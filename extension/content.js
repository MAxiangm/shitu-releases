(() => {
  'use strict';
  if (globalThis.__shituCaptureInstalled) return;
  globalThis.__shituCaptureInstalled = true;
  const MAX_INLINE_BYTES = 20 * 1024 * 1024;
  const IMAGE_MIME = /^image\/(?:png|jpeg|webp|gif|bmp|svg\+xml|avif|tiff)$/i;
  const VIDEO_MIME = /^video\/(?:mp4|webm|ogg|quicktime)$/i;
  const VIDEO_LINK = /\.(?:mp4|m4v|webm|mov|og[gv]|mkv|avi|mpe?g|flv|m3u8|mpd)$/i;
  let toastHost;
  let toastTimer;
  let toastReceipt;
  let recentGesture = null;
  let captureSerial = 0;

  function toast(message, status = 'working', locateReceipt = null, originalPage = null) {
    if (!document.documentElement) return;
    if (!toastHost?.isConnected) {
      toastHost = document.createElement('div');
      toastHost.setAttribute('data-shitu-toast', '');
      toastHost.setAttribute('role', 'status');
      toastHost.setAttribute('aria-live', 'polite');
      Object.assign(toastHost.style, { all: 'initial', position: 'fixed', right: '22px', bottom: '24px', zIndex: '2147483647', pointerEvents: 'none' });
      const shadow = toastHost.attachShadow({ mode: 'closed' });
      const box = document.createElement('div');
      box.setAttribute('role', 'status');
      Object.assign(box.style, { font: '13px/1.65 system-ui,"Microsoft YaHei",sans-serif', color: '#d4d4d4', background: '#0d0d0d', border: '1px solid #444444', borderRadius: '10px', padding: '12px 17px', boxShadow: '0 8px 24px #0008', maxWidth: '370px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', pointerEvents: 'auto' });
      const close = document.createElement('button');
      close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭采集提示');
      Object.assign(close.style, { all: 'initial', float: 'right', marginLeft: '12px', padding: '0 2px', font: '18px/1.2 system-ui,sans-serif', color: '#aaaaaa', cursor: 'pointer', pointerEvents: 'auto' });
      close.addEventListener('click', event => {
        event.stopPropagation();
        clearTimeout(toastTimer);
        toastReceipt = null;
        toastHost.style.display = 'none';
      });
      const label = document.createElement('span');
      const locate = document.createElement('button');
      locate.type = 'button';
      locate.textContent = '在 Mosaic 中查看';
      Object.assign(locate.style, { font: 'inherit', color: '#f4f4f4', background: '#232323', border: '1px solid #666', borderRadius: '5px',
        padding: '4px 9px', marginTop: '9px', cursor: 'pointer' });
      locate.addEventListener('click', async event => {
        if (!event.isTrusted || !toastReceipt || locate.disabled) return;
        event.stopPropagation();
        const receipt = toastReceipt;
        locate.disabled = true;
        clearTimeout(toastTimer);
        try {
          const result = await chrome.runtime.sendMessage({ type: 'shitu:locate', receipt });
          if (!result?.ok) throw new Error(result?.error || '暂时无法定位素材。');
          if (toastReceipt === receipt) toast('已在 Mosaic 中定位素材。', 'success');
        } catch (error) {
          if (toastReceipt === receipt) toast(error.message || '暂时无法定位素材。', 'error', receipt);
        }
      });
      const original = document.createElement('a');
      original.target = '_blank';
      original.rel = 'noopener noreferrer';
      original.textContent = '打开 Vimeo 原页';
      Object.assign(original.style, { font: 'inherit', color: '#f4f4f4', marginTop: '7px', textDecoration: 'underline' });
      box.append(close, label, locate, original);
      shadow.append(box);
      toastHost.__shituBox = box;
      toastHost.__shituLabel = label;
      toastHost.__shituLocate = locate;
      toastHost.__shituOriginal = original;
      document.documentElement.append(toastHost);
    }
    const box = toastHost.__shituBox;
    const locate = toastHost.__shituLocate;
    const original = toastHost.__shituOriginal;
    original.style.display = originalPage ? 'block' : 'none';
    if (originalPage) original.href = originalPage;
    toastReceipt = typeof locateReceipt === 'string' ? locateReceipt : null;
    locate.style.display = toastReceipt ? 'block' : 'none';
    locate.disabled = false;
    toastHost.__shituLabel.textContent = `Mosaic · ${message}`;
    toastHost.setAttribute('aria-label', `Mosaic · ${message}`);
    toastHost.setAttribute('data-status', status);
    box.style.borderColor = status === 'error' ? '#d8d8d8' : '#444444';
    box.style.color = status === 'error' ? '#ffffff' : '#d4d4d4';
    toastHost.style.display = 'block';
    clearTimeout(toastTimer);
    // Keep failures and unconfirmed work visible until the user dismisses them
    // or starts another capture. A start notice is never a save receipt.
    if (status === 'success') toastTimer = setTimeout(() => {
      toastReceipt = null;
      if (toastHost) toastHost.style.display = 'none';
    }, toastReceipt ? 15000 : 8000);
  }

  function absolute(value, base = document.baseURI) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try { const url = new URL(value, base); return /^(https?|blob|data):$/.test(url.protocol) ? url.href : null; } catch { return null; }
  }
  function trustedMedia(value, validHost = () => true) {
    const href = absolute(value);
    if (!href) return null;
    const url = new URL(href);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && validHost(url.hostname) ? url.href : null;
  }
  function socialResolver(page) {
    if (page.protocol !== 'https:') return null;
    if (/^(?:www\.)?instagram\.com$/.test(page.hostname)) return globalThis.MosaicInstagramVideo;
    if (/^(?:(?:www|platform)\.)?(?:x|twitter)\.com$/.test(page.hostname)) return globalThis.MosaicXVideo;
    if (/^(?:(?:www|player)\.)?vimeo\.com$/.test(page.hostname)) return globalThis.MosaicVimeoVideo;
    return null;
  }
  function socialTarget(video, path) {
    const page = new URL(location.href);
    const resolve = socialResolver(page);
    return resolve ? { video, path, page, resolve } : null;
  }
  function videoPageLink(value) {
    const href = trustedMedia(value, host => /^(?:www\.)?vimeo\.com$/.test(host));
    return href && /^\/\d+\/?$/.test(new URL(href).pathname) ? href : null;
  }
  function nameFor(node, url) {
    const label = node.getAttribute?.('alt') || node.getAttribute?.('title') || node.getAttribute?.('aria-label');
    if (label?.trim()) return label.trim().slice(0, 240);
    try { const last = decodeURIComponent(new URL(url).pathname.split('/').pop()); return last?.slice(0, 240) || document.title.slice(0, 240); } catch { return document.title.slice(0, 240); }
  }
  function videoFrom(video, path) {
    const url = absolute(video.currentSrc || video.getAttribute('src') || video.querySelector('source[src]')?.getAttribute('src'));
    const media = { url, kind: 'video', name: url ? nameFor(video, url) : document.title.slice(0, 240) };
    if (video.mediaKeys) media.error = '这是受保护的视频，请使用网站提供的下载功能。';
    else if (video.srcObject || !url) media.error = '这个播放器没有可下载的视频文件地址。';
    if (!video.mediaKeys && !video.srcObject) media.social = socialTarget(video, path);
    return media;
  }
  function imageFrom(node) {
    const image = node.tagName === 'SOURCE' || node.tagName === 'PICTURE' ? node.closest('picture')?.querySelector('img') : node;
    if (image?.tagName === 'IMG') {
      const url = absolute(image.currentSrc || image.getAttribute('src'));
      return url ? { url, kind: 'image', name: nameFor(image, url) } : null;
    }
    if (image?.tagName?.toLowerCase() === 'image') {
      const url = absolute(image.getAttribute('href') || image.getAttribute('xlink:href'));
      return url ? { url, kind: 'image', name: nameFor(image, url) } : null;
    }
    return null;
  }
  function videoLinkFrom(node) {
    const link = node.tagName === 'A' ? node : node.closest('a[href]');
    const url = absolute(link?.getAttribute('href'));
    if (!url) return null;
    const address = new URL(url);
    if (/^video\//i.test(link.getAttribute('type') || '') || VIDEO_LINK.test(address.pathname)) {
      return { url, kind: 'video', name: nameFor(link, url) };
    }
    return null;
  }
  function coversPointer(video, image, event) {
    const bounds = video.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX >= bounds.right ||
        event.clientY < bounds.top || event.clientY >= bounds.bottom) return false;
    if (!image) return true;
    const poster = absolute(video.getAttribute('poster'));
    if (poster && poster === imageFrom(image)?.url) return true;
    const artwork = image.getBoundingClientRect();
    const width = Math.max(0, Math.min(bounds.right, artwork.right) - Math.max(bounds.left, artwork.left));
    const height = Math.max(0, Math.min(bounds.bottom, artwork.bottom) - Math.max(bounds.top, artwork.top));
    return width * height >= Math.max(bounds.width * bounds.height, artwork.width * artwork.height) * 0.6;
  }
  function videoAt(path, event) {
    const clicked = path.find(node => node.tagName === 'VIDEO');
    if (clicked) return videoFrom(clicked, path);
    const image = path.find(node => /^(?:img|image)$/i.test(node.tagName));
    // Restrict overlay lookup to the local player. A full-page video behind
    // unrelated foreground content is not the clicked asset.
    for (const container of path.slice(0, 3)) {
      if (['BODY', 'HTML'].includes(container.tagName)) break;
      const videos = Array.from(container.querySelectorAll(':scope > video, :scope > * > video'))
        .filter(video => coversPointer(video, image, event));
      if (videos.length === 1) return videoFrom(videos[0], path);
      if (videos.length > 1) return null;
    }
    return null;
  }
  function mediaAt(event) {
    const path = event.composedPath().filter(node => node instanceof Element);
    const video = videoAt(path, event);
    if (video) return video;
    const site = socialTarget(null, path);
    if (site && /vimeo\.com$/.test(site.page.hostname) && path.some(node => ['A', 'IFRAME'].includes(node.tagName))) {
      const source = site.resolve({ document, page: site.page, video: null, path, absolute, trustedMedia, singleVideo: false });
      const url = trustedMedia(source?.url);
      if (url) return { kind: 'video', url, name: source.name || nameFor(path[0], url) };
      if (source?.error) return { kind: 'video', error: source.error, originalPage: videoPageLink(source.openUrl) };
    }
    const candidates = [...path];
    const add = node => { if (node instanceof Element && !candidates.includes(node)) candidates.push(node); };
    for (const node of document.elementsFromPoint(event.clientX, event.clientY)) {
      add(node);
      if (node.shadowRoot) for (const child of node.shadowRoot.elementsFromPoint(event.clientX, event.clientY)) add(child);
    }
    for (const node of candidates) { const result = imageFrom(node); if (result) return result; }
    for (const node of candidates) { const result = videoLinkFrom(node); if (result) return result; }
    for (const node of candidates) {
      let background;
      try { background = getComputedStyle(node).backgroundImage; } catch { continue; }
      const match = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i.exec(background);
      if (match) {
        const url = absolute((match[1] || match[2] || match[3] || '').trim());
        if (url) return { url, kind: 'image', name: nameFor(node, url) };
      }
    }
    return null;
  }

  async function resolveMedia(media, { browserVideo = false } = {}) {
    const { social, ...plainMedia } = media;
    media = plainMedia;
    if (social) {
      if (location.href !== social.page.href || !social.video.isConnected) throw new Error('页面已切换，请在当前视频上重新采集。');
      if (social.video.mediaKeys || social.video.srcObject) throw new Error('这个播放器没有可下载的视频文件地址。');
      const found = await social.resolve({
        document, page: social.page, video: social.video, path: social.path, absolute, trustedMedia,
        singleVideo: document.querySelectorAll('video').length === 1
      });
      if (found?.error) throw Object.assign(new Error(found.error), { originalPage: videoPageLink(found.openUrl) });
      const source = trustedMedia(found?.url);
      if (source) {
        media.url = source;
        media.name = found.name || nameFor(social.video, source);
        media.socialPageUrl = found.pageUrl;
        delete media.error;
      }
    }
    if (media.error) throw Object.assign(new Error(media.error), { originalPage: videoPageLink(media.originalPage) });
    const result = { ...media, pageUrl: location.href, title: document.title };
    if (media.kind === 'video' && /\.(m3u8|mpd)(?:$|[?#])/i.test(media.url)) throw new Error('这是分段流媒体，暂不能保存为视频文件。请使用网站提供的下载功能。');
    if (browserVideo && media.pageUrl && media.pageUrl !== location.href) return result;
    const temporary = /^(blob|data):/i.test(media.url);
    const browserRead = /^https?:/i.test(media.url) && (media.kind === 'image' || (media.kind === 'video' && browserVideo));
    if (!temporary && !browserRead) return result;
    if (media.url.length > 29 * 1024 * 1024) throw new Error('临时素材超过 20 MB，暂不支持快捷采集。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      // The browser restricts cross-origin reads and omits cross-origin credentials.
      const response = await fetch(media.url, { signal: controller.signal, credentials: browserRead ? 'same-origin' : 'omit' });
      const contentType = String(response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const allowedMime = media.kind === 'video' ? VIDEO_MIME : IMAGE_MIME;
      if (browserRead && (!response.ok || response.status === 206 || !allowedMime.test(contentType))) {
        await response.body?.cancel().catch(() => {});
        return result;
      }
      if (Number(response.headers?.get('content-length')) > MAX_INLINE_BYTES) {
        await response.body?.cancel().catch(() => {});
        if (browserRead) return result;
        throw new Error('临时素材超过 20 MB，暂不支持快捷采集。');
      }
      let blob;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = []; let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_INLINE_BYTES) throw new Error('素材超过浏览器读取的 20 MB 上限。');
            chunks.push(chunk.value);
          }
          blob = new Blob(chunks, { type: contentType });
        } finally { await reader.cancel().catch(() => {}); }
      } else blob = await response.blob();
      if (blob.size > MAX_INLINE_BYTES) throw new Error('临时素材超过 20 MB，暂不支持快捷采集。');
      if (!blob.size) {
        if (browserRead) return result;
        throw new Error('临时素材为空，请重新采集。');
      }
      const expected = media.kind === 'video' ? /^video\//i : /^image\//i;
      if (!expected.test(blob.type)) throw new Error(`临时地址不是${media.kind === 'video' ? '视频' : '图片'}文件。`);
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('临时素材读取失败。')); reader.readAsDataURL(blob); });
      result.url = media.url.startsWith('data:') ? `data:${media.kind}/placeholder;base64,` : media.url;
      result.dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      result.mimeType = blob.type.split(';')[0].toLowerCase();
      return result;
    } catch (error) {
      // The desktop may use the original HTTP address when the browser cannot read it.
      if (browserRead) return result;
      if (media.kind === 'video' && media.url.startsWith('blob:') && (error instanceof TypeError || error.name === 'AbortError')) throw new Error('视频来源是分段流或不允许读取，暂不能保存为视频文件。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function capture(media) {
    const serial = ++captureSerial;
    let submitted = false;
    toast(media.kind === 'video' ? '正在准备下载视频，尚未保存…' : '正在读取素材，尚未保存…');
    try {
      const prepared = await resolveMedia(media);
      submitted = true;
      const response = await chrome.runtime.sendMessage({ type: 'shitu:capture', media: prepared });
      if (!response?.ok) throw new Error(response?.error || '采集失败，请打开桌面软件重试。');
      if (!(Number.isSafeInteger(response.imported) && response.imported > 0) && !(Number.isSafeInteger(response.duplicates) && response.duplicates > 0)) throw new Error('桌面未确认素材入库，请在 Mosaic 中检查后重试。');
      if (serial !== captureSerial) return;
      const inTrash = !response.imported && response.existingAssets?.some(asset => asset.trashedAt);
      toast(response.message || (response.imported ? '已保存到素材库，可在“最近导入”查看。' : inTrash ? '这份素材已在回收站，请到 Mosaic 恢复后查看。' : '素材库中已有这份文件，可清除筛选后查看。'),
        response.status || (inTrash ? 'warning' : 'success'), response.locateReceipt);
    } catch (error) {
      const message = /Extension context invalidated|Receiving end does not exist/i.test(error.message || '')
        ? '采集助手已更新，请刷新当前网页后再采集。' : error.message || '采集失败。';
      // Also persist errors that happened while reading Blob/data resources,
      // before a capture request reached the background worker.
      if (!submitted) chrome.runtime.sendMessage({ type: 'shitu:capture-failed', name: media?.name, error: message }).catch(() => {});
      if (serial === captureSerial) toast(message, 'error', null, error.originalPage);
    }
  }
  window.addEventListener('pointerdown', event => {
    if (event.isTrusted && event.button === 2 && event.altKey) recentGesture = { at: performance.now(), media: mediaAt(event), x: event.clientX, y: event.clientY };
    else recentGesture = null;
  }, true);
  window.addEventListener('contextmenu', event => {
    if (!event.isTrusted) return;
    const recent = recentGesture && performance.now() - recentGesture.at < 1500 && Math.abs(event.clientX - recentGesture.x) < 10 && Math.abs(event.clientY - recentGesture.y) < 10;
    if (!event.altKey && !recent) return;
    const pressedMedia = recent ? recentGesture.media : null;
    const media = pressedMedia?.kind === 'video' ? pressedMedia : mediaAt(event) || pressedMedia;
    recentGesture = null;
    if (!media) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    capture(media);
  }, true);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'shitu:status') { toast(String(message.message || ''), message.status, message.locateReceipt); return; }
    if (message?.type === 'shitu:resolve-media') {
      resolveMedia(message.media, { browserVideo: message.browserVideo === true }).then(media => sendResponse({ ok: true, media }), error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  });
})();
