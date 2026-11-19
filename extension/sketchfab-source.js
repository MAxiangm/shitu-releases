(function (scope) {
  'use strict';
  const MODEL_ID = /^[a-f0-9]{32}$/;
  const SOURCE_FIELDS = new Set(['kind', 'sourceType', 'modelId', 'url', 'pageUrl', 'name', 'title']);
  const fail = message => Object.assign(new Error(message), { code: 'SKETCHFAB_SOURCE_INVALID' });
  const DOWNLOAD_TIMEOUT = 3 * 60000;
  const DOWNLOAD_ERRORS = {
    SKETCHFAB_LOGIN_REQUIRED: '请先在当前 Chrome 登录 Sketchfab 后重试。',
    SKETCHFAB_NOT_DOWNLOADABLE: '当前账号无权下载此模型，或模型未开放免费下载。',
    SKETCHFAB_DOWNLOAD_UNAVAILABLE: '此模型暂时没有可用的 glTF 下载文件。',
    SKETCHFAB_SOURCE_CHANGED: '模型或页面已变化，请在当前模型上重新采集。',
    SKETCHFAB_DOWNLOAD_TIMEOUT: '模型下载地址准备超时，请稍后重试。',
    SKETCHFAB_DOWNLOAD_FAILED: '无法读取 Sketchfab 官方下载地址，请稍后重试。',
    SKETCHFAB_VIEWER_UNAVAILABLE: '请刷新模型页，等待模型显示后再 Alt＋右键采集。',
    SKETCHFAB_VIEWER_UNSUPPORTED: '此模型包含暂未支持的骨骼、动画或绘制方式，未保存不完整模型。',
    SKETCHFAB_VIEWER_TOO_LARGE: '网页模型超过当前采集大小上限，未保存。',
    SKETCHFAB_VIEWER_INVALID: '网页模型数据无效，请刷新模型页后重新采集。',
    SKETCHFAB_VIEWER_INCOMPLETE: '网页模型或贴图尚未完整加载，请等待后重新采集。'
  };
  function downloadError(code) {
    code = Object.hasOwn(DOWNLOAD_ERRORS, code) ? code : 'SKETCHFAB_DOWNLOAD_FAILED';
    return Object.assign(new Error(DOWNLOAD_ERRORS[code]), { code });
  }
  function checkedArchiveUrl(value, modelId) {
    if (!MODEL_ID.test(modelId || '') || typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) throw downloadError();
    let parsed;
    try { parsed = new URL(value); } catch { throw downloadError(); }
    const prefix = `/archives/${modelId}/gltf/`;
    const tail = parsed.pathname.slice(prefix.length);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'sketchfab-prod-media.s3.amazonaws.com' || parsed.port ||
        parsed.username || parsed.password || parsed.hash || !parsed.pathname.startsWith(prefix) ||
        !/^[A-Za-z0-9_.\/-]+\.zip$/.test(tail) || tail.split('/').some(part => !part || part === '.' || part === '..') ||
        /(?:^|\/)\.{1,2}(?:\/|$)/.test(value.split('?')[0])) throw downloadError();
    return parsed.href;
  }
  function checkedPollUrl(value, origin, modelId) {
    if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) throw downloadError();
    let parsed;
    try { parsed = new URL(value, origin); } catch { throw downloadError(); }
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.hash ||
        !/^\/i\/archives\/[A-Za-z0-9_./-]+$/.test(parsed.pathname) ||
        /(?:^|\/)\.{1,2}(?:\/|$)/.test(value.split('?')[0]) ||
        parsed.searchParams.getAll('model').some(id => id !== modelId) || parsed.searchParams.getAll('model').length > 1) throw downloadError();
    return parsed.href;
  }
  async function resolveDownload({ modelId, pageUrl, fetch: request = scope.fetch, isCurrent = () => true, timeout = DOWNLOAD_TIMEOUT } = {}) {
    if (!MODEL_ID.test(modelId || '') || !sketchfabPage(pageUrl) || typeof request !== 'function') throw downloadError();
    const origin = new URL(pageUrl).origin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(DOWNLOAD_TIMEOUT, Math.max(1, timeout)));
    const current = () => { if (!isCurrent()) throw downloadError('SKETCHFAB_SOURCE_CHANGED'); controller.signal.throwIfAborted(); };
    async function get(value) {
      current();
      const response = await request(value, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CsrfToken': 'skfb-no-token' }, signal: controller.signal });
      current();
      if (response.status === 401) throw downloadError('SKETCHFAB_LOGIN_REQUIRED');
      if (response.status === 403) throw downloadError('SKETCHFAB_NOT_DOWNLOADABLE');
      if (response.status === 202) { void response.body?.cancel().catch(() => {}); return { pending: true }; }
      if (!response.ok || response.status !== 200 || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw downloadError();
      let text = '', length = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read(); current(); if (chunk.done) break;
            length += chunk.value.byteLength; if (length > 2 * 1024 * 1024) throw downloadError();
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally { void reader.cancel().catch(() => {}); }
      } else { text = await response.text(); if (text.length > 2 * 1024 * 1024) throw downloadError(); }
      current();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw downloadError();
      return { data };
    }
    try {
      const { data: metadata } = await get(`${origin}/i/models/${modelId}`);
      if (metadata?.uid !== modelId) throw downloadError('SKETCHFAB_SOURCE_CHANGED');
      if (metadata.downloadType !== 'free' || metadata.isPublished !== true || metadata.isDeleted !== false || metadata.isDisabled !== false) throw downloadError('SKETCHFAB_NOT_DOWNLOADABLE');
      const { data: download } = await get(`${origin}/i/models/${modelId}/download`);
      if (download?.status !== 'Authorized') throw downloadError('SKETCHFAB_NOT_DOWNLOADABLE');
      let polling;
      for (const version of [download.latest, download.original]) {
        if (!Array.isArray(version?.gltf) || version.gltf.length > 32) continue;
        for (const archive of version.gltf) {
          try { polling = checkedPollUrl(archive?.url, origin, modelId); } catch { continue; }
          break;
        }
        if (polling) break;
      }
      if (!polling) throw downloadError('SKETCHFAB_DOWNLOAD_UNAVAILABLE');
      for (;;) {
        const result = await get(polling);
        if (!result.pending) { current(); return checkedArchiveUrl(result.data.url, modelId); }
        await new Promise((resolve, reject) => {
          const aborted = () => { clearTimeout(wait); reject(downloadError('SKETCHFAB_DOWNLOAD_TIMEOUT')); };
          const wait = setTimeout(() => { controller.signal.removeEventListener('abort', aborted); resolve(); }, 1000);
          controller.signal.addEventListener('abort', aborted, { once: true });
          if (controller.signal.aborted) aborted();
        });
      }
    } catch (error) {
      if (controller.signal.aborted) throw downloadError('SKETCHFAB_DOWNLOAD_TIMEOUT');
      throw downloadError(error?.code);
    } finally { clearTimeout(timer); }
  }
  function sketchfabPage(value) {
    try {
      const page = value instanceof URL ? value : new URL(value);
      return page.protocol === 'https:' && !page.username && !page.password && !page.port &&
        ['sketchfab.com', 'www.sketchfab.com'].includes(page.hostname);
    } catch { return false; }
  }
  function parseModelUrl(value, base) {
    if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    let page;
    try { page = new URL(value, base); } catch { return null; }
    if (!sketchfabPage(page)) return null;
    const model = /^\/3d-models\/([^/]+)\/?$/.exec(page.pathname);
    const embed = /^\/models\/([a-f0-9]{32})\/embed\/?$/.exec(page.pathname);
    const modelId = embed?.[1] || (model && /(?:^|-)([a-f0-9]{32})$/.exec(model[1])?.[1]);
    if (!MODEL_ID.test(modelId || '')) return null;
    const url = `https://sketchfab.com/3d-models/${modelId}`;
    return { modelId, url, pageUrl: url };
  }
  function text(value, maximum) {
    return typeof value === 'string' && value.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : null;
  }
  function checkedSource(input, senderUrl) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !SOURCE_FIELDS.has(key)) ||
        input.kind !== 'model' || input.sourceType !== 'sketchfab' || !sketchfabPage(senderUrl)) throw fail('Sketchfab 模型来源无效。');
    const source = parseModelUrl(input.url);
    if (!source || input.modelId !== source.modelId || input.url !== source.url || input.pageUrl !== source.url) throw fail('Sketchfab 模型与来源页面不一致。');
    const result = { kind: 'model', sourceType: 'sketchfab', ...source };
    for (const key of ['name', 'title']) {
      if (input[key] !== undefined) { result[key] = text(input[key], key === 'name' ? 240 : 500); if (result[key] === null) throw fail('Sketchfab 模型名称无效。'); }
    }
    return result;
  }
  function selection(source, element, page, document, link) {
    const label = text(element?.getAttribute?.('title') || element?.textContent?.trim() || document?.title || '', 500) || '';
    return { source: { kind: 'model', sourceType: 'sketchfab', ...source, name: label.slice(0, 240), title: label },
      element, link: Boolean(link), page: page.href };
  }
  function selectModel({ document, page, path = [], x, y }) {
    try { page = page instanceof URL ? page : new URL(page); } catch { return null; }
    if (!sketchfabPage(page)) return null;
    const links = new Map();
    let explicitLink = false;
    for (const element of path) {
      const link = element?.tagName === 'A' ? element : element?.closest?.('a[href]');
      if (!link) continue;
      explicitLink = true;
      const source = parseModelUrl(link.getAttribute?.('href') || link.href, page.href);
      if (source) links.set(source.modelId, selection(source, link, page, document, true));
    }
    if (links.size === 1) return links.values().next().value;
    if (links.size || explicitLink) return null;
    if (path.some(element => ['IMG', 'PICTURE', 'VIDEO', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element?.tagName) ||
        ['button', 'menu', 'menuitem', 'slider'].includes(element?.getAttribute?.('role')))) return null;
    const current = parseModelUrl(page.href);
    if (!current) return null;
    const pointed = [...path, ...(document?.elementsFromPoint?.(x, y) || [])];
    const canvases = [...new Set(pointed.filter(element => element?.tagName === 'CANVAS' && element.isConnected !== false))];
    const hits = canvases.filter(element => {
      const rect = element.getBoundingClientRect?.();
      return !rect || typeof x !== 'number' || typeof y !== 'number' || x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    });
    if (hits.length === 1) return selection(current, hits[0], page, document, false);
    const frames = [...new Set(path.filter(element => element?.tagName === 'IFRAME' && element.isConnected !== false))];
    if (frames.length === 1) {
      const framed = parseModelUrl(frames[0].getAttribute?.('src') || frames[0].src, page.href);
      if (framed?.modelId === current.modelId) return selection(current, frames[0], page, document, false);
    }
    return null;
  }
  function selectionCurrent(value, page) {
    if (!value || value.page !== String(page) || value.element?.isConnected === false) return false;
    if (!value.link) {
      if (parseModelUrl(String(page))?.modelId !== value.source.modelId) return false;
      if (value.element?.tagName === 'IFRAME') {
        return parseModelUrl(value.element.getAttribute?.('src') || value.element.src, String(page))?.modelId === value.source.modelId;
      }
      return true;
    }
    return parseModelUrl(value.element?.getAttribute?.('href') || value.element?.href, String(page))?.modelId === value.source.modelId;
  }
  scope.MosaicSketchfab = { sketchfabPage, parseModelUrl, checkedSource, selectModel, selectionCurrent,
    checkedArchiveUrl, resolveDownload, downloadError, DOWNLOAD_TIMEOUT };
  if (typeof module === 'object' && module.exports) module.exports = scope.MosaicSketchfab;
})(typeof globalThis === 'object' ? globalThis : this);
