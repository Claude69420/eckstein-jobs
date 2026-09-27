"""Tests for tools/promote_stages.py (docs/r2-plan.md sec. 9 "Promotion"). Run: python tests/test_promote.py

No network and no GitHub writes: the dry run uses local fixtures; the --write path runs against a mocked `gh`.
The node checks run the REAL js/stages.js (skipped when node is missing): for every case, the promoted file must
(a) parse back through Stages sanitizeDoc to the beta's merged view (Stages mergeEntry via mergeOverlay) for every
job, field for field, (b) be byte-identical to js serializeDoc of that view with "sat" dropped, and (c) re-serialize
byte-identically. Fixtures: tests/fixtures/promote_v1.json (a v1 stages.json) and promote_beta.json (a
stages-beta.json); made-up jobs and device labels.
"""
import base64, contextlib, io, json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIX = HERE / "fixtures"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import sync_jobs as S  # noqa: E402
import promote_stages as P  # noqa: E402

V1_TEXT = (FIX / "promote_v1.json").read_text(encoding="utf-8")
BETA_TEXT = (FIX / "promote_beta.json").read_text(encoding="utf-8")
LABELS = ["Office PC", "Crew Phone Zeta"]   # device labels in the fixtures: never printed in the summary
NODE = shutil.which("node")

# Node side: the real js/stages.js computes the beta's merged view and reads the promoted file back.
NODE_CHECK = r"""
const fs = require('fs');
const Stages = require(process.argv[2]);
const U = Stages._util;
const cases = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const FIELDS = ['stage', 'assess', 'lane', 'cut', 'asphalt', 'pavers', 'cleanup', 'removed'];
function stripSat(map) {
  const o = {};
  Object.keys(map).forEach(function (jn) {
    const e = Object.assign({}, map[jn]); delete e.sat;
    if (FIELDS.some(function (f) { return Object.prototype.hasOwnProperty.call(e, f); })) o[jn] = e;
  });
  return o;
}
const out = cases.map(function (c) {
  const v1 = U.parseDocText(c.v1);
  let view;   // what the beta app showed (already promoted: what the main app shows)
  if (v1.version >= 2) view = v1.map;
  else view = U.mergeOverlay(c.beta === null ? {} : U.parseDocText(c.beta).map, U.parseOverlayText(c.v1).map);
  const jsText1 = U.serializeDoc(stripSat(view), v1.extras);
  const viewNorm = U.parseDocText(jsText1).map;          // + one read, as the main app would store it
  const jsText = U.serializeDoc(viewNorm, v1.extras);
  const prom = U.parseDocText(c.py);
  const jobs = {};
  Object.keys(Object.assign({}, view, prom.map)).forEach(function (jn) {
    const v = view[jn] || null, p = prom.map[jn] || null, vn = viewNorm[jn] || null;
    jobs[jn] = { view: Stages.effective(v), prom: Stages.effective(p),
      viewAtBy: vn ? [vn.at, vn.by] : null, promAtBy: p ? [p.at, p.by] : null,
      promSat: !!(p && Object.prototype.hasOwnProperty.call(p, 'sat')) };
  });
  return { jsText: jsText, reser: U.serializeDoc(prom.map, prom.extras), version: prom.version, jobs: jobs };
});
process.stdout.write(JSON.stringify(out));
"""


def node_check(cases):
    """cases: [{v1, beta, py}] -> node results, one per case."""
    tmp = tempfile.mkdtemp(prefix="promote-test-")
    try:
        script, data = os.path.join(tmp, "check.js"), os.path.join(tmp, "cases.json")
        Path(script).write_text(NODE_CHECK, encoding="utf-8")
        Path(data).write_text(json.dumps(cases), encoding="utf-8")
        p = subprocess.run([NODE, script, str(ROOT / "js" / "stages.js"), data], capture_output=True, timeout=120)
        if p.returncode != 0: raise AssertionError("node failed: " + p.stderr.decode("utf-8", "replace")[-2000:])
        return json.loads(p.stdout.decode("utf-8"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def doc(stages, version=None, **extra):
    d = {} if version is None else {"version": version}
    d["stages"] = stages
    d.update(extra)
    return json.dumps(d)


def vector_case(v):
    """One overlay vector -> (v1 text, beta text): job 1 in each file (null = no entry)."""
    v1 = doc({} if v["overlay"] is None else {"1": v["overlay"]}, 1)
    beta = doc({} if v["state"] is None else {"1": v["state"]}, 2)
    return v1, beta


def run_main(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = P.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class Merge(unittest.TestCase):
    def setUp(self):
        self.res = P.promote(V1_TEXT, BETA_TEXT)
        self.out = json.loads(self.res["text"])["stages"]

    def test_overlay_vectors_stage_and_items(self):
        vecs = json.loads((FIX / "overlay_vectors.json").read_text(encoding="utf-8"))["vectors"]
        self.assertGreaterEqual(len(vecs), 25)
        for v in vecs:
            with self.subTest(v["name"]):
                res = P.promote(*vector_case(v))
                entry = json.loads(res["text"])["stages"].get("1")
                eff = S.effective(entry, None)
                self.assertEqual(eff["stage"], v["stage"])
                self.assertEqual(eff, v["effective"], "items come from the beta entry, stage from the merge")
                self.assertNotIn("sat", entry or {})

    def test_stage_sources(self):
        o = self.out
        self.assertEqual(o["100"]["stage"], "base")                       # v1 only
        self.assertEqual(o["101"], {"stage": "prep", "at": "", "by": ""})   # v1 shorthand, no at
        self.assertEqual(o["103"]["stage"], "poured")                     # v1 at newer than the beta sat
        self.assertEqual(o["104"]["stage"], "base")                       # beta sat newer
        self.assertEqual(o["105"]["stage"], "setup")                      # beta entry without sat: v1 wins
        self.assertEqual(o["106"]["stage"], "excavation")                 # v1 stage unknown: ignored
        self.assertNotIn("107", o, "beta moved to Ready (sat newer): no entry")
        self.assertNotIn("stage", o["108"], "v1 explicit ready newer: Ready, beta items kept")
        self.assertEqual(o["108"]["cut"], "req")
        self.assertEqual(o["111"]["stage"], "inspected", "' 111' in v1 is job 111")
        self.assertEqual(o["112"]["stage"], "base", "an unreadable v1 at never beats a sat")
        self.assertEqual(o["114"]["stage"], "base", "stage with spaces / case normalized")
        self.assertEqual(o["116"]["stage"], "prep", "offset time 05:30-05:00 = 10:30Z beats sat 10:00Z")

    def test_items_from_beta_and_at_by_from_merge(self):
        o = self.out
        self.assertEqual(o["102"], {"stage": "setup", "assess": "onsite",
                                    "lane": {"s": "booked", "from": "2026-10-06", "to": "2026-10-08"},
                                    "cut": "req", "asphalt": "na", "pavers": "req",
                                    "at": "2026-09-21T08:00:00Z", "by": "Crew Phone Zeta"})
        self.assertEqual(o["103"], {"stage": "poured", "lane": {"s": "req"}, "at": "2026-09-22T10:00:00Z",
                                    "by": "Office PC"}, "v1 stage won and is newer: v1 at/by")
        self.assertEqual(o["105"]["assess"], "onsite")
        self.assertEqual((o["105"]["at"], o["105"]["by"]), ("2026-09-20T10:00:00Z", "Office PC"))
        self.assertEqual((o["104"]["at"], o["104"]["by"]), ("2026-09-21T08:00:00Z", "Crew Phone Zeta"))
        self.assertEqual(o["113"], {"stage": "poured", "asphalt": "done", "cleanup": "done", "removed": True,
                                    "at": "2026-09-21T08:00:00Z", "by": "Crew Phone Zeta"})
        self.assertEqual(o["116"]["pavers"], "req")
        self.assertNotIn("note", o["116"], "fields v1 never had are not carried")
        self.assertEqual(o["115"], {"stage": "inspected", "at": "", "by": ""})

    def test_sat_dropped(self):
        self.assertNotIn('"sat"', self.res["text"])
        self.assertEqual(self.res["report"]["sat_dropped"], 11)

    def test_defaults_and_unknown_values_dropped(self):
        o = self.out
        self.assertEqual(o["109"], {"stage": "setup", "at": "2026-09-21T08:00:00Z", "by": "Crew Phone Zeta"})
        self.assertEqual(o["110"]["lane"], {"s": "booked", "to": "2026-10-08"}, "impossible date dropped")
        self.assertNotIn("assess", o["110"])
        self.assertNotIn("117", o, "only defaults")
        self.assertNotIn("bad key!", o)
        reasons = {(f, k, r) for f, k, r in self.res["report"]["dropped"]}
        self.assertIn(("stages-beta.json", "109", "assess: default dropped"), reasons)
        self.assertIn(("stages-beta.json", "110", "assess: unknown value dropped"), reasons)
        self.assertIn(("stages.json", "106", "no known stage (ignored, like the beta app)"), reasons)

    def test_serialization_shape(self):
        t = self.res["text"]
        self.assertTrue(t.endswith("}\n") and not t.endswith("\n\n"))
        self.assertTrue(t.startswith('{\n  "version": 2,\n  "stages": {\n    "100": {\n      "stage": "base",'))
        keys = list(json.loads(t)["stages"])
        self.assertEqual(keys[-2:], ["1000", "A-1"], "numeric keys ascending, then the others")
        self.assertEqual(keys, sorted(keys[:-1], key=int) + ["A-1"])
        self.assertEqual(json.loads(t)["meta"]["n"], 1)
        self.assertIn('"n": 1,', t)
        self.assertIn('"x": 1e-7,', t)

    def test_js_numbers(self):
        for x, s in [(1.0, "1"), (-0.0, "0"), (0.5, "0.5"), (1e-7, "1e-7"), (0.000001, "0.000001"),
                     (1e21, "1e+21"), (1e20, "100000000000000000000"), (123.456, "123.456"), (-2.5e-10, "-2.5e-10"),
                     (2 ** 60, "1152921504606847000"), (7, "7"), (1.5e300, "1.5e+300")]:
            with self.subTest(x=x): self.assertEqual(P.js_number(x), s)

    def test_idempotent(self):
        t = self.res["text"]
        for beta in (None, "", doc({}, 2), BETA_TEXT):
            with self.subTest(beta=(beta or "")[:20]):
                again = P.promote(t, beta)
                self.assertEqual(again["text"], t)
                self.assertTrue(again["report"]["unchanged"])
                self.assertTrue(again["report"]["already_v2"])

    def test_refuses_unusable_input(self):
        for v1, beta, why in [(doc({}, 3), None, "newer"), ("{oops", None, "damaged"), ('{"stages": []}', None, "damaged"),
                              ("", None, "empty"), (None, None, "not found"), (V1_TEXT, doc({}, 3), "newer"),
                              (V1_TEXT, "[1]", "damaged"), ('{"stages": {"1": NaN}}', None, "damaged")]:
            with self.subTest(why=why, v1=str(v1)[:15]):
                with self.assertRaises(P.PromoteError) as cm: P.promote(v1, beta)
                self.assertIn(why, str(cm.exception))

    def test_missing_or_empty_beta_is_empty(self):
        a, b = P.promote(V1_TEXT, None), P.promote(V1_TEXT, "  ")
        self.assertEqual(a["text"], b["text"])
        self.assertEqual(json.loads(a["text"])["stages"]["103"], {"stage": "poured", "at": "2026-09-22T10:00:00Z",
                                                                  "by": "Office PC"})

    def test_labels_are_cleaned_like_js(self):
        v1 = doc({"1": {"stage": "base", "at": "2026-09-20T10:00:00Z", "by": "  a‮\u0007b   c  "}}, 1)
        e = json.loads(P.promote(v1, None)["text"])["stages"]["1"]
        self.assertEqual(e["by"], "a b c")


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="promote-cli-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_dry_run_local_files_no_labels_no_gh(self):
        out = os.path.join(self.tmp, "o", "stages.json")
        with mock.patch.object(P, "_gh", side_effect=AssertionError("dry run must not call gh")), \
                mock.patch.object(P, "fetch_raw", side_effect=AssertionError("local files only")):
            rc, so, se = run_main("--v1", str(FIX / "promote_v1.json"), "--beta", str(FIX / "promote_beta.json"),
                                  "--out", out)
        self.assertEqual(rc, 0, se)
        self.assertEqual(Path(out).read_bytes(), P.promote(V1_TEXT, BETA_TEXT)["text"].encode("utf-8"))
        self.assertIn("merged stages.json v2: 18 entries", so)
        self.assertIn("DRY RUN", so)
        for label in LABELS: self.assertNotIn(label, so)

    def test_write_refuses_local_files(self):
        with mock.patch.object(P, "_gh", side_effect=AssertionError("must not call gh")):
            rc, so, se = run_main("--write", "--v1", str(FIX / "promote_v1.json"))
        self.assertEqual(rc, 1)
        self.assertIn("ABORTED", se)

    def _fake_gh(self, v1_text, beta_text, put_rc=0, put_err=""):
        calls = []

        def gh(args, input_file=None):
            calls.append((list(args), Path(input_file).read_text(encoding="utf-8") if input_file else None))
            if args[:2] == ["-X", "PUT"]:
                return subprocess.CompletedProcess(args, put_rc, json.dumps({"commit": {"sha": "c0ffee"}}), put_err)
            if "/commits?" in args[0]: return subprocess.CompletedProcess(args, 0, "[]", "")   # no history
            name = args[0].split("/contents/")[1].split("?")[0]
            text = v1_text if name == "stages.json" else beta_text
            if text is None: return subprocess.CompletedProcess(args, 1, "", "gh: Not Found (HTTP 404)")
            body = {"encoding": "base64", "sha": "sha-" + name,
                    "content": base64.b64encode(text.encode("utf-8")).decode("ascii")}
            return subprocess.CompletedProcess(args, 0, json.dumps(body), "")
        return gh, calls

    def test_write_puts_merged_file_with_sha(self):
        gh, calls = self._fake_gh(V1_TEXT, BETA_TEXT)
        with mock.patch.object(P, "_gh", side_effect=gh), \
                mock.patch.object(P, "fetch_raw", side_effect=AssertionError("write reads through gh")):
            rc, so, se = run_main("--write")
        self.assertEqual(rc, 0, se)
        puts = [c for c in calls if c[0][:2] == ["-X", "PUT"]]
        self.assertEqual(len(puts), 1)
        self.assertEqual(puts[0][0][2], "repos/Claude69420/eckstein-jobs-state/contents/stages.json")
        payload = json.loads(puts[0][1])
        self.assertEqual(payload["sha"], "sha-stages.json")
        self.assertEqual(payload["message"], "promote: merge stages-beta.json into stages.json (v2)")
        self.assertEqual(payload["branch"], "main")
        self.assertEqual(base64.b64decode(payload["content"]).decode("utf-8"), P.promote(V1_TEXT, BETA_TEXT)["text"])
        self.assertIn("WROTE", so)
        self.assertFalse(any("stages-beta.json" in c[0][-1] and c[0][:2] == ["-X", "PUT"] for c in calls),
                         "never writes the beta file")

    def test_write_conflict_aborts(self):
        gh, calls = self._fake_gh(V1_TEXT, None, put_rc=1, put_err="gh: Conflict (HTTP 409)")
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write")
        self.assertEqual(rc, 1)
        self.assertIn("Re-run", se)
        self.assertNotIn("WROTE", so)

    def test_write_skips_when_unchanged(self):
        t = P.promote(V1_TEXT, BETA_TEXT)["text"]
        gh, calls = self._fake_gh(t, BETA_TEXT)
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write")
        self.assertEqual(rc, 0, se)
        self.assertFalse([c for c in calls if c[0][:2] == ["-X", "PUT"]])
        self.assertIn("already promoted, nothing to do", so)

    def test_write_read_error_aborts_before_put(self):
        def gh(args, input_file=None):
            if args[:2] == ["-X", "PUT"]: raise AssertionError("no PUT after a read error")
            return subprocess.CompletedProcess(args, 1, "", "gh: Bad credentials (HTTP 401)")
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write")
        self.assertEqual(rc, 1)
        self.assertIn("ABORTED", se)


class Hardening(unittest.TestCase):
    """Review fixes: beta-only stages listed, already-v2 --write is a no-op, --expect, --seal-beta, the beta-file
    race check, --api dry run and the --rollback down-convert."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="promote-hard-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def fake_gh(self, files, put_fail=None, beta_sha_after_put=None, history=None):
        """files: {name: text or None}. put_fail: {name: stderr}. beta_sha_after_put: the beta sha a GET returns
        once stages.json was PUT (a beta save landing during the promotion). history: stages.json commits, newest
        first, [(sha, message, text)]; a GET with ?ref=<sha> returns that text."""
        calls, state = [], {"put_v1": False}
        at_ref = {sha: text for sha, _, text in (history or [])}

        def gh(args, input_file=None):
            calls.append((list(args), Path(input_file).read_text(encoding="utf-8") if input_file else None))
            if args[:2] == ["-X", "PUT"]:
                name = args[2].split("/contents/")[1]
                if put_fail and name in put_fail: return subprocess.CompletedProcess(args, 1, "", put_fail[name])
                if name == "stages.json": state["put_v1"] = True
                return subprocess.CompletedProcess(args, 0, json.dumps({"commit": {"sha": "c-" + name}}), "")
            if "/commits?" in args[0]:
                body = [{"sha": sha, "commit": {"message": msg + "\n\nbody"}} for sha, msg, _ in (history or [])]
                return subprocess.CompletedProcess(args, 0, json.dumps(body), "")
            name, _, ref = args[0].split("/contents/")[1].partition("?ref=")
            text = at_ref.get(ref) if ref != "main" else files.get(name)
            if text is None: return subprocess.CompletedProcess(args, 1, "", "gh: Not Found (HTTP 404)")
            sha = "sha-" + name
            if name == "stages-beta.json" and state["put_v1"] and beta_sha_after_put: sha = beta_sha_after_put
            body = {"encoding": "base64", "sha": sha, "content": base64.b64encode(text.encode("utf-8")).decode("ascii")}
            return subprocess.CompletedProcess(args, 0, json.dumps(body), "")
        return gh, calls

    @staticmethod
    def puts(calls):
        return [(c[0][2].split("/contents/")[1], json.loads(c[1])) for c in calls if c[0][:2] == ["-X", "PUT"]]

    def test_beta_only_stages_are_listed_by_number(self):
        v1 = doc({"1": {"stage": "base", "at": "2026-09-20T10:00:00Z", "by": "x"}}, 1)
        beta = doc({"1": {"stage": "prep", "sat": "2026-09-21T10:00:00Z", "at": "2026-09-21T10:00:00Z"},
                    "2": {"stage": "setup", "sat": "2026-09-21T10:00:00Z", "at": "2026-09-21T10:00:00Z"},
                    "3": {"assess": "onsite", "at": "2026-09-21T10:00:00Z"}}, 2)
        res = P.promote(v1, beta)
        self.assertEqual(res["report"]["beta_only"], ["2"], "job 1 has a v1 entry; job 3 has no stage")
        text = "\n".join(P.summary_lines(res["report"], "t"))
        self.assertIn("beta-only stages (v1 has no usable entry", text)
        self.assertRegex(text, r"(?m)beta-only stages .*: 1: 2$")
        self.assertNotIn("beta-only", "\n".join(P.summary_lines(P.promote(v1, None)["report"], "t")))

    def test_write_on_an_already_v2_file_never_puts_even_when_not_a_fixed_point(self):
        v2 = doc({"5": {"stage": "base", "at": "2026-09-20T10:00:00Z", "by": "x" * 39 + " "},
                  "6": {"stage": "prep", "sat": "2026-09-20T10:00:00Z", "at": "", "by": ""}}, 2)
        self.assertFalse(P.promote(v2, None)["report"]["unchanged"], "the dry run would normalize it")
        gh, calls = self.fake_gh({"stages.json": v2, "stages-beta.json": BETA_TEXT})
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write")
        self.assertEqual(rc, 0, se)
        self.assertEqual(self.puts(calls), [])
        self.assertIn("already promoted, nothing to do", so)

    def test_expect_guards_the_write(self):
        digest = P.proposal_hash(P.promote(V1_TEXT, BETA_TEXT)["text"])
        rc, so, se = run_main("--v1", str(FIX / "promote_v1.json"), "--beta", str(FIX / "promote_beta.json"),
                              "--out", os.path.join(self.tmp, "x", "p.json"))
        self.assertIn("proposal sha256: " + digest, so)
        for bad in ("0" * 64, "abc", "zz" * 8):
            gh, calls = self.fake_gh({"stages.json": V1_TEXT, "stages-beta.json": BETA_TEXT})
            with mock.patch.object(P, "_gh", side_effect=gh):
                rc, so, se = run_main("--write", "--expect", bad)
            self.assertEqual(rc, 1, bad)
            self.assertIn("ABORTED", se)
            self.assertEqual(self.puts(calls), [], "no PUT for a proposal nobody reviewed")
        gh, calls = self.fake_gh({"stages.json": V1_TEXT, "stages-beta.json": BETA_TEXT})
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write", "--expect", digest[:12].upper())
        self.assertEqual(rc, 0, se)
        self.assertEqual([n for n, _ in self.puts(calls)], ["stages.json"])
        rc, so, se = run_main("--expect", digest)
        self.assertEqual(rc, 1, "--expect without --write is refused")

    def test_seal_beta_marks_the_beta_file_retired_with_its_read_sha(self):
        gh, calls = self.fake_gh({"stages.json": V1_TEXT, "stages-beta.json": BETA_TEXT})
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write", "--seal-beta")
        self.assertEqual(rc, 0, se)
        puts = self.puts(calls)
        self.assertEqual([n for n, _ in puts], ["stages.json", "stages-beta.json"], "the promotion first")
        seal = puts[1][1]
        self.assertEqual(seal["sha"], "sha-stages-beta.json", "guarded by the sha read BEFORE the promotion")
        sealed = json.loads(base64.b64decode(seal["content"]).decode("utf-8"))
        self.assertEqual(sealed["version"], 3)
        self.assertEqual(sealed["stages"], json.loads(BETA_TEXT)["stages"], "content kept as a backup")
        self.assertIn("SEALED", so)

    def test_seal_conflict_or_beta_change_warns_exit_3(self):
        gh, calls = self.fake_gh({"stages.json": V1_TEXT, "stages-beta.json": BETA_TEXT},
                                 put_fail={"stages-beta.json": "gh: Conflict (HTTP 409)"})
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write", "--seal-beta")
        self.assertEqual(rc, 3)
        self.assertIn("WROTE stages.json", so)
        self.assertIn("changed during the promotion", se)
        # without --seal-beta: the beta sha is re-read after the PUT
        gh, calls = self.fake_gh({"stages.json": V1_TEXT, "stages-beta.json": BETA_TEXT}, beta_sha_after_put="sha-new")
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write")
        self.assertEqual(rc, 3)
        self.assertIn("changed during the promotion", se)
        self.assertEqual([n for n, _ in self.puts(calls)], ["stages.json"], "never writes the beta file unasked")
        gh, calls = self.fake_gh({"stages.json": V1_TEXT, "stages-beta.json": BETA_TEXT})
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write")
        self.assertEqual(rc, 0, se)
        self.assertNotIn("WARNING", se)

    def test_api_dry_run_reads_through_gh_and_never_puts(self):
        gh, calls = self.fake_gh({"stages.json": V1_TEXT, "stages-beta.json": BETA_TEXT})
        out = os.path.join(self.tmp, "api", "p.json")
        with mock.patch.object(P, "_gh", side_effect=gh), \
                mock.patch.object(P, "fetch_raw", side_effect=AssertionError("--api reads through gh")):
            rc, so, se = run_main("--api", "--out", out)
        self.assertEqual(rc, 0, se)
        self.assertEqual(self.puts(calls), [])
        self.assertIn("DRY RUN", so)
        self.assertEqual(Path(out).read_text(encoding="utf-8"), P.promote(V1_TEXT, BETA_TEXT)["text"])

    def test_rollback_down_converts_the_current_v2_file(self):
        v2 = P.promote(V1_TEXT, BETA_TEXT)["text"]
        res = P.rollback(v2, "junk")
        v1 = json.loads(res["v1_text"])
        self.assertEqual(v1["version"], 1)
        m = json.loads(v2)["stages"]
        r1 = {jn: e["stage"] for jn, e in m.items() if e.get("stage") in P.R1_KEYS}
        self.assertEqual({jn: e["stage"] for jn, e in v1["stages"].items()}, r1)
        for jn, e in v1["stages"].items():
            self.assertEqual(sorted(e), ["at", "by", "stage"], "v1 entries hold no items")
        setup = sorted((jn for jn, e in m.items() if e.get("stage") == "setup"), key=P._sort_key)
        self.assertEqual(res["report"]["setup_to_ready"], setup)
        self.assertTrue(setup)
        beta = json.loads(res["beta_text"])
        self.assertEqual(beta["version"], 2)
        self.assertEqual(sorted(beta["stages"]), sorted(m))
        for jn, e in beta["stages"].items():
            want = dict(m[jn])
            if "stage" in want and P.clean_iso(want["at"]): want["sat"] = want["at"]
            self.assertEqual(e, want, jn)
        # promoting the rolled-back files again gives the same v2 file
        self.assertEqual(P.promote(res["v1_text"], res["beta_text"])["text"], v2)
        with self.assertRaises(P.PromoteError):
            P.rollback(V1_TEXT)   # a v1 file: nothing to roll back

    def test_rollback_write_puts_both_files_with_their_shas(self):
        v2 = P.promote(V1_TEXT, BETA_TEXT)["text"]
        res = P.rollback(v2, None)
        digest = P.proposal_hash(res["v1_text"], res["beta_text"])
        gh, calls = self.fake_gh({"stages.json": v2, "stages-beta.json": None})
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--rollback", "--write", "--expect", digest)
        self.assertEqual(rc, 0, se)
        puts = self.puts(calls)
        self.assertEqual([n for n, _ in puts], ["stages.json", "stages-beta.json"], "R-1's file first")
        self.assertEqual(puts[0][1]["sha"], "sha-stages.json")
        self.assertNotIn("sha", puts[1][1], "a missing beta file is created")
        self.assertEqual(base64.b64decode(puts[0][1]["content"]).decode("utf-8"), res["v1_text"])
        self.assertEqual(base64.b64decode(puts[1][1]["content"]).decode("utf-8"), res["beta_text"])
        for label in LABELS: self.assertNotIn(label, so)
        # dry run: two files, no gh
        d = self.tmp
        v2p = os.path.join(d, "v2.json"); Path(v2p).write_text(v2, encoding="utf-8")
        with mock.patch.object(P, "_gh", side_effect=AssertionError("dry run")):
            rc, so, se = run_main("--rollback", "--v1", v2p, "--beta", os.path.join(d, "none.json"),
                                  "--out", os.path.join(d, "o", "p.json"))
        self.assertEqual(rc, 0, se)
        self.assertEqual(Path(d, "o", "stages.rollback.json").read_text(encoding="utf-8"), res["v1_text"])
        self.assertEqual(Path(d, "o", "stages-beta.rollback.json").read_text(encoding="utf-8"), res["beta_text"])

    @unittest.skipUnless(NODE, "node not installed")
    def test_rollback_files_read_back_in_the_beta_as_the_main_app_showed_them(self):
        v2 = P.promote(V1_TEXT, BETA_TEXT)["text"]
        res = P.rollback(v2, None)
        script = (
            "const S=require(process.argv[2]);const U=S._util;const fs=require('fs');"
            "const d=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));"
            "const main=U.parseDocText(d.v2).map;"
            "const view=U.mergeOverlay(U.parseDocText(d.beta).map,U.parseOverlayText(d.v1).map);"
            "const o={};Object.keys(Object.assign({},main,view)).forEach(function(jn){"
            "o[jn]=[S.effective(main[jn]||null),S.effective(view[jn]||null)];});"
            "process.stdout.write(JSON.stringify(o));")
        tmp = tempfile.mkdtemp(prefix="promote-rbn-")
        try:
            sp, dp = os.path.join(tmp, "c.js"), os.path.join(tmp, "d.json")
            Path(sp).write_text(script, encoding="utf-8")
            Path(dp).write_text(json.dumps({"v2": v2, "v1": res["v1_text"], "beta": res["beta_text"]}), encoding="utf-8")
            p = subprocess.run([NODE, sp, str(ROOT / "js" / "stages.js"), dp], capture_output=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr.decode("utf-8", "replace"))
            for jn, (main, view) in json.loads(p.stdout.decode("utf-8")).items():
                self.assertEqual(view, main, f"job {jn}: the reverted beta shows what the main app showed")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


R1_BUILD = "005a671"   # the live R-1 build WITHOUT the newer-format guard (APP_MASTER sec. 7.17 "stale v1 page")
LATE = "2026-09-27T12:00:00Z"


def r1_rewrite(text, changes):
    """What a stale R-1 page (build 005a671) PUTs after re-reading the promoted file: {stage, at, by} for the R-1
    stage keys only, its own changes applied (stage "ready" = delete), version 1, other top-level fields kept.
    (Node test R1Real checks this against the real 005a671 js/stages.js.)"""
    d = json.loads(text)
    m = {jn: {"stage": e["stage"], "at": e.get("at", ""), "by": e.get("by", "")}
         for jn, e in d["stages"].items() if isinstance(e, dict) and e.get("stage") in P.R1_KEYS}
    for jn, c in changes.items():
        if c["stage"] == "ready": m.pop(jn, None)
        else: m[jn] = dict(c)
    out = {"version": 1, "stages": P.js_dict(m.items())}
    out.update({k: v for k, v in d.items() if k not in ("version", "stages")})
    return json.dumps(out, indent=2) + "\n"


R1_MOVES = {"104": {"stage": "prep", "at": LATE, "by": "Office PC"},          # a real move after the promotion
            "113": {"stage": "ready", "at": LATE, "by": "Office PC"},         # back to Ready (R-1 deletes the entry)
            "114": {"stage": "excavation", "at": "2026-09-19T00:00:00Z", "by": "Office PC"}}   # an old queued move


class Repair(unittest.TestCase):
    """R1-1 / R1-5: a page still running R-1 build 005a671 writes the promoted stages.json back as v1. The tool
    refuses a second (lossy) promotion and --repair rebuilds v2 from the last v2 version in the history."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="promote-repair-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.v2 = P.promote(V1_TEXT, BETA_TEXT)["text"]
        self.stale = r1_rewrite(self.v2, R1_MOVES)
        self.sealed = P.seal_text(BETA_TEXT)
        self.gh = Hardening.fake_gh.__get__(self)
        self.puts = Hardening.puts

    def expected(self):
        m = json.loads(self.v2)["stages"]
        m["104"] = {**m["104"], "stage": "prep", "at": LATE, "by": "Office PC"}
        m["113"] = {k: v for k, v in m["113"].items() if k != "stage"}
        return m

    def test_sealed_beta_after_promotion(self):
        # already v2: the sealed (version 3) beta file is ignored, not an error
        res = P.promote(self.v2, self.sealed)
        self.assertTrue(res["report"]["already_v2"])
        self.assertEqual(res["text"], self.v2)
        # v1 again next to the sealed beta: a stale v1 page wrote it back -> refuse, point to --repair
        with self.assertRaises(P.PromoteError) as cm:
            P.promote(self.stale, self.sealed)
        self.assertIn("--repair", str(cm.exception))

    def test_repair_restores_items_and_setup_and_keeps_the_newer_v1_moves(self):
        self.assertEqual(json.loads(self.stale)["version"], 1)
        self.assertLess(len(json.loads(self.stale)["stages"]), len(json.loads(self.v2)["stages"]))
        res = P.repair(self.stale, self.v2)
        got = json.loads(res["text"])
        self.assertEqual(got["version"], 2)
        self.assertEqual(got["meta"], json.loads(self.v2)["meta"], "top-level fields kept")
        self.assertEqual(got["stages"], self.expected())
        rep = res["report"]
        self.assertEqual(rep["r1_moves"], ["104"])
        self.assertEqual(rep["r1_ready"], ["113"])
        setup_or_items = [jn for jn, e in json.loads(self.v2)["stages"].items() if e.get("stage") not in P.R1_KEYS]
        self.assertEqual(sorted(rep["restored"]), sorted(setup_or_items))
        text = "\n".join(P.repair_lines(rep, "t", "b"))
        for label in LABELS: self.assertNotIn(label, text)
        self.assertIn("check these): 1: 113", text)
        # no move of its own: the repair gives the last v2 file back byte for byte
        plain = P.repair(r1_rewrite(self.v2, {}), self.v2)
        self.assertEqual(plain["text"], self.v2)
        self.assertTrue(plain["report"]["same_as_base"])
        # refuses a file that is not v1 / a base that is not v2
        with self.assertRaises(P.PromoteError): P.repair(self.v2, self.v2)
        with self.assertRaises(P.PromoteError): P.repair(self.stale, V1_TEXT)

    def history(self, *extra):
        return list(extra) + [("c3" + "0" * 38, "stage: #104 Somewhere -> prep", self.stale),
                              ("c2" + "0" * 38, P.COMMIT_MESSAGE, self.v2),
                              ("c1" + "0" * 38, "stage: #100 -> base", V1_TEXT)]

    def test_second_promotion_is_refused_unless_rolled_back(self):
        for beta in (BETA_TEXT, self.sealed):
            gh, calls = self.gh({"stages.json": self.stale, "stages-beta.json": beta}, history=self.history())
            with mock.patch.object(P, "_gh", side_effect=gh):
                rc, so, se = run_main("--write")
            self.assertEqual(rc, 1)
            self.assertIn("--repair", se)
            self.assertEqual(self.puts(calls), [], "never re-promotes over a promotion in force")
            gh, calls = self.gh({"stages.json": self.stale, "stages-beta.json": beta}, history=self.history())
            with mock.patch.object(P, "_gh", side_effect=gh):
                rc, so, se = run_main("--api", "--out", os.path.join(self.tmp, "a", "p.json"))
            self.assertEqual(rc, 1, "the --api dry run says so too")
        # after an intentional rollback, promoting again is the normal path
        rb = P.rollback(self.v2, None)
        hist = [("c4" + "0" * 38, P.ROLLBACK_MESSAGE, rb["v1_text"])] + self.history()
        gh, calls = self.gh({"stages.json": rb["v1_text"], "stages-beta.json": rb["beta_text"]}, history=hist)
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--write")
        self.assertEqual(rc, 0, se)
        self.assertEqual([n for n, _ in self.puts(calls)], ["stages.json"])

    def test_repair_cli(self):
        want = P.repair(self.stale, self.v2)["text"]
        digest = P.proposal_hash(want)
        out = os.path.join(self.tmp, "r", "p.json")
        gh, calls = self.gh({"stages.json": self.stale, "stages-beta.json": self.sealed}, history=self.history())
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--repair", "--out", out)
        self.assertEqual(rc, 0, se)
        self.assertEqual(self.puts(calls), [], "the repair dry run never writes")
        self.assertIn("proposal sha256: " + digest, so)
        self.assertIn("stages.json at commit c20000000000", so)
        self.assertEqual(Path(out).with_name("stages.repaired.json").read_text(encoding="utf-8"), want)
        for label in LABELS + ["Somewhere"]: self.assertNotIn(label, so)
        self.assertFalse(any("stages-beta.json" in c[0][0] for c in calls), "--repair never reads the beta file")
        # --write needs the reviewed --expect
        for args in (["--repair", "--write"], ["--repair", "--write", "--expect", "0" * 12]):
            gh, calls = self.gh({"stages.json": self.stale}, history=self.history())
            with mock.patch.object(P, "_gh", side_effect=gh):
                rc, so, se = run_main(*args)
            self.assertEqual(rc, 1, args)
            self.assertEqual(self.puts(calls), [])
        gh, calls = self.gh({"stages.json": self.stale}, history=self.history())
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--repair", "--write", "--expect", digest[:12])
        self.assertEqual(rc, 0, se)
        puts = self.puts(calls)
        self.assertEqual([n for n, _ in puts], ["stages.json"])
        self.assertEqual(puts[0][1]["sha"], "sha-stages.json", "guarded by the sha of the v1 file it repairs")
        self.assertEqual(puts[0][1]["message"], P.REPAIR_MESSAGE)
        self.assertEqual(base64.b64decode(puts[0][1]["content"]).decode("utf-8"), want)
        # a repair commit counts as a promotion in force (a second regression is refused as a re-promotion too)
        self.assertEqual(P.promoted_before([("r" * 40, P.REPAIR_MESSAGE)]), "r" * 12)
        # nothing to repair: the file is v2, or it was rolled back on purpose
        gh, calls = self.gh({"stages.json": self.v2}, history=self.history())
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--repair", "--write", "--expect", digest[:12])
        self.assertEqual((rc, self.puts(calls)), (0, []))
        self.assertIn("nothing to repair", so)
        rb = P.rollback(self.v2, None)["v1_text"]
        gh, calls = self.gh({"stages.json": rb}, history=[("c4" + "0" * 38, P.ROLLBACK_MESSAGE, rb)] + self.history())
        with mock.patch.object(P, "_gh", side_effect=gh):
            rc, so, se = run_main("--repair")
        self.assertEqual(rc, 1)
        self.assertIn("rolled back to v1 on purpose", se)
        # local files: dry run only, no gh
        cur, base = os.path.join(self.tmp, "cur.json"), os.path.join(self.tmp, "base.json")
        Path(cur).write_text(self.stale, encoding="utf-8"); Path(base).write_text(self.v2, encoding="utf-8")
        with mock.patch.object(P, "_gh", side_effect=AssertionError("local files only")):
            rc, so, se = run_main("--repair", "--v1", cur, "--last-v2", base, "--out", out)
            self.assertEqual(rc, 0, se)
            self.assertIn("proposal sha256: " + digest, so)
            rc, so, se = run_main("--repair", "--v1", cur, "--last-v2", base, "--write")
            self.assertEqual(rc, 1)

    def test_check(self):
        p2, p1 = os.path.join(self.tmp, "v2.json"), os.path.join(self.tmp, "v1.json")
        Path(p2).write_text(self.v2, encoding="utf-8"); Path(p1).write_text(self.stale, encoding="utf-8")
        with mock.patch.object(P, "_gh", side_effect=AssertionError("no gh")):
            rc, so, se = run_main("--check", "--v1", p2)
            self.assertEqual(rc, 0, se)
            self.assertIn("OK: stages.json is version 2", so)
            rc, so, se = run_main("--check", "--v1", p1)
            self.assertEqual(rc, 4)
            self.assertIn("--repair", so)
            rc, so, se = run_main("--check", "--write")
            self.assertEqual(rc, 1)

    @unittest.skipUnless(NODE, "node not installed")
    def test_real_r1_build_rewrite_and_the_repair_read_back_in_js(self):
        """The simulator above = what the real 005a671 code writes; the repaired file reads back identically in the
        current js/stages.js."""
        p = subprocess.run(["git", "-C", str(ROOT), "show", f"{R1_BUILD}:js/stages.js"], capture_output=True)
        if p.returncode != 0: self.skipTest(f"git show {R1_BUILD} unavailable")
        tmp = tempfile.mkdtemp(prefix="promote-r1-")
        try:
            old = os.path.join(tmp, "r1stages.js")
            Path(old).write_bytes(p.stdout)
            script = (
                "const fs=require('fs');"
                "const U=require(process.argv[2])._util;const N=require(process.argv[3])._util;"
                "const d=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));"
                "const doc=U.parseDocText(d.v2);const m=doc.map;"
                "Object.keys(d.moves).forEach(function(jn){const c=d.moves[jn];"
                "if(c.stage==='ready')delete m[jn];else m[jn]={stage:c.stage,at:c.at,by:c.by};});"
                "const r1=U.serializeDoc(m,doc.extras);"
                "const rp=N.parseDocText(d.repaired);"
                "process.stdout.write(JSON.stringify({r1:r1,reser:N.serializeDoc(rp.map,rp.extras),v:rp.version}));")
            sp, dp = os.path.join(tmp, "c.js"), os.path.join(tmp, "d.json")
            Path(sp).write_text(script, encoding="utf-8")
            Path(dp).write_text(json.dumps({"v2": self.v2, "moves": R1_MOVES,
                                            "repaired": P.repair(self.stale, self.v2)["text"]}), encoding="utf-8")
            r = subprocess.run([NODE, sp, old, str(ROOT / "js" / "stages.js"), dp], capture_output=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr.decode("utf-8", "replace"))
            j = json.loads(r.stdout.decode("utf-8"))
            self.assertEqual(json.loads(j["r1"]), json.loads(self.stale), "simulator = the real R-1 rewrite")
            self.assertEqual(P.repair(j["r1"], self.v2)["text"], P.repair(self.stale, self.v2)["text"])
            self.assertEqual(j["v"], 2)
            self.assertEqual(j["reser"], P.repair(self.stale, self.v2)["text"], "js re-serializes it byte for byte")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(NODE, "node not installed: skipping the js/stages.js round trip")
class NodeRoundTrip(unittest.TestCase):
    def check(self, cases, names):
        results = node_check(cases)
        for c, r, name in zip(cases, results, names):
            with self.subTest(name):
                self.assertEqual(r["version"], 2)
                self.assertEqual(r["reser"], c["py"], "js serializeDoc re-serializes the file byte for byte")
                self.assertEqual(r["jsText"], c["py"], "js computes the same promoted file")
                for jn, j in r["jobs"].items():
                    self.assertEqual(j["prom"], j["view"], f"job {jn}: effective fields = the beta's merged view")
                    self.assertEqual(j["promAtBy"], j["viewAtBy"], f"job {jn}: at/by")
                    self.assertFalse(j["promSat"])

    def test_fixtures(self):
        py = P.promote(V1_TEXT, BETA_TEXT)["text"]
        cases = [{"v1": V1_TEXT, "beta": BETA_TEXT, "py": py},
                 {"v1": V1_TEXT, "beta": None, "py": P.promote(V1_TEXT, None)["text"]},
                 {"v1": py, "beta": None, "py": P.promote(py, BETA_TEXT)["text"]}]   # already v2
        self.check(cases, ["fixtures", "no beta file", "already v2"])

    def test_overlay_vectors(self):
        vecs = json.loads((FIX / "overlay_vectors.json").read_text(encoding="utf-8"))["vectors"]
        cases = []
        for v in vecs:
            v1, beta = vector_case(v)
            cases.append({"v1": v1, "beta": beta, "py": P.promote(v1, beta)["text"]})
        self.check(cases, [v["name"] for v in vecs])

    def test_odd_input(self):
        """Hand edits: odd labels, keys, numbers and text the JS must read back identically."""
        long = "Crew \U0001F600 phone " * 5
        v1 = doc({"7": {"stage": "base", "at": "2026-09-20T10:00:00.123456Z", "by": long},
                  " 8": {"stage": "PREP", "at": " 2026-09-20T10:00:00Z", "by": 5},
                  "8": {"stage": "setup", "at": "2026-09-20T10:00:00Z", "by": "x" * 39 + " y"},
                  "0012": "poured", "12": {"stage": "base", "at": "2026-09-20T10:00:00+00:00"},
                  "4294967295": "setup", "9001": {"stage": "excavation"}},
                 1, zz={"a": [0.00001, 1e21, -0.0, 123456789012345678901234, "\ud800x", " "]}, **{"5": "top"})
        beta = doc({"7": {"stage": "prep", "sat": "2026-09-20T10:00:00.123Z", "at": "2026-09-19T00:00:00Z",
                          "by": "‮evil\u0007 " + long},
                    "8": {"assess": "virtual", "lane": {"s": "req", "from": "2026-10-01"}, "cleanup": "done"},
                    "9": {"stage": "poured", "asphalt": "req", "removed": "yes", "sat": 12},
                    "12": {"stage": "prep", "sat": "2026-09-20T09:59:59.999Z"}}, 2, junk=True)
        py = P.promote(v1, beta)["text"]
        self.check([{"v1": v1, "beta": beta, "py": py}, {"v1": py, "beta": None, "py": P.promote(py, None)["text"]}],
                   ["odd input", "odd input, already v2"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
