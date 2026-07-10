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

export function createEngine(ctx) {
  // ctx: { log, emit, sendToDashboard, getWorkingWindowId, focusDashboard }
  const s = {
    running: false, paused: false, pausedByCaptcha: false,
    stopRequested: false, pauseRequested: false,
    status: 'Idle', currentAsin: null, step: '', page: null, totalPages: null,
    processed: new Set(),
    counters: { processed: 0, rs: 0, dp: 0, funnelChanged: 0, flagged: 0 },
    rowRecords: {},
    loopActive: false, resetSeq: 0,
    active: false,   // in-flight → survives restart to auto-resume (see wantsResume)
  };

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
      const t = (await tab.rpc({ type: 'DETECT_PAGE_TYPE' }))?.type || 'other';
      if (t === 'captcha') {
        s.pausedByCaptcha = true;
        s.status = 'CAPTCHA — solve it in the amazon.in tab; auto-resumes when cleared';
        persist(); emit();
        try { await tab.bringToFront(); } catch {}
        log('CAPTCHA detected — solve it in the open tab; the run auto-resumes when cleared.', 'warn');
        let cleared = false;
        for (let k = 0; k < 200 && !s.stopRequested && !s.pauseRequested; k++) {
          await sleep(3000);
          const t2 = (await tab.rpc({ type: 'DETECT_PAGE_TYPE' }))?.type || 'other';
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

  // ---- per-row: funnel + remark --------------------------------------------
  async function processRow(row, settings) {
    const asin = row.asin;
    const rec = s.rowRecords[asin] || { asin, flags: [] };
    rec.flags = rec.flags || [];
    s.currentAsin = asin;
    highlight(asin);
    setStep('scrape amazon.in', asin);

    const url = row.indiaUrl && /amazon\.in/.test(row.indiaUrl)
      ? row.indiaUrl
      : `${IN_ORIGIN}/dp/${asin}`;

    let india = {};
    try {
      india = await scrapeIndia(asin, url, settings);
    } catch (e) {
      if (e.stopped) throw e;
      rec.flags.push('india scrape failed: ' + e.message);
      log(`${asin}: amazon.in scrape failed — ${e.message}`, 'err', asin);
    }

    const bsr = Number.isFinite(india.bsrPrimary) ? india.bsrPrimary : null;
    const bsrCat = india.bsrPrimaryCategory || '';
    const bcRoot = Array.isArray(india.categoryPath) ? india.categoryPath[0] : '';
    const { funnel, key, threshold, matched, reason } = decideFunnel(bsr, bsrCat, bcRoot);
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

    // count + finalize
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
    s.counters = { processed: 0, rs: 0, dp: 0, funnelChanged: 0, flagged: 0 };
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
    s.counters = { processed: 0, rs: 0, dp: 0, funnelChanged: 0, flagged: 0 };
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
