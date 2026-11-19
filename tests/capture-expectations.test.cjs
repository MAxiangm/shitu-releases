'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const contentSource = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';
const pageUrl = 'https://media.example/video';
const videoUrl = 'https://media.example/video.mp4';

function content({ sourcePage = pageUrl, properties = {}, adapter, youtube = false } = {}) {
  const nodes = [], events = new Map(), messages = [];
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.style = {}; this.isConnected = true; nodes.push(this); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener() {}
    append(...children) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
    attachShadow() { return new Element('shadow'); }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll(selector) { return selector === ':scope > video, :scope > * > video' ? this.children.filter(child => child.tagName === 'VIDEO') : []; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 }; }
    remove() { this.isConnected = false; }
  }
  const html = new Element('html'), body = new Element('body'), wrapper = new Element('div'), video = new Element('video');
  html.append(body); body.append(wrapper); wrapper.append(video);
  Object.assign(video, { currentSrc: videoUrl, duration: 21.5, ...properties });
  const hitPath = [video, wrapper, body, html];
  const document = { title: 'Selected video', baseURI: sourcePage, documentElement: html, body,
    createElement: tag => new Element(tag), elementsFromPoint: () => [video],
    querySelectorAll: selector => selector === 'video' ? [video] : [] };
  const context = { Element, URL, document, location: { href: sourcePage }, performance: { now: () => Date.now() },
    setTimeout: () => 1, clearTimeout() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', backgroundImage: 'none' }),
    window: { addEventListener: (type, callback) => events.set(type, [...(events.get(type) || []), callback]) },
    chrome: { runtime: { id: extensionId, onMessage: { addListener() {} }, sendMessage: async message => {
      messages.push(message); return { ok: true, imported: 1, duplicates: 0 };
    } } }, fetch: async () => { throw new Error('Direct video expectation capture must not read a media file'); } };
  if (youtube) context.MosaicYouTubeVideo = Object.assign(adapter, { isPage: () => true, pageSource: () => ({ videoId: 'AbCdEfGhI_1' }) });
  else if (adapter) context.MosaicXVideo = adapter;
  vm.runInNewContext(contentSource, context);
  function gesture(type, extra = {}) {
    const event = { isTrusted: true, button: 2, altKey: true, clientX: 20, clientY: 20, composedPath: () => hitPath,
      preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    for (const callback of events.get(type) || []) { callback(event); if (event.stopped) break; }
  }
  return { video, messages, gesture };
}

async function until(read) {
  for (let index = 0; index < 100; index++) { const value = read(); if (value) return value; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Expected asynchronous capture was not submitted');
}

async function captured(options) {
  const instance = content(options);
  instance.gesture('pointerdown'); instance.gesture('contextmenu');
  return (await until(() => instance.messages.find(message => message.type === 'shitu:capture'))).media;
}

test('trusted video capture includes finite duration and positive audio evidence only', async () => {
  for (const properties of [{ audioTracks: { length: 1 } }, { mozHasAudio: true }, { webkitAudioDecodedByteCount: 128 }]) {
    const media = await captured({ properties });
    assert.equal(media.expectedDuration, 21.5);
    assert.equal(media.expectedAudio, true);
  }
  const unknown = await captured({ properties: { audioTracks: { length: 0 }, mozHasAudio: false, webkitAudioDecodedByteCount: 0 } });
  assert.equal(Object.hasOwn(unknown, 'expectedAudio'), false, 'Missing audio API evidence must not assert a silent source');
  for (const duration of [NaN, Infinity, 0, -1, 86401, '21.5']) {
    assert.equal(Object.hasOwn(await captured({ properties: { duration } }), 'expectedDuration'), false);
  }
});

test('the pointerdown snapshot is retained when the video changes before contextmenu', async () => {
  const instance = content({ properties: { webkitAudioDecodedByteCount: 100 } });
  instance.gesture('pointerdown');
  instance.video.duration = 1;
  instance.video.webkitAudioDecodedByteCount = 0;
  instance.gesture('contextmenu', { altKey: false });
  const media = (await until(() => instance.messages.find(message => message.type === 'shitu:capture'))).media;
  assert.equal(media.expectedDuration, 21.5);
  assert.equal(media.expectedAudio, true);
});

test('async selected-post resolution cannot downgrade the original media expectations', async () => {
  let finish;
  const adapter = Object.assign(() => null, {
    resolveAsync: () => new Promise(resolve => { finish = resolve; }), matchesSelection: () => true
  });
  const instance = content({ sourcePage: 'https://x.com/example/status/12345', properties: { audioTracks: { length: 1 } }, adapter });
  instance.gesture('pointerdown');
  await until(() => finish);
  instance.video.duration = 3;
  instance.video.audioTracks.length = 0;
  instance.video.isConnected = false;
  finish({ url: videoUrl, pageUrl: 'https://x.com/example/status/12345' });
  const media = (await until(() => instance.messages.find(message => message.type === 'shitu:capture'))).media;
  assert.equal(media.expectedDuration, 21.5);
  assert.equal(media.expectedAudio, true);
  assert.equal(media.socialPageUrl, 'https://x.com/example/status/12345');
});

test('YouTube player ad duration and audio evidence are omitted in favor of downloader metadata', async () => {
  const media = await captured({ sourcePage: 'https://www.youtube.com/watch?v=AbCdEfGhI_1', youtube: true,
    properties: { duration: 6, webkitAudioDecodedByteCount: 100 },
    adapter: () => ({ url: 'https://www.youtube.com/watch?v=AbCdEfGhI_1', sourceType: 'youtube', videoId: 'AbCdEfGhI_1' }) });
  assert.equal(media.sourceType, 'youtube');
  assert.equal(Object.hasOwn(media, 'expectedDuration'), false);
  assert.equal(Object.hasOwn(media, 'expectedAudio'), false);
});

function worker({ progress = false } = {}) {
  let receive;
  const captures = [], notices = [], storage = { shituConnection: { port: 38475, token: 'a'.repeat(64) } };
  vm.runInNewContext(workerSource, {
    URL, AbortController, AbortSignal, setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds === 1000 ? 1 : milliseconds), clearTimeout,
    setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval,
    chrome: {
      runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`, getPlatformInfo: async () => ({}),
        onMessage: { addListener: callback => { receive = callback; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: storage[key] }), set: async fields => Object.assign(storage, fields) } },
      tabs: { sendMessage: async (_id, message) => { notices.push(message); } },
      contextMenus: { removeAll: callback => callback(), create: (_item, callback) => callback(), onClicked: { addListener() {} } }
    },
    fetch: async (url, options) => {
      const route = new URL(url).pathname;
      if (route === '/v1/capture') {
        captures.push(JSON.parse(options.body));
        if (progress) await new Promise(resolve => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ ok: true, imported: 1, duplicates: 0, assetIds: ['saved'] }));
      }
      if (route === '/v1/capture-progress') return new Response(JSON.stringify({ ok: true, progress: { phase: 'verifying', receivedBytes: 100 } }));
      return new Response(JSON.stringify({ ok: true, app: '拾图', version: '0.29.23', ready: true, captureProgress: progress, youtubeDownload: true, youtubeBrowserSession: true }));
    }
  });
  return { captures, notices, send: (media, senderUrl = pageUrl) => new Promise(resolve => receive({ type: 'shitu:capture', media },
    { id: extensionId, url: senderUrl, tab: { id: 1, url: senderUrl } }, resolve)) };
}

test('capture worker forwards valid media expectations and rejects malformed values before submission', async () => {
  const instance = worker();
  const media = { kind: 'video', url: videoUrl, expectedDuration: 21.5, expectedAudio: true };
  assert.equal((await instance.send(media)).ok, true);
  assert.equal(instance.captures[0].expectedDuration, 21.5);
  assert.equal(instance.captures[0].expectedAudio, true);
  for (const patch of [{ expectedDuration: NaN }, { expectedDuration: Infinity }, { expectedDuration: 0 }, { expectedDuration: -1 },
    { expectedDuration: 86401 }, { expectedDuration: '21.5' }, { expectedAudio: false }, { expectedAudio: 'true' }, { kind: 'image' }]) {
    assert.equal((await instance.send({ ...media, ...patch })).ok, false, JSON.stringify(patch));
  }
  assert.equal(instance.captures.length, 1);
});

test('worker drops valid ad-tainted expectations for YouTube captures', async () => {
  const instance = worker();
  assert.equal((await instance.send({ kind: 'video', sourceType: 'youtube', videoId: 'AbCdEfGhI_1',
    url: 'https://www.youtube.com/watch?v=AbCdEfGhI_1', expectedDuration: 6, expectedAudio: true },
  'https://www.youtube.com/watch?v=AbCdEfGhI_1')).ok, true);
  assert.equal(Object.hasOwn(instance.captures[0], 'expectedDuration'), false);
  assert.equal(Object.hasOwn(instance.captures[0], 'expectedAudio'), false);
});

test('video verification progress is shown before a saved receipt', async () => {
  const instance = worker({ progress: true });
  assert.equal((await instance.send({ kind: 'video', url: videoUrl })).ok, true);
  assert.ok(instance.notices.some(message => message.progress?.phase === 'verifying' && /检查视频画面、声音和时长/.test(message.message)));
});
