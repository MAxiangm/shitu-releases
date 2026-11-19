(function (scope) {
  'use strict';

  function siteForUrl(value) {
    let page;
    try { page = value instanceof URL ? value : new URL(value); } catch { return null; }
    if (page.protocol !== 'https:' || page.username || page.password || page.port) return null;
    const host = page.hostname.toLowerCase();
    if (['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(host)) return 'instagram';
    if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com', 'platform.twitter.com', 'platform.x.com'].includes(host)) return 'x';
    if (/^(?:[a-z0-9-]+\.)?pinterest\.com$/.test(host)) return 'pinterest';
    if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) return 'vimeo';
    if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host)) return 'bilibili';
    return null;
  }

  function videoPageSource(value, base) {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    let page;
    try { page = new URL(value, base); } catch { return null; }
    const site = siteForUrl(page), pathname = page.pathname;
    let id, match;
    if (site === 'instagram') {
      match = /^\/(?:[A-Za-z0-9_.]+\/)?(reels?|p|tv)\/([A-Za-z0-9_-]{5,32})(?:\/embed(?:\/captioned)?)?\/?$/.exec(pathname);
      if (match) return { site, videoId: match[2], url: `https://www.instagram.com/${match[1] === 'reels' ? 'reel' : match[1]}/${match[2]}/` };
    } else if (site === 'x') {
      id = /^\/(?:[A-Za-z0-9_]+\/status|i\/(?:web\/)?status)\/([1-9]\d{0,31})(?:\/(?:video|photo)\/[1-9]\d?)?\/?$/.exec(pathname)?.[1];
      if (!id && /^platform\./.test(page.hostname) && /^\/embed\/Tweet\.html$/.test(pathname)) {
        const ids = page.searchParams.getAll('id'); if (ids.length === 1) id = ids[0];
      }
      if (/^[1-9]\d{0,31}$/.test(id || '')) return { site, videoId: id, url: `https://x.com/i/status/${id}` };
    } else if (site === 'pinterest') {
      id = /^\/pin\/([1-9]\d{0,31})\/?$/.exec(pathname)?.[1];
      if (id) return { site, videoId: id, url: `https://www.pinterest.com/pin/${id}/` };
    } else if (site === 'vimeo') {
      id = page.hostname === 'player.vimeo.com' ? /^\/video\/([1-9]\d{0,19})\/?$/.exec(pathname)?.[1]
        : /^(?:\/(?:channels\/[^/]+|groups\/[^/]+\/videos))?\/([1-9]\d{0,19})\/?$/.exec(pathname)?.[1];
      if (id) return { site, videoId: id, url: `https://vimeo.com/${id}` };
    } else if (site === 'bilibili') {
      id = /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,19})\/?$/.exec(pathname)?.[1];
      const parts = page.searchParams.getAll('p');
      const part = parts.length ? parts[0] : '1';
      if (!id || parts.length > 1 || !/^[1-9]\d{0,4}$/.test(part) || Number(part) > 10000) return null;
      return { site, videoId: `${id}:p${part}`, url: `https://www.bilibili.com/video/${id}/?p=${part}` };
    }
    return null;
  }

  const api = { videoPageSource, siteForUrl };
  if (typeof module === 'object' && module.exports) module.exports = api;
  scope.MosaicVideoPages = api;
})(globalThis);
