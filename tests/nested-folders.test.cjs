'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { LibraryManager } = require('../src/library-manager.cjs');
const FolderTree = require('../src/folder-tree.js');

async function fixture(t) {
  const base = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'nested-folders-'));
  t.after(async () => {
    const relative = path.relative(base, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (source, destination) => {
    await sharp(source).resize(16).jpeg().toFile(destination); return { width: 32, height: 24 };
  } });
  await library.init();
  return { directory, library };
}
async function createFolder(library, name, parentId = null) { return (await library.createFolder(name, parentId)).folders.at(-1); }
async function importImage(directory, library, name, folderId, color) {
  const bytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: color } }).png().toBuffer();
  const source = path.join(directory, name + '.png'); await fs.writeFile(source, bytes);
  const report = await library.importPaths([source], { folderId });
  assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
  return { id: report.assetIds[0], source, bytes };
}

test('legacy flat folders reopen as roots without rewriting their index', async t => {
  const { library } = await fixture(t);
  const legacy = JSON.stringify({ version: 1, folders: [{ id: 'old-a', name: '旧项目' }, { id: 'old-b', name: '旧素材' }], assets: [] });
  await fs.writeFile(library.indexPath, legacy);
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.deepEqual(reopened.snapshot().folders.map(folder => folder.parentId), [null, null]);
  assert.equal(await fs.readFile(library.indexPath, 'utf8'), legacy, 'Opening the existing index must not migrate it in place');
  assert.equal(JSON.parse(await fs.readFile(library.indexPath, 'utf8')).version, 1);
  const child = await createFolder(reopened, '参考', 'old-a');
  assert.equal(child.parentId, 'old-a');
  assert.equal(JSON.parse(await fs.readFile(library.indexPath, 'utf8')).version, 2);
  assert.equal(FolderTree.path(reopened.snapshot().folders, child.id), '旧项目 / 参考');
});

test('three-level folders and nested asset assignments survive reopen, backup and verified migration', async t => {
  const { directory, library } = await fixture(t);
  const root = await createFolder(library, '项目'), child = await createFolder(library, '视频', root.id), leaf = await createFolder(library, '镜头', child.id);
  const image = await importImage(directory, library, '保留的原图', leaf.id, '#326fb0');
  assert.equal(JSON.parse(await fs.readFile(library.indexPath, 'utf8')).version, 2);
  const originalHash = crypto.createHash('sha256').update(image.bytes).digest('hex');
  await library.flush();
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.equal(FolderTree.path(reopened.snapshot().folders, leaf.id), '项目 / 视频 / 镜头');
  assert.equal(reopened.snapshot().assets[0].folderId, leaf.id);
  const backup = await reopened.backupTo(path.join(directory, 'backups'));
  const restored = new Library({ root: backup.path }); await restored.init();
  assert.equal(JSON.parse(await fs.readFile(restored.indexPath, 'utf8')).version, 2);
  assert.deepEqual(restored.snapshot().folders, reopened.snapshot().folders);
  assert.deepEqual(await fs.readFile(restored.getAssetPath(image.id)), image.bytes);
  const manager = new LibraryManager({ configPath: path.join(directory, 'settings', 'location.json') });
  await manager.init(); await manager.open(library.root);
  const target = path.join(directory, 'migration'); await fs.mkdir(target);
  const migrated = await manager.migrate(target);
  assert.equal(JSON.parse(await fs.readFile(migrated.indexPath, 'utf8')).version, 2);
  assert.deepEqual(migrated.snapshot().folders, reopened.snapshot().folders);
  assert.equal(migrated.snapshot().assets[0].folderId, leaf.id);
  assert.equal(migrated.snapshot().assets[0].hash, originalHash);
  assert.deepEqual(await fs.readFile(migrated.getAssetPath(image.id)), image.bytes);
  assert.deepEqual(await fs.readFile(library.getAssetPath(image.id)), image.bytes);
  assert.deepEqual(await fs.readFile(image.source), image.bytes);
});

test('folder names are unique among siblings and moving a subtree validates its parent and depth', async t => {
  const { library } = await fixture(t);
  const a = await createFolder(library, '项目甲'), b = await createFolder(library, '项目乙');
  const child = await createFolder(library, '素材', a.id), other = await createFolder(library, '素材', b.id);
  const leaf = await createFolder(library, '镜头', child.id);
  await assert.rejects(library.createFolder('素材', a.id), /同级/);
  await assert.rejects(library.moveFolder(child.id, child.id), /自己/);
  await assert.rejects(library.moveFolder(a.id, leaf.id), /子文件夹/);
  await assert.rejects(library.moveFolder(child.id, 'missing'), /不存在/);
  await assert.rejects(library.moveFolder(child.id, b.id), /同级/);
  await library.renameFolder(other.id, '临时素材');
  await library.moveFolder(child.id, b.id);
  assert.equal(FolderTree.path(library.snapshot().folders, leaf.id), '项目乙 / 素材 / 镜头');
  await assert.rejects(library.renameFolder(other.id, '素材'), /同级/);
  await library.moveFolder(child.id, null);
  assert.equal(FolderTree.path(library.snapshot().folders, leaf.id), '素材 / 镜头');
  let parent = null;
  for (let index = 0; index < FolderTree.MAX_DEPTH; index++) parent = (await createFolder(library, `层级${index}`, parent)).id;
  const saved = await fs.readFile(library.indexPath, 'utf8');
  await assert.rejects(library.createFolder('过深', parent), /32 层/);
  await assert.rejects(library.moveFolder(child.id, parent), /32 层/);
  assert.equal(await fs.readFile(library.indexPath, 'utf8'), saved);
});

test('deleting a folder removes its whole classification subtree and retains active and trashed originals', async t => {
  const { directory, library } = await fixture(t);
  const root = await createFolder(library, '项目'), branch = await createFolder(library, '删除分类', root.id);
  const leaf = await createFolder(library, '子分类', branch.id), outside = await createFolder(library, '保留分类', root.id);
  const direct = await importImage(directory, library, '直属图片', branch.id, '#ba5230');
  const nested = await importImage(directory, library, '子目录图片', leaf.id, '#306fba');
  const preserved = await importImage(directory, library, '其他图片', outside.id, '#3fba30');
  await library.setTrash([nested.id], true);
  const thumbnails = new Map();
  for (const image of [direct, nested, preserved]) thumbnails.set(image.id, await fs.readFile(library.getAssetPath(image.id, 'thumbnail')));
  const result = await library.deleteFolder(branch.id);
  assert.deepEqual(result.folders.map(folder => folder.id), [root.id, outside.id]);
  assert.equal(result.assets.find(asset => asset.id === direct.id).folderId, null);
  assert.equal(result.assets.find(asset => asset.id === nested.id).folderId, null);
  assert.ok(result.assets.find(asset => asset.id === nested.id).trashedAt);
  assert.equal(result.assets.find(asset => asset.id === preserved.id).folderId, outside.id);
  for (const image of [direct, nested, preserved]) {
    assert.deepEqual(await fs.readFile(library.getAssetPath(image.id)), image.bytes);
    assert.deepEqual(await fs.readFile(image.source), image.bytes);
    assert.deepEqual(await fs.readFile(library.getAssetPath(image.id, 'thumbnail')), thumbnails.get(image.id));
  }
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.deepEqual(reopened.snapshot().folders, result.folders);
  assert.equal(reopened.snapshot().stats.total, 3);
});

test('folder mutations roll back failed persistence and corrupt folder graphs never replace the original index', async t => {
  const { directory, library } = await fixture(t);
  const root = await createFolder(library, '项目'), child = await createFolder(library, '子目录', root.id), other = await createFolder(library, '其他');
  const image = await importImage(directory, library, '原件', child.id, '#9e32b8');
  const before = library.snapshot(), index = await fs.readFile(library.indexPath, 'utf8');
  const persist = library._persist.bind(library);
  library._persist = async () => { throw new Error('simulated persistence failure'); };
  for (const mutate of [() => library.createFolder('新的子目录', root.id), () => library.renameFolder(child.id, '改名'),
    () => library.moveFolder(child.id, other.id), () => library.deleteFolder(root.id)]) {
    await assert.rejects(mutate(), /simulated persistence failure/);
    assert.deepEqual(library.snapshot(), before);
    assert.equal(await fs.readFile(library.indexPath, 'utf8'), index);
  }
  library._persist = persist;
  await createFolder(library, '仍可继续', root.id);
  assert.deepEqual(await fs.readFile(library.getAssetPath(image.id)), image.bytes);
  const corrupt = JSON.parse(await fs.readFile(library.indexPath, 'utf8'));
  corrupt.folders.find(folder => folder.id === root.id).parentId = child.id;
  const damaged = JSON.stringify(corrupt); await fs.writeFile(library.indexPath, damaged);
  await assert.rejects(new Library({ root: library.root }).init(), /循环/);
  assert.equal(await fs.readFile(library.indexPath, 'utf8'), damaged);
  assert.deepEqual(await fs.readFile(library.getAssetPath(image.id)), image.bytes);
});

test('hierarchy format upgrade is atomic and never downgrades after deleting the last child', async t => {
  const { directory, library } = await fixture(t);
  const root = await createFolder(library, '旧平目录');
  const original = await fs.readFile(library.indexPath, 'utf8'), before = library.snapshot(), originalData = library.data;
  assert.equal(JSON.parse(original).version, 1, 'Flat-only libraries retain their original format');
  // An actual filesystem persistence failure must not upgrade the in-memory
  // version or lose the old index. Everything stays in this isolated fixture.
  const preserved = path.join(directory, 'saved-index.json');
  await fs.rename(library.indexPath, preserved); await fs.mkdir(library.indexPath);
  try {
    await assert.rejects(library.createFolder('尚未保存', root.id));
    assert.equal(library.data, originalData);
    assert.equal(library.data.version, 1);
    assert.deepEqual(library.snapshot(), before);
    assert.equal(await fs.readFile(preserved, 'utf8'), original);
  } finally {
    await fs.rmdir(library.indexPath); await fs.rename(preserved, library.indexPath);
  }
  const child = await createFolder(library, '成功保存', root.id);
  assert.equal(library.data.version, 2);
  assert.equal(originalData.version, 1, 'The pre-upgrade data object must not be modified');
  assert.equal(JSON.parse(await fs.readFile(library.indexPath, 'utf8')).version, 2);
  await library.deleteFolder(child.id);
  assert.equal(library.data.version, 2);
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.equal(reopened.data.version, 2);
  await createFolder(reopened, '新的顶层文件夹');
  assert.equal(JSON.parse(await fs.readFile(reopened.indexPath, 'utf8')).version, 2);
});

test('temporary index sharing failures retry the atomic replacement and persistent failures keep the old index', async t => {
  const { library } = await fixture(t);
  const root = await createFolder(library, '项目');
  const original = await fs.readFile(library.indexPath, 'utf8');
  const rename = fs.rename;
  let attempts = 0, denyAlways = false;
  fs.rename = async (source, destination) => {
    if (destination === library.indexPath && source.startsWith(library.indexPath + '.') && source.endsWith('.tmp')) {
      attempts++;
      if (denyAlways || attempts <= 2) {
        assert.equal(await fs.readFile(library.indexPath, 'utf8'), denyAlways ? preserved : original);
        throw Object.assign(new Error('simulated Windows sharing violation'), { code: 'EPERM' });
      }
    }
    return rename(source, destination);
  };
  let preserved;
  try {
    const child = await createFolder(library, '可保存的子目录', root.id);
    assert.equal(attempts, 3);
    assert.equal(child.parentId, root.id);
    preserved = await fs.readFile(library.indexPath, 'utf8');
    assert.equal(JSON.parse(preserved).version, 2);
    const before = library.snapshot();
    attempts = 0; denyAlways = true;
    await assert.rejects(library.renameFolder(child.id, '不可保存的名称'), /sharing violation/);
    assert.equal(attempts, 6, 'Permanent failures must stop after a bounded number of attempts');
    assert.deepEqual(library.snapshot(), before);
    assert.equal(await fs.readFile(library.indexPath, 'utf8'), preserved);
    assert.deepEqual((await fs.readdir(library.root)).filter(name => name.endsWith('.tmp')), []);
  } finally { fs.rename = rename; }
  await library.renameFolder(root.id, '之后仍可保存');
  assert.equal(library.snapshot().folders.find(folder => folder.id === root.id).name, '之后仍可保存');
});
