'use strict';
const fs = require('fs');
const path = require('path');

/** macOS AppleDouble sidecars ("._foo.mp4") keep the video extension but are not videos. */
function isJunk(name) {
  return name.startsWith('._') || name === '.DS_Store';
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.')) yield* walk(full);
    } else if (e.isFile() && !isJunk(e.name)) {
      yield full;
    }
  }
}

function scanVideos(root, extensions) {
  const exts = new Set(extensions.map((e) => e.toLowerCase()));
  const out = [];
  for (const file of walk(root)) {
    if (exts.has(path.extname(file).toLowerCase())) {
      out.push({ key: path.relative(root, file), path: file });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Same title rules as the legacy script: folders + filename joined by " - ", underscores -> spaces. */
function makeTitle(key) {
  const parts = key.split(path.sep);
  const file = parts.pop();
  const stem = path.basename(file, path.extname(file));
  const clean = (s) => s.replace(/_+/g, ' ').trim();
  const segs = [...parts.map(clean), clean(stem)].filter(Boolean);
  const title = segs.length ? segs.join(' - ') : 'Untitled';
  return (title || 'Untitled').slice(0, 100);
}

module.exports = { scanVideos, makeTitle, isJunk };
