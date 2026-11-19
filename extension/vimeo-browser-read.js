'use strict';

// Keep Vimeo media on the browser's network path when the desktop cannot read
// the same signed source. Only the extension worker can request or receive data.
(() => {
  const CHUNK_BYTES = 256 * 1024;
  const MAX_BYTES = 512 * 1024 * 1024;
  const active = new Map();
  function sourceUrl(value, sourceType) {
    if (sourceType === 'youtube-browser') {
      const source = globalThis.MosaicYouTubeBrowser?.streamUrl(value);
      if (!source) throw new Error('YouTube 浏览器读取地址无效。');
      return source;
    }
    if (sourceType !== undefined) throw new Error('浏览器读取来源无效。');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
        !url.hostname.endsWith('.vimeocdn.com')) throw new Error('视频浏览器读取地址无效。');
    return url.href;
  }
  function permittedPage(sourceType) {
    if (sourceType === 'youtube-browser') return location.protocol === 'https:' &&
      /^(?:(?:www|m|music)\.)?youtube\.com$|^(?:www\.)?youtube-nocookie\.com$/.test(location.hostname);
    return location.protocol === 'https:' && /^(?:(?:www|player)\.)?vimeo\.com$/.test(location.hostname);
  }
  function encode(bytes) {
    let value = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      value += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    }
    return btoa(value);
  }
  async function read(message) {
    if (!permittedPage(message.sourceType) || typeof message.requestId !== 'string' || typeof message.readId !== 'string' ||
        message.requestId.length > 80 || message.readId.length > 80 ||
        !Number.isSafeInteger(message.limit) || message.limit < 1 || message.limit > MAX_BYTES) {
      throw new Error('视频浏览器读取请求无效。');
    }
    const url = sourceUrl(message.url, message.sourceType);
    const range = message.range;
    if (message.sourceType === 'youtube-browser' && range) throw new Error('YouTube 浏览器读取必须获取完整文件。');
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < 0 || range.end < range.start || range.end - range.start + 1 > message.limit)) {
      throw new Error('视频浏览器读取区间无效。');
    }
    const key = `${message.requestId}/${message.readId}`;
    if (active.has(key)) throw new Error('视频浏览器读取任务已在进行。');
    const controller = new AbortController();
    active.set(key, controller);
    const timer = setTimeout(() => controller.abort(), 240000);
    let sequence = 0, reader;
    async function send(fields) {
      const result = await chrome.runtime.sendMessage({ type: 'shitu:vimeo-browser-data',
        requestId: message.requestId, readId: message.readId, sequence: sequence++, ...fields });
      if (!result?.ok) throw new Error(result?.error || '桌面未确认收到 视频数据。');
    }
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error',
        ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}), signal: controller.signal });
      if (sourceUrl(response.url, message.sourceType) !== url) throw new Error('浏览器读取地址发生变化。');
      if (message.sourceType === 'youtube-browser' && (response.status !== 200 ||
          !/^(?:video|audio)\/(?:mp4|webm)(?:\s*;|$)/i.test(response.headers.get('content-type') || ''))) {
        throw new Error('YouTube 浏览器未返回完整的视频或音频文件。');
      }
      const length = response.headers.get('content-length');
      const encoding = response.headers.get('content-encoding');
      // CORS can expose Content-Length while hiding Content-Encoding. Fetch
      // decodes compressed playlists, so their wire length is not a byte count.
      const playlist = /\.(?:m3u8|mpd)$/i.test(new URL(url).pathname);
      const head = { status: response.status, url, contentType: response.headers.get('content-type') || '',
        ...(!playlist && length && /^\d+$/.test(length) && (!encoding || encoding === 'identity') ? { contentLength: Number(length) } : {}),
        ...(response.headers.get('content-range') ? { contentRange: response.headers.get('content-range') } : {}) };
      await send({ head });
      if (!response.body) throw new Error('视频浏览器未返回视频数据。');
      reader = response.body.getReader();
      let received = 0;
      while (true) {
        controller.signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
          const bytes = value.subarray(offset, offset + CHUNK_BYTES);
          received += bytes.length;
          if (received > message.limit) throw new Error('视频浏览器读取超出采集大小上限。');
          await send({ dataBase64: encode(bytes) });
        }
      }
      await send({ done: true });
      return { ok: true };
    } catch (error) {
      // Do not copy URLs or signed query strings into the public failure record.
      const detail = error?.name === 'AbortError' ? '视频浏览器读取超时或已取消。'
        : error?.message === 'Failed to fetch' ? '浏览器也无法读取 视频数据，可能受到跨域或访问限制。'
          : String(error?.message || '视频浏览器读取失败。').slice(0, 300);
      try { await send({ error: detail }); } catch {}
      return { ok: false, error: detail };
    } finally {
      controller.abort();
      try { await reader?.cancel(); } catch {}
      clearTimeout(timer);
      active.delete(key);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'shitu:vimeo-browser-cancel') {
      active.get(`${message.requestId}/${message.readId}`)?.abort();
      respond({ ok: true });
      return;
    }
    if (message?.type !== 'shitu:vimeo-browser-read') return;
    read(message).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
