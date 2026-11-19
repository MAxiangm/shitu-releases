(() => {
  'use strict';

  const PIN_HOST = /^(?:[a-z0-9-]+\.)?pinterest\.com$/i;
  const PIN_PATH = /^\/pin\/(\d{1,20})\/?$/;
  const VIDEO_HOST = 'v1.pinimg.com';
  const IMAGE_HOST = 'i.pinimg.com';
  const RELAY_CALL = /^\s*window\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\(\s*("(?:[^"\\]|\\[\s\S])*")(?:\s*,\s*(\{[\s\S]*\}))?\s*\)\s*;?\s*$/;
  const SCRIPT_LIMIT = 2 * 1024 * 1024;
  const PAGE_LIMIT = 8 * 1024 * 1024;
  const PAGE_TIMEOUT = 8000;

  function httpsAddress(value, base) {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    try {
      const url = new URL(value, base);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash ? url : null;
    } catch { return null; }
  }

  function directVideo(value) {
    const url = httpsAddress(value);
    if (!url || url.hostname !== VIDEO_HOST || url.search) return null;
    const progressive = /^\/videos\/mc\/([1-9]\d{2,3})p\/(([\da-f]{2}\/){3})([\da-f]{32})\.mp4$/i.exec(url.pathname);
    const hevc = /^\/videos\/iht\/hevcMp4V2\/(([\da-f]{2}\/){3})([\da-f]{32})_t[1-9]\d?\.mp4$/i.exec(url.pathname);
    const modern = /^\/videos\/iht\/(expMp4|hevcMp4V3)\/(([\da-f]{2}\/){3})([\da-f]{32})_([1-9]\d{1,3})w\.mp4$/i.exec(url.pathname);
    if (!progressive && !hevc && !modern) return null;
    const key = (progressive ? progressive[4] : hevc ? hevc[3] : modern[4]).toLowerCase();
    const directories = (progressive ? progressive[2] : hevc ? hevc[1] : modern[2]).toLowerCase();
    if (directories !== `${key.slice(0, 2)}/${key.slice(2, 4)}/${key.slice(4, 6)}/`) return null;
    const rank = progressive ? 10000 + Number(progressive[1])
      : modern ? (/^expMp4$/i.test(modern[1]) ? 10000 : 0) + Number(modern[5]) : 0;
    return { url: url.href, key, rank };
  }

  function videoIdentity(value, base) {
    const url = httpsAddress(value, base);
    if (!url) return null;
    if (url.hostname === VIDEO_HOST && url.pathname.startsWith('/videos/')) {
      return /\/([\da-f]{32})(?:_(?:t\d+|\d+w))?\.(?:mp4|m3u8|mpd)$/i.exec(url.pathname)?.[1].toLowerCase();
    }
    if (url.hostname === IMAGE_HOST && url.pathname.startsWith('/videos/thumbnails/')) {
      return /\/([\da-f]{32})(?:\.\d+)?\.(?:jpg|png|webp)$/i.exec(url.pathname)?.[1].toLowerCase();
    }
    return null;
  }

  function coverIdentity(value, base) {
    const url = httpsAddress(value, base);
    if (!url || url.hostname !== IMAGE_HOST) return null;
    const image = /^\/(?:originals|[1-9]\d{0,4}x\d{0,4})\/(?:[\da-f]{2}\/){3}([\da-f]{32})\.(?:jpe?g|png|webp)$/i.exec(url.pathname);
    return image?.[1].toLowerCase() || videoIdentity(url.href);
  }

  function isPinCover(pin, key) {
    if (!key) return false;
    if (typeof pin.imageSignature === 'string' && pin.imageSignature.toLowerCase() === key) return true;
    const variants = Object.entries(pin).filter(([name]) => /^(?:images|imageSpec)_(?:orig|\d+x\d*)$/.test(name));
    return [pin.imageLargeUrl, ...variants.map(([, image]) => image?.url)].some(value => coverIdentity(value) === key);
  }

  function readPin(script, id) {
    const text = script.textContent;
    if (script.src || !text || text.length > SCRIPT_LIMIT || !text.includes(id) || !text.includes('pinimg.com')) return null;
    const match = RELAY_CALL.exec(text);
    if (!match) return null;
    try {
      // The script is Pinterest's serialized response. Only decode its JSON arguments.
      const serialized = JSON.parse(match[1]);
      const request = JSON.parse(serialized.startsWith('{') ? serialized : decodeURIComponent(serialized));
      if (request?.variables?.pinId !== id) return null;
      const response = match[2] ? JSON.parse(match[2]) : request.response || request;
      const pin = response?.data?.v3GetPinQueryv2?.data;
      return pin?.__typename === 'Pin' && pin.entityId === id ? pin : null;
    } catch { return null; }
  }

  function inspect({ document, page, video, path = [], singleVideo }) {
    if (video?.mediaKeys || video?.srcObject || (video?.tagName && video.tagName !== 'VIDEO') ||
        page.protocol !== 'https:' || page.username || page.password || page.port || !PIN_HOST.test(page.hostname)) return null;
    const id = PIN_PATH.exec(page.pathname)?.[1];
    if (!id) return null;
    const target = video || path.find(node => node.tagName === 'IMG');
    if (!target) return null;
    const owner = target.closest?.('[data-pin-id]') || path.find(node => node.getAttribute?.('data-pin-id'));
    const ownerId = owner?.getAttribute('data-pin-id');
    if (ownerId && ownerId !== id) return null;
    const current = target.currentSrc || target.getAttribute?.('src');
    const poster = video ? video.poster || video.getAttribute?.('poster') : current;
    const key = video ? videoIdentity(current, page) || videoIdentity(poster, page) : null;
    const cover = coverIdentity(poster, page);
    if (!video && !cover) return null;
    if (video && !key && !ownerId && (current && !current.startsWith(`blob:${page.origin}/`) || (!singleVideo && !cover))) return null;

    const matching = new Map();
    let hasRecord = false, matchedSelection = false;
    for (const script of document.querySelectorAll('script[data-relay-completed-request="true"]')) {
      const pin = readPin(script, id);
      if (!pin) continue;
      hasRecord = true;
      if (!pin.videos) continue;
      // The site's save-button flags do not determine whether the selected
      // ordinary playback file can be read. Keep actual protection checks.
      if (pin.videos.isProtected === true) return { hasRecord, blocked: true, source: null };
      const list = pin.videos.videoList;
      const details = list && typeof list === 'object' && !Array.isArray(list) ? Object.values(list).slice(0, 64) : [];
      const urls = Array.isArray(pin.videos.videoUrls) ? pin.videos.videoUrls.slice(0, 64) : [];
      const renditions = [list?.v720P?.url, ...details.map(item => item?.url), ...urls];
      const title = [pin.title, pin.gridTitle, pin.closeupUnifiedTitle, pin.description, document.title].find(value => typeof value === 'string' && value.trim());
      const coverMatches = isPinCover(pin, cover);
      if (key ? renditions.some(value => videoIdentity(value, page) === key)
        : cover ? coverMatches : video && (ownerId === id || singleVideo === true)) matchedSelection = true;
      for (const rendition of renditions) {
        const candidate = directVideo(rendition);
        if (!candidate || (key ? candidate.key !== key : cover && !coverMatches && candidate.key !== cover)) continue;
        const previous = matching.get(candidate.key);
        if (!previous || candidate.rank > previous.rank) matching.set(candidate.key, { ...candidate, name: title?.trim().slice(0, 240) });
      }
    }
    const selected = matching.size === 1 ? matching.values().next().value : null;
    return { hasRecord, matchedSelection, id, current, poster, key, cover, ownerId,
      source: selected ? { url: selected.url, name: selected.name, pageUrl: new URL(`/pin/${id}/`, page.origin).href } : null };
  }

  async function readPage(response, signal) {
    if (Number(response.headers.get('content-length')) > PAGE_LIMIT || !response.body?.getReader) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Pinterest 页面数据暂时无法读取，请刷新网页后重试。');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0, html = '';
    try {
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > PAGE_LIMIT) throw new Error('Pinterest 页面数据过大，请刷新网页后重试。');
        html += decoder.decode(chunk.value, { stream: true });
      }
      return html + decoder.decode();
    } finally { void reader.cancel().catch(() => {}); }
  }

  const resolve = context => inspect(context)?.source || null;
  resolve.selectedPage = context => {
    if (context.video?.mediaKeys || context.video?.srcObject) return { blocked: true };
    const selected = inspect(context);
    if (selected?.blocked) return { blocked: true };
    if (!selected || context.video?.isConnected === false ||
        (context.document.defaultView?.location && context.document.defaultView.location.href !== context.page.href)) return null;
    if (selected.hasRecord ? !selected.matchedSelection
      : !context.video || (!selected.ownerId && context.singleVideo !== true)) return null;
    return { url: new URL(`/pin/${selected.id}/`, context.page.origin).href, videoId: selected.id };
  };
  // Pinterest's client-side navigation can leave only the previous page's
  // serialized data in the DOM. Read the selected Pin's own HTML on demand.
  // Keep the synchronous resolver for hit-testing images and video covers.
  resolve.resolveAsync = async context => {
    const initial = inspect(context);
    if (!initial || initial.hasRecord) return initial?.source || null;
    const { document, page, video } = context;
    const unavailable = { error: '未找到这个 Pin 可采集的完整视频，请刷新当前页面后重试。' };
    if (!video || (!initial.key && !initial.cover)) return unavailable;
    const stillSelected = () => video.isConnected !== false && !video.mediaKeys && !video.srcObject &&
      (video.currentSrc || video.getAttribute?.('src')) === initial.current &&
      (video.poster || video.getAttribute?.('poster')) === initial.poster &&
      (video.closest?.('[data-pin-id]') || context.path?.find(node => node.getAttribute?.('data-pin-id')))?.getAttribute('data-pin-id') === initial.ownerId &&
      (!document.defaultView?.location || document.defaultView.location.href === page.href);
    const address = new URL(`/pin/${initial.id}/`, page.origin).href;
    const controller = new AbortController();
    let timer;
    try {
      const work = async () => {
        const response = await fetch(address, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
          headers: { Accept: 'text/html' }, signal: controller.signal });
        if (response.status !== 200 || response.redirected || response.url !== address ||
            !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
          void response.body?.cancel().catch(() => {});
          return unavailable;
        }
        const html = await readPage(response, controller.signal);
        controller.signal.throwIfAborted();
        if (!stillSelected()) return { error: '页面或视频已切换，请在当前视频上重新采集。' };
        // A template is inert: no fetched page scripts are run or inserted.
        const template = document.createElement('template');
        template.innerHTML = html;
        const parsed = inspect({ ...context, document: { title: document.title,
          querySelectorAll: selector => template.content.querySelectorAll(selector) } });
        return parsed?.source || unavailable;
      };
      return await Promise.race([work(), new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('读取 Pinterest 视频来源超时，请重试。');
          controller.abort(error);
          reject(error);
        }, PAGE_TIMEOUT);
      })]);
    } catch (error) {
      return { error: controller.signal.aborted ? '读取 Pinterest 视频来源超时，请重试。'
        : '暂时无法读取 Pinterest 视频来源，请刷新网页后重试。' };
    } finally { clearTimeout(timer); }
  };
  globalThis.MosaicPinterestVideo = resolve;
})();
