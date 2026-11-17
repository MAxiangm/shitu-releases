'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'asset-folder-move-'));
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (source, destination) => {
    await sharp(source).resize(12).jpeg().toFile(destination); return { width: 20, height: 16 };
  } });
  await library.init();
  t.after(async () => {
    await library.flush();
    const relative = path.relative(parent, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const firstFolder = (await library.createFolder('原分类')).folders.at(-1).id;
  const targetFolder = (await library.createFolder('目标')).folders.at(-1).id;
  const files = [];
  for (const [index, color] of ['#873e20', '#246ba3', '#35a068'].entries()) {
    const source = path.join(directory, `sample-${index}.png`);
    await sharp({ create: { width: 20, height: 16, channels: 3, background: color } }).png().toFile(source);
    const report = await library.importPaths([source], { folderId: index === 2 ? targetFolder : firstFolder });
    const asset = library.snapshot().assets.find(item => item.id === report.assetIds[0]);
    files.push({ ...asset, original: await fs.readFile(library.getAssetPath(asset.id, 'original')), thumbnailBytes: await fs.readFile(library.getAssetPath(asset.id, 'thumbnail')) });
  }
  return { library, firstFolder, targetFolder, files };
}

test('moving a batch changes only folder metadata and keeps original bytes and other labels', async t => {
  const { library, targetFolder, files } = await fixture(t);
  const ids = files.slice(0, 2).map(asset => asset.id);
  await library.updateAssets(ids, { tags: ['标记'], colorLabel: '#236abc', notes: '保留备注', rating: 4 });
  const before = library.snapshot().assets;
  const moved = await library.moveAssetsToFolder([...ids, ids[0]], targetFolder);
  for (const asset of moved.assets) {
    const old = before.find(item => item.id === asset.id);
    assert.equal(asset.folderId, targetFolder);
    for (const key of ['hash', 'filename', 'thumbnail', 'tags', 'colorLabel', 'name', 'notes', 'rating']) assert.deepEqual(asset[key], old[key]);
    const file = files.find(item => item.id === asset.id);
    assert.deepEqual(await fs.readFile(library.getAssetPath(asset.id, 'original')), file.original);
    assert.deepEqual(await fs.readFile(library.getAssetPath(asset.id, 'thumbnail')), file.thumbnailBytes);
  }
  const unfiled = await library.moveAssetsToFolder(ids, null);
  assert.ok(unfiled.assets.filter(asset => ids.includes(asset.id)).every(asset => asset.folderId === null));
});

test('dropping assets into their existing folder is a true no-op including index bytes', async t => {
  const { library, firstFolder, files } = await fixture(t);
  const before = await fs.readFile(library.indexPath);
  const snapshot = library.snapshot();
  const persist = library._persist;
  library._persist = async () => assert.fail('Same-folder drop must not persist');
  const result = await library.moveAssetsToFolder([files[0].id, files[1].id], firstFolder);
  library._persist = persist;
  assert.deepEqual(result, snapshot);
  assert.deepEqual(await fs.readFile(library.indexPath), before);
});

test('invalid, missing and trashed batch members reject the entire move without changing other assets', async t => {
  const { library, targetFolder, files } = await fixture(t);
  await library.setTrash([files[1].id], true);
  const before = await fs.readFile(library.indexPath);
  for (const ids of [[], null, [files[0].id, 'missing'], [files[0].id, {}], [files[0].id, files[1].id]]) {
    await assert.rejects(library.moveAssetsToFolder(ids, targetFolder));
    assert.deepEqual(await fs.readFile(library.indexPath), before);
  }
  await assert.rejects(library.moveAssetsToFolder([files[0].id], 'missing-folder'), /分类不存在/);
  await assert.rejects(library.moveAssetsToFolder([files[0].id], undefined), /分类不存在/);
  assert.deepEqual(await fs.readFile(library.indexPath), before);
});

test('queued trash or target deletion is validated after earlier operations commit', async t => {
  const { library, targetFolder, files } = await fixture(t);
  const trash = library.setTrash([files[0].id], true);
  const move = library.moveAssetsToFolder([files[0].id, files[1].id], targetFolder);
  await trash;
  await assert.rejects(move, /回收站/);
  assert.equal(library.snapshot().assets.find(item => item.id === files[1].id).folderId, files[1].folderId);
  const deletion = library.deleteFolder(targetFolder);
  const afterDeletion = library.moveAssetsToFolder([files[1].id], targetFolder);
  await deletion;
  await assert.rejects(afterDeletion, /分类不存在/);
});

test('a failed save leaves every batch member in its original folder', async t => {
  const { library, targetFolder, files } = await fixture(t);
  const before = library.snapshot(), bytes = await fs.readFile(library.indexPath);
  const persist = library._persist;
  library._persist = async () => { throw new Error('simulated save failure'); };
  await assert.rejects(library.moveAssetsToFolder(files.slice(0, 2).map(asset => asset.id), targetFolder), /simulated/);
  library._persist = persist;
  assert.deepEqual(library.snapshot(), before);
  assert.deepEqual(await fs.readFile(library.indexPath), bytes);
});
