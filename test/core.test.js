'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanVideos, makeTitle } = require('../src/main/scanner');
const { Manifest } = require('../src/main/manifest');

test('makeTitle joins folders and filename, underscores to spaces', () => {
  assert.strictEqual(makeTitle(path.join('VISHAL TFH', 'H_fe_1.mp4')), 'VISHAL TFH - H fe 1');
  assert.strictEqual(makeTitle('2407.mp4'), '2407');
  assert.strictEqual(makeTitle('  .mp4'), 'Untitled');
  assert.strictEqual(makeTitle('x'.repeat(200) + '.mp4').length, 100);
});

test('scanVideos skips AppleDouble sidecars and non-videos', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'a.mp4'), 'x');
  fs.writeFileSync(path.join(d, '._a.mp4'), 'x');
  fs.writeFileSync(path.join(d, 'sub', 'b.MOV'), 'x');
  fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  const keys = scanVideos(d, ['.mp4', '.mov']).map((v) => v.key);
  assert.deepStrictEqual(keys, ['a.mp4', path.join('sub', 'b.MOV')]);
});

test('legacy manifest loads and counts uploads per Pacific day', () => {
  const m = new Manifest(path.join(__dirname, '..', 'data'));
  if (!Object.keys(m.entries).length) return; // data/ not seeded in CI
  const total = Object.keys(m.entries).length;
  assert.ok(total > 0);
  const day = Object.values(m.entries)[0].upload_date_pt;
  assert.ok(m.uploadedToday(day) >= 1);
});

test('nextPacificMidnight is within 24h and lands on Pacific midnight', () => {
  const { nextPacificMidnight } = require('../src/main/uploader');
  const now = Date.parse('2026-10-16T09:25:00Z'); // 02:25 PDT
  const at = nextPacificMidnight(now);
  assert.strictEqual(at - now, (21 * 60 + 35) * 60 * 1000);
  assert.ok(nextPacificMidnight(Date.now()) - Date.now() <= 86400000);
});
