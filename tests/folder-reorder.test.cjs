'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Library } = require('../src/library.cjs');
const FolderTree = require('../src/folder-tree.js');
const record = { recordHistory: true };

async function fixture(t) {
  const base = path.resolve(__dirname, '../.recovery/tests');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'folder-reorder-'));
  const library = new Library({ root: path.join(directory, 'library') });
  await library.init();
  t.after(async () => {
    await library.flush();
    const relative = path.relative(base, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const add = async (name, parentId = null) => (await library.createFolder(name, parentId)).folders.at(-1).id;
  const children = (parentId = null) => FolderTree.children(library.snapshot().folders, parentId).map(folder => folder.name);
  return { directory, library, add, children };
}

test('moving a parent keeps all descendants and their assets together and persists the displayed order', async t => {
  const f = await fixture(t);
  const first = await f.add('原父级'), destination = await f.add('新父级');
  const child = await f.add('子级', first), grandchild = await f.add('孙级', child);
  const sibling = await f.add('已有子级', destination);
  const source = path.join(f.directory, 'asset.png'), bytes = Buffer.from('original fixture bytes');
  await fs.writeFile(source, bytes);
  const imported = await f.library.importPaths([source], { folderId: grandchild });
  assert.equal(imported.imported, 1);
  const original = f.library.snapshot().assets[0];
  await f.library.moveFolder(first, destination, { ...record, beforeId: sibling });
  const moved = f.library.snapshot();
  assert.equal(FolderTree.path(moved.folders, grandchild), '新父级 / 原父级 / 子级 / 孙级');
  assert.deepEqual(f.children(destination), ['原父级', '已有子级']);
  assert.equal(moved.folders.find(folder => folder.id === child).parentId, first);
  assert.equal(moved.folders.find(folder => folder.id === grandchild).parentId, child);
  assert.deepEqual(moved.assets[0], original);
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(original.id)), bytes);
  assert.deepEqual(await fs.readFile(source), bytes);
  const reopened = new Library({ root: f.library.root });
  await reopened.init();
  assert.deepEqual(FolderTree.flatten(reopened.snapshot().folders).map(folder => folder.name),
    ['新父级', '原父级', '子级', '孙级', '已有子级']);
  assert.deepEqual(reopened.listFolders().map(folder => folder.id), [destination, first, child, grandchild, sibling]);
  const backup = await f.library.backupTo(path.join(f.directory, 'backups'));
  const restored = new Library({ root: backup.path }); await restored.init();
  assert.deepEqual(FolderTree.flatten(restored.snapshot().folders), FolderTree.flatten(moved.folders));
});

test('same-level before and after moves undo and redo without changing unrelated fields', async t => {
  const f = await fixture(t);
  const a = await f.add('A'), b = await f.add('B'), c = await f.add('C');
  await f.library.setFolderColor(a, '#123456');
  await f.library.moveFolder(c, null, { ...record, beforeId: a });
  assert.deepEqual(f.children(), ['C', 'A', 'B']);
  await f.library.moveFolder(b, null, { ...record, afterId: c });
  assert.deepEqual(f.children(), ['C', 'B', 'A']);
  assert.equal(f.library.historyState().undoLabel, '调整文件夹顺序');
  await f.library.undo(); assert.deepEqual(f.children(), ['C', 'A', 'B']);
  await f.library.undo(); assert.deepEqual(f.children(), ['A', 'B', 'C']);
  await f.library.redo(); assert.deepEqual(f.children(), ['C', 'A', 'B']);
  assert.equal(f.library.snapshot().folders.find(folder => folder.id === a).colorLabel, '#123456');
});

test('later siblings and children stay in place when legacy folder order is undone and redone', async t => {
  const f = await fixture(t);
  const a = await f.add('A'), b = await f.add('B');
  await f.library.moveFolder(b, null, { ...record, beforeId: a });
  const c = await f.add('C'), nested = await f.add('新子级', b);
  assert.deepEqual(f.children(), ['B', 'A', 'C']);
  await f.library.undo();
  assert.deepEqual(f.children(), ['A', 'B', 'C']);
  assert.equal(f.library.snapshot().folders.find(folder => folder.id === nested).parentId, b);
  // A new child after undo must not rewrite the older siblings' order fields,
  // otherwise a valid redo would incorrectly conflict with a simple create.
  const d = await f.add('D');
  assert.deepEqual(f.children(), ['A', 'B', 'C', 'D']);
  await f.library.redo();
  assert.deepEqual(f.children(), ['B', 'A', 'C', 'D']);
  assert.ok(f.library.snapshot().folders.some(folder => folder.id === c));
  assert.ok(f.library.snapshot().folders.some(folder => folder.id === d));
});

test('moving between parents restores complete source and destination sibling orders', async t => {
  const f = await fixture(t);
  const left = await f.add('左'), right = await f.add('右');
  const a = await f.add('A', left), b = await f.add('B', left), c = await f.add('C', right);
  const leaf = await f.add('A的子级', a);
  await f.library.moveFolder(a, right, { ...record, afterId: c });
  assert.deepEqual(f.children(left), ['B']);
  assert.deepEqual(f.children(right), ['C', 'A']);
  const newer = await f.add('新子级', right);
  await f.library.undo();
  assert.deepEqual(f.children(left), ['A', 'B']);
  assert.deepEqual(f.children(right), ['C', '新子级']);
  assert.equal(FolderTree.path(f.library.snapshot().folders, leaf), '左 / A / A的子级');
  await f.library.redo();
  assert.deepEqual(f.children(right), ['C', 'A', '新子级']);
  assert.equal(f.library.snapshot().folders.find(folder => folder.id === newer).parentId, right);
  assert.equal(f.library.snapshot().folders.find(folder => folder.id === b).parentId, left);
});

test('invalid cycles, duplicate sibling names and wrong placement anchors leave the whole library unchanged', async t => {
  const f = await fixture(t);
  const a = await f.add('A'), b = await f.add('B'), duplicate = await f.add('A', b);
  const child = await f.add('子级', a), leaf = await f.add('孙级', child);
  const before = await fs.readFile(f.library.indexPath, 'utf8'), history = f.library.historyState();
  const operations = [
    () => f.library.moveFolder(a, leaf, record),
    () => f.library.moveFolder(a, a, record),
    () => f.library.moveFolder(a, b, record),
    () => f.library.moveFolder(child, b, { ...record, beforeId: leaf }),
    () => f.library.moveFolder(child, b, { ...record, afterId: 'missing' }),
    () => f.library.moveFolder(child, b, { ...record, afterId: child }),
    () => f.library.moveFolder(child, b, { ...record, beforeId: duplicate, afterId: duplicate }),
    () => f.library.moveFolder(child, b, { ...record, beforeId: null })
  ];
  for (const operation of operations) {
    await assert.rejects(operation());
    assert.equal(await fs.readFile(f.library.indexPath, 'utf8'), before);
    assert.deepEqual(f.library.historyState(), history);
  }
});

test('already adjacent reorder and same-parent drops are no-ops and keep the redo branch', async t => {
  const f = await fixture(t);
  const a = await f.add('A'), b = await f.add('B'), c = await f.add('C');
  await f.library.moveFolder(c, null, { ...record, beforeId: a });
  await f.library.undo();
  const before = await fs.readFile(f.library.indexPath, 'utf8'), history = f.library.historyState();
  await f.library.moveFolder(a, null, { ...record, beforeId: b });
  await f.library.moveFolder(b, null, { ...record, afterId: a });
  await f.library.moveFolder(a, null, record);
  assert.equal(await fs.readFile(f.library.indexPath, 'utf8'), before);
  assert.deepEqual(f.library.historyState(), history);
});

test('failed reparent or reorder persistence does not change order, descendants or history', async t => {
  const f = await fixture(t);
  const a = await f.add('A'), b = await f.add('B'), child = await f.add('子级', a);
  const before = f.library.snapshot(), index = await fs.readFile(f.library.indexPath, 'utf8');
  const persist = f.library._persist.bind(f.library);
  f.library._persist = async () => { throw new Error('disk failure'); };
  for (const operation of [
    () => f.library.moveFolder(a, b, record),
    () => f.library.moveFolder(b, null, { ...record, beforeId: a })
  ]) {
    await assert.rejects(operation(), /disk failure/);
    assert.deepEqual(f.library.snapshot(), before);
    assert.equal(await fs.readFile(f.library.indexPath, 'utf8'), index);
  }
  f.library._persist = persist;
  await f.library.moveFolder(child, null, { ...record, afterId: a });
  assert.deepEqual(f.children(), ['A', '子级', 'B']);
});

test('folder ordering helpers retain legacy input and validate only bounded integer positions', () => {
  const folders = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', sortOrder: 2 }];
  const before = structuredClone(folders);
  assert.deepEqual(FolderTree.children(folders).map(folder => folder.id), ['a', 'b', 'c']);
  FolderTree.children(folders).reverse();
  assert.deepEqual(folders, before);
  for (const sortOrder of [-1, .5, NaN, Infinity, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => FolderTree.validate([{ id: 'a', name: 'A', sortOrder }]), /排序/);
  }
});
