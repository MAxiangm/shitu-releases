'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const sketchfab = require('../extension/sketchfab-source.js');

const id = '0123456789abcdef0123456789abcdef';
const other = 'abcdef0123456789abcdef0123456789';
const url = `https://sketchfab.com/3d-models/${id}`;
const model = extra => ({ kind: 'model', sourceType: 'sketchfab', modelId: id, url, pageUrl: url, name: 'Selected model', title: 'Selected model', ...extra });
const root = path.resolve(__dirname, '..');

function node(tagName, attrs = {}) {
  return { tagName, isConnected: true, textContent: '', attrs,
    getAttribute(name) { return this.attrs[name] ?? null; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100 }; } };
}

test('Sketchfab model pages, named cards and viewer embeds normalize one exact lowercase model', () => {
  for (const input of [url, `https://www.sketchfab.com/3d-models/my-model-${id}?utm_source=fixture`,
    `https://sketchfab.com/models/${id}/embed?autostart=1`]) {
    assert.deepEqual(sketchfab.parseModelUrl(input), { modelId: id, url, pageUrl: url });
  }
  for (const input of ['http://sketchfab.com/3d-models/' + id, 'https://sketchfab.com.evil.test/3d-models/' + id,
    'https://user:secret@sketchfab.com/3d-models/' + id, `https://sketchfab.com:444/3d-models/${id}`,
    `https://sketchfab.com/3d-models/${id.toUpperCase()}`, `https://sketchfab.com/3d-models/${id}/extra`,
    'https://sketchfab.com/search?type=models', `https://sketchfab.com/models/${id}`, `https://sketchfab.com/3d-models/${id}\n`]) {
    assert.equal(sketchfab.parseModelUrl(input), null, input);
  }
});

test('Sketchfab canvas selection requires one pointed canvas and never converts unrelated images or controls', () => {
  const canvas = node('CANVAS'), document = { title: 'Model viewer', elementsFromPoint: () => [canvas] };
  const selection = sketchfab.selectModel({ document, page: url, path: [canvas], x: 10, y: 10 });
  assert.equal(selection.source.modelId, id);
  assert.equal(sketchfab.selectionCurrent(selection, url), true);
  assert.equal(sketchfab.selectionCurrent(selection, `https://sketchfab.com/3d-models/${other}`), false);
  assert.equal(sketchfab.selectModel({ document, page: url, path: [canvas], x: 150, y: 10 }), null);
  for (const tag of ['IMG', 'BUTTON', 'INPUT', 'VIDEO']) {
    assert.equal(sketchfab.selectModel({ document, page: url, path: [node(tag)], x: 10, y: 10 }), null);
  }
  assert.equal(sketchfab.selectModel({ document: { ...document, elementsFromPoint: () => [canvas, node('CANVAS')] }, page: url, path: [], x: 10, y: 10 }), null);
  assert.equal(sketchfab.selectModel({ document, page: 'https://example.com/', path: [canvas], x: 10, y: 10 }), null);
});

test('model cards and viewer frames retain the selected model and refuse conflicting card identities', () => {
  const link = node('A', { href: `https://sketchfab.com/3d-models/card-${other}` });
  const picture = node('IMG'); picture.closest = () => link;
  const document = { title: 'Browse', elementsFromPoint: () => [] };
  const selection = sketchfab.selectModel({ document, page: 'https://sketchfab.com/search?type=models', path: [picture, link] });
  assert.equal(selection.source.modelId, other);
  assert.equal(sketchfab.selectionCurrent(selection, 'https://sketchfab.com/search?type=models'), true);
  link.attrs.href = url;
  assert.equal(sketchfab.selectionCurrent(selection, 'https://sketchfab.com/search?type=models'), false);
  const unrelated = node('A', { href: 'https://sketchfab.com/users/someone' });
  assert.equal(sketchfab.selectModel({ document, page: url, path: [unrelated] }), null);
  assert.equal(sketchfab.selectModel({ document, page: url, path: [link, node('A', { href: `https://sketchfab.com/3d-models/${other}` })] }), null);
  const frame = node('IFRAME', { src: `https://sketchfab.com/models/${id}/embed` });
  assert.equal(sketchfab.selectModel({ document, page: url, path: [frame] }).source.modelId, id);
  frame.attrs.src = `https://sketchfab.com/models/${other}/embed`;
  assert.equal(sketchfab.selectModel({ document, page: url, path: [frame] }), null);
  const canvas = node('CANVAS');
  assert.equal(sketchfab.selectModel({ document, page: `https://sketchfab.com/models/${id}/embed`, path: [canvas] }).source.modelId, id);
});

test('a selected viewer frame must still embed the same model before capture', () => {
  const frame = node('IFRAME', { src: `https://sketchfab.com/models/${id}/embed` });
  const selected = sketchfab.selectModel({ document: { title: 'Viewer' }, page: url, path: [frame] });
  assert.equal(sketchfab.selectionCurrent(selected, url), true);
  frame.attrs.src = `https://sketchfab.com/models/${id}/embed?autostart=1`;
  assert.equal(sketchfab.selectionCurrent(selected, url), true);
  for (const replacement of [`https://sketchfab.com/models/${other}/embed`, `https://other.example/models/${id}/embed`, 'about:blank']) {
    frame.attrs.src = replacement;
    assert.equal(sketchfab.selectionCurrent(selected, url), false, replacement);
  }
  frame.attrs.src = `https://sketchfab.com/models/${id}/embed`;
  frame.isConnected = false;
  assert.equal(sketchfab.selectionCurrent(selected, url), false);
});

test('model transport accepts only canonical identity fields, never credentials or page-supplied downloads', () => {
  assert.deepEqual(sketchfab.checkedSource(model(), `https://sketchfab.com/models/${id}/embed`), model());
  for (const extra of [{ modelId: other }, { kind: 'image' }, { sourceType: 'site-video' }, { pageUrl: `https://sketchfab.com/3d-models/${other}` },
    { url: `https://sketchfab.com/3d-models/model-${id}` }, { archiveUrl: `https://sketchfab-prod-media.s3.amazonaws.com/archives/${id}/gltf/model.zip` },
    { attribution: {} }, { cookies: [] }, { token: 'fixture-token' }, { headers: {} }, { dataBase64: 'AA==' }, { mimeType: 'model/gltf-binary' },
    { youtubeSession: {} }, { bilibiliSession: {} }, { playback: 'file' }, { browserRead: true }, { name: 'x'.repeat(241) }]) {
    assert.throws(() => sketchfab.checkedSource(model(extra), url), { code: 'SKETCHFAB_SOURCE_INVALID' });
  }
  assert.throws(() => sketchfab.checkedSource(model(), 'https://sketchfab.com.evil.test/'), { code: 'SKETCHFAB_SOURCE_INVALID' });
});

async function worker({ capable = true, reply, progress = [] } = {}) {
  const requests = [], messages = [], timeoutValues = [], storage = { shituConnection: { port: 38475, token: 'a'.repeat(64) } };
  let listener;
  const chrome = {
    runtime: { id: 'fixture-extension', getURL: file => `chrome-extension://fixture-extension/${file}`,
      getPlatformInfo: async () => ({}), onMessage: { addListener: fn => { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value) } },
    permissions: { contains() { assert.fail('model capture must not inspect browser-session permissions'); } },
    cookies: { getAll() { assert.fail('model capture must not read browser cookies'); } },
    contextMenus: { removeAll: fn => fn(), create: (_entry, fn) => fn?.(), onClicked: { addListener() {} } },
    tabs: { sendMessage: async (_id, message) => { messages.push(structuredClone(message)); } }
  };
  const context = vm.createContext({ chrome, URL, AbortController, AbortSignal, clearTimeout, clearInterval,
    setTimeout: (fn, delay) => { timeoutValues.push(delay); return setTimeout(fn, delay === 1000 ? 0 : delay); },
    setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; },
    fetch: async (address, options) => {
      const route = new URL(address).pathname, body = JSON.parse(options.body); requests.push({ route, body });
      if (route === '/v1/capture') return reply ? reply() : Response.json({ ok: true, imported: 1, duplicates: 0, assetIds: ['new-model'] });
      if (route === '/v1/capture-progress') return Response.json({ ok: true, progress: progress.shift() });
      return Response.json({ ok: true, app: '拾图', version: '0.29.25', ready: true, sketchfabDownload: capable, captureProgress: progress.length > 0 });
    } });
  vm.runInContext(await fs.readFile(path.join(root, 'extension/sketchfab-source.js'), 'utf8'), context);
  vm.runInContext(await fs.readFile(path.join(root, 'extension/background.js'), 'utf8'), context);
  return { requests, messages, timeoutValues, storage, send: input => new Promise(resolve => listener({ type: 'shitu:capture', media: input },
    { id: 'fixture-extension', url, tab: { id: 7, url }, frameId: 0 }, resolve)) };
}

test('Sketchfab worker sends a bounded identity-only model request and waits for the saved receipt', async () => {
  const instance = await worker();
  const result = await instance.send(model());
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(instance.requests.find(value => value.route === '/v1/capture').body, { ...model(), requestId: instance.requests.find(value => value.route === '/v1/capture').body.requestId });
  assert.ok(instance.timeoutValues.includes(18 * 60000));
  assert.equal(instance.messages.some(value => /音视频/.test(value.message)), false);
  const old = await worker({ capable: false });
  assert.equal((await old.send(model())).code, 'INCOMPATIBLE_APP');
  assert.equal(old.requests.some(value => value.route === '/v1/capture'), false);
});

test('Sketchfab worker rejects injected archive and reports official connection errors without a fallback request', async () => {
  const forged = await worker();
  assert.equal((await forged.send(model({ archiveUrl: 'https://example.com/model.zip' }))).code, 'SKETCHFAB_SOURCE_INVALID');
  assert.equal(forged.requests.length, 0);
  const denied = await worker({ reply: () => Response.json({ ok: false, error: '请先在采集设置连接 Sketchfab。' }, { status: 403 }) });
  assert.match((await denied.send(model())).error, /连接 Sketchfab/);
  assert.equal(denied.requests.filter(value => value.route === '/v1/capture').length, 1);
});

test('model extraction and dependency verification progress never uses video-specific messages', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = () => resolve(Response.json({ ok: true, imported: 1, assetIds: ['new-model'] })); });
  const instance = await worker({ reply: () => pending, progress: [
    { phase: 'reading', receivedBytes: 0 }, { phase: 'extracting', receivedBytes: 100 }, { phase: 'verifying', receivedBytes: 100 }
  ] });
  const saving = instance.send(model());
  const deadline = Date.now() + 2000;
  while (!instance.messages.some(value => value.message.includes('核对模型')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  finish();
  assert.equal((await saving).ok, true);
  assert.ok(instance.messages.some(value => value.message.includes('解析模型')));
  assert.ok(instance.messages.some(value => value.message.includes('安全解压模型')));
  assert.ok(instance.messages.some(value => value.message.includes('核对模型和贴图依赖')));
  assert.equal(instance.messages.some(value => /视频|声音/.test(value.message)), false);
});
