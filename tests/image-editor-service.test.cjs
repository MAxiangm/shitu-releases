'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { createImageEditorService } = require('../src/image-editor-service.cjs');
const { assetMenuTemplate } = require('../src/asset-menu.cjs');
const { readPsd, initializeCanvas } = require('ag-psd');
initializeCanvas(() => { throw new Error('PSD tests only use raw image data'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests');
  await fs.mkdir(parent, { recursive: true });
  const base = await fs.mkdtemp(path.join(parent, 'image-editor-'));
  t.after(async () => {
    const relative = path.relative(parent, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const library = new Library({ root: path.join(base, 'library'), createThumbnail: async (input, output) => {
    const bytes = await fs.readFile(input), metadata = await sharp(bytes).metadata();
    await sharp(bytes).rotate().resize({ width: 96, height: 96, fit: 'inside' }).jpeg().toFile(output);
    return { width: metadata.width, height: metadata.height };
  } });
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

test('editor rejects wrong library, trash, non-image and invalid PNG', async t => {
  const { library, service, assetId, request, changeLibrary } = await fixture(t);
  await assert.rejects(service.read(assetId, 'other'), /素材库/);
  await assert.rejects(service.save({ ...request, bytes: new Uint8Array(48) }), /PNG/);
  await library.setTrash([assetId], true);
  await assert.rejects(service.read(assetId, library.root), /静态图片/);
  await library.setTrash([assetId], false);
  changeLibrary(null);
  await assert.rejects(service.save(request), /素材库/);
  assert.equal(service.busy(), false);
});

test('editor saves and exports resized PNG dimensions from image bytes without changing the source', async t => {
  const { library, service, request, original, assetId, choose, base } = await fixture(t);
  const resized = await sharp(request.bytes).resize(16, 12).png().toBuffer();
  const result = await service.save({ ...request, bytes: resized, width: 999, height: 999 });
  assert.equal(result.width, 16); assert.equal(result.height, 12);
  const saved = result.snapshot.assets.find(item => item.id === result.id);
  assert.equal(saved.width, 16); assert.equal(saved.height, 12);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId, 'original')), original);
  choose({ canceled: false, filePath: path.join(base, 'resized.png') });
  const exported = await service.exportImage({ ...request, bytes: resized });
  assert.equal(exported.width, 16); assert.equal(exported.height, 12);
  const info = await sharp(exported.path).metadata();
  assert.equal(info.width, 16); assert.equal(info.height, 12);
});

function psdRequest(request) {
  const imageData = { width: 2, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]) };
  return { assetId: request.assetId, libraryRoot: request.libraryRoot, width: 2, height: 1, imageData,
    layers: [
      { name: '背景', visible: true, locked: true, opacity: 100, blend: 'source-over', imageData },
      { name: '文字与图片', visible: false, locked: false, opacity: 50, blend: 'soft-light',
        imageData: { width: 2, height: 1, data: new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 0]) } }
    ] };
}

test('PSD export writes separate pixel layers, order, visibility, opacity and blend modes', async t => {
  const { base, library, service, request, assetId, original, choose } = await fixture(t);
  choose({ canceled: false, filePath: path.join(base, 'layered') });
  const input = psdRequest(request), result = await service.exportPsd(input);
  assert.equal(result.path, path.join(base, 'layered.psd'));
  assert.equal(result.width, 2); assert.equal(result.height, 1); assert.equal(result.layerCount, 2);
  const bytes = await fs.readFile(result.path);
  assert.equal(bytes.subarray(0, 4).toString(), '8BPS'); assert.equal(bytes.readUInt16BE(4), 1);
  const parsed = readPsd(bytes, { useImageData: true, skipThumbnail: true });
  assert.equal(parsed.width, 2); assert.equal(parsed.height, 1); assert.equal(parsed.children.length, 2);
  assert.deepEqual(parsed.children.map(layer => layer.name), ['文字与图片', '背景']);
  assert.equal(parsed.children[0].hidden, true); assert.equal(parsed.children[0].blendMode, 'soft light');
  assert.ok(Math.abs(parsed.children[0].opacity - .5) <= 1 / 255);
  assert.equal(parsed.children[1].protected.all, true);
  assert.deepEqual([...parsed.children[0].imageData.data], [...input.layers[1].imageData.data]);
  assert.deepEqual([...parsed.children[1].imageData.data], [...input.layers[0].imageData.data]);
  assert.deepEqual([...parsed.imageData.data], [...input.imageData.data]);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId, 'original')), original);
  assert.equal(service.busy(), false);
});

test('PSD export validates pixel limits and follows cancellation and managed-path protection', async t => {
  const { base, library, service, request, assetId, original, choose, changeLibrary } = await fixture(t);
  const input = psdRequest(request);
  choose({ canceled: true });
  assert.deepEqual(await service.exportPsd(input), { canceled: true });
  choose({ canceled: false, filePath: path.join(library.root, 'overwrite.psd') });
  await assert.rejects(service.exportPsd(input), /素材库以外/);
  choose({ canceled: false, filePath: path.join(base, 'bad.png') });
  await assert.rejects(service.exportPsd(input), /\.psd/);
  await assert.rejects(service.exportPsd({ ...input, width: 30001 }), /PSD 尺寸/);
  await assert.rejects(service.exportPsd({ ...input, layers: Array(13).fill(input.layers[0]) }), /12 个图层/);
  await assert.rejects(service.exportPsd({ ...input, imageData: { ...input.imageData, data: new Uint8Array(3) } }), /RGBA/);
  await assert.rejects(service.exportPsd({ ...input, layers: [{ ...input.layers[0], opacity: 101 }] }), /图层属性/);
  await assert.rejects(service.exportPsd({ ...input, layers: [{ ...input.layers[0], blend: 'unexpected' }] }), /图层属性/);
  await assert.rejects(service.exportPsd({ ...input, libraryRoot: 'other' }), /素材库/);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId, 'original')), original);
  changeLibrary(null);
  await assert.rejects(service.exportPsd(input), /素材库/);
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
