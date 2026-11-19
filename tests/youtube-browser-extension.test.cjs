'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helper = require('../extension/youtube-browser-source.js');

const root = path.resolve(__dirname, '..');
const script = file => fs.readFileSync(path.join(root, 'extension', file), 'utf8');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';
const videoId = 'BaW_jenozKc';
const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
const mediaUrl = (itag, extra = '') => `https://rr1.googlevideo.com/videoplayback?id=selected.1&itag=${itag}&clen=16&lmt=123&sig=a%20b${extra}`;
const stream = (overrides = {}) => ({ url: mediaUrl(18), mimeType: 'video/mp4', contentLength: 16,
  duration: 30, itag: 18, hasVideo: true, hasAudio: true, ...overrides });
const browserSource = (overrides = {}) => ({ sourceType: 'youtube-browser', kind: 'video', videoId, url: pageUrl,
  pageUrl, expectedDuration: 30, expectedAudio: true, streams: [stream()], ...overrides });
const metadata = (overrides = {}) => ({ videos: [{ videoId, title: 'Selected video', duration: 30, streams: [stream()], ...overrides }] });
const metadataDocument = data => ({ querySelectorAll: () => [{ textContent: JSON.stringify(data) }] });

test('YouTube browser selection requires one exact public video and full finite files', () => {
  const combined = helper.selectSource(metadataDocument(metadata()), videoId);
  assert.equal(combined.expectedDuration, 30);
  assert.equal(combined.expectedAudio, true);
  assert.equal(combined.streams[0].url, mediaUrl(18), 'signed query bytes are preserved');
  const video = stream({ url: mediaUrl(137), itag: 137, hasAudio: false, height: 1080 });
  const audio = stream({ url: mediaUrl(140), itag: 140, mimeType: 'audio/mp4', hasVideo: false, audioTrack: 'en.0' });
  const pair = helper.selectSource(metadataDocument(metadata({ streams: [video, audio] })), videoId);
  assert.equal(pair.streams.length, 2);
  for (const data of [metadata({ restricted: true }), metadata({ videoId: 'AAAAAAAAAAA' }), metadata({ duration: 0 }),
    metadata({ streams: [video] }), metadata({ streams: [video, audio, { ...audio, audioTrack: 'fr.0' }] }),
    { videos: [...metadata().videos, ...metadata().videos] }]) {
    assert.equal(helper.selectSource(metadataDocument(data), videoId), null);
  }
});

test('YouTube browser validator rejects manifests, partial requests, unsafe hosts and mismatched metadata', () => {
  for (const url of [mediaUrl(18, '&range=0-15'), mediaUrl(18, '&ump=0'), mediaUrl(18, '&sabr=1'), mediaUrl(18, '&sq=1'),
    mediaUrl(18, '&live=0'), mediaUrl(18, '&sig=duplicate'), mediaUrl(18).replace('googlevideo.com', 'googlevideo.com.evil.test'),
    mediaUrl(18).replace('https:', 'http:'), mediaUrl(18).replace('/videoplayback', '/master.m3u8'),
    mediaUrl(18).replace('rr1.', 'user:pass@rr1.'), mediaUrl(18).replace('googlevideo.com/', 'googlevideo.com:444/')]) {
    assert.equal(helper.checkedSource(browserSource({ streams: [stream({ url })] })), null, url);
  }
  for (const change of [{ expectedDuration: '30' }, { expectedDuration: 86401 }, { expectedAudio: false },
    { videoId: 'AAAAAAAAAAA' }, { pageUrl: `${pageUrl}&list=playlist` }, { streams: [] },
    { streams: [stream({ contentLength: 15 })] }, { streams: [stream({ duration: 5 })] },
    { streams: [stream({ hasAudio: false })] }, { streams: [stream(), stream()] },
    { streams: [stream({ url: mediaUrl(137), itag: 137, hasAudio: false }),
      stream({ url: mediaUrl(251), itag: 251, hasVideo: false, mimeType: 'audio/webm' })] }]) {
    assert.equal(helper.checkedSource(browserSource(change)), null);
  }
});

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; }
async function until(read) {
  for (let i = 0; i < 150; i++) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected asynchronous capture result');
}

function harness({ failCode = 'VIDEO_SOURCE_FAILED', capability = true, beforeFallback, payload = metadata(),
  secondFail, maliciousRead, browserStatus = 200, dropResponse = false } = {}) {
  const events = new Map(), pageListeners = [], notices = [], requests = [], fetches = [], uploads = [];
  const sender = { id: extensionId, url: pageUrl, documentId: 'youtube-document', frameId: 2, tab: { id: 17, url: pageUrl } };
  let workerListener, activeRead = null, remaining = [], serial = 0;
  const completed = deferred();
  const captured = deferred();
  const storage = { shituConnection: { port: 38475, token: 'a'.repeat(64) } };
  const scheduled = new Set();
  const timer = (fn, ms) => { const value = setTimeout(fn, ms); value.unref(); scheduled.add(value); return value; };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.style = {}; this.isConnected = true; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    addEventListener() {}
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    attachShadow() { return new Element('shadow'); }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 }; }
    remove() { this.isConnected = false; }
  }
  const html = new Element('html'), body = new Element('body'), wrapper = new Element('div'), video = new Element('video');
  html.append(body); body.append(wrapper); wrapper.append(video);
  Object.assign(video, { currentSrc: 'blob:https://www.youtube.com/selected', poster: 'https://i.ytimg.com/vi/BaW_jenozKc/0.jpg',
    duration: 6, webkitAudioDecodedByteCount: 1 });
  const metadataNode = { textContent: JSON.stringify(payload) };
  const location = new URL(pageUrl);
  const document = { baseURI: pageUrl, title: 'Selected video - YouTube', documentElement: html, body,
    createElement: tag => new Element(tag), elementsFromPoint: () => [video],
    querySelectorAll: selector => selector === 'video' ? [video] : selector === 'div[data-mosaic-youtube-media]' ? [metadataNode] : [] };
  const dispatchPage = async message => {
    if (message.type === 'shitu:resolve-youtube-browser') beforeFallback?.({ video, location, metadataNode });
    for (const listener of pageListeners) {
      let called = false;
      const response = deferred();
      const asynchronous = listener(message, { id: extensionId }, value => { called = true; response.resolve(value); });
      if (called || asynchronous === true) return response.promise;
    }
    return undefined;
  };
  const workerChrome = {
    runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`, getPlatformInfo: async () => ({}),
      getManifest: () => ({ version: '0.11.23' }), onMessage: { addListener: value => { workerListener = value; } },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: storage[key] }),
      set: async value => { Object.assign(storage, structuredClone(value)); } } },
    contextMenus: { removeAll: callback => callback(), create: (_item, callback) => callback(), onClicked: { addListener() {} } },
    tabs: { sendMessage: async (id, message, target) => { notices.push({ id, message, target }); return dispatchPage(message); } }
  };
  const fromPage = message => new Promise(resolve => workerListener(message, sender, resolve));
  const workerContext = { chrome: workerChrome, URL, AbortController, AbortSignal, setTimeout: timer, clearTimeout,
    setInterval: (...args) => { const value = setInterval(...args); value.unref(); return value; }, clearInterval,
    fetch: async (url, options) => {
      const route = new URL(url).pathname, request = JSON.parse(options.body);
      requests.push({ route, body: request });
      let result;
      if (route === '/v1/ping') result = { ok: true, app: '拾图', version: '0.29.22', ready: true,
        libraryId: 'library-fixture', youtubeDownload: true, youtubeBrowserSession: true, youtubeBrowserRead: capability };
      else if (route === '/v1/capture') {
        if (dropResponse) throw new TypeError('Response connection lost after possible import');
        if (request.sourceType !== 'youtube-browser') result = { ok: false, code: failCode, error: 'Initial downloader failed' };
        else if (secondFail) result = { ok: false, code: 'VIDEO_SOURCE_FAILED', error: 'Browser file failed' };
        else {
          remaining = request.streams.map(item => ({ sourceType: 'youtube-browser', readId: `read-${++serial}`,
            url: item.url, limit: item.contentLength }));
          result = await completed.promise;
        }
      } else if (route === '/v1/capture-browser-read') {
        activeRead ||= remaining.shift() || null;
        result = { ok: true, read: activeRead ? { ...activeRead, ...maliciousRead } : null };
      } else if (route === '/v1/capture-browser-data') {
        uploads.push(request);
        if (request.error) { completed.resolve({ ok: false, code: 'VIDEO_SOURCE_FAILED', error: request.error }); activeRead = null; }
        else if (request.done) {
          activeRead = null;
          if (!remaining.length) completed.resolve({ ok: true, imported: 1, duplicates: 0, assetIds: ['saved'] });
        }
        result = { ok: true };
      } else if (route === '/v1/capture-browser-cancel') result = { ok: true, cancelled: true };
      else throw new Error(`Unexpected route ${route}`);
      return new Response(JSON.stringify(result));
    }
  };
  vm.runInNewContext(script('youtube-browser-source.js'), workerContext);
  vm.runInNewContext(script('background.js'), workerContext);
  const pageContext = { Element, URL, AbortController, AbortSignal, TextDecoder, document, location, performance: { now: () => Date.now() },
    setTimeout: timer, clearTimeout, getComputedStyle: () => ({ display: 'block', visibility: 'visible', backgroundImage: 'none' }),
    window: { addEventListener: (type, listener) => events.set(type, [...(events.get(type) || []), listener]) },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    chrome: { runtime: { id: extensionId, onMessage: { addListener: value => pageListeners.push(value) }, sendMessage: async message => {
      const result = await fromPage(message);
      if (message.type === 'shitu:capture') captured.resolve(result);
      return result;
    } } },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      let read = false;
      return { url, status: browserStatus, headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '16' }),
        body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { value: new Uint8Array(16), done: false }), cancel: async () => {} }) } };
    }
  };
  for (const file of ['youtube-browser-source.js', 'social-youtube.js', 'vimeo-browser-read.js', 'content.js']) vm.runInNewContext(script(file), pageContext);
  return { requests, notices, fetches, uploads, captured, video, pageContext, fromPage,
    stop() { for (const value of scheduled) clearTimeout(value); },
    gesture() {
      const event = { isTrusted: true, button: 2, altKey: true, clientX: 20, clientY: 20, composedPath: () => [video, wrapper, body, html],
        preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
      for (const listener of events.get('pointerdown') || []) { listener(event); if (event.stopped) break; }
    }
  };
}

test('Alt+right retries eligible YouTube failures through the same selected browser and waits for saved receipt', async () => {
  for (const failCode of ['AUTH_REQUIRED', 'NETWORK', 'UNSUPPORTED', 'VIDEO_SOURCE_FAILED']) {
    const fixture = harness({ failCode });
    try {
      fixture.gesture();
      const result = await fixture.captured.promise;
      assert.equal(result.ok, true, result.error);
      const captures = fixture.requests.filter(item => item.route === '/v1/capture').map(item => item.body);
      assert.equal(captures.length, 2);
      assert.equal(captures[0].sourceType, 'youtube');
      assert.equal(captures[1].sourceType, 'youtube-browser');
      assert.equal(captures[1].requestId, captures[0].requestId);
      assert.equal(captures[1].expectedDuration, 30, 'ad duration must not taint video validation');
      assert.equal(captures[1].expectedAudio, true);
      assert.equal(Object.hasOwn(captures[0], 'youtubeSelectionId'), false, 'selection receipt never enters desktop payload');
      assert.equal(fixture.fetches.length, 1);
      assert.equal(fixture.fetches[0].options.credentials, 'omit');
      assert.equal(fixture.fetches[0].options.redirect, 'error');
      assert.equal(Buffer.from(fixture.uploads.find(packet => packet.dataBase64).dataBase64, 'base64').length, 16);
      const read = fixture.notices.find(item => item.message.type === 'shitu:vimeo-browser-read');
      assert.equal(read.message.sourceType, 'youtube-browser');
      assert.equal(read.target.documentId, 'youtube-document');
    } finally { fixture.stop(); }
  }
});

test('YouTube fallback reads both exact video and audio streams before completing', async () => {
  const fixture = harness({ payload: metadata({ streams: [stream({ url: mediaUrl(137), itag: 137, hasAudio: false }),
    stream({ url: mediaUrl(140), itag: 140, mimeType: 'audio/mp4', hasVideo: false, audioTrack: 'en.0' })] }) });
  try {
    fixture.gesture();
    assert.equal((await fixture.captured.promise).ok, true);
    assert.deepEqual(fixture.fetches.map(item => item.url), [mediaUrl(137), mediaUrl(140)]);
    assert.equal(fixture.uploads.filter(item => item.done).length, 2);
  } finally { fixture.stop(); }
});

test('changed, detached, restricted or unavailable selections cannot fall back to another video', async () => {
  for (const options of [
    { beforeFallback: ({ video }) => { video.currentSrc = 'blob:https://www.youtube.com/other'; } },
    { beforeFallback: ({ video }) => { video.isConnected = false; } },
    { beforeFallback: ({ video }) => { video.mediaKeys = {}; } },
    { beforeFallback: ({ location }) => { location.href = 'https://www.youtube.com/watch?v=AAAAAAAAAAA'; } },
    { payload: metadata({ videoId: 'AAAAAAAAAAA' }) }, { payload: metadata({ restricted: true }) },
    { capability: false }, { secondFail: true }
  ]) {
    const fixture = harness(options);
    try {
      fixture.gesture();
      assert.equal((await fixture.captured.promise).ok, false);
      assert.equal(fixture.fetches.length, 0);
      assert.equal(fixture.requests.filter(item => item.route === '/v1/capture').length, options.secondFail ? 2 : 1);
    } finally { fixture.stop(); }
  }
});

test('YouTube never retries library errors, uncertain commits or unrelated failures', async () => {
  for (const failCode of ['CAPTURE_LIBRARY_CHANGED', 'CAPTURE_FOLDER_MISSING', 'CAPTURE_PENDING', 'SERVER_ERROR', 'VIDEO_INCOMPLETE']) {
    const fixture = harness({ failCode });
    try {
      fixture.gesture();
      assert.equal((await fixture.captured.promise).ok, false);
      assert.equal(fixture.requests.filter(item => item.route === '/v1/capture').length, 1);
      assert.equal(fixture.notices.some(item => item.message.type === 'shitu:resolve-youtube-browser'), false);
    } finally { fixture.stop(); }
  }
});

test('relay rejects a different video URL and partial responses before forwarding file bytes', async () => {
  for (const options of [{ maliciousRead: { url: mediaUrl(99) } }, { maliciousRead: { sourceType: 'vimeo' } }, { browserStatus: 206 }]) {
    const fixture = harness(options);
    try {
      fixture.gesture();
      const result = await fixture.captured.promise;
      assert.equal(result.ok, false);
      assert.equal(fixture.uploads.some(item => item.dataBase64), false);
      if (options.maliciousRead) assert.equal(fixture.fetches.length, 0);
    } finally { fixture.stop(); }
  }
});

test('browser fallback cannot be submitted directly without a trusted selected-player receipt', async () => {
  const fixture = harness();
  try {
    assert.equal((await fixture.fromPage({ type: 'shitu:capture', media: browserSource() })).ok, false);
    assert.equal(fixture.requests.length, 0);
  } finally { fixture.stop(); }
});

test('a dropped desktop response never resubmits a possibly committed YouTube capture', async () => {
  const fixture = harness({ dropResponse: true });
  try {
    fixture.gesture();
    const result = await fixture.captured.promise;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TIMEOUT');
    assert.equal(fixture.requests.filter(item => item.route === '/v1/capture').length, 1);
    assert.equal(fixture.notices.some(item => item.message.type === 'shitu:resolve-youtube-browser'), false);
  } finally { fixture.stop(); }
});
