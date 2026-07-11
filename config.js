// config.js (ES module — imported by the service worker)
// Dropy Pass-Funnel Validator: re-checks the FUNNEL of rows in the PASS file
// using CATEGORY-SPECIFIC BSR thresholds, and writes the BSR rank into Remark.
//
// This is a SEPARATE extension from Dropy Auto-Validator. Storage keys are
// namespaced `pfv` so the two never share state (Chrome also isolates storage
// per-extension). No LLM/chat is used here.

// ---------------------------------------------------------------------------
// Storage keys (chrome.storage.local), namespaced `pfv`.
// ---------------------------------------------------------------------------
export const K = {
  SETTINGS:    'pfvSettings',
  RUN_STATE:   'pfvRunState',
  PROCESSED:   'pfvProcessedAsins',
  ROW_RECORDS: 'pfvRowRecords',
  LOG:         'pfvLog',
  COUNTERS:    'pfvCounters',
  LAST_SCAN:   'pfvLastScan',
};

export const LOG_MAX = 500;

// ---------------------------------------------------------------------------
// Category-specific funnel thresholds (India BSR).
//   funnel = (BSR present AND BSR < threshold) ? 'RS' : 'DP'
//   i.e. DP when BSR is MISSING or the rank is AT/ABOVE the category cutoff.
// Categories not listed use DEFAULT_THRESHOLD.
// ---------------------------------------------------------------------------
export const CATEGORY_THRESHOLDS = {
  beauty:  60000,   // Beauty / Beauty & Personal Care
  sports:  30000,   // Sports, Fitness & Outdoors
  health:  50000,   // Health & Personal Care / Health & Household
  baby:    40000,   // Baby / Baby Products
  musical: 30000,   // Musical Instruments
};
export const DEFAULT_THRESHOLD = 50000;

// Map an Amazon BSR-category / breadcrumb string to a threshold key. Order
// matters: check `beauty` before `health` because "Personal Care" appears in
// BOTH "Beauty & Personal Care" and "Health & Personal Care" — the presence of
// the word beauty vs health disambiguates.
const DEPT_MATCHERS = [
  { key: 'beauty',  re: /\bbeaut/i },
  { key: 'health',  re: /\bhealth\b/i },
  { key: 'sports',  re: /\bsport|\boutdoor|fitness\b/i },
  { key: 'baby',    re: /\bbaby\b|\binfant\b|\bnursery\b/i },
  { key: 'musical', re: /\bmusical\b|musical\s+instrument/i },
];

// Resolve the threshold (and its category key) for a BSR-category string.
// Falls back to the breadcrumb root when the BSR category is empty.
export function thresholdFor(bsrCategory, breadcrumbRoot) {
  const text = `${bsrCategory || ''} ${breadcrumbRoot || ''}`;
  for (const m of DEPT_MATCHERS) {
    if (m.re.test(text)) return { key: m.key, threshold: CATEGORY_THRESHOLDS[m.key], matched: true };
  }
  return { key: 'other', threshold: DEFAULT_THRESHOLD, matched: false };
}

// The full funnel decision for one product.
//   bsr:  primary India BSR number, or null/undefined if not available.
// Returns { funnel:'RS'|'DP', threshold, key, reason }.
export function decideFunnel(bsr, bsrCategory, breadcrumbRoot) {
  const { key, threshold, matched } = thresholdFor(bsrCategory, breadcrumbRoot);
  const has = Number.isFinite(bsr) && bsr > 0;
  const funnel = (has && bsr < threshold) ? 'RS' : 'DP';
  const reason = !has
    ? `BSR not available → DP`
    : (bsr < threshold ? `BSR ${bsr} < ${threshold} (${key}) → RS`
                       : `BSR ${bsr} ≥ ${threshold} (${key}) → DP`);
  return { funnel, threshold, key, matched, reason };
}

// The text written into the Remark column. ALWAYS includes the rank (or N/A).
export function remarkText(bsr, bsrCategory) {
  const rank = (Number.isFinite(bsr) && bsr > 0) ? `BSR ${bsr}` : 'BSR not available';
  return bsrCategory ? `${rank} in ${bsrCategory}` : rank;
}

// ---------------------------------------------------------------------------
// Pass-file ORIGIN + CHECKLIST enrichment (Scrappy v2 dashboard columns).
//   Origin    → multi-select chips: US (always) + IN (when sellable in India).
//   Checklist → multi-select: Expiry (always), Size (weight < 700 g),
//               Multi (unique sellers > 5, read from amazon.in buying options).
// ---------------------------------------------------------------------------
export const SIZE_MAX_GRAMS = 700;      // Size ticked when weight is UNDER this.
export const MULTI_MIN_SELLERS = 5;     // Multi ticked when sellers exceed this.

// Which Origin chips to tick. `indiaAvailable` = the product is sellable in
// India (amazon.in live product; extend to other marketplaces later).
export function decideOrigin({ indiaAvailable } = {}) {
  return { us: true, in: !!indiaAvailable };
}

// Which Checklist boxes to tick.
export function decideChecklist({ weightGrams, sellerCount } = {}) {
  return {
    expiry: true,
    size: Number.isFinite(weightGrams) && weightGrams < SIZE_MAX_GRAMS,
    multi: Number.isFinite(sellerCount) && sellerCount > MULTI_MIN_SELLERS,
  };
}

// ---------------------------------------------------------------------------
// Defaults (overridable from the side-panel Settings tab, persisted under K.SETTINGS).
// ---------------------------------------------------------------------------
export const DEFAULT_SETTINGS = {
  // Which file we're processing:
  //   'pass'   → re-check FUNNEL (only if wrong) + write Remark. Nothing else. (default)
  //   'failed' → FULL validation: scrape amazon.in (+ amazon.com for USD), fill/correct
  //              EVERY field (weight, INR, USD, category, funnel, source link, remark),
  //              then PEEK the dashboard verdict and Move Pass only if it would pass.
  mode: 'pass',
  // The dashboard origin (same host as Dropy Auto-Validator). Origin only.
  dashboardOrigin: 'http://100.82.234.106:3000',
  // Randomised human-paced delay between amazon.in loads (ms).
  throttleMinMs: 2000,
  throttleMaxMs: 5000,
  // Per-page hard timeout (ms) before one retry, then flag-and-continue.
  pageTimeoutMs: 30000,
  // Bring the amazon.in tab forward so you can watch which ASIN is scraping.
  showWorkingTab: true,
  // DRY-RUN: compute + log everything but DON'T write to the dashboard.
  dryRun: true,
  // Write the BSR rank into Remark for every processed row.
  writeRemark: true,
  // ---- Failed-file mode only ----
  // US ZIP used to force amazon.com to render USD (India IP otherwise shows ₹).
  usZip: '10001',
  // Which URL goes into the "Source Link" column: 'com' (the USA source you buy
  // from) or 'in' (the India listing).
  sourceLinkHost: 'com',
};

export async function getSettings() {
  const d = await chrome.storage.local.get([K.SETTINGS]);
  return { ...DEFAULT_SETTINGS, ...(d[K.SETTINGS] || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [K.SETTINGS]: next });
  return next;
}

export function normalizeOrigin(raw) {
  try { return new URL(String(raw).trim()).origin; }
  catch { return String(raw || '').trim().replace(/\/+$/, ''); }
}
