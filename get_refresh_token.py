"""
ONE-TIME helper: authorize the "Eckstein Jobs Sync" Jobber app and capture its refresh token.

Run on Riley's PC:
    python get_refresh_token.py

It asks for the app's client_id / client_secret (from Jobber Developer Center), opens the browser
for consent, then writes the refresh token to:
    %USERPROFILE%\\.config\\eckstein_jobs_sync\\refresh_token.txt

Open that file and paste its contents into the GitHub repo secret JOBBER_REFRESH_TOKEN.
Nothing is printed to the terminal, and nothing is written into the repo or OneDrive.
"""
import getpass, json, urllib.parse, urllib.request, webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

AUTH_URL = "https://api.getjobber.com/api/oauth/authorize"
TOKEN_URL = "https://api.getjobber.com/api/oauth/token"
REDIRECT = "http://localhost:8081/callback"   # 8081 so it never clashes with the desktop MCP (8080)
OUT = Path.home() / ".config" / "eckstein_jobs_sync" / "refresh_token.txt"

def main():
    print("Eckstein Jobs Sync - one-time authorization\n")
    cid = input("client_id: ").strip()
    csec = getpass.getpass("client_secret (hidden): ").strip()
    if not cid or not csec:
        print("client_id and client_secret are required."); return 1

    holder = {}
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path == "/callback":
                holder["code"] = urllib.parse.parse_qs(u.query).get("code", [None])[0]
                self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
                self.wfile.write(b"<h2>Eckstein Jobs Sync authorized.</h2><p>You can close this tab.</p>")
            else:
                self.send_response(404); self.end_headers()
        def log_message(self, *a): pass

    srv = HTTPServer(("localhost", 8081), H)
    url = f"{AUTH_URL}?{urllib.parse.urlencode({'client_id': cid, 'redirect_uri': REDIRECT, 'response_type': 'code'})}"
    print("\nOpening browser for Jobber consent... (if not, visit)\n  " + url + "\n")
    webbrowser.open(url)
    srv.handle_request(); srv.server_close()
    code = holder.get("code")
    if not code:
        print("No authorization code received. Check the app's redirect URI is exactly " + REDIRECT); return 1

    body = urllib.parse.urlencode({"grant_type": "authorization_code", "code": code, "client_id": cid,
                                   "client_secret": csec, "redirect_uri": REDIRECT}).encode()
    req = urllib.request.Request(TOKEN_URL, data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        tok = json.loads(r.read().decode())
    rt = tok.get("refresh_token")
    if not rt:
        print("Jobber did not return a refresh_token. Response keys: " + ", ".join(tok.keys())); return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(rt, encoding="utf-8")
    print(f"\nSUCCESS. Refresh token saved to:\n  {OUT}\n\nOpen that file, copy its contents, and paste into the "
          "GitHub secret JOBBER_REFRESH_TOKEN. Then you can delete the file.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
