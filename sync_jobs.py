"""
Eckstein Jobs sync — headless Jobber -> data/jobs.json (+ geocode cache, + encrypted prices).

Modes (auto-detected):
  CLOUD  (GitHub Actions): env JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_REFRESH_TOKEN.
         Uses the refresh_token grant. If Jobber rotates the refresh token, the new one is
         written to the path in env ROTATED_TOKEN_FILE (runner temp, never committed) so the
         workflow can update the repo secret.
  LOCAL  (Riley's PC): no env creds -> imports the desktop MCP's auth (Windows Credential Manager).

Geocoding: cache-first (geocode_cache.json); misses go to TomTom (env TOMTOM_KEY).
Results outside a Manitoba bounding box are treated as FAILED (guards the old wrong-province bug).

R-2 (docs/r2-plan.md §2a, §5, §6):
  * Jobber query adds total, uninvoicedTotal and line items (name, description). Line-item text is only
    used to derive jobs.json `hints: {asphalt, pavers}`; it is never written anywhere.
  * THROTTLED / 429 responses are retried with backoff (Jobber's leaky bucket); if the job list still
    cannot be read completely the run FAILS, so a partial list never overwrites jobs.json.
  * Carry-forward: a job that left Jobber's active list is kept (`closed: true`); R-2 kept it only when its stage
    entry said work had started and field work was not done (keepWhenClosed); since R-3 it is kept until removed in
    the app (see R-3 below). Kept jobs are written to
    data/closed_jobs.json, NOT to jobs.json: jobs.json keeps exactly the R-1 membership (active + pending), so
    an R-1 client that never reads closed_jobs.json is unaffected; the R-2 app reads both (r2-plan §9).
    Single-file mode (DEFAULT since the version 2 promotion, BETA_STATE_FILE = None; r2-plan §9 "Promotion"):
    only stages.json is read (one v2 file: stage + items per job) and keepWhenClosed evaluates its entries
    directly. stages-beta.json is never requested. If stages.json cannot be read (a 404 included), or looks
    reset (no entries at all while closed jobs were kept last run, or while it had entries last run:
    meta.stage_entries), every such job is kept (never dropped because of a read failure).
    Dual-file mode (the beta trial; BETA_STATE_FILE = "stages-beta.json", kept switchable for rollback and tests;
    contract rule 2): the entry per job is the MERGE of two files in the state repo: BETA_STATE_FILE (the beta's
    own v2 file; items only come from here) and stages.json (v1's file, read-only overlay). The v1 stage wins
    when v1 has a valid stage for the job AND (the beta entry has no `sat` stage-set time OR v1's `at` is newer
    than `sat`). A 404 on the beta file = no beta entries yet. If either file cannot be read (or looks reset:
    no entries at all while closed jobs were kept last run / the beta file had entries last run), every such
    job is kept.
    Safety net beyond r2-plan §2a (R-2): an entry value this sync does not understand kept the job when it could
    have changed the decision; since R-3 only removed: true drops a job, so such a value only names the log reason.
    Previous closed jobs come from the previous closed_jobs.json; `closed: true` records still in a previous
    jobs.json (the first R-2 build wrote them there) are migrated. An unreadable previous closed_jobs.json
    never stops the job sync: closed_jobs.json, closed_archive.json and prices.json are then left untouched. The
    same goes for an unreadable previous jobs.json (jobs.json is rebuilt from Jobber, as R-1's sync always did;
    only jobs that left Jobber since the last good run miss carry-forward).
    Closed-job refreshes (status + totals) share one REFRESH_BUDGET_S time budget and run before any file is
    written, so a slow or throttled Jobber delays jobs.json by at most about that long.
  * meta.json stage fields: `stages_read` = how stages.json was read ("ok", "fetch failed (...)", a "reset or
    stale copy?" note, "not read (<file> unreadable)", ...). `stages_beta_read` = the same for the beta file in
    dual-file mode; in single-file mode always "not read (single-file mode)". `stage_entries` = the last good
    entry count per stage file this mode reads: {"stages.json": n} in single-file mode (a "stages-beta.json"
    count left by the beta trial is dropped), {"stages.json": n, "stages-beta.json": m} in dual-file mode. An
    unreadable or reset-looking file keeps its previous count, so the reset guard stays armed on later runs.
  * Dropped jobs go to closed_archive.json for ARCHIVE_DAYS days (public data only, same fields as
    jobs.json + droppedAt/droppedWhy) and are re-evaluated every run, so fixing a mistaken stages.json
    entry (an accidental "Completed" / "Remove from app", a reset store) brings the job back.
    Every dropped job is logged (a plain line since R-3: only a confirmed removal drops a job).
  * Line items missing for a job (query refused, lineItems null, or its page had errors): the previous
    run's hints are OR-ed in, so a degraded read never clears a hint.
  * Prices: env PRICE_KEY (base64 of 32 bytes) -> prices.json = AES-256-GCM ciphertext of
    {"<jobNumber>": {"t": total, "u": uninvoicedTotal}}. Prices, totals and the key are never printed.
    PRICE_KEY missing/invalid, or `cryptography` missing: prices.json is left exactly as it is (it
    carries its own `at` time, so the app can show its age) and one "prices: skipped (...)" line is logged,
    as a ::warning:: annotation whenever PRICE_KEY is set (so stale prices show in the Actions UI).
    The sync never fails because of prices.

R-3 (docs/r3-plan.md A, E):
  * Keep rule (replaces the R-2 keepWhenClosed drop above): a job that left Jobber's active list (not a pending
    manual job) stays in closed_jobs.json (`closed: true`) until its stage entry has `removed: true` (the app's
    "Completed" in the "Closed in Jobber — confirm they're done" popup, or "Completed — remove from app"). A
    removed job goes to closed_archive.json (droppedWhy "removed in app", ARCHIVE_DAYS days); an archived job whose
    entry is no longer removed (Settings -> Recently removed -> Restore) is restored at the next sync. keepWhenClosed
    only names the log reason now ("work started, field work not done" vs "waiting for Completed in the app (...)").
    Every read-failure / reset guard above still applies (unreadable or reset-looking stage file: keep every
    candidate, archived jobs stay archived). Entry fields this sync does not use (`name`, `loc`, `at`, `by`, ...)
    are ignored; an unknown `removed` value reads as not removed, so it can never drop a job.
  * Range streets: a Jobber street WITHOUT a house number followed by "(A to B)" or "[A to B]" (e.g. "Portage Ave
    (Lipton St to Lenore St)") becomes `street` "Main & A" plus `range` "A to B" (the key is only present on such
    jobs). The pin is the midpoint of the geocoded "Main & A" and "Main & B" when both are found within RANGE_MAX_KM,
    else "Main & A" (else "Main & B"). Geocode-cache keys keep the usual "<street>, <city>, MB, Canada" format;
    street_overrides.json still wins (no range then). Streets with a house number ("905 Portage Ave (Arlington St
    to Burnell St)") are cleaned as before.

CLI:  python sync_jobs.py [--out DIR] [--data DIR]
  --out   where jobs.json, closed_jobs.json, meta.json, geocode_cache.json, closed_archive.json and prices.json
          are written (default data/). The previous jobs.json / closed_jobs.json / geocode_cache.json /
          closed_archive.json / prices.json / meta.json are read from --out when present there, otherwise
          from --data (read-only).
  --data  hand-maintained inputs street_overrides.json + pending_manual.json (default data/).
"""
from __future__ import annotations
import argparse, base64, http.client, json, math, os, re, secrets, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
JOBS_NAME = "jobs.json"
CACHE_NAME = "geocode_cache.json"
META_NAME = "meta.json"
PRICES_NAME = "prices.json"
OVERRIDES_NAME = "street_overrides.json"
PENDING_NAME = "pending_manual.json"
ARCHIVE_NAME = "closed_archive.json"
CLOSED_NAME = "closed_jobs.json"   # carried-forward closed jobs (read by the R-2 app, not by R-1)
ARCHIVE_DAYS = 60          # dropped closed-job records are kept this long in ARCHIVE_NAME (undo window)

GRAPHQL_URL = "https://api.getjobber.com/api/graphql"
GRAPHQL_VERSION = "2026-03-10"
TOKEN_URL = "https://api.getjobber.com/api/oauth/token"
STATE_RAW_BASE = "https://raw.githubusercontent.com/Claude69420/eckstein-jobs-state/main/"
STAGES_FILE = "stages.json"            # THE stage file (v2: stage + items) since the version 2 promotion
STAGES_BETA_FILE = "stages-beta.json"  # the retired beta trial's own v2 file (items + sat)
STAGES_RAW_URL = STATE_RAW_BASE + STAGES_FILE
# The ONE switch for the beta file read (r2-plan §9 "Promotion"). None = single-file mode: carry-forward reads only
# stages.json (no request to the beta file, no beta reset guard). STAGES_BETA_FILE = dual-file mode (the beta trial:
# that file is the state, stages.json the read-only v1 overlay); tests set it to exercise the dual path.
BETA_STATE_FILE: str | None = None

# Manitoba sanity box: anything outside is a mis-snap (Alberta/Ontario/NB seen before).
MB_BOX = (48.9, 50.9, -99.8, -95.3)  # lat_min, lat_max, lon_min, lon_max

CLIENT_KEYS = {
    "Crown Pipeline Ltd.": "Crown",
    "Harris Holdings Ltd.": "Harris",
    "ACV Sewer & Water": "ACV",
    "MyTec Industry Ltd": "MyTec",
    "No Limits Underground Ltd.": "NoLimits",
}

# Jobber query cost: connection cost ~ first x child cost. 25 jobs x 50 line items stays far below the
# 10,000-point bucket (the actual requested cost is logged per page); a page that could never fit is
# halved automatically.
JOBS_PAGE = 25
LINE_ITEMS_PAGE = 50
MAX_PAGES = 200            # 5,000 jobs; beyond that the run fails instead of silently truncating
NET_ATTEMPTS = 5           # network errors / 5xx per request (sleep 1, 2, 4, 8 s)
THROTTLE_ATTEMPTS = 10     # THROTTLED / 429 per request
THROTTLE_MAX_WAIT = 60.0   # seconds
REFRESH_BUDGET_S = 90.0    # all closed-job refreshes together (retries and throttle waits included): a slow or
                           # throttled Jobber must never hold back the jobs.json that v1 reads

class JobberError(RuntimeError):
    pass

class QueryTooCostly(JobberError):
    """The requested cost is above Jobber's bucket maximum: retrying can never succeed; shrink the page."""

class JobberQueryError(JobberError):
    """GraphQL errors and no data (e.g. a field the app may not read). Not a throttle."""

def _sleep(seconds: float) -> None:   # indirection so tests can skip real waiting
    time.sleep(seconds)

def _monotonic() -> float:            # indirection so tests can drive the refresh time budget
    return time.monotonic()

# ----------------------------------------------------------------------------- http
def _http_json(url: str, data: dict | None = None, headers: dict | None = None, timeout=20) -> dict:
    body = None
    h = {"Content-Type": "application/json"}
    if headers: h.update(headers)
    if data is not None:
        body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=h, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def _http_text(url: str, timeout=20) -> str:
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")

def _form_post(url: str, fields: dict, timeout=20) -> dict:
    body = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

# ----------------------------------------------------------------------------- auth
def get_access_token() -> str:
    # .strip() guards against whitespace/newlines that sneak in when secrets are pasted
    cid, csec, rtok = ((os.environ.get("JOBBER_CLIENT_ID") or "").strip(),
                       (os.environ.get("JOBBER_CLIENT_SECRET") or "").strip(),
                       (os.environ.get("JOBBER_REFRESH_TOKEN") or "").strip())
    if cid and csec and rtok:
        # lengths only (never values) — catches a blank/swapped paste. client_id is a 36-char UUID.
        print(f"auth: cloud mode (refresh_token grant) [client_id len {len(cid)}, secret len {len(csec)}, refresh len {len(rtok)}]")
        try:
            tok = _form_post(TOKEN_URL, {"grant_type": "refresh_token", "refresh_token": rtok,
                                         "client_id": cid, "client_secret": csec})
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            print(f"auth: Jobber token endpoint HTTP {e.code} -> {body}")
            print("auth: invalid_client => JOBBER_CLIENT_ID/JOBBER_CLIENT_SECRET wrong; invalid_grant => JOBBER_REFRESH_TOKEN wrong/expired")
            raise
        new_r = tok.get("refresh_token")
        if new_r and new_r != rtok:
            out = os.environ.get("ROTATED_TOKEN_FILE")
            if out:
                Path(out).write_text(new_r, encoding="utf-8")
                print("auth: Jobber ROTATED the refresh token -> written to ROTATED_TOKEN_FILE for secret update")
            else:
                print("auth: WARNING Jobber rotated the refresh token but ROTATED_TOKEN_FILE not set; "
                      "next run may fail until JOBBER_REFRESH_TOKEN secret is updated")
        return tok["access_token"]
    # local fallback: desktop MCP auth (keyring)
    print("auth: local mode (desktop keyring)")
    sys.path.insert(0, r"C:\Users\Riley\OneDrive\Documents\Agents")
    from agents.services.eckstein_jobber.auth import get_access_token as _local  # type: ignore
    return _local()

# ----------------------------------------------------------------------------- jobber
def list_query(prices: bool = True, items: bool = True) -> str:
    """ListJobs query. The reduced variants are fallbacks for when Jobber refuses the new R-2 fields
    (e.g. an app scope without financial access), so the job list itself keeps syncing."""
    li_var = ", $li: Int" if items else ""
    extra = (" total uninvoicedTotal" if prices else "")
    li = "\n            lineItems(first: $li) { nodes { name description } pageInfo { hasNextPage } }" if items else ""
    return f"""
query ListJobs($filter: JobFilterAttributes, $first: Int, $after: String{li_var}) {{
  jobs(filter: $filter, first: $first, after: $after) {{
    nodes {{ id jobNumber title jobStatus{extra}
            client {{ id name companyName }}
            property {{ address {{ street1 city }} }}{li}
            createdAt updatedAt }}
    pageInfo {{ hasNextPage endCursor }}
  }}
}}"""

LIST_Q = list_query()
LIST_VARIANTS = [(True, True), (False, True), (False, False)]   # (prices, line items), tried in this order

REFRESH_Q = """
query RefreshJob($id: EncodedId!) {
  job(id: $id) { id jobNumber jobStatus total uninvoicedTotal }
}"""

def _num(v) -> float | None:
    """A finite number (not bool) -> float rounded to cents; anything else -> None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)): return None
    f = float(v)
    return round(f, 2) if math.isfinite(f) else None

def _cost_info(res: dict) -> tuple:
    cost = ((res or {}).get("extensions") or {}).get("cost") or {}
    ts = cost.get("throttleStatus") or {}
    return (_num(cost.get("requestedQueryCost")), _num(ts.get("maximumAvailable")),
            _num(ts.get("currentlyAvailable")), _num(ts.get("restoreRate")))

def _is_throttled(res: dict) -> bool:
    for e in (res.get("errors") or []):
        if not isinstance(e, dict): continue
        code = str(((e.get("extensions") or {}).get("code")) or "")
        if code.upper() == "THROTTLED" or "throttl" in str(e.get("message") or "").lower():
            return True
    return False

def _err_summary(res: dict) -> str:
    msgs = [str(e.get("message") if isinstance(e, dict) else e) for e in (res.get("errors") or [])]
    return "; ".join(msgs)[:300]

def _retry_after(e: urllib.error.HTTPError) -> float | None:
    try: return float(e.headers.get("Retry-After"))
    except Exception: return None

def gql(token: str, query: str, variables: dict, label: str = "query", deadline: float | None = None) -> dict:
    """POST one GraphQL request. Retries network errors / 5xx (NET_ATTEMPTS) and THROTTLED / 429
    (THROTTLE_ATTEMPTS, waiting for the bucket to refill). Raises when retries run out, so callers
    never see a partial answer. Returns the full response dict (data, errors, extensions).
    deadline (a _monotonic() time, optional): no request starts and no wait runs past it (JobberError), and
    each request's timeout is cut to the time that is left."""
    headers = {"Authorization": f"Bearer {token}", "X-JOBBER-GRAPHQL-VERSION": GRAPHQL_VERSION}
    net_fail = throttles = 0
    def over_budget(wait: float = 0.0) -> bool:
        return deadline is not None and _monotonic() + wait >= deadline
    def sleep(wait: float) -> None:
        if over_budget(wait): raise JobberError(f"jobber: {label} time budget used up")
        _sleep(wait)
    while True:
        if over_budget(1.0): raise JobberError(f"jobber: {label} time budget used up")
        timeout = 45 if deadline is None else max(1.0, min(45.0, deadline - _monotonic()))
        try:
            res = _http_json(GRAPHQL_URL, {"query": query, "variables": variables}, headers, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                throttles += 1
                if throttles >= THROTTLE_ATTEMPTS:
                    raise JobberError(f"jobber: {label} still rate-limited (HTTP 429) after {throttles} tries")
                wait = min(THROTTLE_MAX_WAIT, _retry_after(e) or 2 ** min(throttles, 5))
                print(f"jobber: {label} HTTP 429; waiting {wait:.0f}s ({throttles}/{THROTTLE_ATTEMPTS})")
                sleep(wait); continue
            if e.code >= 500:
                net_fail += 1
                if net_fail >= NET_ATTEMPTS: raise
                print(f"jobber: {label} HTTP {e.code}; retry {net_fail}/{NET_ATTEMPTS - 1}")
                sleep(2 ** (net_fail - 1)); continue
            print(f"jobber: {label} HTTP {e.code} (not retried)")
            raise
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError) as e:
            # HTTPException covers a cut-off body (IncompleteRead) and other malformed HTTP answers
            net_fail += 1
            if net_fail >= NET_ATTEMPTS: raise
            print(f"jobber: {label} {type(e).__name__}; retry {net_fail}/{NET_ATTEMPTS - 1}")
            sleep(2 ** (net_fail - 1)); continue
        if not isinstance(res, dict):
            raise JobberError(f"jobber: {label} unexpected response type {type(res).__name__}")
        if _is_throttled(res):
            req, mx, avail, rate = _cost_info(res)
            if req is not None and mx is not None and req > mx:
                raise QueryTooCostly(f"jobber: {label} costs {req:.0f} > bucket max {mx:.0f}")
            throttles += 1
            if throttles >= THROTTLE_ATTEMPTS:
                raise JobberError(f"jobber: {label} still THROTTLED after {throttles} tries")
            if req is not None and avail is not None and rate:
                wait = max(0.0, req - avail) / rate + 1.0
            else:
                wait = float(2 ** min(throttles, 5))
            wait = min(THROTTLE_MAX_WAIT, wait)
            print(f"jobber: {label} THROTTLED (cost {req}, available {avail}); waiting {wait:.1f}s "
                  f"({throttles}/{THROTTLE_ATTEMPTS})")
            sleep(wait); continue
        return res

def _pace(res: dict) -> None:
    """After a good page: if the bucket is lower than this page's cost, let it refill first."""
    req, _mx, avail, rate = _cost_info(res)
    if req is not None and avail is not None and rate and avail < req:
        _sleep(min(THROTTLE_MAX_WAIT, (req - avail) / rate + 0.5))

def fetch_active_jobs(token: str, page_size: int = JOBS_PAGE, line_items: int = LINE_ITEMS_PAGE,
                      prices: bool = True, items_: bool = True, stats: dict | None = None) -> list[dict]:
    """Every active job, or an exception. Never returns a partial list.
    stats (optional dict) gets "partial_errors": pages that came back with data AND errors, and
    "partial_jobs": the job numbers on those pages (their line items may be incomplete)."""
    query = list_query(prices, items_)
    stats = stats if stats is not None else {}
    stats["partial_errors"] = 0
    stats["partial_jobs"] = set()
    items, seen, after, pages, first = [], set(), None, 0, max(1, int(page_size))
    while True:
        variables = {"filter": {"status": "active"}, "first": first, "after": after}
        if items_: variables["li"] = line_items
        try:
            res = gql(token, query, variables, label=f"jobs page {pages + 1}")
        except QueryTooCostly as e:
            if first <= 1: raise
            first = max(1, first // 2)
            print(f"{e}; retrying with pages of {first}")
            continue
        data = res.get("data") if isinstance(res.get("data"), dict) else None
        page = data.get("jobs") if data else None
        if res.get("errors"):
            if not isinstance(page, dict):
                raise JobberQueryError(f"Jobber GraphQL error: {_err_summary(res)}")
            stats["partial_errors"] += 1
            print(f"jobber: WARNING page {pages + 1} returned data with errors: {_err_summary(res)}")
        if not isinstance(page, dict) or not isinstance(page.get("nodes"), list) or not isinstance(page.get("pageInfo"), dict):
            raise JobberError(f"jobber: unexpected jobs page shape on page {pages + 1}")
        req, mx, avail, _rate = _cost_info(res)
        if pages == 0 and req is not None:
            print(f"jobber: query cost {req:.0f} per page of {first} (bucket {avail} / {mx})")
        for n in page["nodes"]:
            # A job nulled by a GraphQL error (or without a job number) is never skipped: that job would
            # look closed. The run fails instead and nothing is written.
            if not isinstance(n, dict) or _job_number(n.get("jobNumber")) is None:
                raise JobberError(f"jobber: page {pages + 1} has a job without a job number "
                                  f"({'null node' if not isinstance(n, dict) else 'no jobNumber'}): "
                                  f"{_err_summary(res) or 'no error message'}")
            if res.get("errors"): stats["partial_jobs"].add(_job_number(n.get("jobNumber")))
            key = n.get("id") or n.get("jobNumber")
            if key in seen: continue
            seen.add(key); items.append(n)
        pages += 1
        pi = page["pageInfo"]
        if not pi.get("hasNextPage"): break
        after = pi.get("endCursor")
        if not after: raise JobberError("jobber: hasNextPage without endCursor")
        if pages >= MAX_PAGES:
            raise JobberError(f"jobber: more than {MAX_PAGES} pages; refusing to publish a truncated list")
        _pace(res)
    return items

def refresh_job(token: str, job_id: str, deadline: float | None = None) -> dict | None:
    """Current status/total/uninvoicedTotal of one job (closed jobs). None if Jobber has no such job.
    deadline: see gql (the carry-forward loop shares one REFRESH_BUDGET_S between every closed job)."""
    res = gql(token, REFRESH_Q, {"id": job_id}, label="refresh", deadline=deadline)
    if res.get("errors"):   # also a partial answer: a nulled total must not replace the previous price
        raise JobberError(f"refresh error: {_err_summary(res)}")
    job = (res.get("data") or {}).get("job")
    return job if isinstance(job, dict) else None

# ----------------------------------------------------------------------------- hints
# asphalt: asphalt / blacktop. pavers: paving stone(s), (unit) paver(s), interlock(ing).
# "asphalt paving" is asphalt only ("paving" alone is not pavers; an "asphalt paver" is a machine).
ASPHALT_RE = re.compile(r"\basphalt|\bblack[\s-]?top", re.I)
PAVERS_RE = re.compile(r"\bpaving[\s-]*stones?\b|(?<!asphalt )\b(?:unit\s+)?pavers?\b|\binterlock(?:ing)?\b", re.I)

def compute_hints(title: str | None, line_items: list | None = None) -> dict:
    parts = [title or ""]
    for li in line_items or []:
        if isinstance(li, dict):
            parts.append(str(li.get("name") or "")); parts.append(str(li.get("description") or ""))
    text = "\n".join(parts).replace("&amp;", "&")
    return {"asphalt": bool(ASPHALT_RE.search(text)), "pavers": bool(PAVERS_RE.search(text))}

# ----------------------------------------------------------------------------- stage contract (r2-plan §2a)
# Python twin of js/stages.js; both are checked against tests/fixtures/contract_vectors.json.
STAGE_KEYS = ["ready", "setup", "excavation", "base", "prep", "inspected", "poured"]
ASSESS_VALUES = ("no", "virtual", "onsite")
LANE_VALUES = ("na", "req", "booked")
TRI_VALUES = ("na", "req", "done")
CLEANUP_VALUES = ("todo", "done")
DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")   # used with fullmatch (ASCII digits, no trailing newline)
JOB_KEY_RE = re.compile(r"^[0-9A-Za-z-]{1,32}$")
LIST_KEYS = ["unassessed", "booklane", "streetcuts", "cleanup", "asphalt", "pavers"]

# JavaScript String.prototype.trim()'s whitespace set (the app and tools/promote_stages.py js_trim use it). Python's
# str.strip() also strips \x1c-\x1f and \x85, which the app does not: "prep\x1c" must be unknown here too.
_JS_WS = "\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_JS_TRIM_RE = re.compile(f"^[{_JS_WS}]+|[{_JS_WS}]+$")

def js_trim(s: str) -> str:
    return _JS_TRIM_RE.sub("", s)

def stage_key(v) -> str | None:
    if not isinstance(v, str): return None
    k = v if v in STAGE_KEYS else js_trim(v).lower()
    return k if k in STAGE_KEYS else None

def stage_index(v) -> int:
    k = stage_key(v)
    return STAGE_KEYS.index(k) if k else 0

def _in(v, allowed) -> bool:
    return isinstance(v, str) and v in allowed

def clean_date(v) -> str | None:
    """"YYYY-MM-DD" that is a real calendar date with year >= 1000, else None (JS cleanDate)."""
    if not isinstance(v, str) or not DATE_RE.fullmatch(v): return None
    try: d = date.fromisoformat(v)
    except ValueError: return None
    return v if d.year >= 1000 else None

def effective(entry, hints=None) -> dict:
    """Every field with defaults and the Jobber hints applied. A stored value (incl. "na") beats the hint."""
    e = entry if isinstance(entry, dict) else ({"stage": entry} if isinstance(entry, str) else {})
    h = hints if isinstance(hints, dict) else {}
    lane_raw, lane = e.get("lane"), {"s": "na"}
    if isinstance(lane_raw, dict) and _in(lane_raw.get("s"), LANE_VALUES):
        lane = {"s": lane_raw["s"]}
        if lane["s"] == "booked":
            for k in ("from", "to"):
                v = clean_date(lane_raw.get(k))
                if v: lane[k] = v
    return {
        "stage": stage_key(e.get("stage")) or "ready",
        "assess": e["assess"] if _in(e.get("assess"), ASSESS_VALUES) else "no",
        "lane": lane,
        "cut": e["cut"] if _in(e.get("cut"), TRI_VALUES) else "na",
        "asphalt": e["asphalt"] if _in(e.get("asphalt"), TRI_VALUES) else ("req" if h.get("asphalt") is True else "na"),
        "pavers": e["pavers"] if _in(e.get("pavers"), TRI_VALUES) else ("req" if h.get("pavers") is True else "na"),
        "cleanup": e["cleanup"] if _in(e.get("cleanup"), CLEANUP_VALUES) else "todo",
        "removed": e.get("removed") is True,
    }

def field_work_done(eff: dict) -> bool:
    return (eff["stage"] == "poured" and eff["cleanup"] == "done"
            and eff["asphalt"] != "req" and eff["pavers"] != "req")

def keep_when_closed(eff: dict) -> bool:
    return (not eff["removed"] and not field_work_done(eff)
            and (stage_index(eff["stage"]) > 0 or eff["asphalt"] == "req" or eff["pavers"] == "req"
                 or eff["cut"] == "req" or eff["lane"]["s"] in ("req", "booked")))

def item_lists(eff: dict) -> list[str]:
    st, out = eff["stage"], []
    if st in ("ready", "setup") and eff["assess"] == "no": out.append("unassessed")
    if eff["lane"]["s"] == "req": out.append("booklane")
    if eff["cut"] == "req": out.append("streetcuts")
    if st == "poured" and eff["cleanup"] == "todo": out.append("cleanup")
    if st == "poured" and eff["asphalt"] == "req": out.append("asphalt")
    if st == "poured" and eff["pavers"] == "req": out.append("pavers")
    return out

def unclear_fields(entry) -> set:
    """Fields of a stored entry that hold something this sync does not understand (a newer app, a hand-edit
    typo); "*" = the whole entry. effective() reads such values as defaults (like the JS)."""
    if entry is None: return set()
    if isinstance(entry, str): return set() if stage_key(entry) is not None else {"stage"}
    if not isinstance(entry, dict): return {"*"}
    checks = {"stage": lambda v: stage_key(v) is not None,
              "assess": lambda v: _in(v, ASSESS_VALUES),
              "lane": lambda v: isinstance(v, dict) and _in(v.get("s"), LANE_VALUES),
              "cut": lambda v: _in(v, TRI_VALUES), "asphalt": lambda v: _in(v, TRI_VALUES),
              "pavers": lambda v: _in(v, TRI_VALUES), "cleanup": lambda v: _in(v, CLEANUP_VALUES),
              "removed": lambda v: isinstance(v, bool)}
    return {k for k, ok in checks.items() if k in entry and entry[k] is not None and not ok(entry[k])}

def entry_unclear(entry) -> bool:
    return bool(unclear_fields(entry))

def clean_job_key(k) -> str:
    if isinstance(k, bool): return ""
    if isinstance(k, (int, float)):
        if isinstance(k, float) and not math.isfinite(k): return ""
        k = str(k)
    if not isinstance(k, str): return ""
    k = js_trim(k)                      # js/stages.js cleanJobKey: jn.trim()
    return k if JOB_KEY_RE.match(k) else ""

def parse_stages_text(text: str | None) -> tuple[dict | None, str]:
    """stages.json text -> ({jobKey: raw entry}, "ok") or (None, reason) when it cannot be evaluated."""
    t = (text or "").lstrip("\ufeff").strip()
    if not t: return None, "empty file"
    try: obj = json.loads(t)
    except (ValueError, RecursionError): return None, "not valid JSON"   # RecursionError: absurdly deep nesting
    if not isinstance(obj, dict) or not isinstance(obj.get("stages"), dict):
        return None, "damaged (no stages object)"
    ver = obj.get("version", 1)
    if isinstance(ver, bool) or not isinstance(ver, (int, float)): ver = 1
    if ver > 2: return None, f"version {ver} is newer than this sync understands"
    # Same duplicate-key rule as js/stages.js sanitizeDoc: for keys that clean to the same job ("684" / " 684"),
    # the exact key wins; with no exact key, the last variant in file order wins.
    entries, exact = {}, set()
    for k, v in obj["stages"].items():
        jk = clean_job_key(k)
        if not jk or jk in exact: continue
        entries[jk] = v
        if k == jk: exact.add(jk)
    return entries, "ok"

def fetch_stages(url: str = STAGES_RAW_URL, missing_ok: bool = False) -> tuple[dict | None, str]:
    """One stage file from the state repo -> (entries, "ok") or (None, reason). missing_ok: an HTTP 404 means
    the file does not exist yet -> ({}, "not found (no entries yet)") (only the beta file in dual-file mode, before
    the first beta write; a 404 on stages.json is always a failure). Any other failure is (None, reason): the caller
    keeps every closed job."""
    try:
        text = _http_text(f"{url}?t={int(time.time())}")
    except urllib.error.HTTPError as e:
        if e.code == 404 and missing_ok: return {}, "not found (no entries yet)"
        return None, f"fetch failed (HTTP {e.code})"
    except Exception as e:
        return None, f"fetch failed ({type(e).__name__})"
    try: return parse_stages_text(text)
    except Exception as e:   # never crash the sync on a hostile/odd file: treat it as unreadable (keep all)
        return None, f"could not be read ({type(e).__name__})"

# ---- beta overlay merge (r2-plan §9; shared contract rule 2; vectors in tests/fixtures/overlay_vectors.json)
# Times are compared as instants (millisecond precision, like JS Date.parse). Accepted: ISO 8601 date-time with a
# "Z" or ±HH:MM offset, e.g. "2026-09-20T10:00:00Z", "2026-09-20T10:00:00.500Z", "2026-09-20T05:00:00-05:00".
ISO_TIME_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?"
                         r"(Z|[+-][0-9]{2}:[0-9]{2})")

def parse_time(v) -> int | None:
    """ISO date-time string -> epoch milliseconds, else None (missing, not a string, not a real time: impossible
    dates such as 2026-02-30, hour 24, minute/second/offset-minute 60 and year 0000 are rejected, like js/stages.js
    cleanIso). The raw string is used: no trimming (a leading space or a trailing newline makes it no time, in
    JS too)."""
    if not isinstance(v, str): return None
    m = ISO_TIME_RE.fullmatch(v)
    if not m: return None
    y, mo, d, hh, mi, ss, frac, tz = m.groups()
    if tz != "Z" and int(tz[4:6]) > 59: return None   # "+05:60": no such offset (JS Date.parse agrees)
    try:
        tzinfo = timezone.utc if tz == "Z" else timezone(
            (1 if tz[0] == "+" else -1) * timedelta(hours=int(tz[1:3]), minutes=int(tz[4:6])))
        dt = datetime(int(y), int(mo), int(d), int(hh), int(mi), int(ss or 0), tzinfo=tzinfo)
    except (ValueError, OverflowError):
        return None
    ms = int((frac or "0")[:3].ljust(3, "0"))
    return int(dt.timestamp()) * 1000 + ms

def _overlay_parts(overlay_entry) -> tuple[str | None, int | None, bool]:
    """(understood stage key, at in ms, has a stage value at all) of a v1 entry."""
    o = overlay_entry
    if isinstance(o, str): return stage_key(o), None, True
    if isinstance(o, dict):
        return stage_key(o.get("stage")), parse_time(o.get("at")), o.get("stage") is not None
    return None, None, o is not None

def _overlay_is_newer(state_entry, o_at: int | None) -> bool:
    """Contract rule 2 time test: the state entry has no (readable) sat, OR the overlay's at is newer."""
    sat = parse_time(state_entry.get("sat")) if isinstance(state_entry, dict) else None
    return sat is None or (o_at is not None and o_at > sat)

def merge_entry(state_entry, overlay_entry):
    """Merged stage entry for one job: the state (beta) entry, except its stage comes from the overlay (v1)
    entry when the overlay has a valid stage AND (the state entry has no sat OR overlay.at > sat). Items
    (assess, lane, cut, asphalt, pavers, cleanup, removed) only ever come from the state entry. None = no entry.
    A state entry that is not an object is returned unchanged (the sync keeps such a job to be safe)."""
    o_stage, o_at, _ = _overlay_parts(overlay_entry)
    if o_stage is None or not _overlay_is_newer(state_entry, o_at): return state_entry
    if state_entry is None or isinstance(state_entry, str): return {"stage": o_stage}
    if isinstance(state_entry, dict):
        merged = dict(state_entry); merged["stage"] = o_stage
        return merged
    return state_entry

def merge_entries(state: dict, overlay: dict) -> dict:
    """merge_entry for every job in either file (jobs with no resulting entry are left out)."""
    out = {}
    for jk in list(state) + [k for k in overlay if k not in state]:
        m = merge_entry(state.get(jk), overlay.get(jk))
        if m is not None: out[jk] = m
    return out

def overlay_unclear(state_entry, overlay_entry) -> bool:
    """A v1 entry this sync does not understand that WOULD have supplied the stage (newer than sat, or no sat).
    The merge ignores it (contract); since R-3 such a job is kept anyway (only removed: true drops a job), so this
    only names the reason in the log."""
    o_stage, o_at, has_stage = _overlay_parts(overlay_entry)
    if overlay_entry is None or o_stage is not None: return False
    if not isinstance(overlay_entry, (dict, str)): return True
    return has_stage and _overlay_is_newer(state_entry, o_at)

# R-3 keep rule (docs/r3-plan.md A): a job that left Jobber's active list stays in the app until someone confirms it
# in the app ("Completed" sets removed: true). keepWhenClosed no longer decides the drop; it only names the reason
# (work still outstanding) and, in the app, decides which closed jobs wait for that confirmation (Stages.awaitingOk).
REMOVED_WHY = "removed in app"
AWAITING_WHY = "waiting for Completed in the app"

def keep_decision(entry, hints) -> tuple[bool, str]:
    """(keep, reason) for a job that left Jobber's active list. Only removed: true drops it. A value this sync does
    not understand (a newer app, a hand-edit typo) is read as a default, so it can never drop a job (an unknown
    `removed` value reads as not removed)."""
    eff = effective(entry, hints)
    if eff["removed"]: return False, REMOVED_WHY
    if keep_when_closed(eff): return True, "work started, field work not done"
    if entry_unclear(entry): return True, "stage entry not understood (kept to be safe)"
    return True, f"{AWAITING_WHY} ({'field work done' if field_work_done(eff) else 'nothing outstanding'})"

def _job_number(v) -> int | None:
    if isinstance(v, bool): return None
    try: return int(v)
    except (TypeError, ValueError): return None

def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

def _carried_record(r: dict, jn: int, hints: dict) -> dict:
    """A previous (or archived) record as a closed job, with every field main() and the app rely on present
    and well-typed (a hand-edited or older record must never crash the run half-way)."""
    rec = dict(r)
    for k in ("_why", "droppedAt", "droppedWhy"): rec.pop(k, None)
    rec["jobNumber"] = jn
    for k, default in (("client", "Unknown"), ("clientKey", "Other"), ("street", ""), ("city", "Winnipeg"),
                       ("title", ""), ("permit", ""), ("status", "")):
        if not isinstance(rec.get(k), str): rec[k] = default
    if not isinstance(rec.get("streetRaw"), str): rec["streetRaw"] = rec["street"]
    rec["unscheduled"] = rec.get("unscheduled") is True
    rec["pending"] = False
    if not (_finite(rec.get("lat")) and _finite(rec.get("lon"))): rec["lat"] = rec["lon"] = None
    rec["ok"] = rec.get("ok") is True and rec["lat"] is not None
    rec["closed"] = True
    rec["hints"] = {"asphalt": bool(hints.get("asphalt")), "pavers": bool(hints.get("pavers"))}
    if not isinstance(rec.get("id"), str) or not rec.get("id"): rec["id"] = None
    return rec

def stage_decision(jk: str, hints: dict, stage_entries: dict, overlay: dict | None) -> tuple[bool, str]:
    """keep_decision on the merged entry (overlay None = stage_entries are used as they are)."""
    s = stage_entries.get(jk)
    if overlay is None: return keep_decision(s, hints)
    o = overlay.get(jk)
    keep, why = keep_decision(merge_entry(s, o), hints)
    if keep and why.startswith(AWAITING_WHY) and overlay_unclear(s, o):   # the log names the odd v1 value
        return True, f"{STAGES_FILE} entry not understood (kept to be safe)"
    return keep, why

def carry_forward(prev_jobs: list, active_numbers: set, pending_numbers: set,
                  stage_entries: dict | None, archived: list | None = None,
                  overlay: dict | None = None) -> tuple[list[dict], list[tuple[int, str]]]:
    """Previous records of jobs that left Jobber's active list and must stay (closed: true).
    prev_jobs = candidate records, freshest first (previous jobs.json, then previous closed_jobs.json).
    stage_entries = the state file's entries (stages.json v2 in single-file mode, the beta file in dual-file mode);
    overlay = v1's stages.json entries in dual-file mode, merged per contract rule 2 (None = no overlay, the
    single-file default: stage_entries are evaluated as they are, items included).
    stage_entries None = a stage file unreadable -> keep every candidate (never drop on a read failure).
    R-3 rule (keep_decision): a candidate is kept unless its entry has removed: true ("Completed" in the app).
    archived = records from closed_archive.json (jobs dropped on an earlier run). One comes back as soon as
    its stage entry is no longer removed (Settings -> Recently removed -> Restore, a hand fix in the stage file, or
    a job an older sync dropped under the R-2 rule); while a stage file is unreadable they stay archived.
    Returns (kept records, [(jobNumber, reason) for jobs dropped this run from the previous records])."""
    kept, dropped, seen = [], [], set()
    cands = [(r, False) for r in prev_jobs or []] + [(r, True) for r in archived or []]
    for r, from_archive in cands:
        if not isinstance(r, dict): continue
        jn = _job_number(r.get("jobNumber"))
        if jn is None or jn in seen or jn in active_numbers or jn in pending_numbers or r.get("pending"): continue
        seen.add(jn)
        hints = r.get("hints") if isinstance(r.get("hints"), dict) else {}
        if stage_entries is None:
            if from_archive: continue
            keep, why = True, "stage file unreadable (kept to be safe)"
        else:
            keep, why = stage_decision(str(jn), hints, stage_entries, overlay)
        if not keep:
            if not from_archive: dropped.append((jn, why))
            continue
        rec = _carried_record(r, jn, hints)
        rec["_why"] = f"restored from {ARCHIVE_NAME}: {why}" if from_archive else why
        kept.append(rec)
    return kept, dropped

def store_looks_reset(stage_entries: dict | None, prev_jobs: list, active_numbers: set) -> bool:
    """A readable stages.json with no entries at all while the previous run kept closed jobs: almost surely a
    reset or re-created state repo (or a stale copy), not a real "every job is Ready"."""
    if stage_entries != {}: return False
    return any(isinstance(r, dict) and r.get("closed") is True and _job_number(r.get("jobNumber")) is not None
               and _job_number(r.get("jobNumber")) not in active_numbers for r in prev_jobs or [])

def stage_files() -> tuple[str, ...]:
    """The stage files carry-forward reads in the current mode (see BETA_STATE_FILE), stages.json first."""
    return (STAGES_FILE,) + ((BETA_STATE_FILE,) if BETA_STATE_FILE else ())

def read_stage_files(prev_closed_recs: list, active_numbers: set,
                     prev_counts: dict) -> tuple[dict | None, dict | None, dict, dict]:
    """Reads the stage files of the current mode (stage_files()) ->
    (state entries, overlay entries, {file: entry count} for each file read well, {file: read note}).
    state None = a needed file is unreadable or looks reset (carry-forward then keeps every candidate).
    Single-file mode: state = stages.json's entries, overlay None. Dual-file mode: state = the beta file's
    entries, overlay = stages.json's entries.
    Reset guards: stages.json with no entries while closed jobs were kept last run (store_looks_reset), and the
    state file (the one with items) with no entries while it had entries last run (prev_counts)."""
    files, notes = {}, {}
    files[STAGES_FILE], notes[STAGES_FILE] = fetch_stages(STAGES_RAW_URL)
    if BETA_STATE_FILE:
        files[BETA_STATE_FILE], notes[BETA_STATE_FILE] = fetch_stages(STATE_RAW_BASE + BETA_STATE_FILE,
                                                                      missing_ok=True)
    if store_looks_reset(files[STAGES_FILE], prev_closed_recs, active_numbers):
        files[STAGES_FILE], notes[STAGES_FILE] = None, ("no entries at all, but closed jobs were kept last run "
                                                        "(reset or stale copy?)")
    state_name = BETA_STATE_FILE or STAGES_FILE
    prev_n = prev_counts.get(state_name)
    if files[state_name] == {} and _finite(prev_n) and prev_n > 0:
        files[state_name], notes[state_name] = None, (f"no entries at all, but it had {int(prev_n)} last run "
                                                      "(reset or stale copy?)")
    counts = {name: len(entries) for name, entries in files.items() if entries is not None}
    if len(counts) < len(files):
        return None, None, counts, notes
    return files[state_name], (files[STAGES_FILE] if BETA_STATE_FILE else None), counts, notes

def load_previous_closed(p: Path) -> tuple[list | None, str | None]:
    """Previous closed_jobs.json -> (records, None). Missing -> ([], None) (first beta-channel run).
    Present but unreadable / not a list -> (None, problem): the caller leaves the closed-job files alone."""
    if not p.exists(): return [], None
    try: doc = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e: return None, f"{p.name} unreadable ({type(e).__name__})"
    if not isinstance(doc, list): return None, f"{p.name} is not a list"
    return [r for r in doc if isinstance(r, dict)], None

def load_archive(p: Path) -> tuple[list, str | None]:
    """closed_archive.json -> (records, None), or ([], problem) when it is missing/unreadable."""
    if not p.exists(): return [], None
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        recs = doc.get("jobs") if isinstance(doc, dict) else None
        if not isinstance(recs, list): raise ValueError("no jobs list")
        return [r for r in recs if isinstance(r, dict)], None
    except Exception as e:
        return [], f"{p.name} unreadable ({type(e).__name__}); starting a new one"

def next_archive(prev_archive: list, prev_jobs: list, dropped: list, kept: list, active_numbers: set,
                 pending_numbers: set, today: date) -> list:
    """closed_archive.json records: every job carry-forward dropped in the last ARCHIVE_DAYS days, so a
    mistaken drop can be undone by fixing stages.json alone (the job comes back on the next run)."""
    gone = {r["jobNumber"] for r in kept} | set(active_numbers) | set(pending_numbers)
    prev_by_num = {}
    for r in prev_jobs or []:
        if isinstance(r, dict) and _job_number(r.get("jobNumber")) is not None:
            prev_by_num.setdefault(_job_number(r.get("jobNumber")), r)
    out, have = [], set()
    for jn, why in dropped:
        r = prev_by_num.get(jn)
        if r is None or jn in gone or jn in have: continue
        rec = {k: v for k, v in r.items() if k not in ("_why", "droppedAt", "droppedWhy")}
        rec.update({"jobNumber": jn, "droppedAt": today.isoformat(), "droppedWhy": why})
        out.append(rec); have.add(jn)
    oldest = today - timedelta(days=ARCHIVE_DAYS)
    for r in prev_archive or []:
        jn = _job_number(r.get("jobNumber")) if isinstance(r, dict) else None
        d = clean_date(r.get("droppedAt")) if jn is not None else None
        if d is None or jn in gone or jn in have or date.fromisoformat(d) < oldest: continue
        out.append(r); have.add(jn)
    out.sort(key=lambda r: -_job_number(r.get("jobNumber")))
    return out

# ----------------------------------------------------------------------------- prices (AES-256-GCM)
def parse_price_key(raw: str | None) -> bytes | None:
    """base64 (standard or url-safe, whitespace ignored) of exactly 32 bytes -> key bytes, else None."""
    if not raw: return None
    s = re.sub(r"\s+", "", raw).replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    try: key = base64.b64decode(s, validate=True)
    except Exception: return None
    return key if len(key) == 32 else None

def encrypt_prices(price_map: dict, key: bytes, iv: bytes | None = None, at: str | None = None) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = iv or secrets.token_bytes(12)
    pt = json.dumps(price_map, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ct = AESGCM(key).encrypt(iv, pt, None)   # ciphertext || 16-byte tag (WebCrypto layout)
    return {"v": 1, "alg": "A256GCM", "iv": base64.b64encode(iv).decode("ascii"),
            "ct": base64.b64encode(ct).decode("ascii"),
            "at": at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}

def decrypt_prices(file_obj: dict, key: bytes) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not isinstance(file_obj, dict) or file_obj.get("v") != 1 or file_obj.get("alg") != "A256GCM":
        raise ValueError("unsupported prices file")
    iv, ct = base64.b64decode(file_obj["iv"]), base64.b64decode(file_obj["ct"])
    if len(iv) != 12: raise ValueError("bad iv")
    out = json.loads(AESGCM(key).decrypt(iv, ct, None).decode("utf-8"))
    if not isinstance(out, dict): raise ValueError("bad plaintext")
    return out

def build_price_map(jobs: list[dict], totals: dict) -> dict:
    """{"<jobNumber>": {"t": total, "u": uninvoiced}} for jobs in the output; null values are skipped."""
    out = {}
    for r in jobs:
        t, u = totals.get(r["jobNumber"], (None, None))
        e = {}
        if _num(t) is not None: e["t"] = _num(t)
        if _num(u) is not None: e["u"] = _num(u)
        if e: out[str(r["jobNumber"])] = e
    return out

def update_prices(out_dir: Path, jobs: list[dict], totals: dict, prev_prices_file: Path | None) -> str:
    """Writes out_dir/prices.json when PRICE_KEY is valid. Otherwise leaves any existing file untouched.
    Returns a one-line status for the log (never contains prices or the key)."""
    raw = os.environ.get("PRICE_KEY")
    if raw is None or not raw.strip():
        return "prices: skipped (PRICE_KEY not set)"
    key = parse_price_key(raw)
    if key is None:
        return "::warning::prices: skipped (PRICE_KEY invalid: must be base64 of 32 bytes)"
    try:
        import cryptography  # noqa: F401
    except ImportError:
        return "::warning::prices: skipped (cryptography package not installed)"
    # Closed jobs whose Jobber refresh failed keep their previous encrypted values.
    missing = [r["jobNumber"] for r in jobs if r.get("closed") and r["jobNumber"] not in totals]
    if missing and prev_prices_file and prev_prices_file.exists():
        try:
            prev = decrypt_prices(json.loads(prev_prices_file.read_text(encoding="utf-8")), key)
            for jn in missing:
                e = prev.get(str(jn))
                if isinstance(e, dict): totals[jn] = (e.get("t"), e.get("u"))
        except Exception as e:
            print(f"::warning::prices: previous prices.json not readable with this key ({type(e).__name__}); "
                  "closed jobs without a refresh have no price")
    pmap = build_price_map(jobs, totals)
    (out_dir / PRICES_NAME).write_text(json.dumps(encrypt_prices(pmap, key), indent=1), encoding="utf-8")
    return f"prices: written (encrypted, {len(pmap)} jobs)"

# ----------------------------------------------------------------------------- transform
def clean_addr(s: str) -> str:
    s = (s or "").replace("&amp;", "&")
    s = re.sub(r"\s*\(.*?\)\s*", " ", s)      # (parenthetical)
    s = re.sub(r"\s*\[.*?\]\s*", " ", s)      # [bracketed]
    s = re.sub(r"\bUnits?\s*[\d\-,\s]+", "", s, flags=re.I)
    s = re.sub(r"\b(Rear Lane|Lane)\b", "", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip(" -,")

# ---- range streets (r3-plan E): "Portage Ave (Lipton St to Lenore St)" / "Colony St [Portage Av to Webb Pl]".
# clean_addr alone strips the brackets and leaves a bare "Portage Ave" (a generic pin somewhere on a long street).
RANGE_RE = re.compile(r"^(?P<main>[^()\[\]]*?)\s*(?:\((?P<a1>[^()\[\]]*?)\s+to\s+(?P<b1>[^()\[\]]*?)\)"
                      r"|\[(?P<a2>[^()\[\]]*?)\s+to\s+(?P<b2>[^()\[\]]*?)\])", re.I)
# A house number ("905", "12A", "10-12") but not a numbered street ("1st St NW", "2nd Ave").
HOUSE_NO_RE = re.compile(r"^\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?(?=[\s,]|$)")
INTERSECTION_RE = re.compile(r"&|\band\b", re.I)
RANGE_MAX_KM = 2.0   # both ends geocoded this close together -> pin at the midpoint; else at "Main & A"

def _one_line(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip(" -,")

def parse_range_street(street_raw: str | None) -> tuple[str, str, str] | None:
    """A Jobber street WITHOUT a house number followed by "(A to B)" or "[A to B]" -> (main, A, B), else None.
    main is cleaned like clean_addr; a main street that is already an intersection ("X and Y (...)") or a range of
    house numbers ("(100 to 200)") is not a range street (the old clean_addr result stands)."""
    s = (street_raw or "").replace("&amp;", "&")
    m = RANGE_RE.match(s)
    if not m: return None
    main = clean_addr(m.group("main"))
    a, b = _one_line(m.group("a1") or m.group("a2")), _one_line(m.group("b1") or m.group("b2"))
    if not (main and a and b): return None
    if any(HOUSE_NO_RE.match(x) for x in (main, a, b)) or INTERSECTION_RE.search(main): return None
    return main, a, b

def distance_km(p: list | tuple, q: list | tuple) -> float:
    """Great-circle distance between two [lat, lon] points in km."""
    la1, lo1, la2, lo2 = map(math.radians, (p[0], p[1], q[0], q[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(h)))

def geocode_range(cache: dict, main: str, a: str, b: str, city: str, key: str | None) -> tuple[list | None, str, int]:
    """Pin of a range street -> (coords, how, api_calls). Both ends go through geocode() (same cache keys:
    "Main & A, City, MB, Canada"). Midpoint of "Main & A" and "Main & B" when both are found within RANGE_MAX_KM;
    else "Main & A"; else (A not found) "Main & B"; else (neither) the street itself ("Main"), so the job keeps a pin."""
    ca, hit_a = geocode(cache, f"{main} & {a}", city, key)
    cb, hit_b = geocode(cache, f"{main} & {b}", city, key)
    calls = int(hit_a) + int(hit_b)
    if ca and cb and distance_km(ca, cb) <= RANGE_MAX_KM:
        return [round((ca[0] + cb[0]) / 2, 7), round((ca[1] + cb[1]) / 2, 7)], "midpoint", calls
    if ca: return ca, (f"{main} & {a} ({b} end too far)" if cb else f"{main} & {a}"), calls
    if cb: return cb, f"{main} & {b} ({a} end not found)", calls
    # neither end: the street's own pin (what the job had before range streets), so it stays mapped and can still be
    # corrected in the app (Edit name & location)
    cm, hit_m = geocode(cache, main, city, key)
    calls += int(hit_m)
    if cm: return cm, f"{main} (range ends not found, street pin)", calls
    return None, "not found", calls

def extract_permit(title: str) -> str:
    t = (title or "").replace("&amp;", "&")
    perms = re.findall(r"\b(?:M\d{5,6}|TM\d{4,6}|CTR\d+|\d{5,6})\b", t)
    if perms: return " / ".join(dict.fromkeys(perms))
    return "(gas)" if "Gas" in t else ""

def load_json(p: Path, default):
    try: return json.loads(p.read_text(encoding="utf-8"))
    except Exception: return default

def in_manitoba(lat: float, lon: float) -> bool:
    a, b, c, d = MB_BOX
    return a <= lat <= b and c <= lon <= d

def geocode(cache: dict, addr: str, city: str, key: str | None) -> tuple[list | None, bool]:
    """Returns (coords, from_api)."""
    k = f"{addr}, {city}, MB, Canada"
    if k in cache: return cache[k], False
    if not key:
        print(f"  !! no TOMTOM_KEY; cannot geocode: {k}"); return None, False
    url = (f"https://api.tomtom.com/search/2/geocode/{urllib.parse.quote(k)}.json"
           f"?key={key}&limit=1&countrySet=CA")
    try:
        d = _http_json(url)
    except Exception as e:
        # the exception text can contain the request URL (with the key): print the type only
        code = getattr(e, "code", None)
        print(f"  !! geocode error {k}: {type(e).__name__}{f' HTTP {code}' if code else ''}"); return None, True
    if not d.get("results"): print(f"  !! geocode NONE: {k}"); return None, True
    pos = d["results"][0]["position"]; lat, lon = pos["lat"], pos["lon"]
    if not in_manitoba(lat, lon):
        print(f"  !! geocode OUTSIDE MB (mis-snap): {k} -> {lat:.4f},{lon:.4f}"); return None, True
    cache[k] = [lat, lon]
    print(f"  geocoded: {k} -> {lat:.4f},{lon:.4f}")
    return cache[k], True

def load_previous_jobs(p: Path) -> tuple[list | None, str | None]:
    """Previous jobs.json -> (records, None). Missing -> ([], None). Present but unreadable / not a list ->
    (None, problem): the run still rebuilds jobs.json from Jobber (v1 must never stay stuck on a broken file;
    R-1's sync never read it), but carry-forward is skipped and the closed-job files are left alone."""
    if not p.exists(): return [], None
    try: prev = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e: return None, f"previous {p.name} unreadable ({type(e).__name__})"
    if not isinstance(prev, list): return None, f"previous {p.name} is not a list"
    return prev, None

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Sync active Jobber jobs into jobs.json (see module docstring).")
    ap.add_argument("--out", default=str(DATA), help="output folder (default: repo data/)")
    ap.add_argument("--data", default=str(DATA), help="folder with street_overrides.json + pending_manual.json (default: repo data/)")
    args = ap.parse_args(argv)
    out_dir, data_dir = Path(args.out), Path(args.data)
    out_dir.mkdir(parents=True, exist_ok=True)
    def prev_path(name: str) -> Path:
        return out_dir / name if (out_dir / name).exists() else data_dir / name

    prev_jobs, jobs_problem = load_previous_jobs(prev_path(JOBS_NAME))
    prev_closed, closed_problem = load_previous_closed(prev_path(CLOSED_NAME))
    prev_meta = load_json(prev_path(META_NAME), {})
    prev_meta = prev_meta if isinstance(prev_meta, dict) else {}
    prev_hints = {}
    for r in (prev_jobs or []) + (prev_closed or []):   # jobs.json first: the freshest record wins
        if isinstance(r, dict) and isinstance(r.get("hints"), dict):
            prev_hints.setdefault(_job_number(r.get("jobNumber")), r.get("hints"))
    token = get_access_token()
    raw, with_prices, with_items, stats = None, False, False, {}
    for n, (with_prices, with_items) in enumerate(LIST_VARIANTS):
        try:
            raw = fetch_active_jobs(token, prices=with_prices, items_=with_items, stats=stats)
            break
        except JobberQueryError as e:
            if n == len(LIST_VARIANTS) - 1: raise
            print(f"::warning::jobber: job list query refused ({e}); retrying without "
                  f"{'totals' if n == 0 else 'totals and line items'} (prices and/or hints degraded this run)")
    prices_ok = with_prices and not stats.get("partial_errors")
    partial_jobs = stats.get("partial_jobs") or set()
    print(f"jobber: {len(raw)} active jobs")

    cache = load_json(prev_path(CACHE_NAME), {})
    overrides = {int(k): v for k, v in load_json(data_dir / OVERRIDES_NAME, {}).items()}
    pending = load_json(data_dir / PENDING_NAME, [])
    tkey = (os.environ.get("TOMTOM_KEY") or "").strip()

    jobs, totals, api_calls, li_truncated, li_missing = [], {}, 0, 0, 0
    for j in raw:
        cl = j.get("client") or {}
        addr = ((j.get("property") or {}).get("address") or {})
        client = cl.get("companyName") or cl.get("name") or "Unknown"
        jn = int(j["jobNumber"])
        street_raw = addr.get("street1") or ""
        city = addr.get("city") or "Winnipeg"
        override = overrides.get(jn)
        rng = None if override else parse_range_street(street_raw)   # a street override wins wholesale
        street = override or (f"{rng[0]} & {rng[1]}" if rng else clean_addr(street_raw))
        li_conn = j.get("lineItems")
        # line items complete for this job? Not when the query had to leave them out, when Jobber nulled
        # them, or when this job's page came back with errors.
        li_ok = (with_items and isinstance(li_conn, dict) and isinstance(li_conn.get("nodes"), list)
                 and jn not in partial_jobs)
        if with_items and not li_ok: li_missing += 1
        li_conn = li_conn if isinstance(li_conn, dict) else {}
        line_items = li_conn.get("nodes") if isinstance(li_conn.get("nodes"), list) else []
        if (li_conn.get("pageInfo") or {}).get("hasNextPage"): li_truncated += 1
        rec = {"jobNumber": jn, "id": j.get("id") or None, "client": client, "clientKey": CLIENT_KEYS.get(client, "Other"),
               "street": street, "streetRaw": street_raw, "city": city,
               "title": (j.get("title") or "").replace("&amp;", "&"),
               "permit": extract_permit(j.get("title") or ""),
               "status": j.get("jobStatus") or "", "unscheduled": (j.get("jobStatus") == "unscheduled"),
               "pending": False, "hints": compute_hints(j.get("title"), line_items),
               "lat": None, "lon": None, "ok": False}
        if not li_ok:   # degraded: line items unavailable -> keep last run's hints (OR the title's)
            ph = prev_hints.get(jn) or {}
            rec["hints"] = {k: bool(rec["hints"][k] or ph.get(k) is True) for k in ("asphalt", "pavers")}
        totals[jn] = (_num(j.get("total")), _num(j.get("uninvoicedTotal")))
        if rng:
            rec["range"] = f"{rng[1]} to {rng[2]}"
            c, how, calls = geocode_range(cache, rng[0], rng[1], rng[2], city, tkey); api_calls += calls
            if c: rec["lat"], rec["lon"], rec["ok"] = c[0], c[1], True
            print(f"range: #{jn} {street} ({rec['range']}) -> pin {how}")
        elif street:
            c, hit = geocode(cache, street, city, tkey); api_calls += int(hit)
            if c: rec["lat"], rec["lon"], rec["ok"] = c[0], c[1], True
        jobs.append(rec)
        if api_calls and api_calls % 5 == 0: time.sleep(0.2)
    if li_missing:
        print(f"::warning::jobber: {li_missing} job(s) came back without complete line items; "
              "their previous asphalt/pavers hints were kept this run")
    if li_truncated:
        print(f"jobber: {li_truncated} job(s) have more than {LINE_ITEMS_PAGE} line items; hints use the first {LINE_ITEMS_PAGE}")

    pending_numbers = set()
    for p in pending:  # manual, not-yet-in-Jobber jobs (survive rebuilds)
        c, _ = geocode(cache, p["street"], p.get("city", "Winnipeg"), tkey)
        pending_numbers.add(int(p["jobNumber"]))
        jobs.append({"jobNumber": p["jobNumber"], "id": None, "client": p["client"], "clientKey": CLIENT_KEYS.get(p["client"], "Other"),
                     "street": p["street"], "streetRaw": p["street"], "city": p.get("city", "Winnipeg"),
                     "title": p.get("title", ""), "permit": "", "status": "pending", "unscheduled": False,
                     "pending": True, "hints": compute_hints(p.get("title", "")),
                     "lat": c[0] if c else None, "lon": c[1] if c else None, "ok": bool(c)})

    # ---- carry-forward: jobs that left Jobber's active list, kept until removed in the app (r3-plan A; r2-plan §9)
    # jobs.json keeps exactly the R-1 membership (active + pending); kept closed jobs go to closed_jobs.json.
    active_numbers = {r["jobNumber"] for r in jobs}
    now = datetime.now(timezone.utc)
    closed, archive, notes = [], [], {}
    prev_counts = prev_meta.get("stage_entries") if isinstance(prev_meta.get("stage_entries"), dict) else {}
    # only the files of the current mode (single-file mode forgets the retired beta file's count)
    prev_counts = {k: v for k, v in prev_counts.items() if k in stage_files()}
    stage_counts = dict(prev_counts)
    # carry-forward needs both previous files; without one of them the closed-job files are left exactly as they are
    skip_file = JOBS_NAME if prev_jobs is None else CLOSED_NAME if prev_closed is None else None
    if prev_jobs is None:
        print(f"::warning::carry-forward: {jobs_problem}; {CLOSED_NAME}, {ARCHIVE_NAME} and {PRICES_NAME} are left "
              f"untouched this run and jobs that left Jobber since the last good run are not carried forward (the "
              f"previous {JOBS_NAME} is in git history); {JOBS_NAME} is rebuilt from Jobber")
    elif prev_closed is None:
        print(f"::warning::carry-forward: {closed_problem}; {CLOSED_NAME}, {ARCHIVE_NAME} and {PRICES_NAME} are left "
              f"untouched this run (restore {CLOSED_NAME} from git history; jobs.json is still updated)")
    else:
        # candidates, freshest first: jobs that were active last run, last run's closed_jobs.json, then any
        # closed:true records still in a previous jobs.json (migrated to closed_jobs.json)
        migrated = [r for r in prev_jobs if isinstance(r, dict) and r.get("closed") is True]
        cands = [r for r in prev_jobs if isinstance(r, dict) and r.get("closed") is not True] + prev_closed + migrated
        prev_closed_recs = prev_closed + migrated
        state, overlay, counts, read_notes = read_stage_files(prev_closed_recs, active_numbers, prev_counts)
        notes.update(read_notes)
        for name in stage_files():
            if name in counts:
                stage_counts[name] = counts[name]
            else:   # the last good count is carried, so a reset stays suspicious on later runs
                print(f"::warning::carry-forward: {name} unreadable ({notes[name]}); keeping every job that left "
                      "Jobber's active list")
        archived, archive_note = load_archive(prev_path(ARCHIVE_NAME))
        if archive_note: print(f"::warning::carry-forward: {archive_note}")
        closed, dropped = carry_forward(cands, active_numbers, pending_numbers, state, archived, overlay=overlay)
        refresh_deadline = _monotonic() + REFRESH_BUDGET_S   # one budget for every refresh (see REFRESH_BUDGET_S)
        for rec in closed:
            why = rec.pop("_why")
            jid, refreshed = rec.get("id"), ""
            if isinstance(jid, str) and jid and _monotonic() >= refresh_deadline:
                refreshed = f", not refreshed ({int(REFRESH_BUDGET_S)} s refresh budget used up; previous values kept)"
            elif isinstance(jid, str) and jid:
                try:
                    cur = refresh_job(token, jid, deadline=refresh_deadline)
                    if cur and _job_number(cur.get("jobNumber")) == rec["jobNumber"]:
                        rec["status"] = cur.get("jobStatus") or rec.get("status") or ""
                        rec["unscheduled"] = rec["status"] == "unscheduled"
                        totals[rec["jobNumber"]] = (_num(cur.get("total")), _num(cur.get("uninvoicedTotal")))
                        refreshed = ", refreshed"
                    else:
                        refreshed = ", not found in Jobber (previous values kept)"
                except Exception as e:
                    refreshed = f", refresh failed ({type(e).__name__}; previous values kept)"
            print(f"carry-forward: kept #{rec['jobNumber']} closed in Jobber ({why}{refreshed})")
        was_closed = {_job_number(r.get("jobNumber")) for r in prev_closed_recs}
        # Only removed: true drops a job (someone confirmed "Completed" in the app), so this is a normal log line, not
        # a ::warning:: any more; never silent, and the record stays in the archive (Settings -> Recently removed).
        for jn, why in dropped:
            closed_note = ", which was closed in Jobber" if jn in was_closed else ""
            print(f"carry-forward: dropped #{jn}{closed_note} ({why}); its record stays in data/{ARCHIVE_NAME} for "
                  f"{ARCHIVE_DAYS} days and comes back on the next sync if it is restored in the app")
        archive = next_archive(archived, cands, dropped, closed, active_numbers, pending_numbers, now.date())
        closed.sort(key=lambda r: -r["jobNumber"])

    # everything is computed before the first write, so a surprise can never leave a half-written set of files
    jobs.sort(key=lambda r: -r["jobNumber"])
    mapped = sum(1 for r in jobs if r["ok"]); failed = [r for r in jobs if not r["ok"]]
    by_client = {}
    for r in jobs: by_client[r["clientKey"]] = by_client.get(r["clientKey"], 0) + 1
    closed_ok = skip_file is None
    # total / mapped / failed / by_client describe jobs.json (the v1 app shows "mapped/total"); closed counts
    # closed_jobs.json
    meta = {"updated_utc": now.isoformat(timespec="seconds"),
            "total": len(jobs), "mapped": mapped, "failed": [f"#{r['jobNumber']} {r['street'] or '(blank)'}" for r in failed],
            "by_client": by_client, "cache_entries": len(cache), "geocode_api_calls": api_calls,
            "closed": len(closed) if closed_ok else prev_meta.get("closed"),
            "stages_read": notes.get(STAGES_FILE, f"not read ({skip_file} unreadable)"),
            "stages_beta_read": (notes.get(BETA_STATE_FILE, f"not read ({skip_file} unreadable)") if BETA_STATE_FILE
                                 else "not read (single-file mode)"),
            "stage_entries": stage_counts}
    texts = {CACHE_NAME: json.dumps(cache, indent=2), JOBS_NAME: json.dumps(jobs, indent=1),
             META_NAME: json.dumps(meta, indent=1)}
    if closed_ok:
        texts[CLOSED_NAME] = json.dumps(closed, indent=1)
        texts[ARCHIVE_NAME] = json.dumps({"version": 1, "days": ARCHIVE_DAYS, "jobs": archive}, indent=1)
    for name, text in texts.items():
        (out_dir / name).write_text(text, encoding="utf-8")
    closed_note = f"{len(closed)} closed in Jobber in {CLOSED_NAME}" if closed_ok else f"{CLOSED_NAME} untouched"
    print(f"done: {len(jobs)} jobs ({closed_note}), {mapped} mapped, {len(failed)} failed, "
          f"{api_calls} geocode calls, cache {len(cache)}")
    for f in failed: print(f"  FAILED: #{f['jobNumber']} {f['street']!r} / {f['city']}")

    # ---- prices last (active + closed jobs): never fails the sync, never prints amounts or the key
    try:
        if not closed_ok and (os.environ.get("PRICE_KEY") or "").strip():
            print(f"::warning::prices: skipped ({skip_file} unreadable; previous prices.json kept)")
        elif not prices_ok and (os.environ.get("PRICE_KEY") or "").strip():
            print("::warning::prices: skipped (Jobber did not return complete totals this run; previous prices.json kept)")
        elif not closed_ok:
            print(f"prices: skipped ({skip_file} unreadable)")
        else:
            print(update_prices(out_dir, jobs + closed, totals, prev_path(PRICES_NAME)))
    except Exception as e:
        print(f"::warning::prices: skipped (error: {type(e).__name__})")
    return 0

if __name__ == "__main__":
    sys.exit(main())
