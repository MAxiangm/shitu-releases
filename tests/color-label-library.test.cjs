'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { LibraryManager } = require('../src/library-manager.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'color-label-'));
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (source, destination) => {
    const info = await sharp(source).metadata(); await sharp(source).resize(18, 18).jpeg().toFile(destination); return info;
  } });
  await library.init();
  t.after(async () => {
    await library.flush();
    const relative = path.relative(parent, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, library };
}
async function folder(library, name, parentId = null) {
  const snapshot = await library.createFolder(name, parentId);
  return snapshot.folders.at(-1);
}
async function picture(directory, library, name, folderId = null, color = '#873e20') {
  const source = path.join(directory, `${name}.png`);
  await sharp({ create: { width: 24, height: 20, channels: 3, background: color } }).png().toFile(source);
  const report = await library.importPaths([source], { folderId }); assert.equal(report.imported, 1);
  const asset = library.snapshot().assets.find(item => item.id === report.assetIds[0]);
  return { ...asset, source, sourceBytes: await fs.readFile(source), thumbnailBytes: await fs.readFile(library.getAssetPath(asset.id, 'thumbnail')) };
}
async function unchanged(library, images) {
  for (const item of images) {
    const asset = library.snapshot().assets.find(asset => asset.id === item.id);
    assert.equal(asset.hash, crypto.createHash('sha256').update(item.sourceBytes).digest('hex'));
    assert.deepEqual(await fs.readFile(item.source), item.sourceBytes);
    assert.deepEqual(await fs.readFile(library.getAssetPath(item.id)), item.sourceBytes);
    assert.deepEqual(await fs.readFile(library.getAssetPath(item.id, 'thumbnail')), item.thumbnailBytes);
  }
}

test('legacy assets and folders show no label without rewriting their index or upgrading a flat library', async t => {
  const { directory, library } = await fixture(t);
  const root = await folder(library, '原有分类'); const image = await picture(directory, library, '旧图片', root.id);
  const before = await fs.readFile(library.indexPath, 'utf8');
  assert.equal(JSON.parse(before).version, 1);
  assert.equal('colorLabel' in JSON.parse(before).assets[0], false);
  const reopened = new Library({ root: library.root }); const snapshot = await reopened.init();
  assert.equal(snapshot.assets[0].colorLabel, null); assert.equal(snapshot.folders[0].colorLabel, null);
  assert.equal(await fs.readFile(library.indexPath, 'utf8'), before);
  await reopened.updateAssets([image.id], { colorLabel: 'red' });
  await reopened.setFolderColor(root.id, 'blue');
  const saved = JSON.parse(await fs.readFile(library.indexPath, 'utf8'));
  assert.equal(saved.version, 1, 'Adding an optional color does not change the index format');
  assert.equal(saved.assets[0].colorLabel, 'red'); assert.equal(saved.folders[0].colorLabel, 'blue');
  await unchanged(reopened, [image]);
});

test('single and bulk asset labels persist independently from folder labels through move, rename, trash and clear', async t => {
  const { directory, library } = await fixture(t);
  const parent = await folder(library, '项目'), child = await folder(library, '参考', parent.id), other = await folder(library, '其他');
  const first = await picture(directory, library, '图片甲', child.id), second = await picture(directory, library, '图片乙', parent.id, '#238748');
  await library.setFolderColor(parent.id, 'orange');
  let snapshot = library.snapshot();
  assert.equal(snapshot.folders.find(item => item.id === child.id).colorLabel, null, 'Folder colors do not inherit');
  assert.ok(snapshot.assets.every(item => item.colorLabel === null), 'Folder labels do not recolor contents');
  await library.updateAssets([first.id, second.id], { colorLabel: 'cyan' });
  await library.setFolderColor(child.id, 'purple');
  await library.renameFolder(child.id, '细节参考'); await library.moveFolder(child.id, other.id);
  await library.updateAssets([first.id], { folderId: other.id, name: '已整理的图片' });
  await library.setTrash([first.id], true); await library.setTrash([first.id], false);
  snapshot = library.snapshot();
  assert.equal(snapshot.assets.find(item => item.id === first.id).colorLabel, 'cyan');
  assert.equal(snapshot.assets.find(item => item.id === second.id).colorLabel, 'cyan');
  assert.equal(snapshot.folders.find(item => item.id === child.id).colorLabel, 'purple');
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.deepEqual(reopened.snapshot().folders, snapshot.folders);
  assert.deepEqual(reopened.snapshot().assets, snapshot.assets);
  await reopened.updateAssets([first.id, second.id], { colorLabel: null }); await reopened.setFolderColor(child.id, null);
  assert.ok(reopened.snapshot().assets.every(item => item.colorLabel === null));
  assert.equal(reopened.snapshot().folders.find(item => item.id === child.id).colorLabel, null);
  assert.equal(reopened.snapshot().folders.find(item => item.id === parent.id).colorLabel, 'orange');
  assert.equal(JSON.parse(await fs.readFile(library.indexPath, 'utf8')).version, 2);
  await unchanged(reopened, [first, second]);
});

test('colors survive complete backup and verified migration without changing originals or thumbnails', async t => {
  const { directory, library } = await fixture(t);
  const parent = await folder(library, '设计'), child = await folder(library, '已确认', parent.id);
  const image = await picture(directory, library, '设计图', child.id);
  await library.setFolderColor(parent.id, 'green'); await library.setFolderColor(child.id, 'yellow');
  await library.updateAssets([image.id], { colorLabel: 'pink' });
  const baseline = library.snapshot();
  const backup = await library.backupTo(path.join(directory, 'backups'));
  const restored = new Library({ root: backup.path }); await restored.init();
  assert.deepEqual(restored.snapshot().assets, baseline.assets); assert.deepEqual(restored.snapshot().folders, baseline.folders);
  await unchanged(restored, [image]);
  const manager = new LibraryManager({ configPath: path.join(directory, 'settings/location.json') });
  await manager.init(); await manager.open(library.root);
  const destination = path.join(directory, 'migrated'); await fs.mkdir(destination);
  const migrated = await manager.migrate(destination);
  assert.deepEqual(migrated.snapshot().assets, baseline.assets); assert.deepEqual(migrated.snapshot().folders, baseline.folders);
  await unchanged(migrated, [image]); await unchanged(library, [image]);
});

test('invalid color or asset selection is rejected atomically and invalid stored labels never rewrite the index', async t => {
  const { directory, library } = await fixture(t);
  const root = await folder(library, '文件夹'); const image = await picture(directory, library, '图片', root.id);
  const baseline = library.snapshot(), before = await fs.readFile(library.indexPath, 'utf8');
  for (const value of ['', '#gg0000', '#1234', '#12345678', 'rgb(255,0,0)', 'RED', 'constructor', 1, {}, []]) {
    await assert.rejects(library.updateAssets([image.id], { name: '不应改名', colorLabel: value }), /颜色标记无效/);
    await assert.rejects(library.setFolderColor(root.id, value), /颜色标记无效/);
  }
  await assert.rejects(library.updateAssets([image.id, 'missing'], { colorLabel: 'red' }), /不存在/);
  await assert.rejects(library.setFolderColor('missing', 'red'), /不存在/);
  await assert.rejects(library.setFolderColor(null, 'red'), /不存在/);
  assert.deepEqual(library.snapshot(), baseline); assert.equal(await fs.readFile(library.indexPath, 'utf8'), before);
  for (const kind of ['assets', 'folders']) {
    const corrupt = JSON.parse(before); corrupt[kind][0].colorLabel = 'url(https://invalid.example)';
    const bytes = JSON.stringify(corrupt); await fs.writeFile(library.indexPath, bytes);
    await assert.rejects(new Library({ root: library.root }).init(), /颜色标记无效/);
    assert.equal(await fs.readFile(library.indexPath, 'utf8'), bytes);
  }
  await fs.writeFile(library.indexPath, before); await unchanged(library, [image]);
});

test('failed color persistence retains the complete previous state and deleting folders keeps asset colors', async t => {
  const { directory, library } = await fixture(t);
  const parent = await folder(library, '父级'), child = await folder(library, '子级', parent.id);
  const image = await picture(directory, library, '保留的图片', child.id);
  await library.updateAssets([image.id], { colorLabel: 'blue' }); await library.setFolderColor(child.id, 'pink');
  const baseline = library.snapshot(), before = await fs.readFile(library.indexPath, 'utf8');
  const persist = library._persist.bind(library);
  library._persist = async () => { throw new Error('simulated save failure'); };
  await assert.rejects(library.updateAssets([image.id], { colorLabel: 'red' }), /simulated save failure/);
  await assert.rejects(library.setFolderColor(parent.id, 'green'), /simulated save failure/);
  assert.deepEqual(library.snapshot(), baseline); assert.equal(await fs.readFile(library.indexPath, 'utf8'), before);
  library._persist = persist;
  const removed = await library.deleteFolder(parent.id);
  assert.equal(removed.folders.length, 0); assert.equal(removed.assets[0].folderId, null); assert.equal(removed.assets[0].colorLabel, 'blue');
  await unchanged(library, [image]);
});

test('custom RGB persists in single and bulk labels, folder labels, backups and migrations with no inheritance', async t => {
  const { directory, library } = await fixture(t);
  const parent = await folder(library, '自定义标记'), child = await folder(library, '子目录', parent.id);
  const first = await picture(directory, library, '自定义图片甲', child.id, '#713980');
  const second = await picture(directory, library, '自定义图片乙', parent.id, '#267c91');
  await library.updateAssets([first.id], { colorLabel: '#AbC' });
  assert.equal(library.snapshot().assets.find(item => item.id === first.id).colorLabel, '#aabbcc');
  assert.equal(library.snapshot().assets.find(item => item.id === second.id).colorLabel, null);
  await library.setFolderColor(parent.id, '#0fA');
  assert.equal(library.snapshot().folders.find(item => item.id === parent.id).colorLabel, '#00ffaa');
  assert.equal(library.snapshot().folders.find(item => item.id === child.id).colorLabel, null);
  assert.equal(library.snapshot().assets.find(item => item.id === first.id).colorLabel, '#aabbcc');
  await library.updateAssets([first.id, second.id], { colorLabel: '#AB12Ef' });
  await library.setFolderColor(child.id, 'purple');
  const stored = JSON.parse(await fs.readFile(library.indexPath, 'utf8'));
  assert.ok(stored.assets.every(item => item.colorLabel === '#ab12ef'));
  assert.equal(stored.folders.find(item => item.id === parent.id).colorLabel, '#00ffaa');
  assert.equal(stored.folders.find(item => item.id === child.id).colorLabel, 'purple');
  const reopened = new Library({ root: library.root }); await reopened.init();
  const baseline = reopened.snapshot();
  assert.ok(baseline.assets.every(item => item.colorLabel === '#ab12ef'));
  const backup = await reopened.backupTo(path.join(directory, 'custom-backups'));
  const restored = new Library({ root: backup.path }); await restored.init();
  assert.deepEqual(restored.snapshot().assets, baseline.assets); assert.deepEqual(restored.snapshot().folders, baseline.folders);
  const manager = new LibraryManager({ configPath: path.join(directory, 'custom-settings/location.json') });
  await manager.init(); await manager.open(library.root);
  const destination = path.join(directory, 'custom-migrated'); await fs.mkdir(destination);
  const migrated = await manager.migrate(destination);
  assert.deepEqual(migrated.snapshot().assets, baseline.assets); assert.deepEqual(migrated.snapshot().folders, baseline.folders);
  await unchanged(migrated, [first, second]); await unchanged(restored, [first, second]); await unchanged(reopened, [first, second]);
  await migrated.updateAssets([first.id, second.id], { colorLabel: null });
  await migrated.setFolderColor(parent.id, null);
  assert.ok(migrated.snapshot().assets.every(item => item.colorLabel === null));
  assert.equal(migrated.snapshot().folders.find(item => item.id === parent.id).colorLabel, null);
  assert.equal(migrated.snapshot().folders.find(item => item.id === child.id).colorLabel, 'purple');
  await unchanged(migrated, [first, second]);
});
