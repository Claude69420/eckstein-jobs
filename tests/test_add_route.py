"""Tests for tools/add_route.py (Claude's routes into the app's shared routes.json; R-3).

Run: python tests/test_add_route.py
Never touches the network or the state repo: `gh` and the raw CDN are replaced by fakes; a test fails if the real
ones are reached. The parity tests run the real js/routes.js in node (skipped when node is missing).
"""
from __future__ import annotations

import base64, io, json, os, shutil, subprocess, sys, tempfile, unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import add_route as A  # noqa: E402

NODE = shutil.which("node")
ROUTES_JS = ROOT / "js" / "routes.js"
FAKE_TOKEN = "ghp_FAKE_TEST_ONLY_0123456789abcdefghijklmn"   # fake test value, never a real key
NOW = 1790780400000.0          # 2026-09-30T15:00:00Z
DAY = 86400000

S1 = {"name": "130 Midland St", "lat": 49.9102, "lon": -97.1601, "jobNumber": 664}
S2 = {"name": "Portage & Lipton", "lat": 49.8812, "lon": -97.1834, "jobNumber": 700}
S3 = {"name": "Selkirk", "lat": 50.1436, "lon": -96.8839, "oot": True}


def existing_doc(extra_routes=None):
    routes = {
        "rexisting01": {"id": "rexisting01", "name": "Riley's Monday", "owner": "Riley", "by": "PC", "at": "2026-09-29T10:00:00Z",
                        "rt": False, "start": {"mode": "shop"}, "seq": [S1], "skipped": []},
        "roldtomb001": {"deleted": True, "at": A.iso_of(NOW - 31 * DAY), "by": "PC"},
        "rnewtomb001": {"deleted": True, "at": A.iso_of(NOW - 2 * DAY), "by": "PC"},
    }
    routes.update(extra_routes or {})
    return {"version": 1, "routes": routes, "note": "kept"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="test-add-route-"))
        self.stops = self.tmp / "stops.json"
        self.stops.write_text(json.dumps([S1, S2, S3]), encoding="utf-8")
        self.out = self.tmp / "proposed.json"
        self.current = self.tmp / "routes.json"
        self.current.write_text(json.dumps(existing_doc(), indent=2), encoding="utf-8")
        # the real network / gh must never be reached
        self.p_gh = mock.patch.object(A, "_gh", side_effect=AssertionError("gh must not be called"))
        self.p_raw = mock.patch.object(A, "fetch_raw", side_effect=AssertionError("the CDN must not be read"))
        self.p_sleep = mock.patch.object(A.time, "sleep", lambda s: None)
        self.p_gh.start(); self.p_raw.start(); self.p_sleep.start()

    def tearDown(self):
        mock.patch.stopall()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_tool(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = A.main(list(args))
        return code, out.getvalue(), err.getvalue()

    def base_args(self, *extra):
        return ["--name", "Setup crew Tue", "--stops", str(self.stops), "--out", str(self.out)] + list(extra)


class DryRun(Base):
    def test_dry_run_on_a_local_copy(self):
        code, out, err = self.run_tool(*self.base_args("--current", str(self.current)))
        self.assertEqual(code, 0, err)
        self.assertIn("DRY RUN", out)
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(list(doc), ["version", "routes", "note"])
        self.assertEqual(doc["version"], 1)
        new = [r for k, r in doc["routes"].items() if k not in ("rexisting01", "rnewtomb001")]
        self.assertEqual(len(new), 1)
        r = new[0]
        self.assertTrue(A.ID_RE.fullmatch(r["id"]))
        self.assertEqual(list(r), ["id", "name", "owner", "by", "at", "rt", "start", "seq", "skipped"])
        self.assertEqual((r["name"], r["owner"], r["by"], r["rt"], r["start"], r["skipped"]),
                         ("Setup crew Tue", "Claude", "Claude", False, {"mode": "shop"}, []))
        self.assertEqual(r["seq"], [S1, S2, S3])
        self.assertIn("rexisting01", doc["routes"], "other routes kept")
        self.assertIn("rnewtomb001", doc["routes"], "a recent tombstone is kept")
        self.assertNotIn("roldtomb001", doc["routes"], "tombstones older than 30 days are pruned")
        self.assertEqual(list(doc["routes"]), sorted(doc["routes"]), "sorted by id")
        self.assertIn("routes     1 -> 2", out)
        self.assertIn("#664, #700", out)
        self.assertTrue(self.out.read_text(encoding="utf-8").endswith("}\n"))

    def test_empty_current_means_a_new_file(self):
        self.current.write_text("", encoding="utf-8")
        code, out, err = self.run_tool(*self.base_args("--current", str(self.current)))
        self.assertEqual(code, 0, err)
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(len(doc["routes"]), 1)
        self.assertIn("routes     0 -> 1", out)

    def test_start_stop_rt_owner(self):
        code, _, err = self.run_tool(*self.base_args("--current", str(self.current), "--start", "stop", "--rt", "--owner", " Riley\n"))
        self.assertEqual(code, 0, err)
        r = [r for r in json.loads(self.out.read_text(encoding="utf-8"))["routes"].values() if r.get("owner") == "Riley" and r.get("by") == "Riley"]
        self.assertEqual(len(r), 1)
        self.assertEqual((r[0]["start"], r[0]["rt"], r[0]["seq"][0]["name"]), ({"mode": "stop"}, True, "130 Midland St"))

    def test_default_dry_run_reads_the_cdn_and_api_reads_gh(self):
        self.p_raw.stop()
        with mock.patch.object(A, "fetch_raw", return_value=None) as raw:
            code, out, err = self.run_tool(*self.base_args())
        self.assertEqual(code, 0, err)
        raw.assert_called_once()
        self.assertIn("raw CDN", out)
        self.p_gh.stop()
        calls = []
        with mock.patch.object(A, "_gh", side_effect=lambda args, input_file=None: calls.append((args, input_file)) or
                               FakeProc(0, contents_json(json.dumps(existing_doc()), "sha-9"))):
            code, out, err = self.run_tool(*self.base_args("--api"))
        self.assertEqual(code, 0, err)
        self.assertEqual(len(calls), 1, "read only: one GET")
        self.assertNotIn("-X", calls[0][0])

    def test_damaged_or_newer_file_is_refused(self):
        for text, why in (('{"version": 1, "routes": [', "damaged"), ('{"routes": []}', "damaged"),
                          (json.dumps({"version": 2, "routes": {}}), "newer")):
            self.current.write_text(text, encoding="utf-8")
            if self.out.exists(): self.out.unlink()
            code, out, err = self.run_tool(*self.base_args("--current", str(self.current)))
            self.assertEqual(code, 1, text)
            self.assertIn(why, err)
            self.assertFalse(self.out.exists(), "no proposal for a refused file")

    def test_bad_stops_are_refused(self):
        bads = [[], {"stops": [S1]}, [S1, {"name": "x", "lat": 60, "lon": -97}], [{"name": "x", "lat": "49.9", "lon": -97.1}],
                [S1] * 101, "nope"]
        for b in bads:
            self.stops.write_text(json.dumps(b), encoding="utf-8")
            code, _, err = self.run_tool(*self.base_args("--current", str(self.current)))
            self.assertEqual(code, 1, json.dumps(b)[:80])
            self.assertIn("add_route:", err)
        self.stops.write_text("NaN", encoding="utf-8")
        self.assertEqual(self.run_tool(*self.base_args("--current", str(self.current)))[0], 1)
        self.stops.write_text(json.dumps([S1]), encoding="utf-8")
        self.assertEqual(self.run_tool("--name", " \n ", "--stops", str(self.stops), "--current", str(self.current))[0], 1)
        self.assertEqual(self.run_tool(*self.base_args("--current", str(self.current), "--write"))[0], 1, "--current + --write")

    def test_hostile_stop_fields_are_sanitized(self):
        self.stops.write_text(json.dumps([{"name": "  A\u202e\nB " + "x" * 100, "lat": 49.9, "lon": -97.1, "jobNumber": "9001",
                                           "match": "m" * 300, "shop": "yes", "oot": True, "evil": "<img src=x>"}]), encoding="utf-8")
        code, _, err = self.run_tool(*self.base_args("--current", str(self.current)))
        self.assertEqual(code, 0, err)
        r = [r for r in json.loads(self.out.read_text(encoding="utf-8"))["routes"].values() if r.get("owner") == "Claude"][0]
        s = r["seq"][0]
        self.assertEqual(list(s), ["name", "lat", "lon", "jobNumber", "match", "oot"])
        self.assertTrue(s["name"].startswith("A B x") and len(s["name"]) == 80)
        self.assertEqual((s["jobNumber"], len(s["match"])), ("9001", 120))


class FakeProc:
    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def contents_json(text, sha):
    return json.dumps({"name": "routes.json", "sha": sha, "encoding": "base64",
                       "content": base64.b64encode(text.encode("utf-8")).decode("ascii")})


class FakeGh:
    """gh api: GET returns the current file (or 404); PUT checks the sha like GitHub (409 when stale)."""
    def __init__(self, text, sha="sha-1", conflicts=0):
        self.text, self.sha, self.conflicts = text, sha, conflicts
        self.calls, self.puts = [], []

    def __call__(self, args, input_file=None):
        self.calls.append(list(args))
        if "-X" in args:
            payload = json.loads(Path(input_file).read_text(encoding="utf-8"))
            self.puts.append(payload)
            if self.conflicts > 0:
                self.conflicts -= 1
                self.other_device()
                return FakeProc(1, "", "gh: routes.json does not match (HTTP 409)")
            if (self.text is None) != ("sha" not in payload) or (self.text is not None and payload["sha"] != self.sha):
                return FakeProc(1, "", "gh: conflict (HTTP 409)")
            self.text = base64.b64decode(payload["content"]).decode("utf-8")
            self.sha = "sha-" + str(len(self.puts) + 1)
            return FakeProc(0, json.dumps({"content": {"sha": self.sha}, "commit": {"sha": "c0ffee" * 6}}))
        if self.text is None: return FakeProc(1, "", "gh: Not Found (HTTP 404)")
        return FakeProc(0, contents_json(self.text, self.sha))

    def other_device(self):
        doc = json.loads(self.text) if self.text else {"version": 1, "routes": {}}
        doc["routes"]["rotherdev01"] = {"id": "rotherdev01", "name": "From the iPhone", "owner": "Riley", "by": "iPhone app",
                                        "at": "2026-09-30T14:00:00Z", "rt": False, "start": {"mode": "shop"}, "seq": [S2], "skipped": []}
        self.text = json.dumps(doc)
        self.sha = self.sha + "x"


class Write(Base):
    def use(self, fake):
        self.p_gh.stop()
        self.p_gh = mock.patch.object(A, "_gh", side_effect=fake)
        self.p_gh.start()
        return fake

    def test_write_payload_shape(self):
        gh = self.use(FakeGh(json.dumps(existing_doc()), "sha-1"))
        code, out, err = self.run_tool(*self.base_args("--write"))
        self.assertEqual(code, 0, err)
        self.assertIn("WRITTEN", out)
        self.assertEqual(gh.calls[0], ["repos/Claude69420/eckstein-jobs-state/contents/routes.json"], "fresh GET first")
        self.assertEqual(gh.calls[1], ["-X", "PUT", "repos/Claude69420/eckstein-jobs-state/contents/routes.json"])
        p = gh.puts[0]
        self.assertEqual(sorted(p), ["branch", "content", "message", "sha"])
        self.assertEqual((p["branch"], p["sha"], p["message"]), ("main", "sha-1", 'route: save "Setup crew Tue"'))
        doc = json.loads(base64.b64decode(p["content"]).decode("utf-8"))
        self.assertEqual(len([r for r in doc["routes"].values() if not r.get("deleted")]), 2)
        self.assertEqual(self.out.read_text(encoding="utf-8"), base64.b64decode(p["content"]).decode("utf-8"),
                         "the proposal file is exactly what was PUT")

    def test_write_404_creates_the_file_without_sha(self):
        gh = self.use(FakeGh(None))
        code, _, err = self.run_tool(*self.base_args("--write"))
        self.assertEqual(code, 0, err)
        self.assertNotIn("sha", gh.puts[0])
        self.assertEqual(len(json.loads(gh.text)["routes"]), 1)

    def test_write_conflict_rereads_and_merges(self):
        gh = self.use(FakeGh(json.dumps(existing_doc()), "sha-1", conflicts=1))
        code, _, err = self.run_tool(*self.base_args("--write"))
        self.assertEqual(code, 0, err)
        self.assertEqual(len(gh.puts), 2)
        self.assertEqual([c[0] for c in gh.calls].count("-X"), 2)
        doc = json.loads(gh.text)
        self.assertIn("rotherdev01", doc["routes"], "the other device's route survives")
        self.assertEqual(len([r for r in doc["routes"].values() if not r.get("deleted")]), 3)

    def test_write_gives_up_after_three_conflicts(self):
        gh = self.use(FakeGh(json.dumps(existing_doc()), "sha-1", conflicts=3))
        code, _, err = self.run_tool(*self.base_args("--write"))
        self.assertEqual(code, 1)
        self.assertIn("NOT written", err)
        self.assertEqual(len(gh.puts), 3)

    def test_write_never_overwrites_a_damaged_or_newer_file(self):
        for text in ('{"routes": "oops"}', json.dumps({"version": 5, "routes": {}})):
            gh = self.use(FakeGh(text))
            code, _, _ = self.run_tool(*self.base_args("--write"))
            self.assertEqual(code, 1)
            self.assertEqual(gh.puts, [])

    def test_other_gh_errors_stop_the_tool(self):
        self.use(lambda args, input_file=None: FakeProc(1, "", "gh: Bad credentials (HTTP 401)"))
        code, _, err = self.run_tool(*self.base_args("--write"))
        self.assertEqual(code, 1)
        self.assertIn("could not read routes.json", err)

    def test_never_prints_or_sends_a_token(self):
        gh = self.use(FakeGh(json.dumps(existing_doc())))
        with mock.patch.dict(os.environ, {"GH_TOKEN": FAKE_TOKEN, "GITHUB_TOKEN": FAKE_TOKEN}):
            code, out, err = self.run_tool(*self.base_args("--write"))
            code2, out2, err2 = self.run_tool(*self.base_args("--current", str(self.current)))
        self.assertEqual((code, code2), (0, 0))
        for t in (out, err, out2, err2, json.dumps(gh.calls), json.dumps(gh.puts), self.out.read_text(encoding="utf-8")):
            self.assertNotIn(FAKE_TOKEN, t)
        src = (ROOT / "tools" / "add_route.py").read_text(encoding="utf-8")
        for word in ("os.environ", "getenv", "keyring", "auth token"):
            self.assertNotIn(word, src, "the tool never reads a token itself")


class Pure(unittest.TestCase):
    def test_iso_and_ids(self):
        self.assertEqual(A.iso_ms("2026-09-30T15:00:00Z"), NOW)
        self.assertEqual(A.iso_ms("2026-09-30T10:00:00-05:00"), NOW)
        self.assertEqual(A.iso_ms("2026-09-30T15:00:00.999Z"), NOW + 999)
        for bad in ("2026-02-29T00:00:00Z", "2026-09-30T24:00:00Z", "2026-09-30T15:00:00z", " 2026-09-30T15:00:00Z", "2026-09-30",
                    "2026-09-30T15:00:00+24:00", None, 5, "\uff12026-09-30T15:00:00Z"):
            self.assertIsNone(A.clean_iso(bad), repr(bad))
        ids = {A.new_id(NOW) for _ in range(200)}
        self.assertEqual(len(ids), 200)
        self.assertTrue(all(A.ID_RE.fullmatch(i) and i.startswith("r" + A._b36(int(NOW))) for i in ids))
        self.assertEqual(A.iso_of(NOW), "2026-09-30T15:00:00Z")

    def test_commit_message(self):
        self.assertEqual(A.commit_message([("save", "A\nB")]), 'route: save "A B"')
        self.assertEqual(A.commit_message([("save", "A"), ("delete", "B")]), 'routes: save "A"; delete "B"')


# ---------------------------------------------------------------------------------------------------------------
# Parity with the real js/routes.js (node)
# ---------------------------------------------------------------------------------------------------------------
NODE_SCRIPT = r"""
const R = require(process.argv[1]);
const U = R._util;
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const v = JSON.parse(raw);
  const out = {
    docs: v.docs.map((d) => { const s = U.sanitizeDoc(d); return { map: s.map, extras: s.extras, version: s.version }; }),
    texts: v.texts.map(([s, n]) => U.cleanText(s, n)),
    isos: v.isos.map((s) => { const ms = U.isoMs(s); return Number.isNaN(ms) ? null : ms; }),
    damaged: v.damaged.map((t) => U.isDamaged(t)),
    routes: v.routes.map((r) => R.sanitizeRoute(r)),
    serial: v.serial.map((t) => { const d = U.parseDocText(t); return U.serializeDoc(d.map, d.extras); }),
    ids: v.ids.map((i) => R.ID_RE.test(i)),
    pruned: v.pruned.map(([m, now]) => Object.keys(U.pruneTombstones(U.sanitizeDoc({ routes: m }).map, now))),
    msgs: v.msgs.map((p) => U.commitMessage(p.map(([kind, name]) => ({ kind, name }))))
  };
  process.stdout.write(JSON.stringify(out));
});
"""


def hostile_docs():
    long_emoji = "x" * 79 + "\U0001F600" + "tail"
    base = {"id": "rhostile01", "name": "ok", "owner": "o", "by": "b", "at": "2026-09-30T15:00:00Z", "rt": True,
            "start": {"mode": "gps", "lat": 49.9, "lon": -97.1, "name": "Me"}, "seq": [S1], "skipped": [S3]}
    def r(**kw):
        x = dict(base); x.update(kw); return x
    return [
        None, [], "x", 5, {}, {"routes": []}, {"version": "2", "routes": {}}, {"version": 7.5, "routes": {}},
        {"version": 1, "routes": {"rhostile01": base}, "5": "int-like extra", "b": [1, {"c": None}], "__proto__": {"x": 1}},
        {"routes": {
            "__proto__": base, "constructor": base, "R0000000": base, "r12345": base, "rUPPER0001": base, "r" + "a" * 41: base,
            "rname00001": r(name=long_emoji), "rname00002": r(name="\ud800 lone \udfff" + "\u202e\u2066"),
            "rname00003": r(name=" \t\n ", owner=5, by=None), "rname00004": r(name="a\u00a0\u3000\ufeffb\u0085c\u001cd"),
            "rstart0001": r(start="stop"), "rstart0002": r(start={"mode": "STOP", "lat": 49.9}), "rstart0003": r(start={"mode": "stop", "lat": 49.9, "lon": -97.1, "name": ""}),
            "rtime00001": r(at="2026-02-29T10:00:00Z"), "rtime00002": r(at="2024-02-29T10:00:00.123456789+05:30"),
            "rtime00003": r(at="2026-09-30T15:00Z"), "rtime00004": r(at=12345), "rtime00005": r(at="0001-01-01T00:00:00+01:00"),
            "rstops0001": r(seq=[{"lat": 49.0, "lon": -97}, {"lat": 10 ** 30, "lon": -97}, {"lat": True, "lon": -97.1},
                                 {"lat": 49.9, "lon": -97.1, "jobNumber": 684.0}, {"lat": 49.9, "lon": -97.1, "jobNumber": -0.0},
                                 {"lat": 49.9, "lon": -97.1, "jobNumber": 1e20}, {"lat": 49.9, "lon": -97.1, "jobNumber": 1.5},
                                 {"lat": 49.9, "lon": -97.1, "jobNumber": " 12"}, {"lat": 49.9, "lon": -97.1, "jobNumber": "A-12"},
                                 {"lat": 49.9, "lon": -97.1, "jobNumber": False}, {"lat": 49.9, "lon": -97.1, "shop": 1, "oot": "true"},
                                 {"lat": 48.9, "lon": -99.8, "match": "\u2028" * 5}, "stop", None, [49.9, -97.1]]),
            "rstops0002": r(seq=[{"lat": 49.8 + i / 1e4, "lon": -97.1, "name": "s%d" % i} for i in range(130)], skipped="x"),
            "rstops0003": r(seq=[]), "rstops0004": r(seq=[{"lat": 60, "lon": -97}]),
            "rtomb00001": {"deleted": True, "at": "2026-09-30T15:00:00Z", "by": "PC\u202e", "seq": [S1], "name": "gone"},
            "rtomb00002": {"deleted": True}, "rtomb00003": {"deleted": "true", "at": "2026-09-30T15:00:00Z"},
            "rrt000001": r(rt="true"), "rarr000001": [base],
        }},
        {"routes": {"rcap%05d" % i: r(at=A.iso_of(NOW - i * 60000)) for i in range(305)}},
        # past LIMITS fileBytes (GitHub's contents API stops at 1 MB): the oldest routes go, the same ones in both
        {"routes": {"rbig%05d" % i: r(at=A.iso_of(NOW - i * 60000), name="Big é %d" % i,
                                      seq=[{"lat": 49.8 + k / 1e4, "lon": -97.1, "name": "Stop %d " % k + "x" * 60, "jobNumber": 100 + k,
                                            "match": "m" * 110} for k in range(60)]) for i in range(300)}},
    ]


@unittest.skipUnless(NODE, "node is not installed")
class Parity(unittest.TestCase):
    def node(self, vectors):
        p = subprocess.run([NODE, "-e", NODE_SCRIPT, str(ROUTES_JS)], input=json.dumps(vectors), capture_output=True,
                           text=True, encoding="utf-8", timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_sanitization_matches_js_routes(self):
        docs = hostile_docs()
        texts = [["  a\tb\n\nc\u202e d ", 80], ["x" * 79 + "\U0001F600", 80], ["x" * 78 + "\U0001F600", 80], ["\ud83d", 5],
                 ["abc def", 4], ["\u0085\u001c\u2028", 10], ["a\u200bb", 10], [5, 10], ["\ufeff", 3], ["  ", 1]]
        isos = ["2026-09-30T15:00:00Z", "2026-09-30T15:00:00.5-05:30", "2024-02-29T23:59:59.999999+14:00", "0001-01-01T00:00:00+01:00",
                "9999-12-31T23:59:59-12:00", "2026-09-30T15:00Z", "2026-13-01T00:00:00Z", "bad", "2026-09-30T15:00:00"]
        damaged = ["", "  \n", "\ufeff{\"routes\":{}}", "\u00a0{\"routes\":{}}\u3000", "{\"routes\":[]}", "{", "null", "[]",
                   "{\"version\":1}", "{\"routes\":{}, \"x\": NaN}", "{\"routes\":{}}\n"]
        routes = [dict(d, id=k) if isinstance(d, dict) else d for k, d in hostile_docs()[9]["routes"].items()]
        serial_src = [json.dumps(existing_doc(), ensure_ascii=False), json.dumps({"routes": {"rabc123456": dict(
            existing_doc()["routes"]["rexisting01"], name="G\u00e9rard \U0001F600")}, "9": 1, "a": {"2": 1, "b": 2}})]
        route = A.build_route("Built by Claude", [S1, S2, S3], owner="Claude", rt=True, start="stop", now_ms=NOW)
        text, _ = A.add_to_doc(json.dumps(existing_doc()), route, NOW)
        serial_src.append(text)
        ids = [A.new_id(NOW) for _ in range(20)]
        pruned = [[existing_doc()["routes"], NOW], [existing_doc()["routes"], NOW + 40 * DAY]]
        msgs = [[["save", "A"]], [["save", "x" * 60 + str(i)] for i in range(30)], [["delete", "\u202eB\n"]]]
        js = self.node({"docs": docs, "texts": texts, "isos": isos, "damaged": damaged, "routes": routes, "serial": serial_src,
                        "ids": ids, "pruned": pruned, "msgs": msgs})

        for i, d in enumerate(docs):
            py = A.sanitize_doc(d)
            self.assertEqual(json.loads(json.dumps(py)), js["docs"][i], f"doc {i}")
        self.assertEqual(len(js["docs"][-2]["map"]), 300)
        big = A.sanitize_doc(docs[-1])["map"]
        self.assertTrue(20 < len(big) < 300, len(big))
        self.assertLessEqual(len(A.serialize_doc(big, None).encode("utf-8")), A.LIMITS["fileBytes"])
        self.assertEqual([A.clean_text(s, n) for s, n in texts], js["texts"])
        self.assertEqual([None if A.iso_ms(s) != A.iso_ms(s) else A.iso_ms(s) for s in isos], js["isos"])
        self.assertEqual([A.is_damaged(t) for t in damaged], js["damaged"])
        py_routes = [A.clean_entry(r.get("id") if isinstance(r, dict) else None, r) if isinstance(r, dict) else None for r in routes]
        py_routes = [None if (e is None or e.get("deleted")) else e for e in py_routes]
        self.assertEqual(json.loads(json.dumps(py_routes)), js["routes"])
        for i, t in enumerate(serial_src):
            d = A.parse_doc_text(t)
            self.assertEqual(A.serialize_doc(d["map"], d["extras"]), js["serial"][i], f"serialized text {i} (byte for byte)")
        self.assertEqual(js["serial"][-1], text, "the tool's file is exactly what the app would write")
        self.assertTrue(all(js["ids"]))
        self.assertEqual([sorted(A.prune_tombstones(A.sanitize_doc({"routes": m})["map"], now)) for m, now in pruned],
                         [sorted(x) for x in js["pruned"]])
        self.assertEqual([A.commit_message([tuple(x) for x in p]) for p in msgs], js["msgs"])

    def test_built_route_is_what_js_sanitizeRoute_keeps(self):
        route = A.build_route("  Asphalt \u202eWed\n", [S1, dict(S2, extra=1)], owner="Claude", now_ms=NOW)
        js = self.node({"docs": [], "texts": [], "isos": [], "damaged": [], "routes": [route], "serial": [], "ids": [route["id"]],
                        "pruned": [], "msgs": []})
        self.assertEqual(js["routes"][0], json.loads(json.dumps(route)))
        self.assertEqual(route["name"], "Asphalt Wed")
        self.assertTrue(js["ids"][0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
