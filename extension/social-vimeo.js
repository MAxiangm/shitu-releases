(() => {
  'use strict';

  const DOWNLOAD_REDIRECT = /^\/progressive_redirect\/download\/(\d+)(?:\/|$)/i;
  const PLAYBACK_REDIRECT = /^\/progressive_redirect\/playback\/(\d+)\//i;
  const VIDEO_FILE = /\.(?:mp4|m4v|mov|webm)$/i;
  const HLS_MANIFEST = /\.m3u8$/i;
  const DASH_MANIFEST = /\.mpd$/i;
  const MASTER_MANIFEST = /(?:^|\/)master\.m3u8$/i;
  const VIMEO_ADAPTIVE_CDN = /^(?:vod-adaptive(?:-[a-z0-9]+)?|skyfire)\.vimeocdn\.com$/i;
  const MAX_TIMING_ENTRIES = 250;
  const CONFIG_LIMIT = 2 * 1024 * 1024;
  const PAGE_LIMIT = 8 * 1024 * 1024;
  const PAGE_TIMEOUT = 8000;

  function vimeoPage(hostname) {
    return hostname === 'vimeo.com' || hostname === 'www.vimeo.com';
  }

  function videoId(address) {
    return /^(?:\/(?:video|manage\/videos|channels\/[^/]+|groups\/[^/]+\/videos))?\/(\d+)(?:\/|$)/i.exec(address.pathname)?.[1];
  }

  function publicPlaybackId(page) {
    if (page.hostname === 'player.vimeo.com') {
      return /^\/video\/(\d+)\/?$/.exec(page.pathname)?.[1];
    }
    return /^(?:\/(?:channels\/[^/]+|groups\/[^/]+\/videos))?\/(\d+)\/?$/.exec(page.pathname)?.[1];
  }

  function visible(node) {
    const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    return style?.display !== 'none' && style?.visibility !== 'hidden' &&
      !node.closest?.('[hidden], [inert], [aria-hidden="true"]') &&
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

  function playbackSource(value, id, trustedMedia) {
    const source = trustedMedia(value);
    if (!source || source.length > 8192) return null;
    const url = new URL(source);
    const fromCdn = /\.vimeocdn\.com$/.test(url.hostname);
    const fromPlayer = url.hostname === 'player.vimeo.com' && PLAYBACK_REDIRECT.exec(url.pathname)?.[1] === id;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || (!fromCdn && !fromPlayer)) return null;
    if (VIDEO_FILE.test(url.pathname)) return { url: url.href, playback: 'file' };
    if (HLS_MANIFEST.test(url.pathname)) return { url: url.href, playback: 'hls' };
    if (DASH_MANIFEST.test(url.pathname)) return { url: url.href, playback: 'dash' };
    return null;
  }

  function jsonScript(script) {
    const raw = script?.textContent;
    if (!raw || raw.length > CONFIG_LIMIT || script.src) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function nextPage(document, page, id) {
    if (!vimeoPage(page.hostname)) return null;
    const node = document.getElementById?.('__NEXT_DATA__') || document.querySelector?.('script#__NEXT_DATA__');
    const data = jsonScript(node);
    const props = data?.props?.pageProps;
    if (String(data?.query?.clipId) !== id || String(props?.clipId) !== id) return null;
    let metadata = props.clipMetadata?.jsonLd;
    if (typeof metadata === 'string' && metadata.length <= CONFIG_LIMIT) {
      try { metadata = JSON.parse(metadata); } catch { metadata = null; }
    }
    const graph = Array.isArray(metadata?.['@graph']) ? metadata['@graph'].slice(0, 100) : null;
    const candidates = graph || [metadata];
    const embeds = new Set();
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      if (graph) {
        const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        if (!types.includes('VideoObject')) continue;
        let linked;
        try { linked = new URL(item.url || item['@id']); } catch { continue; }
        if (linked.protocol !== 'https:' || !vimeoPage(linked.hostname) || linked.port || linked.username || linked.password ||
            publicPlaybackId(linked) !== id) continue;
      }
      let embed;
      try { embed = new URL(item.embedUrl); } catch { continue; }
      if (embed.protocol !== 'https:' || embed.hostname !== 'player.vimeo.com' || embed.port || embed.username ||
          embed.password || embed.hash || /^\/video\/(\d+)\/?$/.exec(embed.pathname)?.[1] !== id) continue;
      embeds.add(embed.href);
    }
    return embeds.size === 1 ? { id, embedUrl: embeds.values().next().value } : { id };
  }

  function activeSelection(document, video, singleVideo) {
    const players = [...document.querySelectorAll('video')].filter(node => node.tagName === 'VIDEO');
    if (!players.length) return singleVideo;
    const active = players.filter(node => {
      // Vimeo hides its picture from accessibility because the custom controls
      // expose it separately. aria-hidden does not mean the picture is unseen.
      if (node.getClientRects && !node.getClientRects().length) return false;
      const view = node.ownerDocument?.defaultView || document.defaultView;
      const style = view?.getComputedStyle?.(node);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      return node.currentSrc || node.getAttribute?.('src') || node.querySelector?.('source[src]')?.getAttribute('src');
    });
    return active.length === 1 && active[0] === video;
  }

  function configSource(config, id, trustedMedia) {
    if (!config || String(config.video?.id) !== id) return null;
    if (config.video.is_live === true || config.video.is_drm_protected === true) {
      return { error: '当前 Vimeo 视频为直播或受保护的视频，无法保存为完整文件。', restricted: true };
    }
    const files = config.request?.files;
    if (!files || typeof files !== 'object') return null;
    const progressive = (Array.isArray(files.progressive) ? files.progressive : []).slice(0, 30)
      .map(item => ({ source: playbackSource(item?.url, id, trustedMedia), height: Number(item?.height) || 0,
        width: Number(item?.width) || 0, bitrate: Number(item?.bitrate) || 0 }))
      .filter(item => item.source?.playback === 'file')
      .sort((a, b) => b.height - a.height || b.width - a.width || b.bitrate - a.bitrate);
    if (progressive.length) return progressive[0].source;
    const hls = files.hls;
    const cdns = hls?.cdns;
    if (cdns && typeof cdns === 'object' && !Array.isArray(cdns)) {
      const preferred = playbackSource(cdns[hls.default_cdn]?.url, id, trustedMedia);
      if (preferred?.playback === 'hls') return preferred;
      const sources = Object.values(cdns).slice(0, 20).map(item => playbackSource(item?.url, id, trustedMedia))
        .filter(item => item?.playback === 'hls');
      const unique = new Map(sources.map(item => [item.url, item]));
      if (unique.size === 1) return unique.values().next().value;
    }
    return null;
  }

  function documentConfig(document, id, trustedMedia) {
    const matches = [];
    for (const node of document.querySelectorAll('script[type="application/json"][data-mosaic-vimeo-config]')) {
      const data = jsonScript(node);
      const configs = Array.isArray(data?.configs) ? data.configs.slice(0, 10) : [data?.config || data];
      for (const config of configs) {
        const found = configSource(config, id, trustedMedia);
        if (found?.error) return found;
        if (found) matches.push(found);
      }
    }
    return matches.at(-1) || null;
  }

  function currentPlayback(document, page, video, id, trustedMedia, singleVideo) {
    if (!video || !id || video.mediaKeys || video.srcObject || video.controlsList?.contains('nodownload')) return null;
    const active = video.currentSrc || video.getAttribute?.('src');
    const source = playbackSource(active, id, trustedMedia);
    if (source) return source;
    if (!active) {
      const declared = video.querySelectorAll?.('source[src]');
      if (declared?.length === 1) return playbackSource(declared[0].getAttribute('src'), id, trustedMedia);
    }
    // An empty preload video is not another selected player. Configurations are
    // tied to the current clip ID, and work even after resource timings expire.
    if (!activeSelection(document, video, singleVideo)) return null;
    const configured = documentConfig(document, id, trustedMedia);
    if (configured) return configured;
    // Main pages need explicit route metadata before their resource list can
    // be attributed to the selected clip; independent player pages already do.
    if ((page.hostname !== 'player.vimeo.com' && !nextPage(document, page, id)) ||
        !active?.startsWith(`blob:${page.origin}/`)) return null;
    const entries = document.defaultView?.performance?.getEntriesByType?.('resource') || [];
    const manifests = new Map();
    for (const entry of entries.slice(-MAX_TIMING_ENTRIES)) {
      if (!['fetch', 'xmlhttprequest', 'video'].includes(entry.initiatorType) ||
          (entry.responseStatus && entry.responseStatus !== 200)) continue;
      const found = playbackSource(entry.name, id, trustedMedia);
      if (found && found.playback !== 'file') manifests.set(found.url, found);
    }
    if (manifests.size === 1) return manifests.values().next().value;
    const masters = [...manifests.values()].filter(item => {
      const { hostname, pathname } = new URL(item.url);
      return item.playback === 'dash' || MASTER_MANIFEST.test(pathname) ||
        (VIMEO_ADAPTIVE_CDN.test(hostname) && /(?:^|\/)playlist\.m3u8$/i.test(pathname));
    });
    return masters.length === 1 ? masters[0] : null;
  }

  const resolve = ({ document, page, video, path = [], absolute, trustedMedia, singleVideo }) => {
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
    if (vimeoPage(host) && id && (singleVideo || embedded)) {
      const matches = new Map();
      for (const link of document.querySelectorAll('a[href*="/progressive_redirect/download/"]')) {
        if (!visible(link)) continue;
        const found = approvedLink(link, absolute, trustedMedia);
        if (found?.id === id) matches.set(found.url, link);
      }
      if (matches.size === 1) {
        const [[url, link]] = matches;
        return { url, name: nameFor(link, document) };
      }
    }
    const source = currentPlayback(document, page, video, publicPlaybackId(page), trustedMedia, singleVideo);
    if (source) return { ...source, name: nameFor(null, document) };
    if (vimeoPage(host) && id && !embedded) {
      return { error: '当前没有可采集的 Vimeo 播放源。请先播放视频，再按 Alt＋右键，也可以打开「下载」选择版本。' };
    }
    return {
      error: '当前没有可采集的 Vimeo 播放源。请先播放画面再试，或前往原页使用作者开放的「下载」。',
      ...((embedded || host === 'player.vimeo.com') && id ? { openUrl: `https://vimeo.com/${id}` } : {})
    };
  };

  function assignedConfig(script) {
    const text = script?.textContent;
    if (script?.src || !text || text.length > CONFIG_LIMIT) return null;
    const assignment = /(?:window\.playerConfig|(?:var|let|const)\s+config)\s*=\s*\{/.exec(text);
    if (!assignment) return null;
    const start = assignment.index + assignment[0].length - 1;
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { return null; }
      }
    }
    return null;
  }

  async function readPage(response, signal) {
    if (Number(response.headers.get('content-length')) > PAGE_LIMIT || !response.body?.getReader) {
      void response.body?.cancel().catch(() => {});
      throw new Error('页面数据过大或无法读取。');
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) return text + decoder.decode();
        size += chunk.value.byteLength;
        if (size > PAGE_LIMIT) throw new Error('页面数据过大。');
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally { void reader.cancel().catch(() => {}); }
  }

  resolve.resolveAsync = async context => {
    const initial = resolve(context);
    const { document, page, video, trustedMedia, singleVideo } = context;
    if (initial?.url || initial?.restricted || video?.mediaKeys || video?.srcObject || video?.controlsList?.contains('nodownload') ||
        !video || !activeSelection(document, video, singleVideo)) return initial;
    const id = publicPlaybackId(page);
    const declared = id && nextPage(document, page, id)?.embedUrl;
    // Only request the current player, or an embed explicitly declared by the
    // matching main-page metadata. Never invent another video's endpoint.
    const embedUrl = declared || (page.hostname === 'player.vimeo.com' && id ? page.href : null);
    if (!embedUrl || typeof fetch !== 'function' || typeof document.createElement !== 'function') return initial;
    const selected = video.currentSrc || video.getAttribute?.('src');
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([(async () => {
        const response = await fetch(embedUrl, { credentials: new URL(embedUrl).origin === page.origin ? 'same-origin' : 'omit',
          redirect: 'error', headers: { Accept: 'text/html' }, signal: controller.signal });
        if (response.status !== 200 || response.redirected || response.url !== embedUrl ||
            !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
          void response.body?.cancel().catch(() => {});
          return initial;
        }
        const html = await readPage(response, controller.signal);
        if ((!document.defaultView?.location || document.defaultView.location.href === page.href) && video.isConnected !== false &&
            !video.mediaKeys && !video.srcObject && (video.currentSrc || video.getAttribute?.('src')) === selected) {
          const template = document.createElement('template');
          template.innerHTML = html;
          for (const script of template.content.querySelectorAll('script:not([src])')) {
            const source = configSource(assignedConfig(script), id, trustedMedia);
            if (source) return { ...source, name: nameFor(null, document) };
          }
          // A parallel player response may have populated the bridge meanwhile.
          return resolve(context);
        }
        return { error: '页面或视频已切换，请在当前视频上重新采集。' };
      })(), new Promise((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('来源读取超时')); }, PAGE_TIMEOUT);
      })]);
    } catch { return resolve(context); }
    finally { clearTimeout(timer); }
  };
  globalThis.MosaicVimeoVideo = resolve;
})();
