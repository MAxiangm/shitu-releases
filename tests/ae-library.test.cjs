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
const { PROJECT, SUPPORTED } = require('../src/media-formats.cjs');
const { projectBundleHash, validateProjectBundle, copyProjectBundle } = require('../src/project-bundle.cjs');

const fixturesRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(fixturesRoot, 'ae-library-'));
  t.after(async () => {
    const relative = path.relative(fixturesRoot, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  return base;
}
async function sourceProject(base, extension = 'aep') {
  const directory = path.join(base, 'AE 来源工程');
  await fs.mkdir(path.join(directory, '素材'), { recursive: true });
  const source = path.join(directory, `分镜.${extension}`);
  const footage = ['视频.mov', '代理.mp4', '帧0001.png', '帧0002.png'].map(name => path.join(directory, '素材', name));
  for (const filename of footage) await fs.writeFile(filename, 'fixture footage ' + path.basename(filename));
  await fs.writeFile(source, JSON.stringify({ fixtureProject: true, footage }));
  return { directory, source, footage };
}
// This is a collection-contract fixture, not an After Effects parser. Real AE
// collection and moved-project validation are exercised by the AE engine smoke.
function collector(base, { changeSavedBytes = false, missing = [], onPrepared } = {}) {
  let sequence = 0, cleanups = 0;
  const prepare = async source => {
    const stage = await fs.mkdtemp(path.join(base, 'collected-'));
    const sourceInfo = JSON.parse(await fs.readFile(source, 'utf8'));
    const entry = path.basename(source);
    const sourceFiles = [source, ...sourceInfo.footage];
    const files = [];
    await fs.mkdir(path.join(stage, 'Footage'));
    for (const filename of sourceInfo.footage) {
      const relative = 'Footage/' + path.basename(filename);
      await fs.copyFile(filename, path.join(stage, relative));
      const bytes = await fs.readFile(filename);
      files.push({ path: relative, size: bytes.length, hash: digest(bytes) });
    }
    const collected = Buffer.from(JSON.stringify({ fixtureProject: true, footage: files.map(file => './' + file.path),
      ...(changeSavedBytes ? { saveSerial: ++sequence } : {}) }));
    await fs.writeFile(path.join(stage, entry), collected);
    files.push({ path: entry, size: collected.length, hash: digest(collected) });
    const sourceIdentity = digest(Buffer.concat([await fs.readFile(source), ...await Promise.all(sourceInfo.footage.map(file => fs.readFile(file)))]));
    const manifest = { version: 1, entry, files, missing, warnings: missing.length ? ['工程存在缺失素材'] : [],
      sourceIdentity, hash: projectBundleHash(files, entry), size: files.reduce((sum, file) => sum + file.size, 0), collectedWithVersion: 'fixture' };
    const prepared = { directory: stage, manifest, sourceFiles, cleanup: async () => {
      assert.equal(path.dirname(stage), base); cleanups++; await fs.rm(stage, { recursive: true, force: true });
    } };
    onPrepared?.(prepared);
    return prepared;
  };
  prepare.cleanupCount = () => cleanups;
  return prepare;
}
async function library(base, options = {}) {
  const instance = new Library({ root: path.join(base, 'library'), ...options });
  await instance.init(); return instance;
}

test('AE formats are project assets and require a real collector instead of silently importing a lone AEP', async t => {
  const base = await fixture(t), source = await sourceProject(base);
  for (const ext of ['aep', 'aepx']) { assert.ok(PROJECT.has(ext)); assert.ok(SUPPORTED.has(ext)); }
  const instance = await library(base);
  const result = await instance.importPaths([source.source]);
  assert.equal(result.imported, 0); assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /After Effects|AE/);
  assert.deepEqual(await fs.readdir(path.join(instance.root, 'originals')), []);
});

test('a dropped AE project folder becomes one independent relinked package and exports or drags as a folder', async t => {
  const base = await fixture(t), source = await sourceProject(base);
  const original = await fs.readFile(source.source);
  const prepare = collector(base);
  const instance = await library(base, { prepareProjectBundle: prepare });
  const result = await instance.importPaths([source.directory]);
  assert.equal(result.imported, 1); assert.deepEqual(result.errors, []); assert.deepEqual(result.unsupported, []);
  const asset = instance.snapshot().assets[0];
  assert.equal(asset.mediaType, 'project'); assert.equal(asset.ext, 'aep');
  assert.equal(asset.projectBundle.files.length, 5);
  assert.equal(asset.hash, asset.projectBundle.hash);
  assert.equal(prepare.cleanupCount(), 1);
  assert.equal(instance.getProjectFilePath(asset.id, '../index.json'), null);
  assert.equal(instance.getProjectFilePath(asset.id, 'unlisted.png'), null);
  assert.deepEqual(await fs.readFile(source.source), original);
  assert.equal(path.dirname(source.directory), base);
  await fs.rm(source.directory, { recursive: true });
  const reopened = new Library({ root: instance.root }); await reopened.init();
  const managedEntry = JSON.parse(await fs.readFile(reopened.getAssetPath(asset.id), 'utf8'));
  assert.ok(managedEntry.footage.every(reference => reference.startsWith('./Footage/')));
  for (const relative of managedEntry.footage) assert.ok((await fs.stat(path.join(reopened.getProjectBundleDirectory(asset.id), relative))).isFile());
  const thumbnailPath = path.join(base, 'export-preview.jpg');
  await sharp({ create: { width: 12, height: 8, channels: 3, background: '#357f70' } }).jpeg().toFile(thumbnailPath);
  const exportOptions = { thumbnailPaths: new Map([[asset.id, thumbnailPath]]) };
  const exported = await reopened.exportAssets([asset.id], path.join(base, 'exports'), exportOptions);
  assert.equal(exported.exported, 1); assert.ok((await fs.stat(exported.files[0])).isDirectory());
  assert.deepEqual(await fs.readFile(path.join(exported.files[0], asset.projectBundle.entry)), await fs.readFile(reopened.getAssetPath(asset.id)));
  for (const relative of managedEntry.footage) assert.ok((await fs.stat(path.join(exported.files[0], relative))).isFile());
  assert.deepEqual(resolveAssetFiles(reopened, [asset.id], reopened.root).files, [reopened.getProjectBundleDirectory(asset.id)]);
  const again = await reopened.exportAssets([asset.id], path.join(base, 'exports'), exportOptions);
  assert.notEqual(again.files[0], exported.files[0]);
});

test('source identity deduplicates AE saves with varying serialized bytes but changed footage makes a new asset', async t => {
  const base = await fixture(t), source = await sourceProject(base, 'aepx');
  const prepare = collector(base, { changeSavedBytes: true });
  const instance = await library(base, { prepareProjectBundle: prepare });
  const first = await instance.importPaths([source.source, source.footage[2]]);
  assert.equal(first.imported, 2);
  const project = instance.snapshot().assets.find(asset => asset.mediaType === 'project');
  assert.equal(project.ext, 'aepx');
  const repeated = await instance.importPaths([source.source]);
  assert.equal(repeated.imported, 0); assert.equal(repeated.duplicates, 1);
  await fs.writeFile(source.footage[0], 'changed video content');
  const changed = await instance.importPaths([source.source]);
  assert.equal(changed.imported, 1);
  assert.equal(instance.snapshot().assets.filter(asset => asset.mediaType === 'project').length, 2);
  assert.equal(prepare.cleanupCount(), 3);
});

test('AE backup and verified migration preserve every package file before managed deletion', async t => {
  const base = await fixture(t), source = await sourceProject(base);
  const prepare = collector(base);
  const instance = await library(base, { prepareProjectBundle: prepare });
  const { assetIds: [id] } = await instance.importPaths([source.source]);
  const backup = await instance.backupTo(path.join(base, 'backups'));
  const restored = new Library({ root: backup.path });
  assert.equal((await restored.init()).assets[0].mediaType, 'project');
  assert.deepEqual(await fs.readFile(restored.getAssetPath(id)), await fs.readFile(instance.getAssetPath(id)));
  const manager = new LibraryManager({ configPath: path.join(base, 'location.json'), overrideRoot: instance.root, prepareProjectBundle: prepare });
  await manager.init(); await fs.mkdir(path.join(base, 'migrated'));
  const moved = await manager.migrate(path.join(base, 'migrated'));
  const directory = moved.getProjectBundleDirectory(id);
  await moved.setTrash([id], true);
  assert.throws(() => resolveAssetFiles(moved, [id], moved.root), /回收站/);
  await moved.deletePermanently([id]);
  assert.equal(moved.snapshot().stats.total, 0);
  await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  assert.ok((await fs.stat(source.source)).isFile());
  assert.ok((await fs.stat(instance.getProjectBundleDirectory(id))).isDirectory());
});

test('failed and interrupted AE package deletion restores the entire directory', async t => {
  const base = await fixture(t), source = await sourceProject(base);
  const instance = await library(base, { prepareProjectBundle: collector(base) });
  const { assetIds: [id] } = await instance.importPaths([source.source]); await instance.setTrash([id], true);
  const persist = instance._persist; instance._persist = async () => { throw new Error('AE fixture index failure'); };
  await assert.rejects(instance.deletePermanently([id]), /AE fixture index failure/); instance._persist = persist;
  assert.ok((await fs.stat(instance.getProjectFilePath(id, 'Footage/代理.mp4'))).isFile());
  const asset = instance.snapshot().assets[0];
  const staged = path.join(instance.root, `.pending-delete-${crypto.randomUUID()}`); await fs.mkdir(staged);
  await fs.writeFile(path.join(staged, 'manifest.json'), JSON.stringify({ version: 1, assets: [{ id, ext: asset.ext, hasThumbnail: false, projectBundle: asset.projectBundle }] }));
  await fs.rename(instance.getProjectBundleDirectory(id), path.join(staged, `${id}.project`));
  const reopened = new Library({ root: instance.root }); await reopened.init();
  assert.ok((await fs.stat(reopened.getProjectFilePath(id, 'Footage/帧0002.png'))).isFile());
  await assert.rejects(fs.access(staged), { code: 'ENOENT' });
});

test('unknown package files and path tampering cannot be dragged or silently deleted', async t => {
  const base = await fixture(t), source = await sourceProject(base);
  const instance = await library(base, { prepareProjectBundle: collector(base) });
  const { assetIds: [id] } = await instance.importPaths([source.source]);
  const extra = path.join(instance.getProjectBundleDirectory(id), 'user-note.txt'); await fs.writeFile(extra, 'preserve');
  assert.throws(() => resolveAssetFiles(instance, [id], instance.root), /未知文件/);
  await instance.setTrash([id], true); await assert.rejects(instance.deletePermanently([id]), /未知文件/);
  assert.equal(await fs.readFile(extra, 'utf8'), 'preserve');
  const data = JSON.parse(await fs.readFile(instance.indexPath, 'utf8')); data.assets[0].projectBundle.entry = '../outside.aep';
  await fs.writeFile(instance.indexPath, JSON.stringify(data));
  await assert.rejects(new Library({ root: instance.root }).init(), /工程包/);
});

test('failed library persistence rolls back copied AE assets and always cleans collector staging', async t => {
  const base = await fixture(t), source = await sourceProject(base), stages = [];
  const prepare = collector(base, { onPrepared: prepared => stages.push(prepared.directory) });
  const instance = await library(base, { prepareProjectBundle: prepare });
  const persist = instance._persist; instance._persist = async () => { throw new Error('AE persist failed'); };
  await assert.rejects(instance.importPaths([source.source]), /AE persist failed/);
  assert.equal(instance.snapshot().stats.total, 0); assert.deepEqual(await fs.readdir(path.join(instance.root, 'originals')), []);
  for (const stage of stages) await assert.rejects(fs.access(stage), { code: 'ENOENT' });
  instance._persist = persist;
  assert.equal((await instance.importPaths([source.source])).imported, 1);
  assert.ok((await fs.stat(source.source)).isFile());
});

test('AE collection warnings survive import without claiming missing footage was collected', async t => {
  const base = await fixture(t), source = await sourceProject(base);
  const instance = await library(base, { prepareProjectBundle: collector(base, { missing: ['unavailable.psd'] }) });
  const result = await instance.importPaths([source.source]);
  assert.equal(result.imported, 1);
  assert.ok(result.warnings.some(item => item.message.includes('未收集')));
  assert.deepEqual(instance.snapshot().assets[0].projectBundle.missing, ['unavailable.psd']);
});

test('AE package copy validates each staged file and never follows a changed file or junction', async t => {
  const base = await fixture(t), source = await sourceProject(base);
  const prepare = collector(base), prepared = await prepare(source.source);
  t.after(prepared.cleanup);
  validateProjectBundle(prepared.manifest);
  await fs.writeFile(path.join(prepared.directory, 'Footage/代理.mp4'), 'tampered');
  await assert.rejects(copyProjectBundle(prepared, path.join(base, 'unsafe-copy')), /变化|路径/);
  await assert.rejects(fs.access(path.join(base, 'unsafe-copy')), { code: 'ENOENT' });
  const metadata = structuredClone(prepared.manifest); metadata.files[0].path = '../outside.png';
  assert.throws(() => validateProjectBundle(metadata), /路径|清单/);
});

test('AE package copy refuses linked source folders and linked output parents without writing outside them', async t => {
  const base = await fixture(t), source = await sourceProject(base);
  const prepared = await collector(base)(source.source); t.after(prepared.cleanup);
  await fs.rename(path.join(prepared.directory, 'Footage'), path.join(prepared.directory, 'actual-footage'));
  await fs.symlink(path.join(prepared.directory, 'actual-footage'), path.join(prepared.directory, 'Footage'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyProjectBundle(prepared, path.join(base, 'linked-source-output')), /符号链接|路径/);
  await assert.rejects(fs.access(path.join(base, 'linked-source-output')), { code: 'ENOENT' });
  const cleanPrepared = await collector(base)(source.source); t.after(cleanPrepared.cleanup);
  const actualExports = path.join(base, 'actual-exports'); await fs.mkdir(actualExports);
  await fs.symlink(actualExports, path.join(base, 'linked-exports'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyProjectBundle(cleanPrepared, path.join(base, 'linked-exports', 'project')), /符号链接/);
  assert.deepEqual(await fs.readdir(actualExports), []);
});
