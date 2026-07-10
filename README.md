# Dropy Pass-Funnel Validator

A **separate** Chrome/Edge (MV3) extension that re-checks the **funnel (RS/DP)**
of rows in the dashboard's **Pass file**, using **category-specific BSR
thresholds**, and writes the **BSR rank into the Remark column**.

It is independent from *Dropy Auto-Validator*: its own service worker, side
panel, storage (`pfv*` keys), and managed amazon.in tab. No LLM/Gemini chat.
You can load and run both extensions at once.

---

## What it does — per Pass-file row
1. Reads the ASIN from the row.
2. Opens **amazon.in** for that ASIN and scrapes the **primary Best Sellers
   Rank** and its **category** (e.g. `#12,345 in Beauty & Personal Care`).
3. Decides the funnel by the category's cutoff:
   **DP if the BSR is missing OR the rank is at/above the cutoff, else RS.**
4. Sets/corrects the row's funnel on the dashboard.
5. Writes the BSR into **Remark** (e.g. `BSR 12345 in Beauty & Personal Care`,
   or `BSR not available`).

### Category thresholds (edit in `config.js`)
| Category (from the Amazon BSR category) | DP if BSR missing or ≥ |
|---|---|
| Beauty | 60,000 |
| Sports / Outdoors | 30,000 |
| Health & Personal Care | 50,000 |
| Baby | 40,000 |
| Musical Instruments | 30,000 |
| **Everything else** | 50,000 (default) |

> Beauty vs Health share the words "Personal Care" — the presence of *beauty*
> vs *health* in the BSR category name decides which cutoff applies.

---

## Install (both machines)
1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this folder
   (`c:\Users\Admin\Desktop\PassFunnelValidator`).
4. Pin it; click the icon to open the side panel.

## Use
1. Open the **Validation dashboard** and switch to the **Pass file** view.
2. In the panel, open **Settings** → confirm the **Dashboard origin** matches,
   **Save**.
3. Leave **Dry-run ON** first → **Start**. It scrapes each row and *logs* the
   funnel + Remark it would write, without touching the dashboard. Verify a few.
4. Turn **Dry-run OFF** → **Start** (or **Restart**) to write live.

### Controls
- **Start** — begins; auto-resumes an interrupted run, else a fresh pass.
- **Pause / Resume**, **Stop**, **⟳ Restart** (clear all + run fresh),
  **↺ Reset** (clear, stay idle), **✕ Close tab**.
- **Auto-resume**: if the browser/PC restarts mid-run, it continues on next
  launch (waits for the dashboard tab to reopen), skipping done ASINs.

---

## Running both extensions at once
- **Storage/state/chat are fully separate** — different extension = isolated
  storage, and this one uses no LLM chat at all.
- Each extension manages **its own amazon.in tab**, so scraping won't collide.
- Caveat: both drive the **same dashboard tab**. Point them at **different
  status views** (this one on the Pass file; Auto-Validator on the Main file)
  so they operate on disjoint rows.

---

## Files
| File | Role |
|---|---|
| `manifest.json` | MV3 manifest (amazon.in content script only) |
| `config.js` | thresholds + `decideFunnel()` / `remarkText()` + settings |
| `background.js` | service worker: dashboard registration, router, engine, auto-resume |
| `modules/engine.js` | Pass-file loop: scrape → decide funnel → set funnel → write Remark |
| `modules/amazon-tab.js` | managed amazon.in tab (reused, unchanged) |
| `content/amazon.js` | amazon.in scraper (reused; adds `bsrPrimaryCategory`) |
| `content/dashboard.js` | dashboard grid ops (reused; adds `remark` column mapping) |
| `sidepanel.html/js` | the panel UI |

## Still to verify (needs a Scan)
The Remark write reuses the dashboard's generic field-writer, matched by the
column header `Remark`. Run **Scan** on the Pass file and send the JSON so the
Remark column + Pass grid are confirmed (and adjusted if the header differs).
# Pass-Funnel
