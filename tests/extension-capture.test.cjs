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
const videoUrl = 'https://frame.example/selected.mp4';
const videoBytes = Buffer.from('fixture bytes supplied by the page');

async function worker({ fetchImpl, initial = {}, port = 38475, storageWriteFailure = false, sendToTab } = {}) {
  const storage = { shituConnection: { port, token: 'a'.repeat(64) }, ...structuredClone(initial) };
  const requests = [];
  const tabMessages = [];
  let listener;
  const chrome = {
    runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`, getManifest: () => ({ version: '0.11.1' }),
      getPlatformInfo: async () => ({}), onMessage: { addListener: fn => { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { setAccessLevel: async () => {}, get: async key => typeof key === 'string' ? { [key]: storage[key] } : storage,
      set: async value => { if (storageWriteFailure) throw new Error('Storage quota unavailable'); Object.assign(storage, structuredClone(value)); } } },
    contextMenus: { removeAll: callback => callback(), create: (_item, callback) => callback(), onClicked: { addListener() {} } },
    tabs: { sendMessage: async (tabId, message, options) => {
      const delivery = { tabId, message, options };
      tabMessages.push(delivery);
      return sendToTab?.(delivery);
    } }
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
  return { storage, requests, tabMessages, send(message, sender = { id: extensionId, url: 'https://frame.example/item', tab: { id: 1, url: 'https://top.example/' } }) {
    return new Promise(resolve => listener(message, sender, resolve));
  } };
}

async function content({ fetchImpl, mediaUrl = sourceUrl, pageUrl = 'https://frame.example/item', kind = 'image',
  posterOverlay = false, pointerlessVideo = false, unrelatedBackground = false, protectedVideo = false, siteResolvers = {},
  reply = { ok: true, imported: 1, duplicates: 0, assetIds: ['new-asset'] } } = {}) {
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
    querySelector() { return null; }
    querySelectorAll(selector) {
      if (selector === ':scope > video, :scope > * > video') {
        return [...this.children, ...this.children.flatMap(child => child.children)].filter(child => child.tagName === 'VIDEO');
      }
      return [];
    }
    getBoundingClientRect() { return { top: 0, right: 180, bottom: 120, left: 0, width: 180, height: 120 }; }
    remove() { this.isConnected = false; }
  }
  const documentElement = new Element('html'); documentElement.isConnected = true;
  const body = new Element('body');
  const wrapper = new Element('div');
  documentElement.append(body);
  body.append(wrapper);
  const media = new Element(kind === 'video' ? 'video' : 'img');
  media.currentSrc = mediaUrl;
  media.setAttribute(kind === 'video' ? 'title' : 'alt', 'Selected fixture');
  if (protectedVideo) media.mediaKeys = {};
  const poster = posterOverlay ? new Element('img') : media;
  if (posterOverlay) {
    poster.currentSrc = sourceUrl;
    media.setAttribute('poster', sourceUrl);
    wrapper.append(poster);
  }
  wrapper.append(media);
  const pointStack = posterOverlay ? pointerlessVideo ? [poster] : [poster, media] : [media];
  if (unrelatedBackground) {
    const backdrop = new Element('video');
    backdrop.currentSrc = videoUrl;
    body.append(backdrop);
    pointStack.push(backdrop);
  }
  const document = { baseURI: pageUrl, title: 'Frame page', documentElement, body,
    createElement: tag => new Element(tag), elementsFromPoint: () => pointStack,
    querySelectorAll: selector => selector === 'video' ? nodes.filter(node => node.tagName === 'VIDEO') : [],
    querySelector: selector => selector === '[data-shitu-toast]' ? nodes.find(node => node.attributes['data-shitu-toast'] !== undefined) : null };
  let listener;
  class FileReader {
    readAsDataURL(blob) { blob.arrayBuffer().then(buffer => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onload?.(); }, error => { this.error = error; this.onerror?.(); }); }
  }
  const context = { Element, document, FileReader, URL, Blob, Uint8Array, ArrayBuffer, AbortController, AbortSignal,
    location: { href: document.baseURI }, performance: { now: () => Date.now() },
    getComputedStyle: () => ({ backgroundImage: 'none' }),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    chrome: { runtime: { id: extensionId, getManifest: () => ({ version: '0.11.1' }),
      sendMessage: async message => { messages.push(message); return typeof reply === 'function' ? reply(message) : reply; },
      onMessage: { addListener: callback => { listener = callback; } } } },
    fetch: async (url, options) => { fetches.push({ url, options }); return fetchImpl ? fetchImpl(url, options) : new Response(bytes, { headers: { 'Content-Type': 'image/png' } }); }
  };
  Object.assign(context, siteResolvers);
  context.window = { addEventListener: (type, listener) => events.set(type, listener) };
  vm.runInNewContext(await fs.readFile(path.join(root, 'extension/content.js'), 'utf8'), context, { filename: 'extension/content.js' });
  function contextMenu(options = {}) {
    events.get('contextmenu')({ isTrusted: true, altKey: true, button: 2, clientX: 20, clientY: 20,
      composedPath: () => [poster, wrapper, body, documentElement], preventDefault() {}, stopImmediatePropagation() {}, ...options });
  }
  return { nodes, messages, fetches, timers, contextMenu,
    resolveVideo(pageUrl) {
      return new Promise(resolve => listener({ type: 'shitu:resolve-media', browserVideo: true, media: { url: mediaUrl, kind: 'video', pageUrl } },
        { id: extensionId }, resolve));
    },
    async capture() {
      contextMenu();
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const toast = document.querySelector('[data-shitu-toast]');
        if (toast && toast.getAttribute('data-status') !== 'working') return { status: toast.getAttribute('data-status'), message: toast.getAttribute('aria-label') };
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      throw new Error('Content capture did not reach a final status');
    }
  };
}

test('capture worker preserves the clicked iframe source page instead of replacing it with the top page', async () => {
  const instance = await worker();
  const result = await instance.send({ type: 'shitu:capture', media: { kind: 'image', url: sourceUrl, pageUrl: 'https://frame.example/item' } });
  assert.equal(result.ok, true);
  assert.equal(instance.requests.find(request => request.route === '/v1/capture').body.pageUrl, 'https://frame.example/item');
});

test('a selected social video keeps its individual post URL without trusting cross-origin provenance', async () => {
  const frame = 'https://www.instagram.com/reels/';
  const post = 'https://www.instagram.com/reel/Selected1/';
  const sender = { id: extensionId, url: frame, tab: { id: 5 } };
  for (const [socialPageUrl, expected] of [[post, post], ['https://unrelated.example/reel/Selected1/', frame]]) {
    const instance = await worker();
    const result = await instance.send({
      type: 'shitu:capture',
      media: { kind: 'video', url: 'https://example.cdninstagram.com/selected.mp4', socialPageUrl }
    }, sender);
    assert.equal(result.ok, true);
    assert.equal(instance.requests.find(request => request.route === '/v1/capture').body.pageUrl, expected);
  }
});

test('a site video file replaces only the selected blob and keeps the existing collector request', async () => {
  const pageUrl = 'https://www.instagram.com/reel/fixture/';
  const url = 'https://example.cdninstagram.com/movie.mp4';
  let resolved = 0;
  const instance = await content({
    kind: 'video', pageUrl, mediaUrl: 'blob:https://www.instagram.com/video-fixture', posterOverlay: true,
    siteResolvers: { MosaicInstagramVideo: ({ page, video, trustedMedia }) => {
      resolved++;
      assert.equal(video.tagName, 'VIDEO');
      assert.equal(page.href, pageUrl);
      return { url: trustedMedia(url), name: 'Selected reel', pageUrl };
    } }
  });
  assert.equal((await instance.capture()).status, 'success');
  assert.equal(resolved, 1);
  assert.equal(instance.fetches.length, 0);
  const [request] = instance.messages;
  assert.equal(request.type, 'shitu:capture');
  assert.equal(request.media.kind, 'video');
  assert.equal(request.media.url, url);
  assert.equal(request.media.pageUrl, pageUrl);
  assert.equal(request.media.socialPageUrl, pageUrl);
  assert.equal(request.media.name, 'Selected reel');
  assert.equal(request.media.social, undefined);
});

test('a protected video never enters a site adapter and a Vimeo embed can surface the original page', async () => {
  const protectedResult = await content({
    kind: 'video', pageUrl: 'https://x.com/user/status/123', protectedVideo: true,
    siteResolvers: { MosaicXVideo: () => { throw Error('Must not resolve protected video'); } }
  });
  assert.match((await protectedResult.capture()).message, /受保护/);
  assert.ok(protectedResult.messages.every(message => message.type !== 'shitu:capture'));

  const vimeo = await content({
    kind: 'video', pageUrl: 'https://player.vimeo.com/video/123',
    siteResolvers: { MosaicVimeoVideo: () => ({ error: '到原页选择下载版本', openUrl: 'https://vimeo.com/123' }) }
  });
  assert.equal((await vimeo.capture()).status, 'error');
  assert.equal(vimeo.nodes.find(node => node.href === 'https://vimeo.com/123')?.style.display, 'block');
  assert.ok(vimeo.messages.every(message => message.type !== 'shitu:capture'));
});

test('capture destinations remember each library and confirmed locations require the originating document', async () => {
  const libraries = ['a'.repeat(64), 'b'.repeat(64)];
  let currentLibrary = libraries[0];
  const folders = [{ id: 'parent', parentId: null, name: '项目' }, { id: 'nested', parentId: 'parent', name: '收集' }];
  const popup = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` };
  const content = { id: extensionId, url: 'https://frame.example/item', frameId: 2, documentId: 'selected-document', tab: { id: 1 } };
  const instance = await worker({ fetchImpl: async request => {
    if (request.route === '/v1/ping') return Response.json({ ok: true, app: '拾图', version: '0.29.5', ready: true, libraryId: currentLibrary });
    if (request.route === '/v1/folders') return Response.json({ ok: true, libraryId: currentLibrary, folders });
    if (request.route === '/v1/locate') return Response.json({ ok: true });
    assert.equal(request.route, '/v1/capture');
    return Response.json({ ok: true, imported: 1, duplicates: 0, assetIds: ['saved-asset'], libraryId: currentLibrary, folderName: '收集' });
  } });
  assert.equal((await instance.send({ type: 'shitu:folders' }, content)).ok, false);
  assert.equal((await instance.send({ type: 'shitu:folders' }, popup)).folderId, null);
  assert.equal((await instance.send({ type: 'shitu:set-folder', libraryId: libraries[0], folderId: 'absent' }, popup)).ok, false);
  assert.equal((await instance.send({ type: 'shitu:set-folder', libraryId: libraries[0], folderId: 'nested' }, popup)).ok, true);
  assert.equal((await instance.send({ type: 'shitu:folders' }, popup)).folderId, 'nested');
  currentLibrary = libraries[1];
  assert.equal((await instance.send({ type: 'shitu:folders' }, popup)).folderId, null);
  assert.equal((await instance.send({ type: 'shitu:set-folder', libraryId: libraries[0], folderId: 'parent' }, popup)).ok, false);
  assert.equal((await instance.send({ type: 'shitu:set-folder', libraryId: libraries[1], folderId: 'parent' }, popup)).ok, true);
  currentLibrary = libraries[0];
  assert.equal((await instance.send({ type: 'shitu:folders' }, popup)).folderId, 'nested');

  const saved = await instance.send({ type: 'shitu:capture', media: { kind: 'image', url: sourceUrl } }, content);
  assert.equal(saved.ok, true);
  assert.match(instance.storage.shituLastCapture.message, /收集/);
  assert.doesNotMatch(saved.message, /收集/);
  assert.equal(saved.libraryId, undefined);
  assert.deepEqual(instance.requests.find(request => request.route === '/v1/capture').body.destination, {
    libraryId: libraries[0], folderId: 'nested'
  });
  const locationRequest = { type: 'shitu:locate', receipt: saved.locateReceipt };
  assert.equal((await instance.send(locationRequest, { ...content, documentId: 'another-document' })).ok, false);
  assert.equal(instance.requests.some(request => request.route === '/v1/locate'), false);
  assert.equal((await instance.send(locationRequest, content)).ok, true);
  assert.deepEqual(instance.requests.find(request => request.route === '/v1/locate').body, { libraryId: libraries[0], assetId: 'saved-asset' });
  const recent = { type: 'shitu:locate-recent', requestId: instance.storage.shituLastCapture.requestId };
  assert.equal((await instance.send(recent, popup)).ok, true);
  currentLibrary = libraries[1];
  assert.equal((await instance.send(recent, popup)).ok, false);
  assert.equal(instance.requests.filter(request => request.route === '/v1/locate').length, 2);
});

test('a user click opens the saved asset and synthetic clicks cannot use the capture receipt', async () => {
  const instance = await content({ reply: message => message.type === 'shitu:capture'
    ? { ok: true, imported: 1, duplicates: 0, locateReceipt: 'confirmed-request' } : { ok: true } });
  await instance.capture();
  const locate = instance.nodes.find(node => node.textContent === '在 Mosaic 中查看');
  assert.equal(locate.style.display, 'block');
  const click = locate.listeners.get('click');
  await click({ isTrusted: false, stopPropagation() {} });
  assert.equal(instance.messages.some(message => message.type === 'shitu:locate'), false);
  await click({ isTrusted: true, stopPropagation() {} });
  assert.equal(instance.messages.find(message => message.type === 'shitu:locate').receipt, 'confirmed-request');
  assert.equal(locate.style.display, 'none');
});

test('a video that needs the browser retries exactly once with bytes from the clicked iframe', async () => {
  const captureRequests = [];
  const instance = await worker({
    fetchImpl: async request => {
      if (request.route !== '/v1/capture') return Response.json({ ok: true, app: '拾图', version: '0.11.1', ready: true });
      captureRequests.push(request.body);
      return captureRequests.length === 1
        ? Response.json({ ok: false, code: 'VIDEO_BROWSER_READ', error: '网站返回 HTTP 403' }, { status: 400 })
        : Response.json({ ok: true, imported: 1, duplicates: 0 });
    },
    sendToTab: async ({ message }) => message.type === 'shitu:resolve-media'
      ? { ok: true, media: { ...message.media, dataBase64: videoBytes.toString('base64'), mimeType: 'video/mp4' } }
      : undefined
  });
  const pageUrl = 'https://frame.example/item';
  const result = await instance.send({ type: 'shitu:capture',
    media: { kind: 'video', url: videoUrl, name: 'Selected clip', pageUrl: 'https://elsewhere.example/page' } },
  { id: extensionId, url: pageUrl, documentId: 'click-document', frameId: 7, tab: { id: 13, url: 'https://top.example/' } });
  assert.equal(result.ok, true);
  const requestsToPage = instance.tabMessages.filter(({ message }) => message.type === 'shitu:resolve-media');
  assert.equal(requestsToPage.length, 1);
  const [browserRead] = requestsToPage;
  assert.equal(browserRead.tabId, 13);
  assert.equal(browserRead.options.frameId, undefined);
  assert.equal(browserRead.options.documentId, 'click-document');
  assert.equal(browserRead.message.browserVideo, true);
  assert.equal(browserRead.message.media.url, videoUrl);
  assert.equal(captureRequests.length, 2);
  assert.equal(captureRequests[0].dataBase64, undefined);
  assert.deepEqual(captureRequests[1], { ...captureRequests[0], dataBase64: videoBytes.toString('base64'), mimeType: 'video/mp4' });
  assert.equal(captureRequests[1].pageUrl, pageUrl);
  assert.equal(instance.storage.shituLastCapture.status, 'saved');
});

test('video retry requires the specific browser-read signal and verified bytes for the same URL', async () => {
  const videoPayload = { type: 'shitu:capture', media: { kind: 'video', url: videoUrl } };
  const cases = [
    { name: 'direct success', response: { ok: true, imported: 1, duplicates: 0 }, browserReads: 0 },
    { name: 'unrelated server error', response: { ok: false, error: '素材库写入失败' }, browserReads: 0 },
    { name: 'missing browser bytes', response: { ok: false, code: 'VIDEO_BROWSER_READ', error: '网站返回 HTTP 403' }, browserReads: 1,
      reply: media => ({ ok: true, media }) },
    { name: 'changed browser URL', response: { ok: false, code: 'VIDEO_BROWSER_READ', error: '网站返回 HTTP 403' }, browserReads: 1,
      reply: media => ({ ok: true, media: { ...media, url: 'https://another.example/replacement.mp4', dataBase64: videoBytes.toString('base64'), mimeType: 'video/mp4' } }) },
    { name: 'invalid browser encoding', response: { ok: false, code: 'VIDEO_BROWSER_READ', error: '网站返回 HTTP 403' }, browserReads: 1,
      reply: media => ({ ok: true, media: { ...media, dataBase64: 'invalid base64', mimeType: 'video/mp4' } }) }
  ];
  for (const scenario of cases) {
    const instance = await worker({
      fetchImpl: async request => request.route === '/v1/capture'
        ? Response.json(scenario.response, { status: scenario.response.ok ? 200 : 400 })
        : Response.json({ ok: true, app: '拾图', version: '0.11.1', ready: true }),
      sendToTab: async ({ message }) => message.type === 'shitu:resolve-media' ? scenario.reply?.(message.media) : undefined
    });
    const result = await instance.send(videoPayload);
    assert.equal(result.ok, scenario.response.ok, scenario.name);
    assert.equal(instance.tabMessages.filter(({ message }) => message.type === 'shitu:resolve-media').length, scenario.browserReads, scenario.name);
    assert.equal(instance.requests.filter(request => request.route === '/v1/capture').length, 1, scenario.name);
  }
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

test('Alt-right-click over a video poster sends the underlying video URL without trying to read the image', async () => {
  for (const pointerlessVideo of [false, true]) {
    const instance = await content({ kind: 'video', mediaUrl: videoUrl, posterOverlay: true, pointerlessVideo });
    instance.contextMenu({ altKey: false });
    instance.contextMenu({ isTrusted: false });
    assert.equal(instance.messages.length, 0);
    assert.equal((await instance.capture()).status, 'success');
    const captures = instance.messages.filter(message => message.type === 'shitu:capture');
    assert.equal(captures.length, 1);
    assert.equal(captures[0].media.kind, 'video');
    assert.equal(captures[0].media.url, videoUrl);
    assert.equal(captures[0].media.dataBase64, undefined);
    assert.equal(instance.fetches.length, 0);
  }
});

test('a background video does not intercept Alt-right-click on an unrelated foreground image', async () => {
  const instance = await content({ unrelatedBackground: true });
  assert.equal((await instance.capture()).status, 'success');
  const capture = instance.messages.find(message => message.type === 'shitu:capture');
  assert.equal(capture.media.kind, 'image');
  assert.equal(capture.media.url, sourceUrl);
});

test('the clicked frame reads complete video responses only and reports protected players without importing a poster', async () => {
  const complete = await content({ kind: 'video', mediaUrl: videoUrl, fetchImpl: async () =>
    new Response(videoBytes, { headers: { 'Content-Type': 'video/mp4' } }) });
  const completeRead = await complete.resolveVideo();
  assert.equal(completeRead.ok, true);
  assert.equal(completeRead.media.dataBase64, videoBytes.toString('base64'));
  assert.equal(completeRead.media.mimeType, 'video/mp4');
  assert.equal(complete.fetches[0].options.credentials, 'same-origin');
  assert.equal((await complete.resolveVideo('https://old.example/page')).media.dataBase64, undefined);
  assert.equal(complete.fetches.length, 1);
  const partial = await content({ kind: 'video', mediaUrl: videoUrl, fetchImpl: async () =>
    new Response(videoBytes, { status: 206, headers: { 'Content-Type': 'video/mp4' } }) });
  assert.equal((await partial.resolveVideo()).media.dataBase64, undefined);
  const protectedPlayer = await content({ kind: 'video', mediaUrl: videoUrl, posterOverlay: true, protectedVideo: true });
  const notice = await protectedPlayer.capture();
  assert.equal(notice.status, 'error');
  assert.match(notice.message, /受保护/);
  assert.equal(protectedPlayer.messages[0].type, 'shitu:capture-failed');
  assert.equal(protectedPlayer.fetches.length, 0);
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

test('popup displays nested destination paths and uses the confirmed receipt to open the asset', async () => {
  const elements = new Map();
  const calls = [];
  const libraryId = 'a'.repeat(64);
  const recent = { ok: true, imported: 1, requestId: 'recent-receipt', location: { libraryId, assetId: 'saved-asset' } };
  const makeElement = () => ({
    value: '', textContent: '', children: [], listeners: new Map(),
    setAttribute() {}, replaceChildren(...children) { this.children = children; },
    addEventListener(type, callback) { this.listeners.set(type, callback); }
  });
  function element(id) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  }
  const replies = {
    'shitu:extension-info': { ok: true, protocol: 1, version: '0.11.4', build: '0.11.4' },
    'shitu:ping': { ok: true, ready: true, version: '0.29.5', libraryId },
    'shitu:folders': { ok: true, supported: true, libraryId, folderId: null,
      folders: [{ id: 'parent', name: '项目', parentId: null }, { id: 'child', name: '收集', parentId: 'parent' }] },
    'shitu:set-folder': { ok: true, libraryId, folderId: 'child' },
    'shitu:locate-recent': { ok: true }
  };
  const context = {
    document: { getElementById: element, createElement: makeElement },
    window: { addEventListener() {} }, fetch: async () => Response.json({ version: '0.11.4' }),
    setInterval: () => 1, clearInterval() {},
    chrome: {
      runtime: { getURL: file => `chrome-extension://${extensionId}/${file}`, async sendMessage(message) { calls.push(message); return replies[message.type]; } },
      storage: { local: { get: async key => key === 'shituLastCapture' ? { [key]: recent } : {} } }
    }
  };
  vm.runInNewContext(await fs.readFile(path.join(root, 'extension/popup.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));

  const select = element('captureFolder');
  assert.equal(select.disabled, false);
  assert.deepEqual(select.children.map(option => option.textContent), ['未分类', '项目', '项目 / 收集']);
  select.value = 'child';
  await select.listeners.get('change')({ isTrusted: true });
  assert.equal(select.value, 'child');
  assert.deepEqual(structuredClone(calls.find(call => call.type === 'shitu:set-folder')), { type: 'shitu:set-folder', libraryId, folderId: 'child' });

  const locate = element('locateRecent');
  assert.equal(locate.hidden, false);
  await locate.listeners.get('click')({ isTrusted: true });
  assert.equal(calls.find(call => call.type === 'shitu:locate-recent').requestId, 'recent-receipt');
  assert.match(element('locateNote').textContent, /已在 Mosaic 中定位/);
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
