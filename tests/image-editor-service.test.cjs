'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { createImageEditorService } = require('../src/image-editor-service.cjs');
const { assetMenuTemplate } = require('../src/asset-menu.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests');
  await fs.mkdir(parent, { recursive: true });
  const base = await fs.mkdtemp(path.join(parent, 'image-editor-'));
  t.after(async () => {
    const relative = path.relative(parent, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  const library = new Library({ root: path.join(base, 'library') });
  await library.init();
  const original = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#6738ab' } }).png().toBuffer();
  const filename = path.join(base, 'source.png');
  await fs.writeFile(filename, original);
  const report = await library.importPaths([filename]);
  const assetId = report.assetIds[0];
  let current = library, chosen;
  const service = createImageEditorService({ getLibrary: () => current, tempRoot: path.join(base, 'work'),
    dialog: { showSaveDialog: async () => chosen } });
  const changed = await sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 30, g: 90, b: 170, alpha: 0.3 } } }).png().toBuffer();
  const request = { assetId, libraryRoot: library.root, bytes: new Uint8Array(changed), suffix: 'normal' };
  return { base, library, service, assetId, original, request, changeLibrary: value => { current = value; }, choose: value => { chosen = value; } };
}

test('editor reads full resolution and saves a PNG copy in the source folder without changing original', async t => {
  const { library, service, assetId, original, request, base } = await fixture(t);
  const folder = (await library.createFolder('贴图')).folders[0];
  await library.updateAssets([assetId], { folderId: folder.id });
  const read = await service.read(assetId, library.root);
  assert.equal(read.width, 32); assert.equal(read.height, 24);
  assert.ok(read.bytes instanceof Uint8Array);
  const result = await service.save(request);
  assert.ok(result.id && result.id !== assetId);
  assert.equal(result.duplicate, false);
  const saved = result.snapshot.assets.find(asset => asset.id === result.id);
  assert.equal(saved.folderId, folder.id);
  assert.match(saved.name, / · 法线$/);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId, 'original')), original);
  const info = await sharp(library.getAssetPath(result.id, 'original')).metadata();
  assert.equal(info.format, 'png'); assert.equal(info.hasAlpha, true);
  const duplicate = await service.save(request);
  assert.equal(duplicate.id, result.id); assert.equal(duplicate.duplicate, true);
  assert.deepEqual(await fs.readdir(path.join(base, 'work')), []);
  assert.equal(service.busy(), false);
});

test('editor rejects wrong library, trash, non-image, invalid PNG and changed dimensions', async t => {
  const { library, service, assetId, request, changeLibrary } = await fixture(t);
  await assert.rejects(service.read(assetId, 'other'), /素材库/);
  await assert.rejects(service.save({ ...request, bytes: new Uint8Array(48) }), /PNG/);
  const resized = await sharp(request.bytes).resize(16, 12).png().toBuffer();
  await assert.rejects(service.save({ ...request, bytes: resized }), /尺寸/);
  await library.setTrash([assetId], true);
  await assert.rejects(service.read(assetId, library.root), /静态图片/);
  await library.setTrash([assetId], false);
  changeLibrary(null);
  await assert.rejects(service.save(request), /素材库/);
  assert.equal(service.busy(), false);
});

test('export writes PNG outside library, supports cancel, and prevents overwriting managed files', async t => {
  const { base, library, service, request, assetId, original, choose } = await fixture(t);
  choose({ canceled: true });
  assert.deepEqual(await service.exportImage(request), { canceled: true });
  choose({ canceled: false, filePath: library.getAssetPath(assetId, 'original') });
  await assert.rejects(service.exportImage(request), /素材库以外/);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId, 'original')), original);
  choose({ canceled: false, filePath: path.join(base, 'export') });
  const exported = await service.exportImage(request);
  assert.equal(exported.path, path.join(base, 'export.png'));
  assert.equal((await sharp(exported.path).metadata()).width, 32);
  choose({ canceled: false, filePath: path.join(base, 'bad.jpg') });
  await assert.rejects(service.exportImage(request), /png/);
});

test('editor handles EXIF rotation, rejects animated and oversized sources', async t => {
  const { base, library, service } = await fixture(t);
  const file = path.join(base, 'rotated.jpg');
  await sharp({ create: { width: 30, height: 18, channels: 3, background: 'blue' } }).jpeg().withMetadata({ orientation: 6 }).toFile(file);
  const imported = await library.importPaths([file]);
  const read = await service.read(imported.assetIds[0], library.root);
  assert.equal(read.width, 18); assert.equal(read.height, 30);
  const animation = path.join(base, 'animation.gif');
  const frames = Buffer.alloc(8 * 16 * 3);
  frames.fill(255, 8 * 8 * 3);
  await sharp(frames, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).gif({ delay: [100, 100] }).toFile(animation);
  const gif = await library.importPaths([animation]);
  await assert.rejects(service.read(gif.assetIds[0], library.root), /动图|多页/);
  const large = path.join(base, 'large.png');
  await sharp({ create: { width: 4097, height: 4096, channels: 3, background: 'blue' } }).png().toFile(large);
  const huge = await library.importPaths([large]);
  await assert.rejects(service.read(huge.assetIds[0], library.root), /pixel|像素/);
});

test('image editor and texture menu entries only appear for a single live image', () => {
  const entries = assets => assetMenuTemplate(assets, [], () => {}).filter(item => ['image-edit', 'texture-maps'].includes(item.id));
  assert.equal(entries([{ id: 'a', mediaType: 'image' }]).length, 2);
  assert.equal(entries([{ id: 'a', mediaType: 'image', trashedAt: 'now' }]).length, 0);
  assert.equal(entries([{ id: 'a', mediaType: 'video' }]).length, 0);
  assert.equal(entries([{ id: 'a', mediaType: 'image' }, { id: 'b', mediaType: 'image' }]).length, 0);
});
