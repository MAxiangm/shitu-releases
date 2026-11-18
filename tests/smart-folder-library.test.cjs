'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Library } = require('../src/library.cjs');
const { LibraryManager } = require('../src/library-manager.cjs');
const SmartFolders = require('../src/smart-folders.js');
const root = path.resolve(__dirname, '../.recovery/tests');
async function fixture(t) {
  await fs.mkdir(root, { recursive: true }); const directory = await fs.mkdtemp(path.join(root, 'smart-folders-'));
  t.after(async () => { const relative = path.relative(root, directory); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(directory, { recursive: true, force: true }); });
  const library = new Library({ root: path.join(directory, 'library') }); await library.init(); return { directory, library };
}

test('legacy libraries expose empty smart folders without rewriting their index', async t => {
  const { library } = await fixture(t);
  const legacy = JSON.stringify({ version: 1, assets: [], folders: [] }); await fs.writeFile(library.indexPath, legacy);
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.deepEqual(reopened.snapshot().smartFolders, []);
  assert.equal(await fs.readFile(library.indexPath, 'utf8'), legacy);
});

test('smart folder rules survive reopen, backup, migration, editing and deletion without moving originals', async t => {
  const { directory, library } = await fixture(t);
  const bytes = Buffer.from('original video for smart rule persistence'), source = path.join(directory, 'source.mp4'); await fs.writeFile(source, bytes);
  const imported = await library.importPaths([source]), asset = library.snapshot().assets.find(item => item.id === imported.assetIds[0]);
  const beforeAsset = structuredClone(asset), beforeFolders = library.snapshot().folders;
  const saved = await library.saveSmartFolder({ name: '红色视频', rule: { mediaType: 'video', colorLabel: 'red', recentDays: 7 } }), rule = saved.smartFolders[0];
  assert.equal(rule.name, '红色视频'); assert.ok(rule.id); assert.equal(rule.rule.favorite, false);
  assert.deepEqual(saved.assets, [beforeAsset]); assert.deepEqual(saved.folders, beforeFolders);
  const reopened = new Library({ root: library.root }); await reopened.init(); assert.deepEqual(reopened.snapshot().smartFolders, [rule]);
  const backup = await library.backupTo(path.join(directory, 'backup'));
  const restored = new Library({ root: backup.path }); await restored.init(); assert.deepEqual(restored.snapshot().smartFolders, [rule]);
  assert.deepEqual(await fs.readFile(restored.getAssetPath(asset.id)), bytes);
  const manager = new LibraryManager({ configPath: path.join(directory, 'config', 'location.json') }); await manager.init(); await manager.open(library.root);
  const destination = path.join(directory, 'migrated'); await fs.mkdir(destination); const migrated = await manager.migrate(destination);
  assert.deepEqual(migrated.snapshot().smartFolders, [rule]);
  const edited = await migrated.saveSmartFolder({ id: rule.id, name: '近期字体', rule: { mediaType: 'font', recentDays: 30 } });
  assert.equal(edited.smartFolders[0].id, rule.id); assert.equal(edited.smartFolders[0].rule.mediaType, 'font');
  assert.deepEqual((await migrated.deleteSmartFolder(rule.id)).smartFolders, []);
  assert.deepEqual(await fs.readFile(migrated.getAssetPath(asset.id)), bytes); assert.deepEqual(await fs.readFile(source), bytes);
  assert.deepEqual(library.snapshot().assets, [beforeAsset]); assert.deepEqual(library.snapshot().smartFolders, [rule]);
});

test('smart rule membership follows metadata changes, import and trash without materializing folder assignment', async t => {
  const { directory, library } = await fixture(t);
  const first = path.join(directory, 'one.mp4'); await fs.writeFile(first, 'first original'); const firstImport = await library.importPaths([first]); const id = firstImport.assetIds[0];
  const saved = await library.saveSmartFolder({ name: '红色视频', rule: { mediaType: 'video', colorLabel: 'red' } });
  const matches = () => library.snapshot().assets.filter(SmartFolders.compile(saved.smartFolders[0].rule)).map(item => item.id);
  assert.deepEqual(matches(), []); await library.updateAssets([id], { colorLabel: 'red' }); assert.deepEqual(matches(), [id]);
  await library.setTrash([id], true); assert.deepEqual(matches(), []); await library.setTrash([id], false); assert.deepEqual(matches(), [id]);
  const second = path.join(directory, 'two.mp4'); await fs.writeFile(second, 'second original'); const secondImport = await library.importPaths([second]); await library.updateAssets(secondImport.assetIds, { colorLabel: 'red' });
  assert.deepEqual(matches().sort(), [id, ...secondImport.assetIds].sort());
  assert.ok(library.snapshot().assets.every(item => item.folderId === null)); assert.deepEqual(library.snapshot().folders, []);
  assert.deepEqual(library.snapshot().smartFolders, saved.smartFolders);
});

test('invalid smart rules and failed persistence leave saved rules and originals unchanged', async t => {
  const { library } = await fixture(t);
  const saved = await library.saveSmartFolder({ name: 'My Rule', rule: {} }), before = await fs.readFile(library.indexPath, 'utf8');
  for (const input of [{ name: '', rule: {} }, { name: 'MY RULE', rule: {} }, { id: 'missing', name: 'Missing', rule: {} }, { name: 'Invalid', rule: { mediaType: 'unsupported' } }, { name: 'Unknown field', rule: { folderId: 'id' } }]) await assert.rejects(library.saveSmartFolder(input));
  await assert.rejects(library.deleteSmartFolder('missing'));
  assert.equal(await fs.readFile(library.indexPath, 'utf8'), before); assert.deepEqual(library.snapshot().smartFolders, saved.smartFolders);
  const originalPersist = library._persist; library._persist = async () => { throw new Error('simulated write failure'); };
  await assert.rejects(library.saveSmartFolder({ id: saved.smartFolders[0].id, name: 'Changed', rule: {} }), /simulated/);
  await assert.rejects(library.deleteSmartFolder(saved.smartFolders[0].id), /simulated/); library._persist = originalPersist;
  assert.deepEqual(library.snapshot().smartFolders, saved.smartFolders); assert.equal(await fs.readFile(library.indexPath, 'utf8'), before);
});
