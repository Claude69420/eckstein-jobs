"""
Publish route maps to the Eckstein Jobs app.

Run after building any route map (Claude does this as a standing step):
    python C:/Users/Riley/eckstein-jobs/publish_routes.py

- Copies every Routes/Route_*.html that is new or changed into repo/routes/
- Patches each copy to be phone-responsive (stacked map + list on narrow screens)
- Regenerates routes/index.json (title from <title>, date from file mtime, newest first)
- Commits + pushes (so the phone app picks it up within ~a minute)
"""
import json, re, shutil, subprocess, sys
from datetime import datetime
from pathlib import Path

SRC = Path(r"C:/Users/Riley/OneDrive/Documents/Eckstein/Riley/Jobs/Routes")
REPO = Path(__file__).resolve().parent
DST = REPO / "routes"
RESP = ("@media(max-width:760px){#wrap{flex-direction:column}#map{flex:none;height:52vh}"
        "#side{width:100%!important;flex:1;min-height:0;border-left:0;border-top:1px solid #d0d4db}}")
ANCHOR = "#wrap{display:flex;height:100vh}#map{flex:1}"

def make_responsive(html: str) -> str:
    if RESP in html: return html
    return html.replace(ANCHOR, ANCHOR + RESP, 1)

def main(push=True) -> int:
    DST.mkdir(exist_ok=True)
    changed = 0
    for src in sorted(SRC.glob("Route_*.html")):
        dst = DST / src.name
        new_html = make_responsive(src.read_text(encoding="utf-8"))
        if dst.exists() and dst.read_text(encoding="utf-8") == new_html: continue
        dst.write_text(new_html, encoding="utf-8"); changed += 1
        print(f"  published: {src.name}")
    # index
    entries = []
    for f in DST.glob("Route_*.html"):
        m = re.search(r"<title>(.*?)</title>", f.read_text(encoding="utf-8"), re.I | re.S)
        title = (m.group(1) if m else f.stem).replace("&amp;", "&").strip()
        src = SRC / f.name
        mtime = (src if src.exists() else f).stat().st_mtime
        entries.append({"file": f.name, "title": title, "date": datetime.fromtimestamp(mtime).strftime("%b %d, %Y %I:%M %p"), "_t": mtime})
    entries.sort(key=lambda e: -e["_t"])
    for e in entries: e.pop("_t")
    (DST / "index.json").write_text(json.dumps(entries, indent=1), encoding="utf-8")
    print(f"index: {len(entries)} routes ({changed} new/changed)")
    if push:
        subprocess.run(["git", "add", "routes/"], cwd=REPO, check=True)
        r = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=REPO)
        if r.returncode == 0: print("nothing to commit"); return 0
        subprocess.run(["git", "commit", "-m", f"Publish routes ({changed} updated)"], cwd=REPO, check=True)
        subprocess.run(["git", "push"], cwd=REPO, check=True); print("pushed")
    return 0

if __name__ == "__main__":
    sys.exit(main(push="--no-push" not in sys.argv))
