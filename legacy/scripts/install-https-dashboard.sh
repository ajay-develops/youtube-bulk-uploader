#!/bin/bash
# Run this WITH sudo, on this Mac:
#   sudo bash ~/dev-saroha-youtube-upload/scripts/install-https-dashboard.sh
#
# Must be run AFTER mkcert-setup.command has completed successfully (it
# generates the certificate files this script wires up).
#
# What it does:
#   1. Cleans up the earlier pf port-80-redirect attempt (which didn't work
#      due to macOS "hairpin NAT" -- a Mac can't redirect port-80 traffic
#      addressed to itself back to itself).
#   2. Stops the old unprivileged dashboard (port 5757, no HTTPS).
#   3. Installs the updated dashboard.py as a root-owned LaunchDaemon bound
#      directly to ports 443 (HTTPS) and 80 (redirects to HTTPS) -- this
#      needs root because only root can bind to ports below 1024 on macOS.
#
# After this, https://yt-upload-progress.local should load with a trusted
# padlock, and http://yt-upload-progress.local should redirect to it.

set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run with sudo (sudo bash $0)"
  exit 1
fi

REAL_USER="dev"
BASE_DIR="/Users/$REAL_USER/dev-saroha-youtube-upload"
CERT_FILE="$BASE_DIR/certs/yt-upload-progress.local.pem"
KEY_FILE="$BASE_DIR/certs/yt-upload-progress.local-key.pem"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "ERROR: certificate files not found at:"
  echo "  $CERT_FILE"
  echo "  $KEY_FILE"
  echo "Run mkcert-setup.command first (without sudo), then re-run this script."
  exit 1
fi

echo "== [1/5] Cleaning up the old pf port-80-redirect attempt =="
launchctl bootout system/com.ajay.ytdashboard.pf 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.ajay.ytdashboard.pf.plist
/sbin/pfctl -a com.ajay.ytdashboard -F all 2>/dev/null || true
rm -f /etc/pf.anchors/com.ajay.ytdashboard
rm -f /usr/local/libexec/ytdashboard-pf-load.sh
echo "   done."

echo "== [2/5] Stopping the old unprivileged dashboard (port 5757) =="
DEV_UID=$(id -u "$REAL_USER")
launchctl bootout "gui/$DEV_UID/com.ajay.devsarohayoutubedashboard" 2>/dev/null || true
sudo -u "$REAL_USER" launchctl unload "/Users/$REAL_USER/Library/LaunchAgents/com.ajay.devsarohayoutubedashboard.plist" 2>/dev/null || true
lsof -ti tcp:5757 2>/dev/null | xargs -r kill 2>/dev/null || true
echo "   done."

echo "== [3/5] Writing the new HTTPS dashboard LaunchDaemon =="
PLIST=/Library/LaunchDaemons/com.ajay.devsarohayoutubedashboard.https.plist
tee "$PLIST" > /dev/null <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ajay.devsarohayoutubedashboard.https</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>$BASE_DIR/scripts/dashboard.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$BASE_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONPATH</key>
        <string>/Users/$REAL_USER/Library/Python/3.9/lib/python/site-packages</string>
        <key>HOME</key>
        <string>/Users/$REAL_USER</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$BASE_DIR/logs/dashboard_https_stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$BASE_DIR/logs/dashboard_https_stderr.log</string>
</dict>
</plist>
PLISTEOF
chown root:wheel "$PLIST"
chmod 644 "$PLIST"
echo "   wrote $PLIST"

echo "== [4/5] Loading the new LaunchDaemon =="
launchctl bootout system/com.ajay.devsarohayoutubedashboard.https 2>/dev/null || true
launchctl bootstrap system "$PLIST"
launchctl enable system/com.ajay.devsarohayoutubedashboard.https
echo "   done."

echo "== [5/5] Testing =="
sleep 2
echo "-- launchd status --"
launchctl list | grep devsarohayoutubedashboard || echo "(not listed -- check logs)"
echo "-- https://localhost/ --"
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://localhost/ || echo "curl failed"
echo "-- http://localhost/ (should redirect) --"
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost/ || echo "curl failed"

echo
echo "If both show HTTP 200 / 301 above, open this on the Mac (or any device"
echo "on the same network) in a browser:"
echo
echo "    https://yt-upload-progress.local"
echo
echo "Logs if anything looks wrong:"
echo "  $BASE_DIR/logs/dashboard_https_stderr.log"
