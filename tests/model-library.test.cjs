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
const { MODEL, MODEL_NATIVE, SUPPORTED } = require('../src/media-formats.cjs');

const fixturesRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
async function fixture(t) {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(fixturesRoot, 'model-library-'));
  t.after(async () => {
    const relative = path.relative(fixturesRoot, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  return base;
}
async function project(base) {
  const directory = path.join(base, '来源项目');
  await fs.mkdir(path.join(directory, 'textures'), { recursive: true });
  const filename = path.join(directory, '茶杯.obj');
  const texture = path.join(directory, 'textures', 'base color.png');
  await fs.writeFile(filename, 'mtllib 茶杯.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl cup\nf 1/1 2/2 3/3\n');
  await fs.writeFile(path.join(directory, '茶杯.mtl'), 'newmtl cup\nKd 1 1 1\nmap_Kd textures/base color.png\n');
  const textureBytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#28a4ba' } }).png().toBuffer();
  await fs.writeFile(texture, textureBytes);
  return { directory, filename, texture, textureBytes };
}
async function library(base, options = {}) {
  const instance = new Library({ root: path.join(base, 'library'), ...options });
  await instance.init();
  return instance;
}

test('model formats include interchange files and native Blender, Cinema 4D and 3ds Max projects', () => {
  for (const ext of ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'blend', 'c4d', 'max']) {
    assert.ok(MODEL.has(ext)); assert.ok(SUPPORTED.has(ext));
  }
  assert.deepEqual([...MODEL_NATIVE].sort(), ['blend', 'c4d', 'max']);
});

test('a dropped model folder stores one independent model package with referenced textures and can export or drag it', async t => {
  const base = await fixture(t);
  const source = await project(base);
  let thumbnailOptions;
  const instance = await library(base, { createThumbnail: async (_source, destination, options) => {
    thumbnailOptions = options;
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#223344' } }).jpeg().toFile(destination);
    return { width: 16, height: 16 };
  } });
  const report = await instance.importPaths([source.directory]);
  assert.equal(report.imported, 1);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unsupported, []);
  const asset = instance.snapshot().assets[0];
  assert.equal(asset.mediaType, 'model');
  assert.equal(asset.ext, 'obj');
  assert.equal(asset.modelBundle.files.length, 3);
  assert.equal(asset.hash, asset.modelBundle.hash);
  assert.equal(asset.size, asset.modelBundle.files.reduce((sum, file) => sum + file.size, 0));
  assert.equal(thumbnailOptions.modelDirectory, instance.getModelBundleDirectory(asset.id));
  assert.equal(thumbnailOptions.modelBundle.entry, asset.modelBundle.entry);
  assert.ok(asset.thumbnail);
  assert.equal(instance.getModelFilePath(asset.id, '../index.json'), null);
  assert.equal(instance.getModelFilePath(asset.id, 'unknown.png'), null);
  const sourceModelBytes = await fs.readFile(source.filename);
  const managed = instance.getAssetPath(asset.id);
  assert.deepEqual(await fs.readFile(managed), sourceModelBytes);
  // The source is an explicitly created fixture beneath this test's verified directory.
  assert.equal(path.dirname(source.directory), base);
  await fs.rm(source.directory, { recursive: true });
  const reopened = new Library({ root: instance.root });
  await reopened.init();
  assert.deepEqual(await fs.readFile(reopened.getModelFilePath(asset.id, 'textures/base color.png')), source.textureBytes);
  const exported = await reopened.exportAssets([asset.id], path.join(base, 'exports'));
  assert.equal(exported.exported, 1);
  assert.deepEqual(await fs.readFile(path.join(exported.files[0], '茶杯.obj')), sourceModelBytes);
  assert.deepEqual(await fs.readFile(path.join(exported.files[0], 'textures/base color.png')), source.textureBytes);
  const again = await reopened.exportAssets([asset.id], path.join(base, 'exports'));
  assert.notEqual(again.files[0], exported.files[0]);
  const drag = resolveAssetFiles(reopened, [asset.id], reopened.root);
  assert.deepEqual(drag.files, [reopened.getModelBundleDirectory(asset.id)]);
});

test('model duplicate detection includes textures and separately selected images remain independent', async t => {
  const base = await fixture(t);
  const source = await project(base);
  const instance = await library(base);
  const first = await instance.importPaths([source.directory, source.texture]);
  assert.equal(first.imported, 2);
  const originalModel = instance.snapshot().assets.find(asset => asset.mediaType === 'model');
  const duplicate = await instance.importPaths([source.directory]);
  assert.equal(duplicate.imported, 0);
  assert.equal(duplicate.duplicates, 1);
  const replacement = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ba2840' } }).png().toBuffer();
  await fs.writeFile(source.texture, replacement);
  const changed = await instance.importPaths([source.filename]);
  assert.equal(changed.imported, 1);
  const models = instance.snapshot().assets.filter(asset => asset.mediaType === 'model');
  assert.equal(models.length, 2);
  assert.notEqual(models[0].hash, models[1].hash);
  assert.deepEqual(await fs.readFile(instance.getModelFilePath(originalModel.id, 'textures/base color.png')), source.textureBytes);
});

test('native project plus its matching preview sidecar imports as one asset and keeps the original project', async t => {
  const base = await fixture(t);
  const source = await project(base);
  const native = path.join(source.directory, '茶杯.blend');
  const bytes = Buffer.from('BLENDER-v420 fixture preserved as native project');
  await fs.writeFile(native, bytes);
  const instance = await library(base);
  const imported = await instance.importPaths([source.directory]);
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.imported, 1);
  const [asset] = instance.snapshot().assets;
  assert.equal(asset.ext, 'blend');
  assert.equal(asset.modelBundle.previewEntry, '茶杯.obj');
  assert.deepEqual(await fs.readFile(instance.getAssetPath(asset.id)), bytes);
  assert.ok(asset.modelBundle.files.some(file => file.path === 'textures/base color.png'));
  assert.ok(imported.warnings.length);
});

test('model packages survive backup and verified migration before permanent deletion removes only managed copies', async t => {
  const base = await fixture(t);
  const source = await project(base);
  const instance = await library(base);
  const { assetIds: [id] } = await instance.importPaths([source.filename]);
  const backup = await instance.backupTo(path.join(base, 'backups'));
  const restored = new Library({ root: backup.path });
  assert.equal((await restored.init()).assets[0].mediaType, 'model');
  assert.deepEqual(await fs.readFile(restored.getModelFilePath(id, 'textures/base color.png')), source.textureBytes);
  const parent = path.join(base, 'new-location'); await fs.mkdir(parent);
  const manager = new LibraryManager({ configPath: path.join(base, 'location.json'), overrideRoot: instance.root });
  await manager.init();
  const moved = await manager.migrate(parent);
  assert.notEqual(moved.root, instance.root);
  assert.deepEqual(await fs.readFile(moved.getModelFilePath(id, 'textures/base color.png')), source.textureBytes);
  const managedDirectory = moved.getModelBundleDirectory(id);
  await moved.setTrash([id], true);
  assert.throws(() => resolveAssetFiles(moved, [id], moved.root), /回收站/);
  await moved.deletePermanently([id]);
  assert.equal(moved.snapshot().stats.total, 0);
  await assert.rejects(fs.access(managedDirectory), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(source.texture), source.textureBytes);
  assert.ok((await fs.stat(instance.getModelBundleDirectory(id))).isDirectory());
  assert.equal((await new Library({ root: moved.root }).init()).stats.total, 0);
});

test('failed deletion and interrupted deletion restore a complete model package', async t => {
  const base = await fixture(t);
  const source = await project(base);
  const instance = await library(base);
  const { assetIds: [id] } = await instance.importPaths([source.filename]);
  await instance.setTrash([id], true);
  const persist = instance._persist;
  instance._persist = async () => { throw new Error('fixture save failure'); };
  await assert.rejects(instance.deletePermanently([id]), /fixture save failure/);
  instance._persist = persist;
  assert.deepEqual(await fs.readFile(instance.getModelFilePath(id, 'textures/base color.png')), source.textureBytes);
  assert.equal(instance.snapshot().assets.length, 1);
  const staged = path.join(instance.root, `.pending-delete-${crypto.randomUUID()}`);
  await fs.mkdir(staged);
  const asset = instance.snapshot().assets[0];
  await fs.writeFile(path.join(staged, 'manifest.json'), JSON.stringify({ version: 1, assets: [{ id, ext: 'obj', hasThumbnail: false, modelBundle: asset.modelBundle }] }));
  await fs.rename(instance.getModelBundleDirectory(id), path.join(staged, `${id}.model`));
  const reopened = new Library({ root: instance.root });
  await reopened.init();
  assert.deepEqual(await fs.readFile(reopened.getModelFilePath(id, 'textures/base color.png')), source.textureBytes);
  await assert.rejects(fs.access(staged), { code: 'ENOENT' });
});

test('model package validation rejects traversals and preserves unknown files during delete or drag', async t => {
  const base = await fixture(t);
  const source = await project(base);
  const instance = await library(base);
  const { assetIds: [id] } = await instance.importPaths([source.filename]);
  const extra = path.join(instance.getModelBundleDirectory(id), 'user-extra.txt');
  await fs.writeFile(extra, 'must not be deleted');
  assert.throws(() => resolveAssetFiles(instance, [id], instance.root), /未知文件/);
  await instance.setTrash([id], true);
  await assert.rejects(instance.deletePermanently([id]), /未知文件/);
  assert.equal(await fs.readFile(extra, 'utf8'), 'must not be deleted');
  assert.equal(instance.snapshot().assets.length, 1);
  const tampered = JSON.parse(await fs.readFile(instance.indexPath, 'utf8'));
  tampered.assets[0].modelBundle.entry = '../outside.obj';
  await fs.writeFile(instance.indexPath, JSON.stringify(tampered));
  await assert.rejects(new Library({ root: instance.root }).init(), /模型包|模型/);
  assert.equal(await fs.readFile(extra, 'utf8'), 'must not be deleted');
});

test('failed index save rolls back imported model packages and leaves the source available for retry', async t => {
  const base = await fixture(t);
  const source = await project(base);
  const instance = await library(base);
  const persist = instance._persist;
  instance._persist = async () => { throw new Error('fixture index save failure'); };
  await assert.rejects(instance.importPaths([source.directory]), /fixture index save failure/);
  assert.equal(instance.snapshot().assets.length, 0);
  assert.deepEqual(await fs.readdir(path.join(instance.root, 'originals')), []);
  assert.deepEqual(await fs.readFile(source.texture), source.textureBytes);
  instance._persist = persist;
  const retry = await instance.importPaths([source.directory]);
  assert.equal(retry.imported, 1);
  assert.deepEqual(retry.errors, []);
});

test('a missing model dependency is visible in import warnings without discarding the original model', async t => {
  const base = await fixture(t);
  const source = await project(base);
  await fs.unlink(source.texture);
  const instance = await library(base);
  const imported = await instance.importPaths([source.filename]);
  assert.equal(imported.imported, 1);
  assert.ok(imported.warnings.some(item => item.message.includes('未收集')));
  assert.ok(instance.snapshot().assets[0].modelBundle.missing.length);
  assert.equal(await fs.readFile(instance.getAssetPath(imported.assetIds[0]), 'utf8'), await fs.readFile(source.filename, 'utf8'));
});
