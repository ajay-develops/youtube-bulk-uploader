'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Same folder the legacy script watched.
  sourceRoot: '/Volumes/PortableSSD/DEV DATA/personal/FINAL OUTPUTS',
  dailyCap: 95, // safety margin under YouTube's real daily upload quota
  privacy: 'unlisted', // unlisted | private | public
  autoRunMinutes: 30, // 0 = only run when started manually
  paused: false,
  extensions: ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.wmv', '.mpg', '.mpeg', '.mts', '.m2ts'],
};

class Config {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = { ...DEFAULTS, ...this._read() };
  }
  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }
  get() {
    return { ...this.data };
  }
  set(patch) {
    const allowed = Object.keys(DEFAULTS);
    for (const k of Object.keys(patch)) {
      if (allowed.includes(k)) this.data[k] = patch[k];
    }
    this.data.dailyCap = Math.max(1, Math.min(100, Number(this.data.dailyCap) || DEFAULTS.dailyCap));
    this.data.autoRunMinutes = Math.max(0, Number(this.data.autoRunMinutes) || 0);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}

module.exports = { Config, DEFAULTS };
