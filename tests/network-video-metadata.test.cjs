'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/network-video-metadata.js'), 'utf8');
const resolverSource = fs.readFileSync(path.join(__dirname, '../extension/social-x.js'), 'utf8');
const page = new URL('https://x.com/person/status/123');
const api = 'https://x.com/i/api/graphql/graph123/TweetDetail?variables=%7B%7D';
const poster = id => `https://pbs.twimg.com/ext_tw_video_thumb/${id}/pu/img/poster.jpg`;
const mp4 = (id, quality = '1280x720') => `https://video.twimg.com/ext_tw_video/${id}/pu/vid/${quality}/clip.mp4?tag=12`;
const record = (id = '34', extra = {}) => ({ type: 'video', media_url_https: poster(id),
  expanded_url: `${page.href}/video/1`, video_info: { variants: [
    { content_type: 'video/mp4', url: mp4(id, '640x360'), bitrate: 500000 },
    { content_type: 'video/mp4', url: mp4(id), bitrate: 2000000 },
    { content_type: 'application/x-mpegURL', url: `https://video.twimg.com/ext_tw_video/${id}/pu/pl/clip.m3u8` }
  ] }, ...extra });

function response(data, { url = api, contentType = 'application/json', status = 200, body } = {}) {
  const result = new Response(body ?? JSON.stringify(data), { status, headers: { 'Content-Type': contentType } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

function fixture({ fetchImpl = () => Promise.resolve(response({ data: { media: [record()] } })), ready = true, initialScripts = [] } = {}) {
  const scripts = [...initialScripts];
  const readyListeners = [];
  const calls = [];
  let onMutations;
  const root = { appendChild(node) { scripts.push(node); node.isConnected = true; return node; } };
  const document = {
    documentElement: ready ? root : null,
    addEventListener(type, fn) { assert.equal(type, 'DOMContentLoaded'); readyListeners.push(fn); },
    createElement(tag) {
      assert.equal(tag, 'script');
      return { tagName: 'SCRIPT', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
        hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
        remove() { const index = scripts.indexOf(this); if (index >= 0) scripts.splice(index, 1); this.isConnected = false; } };
    },
    getElementById(id) { return scripts.find(node => node.id === id); },
    querySelectorAll() { return scripts; },
    defaultView: { location: page, performance: { getEntriesByType: () => [] } }
  };
  class XHR {
    constructor() { this.listeners = new Map(); this.responseType = ''; this.status = 200; this.responseURL = api; this.responseText = ''; this.headers = { 'content-type': 'application/json' }; }
    open(...args) { this.openArgs = args; return 'open-result'; }
    addEventListener(type, fn) { const listeners = this.listeners.get(type) || []; listeners.push(fn); this.listeners.set(type, listeners); }
    getResponseHeader(name) { return this.headers[name.toLowerCase()] || null; }
    load(data) {
      this.response = data;
      this.responseText = JSON.stringify(data);
      const bytes = new TextEncoder().encode(this.responseText).length;
      const event = { type: 'load', loaded: bytes, total: bytes };
      for (const fn of this.listeners.get('load') || []) fn.call(this, event);
      return event;
    }
  }
  const originalFetch = function (...args) { calls.push({ self: this, args }); return fetchImpl(...args); };
  class MutationObserver {
    constructor(callback) { onMutations = callback; }
    observe() {}
  }
  const context = vm.createContext({ URL, Request, Response, TextDecoder, TextEncoder, document, location: page,
    XMLHttpRequest: XHR, fetch: originalFetch, setTimeout, clearTimeout, MutationObserver });
  vm.runInContext(source, context);
  return { scripts, context, calls, document, root, XHR, originalFetch,
    mutate(changes) { onMutations(changes); },
    ready() { document.documentElement = root; for (const fn of readyListeners) fn(); },
    data() { return scripts.length ? JSON.parse(scripts.at(-1).textContent) : null; },
    resolve(video) { vm.runInContext(resolverSource, context); return context.MosaicXVideo({ document, page, video, path: [] }); }
  };
}

async function settled(predicate, message = 'Metadata observer did not settle') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(message);
}

test('X network JSON publishes only sanitized video records and the resolver selects the correct MP4', async () => {
  const raw = { data: { tweet: { text: 'private text must not be copied', user: { email: 'not-retained@example.test' },
    extended_entities: { media: [record('34'), record('35')] } } } };
  const originalResponse = response(raw);
  const originalPromise = Promise.resolve(originalResponse);
  const instance = fixture({ fetchImpl: () => originalPromise });
  const customThis = { test: true };
  const actualPromise = instance.context.fetch.call(customThis, api, { method: 'GET' });
  assert.equal(actualPromise, originalPromise);
  assert.equal(await actualPromise, originalResponse);
  assert.equal(instance.calls[0].self, customThis);
  await settled(() => instance.scripts.length === 1);
  assert.equal(instance.scripts[0].type, 'application/json');
  assert.equal(Object.hasOwn(instance.scripts[0].attributes, 'data-mosaic-video-records'), true);
  assert.equal(instance.data().media.length, 2);
  assert.equal(instance.data().media[0].video_info.variants.length, 2);
  assert.equal(instance.scripts[0].textContent.includes('private text'), false);
  assert.equal(instance.scripts[0].textContent.includes('email'), false);
  assert.deepEqual(await originalResponse.json(), raw);
  assert.equal(instance.resolve({ poster: poster('34'), currentSrc: 'blob:https://x.com/test' }).url, mp4('34'));
});

test('X network observation decodes only the named unified-card media_entities string', async () => {
  const first = '1578391494028890119', second = '1578400766095654915';
  const card = { type: 'video_multi_dest_carousel_website', media_entities: {
    [`13_${first}`]: record(first), [`13_${second}`]: record(second)
  }, unrelated: 'not published' };
  const payload = { data: { tweet_result_by_rest_id: { result: { card: { legacy: { binding_values: [
    { key: 'unified_card', value: { type: 'STRING', string_value: JSON.stringify(card) } },
    { key: 'other_string', value: { string_value: JSON.stringify({ media_entities: { unwanted: record('999') } }) } }
  ] } } } } } };
  const instance = fixture({ fetchImpl: () => Promise.resolve(response(payload)) });
  await instance.context.fetch(api);
  await settled(() => instance.scripts.length === 1);
  assert.deepEqual(instance.data().media.map(item => item.media_url_https), [poster(first), poster(second)]);
  assert.equal(instance.resolve({ poster: poster(second), currentSrc: 'blob:https://x.com/selected' }).url, mp4(second));
  assert.equal(instance.scripts[0].textContent.includes('not published'), false);
  assert.equal(instance.scripts[0].textContent.includes('999'), false);
});

test('X initial SSR stream data is captured before isolated scripts start', () => {
  const payload = { data: { media: [record()] } };
  const textContent = `($R=>$R[2].next({value:${JSON.stringify(JSON.stringify(payload))}}))($R["tsr"]);document.currentScript.remove()`;
  const initial = { tagName: 'SCRIPT', textContent };
  const instance = fixture({ initialScripts: [initial] });
  assert.equal(instance.data().media[0].media_url_https, poster('34'));
  assert.equal(instance.scripts[0], initial);
  assert.equal(instance.scripts.length, 2);
});

test('X observes nested and self-removed SSR scripts plus later text updates', () => {
  const instance = fixture();
  const script = { tagName: 'SCRIPT', textContent: '' };
  const parent = { querySelectorAll: () => [script] };
  instance.mutate([{ target: instance.document, addedNodes: [parent] }]);
  assert.equal(instance.scripts.length, 0);
  script.textContent = `($R=>$R[2].next({value:${JSON.stringify(JSON.stringify({ media: [record()] }))}}))($R["tsr"]);document.currentScript.remove()`;
  instance.mutate([{ target: { parentElement: script }, type: 'characterData', addedNodes: [], removedNodes: [script] }]);
  assert.equal(instance.data().media[0].media_url_https, poster('34'));
  const own = instance.scripts[0];
  instance.mutate([{ target: instance.document, addedNodes: [own] }]);
  assert.equal(instance.scripts.length, 1);
  assert.equal(instance.scripts[0], own);
});

test('X observer never reads non-target endpoints, direct messages, off-origin JSON, or failed responses', async t => {
  for (const url of [
    'https://x.com/i/api/graphql/token/DmInbox',
    'https://x.com/i/api/1.1/dm/inbox_initial_state.json',
    'https://x.com/i/api/graphql/token/Viewer',
    'https://other.example/i/api/graphql/token/TweetDetail',
    'https://api.x.com/i/api/graphql/token/TweetDetail',
    'https://x.com.example/i/api/graphql/token/TweetDetail'
  ]) await t.test(url, async () => {
    let clones = 0;
    const original = { status: 200, url, headers: new Headers({ 'content-type': 'application/json' }), clone() { clones++; throw new Error('Must not read'); } };
    const instance = fixture({ fetchImpl: () => Promise.resolve(original) });
    assert.equal(await instance.context.fetch(url), original);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clones, 0);
    assert.equal(instance.scripts.length, 0);
  });
  for (const options of [{ status: 403 }, { contentType: 'text/html' }, { url: 'https://x.com/i/api/graphql/token/DmInbox' }]) {
    const instance = fixture({ fetchImpl: () => Promise.resolve(response({ media: [record()] }, options)) });
    await instance.context.fetch(api);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instance.scripts.length, 0);
  }
});

test('X observer leaves original fetch rejections and synchronous errors unchanged', async () => {
  const failure = new Error('original fetch failed');
  const rejected = Promise.reject(failure);
  const instance = fixture({ fetchImpl: () => rejected });
  const actual = instance.context.fetch(api);
  assert.equal(actual, rejected);
  await assert.rejects(actual, error => error === failure);
  const sync = fixture({ fetchImpl() { throw failure; } });
  assert.throws(() => sync.context.fetch(api), error => error === failure);
});

test('X response clones are read with a four MiB limit and cancelled when too large', async () => {
  let cancelled = false;
  let reads = 0;
  const original = { status: 200, url: api, headers: new Headers({ 'content-type': 'application/json' }),
    clone() { return { body: { getReader() { return {
      async read() { reads++; return { value: new Uint8Array(4 * 1024 * 1024 + 1), done: false }; },
      async cancel() { cancelled = true; }
    }; } } }; } };
  const instance = fixture({ fetchImpl: () => Promise.resolve(original) });
  await instance.context.fetch(api);
  await settled(() => cancelled);
  assert.equal(reads, 1);
  assert.equal(instance.scripts.length, 0);
});

test('X clone reading has at most three concurrent readers', async () => {
  let readers = 0;
  const releases = [];
  const original = () => ({ status: 200, url: api, headers: new Headers({ 'content-type': 'application/json' }),
    clone() { readers++; return { body: { getReader() { return {
      read() { return new Promise(resolve => releases.push(() => resolve({ done: true }))); }, async cancel() {}
    }; } } }; } });
  const instance = fixture({ fetchImpl: () => Promise.resolve(original()) });
  await Promise.all(Array.from({ length: 5 }, () => instance.context.fetch(api)));
  assert.equal(readers, 3);
  for (const release of releases) release();
  await new Promise(resolve => setImmediate(resolve));
});

test('X updates use new data node identities without altering pre-existing scripts', async () => {
  let next = '34';
  const instance = fixture({ fetchImpl: () => Promise.resolve(response({ media: [record(next)] })) });
  const foreign = { id: 'mosaic-video-records-1', type: 'application/json', textContent: '{"keep":true}' };
  instance.scripts.push(foreign);
  await instance.context.fetch(api);
  await settled(() => instance.scripts.length === 2);
  const previous = instance.scripts[1];
  next = '35';
  await instance.context.fetch(api);
  await settled(() => instance.scripts[1] !== previous);
  assert.equal(instance.scripts.length, 2);
  assert.equal(instance.scripts[0], foreign);
  assert.equal(instance.scripts[0].textContent, '{"keep":true}');
  assert.equal(instance.data().media.length, 2);
  assert.notEqual(instance.scripts[1].id, previous.id);
});

test('X records and variants stay bounded and reject mismatched or spoofed CDN sources', async () => {
  const entries = Array.from({ length: 90 }, (_, index) => record(String(index + 1), { video_info: { variants: [
    ...Array.from({ length: 32 }, () => ({ content_type: 'video/mp4', url: mp4(String(index + 1)), bitrate: 1 })),
    { content_type: 'video/mp4', url: mp4('999') }, { content_type: 'video/mp4', url: mp4(String(index + 1)).replace('video.twimg.com', 'video.twimg.com.example') }
  ] } }));
  const instance = fixture({ fetchImpl: () => Promise.resolve(response({ media: entries })) });
  await instance.context.fetch(new Request(api));
  await settled(() => instance.scripts.length === 1);
  assert.equal(instance.data().media.length, 80);
  assert.ok(instance.data().media.every(item => item.video_info.variants.length <= 30));
  assert.ok(instance.data().media.every(item => item.video_info.variants.every(item => !item.url.includes('.example'))));
});

test('X download restrictions survive later ordinary metadata', async () => {
  let entry = record('34', { allow_download_status: { allow_download: false }, text: 'not exposed' });
  const instance = fixture({ fetchImpl: () => Promise.resolve(response({ media: [entry] })) });
  await instance.context.fetch(api);
  await settled(() => instance.scripts.length === 1);
  const previous = instance.scripts[0];
  entry = record('34');
  await instance.context.fetch(api);
  await settled(() => instance.scripts[0] !== previous);
  assert.equal(instance.data().media[0].allow_download_status.allow_download, false);
  assert.match(instance.resolve({ poster: poster('34') }).error, /下载已关闭/);
});

test('X XHR observation preserves open arguments, response data, and normal load listeners', () => {
  const instance = fixture();
  const xhr = new instance.XHR();
  const data = { media: [record()] };
  let received = null;
  xhr.addEventListener('load', event => { received = event; });
  assert.equal(xhr.open('GET', api, true, 'ignored-user', 'ignored-password'), 'open-result');
  assert.deepEqual(xhr.openArgs, ['GET', api, true, 'ignored-user', 'ignored-password']);
  const event = xhr.load(data);
  assert.equal(received, event);
  assert.equal(xhr.response, data);
  assert.equal(xhr.responseText, JSON.stringify(data));
  assert.equal(instance.data().media.length, 1);
  const other = new instance.XHR();
  other.open('GET', 'https://x.com/i/api/graphql/token/DmInbox');
  other.load({ media: [record('35')] });
  assert.equal(instance.data().media.length, 1);
});

test('X network records wait for the document root without exposing data elsewhere', async () => {
  const instance = fixture({ ready: false });
  await instance.context.fetch(api);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.scripts.length, 0);
  instance.ready();
  await settled(() => instance.scripts.length === 1);
  assert.equal(instance.data().media[0].media_url_https, poster('34'));
});
