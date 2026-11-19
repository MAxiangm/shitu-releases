(function (scope) {
  'use strict';
  const MODEL_ID = /^[a-f0-9]{32}$/;
  const SOURCE_FIELDS = new Set(['kind', 'sourceType', 'modelId', 'url', 'pageUrl', 'name', 'title']);
  const fail = message => Object.assign(new Error(message), { code: 'SKETCHFAB_SOURCE_INVALID' });
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
  scope.MosaicSketchfab = { sketchfabPage, parseModelUrl, checkedSource, selectModel, selectionCurrent };
  if (typeof module === 'object' && module.exports) module.exports = scope.MosaicSketchfab;
})(typeof globalThis === 'object' ? globalThis : this);
