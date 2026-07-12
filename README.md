# Dropy Pass-Funnel Validator

A **separate** Chrome/Edge (MV3) extension that validates rows in the Scrappy v2
**Validation dashboard**. It has two modes:

- **Pass file** — re-check the **funnel (RS/DP)** by category-specific BSR
  thresholds, write the **BSR rank into Remark**, and tick the **Origin** and
  **Checklist** columns.
- **Failed file** — **full validation**: scrape amazon.in + amazon.com, fill/fix
  **every** field (weight, INR, USD, category, funnel, remark), tick Origin +
  Checklist, then peek the dashboard verdict and **Move Pass** any row that now
  qualifies.

It is independent from *Dropy Auto-Validator*: its own service worker, side
panel, storage (`pfv*` keys), and managed Amazon tab. No LLM/Gemini chat. You
can load and run both extensions at once.

---

## Pass-file mode — per row
1. Read the ASIN, open **amazon.in**, scrape the primary **Best Sellers Rank**
   and its category (e.g. `#12,345 in Beauty & Personal Care`), plus weight.
2. **Funnel** — DP if BSR is missing OR ≥ the category cutoff, else RS. Set on
   the dashboard **only if wrong**.
3. **Remark** — write the rank (e.g. `BSR 12345 in Beauty & Personal Care`, or
   `BSR not available`) via the Remark modal (typed → **Save**).
4. **Origin** — always tick **US**; tick **India** when the product is sellable
   in India (its amazon.in page is a live product; falls back to searching
   Flipkart/Nykaa/Meesho/JioMart/Amazon.in only when the .in page is dead).
5. **Checklist** — tick **Expire** (always), **Size** (weight < 700 g), and
   **Brand + Multi** (more than 5 **unique** amazon.in sellers).

### Category thresholds (edit in `config.js`)
| Category (from the Amazon BSR category) | DP if BSR missing or ≥ |
|---|---|
| Beauty | 60,000 |
| Sports / Outdoors | 30,000 |
| Health & Personal Care | 50,000 |
| Baby | 40,000 |
| Musical Instruments | 30,000 |
| **Everything else** | 50,000 (default) |

> Beauty vs Health share "Personal Care" — the presence of *beauty* vs *health*
> in the BSR category name decides which cutoff applies.

---

## Failed-file mode — per row
1. Scrape **amazon.in** (weight, INR, BSR/category) and **amazon.com** (USD, via
   a US ZIP so it renders dollars).
2. **Overwrite** each field when the scrape is confident (never blanks a good
   cell): Weight (g), INR, USD, Funnel, Remark.
3. **Category** — Amazon's taxonomy is mapped to the dashboard's ~190 custom
   options (`CATEGORY_MAP` in `config.js`); unmapped values fall back to a fuzzy
   match, else are flagged. *(There is no Source Link column — the USA Link is
   the source and is already present.)*
4. **Weight cross-check** — flags a row when amazon.in vs amazon.com weight
   differ by > 15 % (keeps the amazon.in value).
5. **Origin + Checklist** — same as Pass mode.
6. **Verdict** — peek the dashboard's Move Pass/Fail without clicking; if it
   would pass, click **Move Pass** (row leaves the Failed file); otherwise leave
   it and flag why.

---

## Install
1. Go to `chrome://extensions` (or `edge://extensions`), enable **Developer
   mode**, **Load unpacked** → select this folder.
2. Pin it; click the icon to open the side panel. Reload the extension after any
   `manifest.json` change (e.g. added marketplace hosts).

## Use
1. Open the dashboard and switch to the **Pass file** or **Failed file** view.
2. Panel → **Settings**: confirm **Dashboard origin**; for Failed mode set the
   **US ZIP**. **Save**.
3. Panel → **Run**: pick **File / mode** (Pass or Failed).
4. Leave **Dry-run ON** first → **Start**. It scrapes and *logs* every decision
   without writing. Verify a few rows, then turn **Dry-run OFF** and run live.

### Controls & counters
- **Start / Pause / Resume / Stop / ⟳ Restart** (clear + fresh) / **↺ Reset**
  (clear, idle) / **✕ Close tab**. **CSV / JSON** export the per-row audit.
- **Auto-resume** after a crash/restart (waits for the dashboard tab, skips done
  ASINs). **CAPTCHA** auto-pauses and resumes when cleared.
- Counters: Processed, RS, DP, Funnel changed, Flagged, Moved→Pass, Corrected.

### Settings that matter
- `mode` — `pass` | `failed`.
- `passEnrich`, `countSellers`, `checkAvailability` — toggle the Origin/Checklist
  enrichment and its scrapes (each row does extra page loads).
- `alwaysSearchMarketplaces` — force the multi-marketplace search even when the
  .in page is live (slower; off by default).
- `usZip` (Failed USD), throttle, page timeout, `writeRemark`.

---

## Running both extensions at once
- Separate storage/state; each manages its own Amazon tab.
- Both drive the **same dashboard tab** — point them at **different views** so
  they operate on disjoint rows.

---

## Files
| File | Role |
|---|---|
| `manifest.json` | MV3 manifest (content scripts: amazon.in/.com + the 4 marketplaces) |
| `config.js` | thresholds, `decideFunnel`/`remarkText`, category map, Origin/Checklist rules, marketplaces, settings |
| `background.js` | service worker: dashboard registration, message router, engine host, auto-resume, CSV/JSON export |
| `modules/engine.js` | the run loop: Pass + Failed pipelines, scrapes, enrichment, verdict |
| `modules/amazon-tab.js` | the single managed Amazon tab (navigate/ping/rpc) |
| `content/amazon.js` | amazon.in/.com scraper (BSR, weight, price, sellers, US location) |
| `content/dashboard.js` | dashboard grid ops (read/write fields, funnel, category, Origin/Checklist, Remark modal, Move Pass) |
| `content/marketplace.js` | generic search-result title scraper for the India-availability check |
| `sidepanel.html` / `sidepanel.js` | the panel UI |
| `test/extension.test.mjs` | Node test suite (functional / user-flow / regression) |

## Tests
```bash
npm test          # node --test — runs modules/engine.js + config.js against mocks
```
Covers the decision logic, both mode pipelines, the tick/remark wiring, category
mapping, availability, and the fixed regressions. DOM selectors themselves are
best-effort and confirmed by a live dry-run.
