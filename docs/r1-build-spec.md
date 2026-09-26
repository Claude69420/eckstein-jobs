# R-1 build spec (reconciled 2026-09-25) — stages + Liquid Glass reskin

Read with `APP_MASTER.md` §11 (requirements, answers, decided design) and `docs/liquid-glass-brief.md` (the design brief:
layout, tokens, glass recipes, components, JS shell). **This file overrides the brief wherever they differ.** Log every
amendment in APP_MASTER (§9 ADRs, §11 work log, §12 CHANGELOG) in the same commit.

## 1. Overrides to the brief
1. **Stage storage = `GitHubStageStore`** (brief §8's device-only v1 is superseded). State repo `Claude69420/eckstein-jobs-state`,
   file `stages.json`, shape `{"version":1,"stages":{"<jobNumber>":{"stage":"<key>","at":"<ISO UTC>","by":"<device label>"}}}`,
   only non-`ready` entries stored; missing/unknown = `ready`.
   - Key present (`localStorage['ej_gh_token']`): read `GET https://api.github.com/repos/Claude69420/eckstein-jobs-state/contents/stages.json`
     (`Accept: application/vnd.github.raw+json`, `Authorization: Bearer <key>`; a second GET with `application/vnd.github+json` or the
     response `ETag`/sha is needed for writes). Poll every 60 s while `document.visibilityState==='visible'`, and on `visibilitychange`/`online`.
   - No key: read-only from `https://raw.githubusercontent.com/Claude69420/eckstein-jobs-state/main/stages.json?t=<now>` (CDN ≤ ~5 min).
     `writable=false`; slider locked with "Stages are read-only on this device. Settings → Stages".
   - Writes: optimistic UI → batch changes made within 3 s → `PUT` (`message`, base64 UTF-8 `content`, `sha`, `branch:"main"`),
     commit message like `stage: #684 SW Corner Ellice & Kennedy -> base`. On 409/422: re-GET, re-apply this device's pending
     changes on top (last write per job wins), retry ≤3. Network failure: keep in `localStorage['ej_stage_queue']`, retry on
     `online`/`visibilitychange`. Final failure: roll back + error toast. Undo toast after every move.
   - **localhost / 127.0.0.1 only:** if no key, use `LocalStageStore` (`localStorage['ej_stages']`, same shape) so the UI is
     testable in the preview. Never on the live site.
   - 401/403 from GitHub: mark key invalid, `writable=false`, toast "Edit key rejected — Settings → Stages".
2. **No key in any URL / fragment / setup link.** Settings → Stages has: masked "Paste edit key" field + Save (validates with a
   GET; on success calls `navigator.storage.persist()`), "Remove key", device label field (`ej_device`, default "iPhone app"/"PC"),
   and **"Share edit access"**: `navigator.share` (fallback clipboard) with text: app link, the edit key, and 3 steps
   ("open link in Safari → Share → Add to Home Screen → open the app → Settings → Stages → paste key"). The key is never
   logged, never sent anywhere but `api.github.com`, never rendered unmasked except in the share text the user triggers.
3. **Defaults for the brief's open calls (Riley may change):** chips "solo, then add"; desktop panel on the **left**; tabs
   **Jobs · Routes · Plan**; Settings in the control capsule; stage colours per brief §2.5; desktop hover card + click opens
   detail; Poured stays visible; theme Auto/Light/Dark (Auto default); glass Liquid/Tinted/Solid (Liquid default).
4. **Stage route ("Route" in the filter bar):** from the shop (`S`, then 1..n), open end with a "Return to shop" toggle; uses the
   jobs currently selected in Stage mode (or Client mode); includes pending 9000+ jobs; jobs with `city` ≠ Winnipeg are
   excluded by default and listed under the result with an "Include out-of-town" toggle (legs > 15 km use 70 km/h); ask to
   confirm above 25 stops; Google Maps links split into parts of ≤10 points with overlapping endpoints; `~` estimates,
   "no live traffic". Must not freeze the UI at 60 stops.
5. **PC is first-class** (Riley 2026-09-25): desktop Chrome/Edge at 1440×900 gets the full look incl. hyalite refraction
   behind its gate; acceptance runs at both 375×812 and 1440×900, light + dark.
6. **Files:** as brief §9 plus `js/stages.js` (StageStore adapters) and `js/tsp.js` (optimizer + Google Maps chunking), each
   usable in the browser (plain script, global) and in Node (`module.exports` guard). Node tests (no npm deps) in `tests/`:
   `tests/tsp.test.js` (brute-force optimality ≤8 free stops vs heuristic, fixed start/end/return semantics, 60-stop run
   < 300 ms, chunking ≤10), `tests/stages.test.js` (mocked `fetch`: read with/without key, batching, 409 merge-retry, 422,
   401, offline queue + replay, rollback). Run with `node tests/<file>`.
7. **Ship as ONE squash merge** of branch `r1-stages` into `main` (amends the brief's two-merge plan; rollback = revert that
   single commit, which restores the pre-R-1 app). Bump `sw.js` to `ej-v2` with old-cache cleanup.

## 2. Process (Rule 13)
- Branch `r1-stages` from current `main`. Build agents **do not commit or push**; the main loop commits.
- Build (parallel, disjoint files): (a) `js/tsp.js` + test; (b) `js/stages.js` + test (may run a live API contract test with
  `gh api` against a throwaway file in the state repo, then delete it — never touch `stages.json`); (c) UI: `index.html`,
  `css/*`, `js/ui.js`, `js/app.js`, `vendor/hyalite.js` + LICENSE, `sw.js`, `manifest.json`, icons (Pillow), coding against the
  interfaces of (a)/(b).
- Verify (one agent owns the Browser pane): `preview_start eckstein-jobs`, 375×812 and 1440×900, light + dark, zero console
  errors, exercise Jobs/Routes/Plan, both filter modes, slider (LocalStageStore on localhost), stage route, settings; save
  screenshots.
- Review lenses (parallel): correctness, iOS Safari compatibility (literal + `-webkit-` backdrop-filter, no backdrop-root
  properties on ancestors, `100dvh`, safe areas), security (key handling, escapeHtml on all job data, only api.github.com),
  requirements fidelity (Riley's verbatim request + answers), performance, APP_MASTER updates. Fix loop until no
  critical/major (≤3 rounds, re-verify after fixes).
- Main loop: review screenshots, update APP_MASTER (§2, §4.3, §5, §9 ADRs, §11, §12), squash-merge, push, verify live.

## 3. Riley's steps after ship (Claude guides, never handles the key)
1. Create the edit key: github.com → Settings → Developer settings → Fine-grained tokens → Generate. Name "Eckstein stages",
   expiry 1 year, Repository access **Only select repositories → `eckstein-jobs-state`**, Permissions → Repository →
   **Contents: Read and write**. Copy it into a password manager.
2. iPhone: delete and re-add the Home Screen icon (status-bar change), open the app → Settings → Stages → paste key → Save. PC: same paste.
3. Share with crew: Settings → Stages → Share edit access.
4. Delete the old setup file: `Remove-Item "$env:USERPROFILE\.config\eckstein_jobs_sync\refresh_token.txt"`.
