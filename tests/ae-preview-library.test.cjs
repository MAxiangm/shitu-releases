'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Library } = require('../src/library.cjs');
const { projectBundleHash, validateProjectBundle } = require('../src/project-bundle.cjs');
const { createAEPreviewService } = require('../src/ae-preview-service.cjs');
const fixturesRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
const composition = { id: 24, index: 2, name: '主合成', width: 1920, height: 1080, duration: 12, frameRate: 24, workAreaStart: 1, workAreaDuration: 10, usedInCount: 0 };
const other = { ...composition, id: 27, index: 3, name: '片尾', duration: 4 };
const jpeg = value => Buffer.from([0xff, 0xd8, 0xff, 0xe0, value, 0xff, 0xd9]);
async function fixture(t, { legacy = false } = {}) {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(fixturesRoot, 'ae-preview-library-'));
  t.after(async () => {
    const relative = path.relative(fixturesRoot, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  const source = path.join(base, '工程.aep'); await fs.writeFile(source, 'synthetic AE project');
  const library = new Library({ root: path.join(base, 'library'), prepareProjectBundle: async filename => {
    const directory = await fs.mkdtemp(path.join(base, 'stage-'));
    const bytes = await fs.readFile(filename), entry = path.basename(filename);
    await fs.writeFile(path.join(directory, entry), bytes);
    const files = [{ path: entry, size: bytes.length, hash: crypto.createHash('sha256').update(bytes).digest('hex') }];
    return { directory, manifest: { version: 1, entry, files, missing: [], warnings: [], hash: projectBundleHash(files, entry),
      size: bytes.length, ...(legacy ? {} : { compositions: [composition, other] }) }, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } });
  await library.init(); await library.importPaths([source]);
  const asset = library.snapshot().assets[0], thumbnailPath = path.join(base, 'thumbnail.jpg');
  await fs.writeFile(thumbnailPath, jpeg(1));
  return { base, library, asset, thumbnailPath };
}
function metadata(asset, selected = composition) {
  return { version: 1, sourceHash: asset.hash, composition: selected, width: selected.width, height: selected.height,
    duration: selected.duration, frameRate: selected.frameRate, generatedAt: new Date().toISOString() };
}
async function publish(item, extra = {}) {
  return item.library.publishProjectPreview(item.asset.id, { expectedRoot: item.library.root, expectedHash: item.asset.hash,
    thumbnailPath: item.thumbnailPath, preview: metadata(item.asset), ...extra });
}
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
function fakeEngine(item, { gate } = {}) {
  const calls = [], outputs = [];
  const engine = { calls, outputs, stopped: false, async preview(options) {
    calls.push(options);
    if (gate) await gate.promise;
    const selected = options.compositionId === other.id ? other : composition, serial = calls.length;
    const thumbnailPath = path.join(item.base, `cover-${serial}.jpg`);
    await fs.writeFile(thumbnailPath, jpeg(serial));
    const output = { thumbnailPath, composition: selected, compositions: [composition, other],
      metadata: { width: selected.width / 2, height: selected.height / 2, duration: selected.duration, sourceDuration: selected.duration, frameRate: selected.frameRate }, warnings: ['测试警告'] };
    outputs.push(output); return output;
  }, async shutdown() { engine.stopped = true; } };
  return engine;
}

test('AE composition metadata survives storage and preview thumbnail publication leaves the source package unchanged', async t => {
  const item = await fixture(t), original = await fs.readFile(item.library.getAssetPath(item.asset.id));
  const manifest = structuredClone(item.asset.projectBundle);
  const result = await publish(item), updated = result.assets[0];
  assert.equal(updated.thumbnail, `thumbnails/${item.asset.id}.jpg`);
  assert.deepEqual(updated.projectBundle, manifest); assert.equal(updated.hash, item.asset.hash);
  assert.equal(updated.projectPreview.composition.id, composition.id); assert.equal(updated.duration, 12);
  assert.deepEqual(await fs.readFile(item.library.getAssetPath(item.asset.id)), original);
  assert.deepEqual(await fs.readFile(item.library.getAssetPath(item.asset.id, 'thumbnail')), jpeg(1));
  assert.ok(!JSON.stringify(updated.projectPreview).includes(item.base));
  const reopened = new Library({ root: item.library.root }); await reopened.init();
  assert.deepEqual(reopened.snapshot().assets[0].projectBundle.compositions, [composition, other]);
  assert.equal(reopened.snapshot().assets[0].projectPreview.sourceHash, manifest.hash);
  const exported = await reopened.exportAssets([item.asset.id], path.join(item.base, 'export'));
  assert.deepEqual(await fs.readdir(exported.files[0]), [manifest.entry]);
  assert.deepEqual(await fs.readFile(path.join(exported.files[0], manifest.entry)), original);
});

test('invalid composition metadata is rejected while existing packages without compositions remain valid', async t => {
  const item = await fixture(t, { legacy: true });
  validateProjectBundle(item.asset.projectBundle);
  assert.throws(() => validateProjectBundle({ ...item.asset.projectBundle, compositions: [{ ...composition, id: '../escape' }] }), /合成/);
  assert.throws(() => validateProjectBundle({ ...item.asset.projectBundle, compositions: [composition, composition] }), /合成/);
  assert.throws(() => validateProjectBundle({ ...item.asset.projectBundle, compositions: [{ ...composition, frameRate: Infinity }] }), /合成/);
});

test('late project results cannot publish into a different root, changed asset or trashed asset', async t => {
  const item = await fixture(t);
  assert.equal(await publish(item, { expectedRoot: path.join(item.base, 'different') }), null);
  assert.equal(await publish(item, { expectedHash: '0'.repeat(64) }), null);
  assert.equal(await item.library.publishProjectPreview('missing', { expectedRoot: item.library.root, expectedHash: item.asset.hash }), null);
  await item.library.setTrash([item.asset.id], true);
  assert.equal(await publish(item), null);
  assert.deepEqual(await fs.readdir(path.join(item.library.root, 'thumbnails')), []);
});

test('failed index persistence restores the previous thumbnail and leaves no partial preview metadata', async t => {
  const item = await fixture(t); await publish(item);
  const previous = item.library.snapshot().assets[0];
  await fs.writeFile(item.thumbnailPath, jpeg(2));
  const persist = item.library._persist;
  item.library._persist = async () => { throw new Error('synthetic disk failure'); };
  await assert.rejects(publish(item), /synthetic disk failure/);
  item.library._persist = persist;
  assert.deepEqual(item.library.snapshot().assets[0], previous);
  assert.deepEqual(await fs.readFile(item.library.getAssetPath(item.asset.id, 'thumbnail')), jpeg(1));
  assert.deepEqual(await fs.readdir(path.join(item.library.root, 'thumbnails')), [`${item.asset.id}.jpg`]);
});

test('project thumbnail rejects unsafe or invalid files and an aborted publication', async t => {
  const item = await fixture(t);
  await fs.writeFile(item.thumbnailPath, 'not a jpeg');
  await assert.rejects(publish(item), /JPEG/);
  const link = path.join(item.base, 'linked.jpg');
  try { await fs.symlink(item.thumbnailPath, link); await assert.rejects(publish(item, { thumbnailPath: link }), /缩略图文件/); }
  catch (error) { if (!['EPERM', 'ENOTSUP'].includes(error.code)) throw error; }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(publish(item, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(item.library.snapshot().assets[0].thumbnail, null);
});

test('background and immediate default static requests deduplicate and authorize only the preview image', async t => {
  const item = await fixture(t), engine = fakeEngine(item), progress = [], changed = [];
  const service = createAEPreviewService({ engine, getLibrary: () => item.library,
    onProgress: (_library, detail) => progress.push(detail), onChanged: (_library, snapshot) => changed.push(snapshot) });
  t.after(() => service.shutdown());
  service.scheduleLibrary(item.library);
  const [first, second] = await Promise.all([service.prepare(item.library, item.asset.id, { expectedRoot: item.library.root }), service.prepare(item.library, item.asset.id)]);
  assert.equal(engine.calls.length, 1); assert.deepEqual(first, second); assert.equal(first.status, 'ready');
  assert.equal(first.width, composition.width); assert.equal(first.height, composition.height);
  assert.deepEqual(first.warnings, ['测试警告']); assert.equal(changed.length, 1);
  assert.equal(first.compositions.length, 2); assert.ok(!JSON.stringify(first).includes(item.base));
  assert.ok(progress.some(detail => detail.status === 'queued')); assert.equal(service.state(item.library, item.asset.id).status, 'ready');
  assert.equal(first.url, undefined);
  const response = await service.response(new Request(first.thumbnailUrl, { headers: { range: 'bytes=0-3' } }));
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg(1).subarray(0, 4));
  assert.equal((await service.response(new Request(first.thumbnailUrl))).headers.get('content-type'), 'image/jpeg');
  for (const url of [first.thumbnailUrl + '?path=C:/secret', first.thumbnailUrl.replace('thumbnail.jpg', 'video.webm'), first.thumbnailUrl.replace('thumbnail.jpg', '%2e%2e/index.json')])
    assert.equal((await service.response(new Request(url))).status, 404);
  assert.equal((await service.response(new Request(first.thumbnailUrl, { method: 'POST' }))).status, 404);
});

test('selecting a different composition keeps the main composition gallery thumbnail and source hash', async t => {
  const item = await fixture(t), engine = fakeEngine(item), service = createAEPreviewService({ engine, getLibrary: () => item.library });
  t.after(() => service.shutdown());
  await service.prepare(item.library, item.asset.id);
  const before = item.library.snapshot().assets[0], cover = await fs.readFile(item.library.getAssetPath(item.asset.id, 'thumbnail'));
  const selected = await service.prepare(item.library, item.asset.id, { compositionId: other.id });
  assert.equal(selected.composition.id, other.id); assert.equal(engine.calls.length, 2);
  assert.deepEqual(item.library.snapshot().assets[0], before);
  assert.deepEqual(await fs.readFile(item.library.getAssetPath(item.asset.id, 'thumbnail')), cover);
});

test('legacy AE assets are scanned lazily and missing cached output is regenerated', async t => {
  const item = await fixture(t, { legacy: true }), engine = fakeEngine(item), service = createAEPreviewService({ engine, getLibrary: () => item.library });
  t.after(() => service.shutdown());
  assert.deepEqual(service.state(item.library, item.asset.id).compositions, []);
  const first = await service.prepare(item.library, item.asset.id);
  assert.equal(engine.calls[0].compositions, undefined); assert.equal(first.compositions.length, 2);
  assert.equal(item.library.snapshot().assets[0].projectBundle.compositions, undefined);
  await fs.unlink(engine.outputs[0].thumbnailPath);
  await service.prepare(item.library, item.asset.id);
  assert.equal(engine.calls.length, 2);
});

test('a corrupt existing preview cache is rejected and a manual retry regenerates its image', async t => {
  const item = await fixture(t), engine = fakeEngine(item), service = createAEPreviewService({ engine, getLibrary: () => item.library });
  t.after(() => service.shutdown());
  const first = await service.prepare(item.library, item.asset.id);
  await fs.writeFile(engine.outputs[0].thumbnailPath, 'overwritten cache bytes');
  const regenerated = await service.prepare(item.library, item.asset.id);
  assert.equal(engine.calls.length, 2, 'An existing path with corrupt contents must reach engine cache validation again');
  assert.notEqual(regenerated.thumbnailUrl, first.thumbnailUrl);
  assert.equal((await service.response(new Request(first.thumbnailUrl))).status, 404);
  const image = await service.response(new Request(regenerated.thumbnailUrl));
  assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg(2));
  assert.deepEqual(await fs.readFile(item.library.getAssetPath(item.asset.id, 'thumbnail')), jpeg(2));
});

test('background failures are not retried by later imports until a manual request or new session', async t => {
  const item = await fixture(t), engine = fakeEngine(item), render = engine.preview;
  let attempts = 0, fail = true;
  engine.preview = async options => { attempts++; if (fail) throw new Error('After Effects fixture unavailable'); return render(options); };
  const service = createAEPreviewService({ engine, getLibrary: () => item.library });
  t.after(() => service.shutdown());
  const waitForError = async () => {
    const deadline = Date.now() + 2000;
    while (service.state(item.library, item.asset.id)?.status !== 'error') {
      if (Date.now() > deadline) throw new Error('Background AE error was not reported');
      await new Promise(resolve => setImmediate(resolve));
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  service.scheduleLibrary(item.library); await waitForError();
  assert.equal(attempts, 1); assert.equal(item.library.snapshot().assets[0].thumbnail, null);
  service.scheduleLibrary(item.library); service.schedule(item.library, item.asset.id); service.scheduleLibrary(item.library);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1, 'Unrelated imports must not restart a failed native AE preview');
  service.invalidate(); service.scheduleLibrary(item.library); await waitForError();
  assert.equal(attempts, 2, 'Opening a new library session may retry a previous background failure');
  fail = false;
  const prepared = await service.prepare(item.library, item.asset.id);
  assert.equal(attempts, 3); assert.equal(prepared.status, 'ready');
  assert.ok(item.library.snapshot().assets[0].thumbnail);
});

test('switching libraries or trashing an asset revokes media and cancels late publication', async t => {
  const item = await fixture(t), engine = fakeEngine(item); let current = item.library;
  const service = createAEPreviewService({ engine, getLibrary: () => current }); t.after(() => service.shutdown());
  const ready = await service.prepare(item.library, item.asset.id);
  const inFlightResponse = service.response(new Request(ready.thumbnailUrl));
  current = null;
  assert.equal((await inFlightResponse).status, 404);
  assert.equal((await service.response(new Request(ready.thumbnailUrl))).status, 404);
  await assert.rejects(service.prepare(item.library, item.asset.id), /素材库已切换/);
  current = item.library; await item.library.setTrash([item.asset.id], true);
  assert.equal((await service.response(new Request(ready.thumbnailUrl))).status, 404);
  await item.library.setTrash([item.asset.id], false);
  service.invalidate(); assert.equal((await service.response(new Request(ready.thumbnailUrl))).status, 404);
  const gate = deferred(), lateEngine = fakeEngine(item, { gate });
  const beforeLate = item.library.snapshot();
  const late = createAEPreviewService({ engine: lateEngine, getLibrary: () => current });
  const pending = late.prepare(item.library, item.asset.id); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  late.invalidate(); current = null; gate.resolve(); await rejected; await late.shutdown();
  assert.equal(lateEngine.stopped, true);
  assert.deepEqual(item.library.snapshot(), beforeLate);
});
