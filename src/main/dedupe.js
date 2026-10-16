'use strict';
const { google } = require('googleapis');

/**
 * Look through the channel's most recent uploads for a video with exactly this title
 * published at/after `sinceMs`. Used only when an interrupted upload's session is gone,
 * to adopt a video that actually finished instead of uploading a duplicate.
 * Costs ~1 quota unit per 50 videos (channels.list + playlistItems.list).
 * Requires the youtube.readonly scope.
 * @returns {Promise<string|null>} video id
 */
async function findRecentByTitle(authClient, title, sinceMs) {
  const yt = google.youtube({ version: 'v3', auth: authClient });
  const ch = await yt.channels.list({ part: ['contentDetails'], mine: true });
  const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return null;
  let pageToken;
  for (let page = 0; page < 4; page++) {
    const r = await yt.playlistItems.list({ part: ['snippet'], playlistId: uploads, maxResults: 50, pageToken });
    for (const it of r.data.items || []) {
      const s = it.snippet;
      if (s.title === title && Date.parse(s.publishedAt) >= sinceMs - 60000) return s.resourceId.videoId;
    }
    pageToken = r.data.nextPageToken;
    if (!pageToken) break;
  }
  return null;
}

module.exports = { findRecentByTitle };
