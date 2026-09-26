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
