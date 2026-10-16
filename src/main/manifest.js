'use strict';
const fs = require('fs');
const path = require('path');

// Manifest format is intentionally identical to the legacy manifest.json:
// { "<path relative to source root>": { status, attempts, title, youtube_id,
//   upload_date_pt, uploaded_at, last_error } }
// so the legacy history can be imported as-is.
class Manifest {
  constructor(dir) {
    this.file = path.join(dir, 'manifest.json');
    this.entries = {};
    try {
      this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.entries = {};
    }
  }
  get(key) {
    return this.entries[key];
  }
  set(key, entry) {
    this.entries[key] = entry;
    this.save();
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2));
    fs.renameSync(tmp, this.file);
  }
  /** Merge entries from another manifest file without overwriting existing ones. */
  importFrom(file) {
    const other = JSON.parse(fs.readFileSync(file, 'utf8'));
    let added = 0;
    for (const [k, v] of Object.entries(other)) {
      if (!this.entries[k]) {
        this.entries[k] = v;
        added++;
      }
    }
    if (added) this.save();
    return added;
  }
  uploadedToday(todayPT) {
    return Object.values(this.entries).filter(
      (e) => e.status === 'uploaded' && e.upload_date_pt === todayPT
    ).length;
  }
  resetFailed() {
    let n = 0;
    for (const e of Object.values(this.entries)) {
      if (e.status === 'failed') {
        e.attempts = 0;
        delete e.status;
        n++;
      }
    }
    if (n) this.save();
    return n;
  }
}

module.exports = { Manifest };
