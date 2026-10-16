# YouTube Bulk Uploader

Electron desktop app that uploads videos from the external SSD to the YouTube channel.
Successor to the Python scripts in `legacy/` (originally `~/dev-saroha-youtube-upload`).

## Run

```bash
export PATH=/opt/homebrew/bin:$PATH   # Node was installed via Homebrew
npm install
npm start
npm test
```

## Layout

- `src/main/` – main process: `uploader.js` (run loop, quota, guards), `auth.js` (OAuth loopback sign-in), `scanner.js`, `manifest.js`, `config.js`
- `src/renderer/` – dashboard UI (no framework; untrusted text is never injected as HTML)
- `data/` – dev-mode state: `manifest.json` (legacy format, carried over), `config.json`, `token.json`, `client_secret.json`
- `credentials/`, `certs/`, `bin/`, `logs/` – copies from the legacy app (git-ignored)
- `legacy/` – original scripts, launchd plists, manifest/log snapshots (reference only)

## Behaviour carried over from the legacy script

- Source: `/Volumes/PortableSSD/DEV DATA/personal/FINAL OUTPUTS` (change in Settings), recursive, skips `._*` sidecars
- Titles: folder names + filename joined with ` - `, `_` → space, max 100 chars
- Unlisted by default; daily cap 95 (resets midnight Pacific); stops on YouTube quota errors
- Skips when paused, SSD missing, or offline; files fail permanently after 5 attempts
- Auto-run every 30 min while the app is open

## Resumable uploads and duplicate protection

- Each upload uses YouTube's resumable protocol; the session URL is saved in `sessions.json`. If the app quits, crashes,
  or the network drops, the next run asks YouTube how much it already has and continues from there (no re-sending).
- If the saved session says the video was already complete, it is recorded without re-uploading.
- If a session has expired, the channel's recent uploads are checked for the same title and adopted instead of duplicated.
  This needs the `youtube.readonly` scope: use **Sign in** in Settings once (the legacy token only had upload permission).

## Cut-over warning

The legacy LaunchAgent (`com.ajay.devsarohayoutubeupload`) still runs every 30 min against its own manifest.
Unload the legacy job before unpausing this one so videos aren't uploaded twice:

```bash
launchctl bootout gui/$(id -u)/com.ajay.devsarohayoutubeupload
```

## Not yet done

Upload speed check, menu-bar/background mode, custom icon, HTTPS/`yt-upload-progress.local` remote view.
