"""Unit tests for sync_jobs.py (R-2). No network: every HTTP call is mocked.

    python tests/test_sync.py          (or: python -m unittest discover -s tests -p "test_*.py")

Fixtures live in tests/fixtures/ (made-up jobs, streets and amounts). The AES key used here is a public
TEST ONLY key (bytes 0..31); it is not the real PRICE_KEY.
"""
import base64, contextlib, http.client, io, json, os, shutil, sys, tempfile, unittest, urllib.error, urllib.parse
from datetime import date
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures"
sys.path.insert(0, str(HERE.parent))
import sync_jobs as S  # noqa: E402

TEST_ONLY_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="   # TEST ONLY: bytes(range(32))
TEST_ONLY_KEY = bytes(range(32))
SECRET_AMOUNTS = ["43210", "31337", "27182", "16180", "1618"]          # fixture amounts that must never be printed

def fixture(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))

# End-to-end stage files.
# Single-file mode (the default since the version 2 promotion, S.BETA_STATE_FILE None): stages.json is ONE v2 file,
# sync_stages_promoted.json = the promotion merge of the two beta-trial files below (stage per contract rule 2, items
# from the beta file, sat dropped), plus #156 with a stage this sync does not understand (a newer app).
# Dual-file mode (the beta trial, r2-plan §9; S.BETA_STATE_FILE = "stages-beta.json"): v1's stages.json (stage/at/by
# only, as R-1 writes it) and the beta's stages-beta.json (items + sat).
# Every one of these gives the same decisions as the combined sync_stages.json.
# R-3 keep rule (docs/r3-plan.md A): a closed job is kept until its entry has removed: true. Kept 150 (v1 base is newer
# than the beta sat), 151 (asphalt hint), 155 (beta prep + asphalt, beta sat newer), 156 (v1 stage not understood),
# 152 (field work done: waiting for "Completed" in the app), 154 (no work: waiting too); dropped only 153 (removed).
# (Under R-2's rule 152 and 154 were dropped too.)
KEPT = [150, 151, 152, 154, 155, 156]
ALL_CLOSED = [150, 151, 152, 153, 154, 155, 156]
PROMOTED_TEXT = (FIX / "sync_stages_promoted.json").read_text(encoding="utf-8")
V1_TEXT = (FIX / "sync_stages_v1.json").read_text(encoding="utf-8")
BETA_TEXT = (FIX / "sync_stages_beta.json").read_text(encoding="utf-8")
STAGES_TEXT = PROMOTED_TEXT   # stages.json in single-file mode

def http_error(code, headers=None):
    return urllib.error.HTTPError(S.GRAPHQL_URL, code, f"HTTP {code}", headers or {}, None)

THROTTLED = {"errors": [{"message": "Throttled", "extensions": {"code": "THROTTLED"}}],
             "extensions": {"cost": {"requestedQueryCost": 1500, "actualQueryCost": None,
                                     "throttleStatus": {"maximumAvailable": 10000, "currentlyAvailable": 500, "restoreRate": 500}}}}


class FakeJobber:
    """Serves ListJobs pages (by cursor) and RefreshJob answers (by id); records every request."""
    def __init__(self, pages, refresh=None, script=None):
        self.pages = pages
        self.refresh = refresh or {}
        self.script = list(script or [])   # responses/exceptions served before the normal behaviour
        self.calls = []

    def __call__(self, url, data=None, headers=None, timeout=20):
        self.calls.append({"url": url, "data": data, "headers": headers})
        q, v = (data or {}).get("query", ""), (data or {}).get("variables", {})
        if "ListJobs" in q and self.script:
            item = self.script.pop(0)
            if isinstance(item, Exception): raise item
            return item
        if "ListJobs" in q:
            idx = 0 if v.get("after") is None else int(v["after"].split("-")[1])
            page = json.loads(json.dumps(self.pages[idx]))
            for n in page["data"]["jobs"]["nodes"]:   # like Jobber: only the fields that were asked for
                if "lineItems" not in q: n.pop("lineItems", None)
                if "uninvoicedTotal" not in q: n.pop("total", None); n.pop("uninvoicedTotal", None)
            return page
        if "RefreshJob" in q:
            ans = self.refresh.get(v.get("id"))
            if isinstance(ans, Exception): raise ans
            if ans is None: return {"data": {"job": None}}
            if "__raw__" in ans: return json.loads(json.dumps(ans["__raw__"]))   # a full response (data + errors)
            return {"data": {"job": ans}}
        raise AssertionError(f"unexpected request to {url}")


class SyncTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ej_sync_test_"))
        self.out = self.tmp / "out"; self.inp = self.tmp / "in"
        self.out.mkdir(); self.inp.mkdir()
        (self.inp / S.OVERRIDES_NAME).write_text("{}", encoding="utf-8")
        shutil.copy(HERE.parent / "data" / S.CLIENTS_NAME, self.inp / S.CLIENTS_NAME)   # the real (public) list
        (self.inp / S.PENDING_NAME).write_text(json.dumps([
            {"jobNumber": 9001, "client": "Crown Pipeline Ltd.", "street": "1 Pending Ave", "city": "Winnipeg",
             "title": "PENDING - test"}]), encoding="utf-8")
        cache = {f"{s}, Winnipeg, MB, Canada": [49.85, -97.15] for s in
                 ("100 Test Ave", "200 Test St", "300 Test Blvd", "1 Pending Ave")}
        (self.out / S.CACHE_NAME).write_text(json.dumps(cache), encoding="utf-8")
        shutil.copy(FIX / "sync_prev_jobs.json", self.out / S.JOBS_NAME)
        self.sleeps = []
        self.patches = [mock.patch.object(S, "_sleep", lambda s: self.sleeps.append(s)),
                        mock.patch.object(S, "get_access_token", lambda: "TEST_TOKEN"),
                        mock.patch.dict(os.environ, {}, clear=False)]
        for p in self.patches: p.start()
        for k in ("PRICE_KEY", "TOMTOM_KEY"): os.environ.pop(k, None)

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_main(self, jobber, stages_text=None, stages_exc=None, beta_text=None, beta_exc=None):
        """stages_* = stages.json (v2 in single-file mode, v1's file in dual-file mode); beta_* = stages-beta.json,
        only served in dual-file mode (default: the beta fixture; beta_exc=http_error(404) for "no beta file yet").
        In single-file mode (the default) a request to the beta file fails the test."""
        beta_text = BETA_TEXT if beta_text is None and beta_exc is None else beta_text
        self.fetched = []
        def fake_text(url, timeout=20):
            self.fetched.append(url)
            if url.startswith((S.STATE_RAW_BASE + S.STAGES_BETA_FILE) + "?"):   # (checked after main: fetch_stages swallows errors)
                if beta_exc: raise beta_exc
                return beta_text
            self.assertTrue(url.startswith(S.STAGES_RAW_URL + "?"), url)
            if stages_exc: raise stages_exc
            return stages_text
        buf = io.StringIO()
        with mock.patch.object(S, "_http_json", jobber), mock.patch.object(S, "_http_text", fake_text), \
                contextlib.redirect_stdout(buf):
            rc = S.main(["--out", str(self.out), "--data", str(self.inp)])
        self.log = buf.getvalue()
        if S.BETA_STATE_FILE is None:
            self.assertFalse([u for u in self.fetched if u.startswith((S.STATE_RAW_BASE + S.STAGES_BETA_FILE))],
                             "stages-beta.json requested in single-file mode")
            self.assertNotIn("stages-beta.json", self.log)
        for amt in SECRET_AMOUNTS: self.assertNotIn(amt, self.log, "an amount was printed")
        self.assertNotIn(TEST_ONLY_KEY_B64, self.log)
        return rc

    def jobs_out(self):
        """data/jobs.json (active + pending only)."""
        return {r["jobNumber"]: r for r in json.loads((self.out / S.JOBS_NAME).read_text(encoding="utf-8"))}

    def closed_out(self):
        """data/closed_jobs.json (carried-forward closed jobs)."""
        return {r["jobNumber"]: r for r in json.loads((self.out / S.CLOSED_NAME).read_text(encoding="utf-8"))}

    def all_out(self):
        """What the beta app loads: jobs.json + closed_jobs.json."""
        out = self.jobs_out()
        for jn, r in self.closed_out().items():
            self.assertNotIn(jn, out, "a job in both jobs.json and closed_jobs.json")
            out[jn] = r
        return out

    def meta(self):
        return json.loads((self.out / S.META_NAME).read_text(encoding="utf-8"))

    def default_jobber(self):
        return FakeJobber(fixture("sync_jobber_pages.json")["pages"], refresh={
            "TEST-ID-150": {"id": "TEST-ID-150", "jobNumber": 150, "jobStatus": "requires_invoicing",
                            "total": 27182.81, "uninvoicedTotal": 27182.81},
            "TEST-ID-155": http_error(500),
            "TEST-ID-156": None,
        })


# ----------------------------------------------------------------------------- contract
class ContractVectors(unittest.TestCase):
    def test_shared_vectors(self):
        doc = fixture("contract_vectors.json")
        self.assertGreaterEqual(len(doc["vectors"]), 30)
        self.assertEqual(S.effective(None, None), doc["defaults"])
        for v in doc["vectors"]:
            with self.subTest(v["name"]):
                eff = S.effective(v["entry"], v["hints"])
                self.assertEqual(eff, v["effective"])
                self.assertEqual(S.field_work_done(eff), v["fieldWorkDone"])
                self.assertEqual(S.keep_when_closed(eff), v["keepWhenClosed"])
                self.assertEqual(S.item_lists(eff), v["lists"])

    def test_stage_order(self):
        self.assertEqual(S.STAGE_KEYS, ["ready", "setup", "excavation", "base", "prep", "inspected", "poured"])
        self.assertEqual(S.stage_index("nope"), 0)
        self.assertEqual(S.stage_index(" POURED"), 6)

    def test_entry_unclear(self):
        self.assertFalse(S.entry_unclear(None))
        self.assertFalse(S.entry_unclear({"stage": "base", "at": "x", "by": "y"}))
        self.assertFalse(S.entry_unclear({"stage": None}))
        for e in ({"stage": "setup2"}, {"cut": "maybe"}, {"lane": "req"}, {"lane": {"s": "x"}},
                  {"removed": "yes"}, {"cleanup": 1}, 5, [1], "nonsense"):
            with self.subTest(e=e): self.assertTrue(S.entry_unclear(e))

    def test_parse_stages_text(self):
        ok, note = S.parse_stages_text((FIX / "sync_stages.json").read_text(encoding="utf-8"))
        self.assertEqual(note, "ok"); self.assertIn("150", ok)
        v1, note = S.parse_stages_text('\ufeff{"version":1,"stages":{" 684 ":{"stage":"base"},"bad key!":{"stage":"prep"}}}')
        self.assertEqual((note, sorted(v1)), ("ok", ["684"]))
        self.assertEqual(S.parse_stages_text('{"stages":{}}'), ({}, "ok"))
        for text in ("", "   ", "{oops", "[]", '{"version":2}', '{"stages":[]}', '{"version":3,"stages":{}}'):
            with self.subTest(text=text):
                entries, note = S.parse_stages_text(text)
                self.assertIsNone(entries); self.assertNotEqual(note, "ok")


# ----------------------------------------------------------------------------- hints
class Hints(unittest.TestCase):
    CASES = [
        ("Sidewalk repair", [], False, False),
        ("Asphalt patch", [], True, False),
        ("ASPHALT", [], True, False),
        ("x", [{"name": "Blacktop repair", "description": None}], True, False),
        ("x", [{"name": "black-top", "description": ""}], True, False),
        ("Asphalt paving", [], True, False),
        ("x", [{"name": "Hot mix", "description": "asphalt paving of approach"}], True, False),
        ("x", [{"name": "Asphalt paver rental", "description": None}], True, False),
        ("Reset paving stones", [], False, True),
        ("x", [{"name": "Paving Stone", "description": None}], False, True),
        ("x", [{"name": "Pavers", "description": None}], False, True),
        ("x", [{"name": "misc", "description": "reinstate unit paver border"}], False, True),
        ("Interlock walkway", [], False, True),
        ("x", [{"name": "Interlocking brick", "description": None}], False, True),
        ("Paving stone + asphalt", [], True, True),
        ("Pavement markings", [], False, False),
        ("Repaving", [], False, False),
        ("x", [None, {"name": None, "description": None}, "junk"], False, False),
    ]

    def test_cases(self):
        for title, items, a, p in self.CASES:
            with self.subTest(title=title, items=items):
                self.assertEqual(S.compute_hints(title, items), {"asphalt": a, "pavers": p})


# ----------------------------------------------------------------------------- carry-forward (unit)
class CarryForward(unittest.TestCase):
    def setUp(self):
        self.prev = fixture("sync_prev_jobs.json")
        self.entries, _ = S.parse_stages_text((FIX / "sync_stages.json").read_text(encoding="utf-8"))

    def test_rules(self):
        kept, dropped = S.carry_forward(self.prev, {201, 9001}, {9001}, self.entries)
        self.assertEqual(sorted(r["jobNumber"] for r in kept), KEPT)
        self.assertEqual(dropped, [(153, "removed in app")])
        why = {r["jobNumber"]: r["_why"] for r in kept}
        self.assertEqual(why[152], "waiting for Completed in the app (field work done)")
        self.assertEqual(why[154], "waiting for Completed in the app (nothing outstanding)")
        self.assertEqual(why[150], "work started, field work not done")
        for r in kept:
            self.assertIs(r["closed"], True)
            self.assertIn("hints", r); self.assertIn("id", r)
        self.assertIsNone(next(r for r in kept if r["jobNumber"] == 151)["id"])

    def test_pending_untouched(self):
        kept, dropped = S.carry_forward(self.prev, {201}, set(), None)
        nums = {r["jobNumber"] for r in kept} | {jn for jn, _ in dropped}
        self.assertNotIn(9001, nums); self.assertNotIn(9002, nums)

    def test_read_failure_keeps_every_candidate(self):
        kept, dropped = S.carry_forward(self.prev, {201, 9001}, {9001}, None)
        self.assertEqual(sorted(r["jobNumber"] for r in kept), ALL_CLOSED)
        self.assertEqual(dropped, [])

    def test_active_again_is_not_closed(self):
        kept, _ = S.carry_forward(self.prev, set(KEPT) | {201}, set(), self.entries)
        self.assertEqual(kept, [])

    def test_does_not_mutate_previous_records(self):
        before = json.dumps(self.prev)
        S.carry_forward(self.prev, {201}, set(), self.entries)
        self.assertEqual(json.dumps(self.prev), before)


# ----------------------------------------------------------------------------- prices (unit)
class PricesUnit(unittest.TestCase):
    def test_parse_price_key(self):
        self.assertEqual(S.parse_price_key(TEST_ONLY_KEY_B64), TEST_ONLY_KEY)
        self.assertEqual(S.parse_price_key(" " + TEST_ONLY_KEY_B64[:10] + "\n" + TEST_ONLY_KEY_B64[10:] + " "), TEST_ONLY_KEY)
        urlsafe = base64.urlsafe_b64encode(bytes([251] * 32)).decode().rstrip("=")
        self.assertEqual(S.parse_price_key(urlsafe), bytes([251] * 32))
        for bad in (None, "", "abc", base64.b64encode(bytes(16)).decode(), base64.b64encode(bytes(33)).decode(), "!!!!"):
            with self.subTest(bad=bad): self.assertIsNone(S.parse_price_key(bad))

    def test_round_trip_and_format(self):
        pm = {"101": {"t": 1.5, "u": 0.0}, "7": {"t": 2.0}}
        doc = S.encrypt_prices(pm, TEST_ONLY_KEY)
        self.assertEqual(set(doc), {"v", "alg", "iv", "ct", "at"})
        self.assertEqual((doc["v"], doc["alg"]), (1, "A256GCM"))
        self.assertEqual(len(base64.b64decode(doc["iv"])), 12)
        self.assertRegex(doc["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(S.decrypt_prices(doc, TEST_ONLY_KEY), pm)
        self.assertNotEqual(S.encrypt_prices(pm, TEST_ONLY_KEY)["iv"], doc["iv"], "fresh IV every time")
        with self.assertRaises(Exception): S.decrypt_prices(doc, bytes(32))

    def test_committed_fixture_matches(self):
        """prices.enc.json (also decrypted by tests/prices.test.js with WebCrypto) was made with the TEST key."""
        self.assertEqual(S.decrypt_prices(fixture("prices.enc.json"), TEST_ONLY_KEY), fixture("prices.plain.json"))

    def test_build_price_map_skips_nulls(self):
        jobs = [{"jobNumber": 1}, {"jobNumber": 2}, {"jobNumber": 3}, {"jobNumber": 4}]
        totals = {1: (10.004, 5), 2: (None, None), 3: (None, 7.5), 4: (float("nan"), True)}
        self.assertEqual(S.build_price_map(jobs, totals), {"1": {"t": 10.0, "u": 5.0}, "3": {"u": 7.5}})


# ----------------------------------------------------------------------------- throttle / errors (unit)
class Throttle(unittest.TestCase):
    def setUp(self):
        self.sleeps = []
        self.p = mock.patch.object(S, "_sleep", lambda s: self.sleeps.append(s)); self.p.start()
        self.pages = fixture("sync_jobber_pages.json")["pages"]

    def tearDown(self): self.p.stop()

    def fetch(self, fake):
        with mock.patch.object(S, "_http_json", fake), contextlib.redirect_stdout(io.StringIO()):
            return S.fetch_active_jobs("TEST_TOKEN")

    def test_throttled_then_ok_waits_for_the_bucket(self):
        fake = FakeJobber(self.pages, script=[THROTTLED, THROTTLED])
        jobs = self.fetch(fake)
        self.assertEqual([j["jobNumber"] for j in jobs], [201, 202, 203])
        self.assertEqual(self.sleeps[:2], [3.0, 3.0])       # (1500 - 500) / 500 + 1

    def test_http_429_and_5xx_are_retried(self):
        fake = FakeJobber(self.pages, script=[http_error(429, {"Retry-After": "4"}), http_error(502),
                                              urllib.error.URLError("reset")])
        self.assertEqual(len(self.fetch(fake)), 3)
        self.assertEqual(self.sleeps[:3], [4.0, 1, 2])

    def test_persistent_throttle_fails_instead_of_returning_a_partial_list(self):
        fake = FakeJobber(self.pages, script=[THROTTLED] * S.THROTTLE_ATTEMPTS)
        with self.assertRaises(S.JobberError): self.fetch(fake)

    def test_throttle_on_second_page_still_fails_the_whole_fetch(self):
        class SecondPageThrottled(FakeJobber):
            def __call__(inner, url, data=None, headers=None, timeout=20):
                if (data["variables"].get("after") or "") == "CURSOR-1": return json.loads(json.dumps(THROTTLED))
                return FakeJobber.__call__(inner, url, data, headers, timeout)
        with self.assertRaises(S.JobberError): self.fetch(SecondPageThrottled(self.pages))

    def test_query_too_costly_halves_the_page(self):
        costly = json.loads(json.dumps(THROTTLED))
        costly["extensions"]["cost"]["requestedQueryCost"] = 20000
        fake = FakeJobber(self.pages, script=[costly])
        self.assertEqual(len(self.fetch(fake)), 3)
        firsts = [c["data"]["variables"]["first"] for c in fake.calls]
        self.assertEqual(firsts[:2], [S.JOBS_PAGE, S.JOBS_PAGE // 2])
        self.assertEqual(fake.calls[0]["data"]["variables"]["li"], S.LINE_ITEMS_PAGE)

    def test_errors_without_data_raise(self):
        fake = FakeJobber(self.pages, script=[{"errors": [{"message": "Field 'x' doesn't exist"}]}])
        with self.assertRaises(S.JobberError): self.fetch(fake)

    def test_401_is_not_retried(self):
        fake = FakeJobber(self.pages, script=[http_error(401)])
        with self.assertRaises(urllib.error.HTTPError): self.fetch(fake)
        self.assertEqual(len(fake.calls), 1)

    def test_request_shape(self):
        fake = FakeJobber(self.pages)
        self.fetch(fake)
        q = fake.calls[0]["data"]["query"]
        for f in ("total", "uninvoicedTotal", "lineItems(first: $li)", "name description"):
            self.assertIn(f, q)
        self.assertEqual(fake.calls[0]["data"]["variables"]["filter"], {"status": "active"})
        self.assertEqual(fake.calls[0]["headers"]["X-JOBBER-GRAPHQL-VERSION"], S.GRAPHQL_VERSION)


# ----------------------------------------------------------------------------- end to end (main)
class EndToEnd(SyncTestCase):
    def test_full_run_with_prices(self):
        # previous prices.json holds a value for #155, whose Jobber refresh will fail
        (self.out / S.PRICES_NAME).write_text(json.dumps(S.encrypt_prices({"155": {"t": 16180.33, "u": 1618.03}}, TEST_ONLY_KEY)),
                                             encoding="utf-8")
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        rc = self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertEqual(rc, 0)
        # jobs.json keeps the R-1 membership (active + pending); closed jobs are only in closed_jobs.json
        self.assertEqual(sorted(self.jobs_out()), [201, 202, 203, 9001])
        self.assertEqual(sorted(self.closed_out()), KEPT)
        jobs = self.all_out()
        # active records: id + hints, no prices, no line-item text
        self.assertEqual(jobs[201]["id"], "TEST-ID-201")
        self.assertEqual(jobs[201]["hints"], {"asphalt": True, "pavers": False})
        self.assertEqual(jobs[202]["hints"], {"asphalt": False, "pavers": True})
        self.assertEqual(jobs[203]["hints"], {"asphalt": True, "pavers": False})
        self.assertEqual(jobs[203]["client"], "Test Person 3")
        self.assertNotIn("closed", jobs[201])
        self.assertTrue(jobs[202]["unscheduled"])
        text = (self.out / S.JOBS_NAME).read_text(encoding="utf-8")
        ctext = (self.out / S.CLOSED_NAME).read_text(encoding="utf-8")
        for leaked in ("Replace 3 flags", "Hot mix", "Paving stone reset", "total", "uninvoiced", "43210", "31337",
                       "27182", "16180", "1618"):
            self.assertNotIn(leaked, text); self.assertNotIn(leaked, ctext)
        self.assertNotIn('"closed"', text)
        # pending
        self.assertTrue(jobs[9001]["pending"]); self.assertNotIn("closed", jobs[9001])
        # closed jobs
        for jn in KEPT: self.assertIs(jobs[jn]["closed"], True)
        self.assertEqual(jobs[150]["status"], "requires_invoicing")           # refreshed
        self.assertEqual(jobs[155]["status"], "requires_invoicing")           # refresh failed -> previous kept
        self.assertEqual(jobs[156]["status"], "action_required")              # not found -> previous kept
        self.assertIn("refresh failed", self.log); self.assertIn("not found in Jobber", self.log)
        self.assertEqual([k for k in jobs[150]], [k for k in fixture("sync_prev_jobs.json")[-1]] + ["closed"])
        # order + meta
        for t in (text, ctext):
            order = [r["jobNumber"] for r in json.loads(t)]
            self.assertEqual(order, sorted(order, reverse=True))
        meta = self.meta()
        self.assertEqual((meta["total"], meta["mapped"], meta["closed"], meta["stages_read"], meta["stages_beta_read"]),
                         (4, 4, 6, "ok", "not read (single-file mode)"))
        self.assertEqual(meta["stage_entries"], {"stages.json": 6})
        self.assertEqual([u.split("?")[0] for u in self.fetched], [S.STAGES_RAW_URL], "only stages.json is read")
        self.assertEqual(sorted(meta["by_client"].values()), [1, 1, 2])   # jobs.json only (Crown x2, Harris, Other)
        # prices
        doc = json.loads((self.out / S.PRICES_NAME).read_text(encoding="utf-8"))
        prices = S.decrypt_prices(doc, TEST_ONLY_KEY)
        self.assertEqual(prices, {"201": {"t": 43210.99, "u": 43210.99}, "202": {"t": 31337.5},
                                  "150": {"t": 27182.81, "u": 27182.81}, "155": {"t": 16180.33, "u": 1618.03}})
        self.assertIn("prices: written (encrypted, 4 jobs)", self.log)

    def test_stages_fetch_failure_keeps_every_candidate(self):
        self.run_main(self.default_jobber(), stages_exc=urllib.error.URLError("offline"))
        jobs = self.all_out()
        self.assertEqual(sorted(jn for jn, r in jobs.items() if r.get("closed")), [150, 151, 152, 153, 154, 155, 156])
        self.assertEqual(sorted(self.jobs_out()), [201, 202, 203, 9001])
        self.assertNotIn(9002, jobs)
        self.assertIn("::warning::carry-forward: stages.json unreadable", self.log)
        meta = json.loads((self.out / S.META_NAME).read_text(encoding="utf-8"))
        self.assertTrue(meta["stages_read"].startswith("fetch failed"))

    def test_damaged_stages_file_keeps_every_candidate(self):
        for text in ('{"stages": "oops"', '{"version": 9, "stages": {}}', ""):
            with self.subTest(text=text):
                shutil.copy(FIX / "sync_prev_jobs.json", self.out / S.JOBS_NAME)
                (self.out / S.CLOSED_NAME).unlink(missing_ok=True)
                self.run_main(self.default_jobber(), text)
                closed = sorted(self.closed_out())
                self.assertEqual(closed, [150, 151, 152, 153, 154, 155, 156])

    def test_second_run_drops_nothing_extra_and_keeps_closed(self):
        stages = STAGES_TEXT
        self.run_main(self.default_jobber(), stages)
        first = self.all_out()
        self.run_main(self.default_jobber(), stages)          # previous files are now the first run's output
        second = self.all_out()
        self.assertEqual(sorted(first), sorted(second))
        self.assertEqual(sorted(self.closed_out()), KEPT)

    def test_price_key_missing_leaves_existing_file_alone(self):
        (self.out / S.PRICES_NAME).write_text("OLD-FILE", encoding="utf-8")
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertEqual((self.out / S.PRICES_NAME).read_text(encoding="utf-8"), "OLD-FILE")
        self.assertIn("prices: skipped (PRICE_KEY not set)", self.log)
        self.assertEqual(self.log.count("prices:"), 1)

    def test_price_key_missing_and_no_file(self):
        os.environ["PRICE_KEY"] = "   "
        self.run_main(self.default_jobber(), "{}")
        self.assertFalse((self.out / S.PRICES_NAME).exists())
        self.assertIn("prices: skipped (PRICE_KEY not set)", self.log)

    def test_price_key_invalid(self):
        os.environ["PRICE_KEY"] = "not-a-real-key"
        self.run_main(self.default_jobber(), "{}")
        self.assertFalse((self.out / S.PRICES_NAME).exists())
        self.assertIn("prices: skipped (PRICE_KEY invalid", self.log)
        self.assertNotIn("not-a-real-key", self.log)

    def test_prices_error_never_fails_the_sync(self):
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        with mock.patch.object(S, "encrypt_prices", side_effect=RuntimeError("boom 43210")):
            rc = self.run_main(self.default_jobber(), "{}")
        self.assertEqual(rc, 0)
        self.assertIn("prices: skipped (error: RuntimeError)", self.log)
        self.assertTrue((self.out / S.JOBS_NAME).exists())

    def refusing_jobber(self, *fields):
        base = self.default_jobber()
        def fake(url, data=None, headers=None, timeout=20):
            if any(f in data["query"] for f in fields):
                base.calls.append({"url": url, "data": data, "headers": headers})
                return {"errors": [{"message": f"Field '{fields[0]}' is not accessible"}], "data": None}
            return base(url, data, headers, timeout)
        fake.calls = base.calls
        return fake

    def test_totals_refused_falls_back_without_prices(self):
        (self.out / S.PRICES_NAME).write_text("OLD-FILE", encoding="utf-8")
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        fake = self.refusing_jobber("uninvoicedTotal")
        self.assertEqual(self.run_main(fake, STAGES_TEXT), 0)
        jobs = self.all_out()
        self.assertEqual(sorted(jobs), [150, 151, 152, 154, 155, 156, 201, 202, 203, 9001])
        self.assertEqual(jobs[202]["hints"], {"asphalt": False, "pavers": True}, "line items still used")
        self.assertIn("::warning::jobber: job list query refused", self.log)
        self.assertIn("prices: skipped (Jobber did not return complete totals", self.log)
        self.assertEqual((self.out / S.PRICES_NAME).read_text(encoding="utf-8"), "OLD-FILE")
        self.assertEqual(jobs[155]["status"], "requires_invoicing")   # refresh refused too -> previous kept

    def test_line_items_refused_keeps_previous_hints(self):
        fake = self.refusing_jobber("uninvoicedTotal", "lineItems")
        self.run_main(fake, STAGES_TEXT)
        jobs = self.jobs_out()
        self.assertEqual(jobs[201]["hints"], {"asphalt": True, "pavers": False}, "previous hint kept")
        self.assertEqual(jobs[202]["hints"], {"asphalt": False, "pavers": False}, "title only, no previous record")
        listq = [c["data"] for c in fake.calls if "ListJobs" in c["data"]["query"]]
        self.assertNotIn("li", listq[-1]["variables"])
        self.assertIn("prices: skipped (PRICE_KEY not set)", self.log)

    def test_everything_refused_fails_the_run(self):
        fake = self.refusing_jobber("ListJobs")
        with self.assertRaises(S.JobberQueryError):
            self.run_main(fake, "{}")
        self.assertFalse((self.out / S.META_NAME).exists())

    def test_partial_errors_skip_prices(self):
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        pages = fixture("sync_jobber_pages.json")["pages"]
        pages[1]["errors"] = [{"message": "total could not be resolved"}]
        fake = FakeJobber(pages, refresh=self.default_jobber().refresh)
        self.run_main(fake, "{}")
        self.assertFalse((self.out / S.PRICES_NAME).exists())
        self.assertIn("prices: skipped (Jobber did not return complete totals", self.log)
        self.assertEqual(len([j for j in self.jobs_out().values() if not j.get("closed")]), 4)

    def test_throttle_failure_writes_nothing(self):
        before = {n: (self.out / n).read_bytes() for n in (S.JOBS_NAME, S.CACHE_NAME)}
        fake = FakeJobber(fixture("sync_jobber_pages.json")["pages"], script=[THROTTLED] * S.THROTTLE_ATTEMPTS)
        with self.assertRaises(S.JobberError):
            self.run_main(fake, "{}")
        for n, b in before.items(): self.assertEqual((self.out / n).read_bytes(), b, n)
        self.assertFalse((self.out / S.META_NAME).exists())

    def test_unreadable_previous_jobs_still_rebuilds_jobs_json_for_v1(self):
        """R-1's sync never read the previous jobs.json: a broken one must not leave v1 stuck on it. Carry-forward is
        skipped and the closed-job files (and prices.json) are left exactly as they are."""
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        files = ((S.CLOSED_NAME, "[]"), (S.ARCHIVE_NAME, "ARCHIVE"), (S.PRICES_NAME, "PRICES"))
        for name, text in files: (self.out / name).write_text(text, encoding="utf-8")
        for broken in ("[{truncated", '{"jobs": []}'):
            with self.subTest(broken=broken):
                (self.out / S.JOBS_NAME).write_text(broken, encoding="utf-8")
                self.assertEqual(self.run_main(self.default_jobber(), STAGES_TEXT), 0)
                self.assertEqual(sorted(self.jobs_out()), [201, 202, 203, 9001], "jobs.json rebuilt from Jobber")
                for name, text in files:
                    self.assertEqual((self.out / name).read_text(encoding="utf-8"), text, f"{name} untouched")
                self.assertIn("::warning::carry-forward: previous jobs.json", self.log)
                self.assertIn("jobs.json is rebuilt from Jobber", self.log)
                self.assertIn("::warning::prices: skipped (jobs.json unreadable", self.log)
                self.assertEqual(self.fetched, [], "no stage files needed")
                meta = self.meta()
                self.assertEqual((meta["total"], meta["stages_read"]), (4, "not read (jobs.json unreadable)"))

    def test_refreshes_share_one_time_budget(self):
        """A slow / throttled Jobber holds back jobs.json (read by v1) by at most REFRESH_BUDGET_S."""
        clock = {"t": 1000.0}
        def fake_sleep(sec):
            self.sleeps.append(sec); clock["t"] += sec
        slow = http_error(503)
        jobber = FakeJobber(fixture("sync_jobber_pages.json")["pages"],
                            refresh={"TEST-ID-150": slow, "TEST-ID-155": slow, "TEST-ID-156": slow})
        with mock.patch.object(S, "_sleep", fake_sleep), mock.patch.object(S, "_monotonic", lambda: clock["t"]):
            def slow_call(url, data=None, headers=None, timeout=20):
                if "RefreshJob" in (data or {}).get("query", ""):
                    self.assertLessEqual(timeout, 45.0)
                    clock["t"] += timeout   # every refresh request hangs until its timeout
                return jobber(url, data, headers, timeout)
            self.assertEqual(self.run_main(slow_call, STAGES_TEXT), 0)
        refreshes = [c for c in jobber.calls if "RefreshJob" in (c["data"] or {}).get("query", "")]
        self.assertLessEqual(clock["t"] - 1000.0, S.REFRESH_BUDGET_S + 1, "all refreshes within the budget")
        self.assertLessEqual(len(refreshes), 3)
        self.assertIn("refresh failed (JobberError; previous values kept)", self.log)   # the budget ran out mid-retry
        self.assertIn("refresh budget used up; previous values kept", self.log)
        self.assertEqual(sorted(self.closed_out()), KEPT, "closed jobs still kept (previous values)")
        self.assertEqual(sorted(self.jobs_out()), [201, 202, 203, 9001])

    def test_gql_deadline_bounds_throttle_waits(self):
        clock = {"t": 0.0}
        def fake_sleep(sec): clock["t"] += sec
        fake = FakeJobber([], script=[])
        def throttled(url, data=None, headers=None, timeout=20):
            raise http_error(429, {"Retry-After": "30"})
        with mock.patch.object(S, "_sleep", fake_sleep), mock.patch.object(S, "_monotonic", lambda: clock["t"]), \
                mock.patch.object(S, "_http_json", throttled), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(S.JobberError) as cm:
                S.gql("T", S.REFRESH_Q, {"id": "x"}, label="refresh", deadline=90.0)
        self.assertIn("time budget used up", str(cm.exception))
        self.assertLessEqual(clock["t"], 90.0)
        # without a deadline the list fetch keeps its full retry budget (unchanged)
        self.assertIsNotNone(fake)

    def test_first_r2_run_without_previous_file(self):
        (self.out / S.JOBS_NAME).unlink()
        self.run_main(self.default_jobber(), "{}")
        self.assertEqual(sorted(self.jobs_out()), [201, 202, 203, 9001])

    def test_out_falls_back_to_data_dir_for_previous_state(self):
        shutil.move(str(self.out / S.JOBS_NAME), str(self.inp / S.JOBS_NAME))
        shutil.move(str(self.out / S.CACHE_NAME), str(self.inp / S.CACHE_NAME))
        inp_before = {p.name: p.read_bytes() for p in self.inp.iterdir()}
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertEqual(sorted(self.all_out()), [150, 151, 152, 154, 155, 156, 201, 202, 203, 9001])
        self.assertEqual({p.name: p.read_bytes() for p in self.inp.iterdir()}, inp_before, "--data is read-only")
        self.assertTrue(all(self.jobs_out()[jn]["ok"] for jn in (201, 202, 203)), "cache read from --data")


# ----------------------------------------------------------------------------- review fixes (R-2 fix loop)

def stages_without(*job_numbers):
    doc = json.loads(STAGES_TEXT)
    for jn in job_numbers: doc["stages"].pop(str(jn), None)
    return json.dumps(doc)

def stages_with(**entries):
    """STAGES_TEXT with entries replaced (keys are "_<jobNumber>"; None removes the entry)."""
    doc = json.loads(STAGES_TEXT)
    for k, v in entries.items():
        if v is None: doc["stages"].pop(k.lstrip("_"), None)
        else: doc["stages"][k.lstrip("_")] = v
    return json.dumps(doc)


class ReviewFixesUnit(unittest.TestCase):
    def test_deep_nesting_is_unreadable_not_a_crash(self):
        hostile = '{"version":2,"stages":{"150":' + "[" * 100000 + "]" * 100000 + "}}"
        self.assertEqual(S.parse_stages_text(hostile), (None, "not valid JSON"))
        with mock.patch.object(S, "_http_text", lambda url, timeout=20: hostile):
            entries, note = S.fetch_stages()
        self.assertIsNone(entries); self.assertNotEqual(note, "ok")

    def test_clean_date_matches_js(self):
        for good in ("2026-10-06", "2028-02-29", "1000-01-01", "9999-12-31"):
            with self.subTest(good=good): self.assertEqual(S.clean_date(good), good)
        for bad in ("2026-02-30", "2026-13-45", "2026-02-29", "2026-10-06\n", " 2026-10-06", "0999-12-31",
                    "2026-10-6", "20261006", "2026-W40-1", "２０２６-10-06", 20261006, None):
            with self.subTest(bad=bad): self.assertIsNone(S.clean_date(bad))

    def test_r3_only_removed_drops_and_unknown_values_never_do(self):
        """R-3 keep rule: every closed job stays until removed: true; a value this sync does not understand can never
        drop a job (an unknown `removed` value reads as not removed). The reason names what is outstanding."""
        W = S.AWAITING_WHY
        cases = [
            (None, True, f"{W} (nothing outstanding)"),                          # no entry at all
            ({"stage": "poured", "cleanup": "done"}, True, f"{W} (field work done)"),
            ({"stage": "poured", "cleanup": "done", "pavers": "req"}, True, "work started, field work not done"),
            ({"stage": "base"}, True, "work started, field work not done"),
            ({"stage": "poured", "cleanup": "done", "cut": "maybe"}, True, "stage entry not understood (kept to be safe)"),
            ({"assess": "phone"}, True, "stage entry not understood (kept to be safe)"),
            ({"removed": "yes"}, True, "stage entry not understood (kept to be safe)"),
            ({"removed": False, "stage": "poured", "cleanup": "done"}, True, f"{W} (field work done)"),
            ({"cut": "scheduled"}, True, None), ({"stage": "setup2"}, True, None), ("setup2", True, None),
            (5, True, None), ([1], True, None),
            ({"stage": "base", "removed": True, "cut": "maybe"}, False, "removed in app"),   # removed always wins
            ({"removed": True}, False, "removed in app"),
            ({"removed": True, "name": "Portage & Lipton", "loc": {"lat": 49.88, "lon": -97.28}}, False, "removed in app"),
            ({"name": "Portage & Lipton", "loc": {"lat": 49.88, "lon": -97.28}}, True, f"{W} (nothing outstanding)"),
            ({"stage": "base", "name": 5, "loc": "x"}, True, "work started, field work not done"),   # name/loc ignored
        ]
        for entry, keep, why in cases:
            with self.subTest(entry=entry):
                got = S.keep_decision(entry, {})
                self.assertEqual(got[0], keep)
                if why is not None: self.assertEqual(got[1], why)

    def test_carried_records_are_normalized(self):
        prev = [{"jobNumber": "150", "hints": {"asphalt": 1}, "lat": float("nan"), "lon": -97.2, "ok": True,
                 "clientKey": ["x"], "_why": "old", "droppedAt": "2026-01-01"}]
        # no client -> "Unknown" -> residential (R-3.1), so keep: true is needed to keep it
        kept, _ = S.carry_forward(prev, set(), set(), {"150": {"stage": "base", "keep": True}})
        rec = kept[0]
        self.assertEqual((rec["jobNumber"], rec["clientKey"], rec["client"], rec["street"], rec["city"]),
                         (150, "Residential", "Unknown", "", "Winnipeg"))
        self.assertIs(rec["residential"], True)
        self.assertEqual((rec["lat"], rec["lon"], rec["ok"], rec["id"], rec["closed"]), (None, None, False, None, True))
        self.assertEqual(rec["hints"], {"asphalt": True, "pavers": False})
        self.assertNotIn("droppedAt", rec)

    def test_archive_restores_only_on_a_readable_store(self):
        arch = [{"jobNumber": 150, "id": "TEST-ID-150", "client": "Crown Pipeline Ltd.", "hints": {},
                 "droppedAt": "2026-09-20", "droppedWhy": "x"}]
        kept, dropped = S.carry_forward([], set(), set(), None, arch)
        self.assertEqual((kept, dropped), ([], []), "unreadable store: archived jobs stay archived")
        kept, dropped = S.carry_forward([], set(), set(), {"150": {"stage": "base"}}, arch)
        self.assertEqual([r["jobNumber"] for r in kept], [150]); self.assertEqual(dropped, [])
        self.assertIn("restored from closed_archive.json", kept[0]["_why"])
        kept, _ = S.carry_forward([], {150}, set(), {"150": {"stage": "base"}}, arch)
        self.assertEqual(kept, [], "active again: not a closed job")

    def test_next_archive_ages_out_and_forgets_active_or_kept_jobs(self):
        today = date(2026, 9, 26)
        prev_jobs = [{"jobNumber": 152, "street": "152 Test Ave", "closed": True}]
        prev_arch = [{"jobNumber": 140, "droppedAt": "2026-07-28"},      # 60 days ago: still inside
                     {"jobNumber": 141, "droppedAt": "2026-07-27"},      # 61 days ago: aged out
                     {"jobNumber": 142, "droppedAt": "garbage"},
                     {"jobNumber": 143, "droppedAt": "2026-09-01"},      # active again
                     {"jobNumber": 144, "droppedAt": "2026-09-01"},      # restored this run
                     {"jobNumber": 152, "droppedAt": "2026-09-01"}]      # superseded by today's drop
        out = S.next_archive(prev_arch, prev_jobs, [(152, "field work done")], [{"jobNumber": 144}], {143}, set(), today)
        self.assertEqual([r["jobNumber"] for r in out], [152, 140])
        self.assertEqual((out[0]["droppedAt"], out[0]["droppedWhy"], out[0]["street"]), ("2026-09-26", "field work done", "152 Test Ave"))

    def test_store_looks_reset(self):
        prev = [{"jobNumber": 150, "closed": True}, {"jobNumber": 201}]
        self.assertTrue(S.store_looks_reset({}, prev, {201}))
        self.assertFalse(S.store_looks_reset({}, prev, {150, 201}), "the closed job is active again")
        self.assertFalse(S.store_looks_reset({"1": {"stage": "base"}}, prev, {201}))
        self.assertFalse(S.store_looks_reset(None, prev, {201}))
        self.assertFalse(S.store_looks_reset({}, [{"jobNumber": 201}], {201}), "no closed jobs last run")


class ReviewFixesThrottle(unittest.TestCase):
    setUp, tearDown, fetch = Throttle.setUp, Throttle.tearDown, Throttle.fetch   # (not a subclass: no re-run)

    def test_incomplete_read_is_retried(self):
        fake = FakeJobber(self.pages, script=[http.client.IncompleteRead(b"partial")])
        self.assertEqual(len(self.fetch(fake)), 3)
        self.assertEqual(self.sleeps[:1], [1])

    def test_null_job_node_fails_instead_of_dropping_the_job(self):
        pages = json.loads(json.dumps(self.pages))
        pages[1]["data"]["jobs"]["nodes"].insert(0, None)
        pages[1]["errors"] = [{"message": "Cannot return null for non-nullable field"}]
        with self.assertRaises(S.JobberError) as cm: self.fetch(FakeJobber(pages))
        self.assertIn("without a job number", str(cm.exception))
        pages[1]["data"]["jobs"]["nodes"][0] = {"id": "TEST-ID-X", "title": "no number"}
        with self.assertRaises(S.JobberError): self.fetch(FakeJobber(pages))


class ReviewFixesEndToEnd(SyncTestCase):
    def archive(self):
        return json.loads((self.out / S.ARCHIVE_NAME).read_text(encoding="utf-8"))

    def test_removed_closed_job_comes_back_when_restored_in_the_app(self):
        """R-3: "Completed" (removed: true) archives the job with droppedWhy "removed in app"; Settings -> Recently
        removed -> Restore (the patch {removed: null} deletes the field) brings it back at the next sync."""
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertIs(self.closed_out()[150]["closed"], True)
        self.assertEqual(sorted(r["jobNumber"] for r in self.archive()["jobs"]), [153])
        # run 2: #150's entry slips back to Ready (entry gone): R-3 keeps it (only removed drops a job)
        self.run_main(self.default_jobber(), stages_without(150))
        self.assertIn(150, self.closed_out())
        self.assertIn("kept #150 closed in Jobber (waiting for Completed in the app (nothing outstanding)", self.log)
        # run 3: confirmed "Completed" in the app: dropped (logged, not silent), archived
        self.run_main(self.default_jobber(), stages_with(_150={"stage": "base", "removed": True,
                                                               "at": "2026-09-30T10:00:00Z", "by": "PC"}))
        self.assertNotIn(150, self.all_out())
        self.assertIn("carry-forward: dropped #150, which was closed in Jobber (removed in app); its record stays in "
                      "data/closed_archive.json", self.log)
        self.assertNotIn("::warning::", self.log, "a confirmed removal is not a warning")
        arch = {r["jobNumber"]: r for r in self.archive()["jobs"]}
        self.assertIn(150, arch); self.assertEqual(arch[150]["droppedWhy"], "removed in app")
        self.assertEqual(arch[150]["street"], "150 Test Ave")
        # run 4: still removed -> stays archived, not in the app
        self.run_main(self.default_jobber(), stages_with(_150={"stage": "base", "removed": True}))
        self.assertNotIn(150, self.all_out()); self.assertIn(150, {r["jobNumber"] for r in self.archive()["jobs"]})
        # run 5: restored in the app (removed cleared) -> back, with a fresh refresh; the archive forgets it
        self.run_main(self.default_jobber(), STAGES_TEXT)
        jobs = self.closed_out()
        self.assertIs(jobs[150]["closed"], True)
        self.assertEqual(jobs[150]["status"], "requires_invoicing")
        self.assertNotIn("droppedAt", jobs[150])
        self.assertIn("restored from closed_archive.json", self.log)
        self.assertNotIn(150, {r["jobNumber"] for r in self.archive()["jobs"]})

    def test_empty_store_while_closed_jobs_were_kept_keeps_them(self):
        self.run_main(self.default_jobber(), STAGES_TEXT)
        first = sorted(self.closed_out())
        self.run_main(self.default_jobber(), '{"version":2,"stages":{}}')
        self.assertEqual(sorted(self.closed_out()), first)
        self.assertIn("::warning::carry-forward: stages.json unreadable (no entries at all", self.log)
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertEqual(sorted(self.closed_out()), first)

    def test_hostile_stages_file_does_not_crash_the_sync(self):
        hostile = '{"version":2,"stages":{"150":' + "[" * 100000 + "]" * 100000 + "}}"
        self.assertEqual(self.run_main(self.default_jobber(), hostile), 0)
        closed = sorted(self.closed_out())
        self.assertEqual(closed, [150, 151, 152, 153, 154, 155, 156])

    def test_unreadable_archive_is_replaced_with_a_warning(self):
        (self.out / S.ARCHIVE_NAME).write_text("{broken", encoding="utf-8")
        self.assertEqual(self.run_main(self.default_jobber(), STAGES_TEXT), 0)
        self.assertIn("::warning::carry-forward: closed_archive.json unreadable", self.log)
        self.assertEqual(self.archive()["version"], 1)

    def test_null_line_items_keep_previous_hints(self):
        pages = fixture("sync_jobber_pages.json")["pages"]
        pages[0]["data"]["jobs"]["nodes"][0]["lineItems"] = None          # #201: previous hints asphalt
        pages[0]["errors"] = [{"message": "lineItems could not be resolved"}]
        self.run_main(FakeJobber(pages, refresh=self.default_jobber().refresh), STAGES_TEXT)
        jobs = self.jobs_out()
        self.assertEqual(jobs[201]["hints"], {"asphalt": True, "pavers": False}, "previous hint kept")
        self.assertEqual(jobs[202]["hints"], {"asphalt": False, "pavers": True}, "own line items still used")
        self.assertEqual(jobs[203]["hints"], {"asphalt": True, "pavers": False})
        self.assertIn("::warning::jobber: 2 job(s) came back without complete line items", self.log)

    def test_null_line_items_without_errors_also_keep_previous_hints(self):
        pages = fixture("sync_jobber_pages.json")["pages"]
        pages[0]["data"]["jobs"]["nodes"][0]["lineItems"] = None
        self.run_main(FakeJobber(pages, refresh=self.default_jobber().refresh), STAGES_TEXT)
        self.assertEqual(self.jobs_out()[201]["hints"], {"asphalt": True, "pavers": False})
        self.assertIn("::warning::jobber: 1 job(s) came back without complete line items", self.log)

    def test_partial_refresh_keeps_the_previous_price(self):
        (self.out / S.PRICES_NAME).write_text(json.dumps(S.encrypt_prices({"150": {"t": 111.11}}, TEST_ONLY_KEY)),
                                             encoding="utf-8")
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        fake = self.default_jobber()
        fake.refresh["TEST-ID-150"] = {"__raw__": {
            "data": {"job": {"id": "TEST-ID-150", "jobNumber": 150, "jobStatus": "requires_invoicing",
                             "total": None, "uninvoicedTotal": None}},
            "errors": [{"message": "total: access denied"}]}}
        self.run_main(fake, STAGES_TEXT)
        self.assertIn("carry-forward: kept #150 closed in Jobber (work started, field work not done, refresh failed", self.log)
        self.assertNotIn("111.11", self.log)
        prices = S.decrypt_prices(json.loads((self.out / S.PRICES_NAME).read_text(encoding="utf-8")), TEST_ONLY_KEY)
        self.assertEqual(prices["150"], {"t": 111.11})

    def test_price_skips_are_warnings_only_when_a_key_is_set(self):
        self.run_main(self.default_jobber(), "{}")
        self.assertIn("prices: skipped (PRICE_KEY not set)", self.log)
        self.assertNotIn("::warning::prices", self.log)
        os.environ["PRICE_KEY"] = "not-a-real-key"
        self.run_main(self.default_jobber(), "{}")
        self.assertIn("::warning::prices: skipped (PRICE_KEY invalid", self.log)
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        with mock.patch.dict(sys.modules, {"cryptography": None}):
            self.run_main(self.default_jobber(), "{}")
        self.assertIn("::warning::prices: skipped (cryptography package not installed)", self.log)

    def test_hand_edited_previous_record_does_not_crash_half_way(self):
        prev = fixture("sync_prev_jobs.json")
        rec150 = next(r for r in prev if r["jobNumber"] == 150)
        for k in ("ok", "clientKey", "street"): del rec150[k]
        (self.out / S.JOBS_NAME).write_text(json.dumps(prev), encoding="utf-8")
        self.assertEqual(self.run_main(self.default_jobber(), STAGES_TEXT), 0)
        rec = self.closed_out()[150]
        self.assertEqual((rec["clientKey"], rec["street"], rec["ok"]), ("Crown", "", False))   # re-derived from client
        self.assertNotIn("#150 (blank)", self.meta()["failed"], "meta failed/mapped/total describe jobs.json only")

    def test_null_job_node_writes_nothing(self):
        before = {n: (self.out / n).read_bytes() for n in (S.JOBS_NAME, S.CACHE_NAME)}
        pages = fixture("sync_jobber_pages.json")["pages"]
        pages[0]["data"]["jobs"]["nodes"].append(None)
        pages[0]["errors"] = [{"message": "Cannot return null for non-nullable field Job.title"}]
        with self.assertRaises(S.JobberError):
            self.run_main(FakeJobber(pages), "{}")
        for n, b in before.items(): self.assertEqual((self.out / n).read_bytes(), b, n)
        self.assertFalse((self.out / S.META_NAME).exists())
        self.assertFalse((self.out / S.ARCHIVE_NAME).exists())


class DuplicateKeys(unittest.TestCase):
    """Keys that clean to the same job: exact key wins, else the last variant in file order (matches js/stages.js)."""
    def test_exact_key_wins_either_order(self):
        for raw in ('{"version":2,"stages":{"684":{"stage":"base"}," 684":{"stage":"prep"}}}',
                    '{"version":2,"stages":{" 684":{"stage":"prep"},"684":{"stage":"base"}}}'):
            entries, why = S.parse_stages_text(raw)
            self.assertEqual(why, "ok")
            self.assertEqual(entries["684"], {"stage": "base"}, raw)

    def test_last_variant_wins_without_exact_key(self):
        entries, _ = S.parse_stages_text('{"version":2,"stages":{" 684":{"stage":"prep"},"684 ":{"stage":"poured"}}}')
        self.assertEqual(entries["684"], {"stage": "poured"})


# ----------------------------------------------------------------------------- beta channel (r2-plan §9)
def beta_doc(entries):
    return json.dumps({"version": 2, "stages": entries})

def v1_with(**entries):
    """V1_TEXT with entries replaced (keys are "_<jobNumber>"; None removes the entry)."""
    doc = json.loads(V1_TEXT)
    for k, v in entries.items():
        if v is None: doc["stages"].pop(k.lstrip("_"), None)
        else: doc["stages"][k.lstrip("_")] = v
    return json.dumps(doc)


class OverlayUnit(unittest.TestCase):
    """Contract rule 2 (merge of stages-beta.json with v1's stages.json). Vectors shared with js/stages.js."""
    def test_overlay_vectors(self):
        doc = fixture("overlay_vectors.json")
        self.assertGreaterEqual(len(doc["vectors"]), 25)
        for v in doc["vectors"]:
            with self.subTest(v["name"]):
                before = json.dumps(v["state"])
                merged = S.merge_entry(v["state"], v["overlay"])
                eff = S.effective(merged, None)
                self.assertEqual(eff["stage"], v["stage"])
                self.assertEqual(eff, v["effective"])
                self.assertEqual(S.keep_when_closed(eff), v["keepWhenClosed"])
                src = "overlay" if merged is not v["state"] else ("state" if v["state"] is not None else "none")
                self.assertEqual(src, v["stageFrom"])
                self.assertEqual(json.dumps(v["state"]), before, "merge must not mutate the state entry")

    def test_times(self):
        for t in fixture("overlay_vectors.json")["times"]:
            with self.subTest(t["s"]): self.assertEqual(S.parse_time(t["s"]), t["ms"])
        for bad in ("2026-09-20", "2026-09-20T10:00:00", "2026-13-01T00:00:00Z", "2026-09-20T10:00:00Z\n", True):
            with self.subTest(bad=bad): self.assertIsNone(S.parse_time(bad))

    def test_merge_entries_covers_both_files(self):
        state = {"1": {"stage": "base", "sat": "2026-09-21T00:00:00Z"}, "2": {"cut": "req"}}
        overlay = {"2": {"stage": "prep", "at": "2026-09-20T00:00:00Z"}, "3": {"stage": "poured"}, "4": {"stage": "?"}}
        m = S.merge_entries(state, overlay)
        self.assertEqual(m, {"1": {"stage": "base", "sat": "2026-09-21T00:00:00Z"}, "2": {"cut": "req", "stage": "prep"},
                             "3": {"stage": "poured"}})
        self.assertEqual(state["2"], {"cut": "req"}, "inputs untouched")

    def test_overlay_unclear(self):
        self.assertTrue(S.overlay_unclear(None, {"stage": "setup2", "at": "2026-09-20T00:00:00Z"}))
        self.assertTrue(S.overlay_unclear({"sat": "2026-09-19T00:00:00Z"}, {"stage": "setup2", "at": "2026-09-20T00:00:00Z"}))
        self.assertFalse(S.overlay_unclear({"sat": "2026-09-21T00:00:00Z"}, {"stage": "setup2", "at": "2026-09-20T00:00:00Z"}),
                         "the beta set the stage later: the v1 value would not have been used")
        self.assertFalse(S.overlay_unclear(None, {"stage": "base"}))
        self.assertFalse(S.overlay_unclear(None, {"at": "2026-09-20T00:00:00Z"}), "no stage value at all")
        self.assertFalse(S.overlay_unclear(None, None))
        self.assertTrue(S.overlay_unclear(None, 5))

    def test_carry_forward_with_overlay(self):
        prev = [{"jobNumber": n, "client": "Crown Pipeline Ltd.", "hints": {}} for n in (1, 2, 3, 4, 5)]
        state = {"1": {"stage": "poured", "cleanup": "done", "sat": "2026-09-21T00:00:00Z"},   # beta newer: done
                 "2": {"stage": "poured", "cleanup": "done", "sat": "2026-09-19T00:00:00Z"},   # v1 newer: base
                 "3": {"removed": True},
                 "4": {"asphalt": "req", "sat": "2026-09-19T00:00:00Z"}}                       # v1 ready (no entry)
        overlay = {"1": {"stage": "base", "at": "2026-09-20T00:00:00Z"}, "2": {"stage": "base", "at": "2026-09-20T00:00:00Z"},
                   "3": {"stage": "excavation", "at": "2026-09-20T00:00:00Z"}}
        kept, dropped = S.carry_forward(prev, set(), set(), state, overlay=overlay)
        self.assertEqual(sorted(r["jobNumber"] for r in kept), [1, 2, 4, 5], "R-3: only removed drops a job")
        self.assertEqual(dropped, [(3, "removed in app")])
        why = {r["jobNumber"]: r["_why"] for r in kept}
        self.assertEqual((why[1], why[2], why[5]), ("waiting for Completed in the app (field work done)",
                                                    "work started, field work not done",
                                                    "waiting for Completed in the app (nothing outstanding)"))

    def test_fetch_stages_404(self):
        def raiser(code):
            def f(url, timeout=20): raise urllib.error.HTTPError(url, code, "x", {}, None)
            return f
        with mock.patch.object(S, "_http_text", raiser(404)):
            self.assertEqual(S.fetch_stages((S.STATE_RAW_BASE + S.STAGES_BETA_FILE), missing_ok=True), ({}, "not found (no entries yet)"))
            self.assertEqual(S.fetch_stages(S.STAGES_RAW_URL), (None, "fetch failed (HTTP 404)"), "v1 file: 404 = failure")
        with mock.patch.object(S, "_http_text", raiser(500)):
            self.assertEqual(S.fetch_stages((S.STATE_RAW_BASE + S.STAGES_BETA_FILE), missing_ok=True), (None, "fetch failed (HTTP 500)"))


class DualMode:
    """Mixin: runs a SyncTestCase in dual-file mode (the beta trial, S.BETA_STATE_FILE = "stages-beta.json"), the path
    the single BETA_STATE_FILE switch turns back on (rollback)."""
    def setUp(self):
        super().setUp()
        p = mock.patch.object(S, "BETA_STATE_FILE", S.STAGES_BETA_FILE)
        p.start(); self.addCleanup(p.stop)


class ClosedJobsFiles(SyncTestCase):
    """closed_jobs.json handling, the same in either mode (single-file here, dual-file in ClosedJobsFilesDual)."""
    STAGES = STAGES_TEXT

    def test_migrates_closed_records_out_of_the_previous_jobs_json(self):
        self.assertTrue(any(r.get("closed") for r in fixture("sync_prev_jobs.json")), "fixture: #155 is closed:true")
        self.run_main(self.default_jobber(), self.STAGES)
        self.assertNotIn(155, self.jobs_out())
        self.assertIs(self.closed_out()[155]["closed"], True)
        self.assertEqual(self.closed_out()[155]["title"], "Already closed last run")

    def test_previous_closed_jobs_come_from_closed_jobs_json(self):
        rec = dict(next(r for r in fixture("sync_prev_jobs.json") if r["jobNumber"] == 150), closed=True)
        rec["title"] = "from closed_jobs.json"
        prev = [r for r in fixture("sync_prev_jobs.json") if r["jobNumber"] not in (150, 155)]
        (self.out / S.JOBS_NAME).write_text(json.dumps(prev), encoding="utf-8")
        (self.out / S.CLOSED_NAME).write_text(json.dumps([rec]), encoding="utf-8")
        self.run_main(self.default_jobber(), self.STAGES)
        closed = self.closed_out()
        self.assertEqual(sorted(closed), [150, 151, 152, 154, 156])     # 155 is in neither previous file any more
        self.assertEqual(closed[150]["title"], "from closed_jobs.json")
        self.assertEqual(closed[150]["status"], "requires_invoicing", "still refreshed from Jobber")

    def test_closed_job_active_again_leaves_closed_jobs_json(self):
        self.run_main(self.default_jobber(), self.STAGES)
        self.assertIn(150, self.closed_out())
        pages = fixture("sync_jobber_pages.json")["pages"]
        back = json.loads(json.dumps(pages[0]["data"]["jobs"]["nodes"][0]))
        back.update({"id": "TEST-ID-150", "jobNumber": 150, "title": "active again"})
        pages[0]["data"]["jobs"]["nodes"].append(back)
        self.run_main(FakeJobber(pages, refresh=self.default_jobber().refresh), self.STAGES)
        self.assertIn(150, self.jobs_out()); self.assertNotIn("closed", self.jobs_out()[150])
        self.assertNotIn(150, self.closed_out())

    def test_unreadable_closed_jobs_file_never_stops_the_job_sync(self):
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        files = ((S.CLOSED_NAME, "{broken"), (S.ARCHIVE_NAME, "ARCHIVE"), (S.PRICES_NAME, "PRICES"))
        for name, text in files: (self.out / name).write_text(text, encoding="utf-8")
        self.assertEqual(self.run_main(self.default_jobber(), self.STAGES), 0)
        self.assertEqual(sorted(self.jobs_out()), [201, 202, 203, 9001], "jobs.json still updated for v1")
        for name, text in files:
            self.assertEqual((self.out / name).read_text(encoding="utf-8"), text, f"{name} untouched")
        self.assertIn("::warning::carry-forward: closed_jobs.json unreadable (JSONDecodeError)", self.log)
        self.assertIn("::warning::prices: skipped (closed_jobs.json unreadable", self.log)
        self.assertEqual(self.fetched, [], "no stage files needed")
        meta = self.meta()
        self.assertEqual(meta["total"], 4)
        self.assertIn("closed_jobs.json unreadable", meta["stages_read"])

    def test_closed_jobs_file_not_a_list_is_unreadable(self):
        (self.out / S.CLOSED_NAME).write_text('{"jobs": []}', encoding="utf-8")
        self.run_main(self.default_jobber(), self.STAGES)
        self.assertIn("::warning::carry-forward: closed_jobs.json is not a list", self.log)
        self.assertEqual((self.out / S.CLOSED_NAME).read_text(encoding="utf-8"), '{"jobs": []}')

    def test_prices_cover_active_and_closed_jobs(self):
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        self.run_main(self.default_jobber(), self.STAGES)
        self.run_main(self.default_jobber(), self.STAGES)          # second run: closed jobs read from closed_jobs.json
        prices = S.decrypt_prices(json.loads((self.out / S.PRICES_NAME).read_text(encoding="utf-8")), TEST_ONLY_KEY)
        self.assertEqual(sorted(prices), ["150", "201", "202"])
        self.assertEqual(prices["150"], {"t": 27182.81, "u": 27182.81})


class ClosedJobsFilesDual(DualMode, ClosedJobsFiles):
    STAGES = V1_TEXT


class SingleFileMode(SyncTestCase):
    """The default since the version 2 promotion (r2-plan §9 "Promotion"): only stages.json (v2, items included)."""
    def test_default_is_single_file_mode(self):
        self.assertIsNone(S.BETA_STATE_FILE)
        self.assertEqual(S.stage_files(), ("stages.json",))
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertEqual([u.split("?")[0] for u in self.fetched], [S.STAGES_RAW_URL])
        self.assertIn("kept #156 closed in Jobber (stage entry not understood (kept to be safe)", self.log)
        self.assertIn("kept #155 closed in Jobber (work started", self.log)
        self.assertIn("kept #152 closed in Jobber (waiting for Completed in the app (field work done)", self.log)
        self.assertIn("kept #154 closed in Jobber (waiting for Completed in the app (nothing outstanding)", self.log)
        self.assertIn("dropped #153 (removed in app)", self.log)
        self.assertEqual(self.log.count("dropped #"), 1)
        meta = self.meta()
        self.assertEqual((meta["stages_read"], meta["stages_beta_read"], meta["stage_entries"]),
                         ("ok", "not read (single-file mode)", {"stages.json": 6}))

    def test_items_in_stages_json_decide(self):
        doc = json.loads(STAGES_TEXT)
        doc["stages"].update({
            "150": {"stage": "base", "removed": True, "at": "2026-09-22T10:00:00Z", "by": "PC"},   # removed wins
            "151": {"asphalt": "na", "at": "2026-09-22T10:00:00Z", "by": "PC"},                   # stored na beats the hint
            "152": {"stage": "poured", "at": "2026-09-22T10:00:00Z", "by": "PC"},                 # cleanup still to do
            "154": {"cut": "req", "sat": "2026-09-19T00:00:00Z"},                                 # a leftover sat: harmless
            "155": {"stage": "poured", "cleanup": "done", "asphalt": "req"},                       # asphalt still required
            "156": {"lane": {"s": "booked", "from": "2026-10-06"}}})                               # lane booked
        self.run_main(self.default_jobber(), json.dumps(doc))
        self.assertEqual(sorted(self.closed_out()), [151, 152, 154, 155, 156])
        self.assertIn("dropped #150 (removed in app)", self.log)
        self.assertIn("kept #151 closed in Jobber (waiting for Completed in the app (nothing outstanding)", self.log)
        self.assertIn("dropped #153 (removed in app)", self.log)

    def test_v1_shaped_entries_are_read_as_they_are(self):
        """A stage-only entry (the R-1 shape) is evaluated directly: no items means cleanup still to do; no removed
        flag means every job is kept (R-3)."""
        self.run_main(self.default_jobber(), V1_TEXT)
        self.assertEqual(sorted(self.closed_out()), ALL_CLOSED)
        self.assertIn("kept #154 closed in Jobber (waiting for Completed in the app (nothing outstanding)", self.log)
        self.assertNotIn("dropped", self.log)

    def test_stages_json_404_keeps_everything(self):
        self.run_main(self.default_jobber(), stages_exc=urllib.error.HTTPError(S.STAGES_RAW_URL, 404, "Not Found", {}, None))
        self.assertEqual(sorted(self.closed_out()), [150, 151, 152, 153, 154, 155, 156])
        self.assertIn("::warning::carry-forward: stages.json unreadable (fetch failed (HTTP 404))", self.log)
        self.assertNotIn("dropped", self.log)
        self.assertEqual(self.meta()["stages_read"], "fetch failed (HTTP 404)")

    def test_empty_stages_json_after_it_had_entries_keeps_everything(self):
        """The count guard (the beta file's in the trial) now protects stages.json, which carries the items: even
        with no closed jobs kept last run, an empty file after N entries is a reset or stale copy."""
        prev = [r for r in fixture("sync_prev_jobs.json") if r["jobNumber"] != 155]   # no closed:true record
        (self.out / S.JOBS_NAME).write_text(json.dumps(prev), encoding="utf-8")
        (self.out / S.META_NAME).write_text(json.dumps({"stage_entries": {"stages.json": 31, "stages-beta.json": 5}}),
                                            encoding="utf-8")
        self.run_main(self.default_jobber(), '{"version":2,"stages":{}}')
        self.assertEqual(sorted(self.closed_out()), [150, 151, 152, 153, 154, 156], "nothing dropped")
        self.assertNotIn("dropped", self.log)
        self.assertIn("::warning::carry-forward: stages.json unreadable (no entries at all, but it had 31 last run", self.log)
        self.assertEqual(self.meta()["stage_entries"], {"stages.json": 31}, "guard armed for the next run; beta count gone")
        self.run_main(self.default_jobber(), STAGES_TEXT)      # the file is back: normal decisions again
        self.assertNotIn("unreadable", self.log)
        self.assertEqual(sorted(self.closed_out()), [150, 151, 152, 154, 156])
        self.assertIn("dropped #153, which was closed in Jobber (removed in app)", self.log)
        self.assertEqual(self.meta()["stage_entries"], {"stages.json": 6})

    def test_empty_stages_json_while_closed_jobs_were_kept_keeps_them(self):
        self.run_main(self.default_jobber(), STAGES_TEXT)
        (self.out / S.META_NAME).write_text("{}", encoding="utf-8")   # no count: the closed-jobs guard alone
        self.run_main(self.default_jobber(), '{"version":2,"stages":{}}')
        self.assertEqual(sorted(self.closed_out()), KEPT)
        self.assertIn("::warning::carry-forward: stages.json unreadable (no entries at all, but closed jobs were kept",
                      self.log)

    def test_first_run_after_the_promotion(self):
        """Last run was the beta trial (dual-file mode); this run reads the promoted stages.json alone: same closed jobs,
        no warning, the beta count is forgotten, the archive carries over."""
        with mock.patch.object(S, "BETA_STATE_FILE", S.STAGES_BETA_FILE):
            self.run_main(self.default_jobber(), V1_TEXT)
        self.assertEqual(self.meta()["stage_entries"], {"stages.json": 6, "stages-beta.json": 5})
        trial = sorted(self.closed_out())
        self.run_main(self.default_jobber(), PROMOTED_TEXT)
        self.assertEqual(sorted(self.closed_out()), trial)
        self.assertEqual(trial, KEPT)
        self.assertNotIn("::warning::carry-forward", self.log)
        self.assertNotIn("dropped", self.log)
        meta = self.meta()
        self.assertEqual((meta["stages_beta_read"], meta["stage_entries"]), ("not read (single-file mode)", {"stages.json": 6}))
        arch = json.loads((self.out / S.ARCHIVE_NAME).read_text(encoding="utf-8"))["jobs"]
        self.assertEqual(sorted(r["jobNumber"] for r in arch), [153])

    def test_read_stage_files_unit(self):
        with mock.patch.object(S, "_http_text", lambda url, timeout=20: STAGES_TEXT):
            state, overlay, counts, notes = S.read_stage_files([], set(), {"stages.json": 3})
        self.assertEqual((sorted(state), overlay, counts, notes),
                         (["150", "152", "153", "155", "156", "201"], None, {"stages.json": 6}, {"stages.json": "ok"}))
        with mock.patch.object(S, "_http_text", lambda url, timeout=20: '{"stages":{}}'):
            state, overlay, counts, notes = S.read_stage_files([], set(), {"stages.json": 3})
        self.assertEqual((state, overlay, counts), (None, None, {}))
        self.assertIn("it had 3 last run", notes["stages.json"])
        with mock.patch.object(S, "_http_text", lambda url, timeout=20: '{"stages":{}}'):
            self.assertEqual(S.read_stage_files([], set(), {})[:3], ({}, None, {"stages.json": 0}), "a new store is fine")


class BetaChannel(DualMode, SyncTestCase):
    """Dual-file mode (the beta trial; S.BETA_STATE_FILE = "stages-beta.json"): stages-beta.json merged with v1's
    stages.json per contract rule 2."""
    NOT_FOUND = urllib.error.HTTPError((S.STATE_RAW_BASE + S.STAGES_BETA_FILE), 404, "Not Found", {}, None)

    def fresh_previous(self):
        shutil.copy(FIX / "sync_prev_jobs.json", self.out / S.JOBS_NAME)
        for name in (S.CLOSED_NAME, S.ARCHIVE_NAME, S.META_NAME): (self.out / name).unlink(missing_ok=True)

    def test_meta_shape_in_dual_mode(self):
        self.assertEqual(S.stage_files(), ("stages.json", "stages-beta.json"))
        self.run_main(self.default_jobber(), V1_TEXT)
        meta = self.meta()
        self.assertEqual((meta["stages_read"], meta["stages_beta_read"]), ("ok", "ok"))
        self.assertEqual(meta["stage_entries"], {"stages.json": 6, "stages-beta.json": 5})

    def test_reads_both_files_and_jobs_json_keeps_r1_membership(self):
        self.run_main(self.default_jobber(), V1_TEXT)
        self.assertEqual(sorted(u.split("?")[0] for u in self.fetched), sorted([S.STAGES_RAW_URL, (S.STATE_RAW_BASE + S.STAGES_BETA_FILE)]))
        jobs = self.jobs_out()
        self.assertEqual(sorted(jobs), [201, 202, 203, 9001])
        for r in jobs.values(): self.assertNotIn("closed", r)
        closed = self.closed_out()
        self.assertEqual(sorted(closed), KEPT)
        for r in closed.values(): self.assertIs(r["closed"], True)
        self.assertIn("kept #150 closed in Jobber (work started", self.log)
        self.assertIn("kept #156 closed in Jobber (stages.json entry not understood", self.log)
        self.assertIn("kept #152 closed in Jobber (waiting for Completed in the app (field work done)", self.log)
        self.assertIn("dropped #153 (removed in app)", self.log)
        arch = json.loads((self.out / S.ARCHIVE_NAME).read_text(encoding="utf-8"))["jobs"]
        self.assertEqual(sorted(r["jobNumber"] for r in arch), [153])

    def test_beta_file_404_is_empty_not_a_failure(self):
        self.run_main(self.default_jobber(), V1_TEXT, beta_exc=self.NOT_FOUND)
        # v1 alone decides the stages; v1 carries no items (no removed flag), so every job stays (R-3)
        self.assertEqual(sorted(self.closed_out()), ALL_CLOSED)
        self.assertIn("kept #154 closed in Jobber (waiting for Completed in the app (nothing outstanding)", self.log)
        self.assertNotIn("dropped", self.log)
        self.assertNotIn("stages-beta.json unreadable", self.log)
        meta = self.meta()
        self.assertEqual((meta["stages_read"], meta["stages_beta_read"]), ("ok", "not found (no entries yet)"))
        self.assertEqual(meta["stage_entries"], {"stages.json": 6, "stages-beta.json": 0})

    def test_beta_file_read_failure_keeps_everything(self):
        for exc in (urllib.error.URLError("offline"), http_error(500), http_error(403)):
            with self.subTest(exc=str(exc)):
                self.fresh_previous()
                self.run_main(self.default_jobber(), V1_TEXT, beta_exc=exc)
                self.assertEqual(sorted(self.closed_out()), [150, 151, 152, 153, 154, 155, 156])
                self.assertIn("::warning::carry-forward: stages-beta.json unreadable (fetch failed", self.log)
                self.assertNotIn("dropped", self.log)

    def test_damaged_beta_file_keeps_everything(self):
        for text in ("{oops", '{"version": 3, "stages": {}}', '{"stages": []}', ""):
            with self.subTest(text=text):
                self.fresh_previous()
                self.run_main(self.default_jobber(), V1_TEXT, beta_text=text)
                self.assertEqual(sorted(self.closed_out()), [150, 151, 152, 153, 154, 155, 156])
                self.assertIn("stages-beta.json unreadable", self.log)

    def test_v1_file_404_keeps_everything(self):
        self.run_main(self.default_jobber(), stages_exc=urllib.error.HTTPError(S.STAGES_RAW_URL, 404, "Not Found", {}, None))
        self.assertEqual(sorted(self.closed_out()), [150, 151, 152, 153, 154, 155, 156])
        self.assertIn("::warning::carry-forward: stages.json unreadable (fetch failed (HTTP 404))", self.log)

    def test_sat_rule_end_to_end(self):
        v1 = v1_with(_150={"stage": "base", "at": "2026-09-20T10:00:00Z", "by": "PC"})
        done = {"stage": "poured", "cleanup": "done"}
        # R-3: kept either way (nothing is removed); the merged stage decides the reason
        cases = [(dict(done, sat="2026-09-21T10:00:00Z"), False),   # beta set the stage after v1: field work done
                 (dict(done, sat="2026-09-19T10:00:00Z"), True),    # v1 moved it later: base, work in progress
                 (dict(done, sat="2026-09-20T10:00:00Z"), False),   # same instant: beta stage
                 (dict(done), True)]                                # no sat: v1 stage
        for entry, in_progress in cases:
            with self.subTest(entry=entry):
                self.fresh_previous()
                self.run_main(self.default_jobber(), v1, beta_text=beta_doc({"150": entry}))
                self.assertIn(150, self.closed_out())
                why = "work started, field work not done" if in_progress else "waiting for Completed in the app (field work done)"
                self.assertIn(f"kept #150 closed in Jobber ({why}", self.log)

    def test_items_come_only_from_the_beta_file(self):
        # v1 file carrying items (a hand edit): ignored; the beta's asphalt na beats #151's asphalt hint
        v1 = v1_with(_152={"stage": "poured", "cleanup": "done", "at": "2026-09-20T10:00:00Z"}, _154=None)
        beta = beta_doc({"151": {"asphalt": "na", "sat": "2026-09-21T00:00:00Z"},
                         "154": {"cut": "req", "sat": "2026-09-21T00:00:00Z"}})
        self.run_main(self.default_jobber(), v1, beta_text=beta)
        closed = self.closed_out()
        self.assertIn(152, closed)
        self.assertIn("kept #152 closed in Jobber (work started", self.log, "cleanup from v1's file is ignored")
        self.assertIn(151, closed)
        self.assertIn("kept #151 closed in Jobber (waiting for Completed in the app (nothing outstanding)", self.log,
                      "stored asphalt na beats the hint")
        self.assertIn("kept #154 closed in Jobber (work started", self.log, "street cut required in the beta")

    def test_removed_in_beta_beats_a_newer_v1_stage(self):
        self.run_main(self.default_jobber(), v1_with(_153={"stage": "prep", "at": "2026-09-25T10:00:00Z"}))
        self.assertNotIn(153, self.closed_out())
        self.assertIn("dropped #153 (removed in app)", self.log)

    def test_unclear_v1_stage_older_than_beta_sat_is_not_named(self):
        """R-3: kept either way; the odd v1 value would not have been used, so the reason is the beta's."""
        beta = json.loads(BETA_TEXT); beta["stages"]["156"] = {"assess": "virtual", "sat": "2026-09-21T00:00:00Z"}
        self.run_main(self.default_jobber(), V1_TEXT, beta_text=json.dumps(beta))
        self.assertIn(156, self.closed_out())
        self.assertIn("kept #156 closed in Jobber (waiting for Completed in the app (nothing outstanding)", self.log)

    def test_empty_beta_file_after_it_had_entries_keeps_everything(self):
        self.run_main(self.default_jobber(), V1_TEXT)
        self.assertEqual(self.meta()["stage_entries"]["stages-beta.json"], 5)
        for kw in ({"beta_text": '{"version":2,"stages":{}}'}, {"beta_exc": self.NOT_FOUND}):
            with self.subTest(case=str(kw)):
                shutil.copy(FIX / "sync_prev_jobs.json", self.out / S.JOBS_NAME)
                self.run_main(self.default_jobber(), V1_TEXT, **kw)
                # without the guard #153's "removed" would be forgotten (it would come back)
                self.assertEqual(sorted(self.closed_out()), [150, 151, 152, 153, 154, 155, 156], "nothing dropped")
                self.assertNotIn("dropped", self.log)
                self.assertIn("::warning::carry-forward: stages-beta.json unreadable (no entries at all, but it had 5",
                              self.log)
                self.assertEqual(self.meta()["stage_entries"]["stages-beta.json"], 5, "the guard survives the next run")
        self.run_main(self.default_jobber(), V1_TEXT)      # the file is back: normal decisions again
        self.assertNotIn("unreadable", self.log)

    def test_first_run_on_main_data_with_no_closed_files(self):
        """main's data/: an R-1 jobs.json (no closed, no hints, no id) and no closed_jobs.json / stages-beta.json."""
        prev = [{k: v for k, v in r.items() if k not in ("closed", "hints", "id")}
                for r in fixture("sync_prev_jobs.json")]
        (self.out / S.JOBS_NAME).write_text(json.dumps(prev), encoding="utf-8")
        self.run_main(self.default_jobber(), V1_TEXT, beta_exc=self.NOT_FOUND)
        self.assertEqual(sorted(self.jobs_out()), [201, 202, 203, 9001])
        self.assertEqual(sorted(self.closed_out()), ALL_CLOSED)
        self.assertIsNone(self.closed_out()[150]["id"], "no id yet: not refreshed, previous values kept")


# ----------------------------------------------------------------------------- R-3 (docs/r3-plan.md A, E)
class R3KeepUntilRemoved(SyncTestCase):
    """A: a job that left Jobber's active list stays until its stage entry has removed: true."""
    def archive(self):
        return {r["jobNumber"]: r for r in json.loads((self.out / S.ARCHIVE_NAME).read_text(encoding="utf-8"))["jobs"]}

    def test_closed_job_with_nothing_outstanding_is_kept_not_dropped(self):
        self.run_main(self.default_jobber(), stages_with(_152={"stage": "poured", "cleanup": "done"}, _154=None))
        closed = self.closed_out()
        for jn in (152, 154):
            self.assertIn(jn, closed); self.assertIs(closed[jn]["closed"], True)
        self.assertIn("kept #152 closed in Jobber (waiting for Completed in the app (field work done)", self.log)
        self.assertIn("kept #154 closed in Jobber (waiting for Completed in the app (nothing outstanding)", self.log)
        self.assertNotIn(152, self.archive()); self.assertNotIn(154, self.archive())
        self.run_main(self.default_jobber(), stages_with(_152={"stage": "poured", "cleanup": "done"}, _154=None))
        self.assertEqual(sorted(self.closed_out()), KEPT, "still there on the next run")

    def test_removed_goes_to_the_archive(self):
        self.run_main(self.default_jobber(), stages_with(_152={"stage": "poured", "cleanup": "done", "removed": True}))
        self.assertNotIn(152, self.all_out())
        arch = self.archive()
        self.assertEqual(sorted(arch), [152, 153])
        self.assertEqual((arch[152]["droppedWhy"], arch[153]["droppedWhy"]), ("removed in app", "removed in app"))
        self.assertEqual(arch[152]["droppedAt"], S.datetime.now(S.timezone.utc).date().isoformat())
        self.assertEqual(arch[152]["street"], "152 Test Ave")

    def test_restore_after_removed_is_cleared(self):
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertIn(153, self.archive()); self.assertNotIn(153, self.all_out())
        self.run_main(self.default_jobber(), stages_with(_153={"stage": "excavation", "at": "2026-09-30T10:00:00Z"}))
        self.assertIn(153, self.closed_out())
        self.assertIs(self.closed_out()[153]["closed"], True)
        self.assertNotIn("droppedWhy", self.closed_out()[153])
        self.assertIn("kept #153 closed in Jobber (restored from closed_archive.json: work started", self.log)
        self.assertNotIn(153, self.archive())

    def test_job_archived_under_the_r2_rule_comes_back_at_the_first_r3_sync(self):
        """closed_archive.json from an R-2 sync (droppedWhy "field work done"): not removed -> restored for the OK popup."""
        rec = dict(next(r for r in fixture("sync_prev_jobs.json") if r["jobNumber"] == 152),
                   droppedAt=date.today().isoformat(), droppedWhy="field work done")
        (self.out / S.JOBS_NAME).write_text(json.dumps([r for r in fixture("sync_prev_jobs.json") if r["jobNumber"] != 152]),
                                            encoding="utf-8")
        (self.out / S.ARCHIVE_NAME).write_text(json.dumps({"version": 1, "days": 60, "jobs": [rec]}), encoding="utf-8")
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertIn(152, self.closed_out())
        self.assertNotIn("droppedAt", self.closed_out()[152])
        self.assertIn("restored from closed_archive.json: waiting for Completed in the app (field work done)", self.log)

    def test_pending_jobs_untouched(self):
        """Pending manual (9000+) jobs are never carried forward or archived, even with removed: true."""
        self.run_main(self.default_jobber(), stages_with(_9001={"removed": True}, _9002={"stage": "base"}))
        self.assertIn(9001, self.jobs_out()); self.assertTrue(self.jobs_out()[9001]["pending"])
        self.assertNotIn("closed", self.jobs_out()[9001])
        self.assertNotIn(9001, self.closed_out())
        self.assertNotIn(9002, self.all_out(), "a pending job that left pending_manual.json is not a closed job")
        self.assertFalse({9001, 9002} & set(self.archive()))

    def test_read_failure_and_reset_guards_still_keep_everything_and_restore_nothing(self):
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertIn(153, self.archive())
        for kw in ({"stages_exc": urllib.error.URLError("offline")}, {"stages_text": '{"version":2,"stages":{}}'},
                   {"stages_text": "{oops"}, {"stages_text": '{"version":3,"stages":{}}'}):
            with self.subTest(case=str(kw)):
                self.run_main(self.default_jobber(), **kw)
                self.assertEqual(sorted(self.closed_out()), KEPT, "nothing dropped")
                self.assertNotIn(153, self.all_out(), "a removed job is not restored by an unreadable / reset store")
                self.assertIn(153, self.archive())
                self.assertNotIn("dropped", self.log)

    def test_name_and_loc_in_entries_are_ignored(self):
        doc = json.loads(stages_with(_150={"stage": "base", "name": "Portage & Lipton", "loc": {"lat": 49.88, "lon": -97.28}},
                                     _154={"name": "x" * 500, "loc": "garbage"}))
        self.run_main(self.default_jobber(), json.dumps(doc))
        closed = self.closed_out()
        self.assertEqual(sorted(closed), KEPT)
        self.assertEqual((closed[150]["street"], closed[150]["lat"]), ("150 Test Ave", 49.8), "the sync never applies name/loc")
        self.assertNotIn("name", closed[150]); self.assertNotIn("loc", closed[150])
        self.assertIn("kept #154 closed in Jobber (waiting for Completed in the app (nothing outstanding)", self.log)


class R3RangeStreetsUnit(unittest.TestCase):
    def test_parse_range_street(self):
        cases = {
            "Portage Ave (Lipton St to Lenore St)": ("Portage Ave", "Lipton St", "Lenore St"),
            "Colony St [Portage Av to Webb Pl]": ("Colony St", "Portage Av", "Webb Pl"),
            "Main St [1st St NW to Railway St S]": ("Main St", "1st St NW", "Railway St S"),
            "Pembina Hwy (Adamar Rd TO Plaza Dr)": ("Pembina Hwy", "Adamar Rd", "Plaza Dr"),
            "  Princess St  (William Ave  to  Elgin Ave) ": ("Princess St", "William Ave", "Elgin Ave"),
            "St Mary's Rd (Fermor Ave to St Anne&amp;s Rd)": ("St Mary's Rd", "Fermor Ave", "St Anne&s Rd"),
            "Portage Ave (Lipton St to Lenore St) Rear Lane": ("Portage Ave", "Lipton St", "Lenore St"),
            "2nd St (Toronto St to Ontario St)": ("2nd St", "Toronto St", "Ontario St"),
        }
        for raw, want in cases.items():
            with self.subTest(raw=raw): self.assertEqual(S.parse_range_street(raw), want)
        for raw in ("905 Portage Ave (Arlington St to Burnell St)", "12A Main St (A St to B St)",
                    "10-12 Main St (A St to B St)", "1 St NW (A St to B St)",       # a house number: not a range street
                    "Portage Ave (100 to 200)",                                      # house-number range
                    "Watt St and Munroe Ave (505 Munroe Ave)", "Brandon Ave and Osborne St (back lane)",
                    "Watt St and Munroe Ave (A St to B St)", "Watt St &amp; Munroe Ave (A St to B St)", "Portage Ave & Harris Blvd [A St to B St]",
                    "15 Barnes St (Barnes Av & Cornerstone Ht)", "Portage Ave", "", None,
                    "(Lipton St to Lenore St)", "Portage Ave ( to Lenore St)", "Portage Ave (Lipton St to )",
                    "Portage Ave (Lipton St - Lenore St)", "Portage Ave (Lipton St to Lenore St]"):
            with self.subTest(raw=raw): self.assertIsNone(S.parse_range_street(raw))

    def test_distance_km(self):
        self.assertAlmostEqual(S.distance_km([49.88, -97.20], [49.88, -97.20]), 0.0)
        self.assertAlmostEqual(S.distance_km([49.88, -97.20], [49.89, -97.20]), 1.112, places=2)

    def test_geocode_range_uses_the_cache_format(self):
        k = lambda s: f"{s}, Winnipeg, MB, Canada"
        cache = {k("Portage Ave & Lipton St"): [49.8810, -97.1880], k("Portage Ave & Lenore St"): [49.8816, -97.1840],
                 k("Pembina Hwy & Adamar Rd"): [49.8000, -97.1500], k("Pembina Hwy & Plaza Dr"): [49.8400, -97.1500],
                 k("Colony St & Webb Pl"): [49.8890, -97.1510]}
        with contextlib.redirect_stdout(io.StringIO()):
            c, how, calls = S.geocode_range(cache, "Portage Ave", "Lipton St", "Lenore St", "Winnipeg", None)
            self.assertEqual((c, how, calls), ([49.8813, -97.186], "midpoint", 0))
            c, how, _ = S.geocode_range(cache, "Pembina Hwy", "Adamar Rd", "Plaza Dr", "Winnipeg", None)   # 4.4 km apart
            self.assertEqual((c, how), ([49.8000, -97.1500], "Pembina Hwy & Adamar Rd (Plaza Dr end too far)"))
            c, how, _ = S.geocode_range(cache, "Colony St", "Portage Av", "Webb Pl", "Winnipeg", None)       # A not found
            self.assertEqual((c, how), ([49.8890, -97.1510], "Colony St & Webb Pl (Portage Av end not found)"))
            self.assertEqual(S.geocode_range(cache, "Nowhere St", "A St", "B St", "Winnipeg", None), (None, "not found", 0))


class R3RangeStreetsEndToEnd(SyncTestCase):
    """E: range streets through main() with a mocked TomTom geocoder (no network)."""
    TOMTOM = {   # made-up coordinates inside the Manitoba box
        "Portage Ave & Lipton St, Winnipeg, MB, Canada": (49.8810, -97.1880),
        "Portage Ave & Lenore St, Winnipeg, MB, Canada": (49.8816, -97.1840),   # ~0.3 km: midpoint
        "Colony St & Portage Av, Winnipeg, MB, Canada": (49.8880, -97.1515),
        "Pembina Hwy & Adamar Rd, Winnipeg, MB, Canada": (49.8000, -97.1500),
        "Pembina Hwy & Plaza Dr, Winnipeg, MB, Canada": (49.8400, -97.1500),    # ~4.4 km: too far apart
        "905 Portage Ave, Winnipeg, MB, Canada": (49.8857, -97.1704),
    }
    TEST_ONLY_TOMTOM_KEY = "TEST-ONLY-TOMTOM-KEY"

    def jobber_with(self, streets):
        pages = fixture("sync_jobber_pages.json")["pages"]
        base = pages[0]["data"]["jobs"]["nodes"][0]
        for jn, street in streets.items():
            n = json.loads(json.dumps(base))
            n.update({"id": f"TEST-ID-{jn}", "jobNumber": jn, "title": f"Range test {jn}", "total": None,
                      "uninvoicedTotal": None, "lineItems": {"nodes": [], "pageInfo": {"hasNextPage": False}}})
            n["property"]["address"]["street1"] = street
            pages[0]["data"]["jobs"]["nodes"].append(n)
        jobber = FakeJobber(pages, refresh=self.default_jobber().refresh)
        self.geocoded = []
        def dispatch(url, data=None, headers=None, timeout=20):
            if url.startswith("https://api.tomtom.com/"):
                q = urllib.parse.unquote(url.split("/geocode/")[1].split(".json?")[0])
                self.geocoded.append(q)
                pos = self.TOMTOM.get(q)
                return {"results": [{"position": {"lat": pos[0], "lon": pos[1]}}]} if pos else {"results": []}
            return jobber(url, data, headers, timeout)
        return dispatch

    def run_ranges(self, streets, overrides=None):
        os.environ["TOMTOM_KEY"] = self.TEST_ONLY_TOMTOM_KEY
        if overrides is not None:
            (self.inp / S.OVERRIDES_NAME).write_text(json.dumps(overrides), encoding="utf-8")
        self.run_main(self.jobber_with(streets), STAGES_TEXT)
        self.assertNotIn(self.TEST_ONLY_TOMTOM_KEY, self.log, "the TomTom key is never printed")
        return self.jobs_out()

    def test_portage_and_lipton_gets_a_midpoint_pin(self):
        jobs = self.run_ranges({688: "Portage Ave (Lipton St to Lenore St)"})
        r = jobs[688]
        self.assertEqual((r["street"], r["range"], r["streetRaw"]),
                         ("Portage Ave & Lipton St", "Lipton St to Lenore St", "Portage Ave (Lipton St to Lenore St)"))
        self.assertEqual((r["lat"], r["lon"], r["ok"]), (49.8813, -97.186, True))
        cache = json.loads((self.out / S.CACHE_NAME).read_text(encoding="utf-8"))
        self.assertEqual(cache["Portage Ave & Lipton St, Winnipeg, MB, Canada"], [49.8810, -97.1880])
        self.assertEqual(cache["Portage Ave & Lenore St, Winnipeg, MB, Canada"], [49.8816, -97.1840])
        self.assertNotIn("Portage Ave, Winnipeg, MB, Canada", cache, "no generic street pin any more")
        self.assertIn("range: #688 Portage Ave & Lipton St (Lipton St to Lenore St) -> pin midpoint", self.log)
        self.assertEqual(self.meta()["geocode_api_calls"], 2)
        for jn in (201, 202, 203, 9001): self.assertNotIn("range", jobs[jn], "only range jobs carry the key")
        # second run: everything from the cache, same pin, no TomTom call
        jobs = self.run_ranges({688: "Portage Ave (Lipton St to Lenore St)"})
        self.assertEqual((jobs[688]["lat"], jobs[688]["lon"]), (49.8813, -97.186))
        self.assertEqual(self.geocoded, []); self.assertEqual(self.meta()["geocode_api_calls"], 0)

    def test_colony_street_falls_back_to_main_and_a(self):
        jobs = self.run_ranges({690: "Colony St [Portage Av to Webb Pl]"})   # "Colony St & Webb Pl" not found
        r = jobs[690]
        self.assertEqual((r["street"], r["range"]), ("Colony St & Portage Av", "Portage Av to Webb Pl"))
        self.assertEqual((r["lat"], r["lon"], r["ok"]), (49.8880, -97.1515, True))
        self.assertEqual(sorted(self.geocoded), ["Colony St & Portage Av, Winnipeg, MB, Canada",
                                                 "Colony St & Webb Pl, Winnipeg, MB, Canada"])
        self.assertIn("range: #690 Colony St & Portage Av (Portage Av to Webb Pl) -> pin Colony St & Portage Av", self.log)

    def test_far_apart_ends_fall_back_to_main_and_a(self):
        jobs = self.run_ranges({698: "Pembina Hwy (Adamar Rd to Plaza Dr)"})
        self.assertEqual((jobs[698]["street"], jobs[698]["lat"], jobs[698]["lon"]), ("Pembina Hwy & Adamar Rd", 49.8, -97.15))
        self.assertIn("(Plaza Dr end too far)", self.log)

    def test_neither_end_found_is_a_failed_job(self):
        jobs = self.run_ranges({699: "Nowhere St (A St to B St)"})
        r = jobs[699]
        self.assertEqual((r["street"], r["range"], r["lat"], r["ok"]), ("Nowhere St & A St", "A St to B St", None, False))
        self.assertIn("#699 Nowhere St & A St", self.meta()["failed"])

    def test_neither_end_found_falls_back_to_the_street_pin(self):
        self.TOMTOM = dict(self.TOMTOM, **{"Nowhere St, Winnipeg, MB, Canada": (49.9001, -97.1002)})
        jobs = self.run_ranges({699: "Nowhere St (A St to B St)"})
        r = jobs[699]
        self.assertEqual((r["street"], r["range"], r["lat"], r["lon"], r["ok"]),
                         ("Nowhere St & A St", "A St to B St", 49.9001, -97.1002, True))
        self.assertEqual(self.geocoded[-1], "Nowhere St, Winnipeg, MB, Canada")
        self.assertIn("-> pin Nowhere St (range ends not found, street pin)", self.log)
        self.assertEqual(self.meta()["failed"], [])

    def test_numbered_street_unchanged(self):
        jobs = self.run_ranges({665: "905 Portage Ave (Arlington St to Burnell St)"})
        r = jobs[665]
        self.assertEqual((r["street"], r["lat"], r["lon"]), ("905 Portage Ave", 49.8857, -97.1704))
        self.assertNotIn("range", r)
        self.assertEqual(self.geocoded, ["905 Portage Ave, Winnipeg, MB, Canada"])

    def test_street_override_still_wins(self):
        self.TOMTOM = dict(self.TOMTOM, **{"Portage Ave & Harris Blvd, Winnipeg, MB, Canada": (49.8791, -97.2772)})
        jobs = self.run_ranges({688: "Portage Ave (Lipton St to Lenore St)"}, overrides={"688": "Portage Ave & Harris Blvd"})
        r = jobs[688]
        self.assertEqual((r["street"], r["lat"], r["lon"]), ("Portage Ave & Harris Blvd", 49.8791, -97.2772))
        self.assertNotIn("range", r)
        self.assertEqual(self.geocoded, ["Portage Ave & Harris Blvd, Winnipeg, MB, Canada"])

    def test_hints_permit_and_prices_unchanged(self):
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        jobs = self.run_ranges({688: "Portage Ave (Lipton St to Lenore St)"})
        self.assertEqual(jobs[688]["permit"], "")
        self.assertEqual(jobs[688]["hints"], {"asphalt": False, "pavers": False})
        self.assertEqual(jobs[201]["hints"], {"asphalt": True, "pavers": False})
        prices = S.decrypt_prices(json.loads((self.out / S.PRICES_NAME).read_text(encoding="utf-8")), TEST_ONLY_KEY)
        self.assertEqual(sorted(prices), ["150", "201", "202"], "a job without totals has no price entry")


# ----------------------------------------------------------------------------- R-3.1 (r3-plan G)
def residential_rec(jn, client=None, **extra):
    """A previous jobs.json record of a residential job (old R-3 shape: clientKey "Other")."""
    rec = {"jobNumber": jn, "id": f"TEST-ID-{jn}", "client": client or f"Test Person {jn}", "clientKey": "Other",
           "street": f"{jn} Test Ave", "streetRaw": f"{jn} Test Ave", "city": "Winnipeg", "title": "Driveway",
           "permit": "", "status": "active", "unscheduled": False, "pending": False,
           "hints": {"asphalt": False, "pavers": False}, "lat": 49.8, "lon": -97.2, "ok": True}
    rec.update(extra)
    return rec


class R31CommercialClientsUnit(unittest.TestCase):
    """Contract 1: data/commercial_clients.json decides commercial; everyone else is residential."""

    def test_file_matches_the_contract_and_the_builtin_fallback(self):
        doc = json.loads((HERE.parent / "data" / S.CLIENTS_NAME).read_text(encoding="utf-8"))
        self.assertEqual(doc["version"], 1)
        self.assertEqual(doc["clients"], S.BUILTIN_COMMERCIAL_CLIENTS, "built-in fallback must equal the file")
        want = [("Crown", "Crown Pipeline", "Crown", ["crown pipeline"], "#2563eb"),
                ("Harris", "Harris Holdings", "Harris", ["harris holdings"], "#dc2626"),
                ("ACV", "ACV Sewer & Water", "ACV", ["acv sewer"], "#16a34a"),
                ("MyTec", "MyTec", "MyTec", ["mytec"], "#7c3aed"),
                ("NoLimits", "No Limits Underground", "No Limits", ["no limits underground"], "#0d9488"),
                ("AECON", "AECON", "AECON", ["aecon"], "#db2777"),
                ("Tricore", "Tricore", "Tricore", ["tricore"], "#475569")]
        got = [(c["key"], c["label"], c["short"], c["match"], c["color"]) for c in doc["clients"]]
        self.assertEqual(got[:7], want)
        swift = doc["clients"][7]
        self.assertEqual((len(got), swift["key"], swift["label"], swift["short"], swift["match"]),
                         (8, "Swift", "Swift Underground", "Swift", ["swift underground"]))
        colors = [c["color"].lower() for c in doc["clients"]]
        self.assertEqual(len(set(colors)), 8, "every client has its own colour")
        self.assertNotIn("#f59e0b", colors, "amber is the Residential colour")
        loaded, problem = S.load_commercial_clients(HERE.parent / "data" / S.CLIENTS_NAME)
        self.assertIsNone(problem)
        self.assertEqual(loaded, S.builtin_clients())

    def test_matching(self):
        K = lambda *names: S.commercial_key(*names)
        cases = [
            ("Crown Pipeline Ltd.", "Crown"), ("CROWN PIPELINE LTD", "Crown"), ("crown   pipeline", "Crown"),
            ("Crown Pipeline\tLtd.", "Crown"), ("  Crown Pipeline  ", "Crown"),
            ("Harris Holdings Ltd.", "Harris"), ("HARRIS  HOLDINGS", "Harris"),
            ("Gary Harris Builders", None),                         # "harris" alone is not Harris Holdings
            ("ACV Sewer & Water", "ACV"), ("ACV Sewer &amp; Water", "ACV"), ("acv sewer and water ltd", "ACV"),
            ("MyTec Industry Ltd", "MyTec"), ("MYTEC", "MyTec"), ("MyTech Solutions", None), ("SmyTec", None),
            ("No Limits Underground Ltd.", "NoLimits"), ("no limits  underground", "NoLimits"),
            ("AECON UTILITIES INC.", "AECON"), ("Aecon Group", "AECON"), ("Aeconomy Ltd", None),
            ("Tricore Contracting", "Tricore"), ("TRICORE", "Tricore"),
            ("Swift Underground Inc.", "Swift"), ("Swift Plumbing", None), ("Taylor Swift", None),
            ("Workers Compensation Board of Manitoba", None), ("Test Person 3", None), ("", None), (None, None),
        ]
        for name, key in cases:
            with self.subTest(name=name): self.assertEqual(K(name), key)
        # first match wins: list order (Crown before AECON), and companyName before name
        self.assertEqual(K("AECON / Crown Pipeline joint venture"), "Crown")
        self.assertEqual(K("Tricore", "Swift Underground"), "Tricore")
        self.assertEqual(K(None, "Swift Underground"), "Swift", "name is checked when companyName is empty")
        self.assertEqual(K("Gary Harris Builders", "Test Person"), None)
        custom = S.validate_commercial_clients({"version": 1, "clients": [
            {"key": "A", "label": "A", "short": "A", "match": ["pipe"], "color": "#000000"},
            {"key": "B", "label": "B", "short": "B", "match": ["crown pipe"], "color": "#111111"}]})
        self.assertEqual(S.commercial_key("Crown Pipe Co", clients=custom), "A", "first client in the file wins")

    def test_classify_record(self):
        rec = S.classify_record({"client": "Test Person", "clientKey": "Other"}, None)
        self.assertEqual((rec["clientKey"], rec["residential"]), ("Residential", True))
        rec = S.classify_record({"client": "AECON UTILITIES INC.", "clientKey": "Residential", "residential": True}, None)
        self.assertEqual(rec["clientKey"], "AECON")
        self.assertNotIn("residential", rec, "commercial records carry no residential key")

    def test_stored_records_keep_a_listed_commercial_clientkey(self):
        """A job matched on Jobber's `name` while active (client = companyName that matches nothing) stays commercial
        once it closes: carried / archived records trust a listed clientKey (like the app's classifyClient)."""
        rec = S.classify_stored({"client": "CPL", "clientKey": "Crown"}, None)
        self.assertEqual(rec["clientKey"], "Crown"); self.assertNotIn("residential", rec)
        for stored in ({"client": "CPL", "clientKey": "Other"}, {"client": "CPL", "clientKey": "Nope"},
                       {"client": "CPL", "clientKey": "Crown", "residential": True}, {"client": 5, "clientKey": 5}):
            with self.subTest(stored=stored):
                self.assertEqual(S.stored_client_key(stored, None), None)
        self.assertEqual(S.stored_client_key({"client": "Crown Pipeline Ltd.", "clientKey": "Crown", "residential": True},
                                             None), "Crown", "a stale residential flag still re-matches on client")
        prev = [residential_rec(170, client="CPL", clientKey="Crown")]
        prev[0].pop("residential", None)
        kept, dropped = S.carry_forward(prev, set(), set(), {})
        self.assertEqual(([r["jobNumber"] for r in kept], dropped), ([170], []), "waits for Completed, not auto-archived")
        self.assertEqual(kept[0]["clientKey"], "Crown"); self.assertNotIn("residential", kept[0])

    def test_fallback_when_missing_or_invalid(self):
        tmp = Path(tempfile.mkdtemp(prefix="ej_clients_")); self.addCleanup(shutil.rmtree, tmp, True)
        p = tmp / S.CLIENTS_NAME
        clients, problem = S.load_commercial_clients(p)
        self.assertEqual(clients, S.builtin_clients()); self.assertIn("not found", problem)
        good = {"key": "X", "label": "X Co", "short": "X", "match": ["x co"], "color": "#123456"}
        bad_docs = [
            "{oops", "[]", '"text"', json.dumps({"version": 2, "clients": [good]}),
            json.dumps({"version": True, "clients": [good]}), json.dumps({"version": 1, "clients": []}),
            json.dumps({"version": 1, "clients": {"X": good}}), json.dumps({"version": 1, "clients": [good, 5]}),
            json.dumps({"version": 1, "clients": [dict(good, key="bad key")]}),
            json.dumps({"version": 1, "clients": [dict(good, key="Residential")]}),
            json.dumps({"version": 1, "clients": [dict(good, key="other")]}),
            json.dumps({"version": 1, "clients": [dict(good, key="AllOther")]}),    # the app's "All other" chip key
            json.dumps({"version": 1, "clients": [good, dict(good, key="x")]}),       # key used twice
            json.dumps({"version": 1, "clients": [dict(good, label="")]}),
            json.dumps({"version": 1, "clients": [dict(good, short=None)]}),
            json.dumps({"version": 1, "clients": [dict(good, match=[])]}),
            json.dumps({"version": 1, "clients": [dict(good, match="x co")]}),
            json.dumps({"version": 1, "clients": [dict(good, match=["x co", "  "])]}),
            json.dumps({"version": 1, "clients": [dict(good, match=["x co", 5])]}),
            json.dumps({"version": 1, "clients": [dict(good, color="red")]}),
            json.dumps({"version": 1, "clients": [dict(good, color="#12345")]}),
        ]
        for text in bad_docs:
            with self.subTest(text=text):
                p.write_text(text, encoding="utf-8")
                clients, problem = S.load_commercial_clients(p)
                self.assertEqual(clients, S.builtin_clients())
                self.assertIn("invalid", problem)
        p.write_bytes(b"\xff\xfe\x00bad")
        self.assertEqual(S.load_commercial_clients(p)[0], S.builtin_clients())
        # a valid custom file is used as it is (match strings normalized), BOM tolerated
        p.write_text("﻿" + json.dumps({"version": 1, "clients": [dict(good, match=["  X   CO "])]}), encoding="utf-8")
        clients, problem = S.load_commercial_clients(p)
        self.assertIsNone(problem)
        self.assertEqual(clients, [dict(good, match=["x co"])])
        self.assertIsNone(S.commercial_key("Crown Pipeline Ltd.", clients=clients), "only the file's clients")

    def test_keep_flag(self):
        for entry, want in [(None, False), ("base", False), ({}, False), ({"keep": None}, False),
                            ({"keep": False}, False), ({"stage": "base"}, False), ({"keep": True}, True),
                            ({"keep": "yes"}, None), ({"keep": 1}, None), (5, None), ([1], None)]:
            with self.subTest(entry=entry): self.assertIs(S.keep_flag(entry), want)
        self.assertTrue(S.entry_unclear({"keep": "yes"}))
        self.assertFalse(S.entry_unclear({"keep": True})); self.assertFalse(S.entry_unclear({"keep": None}))

    def test_carry_forward_residential_rule(self):
        prev = [residential_rec(n) for n in (160, 161, 162, 163, 164, 165)] + [
            residential_rec(166, client="AECON UTILITIES INC.")]
        entries = {"161": {"keep": True}, "162": {"stage": "base", "asphalt": "req"},   # work started: still residential
                   "163": {"keep": True, "removed": True}, "164": {"keep": "yes"}, "165": "base"}
        kept, dropped = S.carry_forward(prev, set(), set(), entries)
        why = {r["jobNumber"]: r["_why"] for r in kept}
        self.assertEqual(sorted(why), [161, 164, 166])
        self.assertEqual(dropped, [(160, S.RESIDENTIAL_WHY), (162, S.RESIDENTIAL_WHY), (163, "removed in app"),
                                   (165, S.RESIDENTIAL_WHY)])
        self.assertEqual(S.RESIDENTIAL_WHY, "residential, closed in Jobber")
        self.assertEqual(why[161], "residential, kept in the app: waiting for Completed in the app (nothing outstanding)")
        self.assertEqual(why[164], "residential, keep value not understood (kept to be safe)")
        self.assertEqual(why[166], "waiting for Completed in the app (nothing outstanding)", "AECON is commercial")
        recs = {r["jobNumber"]: r for r in kept}
        self.assertEqual((recs[161]["clientKey"], recs[161]["residential"]), ("Residential", True))
        self.assertEqual(recs[166]["clientKey"], "AECON"); self.assertNotIn("residential", recs[166])
        # unreadable stage file: every candidate kept (residential too); archived residential jobs stay archived
        kept, dropped = S.carry_forward(prev, set(), set(), None, [residential_rec(170, droppedAt="2026-10-01")])
        self.assertEqual(sorted(r["jobNumber"] for r in kept), [160, 161, 162, 163, 164, 165, 166])
        self.assertEqual(dropped, [])
        # archived residential job: restored once keep is set, stays archived without it
        arch = [residential_rec(170, droppedAt="2026-10-01", droppedWhy=S.RESIDENTIAL_WHY)]
        self.assertEqual(S.carry_forward([], set(), set(), {"170": {"stage": "ready"}}, arch), ([], []))
        kept, _ = S.carry_forward([], set(), set(), {"170": {"keep": True}}, arch)
        self.assertEqual([r["jobNumber"] for r in kept], [170])
        self.assertTrue(kept[0]["_why"].startswith("restored from closed_archive.json: residential, kept in the app"))

    def test_dual_mode_reads_keep_from_the_state_entry(self):
        prev = [residential_rec(160), residential_rec(161)]
        state = {"160": {"keep": True, "sat": "2026-09-19T00:00:00Z"}}
        overlay = {"160": {"stage": "base", "at": "2026-09-20T00:00:00Z"},
                   "161": {"stage": "base", "at": "2026-09-20T00:00:00Z"}}
        kept, dropped = S.carry_forward(prev, set(), set(), state, overlay=overlay)
        self.assertEqual([r["jobNumber"] for r in kept], [160])
        self.assertEqual(dropped, [(161, S.RESIDENTIAL_WHY)])


class R31ResidentialEndToEnd(SyncTestCase):
    """Contracts 1 and 4 through main(): clientKey + residential flag on every record; closed residential jobs leave
    automatically unless their stage entry has keep: true."""
    def archive(self):
        return {r["jobNumber"]: r for r in json.loads((self.out / S.ARCHIVE_NAME).read_text(encoding="utf-8"))["jobs"]}

    def setUp(self):
        super().setUp()
        prev = fixture("sync_prev_jobs.json") + [
            residential_rec(160),                                   # was active last run, closed now, no keep
            residential_rec(161, closed=True),                      # kept by R-3 last run, keep set now
            residential_rec(162, client="Workers Compensation Board of Manitoba"),
            residential_rec(163, client="AECON UTILITIES INC."),    # an old "Other" record of a commercial client
            residential_rec(164, client="Crown Pipeline Ltd.", clientKey="Crown", residential=True)]   # stale flag
        (self.out / S.JOBS_NAME).write_text(json.dumps(prev), encoding="utf-8")

    def jobber(self, extra_node=None, **clients):
        """default_jobber with job clients replaced (_203={"name": .., "companyName": ..}) and optionally one more
        active job node."""
        doc = fixture("sync_jobber_pages.json")
        nodes = doc["pages"][-1]["data"]["jobs"]["nodes"]
        if extra_node:
            node = json.loads(json.dumps(nodes[-1])); node.update(extra_node); nodes.append(node)
        for page in doc["pages"]:
            for n in page["data"]["jobs"]["nodes"]:
                if f"_{n['jobNumber']}" in clients: n["client"] = dict(n["client"], **clients[f"_{n['jobNumber']}"])
        fake = self.default_jobber(); fake.pages = doc["pages"]
        return fake

    def test_active_and_pending_records_carry_clientkey_and_residential_flag(self):
        self.run_main(self.default_jobber(), STAGES_TEXT)
        jobs = self.jobs_out()
        self.assertEqual((jobs[201]["clientKey"], jobs[202]["clientKey"], jobs[9001]["clientKey"]), ("Crown", "Harris", "Crown"))
        for jn in (201, 202, 9001): self.assertNotIn("residential", jobs[jn])
        self.assertEqual((jobs[203]["client"], jobs[203]["clientKey"], jobs[203]["residential"]),
                         ("Test Person 3", "Residential", True))
        self.assertEqual(self.meta()["by_client"], {"Crown": 2, "Harris": 1, "Residential": 1})
        self.assertIn("clients: 8 commercial clients from commercial_clients.json", self.log)
        self.assertNotIn("::warning::clients", self.log)

    def test_jobber_company_and_name_matching(self):
        self.run_main(self.jobber(_203={"companyName": "AECON UTILITIES INC."},
                                  _202={"companyName": "Gary Harris Builders", "name": "Test Person 2"}), STAGES_TEXT)
        jobs = self.jobs_out()
        self.assertEqual(jobs[203]["clientKey"], "AECON"); self.assertNotIn("residential", jobs[203])
        self.assertEqual((jobs[202]["client"], jobs[202]["clientKey"], jobs[202]["residential"]),
                         ("Gary Harris Builders", "Residential", True))
        self.run_main(self.jobber(_203={"companyName": None, "name": "Swift Underground"}), STAGES_TEXT)
        self.assertEqual(self.jobs_out()[203]["clientKey"], "Swift")

    def test_missing_client_file_uses_the_builtin_list_with_a_warning(self):
        (self.inp / S.CLIENTS_NAME).unlink()
        self.run_main(self.jobber(_203={"companyName": "Tricore"}), STAGES_TEXT)
        self.assertIn("::warning::clients: commercial_clients.json not found; using the built-in commercial client list "
                      "(8 clients)", self.log)
        self.assertEqual(self.jobs_out()[203]["clientKey"], "Tricore")
        (self.inp / S.CLIENTS_NAME).write_text('{"version": 1, "clients": []}', encoding="utf-8")
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertIn("::warning::clients: commercial_clients.json invalid: no clients list", self.log)
        self.assertEqual(self.jobs_out()[201]["clientKey"], "Crown")

    def test_closed_residential_jobs_are_dropped_to_the_archive(self):
        self.run_main(self.default_jobber(), stages_with(_161={"keep": True}))
        closed, arch = self.closed_out(), self.archive()
        self.assertEqual(sorted(closed), sorted(KEPT + [161, 163, 164]))
        self.assertEqual(sorted(arch), [153, 160, 162])
        for jn in (160, 162):
            self.assertEqual(arch[jn]["droppedWhy"], "residential, closed in Jobber")
            self.assertEqual((arch[jn]["clientKey"], arch[jn]["residential"]), ("Residential", True))
            self.assertIn(f"carry-forward: dropped #{jn} (residential, closed in Jobber)", self.log)
        self.assertEqual(arch[153]["droppedWhy"], "removed in app")
        self.assertEqual((closed[161]["clientKey"], closed[161]["residential"], closed[161]["closed"]),
                         ("Residential", True, True))
        self.assertIn("kept #161 closed in Jobber (residential, kept in the app: waiting for Completed", self.log)
        # carried records are re-classified: an old "Other" AECON record, a stale residential flag
        self.assertEqual(closed[163]["clientKey"], "AECON"); self.assertNotIn("residential", closed[163])
        self.assertEqual(closed[164]["clientKey"], "Crown"); self.assertNotIn("residential", closed[164])
        for jn in KEPT: self.assertNotIn("residential", closed[jn])
        self.assertNotIn("::warning::carry-forward", self.log, "an automatic residential drop is not a warning")
        # next run: 161 stays (keep), the dropped ones stay archived
        self.run_main(self.default_jobber(), stages_with(_161={"keep": True}))
        self.assertIn(161, self.closed_out()); self.assertEqual(sorted(self.archive()), [153, 160, 162])

    def test_keep_is_kept_until_removed(self):
        self.run_main(self.default_jobber(), stages_with(_161={"keep": True, "stage": "poured", "cleanup": "done"}))
        self.assertIn(161, self.closed_out())
        self.run_main(self.default_jobber(), stages_with(_161={"keep": True, "stage": "poured", "cleanup": "done"}))
        self.assertIn(161, self.closed_out(), "still there on the next run")
        self.run_main(self.default_jobber(), stages_with(_161={"keep": True, "removed": True}))
        self.assertNotIn(161, self.all_out())
        self.assertEqual(self.archive()[161]["droppedWhy"], "removed in app")

    def test_archived_residential_job_is_restored_when_keep_is_set(self):
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertEqual(self.archive()[160]["droppedWhy"], "residential, closed in Jobber")
        self.assertNotIn(160, self.all_out())
        self.run_main(self.default_jobber(), stages_with(_160={"keep": True}))   # Settings -> Recently removed -> Restore
        closed = self.closed_out()
        self.assertIn(160, closed)
        self.assertEqual((closed[160]["clientKey"], closed[160]["residential"], closed[160]["closed"]),
                         ("Residential", True, True))
        self.assertNotIn("droppedWhy", closed[160]); self.assertNotIn(160, self.archive())
        self.assertIn("kept #160 closed in Jobber (restored from closed_archive.json: residential, kept in the app", self.log)

    def test_unreadable_stage_file_keeps_closed_residential_jobs(self):
        self.run_main(self.default_jobber(), stages_exc=urllib.error.URLError("offline"))
        self.assertTrue({160, 161, 162}.issubset(self.closed_out()))
        self.assertIs(self.closed_out()[160]["residential"], True)
        self.assertNotIn(160, self.archive())

    def test_residential_job_active_again_leaves_the_archive(self):
        self.run_main(self.default_jobber(), STAGES_TEXT)                       # 160 archived
        self.assertIn(160, self.archive())
        self.run_main(self.jobber(extra_node={"id": "TEST-ID-160", "jobNumber": 160,
                                              "client": {"id": "C9", "name": "Test Person 160", "companyName": None}}),
                      STAGES_TEXT)
        self.assertEqual((self.jobs_out()[160]["clientKey"], self.jobs_out()[160]["residential"]), ("Residential", True))
        self.assertNotIn(160, self.closed_out()); self.assertNotIn(160, self.archive())


class JsTrimParity(unittest.TestCase):
    """stage_key / clean_job_key trim like JavaScript String.prototype.trim (js/stages.js), not like str.strip()."""

    def test_stage_key_and_job_key_use_the_js_whitespace_set(self):
        self.assertEqual(S.stage_key(" PREP\u3000"), "prep")
        self.assertEqual(S.stage_key("\ufeffbase\n"), "base")
        for odd in ("prep\x1c", "prep\x1f", "\x85prep", "prep\x1d"):   # str.strip() strips these, JS trim() does not
            self.assertIsNone(S.stage_key(odd), repr(odd))
            self.assertEqual(S.stage_index(odd), 0, "unknown = Ready, like the app")
        self.assertEqual(S.clean_job_key(" 684\u00a0"), "684")
        self.assertEqual(S.clean_job_key("684\x85"), "")
        self.assertEqual(S.clean_job_key("\x1c684"), "")

    def test_same_whitespace_set_as_the_promote_tool(self):
        sys.path.insert(0, str(HERE.parent / "tools"))
        import promote_stages as P
        self.assertEqual(S._JS_WS, P._JS_WS)
        self.assertFalse(hasattr(S, "STAGES_BETA_RAW_URL"), "unused constant removed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
