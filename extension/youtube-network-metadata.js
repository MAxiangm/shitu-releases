(() => {
  'use strict';

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const PAGE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
  const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

  function address(value, base) {
    if (typeof value !== 'string' || !value || value.length > 16384 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    try {
      const url = new URL(value, base);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash ? url : null;
    } catch { return null; }
  }
  function mediaAddress(value) {
    const url = address(value);
    if (!url || !/^(?:[a-z0-9-]+\.)+googlevideo\.com$/i.test(url.hostname) || url.pathname !== '/videoplayback' ||
        ['sq', 'live', 'ump', 'sabr'].some(key => url.searchParams.has(key))) return null;
    for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length > 1) return null;
    const id = url.searchParams.get('id'), itag = url.searchParams.get('itag');
    if (!id || !/^[A-Za-z0-9_.-]{1,160}$/.test(id) || !/^\d{1,5}$/.test(itag || '')) return null;
    return url;
  }
  function fullMediaAddress(value) {
    const url = mediaAddress(value);
    if (!url) return null;
    if (url.searchParams.has('range')) {
      const signed = [...(url.searchParams.get('sparams') || '').split(','), ...(url.searchParams.get('lsparams') || '').split(',')];
      if (signed.includes('range') || !/^\d+-\d+$/.test(url.searchParams.get('range'))) return null;
      // Byte ranges are request controls, never signature fields. All auth,
      // n-challenge and client parameters stay exactly as the player sent them.
      url.search = url.search.slice(1).split('&').filter(pair => !new URLSearchParams(pair).has('range')).join('&');
    }
    return url;
  }
  function positive(value, max) {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    return Number.isFinite(number) && number > 0 && number <= max ? number : undefined;
  }
  function cleanPlayer(value) {
    const videoId = value?.videoDetails?.videoId;
    if (!VIDEO_ID.test(videoId || '')) return null;
    const record = { videoId, title: String(value.videoDetails.title || '').slice(0, 240),
      duration: positive(value.videoDetails.lengthSeconds, 7 * 86400), formats: [] };
    const live = value.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow === true || Boolean(value.playabilityStatus?.liveStreamability);
    const protectedVideo = Boolean(value.streamingData?.licenseInfos?.length || value.streamingData?.drmParams);
    if (value.playabilityStatus?.status !== 'OK' || live || protectedVideo) {
      record.restricted = true;
      return record;
    }
    const formats = [...(Array.isArray(value.streamingData?.formats) ? value.streamingData.formats : []),
      ...(Array.isArray(value.streamingData?.adaptiveFormats) ? value.streamingData.adaptiveFormats : [])];
    for (const entry of formats.slice(0, 128)) {
      if (!entry || entry.drmFamilies?.length || entry.drmTrackType || entry.isSabr) continue;
      let raw = entry.url;
      const cipher = entry.signatureCipher || entry.cipher;
      if (!raw && typeof cipher === 'string' && cipher.length <= 20000) raw = new URLSearchParams(cipher).get('url');
      const url = mediaAddress(raw);
      const type = typeof entry.mimeType === 'string' ? entry.mimeType.split(';')[0].trim().toLowerCase() : '';
      if (!url || !/^(?:video|audio)\/(?:mp4|webm)$/.test(type) || Number(url.searchParams.get('itag')) !== entry.itag) continue;
      const contentLength = positive(entry.contentLength || url.searchParams.get('clen'), MAX_MEDIA_BYTES);
      if (!Number.isSafeInteger(contentLength)) continue;
      const lmt = String(entry.lastModified || url.searchParams.get('lmt') || '');
      if (lmt && !/^\d{1,24}$/.test(lmt)) continue;
      if ((url.searchParams.has('clen') && String(contentLength) !== url.searchParams.get('clen')) ||
          (url.searchParams.has('lmt') && lmt !== url.searchParams.get('lmt')) ||
          (url.searchParams.has('mime') && url.searchParams.get('mime') !== type)) continue;
      const audioTrack = typeof entry.audioTrack?.id === 'string' ? entry.audioTrack.id.slice(0, 80) : '';
      const hasVideo = type.startsWith('video/');
      const hasAudio = type.startsWith('audio/') || Boolean(entry.audioQuality || entry.audioSampleRate) || /codecs="[^"]*(?:mp4a|opus|vorbis)/i.test(entry.mimeType);
      record.formats.push({ id: url.searchParams.get('id'), itag: entry.itag, lmt,
        xtags: url.searchParams.get('xtags') || '', audioTrack, isDrc: entry.isDrc === true,
        mimeType: type, contentLength, hasVideo, hasAudio,
        duration: positive(entry.approxDurationMs, 7 * 86400 * 1000) / 1000 || record.duration,
        width: positive(entry.width, 32768), height: positive(entry.height, 32768) });
    }
    return record;
  }
  function matchingFormat(record, value) {
    const url = fullMediaAddress(value);
    if (!url || !record || record.restricted) return null;
    const matches = record.formats.filter(format => format.id === url.searchParams.get('id') &&
      format.itag === Number(url.searchParams.get('itag')) &&
      (!format.lmt || format.lmt === url.searchParams.get('lmt')) &&
      (!url.searchParams.has('clen') || String(format.contentLength) === url.searchParams.get('clen')) &&
      (!url.searchParams.has('mime') || format.mimeType === url.searchParams.get('mime')) &&
      format.xtags === (url.searchParams.get('xtags') || ''));
    if (matches.length !== 1) return null;
    const format = matches[0];
    return { url: url.href, ...format, id: undefined, lmt: undefined, xtags: undefined };
  }

  if (typeof module === 'object' && module?.exports) module.exports = { mediaAddress, fullMediaAddress, cleanPlayer, matchingFormat };
  if (typeof location !== 'object' || location.protocol !== 'https:' || !PAGE_HOSTS.has(location.hostname) ||
      globalThis.__mosaicYouTubeMetadataInstalled) return;
  globalThis.__mosaicYouTubeMetadataInstalled = true;

  const videos = new Map(), observed = new Map(), scanned = new WeakMap();
  let serial = 0, ownNode = null, activeReads = 0;
  function publish() {
    if (!document.documentElement || !videos.size) return;
    // A script element's textContent is a TrustedScript sink even when its type
    // is application/json. Keep this cross-world data in an inert hidden node.
    const node = document.createElement('div'); node.setAttribute('hidden', '');
    node.setAttribute('data-mosaic-youtube-media', '');
    do { node.id = `mosaic-youtube-media-${++serial}`; } while (document.getElementById(node.id));
    const records = [];
    for (const entry of videos.values()) records.push({ videoId: entry.videoId, title: entry.title, duration: entry.duration,
      ...(entry.restricted ? { restricted: true } : {}), streams: [...entry.streams.values()].map(({ identity, ...stream }) => stream) });
    while (JSON.stringify({ videos: records }).length > 512 * 1024) {
      if (records.length > 1) records.shift();
      else if (records[0]?.streams.length) records[0].streams.pop();
      else return;
    }
    node.textContent = JSON.stringify({ videos: records });
    document.documentElement.appendChild(node); ownNode?.remove(); ownNode = node;
  }
  function bind(record, value) {
    const stream = matchingFormat(record, value);
    if (!stream) return false;
    const key = `${stream.itag}/${stream.audioTrack}/${stream.isDrc ? 'drc' : ''}`;
    const prior = record.streams.get(key);
    // Refresh on signed URL changes, but avoid republishing every unchanged
    // range request solely because the player's counters moved.
    const identity = new URL(stream.url);
    for (const field of ['rn', 'rbuf']) identity.searchParams.delete(field);
    if (prior?.identity === identity.href) return false;
    record.streams.set(key, { ...stream, identity: identity.href });
    if (record.streams.size > 32) record.streams.delete(record.streams.keys().next().value);
    return true;
  }
  function collect(value) {
    const clean = cleanPlayer(value);
    if (!clean) return;
    clean.streams = new Map();
    if (!clean.restricted) for (const entry of observed.values()) bind(clean, entry.url);
    videos.delete(clean.videoId); videos.set(clean.videoId, clean);
    if (videos.size > 5) videos.delete(videos.keys().next().value);
    publish();
  }
  function observeUrl(value) {
    const url = mediaAddress(value);
    if (!url) return;
    const cutoff = Date.now() - 5 * 60000;
    for (const [key, item] of observed) if (item.at < cutoff) observed.delete(key);
    observed.delete(url.href); observed.set(url.href, { url: url.href, at: Date.now() });
    if (observed.size > 160) observed.delete(observed.keys().next().value);
    let changed = false;
    for (const record of videos.values()) changed = bind(record, url.href) || changed;
    if (changed) publish();
  }
  function playerTarget(value) {
    const url = address(value, location.href);
    return url && url.origin === location.origin && /^\/youtubei\/v1\/player\/?$/.test(url.pathname) ? url.href : null;
  }
  function inputAddress(value) {
    if (typeof value === 'string') return value;
    if (typeof Request === 'function' && value instanceof Request) return value.url;
    return value instanceof URL ? value.href : null;
  }
  async function inspectResponse(response) {
    if (activeReads >= 3 || response.status !== 200 || !playerTarget(response.url) || response.redirected ||
        !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) return;
    activeReads++; let reader, timer, expired = false;
    try {
      reader = response.clone().body?.getReader(); if (!reader) return;
      timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 8000);
      const decoder = new TextDecoder(); let text = '', bytes = 0;
      while (true) {
        const part = await reader.read(); if (expired) return; if (part.done) break;
        bytes += part.value.byteLength; if (bytes > MAX_RESPONSE_BYTES) return;
        text += decoder.decode(part.value, { stream: true });
      }
      collect(JSON.parse(text + decoder.decode()));
    } catch { /* Observations never change the player's own request. */ }
    finally { clearTimeout(timer); if (reader) void reader.cancel().catch(() => {}); activeReads--; }
  }
  if (typeof globalThis.fetch === 'function') {
    const original = globalThis.fetch;
    globalThis.fetch = function fetch(input) {
      const result = Reflect.apply(original, this, arguments);
      let url; try { url = inputAddress(input); } catch {}
      try {
        if (playerTarget(url)) void result.then(response => { void inspectResponse(response); }, () => {}).catch(() => {});
        else if (mediaAddress(url)) void result.then(response => {
          if (response.status === 200 || response.status === 206) observeUrl(response.url || url);
        }, () => {}).catch(() => {});
      } catch {}
      return result;
    };
  }
  if (typeof XMLHttpRequest === 'function') {
    const original = XMLHttpRequest.prototype.open, targets = new WeakMap(), watching = new WeakSet();
    XMLHttpRequest.prototype.open = function open(method, value) {
      const result = Reflect.apply(original, this, arguments);
      const url = inputAddress(value); targets.set(this, playerTarget(url) ? 'player' : mediaAddress(url) ? 'media' : null);
      if (!watching.has(this)) {
        watching.add(this); this.addEventListener('load', event => {
          try {
            if (targets.get(this) === 'media' && [200, 206].includes(this.status)) observeUrl(this.responseURL);
            else if (targets.get(this) === 'player' && this.status === 200 && playerTarget(this.responseURL) &&
                event.loaded <= MAX_RESPONSE_BYTES && event.total <= MAX_RESPONSE_BYTES &&
                Number(this.getResponseHeader('content-length')) <= MAX_RESPONSE_BYTES) {
              if (this.responseType === 'json') collect(this.response);
              else if ((this.responseType === '' || this.responseType === 'text') && this.responseText.length <= MAX_RESPONSE_BYTES) collect(JSON.parse(this.responseText));
            }
          } catch {}
        });
      }
      return result;
    };
  }
  function inspectScript(node) {
    if (node?.tagName !== 'SCRIPT' || node.src || node.hasAttribute?.('data-mosaic-youtube-media')) return;
    const text = node.textContent;
    if (!text || text.length > MAX_RESPONSE_BYTES || scanned.get(node) === text) return;
    scanned.set(node, text);
    const match = /(?:^|[;\s])(?:var\s+|let\s+|const\s+)?(?:window\.)?ytInitialPlayerResponse\s*=\s*(\{)/.exec(text);
    if (!match) return;
    const start = match.index + match[0].lastIndexOf('{'); let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { try { collect(JSON.parse(text.slice(start, index + 1))); } catch {} return; }
    }
  }
  function inspectWithin(node) { inspectScript(node); for (const script of node?.querySelectorAll?.('script:not([src])') || []) inspectScript(script); }
  if (typeof MutationObserver === 'function') new MutationObserver(changes => {
    for (const change of changes) {
      inspectScript(change.target?.tagName === 'SCRIPT' ? change.target : change.target?.parentElement);
      for (const node of change.addedNodes || []) inspectWithin(node);
      for (const node of change.removedNodes || []) inspectWithin(node);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
  inspectWithin(document);
  if (typeof PerformanceObserver === 'function') {
    try { new PerformanceObserver(list => { for (const entry of list.getEntries()) observeUrl(entry.name); }).observe({ type: 'resource', buffered: true }); } catch {}
  }
  try { for (const entry of performance.getEntriesByType('resource')) observeUrl(entry.name); } catch {}
})();
