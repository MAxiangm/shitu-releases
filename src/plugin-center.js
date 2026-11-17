/* Built-in image plugins. Processing and resource management stay in the main process. */
(() => {
  'use strict';
  const api = window.shitu;
  const definitions = [
    { id: 'ai-upscale', name: 'AI 放大图片', short: 'AI 放大', icon: 'upscale', description: '恢复边缘与细节，放大低分辨率图片。', type: 'AI 工具' },
    { id: 'ai-cutout', name: 'AI 自动抠图', short: 'AI 抠图', icon: 'cutout', description: '识别主体，导出透明背景图片。', type: 'AI 工具' },
    { id: 'crop', name: '裁切图片', short: '裁切', icon: 'crop', description: '拖动选择画面，按像素精确裁切。', type: '图片工具' },
    { id: 'compress', name: '压缩图片', short: '压缩', icon: 'compress', description: '调整质量与尺寸，减小图片文件。', type: '图片工具' },
    { id: 'convert', name: '转换格式', short: '转格式', icon: 'convert', description: '批量转换常用图片格式。', type: '图片工具' }
  ];
  const state = { open: false, plugins: [], devices: [], assets: [], selected: new Set(), libraryRoot: null, active: null, filter: 'all', job: null, installing: new Map(), cancelableInstalls: new Set(), crop: null, image: null, previousFocus: null, unsubscribe: null };
  let root, list, panel, note, drag, cropObserver;
  const $ = id => root.querySelector(`#${id}`);
  const text = (node, value) => { node.textContent = value == null ? '' : String(value); };
  const formatBytes = bytes => bytes < 1024 ? `${Math.round(bytes)} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  const node = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value !== undefined) text(n, value); return n; };
  function button(label, cls, click) { const n = node('button', cls, label); n.type = 'button'; if (click) n.addEventListener('click', click); return n; }
  function glyph(type) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('sp-icon');
    const paths = {
      upscale: 'M4 10V4h6M14 4h6v6M20 14v6h-6M10 20H4v-6M8 16l8-8M10 8h6v6',
      cutout: 'M4 5h4m8 0h4v4M20 15v4h-4M8 19H4v-4M12 3l1.4 4.5L18 9l-4.6 1.5L12 15l-1.4-4.5L6 9l4.6-1.5Z',
      crop: 'M7 3v14h14M3 7h14v14M10 7h7v7',
      compress: 'M4 4l6 6M4 9V4h5M20 20l-6-6m6 1v5h-5M20 4l-6 6m1-6h5v5M4 20l6-6m-6 1v5h5',
      convert: 'M4 8h15l-4-4M20 16H5l4 4M19 8v4M5 16v-4',
      close: 'M6 6l12 12M18 6L6 18', arrow: 'M5 12h14m-5-5 5 5-5 5', back: 'M19 12H5m5-5-5 5 5 5', check: 'M5 12l4 4L19 6', image: 'M4 4h16v16H4ZM4 16l5-5 5 5 3-3 3 3M8 8h.01'
    };
    const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', paths[type] || paths.image); svg.append(p); return svg;
  }
  function descriptor(id) { return { ...definitions.find(p => p.id === id), ...(state.plugins.find(p => p.id === id) || {}) }; }
  function chosen() { return state.assets.filter(a => state.selected.has(a.id)); }
  function imageUrl(asset) { return asset?.originalUrl || asset?.url || asset?.previewUrl || (asset && api.assetUrl?.(asset.id, 'original')) || ''; }
  function thumbUrl(asset) { return asset?.previewUrl || (asset && api.assetUrl?.(asset.id, 'thumb')) || imageUrl(asset); }
  function busy() { return Boolean(state.job && !['complete', 'error', 'cancelled'].includes(state.job.status)); }
  function report(message, error = false) { text(note, message); note.classList.toggle('sp-error', error); note.hidden = !message; }
  function build() {
    if (root) return;
    root = node('section', 'sp-overlay'); root.id = 'pluginCenter'; root.hidden = true; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'sp-title');
    root.innerHTML = '<div class="sp-window"><header class="sp-header"><div class="sp-heading"><span class="sp-kicker">IMAGE TOOLS</span><h2 id="sp-title">插件中心</h2></div><div class="sp-header-meta"><span id="sp-library-count"></span><button type="button" id="sp-close" class="sp-close" aria-label="关闭插件中心"></button></div></header><div id="sp-notice" class="sp-notice" role="status" hidden></div><div class="sp-body"><aside class="sp-sidebar"><div class="sp-tabs" aria-label="插件筛选"><button type="button" data-filter="all" class="is-active">全部</button><button type="button" data-filter="installed">已安装</button></div><div id="sp-list" class="sp-list"></div><p class="sp-local-note">本地处理 · 原图保留</p></aside><main id="sp-panel" class="sp-panel"></main></div></div>';
    document.body.append(root); list = $('sp-list'); panel = $('sp-panel'); note = $('sp-notice');
    $('sp-close').append(glyph('close')); $('sp-close').addEventListener('click', close);
    root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.filter; root.querySelectorAll('[data-filter]').forEach(t => t.classList.toggle('is-active', t === b)); renderList(); }));
    root.addEventListener('pointerdown', e => { if (e.target === root) close(); });
    document.addEventListener('keydown', e => {
      if (!state.open) return;
      if (e.key === 'Escape') { e.preventDefault(); if (drag) endCrop(); else close(); }
      if (e.key === 'Tab') {
        const focusable = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(n => n.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
      }
      // Library shortcuts must not act on the gallery behind this dialog.
      e.stopImmediatePropagation();
    }, true);
    if (api.onPluginEvent) state.unsubscribe = api.onPluginEvent(handleEvent);
  }
  async function refresh() {
    try {
      const result = await api.pluginsList();
      state.plugins = Array.isArray(result) ? result : result.plugins || [];
      state.devices = Array.isArray(result.devices) ? result.devices : [];
      renderList(); updateActions();
    } catch (error) { report(error.message || String(error), true); }
  }
  async function open({ assets = [], selectedIds = [], pluginId, libraryRoot } = {}) {
    build(); state.previousFocus = document.activeElement;
    const videos = /^(mp4|webm|m4v|mov|ogv|avi|mkv)$/i;
    state.assets = assets.filter(a => a && a.id && !a.trashedAt && a.mediaType === 'image' && !videos.test(String(a.ext || a.extension || '').replace(/^\./, '')));
    state.selected = new Set(selectedIds.filter(id => state.assets.some(a => a.id === id)));
    state.libraryRoot = libraryRoot || null;
    state.open = true; root.hidden = false; document.body.classList.add('is-plugin-center-open');
    text($('sp-library-count'), `${state.assets.length} 张图片可用`);
    if (!state.job) report('');
    await refresh();
    selectPlugin(pluginId || state.active || definitions[0].id);
    $('sp-close').focus();
  }
  function close() {
    if (!root) return;
    endCrop(); state.open = false; root.hidden = true; document.body.classList.remove('is-plugin-center-open');
    cropObserver?.disconnect(); state.previousFocus?.focus?.();
  }
  function renderList() {
    if (!list) return; list.replaceChildren();
    const plugins = definitions.map(d => descriptor(d.id)).filter(p => state.filter === 'all' || p.installed);
    if (!plugins.length) list.append(node('p', 'sp-list-empty', '还没有安装插件'));
    for (const p of plugins) {
      const b = button('', `sp-plugin-item${state.active === p.id ? ' is-active' : ''}`, () => selectPlugin(p.id));
      b.dataset.pluginId = p.id; b.setAttribute('aria-pressed', String(state.active === p.id));
      const icon = node('span', 'sp-plugin-icon'); icon.append(glyph(p.icon));
      const info = node('span', 'sp-plugin-info'); info.append(node('strong', '', p.short), node('small', '', state.installing.has(p.id) ? '安装中…' : !p.installed ? '未安装' : p.resourceReady === false ? '需要修复' : p.enabled === false ? '已停用' : '已安装'));
      b.append(icon, info); if (p.installed && p.enabled !== false) b.append(node('span', 'sp-status-dot')); list.append(b);
    }
  }
  function selectPlugin(id) {
    endCrop(); cropObserver?.disconnect(); state.active = definitions.some(p => p.id === id) ? id : definitions[0].id;
    const p = descriptor(state.active); renderList(); panel.replaceChildren();
    const top = node('div', 'sp-tool-top'); const title = node('div', 'sp-tool-title'); const mark = node('span', 'sp-tool-mark'); mark.append(glyph(p.icon));
    const titles = node('div'); titles.append(node('span', 'sp-kicker', p.type), node('h3', '', p.name), node('p', '', p.description)); title.append(mark, titles);
    const controls = node('div', 'sp-manage-actions'); controls.id = 'sp-manage'; top.append(title, controls); panel.append(top);
    const work = node('div', 'sp-work');
    const media = node('div', 'sp-media'); media.innerHTML = '<div class="sp-source-heading"><span>选择图片</span><div class="sp-source-actions"><button type="button" id="sp-select-all">全选</button><button type="button" id="sp-select-clear">清空</button><span id="sp-selected-count"></span></div></div><div id="sp-sources" class="sp-sources" aria-label="待处理图片"></div><div id="sp-preview" class="sp-preview"><div id="sp-image-wrap" class="sp-image-wrap"><img id="sp-image" alt="待处理图片" draggable="false"><div id="sp-crop-box" class="sp-crop-box" hidden><span class="sp-crop-grid"></span><button type="button" data-corner="nw" aria-label="裁切左上角"></button><button type="button" data-corner="ne" aria-label="裁切右上角"></button><button type="button" data-corner="sw" aria-label="裁切左下角"></button><button type="button" data-corner="se" aria-label="裁切右下角"></button></div></div><div id="sp-preview-empty" class="sp-preview-empty"></div><span id="sp-image-meta" class="sp-image-meta"></span></div>';
    const settings = node('div', 'sp-settings'); settings.id = 'sp-settings'; work.append(media, settings); panel.append(work);
    const footer = node('div', 'sp-footer'); footer.innerHTML = '<div class="sp-progress-content"><div class="sp-progress-label"><strong id="sp-job-title">结果保存为新素材</strong><span id="sp-job-percent"></span></div><p id="sp-job-message">保留原图，处理后自动加入当前素材库。</p><p id="sp-job-warning" class="sp-job-warning" hidden></p><div id="sp-result-links" class="sp-result-links" hidden></div><progress id="sp-job-progress" max="100" value="0" hidden></progress></div><button type="button" id="sp-cancel" class="sp-secondary" hidden>取消任务</button><button type="button" id="sp-run" class="sp-primary">开始处理</button>'; panel.append(footer);
    $('sp-select-all').addEventListener('click', () => { state.selected = new Set(state.active === 'crop' ? state.assets.slice(0, 1).map(a => a.id) : state.assets.map(a => a.id)); renderSources(); renderPreview(); updateActions(); });
    $('sp-select-clear').addEventListener('click', () => { state.selected.clear(); renderSources(); renderPreview(); updateActions(); });
    $('sp-run').addEventListener('click', run); $('sp-cancel').addEventListener('click', cancelJob);
    renderSettings(p); renderSources(); renderPreview(); updateActions(); renderJob();
  }
  function field(label, input, hint) { const box = node('label', 'sp-field'); box.append(node('span', 'sp-field-label', label), input); if (hint) box.append(node('small', '', hint)); return box; }
  function select(id, values) { const input = node('select', 'sp-input'); input.id = id; for (const [value, label] of values) { const o = node('option', '', label); o.value = value; input.append(o); } return input; }
  function number(id, value, min, max) { const input = node('input', 'sp-input'); input.type = 'number'; input.id = id; input.value = value; input.min = min; if (max != null) input.max = max; input.step = 1; return input; }
  function quality(settings, initial = 82) {
    const slider = node('input'); slider.type = 'range'; slider.id = 'sp-quality'; slider.min = 1; slider.max = 100; slider.value = initial;
    const label = node('div', 'sp-range-heading'); label.append(node('span', '', '图片质量')); const value = node('output', '', initial); value.id = 'sp-quality-value'; label.append(value);
    const box = node('div', 'sp-field'); box.append(label, slider, node('small', '', '数值越低，文件通常越小，细节损失越多。')); slider.addEventListener('input', () => text(value, slider.value)); settings.append(box);
  }
  function renderSettings(p) {
    const settings = $('sp-settings'); settings.replaceChildren(node('h4', '', '处理设置'));
    if (p.id === 'ai-upscale') settings.append(field('放大倍率', select('sp-scale', [['2', '2 倍'], ['4', '4 倍']]), 'AI 重建纹理，结果可能与原始细节不同。'));
    if (p.id.startsWith('ai-')) {
      settings.append(field('计算设备', select('sp-device', p.id === 'ai-upscale' ? [['auto', '自动 · Vulkan GPU'], ['gpu', '仅 GPU']] : [['auto', '自动 · 优先 GPU'], ['gpu', '仅 GPU'], ['cpu', '仅 CPU']])));
      settings.append(node('p', 'sp-setting-note', p.id === 'ai-cutout' ? '输出透明 PNG。复杂背景、发丝和透明物体可能需要再次修整。' : '大图会分块处理，以控制显存占用。'));
      const engine = node('p', 'sp-engine-info'); engine.id = 'sp-engine-info'; settings.append(engine);
    } else if (p.id === 'crop') {
      settings.append(field('裁切比例', select('sp-ratio', [['free', '自由'], ['1', '1 : 1'], [String(4 / 3), '4 : 3'], [String(3 / 4), '3 : 4'], [String(16 / 9), '16 : 9'], [String(9 / 16), '9 : 16']])));
      const coords = node('div', 'sp-crop-coords');
      for (const [id, label] of [['left', 'X'], ['top', 'Y'], ['width', '宽'], ['height', '高']]) {
        const input = number(`sp-crop-${id}`, id === 'width' || id === 'height' ? 1 : 0, id === 'width' || id === 'height' ? 1 : 0);
        input.addEventListener('change', () => cropFromFields(id)); coords.append(field(label, input));
      }
      settings.append(coords, button('重置裁切范围', 'sp-secondary sp-reset-crop', resetCrop), field('输出格式', select('sp-format', [['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP']])), node('p', 'sp-setting-note', '拖动画面选择区域，拖动边角调整大小。每次裁切一张图片。'));
      $('sp-ratio').addEventListener('change', applyRatio);
    } else if (p.id === 'compress') {
      settings.append(field('输出格式', select('sp-format', [['original', '保持原格式'], ['webp', 'WebP'], ['jpeg', 'JPG'], ['png', 'PNG'], ['avif', 'AVIF']]))); quality(settings);
      settings.append(field('最长边限制', number('sp-max-width', 0, 0, 32768), '0 表示保持尺寸；图片不会被放大。'), node('p', 'sp-setting-note', '压缩效果取决于原文件。透明图片转 JPG 时使用白色背景。暂不处理动图和多页图片。'));
    } else {
      settings.append(field('目标格式', select('sp-format', [['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP'], ['avif', 'AVIF'], ['tiff', 'TIFF']]))); quality(settings, 90);
      settings.append(node('p', 'sp-setting-note', '透明图片转 JPG 时使用白色背景。暂不处理动图和多页图片。'));
    }
  }
  function renderSources() {
    const sources = $('sp-sources'); if (!sources) return; sources.replaceChildren();
    text($('sp-selected-count'), `已选 ${chosen().length} 张`);
    if (!state.assets.length) sources.append(node('p', 'sp-no-sources', '先在素材库导入图片，再使用插件。'));
    for (const a of state.assets) {
      const b = button('', `sp-source${state.selected.has(a.id) ? ' is-selected' : ''}`, () => {
        if (busy()) return;
        if (state.active === 'crop') state.selected = new Set([a.id]);
        else if (state.selected.has(a.id)) state.selected.delete(a.id); else state.selected.add(a.id);
        renderSources(); renderPreview(); updateActions();
      });
      b.dataset.assetId = a.id; b.title = a.name; b.setAttribute('aria-label', `${state.selected.has(a.id) ? '取消选择' : '选择'} ${a.name}`); b.setAttribute('aria-pressed', String(state.selected.has(a.id))); b.disabled = busy();
      const img = node('img'); img.alt = ''; img.loading = 'lazy'; img.src = thumbUrl(a); const check = node('span', 'sp-source-check'); check.append(glyph('check')); b.append(img, check); sources.append(b);
    }
  }
  function renderPreview() {
    const selected = chosen(), asset = selected[0], img = $('sp-image'), empty = $('sp-preview-empty'), wrap = $('sp-image-wrap');
    state.image = null; state.crop = null; $('sp-crop-box').hidden = true;
    if (!asset) {
      img.removeAttribute('src'); wrap.hidden = true; empty.hidden = false; empty.replaceChildren(glyph('image'), node('p', '', '选择需要处理的图片')); text($('sp-image-meta'), ''); return;
    }
    wrap.hidden = true; empty.hidden = false; empty.replaceChildren(node('p', '', '正在读取图片…'));
    img.onload = () => {
      if (!state.open || img.dataset.assetId !== asset.id) return;
      const width = img.naturalWidth, height = img.naturalHeight;
      state.image = { width, height, assetId: asset.id }; wrap.hidden = false; empty.hidden = true;
      text($('sp-image-meta'), `${asset.name} · ${width} × ${height}${selected.length > 1 ? ` · 共 ${selected.length} 张` : ''}`);
      resetCrop(); fitImage(); updateActions();
      cropObserver?.disconnect(); cropObserver = new ResizeObserver(fitImage); cropObserver.observe($('sp-preview'));
    };
    img.onerror = () => {
      if (img.dataset.editingFallback !== 'true' && api.assetUrl) {
        img.dataset.editingFallback = 'true'; img.src = api.assetUrl(asset.id, 'editing'); return;
      }
      wrap.hidden = true; empty.hidden = false; empty.replaceChildren(node('p', '', '此图片无法预览。其他已选图片仍可处理。'));
    };
    img.dataset.assetId = asset.id; img.dataset.editingFallback = 'false'; img.src = imageUrl(asset);
    const cropBox = $('sp-crop-box'); cropBox.onpointerdown = startCrop;
    $('sp-preview').onpointerdown = e => { if (state.active === 'crop' && state.image && e.target === $('sp-image')) startCrop(e, 'new'); };
  }
  function fitImage() {
    if (!state.image || !$('sp-preview')) return;
    const box = $('sp-preview').getBoundingClientRect(), availableWidth = Math.max(1, box.width - 48), availableHeight = Math.max(1, box.height - 58), scale = Math.min(availableWidth / state.image.width, availableHeight / state.image.height, 2);
    const wrap = $('sp-image-wrap'); wrap.style.width = `${state.image.width * scale}px`; wrap.style.height = `${state.image.height * scale}px`; updateCropBox(false);
  }
  function resetCrop() {
    if (!state.image || state.active !== 'crop') return;
    state.crop = { left: 0, top: 0, width: state.image.width, height: state.image.height }; applyRatio();
  }
  function applyRatio() {
    if (!state.crop || !state.image) return;
    const ratio = Number($('sp-ratio').value);
    if (ratio > 0) {
      const w = state.image.width, h = state.image.height;
      const width = Math.min(w, h * ratio), height = width / ratio;
      state.crop = { left: (w - width) / 2, top: (h - height) / 2, width, height };
    }
    updateCropBox();
  }
  function normalizeCrop(crop) {
    const { width: w, height: h } = state.image;
    const left = Math.max(0, Math.min(w - 1, Math.round(crop.left))), top = Math.max(0, Math.min(h - 1, Math.round(crop.top)));
    return { left, top, width: Math.max(1, Math.min(w - left, Math.round(crop.width))), height: Math.max(1, Math.min(h - top, Math.round(crop.height))) };
  }
  function updateCropBox(syncFields = true) {
    if (!state.crop || !state.image || state.active !== 'crop') return;
    const c = normalizeCrop(state.crop); state.crop = c; const box = $('sp-crop-box'); box.hidden = false;
    box.style.left = `${c.left / state.image.width * 100}%`; box.style.top = `${c.top / state.image.height * 100}%`; box.style.width = `${c.width / state.image.width * 100}%`; box.style.height = `${c.height / state.image.height * 100}%`;
    if (syncFields) for (const key of ['left', 'top', 'width', 'height']) { $('sp-crop-' + key).value = c[key]; $('sp-crop-' + key).max = key === 'top' || key === 'height' ? state.image.height : state.image.width; }
  }
  function cropFromFields(changed) {
    if (!state.image || !state.crop) return;
    const crop = Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, Number($('sp-crop-' + key).value)]));
    if (Object.values(crop).some(v => !Number.isFinite(v))) { updateCropBox(); return; }
    const ratio = Number($('sp-ratio').value);
    if (ratio > 0) {
      if (changed === 'height') crop.width = crop.height * ratio;
      else if (changed === 'width') crop.height = crop.width / ratio;
    }
    state.crop = normalizeCrop(crop); updateCropBox();
  }
  function startCrop(event, mode) {
    if (event.button !== 0 || busy() || !state.crop || !state.image) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = $('sp-image-wrap').getBoundingClientRect();
    const x = Math.max(0, Math.min(state.image.width, (event.clientX - bounds.left) / bounds.width * state.image.width)), y = Math.max(0, Math.min(state.image.height, (event.clientY - bounds.top) / bounds.height * state.image.height));
    drag = { pointerId: event.pointerId, mode: mode || event.target.dataset.corner || 'move', x, y, crop: { ...state.crop }, bounds, target: event.currentTarget };
    if (mode === 'new') state.crop = { left: x, top: y, width: 1, height: 1 };
    drag.target.setPointerCapture?.(event.pointerId); drag.target.addEventListener('pointermove', moveCrop); drag.target.addEventListener('pointerup', endCrop); drag.target.addEventListener('pointercancel', endCrop); drag.target.addEventListener('lostpointercapture', endCrop); updateCropBox();
  }
  function moveCrop(e) {
    if (!drag || e.pointerId !== drag.pointerId) return; e.preventDefault();
    const { width: w, height: h } = state.image;
    const x = Math.max(0, Math.min(w, (e.clientX - drag.bounds.left) / drag.bounds.width * w)), y = Math.max(0, Math.min(h, (e.clientY - drag.bounds.top) / drag.bounds.height * h));
    const dx = x - drag.x, dy = y - drag.y, c = drag.crop, ratio = Number($('sp-ratio').value);
    if (drag.mode === 'move') state.crop = { ...c, left: Math.max(0, Math.min(w - c.width, c.left + dx)), top: Math.max(0, Math.min(h - c.height, c.top + dy)) };
    else {
      let anchorX, anchorY, endX = x, endY = y;
      if (drag.mode === 'new') { anchorX = drag.x; anchorY = drag.y; }
      else { anchorX = drag.mode.includes('w') ? c.left + c.width : c.left; anchorY = drag.mode.includes('n') ? c.top + c.height : c.top; }
      let width = Math.max(1, Math.abs(endX - anchorX)), height = Math.max(1, Math.abs(endY - anchorY));
      const sx = endX < anchorX ? -1 : 1, sy = endY < anchorY ? -1 : 1;
      if (ratio > 0) {
        if (width / height > ratio) height = width / ratio; else width = height * ratio;
        const limitW = sx > 0 ? w - anchorX : anchorX, limitH = sy > 0 ? h - anchorY : anchorY;
        const factor = Math.min(1, limitW / width, limitH / height); width *= factor; height *= factor;
      }
      endX = anchorX + sx * width; endY = anchorY + sy * height;
      state.crop = { left: Math.min(anchorX, endX), top: Math.min(anchorY, endY), width, height };
    }
    updateCropBox();
  }
  function endCrop() {
    if (!drag) return; const d = drag; drag = null;
    d.target.removeEventListener('pointermove', moveCrop); d.target.removeEventListener('pointerup', endCrop); d.target.removeEventListener('pointercancel', endCrop); d.target.removeEventListener('lostpointercapture', endCrop);
    try { if (d.target.hasPointerCapture?.(d.pointerId)) d.target.releasePointerCapture(d.pointerId); } catch (_) { /* already released */ }
  }
  function updateActions() {
    if (!root || !state.active || !$('sp-manage')) return;
    const p = descriptor(state.active), controls = $('sp-manage'); controls.replaceChildren();
    const pending = state.installing.has(p.id);
    if (!p.installed) controls.append(button(pending ? '正在安装…' : '安装插件', 'sp-secondary', () => manage('install', p.id)));
    else {
      if (p.resourceReady === false) controls.append(button(pending ? '正在修复…' : '修复组件', 'sp-secondary', () => manage('install', p.id)));
      controls.append(button(p.enabled === false ? '启用' : '停用', 'sp-text-button', () => manage('enable', p.id, p.enabled === false)), button('卸载', 'sp-text-button', () => manage('uninstall', p.id)));
    }
    controls.querySelectorAll('button').forEach(b => b.disabled = pending || busy());
    if (pending && state.cancelableInstalls.has(p.id)) controls.append(button('取消安装', 'sp-text-button', async event => {
      event.currentTarget.disabled = true; report('正在取消安装…');
      try { await api.pluginCancel(p.id); } catch (error) { report(error.message || String(error), true); }
    }));
    if ($('sp-engine-info')) {
      const deviceNames = state.devices.filter(d => typeof d === 'string' || d.software !== true).map(d => typeof d === 'string' ? d : d.name || d.description || d.deviceName || '').map(name => name.trim()).filter(name => name && !/microsoft basic render|software raster/i.test(name));
      const devices = [...new Map(deviceNames.map(name => [name.toLowerCase(), name])).values()].join(' / ');
      const engine = p.id === 'ai-upscale' ? 'Real-ESRGAN · Vulkan GPU' : `${p.engine || 'U²-Net'} · ${p.runtime?.provider || 'DirectML GPU / CPU'}`;
      const download = !p.installed || p.resourceReady === false ? p.runtime?.bundled ? '已附带离线组件，点击安装即可使用。' : `首次使用需下载组件${p.downloadBytes ? `，约 ${(p.downloadBytes / 1048576).toFixed(0)} MB` : ''}。` : '';
      text($('sp-engine-info'), [engine, devices, download, '图片仅在本机处理。'].filter(Boolean).join('\n'));
    }
    const run = $('sp-run'), count = chosen().length;
    run.disabled = busy() || pending || !p.installed || p.resourceReady === false || p.enabled === false || !count || (p.id === 'crop' && (count !== 1 || !state.crop));
    text(run, busy() ? state.job.pluginId === state.active ? '正在处理…' : '任务进行中' : !p.installed ? '请先安装插件' : p.resourceReady === false ? '请先修复组件' : p.enabled === false ? '插件已停用' : count > 1 && p.id !== 'crop' ? `处理 ${count} 张图片` : '开始处理');
    $('sp-select-all').disabled = busy(); $('sp-select-clear').disabled = busy();
    $('sp-settings').querySelectorAll('input,select,button').forEach(n => n.disabled = busy());
    if (p.id === 'crop' && count > 1) text($('sp-job-message'), '裁切每次处理一张，请在上方选择一张图片。');
  }
  async function manage(action, id, enabled) {
    if (busy() || state.installing.has(id)) return;
    if (action === 'install') state.cancelableInstalls.add(id);
    state.installing.set(id, 0); updateActions(); renderList(); report(action === 'install' ? '正在准备插件，请稍候…' : '正在更新插件…');
    try {
      let result;
      if (action === 'install') result = await api.pluginInstall(id);
      else if (action === 'enable') await api.pluginSetEnabled(id, enabled);
      else await api.pluginUninstall(id);
      report(result?.cancelled ? '安装已取消。' : action === 'install' ? '插件已安装，可以开始处理。' : action === 'uninstall' ? '插件已卸载，处理过的素材会保留。' : enabled ? '插件已启用。' : '插件已停用。');
    } catch (error) { report(error.message || String(error), true); }
    finally { state.installing.delete(id); state.cancelableInstalls.delete(id); await refresh(); }
  }
  function options() {
    const value = id => $(id)?.value;
    if (state.active === 'ai-upscale') return { scale: Number(value('sp-scale')), device: value('sp-device') };
    if (state.active === 'ai-cutout') return { device: value('sp-device') };
    if (state.active === 'crop') {
      const values = Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, Number(value('sp-crop-' + key))]));
      return { ...normalizeCrop(Object.values(values).every(Number.isFinite) ? values : state.crop), format: value('sp-format') };
    }
    if (state.active === 'compress') return { format: value('sp-format'), quality: Number(value('sp-quality')), maxSize: Number(value('sp-max-width')) };
    return { format: value('sp-format'), quality: Number(value('sp-quality')) };
  }
  async function run() {
    if ($('sp-run').disabled) return; report(''); endCrop();
    const processingOptions = options();
    state.job = { status: 'starting', pluginId: state.active, progress: 0, message: '正在准备处理…' }; renderJob(); updateActions(); renderSources();
    try {
      const result = await api.pluginRun({ pluginId: state.active, assetIds: chosen().map(a => a.id), options: processingOptions, libraryRoot: state.libraryRoot });
      // Early events can arrive before invoke resolves; don't revert completed jobs.
      if (state.job && !state.job.jobId) state.job.jobId = typeof result === 'string' ? result : result.jobId;
      if (state.job && state.job.status === 'starting') state.job.status = 'running';
      renderJob(); updateActions();
    } catch (error) { state.job = { ...state.job, status: 'error', message: error.message || String(error) }; renderJob(); updateActions(); renderSources(); }
  }
  async function cancelJob() {
    if (!state.job?.jobId || !busy()) return;
    try { await api.pluginCancel(state.job.jobId); if (busy()) { state.job.message = '正在取消…'; renderJob(); } } catch (error) { report(error.message || String(error), true); }
  }
  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'install-cancelled') { report('安装已取消。'); return; }
    if (event.type === 'install-error') { report(event.error || event.message || '插件安装失败，请重试。', true); return; }
    if (event.type === 'install-progress' || event.type === 'install' || (!event.jobId && state.installing.has(event.pluginId))) {
      if (event.pluginId) state.installing.set(event.pluginId, event.progress || 0);
      const n = Number(event.progress); report(`${event.message || '正在安装插件…'}${Number.isFinite(n) && n > 0 ? ` ${Math.round(n <= 1 ? n * 100 : n)}%` : ''}`); renderList(); return;
    }
    if (!['progress', 'complete', 'error', 'cancelled'].includes(event.type)) return;
    if (!state.job || (state.job.jobId && event.jobId && state.job.jobId !== event.jobId)) return;
    if (event.jobId) state.job.jobId = event.jobId;
    if (event.type === 'complete') {
      const count = event.results?.length ?? event.count ?? chosen().length;
      const failures = event.errors?.length || 0;
      const duplicates = event.results?.filter(r => r.duplicate).length || 0;
      state.job = { ...state.job, ...event, status: event.cancelled ? 'cancelled' : failures && !count ? 'error' : 'complete', progress: 100, message: event.message || `已完成 ${count} 张图片${duplicates ? `（${duplicates} 个结果已在素材库中）` : ''}${failures ? `，${failures} 张处理失败` : ''}${event.cancelled ? '，任务已取消' : ''}。` };
      if (failures) report(event.errors.slice(0, 3).map(e => typeof e === 'string' ? e : `${e.name || e.sourceId || '图片'}：${e.message || e.error || '处理失败'}`).join('\n'), true);
    }
    else if (event.type === 'error') state.job = { ...state.job, ...event, status: 'error', message: event.error?.message || event.error || event.message || '处理失败，请重试。' };
    else if (event.type === 'cancelled') state.job = { ...state.job, ...event, status: 'cancelled', message: event.message || '任务已取消，已完成的结果保留。' };
    else state.job = { ...state.job, ...event, status: 'running' };
    if (state.open) { renderJob(); updateActions(); if (!busy()) renderSources(); }
  }
  function renderJob() {
    if (!$('sp-job-title')) return;
    const j = state.job, progress = $('sp-job-progress'), cancel = $('sp-cancel');
    const warning = $('sp-job-warning'); warning.hidden = true; text(warning, '');
    const resultLinks = $('sp-result-links'); resultLinks.replaceChildren(); resultLinks.hidden = true;
    if (!j) { progress.hidden = true; cancel.hidden = true; return; }
    const n = Number(j.progress), percent = Math.max(0, Math.min(100, n <= 1 && n > 0 && j.status !== 'complete' ? n * 100 : n || 0));
    text($('sp-job-title'), j.status === 'complete' ? '处理完成' : j.status === 'error' ? '处理失败' : j.status === 'cancelled' ? '已取消' : descriptor(j.pluginId).name);
    text($('sp-job-message'), j.message || '正在处理…'); $('sp-job-message').classList.toggle('sp-error', j.status === 'error');
    if (!busy() && j.results?.length) {
      const fallbackResults = j.results.filter(r => r.fallback);
      if (fallbackResults.length) {
        text(warning, `${fallbackResults.length} 张图片的 GPU 推理不可用，已改用 CPU 完成。`); warning.title = [...new Set(fallbackResults.map(r => typeof r.fallback === 'string' ? r.fallback : 'GPU 推理不可用'))].join('\n'); warning.hidden = false;
      }
      if (j.pluginId === 'compress') {
        const measured = j.results.filter(r => Number.isFinite(r.beforeSize) && r.beforeSize > 0 && Number.isFinite(r.size) && r.size >= 0);
        if (measured.length) {
          const before = measured.reduce((sum, r) => sum + r.beforeSize, 0), after = measured.reduce((sum, r) => sum + r.size, 0);
          const difference = after === before ? '大小未变' : `${after < before ? '减少' : '增加'} ${(Math.abs(after - before) / before * 100).toFixed(1)}%`;
          text($('sp-job-message'), `${j.message || '处理完成。'} ${formatBytes(before)} → ${formatBytes(after)}（${difference}）`);
        }
      }
      const engines = [...new Set(j.results.map(r => [r.engine, r.provider || (r.accelerator === 'gpu' ? 'GPU' : '')].filter(Boolean).join(' · ')).filter(Boolean))];
      if (engines.length) resultLinks.append(node('span', 'sp-result-engine', engines.join(' / ')));
      if (api.openAsset) resultLinks.append(button('打开结果', 'sp-text-button', async () => {
        try { await api.openAsset(j.results[0].id); } catch (error) { report(error.message || String(error), true); }
      }));
      resultLinks.hidden = false;
    }
    text($('sp-job-percent'), busy() ? `${Math.round(percent)}%` : ''); progress.hidden = !busy(); progress.value = percent; cancel.hidden = !busy(); cancel.disabled = !j.jobId;
  }
  window.shituPlugins = Object.freeze({ open, close, refresh, isOpen: () => state.open });
})();
