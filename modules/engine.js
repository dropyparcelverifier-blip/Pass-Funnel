



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

import { K, getSettings, decideFunnel, remarkText } from '../config.js';
import * as tab from './amazon-tab.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.round(a + Math.random() * (b - a));
const IN_ORIGIN = 'https://www.amazon.in';
const US_ORIGIN = 'https://www.amazon.com';
// Fields the dashboard requires before it shows "Move Pass" (used by the
// failed-file verdict peek).
const REQUIRED_FIELDS = ['weight', 'inr', 'usd', 'sourceLink', 'category'];

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
    await detect();
    return (await tab.rpc({ type: 'SCRAPE_PRODUCT' }))?.data || {};
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

  // ---- per-row dispatcher --------------------------------------------------
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
        if (!wr?.ok) { rec.flags.push('remark write failed'); log(`${asin}: Remark write failed${wr?.cellHtml ? ' (cell captured)' : ''}`, 'warn', asin); }
      }
    }

    if (funnel === 'RS') s.counters.rs++; else s.counters.dp++;
    finalizeRecord(rec);
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

    // 2) Scrape amazon.com (USD + source link) — needs the row's USA link.
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
      rec.flags.push('no USA link — USD/source not set');
      log(`${asin}: no amazon.com link on the row — USD + source link can't be filled`, 'warn', asin);
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
    const srcUrl = settings.sourceLinkHost === 'in'
      ? (india.canonicalUrl || `${IN_ORIGIN}/dp/${asin}`)
      : (usa.canonicalUrl || '');
    rec.weight = weight; rec.inr = inr; rec.usd = usd; rec.sourceLink = srcUrl;
    log(`${asin}: ${reason} | weight=${weight ?? '—'}g INR=${inr ?? '—'} USD=${usd ?? '—'} cat="${category || '—'}"`, 'info', asin);
    if (usd == null && row.usaUrl) { rec.flags.push('USD unavailable from amazon.com'); log(`${asin}: USD not found on the .com page (unavailable / parse miss)`, 'warn', asin); }

    // 4) Fill / correct every field. Focus the dashboard first for live writes.
    if (!settings.dryRun) await ctx.focusDashboard?.();

    setStep('weight', asin);   await writeCell(asin, 'weight', weight, rec, settings, 'Weight');
    setStep('INR', asin);      await writeCell(asin, 'inr', inr, rec, settings, 'INR');
    setStep('USD', asin);      await writeCell(asin, 'usd', usd, rec, settings, 'USD');
    setStep('source link', asin);
    if (srcUrl) await writeCell(asin, 'sourceLink', srcUrl, rec, settings, 'Source link');
    else { rec.flags.push('source link not set'); }

    // Category — a real dropdown; SELECT_CATEGORY fuzzy-matches the option list.
    setStep('category', asin);
    if (category) {
      rec.category = category;
      if (settings.dryRun) log(`${asin}: DRY-RUN category ← "${category}"`, 'info', asin);
      else {
        const cr = await ctx.sendToDashboard({ type: 'SELECT_CATEGORY', asin, category });
        rec.categoryOk = !!cr?.ok;
        if (!cr?.ok) { rec.flags.push(`category "${category}" did not match a dropdown option`); log(`${asin}: category "${category}" not applied — ${cr?.error || 'no match'}`, 'warn', asin); }
        else log(`${asin}: category set → ${cr.chosen || category}`, 'ok', asin);
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

    // 5) Peek the verdict; Move Pass only if the dashboard says it now passes.
    setStep('verdict', asin);
    if (settings.dryRun) {
      const stillMissing = REQUIRED_FIELDS.filter(f => {
        if (f === 'weight') return weight == null;
        if (f === 'inr') return inr == null;
        if (f === 'usd') return usd == null;
        if (f === 'sourceLink') return !srcUrl;
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
