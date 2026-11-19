(() => {
  'use strict';

  const pageHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'platform.x.com', 'platform.twitter.com']);
  const videoHost = 'video.twimg.com';
  const posterHost = 'pbs.twimg.com';
  const playerSelector = '[data-testid="videoPlayer"], [data-testid="videoComponent"]';
  const scanned = new WeakSet();
  const media = new Map();
  const maxScriptSize = 2 * 1024 * 1024;
  const maxPageSize = 8 * 1024 * 1024;
  const pageTimeout = 8000;

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
    // Download-button availability is presentation metadata. Only actual access,
    // encryption and live-media restrictions invalidate an otherwise readable file.
    const disabled = record.is_protected === true || record.is_drm_protected === true ||
      record.has_drm === true || record.is_live === true ||
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
    let cardBudget = maxScriptSize;
    while (queue.length) {
      const entry = queue.pop();
      if (!entry || typeof entry !== 'object') continue;
      if (entry.media_url_https || entry.preview_image_url) rememberRecord(entry);
      // Website carousel cards carry their actual video records inside this
      // named JSON string, rather than the post's ordinary media_entities2.
      const cardText = entry.key === 'unified_card' && entry.value?.string_value;
      if (typeof cardText === 'string' && cardText.length <= cardBudget) {
        cardBudget -= cardText.length;
        try {
          const card = JSON.parse(cardText);
          if (card?.media_entities && typeof card.media_entities === 'object' && !Array.isArray(card.media_entities)) {
            queue.push(...Object.values(card.media_entities).slice(0, 80));
          }
        } catch {}
      }
      for (const child of Object.values(entry)) if (child && typeof child === 'object') queue.push(child);
    }
  }

  function hasMediaMetadata(text) {
    return (text.includes('video.twimg.com') || text.includes('pbs.twimg.com')) &&
      /variants|allow_download|allowDownload|downloadable|is_protected|is_drm_protected|has_drm|is_live|ext_media_availability/.test(text);
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

  function selectedPost(page, video, path) {
    const article = video?.closest?.('article');
    const links = [...path, ...(article?.querySelectorAll?.('a[href]') || [])];
    const posts = new Set(links.filter(node => node.tagName === 'A')
      .map(node => postUrl(node.href || node.getAttribute?.('href'), page)).filter(Boolean));
    if (posts.size) return posts.size === 1 ? posts.values().next().value : null;
    return postUrl(page.href);
  }

  const resolve = ({ document, page, video, path = [] }) => {
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
    for (const script of document.querySelectorAll('script:not([src])')) readHydration(script);
    const current = videoVariant(video?.currentSrc || video?.getAttribute?.('src'));
    // Recycled players can retain the previous poster after binding a new
    // complete video URL. The actual playable file identifies that selection.
    const identity = current?.key || posterFor(video, player) || download?.key;
    if (!identity && !player) return null;
    const known = media.get(identity);
    if (known?.disabled) return { error: '此 X 视频受保护或当前不可读取。' };
    const declared = known?.variants.reduce((best, item) => !best || item.bitrate > best.bitrate ? item : best, null);
    const source = (download?.key === identity && download) || declared ||
      (current?.key === identity && current) || (identity && observedVariant(identity, document));
    if (source) return { url: source.url, pageUrl: selectedPost(page, video, path) || known?.pageUrl || page.href };
    return { error: '当前 X 帖文没有可读取的完整视频文件。可打开帖子详情后再试。' };
  };

  resolve.selectedPage = context => {
    const { document, page, video, path = [], singleVideo } = context;
    if (video?.mediaKeys || video?.srcObject) return { blocked: true };
    if (!pageHosts.has(page?.hostname) || page.protocol !== 'https:' || !video ||
        video.isConnected === false ||
        (document.defaultView?.location && document.defaultView.location.href !== page.href)) return null;
    // Reuse the same bounded metadata ingestion and clicked-player identity.
    resolve(context);
    const identity = videoVariant(video.currentSrc || video.getAttribute?.('src'))?.key || posterFor(video, localPlayer(video, path));
    const selected = selectedPost(page, video, path);
    const videoId = selected && /\/status\/(\d+)$/.exec(selected)?.[1];
    if (!identity || !videoId) return null;
    const known = media.get(identity);
    if (known?.disabled) return { blocked: true };
    if (known?.pageUrl && /\/status\/(\d+)$/.exec(known.pageUrl)?.[1] !== videoId) return null;
    const related = [...media.entries()].filter(([, item]) => /\/status\/(\d+)$/.exec(item.pageUrl || '')?.[1] === videoId);
    // The page downloader cannot select a carousel member. Keep those captures
    // on their exact-file path rather than downloading the first post video.
    if (related.length > 1 || (related.length === 1 && related[0][0] !== identity)) return null;
    const article = video.closest?.('article');
    const articleVideos = article?.querySelectorAll?.('video');
    if (article && articleVideos?.length !== 1) return null;
    if (!article && singleVideo !== true && related.length !== 1) return null;
    return { url: selected, videoId };
  };

  resolve.matchesSelection = (found, snapshot) => {
    const selected = videoVariant(snapshot?.url)?.key || posterKey(snapshot?.poster);
    return Boolean(selected && videoVariant(found?.url)?.key === selected);
  };

  async function readPage(response, signal) {
    if (Number(response.headers.get('content-length')) > maxPageSize || !response.body?.getReader) {
      void response.body?.cancel().catch(() => {});
      throw new Error('X 页面数据无法读取。');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0, html = '';
    try {
      while (true) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) return html + decoder.decode();
        size += part.value.byteLength;
        if (size > maxPageSize) throw new Error('X 页面数据过大。');
        html += decoder.decode(part.value, { stream: true });
      }
    } finally { void reader.cancel().catch(() => {}); }
  }

  // A timeline route change does not always leave the selected post's Relay
  // response in the DOM. Recover only its own same-origin public HTML, then
  // bind a complete MP4 to the clicked player's existing thumbnail identity.
  resolve.resolveAsync = async context => {
    const initial = resolve(context);
    const { document, page, video, path = [] } = context;
    if (initial?.url || !pageHosts.has(page?.hostname) || !video || video.mediaKeys || video.srcObject) return initial;
    const player = localPlayer(video, path);
    const identity = videoVariant(video.currentSrc || video.getAttribute?.('src'))?.key || posterFor(video, player);
    if (!identity || media.get(identity)?.disabled) return initial;
    const post = selectedPost(page, video, path);
    if (!post) return initial;
    const address = new URL(new URL(post).pathname, page.origin).href;
    const samePage = () => !document.defaultView?.location || document.defaultView.location.href === page.href;
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([(async () => {
        const response = await fetch(address, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
          headers: { Accept: 'text/html' }, signal: controller.signal });
        if (response.status !== 200 || response.redirected || response.url !== address ||
            !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
          void response.body?.cancel().catch(() => {});
          return initial;
        }
        const html = await readPage(response, controller.signal);
        controller.signal.throwIfAborted();
        if (!samePage()) return { error: '页面已切换，请在当前视频上重新采集。' };
        const template = document.createElement('template');
        template.innerHTML = html;
        for (const script of template.content.querySelectorAll('script:not([src])')) readHydration(script);
        // X can remove or recycle the player while a right-click is handled.
        // Resolve the identity captured at the gesture, never the later DOM.
        const known = media.get(identity);
        if (known?.disabled) return { error: '此 X 视频受保护或当前不可读取。' };
        const source = known?.variants.reduce((best, item) => !best || item.bitrate > best.bitrate ? item : best, null) ||
          observedVariant(identity, document);
        return source ? { url: source.url, pageUrl: address } : initial;
      })(), new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('读取 X 视频来源超时，请重试。');
          controller.abort(error);
          reject(error);
        }, pageTimeout);
      })]);
    } catch {
      return { error: controller.signal.aborted ? '读取 X 视频来源超时，请重试。' : '暂时无法读取 X 视频来源，请刷新帖子后重试。' };
    } finally { clearTimeout(timer); }
  };
  globalThis.MosaicXVideo = resolve;

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
