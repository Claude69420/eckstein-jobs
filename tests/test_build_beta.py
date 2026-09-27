"""Tests for tools/build_beta.py (docs/r2-plan.md section 9). Run: python tests/test_build_beta.py
Every build goes into a temporary copy of the app files: the committed beta/ (since the promotion, the retired notice)
is never built over. Its contents are checked separately (RetiredBeta), by reading only."""
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_URL = "https://claude69420.github.io/eckstein-jobs/"


def load_builder(root):
    spec = importlib.util.spec_from_file_location("build_beta_under_test", os.path.join(root, "tools", "build_beta.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(mod, *argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = mod.main(list(argv))
    return rc, buf.getvalue()


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def make_workspace():
    """A temp copy of the app sources + tools with an EMPTY beta/ except the (kept) beta icons."""
    tmp = tempfile.mkdtemp(prefix="ej_build_beta_")
    for name in ("index.html", "sw.js", "manifest.json"):
        shutil.copy(os.path.join(REPO, name), tmp)
    for d in ("css", "js", "vendor", "tools"):
        shutil.copytree(os.path.join(REPO, d), os.path.join(tmp, d), ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(os.path.join(REPO, "beta", "icons"), os.path.join(tmp, "beta", "icons"))
    return tmp


class BuildBeta(unittest.TestCase):
    def setUp(self):
        self.tmp = make_workspace()
        self.mod = load_builder(self.tmp)
        rc, out = run(self.mod)                      # a fresh beta build in the temp workspace
        self.assertEqual(rc, 0, out)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_fresh_build_is_up_to_date_and_deterministic(self):
        rc, out = run(self.mod, "--check")
        self.assertEqual(rc, 0, out)
        rc, out = run(self.mod)
        self.assertEqual(rc, 0, out)
        self.assertIn("0 written, 0 removed", out)
        html = read(os.path.join(self.tmp, "beta", "index.html"))
        self.assertIn('"channel": "beta"', html)
        self.assertIn(self.mod.GENERATED_MARK, html)
        self.assertNotIn(self.mod.RETIRED_MARK, html)
        self.assertIn("const C = 'ejb-v1';", read(os.path.join(self.tmp, "beta", "sw.js")))

    def test_stray_files_are_never_copied_and_fail_the_check(self):
        planted = {"js/.env.local": "PRICE_KEY=abc", "js/app.js.bak": "x", "css/.DS_Store": "x",
                   "vendor/test-data.json": "{}", "js/__pycache__/junk.pyc": "x"}
        for rel, text in planted.items():
            path = os.path.join(self.tmp, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(text)
        rc, out = run(self.mod, "--check")
        self.assertEqual(rc, 1)
        self.assertIn("unexpected source file js/app.js.bak", out)
        self.assertIn("unexpected source file vendor/test-data.json", out)
        self.assertNotIn(".env.local", out, "dotfiles are skipped silently, never copied")
        rc, out = run(self.mod)
        self.assertEqual(rc, 0, out)
        for rel in planted:
            self.assertFalse(os.path.exists(os.path.join(self.tmp, "beta", rel)), rel)

    def test_config_that_stages_js_would_lock_is_refused(self):
        good = dict(self.mod.CONFIG)
        self.assertEqual(self.mod.config_problems(good), [])
        for change in ({"stateFile": "stages.json"}, {"stateFile": "stages_beta.JSON"}, {"stateFile": "stages-beta.json "},
                       {"ns": "ej_"}, {"ns": "ejb-"}, {"overlayFile": "stages-beta.json"}, {"channel": "main"},
                       {"base": "https://evil/"}, {"cachePrefix": "ej-"}):
            with self.subTest(change=change):
                self.assertTrue(self.mod.config_problems(dict(good, **change)))
        self.mod.CONFIG = dict(good, stateFile="stages.json")
        with self.assertRaises(SystemExit):
            self.mod.generated()

    def test_icon_stamp_catches_a_changed_generator_or_edited_icon(self):
        with open(os.path.join(self.tmp, "tools", "make_icons.py"), "a") as f:
            f.write("\n# changed\n")
        rc, out = run(self.mod, "--check")
        self.assertEqual(rc, 1)
        self.assertIn("make_icons.py changed", out)
        self.assertIn("--icons", out)
        shutil.copy(os.path.join(REPO, "tools", "make_icons.py"), os.path.join(self.tmp, "tools", "make_icons.py"))
        with open(os.path.join(self.tmp, "beta", "icons", "icon-180.png"), "ab") as f:
            f.write(b"x")
        rc, out = run(self.mod, "--check")
        self.assertEqual(rc, 1)
        self.assertIn("beta/icons/ differ", out)

    def test_a_retired_beta_is_never_overwritten_without_force(self):
        beta = os.path.join(self.tmp, "beta")
        for fn in ("index.html", "sw.js"):
            os.remove(os.path.join(beta, fn))
        shutil.rmtree(os.path.join(beta, "css")); shutil.rmtree(os.path.join(beta, "js")); shutil.rmtree(os.path.join(beta, "vendor"))
        notice = "<!DOCTYPE html><html><head>%s<title>EJ Beta</title></head><body>moved</body></html>\n" % self.mod.RETIRED_MARK
        with open(os.path.join(beta, "index.html"), "w", encoding="utf-8") as f:
            f.write(notice)
        with open(os.path.join(beta, "sw.js"), "w", encoding="utf-8") as f:
            f.write("// retire worker\n")
        rc, out = run(self.mod)
        self.assertEqual(rc, 2, out)
        self.assertIn("retired", out)
        self.assertIn("--force", out)
        self.assertEqual(read(os.path.join(beta, "index.html")), notice, "the notice is untouched")
        self.assertFalse(os.path.exists(os.path.join(beta, "js")))
        rc, out = run(self.mod, "--check")
        self.assertEqual(rc, 0, out)
        self.assertIn("retired", out)
        rc, out = run(self.mod, "--force")                        # a future beta: builds over the notice
        self.assertEqual(rc, 0, out)
        self.assertIn('"channel": "beta"', read(os.path.join(beta, "index.html")))
        self.assertTrue(os.path.isfile(os.path.join(beta, "js", "app.js")))
        self.assertEqual(run(self.mod, "--check")[0], 0)

    def test_out_builds_elsewhere_and_refuses_a_foreign_directory(self):
        out_dir = os.path.join(self.tmp, "trial")
        rc, out = run(self.mod, "--out", out_dir)
        self.assertEqual(rc, 0, out)
        self.assertIn('"channel": "beta"', read(os.path.join(out_dir, "index.html")))
        for fn in self.mod.ICONS:
            self.assertTrue(os.path.isfile(os.path.join(out_dir, "icons", fn)), "icons copied from beta/icons: " + fn)
        self.assertEqual(run(self.mod, "--out", out_dir, "--check")[0], 0)
        foreign = os.path.join(self.tmp, "foreign")
        os.makedirs(foreign)
        with open(os.path.join(foreign, "notes.txt"), "w") as f:
            f.write("mine")
        rc, out = run(self.mod, "--out", foreign)
        self.assertEqual(rc, 2, out)
        self.assertIn("refusing --out", out)
        self.assertEqual(os.listdir(foreign), ["notes.txt"], "nothing written or removed")


class RetiredBeta(unittest.TestCase):
    """The committed beta/ is the retired notice (read only; nothing is built here)."""
    BETA = os.path.join(REPO, "beta")

    def test_contents_are_the_notice_worker_manifest_and_icons_only(self):
        files = sorted(os.path.relpath(os.path.join(d, f), self.BETA).replace(os.sep, "/")
                       for d, _, fs in os.walk(self.BETA) for f in fs)
        self.assertEqual(files, ["icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
                                 "icons/icon-maskable-512.png", "index.html", "manifest.json", "sw.js"])
        self.assertTrue(load_builder(REPO).is_retired(self.BETA))
        rc, out = run(load_builder(REPO), "--check")
        self.assertEqual(rc, 0, out)
        self.assertIn("retired", out)
        man = json.loads(read(os.path.join(self.BETA, "manifest.json")))
        self.assertEqual((man["short_name"], man["id"], man["start_url"], man["scope"]), ("EJ Beta", "/eckstein-jobs/beta/", "./", "./"))
        self.assertIn("retired", man["name"].lower())
        self.assertTrue(man["description"].startswith("Retired: EJ Beta is now the main Eckstein Jobs app"), man["description"])

    def test_notice_page_is_static_and_points_to_the_main_app(self):
        html = read(os.path.join(self.BETA, "index.html"))
        self.assertIn("EJ Beta is now the main Eckstein Jobs app", html)
        self.assertIn("you can delete the EJ Beta icon", html)
        # iPhone Home Screen apps keep their own storage: the notice says where the keys must be pasted
        self.assertIn("<b>On iPhone:</b> open the <b>Eckstein Jobs</b> icon on your Home Screen", html)
        self.assertIn("Settings &rarr; Pricing (pricing key)", html)
        self.assertIn("Settings &rarr; Stages (edit key)", html)
        self.assertRegex(html, r'<a class="btn" href="%s">' % re.escape(MAIN_URL))
        self.assertIn("prefers-color-scheme: dark", html)
        self.assertNotRegex(html, r"<script[^>]*\ssrc=", "no external scripts")
        self.assertEqual(len(re.findall(r"<script", html)), 1, "one tiny inline script")
        self.assertNotRegex(html, r"<link[^>]*rel=\"stylesheet\"", "no external stylesheet")
        for bad in ("fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "EJ_CONFIG", "serviceWorker.register",
                    "unpkg", "api.github.com", "raw.githubusercontent"):
            self.assertNotIn(bad, html)
        script = re.search(r"<script>(.*?)</script>", html, re.S).group(1)
        self.assertIn("getRegistrations", script)
        self.assertIn("here = new URL('./', location.href).href", script)
        self.assertIn("if (r.scope === here) r.unregister()", script, "unregisters only the worker of exactly this folder")
        self.assertIn("/^ejb-v\\d+$/.test(k)", script, "deletes only the beta's own ejb-v<N> caches")

    def test_retire_worker_cleans_up_and_unregisters_without_a_fetch_handler(self):
        sw = read(os.path.join(self.BETA, "sw.js"))
        self.assertIn("skipWaiting()", sw)
        self.assertIn("const OURS = /^ejb-v\\d+$/;", sw)
        self.assertIn("return OURS.test(k);", sw)
        ours = re.compile(r"^ejb-v\d+$")
        self.assertEqual([k for k in ("ejb-v1", "ejb-v12", "ej-v3", "ej-v2", "ejb-other", "xejb-v1", "ejb-v1-old")
                          if ours.match(k)], ["ejb-v1", "ejb-v12"], "only the beta caches; never the main app's")
        self.assertIn("self.registration.unregister()", sw)
        # reload to a unique URL: Pages sends max-age=600, the same URL could be the HTTP-cached old beta page
        self.assertIn("c.navigate(scope + '?retired=' + Date.now())", sw)
        self.assertNotIn("navigate(c.url)", sw)
        self.assertNotIn("'fetch'", sw)
        self.assertNotIn("respondWith", sw)
        self.assertNotIn("caches.open", sw, "the retire worker never caches anything")
        self.assertLess(sw.index("caches.delete"), sw.index("unregister()"), "caches go first, then the worker")

    def test_root_index_loads_every_local_css_js_with_one_build_id(self):
        """New index.html must never pick up an HTTP-cached older app file (Pages: max-age=600) after a deploy."""
        html = read(os.path.join(REPO, "index.html"))
        refs = re.findall(r'<(?:script[^>]*\ssrc|link[^>]*rel="stylesheet"[^>]*\shref)="((?:css|js|vendor)/[^"]+)"', html)
        self.assertEqual(len(refs), 8, refs)
        ids = {r.partition("?")[2] for r in refs}
        self.assertEqual(len(ids), 1, "one build id for all: " + repr(ids))
        self.assertRegex(ids.pop(), r"^v=[0-9A-Za-z.\-]+$")
        sw = read(os.path.join(REPO, "sw.js"))
        self.assertIn("ignoreSearch: true", sw, "offline still finds the files stored without the query")
        self.assertIn("const key = u.origin + u.pathname;", sw)

    def test_root_worker_never_deletes_beta_caches(self):
        sw = read(os.path.join(REPO, "sw.js"))
        self.assertIn("const C = 'ej-v3';", sw)
        self.assertIn("const PREFIX = 'ej-';", sw)
        self.assertIn("k.indexOf(PREFIX) === 0 && k !== C", sw)
        self.assertFalse("ejb-v1".startswith("ej-"), "the root prefix cannot match the beta caches")


if __name__ == "__main__":
    unittest.main(verbosity=2)
