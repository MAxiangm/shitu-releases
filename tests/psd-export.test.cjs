'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readPsd, initializeCanvas } = require('ag-psd');
const { createPsdBuffer, BLEND_MODES, MAX_LAYER_COORDINATE } = require('../src/psd-export.cjs');

initializeCanvas(() => { throw new Error('Raw PSD test should not allocate a canvas'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));

test('PSD writer round-trips all supported editor blend names and Unicode layer metadata', () => {
  for (const [blend, expected] of Object.entries(BLEND_MODES)) {
    const imageData = { width: 1, height: 1, data: new Uint8ClampedArray([31, 97, 211, 143]) };
    const result = createPsdBuffer({ width: 1, height: 1, imageData,
      layers: [{ name: '图层 ✨', visible: true, locked: false, opacity: 75, blend, imageData }] });
    const parsed = readPsd(result.bytes, { useImageData: true, skipThumbnail: true });
    assert.equal(parsed.children[0].name, '图层 ✨');
    assert.equal(parsed.children[0].blendMode, expected);
    assert.ok(Math.abs(parsed.children[0].opacity - .75) <= 1 / 255);
    assert.deepEqual([...parsed.children[0].imageData.data], [...imageData.data]);
    // PSD's composite alpha is white-matted on disk, then unmatted by the reader.
    // Layer pixels stay exact; the composite can differ by one quantization step.
    assert.ok(parsed.imageData.data.every((value, i) => Math.abs(value - imageData.data[i]) <= (i % 4 === 3 ? 0 : 1)));
  }
});

test('PSD writer rejects oversized layer budgets before attempting pixel allocation', () => {
  const imageData = { width: 4096, height: 4096, data: new Uint8Array(0) };
  assert.throws(() => createPsdBuffer({ width: 4096, height: 4096, imageData, layers: Array(5).fill({ imageData }) }), /总像素/);
  assert.throws(() => createPsdBuffer({ width: 0, height: 1, imageData, layers: [] }), /尺寸/);
  assert.throws(() => createPsdBuffer({ width: 1, height: 1, imageData, layers: [] }), /图层/);
});

test('PSD preserves complete layer pixels outside the document and their negative or positive origins', () => {
  const imageData = { width: 2, height: 1, data: new Uint8ClampedArray([9, 8, 7, 255, 6, 5, 4, 255]) };
  const larger = { width: 4, height: 3, data: Uint8ClampedArray.from({ length: 4 * 3 * 4 }, (_, i) => i % 4 === 3 ? 255 : (i * 7) % 256) };
  const smaller = { width: 1, height: 2, data: new Uint8ClampedArray([201, 103, 49, 255, 33, 77, 129, 100]) };
  const base = { visible: true, locked: false, opacity: 100, blend: 'source-over' };
  const result = createPsdBuffer({ width: 2, height: 1, imageData, layers: [
    { ...base, name: '左上画布外', left: -3, top: -2, imageData: larger },
    { ...base, name: '右下画布外', left: 5, top: 8, imageData: smaller }
  ] });
  const parsed = readPsd(result.bytes, { useImageData: true, skipThumbnail: true });
  assert.equal(parsed.width, 2); assert.equal(parsed.height, 1);
  assert.deepEqual(parsed.children.map(layer => [layer.name, layer.left, layer.top, layer.right, layer.bottom]), [
    ['右下画布外', 5, 8, 6, 10], ['左上画布外', -3, -2, 1, 1]
  ]);
  assert.deepEqual([...parsed.children[0].imageData.data], [...smaller.data]);
  assert.deepEqual([...parsed.children[1].imageData.data], [...larger.data]);
  assert.deepEqual([...parsed.imageData.data], [...imageData.data]);
});

test('PSD rejects invalid offsets and oversized individual layer canvases', () => {
  const imageData = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) };
  const layer = { name: '层', visible: true, locked: false, opacity: 100, blend: 'source-over', imageData };
  const request = { width: 1, height: 1, imageData, layers: [layer] };
  for (const left of [NaN, Infinity, .5, MAX_LAYER_COORDINATE + 1, -MAX_LAYER_COORDINATE - 1]) {
    assert.throws(() => createPsdBuffer({ ...request, layers: [{ ...layer, left }] }), /坐标/);
  }
  assert.throws(() => createPsdBuffer({ ...request, layers: [{ ...layer, top: '0' }] }), /坐标/);
  for (const [width, height] of [[30001, 1], [8193, 8192], [0, 1]]) {
    assert.throws(() => createPsdBuffer({ ...request, layers: [{ ...layer, imageData: { ...imageData, width, height } }] }), /图层尺寸/);
  }
});
