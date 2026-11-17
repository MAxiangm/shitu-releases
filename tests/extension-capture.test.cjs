'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createCollector } = require('../src/collector.cjs');
const { Library } = require('../src/library.cjs');
const root = path.resolve(__dirname, '..');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const sourceUrl = 'https://image.example/selected.png';

async function worker({ fetchImpl, initial = {}, port = 38475, storageWriteFailure = false } = {}) {
  const storage = { shituConnection: { port, token: 'a'.repeat(64) }, ...structuredClone(initial) };
  const requests = [];
  let listener;
  const chrome = {
    runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`, getManifest: () => ({ version: '0.11.1' }),
      getPlatformInfo: async () => ({}), onMessage: { addListener: fn => { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { setAccessLevel: async () => {}, get: async key => typeof key === 'string' ? { [key]: storage[key] } : storage,
      set: async value => { if (storageWriteFailure) throw new Error('Storage quota unavailable'); Object.assign(storage, structuredClone(value)); } } },
    contextMenus: { removeAll: callback => callback(), create: (_item, callback) => callback(), onClicked: { addListener() {} } },
    tabs: { sendMessage: async () => {} }
  };
  vm.runInNewContext(await fs.readFile(path.join(root, 'extension/background.js'), 'utf8'), {
    chrome, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval,
    fetch: async (url, options) => {
      const request = { url: String(url), route: new URL(url).pathname, body: JSON.parse(options.body), options };
      requests.push(request);
      if (fetchImpl) return fetchImpl(request);
      return new Response(JSON.stringify(request.route === '/v1/capture'
        ? { ok: true, imported: 1, duplicates: 0, assetIds: ['new-asset'], existingAssets: [], libraryRoot: 'isolated-library' }
        : { ok: true, app: '拾图', version: '0.11.1', ready: true }), { headers: { 'Content-Type': 'application/json' } });
    }
  }, { filename: 'extension/background.js' });
  return { storage, requests, send(message, sender = { id: extensionId, url: 'https://frame.example/item', tab: { id: 1, url: 'https://top.example/' } }) {
    return new Promise(resolve => listener(message, sender, resolve));
  } };
}

async function content({ fetchImpl, mediaUrl = sourceUrl, pageUrl = 'https://frame.example/item', reply = { ok: true, imported: 1, duplicates: 0, assetIds: ['new-asset'] } } = {}) {
  const nodes = [], events = new Map(), messages = [], fetches = [], timers = new Map();
  let nextTimer = 0;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.style = {}; this.attributes = {}; this.children = []; this.isConnected = false; this.listeners = new Map(); nodes.push(this); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] || null; }
    append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; child.isConnected = this.isConnected; } }
    appendChild(child) { this.append(child); return child; }
    attachShadow() { return new Element('shadow'); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    closest() { return null; }
    remove() { this.isConnected = false; }
  }
  const documentElement = new Element('html'); documentElement.isConnected = true;
  const image = new Element('img'); image.currentSrc = mediaUrl; image.setAttribute('alt', 'Selected fixture');
  const document = { baseURI: pageUrl, title: 'Frame page', documentElement,
    createElement: tag => new Element(tag), elementsFromPoint: () => [image],
    querySelector: selector => selector === '[data-shitu-toast]' ? nodes.find(node => node.attributes['data-shitu-toast'] !== undefined) : null };
  class FileReader {
    readAsDataURL(blob) { blob.arrayBuffer().then(buffer => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onload?.(); }, error => { this.error = error; this.onerror?.(); }); }
  }
  const context = { Element, document, FileReader, URL, Blob, Uint8Array, ArrayBuffer, AbortController, AbortSignal,
    location: { href: document.baseURI }, performance: { now: () => Date.now() },
    getComputedStyle: () => ({ backgroundImage: 'none' }),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    chrome: { runtime: { id: extensionId, getManifest: () => ({ version: '0.11.1' }),
      sendMessage: async message => { messages.push(message); return typeof reply === 'function' ? reply(message) : reply; },
      onMessage: { addListener() {} } } },
    fetch: async (url, options) => { fetches.push({ url, options }); return fetchImpl ? fetchImpl(url, options) : new Response(bytes, { headers: { 'Content-Type': 'image/png' } }); }
  };
  context.window = { addEventListener: (type, listener) => events.set(type, listener) };
  vm.runInNewContext(await fs.readFile(path.join(root, 'extension/content.js'), 'utf8'), context, { filename: 'extension/content.js' });
  return { nodes, messages, fetches, timers, async capture() {
    events.get('contextmenu')({ isTrusted: true, altKey: true, clientX: 20, clientY: 20,
      composedPath: () => [image], preventDefault() {}, stopImmediatePropagation() {} });
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const toast = document.querySelector('[data-shitu-toast]');
      if (toast && toast.getAttribute('data-status') !== 'working') return { status: toast.getAttribute('data-status'), message: toast.getAttribute('aria-label') };
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Content capture did not reach a final status');
  } };
}

test('capture worker preserves the clicked iframe source page instead of replacing it with the top page', async () => {
  const instance = await worker();
  const result = await instance.send({ type: 'shitu:capture', media: { kind: 'image', url: sourceUrl, pageUrl: 'https://frame.example/item' } });
  assert.equal(result.ok, true);
  assert.equal(instance.requests.find(request => request.route === '/v1/capture').body.pageUrl, 'https://frame.example/item');
});

test('invalid media and an empty server report cannot retain a prior saved status', async () => {
  const instance = await worker({ initial: { shituLastCapture: { ok: true, status: 'saved', name: 'old result' } } });
  const invalid = await instance.send({ type: 'shitu:capture', media: { kind: 'image', url: 'javascript:alert(1)' } });
  assert.equal(invalid.ok, false);
  assert.equal(instance.storage.shituLastCapture.ok, false);
  assert.equal(instance.storage.shituLastCapture.status, 'error');
  const empty = await worker({ fetchImpl: async request => new Response(JSON.stringify(request.route === '/v1/capture'
    ? { ok: true, imported: 0, duplicates: 0, assetIds: [] }
    : { ok: true, app: '拾图', version: '0.11.1', ready: true })) });
  const result = await empty.send({ type: 'shitu:capture', media: { kind: 'image', url: sourceUrl } });
  assert.equal(result.ok, false);
  assert.equal(empty.storage.shituLastCapture.ok, false);
});

test('network failure and an unselected desktop library produce final errors and never report saved', async () => {
  const unavailable = await worker({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  const result = await unavailable.send({ type: 'shitu:capture', media: { kind: 'image', url: sourceUrl } });
  assert.equal(result.ok, false);
  assert.equal(unavailable.storage.shituLastCapture.ok, false);
  const notReady = await worker({ fetchImpl: async () => new Response(JSON.stringify({ ok: true, app: '拾图', version: '0.11.1', ready: false })) });
  const unselected = await notReady.send({ type: 'shitu:capture', media: { kind: 'image', url: sourceUrl } });
  assert.equal(unselected.ok, false);
  assert.equal(notReady.requests.some(request => request.route === '/v1/capture'), false);
});

test('the clicked HTTP image uses browser bytes and retains its original URL and frame provenance', async () => {
  const instance = await content();
  assert.equal((await instance.capture()).status, 'success');
  const capture = instance.messages.find(message => message.type === 'shitu:capture');
  assert.equal(capture.media.url, sourceUrl);
  assert.equal(capture.media.pageUrl, 'https://frame.example/item');
  assert.equal(capture.media.dataBase64, bytes.toString('base64'));
  assert.equal(capture.media.mimeType, 'image/png');
  assert.equal(instance.fetches[0].options.credentials, 'same-origin');
});

test('a cross-origin browser read failure falls back to a direct URL without pretending bytes were fetched', async () => {
  const instance = await content({ fetchImpl: async () => { throw new TypeError('Blocked by CORS'); } });
  assert.equal((await instance.capture()).status, 'success');
  const capture = instance.messages.find(message => message.type === 'shitu:capture');
  assert.equal(capture.media.url, sourceUrl);
  assert.equal(capture.media.dataBase64, undefined);
});

test('a pinimg-like cross-origin image with allowed CORS uses browser bytes and retains the pin page', async () => {
  const mediaUrl = 'https://i.pinimg.com/originals/aa/bb/fixture.jpg';
  const pageUrl = 'https://www.pinterest.com/pin/123456/';
  const instance = await content({ mediaUrl, pageUrl, fetchImpl: async (url, options) => {
    assert.equal(url, mediaUrl); assert.equal(options.credentials, 'same-origin');
    return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': new URL(pageUrl).origin } });
  } });
  assert.equal((await instance.capture()).status, 'success');
  const selected = instance.messages.find(message => message.type === 'shitu:capture').media;
  assert.equal(selected.url, mediaUrl); assert.equal(selected.pageUrl, pageUrl);
  assert.equal(selected.dataBase64, bytes.toString('base64'));
});

test('oversized HTTP images fall back to the desktop download both from declared length and bounded streaming', async () => {
  const declared = await content({ fetchImpl: async () => new Response(bytes, {
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(21 * 1024 * 1024) }
  }) });
  assert.equal((await declared.capture()).status, 'success');
  assert.equal(declared.messages.find(message => message.type === 'shitu:capture').media.dataBase64, undefined);
  let cancelled = false;
  let chunks = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const streamed = await content({ fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { if (chunks++ < 22) controller.enqueue(chunk); else controller.close(); }, cancel() { cancelled = true; }
  }), { headers: { 'Content-Type': 'image/png' } }) });
  assert.equal((await streamed.capture()).status, 'success'); assert.equal(cancelled, true);
  assert.equal(streamed.messages.find(message => message.type === 'shitu:capture').media.dataBase64, undefined);
});

test('same-URL concurrent captures share one request and failed browser status storage cannot undo confirmed saving', async t => {
  let release, started = 0;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const instance = await worker({ fetchImpl: async request => {
    if (request.route === '/v1/capture') { started++; await gate; return new Response(JSON.stringify({ ok: true, imported: 1, duplicates: 0, assetIds: ['one'] })); }
    return new Response(JSON.stringify({ ok: true, app: '拾图', version: '0.11.1', ready: true }));
  } });
  const message = { type: 'shitu:capture', media: { kind: 'image', url: sourceUrl } };
  const first = instance.send(message);
  while (!started) await new Promise(resolve => setTimeout(resolve, 1));
  const second = instance.send(message);
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(started, 1); assert.equal(instance.storage.shituLastCapture.status, 'working');
  release(); const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.ok && result.imported === 1));
  assert.equal(instance.storage.shituLastCapture.status, 'saved');
  const failingStorage = await worker({ storageWriteFailure: true });
  const saved = await failingStorage.send(message); assert.equal(saved.ok, true); assert.equal(saved.imported, 1);
});

test('content errors remain visible and a duplicate in trash is explicitly identified', async () => {
  const error = await content({ reply: { ok: false, error: '网站返回 HTTP 403' } });
  const toast = await error.capture();
  assert.equal(toast.status, 'error'); assert.match(toast.message, /403/);
  assert.equal([...error.timers.values()].some(timer => timer.delay === 9000), false);
  const duplicate = await content({ reply: { ok: true, imported: 0, duplicates: 1,
    existingAssets: [{ id: 'existing', name: 'Earlier image', trashedAt: '2026-01-01T00:00:00.000Z' }] } });
  const duplicated = await duplicate.capture();
  assert.equal(duplicated.status, 'warning'); assert.match(duplicated.message, /回收站/);
});

test('popup never treats stale working or empty legacy results as confirmed and reconnecting preserves capture errors', async () => {
  async function popup(recent) {
    const elements = new Map(), storage = { shituLastCapture: structuredClone(recent) };
    const element = id => {
      if (!elements.has(id)) elements.set(id, { textContent: '', attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener() {} });
      return elements.get(id);
    };
    const context = vm.createContext({ document: { getElementById: element }, URL, Date,
      window: { addEventListener() {} }, setInterval: () => 1, clearInterval() {},
      fetch: async () => new Response(JSON.stringify({ version: '0.11.1' })),
      chrome: { runtime: { getURL: file => `chrome-extension://${extensionId}/${file}`, reload() { throw new Error('A current worker must not reload'); },
        sendMessage: async message => message.type === 'shitu:extension-info' ? { ok: true, protocol: 1, version: '0.11.1', build: '0.11.1' }
          : { ok: true, version: '0.11.1', ready: true } },
      storage: { local: { get: async key => ({ [key]: storage[key] }), set: async values => Object.assign(storage, values), remove: async key => { delete storage[key]; } } } }
    });
    vm.runInContext(await fs.readFile(path.join(root, 'extension/popup.js'), 'utf8'), context, { filename: 'extension/popup.js' });
    await vm.runInContext('showRecent(true)', context);
    return { elements, storage };
  }
  const stale = await popup({ ok: false, pending: true, status: 'working', at: Date.now() - 400000, name: 'Old pending image' });
  assert.equal(stale.elements.get('recent').attributes['data-state'], 'unconfirmed');
  assert.match(stale.elements.get('recentText').textContent, /未收到最终确认/);
  const legacy = await popup({ ok: true, imported: 0, duplicates: 0, name: 'Legacy result' });
  assert.equal(legacy.elements.get('recent').attributes['data-state'], 'unconfirmed');
  const failure = { ok: false, status: 'error', error: 'Website HTTP 403', at: Date.now() };
  const retained = await popup(failure);
  assert.match(retained.elements.get('recentText').textContent, /403/);
  assert.deepEqual(retained.storage.shituLastCapture, failure);
});

test('browser-fetched HTTP bytes pass through the actual collector into a real isolated library and retain provenance', async t => {
  const testsRoot = path.join(root, '.recovery/tests');
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'extension-capture-'));
  t.after(async () => { const relative = path.relative(testsRoot, directory); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(directory, { recursive: true, force: true }); });
  const library = new Library({ root: path.join(directory, 'library') }); await library.init();
  const collector = createCollector({ library, configPath: path.join(directory, 'collector.json') });
  t.after(() => collector.close()); await collector.start();
  const pairing = collector.info().code.split('.');
  const instance = await worker({ port: Number(pairing[1]), initial: { shituConnection: { port: Number(pairing[1]), token: pairing[2] } },
    fetchImpl: async request => {
      if (!request.url.startsWith(collector.info().baseUrl + '/')) throw new Error('This test refuses other local services');
      return fetch(request.url, request.options);
    } });
  const message = { type: 'shitu:capture', media: { kind: 'image', url: sourceUrl, dataBase64: bytes.toString('base64'), mimeType: 'image/png', pageUrl: 'https://frame.example/item' } };
  const result = await instance.send(message);
  assert.equal(result.ok, true); assert.equal(result.imported, 1);
  const asset = library.snapshot().assets[0];
  assert.equal(asset.sourceUrl, sourceUrl); assert.equal(asset.pageUrl, 'https://frame.example/item');
  assert.deepEqual(await fs.readFile(library.getAssetPath(asset.id, 'original')), bytes);
  await library.setTrash([asset.id], true);
  const repeated = await instance.send(message);
  assert.equal(repeated.ok, true); assert.equal(repeated.duplicates, 1);
  assert.ok(repeated.existingAssets[0].trashedAt);
});
