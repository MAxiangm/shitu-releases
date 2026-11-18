'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAssets, normalizeSettings, foreground, fontUrl, createFaceController } = require('../src/font-compare.js');
const asset = (id, ext = 'ttf') => ({ id, ext, name: id, mediaType: 'font' });
const address = 'shitu://font/11111111-1111-1111-1111-111111111111/preview.ttf';
test('font comparison requires a bounded all-font selection and preserves visible order', () => {
  assert.deepEqual(normalizeAssets([asset('b'), asset('a'), asset('b')]).map(value => value.id), ['b', 'a']);
  assert.throws(() => normalizeAssets([asset('a')]), /至少选择/);
  assert.throws(() => normalizeAssets(Array.from({ length: 17 }, (_, index) => asset(String(index)))), /最多对比 16/);
  assert.throws(() => normalizeAssets([asset('a'), { id: 'b', ext: 'png', mediaType: 'image' }]), /仅支持/);
  assert.throws(() => normalizeAssets([asset('a'), { ...asset('b'), trashedAt: 'now' }]), /未删除/);
});
test('shared font comparison settings clamp numeric limits and derive readable contrast', () => {
  const settings = normalizeSettings({ text: '字'.repeat(2100), size: 999, lineHeight: 0, background: '#FFFFFF' });
  assert.equal(settings.text.length, 2000); assert.equal(settings.size, 160); assert.equal(settings.lineHeight, 1); assert.equal(settings.foreground, '#161616');
  assert.equal(normalizeSettings({ size: 'NaN', lineHeight: Infinity, background: 'url(unsafe)' }).background, '#eae8e2');
  assert.equal(foreground('#000000'), '#f4f4f4');
  assert.equal(foreground('#ffffff'), '#161616');
});
test('comparison accepts only the private font protocol and refuses altered URLs', () => {
  assert.equal(fontUrl(address), address);
  for (const value of ['https://example.com/font.ttf', address + '?other=1', address + '#bad', address.replace('font/', 'asset/'), address.replace('preview.ttf', '../index.json')]) assert.throws(() => fontUrl(value));
});
function controller(prepare, FontFaceCtor) {
  const faces = new Set();
  const instance = createFaceController({ prepare, fontSet: faces, FontFaceCtor: FontFaceCtor || class {
    constructor(family, source) { this.family = family; this.source = source; this.status = 'unloaded'; }
    async load() { this.status = 'loaded'; return this; }
  } });
  return { faces, instance };
}
test('newer comparison face wins reverse completion and closing releases loaded faces', async () => {
  let release;
  const old = new Promise(resolve => { release = resolve; });
  const { faces, instance } = controller(async (_id, _root, index) => index === 0 ? old : { url: address, faceIndex: index });
  const slow = instance.load('font', 'library', 0);
  const fast = await instance.load('font', 'library', 1);
  assert.equal(fast.prepared.faceIndex, 1); assert.equal(faces.size, 1);
  release({ url: address, faceIndex: 0 }); assert.equal(await slow, null); assert.equal(faces.size, 1);
  instance.dispose(); assert.equal(faces.size, 0);
});
test('a closed comparison never registers a late font and decode failure never pretends success', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { faces, instance } = controller(() => pending);
  const job = instance.load('font', 'library'); instance.dispose(); release({ url: address });
  assert.equal(await job, null); assert.equal(faces.size, 0);
  const failed = controller(async () => ({ url: address }), class { constructor() { this.status = 'error'; } async load() { throw new Error('bad font'); } });
  await assert.rejects(failed.instance.load('font', 'library'), /bad font/); assert.equal(failed.faces.size, 0);
});
