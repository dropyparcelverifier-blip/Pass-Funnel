# Backlog

Real, self-contained improvements. The scheduled agent (and I, when prompted)
work the **top unchecked** item: implement it, keep `npm test` green (add tests),
tick it off here, and commit as `sagar21-creator`. Browser-only work (live DOM /
LLM) is marked and skipped by the unattended agent.

## Ready (no browser needed)
- [ ] **Conservative overwrite mode.** Add setting `overwritePolicy: 'fresh' | 'fill-empty' | 'flag-only'`. In Failed/Main field writes: `fresh` = current behavior; `fill-empty` = only write when the cell is empty; `flag-only` = never overwrite, just flag differences. Wire in `writeCell`/`writeField`; add tests.
- [ ] **Main dry-run write-free toggle.** Add `mainDryRunWrites: true` (default keeps current fill-fields behavior). When false, Main dry-run skips field writes like Pass/Failed. Gate `writeField` in dry-run; add a test.
- [ ] **Dedup shared helpers.** Extract common pure helpers used by both `engine.js` and `engine-main.js` (sleep/rand/host utils, funnel decision) into `modules/shared.js`; import in both. Tests stay green.
- [ ] **More scenario tests.** Add edge cases: throttle boundaries, pagination advance, `READ_PAGE_ROWS` retry path, empty PASS file → Done, captcha auto-resume timing.
- [ ] **Inline docs / JSDoc.** Add concise JSDoc to the exported config functions and the engine public API. No behavior change; tests green.
- [ ] **Audit JSON export parity.** Ensure the JSON export includes the same unified fields as the CSV; add a small test on `recordsToCsv`/JSON shape by exporting engine records.

## Needs the browser (skip when unattended — for a prompted session)
- [ ] Live dry-run of **Main mode** on the Main file; fix whatever the log surfaces.
- [ ] Confirm Origin/Checklist/Remark selectors on a couple of real rows in each mode.
- [ ] Tune `CATEGORY_MAP` from real category-miss logs.

## Done
- [x] Weight cross-check in Main (`.in` vs `.com`, flag >15%).
- [x] Category map coverage — TV, fridge, printer/scanner, power bank, sunglasses, backpack, mattress, bedsheet, wall art, bicycle.
- [x] Fix red CI (serialize tests, --test-concurrency=1) + failing-name diagnostics.
- [x] Merge Main-file extension into this project (Main/Pass/Failed, isolated storage).
- [x] Map-first category + Origin/Checklist in Main; Main counters + LLM settings UI.
- [x] Suppress Main Source Link write; drop unused `alarms` permission; unified CSV.
- [x] Side-panel redesign (segmented modes, LIVE/DRY switch, mode-aware counters, wide 2-col, collapse-on-hover tools).
- [x] 40-test suite (functional / user / regression / merge / scenarios).
