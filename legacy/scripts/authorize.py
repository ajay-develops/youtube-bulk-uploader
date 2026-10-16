#!/usr/bin/env python3
"""
One-time OAuth authorization for the "Dev Video Offload" YouTube upload automation.

RUN THIS ONCE, directly in a Terminal.app window on THIS Mac (not over a
headless/non-interactive SSH session -- it needs to open a real browser
window), while logged into Chrome as the Google account that owns Dev
Saroha's YouTube channel.

It will:
  1. Open a browser window asking you to sign in and grant upload permission
     to the "Dev Video Offload" app (you'll see an "unverified app" warning --
     click "Advanced" then "Go to Dev Video Offload (unsafe)" to proceed;
     this is expected and safe, it's just Google's standard warning for
     personal-use apps that haven't gone through their full review process).
  2. Save a long-lived token to credentials/token.json.

After this runs successfully once, the main upload script reads that token
file automatically forever -- you should not need to run this again unless
the token is later revoked.
"""
import os
from google_auth_oauthlib.flow import InstalledAppFlow

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "credentials")
CLIENT_SECRET_FILE = os.path.join(CREDENTIALS_DIR, "client_secret.json")
TOKEN_FILE = os.path.join(CREDENTIALS_DIR, "token.json")

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]


def main():
    if not os.path.exists(CLIENT_SECRET_FILE):
        print(f"ERROR: {CLIENT_SECRET_FILE} not found.")
        return

    if os.path.exists(TOKEN_FILE):
        answer = input(f"{TOKEN_FILE} already exists. Re-authorize and overwrite it? [y/N] ")
        if answer.strip().lower() != "y":
            print("Cancelled -- existing token left untouched.")
            return

    print("Opening a browser window for you to sign in and grant access...")
    flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET_FILE, SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent")

    with open(TOKEN_FILE, "w") as f:
        f.write(creds.to_json())
    os.chmod(TOKEN_FILE, 0o600)

    print(f"\nSuccess. Token saved to {TOKEN_FILE}")
    print("You can close this terminal now -- the upload script will use this token automatically.")


if __name__ == "__main__":
    main()
