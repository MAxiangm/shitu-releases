'use strict';

const { writePsdBuffer } = require('ag-psd');

const MAX_PIXELS = 16_777_216;
const MAX_LAYER_PIXELS = 64 * 1024 * 1024;
const MAX_LAYERS = 12;
const MAX_PSD_BYTES = 512 * 1024 * 1024;
const MAX_LAYER_COORDINATE = 1_000_000;
const BLEND_MODES = Object.freeze({
  'source-over': 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  darken: 'darken', lighten: 'lighten', 'color-dodge': 'color dodge', 'color-burn': 'color burn',
  'hard-light': 'hard light', 'soft-light': 'soft light', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity'
});

function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 30000 || height > 30000 || width * height > MAX_PIXELS) {
    throw new Error('PSD 尺寸无效；最多支持 1677 万像素，单边不超过 30000 像素');
  }
  return { width, height };
}

function pixels(value, width, height, label) {
  if (!value || typeof value !== 'object' || value.width !== width || value.height !== height ||
      (!(value.data instanceof Uint8Array) && !(value.data instanceof Uint8ClampedArray)) ||
      value.data.byteLength !== width * height * 4) {
    throw new Error(`${label}的 RGBA 像素数据无效`);
  }
  return { width, height, data: value.data };
}

function layerLayout(layer) {
  const width = layer?.imageData?.width, height = layer?.imageData?.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 30000 || height > 30000 || width * height > MAX_LAYER_PIXELS) {
    throw new Error('PSD 图层尺寸无效；单边不超过 30000 像素，单层不超过约 6400 万像素');
  }
  const left = layer.left === undefined ? 0 : layer.left, top = layer.top === undefined ? 0 : layer.top;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(top) || Math.abs(left) > MAX_LAYER_COORDINATE || Math.abs(top) > MAX_LAYER_COORDINATE) {
    throw new Error('PSD 图层坐标无效或超出允许范围');
  }
  return { width, height, left, top };
}

function createPsdBuffer(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('PSD 导出参数无效');
  const { width, height } = dimensions(request.width, request.height);
  if (!Array.isArray(request.layers) || request.layers.length < 1 || request.layers.length > MAX_LAYERS) {
    throw new Error('PSD 最多支持 12 个图层，图层总像素不超过约 6400 万');
  }
  const layouts = request.layers.map(layerLayout);
  if (layouts.reduce((total, layer) => total + layer.width * layer.height, 0) > MAX_LAYER_PIXELS) {
    throw new Error('PSD 图层总像素不超过约 6400 万，请减小图层或合并后再导出');
  }
  const imageData = pixels(request.imageData, width, height, '合成图像');
  // The editor stores layers bottom-to-top; PSD children are ordered top-to-bottom.
  const children = request.layers.map((layer, index) => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer) || typeof layer.name !== 'string' ||
        layer.name.length > 160 || /\0/.test(layer.name) || typeof layer.visible !== 'boolean' ||
        typeof layer.locked !== 'boolean' || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 100 ||
        !Object.hasOwn(BLEND_MODES, layer.blend)) throw new Error('PSD 图层属性无效');
    const layout = layouts[index];
    return {
      name: layer.name || `图层 ${index + 1}`, left: layout.left, top: layout.top,
      hidden: !layer.visible, opacity: layer.opacity / 100, blendMode: BLEND_MODES[layer.blend],
      transparencyProtected: layer.locked,
      protected: { transparency: layer.locked, composite: layer.locked, position: layer.locked, all: layer.locked },
      imageData: pixels(layer.imageData, layout.width, layout.height, `图层 ${index + 1}`)
    };
  }).reverse();
  const bytes = writePsdBuffer({ width, height, bitsPerChannel: 8, imageData, children }, {
    noBackground: true, trimImageData: false, generateThumbnail: false
  });
  if (bytes.length > MAX_PSD_BYTES) throw new Error('PSD 文件超过 512 MB，请减小图像或合并部分图层');
  return { bytes, width, height, layerCount: children.length };
}

module.exports = { createPsdBuffer, BLEND_MODES, MAX_PIXELS, MAX_LAYER_PIXELS, MAX_LAYERS, MAX_PSD_BYTES, MAX_LAYER_COORDINATE };
