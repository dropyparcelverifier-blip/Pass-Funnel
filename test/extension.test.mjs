// Extension test suite — functional, user-flow, and regression tests.
// Runs the REAL modules/engine.js + config.js in Node against configurable
// mocks of the Amazon content script (chrome.tabs) and the dashboard (ctx).
//
//   node --test        (from the repo root)
//
// No browser is involved, so DOM-level selectors in the content scripts are NOT
// covered — those need a live dry-run. Everything else (mode branching, the
// amazon.com scrape path, field-write orchestration, verdict-peek-then-move,
// captcha pausing, counters, dry-run) is exercised end-to-end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const engineUrl = () => pathToFileURL(path.join(ROOT, 'modules/engine.js')).href + '?t=' + Math.random();
const configUrl = pathToFileURL(path.join(ROOT, 'config.js')).href;

// --------------------------------------------------------------- environment
function makeEnv(opts = {}) {
  const detect = opts.detect || (() => 'product');
  const indiaData = opts.indiaData || ((asin) => ({
    asin, bsrPrimary: 12345, bsrPrimaryCategory: 'Beauty & Personal Care',
    categoryPath: ['Beauty & Personal Care'], weightGrams: 200, priceValue: 499,
    currency: 'INR', canonicalUrl: `https://www.amazon.in/dp/${asin}`,
  }));
  // amazon.com on an India IP renders ₹ until a US location is set (usLocSet).
  const usaData = opts.usaData || ((asin, usLocSet) => usLocSet
    ? { asin, priceValue: 9.99, currency: 'USD', canonicalUrl: `https://www.amazon.com/dp/${asin}` }
    : { asin, priceValue: 830, currency: 'INR', canonicalUrl: `https://www.amazon.com/dp/${asin}` });

  const env = { usLocSet: false, detectCalls: 0 };
  const store = {}, tabUrls = {}; let nextTab = 100;
  const asinOf = (url) => (String(url).match(/\/dp\/([A-Z0-9]{10})/) || [])[1] || 'B000000000';

  function amazonRpc(url, msg) {
    if (msg.type === 'AMAZON_PING') return Promise.resolve({ ok: true, ready: true });
    if (msg.type === 'DETECT_PAGE_TYPE') { env.detectCalls++; return Promise.resolve({ ok: true, pageType: detect(url, env.detectCalls) }); }
    if (msg.type === 'SET_US_LOCATION') { env.usLocSet = true; return Promise.resolve({ ok: true, zip: msg.zip }); }
    if (msg.type === 'SCRAPE_PRODUCT') {
      const asin = asinOf(url);
      const data = /amazon\.in/.test(url) ? indiaData(asin) : usaData(asin, env.usLocSet);
      return Promise.resolve({ ok: true, data });
    }
    return Promise.resolve({ ok: false, error: 'unhandled ' + msg.type });
  }

  const chrome = {
    storage: { local: {
      async get(keys) { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) o[k] = store[k]; }); return o; },
      async set(o) { Object.assign(store, o); },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); },
    } },
    tabs: {
      async create(o) { const id = nextTab++; tabUrls[id] = (o && o.url) || 'about:blank'; return { id, windowId: 1, status: 'complete' }; },
      async get(id) { if (!(id in tabUrls)) throw new Error('no tab'); return { id, windowId: 1, status: 'complete' }; },
      async update(id, o) { if (o && o.url) tabUrls[id] = o.url; return { id }; },
      async remove(id) { delete tabUrls[id]; },
      async query() { return []; },
      async sendMessage(id, msg) { return amazonRpc(tabUrls[id], msg); },
    },
    windows: { async update() {} },
    power: { requestKeepAwake() {}, releaseKeepAwake() {} },
    runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, sendMessage: () => Promise.resolve(), lastError: null },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, executeScript: async () => {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  env.store = store;
  return { chrome, env };
}

function makeDashboard(rows, verdicts = {}) {
  const calls = { byAsin: {}, all: [] };
  const rec = a => (calls.byAsin[a] ||= { writes: {}, funnel: null, category: null, peek: 0, move: 0 });
  async function sendToDashboard(m) {
    calls.all.push(m.type);
    switch (m.type) {
      case 'READ_PAGE_ROWS': return { ok: true, rows };
      case 'READ_PAGINATION': return { ok: true, pagination: { page: 1, totalPages: 1 } };
      case 'HIGHLIGHT_ROW': return { ok: true };
      case 'WRITE_FIELD': rec(m.asin).writes[m.field] = m.value; return { ok: true, corrected: true, now: m.value };
      case 'SET_FUNNEL': rec(m.asin).funnel = m.funnel; return { ok: true, changed: true, current: 'DP' };
      case 'SELECT_CATEGORY': rec(m.asin).category = m.category; return { ok: true, chosen: m.category };
      case 'CLICK_PASS': {
        const v = verdicts[m.asin] || 'pass';
        if (m.opts && m.opts.peek) { rec(m.asin).peek++; return { ok: true, verdict: v, peeked: true }; }
        rec(m.asin).move++; return { ok: true, verdict: v };
      }
      default: return { ok: false, error: 'unhandled ' + m.type };
    }
  }
  return { sendToDashboard, calls };
}

async function runEngine({ rows, verdicts, settings = {}, env: envOpts = {} }) {
  const { chrome, env } = makeEnv(envOpts);
  global.chrome = chrome;
  await chrome.storage.local.set({ pfvSettings: {
    dryRun: false, throttleMinMs: 0, throttleMaxMs: 0, pageTimeoutMs: 1500,
    showWorkingTab: false, writeRemark: true, usZip: '10001', sourceLinkHost: 'com',
    dashboardOrigin: 'http://localhost:3000', ...settings,
  } });
  const { createEngine } = await import(engineUrl());
  const dash = makeDashboard(rows, verdicts);
  const engine = createEngine({
    log: () => {}, sendToDashboard: dash.sendToDashboard,
    focusDashboard: async () => {}, getWorkingWindowId: async () => null, emit: () => {},
  });
  await engine.hydrated;
  await engine.start();
  return { engine, dash, env };
}

async function waitDone(engine, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const st = engine.getStatus();
    if (!st.running && /Done/i.test(st.status)) return st;
    await new Promise(r => setTimeout(r, 25));
  }
  return engine.getStatus();
}
async function waitFor(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
}
const R = (asin, opts = {}) => ({ asin, indiaUrl: `https://www.amazon.in/dp/${asin}`, usaUrl: `https://www.amazon.com/dp/${asin}`, ...opts });

// ============================================================== FUNCTIONAL
test('FUNCTIONAL: decideFunnel across categories', async () => {
  const cfg = await import(configUrl);
  assert.equal(cfg.decideFunnel(12345, 'Beauty & Personal Care', 'Beauty').funnel, 'RS');
  assert.equal(cfg.decideFunnel(70000, 'Beauty & Personal Care', 'Beauty').funnel, 'DP');
  assert.equal(cfg.decideFunnel(null, 'Beauty', 'Beauty').funnel, 'DP');
  assert.equal(cfg.decideFunnel(25000, 'Sports, Fitness & Outdoors', 'Sports').funnel, 'RS');
  assert.equal(cfg.decideFunnel(45000, 'Unknown', 'Misc').funnel, 'RS');   // default 50k
  assert.equal(cfg.decideFunnel(55000, 'Unknown', 'Misc').funnel, 'DP');
});

test('FUNCTIONAL: category matcher precedence + remark text', async () => {
  const cfg = await import(configUrl);
  assert.equal(cfg.thresholdFor('Beauty & Personal Care', '').key, 'beauty');
  assert.equal(cfg.thresholdFor('Health & Personal Care', '').key, 'health');
  assert.equal(cfg.thresholdFor('Musical Instruments', '').key, 'musical');
  assert.equal(cfg.remarkText(12345, 'Beauty'), 'BSR 12345 in Beauty');
  assert.equal(cfg.remarkText(null, 'Beauty'), 'BSR not available in Beauty');
  assert.equal(cfg.normalizeOrigin('http://x:3000/a'), 'http://x:3000');
});

test('FUNCTIONAL: failed mode fills every field from .in + .com', async () => {
  const { engine, dash } = await runEngine({ rows: [R('B0AAAA1111')], verdicts: { B0AAAA1111: 'pass' }, settings: { mode: 'failed' } });
  await waitDone(engine);
  const a = dash.calls.byAsin.B0AAAA1111;
  assert.equal(a.writes.weight, '200');
  assert.equal(a.writes.inr, '499');
  assert.equal(a.writes.usd, '9.99');
  assert.match(a.writes.sourceLink, /amazon\.com\/dp\/B0AAAA1111/);
  assert.ok(a.writes.remark);
  assert.equal(a.funnel, 'RS');
  assert.equal(a.category, 'Beauty & Personal Care');
});

test('FUNCTIONAL: scrapeUsa re-sets US location when .com shows ₹', async () => {
  // usaData is location-dependent by default: ₹ first, USD after SET_US_LOCATION.
  const { engine, dash, env } = await runEngine({ rows: [R('B0AAAA1111')], verdicts: { B0AAAA1111: 'pass' }, settings: { mode: 'failed' } });
  await waitDone(engine);
  assert.equal(env.usLocSet, true, 'engine set the US location');
  assert.equal(dash.calls.byAsin.B0AAAA1111.writes.usd, '9.99', 'USD captured after re-scrape');
});

test('FUNCTIONAL: sourceLinkHost=in writes the .in URL', async () => {
  const { engine, dash } = await runEngine({ rows: [R('B0AAAA1111')], verdicts: { B0AAAA1111: 'pass' }, settings: { mode: 'failed', sourceLinkHost: 'in' } });
  await waitDone(engine);
  assert.match(dash.calls.byAsin.B0AAAA1111.writes.sourceLink, /amazon\.in\/dp\/B0AAAA1111/);
});

test('FUNCTIONAL: getRecords exposes the per-row audit fields', async () => {
  const { engine } = await runEngine({ rows: [R('B0AAAA1111')], verdicts: { B0AAAA1111: 'pass' }, settings: { mode: 'failed' } });
  await waitDone(engine);
  const rec = engine.getRecords().find(r => r.asin === 'B0AAAA1111');
  assert.equal(rec.weight, 200); assert.equal(rec.inr, 499); assert.equal(rec.usd, 9.99);
  assert.equal(rec.funnel, 'RS'); assert.equal(rec.moved, true); assert.equal(rec.verdict, 'pass');
});

// ============================================================== USER FLOWS
test('USER: failed-file run moves passing rows, leaves failing rows', async () => {
  const rows = [R('B0AAAA1111'), R('B0BBBB2222')];
  const { engine, dash } = await runEngine({ rows, verdicts: { B0AAAA1111: 'pass', B0BBBB2222: 'fail' }, settings: { mode: 'failed' } });
  const st = await waitDone(engine);
  assert.equal(st.counters.processed, 2);
  assert.equal(dash.calls.byAsin.B0AAAA1111.move, 1, 'passing row moved');
  assert.equal(dash.calls.byAsin.B0BBBB2222.move, 0, 'failing row not moved');
  assert.equal(st.counters.moved, 1);
  assert.ok(st.counters.flagged >= 1, 'failing row flagged');
});

test('USER: pass-file run touches funnel + remark ONLY', async () => {
  const { engine, dash } = await runEngine({ rows: [R('B0DDDD4444')], settings: { mode: 'pass' } });
  const st = await waitDone(engine);
  const d = dash.calls.byAsin.B0DDDD4444;
  assert.deepEqual(Object.keys(d.writes), ['remark']);
  assert.equal(d.funnel, 'RS');
  assert.equal(d.peek, 0);
  assert.equal(d.move, 0);
  assert.equal(st.counters.processed, 1);
});

test('USER: dry-run writes NOTHING to the dashboard', async () => {
  const { engine, dash } = await runEngine({ rows: [R('B0AAAA1111')], settings: { mode: 'failed', dryRun: true } });
  const st = await waitDone(engine);
  assert.equal(st.counters.processed, 1, 'row still processed');
  assert.deepEqual(dash.calls.byAsin, {}, 'no write/funnel/category/verdict calls');
  assert.ok(!dash.calls.all.includes('WRITE_FIELD'));
  assert.ok(!dash.calls.all.includes('CLICK_PASS'));
});

test('USER: reset clears counters and returns to Idle', async () => {
  const { engine } = await runEngine({ rows: [R('B0AAAA1111')], verdicts: { B0AAAA1111: 'pass' }, settings: { mode: 'failed' } });
  await waitDone(engine);
  await engine.reset();
  const st = engine.getStatus();
  assert.equal(st.status, 'Idle');
  assert.equal(st.counters.processed, 0);
  assert.equal(st.counters.moved, 0);
  assert.equal(st.counters.corrected, 0);
  assert.equal(st.processedCount, 0);
});

test('USER: pause() before a run is a no-op with a clear error', async () => {
  const { engine } = await runEngine({ rows: [], settings: { mode: 'pass' } });
  await waitDone(engine);
  const r = engine.pause();
  assert.equal(r.ok, false);
  assert.match(r.error, /not running/);
});

// ============================================================== REGRESSION
test('REGRESSION: CAPTCHA is detected via pageType and pauses the run', async () => {
  // The bug: engine read `.type` but the content script sends `.pageType`, so
  // captchas were never detected. Serve a captcha wall and assert we pause.
  const { engine } = await runEngine({
    rows: [R('B0AAAA1111')], verdicts: { B0AAAA1111: 'pass' }, settings: { mode: 'failed' },
    env: { detect: () => 'captcha' },
  });
  const paused = await waitFor(() => engine.getStatus().pausedByCaptcha === true);
  assert.equal(paused, true, 'run paused on CAPTCHA (proves .pageType wiring)');
  await engine.stop();
});

test('REGRESSION: pass mode never writes weight/inr/usd/source', async () => {
  const { engine, dash } = await runEngine({ rows: [R('B0DDDD4444')], settings: { mode: 'pass' } });
  await waitDone(engine);
  const w = dash.calls.byAsin.B0DDDD4444.writes;
  assert.equal(w.weight, undefined);
  assert.equal(w.inr, undefined);
  assert.equal(w.usd, undefined);
  assert.equal(w.sourceLink, undefined);
});

test('REGRESSION: USD is not written when amazon.com stays ₹', async () => {
  // .com never yields USD even after a location set → usd must be null, flagged,
  // never written as a rupee value into the USD column.
  const { engine, dash } = await runEngine({
    rows: [R('B0EEEE5555')], verdicts: { B0EEEE5555: 'fail' }, settings: { mode: 'failed' },
    env: { usaData: (asin) => ({ asin, priceValue: 830, currency: 'INR', canonicalUrl: `https://www.amazon.com/dp/${asin}` }) },
  });
  const st = await waitDone(engine);
  assert.equal(dash.calls.byAsin.B0EEEE5555.writes.usd, undefined, 'no USD written');
  assert.ok(st.counters.flagged >= 1);
});

test('REGRESSION: a missing scraped value never blanks its cell', async () => {
  // amazon.in returns no weight → the weight cell must be left untouched.
  const { engine, dash } = await runEngine({
    rows: [R('B0FFFF6666')], verdicts: { B0FFFF6666: 'fail' }, settings: { mode: 'failed' },
    env: { indiaData: (asin) => ({ asin, bsrPrimary: 12345, bsrPrimaryCategory: 'Beauty & Personal Care',
      categoryPath: ['Beauty & Personal Care'], weightGrams: null, priceValue: 499, currency: 'INR',
      canonicalUrl: `https://www.amazon.in/dp/${asin}` }) },
  });
  await waitDone(engine);
  const w = dash.calls.byAsin.B0FFFF6666.writes;
  assert.equal(w.weight, undefined, 'weight left untouched (not blanked)');
  assert.equal(w.inr, '499', 'other fields still written');
});

test('REGRESSION: counters reset cleanly between two Start runs', async () => {
  const { engine } = await runEngine({ rows: [R('B0AAAA1111')], verdicts: { B0AAAA1111: 'pass' }, settings: { mode: 'failed' } });
  await waitDone(engine);
  assert.equal(engine.getStatus().counters.processed, 1);
  await engine.start();           // fresh run, same engine
  const st = await waitDone(engine);
  assert.equal(st.counters.processed, 1, 'not doubled from the previous run');
  assert.equal(st.counters.moved, 1);
});
