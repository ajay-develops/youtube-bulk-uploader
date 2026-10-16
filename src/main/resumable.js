'use strict';
const fs = require('fs');
const path = require('path');

// Chunks must be a multiple of 256 KiB per the resumable upload protocol.
const CHUNK = 8 * 1024 * 1024;
const BASE = 'https://www.googleapis.com/upload/youtube/v3/videos';

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.wmv': 'video/x-ms-wmv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
};
const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.status = status;
  }
}
/** The saved session is gone (expired / never completed on YouTube's side). */
class SessionExpired extends Error {}
/** Caller asked to stop; the session is kept so the upload resumes later. */
class StopRequested extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRetryable = (e) => !(e instanceof HttpError) || e.status >= 500 || e.status === 429;

async function startSession({ baseUrl, token, metadata, size, mime }) {
  const res = await fetch(`${baseUrl}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': mime,
    },
    body: JSON.stringify(metadata),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  const url = res.headers.get('location');
  if (!url) throw new Error('YouTube did not return an upload session URL.');
  return url;
}

function parseRange(res) {
  const r = res.headers.get('range'); // "bytes=0-12345" => next offset 12346
  const m = r && /bytes=0-(\d+)/.exec(r);
  return m ? Number(m[1]) + 1 : 0;
}

/** Interpret a PUT response: finished video, next offset, expired session, or throw. */
async function interpret(res) {
  if (res.status === 200 || res.status === 201) return { done: true, video: await res.json() };
  if (res.status === 308) return { done: false, offset: parseRange(res) };
  if (res.status === 404 || res.status === 410) throw new SessionExpired(`HTTP ${res.status}`);
  throw new HttpError(res.status, await res.text());
}

/** Ask YouTube how much of the file it already has (or whether it is already finished). */
async function queryStatus(url, size, token) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${size}` },
  });
  return interpret(res);
}

async function sendChunk(url, fh, offset, size, token, chunk) {
  const len = Math.min(chunk, size - offset);
  const buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await fh.read(buf, 0, len, offset);
  if (bytesRead !== len) throw new Error('File changed or became unreadable during upload.');
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` },
    body: buf,
  });
  return interpret(res);
}

/**
 * Resumable upload.
 * @param {object} o
 * @param {() => Promise<string>} o.getToken       fresh access token per request
 * @param {string} o.filePath
 * @param {object} o.metadata                       videos.insert request body
 * @param {string|null} o.sessionUrl                saved session to resume, if any
 * @param {(url:string)=>void} o.onSession          called when a new session is created
 * @param {(bytes:number)=>void} o.onProgress
 * @param {()=>boolean} o.shouldStop
 * @returns {Promise<{video:object, resumedFrom:number}>}
 * @throws SessionExpired when a provided sessionUrl is no longer valid.
 */
async function uploadResumable(o) {
  const baseUrl = o.baseUrl || BASE;
  const chunk = o.chunkSize || CHUNK;
  const size = fs.statSync(o.filePath).size;
  let url = o.sessionUrl || null;
  let offset = 0;
  let resumedFrom = 0;

  if (url) {
    const st = await queryStatus(url, size, await o.getToken()); // may throw SessionExpired
    if (st.done) return { video: st.video, resumedFrom: size };
    offset = resumedFrom = st.offset;
  } else {
    url = await startSession({ baseUrl, token: await o.getToken(), metadata: o.metadata, size, mime: mimeFor(o.filePath) });
    o.onSession(url);
  }

  const fh = await fs.promises.open(o.filePath, 'r');
  try {
    let failures = 0;
    while (true) {
      if (o.shouldStop()) throw new StopRequested();
      o.onProgress(offset);
      try {
        const r = await sendChunk(url, fh, offset, size, await o.getToken(), chunk);
        failures = 0;
        if (r.done) {
          o.onProgress(size);
          return { video: r.video, resumedFrom };
        }
        offset = r.offset;
      } catch (e) {
        if (e instanceof SessionExpired || !isRetryable(e) || ++failures > 6) throw e;
        await sleep(Math.min(30000, 1000 * 2 ** failures) * (o.fastRetry ? 0.001 : 1));
        // Re-sync with the server: the chunk may or may not have landed before the drop.
        const st = await queryStatus(url, size, await o.getToken());
        if (st.done) {
          o.onProgress(size);
          return { video: st.video, resumedFrom };
        }
        offset = st.offset;
      }
    }
  } finally {
    await fh.close();
  }
}

module.exports = { uploadResumable, SessionExpired, StopRequested, HttpError, mimeFor, CHUNK };
