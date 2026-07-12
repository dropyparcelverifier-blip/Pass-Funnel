



// modules/engine.js — Pass-Funnel re-check state machine.
//
// For each row in the PASS file: scrape amazon.in for the primary BSR + its
// category, decide the funnel with CATEGORY-SPECIFIC thresholds (config.js),
// correct the dashboard's funnel, and write the BSR rank into Remark.
//
// Sequential by design: ONE amazon.in tab in flight, human-paced throttle.
// No weight / price / USA leg / category / Pass — funnel + remark only.
// Persistence (chrome.storage.local, `pfv` keys) + an `active` flag give clean
// resume after a stop and AUTO-resume after a crash/restart.

import {
  K, getSettings, decideFunnel, remarkText, mapCategory,
  decideOrigin, decideChecklist, decideIndiaAvailable, originLabels, checklistLabels,
  availabilityQuery, titleSimilarity, MARKETPLACES, AVAILABILITY_SIM_THRESHOLD,
} from '../config.js';
import * as tab from './amazon-tab.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.round(a + Math.random() * (b - a));
const IN_ORIGIN = 'https://www.amazon.in';
const US_ORIGIN = 'https://www.amazon.com';
// Fields the dashboard requires before it shows "Move Pass" (used by the
// failed-file verdict peek). No Source Link column exists on this dashboard —
// the USA Link is the source and is already populated.
const REQUIRED_FIELDS = ['weight', 'inr', 'usd', 'category'];

export function createEngine(ctx) {
  // ctx: { log, emit, sendToDashboard, getWorkingWindowId, focusDashboard }
  const s = {
    running: false, paused: false, pausedByCaptcha: false,
    stopRequested: false, pauseRequested: false,
    status: 'Idle', currentAsin: null, step: '', page: null, totalPages: null,
    processed: new Set(),
    counters: { processed: 0, rs: 0, dp: 0, funnelChanged: 0, flagged: 0, moved: 0, corrected: 0 },
    rowRecords: {},
    loopActive: false, resetSeq: 0,
    active: false,   // in-flight → survives restart to auto-resume (see wantsResume)
  };
  // amazon.com renders ₹ on an India IP until we set a US delivery location.
  // Amazon remembers it per session, so we only need to set it once per run.
  let usLocationSet = false;

  // ---- persistence ---------------------------------------------------------
  async function hydrate() {
    const d = await chrome.storage.local.get([K.PROCESSED, K.COUNTERS, K.ROW_RECORDS, K.RUN_STATE]);
    if (Array.isArray(d[K.PROCESSED])) s.processed = new Set(d[K.PROCESSED]);
    if (d[K.COUNTERS]) s.counters = { ...s.counters, ...d[K.COUNTERS] };
    if (d[K.ROW_RECORDS]) s.rowRecords = d[K.ROW_RECORDS];
    const rs = d[K.RUN_STATE] || {};
    s.status = rs.status || 'Idle';
    s.page = rs.page ?? null; s.totalPages = rs.totalPages ?? null;
    s.active = !!rs.active;
  }
  const hydrated = hydrate();

  let persistTimer = null;
  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      chrome.storage.local.set({
        [K.PROCESSED]: Array.from(s.processed),
        [K.COUNTERS]: s.counters,
        [K.ROW_RECORDS]: s.rowRecords,
        [K.RUN_STATE]: { status: s.status, page: s.page, totalPages: s.totalPages, paused: s.paused, pausedByCaptcha: s.pausedByCaptcha, active: s.active },
      }).catch(() => {});
    }, 300);
  }

  function emit(extra) {
    ctx.emit?.({
      running: s.running, paused: s.paused, pausedByCaptcha: s.pausedByCaptcha,
      status: s.status, currentAsin: s.currentAsin, step: s.step,
      page: s.page, totalPages: s.totalPages, counters: s.counters,
      processedCount: s.processed.size, ...extra,
    });
  }
  function setStep(step, asin) { s.step = step; if (asin !== undefined) s.currentAsin = asin; emit(); }
  function log(t, k, a) { ctx.log?.(t, k, a); }
  function highlight(asin) { ctx.sendToDashboard?.({ type: 'HIGHLIGHT_ROW', asin }).catch(() => {}); }

  // ---- cancellation --------------------------------------------------------
  class Stopped extends Error { constructor() { super('stopped'); this.stopped = true; } }
  function checkControl() {
    if (s.stopRequested) throw new Stopped();
    if (s.pauseRequested) { s.paused = true; s.status = 'Paused'; persist(); throw new Stopped(); }
  }
  async function syncWorkingWindow() {
    try { const w = await ctx.getWorkingWindowId?.(); tab.setWindow(w == null ? null : w); } catch {}
  }

  // ---- throttled navigation + captcha --------------------------------------
  async function loadAmazon(url, settings) {
    await sleep(rand(settings.throttleMinMs, settings.throttleMaxMs));
    checkControl();
    const show = settings.showWorkingTab !== false;
    if (show) { try { await tab.ensureTab(); await tab.bringToFront(); } catch {} }
    let r;
    try {
      r = await tab.navigate(url, settings.pageTimeoutMs);
    } catch (e1) {
      log(`load failed (${e1.message}) — retrying once`, 'warn');
      await sleep(rand(settings.throttleMinMs, settings.throttleMaxMs));
      checkControl();
      r = await tab.navigate(url, settings.pageTimeoutMs);
    }
    if (show) { try { await tab.bringToFront(); } catch {} }
    return r;
  }

  // Detect the page; on CAPTCHA bring the tab forward and poll until solved
  // (auto-resumes — no manual click). Stop/Pause during the wait exits.
  async function detect() {
    for (let i = 0; i < 3; i++) {
      const t = (await tab.rpc({ type: 'DETECT_PAGE_TYPE' }))?.pageType || 'other';
      if (t === 'captcha') {
        s.pausedByCaptcha = true;
        s.status = 'CAPTCHA — solve it in the amazon.in tab; auto-resumes when cleared';
        persist(); emit();
        try { await tab.bringToFront(); } catch {}
        log('CAPTCHA detected — solve it in the open tab; the run auto-resumes when cleared.', 'warn');
        let cleared = false;
        for (let k = 0; k < 200 && !s.stopRequested && !s.pauseRequested; k++) {
          await sleep(3000);
          const t2 = (await tab.rpc({ type: 'DETECT_PAGE_TYPE' }))?.pageType || 'other';
          if (t2 !== 'captcha') { cleared = true; break; }
        }
        if (!cleared) throw new Stopped();
        s.pausedByCaptcha = false; s.status = 'Running'; persist(); emit();
        continue; // re-detect the cleared page
      }
      return t;
    }
    return 'other';
  }

  async function scrapeIndia(asin, url, settings) {
    await loadAmazon(url, settings);
    const pageType = await detect();
    const data = (await tab.rpc({ type: 'SCRAPE_PRODUCT' }))?.data || {};
    data._pageType = pageType;   // 'product' = live & sellable on amazon.in
    return data;
  }

  // Scrape the amazon.com source page for the USD price. Forces a US delivery
  // location the first time (India IP otherwise renders ₹); if a page still
  // comes back non-USD, re-set the location and re-scrape once.
  async function scrapeUsa(url, settings) {
    await loadAmazon(url, settings);
    await detect();
    let data = (await tab.rpc({ type: 'SCRAPE_PRODUCT' }))?.data || {};
    if (data.currency !== 'USD') {
      try {
        await tab.rpc({ type: 'SET_US_LOCATION', zip: settings.usZip || '10001' });
        usLocationSet = true;
        try { await tab.waitReady(settings.pageTimeoutMs); } catch {}
        checkControl();
        await detect();
        data = (await tab.rpc({ type: 'SCRAPE_PRODUCT' }))?.data || {};
      } catch (e) { if (e.stopped) throw e; }
    }
    return data;
  }

  // Count unique amazon.in sellers via the offer-listing page (Multi checkbox).
  // Offers load lazily, so an early scrape can undercount (just the buybox = 1).
  // Poll a few times and keep the MAX seen.
  async function scrapeSellerCount(asin, settings) {
    const url = `${IN_ORIGIN}/gp/offer-listing/${asin}`;
    await loadAmazon(url, settings);
    await detect();
    let best = null;
    for (let i = 0; i < 3; i++) {
      checkControl();
      const r = await tab.rpc({ type: 'SCRAPE_SELLERS' });
      const c = Number.isFinite(r?.count) ? r.count : null;
      if (c != null && (best == null || c > best)) best = c;
      if (best != null && best >= 2) break;   // got a real offer list, stop early
      await sleep(800);
    }
    return best;
  }

  // Search each enabled Indian marketplace by product name; a title similar
  // enough to the query means the product is sellable in India (Origin "India").
  async function checkIndiaAvailability(row, settings) {
    const enabled = new Set(settings.availabilitySites || []);
    const sites = MARKETPLACES.filter(m => enabled.has(m.key));
    const query = availabilityQuery(row.brand, row.title);
    if (!query || !sites.length) return { available: false, sites: [], query, results: [] };
    const threshold = settings.availabilityThreshold ?? AVAILABILITY_SIM_THRESHOLD;
    const results = [];
    for (const site of sites) {
      checkControl();
      setStep(`india avail: ${site.name}`, row.asin);
      try {
        await loadAmazon(site.search(query), settings);   // marketplace.js answers the ping
        const r = await tab.rpc({ type: 'MP_SEARCH_SCRAPE' });
        const titles = (r && r.titles) || [];
        let best = 0; for (const t of titles) { const s = titleSimilarity(query, t); if (s > best) best = s; }
        results.push({ key: site.key, name: site.name, sim: Math.round(best * 100) / 100, matched: best >= threshold });
      } catch (e) { if (e.stopped) throw e; results.push({ key: site.key, name: site.name, sim: 0, error: e.message }); }
    }
    return { ...decideIndiaAvailable(results, threshold), query, results };
  }

  // ---- per-row dispatcher (Main mode is handled by the separate Main engine) -
  async function processRow(row, settings) {
    if (settings.mode === 'failed') return processRowFailed(row, settings);
    return processRowPass(row, settings);
  }

  // Resolve the amazon.in product URL for a row (its India link, else /dp/ASIN).
  function indiaUrlFor(row) {
    return row.indiaUrl && /amazon\.in/.test(row.indiaUrl)
      ? row.indiaUrl
      : `${IN_ORIGIN}/dp/${row.asin}`;
  }

  // Compute funnel + remark from a scraped amazon.in payload.
  function funnelFromIndia(india) {
    const bsr = Number.isFinite(india.bsrPrimary) ? india.bsrPrimary : null;
    const bsrCat = india.bsrPrimaryCategory || '';
    const bcRoot = Array.isArray(india.categoryPath) ? india.categoryPath[0] : '';
    const decided = decideFunnel(bsr, bsrCat, bcRoot);
    return { bsr, bsrCat, bcRoot, ...decided };
  }

  // Write one dashboard field, honouring dry-run and recording the outcome.
  // Skips silently when we have no confident value (never blanks a good cell).
  async function writeCell(asin, field, value, rec, settings, label) {
    if (value == null || value === '') return { ok: false, skipped: true };
    const shown = label || field;
    if (settings.dryRun) {
      log(`${asin}: DRY-RUN ${shown} ← ${value}`, 'info', asin);
      rec.writes = rec.writes || {}; rec.writes[field] = String(value);
      return { ok: true, dryRun: true };
    }
    const r = await ctx.sendToDashboard({ type: 'WRITE_FIELD', asin, field, value: String(value) });
    rec.writes = rec.writes || {}; rec.writes[field] = { ok: !!r?.ok, now: r?.now };
    if (r?.corrected) { s.counters.corrected = (s.counters.corrected || 0) + 1; log(`${asin}: ${shown} corrected → ${value}`, 'ok', asin); }
    if (!r?.ok) { rec.flags.push(`${shown} write failed`); log(`${asin}: ${shown} write failed${r?.error ? ' — ' + r.error : ''}`, 'warn', asin); }
    return r || { ok: false };
  }

  // ---- PASS file: funnel (only if wrong) + remark. Nothing else. -----------
  async function processRowPass(row, settings) {
    const asin = row.asin;
    const rec = s.rowRecords[asin] || { asin, flags: [] };
    rec.flags = rec.flags || [];
    s.currentAsin = asin;
    highlight(asin);
    setStep('scrape amazon.in', asin);

    let india = {};
    try {
      india = await scrapeIndia(asin, indiaUrlFor(row), settings);
    } catch (e) {
      if (e.stopped) throw e;
      rec.flags.push('india scrape failed: ' + e.message);
      log(`${asin}: amazon.in scrape failed — ${e.message}`, 'err', asin);
    }

    const { bsr, bsrCat, bcRoot, funnel, key, threshold, matched, reason } = funnelFromIndia(india);
    rec.bsr = bsr; rec.bsrCategory = bsrCat; rec.thresholdKey = key; rec.threshold = threshold;
    rec.funnel = funnel; rec.categoryMatched = matched;
    log(`${asin}: ${reason}${matched ? '' : ' [default threshold]'} — ${bsrCat || bcRoot || 'no category'}`, 'info', asin);

    // 1) Funnel — set/correct on the dashboard.
    setStep('funnel', asin);
    if (settings.dryRun) {
      rec.funnelOk = true;
      log(`${asin}: DRY-RUN would set funnel ${funnel}`, 'info', asin);
    } else {
      await ctx.focusDashboard?.();
      const fr = await ctx.sendToDashboard({ type: 'SET_FUNNEL', asin, funnel });
      rec.funnelOk = !!fr?.ok; rec.funnelCurrent = fr?.current;
      if (fr?.changed) { rec.funnelChanged = true; s.counters.funnelChanged++; log(`${asin}: funnel corrected ${fr.current || '?'} → ${funnel}`, 'ok', asin); }
      else if (fr?.ok) { log(`${asin}: funnel ${funnel} already correct`, 'info', asin); }
      else { rec.flags.push(`funnel could not be set (shows ${fr?.current || '?'})`); log(`${asin}: funnel could not be set to ${funnel}`, 'warn', asin); }
      await sleep(300); // let the row re-render settle
    }

    // 2) Remark — always write the BSR rank.
    if (settings.writeRemark) {
      const remark = remarkText(bsr, bsrCat);
      rec.remark = remark;
      setStep('remark', asin);
      if (settings.dryRun) {
        log(`${asin}: DRY-RUN would write Remark "${remark}"`, 'info', asin);
      } else {
        const wr = await ctx.sendToDashboard({ type: 'WRITE_FIELD', asin, field: 'remark', value: remark });
        rec.remarkOk = !!wr?.ok;
        if (!wr?.ok) { rec.flags.push('remark write failed'); log(`${asin}: Remark write failed — ${wr?.error || '?'}${wr?.cellHtml ? ' | CELL: ' + wr.cellHtml : ''}`, 'warn', asin); }
      }
    }

    // 3) Origin + Checklist enrichment (US always; India when sellable;
    //    Expire always; Size <700g; Multi when unique sellers > 5).
    if (settings.passEnrich) {
      await enrichPassRow(row, rec, india, settings);
    }

    if (funnel === 'RS') s.counters.rs++; else s.counters.dp++;
    finalizeRecord(rec);
  }

  // Origin/Checklist ticking for a Pass-file row (scrapes sellers + availability).
  async function enrichPassRow(row, rec, india, settings) {
    const asin = row.asin;

    let sellerCount = null;
    if (settings.countSellers) {
      setStep('count sellers', asin);
      try { sellerCount = await scrapeSellerCount(asin, settings); }
      catch (e) { if (e.stopped) throw e; rec.flags.push('seller count failed: ' + e.message); log(`${asin}: seller count failed — ${e.message}`, 'warn', asin); }
    }

    // The product's OWN amazon.in page already proves India availability when
    // it's a live product — no search needed. Only search the other Indian
    // marketplaces when the .in page is dead (or when forced to always search).
    const inLive = india._pageType === 'product';
    let avail = { available: false, sites: [] };
    if (settings.checkAvailability && (!inLive || settings.alwaysSearchMarketplaces)) {
      try { avail = await checkIndiaAvailability(row, settings); }
      catch (e) { if (e.stopped) throw e; rec.flags.push('availability check failed: ' + e.message); log(`${asin}: availability check failed — ${e.message}`, 'warn', asin); }
    }
    const indiaAvailable = inLive || avail.available;
    const sites = [...(inLive ? ['amazon.in(page)'] : []), ...(avail.sites || [])];

    const origin = decideOrigin({ indiaAvailable });
    const checklist = decideChecklist({ weightGrams: india.weightGrams, sellerCount });
    const oLabels = originLabels(origin), cLabels = checklistLabels(checklist);
    rec.sellerCount = sellerCount; rec.indiaAvailable = indiaAvailable; rec.availSites = sites;
    rec.origin = origin; rec.checklist = checklist;
    log(`${asin}: origin[${oLabels.join(',')}] checklist[${cLabels.join(',')}] sellers=${sellerCount ?? '—'} india=${indiaAvailable ? sites.join('/') : 'no'}`, 'info', asin);

    if (settings.dryRun) {
      log(`${asin}: DRY-RUN would tick Origin ${oLabels.join('+')} & Checklist ${cLabels.join('+')}`, 'info', asin);
      return;
    }
    await ctx.focusDashboard?.();
    const or = await ctx.sendToDashboard({ type: 'SET_ORIGIN', asin, labels: oLabels });
    rec.originOk = !!or?.ok;
    const dump = (r) => r?.menuHtml ? ' | MENU: ' + r.menuHtml : (r?.cellHtml ? ' | CELL: ' + r.cellHtml : '');
    if (!or?.ok) { rec.flags.push(`origin tick incomplete (${(or?.failed || []).join(',') || or?.error || '?'})`); log(`${asin}: Origin tick failed — ${or?.error || (or?.failed || []).join(',')}${dump(or)}`, 'warn', asin); }
    else if ((or.added || []).length) log(`${asin}: Origin ticked ${or.added.join('+')}`, 'ok', asin);

    const cr = await ctx.sendToDashboard({ type: 'SET_CHECKLIST', asin, labels: cLabels });
    rec.checklistOk = !!cr?.ok;
    if (!cr?.ok) { rec.flags.push(`checklist tick incomplete (${(cr?.failed || []).join(',') || cr?.error || '?'})`); log(`${asin}: Checklist tick failed — ${cr?.error || (cr?.failed || []).join(',')}${dump(cr)}`, 'warn', asin); }
    else if ((cr.added || []).length) log(`${asin}: Checklist ticked ${cr.added.join('+')}`, 'ok', asin);
  }

  // ---- FAILED file: fill/correct EVERY field, then peek verdict + move -----
  async function processRowFailed(row, settings) {
    const asin = row.asin;
    const rec = s.rowRecords[asin] || { asin, flags: [] };
    rec.flags = rec.flags || [];
    s.currentAsin = asin;
    highlight(asin);

    // 1) Scrape amazon.in (weight, INR, BSR/category).
    setStep('scrape amazon.in', asin);
    let india = {};
    try {
      india = await scrapeIndia(asin, indiaUrlFor(row), settings);
    } catch (e) {
      if (e.stopped) throw e;
      rec.flags.push('india scrape failed: ' + e.message);
      log(`${asin}: amazon.in scrape failed — ${e.message}`, 'err', asin);
    }

    // 2) Scrape amazon.com (USD) — needs the row's USA link.
    let usa = {};
    if (row.usaUrl && /amazon\.com/.test(row.usaUrl)) {
      setStep('scrape amazon.com', asin);
      try {
        usa = await scrapeUsa(row.usaUrl, settings);
      } catch (e) {
        if (e.stopped) throw e;
        rec.flags.push('usa scrape failed: ' + e.message);
        log(`${asin}: amazon.com scrape failed — ${e.message}`, 'err', asin);
      }
    } else {
      rec.flags.push('no USA link — USD not set');
      log(`${asin}: no amazon.com link on the row — USD can't be filled`, 'warn', asin);
    }

    // 3) Compute funnel + remark from India BSR.
    const { bsr, bsrCat, bcRoot, funnel, key, threshold, matched, reason } = funnelFromIndia(india);
    rec.bsr = bsr; rec.bsrCategory = bsrCat; rec.thresholdKey = key; rec.threshold = threshold;
    rec.funnel = funnel; rec.categoryMatched = matched;

    const inr = (india.currency === 'INR' && Number.isFinite(india.priceValue)) ? india.priceValue
              : (Number.isFinite(india.priceValue) ? india.priceValue : null);
    const usd = (usa.currency === 'USD' && Number.isFinite(usa.priceValue)) ? usa.priceValue : null;
    const weight = Number.isFinite(india.weightGrams) ? india.weightGrams : null;
    const category = bsrCat || bcRoot || '';
    rec.weight = weight; rec.inr = inr; rec.usd = usd;
    log(`${asin}: ${reason} | weight=${weight ?? '—'}g INR=${inr ?? '—'} USD=${usd ?? '—'} cat="${category || '—'}"`, 'info', asin);
    if (usd == null && row.usaUrl) { rec.flags.push('USD unavailable from amazon.com'); log(`${asin}: USD not found on the .com page (unavailable / parse miss)`, 'warn', asin); }

    // Cross-check weight from both marketplaces — a big gap usually means a wrong
    // .com match or a parse error. Flag it (keep the amazon.in weight as written).
    const usWeight = Number.isFinite(usa.weightGrams) ? usa.weightGrams : null;
    rec.weightIn = weight; rec.weightUs = usWeight;
    if (weight != null && usWeight != null) {
      const diff = Math.abs(weight - usWeight) / Math.max(weight, usWeight);
      if (diff > 0.15) { rec.flags.push(`weight mismatch: IN ${weight}g vs US ${usWeight}g`); log(`${asin}: weight mismatch — amazon.in ${weight}g vs amazon.com ${usWeight}g (${Math.round(diff * 100)}% apart)`, 'warn', asin); }
    }

    // 4) Fill / correct every field. Focus the dashboard first for live writes.
    // (No Source Link column on this dashboard — the USA Link is the source.)
    if (!settings.dryRun) await ctx.focusDashboard?.();

    setStep('weight', asin);   await writeCell(asin, 'weight', weight, rec, settings, 'Weight');
    setStep('INR', asin);      await writeCell(asin, 'inr', inr, rec, settings, 'INR');
    setStep('USD', asin);      await writeCell(asin, 'usd', usd, rec, settings, 'USD');

    // Category — map Amazon's taxonomy to the dashboard's custom options, then
    // select. Fall back to the raw text (fuzzy match) when nothing maps.
    setStep('category', asin);
    if (category) {
      const mapped = mapCategory(`${bsrCat} ${bcRoot}`) || category;
      rec.category = mapped; rec.categoryRaw = category;
      if (settings.dryRun) log(`${asin}: DRY-RUN category "${category}" → "${mapped}"`, 'info', asin);
      else {
        const cr = await ctx.sendToDashboard({ type: 'SELECT_CATEGORY', asin, category: mapped });
        rec.categoryOk = !!cr?.ok;
        if (!cr?.ok) { rec.flags.push(`category "${mapped}" did not match a dropdown option`); log(`${asin}: category "${category}" → "${mapped}" not applied — ${cr?.error || 'no match'}`, 'warn', asin); }
        else log(`${asin}: category "${category}" → ${cr.chosen || mapped}`, 'ok', asin);
      }
    }

    // Funnel.
    setStep('funnel', asin);
    if (settings.dryRun) log(`${asin}: DRY-RUN funnel ← ${funnel}`, 'info', asin);
    else {
      const fr = await ctx.sendToDashboard({ type: 'SET_FUNNEL', asin, funnel });
      rec.funnelOk = !!fr?.ok; rec.funnelCurrent = fr?.current;
      if (fr?.changed) { rec.funnelChanged = true; s.counters.funnelChanged++; log(`${asin}: funnel corrected ${fr.current || '?'} → ${funnel}`, 'ok', asin); }
      else if (!fr?.ok) { rec.flags.push(`funnel could not be set (shows ${fr?.current || '?'})`); log(`${asin}: funnel could not be set to ${funnel}`, 'warn', asin); }
    }

    // Remark (always).
    if (settings.writeRemark) {
      const remark = remarkText(bsr, bsrCat);
      rec.remark = remark;
      setStep('remark', asin);
      await writeCell(asin, 'remark', remark, rec, settings, 'Remark');
    }

    // Origin + Checklist enrichment (same as the Pass file).
    if (settings.passEnrich) {
      await enrichPassRow(row, rec, india, settings);
    }

    // 5) Peek the verdict; Move Pass only if the dashboard says it now passes.
    setStep('verdict', asin);
    if (settings.dryRun) {
      const stillMissing = REQUIRED_FIELDS.filter(f => {
        if (f === 'weight') return weight == null;
        if (f === 'inr') return inr == null;
        if (f === 'usd') return usd == null;
        if (f === 'category') return !category;
        return false;
      });
      rec.verdict = stillMissing.length ? 'would-fail' : 'would-pass';
      log(`${asin}: DRY-RUN verdict ${rec.verdict}${stillMissing.length ? ' — missing: ' + stillMissing.join(', ') : ' → would Move Pass'}`, stillMissing.length ? 'warn' : 'info', asin);
    } else {
      const peek = await ctx.sendToDashboard({ type: 'CLICK_PASS', asin, opts: { peek: true } });
      rec.verdict = peek?.verdict || (peek?.ok ? 'pass' : 'fail');
      if (peek?.ok && peek.verdict === 'pass') {
        const mv = await ctx.sendToDashboard({ type: 'CLICK_PASS', asin, opts: {} });
        if (mv?.ok) { rec.moved = true; s.counters.moved = (s.counters.moved || 0) + 1; log(`${asin}: verdict PASS → moved to Pass file`, 'ok', asin); }
        else { rec.flags.push('move-pass click failed'); log(`${asin}: verdict pass but Move Pass failed — ${mv?.error || '?'}`, 'warn', asin); }
      } else {
        const why = peek?.failReason || (peek?.missing && peek.missing.length ? 'missing: ' + peek.missing.join(', ') : peek?.error) || 'verdict fail';
        rec.flags.push('still failing: ' + why);
        log(`${asin}: still failing (${why}) — left in Failed file`, 'warn', asin);
      }
    }

    if (funnel === 'RS') s.counters.rs++; else s.counters.dp++;
    finalizeRecord(rec);
  }

  function finalizeRecord(rec) {
    if (rec.flags && rec.flags.length) s.counters.flagged++;
    s.rowRecords[rec.asin] = rec;
    s.processed.add(rec.asin);
    s.counters.processed = s.processed.size;
    persist(); emit();
  }

  // ---- page reading (grid-wait) --------------------------------------------
  async function readPage() {
    let res = await ctx.sendToDashboard({ type: 'READ_PAGE_ROWS' });
    for (let attempt = 0; (!res?.ok || !(res.rows || []).length) && attempt < 6; attempt++) {
      await sleep(res?.ok ? 700 : 1200);
      const r = await ctx.sendToDashboard({ type: 'READ_PAGE_ROWS' });
      if (r) res = r;
      if (res?.ok && (res.rows || []).length) break;
      if (res?.ok && attempt >= 1) break;
    }
    const pag = await ctx.sendToDashboard({ type: 'READ_PAGINATION' });
    if (pag?.pagination) { s.page = pag.pagination.page; s.totalPages = pag.pagination.totalPages; }
    if (!res?.ok) {
      log(`page read: ${res?.error || 'no rows'} after retries — is the PASS file grid visible? (empty file = Done)`, 'warn');
      return [];
    }
    return res.rows || [];
  }

  let lastLoggedPage = null;
  async function runLoop() {
    if (s.loopActive) return;
    s.loopActive = true;
    const myReset = s.resetSeq;
    const settings = await getSettings();
    await syncWorkingWindow();
    try {
      while (!s.stopRequested && !s.pauseRequested && !s.pausedByCaptcha) {
        const rows = await readPage();
        const pending = rows.filter(r => r.asin && !s.processed.has(r.asin));
        if (s.page !== lastLoggedPage) { log(`Page ${s.page ?? '?'}: ${rows.length} rows — ${pending.length} to do`, 'info'); lastLoggedPage = s.page; }
        emit();

        if (pending.length === 0) {
          if (s.totalPages && s.page && s.page >= s.totalPages) { s.status = 'Done — all pages processed'; break; }
          setStep('next page');
          const before = s.page;
          const np = await ctx.sendToDashboard({ type: 'GOTO_NEXT_PAGE' });
          if (!np?.ok) { s.status = np?.lastPage ? 'Done — last page' : 'Stopped — pagination: ' + (np?.error || ''); break; }
          await sleep(900);
          await readPage();
          if (s.page === before) { s.status = 'Done — pagination did not advance'; break; }
          continue;
        }

        const row = pending[0];
        try {
          await processRow(row, settings);
        } catch (e) {
          if (e.stopped) break;
          log(`${row.asin}: row error — ${e.message}`, 'err', row.asin);
          const rec = s.rowRecords[row.asin] || { asin: row.asin, flags: [] };
          rec.flags = (rec.flags || []).concat('row error: ' + e.message);
          finalizeRecord(rec);
        }
      }
    } catch (e) {
      if (!e.stopped) { s.status = 'Error: ' + e.message; log(`Run error: ${e.message}`, 'err'); }
    } finally {
      s.loopActive = false;
      if (s.resetSeq !== myReset) return;
      s.running = false;
      if (s.stopRequested) s.status = s.status.startsWith('Done') ? s.status : 'Stopped';
      else if (s.pausedByCaptcha) s.paused = true;
      else if (s.pauseRequested || s.paused) { s.paused = true; if (!s.status.startsWith('Paused')) s.status = 'Paused'; }
      if (!s.pausedByCaptcha && !s.pauseRequested && !s.paused) {
        s.active = false;            // truly over — no auto-resume next launch
        highlight(null);
        try { await tab.closeTab(); } catch {}
        log('Run finished — closed amazon.in tab', 'info');
      }
      try { chrome.power?.releaseKeepAwake?.(); } catch {}
      persist(); emit();
    }
  }

  // ---- public control ------------------------------------------------------
  async function stopAndWait() {
    if (!s.loopActive && !s.running) return;
    s.stopRequested = true; s.pauseRequested = false;
    try { await tab.closeTab(); } catch {}
    for (let i = 0; i < 60 && s.loopActive; i++) await sleep(200);
  }
  async function start() {
    await hydrated;
    await stopAndWait();
    s.processed = new Set(); s.rowRecords = {};
    s.counters = { processed: 0, rs: 0, dp: 0, funnelChanged: 0, flagged: 0, moved: 0, corrected: 0 };
    usLocationSet = false;
    await chrome.storage.local.remove([K.PROCESSED, K.COUNTERS, K.ROW_RECORDS]).catch(() => {});
    const settings = await getSettings();
    s.stopRequested = false; s.pauseRequested = false; s.paused = false; s.pausedByCaptcha = false;
    s.active = true; s.running = true; s.status = settings.dryRun ? 'Running (dry-run)' : 'Running';
    lastLoggedPage = null;
    try { chrome.power?.requestKeepAwake?.('display'); } catch {}
    persist(); emit(); runLoop();
    return { ok: true };
  }
  async function resume() {
    await hydrated;
    if (s.running) return { ok: false, error: 'already running' };
    s.pausedByCaptcha = false; s.paused = false; s.pauseRequested = false; s.stopRequested = false;
    s.active = true;
    const settings = await getSettings();
    s.running = true; s.status = settings.dryRun ? 'Running (dry-run)' : 'Running';
    persist(); emit(); runLoop();
    return { ok: true };
  }
  function pause() {
    if (!s.running) return { ok: false, error: 'not running' };
    s.pauseRequested = true; s.active = false; s.status = 'Pausing…';
    persist(); emit();
    return { ok: true };
  }
  async function stop() {
    s.stopRequested = true; s.pauseRequested = false; s.active = false;
    highlight(null);
    try { await tab.closeTab(); } catch {}
    s.running = false; s.status = 'Stopped';
    persist(); emit();
    return { ok: true };
  }
  async function reset() {
    s.resetSeq++;
    await stopAndWait();
    try { highlight(null); } catch {}
    s.running = false; s.loopActive = false; s.active = false;
    s.processed = new Set(); s.rowRecords = {};
    s.counters = { processed: 0, rs: 0, dp: 0, funnelChanged: 0, flagged: 0, moved: 0, corrected: 0 };
    usLocationSet = false;
    s.status = 'Idle'; s.page = null; s.totalPages = null; s.currentAsin = null; s.step = '';
    s.paused = false; s.pausedByCaptcha = false;
    await chrome.storage.local.remove([K.PROCESSED, K.COUNTERS, K.ROW_RECORDS, K.RUN_STATE]);
    emit();
    return { ok: true };
  }
  async function closeTabs() {
    await stopAndWait();
    s.running = false;
    if (!s.status.startsWith('Done') && !s.pausedByCaptcha) s.status = 'Stopped';
    try { highlight(null); } catch {}
    try { await tab.closeTab(); } catch {}
    persist(); emit();
    log('Closed amazon.in tab', 'info');
    return { ok: true };
  }
  function wantsResume() { return s.active && !s.running && !s.loopActive; }
  function getStatus() {
    return { running: s.running, paused: s.paused, pausedByCaptcha: s.pausedByCaptcha, status: s.status,
      currentAsin: s.currentAsin, step: s.step, page: s.page, totalPages: s.totalPages,
      counters: s.counters, processedCount: s.processed.size };
  }
  function getRecords() { return Object.values(s.rowRecords); }

  return { start, pause, resume, stop, reset, closeTabs, wantsResume, getStatus, getRecords, hydrated };
}
