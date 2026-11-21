(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituImageLayers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_LAYERS = 12;
  const MAX_PIXELS = 64 * 1024 * 1024;
  const MAX_DOCUMENT_PIXELS = 16_777_216;
  const BLENDS = Object.freeze({
    'source-over': '正常', multiply: '正片叠底', screen: '滤色', overlay: '叠加',
    darken: '变暗', lighten: '变亮', 'color-dodge': '颜色减淡', 'color-burn': '颜色加深',
    'hard-light': '强光', 'soft-light': '柔光', difference: '差值', exclusion: '排除',
    hue: '色相', saturation: '饱和度', color: '颜色', luminosity: '明度'
  });
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  let nextId = 0;

  function textMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.text !== 'string') return undefined;
    const family = typeof value.fontFamily === 'string' ? value.fontFamily.replace(/[\u0000-\u001f"'\\;:{}]/g, '').trim().slice(0, 120) : '';
    return {
      text: value.text.slice(0, 20000), fontSize: clamp(finite(value.fontSize, 48), 1, 4096),
      fontFamily: family || 'Microsoft YaHei', bold: Boolean(value.bold),
      align: ['left', 'center', 'right'].includes(value.align) ? value.align : 'left',
      x: clamp(finite(value.x, 0), -1e6, 1e6), y: clamp(finite(value.y, 0), -1e6, 1e6),
      lineHeight: clamp(finite(value.lineHeight, 1.2), 0.5, 10),
      color: typeof value.color === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value.color) ? value.color : '#ffffff'
    };
  }

  function defaultCanvas(width, height) {
    let result;
    if (typeof document !== 'undefined') result = document.createElement('canvas');
    else if (typeof OffscreenCanvas !== 'undefined') result = new OffscreenCanvas(width, height);
    else throw new Error('当前环境不支持图层画布');
    result.width = width; result.height = height;
    return result;
  }

  function create(width, height, baseCanvas = null, baseName = '背景', options = {}) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
      throw new Error('图层画布尺寸无效或超过像素上限');
    }
    const pixels = width * height;
    const factory = options.canvasFactory || defaultCanvas;
    let layers = [], activeId = null;

    function allocate() {
      const result = factory(width, height);
      if (!result || typeof result.getContext !== 'function') throw new Error('无法创建图层画布');
      result.width = width; result.height = height;
      if (!result.getContext('2d', { willReadFrequently: true })) throw new Error('无法创建图层绘图上下文');
      return result;
    }
    const context = target => target.getContext('2d', { willReadFrequently: true });
    function capacity(count) {
      if (count > MAX_LAYERS) throw new Error(`最多支持 ${MAX_LAYERS} 个图层`);
      if (count * pixels > MAX_PIXELS) throw new Error('图层总像素超过 6400 万上限，请合并图层后再添加');
    }
    function identifier() { nextId += 1; return `layer-${Date.now().toString(36)}-${nextId.toString(36)}`; }
    function nameOf(value, fallback = '图层') { return String(value || fallback).trim().slice(0, 160) || fallback; }
    function find(id = activeId) {
      const layer = layers.find(item => item.id === id);
      if (!layer) throw new Error('图层不存在');
      return layer;
    }
    function metadata(layer, overrides = {}) {
      const text = textMetadata(layer.text);
      return {
        id: layer.id, name: nameOf(layer.name), visible: layer.visible !== false, locked: Boolean(layer.locked),
        opacity: clamp(finite(layer.opacity, 100), 0, 100), blend: Object.hasOwn(BLENDS, layer.blend) ? layer.blend : 'source-over',
        x: finite(layer.x, 0), y: finite(layer.y, 0), scale: clamp(finite(layer.scale, 100), 1, 10000),
        rotation: finite(layer.rotation, 0), ...(text ? { text } : {}), ...overrides
      };
    }
    function cloneCanvas(input) {
      const target = allocate(); context(target).drawImage(input, 0, 0); return target;
    }
    function matrix(layer, inverse = false) {
      const state = metadata(layer), radians = state.rotation * Math.PI / 180, scale = state.scale / 100;
      const a = Math.cos(radians) * scale, b = Math.sin(radians) * scale, c = -b, d = a;
      const e = width / 2 + state.x - a * width / 2 - c * height / 2;
      const f = height / 2 + state.y - b * width / 2 - d * height / 2;
      if (!inverse) return { a, b, c, d, e, f };
      const det = a * d - b * c;
      return { a: d / det, b: -b / det, c: -c / det, d: a / det, e: (c * f - d * e) / det, f: (b * e - a * f) / det };
    }
    function applyTransform(ctx, layer, inverse = false) {
      const value = matrix(layer, inverse);
      ctx.transform(value.a, value.b, value.c, value.d, value.e, value.f);
      return value;
    }
    function point(layer, x, y, inverse = false) {
      const value = matrix(layer, inverse);
      return { x: value.a * x + value.c * y + value.e, y: value.b * x + value.d * y + value.f };
    }
    function bounds(layer) {
      const points = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => point(layer, x, y));
      const xs = points.map(value => value.x), ys = points.map(value => value.y);
      const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
      return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, points };
    }
    function add(name, image = null, settings = {}) {
      capacity(layers.length + 1);
      const bitmap = allocate();
      if (image) {
        const imageWidth = image.naturalWidth || image.videoWidth || image.width;
        const imageHeight = image.naturalHeight || image.videoHeight || image.height;
        if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) throw new Error('导入的图像尺寸无效');
        const ratio = settings.fit === false ? 1 : Math.min(1, width / imageWidth, height / imageHeight);
        const drawnWidth = imageWidth * ratio, drawnHeight = imageHeight * ratio;
        context(bitmap).drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
      }
      const layer = metadata({ id: identifier(), name: nameOf(name, `图层 ${layers.length + 1}`) });
      layer.canvas = bitmap;
      // New artwork is placed immediately above the selected layer.
      const activeIndex = layers.findIndex(item => item.id === activeId);
      layers.splice(activeIndex < 0 ? layers.length : activeIndex + 1, 0, layer);
      activeId = layer.id;
      return layer;
    }
    function duplicate(id = activeId) {
      const original = find(id); capacity(layers.length + 1);
      const layer = { ...metadata(original, { id: identifier(), name: nameOf(`${original.name} 副本`) }), canvas: cloneCanvas(original.canvas) };
      layers.splice(layers.indexOf(original) + 1, 0, layer); activeId = layer.id;
      return layer;
    }
    function remove(id = activeId) {
      const layer = find(id);
      if (layers.length <= 1) throw new Error('至少保留一个图层');
      const index = layers.indexOf(layer); layers.splice(index, 1);
      if (activeId === id) activeId = layers[Math.min(index, layers.length - 1)].id;
      return layer;
    }
    function move(id = activeId, delta = 0) {
      const layer = find(id), index = layers.indexOf(layer);
      const destination = clamp(index + Math.trunc(finite(delta, 0)), 0, layers.length - 1);
      if (index === destination) return false;
      layers.splice(index, 1); layers.splice(destination, 0, layer);
      return true;
    }
    function composite(target = allocate()) {
      if (layers.some(layer => layer.canvas === target)) throw new Error('合成目标不能是原始图层画布');
      if (target.width !== width) target.width = width;
      if (target.height !== height) target.height = height;
      const ctx = context(target);
      ctx.save();
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, width, height);
        for (const layer of layers) {
          const state = metadata(layer);
          if (!state.visible || state.opacity === 0) continue;
          ctx.save();
          ctx.globalAlpha = state.opacity / 100; ctx.globalCompositeOperation = state.blend;
          applyTransform(ctx, state); ctx.drawImage(layer.canvas, 0, 0);
          ctx.restore();
        }
      } finally { ctx.restore(); }
      return target;
    }
    function snapshot() {
      return { width, height, activeId, layers: layers.map(layer => ({ ...metadata(layer), canvas: cloneCanvas(layer.canvas) })) };
    }
    function restore(saved) {
      if (!saved || saved.width !== width || saved.height !== height || !Array.isArray(saved.layers) || !saved.layers.length) throw new Error('图层历史记录无效');
      capacity(saved.layers.length);
      const seen = new Set();
      const replacement = saved.layers.map(layer => {
        if (!layer || typeof layer.id !== 'string' || !layer.id || seen.has(layer.id) || layer.canvas?.width !== width || layer.canvas?.height !== height) throw new Error('图层历史记录损坏');
        seen.add(layer.id);
        return { ...metadata(layer), canvas: cloneCanvas(layer.canvas) };
      });
      if (!seen.has(saved.activeId)) throw new Error('图层历史记录的活动图层不存在');
      layers = replacement; activeId = saved.activeId;
      return find();
    }
    function flatten(name = '合并图层') {
      const bitmap = composite();
      const layer = { ...metadata({ id: identifier(), name: nameOf(name) }), canvas: bitmap };
      layers = [layer]; activeId = layer.id;
      return layer;
    }
    function remap(newWidth, newHeight, transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) {
      if (!Number.isSafeInteger(newWidth) || !Number.isSafeInteger(newHeight) || newWidth < 1 || newHeight < 1 ||
          newWidth * newHeight > MAX_DOCUMENT_PIXELS || newWidth * newHeight * layers.length > MAX_PIXELS) {
        throw new Error('变换后的画布超过尺寸或图层总像素上限');
      }
      const values = ['a', 'b', 'c', 'd', 'e', 'f'].map(key => transform?.[key]);
      if (values.some(value => typeof value !== 'number' || !Number.isFinite(value)) || Math.abs(values[0] * values[3] - values[1] * values[2]) < 1e-12) {
        throw new Error('画布变换矩阵无效');
      }
      // Allocate a separate document; the original layers remain intact for undo.
      const result = create(newWidth, newHeight, null, '背景', { canvasFactory: factory });
      const remapped = layers.map((layer, index) => {
        const bitmap = index === 0 ? result.layers[0].canvas : factory(newWidth, newHeight);
        if (!bitmap || typeof bitmap.getContext !== 'function') throw new Error('无法创建变换图层');
        bitmap.width = newWidth; bitmap.height = newHeight;
        const ctx = context(bitmap); if (!ctx) throw new Error('无法创建图层绘图上下文');
        ctx.save();
        try { ctx.setTransform(...values); applyTransform(ctx, layer); ctx.drawImage(layer.canvas, 0, 0); }
        finally { ctx.restore(); }
        const state = metadata(layer, { x: 0, y: 0, scale: 100, rotation: 0 });
        delete state.text;
        return { ...state, canvas: bitmap };
      });
      result.layers.splice(0, result.layers.length, ...remapped);
      result.activeId = activeId;
      return result;
    }

    add(baseName, baseCanvas, { fit: false });
    return {
      width, height, get layers() { return layers; },
      get activeId() { return activeId; },
      set activeId(id) { activeId = find(id).id; },
      active: () => find(), add, duplicate, remove, move, composite, snapshot, restore, flatten, remap,
      matrix, applyTransform, point, bounds, estimateBytes: () => pixels * layers.length * 4
    };
  }

  return Object.freeze({ create, MAX_LAYERS, MAX_PIXELS, MAX_DOCUMENT_PIXELS, BLENDS });
});
