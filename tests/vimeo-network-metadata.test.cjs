'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../extension/vimeo-network-metadata.js'), 'utf8');
const page = new URL('https://vimeo.com/138191248');
const endpoint = id => `https://player.vimeo.com/video/${id}/config?referrer=test`;
const mp4 = id => `https://vod-progressive.akamaized.net/not-official/${id}.mp4`;
const official = id => `https://vod.vimeocdn.com/${id}/movie.mp4?signature=public`;
const hls = id => `https://vod-adaptive-ak.vimeocdn.com/${id}/playlist.m3u8?signature=public`;
const config = (id = '138191248', extra = {}) => ({ video: { id: Number(id), title: 'A {title}', owner: { email: 'must-not-be-copied@example.test' } },
  request: { files: { progressive: [{ url: official(id), width: 1280, height: 720, bitrate: 1000000 }],
    hls: { default_cdn: 'akfire', cdns: { akfire: { url: hls(id), origin: 'not retained' } } },
    dash: { default_cdn: 'fastly', cdns: { fastly: { url: `https://skyfire.vimeocdn.com/${id}/master.json` } } } }, token: 'do-not-retain' },
  ...extra });

function response(data, { url = endpoint('138191248'), type = 'application/json', status = 200 } = {}) {
  const result = new Response(JSON.stringify(data), { status, headers: { 'Content-Type': type } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

function fixture({ fetchImpl = () => Promise.resolve(response(config())), initial = [], ready = true } = {}) {
  const scripts = [...initial], calls = [], readyListeners = [];
  let mutate;
  const root = { appendChild(node) { scripts.push(node); return node; } };
  const document = {
    documentElement: ready ? root : null,
    addEventListener(_type, callback) { readyListeners.push(callback); },
    getElementById: id => scripts.find(s => s.id === id),
    querySelectorAll: () => scripts,
    createElement(tag) {
      assert.equal(tag, 'script');
      return { tagName: 'SCRIPT', attributes: {}, setAttribute(k, v) { this.attributes[k] = v; },
        hasAttribute(k) { return Object.hasOwn(this.attributes, k); },
        remove() { const i = scripts.indexOf(this); if (i >= 0) scripts.splice(i, 1); } };
    }
  };
  class XHR {
    constructor() { this.listeners = []; this.responseType = ''; this.status = 200; this.responseURL = endpoint('138191248'); }
    open(...args) { this.args = args; return 'original'; }
    addEventListener(_type, callback) { this.listeners.push(callback); }
    getResponseHeader(key) { return key === 'content-type' ? 'application/json' : null; }
    load(data) {
      this.response = data; this.responseText = JSON.stringify(data);
      const event = { loaded: this.responseText.length, total: this.responseText.length };
      for (const callback of this.listeners) callback.call(this, event);
      return event;
    }
  }
  class MutationObserver { constructor(callback) { mutate = callback; } observe() {} }
  const originalFetch = function (...args) { calls.push({ self: this, args }); return fetchImpl(...args); };
  const context = vm.createContext({ URL, Request, Response, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    document, location: new URL(page), fetch: originalFetch, XMLHttpRequest: XHR, MutationObserver });
  vm.runInContext(source, context);
  return { scripts, context, calls, XHR, mutate: (...args) => mutate(...args), document, originalFetch,
    data() { const node = scripts.find(s => s.attributes?.['data-mosaic-vimeo-config'] !== undefined); return node ? JSON.parse(node.textContent) : null; },
    ready() { document.documentElement = root; readyListeners.forEach(callback => callback()); } };
}

async function settled(read) {
  for (let i = 0; i < 100; i++) { if (read()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('Observation did not settle');
}

test('Vimeo config observer keeps original Promise/Response and publishes only structured source metadata', async () => {
  const raw = config(), original = response(raw), promise = Promise.resolve(original);
  const instance = fixture({ fetchImpl: () => promise });
  const receiver = { receiver: true };
  assert.equal(instance.context.fetch.call(receiver, endpoint('138191248')), promise);
  assert.equal(await promise, original);
  await settled(() => instance.data());
  assert.equal(instance.calls[0].self, receiver);
  const data = instance.data().configs[0];
  assert.equal(data.video.id, '138191248');
  assert.equal(data.request.files.progressive[0].url, official('138191248'));
  assert.equal(data.request.files.hls.cdns.akfire.url, hls('138191248'));
  assert.equal(data.request.files.dash.cdns.fastly.url.endsWith('master.json'), true);
  assert.equal(JSON.stringify(data).includes('do-not-retain'), false);
  assert.equal(JSON.stringify(data).includes('email'), false);
  assert.deepEqual(await original.json(), raw);
});

test('Vimeo observer requires exact config endpoints and matching response IDs', async () => {
  for (const url of [endpoint('138191248').replace('player.vimeo.com', 'player.vimeo.com.example'),
    'https://vimeo.com/api/user', 'https://player.vimeo.com/video/138191248',
    endpoint('138191248').replace('https:', 'http:'), 'https://other.example/video/138191248/config']) {
    let read = false;
    const original = { status: 200, url, clone() { read = true; throw new Error('Not allowed'); } };
    const instance = fixture({ fetchImpl: () => Promise.resolve(original) });
    assert.equal(await instance.context.fetch(url), original);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(read, false);
    assert.equal(instance.data(), null);
  }
  const wrong = fixture({ fetchImpl: () => Promise.resolve(response(config('999'))) });
  await wrong.context.fetch(endpoint('138191248'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrong.data(), null);
});

test('Vimeo observer rejects non-JSON/failed responses and misleading media hosts', async () => {
  for (const options of [{ status: 403 }, { type: 'text/html' }, { url: endpoint('999') }]) {
    const instance = fixture({ fetchImpl: () => Promise.resolve(response(config(), options)) });
    await instance.context.fetch(endpoint('138191248'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instance.data(), null);
  }
  const raw = config();
  raw.request.files.progressive = [{ url: mp4('138191248') }, { url: official('138191248').replace('vimeocdn.com', 'vimeocdn.com.example') }];
  const instance = fixture({ fetchImpl: () => Promise.resolve(response(raw)) });
  await instance.context.fetch(endpoint('138191248'));
  await settled(() => instance.data());
  assert.equal(instance.data().configs[0].request.files.progressive.length, 0);
});

test('Vimeo config denial/live signals survive sanitization without copying DRM credentials', async () => {
  const raw = config(); raw.request.drm = { widevine: { token: 'private-license-token' } }; raw.video.is_live = true;
  const instance = fixture({ fetchImpl: () => Promise.resolve(response(raw)) });
  await instance.context.fetch(endpoint('138191248')); await settled(() => instance.data());
  const video = instance.data().configs[0].video;
  assert.equal(video.is_live, true); assert.equal(video.is_drm_protected, true);
  assert.equal(JSON.stringify(instance.data()).includes('private-license-token'), false);
});

test('Vimeo recognizes explicit DRM system markers but does not classify disabled placeholders as protection', async () => {
  for (const [drm, expected] of [['widevine', true], [{ enabled: false }, false], [false, false], ['none', false], [['widevine'], true]]) {
    const raw = config(); raw.request.drm = drm;
    const instance = fixture({ fetchImpl: () => Promise.resolve(response(raw)) });
    await instance.context.fetch(endpoint('138191248')); await settled(() => instance.data());
    assert.equal(instance.data().configs[0].video.is_drm_protected === true, expected);
  }
});

test('Vimeo inline playerConfig is read as JSON and bound to the current page', () => {
  const inline = { tagName: 'SCRIPT', textContent: `window.playerConfig = ${JSON.stringify(config())}; throw new Error('never execute');` };
  const instance = fixture({ initial: [inline] });
  assert.equal(instance.data().configs[0].video.title, 'A {title}');
  const wrong = fixture({ initial: [{ ...inline, textContent: `window.playerConfig=${JSON.stringify(config('999'))};` }] });
  assert.equal(wrong.data(), null);
});

test('Vimeo watches nested, removed, and progressively filled config scripts without observing itself recursively', () => {
  const instance = fixture();
  const script = { tagName: 'SCRIPT', textContent: '' };
  instance.mutate([{ target: instance.document, addedNodes: [{ querySelectorAll: () => [script] }] }]);
  assert.equal(instance.data(), null);
  script.textContent = `window.playerConfig=${JSON.stringify(config())};`;
  instance.mutate([{ target: { parentElement: script }, addedNodes: [], removedNodes: [script] }]);
  assert.equal(instance.data().configs.length, 1);
  const own = instance.scripts.at(-1);
  instance.mutate([{ target: instance.document, addedNodes: [own] }]);
  assert.equal(instance.scripts.at(-1), own);
});

test('Vimeo observer publishes only ten configs and preserves unrelated data nodes', async () => {
  let id = '1';
  const instance = fixture({ fetchImpl: () => Promise.resolve(response(config(id), { url: endpoint(id) })) });
  const foreign = { id: 'mosaic-vimeo-config-1', textContent: 'unchanged' };
  instance.scripts.push(foreign);
  for (let i = 1; i <= 12; i++) {
    id = String(i); await instance.context.fetch(endpoint(id));
    await settled(() => instance.data()?.configs.at(-1).video.id === id);
  }
  assert.equal(instance.data().configs.length, 10);
  assert.equal(instance.scripts.length, 2);
  assert.equal(instance.scripts[0], foreign);
  assert.equal(foreign.textContent, 'unchanged');
});

test('Vimeo XHR observation preserves original open, response and load event behavior', () => {
  const instance = fixture(), xhr = new instance.XHR(), raw = config(); let normal;
  xhr.addEventListener('load', event => { normal = event; });
  assert.equal(xhr.open('GET', endpoint('138191248'), true), 'original');
  const event = xhr.load(raw);
  assert.equal(normal, event); assert.equal(xhr.response, raw);
  assert.deepEqual(xhr.args, ['GET', endpoint('138191248'), true]);
  assert.equal(instance.data().configs[0].video.id, '138191248');
});

test('Vimeo body clones have a four MiB limit and at most three concurrent readers', async () => {
  let cancelled = false;
  const big = { status: 200, url: endpoint('138191248'), headers: new Headers({ 'Content-Type': 'application/json' }),
    clone() { return { body: { getReader() { return { read: async () => ({ done: false, value: new Uint8Array(4 * 1024 * 1024 + 1) }),
      cancel: async () => { cancelled = true; } }; } } }; } };
  const oversized = fixture({ fetchImpl: () => Promise.resolve(big) });
  await oversized.context.fetch(endpoint('138191248')); await settled(() => cancelled);
  assert.equal(oversized.data(), null);
  let readers = 0; const releases = [];
  const pending = { ...big, clone() { readers++; return { body: { getReader() { return {
    read() { return new Promise(resolve => releases.push(() => resolve({ done: true }))); }, cancel: async () => {}
  }; } } }; } };
  const concurrent = fixture({ fetchImpl: () => Promise.resolve(pending) });
  await Promise.all(Array.from({ length: 5 }, () => concurrent.context.fetch(endpoint('138191248'))));
  assert.equal(readers, 3); releases.forEach(release => release());
});

test('Vimeo read timeout releases the cloned body without cancelling the site response', async () => {
  let timeout, cancel;
  const original = { status: 200, url: endpoint('138191248'), headers: new Headers({ 'Content-Type': 'application/json' }),
    clone() { return { body: { getReader() { let resolve; return {
      read() { return new Promise(done => { resolve = done; }); }, cancel: async () => { cancel = true; resolve({ done: true }); }
    }; } } }; } };
  const instance = fixture({ fetchImpl: () => Promise.resolve(original) });
  instance.context.setTimeout = (callback, delay) => { assert.equal(delay, 8000); timeout = callback; return 1; };
  instance.context.clearTimeout = () => {};
  assert.equal(await instance.context.fetch(endpoint('138191248')), original);
  timeout(); await settled(() => cancel); assert.equal(instance.data(), null);
});

test('Vimeo observation leaves original fetch rejections unchanged and can wait for document root', async () => {
  const error = new Error('original'); const failure = fixture({ fetchImpl: () => Promise.reject(error) });
  await assert.rejects(failure.context.fetch(endpoint('138191248')), e => e === error);
  const instance = fixture({ ready: false });
  await instance.context.fetch(endpoint('138191248')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.data(), null); instance.ready(); await settled(() => instance.data());
  assert.equal(instance.data().configs.length, 1);
});
