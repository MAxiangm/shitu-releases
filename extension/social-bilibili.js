(() => {
  'use strict';

  const CARD = '.bili-video-card, .video-page-card-small, .video-card, .small-item';
  const PLAYER = '.bpx-player-container, .bilibili-player';
  function pageSource(value, base) {
    const source = globalThis.MosaicVideoPages?.videoPageSource(value, base);
    return source?.site === 'bilibili' ? source : null;
  }
  function isPage(page) {
    return globalThis.MosaicVideoPages?.siteForUrl(page) === 'bilibili';
  }
  function nodeSource(node, page) {
    return node?.tagName === 'A' ? pageSource(node.getAttribute?.('href'), page.href) : null;
  }
  function cardSource(card, page) {
    const sources = new Map();
    for (const link of Array.from(card.querySelectorAll?.('a[href]') || []).slice(0, 100)) {
      const source = nodeSource(link, page);
      if (source) sources.set(source.videoId, source);
    }
    // Multiple parts or videos in one card must be explicitly selected.
    if (sources.size) return sources.size === 1 ? sources.values().next().value : null;
    const bvid = card.getAttribute?.('data-bvid'), aid = card.getAttribute?.('data-aid');
    const id = /^BV[A-Za-z0-9]{10}$/.test(bvid || '') ? bvid : /^[1-9]\d{0,19}$/.test(aid || '') ? `av${aid}` : null;
    return id ? pageSource(`https://www.bilibili.com/video/${id}/?p=1`) : null;
  }
  function selectedPartAgrees(document, page, source) {
    const selected = Array.from(document.querySelectorAll?.(
      '.multi-page .cur a[href], .video-pod .active a[href], a[aria-current="page"], a[aria-selected="true"]') || []).slice(0, 100);
    for (const node of selected) {
      const part = nodeSource(node, page);
      if (part && part.videoId !== source.videoId) return false;
    }
    return true;
  }
  function selectedPage({ document, page, video, path = [], singleVideo = false }) {
    if (!isPage(page)) return null;
    if (video?.mediaKeys || video?.srcObject) return { blocked: true };
    if (video && video.isConnected === false) return null;
    const ownCard = video?.closest?.(CARD);
    if (ownCard) return cardSource(ownCard, page);
    const current = pageSource(page.href);
    // A linked recommendation covering the actual player still refers to the
    // video under the pointer. A separate preview/card is resolved above.
    if (video && current && (video.closest?.(PLAYER) || singleVideo)) {
      return selectedPartAgrees(document, page, current) ? current : null;
    }
    const direct = path.map(node => nodeSource(node, page)).filter(Boolean);
    if (direct.length) {
      const unique = new Map(direct.map(source => [source.videoId, source]));
      return unique.size === 1 ? unique.values().next().value : null;
    }
    const cards = [];
    for (const node of path) {
      const card = node?.closest?.(CARD);
      if (card && !cards.includes(card)) cards.push(card);
    }
    return cards.length === 1 ? cardSource(cards[0], page) : null;
  }
  function resolve(context) {
    const source = selectedPage(context);
    if (source?.blocked) return { error: '当前 Bilibili 视频受到保护，无法采集。' };
    if (!source) return context.video ? { error: '无法确定所选 Bilibili 视频和分集，请在对应视频页面重新采集。' } : null;
    const title = context.video?.getAttribute?.('title') || context.path?.find(node => node.tagName === 'A')?.getAttribute?.('title') || context.document.title;
    return { ...source, sourceType: 'site-video', pageUrl: source.url,
      name: String(title || '').replace(/[_-]哔哩哔哩.*$/, '').trim().slice(0, 240) };
  }
  resolve.isPage = isPage;
  resolve.pageSource = pageSource;
  resolve.selectedPage = selectedPage;
  globalThis.MosaicBilibiliVideo = resolve;
})();
