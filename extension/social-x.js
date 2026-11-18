(() => {
  'use strict';

  const pageHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'platform.x.com', 'platform.twitter.com']);
  const videoHost = 'video.twimg.com';
  const posterHost = 'pbs.twimg.com';
  const playerSelector = '[data-testid="videoPlayer"], [data-testid="videoComponent"]';
  const scanned = new WeakSet();
  const media = new Map();
  const maxScriptSize = 2 * 1024 * 1024;

  function httpsUrl(value, base) {
    try {
      if (typeof value !== 'string' || !value.trim()) return null;
      const url = new URL(value, base);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
    } catch { return null; }
  }

  function posterKey(value) {
    const url = httpsUrl(value);
    if (url?.hostname !== posterHost) return null;
    const numbered = /^\/(ext_tw_video|amplify_video)_thumb\/(\d+)\//.exec(url.pathname);
    if (numbered) return `${numbered[1]}/${numbered[2]}`;
    const gif = /^\/tweet_video_thumb\/([\w-]+)(?:\.(?:jpg|png|webp))?$/i.exec(url.pathname);
    return gif ? `tweet_video/${gif[1]}` : null;
  }

  function videoVariant(value) {
    const url = httpsUrl(value);
    if (url?.hostname !== videoHost || !/\.mp4$/i.test(url.pathname)) return null;
    const numbered = /^\/(ext_tw_video|amplify_video)\/(\d+)\/(?:pu\/)?vid\//.exec(url.pathname);
    if (numbered) return { url: url.href, key: `${numbered[1]}/${numbered[2]}` };
    const gif = /^\/tweet_video\/([\w-]+)\.mp4$/i.exec(url.pathname);
    return gif ? { url: url.href, key: `tweet_video/${gif[1]}` } : null;
  }

  function postUrl(value, page) {
    const url = httpsUrl(value, page);
    if (!url || !pageHosts.has(url.hostname)) return null;
    const canonical = /^\/(?:[A-Za-z0-9_]+\/status|i\/web\/status)\/\d+(?=\/|$)/.exec(url.pathname);
    return canonical ? new URL(canonical[0], url.origin).href : null;
  }

  function rememberRecord(record) {
    const poster = posterKey(record.media_url_https || record.preview_image_url);
    if (!poster || !['video', 'animated_gif'].includes(record.type)) return;
    const disabled = record.allow_download_status?.allow_download === false || record.allow_download === false ||
      record.allowDownload === false || record.downloadable === false || record.is_protected === true ||
      (record.ext_media_availability?.status && record.ext_media_availability.status !== 'Available');
    const items = record.video_info?.variants || record.variants;
    if (!disabled && !Array.isArray(items)) return;
    const variants = [];
    for (const item of Array.isArray(items) ? items.slice(0, 30) : []) {
      if (item?.content_type !== 'video/mp4') continue;
      const variant = videoVariant(item.url);
      if (variant?.key === poster) variants.push({ ...variant, bitrate: Number(item.bitrate ?? item.bit_rate) || 0 });
    }
    const previous = media.get(poster);
    const result = {
      disabled: Boolean(disabled || previous?.disabled),
      variants: variants.length ? variants : previous?.variants || [],
      pageUrl: postUrl(record.expanded_url) || previous?.pageUrl
    };
    media.delete(poster);
    media.set(poster, result);
    if (media.size > 160) media.delete(media.keys().next().value);
  }

  function readJson(value) {
    let record;
    try { record = JSON.parse(value); } catch { return; }
    if (!record || typeof record !== 'object') return;
    const queue = [record];
    while (queue.length) {
      const entry = queue.pop();
      if (!entry || typeof entry !== 'object') continue;
      if (entry.media_url_https || entry.preview_image_url) rememberRecord(entry);
      for (const child of Object.values(entry)) if (child && typeof child === 'object') queue.push(child);
    }
  }

  function hasMediaMetadata(text) {
    return (text.includes('video.twimg.com') || text.includes('pbs.twimg.com')) &&
      /variants|allow_download|allowDownload|downloadable|is_protected|ext_media_availability/.test(text);
  }

  function readHydration(script) {
    if (scanned.has(script) || script.src) return;
    const text = script.textContent;
    if (!text || text.length > maxScriptSize || !hasMediaMetadata(text)) return;
    scanned.add(script);
    if (script.type === 'application/json' || script.type === 'application/ld+json') {
      readJson(text);
      return;
    }
    if (!text.includes('$_TSR') && !text.includes('$R["tsr"]') && !text.startsWith('window.__INITIAL_STATE__')) return;
    // X's public page uses TanStack Router stream scripts containing serialized
    // Relay responses. Parse their JSON string literals as data, even if the
    // page removes the script nodes immediately after executing them.
    if (text.startsWith('window.__INITIAL_STATE__')) readJson(text.slice(text.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
    for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
      const literal = match[0];
      if (!hasMediaMetadata(literal)) continue;
      let decoded;
      try { decoded = JSON.parse(literal); } catch { continue; }
      if (decoded.startsWith('{') || decoded.startsWith('[')) readJson(decoded);
    }
  }

  function posterFor(video, player) {
    const key = posterKey(video?.poster || video?.getAttribute?.('poster'));
    if (key || !player) return key;
    const keys = new Set();
    for (const image of player.querySelectorAll('img')) {
      const identity = posterKey(image.currentSrc || image.getAttribute('src'));
      if (identity) keys.add(identity);
    }
    return keys.size === 1 ? keys.values().next().value : null;
  }

  function localPlayer(video, path) {
    return video?.closest?.(playerSelector) || path.find(node => node.matches?.(playerSelector));
  }

  function observedVariant(key, document) {
    const entries = document.defaultView?.performance?.getEntriesByType?.('resource') || [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const variant = videoVariant(entries[index].name);
      if (variant?.key === key) return variant;
    }
    return null;
  }

  globalThis.MosaicXVideo = ({ document, page, video, path = [] }) => {
    if (!pageHosts.has(page?.hostname)) return null;
    const player = localPlayer(video, path);
    if (!video && player) {
      const players = player.querySelectorAll('video');
      if (players.length === 1) video = players[0];
    }
    const link = path.find(node => node.tagName === 'A' && node.hasAttribute('download'));
    const download = videoVariant(link?.href);
    if (!player && !video && !download) return null;
    if (video?.mediaKeys || video?.srcObject) return { error: '此 X 视频需要使用网站提供的下载功能。' };
    if (video?.controlsList?.contains('nodownload')) return { error: '此 X 视频的下载已关闭。' };
    for (const script of document.querySelectorAll('script:not([src])')) readHydration(script);
    const current = videoVariant(video?.currentSrc || video?.getAttribute?.('src'));
    const identity = posterFor(video, player) || current?.key || download?.key;
    if (!identity && !player) return null;
    const known = media.get(identity);
    if (known?.disabled) return { error: '此 X 视频的下载已关闭。' };
    const declared = known?.variants.reduce((best, item) => !best || item.bitrate > best.bitrate ? item : best, null);
    const source = (download?.key === identity && download) || declared ||
      (current?.key === identity && current) || (identity && observedVariant(identity, document));
    if (source) return { url: source.url, pageUrl: known?.pageUrl || postUrl(page.href) || page.href };
    return { error: '当前 X 帖文没有可读取的完整视频文件。可打开帖子详情后再试。' };
  };

  if (typeof document !== 'undefined' && pageHosts.has(location.hostname) && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.target.tagName === 'SCRIPT') readHydration(record.target);
        for (const node of record.addedNodes) if (node.tagName === 'SCRIPT') readHydration(node);
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }
})();
