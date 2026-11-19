'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { createAssetExportService } = require('../src/asset-export-service.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests');
  await fs.mkdir(parent, { recursive: true });
  const base = await fs.mkdtemp(path.join(parent, 'export-service-'));
  t.after(async () => { assert.ok(path.relative(parent, base).startsWith('export-service-')); await fs.rm(base, { recursive: true, force: true }); });
  const data = { root: path.join(base, 'library'), folders: [{ id: 'parent', name: '项目', parentId: null }, { id: 'child', name: '子级', parentId: 'parent' }],
    assets: [{ id: 'model', name: '模型新名称', ext: 'obj', hash: 'model-hash', folderId: 'child' },
      { id: 'image', name: '图片', ext: 'png', hash: 'image-hash', folderId: 'parent' }] };
  const calls = [], thumbnails = new Map();
  const library = { root: data.root, snapshot: () => structuredClone(data), flush: async () => {},
    getAssetPath: (id, kind) => kind === 'thumbnail' ? thumbnails.get(id) : path.join(base, `${id}.original`),
    exportFolder: async (id, dest, options) => { calls.push({ id, dest, options }); return { exported: 2, folders: 2, path: path.join(dest, '项目') }; },
    exportAssets: async (ids, dest, options) => { calls.push({ ids, dest, options }); return { exported: ids.length, files: [] }; } };
  const image = async filename => { await fs.mkdir(path.dirname(filename), { recursive: true }); await sharp({ create: { width: 12, height: 10, channels: 3, background: '#345678' } }).jpeg().toFile(filename); };
  let current = library;
  const config = { getLibrary: () => current, chooseDirectory: async () => ({ filePaths: [path.join(base, 'exports')] }), tempDirectory: path.join(base, 'temporary'),
    prepareModel: async (_library, _asset, filename) => image(filename), prepareProject: async () => { throw new Error('unexpected project'); } };
  return { base, data, library, config, calls, thumbnails, image, switchLibrary: () => { current = { root: 'different' }; } };
}

test('cancelled directory selection never prepares or copies and releases the export lock', async t => {
  const f = await fixture(t); let prepared = false;
  const service = createAssetExportService({ ...f.config, chooseDirectory: async () => ({ canceled: true }), prepareModel: async () => { prepared = true; } });
  assert.deepEqual(await service.exportFolder('parent', f.library.root), { cancelled: true });
  assert.equal(prepared, false); assert.equal(f.calls.length, 0); assert.equal(service.busy(), false);
});

test('a library change during the native dialog rejects before any old selection is exported', async t => {
  const f = await fixture(t);
  const service = createAssetExportService({ ...f.config, chooseDirectory: async () => { f.switchLibrary(); return { filePaths: [f.base] }; } });
  await assert.rejects(service.exportFolder('parent', f.library.root), /素材库已切换/);
  assert.equal(f.calls.length, 0); assert.equal(service.busy(), false);
});

test('a recursive export prepares a missing model thumbnail before copying and cleans temporary files', async t => {
  const f = await fixture(t), events = []; let generated;
  f.data.assets.push({ id: 'trash', name: '回收站模型', ext: 'obj', hash: 'trash', folderId: 'child', trashedAt: '2026-11-18' });
  const service = createAssetExportService({ ...f.config, onProgress: event => events.push(event), prepareModel: async (library, asset, file) => {
    assert.equal(library, f.library); assert.equal(asset.id, 'model'); generated = file; await f.image(file);
  } });
  const result = await service.exportFolder('parent', f.library.root);
  assert.equal(result.path, path.join(f.base, 'exports', '项目')); assert.equal(result.count, 2); assert.equal(result.folders, 2);
  assert.equal(f.calls[0].options.thumbnailPaths.get('model'), generated);
  assert.equal(events.filter(e => e.phase === 'preparing').length, 1);
  await assert.rejects(fs.stat(generated), { code: 'ENOENT' }); assert.equal(service.busy(), false);
});

test('valid existing thumbnails are reused and ordinary assets need no preview work', async t => {
  const f = await fixture(t); const thumbnail = path.join(f.base, 'existing.jpg'); await f.image(thumbnail); f.thumbnails.set('model', thumbnail);
  const service = createAssetExportService({ ...f.config, prepareModel: async () => { throw new Error('should reuse'); } });
  const result = await service.exportAssets(['model', 'image'], f.library.root);
  assert.equal(result.count, 2); assert.equal(f.calls[0].options.thumbnailPaths.get('model'), thumbnail);
  assert.equal(f.calls[0].options.previewNotes.size, 0);
  await fs.access(thumbnail);
});

test('AE preview publication completes before the serialized library export begins', async t => {
  const f = await fixture(t); f.data.assets[0].ext = 'aep'; let published = false;
  const service = createAssetExportService({ ...f.config, prepareProject: async (library, id, options) => {
    assert.equal(library, f.library); assert.equal(options.expectedRoot, f.library.root);
    const file = path.join(f.base, 'ae-thumbnail.jpg'); await f.image(file); f.thumbnails.set(id, file); published = true;
  } });
  await service.exportFolder('parent', f.library.root); assert.equal(published, true); assert.equal(f.calls.length, 1);
});

test('a failed preview is attempted once and export continues with a note and no thumbnail', async t => {
  const f = await fixture(t);
  let attempts = 0, partial;
  const failure = createAssetExportService({ ...f.config, prepareModel: async (_library, _asset, file) => {
    attempts++; partial = file; await fs.writeFile(file, 'partial preview'); throw new Error('没有渲染器');
  } });
  const result = await failure.exportAssets(['model'], f.library.root);
  assert.equal(result.count, 1); assert.equal(attempts, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.thumbnailPaths.get('model'), null);
  assert.match(f.calls[0].options.previewNotes.get('model'), /未附带缩略图.*没有渲染器/);
  await assert.rejects(fs.access(partial), { code: 'ENOENT' });
  assert.equal(failure.busy(), false);
});

test('invalid generated previews and unavailable AE engines do not prevent original exports', async t => {
  const f = await fixture(t); let attempts = 0;
  const invalid = createAssetExportService({ ...f.config, prepareModel: async (_library, _asset, file) => { attempts++; await fs.writeFile(file, 'not an image'); } });
  assert.equal((await invalid.exportAssets(['model'], f.library.root)).count, 1);
  assert.equal(attempts, 1); assert.equal(f.calls[0].options.thumbnailPaths.get('model'), null);
  assert.match(f.calls[0].options.previewNotes.get('model'), /未能生成可用缩略图/);
  f.data.assets[0].ext = 'aep';
  const noAe = createAssetExportService({ ...f.config, prepareProject: async () => { throw new Error('未安装 After Effects'); } });
  assert.equal((await noAe.exportAssets(['model'], f.library.root)).count, 1);
  assert.equal(f.calls[1].options.thumbnailPaths.get('model'), null);
  assert.match(f.calls[1].options.previewNotes.get('model'), /未安装 After Effects/);
});

test('changed asset identity still prevents export after preview preparation', async t => {
  const f = await fixture(t);
  const changed = createAssetExportService({ ...f.config, prepareModel: async (_library, _asset, file) => { await f.image(file); f.data.assets[0].name = '后来改名'; } });
  await assert.rejects(changed.exportAssets(['model'], f.library.root), /已变化/); assert.equal(f.calls.length, 0);
});

test('failed copying still publishes dependency checks already saved by the library', async t => {
  const f = await fixture(t), changes = [];
  f.library.exportAssets = async () => { throw new Error('导出目录不可写'); };
  const service = createAssetExportService({ ...f.config, onChanged: library => changes.push(library) });
  await assert.rejects(service.exportAssets(['image'], f.library.root), /导出目录不可写/);
  assert.deepEqual(changes, [f.library]); assert.equal(service.busy(), false);
});

test('cancellation, library switches and explicit preview aborts are never downgraded to preview notes', async t => {
  for (const scenario of ['cancel', 'switch', 'abort']) {
    const f = await fixture(t); let service;
    service = createAssetExportService({ ...f.config, prepareModel: async () => {
      if (scenario === 'cancel') service.cancel();
      else if (scenario === 'switch') f.switchLibrary();
      else throw Object.assign(new Error('preview aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
      throw new Error('preview failed after ownership changed');
    } });
    await assert.rejects(service.exportAssets(['model'], f.library.root), scenario === 'cancel' ? /导出已取消/ : scenario === 'switch' ? /素材库已切换/ : /preview aborted/);
    assert.equal(f.calls.length, 0); assert.equal(service.busy(), false);
  }
});

test('only one export may own the native dialog and a rejected duplicate does not unlock it', async t => {
  const f = await fixture(t); let finishDialog;
  const service = createAssetExportService({ ...f.config, chooseDirectory: () => new Promise(resolve => { finishDialog = resolve; }) });
  const pending = service.exportFolder('parent', f.library.root);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.exportAssets(['image'], f.library.root), /正在导出/); assert.equal(service.busy(), true);
  finishDialog({ canceled: true }); await pending; assert.equal(service.busy(), false);
});

test('temporary cleanup removes only the generated image and preserves unrelated files', async t => {
  const f = await fixture(t); let generated;
  const service = createAssetExportService({ ...f.config, prepareModel: async (_library, _asset, file) => {
    generated = file; await f.image(file); await fs.writeFile(path.join(path.dirname(file), 'unrelated.txt'), 'retain');
  } });
  await service.exportAssets(['model'], f.library.root);
  await assert.rejects(fs.stat(generated), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(path.dirname(generated), 'unrelated.txt'), 'utf8'), 'retain');
});

test('temporary cleanup does not remove a replacement directory at the same path', async t => {
  const f = await fixture(t); let directory;
  f.library.exportAssets = async (_ids, _dest, options) => {
    directory = path.dirname(options.thumbnailPaths.get('model'));
    await fs.rename(directory, `${directory}-original`); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, '0.jpg'), 'replacement');
    return { exported: 1 };
  };
  await createAssetExportService(f.config).exportAssets(['model'], f.library.root);
  assert.equal(await fs.readFile(path.join(directory, '0.jpg'), 'utf8'), 'replacement');
});
