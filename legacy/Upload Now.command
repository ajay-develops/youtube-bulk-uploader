#!/bin/bash
cd "$(dirname "$0")"
echo "Starting manual upload run..."
echo ""
/usr/bin/python3 upload.py
echo ""
echo "Done. Press Enter to close this window."
read
