'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Config } = require('./config');
const { Manifest } = require('./manifest');
const { Auth } = require('./auth');
const { Uploader } = require('./uploader');
const { Sessions } = require('./sessions');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
// In development all state lives in ./data (seeded from the legacy app);
// packaged builds use the standard per-user app data folder.
const IS_BUNDLED = __dirname.includes('.app/Contents/Resources');
const DATA_DIR = IS_BUNDLED ? app.getPath('userData') : path.join(PROJECT_ROOT, 'data');

// First launch of the installed app: seed state (manifest, token, config) from the
// development folder so uploads continue exactly where they left off.
if (IS_BUNDLED && !fs.existsSync(path.join(DATA_DIR, 'manifest.json'))) {
  const seed = path.join(require('os').homedir(), 'youtube-bulk-uploader', 'data');
  if (fs.existsSync(seed)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const f of fs.readdirSync(seed)) {
      fs.copyFileSync(path.join(seed, f), path.join(DATA_DIR, f));
      if (/token|client_secret/.test(f)) fs.chmodSync(path.join(DATA_DIR, f), 0o600);
    }
  }
}

let win;
let timer;
let config, manifest, auth, uploader;

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', uploader.snapshot());
}

function setupSchedule() {
  clearInterval(timer);
  const mins = config.get().autoRunMinutes;
  if (mins > 0) timer = setInterval(() => uploader.run('scheduled'), mins * 60 * 1000);
}

function bootstrap() {
  config = new Config(DATA_DIR);
  manifest = new Manifest(DATA_DIR);
  auth = new Auth(DATA_DIR, (url) => shell.openExternal(url));
  uploader = new Uploader({ config, manifest, auth, sessions: new Sessions(DATA_DIR) });

  // First launch: reuse the legacy app's credentials copied into ./credentials.
  if (!auth.status().signedIn && fs.existsSync(path.join(PROJECT_ROOT, 'credentials', 'token.json'))) {
    try {
      auth.importLegacy(PROJECT_ROOT);
      uploader.log('Imported existing YouTube authorization from ./credentials.');
    } catch (e) {
      uploader.log('Could not import legacy credentials: ' + e.message);
    }
  }
  // Legacy pause flag carries over once, then the in-app setting is the source of truth.
  const legacyPause = path.join(DATA_DIR, 'paused.flag');
  if (fs.existsSync(legacyPause)) {
    config.set({ paused: true });
    fs.rmSync(legacyPause, { force: true });
  }
  const legacyQuota = path.join(DATA_DIR, 'quota_exhausted.flag');
  if (fs.existsSync(legacyQuota)) {
    uploader.quotaFlagDate = fs.readFileSync(legacyQuota, 'utf8').trim();
    fs.rmSync(legacyQuota, { force: true });
  }

  uploader.on('change', pushState);
  uploader.refreshQueue();
  setupSchedule();
  // Re-check when a volume is mounted (e.g. SSD plugged in).
  try {
    fs.watch('/Volumes', () => {
      uploader.refreshQueue();
      pushState();
    });
  } catch {}
}

function registerIpc() {
  ipcMain.handle('state', () => uploader.snapshot());
  ipcMain.handle('run', () => (uploader.run('manual'), true));
  ipcMain.handle('stop', () => (uploader.stop(), true));
  ipcMain.handle('set-paused', (_e, paused) => {
    config.set({ paused: !!paused });
    if (!paused) uploader.run('resume');
    pushState();
    return true;
  });
  ipcMain.handle('set-config', (_e, patch) => {
    config.set(patch);
    setupSchedule();
    uploader.refreshQueue();
    pushState();
    return config.get();
  });
  ipcMain.handle('choose-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled) return null;
    config.set({ sourceRoot: r.filePaths[0] });
    uploader.refreshQueue();
    pushState();
    return r.filePaths[0];
  });
  ipcMain.handle('import-client-secret', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return null;
    auth.importClientSecret(r.filePaths[0]);
    pushState();
    return true;
  });
  ipcMain.handle('sign-in', async () => {
    try {
      await auth.signIn();
      uploader.log('Signed in to YouTube.');
      return { ok: true };
    } catch (e) {
      uploader.log('Sign-in failed: ' + e.message);
      return { ok: false, error: e.message };
    } finally {
      pushState();
    }
  });
  ipcMain.handle('sign-out', () => (auth.signOut(), pushState(), true));
  ipcMain.handle('retry-failed', () => {
    const n = manifest.resetFailed();
    uploader.refreshQueue();
    pushState();
    return n;
  });
  ipcMain.handle('open-external', (_e, url) => {
    if (/^https:\/\/youtu\.be\//.test(url)) shell.openExternal(url);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    backgroundColor: '#111111',
    title: 'YouTube Bulk Uploader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  bootstrap();
  registerIpc();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
