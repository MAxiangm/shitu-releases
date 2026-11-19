(() => {
  'use strict';

  const INSTAGRAM = /^(?:[a-z0-9-]+\.)*instagram\.com$/i;
  const CDN = /^(?:[a-z0-9-]+\.)*(?:cdninstagram\.com|fbcdn\.net)$/i;
  const POST = /^\/(?:[a-z0-9_.]+\/)?(?:reels?|p|tv)\/([a-z0-9_-]{5,32})(?:\/embed(?:\/captioned)?)?\/?$/i;
  const RESTRICTED = '此视频的下载受限，请使用 Instagram 提供的下载入口。';
  const PAGE_LIMIT = 8 * 1024 * 1024;
  const PAGE_TIMEOUT = 8000;

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
    // A hidden save button does not make a matching playback file inaccessible.
    // Keep actual privacy, authentication, live and encryption restrictions.
    return node && (
      node.is_private === true || node.user?.is_private === true || node.owner?.is_private === true ||
      node.is_drm_protected === true || node.is_live === true || Boolean(node.gating_ruling) ||
      (Object.hasOwn(node, 'if_not_gated_logged_out') && node.if_not_gated_logged_out === null)
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

  function inspect({ document, page, video, path = [], trustedMedia, singleVideo }) {
    if (!page || page.protocol !== 'https:' || page.username || page.password || page.port || !INSTAGRAM.test(page.hostname)) return null;
    if (video?.mediaKeys || video?.srcObject) return { error: RESTRICTED };
    const post = selectedPost(page, video, path, singleVideo);
    if (!post) return null;
    const code = postCode(post);
    const clip = value => {
      const url = address(value, page);
      // Current Instagram video_versions can use extensionless /o1/v/ URLs.
      // Only accept these when declared as video data or selected by <video>.
      return url?.protocol === 'https:' && CDN.test(url.hostname) &&
        (/\.(?:mp4|m4v)$/i.test(url.pathname) || /^\/o1\/v\//i.test(url.pathname))
        ? trustedMedia(url.href) : null;
    };
    const { blocked, carousel, variants } = inspectMetadata(document, page, code, clip);
    if (blocked) return { error: RESTRICTED };
    if (carousel) return { post, code, carousel: true };
    variants.sort((left, right) => right.pixels - left.pixels);
    let url = variants[0]?.source;
    // A complete URL on the actual chosen player is useful even when SPA
    // navigation has discarded the server's initial JSON.
    if (!url) url = clip(video?.currentSrc || video?.getAttribute?.('src'));
    if (!url && postCode(page) === code) {
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
      const ogPage = document.querySelector('meta[property="og:url"]')?.getAttribute('content');
      const identities = [canonical, ogPage].filter(Boolean);
      // SPA navigation can leave a previous post's OG video in the document.
      // An OG video is usable only with explicit, consistent post identity.
      if (identities.length && identities.every(value => postCode(address(value, page)) === code)) {
        const metadata = Array.from(document.querySelectorAll(
          'meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[property="og:video"]'
        )).map(node => clip(node.getAttribute('content'))).filter(Boolean);
        if (new Set(metadata).size === 1) url = metadata[0];
      }
    }
    const pageUrl = new URL(post.href);
    pageUrl.hash = '';
    pageUrl.search = '';
    return { post, code, source: url ? { url, name: `Instagram ${code}`, pageUrl: pageUrl.href } : null };
  }

  async function readPage(response, signal) {
    if (Number(response.headers.get('content-length')) > PAGE_LIMIT || !response.body?.getReader) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Instagram 页面数据无法读取。');
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, html = '';
    try {
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > PAGE_LIMIT) throw new Error('Instagram 页面数据过大。');
        html += decoder.decode(chunk.value, { stream: true });
      }
      return html + decoder.decode();
    } finally { void reader.cancel().catch(() => {}); }
  }

  const resolve = context => {
    const result = inspect(context);
    return result?.error ? { error: result.error } : result?.source || null;
  };
  resolve.selectedPage = context => {
    if (context.video?.mediaKeys || context.video?.srcObject) return { blocked: true };
    if (!context.video || context.video.isConnected === false ||
        (context.document.defaultView?.location && context.document.defaultView.location.href !== context.page.href)) return null;
    const result = inspect(context);
    if (result?.error) return { blocked: true };
    if (!result?.post || result.carousel) return null;
    const pageUrl = new URL(result.post.href);
    pageUrl.search = ''; pageUrl.hash = '';
    pageUrl.pathname = pageUrl.pathname.replace(/\/embed(?:\/captioned)?\/?$/, '/');
    if (!pageUrl.pathname.endsWith('/')) pageUrl.pathname += '/';
    return { url: pageUrl.href, videoId: result.code };
  };
  resolve.resolveAsync = async context => {
    const initial = inspect(context);
    if (!initial || initial.error || initial.source) return initial?.error ? { error: initial.error } : initial?.source || null;
    if (initial.carousel) return { error: '请在这条 Instagram 帖子的具体视频画面上采集。' };
    const { document, page, video } = context;
    if (!video) return null;
    const current = video.currentSrc || video.getAttribute?.('src');
    const poster = video.poster || video.getAttribute?.('poster');
    const stillSelected = () => video.isConnected !== false && !video.mediaKeys && !video.srcObject &&
      (video.currentSrc || video.getAttribute?.('src')) === current &&
      (video.poster || video.getAttribute?.('poster')) === poster &&
      (!document.defaultView?.location || document.defaultView.location.href === page.href);
    const pageUrl = new URL(initial.post.href);
    pageUrl.search = ''; pageUrl.hash = '';
    pageUrl.pathname = pageUrl.pathname.replace(/\/embed(?:\/captioned)?\/?$/, '/');
    if (!pageUrl.pathname.endsWith('/')) pageUrl.pathname += '/';
    pageUrl.host = page.host;
    const controller = new AbortController();
    const unavailable = { error: '未找到当前 Instagram 视频的完整文件。请确认视频可以播放后重试。' };
    let timer;
    try {
      const work = async () => {
        const response = await fetch(pageUrl.href, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
          headers: { Accept: 'text/html' }, signal: controller.signal });
        if (response.status !== 200 || response.redirected || response.url !== pageUrl.href ||
            !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
          void response.body?.cancel().catch(() => {});
          return unavailable;
        }
        const html = await readPage(response, controller.signal);
        controller.signal.throwIfAborted();
        if (!stillSelected()) return { error: '页面或视频已切换，请在当前视频上重新采集。' };
        const template = document.createElement('template');
        template.innerHTML = html;
        const parsed = inspect({ ...context, page: pageUrl, document: {
          querySelector: selector => template.content.querySelector(selector),
          querySelectorAll: selector => template.content.querySelectorAll(selector)
        } });
        return parsed?.error ? { error: parsed.error } : parsed?.source || unavailable;
      };
      return await Promise.race([work(), new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('读取 Instagram 视频来源超时，请重试。');
          controller.abort(error); reject(error);
        }, PAGE_TIMEOUT);
      })]);
    } catch {
      return { error: controller.signal.aborted ? '读取 Instagram 视频来源超时，请重试。'
        : '暂时无法读取 Instagram 视频来源，请确认当前视频可以播放后重试。' };
    } finally { clearTimeout(timer); }
  };
  globalThis.MosaicInstagramVideo = resolve;
})();
