# R-2 plan (2026-09-26): Setup stage, job items, route editing, pricing

Status: **answers received 2026-09-26** (recorded in APP_MASTER §11 "R-2"). Build starts after R-1 ships.
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

## 9. Beta channel: trial R-2 next to v1 (Riley 2026-09-26)
Riley: "When complete please dont overwrite v1, would like to trial it in parallel if possible." Stage sync answer:
**"v1 → beta only"**.
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
- **Promotion (when Riley approves):** merge files (stage = newest of v1 `at` / beta `sat`; items from beta) into
  `stages.json` v2; ship the `r2` frontend at the root with default config (`ns` "ej_", `stateFile` "stages.json", no
  overlay); `beta/` redirects to `/` then is removed. Logged as one change with its own rollback.

## 10. Assessed default for existing jobs (Riley 2026-09-26: "Existing jobs = assessed")
- `Stages.ASSESS_CUTOFF` = the highest non-pending Jobber jobNumber in `data/jobs.json` on the day the beta launches
  (set in `js/stages.js` at ship time; recorded in APP_MASTER).
- `effective(entry, hints, jobNumber)`: when `assess` is not stored and `jobNumber <= ASSESS_CUTOFF` (and < 9000),
  effective assess = `prior` ("assessed before the beta", type not recorded). Pending 9000+ and newer jobs default to
  `no` as before. A stored `virtual`/`onsite` always wins; `prior` is never stored, and neither is `no` (the default), so
  an old job cannot be set back to "Not yet" (the app dims it on every job <= the cutoff, `Stages.priorAssessed`; open
  design call for Riley: un-assessing an old job would need a stored non-default marker).
- UI: the Assessed row shows no selected segment plus a quiet "Assessed before beta" caption; tapping a segment stores
  it. The Unassessed list = effective `no` only. Python: `assess` doesn't affect carry-forward; keep vectors valid
  (third argument optional).
