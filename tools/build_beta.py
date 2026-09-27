"""Generate beta/ (the "EJ Beta" app at https://claude69420.github.io/eckstein-jobs/beta/) from the root app files.

docs/r2-plan.md section 9 "Beta channel": R-2 is trialled next to v1. v1 stays at the site root, byte-for-byte; the
beta is a copy of this branch's frontend in beta/ with its own config, manifest, service worker and icons:

  beta/index.html     root index.html + an inline window.EJ_CONFIG script before every other script, <title> and
                      apple-mobile-web-app-title "EJ Beta" (manifest.json / icons/ links are relative, so they
                      resolve to beta/manifest.json and beta/icons/)
  beta/css/ js/ vendor/  byte-for-byte copies of APP_FILES only (an explicit list: a stray local file such as a
                      backup or a .env can never reach the public site; vendor/ is -text in .gitattributes)
  beta/manifest.json  "Eckstein Jobs Beta" / "EJ Beta", start_url / scope "./" (= /eckstein-jobs/beta/), id
                      "/eckstein-jobs/beta/"
  beta/sw.js          root sw.js with cache "ejb-v1" and cleanup of "ejb-" caches only (the root keeps "ej-")
  beta/icons/         NOT copied: made by `python tools/make_icons.py --variant beta` (orange, with a beta badge).
                      tools/beta_icons.json records their sha256 and make_icons.py's, so a plain --check notices
                      hand-edited icons or a changed generator without the ~30 s render.

Usage (from anywhere):
  python tools/build_beta.py            write beta/ (only files whose bytes change; stale files are removed)
  python tools/build_beta.py --check    exit 1 if beta/ is out of date (nothing is written)
  add --icons to either to also (re)generate / fully verify beta/icons/ via tools/make_icons.py (~30 s)
  --out DIR   build into DIR instead of beta/ (tests, a trial build); DIR must be missing, empty or an earlier
              build; beta/icons/ are copied in when DIR has none
  --force     build over a RETIRED beta/ (see below)

RETIRED (2026-09-26, R-2 promoted to the main app at the site root; docs/r2-plan.md section 9 "Promotion"): beta/ now
holds a small static notice (beta/index.html, marked <meta name="ej-beta" content="retired">), a self-unregistering
service worker (beta/sw.js), the old beta manifest and icons, so an "EJ Beta" Home Screen icon opens a page that points
to the main app. The build refuses to overwrite it unless --force (a future beta); --check on it only reports it.

The build refuses a CONFIG that js/stages.js resolveConfig would lock or change (mirrored rules below; the
tests/stages.test.js "beta build" test runs the real resolveConfig on beta/index.html).
Deterministic: the same root files always give the same bytes. Line endings follow the source files.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import tempfile

sys.dont_write_bytecode = True   # importing make_icons must not leave tools/__pycache__ behind

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BETA = os.path.join(ROOT, "beta")
ICON_STAMP = os.path.join(ROOT, "tools", "beta_icons.json")

# window.EJ_CONFIG for the beta (the defaults, i.e. no config, are the main app; js/app.js, js/stages.js,
# js/prices.js and the index.html boot script read it).
CONFIG = {
    "channel": "beta",
    "base": "../",                    # data/ and routes/ come from the root site (same files v1 reads)
    "ns": "ejb_",                     # localStorage prefix: never shares a key with v1 ("ej_")
    "stateFile": "stages-beta.json",  # the beta's own stage file in Claude69420/eckstein-jobs-state
    "overlayFile": "stages.json",     # v1's stage file: read-only overlay
    "cachePrefix": "ejb-",            # service worker caches (informational; baked into beta/sw.js below)
}
CACHE = "ejb-v1"
APP_TITLE = "EJ Beta"
# The app's own files under css/ js/ vendor/ (sw.js SHELL + the vendored licence). Anything else found there is NOT
# copied: --check reports it, so a new app file has to be added here on purpose.
APP_FILES = (
    "css/tokens.css", "css/glass.css", "css/components.css",
    "js/tsp.js", "js/stages.js", "js/prices.js", "js/ui.js", "js/app.js",
    "vendor/hyalite.js", "vendor/hyalite.LICENSE",
)
COPY_DIRS = ("css", "js", "vendor")
ICONS = ("icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png")

# Mirrors of js/stages.js CONFIG_OK / NS_RE (resolveConfig) plus the beta-only rules it enforces.
_CONFIG_RULES = {
    "channel": r"[a-z0-9-]{1,16}",
    "base": r"(\.\.?/)*",
    "ns": r"[A-Za-z0-9_]{1,16}",
    "stateFile": r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json",
    "overlayFile": r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json",
    "cachePrefix": r"[A-Za-z0-9_-]{1,16}",
}


def config_problems(cfg):
    """Why js/stages.js would lock (read-only) or alter this beta config; [] = it resolves unchanged."""
    probs = []
    if set(cfg) != set(_CONFIG_RULES):
        probs.append("fields must be exactly %s" % ", ".join(sorted(_CONFIG_RULES)))
    for k, pat in _CONFIG_RULES.items():
        v = cfg.get(k)
        if not isinstance(v, str) or not re.fullmatch(pat, v) or (k == "base" and len(v) > 32):
            probs.append("%s %r is not valid" % (k, v))
    if cfg.get("channel") == "main": probs.append("channel must not be 'main'")
    if cfg.get("ns") == "ej_": probs.append("ns must not be v1's 'ej_'")
    if cfg.get("stateFile") == "stages.json": probs.append("stateFile must not be v1's stages.json")
    if cfg.get("overlayFile") == cfg.get("stateFile"): probs.append("overlayFile must differ from stateFile")
    if cfg.get("cachePrefix") == "ej-" or not CACHE.startswith(str(cfg.get("cachePrefix"))):
        probs.append("cachePrefix must not be v1's 'ej-' and must prefix CACHE %r" % CACHE)
    return probs


def read(rel):
    with open(os.path.join(ROOT, rel), "rb") as f:
        return f.read()


def nl_of(text):
    return "\r\n" if "\r\n" in text else "\n"


def sub_once(text, pattern, repl, what, flags=0):
    new, n = re.subn(pattern, lambda m: repl, text, count=0, flags=flags)
    if n != 1:
        raise SystemExit("build_beta: expected exactly one %s in the root file, found %d" % (what, n))
    return new


def build_index():
    src = read("index.html").decode("utf-8")
    nl = nl_of(src)
    # every local script / stylesheet the page loads must be in APP_FILES (else the beta would 404 on it)
    for ref in re.findall(r'<(?:script[^>]*\ssrc|link[^>]*rel="stylesheet"[^>]*\shref)="((?:css|js|vendor)/[^"]+)"', src):
        if ref.split("?")[0] not in APP_FILES:        # "js/app.js?v=r2.0": the ?v= build id is not part of the file
            raise SystemExit("build_beta: index.html loads %s, which is not in APP_FILES (tools/build_beta.py)" % ref)
    cfg = json.dumps(CONFIG, separators=(", ", ": "))
    inject = (
        '<meta charset="utf-8">' + nl +
        "<!-- GENERATED by tools/build_beta.py from the root index.html. Do not edit anything in beta/ by hand. -->" + nl +
        "<script>/* EJ Beta channel (docs/r2-plan.md section 9): must run before every other script. */" + nl +
        "window.EJ_CONFIG = " + cfg + ";</script>"
    )
    out = sub_once(src, r'<meta charset="utf-8">', inject, '<meta charset="utf-8">')
    # the config script must come before every other <script>
    first_script = out.find("<script")
    if first_script != out.find("<script>/* EJ Beta channel"):
        raise SystemExit("build_beta: the EJ_CONFIG script is not the first script in beta/index.html")
    out = sub_once(out, r"<title>[^<]*</title>", "<title>%s</title>" % APP_TITLE, "<title>")
    out = sub_once(out, r'<meta name="apple-mobile-web-app-title" content="[^"]*">',
                   '<meta name="apple-mobile-web-app-title" content="%s">' % APP_TITLE, "apple-mobile-web-app-title")
    # the manifest and icon links must stay relative so they resolve inside beta/
    sub_once(out, r'<link rel="manifest" href="manifest\.json">', "", "relative manifest link")
    for m in re.finditer(r'<link rel="(?:apple-touch-icon|icon)"[^>]*href="([^"]+)"', out):
        if not m.group(1).startswith("icons/"):
            raise SystemExit("build_beta: icon link %r is not relative to icons/" % m.group(1))
    return out.encode("utf-8")


def build_sw():
    src = read("sw.js").decode("utf-8")
    nl = nl_of(src)
    shell = re.search(r"const SHELL = \[(.*?)\];", src, re.S)
    for ref in re.findall(r"'((?:css|js|vendor)/[^']+)'", shell.group(1) if shell else ""):
        if ref not in APP_FILES:
            raise SystemExit("build_beta: sw.js SHELL lists %s, which is not in APP_FILES (tools/build_beta.py)" % ref)
    out = sub_once(src, r"^const C = '[^']*';$", "const C = '%s';" % CACHE, "const C", flags=re.M)
    out = sub_once(out, r"^const PREFIX = '[^']*';$", "const PREFIX = '%s';" % CONFIG["cachePrefix"], "const PREFIX", flags=re.M)
    out = sub_once(out, r"\A[^\r\n]*", "// EJ Beta service worker (cache \"%s\"): GENERATED from the root sw.js by tools/build_beta.py." % CACHE,
                   "first line")
    # sanity: the cleanup must be prefix-scoped so the beta never deletes v1's caches
    if "k.indexOf(PREFIX) === 0 && k !== C" not in out:
        raise SystemExit("build_beta: sw.js cleanup is not prefix-scoped (k.indexOf(PREFIX) === 0 && k !== C)")
    return out.replace("\r\n", "\n").replace("\n", nl).encode("utf-8")


def build_manifest():
    raw = read("manifest.json").decode("utf-8")
    root = json.loads(raw)
    out = {
        "name": "Eckstein Jobs Beta",
        "short_name": APP_TITLE,
        # id is resolved against the ORIGIN (W3C manifest spec), so "./" would mean the whole github.io site:
        # an explicit path keeps the beta's install identity unique (and different from v1's, which has no id).
        "id": "/eckstein-jobs/beta/",
        "description": "R-2 beta of Eckstein Jobs (trial next to v1): stages with job items, route editor, pricing.",
        "start_url": "./",
        "scope": "./",
    }
    for k, v in root.items():
        if k not in out:
            out[k] = v
    text = json.dumps(out, indent=2, ensure_ascii=False) + "\n"
    return text.replace("\n", nl_of(raw)).encode("utf-8")


RETIRED_MARK = '<meta name="ej-beta" content="retired">'
GENERATED_MARK = "GENERATED by tools/build_beta.py"


def is_retired(beta_dir):
    """True when beta_dir/index.html is the retired-beta notice (it carries RETIRED_MARK)."""
    path = os.path.join(beta_dir, "index.html")
    if not os.path.isfile(path):
        return False
    with open(path, "rb") as f:
        return RETIRED_MARK.encode("utf-8") in f.read()


def foreign_target(beta_dir):
    """Why building into beta_dir could delete files that are not ours ('' = safe): the stale-file cleanup removes every
    file it did not generate, so a non-default --out must be missing, empty, an earlier build or a retired beta."""
    if not os.path.isdir(beta_dir) or not os.listdir(beta_dir):
        return ""
    path = os.path.join(beta_dir, "index.html")
    if os.path.isfile(path):
        with open(path, "rb") as f:
            text = f.read()
        if GENERATED_MARK.encode("utf-8") in text or RETIRED_MARK.encode("utf-8") in text:
            return ""
    return "%s is not empty and holds no earlier beta build" % beta_dir


def ignorable(name):
    return name.startswith(".") or name == "__pycache__" or name.endswith(".pyc")


def unexpected_sources():
    """Files under css/ js/ vendor/ that are not APP_FILES (OS junk and dotfiles are skipped silently)."""
    out = []
    for d in COPY_DIRS:
        for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, d)):
            dirnames[:] = sorted(n for n in dirnames if not ignorable(n))
            for fn in sorted(filenames):
                if ignorable(fn):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, fn), ROOT).replace(os.sep, "/")
                if rel not in APP_FILES:
                    out.append(rel)
    return out


def generated():
    probs = config_problems(CONFIG)
    if probs:
        raise SystemExit("build_beta: CONFIG would be locked or changed by js/stages.js resolveConfig: " + "; ".join(probs))
    files = {
        "index.html": build_index(),
        "sw.js": build_sw(),
        "manifest.json": build_manifest(),
    }
    for rel in APP_FILES:
        if not os.path.isfile(os.path.join(ROOT, rel)):
            raise SystemExit("build_beta: %s (APP_FILES) is missing" % rel)
        files[rel] = read(rel)
    return files


def existing():
    out = []
    for dirpath, dirnames, filenames in os.walk(BETA):
        dirnames.sort()
        for fn in sorted(filenames):
            out.append(os.path.relpath(os.path.join(dirpath, fn), BETA).replace(os.sep, "/"))
    return out


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def generator_hash():
    return sha256(read("tools/make_icons.py").replace(b"\r\n", b"\n"))


def icon_hashes():
    out = {}
    for fn in ICONS:
        path = os.path.join(BETA, "icons", fn)
        if os.path.isfile(path):
            with open(path, "rb") as f:
                out[fn] = sha256(f.read())
    return out


def stamp_text():
    return json.dumps({"about": "sha256 of beta/icons/* and of tools/make_icons.py (LF) when the icons were made; "
                                "written by python tools/build_beta.py --icons, checked by --check",
                       "make_icons.py": generator_hash(), "icons": icon_hashes()}, indent=1, sort_keys=True) + "\n"


def icon_problems(regen):
    hint = " (run: python tools/build_beta.py --icons)"
    probs = []
    for fn in ICONS:
        if not os.path.isfile(os.path.join(BETA, "icons", fn)):
            probs.append("missing beta/icons/%s%s" % (fn, hint))
    if probs:
        return probs
    try:
        with open(ICON_STAMP, encoding="utf-8") as f:
            stamp = json.load(f)
    except (OSError, ValueError):
        stamp = None
    if not isinstance(stamp, dict):
        probs.append("missing or unreadable tools/beta_icons.json" + hint)
    else:
        if stamp.get("make_icons.py") != generator_hash():
            probs.append("tools/make_icons.py changed since beta/icons/ were made" + hint)
        if stamp.get("icons") != icon_hashes():
            probs.append("beta/icons/ differ from the icons recorded in tools/beta_icons.json" + hint)
    if regen:
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        import make_icons
        with tempfile.TemporaryDirectory() as tmp:
            make_icons.write_icons("beta", tmp)
            for fn in ICONS:
                with open(os.path.join(tmp, fn), "rb") as a, open(os.path.join(BETA, "icons", fn), "rb") as b:
                    if a.read() != b.read():
                        probs.append("beta/icons/%s differs from tools/make_icons.py --variant beta%s" % (fn, hint))
    return probs


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate beta/ from the root app files.")
    ap.add_argument("--check", action="store_true", help="exit 1 if beta/ is out of date; write nothing")
    ap.add_argument("--icons", action="store_true", help="also regenerate (or with --check, fully verify) beta/icons/")
    ap.add_argument("--out", help="build into this directory instead of beta/")
    ap.add_argument("--force", action="store_true", help="build over a retired beta/ (a new beta after the promotion)")
    a = ap.parse_args(argv)

    global BETA
    default_beta = os.path.join(ROOT, "beta")
    BETA = os.path.abspath(a.out) if a.out else default_beta
    if os.path.normcase(BETA) != os.path.normcase(default_beta):
        why = foreign_target(BETA)
        if why:
            print("build_beta: refusing --out: " + why)
            return 2
    if is_retired(BETA) and not a.force:
        if a.check:
            print("beta/ is retired (the static notice pointing to the main app; R-2 was promoted). Nothing to check; "
                  "build a new beta over it with: python tools/build_beta.py --force")
            return 0
        print("build_beta: beta/ is retired (the static notice pointing to the main app; R-2 was promoted). Refusing to "
              "overwrite it; pass --force to build a new beta over it.")
        return 2

    files = generated()
    extra = unexpected_sources()
    keep = set(files) | set("icons/" + fn for fn in ICONS)
    stale = [p for p in existing() if p not in keep]
    changed = []
    for rel, data in files.items():
        path = os.path.join(BETA, rel)
        cur = None
        if os.path.isfile(path):
            with open(path, "rb") as f:
                cur = f.read()
        if cur != data:
            changed.append(rel)
    extra_msgs = ["unexpected source file %s (not in the beta file list APP_FILES in tools/build_beta.py: add it "
                  "there if the app needs it, otherwise remove it; it is NOT copied into beta/)" % p for p in extra]

    if a.check:
        probs = ["out of date: beta/%s" % p for p in changed] + ["stale: beta/%s" % p for p in stale]
        build_hint = bool(probs)
        probs += extra_msgs
        probs += icon_problems(a.icons)
        if probs:
            print("\n".join(probs))
            print("beta/ check FAILED (%d problem%s)%s" % (len(probs), "" if len(probs) == 1 else "s",
                  ": run python tools/build_beta.py" if build_hint else ""))
            return 1
        print("beta/ is up to date (%d files, icons %s)" % (len(files) + len(ICONS), "re-rendered and verified" if a.icons else "match tools/beta_icons.json"))
        return 0

    if BETA != default_beta and not a.icons:        # --out: reuse the committed beta icons (kept after the retirement)
        for fn in ICONS:
            src, dst = os.path.join(default_beta, "icons", fn), os.path.join(BETA, "icons", fn)
            if os.path.isfile(src) and not os.path.isfile(dst):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(src, "rb") as f_in, open(dst, "wb") as f_out:
                    f_out.write(f_in.read())
    for rel in changed:
        path = os.path.join(BETA, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(files[rel])
    for rel in stale:
        os.remove(os.path.join(BETA, rel))
    for dirpath, dirnames, filenames in sorted(os.walk(BETA), key=lambda t: -len(t[0])):
        if dirpath != BETA and not os.listdir(dirpath):
            os.rmdir(dirpath)
    if a.icons:
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        import make_icons
        make_icons.write_icons("beta", os.path.join(BETA, "icons"))
        text = stamp_text()
        cur = None
        if os.path.isfile(ICON_STAMP):
            with open(ICON_STAMP, encoding="utf-8", newline="") as f:
                cur = f.read().replace("\r\n", "\n")
        if cur != text:
            with open(ICON_STAMP, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
    print("beta/: %d written, %d removed, %d unchanged" % (len(changed), len(stale), len(files) - len(changed)))
    if extra_msgs:
        print("\n".join(extra_msgs))
    probs = icon_problems(False)
    if probs:
        print("\n".join(probs))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
