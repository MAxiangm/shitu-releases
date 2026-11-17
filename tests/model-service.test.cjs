'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');

const fixturesRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
async function fixture(t, native = false) {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(fixturesRoot, 'model-service-'));
  t.after(async () => {
    const relative = path.relative(fixturesRoot, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  const source = path.join(base, 'source'); await fs.mkdir(path.join(source, 'textures'), { recursive: true });
  const filename = path.join(source, native ? '模型.blend' : '模型.obj');
  if (native) await fs.writeFile(filename, 'BLENDER-v420 native fixture');
  else {
    await fs.writeFile(filename, 'mtllib 模型.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl material\nf 1 2 3\n');
    await fs.writeFile(path.join(source, '模型.mtl'), 'newmtl material\nmap_Kd textures/base color.png\n');
    await fs.writeFile(path.join(source, 'textures', 'base color.png'), Buffer.from('texture fixture bytes'));
  }
  const library = new Library({ root: path.join(base, 'library') });
  await library.init();
  const imported = await library.importPaths([filename]);
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.imported, 1);
  return { base, library, asset: library.snapshot().assets[0] };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function waitFor(condition, message) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 2000) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function bounded(promise, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Test operation timed out')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
function setup(t, fixture, { converter, behavior = {}, thumbnailTimeoutMs = 1000 } = {}) {
  const windows = [];
  let activeLibrary = fixture.library, shutdownCalls = 0;
  const nativeConverter = converter || { preview: async () => { throw new Error('Unexpected native converter'); } };
  const shutdown = nativeConverter.shutdown || (async () => {});
  nativeConverter.shutdown = async () => { shutdownCalls++; await shutdown(); };
  class MockWindow {
    constructor(options) {
      this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = callback => { this.openHandler = callback; };
      this.webContents.executeJavaScript = async script => {
        this.modelOptions = JSON.parse(script.slice('window.renderModelThumbnail('.length, -1));
        return behavior.execute ? behavior.execute(this) : { dataUrl: 'data:image/jpeg;base64,/9j/2Q==' };
      };
      windows.push(this);
    }
    async loadFile(filename) { this.loadedFile = filename; return behavior.load ? behavior.load(this) : undefined; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.webContents.emit('destroyed'); }
  }
  // Capture an isolated converter factory when loading this service module.
  // The real native applications are never discovered or launched by these tests.
  const nativePath = require.resolve('../src/native-models.cjs');
  const servicePath = require.resolve('../src/model-service.cjs');
  const oldNative = require.cache[nativePath], oldService = require.cache[servicePath];
  require.cache[nativePath] = { id: nativePath, filename: nativePath, loaded: true,
    exports: { createNativeModelConverter: () => nativeConverter } };
  delete require.cache[servicePath];
  let createModelService;
  try { ({ createModelService } = require(servicePath)); }
  finally {
    if (oldNative) require.cache[nativePath] = oldNative; else delete require.cache[nativePath];
    if (oldService) require.cache[servicePath] = oldService; else delete require.cache[servicePath];
  }
  const service = createModelService({ BrowserWindow: MockWindow, cacheDir: path.join(fixture.base, 'cache'),
    getLibrary: () => activeLibrary, thumbnailTimeoutMs });
  t.after(() => service.shutdown());
  return { service, windows, setLibrary: library => { activeLibrary = library; }, shutdownCalls: () => shutdownCalls };
}
const request = (url, options) => new Request(url, options);

test('model service serves only authorized package files and rejects malformed, traversal and stale library URLs', async t => {
  const data = await fixture(t);
  const { service, setLibrary } = setup(t, data);
  const prepared = await service.prepare(data.library, data.asset.id, data.library.root);
  assert.equal(prepared.format, 'obj');
  assert.equal(prepared.files.length, 3);
  assert.equal(JSON.stringify(prepared).includes(data.base), false, 'renderer options must not expose local filesystem paths');
  const original = await service.response(request(prepared.url));
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(await original.text(), await fs.readFile(data.library.getAssetPath(data.asset.id), 'utf8'));
  const texture = prepared.files.find(file => file.path.endsWith('.png'));
  assert.equal((await service.response(request(texture.url))).status, 200);
  const baseUrl = new URL('.', prepared.url).href;
  for (const url of [
    new URL('unknown.txt', prepared.url).href,
    `${baseUrl}../index.json`, `${baseUrl}%2e%2e/index.json`, `${baseUrl}%252e%252e%252findex.json`,
    `${baseUrl}%00`, `${baseUrl}%E0%A4%A`, prepared.url.replace('shitu:', 'http:'),
    prepared.url.replace('://model/', '://other/'),
    prepared.url.replace(/\/[^/]+\/[^/]+$/, '/not-a-token/model.obj')
  ]) assert.equal((await service.response(request(url))).status, 404, url);
  assert.equal((await service.response(request(prepared.url, { method: 'POST' }))).status, 404);
  await assert.rejects(service.prepare(data.library, data.asset.id, path.join(data.base, 'wrong-library')), /素材库已切换/);
  const second = new Library({ root: path.join(data.base, 'second-library') }); await second.init();
  setLibrary(second);
  assert.equal((await service.response(request(prepared.url))).status, 404);
  setLibrary(data.library); service.invalidate();
  assert.equal((await service.response(request(prepared.url))).status, 404);
});

test('authorization rejects a model package directory replaced by a junction', async t => {
  const data = await fixture(t);
  const { service } = setup(t, data);
  const directory = data.library.getModelBundleDirectory(data.asset.id);
  const detached = path.join(data.base, 'outside-package');
  await fs.rename(directory, detached);
  await fs.symlink(detached, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.prepare(data.library, data.asset.id, data.library.root), /符号链接|托管/);
});

test('authorization rejects linked ancestors and resource responses reject links introduced after preparation', async t => {
  const data = await fixture(t);
  const { service } = setup(t, data);
  const prepared = await service.prepare(data.library, data.asset.id, data.library.root);
  const texture = prepared.files.find(file => file.path.endsWith('.png'));
  const textureDirectory = path.dirname(data.library.getModelFilePath(data.asset.id, texture.path));
  const detachedTextures = path.join(data.base, 'outside-textures');
  await fs.rename(textureDirectory, detachedTextures);
  await fs.symlink(detachedTextures, textureDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await service.response(request(texture.url))).status, 404);
  await assert.rejects(service.prepare(data.library, data.asset.id, data.library.root), /符号链接|托管/);
  await fs.unlink(textureDirectory);
  await fs.rename(detachedTextures, textureDirectory);
  const originals = path.join(data.library.root, 'originals');
  const detachedOriginals = path.join(data.base, 'outside-originals');
  await fs.rename(originals, detachedOriginals);
  await fs.symlink(detachedOriginals, originals, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.prepare(data.library, data.asset.id, data.library.root), /符号链接|托管/);
});

test('concurrent native preparations share one conversion and stale library objects do not absorb a new request', async t => {
  const data = await fixture(t, true);
  const convertedFile = path.join(data.base, 'preview.glb'); await fs.writeFile(convertedFile, 'converted fixture bytes');
  const converted = { entry: 'preview.glb', format: 'glb', files: [{ path: 'preview.glb', source: convertedFile }] };
  const gates = [deferred(), deferred()]; let calls = 0;
  const { service, setLibrary } = setup(t, data, { converter: { preview: () => gates[calls++].promise } });
  const old = service.prepare(data.library, data.asset.id, data.library.root);
  const oldRejected = assert.rejects(old, /素材库已切换/);
  assert.equal(service.prepare(data.library, data.asset.id, data.library.root), old);
  await waitFor(() => calls === 1, 'First native conversion never started');
  const reopened = new Library({ root: data.library.root }); await reopened.init();
  setLibrary(reopened);
  const current = service.prepare(reopened, data.asset.id, reopened.root);
  await waitFor(() => calls === 2, 'New library object reused the stale library task');
  gates[0].resolve(converted); await oldRejected;
  assert.equal(service.prepare(reopened, data.asset.id, reopened.root), current, 'old cleanup must not remove a new pending task');
  gates[1].resolve(converted);
  const prepared = await current;
  assert.equal(prepared.format, 'glb');
  assert.equal(calls, 2);
  assert.equal(await (await service.response(request(prepared.url))).text(), 'converted fixture bytes');
});

test('thumbnail failures destroy the hidden window, revoke temporary access, and release the queue', async t => {
  const data = await fixture(t);
  let attempts = 0;
  const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#227799' } }).jpeg().toBuffer();
  const { service, windows } = setup(t, data, { behavior: { execute: async () => {
    if (++attempts === 1) throw new Error('fixture renderer failure');
    return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
  } } });
  const settings = { modelBundle: data.asset.modelBundle, modelDirectory: data.library.getModelBundleDirectory(data.asset.id) };
  const destination = path.join(data.base, 'thumbnail.jpg');
  await assert.rejects(service.thumbnail(data.library.getAssetPath(data.asset.id), destination, settings), /fixture renderer failure/);
  assert.equal(windows[0].isDestroyed(), true);
  assert.equal((await service.response(request(windows[0].modelOptions.url))).status, 404);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
  assert.deepEqual(await service.thumbnail(data.library.getAssetPath(data.asset.id), destination, settings), { width: 640, height: 640 });
  assert.deepEqual(await fs.readFile(destination), jpeg);
  assert.equal(windows[1].isDestroyed(), true);
  assert.equal(windows[1].options.useContentSize, true);
  assert.deepEqual(windows[1].openHandler(), { action: 'deny' });
  assert.equal((await service.response(request(windows[1].modelOptions.url))).status, 404);
  assert.equal(service.busy(), false);
});

test('thumbnail timeout and invalid image output both clean up their authorization and window', async t => {
  const data = await fixture(t);
  const timed = setup(t, data, { thumbnailTimeoutMs: 20, behavior: { execute: () => new Promise(() => {}) } });
  const settings = { modelBundle: data.asset.modelBundle, modelDirectory: data.library.getModelBundleDirectory(data.asset.id) };
  await assert.rejects(bounded(timed.service.thumbnail(data.library.getAssetPath(data.asset.id), path.join(data.base, 'timeout.jpg'), settings)), /超时/);
  assert.equal(timed.windows[0].isDestroyed(), true);
  assert.equal((await timed.service.response(request(timed.windows[0].modelOptions.url))).status, 404);
  const invalid = setup(t, data, { behavior: { execute: async () => ({ dataUrl: 'data:text/html;base64,PGltZz4=' }) } });
  await assert.rejects(invalid.service.thumbnail(data.library.getAssetPath(data.asset.id), path.join(data.base, 'invalid.jpg'), settings), /封面数据无效/);
  assert.equal(invalid.windows[0].isDestroyed(), true);
});

test('shutdown cancels a hung thumbnail and queued jobs promptly instead of waiting for the rendering timeout', async t => {
  const data = await fixture(t);
  const { service, windows, shutdownCalls } = setup(t, data, { thumbnailTimeoutMs: 10000, behavior: { load: () => new Promise(() => {}) } });
  const settings = { modelBundle: data.asset.modelBundle, modelDirectory: data.library.getModelBundleDirectory(data.asset.id) };
  const first = service.thumbnail(data.library.getAssetPath(data.asset.id), path.join(data.base, 'first.jpg'), settings);
  const second = service.thumbnail(data.library.getAssetPath(data.asset.id), path.join(data.base, 'second.jpg'), settings);
  const rejected = [assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })];
  await waitFor(() => windows.length === 1, 'Thumbnail window never opened');
  await bounded(service.shutdown(), 500);
  await Promise.all(rejected);
  assert.equal(windows[0].isDestroyed(), true);
  assert.equal(windows.length, 1);
  assert.equal(service.busy(), false);
  await service.shutdown();
  assert.equal(shutdownCalls(), 1);
  await assert.rejects(service.prepare(data.library, data.asset.id, data.library.root), { name: 'AbortError' });
});

test('shutdown cancels in-flight native preparation and old resource URLs immediately', async t => {
  const data = await fixture(t, true);
  let conversionStarted = false;
  const { service } = setup(t, data, { converter: { preview: () => { conversionStarted = true; return new Promise(() => {}); } } });
  const preparing = service.prepare(data.library, data.asset.id, data.library.root);
  const rejected = assert.rejects(preparing, { name: 'AbortError' });
  await waitFor(() => conversionStarted, 'Native conversion never started');
  await bounded(service.shutdown(), 500);
  await rejected;
  assert.equal(service.busy(), false);
});
