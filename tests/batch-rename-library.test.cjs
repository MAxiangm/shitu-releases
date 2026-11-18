'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Library } = require('../src/library.cjs');
const { MetadataHistory } = require('../src/metadata-history.cjs');
const { plan } = require('../src/batch-rename.js');
const record = { recordHistory: true };

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'batch-rename-library-'));
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (_source, destination) => {
    await fs.writeFile(destination, 'fixture-thumbnail'); return { width: 10, height: 10 };
  } });
  await library.init();
  t.after(async () => {
    await library.flush(); const relative = path.relative(parent, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const name of ['Zulu', 'Alpha', 'Bravo']) {
    const file = path.join(directory, `${name}.png`); await fs.writeFile(file, `original-${name}`);
    await library.importPaths([file]);
  }
  const assets = library.snapshot().assets;
  const originals = await Promise.all(assets.map(async asset => ({ id: asset.id, filename: asset.filename, thumbnail: asset.thumbnail,
    bytes: await fs.readFile(library.getAssetPath(asset.id)), preview: await fs.readFile(library.getAssetPath(asset.id, 'thumbnail')) })));
  return { library, directory, assets, originals };
}
const namesById = snapshot => Object.fromEntries(snapshot.assets.map(asset => [asset.id, asset.name]));

test('different batch names follow planner order and undo/redo as exactly one operation', async t => {
  const f = await fixture(t), ordered = [f.assets[2], f.assets[0], f.assets[1]];
  const changes = plan(ordered, { prefix: '项目-', numbering: true, start: 7, digits: 3, numberMode: 'replace' }).changes;
  const renamed = await f.library.batchRenameAssets(changes, record);
  assert.deepEqual(ordered.map(asset => renamed.assets.find(item => item.id === asset.id).name), ['项目-007', '项目-008', '项目-009']);
  assert.equal(renamed.history.undoCount, 1); assert.equal(renamed.history.undoLabel, '重命名 3 个素材');
  const undoId = renamed.history.undoId;
  const undone = await f.library.undo({ expectedId: undoId });
  assert.deepEqual(namesById(undone), namesById({ assets: f.assets })); assert.equal(undone.history.redoCount, 1);
  const redone = await f.library.redo({ expectedId: undoId });
  assert.deepEqual(namesById(redone), namesById(renamed)); assert.equal(redone.history.undoCount, 1);
  for (const original of f.originals) {
    const current = redone.assets.find(asset => asset.id === original.id);
    assert.equal(current.filename, original.filename); assert.equal(current.thumbnail, original.thumbnail);
    assert.deepEqual(await fs.readFile(f.library.getAssetPath(current.id)), original.bytes);
    assert.deepEqual(await fs.readFile(f.library.getAssetPath(current.id, 'thumbnail')), original.preview);
  }
  const reopened = new Library({ root: f.library.root }); await reopened.init();
  assert.deepEqual(namesById(reopened.snapshot()), namesById(renamed));
});

test('a stale member, duplicate ID or invalid rename rejects the entire batch without any persisted change', async t => {
  const f = await fixture(t), valid = plan(f.assets, { prefix: 'New-' }).changes;
  const before = f.library.snapshot(), bytes = await fs.readFile(f.library.indexPath);
  const variants = [
    [valid[0], { ...valid[1], beforeName: 'outdated name' }],
    [valid[0], { ...valid[1], hash: '0'.repeat(64) }],
    [valid[0], { ...valid[1], id: 'missing' }],
    [valid[0], { ...valid[0] }],
    [valid[0], { ...valid[1], name: ' ' }],
    [valid[0], { ...valid[1], name: 'x'.repeat(241) }],
    [valid[0], { ...valid[1], name: 'bad\nname' }],
    [valid[0], { ...valid[1], filename: 'overwrite.png' }]
  ];
  for (const changes of variants) {
    await assert.rejects(f.library.batchRenameAssets(changes, record));
    assert.deepEqual(f.library.snapshot(), before); assert.deepEqual(await fs.readFile(f.library.indexPath), bytes);
  }
});

test('queued trash invalidates the complete rename and leaves other selected assets unchanged', async t => {
  const f = await fixture(t), changes = plan(f.assets, { suffix: '-rename' }).changes;
  const trash = f.library.setTrash([f.assets[1].id], true);
  const rename = f.library.batchRenameAssets(changes, record);
  await trash; await assert.rejects(rename, /素材已变化/);
  assert.deepEqual(namesById(f.library.snapshot()), namesById({ assets: f.assets }));
  assert.equal(f.library.historyState().canUndo, false);
});

test('failed persistence keeps names, index bytes and both undo stacks unchanged', async t => {
  const f = await fixture(t);
  await f.library.updateAssets([f.assets[0].id], { notes: 'keep history' }, record); await f.library.undo();
  const before = f.library.snapshot(), bytes = await fs.readFile(f.library.indexPath), persist = f.library._persist;
  f.library._persist = async () => { throw new Error('simulated disk failure'); };
  try { await assert.rejects(f.library.batchRenameAssets(plan(f.assets, { prefix: 'New-' }).changes, record), /simulated disk failure/); }
  finally { f.library._persist = persist; }
  assert.deepEqual(f.library.snapshot(), before); assert.deepEqual(await fs.readFile(f.library.indexPath), bytes);
  assert.equal(f.library.historyState().canRedo, true);
});

test('no-op names do not write a new history entry or discard an existing redo', async t => {
  const f = await fixture(t);
  await f.library.updateAssets([f.assets[0].id], { notes: 'keep history' }, record); await f.library.undo();
  const before = f.library.snapshot(), bytes = await fs.readFile(f.library.indexPath);
  const result = await f.library.batchRenameAssets(f.assets.map(asset => ({ id: asset.id, name: asset.name, beforeName: asset.name, hash: asset.hash })), record);
  assert.deepEqual(result, before); assert.deepEqual(await fs.readFile(f.library.indexPath), bytes);
});

test('an oversized rename is rejected so an accepted rename always has its undo record', async t => {
  const f = await fixture(t); f.library._history = new MetadataHistory({ maxBytes: 100 });
  const before = f.library.snapshot(), bytes = await fs.readFile(f.library.indexPath);
  await assert.rejects(f.library.batchRenameAssets(plan(f.assets, { prefix: 'New-' }).changes, record), /保留撤销记录/);
  assert.deepEqual(f.library.snapshot(), before); assert.deepEqual(await fs.readFile(f.library.indexPath), bytes);
});
