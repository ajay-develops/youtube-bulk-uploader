#!/usr/bin/env python3
"""
Dev Video Offload -- live status dashboard.

A tiny local web server that reads manifest.json and the upload log to show
Dev Saroha a live view of the YouTube upload automation's progress: how many
videos are done, how many are left, today's quota usage, recent uploads with
clickable links, and any failures. Also lets him pause/resume the upload
process with a single toggle button -- resuming automatically kicks off an
immediate upload check instead of waiting for the next scheduled run.

Runs continuously in the background as a root LaunchDaemon (separate from
the upload job), serves real HTTPS on port 443 using a locally-trusted
mkcert certificate, redirects plain HTTP on port 80 to HTTPS, and advertises
itself on the local network as a friendly hostname (yt-upload-progress.local)
via Bonjour/mDNS -- so it's reachable at:

    https://yt-upload-progress.local

with no port number and a trusted padlock (no browser warning), because the
mkcert local CA was installed into Dev's login keychain.
"""

import fcntl
import http.server
import os
import json
import socket
import socketserver
import ssl
import subprocess
import threading
from datetime import datetime
from pathlib import Path

BASE_DIR = Path.home() / "dev-saroha-youtube-upload"
MANIFEST_FILE = BASE_DIR / "manifest.json"
LOG_FILE = BASE_DIR / "logs" / "upload.log"
CERT_DIR = BASE_DIR / "certs"
CERT_FILE = CERT_DIR / "yt-upload-progress.local.pem"
KEY_FILE = CERT_DIR / "yt-upload-progress.local-key.pem"
PAUSE_FILE = BASE_DIR / "paused.flag"
LOCK_FILE = BASE_DIR / "upload.lock"
UPLOAD_SCRIPT = BASE_DIR / "scripts" / "upload.py"
RUN_AS_USER = "dev"

HOSTNAME = "yt-upload-progress"
HTTPS_PORT = 443
HTTP_PORT = 80


def load_manifest():
    if MANIFEST_FILE.exists():
        with open(MANIFEST_FILE) as f:
            return json.load(f)
    return {}


def tail_log(n=40):
    if not LOG_FILE.exists():
        return []
    with open(LOG_FILE) as f:
        lines = f.readlines()
    return [l.rstrip() for l in lines[-n:]]


def pacific_today():
    try:
        env = os.environ.copy()
        env["TZ"] = "America/Los_Angeles"
        out = subprocess.run(["date", "+%Y-%m-%d"], capture_output=True, text=True, env=env)
        return out.stdout.strip()
    except Exception:
        return ""


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def is_paused():
    return PAUSE_FILE.exists()


def upload_running():
    """True if a run currently holds upload.py's lock file."""
    if not LOCK_FILE.exists():
        return False
    try:
        fp = open(LOCK_FILE, "r+")
    except Exception:
        return False
    try:
        fcntl.flock(fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fp.close()
        return True
    # We got the lock ourselves -- nobody else holds it. Release right away.
    fcntl.flock(fp, fcntl.LOCK_UN)
    fp.close()
    return False


def trigger_manual_run():
    """Fire off upload.py in the background as the regular (unprivileged)
    user, without blocking this request. upload.py's own file lock makes
    sure this can never overlap with the scheduled run or another click."""
    try:
        subprocess.Popen(
            ["sudo", "-n", "-u", RUN_AS_USER, "/usr/bin/python3", str(UPLOAD_SCRIPT)],
            cwd=str(BASE_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as e:
        print("Failed to trigger manual run: {}".format(e))


def render_page():
    manifest = load_manifest()
    total = len(manifest)
    uploaded = [e for e in manifest.values() if e.get("status") == "uploaded"]
    failed = [(k, e) for k, e in manifest.items() if e.get("status") == "failed"]
    pending = max(total - len(uploaded) - len(failed), 0)

    today_pt = pacific_today()
    today_count = sum(1 for e in uploaded if e.get("upload_date_pt") == today_pt)

    recent_uploads = sorted(uploaded, key=lambda e: e.get("uploaded_at", ""), reverse=True)[:15]

    rows = ""
    for e in recent_uploads:
        rows += (
            "<tr><td>{title}</td>"
            '<td><a href="https://youtu.be/{vid}" target="_blank">watch (unlisted)</a></td>'
            "<td>{when}</td></tr>"
        ).format(title=esc(e.get("title", "")), vid=esc(e.get("youtube_id", "")), when=esc(e.get("uploaded_at", "")))

    fail_rows = ""
    for key, e in failed[:15]:
        fail_rows += "<tr><td>{key}</td><td>{err}</td><td>{attempts}</td></tr>".format(
            key=esc(key), err=esc(e.get("last_error", ""))[:200], attempts=e.get("attempts", 0)
        )

    log_html = "\n".join(esc(l) for l in tail_log(40))

    paused = is_paused()
    running = upload_running()

    if running:
        status_label = "Uploading now"
        status_color = "#3fa8e0"
    elif paused:
        status_label = "Paused"
        status_color = "#e0a30d"
    else:
        status_label = "Running"
        status_color = "#3fa34d"

    if paused:
        pause_action_href = "/resume"
        pause_action_label = "Resume uploads"
        pause_action_color = "#2e7d32"
    else:
        pause_action_href = "/pause"
        pause_action_label = "Pause uploads"
        pause_action_color = "#b3261e"

    html = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>Dev Video Offload -- Upload Progress</title>
<style>
  body {{ font-family: -apple-system, sans-serif; background: #111; color: #eee; max-width: 900px; margin: 40px auto; padding: 0 20px; }}
  h1 {{ font-size: 1.4rem; }}
  .stats {{ display: flex; gap: 16px; margin: 24px 0; flex-wrap: wrap; }}
  .stat {{ background: #1c1c1c; border: 1px solid #333; border-radius: 8px; padding: 16px 20px; min-width: 120px; }}
  .stat .n {{ font-size: 1.8rem; font-weight: 600; }}
  .stat .l {{ font-size: 0.8rem; color: #999; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.9rem; }}
  th, td {{ text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }}
  a {{ color: #6ab0ff; }}
  pre {{ background: #0c0c0c; border: 1px solid #2a2a2a; border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 0.78rem; line-height: 1.4; max-height: 300px; overflow-y: auto; }}
  h2 {{ font-size: 1.05rem; margin-top: 32px; }}
  .status-row {{ display: flex; align-items: center; gap: 12px; margin: 20px 0; flex-wrap: wrap; }}
  .status-pill {{ display: inline-block; padding: 6px 14px; border-radius: 999px; font-weight: 600; font-size: 0.85rem; background: {status_color}22; color: {status_color}; border: 1px solid {status_color}55; }}
  .action-btn {{ display: inline-block; padding: 10px 20px; border-radius: 6px; color: #fff; text-decoration: none; font-weight: 600; font-size: 0.9rem; }}
  .action-btn:hover {{ opacity: 0.9; }}
  .action-btn[aria-disabled="true"] {{ pointer-events: none; opacity: 0.6; }}
</style>
</head>
<body>
<h1>Dev Video Offload -- upload progress</h1>

<div class="status-row">
  <span class="status-pill">{status_label}</span>
  <a class="action-btn" style="background:{pause_action_color};" href="{pause_action_href}">{pause_action_label}</a>
</div>

<div class="stats">
  <div class="stat"><div class="n">{total}</div><div class="l">videos found</div></div>
  <div class="stat"><div class="n">{uploaded_n}</div><div class="l">uploaded</div></div>
  <div class="stat"><div class="n">{pending_n}</div><div class="l">remaining</div></div>
  <div class="stat"><div class="n">{failed_n}</div><div class="l">failed</div></div>
  <div class="stat"><div class="n">{today_count}/95</div><div class="l">today's quota (Pacific)</div></div>
</div>

<h2>Recent uploads</h2>
<table>
<tr><th>Title</th><th>Link</th><th>Uploaded at (UTC)</th></tr>
{rows}
</table>

<h2>Failures</h2>
<table>
<tr><th>File</th><th>Last error</th><th>Attempts</th></tr>
{fail_rows}
</table>

<h2>Recent log</h2>
<pre>{log_html}</pre>

<p style="color:#666; font-size:0.75rem; margin-top:32px;">Auto-refreshes every 30 seconds. Generated {now}</p>
</body>
</html>""".format(
        total=total, uploaded_n=len(uploaded), pending_n=pending, failed_n=len(failed),
        today_count=today_count, rows=rows or "<tr><td colspan=3>None yet</td></tr>",
        fail_rows=fail_rows or "<tr><td colspan=3>None</td></tr>", log_html=log_html or "(no log yet)",
        now=datetime.now().isoformat(timespec="seconds"),
        status_label=status_label, status_color=status_color,
        pause_action_href=pause_action_href, pause_action_label=pause_action_label, pause_action_color=pause_action_color,
    )
    return html


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/", ""):
            body = render_page().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/pause":
            try:
                PAUSE_FILE.touch()
                os.chmod(PAUSE_FILE, 0o666)
            except Exception:
                pass
            self._redirect_home()
        elif self.path == "/resume":
            try:
                PAUSE_FILE.unlink()
            except FileNotFoundError:
                pass
            except Exception:
                pass
            # Automate what the old separate "Retry uploads now" button did:
            # resuming immediately kicks off a run instead of waiting for the
            # next scheduled LaunchAgent tick (up to 30 min away).
            if not upload_running():
                trigger_manual_run()
            self._redirect_home()
        else:
            self.send_response(404)
            self.end_headers()

    def _redirect_home(self):
        self.send_response(303)
        self.send_header("Location", "/")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format, *args):
        pass


class RedirectHandler(http.server.BaseHTTPRequestHandler):
    """Plain-HTTP handler on port 80 that 301-redirects everything to HTTPS."""

    def _redirect(self):
        target = "https://{}.local{}".format(HOSTNAME, self.path)
        self.send_response(301)
        self.send_header("Location", target)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._redirect()

    def do_HEAD(self):
        self._redirect()

    def log_message(self, format, *args):
        pass


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def register_mdns():
    try:
        from zeroconf import Zeroconf, ServiceInfo
        ip = get_local_ip()
        zc = Zeroconf()
        info = ServiceInfo(
            "_https._tcp.local.",
            "{}._https._tcp.local.".format(HOSTNAME),
            addresses=[socket.inet_aton(ip)],
            port=HTTPS_PORT,
            server="{}.local.".format(HOSTNAME),
        )
        zc.register_service(info)
        print("mDNS registered: https://{}.local".format(HOSTNAME))
        return zc
    except Exception as e:
        print("mDNS registration failed ({}); dashboard still reachable via IP".format(e))
        return None


def run_http_redirect_server():
    try:
        with ReusableTCPServer(("0.0.0.0", HTTP_PORT), RedirectHandler) as httpd:
            print("HTTP->HTTPS redirect running on port {}".format(HTTP_PORT))
            httpd.serve_forever()
    except Exception as e:
        print("Could not start HTTP redirect server on port {}: {}".format(HTTP_PORT, e))


def main():
    if not CERT_FILE.exists() or not KEY_FILE.exists():
        print("ERROR: missing TLS cert/key at {} / {}".format(CERT_FILE, KEY_FILE))
        print("Run the mkcert setup step first (see scripts/mkcert-setup.command).")
        return

    zc = register_mdns()

    redirect_thread = threading.Thread(target=run_http_redirect_server, daemon=True)
    redirect_thread.start()

    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain(certfile=str(CERT_FILE), keyfile=str(KEY_FILE))

    with ReusableTCPServer(("0.0.0.0", HTTPS_PORT), Handler) as httpd:
        httpd.socket = ssl_context.wrap_socket(httpd.socket, server_side=True)
        print("Dashboard running on https://{}.local (port {})".format(HOSTNAME, HTTPS_PORT))
        try:
            httpd.serve_forever()
        finally:
            if zc:
                zc.close()


if __name__ == "__main__":
    main()
