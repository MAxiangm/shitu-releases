'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const sharp = require('sharp');
const { IMAGE } = require('./media-formats.cjs');

const SIDE = 56;
const STRIDE = (SIDE + 1) * 3;
const GRID = 8;
const PIXELS = GRID * GRID;
const MAX_CACHE = 640;
const MAX_RESULTS = 60;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_PIXELS = 75_000_000;
const GRID_CELLS = PIXELS * 3;
const CROP_SCALES = [1, 0.93, 0.86, 0.79, 0.72, 0.65, 0.58];
const CROP_POSITIONS = [0, 0.25, 0.5, 0.75, 1];

function isSearchableImage(asset) {
  return Boolean(asset && !asset.trashedAt && (asset.mediaType === 'image' || IMAGE.has(asset.ext)));
}

function sourceInside(root, file) {
  const relative = path.relative(root, file);
  return Boolean(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

// Color integrals let each sampled region use box averages, including small crops.
function imageIntegral(rgb) {
  const integral = new Uint32Array(STRIDE * (SIDE + 1));
  for (let row = 0; row < SIDE; row++) {
    const sums = [0, 0, 0];
    for (let column = 0; column < SIDE; column++) {
      const read = (row * SIDE + column) * 3;
      const write = (row + 1) * STRIDE + (column + 1) * 3;
      for (let channel = 0; channel < 3; channel++) {
        sums[channel] += rgb[read + channel];
        integral[write + channel] = sums[channel] + integral[write - STRIDE + channel];
      }
    }
  }
  return integral;
}

function sampleRegion(image, x, y, width, height, output) {
  let index = 0;
  for (let row = 0; row < GRID; row++) {
    const top = Math.round(y + height * row / GRID);
    const bottom = Math.round(y + height * (row + 1) / GRID);
    for (let column = 0; column < GRID; column++) {
      const left = Math.round(x + width * column / GRID);
      const right = Math.round(x + width * (column + 1) / GRID);
      const area = (right - left) * (bottom - top);
      const a = top * STRIDE + left * 3;
      const b = top * STRIDE + right * 3;
      const c = bottom * STRIDE + left * 3;
      const d = bottom * STRIDE + right * 3;
      for (let channel = 0; channel < 3; channel++) {
        output[index++] = (image[d + channel] - image[b + channel] - image[c + channel] + image[a + channel]) / area;
      }
    }
  }
}

function luma(red, green, blue) { return red * 0.2126 + green * 0.7152 + blue * 0.0722; }

function regionScore(reference, candidate) {
  let sumA = 0, sumB = 0, squareA = 0, squareB = 0, product = 0, difference = 0;
  for (let i = 0; i < GRID_CELLS; i += 3) {
    const a = luma(reference[i], reference[i + 1], reference[i + 2]);
    const b = luma(candidate[i], candidate[i + 1], candidate[i + 2]);
    sumA += a; sumB += b; squareA += a * a; squareB += b * b; product += a * b;
    difference += Math.abs(reference[i] - candidate[i]) + Math.abs(reference[i + 1] - candidate[i + 1]) +
      Math.abs(reference[i + 2] - candidate[i + 2]);
  }
  const varianceA = squareA - sumA * sumA / PIXELS;
  const varianceB = squareB - sumB * sumB / PIXELS;
  const error = difference / GRID_CELLS;
  // Near-uniform pictures have no reliable edges; require close pixel colors.
  if (Math.min(varianceA, varianceB) < 2 * PIXELS) return Math.max(0, 1 - error / 12);
  const structure = Math.max(0, Math.min(1, (product - sumA * sumB / PIXELS) / Math.sqrt(varianceA * varianceB)));
  return 0.64 * structure + 0.36 * Math.max(0, 1 - error / 65);
}

function cropScore(reference, source) {
  const ratio = reference.aspect / source.aspect;
  if (ratio < 0.54 || ratio > 1.85) return 0;
  const shape = { width: Math.min(1, ratio) * SIDE, height: Math.min(1, 1 / ratio) * SIDE };
  const scratch = new Float32Array(GRID_CELLS);
  let best = { score: 0, scale: 1, x: 0, y: 0 };
  function tryRegion(scale, x, y) {
    const width = shape.width * scale, height = shape.height * scale;
    sampleRegion(source.integral, (SIDE - width) * x, (SIDE - height) * y, width, height, scratch);
    const score = regionScore(reference.full, scratch);
    if (score > best.score) best = { score, scale, x, y };
  }
  for (const scale of CROP_SCALES) {
    const xs = SIDE - shape.width * scale < 1 ? [0] : CROP_POSITIONS;
    const ys = SIDE - shape.height * scale < 1 ? [0] : CROP_POSITIONS;
    for (const x of xs) {
      for (const y of ys) tryRegion(scale, x, y);
    }
    if (best.score >= 0.98) break;
  }
  if (best.score >= 0.75 && best.score < 0.97) {
    const nearby = ({ scale, x, y }) => [
      [Math.max(0.55, scale - 0.035), scale, Math.min(1, scale + 0.035)],
      [Math.max(0, x - 0.125), x, Math.min(1, x + 0.125)],
      [Math.max(0, y - 0.125), y, Math.min(1, y + 0.125)]
    ];
    const [scales, xs, ys] = nearby(best);
    for (const scale of scales) for (const x of xs) for (const y of ys) tryRegion(scale, x, y);
  }
  return best.score;
}

async function describeImage(file) {
  const input = sharp(file, { limitInputPixels: MAX_INPUT_PIXELS });
  const metadata = await input.metadata();
  const width = metadata.autoOrient?.width || metadata.width;
  const height = metadata.autoOrient?.height || metadata.height;
  if (!width || !height) throw new Error('无法读取图像尺寸');
  const pixels = await input.rotate().resize(SIDE, SIDE, { fit: 'fill' }).flatten({ background: '#eeeeee' })
    .toColourspace('srgb').removeAlpha().raw().toBuffer();
  if (pixels.length !== SIDE * SIDE * 3) throw new Error('无法读取图片像素');
  const integral = imageIntegral(pixels);
  const full = new Float32Array(GRID_CELLS);
  sampleRegion(integral, 0, 0, SIDE, SIDE, full);
  return { aspect: width / height, full, integral };
}

function createSimilarImageService({ getLibrary, onProgress = () => {} }) {
  const cache = new Map();
  let active = null, tail = Promise.resolve();

  function assertCurrent(request) {
    if (request !== active || getLibrary() !== request.library) throw new DOMException('相似图片查找已取消', 'AbortError');
  }

  async function descriptor(request, asset, root) {
    const files = ['thumbnail', 'original'].map(kind => request.library.getAssetPath(asset.id, kind)).filter(Boolean);
    for (const file of files) {
      assertCurrent(request);
      try {
        const resolved = await fs.realpath(file);
        if (!sourceInside(root, resolved)) continue;
        const info = await fs.lstat(file);
        if (!info.isFile() || !info.size || info.size > MAX_SOURCE_BYTES) continue;
        const key = JSON.stringify([root, asset.hash, resolved, info.size, info.mtimeMs, info.ctimeMs]);
        const existing = cache.get(key);
        if (existing) {
          cache.delete(key);
          cache.set(key, existing);
          return existing;
        }
        const value = await describeImage(resolved);
        assertCurrent(request);
        cache.set(key, value);
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
        return value;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
    }
    return null;
  }

  async function scan(request, first, candidates) {
    const root = await fs.realpath(request.root);
    const reference = await descriptor(request, first, root);
    assertCurrent(request);
    if (!reference) throw new Error('无法读取对比图片，请确认素材文件可用');
    const matches = [];
    let current = 0, skipped = 0, lastUpdate = 0;
    const total = candidates.length;
    const notify = () => {
      lastUpdate = Date.now();
      onProgress({ root: request.root, token: request.token, current, total, skipped });
    };
    notify();
    for (const asset of candidates) {
      const image = await descriptor(request, asset, root);
      assertCurrent(request);
      if (!image) skipped++;
      else {
        const full = regionScore(reference.full, image.full);
        if (full >= 0.89) matches.push({ id: asset.id, score: full, kind: 'full' });
        else {
          const crop = Math.max(cropScore(reference, image), cropScore(image, reference));
          if (crop >= 0.91) matches.push({ id: asset.id, score: crop - 0.035, kind: 'crop' });
        }
      }
      current++;
      if (Date.now() - lastUpdate >= 150) notify();
      if (current % 8 === 0) await yieldTurn();
    }
    assertCurrent(request);
    // Assets may have moved to the recycle bin during a long local scan.
    const live = new Map(request.library.snapshot().assets.filter(isSearchableImage).map(asset => [asset.id, asset.hash]));
    if (!live.has(first.id) || live.get(first.id) !== first.hash) throw new Error('对比图片已变化，请重新查找');
    const sourceHashes = new Map(candidates.map(asset => [asset.id, asset.hash]));
    const sorted = matches.filter(match => live.has(match.id) && live.get(match.id) === sourceHashes.get(match.id))
      .sort((a, b) => b.score - a.score);
    return { matches: sorted.slice(0, MAX_RESULTS), matched: sorted.length, current, total, skipped };
  }

  function search(library, id, expectedRoot, token) {
    if (typeof token !== 'string' || !/^similar_[a-z0-9_]{1,72}$/.test(token)) throw new Error('相似图片查找标识无效');
    if (!library || library.root !== expectedRoot || getLibrary() !== library) throw new Error('素材库已切换，请重新选择图片');
    const assets = library.snapshot().assets.filter(isSearchableImage);
    const first = assets.find(asset => asset.id === id);
    if (!first) throw new Error('请选择素材库中的图片');
    const request = { library, root: expectedRoot, token };
    active = request;
    const result = tail.then(() => {
      assertCurrent(request);
      return scan(request, first, assets.filter(asset => asset.id !== id));
    }).finally(() => { if (active === request) active = null; });
    tail = result.catch(() => {});
    return result;
  }

  function cancel(root, token) {
    if (!active || active.root !== root || active.token !== token) return false;
    active = null;
    return true;
  }

  function invalidate() { active = null; }
  return { search, cancel, invalidate };
}

module.exports = { createSimilarImageService, isSearchableImage };
