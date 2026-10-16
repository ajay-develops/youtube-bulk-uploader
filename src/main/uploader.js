'use strict';
const fs = require('fs');
const net = require('net');
const { EventEmitter } = require('events');
const { scanVideos, makeTitle } = require('./scanner');
const { uploadResumable, SessionExpired, StopRequested } = require('./resumable');
const { findRecentByTitle } = require('./dedupe');
const { READONLY } = require('./auth');

const QUOTA_MARKERS = [
  'uploadlimitexceeded',
  'ratelimitexceeded',
  'quotaexceeded',
  'dailylimitexceeded',
  'exceeded the number of videos they may upload',
  'quota exceeded for quota metric',
];
const MAX_ATTEMPTS = 5;

/** YouTube's daily quota resets at midnight Pacific. */
function pacificDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

/** Epoch ms of the next midnight in Pacific time (when YouTube's daily quota resets). */
function nextPacificMidnight(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const secs = get('hour') * 3600 + get('minute') * 60 + get('second');
  return now + (86400 - secs) * 1000;
}

function internetUp() {
  const probe = (host, port) =>
    new Promise((resolve) => {
      const s = net.createConnection({ host, port, timeout: 5000 });
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
      s.once('timeout', () => (s.destroy(), resolve(false)));
    });
  return (async () => {
    for (const [h, p] of [['8.8.8.8', 53], ['1.1.1.1', 53], ['1.1.1.1', 443]]) {
      if (await probe(h, p)) return true;
    }
    return false;
  })();
}

class Uploader extends EventEmitter {
  constructor({ config, manifest, auth, sessions }) {
    super();
    this.sessions = sessions;
    this.config = config;
    this.manifest = manifest;
    this.auth = auth;
    this.running = false;
    this.stopRequested = false;
    this.current = null; // { key, title, progress, bytes, size }
    this.logLines = [];
    this.queue = [];
    this.quotaFile = require('path').join(config.dir, 'quota.json');
    try {
      this.quotaFlagDate = JSON.parse(fs.readFileSync(this.quotaFile, 'utf8')).date || null;
    } catch {
      this.quotaFlagDate = null;
    }
    this.lastMessage = '';
  }

  log(msg) {
    const line = `[${new Date().toISOString().slice(0, 19)}] ${msg}`;
    this.lastMessage = msg;
    this.logLines.push(line);
    if (this.logLines.length > 500) this.logLines.shift();
    this.emit('log', line);
    this.emit('change');
  }

  ssdConnected() {
    try {
      return fs.statSync(this.config.get().sourceRoot).isDirectory();
    } catch {
      return false;
    }
  }

  /** Refresh the pending queue (cheap enough to call on demand). */
  refreshQueue() {
    const cfg = this.config.get();
    if (!this.ssdConnected()) {
      this.queue = [];
      return;
    }
    this.queue = scanVideos(cfg.sourceRoot, cfg.extensions).filter(({ key }) => {
      const e = this.manifest.get(key);
      if (!e) return true;
      if (e.status === 'uploaded') return false;
      if (e.status === 'failed' && (e.attempts || 0) >= MAX_ATTEMPTS) return false;
      return true;
    });
  }

  stop() {
    this.stopRequested = true;
  }

  async run(trigger = 'manual') {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.log(`=== Run started (${trigger}) ===`);
    try {
      await this._run();
    } catch (e) {
      this.log(`Run aborted: ${e.message}`);
    } finally {
      this.running = false;
      this.current = null;
      this.refreshQueue();
      this.log('=== Run finished ===');
      this.emit('change');
    }
  }

  async _run() {
    const cfg = this.config.get();
    if (cfg.paused) return this.log('Uploads are paused. Skipping.');
    if (!this.ssdConnected()) return this.log(`Source folder not found (${cfg.sourceRoot}). Is the SSD connected?`);
    if (!(await internetUp())) return this.log('No internet connection. Skipping.');

    const today = pacificDate();
    if (this.quotaFlagDate === today) return this.log(`YouTube daily limit already hit (${today} PT). Resuming tomorrow.`);
    const remaining = cfg.dailyCap - this.manifest.uploadedToday(today);
    if (remaining <= 0) return this.log(`Daily cap of ${cfg.dailyCap} reached for ${today} PT.`);

    this.refreshQueue();
    if (!this.queue.length) return this.log('Nothing left to upload.');

    let done = 0;

    for (const { key, path: file } of [...this.queue]) {
      if (this.stopRequested || this.config.get().paused) return this.log('Stopped.');
      if (done >= remaining) return this.log(`Reached today's cap of ${cfg.dailyCap}.`);

      const title = makeTitle(key);
      const entry = this.manifest.get(key) || { attempts: 0 };
      const st = fs.statSync(file);
      const size = st.size;
      this.current = { key, title, progress: 0, bytes: 0, size };
      this.log(`Uploading: ${key}  ->  "${title}"`);

      try {
        const videoId = await this._uploadOne({ key, file, title, st });
        entry.attempts = (entry.attempts || 0) + 1;
        Object.assign(entry, {
          status: 'uploaded',
          youtube_id: videoId,
          title,
          upload_date_pt: pacificDate(),
          uploaded_at: new Date().toISOString(),
        });
        delete entry.last_error;
        this.manifest.set(key, entry);
        this.sessions.delete(key);
        this.log(`  Success: https://youtu.be/${videoId}`);
        done++;
      } catch (e) {
        if (e instanceof StopRequested) return this.log('Stopped. This video will resume from where it left off.');
        const text = String(e && (e.message || e)).toLowerCase();
        if (QUOTA_MARKERS.some((m) => text.includes(m))) {
          this.quotaFlagDate = pacificDate();
          try {
            fs.writeFileSync(this.quotaFile, JSON.stringify({ date: this.quotaFlagDate }));
          } catch {}
          return this.log('  YouTube says the daily upload limit is reached. Stopping until tomorrow (PT).');
        }
        entry.attempts = (entry.attempts || 0) + 1;
        entry.status = 'failed';
        entry.last_error = String(e.message || e);
        this.manifest.set(key, entry);
        this.log(`  FAILED: ${entry.last_error}`);
      }

      if (!this.ssdConnected()) return this.log('SSD disconnected mid-run. Stopping.');
    }
    this.log(`Uploaded ${done} video(s) this run.`);
  }

  /** Upload one file via a resumable session that survives app restarts. Returns the video id. */
  async _uploadOne({ key, file, title, st }) {
    const oauth = this.auth.getClient();
    const getToken = async () => (await oauth.getAccessToken()).token;
    const cfg = this.config.get();
    const mb = (n) => (n / 1048576).toFixed(0) + ' MB';

    let sess = this.sessions.get(key);
    if (sess && (sess.size !== st.size || sess.mtimeMs !== st.mtimeMs)) {
      this.log('  File changed since the saved upload session; starting over.');
      this.sessions.delete(key);
      sess = null;
    }

    const attempt = async (sessionUrl) => {
      const r = await uploadResumable({
        getToken,
        filePath: file,
        sessionUrl,
        metadata: { snippet: { title, description: '' }, status: { privacyStatus: cfg.privacy } },
        onSession: (url) =>
          this.sessions.set(key, { url, size: st.size, mtimeMs: st.mtimeMs, title, startedAt: Date.now() }),
        onProgress: (bytes) => {
          if (!this.current) return;
          this.current.bytes = bytes;
          this.current.progress = Math.min(1, bytes / st.size);
          this.emit('change');
        },
        shouldStop: () => this.stopRequested || this.config.get().paused,
      });
      if (sessionUrl && r.resumedFrom >= st.size) this.log('  YouTube already had the complete video.');
      else if (sessionUrl && r.resumedFrom > 0) this.log(`  Resumed from ${mb(r.resumedFrom)} of ${mb(st.size)}.`);
      return r.video.id;
    };

    try {
      return await attempt(sess ? sess.url : null);
    } catch (e) {
      if (!(e instanceof SessionExpired) || !sess) throw e;
      this.log('  Saved upload session is no longer valid.');
      if (this.auth.hasScope(READONLY)) {
        const existing = await findRecentByTitle(oauth, title, sess.startedAt);
        if (existing) {
          this.log('  Found this video already on the channel; not uploading a duplicate.');
          return existing;
        }
      } else {
        this.log('  (Duplicate check unavailable: sign in again in Settings to grant read access.)');
      }
      this.sessions.delete(key);
      return attempt(null);
    }
  }

  snapshot() {
    const cfg = this.config.get();
    const today = pacificDate();
    const entries = Object.entries(this.manifest.entries);
    const uploaded = entries
      .filter(([, e]) => e.status === 'uploaded')
      .sort((a, b) => (b[1].uploaded_at || '').localeCompare(a[1].uploaded_at || ''));
    const failed = entries.filter(([, e]) => e.status === 'failed');
    return {
      config: cfg,
      auth: this.auth.status(),
      ssdConnected: this.ssdConnected(),
      running: this.running,
      paused: cfg.paused,
      quotaHit: this.quotaFlagDate === today,
      quotaResetAt: nextPacificMidnight(),
      todayCount: this.manifest.uploadedToday(today),
      current: this.current,
      counts: { uploaded: uploaded.length, failed: failed.length, pending: this.queue.length },
      recent: uploaded.slice(0, 50).map(([key, e]) => ({ key, ...e })),
      failed: failed.map(([key, e]) => ({ key, ...e })),
      queue: this.queue.slice(0, 200).map((q) => q.key),
      log: this.logLines.slice(-100),
    };
  }
}

module.exports = { Uploader, pacificDate, nextPacificMidnight };
