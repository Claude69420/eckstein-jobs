"""
Eckstein Jobs sync — headless Jobber -> data/jobs.json (+ geocode cache).

Modes (auto-detected):
  CLOUD  (GitHub Actions): env JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_REFRESH_TOKEN.
         Uses the refresh_token grant. If Jobber rotates the refresh token, the new one is
         written to the path in env ROTATED_TOKEN_FILE (runner temp, never committed) so the
         workflow can update the repo secret.
  LOCAL  (Riley's PC): no env creds -> imports the desktop MCP's auth (Windows Credential Manager).

Geocoding: cache-first (data/geocode_cache.json); misses go to TomTom (env TOMTOM_KEY).
Results outside a Manitoba bounding box are treated as FAILED (guards the old wrong-province bug).

Outputs: data/jobs.json, data/geocode_cache.json, data/meta.json
"""
from __future__ import annotations
import json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
JOBS_OUT = DATA / "jobs.json"
CACHE_FILE = DATA / "geocode_cache.json"
META_OUT = DATA / "meta.json"
OVERRIDES_FILE = DATA / "street_overrides.json"
PENDING_FILE = DATA / "pending_manual.json"

GRAPHQL_URL = "https://api.getjobber.com/api/graphql"
GRAPHQL_VERSION = "2026-03-10"
TOKEN_URL = "https://api.getjobber.com/api/oauth/token"

# Manitoba sanity box: anything outside is a mis-snap (Alberta/Ontario/NB seen before).
MB_BOX = (48.9, 50.9, -99.8, -95.3)  # lat_min, lat_max, lon_min, lon_max

CLIENT_KEYS = {
    "Crown Pipeline Ltd.": "Crown",
    "Harris Holdings Ltd.": "Harris",
    "ACV Sewer & Water": "ACV",
    "MyTec Industry Ltd": "MyTec",
}

# ----------------------------------------------------------------------------- auth
def _http_json(url: str, data: dict | None = None, headers: dict | None = None, timeout=20) -> dict:
    body = None
    h = {"Content-Type": "application/json"}
    if headers: h.update(headers)
    if data is not None:
        body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=h, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def _form_post(url: str, fields: dict, timeout=20) -> dict:
    body = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def get_access_token() -> str:
    cid, csec, rtok = (os.environ.get("JOBBER_CLIENT_ID"), os.environ.get("JOBBER_CLIENT_SECRET"),
                       os.environ.get("JOBBER_REFRESH_TOKEN"))
    if cid and csec and rtok:
        print("auth: cloud mode (refresh_token grant)")
        tok = _form_post(TOKEN_URL, {"grant_type": "refresh_token", "refresh_token": rtok,
                                     "client_id": cid, "client_secret": csec})
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
LIST_Q = """
query ListJobs($filter: JobFilterAttributes, $first: Int, $after: String) {
  jobs(filter: $filter, first: $first, after: $after) {
    nodes { id jobNumber title jobStatus
            client { id name companyName }
            property { address { street1 city } }
            createdAt updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}"""

def fetch_active_jobs(token: str) -> list[dict]:
    headers = {"Authorization": f"Bearer {token}", "X-JOBBER-GRAPHQL-VERSION": GRAPHQL_VERSION}
    items, after = [], None
    for _ in range(50):  # hard cap on pages
        variables = {"filter": {"status": "active"}, "first": 100, "after": after}
        for attempt in range(5):
            try:
                res = _http_json(GRAPHQL_URL, {"query": LIST_Q, "variables": variables}, headers)
                break
            except Exception as e:  # retry transient
                if attempt == 4: raise
                time.sleep(2 ** attempt)
        if "errors" in res and not res.get("data"):
            raise RuntimeError(f"Jobber GraphQL error: {res['errors']}")
        page = res["data"]["jobs"]
        items.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]: break
        after = page["pageInfo"]["endCursor"]
    return items

# ----------------------------------------------------------------------------- transform
def clean_addr(s: str) -> str:
    s = (s or "").replace("&amp;", "&")
    s = re.sub(r"\s*\(.*?\)\s*", " ", s)      # (parenthetical)
    s = re.sub(r"\s*\[.*?\]\s*", " ", s)      # [bracketed]
    s = re.sub(r"\bUnits?\s*[\d\-,\s]+", "", s, flags=re.I)
    s = re.sub(r"\b(Rear Lane|Lane)\b", "", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip(" -,")

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
        print(f"  !! geocode error {k}: {e}"); return None, True
    if not d.get("results"): print(f"  !! geocode NONE: {k}"); return None, True
    pos = d["results"][0]["position"]; lat, lon = pos["lat"], pos["lon"]
    if not in_manitoba(lat, lon):
        print(f"  !! geocode OUTSIDE MB (mis-snap): {k} -> {lat:.4f},{lon:.4f}"); return None, True
    cache[k] = [lat, lon]
    print(f"  geocoded: {k} -> {lat:.4f},{lon:.4f}")
    return cache[k], True

def main() -> int:
    DATA.mkdir(exist_ok=True)
    token = get_access_token()
    raw = fetch_active_jobs(token)
    print(f"jobber: {len(raw)} active jobs")

    cache = load_json(CACHE_FILE, {})
    overrides = {int(k): v for k, v in load_json(OVERRIDES_FILE, {}).items()}
    pending = load_json(PENDING_FILE, [])
    tkey = os.environ.get("TOMTOM_KEY") or ""

    jobs, api_calls = [], 0
    for j in raw:
        cl = j.get("client") or {}
        addr = ((j.get("property") or {}).get("address") or {})
        client = cl.get("companyName") or cl.get("name") or "Unknown"
        jn = int(j["jobNumber"])
        street_raw = addr.get("street1") or ""
        city = addr.get("city") or "Winnipeg"
        street = overrides.get(jn) or clean_addr(street_raw)
        rec = {"jobNumber": jn, "client": client, "clientKey": CLIENT_KEYS.get(client, "Other"),
               "street": street, "streetRaw": street_raw, "city": city,
               "title": (j.get("title") or "").replace("&amp;", "&"),
               "permit": extract_permit(j.get("title") or ""),
               "status": j.get("jobStatus") or "", "unscheduled": (j.get("jobStatus") == "unscheduled"),
               "pending": False, "lat": None, "lon": None, "ok": False}
        if street:
            c, hit = geocode(cache, street, city, tkey); api_calls += int(hit)
            if c: rec["lat"], rec["lon"], rec["ok"] = c[0], c[1], True
        jobs.append(rec)
        if api_calls and api_calls % 5 == 0: time.sleep(0.2)

    for p in pending:  # manual, not-yet-in-Jobber jobs (survive rebuilds)
        c, _ = geocode(cache, p["street"], p.get("city", "Winnipeg"), tkey)
        jobs.append({"jobNumber": p["jobNumber"], "client": p["client"], "clientKey": CLIENT_KEYS.get(p["client"], "Other"),
                     "street": p["street"], "streetRaw": p["street"], "city": p.get("city", "Winnipeg"),
                     "title": p.get("title", ""), "permit": "", "status": "pending", "unscheduled": False,
                     "pending": True, "lat": c[0] if c else None, "lon": c[1] if c else None, "ok": bool(c)})

    jobs.sort(key=lambda r: -r["jobNumber"])
    CACHE_FILE.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    JOBS_OUT.write_text(json.dumps(jobs, indent=1), encoding="utf-8")
    mapped = sum(1 for r in jobs if r["ok"]); failed = [r for r in jobs if not r["ok"]]
    by_client = {}
    for r in jobs: by_client[r["clientKey"]] = by_client.get(r["clientKey"], 0) + 1
    meta = {"updated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "total": len(jobs), "mapped": mapped, "failed": [f"#{r['jobNumber']} {r['street'] or '(blank)'}" for r in failed],
            "by_client": by_client, "cache_entries": len(cache), "geocode_api_calls": api_calls}
    META_OUT.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"done: {len(jobs)} jobs, {mapped} mapped, {len(failed)} failed, {api_calls} geocode calls, cache {len(cache)}")
    for f in failed: print(f"  FAILED: #{f['jobNumber']} {f['street']!r} / {f['city']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
