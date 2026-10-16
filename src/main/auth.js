'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { google } = require('googleapis');

// readonly lets the app look at recent uploads to avoid re-uploading a video that
// finished on YouTube but wasn't recorded locally (e.g. app closed at that instant).
const READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', READONLY];

class Auth {
  /** @param {string} dir userData dir  @param {(url:string)=>void} openExternal */
  constructor(dir, openExternal) {
    this.clientFile = path.join(dir, 'client_secret.json');
    this.tokenFile = path.join(dir, 'token.json');
    this.openExternal = openExternal;
  }

  status() {
    return {
      hasClientSecret: fs.existsSync(this.clientFile),
      signedIn: fs.existsSync(this.tokenFile),
      canCheckDuplicates: this.hasScope(READONLY),
    };
  }

  hasScope(scope) {
    try {
      return String(JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')).scope || '').split(/\s+/).includes(scope);
    } catch {
      return false;
    }
  }

  _clientConfig() {
    const raw = JSON.parse(fs.readFileSync(this.clientFile, 'utf8'));
    const c = raw.installed || raw.web;
    if (!c) throw new Error('client_secret.json must be an OAuth "Desktop app" client.');
    return c;
  }

  _writeSecret(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  importClientSecret(srcFile) {
    const raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
    if (!(raw.installed || raw.web)) throw new Error('Not a Google OAuth client file.');
    this._writeSecret(this.clientFile, raw);
  }

  /** Reuse the legacy Python script's authorization so Dev doesn't have to sign in again. */
  importLegacy(legacyDir) {
    const legacyClient = path.join(legacyDir, 'credentials', 'client_secret.json');
    const legacyToken = path.join(legacyDir, 'credentials', 'token.json');
    if (!fs.existsSync(legacyClient) || !fs.existsSync(legacyToken)) {
      throw new Error('Legacy credentials not found in ' + legacyDir);
    }
    this.importClientSecret(legacyClient);
    const t = JSON.parse(fs.readFileSync(legacyToken, 'utf8'));
    if (!t.refresh_token) throw new Error('Legacy token has no refresh_token; sign in again.');
    this._writeSecret(this.tokenFile, {
      refresh_token: t.refresh_token,
      access_token: t.token,
      expiry_date: t.expiry ? Date.parse(t.expiry) : undefined,
      token_type: 'Bearer',
      scope: SCOPES[0], // legacy token only ever had upload permission
    });
  }

  signOut() {
    fs.rmSync(this.tokenFile, { force: true });
  }

  /** Loopback OAuth flow using the system browser. */
  signIn() {
    const c = this._clientConfig();
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('Sign-in timed out.'));
      }, 5 * 60 * 1000);

      server.listen(0, '127.0.0.1', () => {
        const redirect = `http://127.0.0.1:${server.address().port}`;
        const oauth = new google.auth.OAuth2(c.client_id, c.client_secret, redirect);
        const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

        server.on('request', async (req, res) => {
          const u = new URL(req.url, redirect);
          const code = u.searchParams.get('code');
          const err = u.searchParams.get('error');
          if (!code && !err) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h3>You can close this tab and return to YouTube Bulk Uploader.</h3>');
          clearTimeout(timer);
          server.close();
          if (err) return reject(new Error('Google sign-in failed: ' + err));
          try {
            const { tokens } = await oauth.getToken(code);
            this._writeSecret(this.tokenFile, tokens);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        this.openExternal(url);
      });
    });
  }

  /** Authorized OAuth2 client; refreshed tokens are persisted automatically. */
  getClient() {
    if (!fs.existsSync(this.tokenFile)) throw new Error('Not signed in to YouTube.');
    const c = this._clientConfig();
    const oauth = new google.auth.OAuth2(c.client_id, c.client_secret);
    oauth.setCredentials(JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')));
    oauth.on('tokens', (t) => {
      const cur = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      this._writeSecret(this.tokenFile, { ...cur, ...t });
    });
    return oauth;
  }
}

module.exports = { Auth, READONLY };
