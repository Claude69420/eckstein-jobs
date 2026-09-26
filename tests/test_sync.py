"""Unit tests for sync_jobs.py (R-2). No network: every HTTP call is mocked.

    python tests/test_sync.py          (or: python -m unittest discover -s tests -p "test_*.py")

Fixtures live in tests/fixtures/ (made-up jobs, streets and amounts). The AES key used here is a public
TEST ONLY key (bytes 0..31); it is not the real PRICE_KEY.
"""
import base64, contextlib, http.client, io, json, os, shutil, sys, tempfile, unittest, urllib.error
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

# End-to-end stage files (beta channel, r2-plan §9): v1's stages.json (stage/at/by only, as R-1 writes it) and the
# beta's stages-beta.json (items + sat). Together they give the same decisions as the combined sync_stages.json:
# kept 150 (v1 base is newer than the beta sat), 151 (asphalt hint), 155 (beta prep + asphalt, beta sat newer),
# 156 (v1 stage not understood); dropped 152 (field work done), 153 (removed in the beta), 154 (no work).
V1_TEXT = (FIX / "sync_stages_v1.json").read_text(encoding="utf-8")
BETA_TEXT = (FIX / "sync_stages_beta.json").read_text(encoding="utf-8")

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
        """stages_* = v1's stages.json; beta_* = stages-beta.json (default: the beta fixture; beta_exc=http_error(404)
        for "no beta file yet")."""
        beta_text = BETA_TEXT if beta_text is None and beta_exc is None else beta_text
        self.fetched = []
        def fake_text(url, timeout=20):
            self.fetched.append(url)
            if url.startswith(S.STAGES_BETA_RAW_URL + "?"):
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
        self.assertEqual(sorted(r["jobNumber"] for r in kept), [150, 151, 155, 156])
        self.assertEqual(sorted(jn for jn, _ in dropped), [152, 153, 154])
        why = dict(dropped)
        self.assertIn("removed", why[153]); self.assertIn("field work done", why[152])
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
        self.assertEqual(sorted(r["jobNumber"] for r in kept), [150, 151, 152, 153, 154, 155, 156])
        self.assertEqual(dropped, [])

    def test_active_again_is_not_closed(self):
        kept, _ = S.carry_forward(self.prev, {150, 151, 155, 156, 201}, set(), self.entries)
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
        rc = self.run_main(self.default_jobber(), V1_TEXT)
        self.assertEqual(rc, 0)
        # jobs.json keeps the R-1 membership (active + pending); closed jobs are only in closed_jobs.json
        self.assertEqual(sorted(self.jobs_out()), [201, 202, 203, 9001])
        self.assertEqual(sorted(self.closed_out()), [150, 151, 155, 156])
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
        for jn in (150, 151, 155, 156): self.assertIs(jobs[jn]["closed"], True)
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
                         (4, 4, 4, "ok", "ok"))
        self.assertEqual(meta["stage_entries"], {"stages.json": 6, "stages-beta.json": 5})
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
        stages = V1_TEXT
        self.run_main(self.default_jobber(), stages)
        first = self.all_out()
        self.run_main(self.default_jobber(), stages)          # previous files are now the first run's output
        second = self.all_out()
        self.assertEqual(sorted(first), sorted(second))
        self.assertEqual(sorted(self.closed_out()), [150, 151, 155, 156])

    def test_price_key_missing_leaves_existing_file_alone(self):
        (self.out / S.PRICES_NAME).write_text("OLD-FILE", encoding="utf-8")
        self.run_main(self.default_jobber(), V1_TEXT)
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
        self.assertEqual(self.run_main(fake, V1_TEXT), 0)
        jobs = self.all_out()
        self.assertEqual(sorted(jobs), [150, 151, 155, 156, 201, 202, 203, 9001])
        self.assertEqual(jobs[202]["hints"], {"asphalt": False, "pavers": True}, "line items still used")
        self.assertIn("::warning::jobber: job list query refused", self.log)
        self.assertIn("prices: skipped (Jobber did not return complete totals", self.log)
        self.assertEqual((self.out / S.PRICES_NAME).read_text(encoding="utf-8"), "OLD-FILE")
        self.assertEqual(jobs[155]["status"], "requires_invoicing")   # refresh refused too -> previous kept

    def test_line_items_refused_keeps_previous_hints(self):
        fake = self.refusing_jobber("uninvoicedTotal", "lineItems")
        self.run_main(fake, V1_TEXT)
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
                self.assertEqual(self.run_main(self.default_jobber(), V1_TEXT), 0)
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
            self.assertEqual(self.run_main(slow_call, V1_TEXT), 0)
        refreshes = [c for c in jobber.calls if "RefreshJob" in (c["data"] or {}).get("query", "")]
        self.assertLessEqual(clock["t"] - 1000.0, S.REFRESH_BUDGET_S + 1, "all refreshes within the budget")
        self.assertLessEqual(len(refreshes), 3)
        self.assertIn("refresh failed (JobberError; previous values kept)", self.log)   # the budget ran out mid-retry
        self.assertIn("refresh budget used up; previous values kept", self.log)
        self.assertEqual(sorted(self.closed_out()), [150, 151, 155, 156], "closed jobs still kept (previous values)")
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
        self.run_main(self.default_jobber(), V1_TEXT)
        self.assertEqual(sorted(self.all_out()), [150, 151, 155, 156, 201, 202, 203, 9001])
        self.assertEqual({p.name: p.read_bytes() for p in self.inp.iterdir()}, inp_before, "--data is read-only")
        self.assertTrue(all(self.jobs_out()[jn]["ok"] for jn in (201, 202, 203)), "cache read from --data")


# ----------------------------------------------------------------------------- review fixes (R-2 fix loop)
STAGES_TEXT = V1_TEXT

def stages_without(*job_numbers):
    doc = json.loads(STAGES_TEXT)
    for jn in job_numbers: doc["stages"].pop(str(jn), None)
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

    def test_unknown_values_keep_only_when_they_could_change_the_decision(self):
        cases = [
            ({"stage": "poured", "cleanup": "done", "cut": "maybe"}, False),     # field work done either way
            ({"stage": "poured", "cleanup": "done", "assess": "phone"}, False),
            ({"stage": "poured", "cleanup": "done", "lane": {"s": "later"}}, False),
            ({"stage": "poured", "cleanup": "done", "asphalt": "partial"}, True),  # might still be required
            ({"stage": "poured", "cleanup": "done", "pavers": "partial"}, True),
            ({"assess": "phone"}, False),                                        # no work either way
            ({"cleanup": "later"}, False),
            ({"removed": "yes"}, False),
            ({"cut": "scheduled"}, True),                                        # might be work in progress
            ({"lane": {"s": "pending"}}, True),
            ({"stage": "setup2"}, True),                                         # a newer app's stage
            ("setup2", True),
            (5, True), ([1], True),                                              # whole entry not understood
            ({"stage": "base", "removed": True, "cut": "maybe"}, False),          # removed always wins
        ]
        for entry, keep in cases:
            with self.subTest(entry=entry):
                self.assertEqual(S.keep_decision(entry, {})[0], keep)

    def test_carried_records_are_normalized(self):
        prev = [{"jobNumber": "150", "hints": {"asphalt": 1}, "lat": float("nan"), "lon": -97.2, "ok": True,
                 "clientKey": ["x"], "_why": "old", "droppedAt": "2026-01-01"}]
        kept, _ = S.carry_forward(prev, set(), set(), {"150": {"stage": "base"}})
        rec = kept[0]
        self.assertEqual((rec["jobNumber"], rec["clientKey"], rec["client"], rec["street"], rec["city"]),
                         (150, "Other", "Unknown", "", "Winnipeg"))
        self.assertEqual((rec["lat"], rec["lon"], rec["ok"], rec["id"], rec["closed"]), (None, None, False, None, True))
        self.assertEqual(rec["hints"], {"asphalt": True, "pavers": False})
        self.assertNotIn("droppedAt", rec)

    def test_archive_restores_only_on_a_readable_store(self):
        arch = [{"jobNumber": 150, "id": "TEST-ID-150", "hints": {}, "droppedAt": "2026-09-20", "droppedWhy": "x"}]
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

    def test_dropped_closed_job_comes_back_when_its_entry_is_restored(self):
        self.run_main(self.default_jobber(), STAGES_TEXT)
        self.assertIs(self.closed_out()[150]["closed"], True)
        self.assertEqual(sorted(r["jobNumber"] for r in self.archive()["jobs"]), [152, 153, 154])
        # run 2: #150's entry is gone (a slip back to Ready, or a stale/reset copy): dropped, warned, archived
        self.run_main(self.default_jobber(), stages_without(150))
        self.assertNotIn(150, self.all_out())
        self.assertIn("::warning::carry-forward: dropped #150, which was closed in Jobber", self.log)
        arch = {r["jobNumber"]: r for r in self.archive()["jobs"]}
        self.assertIn(150, arch); self.assertEqual(arch[150]["droppedWhy"], "no work in progress")
        # run 3: the entry is back -> so is the job, with a fresh refresh; the archive forgets it
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
        self.assertEqual((rec["clientKey"], rec["street"], rec["ok"]), ("Other", "", False))
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
        prev = [{"jobNumber": n, "hints": {}} for n in (1, 2, 3, 4, 5)]
        state = {"1": {"stage": "poured", "cleanup": "done", "sat": "2026-09-21T00:00:00Z"},   # beta newer: done
                 "2": {"stage": "poured", "cleanup": "done", "sat": "2026-09-19T00:00:00Z"},   # v1 newer: base
                 "3": {"removed": True},
                 "4": {"asphalt": "req", "sat": "2026-09-19T00:00:00Z"}}                       # v1 ready (no entry)
        overlay = {"1": {"stage": "base", "at": "2026-09-20T00:00:00Z"}, "2": {"stage": "base", "at": "2026-09-20T00:00:00Z"},
                   "3": {"stage": "excavation", "at": "2026-09-20T00:00:00Z"}}
        kept, dropped = S.carry_forward(prev, set(), set(), state, overlay=overlay)
        self.assertEqual(sorted(r["jobNumber"] for r in kept), [2, 4])
        self.assertEqual(dict(dropped), {1: "field work done", 3: "removed from app", 5: "no work in progress"})

    def test_fetch_stages_404(self):
        def raiser(code):
            def f(url, timeout=20): raise urllib.error.HTTPError(url, code, "x", {}, None)
            return f
        with mock.patch.object(S, "_http_text", raiser(404)):
            self.assertEqual(S.fetch_stages(S.STAGES_BETA_RAW_URL, missing_ok=True), ({}, "not found (no entries yet)"))
            self.assertEqual(S.fetch_stages(S.STAGES_RAW_URL), (None, "fetch failed (HTTP 404)"), "v1 file: 404 = failure")
        with mock.patch.object(S, "_http_text", raiser(500)):
            self.assertEqual(S.fetch_stages(S.STAGES_BETA_RAW_URL, missing_ok=True), (None, "fetch failed (HTTP 500)"))


class BetaChannel(SyncTestCase):
    NOT_FOUND = urllib.error.HTTPError(S.STAGES_BETA_RAW_URL, 404, "Not Found", {}, None)

    def fresh_previous(self):
        shutil.copy(FIX / "sync_prev_jobs.json", self.out / S.JOBS_NAME)
        for name in (S.CLOSED_NAME, S.ARCHIVE_NAME, S.META_NAME): (self.out / name).unlink(missing_ok=True)

    def test_reads_both_files_and_jobs_json_keeps_r1_membership(self):
        self.run_main(self.default_jobber(), V1_TEXT)
        self.assertEqual(sorted(u.split("?")[0] for u in self.fetched), sorted([S.STAGES_RAW_URL, S.STAGES_BETA_RAW_URL]))
        jobs = self.jobs_out()
        self.assertEqual(sorted(jobs), [201, 202, 203, 9001])
        for r in jobs.values(): self.assertNotIn("closed", r)
        closed = self.closed_out()
        self.assertEqual(sorted(closed), [150, 151, 155, 156])
        for r in closed.values(): self.assertIs(r["closed"], True)
        self.assertIn("kept #150 closed in Jobber (work started", self.log)
        self.assertIn("kept #156 closed in Jobber (stages.json entry not understood", self.log)
        self.assertIn("dropped #152 (field work done)", self.log)
        self.assertIn("dropped #153 (removed from app)", self.log)
        arch = json.loads((self.out / S.ARCHIVE_NAME).read_text(encoding="utf-8"))["jobs"]
        self.assertEqual(sorted(r["jobNumber"] for r in arch), [152, 153, 154])

    def test_migrates_closed_records_out_of_the_previous_jobs_json(self):
        self.assertTrue(any(r.get("closed") for r in fixture("sync_prev_jobs.json")), "fixture: #155 is closed:true")
        self.run_main(self.default_jobber(), V1_TEXT)
        self.assertNotIn(155, self.jobs_out())
        self.assertIs(self.closed_out()[155]["closed"], True)
        self.assertEqual(self.closed_out()[155]["title"], "Already closed last run")

    def test_previous_closed_jobs_come_from_closed_jobs_json(self):
        rec = dict(next(r for r in fixture("sync_prev_jobs.json") if r["jobNumber"] == 150), closed=True)
        rec["title"] = "from closed_jobs.json"
        prev = [r for r in fixture("sync_prev_jobs.json") if r["jobNumber"] not in (150, 155)]
        (self.out / S.JOBS_NAME).write_text(json.dumps(prev), encoding="utf-8")
        (self.out / S.CLOSED_NAME).write_text(json.dumps([rec]), encoding="utf-8")
        self.run_main(self.default_jobber(), V1_TEXT)
        closed = self.closed_out()
        self.assertEqual(sorted(closed), [150, 151, 156])     # 155 is in neither previous file any more
        self.assertEqual(closed[150]["title"], "from closed_jobs.json")
        self.assertEqual(closed[150]["status"], "requires_invoicing", "still refreshed from Jobber")

    def test_closed_job_active_again_leaves_closed_jobs_json(self):
        self.run_main(self.default_jobber(), V1_TEXT)
        self.assertIn(150, self.closed_out())
        pages = fixture("sync_jobber_pages.json")["pages"]
        back = json.loads(json.dumps(pages[0]["data"]["jobs"]["nodes"][0]))
        back.update({"id": "TEST-ID-150", "jobNumber": 150, "title": "active again"})
        pages[0]["data"]["jobs"]["nodes"].append(back)
        self.run_main(FakeJobber(pages, refresh=self.default_jobber().refresh), V1_TEXT)
        self.assertIn(150, self.jobs_out()); self.assertNotIn("closed", self.jobs_out()[150])
        self.assertNotIn(150, self.closed_out())

    def test_beta_file_404_is_empty_not_a_failure(self):
        self.run_main(self.default_jobber(), V1_TEXT, beta_exc=self.NOT_FOUND)
        # v1 alone decides the stages; v1 carries no items, so 152 (poured, cleanup to do) and 153 stay
        self.assertEqual(sorted(self.closed_out()), [150, 151, 152, 153, 155, 156])
        self.assertIn("dropped #154 (no work in progress)", self.log)
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
        cases = [(dict(done, sat="2026-09-21T10:00:00Z"), False),   # beta set the stage after v1: field work done
                 (dict(done, sat="2026-09-19T10:00:00Z"), True),    # v1 moved it later: base, work in progress
                 (dict(done, sat="2026-09-20T10:00:00Z"), False),   # same instant: beta stage
                 (dict(done), True)]                                # no sat: v1 stage
        for entry, kept in cases:
            with self.subTest(entry=entry):
                self.fresh_previous()
                self.run_main(self.default_jobber(), v1, beta_text=beta_doc({"150": entry}))
                self.assertEqual(150 in self.closed_out(), kept)

    def test_items_come_only_from_the_beta_file(self):
        # v1 file carrying items (a hand edit): ignored; the beta's asphalt na beats #151's asphalt hint
        v1 = v1_with(_152={"stage": "poured", "cleanup": "done", "at": "2026-09-20T10:00:00Z"}, _154=None)
        beta = beta_doc({"151": {"asphalt": "na", "sat": "2026-09-21T00:00:00Z"},
                         "154": {"cut": "req", "sat": "2026-09-21T00:00:00Z"}})
        self.run_main(self.default_jobber(), v1, beta_text=beta)
        closed = self.closed_out()
        self.assertIn(152, closed, "cleanup from v1's file is ignored: cleanup still to do")
        self.assertNotIn(151, closed, "stored asphalt na beats the hint")
        self.assertIn(154, closed, "street cut required in the beta")

    def test_removed_in_beta_beats_a_newer_v1_stage(self):
        self.run_main(self.default_jobber(), v1_with(_153={"stage": "prep", "at": "2026-09-25T10:00:00Z"}))
        self.assertNotIn(153, self.closed_out())
        self.assertIn("dropped #153 (removed from app)", self.log)

    def test_unclear_v1_stage_older_than_beta_sat_does_not_keep(self):
        beta = json.loads(BETA_TEXT); beta["stages"]["156"] = {"assess": "virtual", "sat": "2026-09-21T00:00:00Z"}
        self.run_main(self.default_jobber(), V1_TEXT, beta_text=json.dumps(beta))
        self.assertNotIn(156, self.closed_out())

    def test_empty_beta_file_after_it_had_entries_keeps_everything(self):
        self.run_main(self.default_jobber(), V1_TEXT)
        self.assertEqual(self.meta()["stage_entries"]["stages-beta.json"], 5)
        for kw in ({"beta_text": '{"version":2,"stages":{}}'}, {"beta_exc": self.NOT_FOUND}):
            with self.subTest(case=str(kw)):
                shutil.copy(FIX / "sync_prev_jobs.json", self.out / S.JOBS_NAME)
                self.run_main(self.default_jobber(), V1_TEXT, **kw)
                # without the guard #154 would be dropped (and #153's "removed" forgotten)
                self.assertEqual(sorted(self.closed_out()), [150, 151, 152, 153, 154, 155, 156], "nothing dropped")
                self.assertNotIn("dropped", self.log)
                self.assertIn("::warning::carry-forward: stages-beta.json unreadable (no entries at all, but it had 5",
                              self.log)
                self.assertEqual(self.meta()["stage_entries"]["stages-beta.json"], 5, "the guard survives the next run")
        self.run_main(self.default_jobber(), V1_TEXT)      # the file is back: normal decisions again
        self.assertNotIn("unreadable", self.log)

    def test_unreadable_closed_jobs_file_never_stops_the_job_sync(self):
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        files = ((S.CLOSED_NAME, "{broken"), (S.ARCHIVE_NAME, "ARCHIVE"), (S.PRICES_NAME, "PRICES"))
        for name, text in files: (self.out / name).write_text(text, encoding="utf-8")
        self.assertEqual(self.run_main(self.default_jobber(), V1_TEXT), 0)
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
        self.run_main(self.default_jobber(), V1_TEXT)
        self.assertIn("::warning::carry-forward: closed_jobs.json is not a list", self.log)
        self.assertEqual((self.out / S.CLOSED_NAME).read_text(encoding="utf-8"), '{"jobs": []}')

    def test_prices_cover_active_and_closed_jobs(self):
        os.environ["PRICE_KEY"] = TEST_ONLY_KEY_B64
        self.run_main(self.default_jobber(), V1_TEXT)
        self.run_main(self.default_jobber(), V1_TEXT)          # second run: closed jobs read from closed_jobs.json
        prices = S.decrypt_prices(json.loads((self.out / S.PRICES_NAME).read_text(encoding="utf-8")), TEST_ONLY_KEY)
        self.assertEqual(sorted(prices), ["150", "201", "202"])
        self.assertEqual(prices["150"], {"t": 27182.81, "u": 27182.81})

    def test_first_run_on_main_data_with_no_closed_files(self):
        """main's data/: an R-1 jobs.json (no closed, no hints, no id) and no closed_jobs.json / stages-beta.json."""
        prev = [{k: v for k, v in r.items() if k not in ("closed", "hints", "id")}
                for r in fixture("sync_prev_jobs.json")]
        (self.out / S.JOBS_NAME).write_text(json.dumps(prev), encoding="utf-8")
        self.run_main(self.default_jobber(), V1_TEXT, beta_exc=self.NOT_FOUND)
        self.assertEqual(sorted(self.jobs_out()), [201, 202, 203, 9001])
        self.assertEqual(sorted(self.closed_out()), [150, 152, 153, 155, 156])
        self.assertIsNone(self.closed_out()[150]["id"], "no id yet: not refreshed, previous values kept")


if __name__ == "__main__":
    unittest.main(verbosity=2)
