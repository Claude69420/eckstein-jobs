#!/usr/bin/env python3
"""Promote the R-2 beta to the main app: merge stages-beta.json into stages.json as ONE v2 file.

    python tools/promote_stages.py                      dry run on the PUBLIC raw files (default; CDN, <= 5 min stale)
    python tools/promote_stages.py --api                dry run reading both files fresh through `gh api` (read only)
    python tools/promote_stages.py --v1 A --beta B      dry run on local files
    python tools/promote_stages.py --out FILE           where the proposed stages.json is written (dry run)
    python tools/promote_stages.py --write --expect SHA [--seal-beta]
                                                        read both files through `gh api` (fresh, with the sha), check
                                                        the fresh proposal is the reviewed one (--expect = the dry run's
                                                        "proposal sha256", >= 12 hex chars) and PUT the merged
                                                        stages.json. Aborts on any error or a 409. --seal-beta then marks
                                                        stages-beta.json retired (version 3, content kept; sha-guarded),
                                                        so a beta app still running cannot save there any more; without
                                                        it the beta file's sha is re-checked. Exit 3 = promoted, but
                                                        stages-beta.json changed meanwhile (compare by hand).
    python tools/promote_stages.py --rollback [--write --expect SHA]
                                                        ROLLBACK: down-convert the CURRENT v2 stages.json into a v1
                                                        stages.json (R-1 stages; Setup -> Ready, listed) and a v2
                                                        stages-beta.json (stage + items, sat = at), see rollback().
    python tools/promote_stages.py --check              AFTER the promotion: is the public stages.json still version 2?
                                                        exit 0 = yes, exit 4 = not version 2 (see --repair)
    python tools/promote_stages.py --repair [--write --expect SHA]
                                                        REPAIR after a page still running the v1 app (R-1) rewrote the
                                                        promoted stages.json as version 1 (items and Setup entries
                                                        gone): rebuild v2 from the newest v2 version in the state
                                                        repo's history + the R-1 moves made since, see repair(). Close
                                                        that page first. Dry run by default (read only, gh api);
                                                        --repair --v1 CUR --last-v2 BASE = dry run on local files.

Spec: docs/r2-plan.md sec. 9 "Promotion", APP_MASTER.md sec. 7.17. Per job (the beta's merged view, exactly as
js/stages.js shows it: sanitizeDoc(stages-beta.json) + sanitizeOverlay(stages.json) -> mergeOverlay):
  * stage   = the overlay merge result (the v1 stage wins when the v1 entry is newer than the beta "sat", or the
              beta entry has no sat; an unusable v1 "at" never beats a sat);
  * items   = assess, lane, cut, asphalt, pavers, cleanup, removed from the beta file (v1 never had items);
  * at / by = from the merge (the v1 at/by when the v1 stage won and is the newer change);
  * "sat" is dropped (the main app has no overlay); an entry left with only defaults is dropped (Ready = no entry).
The entries are sanitized exactly like js/stages.js cleanEntry (only non-default fields; asphalt/pavers whenever
stored, "na" included) and the file is serialized exactly like js/stages.js serializeDoc: 2-space JSON, trailing
newline, numeric job keys ascending, {"version": 2, "stages": {...}} plus the unknown top-level fields of
stages.json. tests/test_promote.py checks the output against the real js/stages.js in node.

Already promoted (stages.json is version 2): the dry run re-sanitizes stages.json as it is and ignores
stages-beta.json (the beta is retired, possibly sealed as version 3; stages.json is the source of truth); --write then
does NOTHING (never a normalization commit to the live file).

Promoted before, but stages.json is version 1 again (a stale R-1 page wrote it back): a second promotion would rebuild
the file from the old beta content and lose every item / Setup change made since, so the tool refuses (a sealed
stages-beta.json, or with gh the state repo's commit history, shows the promotion) and points to --repair.

Safety: this tool never reads, prints or stores a key or token (`gh` uses its own login); the summary lists job
numbers and stage keys only (no device labels). The dry run never writes to the state repo.
"""
from __future__ import annotations

import argparse, base64, hashlib, json, math, os, re, subprocess, sys, tempfile, time, urllib.error, urllib.request
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import sync_jobs as S  # noqa: E402  (parse_time = js cleanIso + Date.parse; clean_date = js cleanDate)

REPO = "Claude69420/eckstein-jobs-state"
V1_FILE, BETA_FILE = "stages.json", "stages-beta.json"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}/main/"
COMMIT_MESSAGE = "promote: merge stages-beta.json into stages.json (v2)"
ROLLBACK_MESSAGE = "rollback: stages.json back to v1 (R-1)"
REPAIR_MESSAGE = "repair: stages.json back to v2 (a page on the v1 app had rewritten it)"
HISTORY_LIMIT = 100   # commits of stages.json the promotion guard / --repair look at (newest first)
REGRESSED = ("stages.json is version 1, but it was already promoted to v2: a page still running the v1 app (R-1) wrote "
             "it back as v1. Promoting again would lose the items and Setup stages saved since. Close every Eckstein "
             "Jobs page / app that may still run the old version, then run: python tools/promote_stages.py --repair")
FILE_VERSION = 2
DEFAULT_OUT = Path(tempfile.gettempdir()) / "eckstein-promote" / "stages.promoted.json"


class PromoteError(Exception):
    """Anything that must stop the promotion (bad input, newer format, gh failure)."""


# ---------------------------------------------------------------------------------------------------------------
# JavaScript string semantics (js/stages.js runs in a browser; these mirror String.prototype.trim, \s, slice)
# ---------------------------------------------------------------------------------------------------------------
_JS_WS = "\t\n\x0b\x0c\r \xa0  -     　﻿"
_JS_TRIM_RE = re.compile(f"^[{_JS_WS}]+|[{_JS_WS}]+$")
_JS_WS_RUN_RE = re.compile(f"[{_JS_WS}]+")
_LABEL_BAD_RE = re.compile("[\u0000-\u001f\u007f-\u009f  ‎‏‪-‮⁦-⁩]+")
_JOB_KEY_RE = re.compile(r"[0-9A-Za-z-]{1,32}")


def js_trim(s: str) -> str:
    return _JS_TRIM_RE.sub("", s)


def js_slice(s: str, n: int) -> str:
    """s.slice(0, n) in UTF-16 code units (an astral character counts 2 and may be cut in half, like JS)."""
    b = s.encode("utf-16-le", "surrogatepass")
    return s if len(b) <= 2 * n else b[:2 * n].decode("utf-16-le", "surrogatepass")


def js_str(v) -> str:
    """str(v) in stages.js: a string stays, anything else is ''."""
    return v if isinstance(v, str) else ""


def clean_label(s: str) -> str:
    """js cleanLabel: one line, no control / bidi-override characters, whitespace collapsed, max 80 units."""
    s = _LABEL_BAD_RE.sub(" ", s)
    s = _JS_WS_RUN_RE.sub(" ", s)
    return js_slice(js_trim(s), 80)


def clean_job_key(k: str) -> str:
    """js cleanJobKey for an object key (always a string here)."""
    k = js_trim(k)
    return k if _JOB_KEY_RE.fullmatch(k) else ""


# ---------------------------------------------------------------------------------------------------------------
# js/stages.js model (entries): knownKey, cleanLane, cleanContent, cleanEntry, copyEntry, sanitizeDoc, ...
# ---------------------------------------------------------------------------------------------------------------
STAGE_KEYS = ["ready", "setup", "excavation", "base", "prep", "inspected", "poured"]
ITEM_VALUES = {"assess": ("no", "virtual", "onsite"), "lane": ("na", "req", "booked"), "cut": ("na", "req", "done"),
               "asphalt": ("na", "req", "done"), "pavers": ("na", "req", "done"), "cleanup": ("todo", "done")}
FIELDS = ["stage", "assess", "lane", "cut", "asphalt", "pavers", "cleanup", "removed"]
QFIELDS = FIELDS + ["sat"]
ITEM_FIELDS = FIELDS[1:]


def known_key(v) -> str | None:
    if not isinstance(v, str): return None
    if v in STAGE_KEYS: return v
    t = js_trim(v).lower()
    return t if t in STAGE_KEYS else None


def in_values(key: str, v) -> bool:
    return isinstance(v, str) and v in ITEM_VALUES[key]


def clean_iso(v) -> str | None:
    return v if isinstance(v, str) and len(v) <= 40 and S.parse_time(v) is not None else None


def iso_ms(v) -> int | None:
    """js isoMs; None plays JS NaN (never compares as newer)."""
    return S.parse_time(v) if clean_iso(v) else None


def clean_lane(l):
    if not isinstance(l, dict) or not in_values("lane", l.get("s")): return None
    o = {"s": l["s"]}
    if l["s"] == "booked":
        f = S.clean_date(l["from"]) if "from" in l else None
        t = S.clean_date(l["to"]) if "to" in l else None
        if f: o["from"] = f
        if t: o["to"] = t
    return o


def clean_content(v) -> dict:
    o = {}
    if isinstance(v, str):   # v1 shorthand "684": "prep"
        k = known_key(v)
        if k and k != "ready": o["stage"] = k
        return o
    if not isinstance(v, dict): return o
    if "stage" in v:
        k = known_key(v["stage"])
        if k and k != "ready": o["stage"] = k
    if "assess" in v and in_values("assess", v["assess"]) and v["assess"] != "no": o["assess"] = v["assess"]
    if "lane" in v:
        l = clean_lane(v["lane"])
        if l and l["s"] != "na": o["lane"] = l
    if "cut" in v and in_values("cut", v["cut"]) and v["cut"] != "na": o["cut"] = v["cut"]
    if "asphalt" in v and in_values("asphalt", v["asphalt"]): o["asphalt"] = v["asphalt"]   # stored "na" beats the hint
    if "pavers" in v and in_values("pavers", v["pavers"]): o["pavers"] = v["pavers"]
    if "cleanup" in v and v["cleanup"] == "done": o["cleanup"] = "done"
    if "removed" in v and v["removed"] is True: o["removed"] = True
    return o


def has_content(e) -> bool:
    return bool(e) and any(f in e for f in QFIELDS)


def copy_entry(e):
    if e is None: return None
    o = {}
    for f in QFIELDS:
        if f in e: o[f] = dict(e[f]) if f == "lane" else e[f]
    for f in ("at", "by"):
        if f in e: o[f] = e[f]
    return o


def clean_entry(v):
    o = clean_content(v)
    is_obj = isinstance(v, dict)
    if is_obj and "sat" in v and clean_iso(v["sat"]): o["sat"] = v["sat"]
    if not has_content(o): return None
    o["at"] = js_slice(clean_label(js_str(v["at"])), 40) if is_obj and "at" in v else ""
    o["by"] = js_slice(clean_label(js_str(v["by"])), 40) if is_obj and "by" in v else ""
    return copy_entry(o)


def _is_array_index(k: str) -> bool:
    return bool(re.fullmatch(r"0|[1-9][0-9]*", k)) and int(k) < 2 ** 32 - 1


def js_keys(d: dict) -> list:
    """Object.keys order: array-index keys ascending, then the other keys in insertion order."""
    keys = list(d)
    idx = sorted((k for k in keys if _is_array_index(k)), key=int)
    return idx + [k for k in keys if not _is_array_index(k)]


def js_dict(pairs) -> dict:
    """A dict whose iteration order is the one a JS object built from these pairs would have."""
    d = dict(pairs)
    return {k: d[k] for k in js_keys(d)}


def _job_keys(st: dict) -> tuple[dict, list]:
    """sanitizeDoc / sanitizeOverlay key rule: exact key wins, else the last variant. -> ({jn: raw}, dropped)."""
    raw, exact, dropped = {}, set(), []
    for k in js_keys(st):
        jn = clean_job_key(k)
        if not jn:
            dropped.append((k, "not a usable job key")); continue
        if jn != k and jn in exact:
            dropped.append((k, f"duplicate of job {jn}")); continue
        if jn in raw: dropped.append((jn, "duplicate key variant (the later one wins)"))
        raw[jn] = st[k]
        if jn == k: exact.add(jn)
    return js_dict(raw.items()), dropped


DEFAULTS = {"stage": "ready", "assess": "no", "cut": "na", "cleanup": "todo", "removed": False}


def field_drops(v) -> list[str]:
    """Why cleanEntry leaves out parts of one raw entry (field names only, never values of at / by)."""
    if not isinstance(v, dict): return []
    c, out = clean_content(v), []
    for f in QFIELDS:
        if f not in v: continue
        if f == "sat":
            if not clean_iso(v["sat"]): out.append("sat: not a time")
            continue
        if f in c:
            if f == "lane" and isinstance(v["lane"], dict):
                lost = [d for d in ("from", "to") if d in v["lane"] and d not in c["lane"]]
                if lost: out.append("lane " + "/".join(lost) + ": " + ("not a real date" if v["lane"]["s"] == "booked"
                                                                      else "dates only count when booked"))
            continue
        val = v[f]
        is_def = ((f == "stage" and known_key(val) == "ready") or (f == "removed" and val is False)
                  or (f == "lane" and isinstance(val, dict) and val.get("s") == "na")
                  or (f in ("assess", "cut", "cleanup") and val == DEFAULTS[f]))
        out.append(f"{f}: default dropped" if is_def else f"{f}: unknown value dropped")
    extra = sorted(k for k in v if k not in QFIELDS and k not in ("at", "by"))
    if extra: out.append("unknown fields ignored: " + ", ".join(extra))
    return out


def _version(obj) -> float:
    v = obj.get("version") if isinstance(obj, dict) else None
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 1


def sanitize_doc(obj) -> tuple[dict, dict, float, list]:
    """js sanitizeDoc -> (map, extras, version, dropped[(key, reason)])."""
    m, extras, dropped = {}, {}, []
    if isinstance(obj, dict):
        for k in js_keys(obj):
            if k not in ("version", "stages", "__proto__"): extras[k] = obj[k]
        st = obj.get("stages")
        if isinstance(st, dict):
            raw, dropped = _job_keys(st)
            for jn, v in raw.items():
                e = clean_entry(v)
                if e: m[jn] = e
                else: dropped.append((jn, "holds nothing but defaults / unknown values"))
    return js_dict(m.items()), extras, _version(obj), dropped


def sanitize_overlay(obj) -> tuple[dict, list]:
    """js sanitizeOverlay -> ({jn: {stage, at, by}}, dropped)."""
    m, dropped = {}, []
    if isinstance(obj, dict) and isinstance(obj.get("stages"), dict):
        raw, dropped = _job_keys(obj["stages"])
        for jn, v in raw.items():
            is_obj = isinstance(v, dict)
            k = known_key(v if isinstance(v, str) else (v.get("stage") if is_obj and "stage" in v else None))
            if not k:
                dropped.append((jn, "no known stage (ignored, like the beta app)")); continue
            m[jn] = {"stage": k, "at": v["at"] if is_obj and clean_iso(v.get("at")) else "",
                     "by": js_slice(clean_label(js_str(v["by"])), 40) if is_obj and "by" in v else ""}
    return js_dict(m.items()), dropped


def overlay_wins(e, ov) -> bool:
    if not ov or not known_key(ov.get("stage")): return False
    if not e or "sat" not in e or not clean_iso(e["sat"]): return True
    oa, sat = iso_ms(ov.get("at")), iso_ms(e["sat"])
    return oa is not None and sat is not None and oa > sat


def merge_entry(e, ov):
    """js mergeEntry: the state entry with the stage from the overlay when overlay_wins; at/by then come from the
    overlay when it is the newer change. None when nothing is left."""
    if not overlay_wins(e, ov): return copy_entry(e) if e else None
    o = copy_entry(e) or {}
    if ov["stage"] == "ready": o.pop("stage", None)
    else: o["stage"] = ov["stage"]
    ea, oa = iso_ms(e.get("at") if e else None), iso_ms(ov.get("at"))
    if not e or (oa is not None and ea is not None and oa > ea) or (ea is None and oa is not None):
        o["at"], o["by"] = ov["at"], ov["by"]
    return copy_entry(o) if has_content(o) else None


def merge_overlay(state: dict, ov: dict) -> dict:
    o = {k: copy_entry(v) for k, v in state.items()}
    for jn in js_keys(ov):
        m = merge_entry(o.get(jn), ov[jn])
        if m: o[jn] = m
        else: o.pop(jn, None)
    return js_dict(o.items())


# ---------------------------------------------------------------------------------------------------------------
# JSON text: JSON.parse / JSON.stringify(doc, null, 2) semantics
# ---------------------------------------------------------------------------------------------------------------
def _no_constant(name):
    raise ValueError(f"{name} is not JSON")


def parse_json(text: str):
    """JSON.parse after stripping one BOM; None when JS would throw (NaN / Infinity are not JSON)."""
    t = text[1:] if text.startswith("﻿") else text
    try:
        return json.loads(t, parse_constant=_no_constant)
    except (ValueError, RecursionError):
        return None


def is_damaged(text: str) -> bool:
    """js isDamaged: non-empty text that is not {"stages": {...}}."""
    t = js_trim(text[1:] if text.startswith("﻿") else text)
    if not t: return False
    j = parse_json(t)
    return not isinstance(j, dict) or not isinstance(j.get("stages"), dict)


def js_number(x) -> str:
    """Number.prototype.toString (what JSON.stringify writes)."""
    if isinstance(x, bool): return "true" if x else "false"
    if isinstance(x, int) and abs(x) <= 2 ** 53: return str(x)
    x = float(x)
    if not math.isfinite(x): return "null"
    if x == 0: return "0"
    sign = "-" if x < 0 else ""
    t = Decimal(repr(abs(x))).normalize().as_tuple()
    digits = "".join(map(str, t.digits))
    k, n = len(digits), t.exponent + len(digits)
    if k <= n <= 21: s = digits + "0" * (n - k)
    elif 0 < n <= 21: s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0: s = "0." + "0" * -n + digits
    else:
        e = n - 1
        s = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + s


_ESC = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def js_string(s: str) -> str:
    out = []
    for c in s:
        o = ord(c)
        if c in _ESC: out.append(_ESC[c])
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF: out.append("\\u%04x" % o)   # lone surrogates, like JS
        else: out.append(c)
    return '"' + "".join(out) + '"'


def js_stringify(v, indent: str = "") -> str:
    if v is None: return "null"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int, float)): return js_number(v)
    if isinstance(v, str): return js_string(v)
    inner = indent + "  "
    if isinstance(v, list):
        if not v: return "[]"
        return "[\n" + ",\n".join(inner + js_stringify(x, inner) for x in v) + "\n" + indent + "]"
    if isinstance(v, dict):
        if not v: return "{}"
        return "{\n" + ",\n".join(inner + js_string(k) + ": " + js_stringify(v[k], inner) for k in js_keys(v)) \
            + "\n" + indent + "}"
    raise TypeError(type(v).__name__)


def serialize_doc(m: dict, extras: dict | None) -> str:
    """js serializeDoc: {"version": 2, "stages": {...}} + extras, 2-space JSON, trailing newline."""
    doc = {"version": FILE_VERSION, "stages": {jn: copy_entry(m[jn]) for jn in m}}
    for k in (extras or {}):
        if k not in doc: doc[k] = extras[k]
    return js_stringify(doc) + "\n"


# ---------------------------------------------------------------------------------------------------------------
# promotion
# ---------------------------------------------------------------------------------------------------------------
def _load(text: str | None, name: str, missing_ok: bool):
    if text is None:
        if missing_ok: return None
        raise PromoteError(f"{name} was not found")
    if is_damaged(text): raise PromoteError(f"{name} is damaged (not valid stage JSON); fix it first")
    obj = parse_json(text)
    if obj is None:   # empty (or whitespace) text
        if missing_ok: return None
        raise PromoteError(f"{name} is empty")
    if _version(obj) > FILE_VERSION:
        raise PromoteError(f"{name} is version {_version(obj)}, newer than this tool understands ({FILE_VERSION})")
    return obj


def promote(v1_text: str | None, beta_text: str | None) -> dict:
    """-> {"text": proposed stages.json, "report": {...}}. Raises PromoteError on unusable input."""
    v1 = _load(v1_text, V1_FILE, missing_ok=False)
    # Already promoted: the retired beta file is never read (a sealed one is version 3). A sealed beta next to a v1
    # stages.json means the promotion happened and a v1 page wrote the file back: that needs --repair.
    if _version(v1) >= FILE_VERSION: beta = None
    else:
        b = parse_json(beta_text) if beta_text is not None else None
        if isinstance(b, dict) and _version(b) == RETIRED_VERSION and "retired" in b: raise PromoteError(REGRESSED)
        beta = _load(beta_text, BETA_FILE, missing_ok=True)
    v1_raw = v1.get("stages") or {}
    beta_raw = (beta or {}).get("stages") or {} if isinstance(beta, dict) else {}
    rep = {"v1_version": _version(v1), "v1_entries": len(v1_raw), "beta_entries": len(beta_raw),
           "already_v2": _version(v1) >= FILE_VERSION, "dropped": [], "stage_from": {}, "conflicts": [],
           "sat_dropped": 0, "beta_extras_ignored": [], "beta_only": []}
    _, v1_extras, _, _ = sanitize_doc(v1)

    if rep["already_v2"]:
        # Already promoted: stages.json is the source of truth; the retired beta file is ignored.
        state, _, _, dropped = sanitize_doc(v1)
        rep["dropped"] += [(V1_FILE, k, r) for k, r in dropped]
        for jn, v in _job_keys(v1_raw)[0].items():
            for r in field_drops(v): rep["dropped"].append((V1_FILE, jn, r))
        merged = state
        rep["v1_usable"], rep["beta_usable"] = len(state), 0
        rep["stage_from"] = {jn: "stages.json" for jn in state if "stage" in state[jn]}
    else:
        state, beta_extras, _, bdropped = sanitize_doc(beta) if beta is not None else ({}, {}, 1, [])
        ov, odropped = sanitize_overlay(v1)
        rep["dropped"] += [(BETA_FILE, k, r) for k, r in bdropped] + [(V1_FILE, k, r) for k, r in odropped]
        rep["beta_extras_ignored"] = list(beta_extras)
        rep["v1_usable"], rep["beta_usable"] = len(ov), len(state)
        for jn, v in v1_raw.items():   # v1 files never held items; anything else in them is ignored
            if isinstance(v, dict):
                extra = sorted(k for k in v if k not in ("stage", "at", "by"))
                if extra: rep["dropped"].append((V1_FILE, clean_job_key(jn) or jn, "ignored fields: " + ", ".join(extra)))
        for jn, v in _job_keys(beta_raw)[0].items():
            for r in field_drops(v): rep["dropped"].append((BETA_FILE, jn, r))
        merged = merge_overlay(state, ov)
        for jn in js_keys({**state, **ov}):
            e, o = state.get(jn), ov.get(jn)
            win = overlay_wins(e, o)
            rep["stage_from"][jn] = "v1" if win else ("beta" if e and ("stage" in e or "sat" in e) else "none")
            b_stage = (e or {}).get("stage", "ready") if e and ("stage" in e or "sat" in e) else None
            if o and b_stage is not None and o["stage"] != b_stage:
                rep["conflicts"].append((jn, o["stage"], b_stage, "v1" if win else "beta"))
            # v1 records a move back to Ready by DELETING the entry (no tombstone): a beta stage on a job v1 has no
            # entry for may override a crew "back to Ready" made after it. Listed by number so Riley can check them.
            if not o and not win and e and e.get("stage", "ready") != "ready":
                rep["beta_only"].append(jn)
            if jn not in merged:
                rep["dropped"].append(("merge", jn, "effective stage is Ready and no items: no entry needed"))

    out = {}
    for jn, e in merged.items():
        if "sat" in e:
            rep["sat_dropped"] += 1
            e = {k: v for k, v in e.items() if k != "sat"}
        # a 40-unit cut can leave a trailing space that cleanLabel would trim on the next read: store the fixed point
        e = {**e, "at": js_slice(clean_label(e.get("at", "")), 40), "by": js_slice(clean_label(e.get("by", "")), 40)}
        if has_content(e): out[jn] = copy_entry(e)
        else: rep["dropped"].append(("merge", jn, "only a stage time (sat) was left: Ready, no entry needed"))
    out = js_dict(out.items())
    text = serialize_doc(out, v1_extras)

    # self-check: the file reads back (like js parseDocText) to exactly this map
    back, _, ver, _ = sanitize_doc(parse_json(text))
    if ver != FILE_VERSION or back != out or serialize_doc(back, v1_extras) != text:
        raise PromoteError("internal check failed: the proposed file does not read back identically")

    rep["merged_entries"] = len(out)
    rep["stages"] = {jn: out[jn].get("stage", "ready") for jn in out}
    rep["items"] = {f: sorted((jn for jn in out if f in out[jn]), key=_sort_key) for f in ITEM_FIELDS}
    rep["unchanged"] = (v1_text or "").lstrip("﻿") == text
    return {"text": text, "report": rep, "map": out}


def _sort_key(jn: str):
    return (0, int(jn), "") if jn.isdigit() else (1, 0, jn)


def summary_lines(rep: dict, source: str) -> list[str]:
    """Human summary: job numbers, stage keys and field names only (never device labels / at / by)."""
    L = [f"source: {source}",
         f"stages.json:      {rep['v1_entries']} entries (version {rep['v1_version']}), {rep['v1_usable']} usable",
         f"stages-beta.json: {rep['beta_entries']} entries, {rep['beta_usable']} usable"]
    if rep["already_v2"]:
        L.append("stages.json is ALREADY version 2 (promoted): re-sanitized as is, stages-beta.json ignored")
    L.append(f"merged stages.json v2: {rep['merged_entries']} entries")
    from_counts = {}
    for jn, src in rep["stage_from"].items():
        if src != "none": from_counts[src] = from_counts.get(src, 0) + 1
    L.append("stage source: " + (", ".join(f"{k} {v}" for k, v in sorted(from_counts.items())) or "none"))
    by_stage = {}
    for jn, st in rep["stages"].items(): by_stage.setdefault(st, []).append(jn)
    for st in STAGE_KEYS:
        if st in by_stage:
            L.append(f"  {st:<11} {len(by_stage[st]):>3}: " + " ".join(sorted(by_stage[st], key=_sort_key)))
    for jn, v1s, bs, win in sorted(rep["conflicts"], key=lambda c: _sort_key(c[0])):
        L.append(f"  conflict job {jn}: v1 {v1s} vs beta {bs} -> {win} wins")
    if rep.get("beta_only"):
        L.append(f"beta-only stages (v1 has no usable entry, e.g. the crew moved it back to Ready; check these): "
                 f"{len(rep['beta_only'])}: " + " ".join(sorted(rep["beta_only"], key=_sort_key)))
    items = {f: jns for f, jns in rep["items"].items() if jns}
    L.append(f"items carried from the beta: {sum(len(j) for j in items.values())} field(s)"
             + ("" if items else " (none)"))
    for f, jns in items.items(): L.append(f"  {f:<8} {len(jns):>3}: " + " ".join(jns))
    L.append(f"sat dropped: {rep['sat_dropped']}")
    if rep["beta_extras_ignored"]:
        L.append("stages-beta.json top-level fields ignored: " + ", ".join(map(str, rep["beta_extras_ignored"])))
    if rep["dropped"]:
        L.append(f"dropped / ignored: {len(rep['dropped'])}")
        for f, k, r in rep["dropped"]: L.append(f"  {f} job {ascii(k)}: {r}")
    else:
        L.append("dropped / ignored: none")
    L.append("result: " + ("IDENTICAL to the current stages.json (nothing to write)" if rep["unchanged"]
                           else "differs from the current stages.json"))
    return L


R1_KEYS = ("excavation", "base", "prep", "inspected", "poured")   # R-1 (v1) stages besides Ready; no "setup"
RETIRED_VERSION = 3   # --seal-beta: a retired stages-beta.json is marked newer than any beta app (its saves stop)


def rollback(v2_text: str | None, beta_text: str | None = None) -> dict:
    """Down-convert the CURRENT v2 stages.json for a rollback to R-1 + the beta (APP_MASTER sec. 7.17 rollback):
      * stages.json      -> v1: {stage, at, by} for the R-1 stage keys only ("setup" has no R-1 stage: those jobs
                           show as Ready in R-1 and are listed in the report; items are not part of v1);
      * stages-beta.json -> v2: every entry of the v2 file (stage + items) with "sat" = at for entries that have a stage,
                           so a reverted beta shows exactly what the main app showed (the v1 overlay is never newer).
    The current stages-beta.json content is ignored (retired, possibly sealed); only its sha matters for the PUT.
    -> {"v1_text", "beta_text", "report"}. Raises PromoteError on unusable input."""
    v2 = _load(v2_text, V1_FILE, missing_ok=False)
    if _version(v2) < FILE_VERSION:
        raise PromoteError(f"stages.json is version {_version(v2)} (not promoted): nothing to roll back")
    state, extras, _, dropped = sanitize_doc(v2)
    v1, beta, setup, items = {}, {}, [], 0
    for jn, e in state.items():
        st = e.get("stage", "ready")
        at = js_slice(clean_label(e.get("at", "")), 40)
        by = js_slice(clean_label(e.get("by", "")), 40)
        if st in R1_KEYS: v1[jn] = {"stage": st, "at": at, "by": by}
        elif st == "setup": setup.append(jn)
        b = {k: (dict(v) if k == "lane" else v) for k, v in e.items() if k in FIELDS}
        if "stage" in b and clean_iso(at): b["sat"] = at
        b["at"], b["by"] = at, by
        if any(f in e for f in ITEM_FIELDS): items += 1
        beta[jn] = copy_entry(b)
    v1_doc = {"version": 1, "stages": js_dict(v1.items())}
    for k in extras:
        if k not in v1_doc: v1_doc[k] = extras[k]
    v1_out = js_stringify(v1_doc) + "\n"
    beta_out = serialize_doc(js_dict(beta.items()), None)
    # self-checks: R-1 reads the stages back; the beta reads every entry back unchanged
    ov, _ = sanitize_overlay(parse_json(v1_out))
    if {jn: o["stage"] for jn, o in ov.items()} != {jn: v["stage"] for jn, v in v1.items()}:
        raise PromoteError("internal check failed: the v1 file does not read back identically")
    back, _, ver, _ = sanitize_doc(parse_json(beta_out))
    if ver != FILE_VERSION or back != js_dict(beta.items()):
        raise PromoteError("internal check failed: the beta file does not read back identically")
    rep = {"v2_entries": len(state), "v1_entries": len(v1), "beta_entries": len(beta), "setup_to_ready":
           sorted(setup, key=_sort_key), "items_entries": items, "dropped": [(V1_FILE, k, r) for k, r in dropped],
           "beta_was": "missing" if beta_text is None else "present"}
    return {"v1_text": v1_out, "beta_text": beta_out, "report": rep}


def rollback_lines(rep: dict, source: str) -> list[str]:
    """Human summary of a rollback: counts and job numbers only."""
    L = [f"source: {source}",
         f"ROLLBACK of stages.json v2 ({rep['v2_entries']} entries):",
         f"  -> stages.json v1:        {rep['v1_entries']} R-1 stage entries",
         f"  -> stages-beta.json v2:   {rep['beta_entries']} entries ({rep['items_entries']} with items), "
         f"replacing the current file ({rep['beta_was']})"]
    if rep["setup_to_ready"]:
        L.append(f"  Setup has no R-1 stage, these show as Ready in R-1 (the beta keeps Setup): "
                 f"{len(rep['setup_to_ready'])}: " + " ".join(rep["setup_to_ready"]))
    if rep["dropped"]:
        L.append(f"dropped / ignored: {len(rep['dropped'])}")
        for f, k, r in rep["dropped"]: L.append(f"  {f} job {ascii(k)}: {r}")
    return L


def repair(cur_text: str | None, base_text: str | None) -> dict:
    """Undo a stale R-1 page's rewrite of the promoted file (APP_MASTER sec. 7.17 "stale v1 page").
    A page still running the v1 app reads stages.json, keeps only {stage, at, by} for its own stage keys (no "setup",
    no items, no item-only entries) and PUTs it back as version 1 plus its own move(s). The R-2 app holds every save
    while the file is v1 (code "format"), so nothing else writes it meanwhile. The rebuilt v2 file is:
      * base    = the newest version 2 stages.json in the state repo's history (the file the v1 page read);
      * overlay = the current v1 file, merged exactly like the beta merged stages.json (mergeOverlay) with "sat" = the
                  base entry's at: an R-1 move made after the base entry's own change wins (stage, at, by); an older
                  queued R-1 move does not; equal = the base (items, Setup) stays;
      * a job the base holds at an R-1 stage that the v1 file no longer has was moved back to Ready on that page (R-1
        writes back every R-1-stage entry it read): its stage goes, its items stay. Listed by number to check.
    Entries R-1 cannot see (Setup, items only) come back from the base. Top-level fields: the current file's.
    -> {"text", "report", "map"}. Raises PromoteError on unusable input."""
    cur = _load(cur_text, V1_FILE, missing_ok=False)
    if _version(cur) >= FILE_VERSION:
        raise PromoteError(f"stages.json is version {_version(cur)}: it was not rewritten by a v1 page, nothing to repair")
    base = _load(base_text, "the last v2 stages.json", missing_ok=False)
    if _version(base) != FILE_VERSION: raise PromoteError("the repair base is not a version 2 stages.json")
    state, _, _, bdropped = sanitize_doc(base)
    ov, odropped = sanitize_overlay(cur)
    _, cur_extras, _, _ = sanitize_doc(cur)
    st = {}
    for jn, e in state.items():
        b = copy_entry(e)
        if "stage" in b and clean_iso(b.get("at")): b["sat"] = b["at"]
        st[jn] = b
    st = js_dict(st.items())
    merged = merge_overlay(st, ov)
    r1_moves = sorted((jn for jn in ov if overlay_wins(st.get(jn), ov[jn])
                       and ov[jn]["stage"] != (state.get(jn) or {}).get("stage", "ready")), key=_sort_key)
    r1_ready = sorted((jn for jn, e in state.items() if e.get("stage") in R1_KEYS and jn not in ov), key=_sort_key)
    for jn in r1_ready:
        e = {k: v for k, v in (merged.get(jn) or {}).items() if k not in ("stage", "sat")}
        if has_content(e): merged[jn] = copy_entry(e)
        else: merged.pop(jn, None)
    out = {}
    for jn, e in merged.items():
        e = {k: v for k, v in e.items() if k != "sat"}
        e = {**e, "at": js_slice(clean_label(e.get("at", "")), 40), "by": js_slice(clean_label(e.get("by", "")), 40)}
        if has_content(e): out[jn] = copy_entry(e)
    out = js_dict(out.items())
    text = serialize_doc(out, cur_extras)
    back, _, ver, _ = sanitize_doc(parse_json(text))
    if ver != FILE_VERSION or back != out or serialize_doc(back, cur_extras) != text:
        raise PromoteError("internal check failed: the repaired file does not read back identically")
    restored = sorted((jn for jn in out if jn not in ov and jn not in r1_ready), key=_sort_key)
    rep = {"base_entries": len(state), "v1_entries": len(ov), "merged_entries": len(out), "r1_moves": r1_moves,
           "r1_ready": r1_ready, "restored": restored,
           "items_entries": sum(1 for e in out.values() if any(f in e for f in ITEM_FIELDS)),
           "same_as_base": out == state,
           "dropped": [("base", k, r) for k, r in bdropped] + [(V1_FILE, k, r) for k, r in odropped]}
    return {"text": text, "report": rep, "map": out}


def repair_lines(rep: dict, source: str, base: str) -> list[str]:
    """Human summary of a repair: counts and job numbers only (never device labels / at / by)."""
    L = [f"source: {source}",
         f"REPAIR: stages.json is version 1 again ({rep['v1_entries']} usable R-1 entries); "
         f"base = {base} ({rep['base_entries']} entries)",
         f"repaired stages.json v2: {rep['merged_entries']} entries ({rep['items_entries']} with items)",
         f"  R-1 moves kept (newer than the base): {len(rep['r1_moves'])}" +
         (": " + " ".join(rep["r1_moves"]) if rep["r1_moves"] else ""),
         f"  entries the v1 rewrite had dropped, restored from the base (Setup / items): {len(rep['restored'])}" +
         (": " + " ".join(rep["restored"]) if rep["restored"] else "")]
    if rep["r1_ready"]:
        L.append(f"  moved back to Ready on the v1 page (stage removed, items kept; check these): "
                 f"{len(rep['r1_ready'])}: " + " ".join(rep["r1_ready"]))
    if rep["same_as_base"]: L.append("  result = the base exactly (the v1 page made no move of its own)")
    if rep["dropped"]:
        L.append(f"dropped / ignored: {len(rep['dropped'])}")
        for f, k, r in rep["dropped"]: L.append(f"  {f} job {ascii(k)}: {r}")
    return L


def seal_text(beta_text: str) -> str | None:
    """--seal-beta: the retired stages-beta.json with "version": RETIRED_VERSION (content kept as a backup), so any
    beta app still running refuses to save to it ("close and reopen the app") and lands on the retired notice.
    None when the file cannot be sealed (damaged / not an object)."""
    obj = parse_json(beta_text)
    if not isinstance(obj, dict) or not isinstance(obj.get("stages"), dict): return None
    out = {"version": RETIRED_VERSION,
           "retired": "R-2 was promoted: stages.json is the only stage file. Kept as a backup; nothing reads it."}
    for k in js_keys(obj):
        if k not in out: out[k] = obj[k]
    return js_stringify(out) + "\n"


def proposal_hash(*texts: str) -> str:
    """sha256 of the proposed file text(s): the dry run prints it, --write --expect compares it."""
    h = hashlib.sha256()
    for i, t in enumerate(texts):
        if i: h.update(b"\0")
        h.update(t.encode("utf-8"))
    return h.hexdigest()


# ---------------------------------------------------------------------------------------------------------------
# I/O: public raw files, local files, gh api (write)
# ---------------------------------------------------------------------------------------------------------------
def fetch_raw(name: str, missing_ok: bool) -> str | None:
    url = f"{RAW_BASE}{name}?t={int(time.time())}"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404 and missing_ok: return None
        raise PromoteError(f"could not read {name} (HTTP {e.code})")
    except Exception as e:
        raise PromoteError(f"could not read {name} ({type(e).__name__})")


def _gh(args: list[str], input_file: str | None = None) -> subprocess.CompletedProcess:
    cmd = ["gh", "api"] + args + (["--input", input_file] if input_file else [])
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    except FileNotFoundError:
        raise PromoteError("the GitHub CLI (gh) is not installed or not on PATH")
    except subprocess.TimeoutExpired:
        raise PromoteError("gh api timed out")


def _gh_err(p: subprocess.CompletedProcess) -> str:
    lines = [l.strip() for l in (p.stderr or "").splitlines() if l.strip()]
    return lines[-1][:200] if lines else f"exit code {p.returncode}"


def gh_get(name: str, missing_ok: bool, ref: str = "main") -> tuple[str | None, str | None]:
    """(text, sha) of a file in the state repo through the contents API (fresh, not the CDN); ref = branch or commit."""
    p = _gh([f"repos/{REPO}/contents/{name}?ref={ref}"])
    if p.returncode != 0:
        if "HTTP 404" in (p.stderr or "") and missing_ok: return None, None
        raise PromoteError(f"could not read {name} through gh api: {_gh_err(p)}")
    try:
        j = json.loads(p.stdout)
        if j.get("encoding") != "base64" or not isinstance(j.get("sha"), str):
            raise ValueError("unexpected contents response")
        return base64.b64decode(j.get("content") or "").decode("utf-8"), j["sha"]
    except Exception as e:
        raise PromoteError(f"could not read {name} through gh api ({type(e).__name__})")


def gh_history(name: str = V1_FILE) -> list[tuple[str, str]]:
    """[(commit sha, first line of the message)] of the commits that changed `name`, newest first (read only).
    The messages are only matched against this tool's own prefixes, never printed (R-1's hold job labels)."""
    p = _gh([f"repos/{REPO}/commits?path={name}&sha=main&per_page={HISTORY_LIMIT}"])
    if p.returncode != 0: raise PromoteError(f"could not read the history of {name} through gh api: {_gh_err(p)}")
    try:
        out = []
        for c in json.loads(p.stdout):
            msg = c["commit"]["message"]
            out.append((str(c["sha"]), (msg if isinstance(msg, str) else "").split("\n", 1)[0].strip()))
        return out
    except Exception as e:
        raise PromoteError(f"could not read the history of {name} through gh api ({type(e).__name__})")


def promoted_before(history: list[tuple[str, str]]) -> str | None:
    """Short sha of the promote / repair commit still in force (no rollback commit after it), or None."""
    for sha, msg in history:
        if msg == ROLLBACK_MESSAGE: return None
        if msg in (COMMIT_MESSAGE, REPAIR_MESSAGE): return sha[:12]
    return None


def find_last_v2(history: list[tuple[str, str]]) -> tuple[str, str]:
    """(text, short sha) of the newest version 2 stages.json in the history (the file the v1 page read)."""
    for sha, msg in history:
        if msg == ROLLBACK_MESSAGE:
            raise PromoteError(f"stages.json was rolled back to v1 on purpose (commit {sha[:12]}): nothing to repair")
        text, _ = gh_get(V1_FILE, missing_ok=True, ref=sha)
        if text is None or is_damaged(text): continue
        obj = parse_json(text)
        if isinstance(obj, dict) and _version(obj) == FILE_VERSION: return text, sha[:12]
    raise PromoteError(f"no version 2 stages.json in the last {HISTORY_LIMIT} commits of stages.json: nothing to "
                       "repair from (never promoted?)")


def gh_put(text: str, sha: str | None, name: str = V1_FILE, message: str = COMMIT_MESSAGE) -> str:
    """PUT one file of the state repo, guarded by its blob sha (None = the file must not exist yet)."""
    payload = {"message": message, "content": base64.b64encode(text.encode("utf-8")).decode("ascii"), "branch": "main"}
    if sha: payload["sha"] = sha
    fd, tmp = tempfile.mkstemp(prefix="promote-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f: json.dump(payload, f)
        p = _gh(["-X", "PUT", f"repos/{REPO}/contents/{name}"], input_file=tmp)
    finally:
        try: os.remove(tmp)
        except OSError: pass
    if p.returncode != 0:
        err = p.stderr or ""
        if "HTTP 409" in err or "HTTP 422" in err:
            raise PromoteError(f"{name} changed while this tool ran (conflict): {name} was NOT written. Re-run the tool.")
        raise PromoteError(f"the PUT of {name} failed, it was NOT written: {_gh_err(p)}")
    try: return json.loads(p.stdout)["commit"]["sha"]
    except Exception: return "(commit sha not reported)"


def _check_expect(expect: str | None, actual: str) -> None:
    if not expect: return
    e = expect.strip().lower()
    if len(e) < 12 or not re.fullmatch(r"[0-9a-f]+", e):
        raise PromoteError("--expect needs at least the first 12 hex characters of the proposal sha256")
    if not actual.startswith(e):
        raise PromoteError(f"the fresh proposal (sha256 {actual[:12]}) is NOT the reviewed one ({e[:12]}): something "
                           "changed since the dry run. Nothing was written; run the dry run again and review it.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Merge stages-beta.json into stages.json as one v2 file (R-2 promotion).")
    ap.add_argument("--v1", help="local stages.json (instead of the public raw file)")
    ap.add_argument("--beta", help="local stages-beta.json (instead of the public raw file; missing file = empty)")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help=f"proposed file (default {DEFAULT_OUT})")
    ap.add_argument("--api", action="store_true",
                    help="dry run: read both files fresh through `gh api` (read only) instead of the raw CDN")
    ap.add_argument("--expect", help="--write: abort unless the fresh proposal's sha256 starts with this (from the dry run)")
    ap.add_argument("--seal-beta", action="store_true",
                    help="--write: afterwards mark stages-beta.json retired (version 3, content kept) so a beta app "
                         "still running cannot save to it; the PUT is guarded by the sha read before the promotion")
    ap.add_argument("--rollback", action="store_true",
                    help="down-convert the CURRENT v2 stages.json: v1 stages.json + v2 stages-beta.json (see rollback())")
    ap.add_argument("--repair", action="store_true",
                    help="stages.json was promoted, then a page on the v1 app wrote it back as v1: rebuild v2 from the "
                         "newest v2 version in its history + the v1 moves since (see repair()); --write needs --expect")
    ap.add_argument("--last-v2", help="--repair dry run on local files: the last v2 stages.json (with --v1 = the current)")
    ap.add_argument("--check", action="store_true",
                    help="after the promotion: exit 0 when the public stages.json is version 2, else 4 (see --repair)")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="default: summary + proposed file, no write")
    mode.add_argument("--write", action="store_true", help="PUT the result with gh api")
    a = ap.parse_args(argv)
    try: sys.stdout.reconfigure(errors="backslashreplace")   # odd keys in a hand-edited file never crash a print
    except Exception: pass
    try:
        if a.expect and not a.write: raise PromoteError("--expect only goes with --write")
        if a.seal_beta and (not a.write or a.rollback or a.repair):
            raise PromoteError("--seal-beta only goes with a promotion --write")
        if sum(map(bool, (a.rollback, a.repair, a.check))) > 1:
            raise PromoteError("--rollback, --repair and --check are separate modes")
        if a.last_v2 and not a.repair: raise PromoteError("--last-v2 only goes with --repair")
        if a.check:
            if a.write or a.beta: raise PromoteError("--check only reads stages.json")
            if a.v1: text = Path(a.v1).read_text(encoding="utf-8")
            elif a.api: text, _ = gh_get(V1_FILE, missing_ok=False)
            else: text = fetch_raw(V1_FILE, missing_ok=False)
            if is_damaged(text): raise PromoteError("stages.json is damaged (not valid stage JSON)")
            obj = parse_json(text)
            ver = _version(obj) if isinstance(obj, dict) else 1
            n = len((obj or {}).get("stages") or {}) if isinstance(obj, dict) else 0
            if ver == FILE_VERSION:
                print(f"OK: stages.json is version {ver} ({n} entries)")
                return 0
            print(f"stages.json is version {ver} ({n} entries), NOT version {FILE_VERSION}. Before the promotion that is "
                  "normal. AFTER it, a page still running the v1 app wrote it back: close every Eckstein Jobs page / "
                  "app that may still run the old version, then: python tools/promote_stages.py --repair")
            return 4
        if a.repair:
            if a.write and not a.expect:
                raise PromoteError("--repair --write needs --expect (the dry run's proposal sha256)")
            if a.v1 or a.last_v2:
                if not (a.v1 and a.last_v2): raise PromoteError("--repair on local files needs both --v1 and --last-v2")
                if a.write or a.api or a.beta: raise PromoteError("--repair on local files is a dry run only")
                cur_text, cur_sha = Path(a.v1).read_text(encoding="utf-8"), None
                base_text, base = Path(a.last_v2).read_text(encoding="utf-8"), "local file"
                source = "local files"
            else:
                if a.beta: raise PromoteError("--repair never reads stages-beta.json")
                cur_text, cur_sha = gh_get(V1_FILE, missing_ok=False)
                cur = parse_json(cur_text)
                if isinstance(cur, dict) and _version(cur) >= FILE_VERSION:
                    print(f"stages.json is version {_version(cur)}: nothing to repair (nothing was written)")
                    return 0
                base_text, short = find_last_v2(gh_history())
                base, source = f"stages.json at commit {short}", "gh api (contents + commits API, fresh)"
            res = repair(cur_text, base_text)
            digest = proposal_hash(res["text"])
            print("\n".join(repair_lines(res["report"], source, base)))
            print(f"proposal sha256: {digest}")
            if not a.write:
                out = Path(a.out).with_name("stages.repaired.json")
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(res["text"], encoding="utf-8", newline="\n")
                print(f"proposed stages.json written to {out} (DRY RUN: nothing was sent to GitHub)")
                return 0
            _check_expect(a.expect, digest)
            commit = gh_put(res["text"], cur_sha, V1_FILE, REPAIR_MESSAGE)
            print(f"WROTE stages.json v2 ({res['report']['merged_entries']} entries), commit {commit}. Check again in "
                  "about 10 minutes: python tools/promote_stages.py --check")
            return 0
        v1_sha = beta_sha = None
        if a.write or a.api:
            if a.v1 or a.beta:
                raise PromoteError("--write / --api read both files from the state repo itself; drop --v1 / --beta")
            v1_text, v1_sha = gh_get(V1_FILE, missing_ok=False)
            beta_text, beta_sha = gh_get(BETA_FILE, missing_ok=True)
            source = "gh api (contents API, fresh)"
        else:
            if a.v1: v1_text = Path(a.v1).read_text(encoding="utf-8")
            else: v1_text = fetch_raw(V1_FILE, missing_ok=False)
            if a.beta: beta_text = Path(a.beta).read_text(encoding="utf-8") if Path(a.beta).exists() else None
            else: beta_text = fetch_raw(BETA_FILE, missing_ok=True)
            source = ("local files" if a.v1 and a.beta else
                      "public raw files (CDN, may be up to 5 min stale; --api reads fresh)" if not (a.v1 or a.beta)
                      else "mixed")

        if a.rollback:
            res = rollback(v1_text, beta_text)
            digest = proposal_hash(res["v1_text"], res["beta_text"])
            print("\n".join(rollback_lines(res["report"], source)))
            print(f"proposal sha256: {digest}")
            if not a.write:
                out = Path(a.out)
                out.parent.mkdir(parents=True, exist_ok=True)
                o1, o2 = out.with_name("stages.rollback.json"), out.with_name("stages-beta.rollback.json")
                o1.write_text(res["v1_text"], encoding="utf-8", newline="\n")
                o2.write_text(res["beta_text"], encoding="utf-8", newline="\n")
                print(f"proposed files written to {o1} and {o2} (DRY RUN: nothing was sent to GitHub)")
                return 0
            _check_expect(a.expect, digest)
            c1 = gh_put(res["v1_text"], v1_sha, V1_FILE, ROLLBACK_MESSAGE)
            print(f"WROTE stages.json v1 ({res['report']['v1_entries']} entries), commit {c1}")
            c2 = gh_put(res["beta_text"], beta_sha, BETA_FILE, "rollback: stages-beta.json from the v2 stages.json")
            print(f"WROTE stages-beta.json v2 ({res['report']['beta_entries']} entries), commit {c2}")
            return 0

        if a.write or a.api:
            # A v1 file after a promotion that is still in force = a stale v1 page wrote it back: never re-promote.
            o = parse_json(v1_text or "")
            if not (isinstance(o, dict) and _version(o) >= FILE_VERSION):
                done = promoted_before(gh_history())
                if done: raise PromoteError(REGRESSED + f" (promotion commit {done})")
        res = promote(v1_text, beta_text)
        digest = proposal_hash(res["text"])
        print("\n".join(summary_lines(res["report"], source)))
        print(f"proposal sha256: {digest}")
        if not a.write:
            out = Path(a.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(res["text"], encoding="utf-8", newline="\n")
            print(f"proposed stages.json written to {out} (DRY RUN: nothing was sent to GitHub)")
            return 0
        if res["report"]["already_v2"]:
            print("stages.json is already version 2: already promoted, nothing to do (nothing was written)")
            return 0
        if res["report"]["unchanged"]:
            print("nothing to write: stages.json already holds exactly this content")
            return 0
        _check_expect(a.expect, digest)
        commit = gh_put(res["text"], v1_sha)
        print(f"WROTE stages.json v2 ({res['report']['merged_entries']} entries), commit {commit}")
        # The beta file was read once, before the PUT: a beta save since then is NOT in stages.json.
        if beta_text is None:
            return 0
        if a.seal_beta:
            sealed = seal_text(beta_text)
            if sealed is None:
                print("WARNING: stages-beta.json could not be sealed (damaged); close every EJ Beta app by hand",
                      file=sys.stderr)
                return 3
            try:
                c2 = gh_put(sealed, beta_sha, BETA_FILE, "promote: mark stages-beta.json retired (version 3)")
            except PromoteError as e:
                print(f"WARNING: stages-beta.json changed during the promotion, so it was NOT sealed and its newest "
                      f"changes are NOT in stages.json. Compare it with stages.json by hand. ({e})", file=sys.stderr)
                return 3
            print(f"SEALED stages-beta.json (version {RETIRED_VERSION}, content kept), commit {c2}")
            return 0
        _, now_sha = gh_get(BETA_FILE, missing_ok=True)
        if now_sha != beta_sha:
            print("WARNING: stages-beta.json changed during the promotion: its newest changes are NOT in stages.json. "
                  "Compare it with stages.json by hand.", file=sys.stderr)
            return 3
        return 0
    except PromoteError as e:
        print(f"ABORTED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
