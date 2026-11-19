(() => {
  'use strict';

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const PAGE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
  const EMBED_HOSTS = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com']);
  const CARD_SELECTOR = 'yt-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ' +
    'ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ' +
    'ytd-reel-item-renderer, ytd-reel-video-renderer, ytm-video-with-context-renderer, ytm-video-card-renderer, ' +
    'ytm-shorts-lockup-view-model, ytm-reel-video-renderer, [data-video-id]';

  function pageSource(value, base) {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192) return null;
    let url;
    try { url = new URL(value, base); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    let id;
    if (url.hostname === 'youtu.be') id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    else if (PAGE_HOSTS.has(url.hostname)) {
      if (/^\/watch\/?$/.test(url.pathname)) {
        const ids = url.searchParams.getAll('v');
        if (ids.length !== 1) return null;
        id = ids[0];
      } else id = /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    } else if (EMBED_HOSTS.has(url.hostname)) id = /^\/embed\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (!VIDEO_ID.test(id || '')) return null;
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    return { url: canonical, sourceType: 'youtube', videoId: id, pageUrl: canonical };
  }

  function isPage(page) {
    return page.protocol === 'https:' && !page.username && !page.password && !page.port &&
      (PAGE_HOSTS.has(page.hostname) || EMBED_HOSTS.has(page.hostname));
  }

  function nodeSource(node, page) {
    if (!node?.getAttribute) return null;
    if (node.tagName === 'A') return pageSource(node.getAttribute('href'), page.href);
    if (node.tagName === 'IFRAME') return pageSource(node.getAttribute('src'), page.href);
    return null;
  }

  function cardSource(card, page) {
    const id = card.getAttribute?.('data-video-id') || card.getAttribute?.('video-id');
    if (VIDEO_ID.test(id || '')) return pageSource(`https://www.youtube.com/watch?v=${id}`);
    const sources = new Map();
    for (const link of Array.from(card.querySelectorAll?.('a[href]') || []).slice(0, 100)) {
      const source = nodeSource(link, page);
      if (source) sources.set(source.videoId, source);
    }
    return sources.size === 1 ? sources.values().next().value : null;
  }

  function nameFor(node, document, card) {
    const title = node?.getAttribute?.('title') || card?.querySelector?.('#video-title, [id="video-title-link"], h3')?.textContent ||
      (node?.tagName === 'A' ? node.textContent : '') || document.title;
    return String(title || '').replace(/\s*[-–|]\s*YouTube\s*$/i, '').trim().slice(0, 240) || undefined;
  }

  function resolve({ document, page, video, path = [] }) {
    if (!isPage(page)) return null;
    if (video?.mediaKeys || video?.srcObject) return { error: '这个 YouTube 视频无法保存为普通视频文件。' };

    // A clicked link identifies its own video, including recommendations next
    // to another playing video. Never infer a recommendation from the route.
    const direct = path.map(node => ({ node, source: nodeSource(node, page) })).find(item => item.source);
    if (direct) return { ...direct.source, name: nameFor(direct.node, document) };
    const cards = [];
    for (const node of [...path, ...(video ? [video] : [])]) {
      const card = node?.closest?.(CARD_SELECTOR);
      if (card && !cards.includes(card)) cards.push(card);
    }
    if (cards.length) {
      const source = cardSource(cards[0], page);
      if (source) return { ...source, name: nameFor(null, document, cards[0]) };
      // Shorts can omit links to themselves. Only the explicitly active reel
      // may use the current /shorts/ route; adjacent preloaded reels may not.
      if (video && /^(?:YTD|YTM)-REEL-VIDEO-RENDERER$/.test(cards[0].tagName || '') &&
          cards[0].hasAttribute?.('is-active') && /^\/shorts\//.test(page.pathname)) {
        const active = pageSource(page.href);
        if (active) return { ...active, name: nameFor(video, document, cards[0]) };
      }
      // A card containing multiple IDs is ambiguous (for example a collection).
      // Do not silently download the unrelated main player in that situation.
      return video ? { error: '无法确定所选 YouTube 视频，请在该视频的标题或封面上重新采集。' } : null;
    }
    if (!video) return null;
    const source = pageSource(page.href);
    if (!source) return { error: '无法确定所选 YouTube 视频，请打开视频页面后重新采集。' };
    return { ...source, name: nameFor(video, document) };
  }

  resolve.pageSource = pageSource;
  resolve.isPage = isPage;
  globalThis.MosaicYouTubeVideo = resolve;
})();
