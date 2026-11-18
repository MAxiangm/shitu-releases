'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { LibraryManager } = require('../src/library-manager.cjs');
const { resolveAssetFiles } = require('../src/asset-actions.cjs');
const { assetMenuTemplate } = require('../src/asset-menu.cjs');
const { FONT, SUPPORTED, MIME } = require('../src/media-formats.cjs');

const fixtureRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(fixtureRoot, 'font-library-'));
  t.after(async () => {
    const relative = path.relative(fixtureRoot, base);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  return base;
}
async function source(base, name = '字体样本.ttf') {
  const directory = path.join(base, 'sources');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, name);
  // Container decoding is exercised by font-engine tests; this fixture tests storage.
  const bytes = Buffer.from(`library font storage fixture ${name}`);
  await fs.writeFile(filename, bytes);
  return { filename, bytes };
}
async function thumbnail(_source, destination) {
  await sharp({ create: { width: 24, height: 24, channels: 3, background: '#151519' } }).jpeg().toFile(destination);
  return { width: 24, height: 24, font: { family: '测试 Font', style: 'Regular', fullName: '测试 Font Regular', postscriptName: 'TestFont-Regular', faceCount: 2 } };
}
async function library(base, options = {}) {
  const instance = new Library({ root: path.join(base, 'library'), ...options });
  await instance.init();
  return instance;
}

test('font formats are supported with font-specific MIME types', () => {
  assert.deepEqual([...FONT].sort(), ['otc', 'otf', 'ttc', 'ttf', 'woff', 'woff2']);
  for (const extension of FONT) {
    assert.ok(SUPPORTED.has(extension));
    assert.ok(MIME[extension].startsWith('font/'));
  }
});

test('all font containers import recursively with metadata and remain independent original files', async t => {
  const base = await fixture(t);
  const sources = await Promise.all([...FONT].map(extension => source(base, `family.${extension}`)));
  const thumbnailNames = [];
  const instance = await library(base, { createThumbnail: (filename, destination, options) => {
    thumbnailNames.push(options?.originalName);
    return thumbnail(filename, destination);
  } });
  const { folders: [folder] } = await instance.createFolder('字体');
  const report = await instance.importPaths([path.dirname(sources[0].filename)], { folderId: folder.id });
  assert.equal(report.imported, FONT.size);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unsupported, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(thumbnailNames, new Array(FONT.size).fill('family'));
  for (const asset of instance.snapshot().assets) {
    const original = sources.find(item => path.extname(item.filename).slice(1) === asset.ext);
    assert.equal(asset.mediaType, 'font');
    assert.equal(asset.folderId, folder.id);
    assert.equal(asset.font.family, '测试 Font');
    assert.equal(asset.font.faceCount, 2);
    assert.equal(asset.hash, digest(original.bytes));
    assert.equal(asset.filename, `originals/${asset.id}.${asset.ext}`);
    assert.ok(asset.thumbnail);
    assert.equal(asset.modelBundle, undefined);
    assert.equal(asset.projectBundle, undefined);
    assert.deepEqual(await fs.readFile(instance.getAssetPath(asset.id)), original.bytes);
    assert.deepEqual(await fs.readFile(original.filename), original.bytes);
  }
  const duplicate = await instance.importPaths(sources.map(item => item.filename));
  assert.equal(duplicate.imported, 0);
  assert.equal(duplicate.duplicates, FONT.size);
  const reopened = new Library({ root: instance.root });
  await reopened.init();
  assert.deepEqual(reopened.snapshot().assets, instance.snapshot().assets);
  const [asset] = reopened.snapshot().assets;
  assert.deepEqual(resolveAssetFiles(reopened, [asset.id], reopened.root).files, [reopened.getAssetPath(asset.id)]);
  const menu = assetMenuTemplate([asset], [], () => {});
  assert.equal(menu.find(item => item.id === 'copy-image').enabled, false);
  assert.equal(menu.find(item => item.id === 'image-plugins').enabled, false);
  assert.equal(menu.find(item => item.id === 'video-transcode').enabled, false);
});

test('font export, backup, migration and trash retain source bytes and metadata', async t => {
  const base = await fixture(t);
  const original = await source(base, 'Collection.TTC');
  const instance = await library(base, { createThumbnail: thumbnail });
  const { assetIds: [id] } = await instance.importPaths([original.filename]);
  const exported = await instance.exportAssets([id], path.join(base, 'exports'));
  assert.equal(exported.exported, 1);
  assert.equal(path.extname(exported.files[0]), '.ttc');
  assert.deepEqual(await fs.readFile(exported.files[0]), original.bytes);
  const backup = await instance.backupTo(path.join(base, 'backups'));
  const backedUp = new Library({ root: backup.path });
  assert.equal((await backedUp.init()).assets[0].font.faceCount, 2);
  assert.deepEqual(await fs.readFile(backedUp.getAssetPath(id)), original.bytes);
  const destination = path.join(base, 'destination');
  await fs.mkdir(destination);
  const manager = new LibraryManager({ configPath: path.join(base, 'location.json'), overrideRoot: instance.root });
  await manager.init();
  const moved = await manager.migrate(destination);
  assert.equal(moved.snapshot().assets[0].mediaType, 'font');
  assert.deepEqual(await fs.readFile(moved.getAssetPath(id)), original.bytes);
  await moved.setTrash([id], true);
  await assert.rejects(async () => resolveAssetFiles(moved, [id], moved.root), /回收站/);
  await moved.setTrash([id], false);
  assert.deepEqual(await fs.readFile(moved.getAssetPath(id)), original.bytes);
  await moved.setTrash([id], true);
  await moved.deletePermanently([id]);
  assert.equal(moved.snapshot().stats.total, 0);
  assert.deepEqual(await fs.readFile(original.filename), original.bytes);
  assert.deepEqual(await fs.readFile(instance.getAssetPath(id)), original.bytes);
});

test('invalid-font preview failure preserves the original and does not interrupt the next import', async t => {
  const base = await fixture(t);
  const invalid = await source(base, 'invalid.ttf');
  const valid = await source(base, 'valid.woff2');
  const instance = await library(base, { createThumbnail: async (filename, destination) => {
    const contents = await fs.readFile(filename, 'utf8');
    if (contents.includes('invalid.ttf')) {
      await fs.writeFile(destination, 'partial thumbnail');
      throw new Error('无效字体容器');
    }
    return thumbnail(filename, destination);
  } });
  const report = await instance.importPaths([invalid.filename, valid.filename]);
  assert.equal(report.imported, 2);
  assert.deepEqual(report.errors, []);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0].message, /字体已收录.*无效字体容器/);
  const [first, second] = instance.snapshot().assets;
  assert.equal(first.thumbnail, null);
  assert.equal(first.font, undefined);
  assert.ok(second.thumbnail);
  assert.equal(second.font.faceCount, 2);
  await assert.rejects(fs.access(path.join(instance.root, 'thumbnails', `${first.id}.jpg`)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(instance.getAssetPath(first.id)), invalid.bytes);
  assert.equal((await new Library({ root: instance.root }).init()).assets.length, 2);
});

test('font metadata storage filters service capabilities and malformed fields', async t => {
  const base = await fixture(t);
  const original = await source(base);
  const instance = await library(base, { createThumbnail: async (filename, destination) => {
    await thumbnail(filename, destination);
    return { font: { family: 'Safe Family', style: 'a'.repeat(257), fullName: 'bad\u0000name',
      postscriptName: { invalid: true }, faceCount: Infinity, url: 'shitu://font/private/token',
      path: 'C:/private/font.ttf', faces: new Array(300).fill('unexpected') } };
  } });
  await instance.importPaths([original.filename]);
  assert.deepEqual(instance.snapshot().assets[0].font, { family: 'Safe Family' });
  const stored = JSON.parse(await fs.readFile(instance.indexPath, 'utf8'));
  assert.deepEqual(stored.assets[0].font, { family: 'Safe Family' });
  stored.assets[0].font.path = '../outside.ttf';
  await fs.writeFile(instance.indexPath, JSON.stringify(stored));
  await assert.rejects(new Library({ root: instance.root }).init(), /字体信息包含无效属性/);
  assert.deepEqual(await fs.readFile(original.filename), original.bytes);
});

test('non-font assets cannot receive persisted font metadata and failed saves roll back managed fonts', async t => {
  const base = await fixture(t);
  const image = await source(base, 'image.png');
  const instance = await library(base, { createThumbnail: thumbnail });
  await instance.importPaths([image.filename]);
  assert.equal(instance.snapshot().assets[0].font, undefined);
  const font = await source(base);
  const persist = instance._persist;
  instance._persist = async () => { throw new Error('test index failure'); };
  await assert.rejects(instance.importPaths([font.filename]), /test index failure/);
  instance._persist = persist;
  assert.equal(instance.snapshot().assets.length, 1);
  assert.equal((await fs.readdir(path.join(instance.root, 'originals'))).length, 1);
  assert.equal((await fs.readdir(path.join(instance.root, 'thumbnails'))).length, 1);
  assert.deepEqual(await fs.readFile(font.filename), font.bytes);
  assert.equal((await instance.importPaths([font.filename])).imported, 1);
  const stored = JSON.parse(await fs.readFile(instance.indexPath, 'utf8'));
  stored.assets[0].font = { family: 'Invalid attachment' };
  await fs.writeFile(instance.indexPath, JSON.stringify(stored));
  await assert.rejects(new Library({ root: instance.root }).init(), /字体信息素材类型无效/);
});
