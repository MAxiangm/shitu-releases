'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Library } = require('../src/library.cjs');
const { LibraryManager } = require('../src/library-manager.cjs');

const fixturesRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
async function fixture(t) {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixturesRoot, 'library-safety-'));
  t.after(async () => {
    const relative = path.relative(fixturesRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const library = new Library({ root: path.join(directory, 'library') });
  await library.init();
  return { directory, library };
}

async function temporaryNamedDependency(directory, library) {
  const source = path.join(directory, 'source');
  await fs.mkdir(source);
  const filename = path.join(source, 'model.obj');
  const material = Buffer.from('newmtl test\nKd 0.2 0.4 0.8\n');
  await fs.writeFile(filename, 'mtllib material.tmp\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl test\nf 1 2 3\n');
  await fs.writeFile(path.join(source, 'material.tmp'), material);
  const report = await library.importPaths([source]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.imported, 1);
  const id = report.assetIds[0];
  assert.ok(library.snapshot().assets[0].modelBundle.files.some(file => file.path === 'material.tmp'));
  return { id, material };
}

test('backup preserves legitimate .tmp resource dependencies and omits only index-write temporaries', async t => {
  const f = await fixture(t);
  const { id, material } = await temporaryNamedDependency(f.directory, f.library);
  const temporary = 'index.json.00000000-0000-4000-8000-000000000001.tmp';
  await fs.writeFile(path.join(f.library.root, temporary), 'incomplete index');
  const backup = await f.library.backupTo(path.join(f.directory, 'backups'));
  const reopened = new Library({ root: backup.path });
  await reopened.init();
  assert.deepEqual(await fs.readFile(reopened.getModelFilePath(id, 'material.tmp')), material);
  await assert.rejects(fs.access(path.join(backup.path, temporary)), { code: 'ENOENT' });
});

test('migration preserves legitimate .tmp resource dependencies and original library', async t => {
  const f = await fixture(t);
  const { id, material } = await temporaryNamedDependency(f.directory, f.library);
  const destination = path.join(f.directory, 'migrated');
  await fs.mkdir(destination);
  const manager = new LibraryManager({ configPath: path.join(f.directory, 'location.json'), overrideRoot: f.library.root });
  await manager.init();
  const migrated = await manager.migrate(destination);
  assert.notEqual(migrated.root, f.library.root);
  assert.deepEqual(await fs.readFile(migrated.getModelFilePath(id, 'material.tmp')), material);
  assert.deepEqual(await fs.readFile(f.library.getModelFilePath(id, 'material.tmp')), material);
});

test('ordinary file imports reject a managed originals directory replaced by a junction', async t => {
  const f = await fixture(t);
  const source = path.join(f.directory, 'source.txt');
  await fs.writeFile(source, 'A new managed original must remain inside the library.');
  const outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside);
  const originals = path.join(f.library.root, 'originals');
  await fs.rmdir(originals);
  await fs.symlink(outside, originals, process.platform === 'win32' ? 'junction' : 'dir');
  const report = await f.library.importPaths([source]);
  assert.equal(report.imported, 0);
  assert.match(report.errors[0]?.message || '', /符号链接|目录/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(f.library.snapshot().assets.length, 0);
  await assert.rejects(new Library({ root: f.library.root }).init(), /符号链接/);
});

test('thumbnail imports cannot write through a managed directory junction and roll back their new original', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside);
  const thumbnails = path.join(f.library.root, 'thumbnails');
  await fs.rmdir(thumbnails);
  await fs.symlink(outside, thumbnails, process.platform === 'win32' ? 'junction' : 'dir');
  const source = path.join(f.directory, 'source.txt');
  await fs.writeFile(source, 'Source survives failed preview creation.');
  let calls = 0;
  f.library.createThumbnail = async (_source, destination) => { calls++; await fs.writeFile(destination, 'preview'); };
  const report = await f.library.importPaths([source]);
  assert.equal(report.imported, 0);
  assert.equal(calls, 0);
  assert.match(report.errors[0]?.message || '', /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(path.join(f.library.root, 'originals')), []);
  assert.equal(await fs.readFile(source, 'utf8'), 'Source survives failed preview creation.');
});

test('saving library metadata never overwrites an unrelated file hard-linked as the index backup', async t => {
  const f = await fixture(t);
  const unrelated = path.join(f.directory, 'unrelated-document.txt');
  const bytes = Buffer.from('This file must not be overwritten while saving the library.');
  await fs.writeFile(unrelated, bytes);
  await fs.link(unrelated, path.join(f.library.root, 'index.backup.json'));
  await f.library.createFolder('Saved safely');
  assert.deepEqual(await fs.readFile(unrelated), bytes);
  const backup = JSON.parse(await fs.readFile(path.join(f.library.root, 'index.backup.json'), 'utf8'));
  assert.deepEqual(backup.folders, []);
  assert.equal((await new Library({ root: f.library.root }).init()).folders[0].name, 'Saved safely');
});

test('switching libraries never overwrites an unrelated file hard-linked as the locator backup', async t => {
  const f = await fixture(t);
  const configPath = path.join(f.directory, 'library-location.json');
  const manager = new LibraryManager({ configPath });
  await manager.open(f.library.root);
  const previousConfig = await fs.readFile(configPath);
  const unrelated = path.join(f.directory, 'unrelated-settings.txt');
  const bytes = Buffer.from('Keep all external settings intact.');
  await fs.writeFile(unrelated, bytes);
  await fs.link(unrelated, `${configPath}.backup`);
  const parent = path.join(f.directory, 'other-libraries');
  await fs.mkdir(parent);
  await manager.create(parent, 'New library');
  assert.deepEqual(await fs.readFile(unrelated), bytes);
  assert.deepEqual(await fs.readFile(`${configPath}.backup`), previousConfig);
});

test('interrupted index-backup writes retain the complete previous backup and active index', async t => {
  const f = await fixture(t);
  await f.library.createFolder('First saved folder');
  const backupPath = path.join(f.library.root, 'index.backup.json');
  const oldBackup = await fs.readFile(backupPath), oldIndex = await fs.readFile(f.library.indexPath);
  const oldSnapshot = f.library.snapshot(), copyFile = fs.copyFile;
  fs.copyFile = async (source, destination, ...args) => {
    if (destination === backupPath || String(destination).startsWith(`${backupPath}.`)) {
      await fs.writeFile(destination, '{partial');
      throw Object.assign(new Error('Fixture disk is full'), { code: 'ENOSPC' });
    }
    return copyFile(source, destination, ...args);
  };
  try { await assert.rejects(f.library.createFolder('Must not commit'), /disk is full/); }
  finally { fs.copyFile = copyFile; }
  assert.deepEqual(f.library.snapshot(), oldSnapshot);
  assert.deepEqual(await fs.readFile(backupPath), oldBackup);
  assert.deepEqual(await fs.readFile(f.library.indexPath), oldIndex);
  assert.deepEqual((await fs.readdir(f.library.root)).filter(name => name.endsWith('.tmp')), []);
});
