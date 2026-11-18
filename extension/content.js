(() => {
  'use strict';
  if (globalThis.__shituCaptureInstalled) return;
  globalThis.__shituCaptureInstalled = true;
  const MAX_INLINE_BYTES = 20 * 1024 * 1024;
  let toastHost;
  let toastTimer;
  let recentGesture = null;
  let captureSerial = 0;

  function toast(message, status = 'working') {
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
      close.addEventListener('click', event => { event.stopPropagation(); clearTimeout(toastTimer); toastHost.style.display = 'none'; });
      const label = document.createElement('span');
      box.append(close, label);
      shadow.append(box);
      toastHost.__shituBox = box;
      toastHost.__shituLabel = label;
      document.documentElement.append(toastHost);
    }
    const box = toastHost.__shituBox;
    toastHost.__shituLabel.textContent = `Mosaic · ${message}`;
    toastHost.setAttribute('aria-label', `Mosaic · ${message}`);
    toastHost.setAttribute('data-status', status);
    box.style.borderColor = status === 'error' ? '#d8d8d8' : '#444444';
    box.style.color = status === 'error' ? '#ffffff' : '#d4d4d4';
    toastHost.style.display = 'block';
    clearTimeout(toastTimer);
    // Keep failures and unconfirmed work visible until the user dismisses them
    // or starts another capture. A start notice is never a save receipt.
    if (status === 'success') toastTimer = setTimeout(() => { if (toastHost) toastHost.style.display = 'none'; }, 8000);
  }

  function absolute(value, base = document.baseURI) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try { const url = new URL(value, base); return /^(https?|blob|data):$/.test(url.protocol) ? url.href : null; } catch { return null; }
  }
  function nameFor(node, url) {
    const label = node.getAttribute?.('alt') || node.getAttribute?.('title') || node.getAttribute?.('aria-label');
    if (label?.trim()) return label.trim().slice(0, 240);
    try { const last = decodeURIComponent(new URL(url).pathname.split('/').pop()); return last?.slice(0, 240) || document.title.slice(0, 240); } catch { return document.title.slice(0, 240); }
  }
  function direct(node) {
    if (!(node instanceof Element)) return null;
    let media = node;
    if (node.tagName === 'SOURCE') media = node.parentElement;
    if (media?.tagName === 'IMG') {
      const url = absolute(media.currentSrc || media.getAttribute('src'));
      return url ? { url, kind: 'image', name: nameFor(media, url) } : null;
    }
    if (media?.tagName === 'VIDEO') {
      const url = absolute(media.currentSrc || media.getAttribute('src') || media.querySelector('source[src]')?.getAttribute('src'));
      return url ? { url, kind: 'video', name: nameFor(media, url) } : null;
    }
    if (media?.tagName === 'IMAGE' || media?.tagName === 'image') {
      const url = absolute(media.getAttribute('href') || media.getAttribute('xlink:href'));
      return url ? { url, kind: 'image', name: nameFor(media, url) } : null;
    }
    return null;
  }
  function mediaAt(event) {
    const candidates = [];
    const add = node => { if (node instanceof Element && !candidates.includes(node)) candidates.push(node); };
    for (const node of event.composedPath()) add(node);
    for (const node of document.elementsFromPoint(event.clientX, event.clientY)) {
      add(node);
      if (node.shadowRoot) for (const child of node.shadowRoot.elementsFromPoint(event.clientX, event.clientY)) add(child);
    }
    for (const node of candidates) { const result = direct(node); if (result) return result; }
    for (const node of candidates) {
      const nearby = node.closest('picture,video');
      const result = direct(nearby?.tagName === 'PICTURE' ? nearby.querySelector('img') : nearby);
      if (result) return result;
    }
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

  async function resolveMedia(media) {
    const result = { ...media, pageUrl: location.href, title: document.title };
    if (media.kind === 'video' && /\.(m3u8|mpd)(?:$|[?#])/i.test(media.url)) throw new Error('这是分段流媒体，暂不能保存为视频文件。请使用网站提供的下载功能。');
    const temporary = /^(blob|data):/i.test(media.url);
    const browserImage = !temporary && media.kind === 'image' && /^https?:/i.test(media.url);
    if (!temporary && !browserImage) return result;
    if (media.url.length > 29 * 1024 * 1024) throw new Error('临时素材超过 20 MB，暂不支持快捷采集。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      // Same-origin images can use the browser's current login session. The
      // same-origin policy omits credentials for a cross-origin image request.
      const response = await fetch(media.url, { signal: controller.signal, credentials: browserImage ? 'same-origin' : 'omit' });
      const contentType = String(response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const allowedImage = /^image\/(?:png|jpeg|webp|gif|bmp|svg\+xml|avif|tiff)$/i;
      if (browserImage && (!response.ok || !allowedImage.test(contentType))) {
        await response.body?.cancel().catch(() => {});
        return result;
      }
      if (Number(response.headers?.get('content-length')) > MAX_INLINE_BYTES) {
        await response.body?.cancel().catch(() => {});
        if (browserImage) return result;
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
      const expected = media.kind === 'video' ? /^video\//i : /^image\//i;
      if (!expected.test(blob.type)) throw new Error(`临时地址不是${media.kind === 'video' ? '视频' : '图片'}文件。`);
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('临时素材读取失败。')); reader.readAsDataURL(blob); });
      result.url = media.url.startsWith('data:') ? `data:${media.kind}/placeholder;base64,` : media.url;
      result.dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      result.mimeType = blob.type.split(';')[0].toLowerCase();
      return result;
    } catch (error) {
      // CORS, read timeouts and oversized HTTP images fall back to the desktop's
      // existing direct-download path; Blob/data URLs cannot be read there.
      if (browserImage) return result;
      if (media.kind === 'video' && media.url.startsWith('blob:') && (error instanceof TypeError || error.name === 'AbortError')) throw new Error('视频来源是分段流或不允许读取，暂不能保存为视频文件。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function capture(media) {
    const serial = ++captureSerial;
    let submitted = false;
    toast('正在读取素材，尚未保存…');
    try {
      const prepared = await resolveMedia(media);
      submitted = true;
      const response = await chrome.runtime.sendMessage({ type: 'shitu:capture', media: prepared });
      if (!response?.ok) throw new Error(response?.error || '采集失败，请打开桌面软件重试。');
      if (!(Number.isSafeInteger(response.imported) && response.imported > 0) && !(Number.isSafeInteger(response.duplicates) && response.duplicates > 0)) throw new Error('桌面未确认素材入库，请在 Mosaic 中检查后重试。');
      if (serial !== captureSerial) return;
      const inTrash = !response.imported && response.existingAssets?.some(asset => asset.trashedAt);
      toast(response.message || (response.imported ? '已保存到素材库，可在“最近导入”查看。' : inTrash ? '这份素材已在回收站，请到 Mosaic 恢复后查看。' : '素材库中已有这份文件，可清除筛选后查看。'), response.status || (inTrash ? 'warning' : 'success'));
    } catch (error) {
      const message = /Extension context invalidated|Receiving end does not exist/i.test(error.message || '')
        ? '采集助手已更新，请刷新当前网页后再采集。' : error.message || '采集失败。';
      // Also persist errors that happened while reading Blob/data resources,
      // before a capture request reached the background worker.
      if (!submitted) chrome.runtime.sendMessage({ type: 'shitu:capture-failed', name: media?.name, error: message }).catch(() => {});
      if (serial === captureSerial) toast(message, 'error');
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
    const media = mediaAt(event) || (recent ? recentGesture.media : null);
    recentGesture = null;
    if (!media) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    capture(media);
  }, true);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'shitu:status') { toast(String(message.message || ''), message.status); return; }
    if (message?.type === 'shitu:resolve-media') {
      resolveMedia(message.media).then(media => sendResponse({ ok: true, media }), error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  });
})();
