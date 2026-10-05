# R-3 plan (2026-09-30): confirm before removal, start from a site, totals, chip fixes, rename/relocate, one Route tab

Status: **shipped (see APP_MASTER §12)**, 2026-09-30, as one squash commit of branch `r3` (built from `main` @ `bb19494`; code complete at `71c1667`). Riley's requests and answers are quoted verbatim in
APP_MASTER §11 "R-3". Ships straight to the main link after full testing (Riley: "Straight to the app").
Rule 14 applies: bump every `?v=` in `index.html` and the `sw.js` cache name (`ej-v4`).

## A. Confirm before a job leaves the app ("Every job Jobber closes"; "Popup on open"; "Recently removed": yes)
- **Sync:** a job that leaves Jobber's active list (not a pending manual 9000+ job) stays in `data/closed_jobs.json`
  (`closed: true`) until its stage entry has `removed: true`. The keep rule becomes: keep unless removed. Removed jobs go
  to `data/closed_archive.json` (60 days, `droppedAt`, `droppedWhy: "removed in app"`); an archived job whose entry is
  no longer `removed` is restored to `closed_jobs.json` at the next sync. All read-failure safety rules stay.
- **App:** `Stages.awaitingOk(eff, job)` = `job.closed && !eff.removed && !Stages.keepWhenClosed(eff)` (closed in Jobber,
  nothing outstanding). On app open (cold start or reload), when the store is writable and ≥1 job is awaiting: a glass
  popup "Closed in Jobber — confirm they're done" listing each job (address, client, #, stage, price if shown) with
  **Completed** (sets `removed: true`, Undo toast) and **Still needs work** (closes the popup, opens the job, scrolls
  to and highlights Job items so pavers/asphalt/cleanup can be set). **Later** closes it until the next app open.
  Read-only devices: no popup. The closed-job detail button reads "Completed — remove from app" (confirm first).
- **Settings → Data → Recently removed (60 days):** reads `data/closed_archive.json`; each row: address · # · removed
  date; **Restore** sets `removed` back (patch `{removed: null}`), row shows "Comes back at the next sync".

## B. Start a route away from the shop ("Switch + my location")
- The route editor's start row (S, Shop) gets an on/off switch. Off: the first included stop is the fixed start and is
  numbered **#1** (Rule 6: start at a site → that site is #1); Re-optimize keeps it first; drag another stop to the top
  to change the start. A **Start from my location** action (GPS via `navigator.geolocation`, high accuracy, 10 s
  timeout, clear error text) makes a start marker "Me" (location glyph) and the jobs are #1..n.
- "Return to shop" keeps meaning the shop. Google Maps parts start from the chosen start. Saved routes keep the start
  mode. One-click routes still start at the shop by default.

## C. Totals
- Next to the job count: "N jobs · $total" (prices shown only) = sum of priced jobs in the current selection
  (All, one chip or several, plus search). Fix the bug where a total covers only the first selected chip.

## D. Mobile chip bugs
- Selecting a chip must never jump the chip row back to the left (preserve `scrollLeft` / update in place).
- A horizontal swipe that starts ON a chip scrolls the row (like iOS); only a tap toggles; no toggle after a swipe.
  Check every pointer/touch handler on the path (press glow, accessory swipe, sheet drag, chip click) and `touch-action`.

## E. Rename / relocate a job
- **Root cause (Portage & Lipton):** Jobber street "Portage Ave (Lipton St to Lenore St)"; `clean_addr` strips the
  parenthetical → "Portage Ave" → a generic pin. **Sync fix:** a street WITHOUT a house number followed by "(A to B)" or
  "[A to B]" becomes `street` "Main & A" (display) with `range` "A to B"; the pin is the midpoint of the geocoded
  "Main & A" and "Main & B" when both are found within 2 km, else "Main & A". Street overrides still win. Tests.
- **App:** a pencil on the job sheet opens "Edit name & location": Name (≤ 80 chars) and an address search (the Esri
  geocoder already used by the planner, Manitoba extent) that previews the match on the map; Save stores
  `name` and `loc {lat, lon}` for the job (shared with everyone); **Reset to Jobber** clears both.
- **Storage (as built, amended after review):** `name` / `loc` are NOT stored inside the job's stage entry. They live in
  a TOP-LEVEL `"overrides"` object of `stages.json`: `{"<jobNumber>": {name?, loc?: {lat, lon}, at, by}}`, next to
  `"stages"`. Reason: an R-2 page still open after the update passes unknown top-level fields through untouched, but its
  entry cleaner would strip unknown entry fields (and drop an entry holding only name / loc) on its next save. The file
  stays `version: 2` (R-2 pages keep saving; no format hold). `js/stages.js` merges the overrides into the entries on
  read (they win over inline ones) and writes them back out on every save; the sync reads only `"stages"`.
  `tests/fixtures/stages_r2.js` (a copy of the R-2 `js/stages.js`) is the stale-client fixture in `tests/stages.test.js`.
  The override applies everywhere (list, pins, detail, search, routes, Google Maps links).
- Contract additions (js/stages.js): `name` (one line, ≤ 80, sanitized like labels), `loc` (finite lat/lon inside the
  Manitoba box 48.9–50.9 N, −99.8 to −95.3 E); patch `null` clears (store API `set(jn, {name, loc})` as for
  any field; the serializer moves them to `"overrides"`). The sync ignores both.

## F. One Route tab + synced saved routes ("Shared + 'mine first'"; "Into the Route list")
- Tabs become **Jobs · Route** (Settings stays in the capsule). "Plan" is renamed **Route**; the old Routes tab goes.
- Saved routes sync through a new state-repo file `routes.json` (`{"version":1,"routes":{"<id>":{...}}}`) written with
  the same edit key (contents API, sha-guarded, per-route merge on 409/422, offline queue like stages). Route shape:
  `{id, name, owner, by, at, rt, start: {mode: "shop"|"stop"|"gps", lat?, lon?}, seq: [...stops], skipped: [...]}`,
  sanitized (bounded strings, finite coordinates, ≤ 100 stops, ≤ 300 routes). Without a key: the shared list is
  read-only (raw CDN) and saves stay on the device as today.
- **Your name** (Settings, per device, `ej_user_name`): routes you save get `owner`; the list shows yours first, then
  "Team" (owner shown). Asked once on the first save if unset.
- One-time "Sync my N saved routes" for routes saved on the device before R-3 (`ej_routes`).
- **Claude-built routes:** `tools/add_route.py` adds a route (owner "Claude") to `routes.json` from a stops JSON (dry run
  default; `--write` via `gh api`, sha-guarded). This replaces publishing HTML maps (Rule 4 changes).
- **Old maps:** Settings → "Old route maps (N)" opens the existing `routes/` list (kept, read-only).

## Build and ship
Workflow: parallel builders (sync | data: stages.js + new routes store + tools/add_route.py | UI part 1: A, C, D, E),
then UI part 2 (B, F), then browser acceptance + review lenses + fix loop. Main session: docs, squash to `main`,
Rule 14 bump, live check, first sync check.

## G. R-3.1 soft update (2026-10-04): residential jobs are stageless; commercial clients from a list
Riley: "Residential jobs should not be in the stages but rather exist as stageless jobs on the stage view that can be
toggled off just like the other stages. They dont progress through the pipeline and are often done by one crew in one
day so they dont need to be tracked the same." Commercial = exactly Riley's list ("Crown, harris, mytec, NLU, aecon,
tricore, ACV, swift underground. These are all we have for commercial for now"); everyone else is residential.
- **`data/commercial_clients.json`** (hand-maintained, public; the ONE place to add a client):
  `{"version":1,"clients":[{"key","label","short","match":["lowercase substring", ...],"color"}]}`. A Jobber client name
  (companyName or name) matches when it contains a `match` string (case-insensitive, word-bounded; first match wins).
  No match = residential (`clientKey` "Residential", `residential: true` in jobs.json). Built-in fallback = the same list.
- **Chips (Riley):** "All commercial clients get their own chips unless there are 9 or more. In which case, the 8 with
  the most jobs get their own chips and the rest are lumped under all other" (+ a Residential chip). Only clients with
  jobs get chips.
- **Stage view:** residential jobs never sit in a stage or a list; a **Residential** chip sits with the stage chips and
  toggles like them (routable, totals, search "residential"). Residential pins: residential colour + house glyph.
- **Residential job sheet:** no stage slider, no job items (address, client, price, Directions / Add to route / Copy,
  rename pencil stay).
- **Closed residential jobs:** removed automatically (archive, droppedWhy "residential, closed in Jobber"); Settings →
  Recently removed → Restore stores `keep: true` (new optional stage-entry field) so the job stays until Completed.
- Rule 14: `?v=r3.1`, cache `ej-v5`. Ships straight to `main` (soft update, no new version name).
