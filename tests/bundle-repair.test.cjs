'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { Library } = require('../src/library.cjs');
const { createBundleRepair } = require('../src/bundle-repair.cjs');

const testsRoot = path.resolve(__dirname, '..', '.recovery', 'tests');

async function fixture(t) {
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'bundle-repair-'));
  t.after(async () => {
    const relative = path.relative(testsRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const original = path.join(directory, 'source'), replacements = path.join(directory, 'assets');
  await fs.mkdir(original);
  for (const folder of ['Textures', 'Other']) await fs.mkdir(path.join(replacements, folder), { recursive: true });
  const originalBytes = Buffer.from(JSON.stringify({ asset: { version: '2.0' },
    images: [{ uri: 'Textures/front%202.png' }, { uri: 'Tint.png' }, { uri: 'unavailable.png' }] }));
  const file = path.join(original, 'model.gltf');
  await fs.writeFile(file, originalBytes);
  await fs.writeFile(path.join(replacements, 'Textures', 'front 2.png'), 'chosen front texture');
  await fs.writeFile(path.join(replacements, 'Other', 'front 2.png'), 'other front texture');
  for (const folder of ['Textures', 'Other']) await fs.writeFile(path.join(replacements, folder, 'Tint.png'), folder);
  const library = new Library({ root: path.join(directory, 'library') });
  await library.init();
  const folder = (await library.createFolder('模型')).folders[0];
  const imported = await library.importPaths([file], { folderId: folder.id });
  const id = imported.assetIds[0];
  await library.updateAssets([id], { tags: ['保留'], notes: '原备注', rating: 4, name: '已整理素材' });
  const service = createBundleRepair({ cacheDir: path.join(directory, 'cache'), currentLibrary: () => library });
  return { directory, library, service, id, file, replacements, folder, originalBytes };
}

test('model repair confirms path-specific matches, preserves metadata, and exports the original model with repaired companions', async t => {
  const { library, service, id, file, replacements, folder, originalBytes, directory } = await fixture(t);
  const plan = await service.plan(library, id, replacements);
  assert.deepEqual(plan.rows, [
    { reference: 'Textures/front%202.png', status: 'matched', file: 'Textures/front 2.png' },
    { reference: 'Tint.png', status: 'ambiguous' },
    { reference: 'unavailable.png', status: 'missing' }
  ]);
  const previous = library.snapshot().assets[0];
  const result = await service.apply(library, id, plan.token);
  const updated = result.snapshot.assets[0];
  assert.equal(result.repaired, 1); assert.equal(result.missing, 2);
  assert.equal(updated.id, id); assert.equal(updated.folderId, folder.id);
  for (const field of ['name', 'tags', 'notes', 'rating', 'createdAt']) assert.deepEqual(updated[field], previous[field]);
  assert.notEqual(updated.hash, previous.hash);
  assert.deepEqual(updated.modelBundle.missing, ['Tint.png', 'unavailable.png']);
  assert.deepEqual(await fs.readFile(file), originalBytes);
  const output = (await library.exportAssets([id], path.join(directory, 'export'))).files[0];
  assert.deepEqual(await fs.readFile(path.join(output, 'model.gltf')), originalBytes);
  assert.equal(await fs.readFile(path.join(output, 'Textures', 'front 2.png'), 'utf8'), 'chosen front texture');
  assert.equal((await fs.readdir(library.root)).some(name => name.startsWith('.pending-repair-')), false);
  const backup = JSON.parse(await fs.readFile(path.join(library.root, 'index.backup.json'), 'utf8'));
  assert.equal(backup.assets[0].hash, updated.hash);
  const reopened = new Library({ root: library.root });
  assert.equal((await reopened.init()).assets[0].hash, updated.hash);
});

test('model repair rejects files changed after confirmation and restores the original if catalogue publication fails', async t => {
  const { library, service, id, replacements } = await fixture(t);
  const old = library.snapshot().assets[0];
  const stale = await service.plan(library, id, replacements);
  await fs.writeFile(path.join(replacements, 'Textures', 'front 2.png'), 'changed after preview');
  await assert.rejects(service.apply(library, id, stale.token), /已变化/);
  const next = await service.plan(library, id, replacements);
  const rename = fs.rename;
  fs.rename = async (source, target) => {
    if (target === library.indexPath) throw new Error('injected catalogue failure');
    return rename(source, target);
  };
  try { await assert.rejects(service.apply(library, id, next.token), /catalogue failure/); }
  finally { fs.rename = rename; }
  assert.deepEqual(library.snapshot().assets[0], old);
  const backup = JSON.parse(await fs.readFile(path.join(library.root, 'index.backup.json'), 'utf8'));
  assert.equal(backup.assets[0].hash, old.hash);
  assert.deepEqual(await fs.readdir(library.getModelBundleDirectory(id)), ['model.gltf']);
  assert.equal((await fs.readdir(library.root)).some(name => name.startsWith('.pending-repair-')), false);
  const retry = await service.plan(library, id, replacements);
  assert.equal((await service.apply(library, id, retry.token)).repaired, 1);
});
