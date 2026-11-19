'use strict';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DECIMAL_ID = /^[1-9]\d{0,31}$/;

function invalid() { return Object.assign(new Error('请选择受支持网站中的单个视频或帖子'), { code: 'INVALID_VIDEO_PAGE' }); }

function videoPageSource(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) throw invalid();
  let page;
  try { page = new URL(value); } catch { throw invalid(); }
  if (page.protocol !== 'https:' || page.username || page.password || page.port) throw invalid();
  const host = page.hostname.toLowerCase(), pathname = page.pathname;
  let id, match;
  if (host === 'youtu.be') id = /^\/([^/]+)\/?$/.exec(pathname)?.[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (/^\/watch\/?$/.test(pathname)) {
      const ids = page.searchParams.getAll('v');
      if (ids.length !== 1) throw invalid();
      id = ids[0];
    } else id = /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(pathname)?.[1];
  } else if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) id = /^\/embed\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (id !== undefined) {
    if (!VIDEO_ID.test(id)) throw invalid();
    return { site: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(host)) {
    match = /^\/(?:[A-Za-z0-9_.]+\/)?(reels?|p|tv)\/([A-Za-z0-9_-]{5,32})(?:\/embed(?:\/captioned)?)?\/?$/.exec(pathname);
    if (!match) throw invalid();
    return { site: 'instagram', videoId: match[2], url: `https://www.instagram.com/${match[1] === 'reels' ? 'reel' : match[1]}/${match[2]}/` };
  }
  if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com', 'platform.twitter.com', 'platform.x.com'].includes(host)) {
    id = /^\/(?:[A-Za-z0-9_]+\/status|i\/(?:web\/)?status)\/([1-9]\d{0,31})(?:\/(?:video|photo)\/[1-9]\d?)?\/?$/.exec(pathname)?.[1];
    if (!id && /^platform\./.test(host) && /^\/embed\/Tweet\.html$/.test(pathname)) {
      const ids = page.searchParams.getAll('id'); if (ids.length === 1) id = ids[0];
    }
    if (!DECIMAL_ID.test(id || '')) throw invalid();
    return { site: 'x', videoId: id, url: `https://x.com/i/status/${id}` };
  }
  if (/^(?:[a-z0-9-]+\.)?pinterest\.com$/.test(host)) {
    id = /^\/pin\/([1-9]\d{0,31})\/?$/.exec(pathname)?.[1];
    if (!id) throw invalid();
    return { site: 'pinterest', videoId: id, url: `https://www.pinterest.com/pin/${id}/` };
  }
  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) {
    id = host === 'player.vimeo.com' ? /^\/video\/([1-9]\d{0,19})\/?$/.exec(pathname)?.[1]
      : /^(?:\/(?:channels\/[^/]+|groups\/[^/]+\/videos))?\/([1-9]\d{0,19})\/?$/.exec(pathname)?.[1];
    if (!id) throw invalid();
    return { site: 'vimeo', videoId: id, url: `https://vimeo.com/${id}` };
  }
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host)) {
    id = /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,19})\/?$/.exec(pathname)?.[1];
    const parts = page.searchParams.getAll('p');
    const part = parts.length ? parts[0] : '1';
    if (!id || parts.length > 1 || !/^[1-9]\d{0,4}$/.test(part) || Number(part) > 10000) throw invalid();
    return { site: 'bilibili', videoId: `${id}:p${part}`, url: `https://www.bilibili.com/video/${id}/?p=${part}` };
  }
  throw invalid();
}

module.exports = { videoPageSource };
