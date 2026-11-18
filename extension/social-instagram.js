(() => {
  'use strict';

  const INSTAGRAM = /^(?:[a-z0-9-]+\.)*instagram\.com$/i;
  const CDN = /^(?:[a-z0-9-]+\.)*(?:cdninstagram\.com|fbcdn\.net)$/i;
  const POST = /^\/(?:[a-z0-9_.]+\/)?(?:reels?|p|tv)\/([a-z0-9_-]{5,32})(?:\/embed(?:\/captioned)?)?\/?$/i;
  const RESTRICTED = '此视频的下载受限，请使用 Instagram 提供的下载入口。';
  const NO_DOWNLOAD = ['can_download', 'is_downloadable', 'downloadable', 'download_allowed',
    'allows_download', 'allow_download', 'allow_downloads', 'download_enabled', 'is_download_enabled', 'viewer_can_download'];

  function address(value, base) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try { return new URL(value, base); } catch { return null; }
  }

  function postCode(url) {
    return url?.protocol === 'https:' && INSTAGRAM.test(url.hostname) ? POST.exec(url.pathname)?.[1] : undefined;
  }

  function postUrl(node, page) {
    if (node?.tagName !== 'A') return null;
    const url = address(node.getAttribute('href'), page);
    return postCode(url) && !url.username && !url.password && !url.port ? url : null;
  }

  function selectedPost(page, video, path, singleVideo) {
    const links = path.map(node => postUrl(node, page)).filter(Boolean);
    if (video && !links.length) {
      const article = video.closest?.('article');
      if (article?.querySelectorAll('video').length === 1) {
        for (const node of article.querySelectorAll('a[href]')) {
          const url = postUrl(node, page);
          if (url) links.push(url);
        }
      }
    }
    const codes = new Set(links.map(postCode));
    if (codes.size === 1) return links[0];
    if (codes.size > 1 || !singleVideo || !video || !postCode(page)) return null;
    return page;
  }

  function denied(node) {
    return node && (
      node.is_private === true || node.user?.is_private === true || node.owner?.is_private === true ||
      node.is_drm_protected === true || node.is_live === true || Boolean(node.gating_ruling) ||
      (Object.hasOwn(node, 'if_not_gated_logged_out') && node.if_not_gated_logged_out === null) ||
      NO_DOWNLOAD.some(key => node[key] === false || node.clips_metadata?.[key] === false)
    );
  }

  function inspectMetadata(document, page, code, clip) {
    let budget = 4 * 1024 * 1024;
    let blocked = false, carousel = false;
    const variants = [];
    for (const script of document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]')) {
      const raw = script.textContent;
      if (!raw || raw.length > budget || !raw.includes(code)) continue;
      budget -= raw.length;
      let data;
      try { data = JSON.parse(raw); } catch { continue; }
      const queue = [data];
      for (let index = 0; index < queue.length && index < 40000; index++) {
        const node = queue[index];
        if (!node || typeof node !== 'object') continue;
        const recordCode = node.code || node.shortcode;
        const schemaCode = postCode(address(node.url || node.mainEntityOfPage?.['@id'], page));
        if (recordCode === code || schemaCode === code && node['@type'] === 'VideoObject') {
          if (denied(node)) blocked = true;
          const media = node.if_not_gated_logged_out || node;
          if (denied(media)) blocked = true;
          if (media.media_type === 8 || media.carousel_media?.length > 1 || media.edge_sidecar_to_children?.edges?.length > 1) carousel = true;
          for (const variant of Array.isArray(media.video_versions) ? media.video_versions : []) {
            const source = clip(variant?.url);
            if (source) variants.push({ source, pixels: (Number(variant.width) || 0) * (Number(variant.height) || 0) });
          }
          for (const value of [media.video_url, media.contentUrl]) {
            const source = clip(value);
            if (source) variants.push({ source, pixels: 0 });
          }
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object' && queue.length < 40000) queue.push(value);
        }
      }
    }
    return { blocked, carousel, variants };
  }

  globalThis.MosaicInstagramVideo = function ({ document, page, video, path = [], trustedMedia, singleVideo }) {
    if (!page || !INSTAGRAM.test(page.hostname)) return null;
    if (video?.mediaKeys || video?.srcObject) return { error: RESTRICTED };
    const post = selectedPost(page, video, path, singleVideo);
    if (!post) return null;
    const code = postCode(post);
    const clip = value => {
      const url = address(value, page);
      return url?.protocol === 'https:' && CDN.test(url.hostname) && /\.(?:mp4|m4v)$/i.test(url.pathname)
        ? trustedMedia(url.href) : null;
    };
    const { blocked, carousel, variants } = inspectMetadata(document, page, code, clip);
    if (blocked) return { error: RESTRICTED };
    if (carousel) return null;
    variants.sort((left, right) => right.pixels - left.pixels);
    let url = variants[0]?.source;
    if (!url && postCode(page) === code) {
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
      if (!canonical || postCode(address(canonical, page)) === code) {
        const metadata = Array.from(document.querySelectorAll(
          'meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[property="og:video"]'
        )).map(node => clip(node.getAttribute('content'))).filter(Boolean);
        if (new Set(metadata).size === 1) url = metadata[0];
      }
    }
    if (!url) return null;
    const pageUrl = new URL(post.href);
    pageUrl.hash = '';
    pageUrl.search = '';
    return { url, name: `Instagram ${code}`, pageUrl: pageUrl.href };
  };
})();
