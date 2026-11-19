'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');

const fixturesRoot = path.resolve(__dirname, '../.recovery/tests');
async function fixture(t, names = ['First.ttf', 'Second.ttf']) {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(fixturesRoot, 'font-refresh-'));
  t.after(async () => {
    const relative = path.relative(fixturesRoot, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  const sources = await Promise.all(names.map(async name => {
    const filename = path.join(base, name), bytes = Buffer.from(`font refresh source ${name}`);
    await fs.writeFile(filename, bytes); return { filename, bytes };
  }));
  const library = new Library({ root: path.join(base, 'library'), createThumbnail: async () => { throw new Error('Legacy preview failed'); } });
  await library.init();
  const imported = await library.importPaths(sources.map(item => item.filename));
  assert.equal(imported.imported, names.length);
  return { base, library, sources, ids: imported.assetIds };
}
async function thumbnail(_source, destination, options) {
  await sharp({ create: { width: 28, height: 20, channels: 3, background: '#246789' } }).jpeg().toFile(destination);
  return { width: 999, height: 999, font: { family: options.originalName, style: 'Regular', fullName: `${options.originalName} Regular`, faceCount: 1 } };
}
async function thumbnails(library) { return (await fs.readdir(path.join(library.root, 'thumbnails'))).sort(); }

test('missing font previews regenerate without reimporting or changing original bytes and metadata', async t => {
  const { library, ids, sources } = await fixture(t);
  await library.updateAssets([ids[0]], { rating: 5, tags: ['saved-font'] });
  library.createThumbnail = thumbnail;
  const result = await library.refreshFontPreviews(ids, { expectedRoot: library.root });
  assert.equal(result.updated, 2); assert.deepEqual(result.errors, []);
  for (const asset of result.snapshot.assets) {
    assert.equal(asset.width, 28); assert.equal(asset.height, 20);
    assert.equal(asset.font.family, asset.name); assert.equal(asset.thumbnail, `thumbnails/${asset.id}.jpg`);
    const source = sources.find(item => path.parse(item.filename).name === asset.name);
    assert.deepEqual(await fs.readFile(library.getAssetPath(asset.id)), source.bytes);
  }
  assert.equal(result.snapshot.assets.find(asset => asset.id === ids[0]).rating, 5);
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.deepEqual(reopened.snapshot().assets, result.snapshot.assets);
});

test('valid previews and trashed fonts are skipped while corrupt preview images are regenerated', async t => {
  const { library, ids } = await fixture(t);
  let generated = 0;
  library.createThumbnail = (...args) => { generated++; return thumbnail(...args); };
  await library.refreshFontPreviews(ids);
  assert.equal(generated, 2);
  assert.equal((await library.refreshFontPreviews(ids)).updated, 0); assert.equal(generated, 2);
  await fs.writeFile(library.getAssetPath(ids[0], 'thumbnail'), 'corrupt JPEG');
  await library.setTrash([ids[1]], true);
  const refreshed = await library.refreshFontPreviews(ids);
  assert.equal(refreshed.updated, 1); assert.equal(generated, 3);
  assert.deepEqual(refreshed.errors, []);
});

test('individual generation failures are reported without blocking another font or leaving temporary files', async t => {
  const { library, ids } = await fixture(t);
  library.createThumbnail = async (source, destination, options) => {
    if (options.originalName === 'Second') { await fs.writeFile(destination, 'partial'); throw new Error('Still unsupported'); }
    return thumbnail(source, destination, options);
  };
  const result = await library.refreshFontPreviews(ids);
  assert.equal(result.updated, 1); assert.deepEqual(result.errors, [{ id: ids[1], message: 'Still unsupported' }]);
  assert.deepEqual(await thumbnails(library), [`${ids[0]}.jpg`]);
  assert.equal(library.snapshot().assets.find(a => a.id === ids[1]).thumbnail, null);
});

test('aborting a refresh rolls back earlier thumbnails and preserves the index', async t => {
  const { library, ids } = await fixture(t), before = library.snapshot().assets;
  const controller = new AbortController(); let count = 0;
  library.createThumbnail = async (...args) => { const result = await thumbnail(...args); if (++count === 2) controller.abort(); return result; };
  await assert.rejects(library.refreshFontPreviews(ids, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(library.snapshot().assets, before); assert.deepEqual(await thumbnails(library), []);
});

test('failed persistence restores old thumbnail bytes and removes newly created files', async t => {
  const { library, ids } = await fixture(t), before = library.snapshot().assets;
  const destination = path.join(library.root, 'thumbnails', `${ids[0]}.jpg`), old = Buffer.from('old thumbnail retained');
  await fs.writeFile(destination, old);
  library.createThumbnail = thumbnail;
  library._persist = async () => { throw new Error('Save blocked'); };
  await assert.rejects(library.refreshFontPreviews(ids), /Save blocked/);
  assert.deepEqual(library.snapshot().assets, before); assert.deepEqual(await fs.readFile(destination), old);
  assert.deepEqual(await thumbnails(library), [`${ids[0]}.jpg`]);
});

test('changed originals and malformed generated JPEGs never publish a preview', async t => {
  const { library, ids, sources } = await fixture(t, ['Changed.ttf', 'BadJpeg.ttf']);
  await fs.appendFile(library.getAssetPath(ids[0]), 'changed');
  library.createThumbnail = async (_source, destination) => { await fs.writeFile(destination, Buffer.from([0xff, 0xd8, 0x00, 0x00])); return { font: { family: 'Fake' } }; };
  const result = await library.refreshFontPreviews(ids);
  assert.equal(result.updated, 0); assert.equal(result.errors.length, 2); assert.deepEqual(await thumbnails(library), []);
  for (const original of sources) assert.deepEqual(await fs.readFile(original.filename), original.bytes);
});

test('linked original directories are rejected before thumbnail generation', async t => {
  const { library, ids, sources, base } = await fixture(t, ['Linked.ttf']);
  const original = library.getAssetPath(ids[0]), originals = path.dirname(original), linked = path.join(base, 'linked-originals');
  await fs.mkdir(linked);
  await fs.writeFile(path.join(linked, path.basename(original)), sources[0].bytes);
  await fs.unlink(original); await fs.rmdir(originals);
  await fs.symlink(linked, originals, process.platform === 'win32' ? 'junction' : 'dir');
  let generated = false; library.createThumbnail = async () => { generated = true; };
  const result = await library.refreshFontPreviews(ids);
  assert.equal(result.updated, 0); assert.equal(result.errors.length, 1); assert.equal(generated, false);
  assert.match(result.errors[0].message, /符号链接/);
});

test('refresh serializes with metadata edits and rejects stale roots and unbounded selections', async t => {
  const { library, ids } = await fixture(t, ['Single.ttf']);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  library.createThumbnail = async (...args) => { entered(); await gate; return thumbnail(...args); };
  const refresh = library.refreshFontPreviews(ids); await started;
  const edited = library.updateAssets(ids, { rating: 4 }); release();
  await refresh; await edited;
  assert.equal(library.snapshot().assets[0].rating, 4); assert.ok(library.snapshot().assets[0].thumbnail);
  await assert.rejects(library.refreshFontPreviews(ids, { expectedRoot: 'other-library' }), /素材库已切换/);
  await assert.rejects(library.refreshFontPreviews(new Array(129).fill(ids[0])), /有效的字体/);
  await assert.rejects(library.refreshFontPreviews(['missing']), /素材不存在/);
});
