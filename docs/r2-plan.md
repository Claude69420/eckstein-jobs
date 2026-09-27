# R-2 plan (2026-09-26): Setup stage, job items, route editing, pricing

Status: shipped; R-2 is the main app (promoted to the site root on 2026-09-26; §9 "Promotion" below; APP_MASTER §7.17, ADR-30).
History: answers received 2026-09-26 (recorded in APP_MASTER §11 "R-2"); beta released at `/beta/` the same day, then promoted.
Builds on R-1 (`docs/r1-build-spec.md`). Riley's request is quoted verbatim in APP_MASTER §11 "R-2".
This file is the build spec for R-2; amend it (and log the amendment) if anything changes.

## 1. Model
**Stage = the work happening now / next** (Q1). Routing a stage = that crew's list.

Stages (7, keys stable; R-1 data carries over, `setup` slots in):
`ready` Ready to start → `setup` Setup (new) → `excavation` → `base` → `prep` → `inspected` Passed inspection → `poured`.

**Items** (all use the same small 3-way switch; defaults in bold):

| Item | Key | States | Shown | Gate / effect |
|---|---|---|---|---|
| Assessed | `assess` | **Not yet** · Virtual · On site | Ready, Setup | Never blocks. "Unassessed" list = Ready/Setup jobs still Not yet |
| Lane closure | `lane` | **N/A** · Required · Booked (+ start/end dates, optional) | Ready, Setup (and later only if still Required) | `Required` blocks Ready → Setup (and anything beyond) |
| Street cut | `cut` | **N/A** · Required · Done | Ready, Setup (and later only if still Required) | `Required` blocks Setup → Excavation (and beyond) |
| Asphalt | `asphalt` | **N/A** (or Required from the Jobber hint) · Required · Done | every stage (planning flag before pour) | Done only possible once Poured |
| Pavers | `pavers` | same as asphalt | every stage | Done only possible once Poured |
| Cuts & cleanup | `cleanup` | **To do** · Done (release cuts + cleanup, one crew member) | Poured | Auto To do at Poured on every job |

- Gates block only; nothing auto-advances. A blocked slider stop shows a lock + reason; the fix is on the same sheet.
- Asphalt / pavers / cleanup are independent after pour (no enforced order; road cut vs isolation and full section vs
  blockout are the crew's call).
- **Field work done** = stage `poured` AND cleanup Done AND asphalt, pavers each N/A or Done. Such jobs stay visible
  (Q6) with a small check until they leave Jobber's active list.
- **Closed in Jobber:** the sync keeps a job that left Jobber's active list when work has started (stage beyond Ready, or
  any item Required) and field work is not done; tagged "Closed in Jobber". "Remove from app" on its sheet clears it.

## 2. stages.json v2 (`Claude69420/eckstein-jobs-state`)
- `{"version":2,"stages":{"<jobNumber>":{"stage":"setup","assess":"virtual","lane":{"s":"booked","from":"2026-10-06","to":"2026-10-08"},"cut":"req","asphalt":"req","pavers":"na","cleanup":"todo","removed":false,"at":"<ISO>","by":"<device>"}}}`
- Only non-default fields stored. v1 entries (`stage`,`at`,`by`) read as v2 unchanged.
- Asphalt/pavers stored explicitly once someone touches them (so a manual N/A beats the Jobber hint).
- **Per-field merge** on 409/422: this device's changed fields win, other fields keep the remote value.
- Store API: `set(jobNumber, patch, meta)` (patch = changed fields); `set(jobNumber, stageKey, meta)` still works.
- Commit messages: `job #684 SW Corner Ellice & Kennedy: stage -> setup, lane -> booked`.

## 2a. Shared contract (JS `js/stages.js` and Python `sync_jobs.py` implement exactly this)
- **Stages** (order = index): `ready` "Ready to start"/"Ready", `setup` "Setup"/"Setup", `excavation` "Excavation"/"Excav.",
  `base` "Base"/"Base", `prep` "Prep"/"Prep", `inspected` "Passed inspection"/"Passed", `poured` "Poured"/"Poured".
  Missing/unknown = `ready`.
- **Item values** (stored only when not default; unknown values dropped on read):
  `assess` `no|virtual|onsite` (default `no`) · `lane` `{s: na|req|booked, from?: YYYY-MM-DD, to?: YYYY-MM-DD}` (default
  `{s:"na"}`; dates only meaningful when booked) · `cut` `na|req|done` (default `na`) · `asphalt`, `pavers` `na|req|done`
  (default = Jobber hint: `req` if `job.hints.asphalt` / `job.hints.pavers` is true, else `na`; **a stored value, including
  `na`, always beats the hint**, so these two are stored as soon as someone sets them) · `cleanup` `todo|done` (default
  `todo`) · `removed` `true` (default false; only has an effect while the job is closed in Jobber).
- **effective(entry, hints)** = every field with defaults and hints applied.
- **Gates (moves only; moving backwards is always allowed):** target index ≥ `setup` while `lane.s == "req"` → blocked
  "Book the lane closure first"; target index ≥ `excavation` while `cut == "req"` → blocked "Street cut must be done first".
  `asphalt`/`pavers`/`cleanup` can only be set to `done` while the stage is `poured`.
- **fieldWorkDone** = stage `poured` AND cleanup `done` AND asphalt ≠ `req` AND pavers ≠ `req`.
- **keepWhenClosed** = NOT removed AND NOT fieldWorkDone AND (stage index > 0 OR asphalt `req` OR pavers `req` OR cut `req`
  OR lane.s ∈ {req, booked}).
- **Lists** (item chips): `unassessed` = stage ∈ {ready, setup} AND assess `no`; `booklane` = lane.s `req`;
  `streetcuts` = cut `req`; `cleanup` = stage `poured` AND cleanup `todo`; `asphalt` = stage `poured` AND asphalt `req`;
  `pavers` = stage `poured` AND pavers `req`.
- **File:** `{"version":2,"stages":{"<jobNumber>":{...non-default fields..., "at":"<ISO UTC>","by":"<device>"}}}`.
  v1 files read as v2. The app writes v2 only and refuses to write a file whose version is > 2 (same guard as R-1's).
- **jobs.json additions (sync):** `hints: {asphalt: bool, pavers: bool}` (from the Jobber title + line-item names and
  descriptions; the text itself is never published), `closed: true` on carried-forward jobs, `id` (Jobber encoded id, for
  refreshing closed jobs). Prices only in the encrypted `data/prices.json`.

## 3. Lists (Stage mode chips)
`Ready · Setup · Excavation · Base · Prep · Inspected · Poured` | `Unassessed · Book lane · Street cuts · Cuts & cleanup · Asphalt · Pavers`
- Stage chips always shown; item chips hidden when empty. Any mix can be selected; Setup + Cuts & cleanup = the
  setup/cleanup crew's day.
- Book lane = lane Required (not booked); Booked jobs show their dates in rows and the sheet (red if the end date passed
  and the job isn't poured).
- Client mode unchanged.

## 4. Route editor (replaces the separate result + Plan screens)
- Route (one click) builds immediately from the selected chips, from the shop (`S`, 1..n), open end, Return-to-shop toggle.
- The result list is the editor: skip switch per stop (skipped rows grey at the bottom; out-of-town jobs start skipped),
  drag handle to reorder (Apple Maps-style; long-press on phone), "+ Add stop" (address or job), "Re-optimize".
  Live update of numbering, legs, totals, map line, Google Maps parts (≤10 points, overlapping).
- Plan tab = the same editor started empty. Save / saved routes keep working (old `ej_routes` entries load).
- Drag library: vendored SortableJS (MIT, pinned, sha recorded) unless a small hand-rolled version passes iOS testing.

## 5. Pricing (Q4 only Riley's devices, Q5 job total)
- `sync_jobs.py` adds Jobber `total` + `uninvoicedTotal` per job → `data/prices.json` = AES-256-GCM ciphertext
  (key = new GitHub secret `PRICE_KEY`, 32 random bytes base64). Line items are fetched only to derive the
  asphalt/pavers hints; their text and prices are never published.
- App: Settings → Pricing → paste pricing key (per device). A `$` button appears in the control capsule only when the
  key is present; show/hide is remembered. Shows: list row, job sheet (total + "Uninvoiced $X"), chip totals
  (count · $), route total. Never on map pins.
- Confirm on a real job whether Jobber `total` is pre-tax; label accordingly.

## 6. Sync changes (`sync_jobs.py`)
1. Query adds `total uninvoicedTotal lineItems(first:50){nodes{name description}}` (check the Jobber cost/throttle).
2. Hints: `hints.asphalt` / `hints.pavers` booleans in `jobs.json` from line-item text (asphalt; paving stone(s), paver(s), interlock).
3. Carry-forward: read `https://raw.githubusercontent.com/Claude69420/eckstein-jobs-state/main/stages.json`; for each
   job that qualifies (§1 "Closed in Jobber") and is not in the active list, copy its record from the previous
   `data/jobs.json` with `closed: true` (and refresh status/total via `job(id)` if the id is stored).
4. Encrypted prices file; never print prices in the Action log.
5. Unit tests with fixtures (no network): carry-forward rules, hints, encryption round-trip with a test key.

## 6a. Testing the sync safely (IMPORTANT)
`.github/workflows/sync.yml` always ends with `git push origin HEAD:main` after rebasing onto `origin/main`. **Never run it
from the `r2` branch** (`gh workflow run sync.yml --ref r2` or "Run workflow" on r2): it would push the unfinished branch
code to `main` and deploy it. Test `sync_jobs.py` changes with unit tests plus a local run (APP_MASTER §7.4 fallback,
desktop keyring token) that writes to a scratch folder via `--out`, never committed. The first Actions run happens after
the R-2 merge, watched live.

## 7. Build phases
1. `js/stages.js` v2 + tests. 2. `sync_jobs.py` + tests. 3. UI: 7-stop slider, item switches, gates, lane dates,
item chips, field-work-done + Closed-in-Jobber tags, Remove from app. 4. Route editor. 5. Pricing UI.
6. Browser verification (375×812, 1440×900, light/dark), review lenses, fix loop, APP_MASTER, one squash merge, one real
Actions run, live check.

## 8. Riley's steps (Claude never sees the values)
1. Generate the pricing key in PowerShell (copies it to the clipboard):
   `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard`
2. Paste it as a new repo secret `PRICE_KEY` (GitHub → eckstein-jobs → Settings → Secrets and variables → Actions).
3. Paste it into the app on the iPhone and the PC: Settings → Pricing. Keep a copy in the password manager.

## 9. Beta channel: trial R-2 next to v1 (Riley 2026-09-26), then the promotion
Riley: "When complete please dont overwrite v1, would like to trial it in parallel if possible." Stage sync answer:
**"v1 → beta only"**. (The bullets below describe the trial as it ran; the promotion below replaced it.)
- **URL:** `https://claude69420.github.io/eckstein-jobs/beta/` (folder `beta/` on `main`). Root `/` stays R-1 v1,
  byte-for-byte (no root frontend file changes while the trial runs).
- **Build:** `beta/` is generated from the `r2` branch's frontend files by `tools/build_beta.py` (copies index.html,
  css/, js/, vendor/, beta icons, beta manifest, beta sw.js and injects `window.EJ_CONFIG`). `r2` stays the development
  branch (all tests live there); `main` receives only `beta/` + backward-compatible sync changes + sync tests + docs.
- **Config** (`window.EJ_CONFIG`, defaults = the future main app): `channel` ("beta"), `base` ("../" for data/ and
  routes/), `ns` (localStorage prefix "ejb_" instead of "ej_", so v1 and beta never share keys on the PC), `stateFile`
  ("stages-beta.json"), `overlayFile` ("stages.json" = v1's file, read-only).
- **Stages:** the beta writes ONLY `stages-beta.json` (v2) in `Claude69420/eckstein-jobs-state`. It also reads v1's
  `stages.json` (read-only) and, per job, shows v1's stage when v1's `at` is newer than the beta entry's `sat`
  (stage-set time, stored whenever the beta sets `stage`); items come only from the beta file. v1 never reads the beta
  file, so v1 cannot be affected. A beta move does NOT appear in v1 (repeat it in v1 if the crew needs it).
- **Sync:** backward compatible for v1. `data/jobs.json` keeps today's job set (new optional fields `hints`, `id` are
  ignored by v1). Carried-forward closed jobs go to `data/closed_jobs.json` (only the beta reads it). Carry-forward
  evaluates the beta-effective entries (same merge rule, both files); read failures keep everything.
  `data/prices.json` (encrypted) is read only by the beta.
- **Install:** separate Home Screen app "EJ Beta" with a tinted icon; own manifest (`id`/`scope`/`start_url` = `beta/`),
  own service worker (scope `beta/`, caches prefixed `ejb-`, cleanup only of `ejb-` caches). Riley pastes the same edit
  key (and the pricing key) inside the beta app. A small "Beta" label in the header.
The trial ran from 2026-09-26 (release `6613835`) until Riley approved the promotion the same day: "Looks good please
push the beta to the final release of version 2 so that the original link will work."

### Promotion (the procedure actually used, 2026-09-26; APP_MASTER §7.17, ADR-30)
The earlier plan here ("merge the stage files into `stages.json` v2 first, then ship; `beta/` redirects, then is
removed") was replaced by **deploy first, then convert**: converting first would have made every open R-1 page refuse its
saves for the whole ship, while an R-2 page that meets the v1 file simply holds its changes on the device.
1. **Pre-flight (Riley):** close and reopen every app/tab with the edit key (a tab still on R-1 `005a671`, which lacks the
   newer-format guard, could rewrite a converted file as v1); force-quit EJ Beta with 0 pending changes; the crew open the
   app online after the deploy.
2. **Deploy the code (one commit on `main`):** the `r2` root frontend with the default config (no `EJ_CONFIG`: channel
   main, `ns "ej_"`, `stateFile "stages.json"`, no overlay), every local css/js URL with `?v=r2.0`, `sw.js` cache `ej-v3`
   (cleans only `ej-` caches); root `manifest.json` + `icons/` unchanged, so the existing Home Screen app loads version 2.
   The main app copies the beta's per-device keys once on a same-origin browser (`Stages.migrateFromBeta`:
   `ejb_gh_token`, `ejb_price_key`, `ejb_show_prices`, `ejb_device` into missing `ej_` keys; `ejb_routes` merged into
   `ej_routes`; marker `ej_migrated_from_beta`; the beta's secret copies removed afterwards). Wording "Assessed before this
   update"; About "Eckstein Jobs · version R-2". `sync_jobs.py` switches to **single-file mode** (`BETA_STATE_FILE = None`:
   only `stages.json` is read; `meta.stages_beta_read` "not read (single-file mode)", `stage_entries` `{"stages.json": n}`).
   Until step 4, R-2 devices hold their moves ("… still in the v1 format … saving is paused (changes wait on this
   device)"); nothing is lost.
3. **Dry run:** `python tools/promote_stages.py --api` (fresh, read only). Per job: stage = the beta's merged view (v1 wins
   when its `at` is newer than the beta `sat`, as the beta showed it), items from `stages-beta.json`, `sat` dropped,
   serialized exactly like `js/stages.js`. On 2026-09-26: 31 v1 entries + 1 beta entry (#412 assess On site) → 32, 0 dropped; a re-check at
   2026-09-27 01:18 UTC (raw CDN) found 3 beta entries (#411, #412, #679) → 33, 0 dropped. The fresh run after the
   pre-flight decides the count.
4. **Convert and seal:** `python tools/promote_stages.py --write --expect SHA12 --seal-beta` (SHA12 = the first 12+ hex of
   the dry run's proposal sha256): `stages.json` becomes v2 (sha-guarded; refused if anything changed since the dry run),
   then `stages-beta.json` is sealed as **version 3** (content kept), so a still-running beta app can no longer save.
5. **Check:** `python tools/promote_stages.py --check --api` right after, about 10 minutes later and later that day (exit 0
   = v2; exit 4 = a stale R-1 page wrote it back as v1).
6. **Repair (only if step 5 fails):** close the stale page, then `python tools/promote_stages.py --repair` (dry run: the
   newest v2 `stages.json` in the state repo's history + the R-1 moves made since) and `--repair --write --expect SHA12`.
7. **Sync check:** dispatch the sync; `stages_read` "ok", `stages_beta_read` "not read (single-file mode)",
   `stage_entries` `{"stages.json": N}` (N = the `WROTE stages.json v2 (N entries)` count).
8. **Retire `/beta/` (part of the step 2 commit):** `beta/index.html` is a static notice ("EJ Beta is now the main Eckstein Jobs app", button to the
   main URL; its inline script unregisters the `/beta/` service worker and deletes `ejb-` caches), `beta/sw.js` a retire
   worker (deletes `ejb-` caches, unregisters itself, reloads open beta pages as the notice); manifest + icons kept;
   `beta/css`, `beta/js`, `beta/vendor` removed. `tools/build_beta.py` stays for future betas (refuses a retired `beta/`
   unless `--force`; `--out DIR`). A future beta needs a new state-file name (`stages-beta.json` is sealed).
9. **Riley's devices:** iPhone Home Screen apps don't share storage: paste the edit key and the pricing key in the main
   "Eckstein Jobs" app, then delete EJ Beta (its saved routes are not copied). The PC copies them automatically.

**Rollback** (APP_MASTER §7.19): push a code revert first (restores the R-1 root, the generated beta and the dual-file
sync), then `python tools/promote_stages.py --rollback --api` (dry run, fresh) and `--rollback --write --expect SHA12` (v2 `stages.json`
→ v1 `stages.json` with the R-1 stages, Setup → Ready, plus a v2 `stages-beta.json` with every entry and its items, `sat` =
`at`). If only the frontend is reverted, set `sync_jobs.BETA_STATE_FILE = "stages-beta.json"`. Caveats: an R-2 page that
reloads into R-1 drops its v2-format queue; a rollback made by other means than `--rollback` is not recognised by the
tool's history checks.

## 10. Assessed default for existing jobs (Riley 2026-09-26: "Existing jobs = assessed")
- `Stages.ASSESS_CUTOFF` = the highest non-pending Jobber jobNumber in `data/jobs.json` on the day the beta launches
  (set in `js/stages.js` at ship time; recorded in APP_MASTER).
- `effective(entry, hints, jobNumber)`: when `assess` is not stored and `jobNumber <= ASSESS_CUTOFF` (and < 9000),
  effective assess = `prior` ("assessed before the beta", type not recorded). Pending 9000+ and newer jobs default to
  `no` as before. A stored `virtual`/`onsite` always wins; `prior` is never stored, and neither is `no` (the default), so
  an old job cannot be set back to "Not yet" (the app dims it on every job <= the cutoff, `Stages.priorAssessed`; open
  design call for Riley: un-assessing an old job would need a stored non-default marker).
- UI: the Assessed row shows no selected segment plus a quiet "Assessed before beta" caption (the main app since the
  promotion: "Assessed before this update"); tapping a segment stores
  it. The Unassessed list = effective `no` only. Python: `assess` doesn't affect carry-forward; keep vectors valid
  (third argument optional).
