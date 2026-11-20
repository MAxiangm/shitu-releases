(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituTextureMaps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PIXELS = 16777216;
  const TYPES = new Set(['color', 'displacement', 'normal', 'roughness', 'specular']);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const byte = value => Math.round(clamp(value, 0, 1) * 255);
  function number(value, fallback, low, high) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('贴图参数必须是有效数字');
    return clamp(value, low, high);
  }
  function normalizeOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('贴图参数无效');
    const type = options.type === undefined ? 'displacement' : options.type;
    if (!TYPES.has(type)) throw new Error('不支持的贴图类型');
    return {
      type,
      brightness: number(options.brightness, 0, -1, 1),
      contrast: number(options.contrast, 1, 0.1, 4),
      gamma: number(options.gamma, 1, 0.1, 4),
      blur: number(options.blur, 0, 0, 20),
      strength: number(options.strength, 3, 0.1, 20),
      invert: options.invert === true,
      flipY: options.flipY === true,
      seamless: options.seamless === true,
      seamWidth: number(options.seamWidth, 0.15, 0.02, 0.5)
    };
  }
  function validateImage(image) {
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 ||
        image.width * image.height > MAX_PIXELS) throw new Error('图片尺寸无效，最多支持 1677 万像素');
    // Accept ImageData and raw typed arrays in both the renderer and Node.
    if (!ArrayBuffer.isView(image.data) || !['[object Uint8Array]', '[object Uint8ClampedArray]'].includes(Object.prototype.toString.call(image.data)) || image.data.length !== image.width * image.height * 4) {
      throw new Error('图片必须为 RGBA 像素数据');
    }
    return image;
  }
  function weight(distance, band) {
    const t = clamp(distance / band, 0, 1);
    return (1 - t * t * (3 - 2 * t)) * 0.5;
  }
  function blendPixel(data, a, b, amount, out, target) {
    if (!amount || a === b) {
      for (let c = 0; c < 4; c++) out[target + c] = data[a + c];
      return;
    }
    const aa = data[a + 3] / 255 * (1 - amount), ab = data[b + 3] / 255 * amount;
    const alpha = aa + ab;
    for (let c = 0; c < 3; c++) out[target + c] = alpha ? Math.round((data[a + c] * aa + data[b + c] * ab) / alpha) : 0;
    out[target + 3] = byte(alpha);
  }
  function makeSeamless(image, seamWidth = 0.15) {
    validateImage(image);
    seamWidth = number(seamWidth, 0.15, 0.02, 0.5);
    const { width, height, data } = image;
    const horizontal = new Uint8ClampedArray(data.length), output = new Uint8ClampedArray(data.length);
    const bandX = Math.max(1, (width - 1) * seamWidth), bandY = Math.max(1, (height - 1) * seamWidth);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = (y * width + x) * 4, b = (y * width + width - 1 - x) * 4;
        blendPixel(data, a, b, weight(Math.min(x, width - 1 - x), bandX), horizontal, a);
      }
    }
    for (let y = 0; y < height; y++) {
      const amount = weight(Math.min(y, height - 1 - y), bandY);
      for (let x = 0; x < width; x++) {
        const a = (y * width + x) * 4, b = ((height - 1 - y) * width + x) * 4;
        blendPixel(horizontal, a, b, amount, output, a);
      }
    }
    return { width, height, data: output };
  }

  // Separable sliding box filter. Work is O(pixels), independent of radius.
  // Seamless images contain a duplicated endpoint, so wrap over size - 1.
  function blurScalar(source, width, height, radius, periodic) {
    if (!radius) return source;
    const temporary = new Float32Array(source.length), output = new Float32Array(source.length);
    const diameter = radius * 2 + 1;
    function position(value, size) {
      if (!periodic) return clamp(value, 0, size - 1);
      const length = Math.max(1, size - 1);
      return ((value % length) + length) % length;
    }
    for (let y = 0; y < height; y++) {
      const base = y * width;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += source[base + position(k, width)];
      for (let x = 0; x < width; x++) {
        temporary[base + x] = sum / diameter;
        sum += source[base + position(x + radius + 1, width)] - source[base + position(x - radius, width)];
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += temporary[position(k, height) * width + x];
      for (let y = 0; y < height; y++) {
        output[y * width + x] = sum / diameter;
        sum += temporary[position(y + radius + 1, height) * width + x] - temporary[position(y - radius, height) * width + x];
      }
    }
    return output;
  }
  function tone(value, options) {
    const adjusted = Math.pow(clamp((value - 0.5) * options.contrast + 0.5 + options.brightness, 0, 1), 1 / options.gamma);
    return options.invert ? 1 - adjusted : adjusted;
  }
  function generate(image, inputOptions = {}) {
    validateImage(image);
    const options = normalizeOptions(inputOptions);
    const source = options.seamless ? makeSeamless(image, options.seamWidth) : image;
    const { width, height, data } = source, size = width * height;
    const output = new Uint8ClampedArray(data.length), radius = Math.round(options.blur);
    if (options.type === 'color') {
      for (let c = 0; c < 3; c++) {
        let values = new Float32Array(size), alpha;
        if (radius) alpha = new Float32Array(size);
        for (let i = 0; i < size; i++) {
          const a = data[i * 4 + 3] / 255;
          values[i] = data[i * 4 + c] / 255 * (radius ? a : 1);
          if (radius) alpha[i] = a;
        }
        if (radius) {
          values = blurScalar(values, width, height, radius, options.seamless);
          alpha = blurScalar(alpha, width, height, radius, options.seamless);
        }
        for (let i = 0; i < size; i++) output[i * 4 + c] = byte(tone(radius ? (alpha[i] > 0 ? values[i] / alpha[i] : 0) : values[i], options));
      }
    } else {
      let heights = new Float32Array(size), alpha;
      if (radius) alpha = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        const p = i * 4, a = data[p + 3] / 255;
        heights[i] = (data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722) / 255 * (radius ? a : 1);
        if (radius) alpha[i] = a;
      }
      if (radius) {
        heights = blurScalar(heights, width, height, radius, options.seamless);
        alpha = blurScalar(alpha, width, height, radius, options.seamless);
      }
      for (let i = 0; i < size; i++) heights[i] = tone(radius ? (alpha[i] > 0 ? heights[i] / alpha[i] : 0) : heights[i], options);
      if (options.type === 'normal') {
        const sample = (x, y) => {
          if (options.seamless) {
            const w = Math.max(1, width - 1), h = Math.max(1, height - 1);
            x = ((x % w) + w) % w; y = ((y % h) + h) % h;
          } else { x = clamp(x, 0, width - 1); y = clamp(y, 0, height - 1); }
          return heights[y * width + x];
        };
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const dx = (sample(x + 1, y) - sample(x - 1, y)) * options.strength;
          const dy = (sample(x, y + 1) - sample(x, y - 1)) * options.strength * (options.flipY ? -1 : 1);
          const length = Math.hypot(dx, dy, 1), p = (y * width + x) * 4;
          output[p] = byte((-dx / length + 1) / 2);
          output[p + 1] = byte((-dy / length + 1) / 2);
          output[p + 2] = byte((1 / length + 1) / 2);
        }
      } else {
        for (let i = 0; i < size; i++) {
          const value = byte(options.type === 'specular' ? 1 - heights[i] : heights[i]);
          output[i * 4] = value; output[i * 4 + 1] = value; output[i * 4 + 2] = value;
        }
      }
    }
    for (let i = 0; i < size; i++) output[i * 4 + 3] = data[i * 4 + 3];
    // Guard against one-byte floating point rounding differences across wrapped
    // filter endpoints; save and preview always have identical opposing edges.
    if (options.seamless) {
      for (let y = 0; y < height; y++) for (let c = 0; c < 4; c++) output[(y * width + width - 1) * 4 + c] = output[y * width * 4 + c];
      for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) output[((height - 1) * width + x) * 4 + c] = output[x * 4 + c];
    }
    return { width, height, data: output };
  }
  return Object.freeze({ MAX_PIXELS, normalizeOptions, makeSeamless, generate });
});
