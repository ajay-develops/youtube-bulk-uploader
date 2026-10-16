'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uploadResumable, SessionExpired, StopRequested } = require('../src/main/resumable');

const MB = 1024 * 1024;

/** Minimal imitation of YouTube's resumable upload endpoint. */
function mockServer({ dropOnceAtChunk = -1, expireSessions = false } = {}) {
  const st = { received: 0, bytesSent: 0, chunkCount: 0, dropped: false, inits: 0, total: 0 };
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST') {
      st.inits++;
      st.total = Number(req.headers['x-upload-content-length']);
      res.writeHead(200, { Location: `http://127.0.0.1:${srv.address().port}/session` });
      return res.end();
    }
    if (expireSessions) return res.writeHead(404).end();
    const m = /bytes (?:(\d+)-(\d+)|\*)\/(\d+)/.exec(req.headers['content-range']);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!m[1]) {
        // status query
        if (st.received >= st.total) return res.writeHead(200).end(JSON.stringify({ id: 'vid123' }));
        const h = st.received ? { Range: `bytes=0-${st.received - 1}` } : {};
        return res.writeHead(308, h).end();
      }
      st.chunkCount++;
      if (st.chunkCount === dropOnceAtChunk && !st.dropped) {
        st.dropped = true;
        return req.socket.destroy(); // connection lost mid-upload; chunk not stored
      }
      const body = Buffer.concat(chunks);
      assert.strictEqual(Number(m[1]), st.received, 'client must continue exactly where server left off');
      st.received += body.length;
      st.bytesSent += body.length;
      if (st.received >= st.total) return res.writeHead(200).end(JSON.stringify({ id: 'vid123' }));
      res.writeHead(308, { Range: `bytes=0-${st.received - 1}` }).end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st })));
}

function tmpFile(size) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'up-')), 'v.mp4');
  fs.writeFileSync(f, Buffer.alloc(size, 7));
  return f;
}

const base = (srv) => ({
  baseUrl: `http://127.0.0.1:${srv.address().port}/upload`,
  getToken: async () => 't',
  metadata: { snippet: { title: 'x' }, status: { privacyStatus: 'unlisted' } },
  onProgress: () => {},
  chunkSize: 1 * MB,
  fastRetry: true,
});

test('network drop mid-upload resumes without re-sending earlier bytes', async () => {
  const { srv, st } = await mockServer({ dropOnceAtChunk: 3 });
  const file = tmpFile(5 * MB);
  const r = await uploadResumable({ ...base(srv), filePath: file, sessionUrl: null, onSession: () => {}, shouldStop: () => false });
  assert.strictEqual(r.video.id, 'vid123');
  assert.strictEqual(st.bytesSent, 5 * MB, 'each byte sent exactly once');
  srv.close();
});

test('stop keeps the session; a later call resumes from the saved offset', async () => {
  const { srv, st } = await mockServer();
  const file = tmpFile(5 * MB);
  let session;
  let chunks = 0;
  await assert.rejects(
    uploadResumable({
      ...base(srv), filePath: file, sessionUrl: null,
      onSession: (u) => (session = u),
      onProgress: () => chunks++,
      shouldStop: () => chunks > 2, // "app closed" after ~2 chunks
    }),
    StopRequested
  );
  assert.ok(session, 'session URL was handed back for persistence');
  const partial = st.received;
  assert.ok(partial > 0 && partial < 5 * MB);

  const r = await uploadResumable({ ...base(srv), filePath: file, sessionUrl: session, onSession: () => {}, shouldStop: () => false });
  assert.strictEqual(r.resumedFrom, partial);
  assert.strictEqual(st.inits, 1, 'no new session was created');
  assert.strictEqual(st.bytesSent, 5 * MB);
  srv.close();
});

test('session that already finished on YouTube is detected, nothing re-sent', async () => {
  const { srv, st } = await mockServer();
  const file = tmpFile(2 * MB);
  let session;
  await uploadResumable({ ...base(srv), filePath: file, sessionUrl: null, onSession: (u) => (session = u), shouldStop: () => false });
  const sent = st.bytesSent;
  // App "crashed" before recording success; on restart it asks the saved session.
  const r = await uploadResumable({ ...base(srv), filePath: file, sessionUrl: session, onSession: () => {}, shouldStop: () => false });
  assert.strictEqual(r.video.id, 'vid123');
  assert.strictEqual(st.bytesSent, sent, 'no bytes re-uploaded');
  srv.close();
});

test('expired saved session raises SessionExpired', async () => {
  const { srv } = await mockServer({ expireSessions: true });
  const file = tmpFile(1 * MB);
  await assert.rejects(
    uploadResumable({ ...base(srv), filePath: file, sessionUrl: `http://127.0.0.1:${srv.address().port}/session`, onSession: () => {}, shouldStop: () => false }),
    SessionExpired
  );
  srv.close();
});
