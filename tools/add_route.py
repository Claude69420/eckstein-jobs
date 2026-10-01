#!/usr/bin/env python3
"""Add a route Claude built to the app's shared saved routes (routes.json in the state repo; R-3, docs/r3-plan.md F).

    python tools/add_route.py --name "Setup crew Tue" --stops stops.json
                              dry run (default): reads the current routes.json from the PUBLIC raw CDN (<= 5 min
                              stale), prints a summary and writes the proposed routes.json to a temp file
    ... --api                 dry run reading routes.json fresh through `gh api` (read only)
    ... --current FILE        dry run on a local copy of routes.json (an empty file = no routes.json yet)
    ... --out FILE            where the proposed routes.json is written (dry run and --write)
    ... --owner NAME          the route's owner (default "Claude"); shown in the app's Route list under "Team"
    ... --rt                  return to the shop at the end (round trip)
    ... --start shop|stop     "shop" (default): starts at the shop; "stop": the first stop is the start site (#1)
    ... --write               read routes.json through `gh api` (fresh, with its sha), add the route and PUT it back
                              (sha-guarded; 404 = create the file without a sha; a 409/422 re-reads and retries, at
                              most 3 attempts). Never writes over a damaged routes.json or one in a newer format.

stops.json = a JSON list of stops in route order: [{"name": "130 Midland St", "lat": 49.91, "lon": -97.16,
"jobNumber": 664}, ...] (optional per stop: jobNumber, match, shop, oot). Every stop must have finite lat/lon inside
the Manitoba box (lat 48.9..50.9, lon -99.8..-95.3); at most 100.
PUBLIC: routes.json, its git history and the commit message ('route: save "<name>"') are world-readable. Name the route
and the stops by street address / intersection only: never client names, phone numbers, emails or prices. The dry
run lists the stop names so a mistake shows before --write.

The route and the file are sanitized and serialized exactly like js/routes.js (tests/test_add_route.py checks it
against the real js/routes.js in node): route = {id, name, owner, by, at, rt, start: {mode}, seq, skipped: []};
file = {"version": 1, "routes": {"<id>": route | {"deleted": true, at, by}}}, tombstones older than 30 days are pruned
on write, <= 300 routes and <= 900 KB (newest kept). Commit message: route: save "<name>".

Safety: this tool never reads, prints or stores a key or token (`gh` uses its own login; in a sandboxed shell where
gh cannot see its login, set the GH_TOKEN environment variable for the run yourself; the tool never echoes it). The
dry run never writes to the state repo.
"""
from __future__ import annotations

import argparse, base64, calendar, json, math, os, re, secrets, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path

REPO = "Claude69420/eckstein-jobs-state"
FILE = "routes.json"
RAW_URL = f"https://raw.githubusercontent.com/{REPO}/main/{FILE}"
FILE_VERSION = 1
MB_BOX = {"latMin": 48.9, "latMax": 50.9, "lonMin": -99.8, "lonMax": -95.3}
LIMITS = {"name": 80, "owner": 40, "by": 40, "match": 120, "stopName": 80, "stops": 100, "routes": 300,
          "tombstones": 1000, "tombstoneDays": 30, "fileBytes": 900000}
TOMB_MS = LIMITS["tombstoneDays"] * 86400000
MODES = ("shop", "stop", "gps")
ID_RE = re.compile(r"r[0-9a-z]{6,40}")          # used with fullmatch (= js /^r[0-9a-z]{6,40}$/)
JOB_RE = re.compile(r"[0-9A-Za-z-]{1,32}")
MAX_ATTEMPTS = 3
MAX_COMMIT_MSG = 500
DEFAULT_OUT = Path(tempfile.gettempdir()) / "eckstein-routes" / "routes.proposed.json"


class AddRouteError(Exception):
    """Anything that must stop the tool (bad input, damaged / newer file, gh failure)."""


# ---------------------------------------------------------------------------------------------------------------
# Sanitizers: exact twins of js/routes.js (cleanText, cleanIso, cleanStop, cleanEntry, sanitizeDoc, serializeDoc)
# ---------------------------------------------------------------------------------------------------------------
_CTRL_RE = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+")
# JavaScript's \s (and String.prototype.trim) whitespace set; Python's \s differs (\x1c-\x1f, \x85; no \ufeff).
_JS_WS = "\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_JS_WS_RE = re.compile("[" + _JS_WS + "]+")
_JS_TRIM_RE = re.compile("^[" + _JS_WS + "]+|[" + _JS_WS + "]+$")


def clip(s: str, max_units: int) -> str:
    """At most max_units UTF-16 code units, never splitting a pair; lone surrogates become U+FFFD (js clip)."""
    out, n = [], 0
    for ch in s:
        o = ord(ch)
        if 0xD800 <= o <= 0xDFFF: ch, o = "\ufffd", 0xFFFD
        units = 2 if o > 0xFFFF else 1
        if n + units > max_units: break
        out.append(ch); n += units
    return "".join(out)


def clean_text(v, max_units: int) -> str:
    if not isinstance(v, str): return ""
    s = _JS_WS_RE.sub(" ", _CTRL_RE.sub(" ", v)).strip(" ")
    return clip(s, max_units).rstrip(" ")


_ISO_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\.[0-9]{1,9})?)?"
                     r"(Z|[+-]([0-9]{2}):([0-9]{2}))")


def _iso_parts(v):
    if not isinstance(v, str) or len(v) > 40: return None
    m = _ISO_RE.fullmatch(v)
    if not m: return None
    y, mo, d, h, mi = (int(m.group(i)) for i in range(1, 6))
    s = int(m.group(6) or 0)
    if y < 1 or not 1 <= mo <= 12 or d < 1 or d > calendar.monthrange(y, mo)[1] or h > 23 or mi > 59 or s > 59:
        return None
    if m.group(9) and (int(m.group(9)) > 23 or int(m.group(10)) > 59): return None
    return m


def clean_iso(v):
    return v if _iso_parts(v) else None


def iso_ms(v) -> float:
    """ISO text -> ms since the epoch (js Date.parse on a cleanIso time), NaN when unusable."""
    m = _iso_parts(v)
    if not m: return math.nan
    y, mo, d, h, mi = (int(m.group(i)) for i in range(1, 6))
    s = int(m.group(6) or 0)
    ms = int(((m.group(7) or ".")[1:] + "000")[:3])
    off = 0
    if m.group(8) != "Z":
        off = (int(m.group(9)) * 60 + int(m.group(10))) * 60000 * (1 if m.group(8)[0] == "+" else -1)
    days = _days_from_civil(y, mo, d)   # plain arithmetic: an offset may cross year 0 / 10000 (datetime cannot)
    return float(((days * 24 + h) * 60 + mi) * 60000 + s * 1000 + ms - off)


def _days_from_civil(y: int, m: int, d: int) -> int:
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def iso_of(ms: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _finite(v) -> bool:
    try: return math.isfinite(float(v))
    except (OverflowError, ValueError): return False


def in_box(lat, lon) -> bool:
    return (_num(lat) and _num(lon) and _finite(lat) and _finite(lon) and
            MB_BOX["latMin"] <= lat <= MB_BOX["latMax"] and MB_BOX["lonMin"] <= lon <= MB_BOX["lonMax"])


def clean_job_number(v):
    if _num(v):
        if not _finite(v) or v < 0 or v > 999999999: return None
        if isinstance(v, float):
            return int(v) if v.is_integer() else None
        return v
    return v if isinstance(v, str) and JOB_RE.fullmatch(v) else None


def clean_stop(s):
    if not isinstance(s, dict) or not in_box(s.get("lat"), s.get("lon")): return None
    o = {"name": clean_text(s.get("name"), LIMITS["stopName"]), "lat": s["lat"], "lon": s["lon"]}
    jn = clean_job_number(s["jobNumber"]) if "jobNumber" in s else None
    if jn is not None: o["jobNumber"] = jn
    mt = clean_text(s.get("match"), LIMITS["match"])
    if mt: o["match"] = mt
    if s.get("shop") is True: o["shop"] = True
    if s.get("oot") is True: o["oot"] = True
    return o


def clean_stops(a) -> list:
    if not isinstance(a, list): return []
    out = []
    for s in a:
        if len(out) >= LIMITS["stops"]: break
        c = clean_stop(s)
        if c: out.append(c)
    return out


def clean_start(v) -> dict:
    is_obj = isinstance(v, dict)
    mode = v.get("mode") if is_obj else None
    o = {"mode": mode if isinstance(mode, str) and mode in MODES else "shop"}
    if is_obj:
        if in_box(v.get("lat"), v.get("lon")): o["lat"] = v["lat"]; o["lon"] = v["lon"]
        nm = clean_text(v.get("name"), LIMITS["stopName"])
        if nm: o["name"] = nm
    return o


def clean_entry(rid, v):
    """(id, any value) -> route | tombstone | None (js cleanEntry)."""
    if not isinstance(rid, str) or not ID_RE.fullmatch(rid) or not isinstance(v, dict): return None
    at = clean_iso(v.get("at"))
    if not at: return None
    if v.get("deleted") is True: return {"deleted": True, "at": at, "by": clean_text(v.get("by"), LIMITS["by"])}
    seq = clean_stops(v.get("seq"))
    if not seq: return None
    return {"id": rid, "name": clean_text(v.get("name"), LIMITS["name"]) or "Route",
            "owner": clean_text(v.get("owner"), LIMITS["owner"]), "by": clean_text(v.get("by"), LIMITS["by"]),
            "at": at, "rt": v.get("rt") is True, "start": clean_start(v.get("start")), "seq": seq,
            "skipped": clean_stops(v.get("skipped"))}


def _newest_key(item):
    rid, e = item
    return (-iso_ms(e["at"]), rid)


def _utf8_len(s: str) -> int:
    return len(s.encode("utf-8", "surrogatepass"))


def cap_map(m: dict) -> dict:
    """js capMap: newest LIMITS["routes"] routes and LIMITS["tombstones"] tombstones; then the oldest routes go while the
    file would pass LIMITS["fileBytes"] (GitHub's contents API stops returning a file over 1 MB)."""
    live = sorted(((k, e) for k, e in m.items() if not e.get("deleted")), key=_newest_key)[:LIMITS["routes"]]
    tombs = sorted(((k, e) for k, e in m.items() if e.get("deleted")), key=_newest_key)[:LIMITS["tombstones"]]
    empty = _utf8_len(serialize_doc({}, None))
    sizes = {k: _utf8_len(serialize_doc({k: e}, None)) - empty + 1 for k, e in live + tombs}
    total = empty + sum(sizes.values())
    while total > LIMITS["fileBytes"] and len(live) > 1:
        total -= sizes[live.pop()[0]]
    return dict(sorted(live + tombs))


def _reject_constant(c):
    raise ValueError(f"not JSON: {c}")


def parse_json(text):
    try: return json.loads(text, parse_constant=_reject_constant)
    except Exception: return None


def sanitize_doc(obj) -> dict:
    m, extras = {}, {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k not in ("version", "routes", "__proto__"): extras[k] = v
        if isinstance(obj.get("routes"), dict):
            for rid, v in obj["routes"].items():
                e = clean_entry(rid, v)
                if e: m[rid] = e
    version = obj["version"] if isinstance(obj, dict) and _num(obj.get("version")) else 1
    return {"map": cap_map(m), "extras": extras, "version": version}


def _strip_bom(t) -> str:
    t = t if isinstance(t, str) else ""
    return t[1:] if t.startswith("\ufeff") else t


def parse_doc_text(text) -> dict:
    return sanitize_doc(parse_json(_strip_bom(text)))


def js_trim(s: str) -> str:
    return _JS_TRIM_RE.sub("", s)


def is_damaged(text) -> bool:
    """Non-empty text that is not {"routes": {...}}: never write over it (js isDamaged)."""
    t = js_trim(_strip_bom(text))
    if not t: return False
    j = parse_json(t)
    return not isinstance(j, dict) or not isinstance(j.get("routes"), dict)


def prune_tombstones(m: dict, now_ms: float) -> dict:
    return {k: e for k, e in m.items() if not (e.get("deleted") and not iso_ms(e["at"]) >= now_ms - TOMB_MS)}


def _js_keys(d: dict) -> list:
    """Object.keys order: array-index keys ascending, then the other keys in insertion order."""
    idx = [k for k in d if re.fullmatch(r"0|[1-9][0-9]*", k) and int(k) < 2 ** 32 - 1]
    return sorted(idx, key=int) + [k for k in d if k not in idx]


def _js_order(v):
    """Objects re-keyed in JavaScript property order (array-index keys first), recursively, like JSON.stringify."""
    if isinstance(v, dict): return {k: _js_order(v[k]) for k in _js_keys(v)}
    if isinstance(v, list): return [_js_order(x) for x in v]
    return v


def serialize_doc(m: dict, extras: dict | None) -> str:
    """js serializeDoc: 2-space JSON + newline; routes sorted by id; unknown top-level fields after them (in
    JavaScript key order: array-index keys such as "9" come first, even before "version"). Lone surrogates
    (possible only inside unknown fields) are escaped the way JSON.stringify does."""
    doc = {"version": FILE_VERSION, "routes": {k: m[k] for k in sorted(m)}}
    ex = extras or {}
    for k in _js_keys(ex):
        if k not in doc: doc[k] = ex[k]
    text = json.dumps(_js_order(doc), indent=2, ensure_ascii=False) + "\n"
    return re.sub("[\ud800-\udfff]", lambda x: "\\u%04x" % ord(x.group()), text)


def commit_message(parts: list[tuple[str, str]]) -> str:
    def one(p): return f'{p[0]} "{clean_text(p[1], LIMITS["name"])}"'
    if len(parts) == 1: return "route: " + one(parts[0])
    out, n = "routes: ", 0
    for p in parts:
        t = one(p)
        if n and len(out) + len(t) + 2 > MAX_COMMIT_MSG: break
        out += ("; " if n else "") + t; n += 1
    if n < len(parts): out += f"; +{len(parts) - n} more"
    return out


def _b36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n <= 0: return "0"
    s = ""
    while n: n, r = divmod(n, 36); s = digits[r] + s
    return s


def new_id(now_ms: float) -> str:
    """"r" + base36 time + base36 random (like js newId: two random 32-bit values)."""
    return ("r" + _b36(int(max(0, now_ms))) + _b36(secrets.randbits(32)) + _b36(secrets.randbits(32)))[:41]


# ---------------------------------------------------------------------------------------------------------------
# Building the route
# ---------------------------------------------------------------------------------------------------------------
def load_stops(path: str) -> list:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8-sig"), parse_constant=_reject_constant)
    except Exception as e:
        raise AddRouteError(f"could not read the stops file ({type(e).__name__})")
    if not isinstance(raw, list) or not raw: raise AddRouteError("the stops file must be a non-empty JSON list of stops")
    if len(raw) > LIMITS["stops"]: raise AddRouteError(f"too many stops ({len(raw)}; at most {LIMITS['stops']})")
    for i, s in enumerate(raw, 1):
        if clean_stop(s) is None:
            raise AddRouteError(f"stop {i} is not an object with numeric lat/lon inside Manitoba "
                                "(lat 48.9..50.9, lon -99.8..-95.3)")
    return raw


def build_route(name: str, stops: list, owner: str = "Claude", rt: bool = False, start: str = "shop",
                now_ms: float | None = None, rid: str | None = None) -> dict:
    t = time.time() * 1000 if now_ms is None else now_ms
    if not clean_text(name, LIMITS["name"]): raise AddRouteError("--name is empty")
    if start not in ("shop", "stop"): raise AddRouteError("--start must be shop or stop")
    rid = rid or new_id(t)
    who = clean_text(owner, LIMITS["owner"]) or "Claude"
    e = clean_entry(rid, {"name": name, "owner": who, "by": who, "at": iso_of(t), "rt": bool(rt),
                          "start": {"mode": start}, "seq": stops, "skipped": []})
    if not e: raise AddRouteError("the route has no usable stop")
    return e


def add_to_doc(text: str | None, route: dict, now_ms: float) -> tuple[str, dict]:
    """Current file text (None = no file) + route -> (new file text, info). Raises on a damaged / newer file."""
    if text is not None and is_damaged(text):
        raise AddRouteError(f"{FILE} in the state repo is damaged (not valid route JSON): fix it first; nothing written")
    d = parse_doc_text(text or "")
    if d["version"] > FILE_VERSION:
        raise AddRouteError(f"{FILE} was written by a newer app version (version {d['version']}): update this tool; "
                            "nothing written")
    before = d["map"]
    m = dict(before)
    m[route["id"]] = route
    pruned = prune_tombstones(m, now_ms)
    capped = cap_map(pruned)
    if route["id"] not in capped: raise AddRouteError("the route would not fit in the file (300 routes max)")
    info = {"before": sum(1 for e in before.values() if not e.get("deleted")),
            "after": sum(1 for e in capped.values() if not e.get("deleted")),
            "tombstones_pruned": len(m) - len(pruned), "dropped_by_cap": len(pruned) - len(capped)}
    return serialize_doc(capped, d["extras"]), info


# ---------------------------------------------------------------------------------------------------------------
# I/O: public raw file, local file, gh api
# ---------------------------------------------------------------------------------------------------------------
def fetch_raw() -> str | None:
    try:
        with urllib.request.urlopen(f"{RAW_URL}?t={int(time.time())}", timeout=20) as r:
            return r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise AddRouteError(f"could not read {FILE} (HTTP {e.code})")
    except Exception as e:
        raise AddRouteError(f"could not read {FILE} ({type(e).__name__})")


def _gh(args: list[str], input_file: str | None = None) -> subprocess.CompletedProcess:
    cmd = ["gh", "api"] + args + (["--input", input_file] if input_file else [])
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    except FileNotFoundError:
        raise AddRouteError("the GitHub CLI (gh) is not installed or not on PATH")
    except subprocess.TimeoutExpired:
        raise AddRouteError("gh api timed out")


def _gh_err(p: subprocess.CompletedProcess) -> str:
    lines = [l.strip() for l in (p.stderr or "").splitlines() if l.strip()]
    return lines[-1][:200] if lines else f"exit code {p.returncode}"


def gh_get() -> tuple[str | None, str | None]:
    """(text, sha) of routes.json through the contents API (fresh); (None, None) when it does not exist yet."""
    p = _gh([f"repos/{REPO}/contents/{FILE}"])
    if p.returncode != 0:
        if "HTTP 404" in (p.stderr or ""): return None, None
        raise AddRouteError(f"could not read {FILE} through gh api: {_gh_err(p)}")
    try:
        j = json.loads(p.stdout)
        if j.get("encoding") != "base64" or not isinstance(j.get("sha"), str): raise ValueError("unexpected response")
        return base64.b64decode(j.get("content") or "").decode("utf-8"), j["sha"]
    except Exception as e:
        raise AddRouteError(f"could not read {FILE} through gh api ({type(e).__name__})")


class Conflict(Exception):
    pass


def gh_put(text: str, sha: str | None, message: str) -> str:
    payload = {"message": message, "content": base64.b64encode(text.encode("utf-8")).decode("ascii"), "branch": "main"}
    if sha: payload["sha"] = sha
    fd, tmp = tempfile.mkstemp(prefix="add-route-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f: json.dump(payload, f)
        p = _gh(["-X", "PUT", f"repos/{REPO}/contents/{FILE}"], input_file=tmp)
    finally:
        try: os.remove(tmp)
        except OSError: pass
    if p.returncode != 0:
        err = p.stderr or ""
        if "HTTP 409" in err or "HTTP 422" in err: raise Conflict()
        raise AddRouteError(f"the PUT of {FILE} failed, it was NOT written: {_gh_err(p)}")
    try: return str(json.loads(p.stdout)["commit"]["sha"])
    except Exception: return "(commit sha not reported)"


def write_route(route: dict, now_ms: float, out: Path) -> tuple[str, dict]:
    """Fresh read (text + sha from the same response), add, sha-guarded PUT; a 409/422 re-reads (<= 3 attempts)."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        text, sha = gh_get()
        new_text, info = add_to_doc(text, route, now_ms)
        _save(out, new_text)
        try:
            commit = gh_put(new_text, sha, commit_message([("save", route["name"])]))
            return commit, info
        except Conflict:
            if attempt == MAX_ATTEMPTS: break
            time.sleep(0.4 * attempt)
    raise AddRouteError(f"{FILE} kept changing (conflict {MAX_ATTEMPTS} times): it was NOT written. Run the tool again.")


def _save(out: Path, text: str) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8", newline="\n")


def _summary(route: dict, info: dict, out: Path, source: str) -> str:
    start = {"shop": "the shop", "stop": "stop #1 (" + route["seq"][0]["name"] + ")"}.get(route["start"]["mode"], "?")
    jobs = [str(s["jobNumber"]) for s in route["seq"] if "jobNumber" in s]
    lines = [f"route      {route['name']}  (id {route['id']})",
             f"owner      {route['owner']}   saved at {route['at']}",
             f"stops      {len(route['seq'])} routed, starting at {start}" + ("; back to the shop" if route["rt"] else ""),
             f"jobs       {', '.join('#' + j for j in jobs) if jobs else '(none linked)'}",
             "names      " + "; ".join(s["name"] for s in route["seq"][:12]) + (" ..." if len(route["seq"]) > 12 else "")
             + "   (PUBLIC: addresses only)",
             f"read from  {source}",
             f"routes     {info['before']} -> {info['after']}" +
             (f"   (tombstones pruned: {info['tombstones_pruned']})" if info["tombstones_pruned"] else "") +
             (f"   (oldest dropped by the 300-route / size cap: {info['dropped_by_cap']})" if info["dropped_by_cap"] else ""),
             f"proposal   {out}"]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Add a route to the Eckstein Jobs app's shared saved routes (routes.json).")
    ap.add_argument("--name", required=True, help="route name (one line, <= 80 characters)")
    ap.add_argument("--stops", required=True, help="JSON list of stops [{name, lat, lon, jobNumber?}] in route order")
    ap.add_argument("--owner", default="Claude", help='owner shown in the app (default "Claude")')
    ap.add_argument("--rt", action="store_true", help="return to the shop at the end")
    ap.add_argument("--start", choices=("shop", "stop"), default="shop", help="start at the shop (default) or the first stop")
    ap.add_argument("--write", action="store_true", help="PUT the new routes.json through gh api (otherwise a dry run)")
    ap.add_argument("--api", action="store_true", help="dry run: read routes.json fresh through gh api (read only)")
    ap.add_argument("--current", help="dry run: a local copy of routes.json (empty file = none yet)")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="where the proposed routes.json is written")
    a = ap.parse_args(argv)
    try:
        if a.write and a.current: raise AddRouteError("--current is for dry runs only (--write always reads through gh api)")
        now_ms = time.time() * 1000
        route = build_route(a.name, load_stops(a.stops), owner=a.owner, rt=a.rt, start=a.start, now_ms=now_ms)
        out = Path(a.out)
        if a.write:
            commit, info = write_route(route, now_ms, out)
            print(_summary(route, info, out, "gh api (fresh)"))
            print(f"WRITTEN   {FILE} in {REPO}, commit {commit[:12]}. The app shows it within ~1 min (key) / ~5 min.")
            return 0
        if a.current:
            try: text = Path(a.current).read_text(encoding="utf-8")
            except OSError as e: raise AddRouteError(f"could not read --current ({type(e).__name__})")
            source = f"local file {a.current}"
        elif a.api:
            text, _ = gh_get(); source = "gh api (fresh, read only)"
        else:
            text = fetch_raw(); source = "raw CDN (up to ~5 min stale)"
        new_text, info = add_to_doc(text if text else None, route, now_ms)
        _save(out, new_text)
        print(_summary(route, info, out, source))
        print("DRY RUN   nothing was written to the state repo. Re-run with --write to add the route.")
        return 0
    except AddRouteError as e:
        print(f"add_route: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
