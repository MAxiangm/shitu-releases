(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituImageBasics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PIXELS = 16_777_216;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  function dimensions(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
      throw new Error('画布尺寸无效或超过 1677 万像素上限');
    }
  }
  function context(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new Error('图像画布不可用');
    dimensions(canvas.width, canvas.height);
    const result = canvas.getContext('2d', { willReadFrequently: true });
    if (!result) throw new Error('无法读取图像像素');
    return result;
  }
  function makeCanvas(width, height, source) {
    dimensions(width, height);
    let result;
    if (typeof document !== 'undefined') result = document.createElement('canvas');
    else if (typeof OffscreenCanvas !== 'undefined') result = new OffscreenCanvas(width, height);
    else {
      // Canvas implementations in Node expose a constructible Canvas class.
      try { result = new source.constructor(width, height); } catch {}
    }
    if (!result || typeof result.getContext !== 'function') throw new Error('当前环境不支持图像画布');
    result.width = width; result.height = height;
    context(result);
    return result;
  }
  function adjust(source, options = {}, mask = null) {
    if (!options || typeof options !== 'object') options = {};
    const input = context(source).getImageData(0, 0, source.width, source.height);
    let coverage = null;
    if (mask) {
      if (mask.width !== source.width || mask.height !== source.height) throw new Error('调整选区必须与图像尺寸一致');
      coverage = context(mask).getImageData(0, 0, mask.width, mask.height).data;
    }
    const output = makeCanvas(source.width, source.height, source), ctx = context(output);
    const pixels = ctx.createImageData(source.width, source.height); pixels.data.set(input.data);
    const brightness = clamp(finite(options.brightness, 0), -100, 100) * 2.55;
    const contrast = clamp(finite(options.contrast, 0), -100, 100) * 2.55;
    const factor = 259 * (contrast + 255) / (255 * (259 - contrast));
    const saturation = options.grayscale ? 0 : 1 + clamp(finite(options.saturation, 0), -100, 100) / 100;
    for (let at = 0; at < input.data.length; at += 4) {
      const amount = coverage ? coverage[at + 3] / 255 : 1;
      if (!amount || !input.data[at + 3]) continue;
      let r = clamp(factor * (input.data[at] + brightness - 127.5) + 127.5, 0, 255);
      let g = clamp(factor * (input.data[at + 1] + brightness - 127.5) + 127.5, 0, 255);
      let b = clamp(factor * (input.data[at + 2] + brightness - 127.5) + 127.5, 0, 255);
      const gray = r * 0.2126 + g * 0.7152 + b * 0.0722;
      r = clamp(gray + (r - gray) * saturation, 0, 255);
      g = clamp(gray + (g - gray) * saturation, 0, 255);
      b = clamp(gray + (b - gray) * saturation, 0, 255);
      if (options.invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
      pixels.data[at] = Math.round(input.data[at] + (r - input.data[at]) * amount);
      pixels.data[at + 1] = Math.round(input.data[at + 1] + (g - input.data[at + 1]) * amount);
      pixels.data[at + 2] = Math.round(input.data[at + 2] + (b - input.data[at + 2]) * amount);
      // Alpha is intentionally unchanged, including feathered selections.
    }
    ctx.putImageData(pixels, 0, 0);
    return output;
  }
  function transformCanvas(input, width, height, matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) {
    context(input);
    const values = ['a', 'b', 'c', 'd', 'e', 'f'].map(key => matrix?.[key]);
    if (values.some(value => typeof value !== 'number' || !Number.isFinite(value)) || Math.abs(values[0] * values[3] - values[1] * values[2]) < 1e-12) {
      throw new Error('图像变换矩阵无效');
    }
    const result = makeCanvas(width, height, input), ctx = context(result);
    ctx.setTransform(...values); ctx.drawImage(input, 0, 0);
    return result;
  }
  function normalizeText(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    const family = typeof value.fontFamily === 'string' ? value.fontFamily.replace(/[\u0000-\u001f"'\\;:{}]/g, '').trim().slice(0, 120) : '';
    return {
      text: String(value.text ?? '').slice(0, 20000), fontSize: clamp(finite(value.fontSize, 48), 1, 4096),
      fontFamily: family || 'Microsoft YaHei', bold: Boolean(value.bold),
      align: ['left', 'center', 'right'].includes(value.align) ? value.align : 'left',
      x: clamp(finite(value.x, 0), -1e6, 1e6), y: clamp(finite(value.y, 0), -1e6, 1e6),
      lineHeight: clamp(finite(value.lineHeight, 1.2), 0.5, 10),
      color: typeof value.color === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value.color) ? value.color : '#ffffff'
    };
  }
  function drawText(canvas, value = {}) {
    const ctx = context(canvas), spec = normalizeText(value);
    const generic = /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(spec.fontFamily);
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none'; ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${spec.bold ? '700' : '400'} ${spec.fontSize}px ${generic ? spec.fontFamily : `"${spec.fontFamily}"`}, sans-serif`;
      ctx.fillStyle = spec.color; ctx.textAlign = spec.align; ctx.textBaseline = 'top';
      const lines = spec.text.split(/\r\n|\r|\n/);
      for (let index = 0; index < lines.length; index++) ctx.fillText(lines[index].replace(/\t/g, '    '), spec.x, spec.y + index * spec.fontSize * spec.lineHeight);
    } finally { ctx.restore(); }
    return canvas;
  }
  return Object.freeze({ adjust, transformCanvas, drawText, normalizeText, MAX_PIXELS });
});
