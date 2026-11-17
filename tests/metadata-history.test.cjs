'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Library } = require('../src/library.cjs');
const { MetadataHistory, MAX_BYTES } = require('../src/metadata-history.cjs');
const record = { recordHistory: true };

async function fixture(t, count = 2) {
  const parent = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'metadata-history-'));
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (_source, destination) => {
    await fs.writeFile(destination, 'fixture thumbnail'); return { width: 10, height: 10 };
  } });
  await library.init();
  t.after(async () => {
    await library.flush(); const relative = path.relative(parent, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const firstFolder = (await library.createFolder('原位置')).folders.at(-1).id;
  const targetFolder = (await library.createFolder('新位置')).folders.at(-1).id;
  async function add(index) {
    const filename = path.join(directory, `${index}.png`); await fs.writeFile(filename, `original-${index}`);
    return (await library.importPaths([filename], { folderId: firstFolder })).assetIds[0];
  }
  const ids = []; for (let index = 0; index < count; index++) ids.push(await add(index));
  return { library, directory, ids, firstFolder, targetFolder, add,
    asset: id => library.snapshot().assets.find(asset => asset.id === id) };
}

test('history is opt-in, instance-local and absent from the persisted library index', async t => {
  const f = await fixture(t);
  await f.library.updateAssets([f.ids[0]], { notes: 'internal metadata' });
  assert.equal(f.library.historyState().canUndo, false);
  await f.library.updateAssets([f.ids[0]], { name: 'user name' }, record);
  assert.equal(f.library.historyState().undoCount, 1);
  assert.deepEqual(f.library.snapshot().history, f.library.historyState());
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(f.library.indexPath, 'utf8')), 'history'), false);
  const reopened = new Library({ root: f.library.root }); await reopened.init();
  assert.equal(reopened.historyState().canUndo, false); assert.equal(f.library.historyState().canUndo, true);
});

test('one batch undo restores only changed fields while preserving later imports and unrelated metadata', async t => {
  const f = await fixture(t), originals = [];
  for (const id of f.ids) originals.push({ id, original: await fs.readFile(f.library.getAssetPath(id)), thumbnail: await fs.readFile(f.library.getAssetPath(id, 'thumbnail')) });
  const before = f.ids.map(f.asset);
  await f.library.updateAssets(f.ids, { name: '统一名称', tags: ['标签'], rating: 4, notes: '批量备注', colorLabel: '#123456', folderId: f.targetFolder }, record);
  assert.equal(f.library.historyState().undoCount, 1);
  const later = await f.add(3);
  await f.library.updateAssets([f.ids[0]], { sourceUrl: 'https://example.test/later' });
  const undoId = f.library.historyState().undoId;
  const undone = await f.library.undo({ expectedId: undoId });
  assert.equal(undone.history.canRedo, true); assert.equal(undone.history.redoId, undoId);
  assert.ok(undone.assets.some(asset => asset.id === later));
  for (let index = 0; index < f.ids.length; index++) {
    for (const key of ['name', 'tags', 'rating', 'notes', 'colorLabel', 'folderId']) assert.deepEqual(f.asset(f.ids[index])[key], before[index][key], key);
  }
  assert.equal(f.asset(f.ids[0]).sourceUrl, 'https://example.test/later');
  await f.library.redo({ expectedId: undoId });
  assert.ok(f.ids.every(id => f.asset(id).name === '统一名称' && f.asset(id).folderId === f.targetFolder));
  for (const item of originals) {
    assert.deepEqual(await fs.readFile(f.library.getAssetPath(item.id)), item.original);
    assert.deepEqual(await fs.readFile(f.library.getAssetPath(item.id, 'thumbnail')), item.thumbnail);
  }
});

test('unchanged batch fields do not overwrite external edits during replay', async t => {
  const f = await fixture(t);
  await f.library.updateAssets([f.ids[0]], { notes: 'already set' });
  await f.library.updateAssets(f.ids, { notes: 'already set', rating: 3 }, record);
  await f.library.updateAssets([f.ids[0]], { notes: 'new internal note' });
  await f.library.undo();
  assert.equal(f.asset(f.ids[0]).notes, 'new internal note'); assert.equal(f.asset(f.ids[0]).rating, 0);
  assert.equal(f.asset(f.ids[1]).notes, ''); assert.equal(f.asset(f.ids[1]).rating, 0);
  await f.library.redo(); assert.equal(f.asset(f.ids[0]).notes, 'new internal note');
});

test('batch tag additions and removals preserve distinct tags and undo as one action', async t => {
  const f = await fixture(t);
  await f.library.updateAssets([f.ids[0]], { tags: ['甲', '移除'] });
  await f.library.updateAssets([f.ids[1]], { tags: ['乙', '移除'] });
  await f.library.updateAssets(f.ids, { addTags: ['新增', '新增'], removeTags: ['移除'] }, record);
  assert.deepEqual(f.asset(f.ids[0]).tags, ['甲', '新增']); assert.deepEqual(f.asset(f.ids[1]).tags, ['乙', '新增']);
  assert.equal(f.library.historyState().undoCount, 1);
  await f.library.undo();
  assert.deepEqual(f.asset(f.ids[0]).tags, ['甲', '移除']); assert.deepEqual(f.asset(f.ids[1]).tags, ['乙', '移除']);
  await f.library.redo(); assert.deepEqual(f.asset(f.ids[1]).tags, ['乙', '新增']);
  const before = f.library.snapshot();
  await assert.rejects(f.library.updateAssets(f.ids, { tags: [], addTags: [] }, record), /不能/);
  await assert.rejects(f.library.updateAssets(f.ids, { addTags: ['x'.repeat(101)] }, record), /标签/);
  assert.deepEqual(f.library.snapshot(), before);
  await f.library.updateAssets([f.ids[1]], { tags: Array.from({ length: 100 }, (_, i) => `标签${i}`) });
  const full = f.library.snapshot();
  await assert.rejects(f.library.updateAssets(f.ids, { addTags: ['超限'] }, record), /标签/);
  assert.deepEqual(f.library.snapshot(), full, 'later overflow must not commit earlier batch members');
});

test('batch minimum ratings preserve higher ratings and record only changed assets in one step', async t => {
  const f = await fixture(t);
  await f.library.updateAssets([f.ids[0]], { rating: 2 });
  await f.library.updateAssets([f.ids[1]], { rating: 5 });
  await f.library.updateAssets(f.ids, { minRating: 4 }, record);
  assert.equal(f.asset(f.ids[0]).rating, 4); assert.equal(f.asset(f.ids[1]).rating, 5);
  assert.equal(f.library.historyState().undoCount, 1);
  await f.library.updateAssets([f.ids[1]], { rating: 3 });
  await f.library.undo(); assert.equal(f.asset(f.ids[0]).rating, 2); assert.equal(f.asset(f.ids[1]).rating, 3);
  await f.library.redo(); assert.equal(f.asset(f.ids[0]).rating, 4); assert.equal(f.asset(f.ids[1]).rating, 3);
  const before = f.library.snapshot();
  for (const minRating of [0, 6, 1.2, '4']) await assert.rejects(f.library.updateAssets(f.ids, { minRating }, record), /最低评分/);
  await assert.rejects(f.library.updateAssets(f.ids, { rating: 2, minRating: 4 }, record), /不能/);
  assert.deepEqual(f.library.snapshot(), before);
});

test('oversized operations still apply completely but expose a warning and clear the redo branch', async t => {
  const f = await fixture(t);
  f.library._history = new MetadataHistory({ maxBytes: 1500 });
  await f.library.updateAssets([f.ids[0]], { notes: 'small' }, record); await f.library.undo();
  assert.equal(f.library.historyState().canRedo, true);
  const result = await f.library.updateAssets(f.ids, { notes: 'x'.repeat(1000) }, record);
  assert.ok(f.ids.every(id => f.asset(id).notes === 'x'.repeat(1000)));
  assert.match(result.history.warning, /未保存撤销/); assert.equal(result.history.canRedo, false);
  assert.equal(result.history.canUndo, false);
});

test('no-op and failed operations preserve the redo branch; a new recorded change clears it', async t => {
  const f = await fixture(t);
  await f.library.updateAssets([f.ids[0]], { notes: 'first' }, record); await f.library.undo();
  const history = f.library.historyState(), bytes = await fs.readFile(f.library.indexPath);
  await f.library.updateAssets([f.ids[0]], { notes: '', colorLabel: null }, record);
  await f.library.moveAssetsToFolder(f.ids, f.firstFolder, record);
  await assert.rejects(f.library.updateAssets(f.ids, { rating: 9 }, record));
  assert.deepEqual(f.library.historyState(), history); assert.deepEqual(await fs.readFile(f.library.indexPath), bytes);
  await f.library.updateAssets([f.ids[1]], { rating: 2 }, record);
  assert.equal(f.library.historyState().canRedo, false); assert.equal(f.library.historyState().undoCount, 1);
});

test('batch move replay preserves current labels and detects deleted target folders', async t => {
  const f = await fixture(t);
  await f.library.moveAssetsToFolder(f.ids, f.targetFolder, record);
  await f.library.updateAssets([f.ids[0]], { notes: 'keep', colorLabel: 'red' });
  await f.library.undo(); assert.ok(f.ids.every(id => f.asset(id).folderId === f.firstFolder));
  assert.equal(f.asset(f.ids[0]).notes, 'keep'); assert.equal(f.asset(f.ids[0]).colorLabel, 'red');
  await f.library.deleteFolder(f.targetFolder);
  const before = f.library.snapshot();
  await assert.rejects(f.library.redo(), /冲突/); assert.deepEqual(f.library.snapshot(), before);
});

test('folder rename, color and hierarchy each replay atomically without affecting newer children', async t => {
  const f = await fixture(t);
  await f.library.renameFolder(f.firstFolder, '新名称', record);
  await f.library.setFolderColor(f.firstFolder, '#aabbcc', record);
  await f.library.moveFolder(f.firstFolder, f.targetFolder, record);
  const child = (await f.library.createFolder('后建子目录', f.firstFolder)).folders.at(-1).id;
  await f.library.undo(); await f.library.undo(); await f.library.undo();
  let folders = f.library.snapshot().folders;
  assert.equal(folders.find(folder => folder.id === f.firstFolder).name, '原位置');
  assert.equal(folders.find(folder => folder.id === f.firstFolder).parentId, null);
  assert.equal(folders.find(folder => folder.id === f.firstFolder).colorLabel, null);
  assert.equal(folders.find(folder => folder.id === child).parentId, f.firstFolder);
  await f.library.redo(); await f.library.redo(); await f.library.redo();
  folders = f.library.snapshot().folders;
  assert.equal(folders.find(folder => folder.id === f.firstFolder).parentId, f.targetFolder);
  assert.equal(folders.find(folder => folder.id === f.firstFolder).name, '新名称');
});

test('related edits, deleted objects and stale expected IDs reject without moving history', async t => {
  const f = await fixture(t);
  await f.library.updateAssets(f.ids, { notes: 'recorded' }, record);
  await f.library.updateAssets([f.ids[1]], { notes: 'external' });
  let before = f.library.snapshot();
  await assert.rejects(f.library.undo(), /冲突/); assert.deepEqual(f.library.snapshot(), before);
  await assert.rejects(f.library.undo({ expectedId: 'outdated' }), /历史已变化/); assert.deepEqual(f.library.snapshot(), before);
  await f.library.setTrash([f.ids[1]], true); await f.library.deletePermanently([f.ids[1]]);
  before = f.library.snapshot(); await assert.rejects(f.library.undo(), /冲突/); assert.deepEqual(f.library.snapshot(), before);
});

test('failed recording or replay persistence leaves both data and stacks unchanged', async t => {
  const f = await fixture(t);
  const persist = f.library._persist;
  let before = f.library.snapshot();
  f.library._persist = async () => { throw new Error('fixture persistence failure'); };
  await assert.rejects(f.library.updateAssets(f.ids, { notes: 'unsaved' }, record), /persistence/);
  assert.deepEqual(f.library.snapshot(), before);
  f.library._persist = persist;
  await f.library.updateAssets(f.ids, { notes: 'saved' }, record);
  before = f.library.snapshot(); f.library._persist = async () => { throw new Error('fixture persistence failure'); };
  await assert.rejects(f.library.undo(), /persistence/); assert.deepEqual(f.library.snapshot(), before);
  f.library._persist = persist; await f.library.undo();
  before = f.library.snapshot(); f.library._persist = async () => { throw new Error('fixture persistence failure'); };
  await assert.rejects(f.library.redo(), /persistence/); assert.deepEqual(f.library.snapshot(), before);
  f.library._persist = persist; await f.library.redo();
});

test('history capture and replay run after earlier queued edits, never against stale snapshots', async t => {
  const f = await fixture(t);
  const first = f.library.updateAssets([f.ids[0]], { notes: 'first' }, record);
  const second = f.library.updateAssets([f.ids[0]], { notes: 'second' }, record);
  const undo = f.library.undo(); await Promise.all([first, second, undo]);
  assert.equal(f.asset(f.ids[0]).notes, 'first'); assert.equal(f.library.historyState().undoCount, 1);
  await f.library.undo(); assert.equal(f.asset(f.ids[0]).notes, '');
  await f.library.redo(); await f.library.redo(); assert.equal(f.asset(f.ids[0]).notes, 'second');
});

test('history retains at most 50 whole steps and a bounded number of bytes', async t => {
  const f = await fixture(t, 1);
  for (let index = 1; index <= 52; index++) await f.library.updateAssets(f.ids, { notes: String(index) }, record);
  assert.equal(f.library.historyState().undoCount, 50);
  for (let index = 0; index < 50; index++) await f.library.undo();
  assert.equal(f.asset(f.ids[0]).notes, '2'); assert.equal(f.library.historyState().undoCount, 0);
  assert.equal(f.library.historyState().redoCount, 50);
  assert.equal(MAX_BYTES, 16 * 1024 * 1024);
  const history = new MetadataHistory({ maxBytes: 1800 });
  const before = { assets: [{ id: 'a', notes: '' }] };
  for (let index = 0; index < 4; index++) {
    const after = { assets: [{ id: 'a', notes: `${index}:${'a'.repeat(200)}` }] };
    history.record(history.prepare(before, after, 'assets', new Set(['a']), ['notes'], 'edit'));
  }
  assert.ok(history.undoStack.length > 0 && history.undoStack.length < 4);
  assert.ok(history.undoStack.reduce((sum, entry) => sum + entry.bytes, 0) <= 1800);
  const oversized = history.prepare(before, { assets: [{ id: 'a', notes: 'x'.repeat(2000) }] }, 'assets', new Set(['a']), ['notes'], 'large');
  history.record(oversized); assert.match(history.state().warning, /未保存撤销/);
});
