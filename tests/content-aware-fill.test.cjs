'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fill } = require('../src/content-aware-fill.js');

function fixture(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4), mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(fn(x, y), (y * width + x) * 4);
  return { image: { width, height, data }, mask };
}
function select(mask, width, left, top, right, bottom, value = 255) {
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) mask[y * width + x] = value;
}
test('content-aware fill samples surrounding texture and preserves all unselected pixels', async () => {
  const { image, mask } = fixture(48, 40, (x, y) => [x % 2 ? 200 : 40, y % 2 ? 160 : 30, 90, 255]);
  select(mask, image.width, 16, 12, 30, 28);
  for (let i = 0; i < mask.length; i++) if (mask[i]) image.data.set([255, 0, 255, 255], i * 4);
  const before = image.data.slice(), progress = [];
  const result = await fill(image, mask, { onProgress: value => progress.push(value) });
  let light = 0, dark = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) assert.deepEqual(result.data.slice(i * 4, i * 4 + 4), before.slice(i * 4, i * 4 + 4));
    else {
      assert.equal(result.data[i * 4 + 2], 90, 'donor pixels exclude the selected magenta object');
      if (result.data[i * 4] > 120) light++; else dark++;
    }
  }
  assert.ok(light > 0 && dark > 0, 'texture is synthesized rather than flat-color filling');
  assert.deepEqual(image.data, before);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, index) => !index || value >= progress[index - 1]));
});
test('soft selections blend their feather coverage and donor alpha is retained', async () => {
  const { image, mask } = fixture(16, 16, () => [40, 80, 120, 200]);
  image.data.set([200, 0, 0, 200], (8 * 16 + 8) * 4); mask[8 * 16 + 8] = 128;
  const result = await fill(image, mask);
  const pixel = [...result.data.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)];
  assert.deepEqual(pixel, [120, 40, 60, 200]);
});
test('large-image synthesis returns original size and changes only the selected region', async () => {
  const { image, mask } = fixture(800, 8, () => [70, 120, 190, 255]);
  select(mask, 800, 300, 2, 500, 6);
  for (let i = 0; i < mask.length; i++) if (mask[i]) image.data.set([255, 0, 0, 255], i * 4);
  const result = await fill(image, mask);
  assert.equal(result.width, 800); assert.equal(result.height, 8);
  assert.deepEqual(result.data.slice((3 * 800 + 400) * 4, (3 * 800 + 400) * 4 + 4), new Uint8ClampedArray([70, 120, 190, 255]));
  assert.deepEqual(result.data.slice(0, 800 * 4), image.data.slice(0, 800 * 4));
});
test('full selections, invalid data and pre-aborted requests report actionable errors', async () => {
  const { image, mask } = fixture(4, 4, () => [0, 0, 0, 255]); mask.fill(255);
  await assert.rejects(fill(image, mask), /选区外/);
  await assert.rejects(fill(image, new Uint8Array(2)), /选区/);
  await assert.rejects(fill({ width: 5000, height: 5000 }, mask), /1677/);
  await assert.rejects(fill(image, mask, null), /参数/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fill(image, mask, { signal: controller.signal }), { name: 'AbortError' });
});
test('asynchronous progress permits cancellation without changing the input', async () => {
  const { image, mask } = fixture(128, 128, (x, y) => [x, y, 80, 255]);
  select(mask, 128, 20, 20, 108, 108);
  const before = image.data.slice(), controller = new AbortController();
  await assert.rejects(fill(image, mask, { signal: controller.signal, onProgress: value => { if (value >= 0.08) controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(image.data, before);
});
test('empty selections return a separate unchanged image and narrow source strips are supported', async () => {
  const { image, mask } = fixture(1, 8, () => [40, 60, 80, 255]);
  const unchanged = await fill(image, mask);
  assert.notEqual(unchanged.data, image.data); assert.deepEqual(unchanged.data, image.data);
  mask.fill(255, 1); image.data.fill(0, 4);
  const result = await fill(image, mask);
  for (let y = 0; y < 8; y++) assert.deepEqual([...result.data.slice(y * 4, y * 4 + 4)], [40, 60, 80, 255]);
});
