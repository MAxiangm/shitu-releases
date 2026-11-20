'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Maps = require('../src/texture-maps.js');

function image(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}
function at(image, x, y) { return [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]; }
function assertSeamless(output) {
  for (let x = 0; x < output.width; x++) assert.deepEqual(at(output, x, 0), at(output, x, output.height - 1));
  for (let y = 0; y < output.height; y++) assert.deepEqual(at(output, 0, y), at(output, output.width - 1, y));
}

test('texture maps load in the browser without Node and normalize supported options', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/texture-maps.js'), 'utf8'), context);
  assert.equal(typeof context.ShituTextureMaps.generate, 'function');
  assert.ok(Object.isFrozen(Maps));
  assert.deepEqual(Maps.normalizeOptions(), {
    type: 'displacement', brightness: 0, contrast: 1, gamma: 1, blur: 0, strength: 3,
    invert: false, flipY: false, seamless: false, seamWidth: 0.15
  });
  assert.equal(Maps.normalizeOptions({ strength: 100 }).strength, 20);
  assert.equal(Maps.normalizeOptions({ brightness: -10 }).brightness, -1);
  assert.equal(Maps.normalizeOptions({ seamWidth: 0 }).seamWidth, 0.02);
});

test('flat heights produce neutral normal maps with preserved transparency', () => {
  const source = image(9, 5, (x, y) => [94, 94, 94, x * 20 + y]);
  for (const seamless of [false, true]) {
    const normal = Maps.generate(source, { type: 'normal', seamless });
    for (let i = 0; i < normal.data.length; i += 4) assert.deepEqual([...normal.data.slice(i, i + 3)], [128, 128, 255]);
  }
  const normal = Maps.generate(source, { type: 'normal' });
  for (let i = 3; i < normal.data.length; i += 4) assert.equal(normal.data[i], source.data[i]);
});

test('height slope, strength, green-axis convention and inversion affect normals', () => {
  const source = image(9, 9, (x, y) => [x * 12 + y * 12, x * 12 + y * 12, x * 12 + y * 12, 255]);
  const low = at(Maps.generate(source, { type: 'normal', strength: 1 }), 4, 4);
  const high = at(Maps.generate(source, { type: 'normal', strength: 8 }), 4, 4);
  const flipped = at(Maps.generate(source, { type: 'normal', strength: 1, flipY: true }), 4, 4);
  const inverted = at(Maps.generate(source, { type: 'normal', strength: 1, invert: true }), 4, 4);
  assert.ok(low[0] < 128 && low[1] < 128);
  assert.ok(high[0] < low[0] && high[2] < low[2]);
  assert.equal(low[0], flipped[0]);
  assert.equal(low[1] + flipped[1], 255);
  assert.equal(low[0] + inverted[0], 255);
  assert.equal(low[1] + inverted[1], 255);
});

test('height, roughness, specular and tone adjustments produce meaningful channel values', () => {
  const source = image(3, 1, x => [[0, 0, 0, 255], [128, 128, 128, 140], [255, 255, 255, 0]][x]);
  const height = Maps.generate(source, { type: 'displacement' });
  const rough = Maps.generate(source, { type: 'roughness' });
  const specular = Maps.generate(source, { type: 'specular' });
  assert.deepEqual([...rough.data], [...height.data]);
  for (let x = 0; x < 3; x++) {
    assert.equal(at(height, x, 0)[0] + at(specular, x, 0)[0], 255);
    assert.equal(at(height, x, 0)[3], at(source, x, 0)[3]);
  }
  assert.ok(at(Maps.generate(source, { brightness: 0.2 }), 1, 0)[0] > 128);
  assert.ok(at(Maps.generate(source, { gamma: 2 }), 1, 0)[0] > 128);
  assert.deepEqual(at(Maps.generate(source, { type: 'color', brightness: -1 }), 1, 0), [0, 0, 0, 140]);
  assert.deepEqual(at(Maps.generate(source, { type: 'color', invert: true }), 0, 0), [255, 255, 255, 255]);
});

test('seam blending and every generated map have identical RGBA edges without mutating input', () => {
  const source = image(41, 28, (x, y) => [(x * 83 + y * 5) % 256, (x * 9 + y * 29) % 256, (x * 13 + y * 71) % 256, (x * 37 + y * 2) % 256]);
  const before = source.data.slice();
  const seamless = Maps.makeSeamless(source, 0.15);
  assertSeamless(seamless);
  assert.deepEqual(at(source, 20, 14), at(seamless, 20, 14), 'center is preserved outside seam bands');
  assert.notDeepEqual(at(source, 0, 10), at(seamless, 0, 10));
  for (const type of ['color', 'displacement', 'normal', 'roughness', 'specular']) for (const blur of [0, 3, 20]) {
    assertSeamless(Maps.generate(source, { type, seamless: true, blur, contrast: 2, brightness: 0.1, gamma: 1.5 }));
  }
  assert.deepEqual(source.data, before);
});

test('seam blending uses premultiplied alpha to avoid black transparent halos', () => {
  const source = image(4, 3, x => x === 0 ? [200, 100, 50, 255] : [0, 0, 0, 0]);
  const output = Maps.makeSeamless(source);
  assert.deepEqual(at(output, 0, 1), [200, 100, 50, 128]);
  assert.deepEqual(at(output, 3, 1), [200, 100, 50, 128]);
  const blurred = Maps.generate(source, { type: 'color', blur: 1 });
  assert.equal(at(blurred, 1, 1)[0], 200);
  assert.equal(at(blurred, 1, 1)[3], 0, 'blur does not expand the alpha footprint');
});

test('blur smooths noisy height values and dimensions of one or two pixels work', () => {
  const noisy = image(7, 7, (x, y) => [(x + y) % 2 * 255, (x + y) % 2 * 255, (x + y) % 2 * 255, 255]);
  const smooth = at(Maps.generate(noisy, { blur: 2 }), 3, 3)[0];
  assert.ok(smooth > 80 && smooth < 175);
  for (const [width, height] of [[1, 1], [1, 9], [9, 1], [2, 2]]) {
    const source = image(width, height, (x, y) => [x * 20, y * 20, 70, 200]);
    for (const type of ['color', 'displacement', 'normal', 'roughness', 'specular']) {
      const output = Maps.generate(source, { type, seamless: true, blur: 20 });
      assert.equal(output.data.length, width * height * 4);
      assertSeamless(output);
    }
  }
});

test('invalid image buffers and nonfinite or unsupported options fail before allocation', () => {
  for (const source of [null, {}, { width: 0, height: 1, data: new Uint8Array(0) },
    { width: 0.5, height: 1, data: new Uint8Array(4) }, { width: 4097, height: 4097 },
    { width: 1, height: 1, data: [0, 0, 0, 255] }, { width: 1, height: 1, data: new Float32Array(4) },
    { width: 1, height: 1, data: new Uint8Array(3) }]) assert.throws(() => Maps.generate(source), /图片/);
  for (const value of [NaN, Infinity, -Infinity, '2', null]) assert.throws(() => Maps.normalizeOptions({ blur: value }), /有效数字/);
  for (const type of ['height', '', null, {}, 'constructor']) assert.throws(() => Maps.normalizeOptions({ type }), /贴图类型/);
  for (const options of [null, false, []]) assert.throws(() => Maps.normalizeOptions(options), /参数/);
  assert.throws(() => Maps.makeSeamless(image(1, 1, () => [0, 0, 0, 255]), Infinity), /有效数字/);
});
