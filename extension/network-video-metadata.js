(() => {
  'use strict';

  const hosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
  if (location.protocol !== 'https:' || !hosts.has(location.hostname) || globalThis.__mosaicVideoMetadataInstalled) return;
  globalThis.__mosaicVideoMetadataInstalled = true;

  const operations = new Set(['TweetDetail', 'TweetResultByRestId', 'UserTweets', 'UserTweetsAndReplies', 'UserMedia',
    'HomeTimeline', 'HomeLatestTimeline', 'SearchTimeline', 'Bookmarks', 'Likes', 'ListLatestTweetsTimeline']);
  const byteLimit = 4 * 1024 * 1024;
  const recordLimit = 80;
  const records = new Map();
  let activeReads = 0;
  let serial = 0;
  let ownNode = null;

  function address(value, base) {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    try {
      const url = new URL(value, base);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash ? url : null;
    } catch { return null; }
  }

  function target(value) {
    const url = address(value, location.href);
    if (!url || !hosts.has(url.hostname) || url.origin !== location.origin) return null;
    const match = /^\/i\/api\/graphql\/[A-Za-z0-9_-]{1,128}\/([A-Za-z]+)$/.exec(url.pathname);
    return match && operations.has(match[1]) ? url.href : null;
  }

  function requestAddress(input) {
    if (typeof input === 'string') return input;
    if (typeof Request === 'function' && input instanceof Request) return input.url;
    if (input instanceof URL) return input.href;
    return null;
  }

  function poster(value) {
    const url = address(value);
    if (!url || url.hostname !== 'pbs.twimg.com') return null;
    const numbered = /^\/(ext_tw_video|amplify_video)_thumb\/(\d+)\//.exec(url.pathname);
    if (numbered) return { url: url.href, key: `${numbered[1]}/${numbered[2]}` };
    const gif = /^\/tweet_video_thumb\/([\w-]+)(?:\.(?:jpg|png|webp))?$/i.exec(url.pathname);
    return gif ? { url: url.href, key: `tweet_video/${gif[1]}` } : null;
  }

  function variant(value, key) {
    if (!value || value.content_type !== 'video/mp4') return null;
    const url = address(value.url);
    if (!url || url.hostname !== 'video.twimg.com' || !/\.mp4$/i.test(url.pathname)) return null;
    const numbered = /^\/(ext_tw_video|amplify_video)\/(\d+)\/(?:pu\/)?vid\//.exec(url.pathname);
    const gif = /^\/tweet_video\/([\w-]+)\.mp4$/i.exec(url.pathname);
    const identity = numbered ? `${numbered[1]}/${numbered[2]}` : gif ? `tweet_video/${gif[1]}` : null;
    if (identity !== key) return null;
    const bitrate = Number(value.bitrate ?? value.bit_rate);
    return { content_type: 'video/mp4', url: url.href,
      bitrate: Number.isFinite(bitrate) && bitrate >= 0 && bitrate <= 1e9 ? bitrate : 0 };
  }

  function post(value) {
    const url = address(value);
    if (!url || !hosts.has(url.hostname)) return null;
    const path = /^\/(?:[A-Za-z0-9_]+\/status|i\/web\/status)\/\d+(?=\/|$)/.exec(url.pathname);
    return path ? new URL(path[0], url.origin).href : null;
  }

  function cleanRecord(value) {
    if (!value || !['video', 'animated_gif'].includes(value.type)) return null;
    const image = poster(value.media_url_https || value.preview_image_url);
    if (!image) return null;
    const items = value.video_info?.variants || value.variants;
    const variants = Array.isArray(items) ? items.slice(0, 30).map(item => variant(item, image.key)).filter(Boolean) : [];
    const clean = { type: value.type, media_url_https: image.url, video_info: { variants } };
    const pageUrl = post(value.expanded_url);
    if (pageUrl) clean.expanded_url = pageUrl;
    let restricted = false;
    for (const key of ['allow_download', 'allowDownload', 'downloadable']) {
      if (value[key] === false) { clean[key] = false; restricted = true; }
    }
    if (value.allow_download_status?.allow_download === false) {
      clean.allow_download_status = { allow_download: false }; restricted = true;
    }
    for (const key of ['is_protected', 'is_drm_protected', 'has_drm', 'is_live']) {
      if (value[key] === true) { clean[key] = true; restricted = true; }
    }
    if (typeof value.ext_media_availability?.status === 'string' && value.ext_media_availability.status !== 'Available') {
      clean.ext_media_availability = { status: 'Unavailable' }; restricted = true;
    }
    return variants.length || restricted ? { key: image.key, record: clean } : null;
  }

  function publish() {
    if (!document.documentElement || !records.size) return;
    const node = document.createElement('script');
    node.type = 'application/json';
    node.setAttribute('data-mosaic-video-records', '');
    do { node.id = `mosaic-video-records-${++serial}`; } while (document.getElementById(node.id));
    let payload = JSON.stringify({ media: [...records.values()] });
    while (payload.length > 512 * 1024 && records.size > 1) {
      records.delete(records.keys().next().value);
      payload = JSON.stringify({ media: [...records.values()] });
    }
    node.textContent = payload;
    document.documentElement.appendChild(node);
    // Only remove our own previous data node. A new node identity is needed by
    // content scripts that remember which hydration scripts they have parsed.
    ownNode?.remove();
    ownNode = node;
  }

  function collect(data) {
    if (!data || typeof data !== 'object') return;
    const queue = [data];
    const visited = new WeakSet();
    let cardBudget = byteLimit;
    let changed = false;
    for (let index = 0; index < queue.length && index < 50000; index++) {
      const entry = queue[index];
      if (!entry || typeof entry !== 'object' || visited.has(entry)) continue;
      visited.add(entry);
      const cardText = entry.key === 'unified_card' && entry.value?.string_value;
      if (typeof cardText === 'string' && cardText.length <= cardBudget) {
        cardBudget -= cardText.length;
        try {
          const card = JSON.parse(cardText);
          if (card?.media_entities && typeof card.media_entities === 'object' && !Array.isArray(card.media_entities)) {
            queue.push(...Object.values(card.media_entities).slice(0, recordLimit));
          }
        } catch {}
      }
      const cleaned = cleanRecord(entry);
      if (cleaned) {
        const previous = records.get(cleaned.key);
        // Sparse access/protection metadata must not be erased by a later rendition.
        if (previous) {
          for (const key of ['allow_download', 'allowDownload', 'downloadable', 'is_protected', 'is_drm_protected',
            'has_drm', 'is_live', 'allow_download_status', 'ext_media_availability']) {
            if (Object.hasOwn(previous, key)) cleaned.record[key] = previous[key];
          }
          if (!cleaned.record.video_info.variants.length) cleaned.record.video_info = previous.video_info;
        }
        records.delete(cleaned.key);
        records.set(cleaned.key, cleaned.record);
        if (records.size > recordLimit) records.delete(records.keys().next().value);
        changed = true;
      }
      for (const child of Object.values(entry)) {
        if (child && typeof child === 'object' && queue.length < 50000) queue.push(child);
      }
    }
    if (changed) publish();
  }

  const scannedScripts = new WeakMap();
  function inspectScript(script) {
    if (script?.tagName !== 'SCRIPT' || script.src || script.hasAttribute?.('data-mosaic-video-records')) return;
    const text = script.textContent;
    if (!text || text.length > 2 * 1024 * 1024 || scannedScripts.get(script) === text ||
        (!text.includes('video.twimg.com') && !text.includes('pbs.twimg.com')) ||
        !/variants|unified_card|is_protected|is_drm_protected|has_drm|is_live|ext_media_availability/.test(text)) return;
    scannedScripts.set(script, text);
    if (script.type === 'application/json' || script.type === 'application/ld+json') {
      try { collect(JSON.parse(text)); } catch {}
      return;
    }
    if (!text.includes('$_TSR') && !text.includes('$R["tsr"]') && !text.trimStart().startsWith('window.__INITIAL_STATE__')) return;
    if (text.trimStart().startsWith('window.__INITIAL_STATE__')) {
      try { collect(JSON.parse(text.slice(text.indexOf('=') + 1).trim().replace(/;\s*$/, ''))); } catch {}
      return;
    }
    // Read the data literals in X's self-removing SSR stream scripts without
    // executing any of the script or retaining unrelated fields from the JSON.
    for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
      if (!match[0].includes('video.twimg.com') && !match[0].includes('pbs.twimg.com')) continue;
      try {
        const decoded = JSON.parse(match[0]);
        if (decoded.startsWith('{') || decoded.startsWith('[')) collect(JSON.parse(decoded));
      } catch {}
    }
  }

  function inspectScriptsWithin(node) {
    inspectScript(node);
    for (const script of node?.querySelectorAll?.('script:not([src])') || []) inspectScript(script);
  }

  if (typeof MutationObserver === 'function') {
    new MutationObserver(changes => {
      for (const change of changes) {
        inspectScript(change.target?.tagName === 'SCRIPT' ? change.target : change.target?.parentElement);
        for (const node of change.addedNodes || []) inspectScriptsWithin(node);
        for (const node of change.removedNodes || []) inspectScriptsWithin(node);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  }
  inspectScriptsWithin(document);

  async function inspectResponse(response) {
    if (activeReads >= 3 || response.status !== 200 || response.redirected || !target(response.url) ||
        !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length')) > byteLimit) return;
    activeReads++;
    let reader;
    let timeout;
    let expired = false;
    try {
      const clone = response.clone();
      if (!clone.body?.getReader) return;
      reader = clone.body.getReader();
      timeout = setTimeout(() => {
        expired = true;
        void reader.cancel().catch(() => {});
      }, 8000);
      const decoder = new TextDecoder();
      let bytes = 0, text = '';
      while (true) {
        const part = await reader.read();
        if (expired) return;
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > byteLimit) return;
        text += decoder.decode(part.value, { stream: true });
      }
      collect(JSON.parse(text + decoder.decode()));
    } catch { /* Observing metadata must never affect the website request. */ }
    finally {
      clearTimeout(timeout);
      if (reader) void reader.cancel().catch(() => {});
      activeReads--;
    }
  }

  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function fetch(input, init) {
      const result = Reflect.apply(originalFetch, this, arguments);
      let eligible = false;
      try { eligible = Boolean(target(requestAddress(input))); } catch {}
      if (eligible) {
        // Keep the original Promise and Response objects, including their
        // rejection and body-consumption behavior, entirely with the site.
        try { void result.then(response => { void inspectResponse(response); }, () => {}).catch(() => {}); } catch {}
      }
      return result;
    };
  }

  if (typeof XMLHttpRequest === 'function') {
    const originalOpen = XMLHttpRequest.prototype.open;
    const watched = new WeakSet();
    const requests = new WeakMap();
    XMLHttpRequest.prototype.open = function open(method, url) {
      const result = Reflect.apply(originalOpen, this, arguments);
      requests.set(this, target(typeof url === 'string' ? url : url instanceof URL ? url.href : null));
      if (!watched.has(this)) {
        watched.add(this);
        this.addEventListener('load', event => {
          try {
            if (!requests.get(this) || this.status !== 200 || !target(this.responseURL) ||
                !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(this.getResponseHeader('content-type') || '') ||
                event.loaded > byteLimit || event.total > byteLimit || Number(this.getResponseHeader('content-length')) > byteLimit) return;
            if (this.responseType === 'json') collect(this.response);
            else if (this.responseType === '' || this.responseType === 'text') {
              const value = this.responseText;
              if (value.length <= byteLimit && new TextEncoder().encode(value).byteLength <= byteLimit) collect(JSON.parse(value));
            }
          } catch { /* Never change the XHR response or its event delivery. */ }
        });
      }
      return result;
    };
  }

  if (!document.documentElement) document.addEventListener('DOMContentLoaded', publish, { once: true });
})();
