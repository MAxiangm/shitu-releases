'use strict';

// The page observer only publishes URLs that its own player has used. This
// second boundary accepts complete, finite files tied to one exact video ID.
(() => {
  const MAX_BYTES = 512 * 1024 * 1024;
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  function streamUrl(value) {
    if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
          !/^(?:[a-z0-9-]+\.)+googlevideo\.com$/i.test(url.hostname) || url.pathname !== '/videoplayback' ||
          ['range', 'sq', 'live', 'ump', 'sabr'].some(key => url.searchParams.has(key))) return null;
      if (!/^[A-Za-z0-9_.-]{1,160}$/.test(url.searchParams.get('id') || '') ||
          !/^\d{1,5}$/.test(url.searchParams.get('itag') || '')) return null;
      for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length > 1) return null;
      if (url.searchParams.has('lmt') && !/^\d{1,24}$/.test(url.searchParams.get('lmt'))) return null;
      return url.href;
    } catch { return null; }
  }
  function duration(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 86400;
  }
  function cleanStream(value, expectedDuration) {
    const url = streamUrl(value?.url);
    if (!url || !['video/mp4', 'audio/mp4', 'video/webm', 'audio/webm'].includes(value.mimeType) ||
        !Number.isSafeInteger(value.contentLength) || value.contentLength < 1 || value.contentLength > MAX_BYTES ||
        !Number.isSafeInteger(value.itag) || value.itag < 1 || value.itag > 99999 ||
        String(value.itag) !== new URL(url).searchParams.get('itag') ||
        typeof value.hasVideo !== 'boolean' || typeof value.hasAudio !== 'boolean' ||
        (!value.hasVideo && !value.hasAudio) || value.hasVideo !== value.mimeType.startsWith('video/') ||
        !duration(value.duration) || Math.abs(value.duration - expectedDuration) > Math.max(2, expectedDuration * 0.02)) return null;
    const clen = new URL(url).searchParams.get('clen');
    if (clen !== null && clen !== String(value.contentLength)) return null;
    return { url, mimeType: value.mimeType, contentLength: value.contentLength, duration: value.duration,
      itag: value.itag, hasVideo: value.hasVideo, hasAudio: value.hasAudio };
  }
  function checkedSource(value) {
    if (!value || value.sourceType !== 'youtube-browser' || value.kind !== 'video' ||
        !VIDEO_ID.test(value.videoId || '') || value.url !== `https://www.youtube.com/watch?v=${value.videoId}` ||
        (value.pageUrl !== undefined && value.pageUrl !== value.url) || !duration(value.expectedDuration) ||
        value.expectedAudio !== true || !Array.isArray(value.streams) || ![1, 2].includes(value.streams.length)) return null;
    const streams = value.streams.map(stream => cleanStream(stream, value.expectedDuration));
    if (streams.some(stream => !stream) || streams.reduce((sum, stream) => sum + stream.contentLength, 0) > MAX_BYTES ||
        new Set(streams.map(stream => stream.url)).size !== streams.length) return null;
    if (streams.length === 1 ? !streams[0].hasVideo || !streams[0].hasAudio
      : !(streams.filter(stream => stream.hasVideo && !stream.hasAudio).length === 1 &&
          streams.filter(stream => stream.hasAudio && !stream.hasVideo).length === 1 &&
          streams[0].mimeType.split('/')[1] === streams[1].mimeType.split('/')[1])) return null;
    return { sourceType: 'youtube-browser', kind: 'video', videoId: value.videoId, url: value.url, pageUrl: value.url,
      expectedDuration: value.expectedDuration, expectedAudio: true, streams };
  }
  function selectSource(document, videoId) {
    if (!VIDEO_ID.test(videoId || '')) return null;
    const records = [];
    for (const node of Array.from(document.querySelectorAll('div[data-mosaic-youtube-media]')).slice(-5)) {
      if (typeof node.textContent !== 'string' || node.textContent.length > 512 * 1024) continue;
      try {
        const payload = JSON.parse(node.textContent);
        if (Array.isArray(payload?.videos)) records.push(...payload.videos.filter(record => record?.videoId === videoId));
      } catch {}
    }
    // Duplicate records make provenance uncertain; the observer owns one node.
    if (records.length !== 1 || records[0].restricted || !duration(records[0].duration) ||
        !Array.isArray(records[0].streams) || records[0].streams.length > 32) return null;
    const record = records[0], canonical = `https://www.youtube.com/watch?v=${videoId}`;
    const make = streams => checkedSource({ sourceType: 'youtube-browser', kind: 'video', videoId, url: canonical,
      expectedDuration: record.duration, expectedAudio: true, streams });
    const rank = stream => (Number.isFinite(stream.height) ? stream.height : 0) * 32768 + (Number.isFinite(stream.width) ? stream.width : 0);
    const valid = record.streams.filter(stream => cleanStream(stream, record.duration));
    const combined = valid.filter(stream => stream.hasVideo && stream.hasAudio).sort((a, b) => rank(b) - rank(a));
    for (const stream of combined) { const result = make([stream]); if (result) return { ...result, name: String(record.title || '').slice(0, 240) }; }
    const videos = valid.filter(stream => stream.hasVideo && !stream.hasAudio).sort((a, b) => rank(b) - rank(a));
    const audios = valid.filter(stream => stream.hasAudio && !stream.hasVideo && stream.isDrc !== true);
    // A language/track switch cannot be reconstructed from stale observations.
    if (new Set(audios.map(stream => stream.audioTrack || '')).size !== 1) return null;
    for (const video of videos) for (const audio of audios) {
      const result = make([video, audio]);
      if (result) return { ...result, name: String(record.title || '').slice(0, 240) };
    }
    return null;
  }
  const api = { streamUrl, checkedSource, selectSource };
  if (typeof module === 'object' && module?.exports) module.exports = api;
  globalThis.MosaicYouTubeBrowser = api;
})();
