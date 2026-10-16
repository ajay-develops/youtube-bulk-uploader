#!/bin/bash
# Run this WITH sudo, on this Mac:
#   sudo bash ~/dev-saroha-youtube-upload/scripts/fix-dashboard-daemon.sh
#
# The dashboard's LaunchDaemon isn't currently loaded at all (no process
# running, nothing listening on 443/80) -- most likely it crashed early on
# and macOS's launchd gave up on it, or it didn't survive a reboot/sleep.
# This rewrites the plist (adds unbuffered python output so the log files
# actually capture what happens, in case it crashes again) and (re)loads it
# fresh.

set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run with sudo (sudo bash $0)"
  exit 1
fi

REAL_USER="dev"
BASE_DIR="/Users/$REAL_USER/dev-saroha-youtube-upload"
PLIST=/Library/LaunchDaemons/com.ajay.devsarohayoutubedashboard.https.plist
LABEL="com.ajay.devsarohayoutubedashboard.https"

echo "== [1/4] Rewriting plist with unbuffered python output =="
tee "$PLIST" > /dev/null <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>-u</string>
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
echo "   done."

echo "== [2/4] Making sure any stale copy is unloaded =="
launchctl bootout "system/$LABEL" 2>/dev/null || true
pkill -f "dashboard.py" 2>/dev/null || true
sleep 1

echo "== [3/4] Loading fresh =="
launchctl bootstrap system "$PLIST"
launchctl enable "system/$LABEL"
launchctl kickstart -k "system/$LABEL"
echo "   done."

echo "== [4/4] Testing =="
sleep 2
echo "-- launchctl print (status) --"
launchctl print "system/$LABEL" 2>&1 | grep -E "state|pid|last exit" 
echo "-- https://localhost/ --"
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://localhost/ --max-time 5
echo "-- http://localhost/ (should redirect) --"
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost/ --max-time 5
echo "-- stderr log --"
tail -n 30 "$BASE_DIR/logs/dashboard_https_stderr.log"
echo "-- stdout log --"
tail -n 30 "$BASE_DIR/logs/dashboard_https_stdout.log"

echo
echo "If https:// shows 200 and http:// shows 301, open:"
echo "    https://yt-upload-progress.local"
