'use strict';
const fs = require('fs');
const path = require('path');

/**
 * In-flight resumable upload sessions, keyed like the manifest (relative path).
 * { url, size, mtimeMs, title, startedAt }
 * Kept separate from manifest.json so the legacy manifest format stays untouched.
 */
class Sessions {
  constructor(dir) {
    this.file = path.join(dir, 'sessions.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }
  get(key) {
    return this.data[key] || null;
  }
  set(key, s) {
    this.data[key] = s;
    this._save();
  }
  delete(key) {
    if (this.data[key]) {
      delete this.data[key];
      this._save();
    }
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Sessions };
