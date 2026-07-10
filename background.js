// background.js (MV3 module service worker) — Dropy Pass-Funnel Validator.
// Registers the dashboard content script on the configured origin, routes panel
// commands, and drives the funnel-recheck engine. Separate storage (`pfv`) and
// service worker from Dropy Auto-Validator — the two never share state.

import { K, LOG_MAX, DEFAULT_SETTINGS, getSettings, saveSettings, normalizeOrigin } from './config.js';
import { createEngine } from './modules/engine.js';

const state = {
  settings: { ...DEFAULT_SETTINGS },
  running: false, paused: false, pausedByCaptcha: false, status: 'Idle',
  log: [], counters: { processed: 0, rs: 0, dp: 0, funnelChanged: 0, flagged: 0 },
  registeredOrigin: null, lastScan: null,
};
const DASHBOARD_SCRIPT_ID = 'pfv-dashboard-cs';

try { chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {}); } catch {}

const coldStart = (async () => {
  const data = await chrome.storage.local.get([K.SETTINGS, K.RUN_STATE, K.LOG, K.COUNTERS, K.LAST_SCAN]);
  state.settings = { ...DEFAULT_SETTINGS, ...(data[K.SETTINGS] || {}) };
  if (Array.isArray(data[K.LOG])) state.log = data[K.LOG];
  if (data[K.COUNTERS]) state.counters = { ...state.counters, ...data[K.COUNTERS] };
  if (data[K.LAST_SCAN]) state.lastScan = data[K.LAST_SCAN];
  const rs = data[K.RUN_STATE] || {};
  state.status = rs.status || 'Idle';
  state.paused = !!rs.paused; state.pausedByCaptcha = !!rs.pausedByCaptcha;
  await ensureDashboardRegistration(state.settings.dashboardOrigin);
})();

function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }
let logPersistTimer = null;
function pushLog(text, kind, asin) {
  if (!text) return;
  const line = { ts: Date.now(), text: String(text), kind: kind || null };
  if (asin) line.asin = asin;
  state.log.push(line);
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  if (logPersistTimer) clearTimeout(logPersistTimer);
  logPersistTimer = setTimeout(() => chrome.storage.local.set({ [K.LOG]: state.log }).catch(() => {}), 400);
  broadcast({ action: 'log', line });
}

// ---- dashboard content-script registration (dynamic origin) ----------------
async function ensureDashboardRegistration(rawOrigin) {
  const origin = normalizeOrigin(rawOrigin);
  if (!origin || state.registeredOrigin === origin) return;
  const pattern = `${origin}/*`;
  try {
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DASHBOARD_SCRIPT_ID] });
      if (existing && existing.length) await chrome.scripting.unregisterContentScripts({ ids: [DASHBOARD_SCRIPT_ID] });
    } catch {}
    await chrome.scripting.registerContentScripts([{
      id: DASHBOARD_SCRIPT_ID, js: ['content/dashboard.js'], matches: [pattern],
      runAt: 'document_idle', persistAcrossSessions: true,
    }]);
    state.registeredOrigin = origin;
    pushLog(`Dashboard content script registered for ${pattern}`, 'ok');
    await injectIntoOpenDashboardTabs(origin);
  } catch (e) { pushLog(`Failed to register dashboard script for ${pattern}: ${e.message}`, 'err'); }
}
async function injectIntoOpenDashboardTabs(origin) {
  try {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    for (const t of tabs) {
      if (!t.id) continue;
      try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/dashboard.js'] }); } catch {}
    }
  } catch {}
}
async function getDashboardTab() {
  const origin = normalizeOrigin(state.settings.dashboardOrigin);
  if (!origin) return null;
  const onOrigin = await chrome.tabs.query({ url: `${origin}/*` });
  if (!onOrigin.length) return null;
  return onOrigin.find(t => t.active) || onOrigin[0];
}
async function sendToDashboard(message) {
  const tab = await getDashboardTab();
  if (!tab?.id) throw new Error('No dashboard tab open. Open the Validation dashboard, then retry.');
  try { return await chrome.tabs.sendMessage(tab.id, message); }
  catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/dashboard.js'] });
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (e2) { throw new Error(`Dashboard content script unreachable: ${e2.message}. Reload the dashboard tab.`); }
  }
}

// ---- engine ----------------------------------------------------------------
const engine = createEngine({
  log: (text, kind, asin) => pushLog(text, kind, asin),
  sendToDashboard: (m) => sendToDashboard(m),
  focusDashboard: async () => {
    try { const t = await getDashboardTab(); if (t?.id) { await chrome.tabs.update(t.id, { active: true }); if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true }); } } catch {}
  },
  getWorkingWindowId: async () => { try { const t = await getDashboardTab(); return (t && t.windowId != null) ? t.windowId : null; } catch { return null; } },
  emit: (payload) => {
    if (payload.counters) state.counters = payload.counters;
    if (payload.status) state.status = payload.status;
    state.running = payload.running; state.paused = payload.paused; state.pausedByCaptcha = payload.pausedByCaptcha;
    broadcast({ action: 'progress', payload });
  },
});

// ---- auto-resume after crash/restart ---------------------------------------
let autoResumeDone = false;
async function autoResumeIfNeeded(trigger) {
  if (autoResumeDone) return; autoResumeDone = true;
  try {
    await coldStart; await engine.hydrated;
    if (!engine.wantsResume()) return;
    pushLog(`Auto-resume (${trigger}): a run was interrupted — waiting for the dashboard tab…`, 'info');
    let tab = null;
    for (let i = 0; i < 90; i++) { tab = await getDashboardTab(); if (tab?.id) break; await new Promise(r => setTimeout(r, 1000)); }
    if (!tab?.id) { pushLog('Auto-resume aborted — no dashboard tab reopened. Open it and click Resume.', 'warn'); return; }
    await ensureDashboardRegistration(state.settings.dashboardOrigin);
    await new Promise(r => setTimeout(r, 1500));
    if (!engine.wantsResume()) return;
    const res = await engine.resume();
    pushLog(res?.ok ? 'Auto-resumed the interrupted run.' : `Auto-resume failed: ${res?.error || 'unknown'}.`, res?.ok ? 'ok' : 'warn');
  } catch (e) { pushLog(`Auto-resume error: ${e.message}`, 'warn'); }
}
try { chrome.runtime.onStartup?.addListener(() => autoResumeIfNeeded('browser start')); } catch {}
autoResumeIfNeeded('cold start');

// ---- CSV export ------------------------------------------------------------
function recordsToCsv(records) {
  const cols = ['asin', 'bsr', 'bsrCategory', 'thresholdKey', 'threshold', 'funnel', 'funnelChanged', 'remark', 'flags'];
  const esc = v => { if (v == null) v = ''; if (Array.isArray(v)) v = v.join(' | '); v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return cols.join(',') + '\n' + records.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');
}

// ---- message router --------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const action = msg?.action;

  if (action === 'getState') {
    Promise.all([coldStart, engine.hydrated]).then(() => {
      const st = engine.getStatus();
      sendResponse({ ok: true, settings: state.settings, log: state.log, lastScan: state.lastScan,
        running: st.running, paused: st.paused, pausedByCaptcha: st.pausedByCaptcha, status: st.status,
        currentAsin: st.currentAsin, step: st.step, page: st.page, totalPages: st.totalPages,
        counters: st.counters, processedCount: st.processedCount });
    });
    return true;
  }
  if (action === 'saveSettings') {
    coldStart.then(async () => {
      state.settings = await saveSettings(msg.settings || {});
      await ensureDashboardRegistration(state.settings.dashboardOrigin);
      sendResponse({ ok: true, settings: state.settings });
    });
    return true;
  }
  if (action === 'runScan') {
    coldStart.then(async () => {
      try {
        const r = await sendToDashboard({ type: 'SCAN' });
        if (r?.ok && r.scan) { state.lastScan = r.scan; await chrome.storage.local.set({ [K.LAST_SCAN]: r.scan }).catch(() => {}); }
        sendResponse(r || { ok: false, error: 'no response' });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    });
    return true;
  }
  if (action === 'getLastScan') { coldStart.then(() => sendResponse({ ok: true, scan: state.lastScan })); return true; }
  if (action === 'clearLog') {
    state.log = []; chrome.storage.local.remove([K.LOG]).catch(() => {}); broadcast({ action: 'logCleared' });
    sendResponse({ ok: true }); return false;
  }
  if (action === 'logFromContent') { pushLog(msg.text, msg.kind, msg.asin); sendResponse({ ok: true }); return false; }

  if (action === 'startRun')  { coldStart.then(() => engine.start()).then(sendResponse);  return true; }
  if (action === 'pauseRun')  { sendResponse(engine.pause()); return false; }
  if (action === 'resumeRun') { coldStart.then(() => engine.resume()).then(sendResponse); return true; }
  if (action === 'stopRun')   { engine.stop().then(sendResponse); return true; }
  if (action === 'closeTabs') { engine.closeTabs().then(sendResponse); return true; }
  if (action === 'resetRun')  {
    coldStart.then(() => engine.reset()).then(async (res) => {
      if (res?.ok) { state.log = []; await chrome.storage.local.remove([K.LOG]).catch(() => {}); broadcast({ action: 'logCleared' }); }
      sendResponse(res);
    });
    return true;
  }
  if (action === 'restartRun') {
    coldStart.then(async () => {
      const r = await engine.reset();
      if (r?.ok) { state.log = []; await chrome.storage.local.remove([K.LOG]).catch(() => {}); broadcast({ action: 'logCleared' }); }
      return engine.start();
    }).then(sendResponse);
    return true;
  }
  if (action === 'getRecords') { engine.hydrated.then(() => sendResponse({ ok: true, records: engine.getRecords() })); return true; }
  if (action === 'exportAudit') {
    engine.hydrated.then(() => {
      const records = engine.getRecords();
      const fmt = msg.format === 'json' ? 'json' : 'csv';
      const content = fmt === 'json' ? JSON.stringify(records, null, 2) : recordsToCsv(records);
      const dataUrl = 'data:' + (fmt === 'json' ? 'application/json' : 'text/csv') + ';charset=utf-8,' + encodeURIComponent(content);
      sendResponse({ ok: true, count: records.length, filename: `pass-funnel-${Date.now()}.${fmt}`, dataUrl });
    });
    return true;
  }

  return false;
});
