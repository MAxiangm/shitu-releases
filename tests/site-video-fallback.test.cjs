'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, 'extension', name), 'utf8');
const pages = require('../extension/video-page-source.js');
const { videoPageSource } = require('../src/video-page-source.cjs');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';
const post = { site: 'instagram', videoId: 'DQh8sFtjyTm', url: 'https://www.instagram.com/reel/DQh8sFtjyTm/' };

test('browser and native canonicalizers agree on supported selected-post pages', () => {
  for (const url of [post.url, 'https://m.instagram.com/name/reels/AbCdE_123/embed/captioned/?utm=1',
    'https://twitter.com/example/status/12345/video/2', 'https://platform.twitter.com/embed/Tweet.html?id=12345',
    'https://x.com/i/web/status/12345', 'https://ca.pinterest.com/pin/939845016006277613/?s=1',
    'https://player.vimeo.com/video/798860?h=abc', 'https://vimeo.com/groups/short/videos/798860']) {
    assert.deepEqual(pages.videoPageSource(url), videoPageSource(url), url);
  }
  for (const url of ['http://x.com/example/status/123', 'https://x.com.evil.test/example/status/123',
    'https://x.com:444/example/status/123', 'https://user:pass@vimeo.com/123', 'https://www.instagram.com/p/short code/',
    'https://x.com/home', 'https://vimeo.com/channels/foo', 'https://www.pinterest.com/pin/0/',
    'https://vimeo.com/123\\evil']) assert.equal(pages.videoPageSource(url), null, url);
});

function content({ url = post.url, mediaUrl = 'blob:https://www.instagram.com/selected', selected = () => post,
  resolve = () => ({ error: '未找到当前 Instagram 视频的完整文件。' }), site = 'instagram', adapterScript } = {}) {
  const messages = [], listeners = new Map(), nodes = [];
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.style = {}; this.isConnected = true; nodes.push(this); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener() {}
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    attachShadow() { return new Element('shadow'); }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll(selector) { return selector === ':scope > video, :scope > * > video' ? this.children.filter(node => node.tagName === 'VIDEO') : []; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
    remove() { this.isConnected = false; }
  }
  const html = new Element('html'), body = new Element('body'), wrapper = new Element('div'), video = new Element('video');
  html.append(body); body.append(wrapper); wrapper.append(video);
  Object.assign(video, { currentSrc: mediaUrl, duration: 40.87, webkitAudioDecodedByteCount: 100 });
  const hit = [video, wrapper, body, html];
  const document = { baseURI: url, title: 'Selected video', documentElement: html, body, createElement: tag => new Element(tag),
    querySelector: () => null, querySelectorAll: selector => selector === 'video' ? [video] : [], elementsFromPoint: () => [video] };
  const adapter = Object.assign(context => resolve(context), { selectedPage: context => selected(context), matchesSelection: () => true });
  const context = { Element, URL, AbortController, AbortSignal, TextDecoder, document, location: { href: url }, performance: { now: () => Date.now() }, setTimeout: () => 1, clearTimeout() {},
    window: { addEventListener: (type, callback) => listeners.set(type, [...(listeners.get(type) || []), callback]) },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', backgroundImage: 'none' }),
    fetch: async () => { throw new TypeError('Blob cannot be fetched'); },
    chrome: { runtime: { id: extensionId, onMessage: { addListener() {} }, sendMessage: async message => {
      messages.push(message); return { ok: true, imported: 1, duplicates: 0 };
    } } },
    [site === 'instagram' ? 'MosaicInstagramVideo' : site === 'x' ? 'MosaicXVideo' : site === 'pinterest' ? 'MosaicPinterestVideo' : 'MosaicVimeoVideo']: adapter
  };
  vm.runInNewContext(source('video-page-source.js'), context);
  if (adapterScript) vm.runInNewContext(source(adapterScript), context);
  vm.runInNewContext(source('content.js'), context);
  function gesture(type = 'pointerdown') {
    const event = { isTrusted: true, button: 2, altKey: true, clientX: 20, clientY: 20, composedPath: () => hit,
      preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
    for (const listener of listeners.get(type) || []) { listener(event); if (event.stopped) break; }
  }
  return { messages, video, gesture };
}

async function settled(fixture) {
  for (let i = 0; i < 80; i++) {
    const message = fixture.messages.find(item => ['shitu:capture', 'shitu:capture-failed'].includes(item.type));
    if (message) return message;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('No terminal capture message');
}

test('Alt+right falls back to the explicitly selected post when its player has no direct source', async () => {
  const fixture = content(); fixture.gesture();
  const message = await settled(fixture);
  assert.equal(message.type, 'shitu:capture');
  assert.equal(message.media.sourceType, 'site-video');
  assert.equal(message.media.site, post.site);
  assert.equal(message.media.url, post.url);
  assert.equal(message.media.videoId, post.videoId);
  assert.equal(message.media.expectedAudio, true);
  assert.equal(message.media.expectedDuration, 40.87);
  assert.equal(Object.hasOwn(message.media, 'pageFallback'), false);
});

test('real Instagram adapter can recover a selected single-player post through the page downloader', async () => {
  const fixture = content({ adapterScript: 'social-instagram.js' }); fixture.gesture();
  const message = await settled(fixture);
  assert.equal(message.type, 'shitu:capture');
  assert.equal(message.media.sourceType, 'site-video');
  assert.equal(message.media.url, post.url);
});

test('a verified direct stream stays first and carries its selected-post fallback', async () => {
  const fixture = content({ url: 'https://www.instagram.com/', mediaUrl: 'https://cdninstagram.com/selected.mp4',
    resolve: () => ({ url: 'https://cdninstagram.com/selected.mp4', pageUrl: post.url }) });
  fixture.gesture('contextmenu');
  const message = await settled(fixture);
  assert.equal(message.media.url, 'https://cdninstagram.com/selected.mp4');
  assert.equal(message.media.sourceType, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(message.media.pageFallback)), post);
  assert.equal(message.media.socialPageUrl, post.url);
});

test('ambiguous, protected and changed selections never become page downloads', async () => {
  for (const options of [
    { selected: () => null, resolve: () => ({ error: '请在这条 Instagram 帖子的具体视频画面上采集。' }) },
    { resolve: () => ({ error: '此视频的下载受限。' }) },
    { selected: () => ({ blocked: true }), resolve: () => ({ url: 'https://cdninstagram.com/selected.mp4', pageUrl: post.url }) },
    { resolve: () => ({ error: '页面或视频已切换，请重新采集。' }) },
    { url: 'https://www.instagram.com/', selected: () => null, resolve: () => null }
  ]) {
    const fixture = content(options); fixture.gesture('contextmenu');
    const message = await settled(fixture);
    assert.equal(message.type, 'shitu:capture-failed');
    assert.equal(fixture.messages.some(item => item.type === 'shitu:capture'), false);
  }
});

function worker({ failCode = 'VIDEO_SOURCE_FAILED', capability = true, secondFail = false } = {}) {
  const requests = [], notices = [], storage = { shituConnection: { port: 38475, token: 'a'.repeat(64) } };
  let listener;
  const context = { URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval,
    chrome: { runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`, getPlatformInfo: async () => ({}),
      onMessage: { addListener: fn => { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: storage[key] }), set: async fields => Object.assign(storage, fields) } },
      contextMenus: { removeAll: callback => callback(), create: (_item, callback) => callback(), onClicked: { addListener() {} } },
      tabs: { sendMessage: async (_id, message) => { notices.push(message); return { ok: false }; } } },
    fetch: async (url, options) => {
      const route = new URL(url).pathname;
      if (route !== '/v1/capture') return new Response(JSON.stringify({ ok: true, app: '拾图', version: '0.29.21', ready: true, siteVideoDownload: capability }));
      const body = JSON.parse(options.body); requests.push(body);
      if (requests.length === 1 && !body.sourceType || secondFail) return new Response(JSON.stringify({ ok: false, code: failCode, error: 'fixture failure' }));
      return new Response(JSON.stringify({ ok: true, imported: 1, duplicates: 0, assetIds: ['saved'] }));
    }
  };
  vm.runInNewContext(source('video-page-source.js'), context);
  vm.runInNewContext(source('background.js'), context);
  return { requests, notices, send: (media, senderUrl = 'https://www.instagram.com/') => new Promise(resolve => listener({ type: 'shitu:capture', media },
    { id: extensionId, url: senderUrl, tab: { id: 1, url: senderUrl } }, resolve)) };
}
const direct = extra => ({ kind: 'video', url: 'https://cdninstagram.com/selected.mp4', socialPageUrl: post.url,
  pageFallback: post, expectedAudio: true, expectedDuration: 40.87, ...extra });

test('worker retries source/incomplete failures once through the same selected post and retains expectations', async () => {
  for (const failCode of ['VIDEO_SOURCE_FAILED', 'VIDEO_INCOMPLETE']) {
    const fixture = worker({ failCode });
    assert.equal((await fixture.send(direct())).ok, true);
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[0].sourceType, undefined);
    const retry = fixture.requests[1];
    assert.equal(retry.sourceType, 'site-video'); assert.equal(retry.site, post.site);
    assert.equal(retry.videoId, post.videoId); assert.equal(retry.url, post.url); assert.equal(retry.pageUrl, post.url);
    assert.equal(retry.expectedAudio, true); assert.equal(retry.expectedDuration, 40.87);
    for (const property of ['playback', 'browserRead', 'dataBase64', 'mimeType', 'pageFallback']) assert.equal(Object.hasOwn(retry, property), false);
    assert.equal(retry.requestId, fixture.requests[0].requestId);
  }
});

test('worker never retries library/uncertain failures, missing capabilities, or an already attempted page download', async () => {
  for (const options of [{ failCode: 'CAPTURE_FOLDER_MISSING' }, { failCode: 'CAPTURE_LIBRARY_CHANGED' },
    { failCode: 'CAPTURE_PENDING' }, { failCode: 'SERVER_ERROR' }, { capability: false }]) {
    const fixture = worker(options);
    assert.equal((await fixture.send(direct())).ok, false);
    assert.equal(fixture.requests.length, 1);
  }
  const fixture = worker({ secondFail: true });
  assert.equal((await fixture.send(direct())).ok, false);
  assert.equal(fixture.requests.length, 2, 'The failed page fallback must not loop');
});

test('worker validates canonical fallback identity, sender site and transfer mode before calling desktop', async () => {
  for (const [media, sender] of [
    [direct({ pageFallback: { ...post, videoId: 'Another123' } })],
    [direct({ pageFallback: { ...post, site: 'x' } })],
    [direct({ socialPageUrl: 'https://www.instagram.com/reel/Another123/' })],
    [direct(), 'https://evil.example/'],
    [{ ...post, kind: 'image', sourceType: 'site-video' }],
    [{ ...post, kind: 'video', sourceType: 'site-video', playback: 'file' }],
    [{ ...post, kind: 'video', sourceType: 'site-video', dataBase64: 'AAAA', mimeType: 'video/mp4' }]
  ]) {
    const fixture = worker();
    assert.equal((await fixture.send(media, sender)).ok, false);
    assert.equal(fixture.requests.length, 0);
  }
});
