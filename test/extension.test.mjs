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
    if (msg.type === 'SCRAPE_SELLERS') return Promise.resolve({ ok: true, count: opts.sellerCount ?? null });
    if (msg.type === 'SEARCH_AND_MATCH') return Promise.resolve({ ok: true, match: null, candidates: [] });
    if (msg.type === 'MP_SEARCH_SCRAPE') {
      const host = (String(url).match(/https?:\/\/([^/]+)/) || [])[1] || '';
      const hit = (opts.availableHosts || []).includes(host);
      return Promise.resolve({ ok: true, titles: hit ? [opts.productTitle || 'Glass Seed Beads White'] : [] });
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
  const rec = a => (calls.byAsin[a] ||= { writes: {}, funnel: null, category: null, peek: 0, move: 0, origin: null, checklist: null });
  async function sendToDashboard(m) {
    calls.all.push(m.type);
    switch (m.type) {
      case 'READ_PAGE_ROWS': return { ok: true, rows };
      case 'READ_PAGINATION': return { ok: true, pagination: { page: 1, totalPages: 1 } };
      case 'HIGHLIGHT_ROW': return { ok: true };
      case 'WRITE_FIELD': rec(m.asin).writes[m.field] = m.value; return { ok: true, corrected: true, now: m.value };
      case 'SET_FUNNEL': rec(m.asin).funnel = m.funnel; return { ok: true, changed: true, current: 'DP' };
      case 'SELECT_CATEGORY': rec(m.asin).category = m.category; return { ok: true, chosen: m.category };
      case 'SET_ORIGIN': rec(m.asin).origin = m.labels; return { ok: true, added: m.labels, current: m.labels };
      case 'SET_CHECKLIST': rec(m.asin).checklist = m.labels; return { ok: true, added: m.labels, current: m.labels };
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

test('FUNCTIONAL: Amazon category → dashboard taxonomy mapping', async () => {
  const cfg = await import(configUrl);
  // The exact cases that failed in the live Failed-file run:
  assert.equal(cfg.mapCategory('Health & Personal Care'), 'Health - Other Products');
  assert.equal(cfg.mapCategory('Grocery & Gourmet Foods'), 'Grocery and Gourmet - Other Products');
  assert.equal(cfg.mapCategory('Pet Supplies'), 'Pet - Other Products');
  assert.equal(cfg.mapCategory('Car & Motorbike'), 'Automotive - Other Products');
  assert.equal(cfg.mapCategory('Computers & Accessories'), 'Accessories Electronics PC Wireless');
  assert.equal(cfg.mapCategory('Beauty'), 'Beauty - Other Products');
  assert.equal(cfg.mapCategory('Books'), 'Books');
  assert.equal(cfg.mapCategory('Home & Kitchen'), 'Home - Other Products');
  assert.equal(cfg.mapCategory('Musical Instruments'), 'Musical Instruments - Other Products');
  assert.equal(cfg.mapCategory('Baby Products'), 'Baby - Other Products');
  // beauty must win over the "personal care" health rule
  assert.equal(cfg.mapCategory('Beauty & Personal Care'), 'Beauty - Other Products');
  assert.equal(cfg.mapCategory(''), '');
  assert.equal(cfg.mapCategory('Totally Unknown Xyz'), '');
});

test('FUNCTIONAL: Pass-file Origin + Checklist decision rules', async () => {
  const cfg = await import(configUrl);
  // Origin: US always; IN only when sellable in India.
  assert.deepEqual(cfg.decideOrigin({ indiaAvailable: true }), { us: true, in: true });
  assert.deepEqual(cfg.decideOrigin({ indiaAvailable: false }), { us: true, in: false });
  assert.deepEqual(cfg.decideOrigin({}), { us: true, in: false });
  // Checklist: Expiry always; Size when weight < 700 g; Brand+Multi when sellers > 5.
  assert.deepEqual(cfg.decideChecklist({ weightGrams: 200, sellerCount: 9 }), { brand: true, expiry: true, size: true, multi: true });
  assert.deepEqual(cfg.decideChecklist({ weightGrams: 700, sellerCount: 5 }), { brand: false, expiry: true, size: false, multi: false });
  assert.deepEqual(cfg.decideChecklist({ weightGrams: 699, sellerCount: 6 }), { brand: true, expiry: true, size: true, multi: true });
  assert.deepEqual(cfg.decideChecklist({ weightGrams: null, sellerCount: null }), { brand: false, expiry: true, size: false, multi: false });
});

test('FUNCTIONAL: multi-marketplace query, similarity, availability', async () => {
  const cfg = await import(configUrl);
  // query builder dedupes a leading brand
  assert.equal(cfg.availabilityQuery('Mill Hill', 'Mill Hill Glass Seed Beads'), 'Mill Hill Glass Seed Beads');
  assert.equal(cfg.availabilityQuery('Nykaa', 'Matte Lipstick Red'), 'Nykaa Matte Lipstick Red');
  assert.equal(cfg.availabilityQuery('', 'Just A Name'), 'Just A Name');
  // similarity: same title ~1, unrelated ~0
  assert.ok(cfg.titleSimilarity('Glass Seed Beads White', 'Glass Seed Beads White') > 0.99);
  assert.ok(cfg.titleSimilarity('Glass Seed Beads', 'Bluetooth Speaker') < 0.2);
  // search URLs per marketplace
  const byKey = Object.fromEntries(cfg.MARKETPLACES.map(m => [m.key, m]));
  assert.equal(byKey.flipkart.search('a b'), 'https://www.flipkart.com/search?q=a%20b');
  assert.equal(byKey.amazon_in.search('x'), 'https://www.amazon.in/s?k=x');
  assert.ok(byKey.nykaa && byKey.meesho && byKey.jiomart, 'all 5 marketplaces present');
  // availability decision
  assert.deepEqual(cfg.decideIndiaAvailable([{ key: 'flipkart', sim: 0.6 }, { key: 'nykaa', sim: 0.1 }]), { available: true, sites: ['flipkart'] });
  assert.deepEqual(cfg.decideIndiaAvailable([{ key: 'meesho', matched: true, sim: 0 }]), { available: true, sites: ['meesho'] });
  assert.deepEqual(cfg.decideIndiaAvailable([{ key: 'nykaa', sim: 0.2 }]), { available: false, sites: [] });
  assert.deepEqual(cfg.decideIndiaAvailable([]), { available: false, sites: [] });
});

test('FUNCTIONAL: chip label maps use dashboard wording (US/India, Expire)', async () => {
  const cfg = await import(configUrl);
  assert.deepEqual(cfg.originLabels({ us: true, in: true }), ['US', 'India']);
  assert.deepEqual(cfg.originLabels({ us: true, in: false }), ['US']);
  assert.deepEqual(cfg.checklistLabels({ brand: true, expiry: true, size: true, multi: true }), ['Brand', 'Expire', 'Size', 'Multi']);
  assert.deepEqual(cfg.checklistLabels({ brand: false, expiry: true, size: false, multi: false }), ['Expire']);
});

test('USER: enrichment ticks India from a LIVE amazon.in page (no search needed)', async () => {
  // .in product page is live (detect → product) → India without any marketplace hit.
  const rows = [R('B0AAAA1111', { title: 'Glass Seed Beads White', brand: 'Mill Hill' })];
  const { engine, dash } = await runEngine({
    rows, settings: { mode: 'pass' },
    env: { sellerCount: 9, availableHosts: [], detect: () => 'product' },
  });
  await waitDone(engine);
  const a = dash.calls.byAsin.B0AAAA1111;
  assert.deepEqual(a.origin, ['US', 'India'], 'India from live .in page');
  assert.deepEqual(a.checklist, ['Brand', 'Expire', 'Size', 'Multi'], 'Brand + Expire + Size(<700g) + Multi(9>5)');
});

test('USER: enrichment falls back to marketplace search when .in page is dead', async () => {
  // .in page not_found → search runs; found on Flipkart → India ticked.
  const rows = [R('B0AAAA1111', { title: 'Glass Seed Beads White', brand: 'Mill Hill' })];
  const { engine, dash } = await runEngine({
    rows, settings: { mode: 'pass' },
    env: { sellerCount: 9, detect: () => 'not_found', availableHosts: ['www.flipkart.com'], productTitle: 'Glass Seed Beads White' },
  });
  await waitDone(engine);
  assert.deepEqual(dash.calls.byAsin.B0AAAA1111.origin, ['US', 'India'], 'India via Flipkart fallback');
});

test('USER: enrichment omits India/Multi/Size when .in dead + nowhere else + heavy', async () => {
  const rows = [R('B0GGGG7777', { title: 'Obscure Item XYZ', brand: 'NoBrand' })];
  const { engine, dash } = await runEngine({
    rows, settings: { mode: 'pass' },
    env: { sellerCount: 3, availableHosts: [], detect: () => 'not_found',
      indiaData: (asin) => ({ asin, bsrPrimary: 12345, bsrPrimaryCategory: 'Beauty', categoryPath: ['Beauty'],
        weightGrams: 900, priceValue: 499, currency: 'INR', canonicalUrl: `https://www.amazon.in/dp/${asin}` }) },
  });
  await waitDone(engine);
  const a = dash.calls.byAsin.B0GGGG7777;
  assert.deepEqual(a.origin, ['US'], 'US only (not sellable in India)');
  assert.deepEqual(a.checklist, ['Expire'], 'Expire only (900g not <700, 3 sellers not >5)');
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
  assert.equal(a.writes.sourceLink, undefined, 'no Source Link column on this dashboard');
  assert.ok(a.writes.remark);
  assert.equal(a.funnel, 'RS');
  assert.equal(a.category, 'Beauty - Other Products', 'Amazon "Beauty & Personal Care" mapped to dashboard taxonomy');
});

test('FUNCTIONAL: scrapeUsa re-sets US location when .com shows ₹', async () => {
  // usaData is location-dependent by default: ₹ first, USD after SET_US_LOCATION.
  const { engine, dash, env } = await runEngine({ rows: [R('B0AAAA1111')], verdicts: { B0AAAA1111: 'pass' }, settings: { mode: 'failed' } });
  await waitDone(engine);
  assert.equal(env.usLocSet, true, 'engine set the US location');
  assert.equal(dash.calls.byAsin.B0AAAA1111.writes.usd, '9.99', 'USD captured after re-scrape');
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
  const { engine, dash } = await runEngine({ rows: [R('B0DDDD4444')], settings: { mode: 'pass', passEnrich: false } });
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
  const { engine, dash } = await runEngine({ rows: [R('B0DDDD4444')], settings: { mode: 'pass', passEnrich: false } });
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

// ============================================================== MERGE (Main)
const mainEngineUrl = () => pathToFileURL(path.join(ROOT, 'modules/engine-main.js')).href + '?t=' + Math.random();

async function makeMainEngine(rows, settings = {}) {
  const { chrome } = makeEnv({});
  global.chrome = chrome;
  await chrome.storage.local.set({ pfvSettings: {
    mode: 'main', dryRun: true, throttleMinMs: 0, throttleMaxMs: 0, pageTimeoutMs: 1200,
    showWorkingTab: false, weightMode: 'off', useLlmCategory: false, passEnrich: false,
    dashboardOrigin: 'http://localhost:3000', ...settings,
  } });
  const { createMainEngine } = await import(mainEngineUrl());
  const dash = makeDashboard(rows, {});
  const engine = createMainEngine({
    log: () => {}, sendToDashboard: dash.sendToDashboard,
    focusDashboard: async () => {}, getWorkingWindowId: async () => null, emit: () => {},
  });
  await engine.hydrated;
  return { engine, dash };
}

test('MERGE: Main engine constructs with the full public API (drop-in compatible)', async () => {
  const { engine } = await makeMainEngine([]);
  for (const m of ['start', 'pause', 'resume', 'stop', 'reset', 'closeTabs', 'wantsResume', 'getStatus', 'getRecords']) {
    assert.equal(typeof engine[m], 'function', `Main engine exposes ${m}()`);
  }
  const st = engine.getStatus();
  assert.equal(st.running, false);
  assert.equal(st.paused, false);
});

test('MERGE: Main engine uses the isolated pfvm* storage namespace', async () => {
  const { engine } = await makeMainEngine([]);
  await engine.reset();
  const store = global.chrome.storage.local;
  // Pass/Failed keys must NOT be created by the Main engine.
  const pass = await store.get(['pfvRunState', 'pfvProcessedAsins']);
  assert.deepEqual(pass, {}, 'Main engine did not touch pfv* (Pass/Failed) keys');
});

test('MERGE: Main engine runs an empty page to completion without error', async () => {
  const { engine } = await makeMainEngine([]);
  await engine.start();
  const st = await waitDone(engine, 6000);
  assert.equal(st.running, false, 'run ended');
  assert.match(st.status, /done/i);
});

// ============================================================== MERGE (Main pipeline, live)
function makeMainDashboard(rows, opts = {}) {
  const verdict = opts.verdict || 'pass';
  const funnelOk = opts.funnelOk !== false;
  const calls = { byAsin: {}, all: [] };
  const rec = a => (calls.byAsin[a] ||= { writes: {}, funnel: null, category: null, origin: null, checklist: null, peek: 0, pass: 0, usaLink: null });
  const CAT_OPTS = ['Beauty - Other Products', 'Books', 'Health - Other Products', 'Automotive - Other Products',
    'Accessories Electronics PC Wireless', 'Home - Other Products', 'Pet - Other Products'];
  async function sendToDashboard(m) {
    calls.all.push(m.type);
    const a = m.asin;
    switch (m.type) {
      case 'READ_PAGE_ROWS': return { ok: true, rows };
      case 'READ_PAGINATION': return { ok: true, pagination: { page: 1, totalPages: 1 } };
      case 'HIGHLIGHT_ROW': return { ok: true };
      case 'GET_CATEGORY_OPTIONS': return { ok: true, options: CAT_OPTS, selected: '' };
      case 'WRITE_FIELD': rec(a).writes[m.field] = m.value; return { ok: true, corrected: false, now: m.value };
      case 'SELECT_CATEGORY': rec(a).category = m.category; return { ok: true, chosen: m.category };
      case 'SET_FUNNEL': rec(a).funnel = m.funnel; return { ok: funnelOk, changed: false, current: funnelOk ? m.funnel : 'DP' };
      case 'SET_USA_LINK': rec(a).usaLink = m.url; return { ok: true };
      case 'READ_ROW_FIELDS': return { ok: true, fields: { weight: '200', inr: '499', usd: '9.99', sourceLink: 'https://www.amazon.com/dp/' + a, category: 'Beauty - Other Products', funnel: 'RS' } };
      case 'CLICK_PASS': if (m.opts && m.opts.peek) { rec(a).peek++; return { ok: true, verdict }; } rec(a).pass++; return { ok: true, verdict };
      case 'SET_ORIGIN': rec(a).origin = m.labels; return { ok: true, added: m.labels };
      case 'SET_CHECKLIST': rec(a).checklist = m.labels; return { ok: true, added: m.labels };
      default: return { ok: true };
    }
  }
  return { sendToDashboard, calls };
}
async function runMain(rows, settings = {}, envOpts = {}, dashOpts = {}) {
  const { chrome } = makeEnv(envOpts);
  global.chrome = chrome;
  await chrome.storage.local.set({ pfvSettings: {
    mode: 'main', dryRun: false, throttleMinMs: 0, throttleMaxMs: 0, pageTimeoutMs: 1200,
    showWorkingTab: false, weightMode: 'off', useLlmCategory: false, passEnrich: true, countSellers: true,
    bsrThreshold: 50000, usZip: '10001', dashboardOrigin: 'http://localhost:3000', ...settings,
  } });
  const { createMainEngine } = await import(mainEngineUrl());
  const dash = makeMainDashboard(rows, dashOpts);
  const engine = createMainEngine({
    log: () => {}, sendToDashboard: dash.sendToDashboard,
    focusDashboard: async () => {}, getWorkingWindowId: async () => null, emit: () => {},
  });
  await engine.hydrated;
  await engine.start();
  return { engine, dash };
}

test('MERGE (Main): a live product routes to PASS, with mapped category + Origin/Checklist', async () => {
  const rows = [R('B0AAAA1111', { title: 'Glass Seed Beads White', brand: 'Mill Hill' })];
  const { engine, dash } = await runMain(rows, {}, { sellerCount: 9 });
  const st = await waitDone(engine, 8000);
  assert.match(st.status, /done/i, 'run completed');
  assert.equal(st.counters.processed, 1);
  assert.equal(st.counters.passed, 1, 'row passed');
  const a = dash.calls.byAsin.B0AAAA1111;
  // accuracy: Amazon "Beauty & Personal Care" mapped to the dashboard taxonomy, no LLM
  assert.equal(a.category, 'Beauty - Other Products', 'category via CATEGORY_MAP');
  // funnel from India BSR 12345 < 50000 -> RS
  assert.equal(a.funnel, 'RS');
  // fields written from the scrapes (engine may write numbers; the content
  // script String()s them, so compare loosely)
  assert.equal(String(a.writes.weight), '200'); assert.equal(String(a.writes.usd), '9.99');
  // enrichment: Origin US+India (live .in product), Checklist Brand+Multi (9 sellers)
  assert.deepEqual(a.origin, ['US', 'India']);
  assert.deepEqual(a.checklist, ['Brand', 'Expire', 'Size', 'Multi']);
  assert.ok(a.pass >= 1, 'Move Pass clicked');
});

test('MERGE (Main): a dead amazon.in page routes to Link NF (no field writes)', async () => {
  const rows = [R('B0DEAD0000', { title: 'Gone', brand: 'X' })];
  const { engine, dash } = await runMain(rows, {}, { detect: () => 'not_found' });
  const st = await waitDone(engine, 8000);
  assert.match(st.status, /done/i);
  assert.equal(st.counters.linkNf, 1, 'routed to Link NF');
  assert.equal(st.counters.passed, 0);
  const a = dash.calls.byAsin.B0DEAD0000;
  assert.equal(a && a.pass || 0, 0, 'never clicked Pass');
});

// ============================================================== SCENARIOS (exhaustive)
const inData = (over) => (asin) => ({ asin, bsrPrimary: 12345, bsrPrimaryCategory: 'Beauty & Personal Care',
  categoryPath: ['Beauty & Personal Care'], weightGrams: 200, priceValue: 499, currency: 'INR',
  canonicalUrl: `https://www.amazon.in/dp/${asin}`, ...over });

// ---- Pass mode ----
test('SCENARIO Pass: funnel corrected when wrong (counter ticks)', async () => {
  const { engine, dash } = await runEngine({ rows: [R('B0PASS0001')], settings: { mode: 'pass', passEnrich: false } });
  const st = await waitDone(engine);
  assert.equal(dash.calls.byAsin.B0PASS0001.funnel, 'RS');
  assert.equal(st.counters.funnelChanged, 1);
});
test('SCENARIO Pass: BSR missing → DP + "not available" remark', async () => {
  const { engine, dash } = await runEngine({ rows: [R('B0PASS0002')], settings: { mode: 'pass', passEnrich: false },
    env: { indiaData: inData({ bsrPrimary: null }) } });
  await waitDone(engine);
  const d = dash.calls.byAsin.B0PASS0002;
  assert.equal(d.funnel, 'DP');
  assert.match(d.writes.remark, /not available/i);
});
test('SCENARIO Pass: category thresholds (sports 25k→RS, 35k→DP)', async () => {
  const a = await runEngine({ rows: [R('B0SPORT001')], settings: { mode: 'pass', passEnrich: false },
    env: { indiaData: inData({ bsrPrimary: 25000, bsrPrimaryCategory: 'Sports, Fitness & Outdoors', categoryPath: ['Sports'] }) } });
  await waitDone(a.engine); assert.equal(a.dash.calls.byAsin.B0SPORT001.funnel, 'RS');
  const b = await runEngine({ rows: [R('B0SPORT002')], settings: { mode: 'pass', passEnrich: false },
    env: { indiaData: inData({ bsrPrimary: 35000, bsrPrimaryCategory: 'Sports, Fitness & Outdoors', categoryPath: ['Sports'] }) } });
  await waitDone(b.engine); assert.equal(b.dash.calls.byAsin.B0SPORT002.funnel, 'DP');
});

// ---- Failed mode ----
test('SCENARIO Failed: weight mismatch (.in vs .com >15%) is flagged', async () => {
  const { engine } = await runEngine({ rows: [R('B0WMIS0001')], verdicts: { B0WMIS0001: 'fail' }, settings: { mode: 'failed' },
    env: { usaData: (asin) => ({ asin, priceValue: 9.99, currency: 'USD', weightGrams: 900, canonicalUrl: `https://www.amazon.com/dp/${asin}` }) } });
  const st = await waitDone(engine);
  const rec = engine.getRecords().find(r => r.asin === 'B0WMIS0001');
  assert.ok(rec.flags.some(f => /weight mismatch/i.test(f)), 'weight mismatch flagged');
  assert.ok(st.counters.flagged >= 1);
});
test('SCENARIO Main: non-INR .in currency is written but flagged', async () => {
  const { engine } = await runMain([R('B0CURR0001')], {}, { sellerCount: 3, indiaData: inData({ currency: 'USD' }) });
  await waitDone(engine, 8000);
  const rec = engine.getRecords().find(r => r.asin === 'B0CURR0001');
  assert.ok(rec.flags.some(f => /INR currency/i.test(f)), 'Main flags a non-INR amazon.in price');
});

// ---- Main mode ----
test('SCENARIO Main: a .com India link is rewritten to .in and still passes', async () => {
  const rows = [{ asin: 'B0RWRT0001', indiaUrl: 'https://www.amazon.com/dp/B0RWRT0001', usaUrl: 'https://www.amazon.com/dp/B0RWRT0001' }];
  const { engine } = await runMain(rows, {}, { sellerCount: 3 });
  const st = await waitDone(engine, 8000);
  assert.equal(st.counters.linkNf, 0, 'not Link NF — link was rewritten');
  assert.equal(st.counters.passed, 1);
});
test('SCENARIO Main: .in redirect to a DIFFERENT ASIN → Link NF', async () => {
  const { engine } = await runMain([R('B0REDIR001')], {}, { indiaData: () => inData({})('B0OTHER999') });
  const st = await waitDone(engine, 8000);
  assert.equal(st.counters.linkNf, 1, 'wrong-product redirect routes to Link NF');
  assert.equal(st.counters.passed, 0);
});
test('SCENARIO Main: funnel that cannot be set → NOT passed, flagged', async () => {
  const { engine } = await runMain([R('B0FUNN0001')], {}, { sellerCount: 3 }, { funnelOk: false });
  const st = await waitDone(engine, 8000);
  assert.equal(st.counters.passed, 0, 'not passed with an unfixable funnel');
  assert.ok(st.counters.flagged >= 1);
});
test('SCENARIO Main: FAIL verdict (profitable, no rescue) → Move Fail', async () => {
  // High INR so India price > USA price → profitable → no cheaper-.com rescue.
  const { engine } = await runMain([R('B0FAIL0001')], {}, { sellerCount: 3, indiaData: inData({ priceValue: 99999 }) }, { verdict: 'fail' });
  const st = await waitDone(engine, 8000);
  assert.equal(st.counters.failed, 1, 'routed to Move Fail');
  assert.equal(st.counters.passed, 0);
});
test('SCENARIO Main: dry-run fills fields but commits NO verdict', async () => {
  // Main dry-run (unlike Pass/Failed) DOES write fields; it only withholds the
  // status-changing clicks (Pass / Fail / Link NF).
  const { engine, dash } = await runMain([R('B0DRYM0001')], { dryRun: true }, { sellerCount: 9 });
  const st = await waitDone(engine, 8000);
  assert.equal(st.counters.processed, 1);
  assert.equal(st.counters.passed, 0); assert.equal(st.counters.failed, 0); assert.equal(st.counters.linkNf, 0);
  assert.equal(dash.calls.byAsin.B0DRYM0001 && dash.calls.byAsin.B0DRYM0001.pass || 0, 0, 'no Move Pass click in dry-run');
});

// ---- config edge cases ----
test('SCENARIO config: decideFunnel boundary is inclusive (>= threshold → DP)', async () => {
  const cfg = await import(configUrl);
  assert.equal(cfg.decideFunnel(50000, 'other', '').funnel, 'DP');   // exactly at cutoff
  assert.equal(cfg.decideFunnel(49999, 'other', '').funnel, 'RS');
  assert.equal(cfg.decideFunnel(60000, 'Beauty & Personal Care', '').funnel, 'DP');
  assert.equal(cfg.decideFunnel(59999, 'Beauty & Personal Care', '').funnel, 'RS');
});
test('SCENARIO config: thresholdFor resolves every category key', async () => {
  const cfg = await import(configUrl);
  assert.equal(cfg.thresholdFor('Sports, Fitness & Outdoors', '').key, 'sports');
  assert.equal(cfg.thresholdFor('Baby Products', '').key, 'baby');
  assert.equal(cfg.thresholdFor('Musical Instruments', '').key, 'musical');
  assert.equal(cfg.thresholdFor('Random Unknown', '').key, 'other');
});
test('SCENARIO config: mapCategory covers more departments', async () => {
  const cfg = await import(configUrl);
  assert.equal(cfg.mapCategory('Toys & Games'), 'Toys - Other Products');
  assert.equal(cfg.mapCategory('Office Products'), 'Office - Other Products');
  assert.equal(cfg.mapCategory('Shoes & Handbags'), 'Shoes');
  assert.equal(cfg.mapCategory('Watches'), 'Watches');
  assert.equal(cfg.mapCategory('Electronics'), 'Electronic Devices excl TV Camera');
});

test('SCENARIO Main: weight mismatch (.in vs .com >15%) is flagged', async () => {
  const { engine } = await runMain([R('B0WMISM001')], {}, { sellerCount: 3,
    usaData: (asin) => ({ asin, priceValue: 9.99, currency: 'USD', weightGrams: 900, canonicalUrl: `https://www.amazon.com/dp/${asin}` }) });
  await waitDone(engine, 8000);
  const rec = engine.getRecords().find(r => r.asin === 'B0WMISM001');
  assert.ok(rec.flags.some(f => /weight mismatch/i.test(f)), 'Main flags .in vs .com weight mismatch');
});

test('SCENARIO config: mapCategory extended departments', async () => {
  const cfg = await import(configUrl);
  assert.equal(cfg.mapCategory('Televisions'), 'Television');
  assert.equal(cfg.mapCategory('Refrigerators'), 'Refrigerators');
  assert.equal(cfg.mapCategory('Printers & Scanners'), 'Scanners and Printers');
  assert.equal(cfg.mapCategory('Power Banks'), 'Power Banks and Chargers');
  assert.equal(cfg.mapCategory('Sunglasses'), 'Eyewear Sunglasses Frames');
  assert.equal(cfg.mapCategory('Backpacks'), 'Backpacks');
  assert.equal(cfg.mapCategory('Mattresses'), 'Mattresses');
  assert.equal(cfg.mapCategory('Bedsheets & Pillow Covers'), 'Bedsheets Blankets Covers');
  assert.equal(cfg.mapCategory('Wall Art'), 'Wall Art');
  assert.equal(cfg.mapCategory('Cycling'), 'Bicycles');
});
