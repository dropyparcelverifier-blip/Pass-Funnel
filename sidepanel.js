// sidepanel.js — Dropy Pass-Funnel Validator panel.
const $ = id => document.getElementById(id);
const send = (msg) => new Promise(res => { try { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r); }); } catch { res(null); } });

// ---- tabs ----
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('section.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); $('tab-' + b.dataset.tab).classList.add('active');
}));

// ---- mode (segmented control) ----
const MODES = ['main', 'pass', 'failed'];
const MODE_LABEL = { main: 'Main file', pass: 'Pass file', failed: 'Failed file' };
let currentMode = 'pass';
function applyCounterVisibility(mode) {
  document.querySelectorAll('.chip[data-modes]').forEach(ch => { ch.hidden = !ch.dataset.modes.split(' ').includes(mode); });
}
function setModeUI(m) {
  currentMode = MODES.includes(m) ? m : 'pass';
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode));
  const bm = $('brandMode'); if (bm) bm.textContent = MODE_LABEL[currentMode];
  applyCounterVisibility(currentMode);
  updateModeHint();
}
document.querySelectorAll('#modeSeg button').forEach(b => b.addEventListener('click', async () => {
  setModeUI(b.dataset.mode);
  await send({ action: 'saveSettings', settings: { mode: currentMode } });
}));
function updateDryTag() {
  const dry = $('dryRun').checked, t = $('dryTag');
  t.textContent = dry ? 'DRY' : 'LIVE'; t.className = 'state-tag ' + (dry ? 'dry' : 'live');
}

// ---- log rendering ----
function lineEl(l) {
  const d = document.createElement('div');
  d.className = 'line' + (l.kind ? ' ' + l.kind : '');
  const t = new Date(l.ts || Date.now()).toLocaleTimeString();
  d.innerHTML = `<span class="ts">${t}</span> ${escapeHtml(l.text)}`;
  return d;
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
function appendLog(l) {
  for (const id of ['log', 'liveLog']) { const box = $(id); if (!box) continue;
    const empty = box.querySelector('.log-empty'); if (empty) empty.remove();
    box.appendChild(lineEl(l)); box.scrollTop = box.scrollHeight;
    while (box.childNodes.length > 400) box.removeChild(box.firstChild); }
}
function renderLog(lines) {
  for (const id of ['log', 'liveLog']) { const box = $(id); if (box) box.innerHTML = ''; }
  if (!(lines && lines.length)) { const box = $('liveLog'); if (box) box.innerHTML = '<div class="log-empty">No activity yet — pick a mode and Start.</div>'; }
  (lines || []).forEach(appendLog);
}

// ---- state rendering ----
let uiState = { running: false, paused: false, pausedByCaptcha: false };
function renderControls() {
  const { running, paused, pausedByCaptcha } = uiState;
  const busy = running || paused || pausedByCaptcha;
  // Start only from a clean idle state — while paused, Resume continues and
  // Restart starts fresh, so Start here would just silently wipe progress.
  $('btnStart').disabled = busy;
  $('btnStop').disabled = !busy;
  const pb = $('btnPause');
  if (paused || pausedByCaptcha) { pb.textContent = '▶ Resume'; pb.dataset.act = 'resumeRun'; pb.disabled = false; }
  else if (running) { pb.textContent = '⏸ Pause'; pb.dataset.act = 'pauseRun'; pb.disabled = false; }
  else { pb.textContent = '⏸ Pause'; pb.dataset.act = 'pauseRun'; pb.disabled = true; }
  // Lock mode switching while a run is active — flipping mode swaps engines and
  // would leave the current one running invisibly.
  $('modeSeg').classList.toggle('locked', busy);
  document.querySelectorAll('#modeSeg button').forEach(b => { b.disabled = busy; });
}
function renderState(s) {
  if (!s) return;
  uiState = { running: !!s.running, paused: !!s.paused, pausedByCaptcha: !!s.pausedByCaptcha };
  const pill = $('statePill');
  pill.className = 'pill' + (s.pausedByCaptcha ? ' captcha' : s.running ? ' run' : (s.paused ? ' paused' : ''));
  $('pillTxt').textContent = (s.status || 'Idle').replace(/\s*—.*$/, '');   // short label in the pill
  $('curStatus').textContent = s.status || 'Idle';
  $('curAsin').textContent = s.currentAsin || '—';
  $('curStep').textContent = s.step || '—';
  $('curPage').textContent = (s.page != null) ? `${s.page}${s.totalPages ? ' / ' + s.totalPages : ''}` : '—';
  $('progFill').style.width = (s.page && s.totalPages) ? Math.min(100, Math.round(100 * s.page / s.totalPages)) + '%' : '0%';
  const c = s.counters || {};
  $('cProcessed').textContent = c.processed ?? s.processedCount ?? 0;
  $('cRs').textContent = c.rs ?? 0; $('cDp').textContent = c.dp ?? 0;
  $('cChanged').textContent = c.funnelChanged ?? 0; $('cFlagged').textContent = c.flagged ?? 0;
  $('cMoved').textContent = c.moved ?? 0; $('cCorrected').textContent = c.corrected ?? 0;
  // Main-mode counters (0 in Pass/Failed).
  $('cPassed').textContent = c.passed ?? 0; $('cFailed').textContent = c.failed ?? 0;
  $('cLinkNf').textContent = c.linkNf ?? 0; $('cUsaNf').textContent = c.usaLinkNf ?? 0;
  $('captchaBanner').style.display = s.pausedByCaptcha ? '' : 'none';
  renderControls();
}

// ---- controls ----
async function ctrl(action) { const r = await send({ action }); if (!r?.ok) appendLog({ ts: Date.now(), text: r?.error || 'not available', kind: 'info' }); }
$('btnStart').addEventListener('click', () => ctrl('startRun'));
$('btnStop').addEventListener('click', () => ctrl('stopRun'));
$('btnPause').addEventListener('click', () => ctrl($('btnPause').dataset.act || 'pauseRun'));
$('btnRestart').addEventListener('click', async () => {
  if (!confirm('Restart clears all progress + the log and runs from the top. Continue?')) return;
  const b = $('btnRestart'), o = b.textContent; b.disabled = true; b.textContent = 'Restarting…';
  appendLog({ ts: Date.now(), text: 'restart — clearing + starting fresh…', kind: 'info' });
  const r = await send({ action: 'restartRun' });
  appendLog({ ts: Date.now(), text: r?.ok ? 'restarted' : ('restart failed: ' + (r?.error || '')), kind: r?.ok ? 'ok' : 'err' });
  renderState(await send({ action: 'getState' })); b.disabled = false; b.textContent = o;
});
$('btnCloseTabs').addEventListener('click', async () => {
  const b = $('btnCloseTabs'), o = b.textContent; b.disabled = true; b.textContent = 'Closing…';
  await send({ action: 'closeTabs' }); renderState(await send({ action: 'getState' })); b.disabled = false; b.textContent = o;
});
$('btnReset').addEventListener('click', async () => {
  if (!confirm('Reset clears all progress + the log and returns to Idle. Continue?')) return;
  const b = $('btnReset'), o = b.textContent; b.disabled = true; b.textContent = 'Resetting…';
  const r = await send({ action: 'resetRun' });
  appendLog({ ts: Date.now(), text: r?.ok ? 'progress + log reset' : 'reset failed', kind: r?.ok ? 'ok' : 'err' });
  renderState(await send({ action: 'getState' })); b.disabled = false; b.textContent = o;
});
$('dryRun').addEventListener('change', async () => { updateDryTag(); await send({ action: 'saveSettings', settings: { dryRun: $('dryRun').checked } }); });
function updateModeHint() {
  $('modeHint').textContent =
    currentMode === 'main' ? 'Open the MAIN file view, then Start. Validates each row and routes it: Pass / Move Fail / Link NF / USA Link NF (LLM fallback for weight/category).'
    : currentMode === 'failed' ? 'Open the FAILED file view, then Start. Scrapes amazon.in + amazon.com, fills/fixes every field, moves rows that now pass.'
    : 'Open the PASS file view, then Start. Corrects the funnel (if wrong), writes the Remark, ticks Origin/Checklist.';
}

// ---- export ----
async function exportAudit(format) {
  const r = await send({ action: 'exportAudit', format });
  if (!r?.ok) { appendLog({ ts: Date.now(), text: 'export failed', kind: 'err' }); return; }
  if (!r.count) { appendLog({ ts: Date.now(), text: 'nothing to export yet', kind: 'info' }); return; }
  const a = document.createElement('a'); a.href = r.dataUrl; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
  appendLog({ ts: Date.now(), text: `exported ${r.count} rows → ${r.filename}`, kind: 'ok' });
}
$('btnExportCsv').addEventListener('click', () => exportAudit('csv'));
$('btnExportJson').addEventListener('click', () => exportAudit('json'));

// ---- settings ----
function fillSettings(st) {
  if (!st) return;
  $('setOrigin').value = st.dashboardOrigin || '';
  $('setThrottleMin').value = st.throttleMinMs ?? 2000;
  $('setThrottleMax').value = st.throttleMaxMs ?? 5000;
  $('setWriteRemark').checked = st.writeRemark !== false;
  $('dryRun').checked = !!st.dryRun; updateDryTag();
  setModeUI(st.mode);
  $('setUsZip').value = st.usZip || '10001';
  $('setSourceHost').value = st.sourceLinkHost === 'in' ? 'in' : 'com';
  $('setPassEnrich').checked = st.passEnrich !== false;
  $('setCountSellers').checked = st.countSellers !== false;
  $('setCheckAvail').checked = st.checkAvailability !== false;
  $('setWeightMode').value = st.weightMode || 'gemini-web';
  $('setLlmProvider').value = st.llmProvider || 'gemini';
  $('setLlmModel').value = st.llmModel || '';
  $('setLlmApiKey').value = st.llmApiKey || '';
  updateModeHint();
}
$('btnSaveSettings').addEventListener('click', async () => {
  const settings = {
    dashboardOrigin: $('setOrigin').value.trim(),
    throttleMinMs: parseInt($('setThrottleMin').value, 10) || 2000,
    throttleMaxMs: parseInt($('setThrottleMax').value, 10) || 5000,
    writeRemark: $('setWriteRemark').checked,
    mode: currentMode,
    usZip: $('setUsZip').value.trim() || '10001',
    sourceLinkHost: $('setSourceHost').value === 'in' ? 'in' : 'com',
    passEnrich: $('setPassEnrich').checked,
    countSellers: $('setCountSellers').checked,
    checkAvailability: $('setCheckAvail').checked,
    weightMode: $('setWeightMode').value,
    llmProvider: $('setLlmProvider').value,
    llmModel: $('setLlmModel').value.trim(),
    llmApiKey: $('setLlmApiKey').value.trim(),
  };
  const r = await send({ action: 'saveSettings', settings });
  appendLog({ ts: Date.now(), text: r?.ok ? 'settings saved' : 'save failed', kind: r?.ok ? 'ok' : 'err' });
});

// ---- scan ----
let lastScanJson = '';
$('btnScan').addEventListener('click', async () => {
  appendLog({ ts: Date.now(), text: 'scanning dashboard…', kind: 'info' });
  const r = await send({ action: 'runScan' });
  if (r?.ok && r.scan) { lastScanJson = JSON.stringify(r.scan, null, 2); appendLog({ ts: Date.now(), text: 'scan complete — Copy JSON and send it', kind: 'ok' }); }
  else appendLog({ ts: Date.now(), text: 'scan failed: ' + (r?.error || 'no dashboard tab'), kind: 'err' });
});
$('btnCopyScan').addEventListener('click', async () => {
  if (!lastScanJson) { const r = await send({ action: 'getLastScan' }); if (r?.scan) lastScanJson = JSON.stringify(r.scan, null, 2); }
  if (!lastScanJson) { appendLog({ ts: Date.now(), text: 'run Scan first', kind: 'info' }); return; }
  try { await navigator.clipboard.writeText(lastScanJson); appendLog({ ts: Date.now(), text: 'scan JSON copied', kind: 'ok' }); } catch { appendLog({ ts: Date.now(), text: 'copy failed', kind: 'err' }); }
});

// ---- live updates ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === 'progress') renderState(msg.payload);
  else if (msg?.action === 'log') appendLog(msg.line);
  else if (msg?.action === 'logCleared') renderLog([]);
});

// ---- init ----
(async () => {
  const s = await send({ action: 'getState' });
  if (s) { fillSettings(s.settings); renderLog(s.log); renderState(s); }
})();
