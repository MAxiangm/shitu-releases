(() => {
  'use strict';
  if (globalThis.__shituCaptureInstalled) return;
  globalThis.__shituCaptureInstalled = true;
  const MAX_INLINE_BYTES = 20 * 1024 * 1024;
  let toastHost;
  let toastTimer;
  let recentGesture = null;

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
      Object.assign(box.style, { font: '13px/1.65 system-ui,"Microsoft YaHei",sans-serif', color: '#d4d4d4', background: '#0d0d0d', border: '1px solid #444444', borderRadius: '10px', padding: '12px 17px', boxShadow: '0 8px 24px #0008', maxWidth: '370px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
      shadow.append(box);
      toastHost.__shituBox = box;
      document.documentElement.append(toastHost);
    }
    const box = toastHost.__shituBox;
    box.textContent = `拾图 · ${message}`;
    toastHost.setAttribute('aria-label', `拾图 · ${message}`);
    toastHost.setAttribute('data-status', status);
    box.style.borderColor = status === 'error' ? '#d8d8d8' : '#444444';
    box.style.color = status === 'error' ? '#ffffff' : '#d4d4d4';
    toastHost.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastHost) toastHost.style.display = 'none'; }, status === 'working' ? 95000 : status === 'error' ? 9000 : 4000);
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
    if (!/^(blob|data):/i.test(media.url)) return result;
    if (media.url.length > 29 * 1024 * 1024) throw new Error('临时素材超过 20 MB，暂不支持快捷采集。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(media.url, { signal: controller.signal, credentials: 'omit' });
      const blob = await response.blob();
      if (blob.size > MAX_INLINE_BYTES) throw new Error('临时素材超过 20 MB，暂不支持快捷采集。');
      const expected = media.kind === 'video' ? /^video\//i : /^image\//i;
      if (!expected.test(blob.type)) throw new Error(`临时地址不是${media.kind === 'video' ? '视频' : '图片'}文件。`);
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('临时素材读取失败。')); reader.readAsDataURL(blob); });
      result.url = media.url.startsWith('data:') ? `data:${media.kind}/placeholder;base64,` : media.url;
      result.dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      result.mimeType = blob.type.split(';')[0].toLowerCase();
      return result;
    } catch (error) {
      if (media.kind === 'video' && media.url.startsWith('blob:') && (error instanceof TypeError || error.name === 'AbortError')) throw new Error('视频来源是分段流或不允许读取，暂不能保存为视频文件。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function capture(media) {
    toast('正在采集到素材库…');
    try {
      const prepared = await resolveMedia(media);
      const response = await chrome.runtime.sendMessage({ type: 'shitu:capture', media: prepared });
      if (!response?.ok) throw new Error(response?.error || '采集失败，请打开桌面软件重试。');
      toast(response.imported ? '已保存到素材库' : '素材库中已有这份文件', 'success');
    } catch (error) {
      const message = /Extension context invalidated|Receiving end does not exist/i.test(error.message || '')
        ? '采集助手已更新，请刷新当前网页后再采集。' : error.message || '采集失败。';
      toast(message, 'error');
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
