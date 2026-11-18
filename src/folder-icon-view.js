(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituFolderIconView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const path = d => ['path', { d }];
  const rect = (x, y, width, height, rx = 0) => ['rect', { x, y, width, height, rx }];
  const circle = (cx, cy, r) => ['circle', { cx, cy, r }];
  const definitions = Object.freeze([
    { id: 'folder', name: '文件夹', shapes: [path('M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z')] },
    { id: 'image', name: '图片', shapes: [rect(3, 3, 18, 18, 2), circle(8, 8, 1.5), path('m3 17 6-6 5 5 3-3 4 4')] },
    { id: 'video', name: '视频', shapes: [rect(3, 4, 18, 16, 2), path('m10 8 6 4-6 4ZM3 8h3m-3 8h3m12-8h3m-3 8h3')] },
    { id: 'music', name: '音乐', shapes: [path('M9 18V5l12-2v13M9 8l12-2'), ['ellipse', { cx: 6, cy: 18, rx: 3, ry: 2.5 }], ['ellipse', { cx: 18, cy: 16, rx: 3, ry: 2.5 }]] },
    { id: 'camera', name: '摄影', shapes: [path('M8 6 10 3h4l2 3h4a1 1 0 0 1 1 1v12H3V7a1 1 0 0 1 1-1Z'), circle(12, 12.5, 4)] },
    { id: 'document', name: '文档', shapes: [path('M5 3h9l5 5v13H5ZM14 3v5h5M8 12h8M8 16h8')] },
    { id: 'font', name: '字体', shapes: [path('M3 5h18M12 5v15M8 20h8M3 8V5m18 3V5')] },
    { id: 'code', name: '代码', shapes: [path('m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18')] },
    { id: 'archive', name: '归档', shapes: [rect(3, 3, 18, 5, 1), path('M5 8v13h14V8M9 12h6')] },
    { id: 'model', name: '3D 模型', shapes: [path('m12 2 9 5v10l-9 5-9-5V7Zm0 10 9-5M12 12 3 7m9 5v10')] },
    { id: 'brush', name: '笔刷', shapes: [path('m9 14 9-11 3 3-11 9M9 14c-4-2-6 1-5 4 0 1-1 2-2 2 6 2 9-1 8-5Z')] },
    { id: 'palette', name: '设计', shapes: [path('M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4c0-4.2-4.5-7.5-9-7.5Z'), circle(7, 10, 1), circle(10, 7, 1), circle(15, 7, 1)] },
    { id: 'layers', name: '图层', shapes: [path('m12 3 10 5-10 5L2 8Zm-9 9 9 5 9-5M3 16l9 5 9-5')] },
    { id: 'project', name: '项目', shapes: [rect(3, 7, 18, 14, 2), path('M8 7V3h8v4M3 12h18M10 12v3h4v-3')] },
    { id: 'star', name: '收藏', shapes: [path('m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z')] },
    { id: 'heart', name: '喜爱', shapes: [path('M12 21 3.8 12.8A5.5 5.5 0 0 1 12 5.5a5.5 5.5 0 0 1 8.2 7.3Z')] }
  ].map(item => Object.freeze(item)));
  const byId = new Map(definitions.map(item => [item.id, item]));
  function builtin(name = 'folder', color, doc = document) {
    const definition = byId.get(name) || byId.get('folder');
    const node = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('class', 'icon folder-icon'); node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('aria-hidden', 'true'); node.style.fill = 'none';
    if (/^#[a-f\d]{6}$/i.test(color || '')) node.style.color = color;
    for (const [tag, attributes] of definition.shapes) {
      const shape = doc.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, String(value));
      node.append(shape);
    }
    return node;
  }
  function create(folder, { imageUrl, fallbackColor, document: doc = document } = {}) {
    const color = folder?.iconColor || fallbackColor;
    const fallback = () => builtin(folder?.icon?.type === 'builtin' ? folder.icon.name : 'folder', color, doc);
    const source = folder?.icon?.type === 'image' && imageUrl?.(folder);
    if (!source) return fallback();
    const node = doc.createElement('img'); node.className = 'folder-icon folder-custom-icon';
    node.src = source; node.alt = ''; node.draggable = false; node.setAttribute('aria-hidden', 'true');
    node.addEventListener('error', () => node.replaceWith(fallback()), { once: true });
    return node;
  }
  return Object.freeze({ definitions, builtin, create });
});
