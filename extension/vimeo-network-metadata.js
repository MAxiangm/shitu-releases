(() => {
  'use strict';

  const hosts = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
  if (location.protocol !== 'https:' || !hosts.has(location.hostname) || globalThis.__mosaicVimeoMetadataInstalled) return;
  globalThis.__mosaicVimeoMetadataInstalled = true;
  const byteLimit = 4 * 1024 * 1024;
  const configs = new Map();
  const scanned = new WeakMap();
  let active = 0, serial = 0, ownNode = null;

  function address(value, base) {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    try {
      const url = new URL(value, base);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash ? url : null;
    } catch { return null; }
  }

  function requestTarget(value) {
    const url = address(value, location.href);
    if (!url || !(url.hostname === 'player.vimeo.com' || url.origin === location.origin)) return null;
    return /^\/video\/(\d+)\/config\/?$/.exec(url.pathname)?.[1] || null;
  }

  function currentId() {
    return /^(?:\/(?:video|manage\/videos|channels\/[^/]+|groups\/[^/]+\/videos))?\/(\d+)\/?$/.exec(location.pathname)?.[1] || null;
  }

  function source(value, id) {
    const url = address(value);
    if (!url) return null;
    const redirect = url.hostname === 'player.vimeo.com' && /^\/progressive_redirect\/playback\/(\d+)\//.exec(url.pathname)?.[1] === id;
    if ((!/\.vimeocdn\.com$/i.test(url.hostname) && !redirect) || !/\.(?:mp4|m4v|mov|webm|m3u8|mpd|json)$/i.test(url.pathname)) return null;
    return url.href;
  }

  function manifest(value, id) {
    if (!value || typeof value !== 'object' || !value.cdns || typeof value.cdns !== 'object') return null;
    const cdns = Object.create(null);
    for (const [key, item] of Object.entries(value.cdns).slice(0, 32)) {
      if (!/^[\w-]{1,80}$/.test(key)) continue;
      const url = source(item?.url, id);
      if (url) cdns[key] = { url };
    }
    if (!Object.keys(cdns).length) return null;
    const result = { cdns };
    if (typeof value.default_cdn === 'string' && Object.hasOwn(cdns, value.default_cdn)) result.default_cdn = value.default_cdn;
    return result;
  }

  function positive(value, max) {
    return Number.isFinite(value) && value > 0 && value <= max ? value : undefined;
  }

  function protectedMedia(value) {
    return value === true || typeof value === 'string' && Boolean(value.trim()) && !/^(?:none|false|disabled)$/i.test(value) ||
      Array.isArray(value) && value.length > 0 || value?.enabled === true || Boolean(value?.widevine || value?.fairplay || value?.playready);
  }

  function cleanConfig(value, id) {
    if (!value || String(value.video?.id) !== id || !value.request?.files || typeof value.request.files !== 'object') return null;
    const raw = value.request.files;
    const files = {};
    if (Array.isArray(raw.progressive)) {
      files.progressive = raw.progressive.slice(0, 32).flatMap(item => {
        const url = source(item?.url, id);
        if (!url || !/\.(?:mp4|m4v|mov|webm)(?:\?|$)/i.test(url)) return [];
        const result = { url };
        for (const key of ['width', 'height', 'bitrate']) {
          const number = positive(item[key], key === 'bitrate' ? 1e10 : 65536);
          if (number !== undefined) result[key] = number;
        }
        return [result];
      });
    }
    for (const kind of ['hls', 'dash']) {
      const found = manifest(raw[kind], id);
      if (found) files[kind] = found;
    }
    const video = { id };
    if (typeof value.video.title === 'string') video.title = value.video.title.slice(0, 240);
    if (value.video.is_live === true || value.video.live_event?.status === 'live' || value.request.is_live === true) video.is_live = true;
    if (value.video.is_drm_protected === true || [value.video.drm, value.request.drm, raw.drm].some(protectedMedia)) video.is_drm_protected = true;
    if (!files.progressive?.length && !files.hls && !files.dash && !video.is_drm_protected && !video.is_live) return null;
    return { video, request: { files } };
  }

  function publish() {
    if (!document.documentElement || !configs.size) return;
    const node = document.createElement('script');
    node.type = 'application/json';
    node.setAttribute('data-mosaic-vimeo-config', '');
    do { node.id = `mosaic-vimeo-config-${++serial}`; } while (document.getElementById(node.id));
    node.textContent = JSON.stringify({ configs: [...configs.values()] });
    document.documentElement.appendChild(node);
    ownNode?.remove();
    ownNode = node;
  }

  function collect(value, id) {
    if (!id) return;
    const clean = cleanConfig(value, id);
    if (!clean) return;
    const previous = configs.get(id);
    if (previous?.video.is_drm_protected) clean.video.is_drm_protected = true;
    if (previous?.video.is_live) clean.video.is_live = true;
    if (previous && JSON.stringify(previous) === JSON.stringify(clean)) return;
    configs.delete(id);
    configs.set(id, clean);
    if (configs.size > 10) configs.delete(configs.keys().next().value);
    publish();
  }

  function inputUrl(input) {
    if (typeof input === 'string') return input;
    if (typeof Request === 'function' && input instanceof Request) return input.url;
    return input instanceof URL ? input.href : null;
  }

  async function inspectResponse(response, expectedId) {
    if (active >= 3 || response.status !== 200 || response.redirected || requestTarget(response.url) !== expectedId ||
        !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length')) > byteLimit) return;
    active++;
    let reader, timer, expired = false;
    try {
      const clone = response.clone();
      if (!clone.body?.getReader) return;
      reader = clone.body.getReader();
      timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 8000);
      const decoder = new TextDecoder();
      let bytes = 0, text = '';
      while (true) {
        const item = await reader.read();
        if (expired) return;
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > byteLimit) return;
        text += decoder.decode(item.value, { stream: true });
      }
      collect(JSON.parse(text + decoder.decode()), expectedId);
    } catch { /* Observation never changes the site's request or response. */ }
    finally {
      clearTimeout(timer);
      if (reader) void reader.cancel().catch(() => {});
      active--;
    }
  }

  if (typeof globalThis.fetch === 'function') {
    const original = globalThis.fetch;
    globalThis.fetch = function fetch(input, init) {
      const result = Reflect.apply(original, this, arguments);
      let id;
      try { id = requestTarget(inputUrl(input)); } catch {}
      if (id) try { void result.then(response => { void inspectResponse(response, id); }, () => {}).catch(() => {}); } catch {}
      return result;
    };
  }

  if (typeof XMLHttpRequest === 'function') {
    const original = XMLHttpRequest.prototype.open;
    const ids = new WeakMap(), watching = new WeakSet();
    XMLHttpRequest.prototype.open = function open(method, url) {
      const result = Reflect.apply(original, this, arguments);
      ids.set(this, requestTarget(typeof url === 'string' ? url : url instanceof URL ? url.href : null));
      if (!watching.has(this)) {
        watching.add(this);
        this.addEventListener('load', event => {
          try {
            const id = ids.get(this);
            if (!id || this.status !== 200 || requestTarget(this.responseURL) !== id || event.loaded > byteLimit || event.total > byteLimit ||
                Number(this.getResponseHeader('content-length')) > byteLimit ||
                !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(this.getResponseHeader('content-type') || '')) return;
            if (this.responseType === 'json') collect(this.response, id);
            else if (this.responseType === '' || this.responseType === 'text') {
              const text = this.responseText;
              if (text.length <= byteLimit && new TextEncoder().encode(text).byteLength <= byteLimit) collect(JSON.parse(text), id);
            }
          } catch {}
        });
      }
      return result;
    };
  }

  // Extract only the JSON value assigned to the documented player config
  // object. Scripts are never evaluated or copied into the page.
  function inspectScript(node) {
    if (node?.tagName !== 'SCRIPT' || node.src || node.hasAttribute?.('data-mosaic-vimeo-config')) return;
    const text = node.textContent;
    if (!text || text.length > byteLimit || scanned.get(node) === text) return;
    scanned.set(node, text);
    const id = currentId();
    if (!id) return;
    if (node.type === 'application/json') {
      try { collect(JSON.parse(text), id); } catch {}
      return;
    }
    const match = /(?:^|[;\s])(?:window\.)?playerConfig\s*=\s*(\{)/.exec(text);
    if (!match) return;
    const start = match.index + match[0].lastIndexOf('{');
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { collect(JSON.parse(text.slice(start, index + 1)), id); } catch {}
        return;
      }
    }
  }

  function inspectWithin(node) {
    inspectScript(node);
    for (const script of node?.querySelectorAll?.('script:not([src])') || []) inspectScript(script);
  }

  if (typeof MutationObserver === 'function') new MutationObserver(changes => {
    for (const change of changes) {
      inspectScript(change.target?.tagName === 'SCRIPT' ? change.target : change.target?.parentElement);
      for (const node of change.addedNodes || []) inspectWithin(node);
      for (const node of change.removedNodes || []) inspectWithin(node);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
  inspectWithin(document);
  if (!document.documentElement) document.addEventListener('DOMContentLoaded', publish, { once: true });
})();
