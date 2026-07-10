// sidepanel.js — Dropy Pass-Funnel Validator panel.
const $ = id => document.getElementById(id);
const send = (msg) => new Promise(res => { try { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r); }); } catch { res(null); } });

// ---- tabs ----
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('section.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); $('tab-' + b.dataset.tab).classList.add('active');
}));

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
  for (const id of ['log', 'liveLog']) { const box = $(id); if (!box) continue; box.appendChild(lineEl(l)); box.scrollTop = box.scrollHeight;
    while (box.childNodes.length > 400) box.removeChild(box.firstChild); }
}
function renderLog(lines) { for (const id of ['log', 'liveLog']) { const box = $(id); if (box) box.innerHTML = ''; } (lines || []).forEach(appendLog); }

// ---- state rendering ----
let uiState = { running: false, paused: false, pausedByCaptcha: false };
function renderControls() {
  const { running, paused, pausedByCaptcha } = uiState;
  $('btnStart').disabled = running;
  $('btnStop').disabled = !running && !paused && !pausedByCaptcha;
  const pb = $('btnPause');
  if (paused || pausedByCaptcha) { pb.textContent = 'Resume'; pb.dataset.act = 'resumeRun'; pb.disabled = false; }
  else if (running) { pb.textContent = '⏸ Pause'; pb.dataset.act = 'pauseRun'; pb.disabled = false; }
  else { pb.textContent = '⏸ Pause'; pb.dataset.act = 'pauseRun'; pb.disabled = true; }
}
function renderState(s) {
  if (!s) return;
  uiState = { running: !!s.running, paused: !!s.paused, pausedByCaptcha: !!s.pausedByCaptcha };
  const pill = $('statePill');
  pill.textContent = s.status || 'Idle';
  pill.className = 'pill' + (s.pausedByCaptcha ? ' captcha' : s.running ? ' run' : (s.paused ? ' paused' : ''));
  $('curStatus').textContent = s.status || 'Idle';
  $('curAsin').textContent = s.currentAsin || '—';
  $('curStep').textContent = s.step || '—';
  $('curPage').textContent = (s.page != null) ? `${s.page}${s.totalPages ? ' / ' + s.totalPages : ''}` : '—';
  const c = s.counters || {};
  $('cProcessed').textContent = c.processed ?? s.processedCount ?? 0;
  $('cRs').textContent = c.rs ?? 0; $('cDp').textContent = c.dp ?? 0;
  $('cChanged').textContent = c.funnelChanged ?? 0; $('cFlagged').textContent = c.flagged ?? 0;
  $('captchaBanner').style.display = s.pausedByCaptcha ? 'block' : 'none';
  renderControls();
}

// ---- controls ----
async function ctrl(action) { const r = await send({ action }); if (!r?.ok) appendLog({ ts: Date.now(), text: r?.error || 'not available', kind: 'info' }); }
$('btnStart').addEventListener('click', () => ctrl('startRun'));
$('btnStop').addEventListener('click', () => ctrl('stopRun'));
$('btnPause').addEventListener('click', () => ctrl($('btnPause').dataset.act || 'pauseRun'));
$('btnRestart').addEventListener('click', async () => {
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
  const b = $('btnReset'), o = b.textContent; b.disabled = true; b.textContent = 'Resetting…';
  const r = await send({ action: 'resetRun' });
  appendLog({ ts: Date.now(), text: r?.ok ? 'progress + log reset' : 'reset failed', kind: r?.ok ? 'ok' : 'err' });
  renderState(await send({ action: 'getState' })); b.disabled = false; b.textContent = o;
});
$('dryRun').addEventListener('change', async () => { await send({ action: 'saveSettings', settings: { dryRun: $('dryRun').checked } }); });

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
  $('dryRun').checked = !!st.dryRun;
}
$('btnSaveSettings').addEventListener('click', async () => {
  const settings = {
    dashboardOrigin: $('setOrigin').value.trim(),
    throttleMinMs: parseInt($('setThrottleMin').value, 10) || 2000,
    throttleMaxMs: parseInt($('setThrottleMax').value, 10) || 5000,
    writeRemark: $('setWriteRemark').checked,
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
