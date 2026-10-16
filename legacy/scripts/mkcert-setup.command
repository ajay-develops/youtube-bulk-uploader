#!/bin/bash
# Run this WITHOUT sudo, directly in Terminal.app on this Mac (interactive,
# real terminal window -- not over a headless SSH session). It will ask for
# your Mac login password partway through (that's macOS's normal "security
# add-trusted-cert" prompt for trusting a new certificate authority) -- type
# it when asked.
#
# What it does:
#   1. Installs the local certificate authority mkcert already generated
#      into your login keychain, so Chrome/Safari trust it.
#   2. Generates a real TLS certificate for yt-upload-progress.local.
#
# After this finishes, run install-https-dashboard.sh WITH sudo to switch
# the dashboard over to serving HTTPS on the friendly URL.

set -euo pipefail
cd "$(dirname "$0")/.."

export CAROOT="$(pwd)/certs"
mkdir -p "$CAROOT"

echo "== Installing local CA into your login keychain (you may be asked for your Mac password) =="
./bin/mkcert -install

echo
echo "== Generating certificate for yt-upload-progress.local =="
./bin/mkcert -cert-file certs/yt-upload-progress.local.pem \
             -key-file certs/yt-upload-progress.local-key.pem \
             yt-upload-progress.local

echo
echo "Done. Certificate files:"
ls -la certs/*.pem

echo
echo "Next: run install-https-dashboard.sh with sudo to finish setup:"
echo "  sudo bash ~/dev-saroha-youtube-upload/scripts/install-https-dashboard.sh"
echo
echo "Press Enter to close this window."
read
