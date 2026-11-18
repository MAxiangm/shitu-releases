(() => {
  'use strict';

  const DOWNLOAD_REDIRECT = /^\/progressive_redirect\/download\/(\d+)(?:\/|$)/i;
  const VIDEO_FILE = /\.(?:mp4|m4v|mov|webm)$/i;

  function vimeoPage(hostname) {
    return hostname === 'vimeo.com' || hostname === 'www.vimeo.com';
  }

  function videoId(address) {
    return /^(?:\/(?:video|manage\/videos|channels\/[^/]+|groups\/[^/]+\/videos))?\/(\d+)(?:\/|$)/i.exec(address.pathname)?.[1];
  }

  function visible(node) {
    return !node.closest?.('[hidden], [inert], [aria-hidden="true"]') &&
      (!node.getClientRects || node.getClientRects().length > 0);
  }

  function approvedLink(link, absolute, trustedMedia) {
    if (link?.tagName !== 'A') return null;
    const candidate = absolute(link.getAttribute('href'));
    const source = candidate && trustedMedia(candidate);
    if (!source) return null;
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const redirectId = url.hostname === 'player.vimeo.com' && DOWNLOAD_REDIRECT.exec(url.pathname)?.[1];
    if (redirectId) return { url: url.href, id: redirectId };
    const downloadCdn = /^download-video(?:-[a-z0-9]+)?\.vimeocdn\.com$/.test(url.hostname);
    const downloadPage = vimeoPage(url.hostname) && /^\/(?:user\d+\/)?download\/\d+(?:\/|$)/i.test(url.pathname);
    const explicit = link.hasAttribute('download') ||
      Boolean(link.closest('[role="dialog"], dialog')) && /下载|download/i.test(link.getAttribute('aria-label') || link.textContent || '');
    return explicit && (downloadPage || downloadCdn) && VIDEO_FILE.test(url.pathname) ? { url: url.href } : null;
  }

  function nameFor(link, document) {
    return link?.getAttribute('download')?.trim().slice(0, 240) ||
      document.title?.replace(/\s*\|\s*Vimeo$|\s+on Vimeo$/i, '').trim().slice(0, 240) || undefined;
  }

  globalThis.MosaicVimeoVideo = ({ document, page, video, path = [], absolute, trustedMedia, singleVideo }) => {
    const host = page.hostname;
    if (!vimeoPage(host) && host !== 'player.vimeo.com') return null;
    const clicked = path.find(node => node.tagName === 'A');
    const explicit = approvedLink(clicked, absolute, trustedMedia);
    if (explicit) return { url: explicit.url, name: nameFor(clicked, document) };

    const frame = path.find(node => node.tagName === 'IFRAME' && node.getAttribute('src'));
    const frameSource = frame && absolute(frame.getAttribute('src'));
    const embedded = frameSource ? new URL(frameSource) : null;
    if (embedded && embedded.hostname !== 'player.vimeo.com') return null;
    if (!video && !embedded) return null;

    const id = videoId(embedded || page);
    if (vimeoPage(host) && id) {
      const matches = new Map();
      if (singleVideo || embedded) {
        for (const link of document.querySelectorAll('a[href*="/progressive_redirect/download/"]')) {
          if (!visible(link)) continue;
          const found = approvedLink(link, absolute, trustedMedia);
          if (found?.id === id) matches.set(found.url, link);
        }
      }
      if (matches.size === 1) {
        const [[url, link]] = matches;
        return { url, name: nameFor(link, document) };
      }
      return { error: '请在 Vimeo 打开「下载」，再对要保存的版本按 Alt＋右键。' };
    }
    return {
      error: '请在 Vimeo 视频页使用作者开放的「下载」。',
      ...((embedded || host === 'player.vimeo.com') && id ? { openUrl: `https://vimeo.com/${id}` } : {})
    };
  };
})();
