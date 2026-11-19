'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, 'extension', file), 'utf8');
const browserPages = require('../extension/video-page-source.js');
const nativePages = require('../src/video-page-source.cjs');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';
const bvid = 'BV1xx411c7mD';
const canonical = `https://www.bilibili.com/video/${bvid}/?p=2`;

test('Bilibili browser and desktop canonicalizers preserve exact BV/av and part identity', () => {
  for (const [url, id, part] of [
    [`https://www.bilibili.com/video/${bvid}/?p=2&spm_id_from=333.1007`, bvid, 2],
    [`https://m.bilibili.com/video/${bvid}`, bvid, 1],
    ['https://bilibili.com/video/av170001/?p=15#reply', 'av170001', 15],
    ['https://www.bilibili.com/video/av1/?p=10000', 'av1', 10000]
  ]) {
    const expected = { site: 'bilibili', videoId: `${id}:p${part}`, url: `https://www.bilibili.com/video/${id}/?p=${part}` };
    assert.deepEqual(browserPages.videoPageSource(url), expected);
    assert.deepEqual(nativePages.videoPageSource(url), expected);
  }
});

test('Bilibili parsers reject unexpanded short links, other media types and ambiguous part identities', () => {
  for (const url of [
    'https://b23.tv/abcd', 'https://live.bilibili.com/123', 'https://www.bilibili.com/bangumi/play/ep123',
    `https://www.bilibili.com/video/${bvid}/?p=1&p=2`, `https://www.bilibili.com/video/${bvid}/?p=`,
    `https://www.bilibili.com/video/${bvid}/?p=0`, `https://www.bilibili.com/video/${bvid}/?p=01`,
    `https://www.bilibili.com/video/${bvid}/?p=10001`, 'https://www.bilibili.com/video/av0/',
    `https://www.bilibili.com.evil.test/video/${bvid}`, `https://user:pass@www.bilibili.com/video/${bvid}`,
    `https://www.bilibili.com:444/video/${bvid}`, `http://www.bilibili.com/video/${bvid}`
  ]) {
    assert.equal(browserPages.videoPageSource(url), null, url);
    assert.throws(() => nativePages.videoPageSource(url), { code: 'INVALID_VIDEO_PAGE' });
  }
});

function adapter() {
  const context = { URL, MosaicVideoPages: browserPages };
  vm.runInNewContext(source('social-bilibili.js'), context);
  return context.MosaicBilibiliVideo;
}
function link(url) { return { tagName: 'A', getAttribute: key => key === 'href' ? url : null, closest: () => null }; }
function input(overrides = {}) {
  return { document: { title: 'Selected Bilibili video', querySelectorAll: () => [] }, page: new URL(canonical),
    video: { isConnected: true, closest: () => null }, path: [], singleVideo: true, ...overrides };
}

test('Bilibili selected main player retains P2 even when a recommendation link covers it', () => {
  const resolve = adapter();
  const result = resolve(input({ path: [link(`https://www.bilibili.com/video/${bvid}/?p=3`)] }));
  assert.equal(result.videoId, `${bvid}:p2`);
  assert.equal(result.url, canonical);
  assert.equal(result.sourceType, 'site-video');
  assert.equal(resolve(input({ video: null })), null, 'blank page cannot infer a selected video');
});

test('Bilibili explicit card and link selection beat an unrelated current video route', () => {
  const resolve = adapter();
  const selected = link('https://www.bilibili.com/video/av170001/?p=3');
  assert.equal(resolve(input({ video: null, path: [selected] })).videoId, 'av170001:p3');
  const card = { getAttribute: () => null, querySelectorAll: () => [selected] };
  const video = { isConnected: true, closest: selector => selector.includes('.bili-video-card') ? card : null };
  assert.equal(resolve(input({ video })).videoId, 'av170001:p3');
  assert.equal(resolve(input({ page: new URL('https://www.bilibili.com/'), video, singleVideo: false })).videoId, 'av170001:p3');
});

test('Bilibili never guesses among different parts or from stale, protected and unbound players', () => {
  const resolve = adapter();
  const card = { getAttribute: () => null, querySelectorAll: () => [link(canonical), link(canonical.replace('p=2', 'p=3'))] };
  const ambiguous = { isConnected: true, closest: selector => selector.includes('.bili-video-card') ? card : null };
  for (const value of [input({ video: ambiguous }), input({ video: { isConnected: false } }),
    input({ page: new URL('https://www.bilibili.com/'), singleVideo: false }),
    input({ document: { title: '', querySelectorAll: () => [link(canonical.replace('p=2', 'p=3'))] } })]) {
    assert.equal(resolve.selectedPage(value), null);
    assert.ok(resolve(value).error);
  }
  assert.equal(resolve.selectedPage(input({ video: { mediaKeys: {}, isConnected: true } })).blocked, true);
  assert.equal(resolve.selectedPage(input({ video: { srcObject: {}, isConnected: true } })).blocked, true);
  assert.equal(resolve(input({ page: new URL('https://b23.tv/abc'), video: null })), null);
});

function content({ card = false } = {}) {
  const events = new Map(), messages = [];
  class Element {
    constructor(tag, attrs = {}) { this.tagName = tag.toUpperCase(); this.attributes = attrs; this.children = []; this.style = {}; this.isConnected = true; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener() {}
    append(...children) { for (const node of children) { node.parentElement = this; this.children.push(node); } }
    attachShadow() { return new Element('shadow'); }
    closest(selector) {
      if (selector.includes('.bpx-player-container')) return card ? null : player;
      return null;
    }
    querySelector() { return null; }
    querySelectorAll(selector) { return selector === ':scope > video, :scope > * > video' ? this.children.filter(child => child.tagName === 'VIDEO') : []; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 }; }
    remove() { this.isConnected = false; }
  }
  const html = new Element('html'), body = new Element('body'), player = new Element('div'), video = new Element('video');
  const anchor = new Element('a', { href: canonical }), image = new Element('img', { src: 'https://i0.hdslb.com/cover.jpg' });
  html.append(body); body.append(player, anchor); player.append(video); anchor.append(image);
  Object.assign(video, { currentSrc: 'blob:https://www.bilibili.com/current', duration: 25, webkitAudioDecodedByteCount: 100 });
  const page = card ? 'https://www.bilibili.com/' : canonical;
  const document = { baseURI: page, title: 'Selected video', body, documentElement: html,
    createElement: tag => new Element(tag), querySelectorAll: selector => selector === 'video' ? [video] : [], elementsFromPoint: () => [] };
  const context = { Element, URL, document, location: { href: page }, performance: { now: () => Date.now() },
    setTimeout: () => 1, clearTimeout() {}, getComputedStyle: () => ({ display: 'block', visibility: 'visible', backgroundImage: 'none' }),
    window: { addEventListener: (name, listener) => events.set(name, [...(events.get(name) || []), listener]) },
    chrome: { runtime: { id: extensionId, onMessage: { addListener() {} }, sendMessage: async message => {
      messages.push(message); return { ok: true, imported: 1, duplicates: 0 };
    } } }
  };
  for (const file of ['video-page-source.js', 'social-bilibili.js', 'content.js']) vm.runInNewContext(source(file), context);
  const event = { isTrusted: true, button: 2, altKey: true, clientX: 20, clientY: 20,
    composedPath: () => card ? [image, anchor, body, html] : [video, player, body, html],
    preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
  for (const listener of events.get('pointerdown') || []) { listener(event); if (event.stopped) break; }
  return { messages };
}
async function submitted(fixture) {
  for (let i = 0; i < 100; i++) {
    const result = fixture.messages.find(message => message.type === 'shitu:capture');
    if (result) return result.media;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(JSON.stringify(fixture.messages));
}

test('Bilibili Alt+right sends selected player and card as exact-part page downloads', async () => {
  for (const card of [false, true]) {
    const media = await submitted(content({ card }));
    assert.equal(media.sourceType, 'site-video');
    assert.equal(media.site, 'bilibili');
    assert.equal(media.videoId, `${bvid}:p2`);
    assert.equal(media.url, canonical);
    if (!card) { assert.equal(media.expectedDuration, 25); assert.equal(media.expectedAudio, true); }
    assert.equal(Object.hasOwn(media, 'dataBase64'), false);
  }
});

function worker() {
  let listener;
  const requests = [], delays = [];
  const config = { port: 38475, token: 'a'.repeat(64) };
  const context = { URL, AbortController, setTimeout: (_fn, delay) => { delays.push(delay); return 1; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, chrome: {
      runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`,
        getManifest: () => ({ version: '0.11.25' }), getPlatformInfo: async () => ({}),
        onMessage: { addListener: fn => { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: key === 'shituConnection' ? config : undefined }), set: async () => {} } },
      contextMenus: { removeAll: callback => callback(), create: (_item, callback) => callback(), onClicked: { addListener() {} } },
      tabs: { sendMessage: async () => ({ ok: true }) }
    }, fetch: async (url, options) => {
      if (String(url).endsWith('/v1/ping')) return new Response(JSON.stringify({ ok: true, app: '拾图', version: '0.29.24', ready: true, siteVideoDownload: true, bilibiliBrowserSession: true }));
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, imported: 1, duplicates: 0, assetIds: ['saved'] }));
    }
  };
  vm.runInNewContext(source('video-page-source.js'), context);
  vm.runInNewContext(source('background.js') + '\nglobalThis.progressProbe = { captureProgress, progressMessage };', context);
  return { requests, delays, progress: context.progressProbe,
    send: (media, page = canonical) => new Promise(resolve => listener({ type: 'shitu:capture', media }, { id: extensionId, url: page, tab: { id: 1 } }, resolve)) };
}

test('Bilibili worker verifies part provenance and leaves time for authorized login plus download', async () => {
  const fixture = worker(), media = { kind: 'video', sourceType: 'site-video', site: 'bilibili', videoId: `${bvid}:p2`, url: canonical };
  assert.equal((await fixture.send(media)).ok, true);
  assert.equal(fixture.requests[0].pageUrl, canonical);
  assert.ok(fixture.delays.includes(31 * 60000));
  for (const change of [{ videoId: `${bvid}:p1` }, { url: canonical.replace('p=2', 'p=1') }, { site: 'youtube' }]) {
    assert.equal((await worker().send({ ...media, ...change })).ok, false);
  }
  assert.equal((await worker().send(media, 'https://b23.tv/abcd')).ok, false);
  const progress = fixture.progress.captureProgress({ phase: 'connecting', receivedBytes: 0 });
  assert.equal(progress.phase, 'connecting');
  assert.match(fixture.progress.progressMessage(progress), /登录|验证/);
});
