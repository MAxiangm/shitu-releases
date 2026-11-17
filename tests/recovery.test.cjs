const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { LibraryManager } = require('../src/library-manager.cjs');
const { mediaResponse } = require('../src/media-response.cjs');

const fixturesRoot = path.resolve(__dirname, '..', '.recovery', 'tests');

async function fixture(t) {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixturesRoot, 'recovery-'));
  t.after(async () => {
    const relative = path.relative(fixturesRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function imageFixture(directory, filename = '测试图片.png') {
  const bytes = await sharp({
    create: { width: 32, height: 24, channels: 4, background: '#3278b8' }
  }).png().toBuffer();
  const filenamePath = path.join(directory, filename);
  await fs.writeFile(filenamePath, bytes);
  return { filename: filenamePath, bytes };
}

async function thumbnail(source, destination) {
  const metadata = await sharp(source).metadata();
  await sharp(source).resize({ width: 16 }).jpeg().toFile(destination);
  return { width: metadata.width, height: metadata.height };
}

test('real image import, duplicate detection, metadata, trash and persistence', async t => {
  const directory = await fixture(t);
  const source = await imageFixture(directory);
  const duplicate = path.join(directory, '相同内容.png');
  await fs.copyFile(source.filename, duplicate);
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: thumbnail });
  await library.init();
  const folder = (await library.createFolder('恢复验证')).folders[0];
  const report = await library.importPaths([source.filename, duplicate], { folderId: folder.id });
  assert.equal(report.imported, 1);
  assert.equal(report.duplicates, 1);
  assert.deepEqual(report.errors, []);
  const [id] = report.assetIds;
  let asset = library.snapshot().assets[0];
  assert.equal(asset.width, 32);
  assert.equal(asset.height, 24);
  assert.equal(asset.folderId, folder.id);
  assert.equal(asset.hash, crypto.createHash('sha256').update(source.bytes).digest('hex'));
  assert.deepEqual(await fs.readFile(library.getAssetPath(id)), source.bytes);
  assert.equal((await sharp(library.getAssetPath(id, 'thumbnail')).metadata()).width, 16);

  await library.updateAssets([id], { name: '保留原图', tags: ['设计', '参考', '设计'], rating: 4, notes: '恢复后的测试备注' });
  assert.deepEqual(library.snapshot().assets[0].tags, ['设计', '参考']);
  await assert.rejects(library.deletePermanently([id]), /回收站/);
  await library.setTrash([id], true);
  assert.equal(library.snapshot().stats.trashed, 1);
  await fs.access(library.getAssetPath(id));
  await library.setTrash([id], false);
  await library.flush();

  const reopened = new Library({ root: library.root });
  await reopened.init();
  asset = reopened.snapshot().assets[0];
  assert.equal(asset.name, '保留原图');
  assert.equal(asset.rating, 4);
  assert.equal(asset.notes, '恢复后的测试备注');
  assert.equal(asset.trashedAt, null);
  assert.deepEqual(asset.tags, ['设计', '参考']);
  assert.equal(reopened.snapshot().stats.active, 1);
  assert.deepEqual(await fs.readFile(source.filename), source.bytes);
  assert.deepEqual(await fs.readFile(duplicate), source.bytes);
});

test('exports preserve earlier files and backups reopen with original bytes', async t => {
  const directory = await fixture(t);
  const source = await imageFixture(directory);
  const library = new Library({ root: path.join(directory, 'library') });
  await library.init();
  const { assetIds: [id] } = await library.importPaths([source.filename]);
  const first = await library.exportAssets([id], path.join(directory, 'exports'));
  const second = await library.exportAssets([id], path.join(directory, 'exports'));
  assert.equal(first.exported, 1);
  assert.equal(second.exported, 1);
  assert.notEqual(first.files[0], second.files[0]);
  assert.deepEqual(await fs.readFile(first.files[0]), source.bytes);
  assert.deepEqual(await fs.readFile(second.files[0]), source.bytes);
  const backup = await library.backupTo(path.join(directory, 'backups'));
  const restored = new Library({ root: backup.path });
  await restored.init();
  assert.equal(restored.snapshot().assets[0].id, id);
  assert.deepEqual(await fs.readFile(restored.getAssetPath(id)), source.bytes);
});

test('permanent deletion removes managed copies only', async t => {
  const directory = await fixture(t);
  const source = await imageFixture(directory);
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: thumbnail });
  await library.init();
  const { assetIds: [id] } = await library.importPaths([source.filename]);
  const managedOriginal = library.getAssetPath(id);
  const managedThumbnail = library.getAssetPath(id, 'thumbnail');
  await library.setTrash([id], true);
  await library.deletePermanently([id]);
  assert.equal(library.snapshot().stats.total, 0);
  await assert.rejects(fs.access(managedOriginal), { code: 'ENOENT' });
  await assert.rejects(fs.access(managedThumbnail), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(source.filename), source.bytes);
  const reopened = new Library({ root: library.root });
  assert.equal((await reopened.init()).stats.total, 0);
});

test('LibraryManager creates, persists and reopens an isolated library', async t => {
  const directory = await fixture(t);
  const configPath = path.join(directory, 'settings', 'library-location.json');
  const parent = path.join(directory, 'libraries');
  await fs.mkdir(parent);
  const manager = new LibraryManager({ configPath });
  assert.equal((await manager.init()).configured, false);
  const library = await manager.create(parent, '验证素材库');
  await library.createFolder('持久化分类');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(config.libraryRoot, library.root);
  const reopened = new LibraryManager({ configPath });
  assert.equal((await reopened.init()).configured, true);
  assert.equal(reopened.current().root, library.root);
  assert.equal(reopened.current().snapshot().folders[0].name, '持久化分类');
  await assert.rejects(reopened.open(path.join(directory, 'not-a-library')), /找不到素材库索引/);
  assert.equal(reopened.current().root, library.root);
});

test('SHITU_LIBRARY-style override leaves a pre-existing config untouched', async t => {
  const directory = await fixture(t);
  const configPath = path.join(directory, 'library-location.json');
  const preserved = '{"keep":"existing settings must not be read or overwritten"}';
  await fs.writeFile(configPath, preserved);
  const manager = new LibraryManager({ configPath, overrideRoot: path.join(directory, 'override-library') });
  assert.equal((await manager.init()).configured, true);
  assert.equal(manager.current().root, path.join(directory, 'override-library'));
  assert.equal(await fs.readFile(configPath, 'utf8'), preserved);
});

test('media responses serve full content, byte ranges, suffix ranges and reject invalid ranges', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'sample.mp4');
  await fs.writeFile(filename, Buffer.from('0123456789'));
  const request = range => new Request('http://example.test/sample.mp4', { headers: range ? { range } : {} });
  const full = await mediaResponse(filename, request());
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(await full.text(), '0123456789');
  const partial = await mediaResponse(filename, request('bytes=2-5'));
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');
  const suffix = await mediaResponse(filename, request('bytes=-3'));
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), '789');
  const invalid = await mediaResponse(filename, request('bytes=20-30'));
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  assert.equal(await invalid.text(), '');
});
