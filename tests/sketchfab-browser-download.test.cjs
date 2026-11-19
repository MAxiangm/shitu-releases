'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helper = require('../extension/sketchfab-source.js');
const id = '0123456789abcdef0123456789abcdef', other = 'abcdef0123456789abcdef0123456789';
const page = `https://sketchfab.com/3d-models/${id}`;
const archive = `https://sketchfab-prod-media.s3.amazonaws.com/archives/${id}/gltf/model.zip?Signature=fixture-only`;
const poll = `https://sketchfab.com/i/archives/latest?archive_type=gltf&model=${id}`;
const metadata = () => ({ uid: id, downloadType: 'free', isPublished: true, isDeleted: false, isDisabled: false });
const authorized = () => ({ status: 'Authorized', latest: { gltf: [{ url: poll, size: 2048 }] } });
function route(options = {}) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith(`/models/${id}`)) return Response.json({ ...metadata(), ...options.metadata });
    if (url.endsWith('/download')) return options.downloadResponse?.() || Response.json(options.download || authorized());
    return options.pollResponse?.() || Response.json({ url: options.archive || archive });
  };
  return { request, calls };
}

test('website resolver follows Authorized glTF downloads with same-origin session and no credential extraction', async () => {
  const { request, calls } = route();
  assert.equal(await helper.resolveDownload({ modelId: id, pageUrl: page, fetch: request }), archive);
  assert.deepEqual(calls.map(call => call.url), [`https://sketchfab.com/i/models/${id}`, `https://sketchfab.com/i/models/${id}/download`, poll]);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { 'X-Requested-With': 'XMLHttpRequest', 'X-CsrfToken': 'skfb-no-token' });
    assert.equal(init.body, undefined);
  }
});

test('resolver falls back to original glTF and only polls bound same-origin archive entries', async () => {
  const cases = [
    { latest: { gltf: [{ url: 'https://evil.example/private' }] }, original: { gltf: [{ url: poll }] } },
    { latest: { gltf: [{ url: `/i/archives/latest?archive_type=gltf&model=${id}` }] } }
  ];
  for (const versions of cases) {
    const fixture = route({ download: { status: 'Authorized', ...versions } });
    assert.equal(await helper.resolveDownload({ modelId: id, pageUrl: page, fetch: fixture.request }), archive);
  }
  for (const unsafe of [`/i/archives/latest?model=${other}`, `/i/archives/latest?model=${id}&model=${id}`,
    '/i/users/me', '/i/archives/%2e%2e/private', `https://sketchfab.com.evil.example/i/archives/${id}`, '/i/archives/../private']) {
    const fixture = route({ download: { status: 'Authorized', latest: { gltf: [{ url: unsafe }] } } });
    await assert.rejects(helper.resolveDownload({ modelId: id, pageUrl: page, fetch: fixture.request }), { code: 'SKETCHFAB_DOWNLOAD_UNAVAILABLE' });
    assert.equal(fixture.calls.length, 2);
  }
});

test('resolver never follows unavailable, private, paid or unauthorized model downloads', async () => {
  for (const changed of [{ uid: other }, { downloadType: 'no' }, { downloadType: 'store' }, { isDeleted: true }, { isDisabled: true }, { isPublished: false }]) {
    const fixture = route({ metadata: changed });
    await assert.rejects(helper.resolveDownload({ modelId: id, pageUrl: page, fetch: fixture.request }));
    assert.equal(fixture.calls.length, 1);
  }
  for (const status of ['Pending', 'Created', 'Denied', undefined]) {
    const fixture = route({ download: { ...authorized(), status } });
    await assert.rejects(helper.resolveDownload({ modelId: id, pageUrl: page, fetch: fixture.request }), { code: 'SKETCHFAB_NOT_DOWNLOADABLE' });
    assert.equal(fixture.calls.length, 2);
  }
  for (const status of [401, 403, 429, 302]) {
    const fixture = route({ downloadResponse: () => Response.json({ detail: 'secret-response-body' }, { status }) });
    await assert.rejects(helper.resolveDownload({ modelId: id, pageUrl: page, fetch: fixture.request }), error => {
      assert.equal(error.code, status === 401 ? 'SKETCHFAB_LOGIN_REQUIRED' : status === 403 ? 'SKETCHFAB_NOT_DOWNLOADABLE' : 'SKETCHFAB_DOWNLOAD_FAILED');
      assert.doesNotMatch(error.message, /secret/); return true;
    });
  }
});

test('archive response must match the selected model and never exposes signed response errors', async () => {
  for (const value of [archive.replace(id, other), archive.replace('https:', 'http:'), archive.replace('/gltf/', '/source/'),
    archive.replace('model.zip', '%2fmodel.zip'), archive.replace('model.zip', '../model.zip'), archive + '#fragment',
    archive.replace('https://', 'https://user:pass@'), 'https://127.0.0.1/private.zip']) {
    const fixture = route({ archive: value });
    await assert.rejects(helper.resolveDownload({ modelId: id, pageUrl: page, fetch: fixture.request }), error => {
      assert.equal(error.code, 'SKETCHFAB_DOWNLOAD_FAILED'); assert.doesNotMatch(error.message, /Signature|fixture-only|127\.0/); return true;
    });
  }
  const malformed = route({ pollResponse: () => new Response('secret-invalid-json') });
  await assert.rejects(helper.resolveDownload({ modelId: id, pageUrl: page, fetch: malformed.request }), { code: 'SKETCHFAB_DOWNLOAD_FAILED' });
  const oversized = route({ pollResponse: () => new Response('{}', { headers: { 'content-length': 3 * 1024 * 1024 } }) });
  await assert.rejects(helper.resolveDownload({ modelId: id, pageUrl: page, fetch: oversized.request }), { code: 'SKETCHFAB_DOWNLOAD_FAILED' });
});

test('202 preparation is bounded and a changed selection stops before the next request', async () => {
  const fixture = route({ pollResponse: () => new Response(null, { status: 202 }) });
  await assert.rejects(helper.resolveDownload({ modelId: id, pageUrl: page, fetch: fixture.request, timeout: 10 }), { code: 'SKETCHFAB_DOWNLOAD_TIMEOUT' });
  let current = true;
  const changed = route();
  await assert.rejects(helper.resolveDownload({ modelId: id, pageUrl: page, isCurrent: () => current,
    fetch: async (...args) => { const response = await changed.request(...args); current = false; return response; } }), { code: 'SKETCHFAB_SOURCE_CHANGED' });
  assert.equal(changed.calls.length, 1);
});

function contentHarness({ beforeResolve, beforeFetch, synthetic = false, viewerReply, viewerCapable = false, officialDenied = false } = {}) {
  const events = new Map(), calls = [], notices = [], timers = new Set();
  let listener, finished;
  const completion = new Promise(resolve => { finished = resolve; });
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.style = {}; this.children = []; this.isConnected = true; this.attributes = {}; }
    getAttribute(key) { return this.attributes[key] ?? null; } setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    append(...items) { this.children.push(...items); } attachShadow() { return new Element('shadow'); }
    addEventListener() {} closest() { return null; } querySelector() { return null; } querySelectorAll() { return []; }
    remove() { this.isConnected = false; } getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100 }; }
  }
  const html = new Element('html'), canvas = new Element('canvas'), location = new URL(page);
  const timer = (fn, ms) => { const result = setTimeout(fn, ms); result.unref(); timers.add(result); return result; };
  const document = { documentElement: html, body: html, title: 'Selected model', baseURI: page, createElement: tag => new Element(tag),
    elementsFromPoint: () => [canvas], querySelectorAll: () => [] };
  Object.defineProperty(document, 'cookie', { get() { assert.fail('must not read a cookie'); } });
  const dispatch = message => new Promise(resolve => {
    const pending = listener(message, { id: 'fixture-extension' }, resolve); if (pending !== true) resolve(undefined);
  });
  const context = vm.createContext({ URL, Element, AbortController, TextDecoder, document, location, setTimeout: timer, clearTimeout,
    ...(viewerReply ? { MosaicSketchfabViewerBridge: { capture: async options => {
      assert.equal(options.modelId, id); assert.equal(options.isCurrent(), true); return structuredClone(viewerReply);
    } } } : {}),
    performance: { now: () => Date.now() }, window: { addEventListener: (type, fn) => events.set(type, [...(events.get(type) || []), fn]) },
    chrome: { runtime: { id: 'fixture-extension', onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async message => {
      if (message.type !== 'shitu:capture') return { ok: true };
      notices.push(structuredClone(message));
      const resolveMessage = { type: 'shitu:resolve-sketchfab', modelId: id, clientCaptureId: message.clientCaptureId, requestId: '1795100000000-1', ...(viewerCapable ? { allowViewer: true } : {}) };
      beforeResolve?.({ location, canvas, resolveMessage, dispatch });
      const result = await dispatch(resolveMessage); finished(result);
      return result?.ok ? { ok: true, imported: 1, duplicates: 0 } : { ok: false, error: 'fixture failure' };
    } } },
    fetch: async (url, options) => {
      calls.push({ url, options }); beforeFetch?.({ location, canvas, calls });
      if (officialDenied) return new Response('{}', { status: 403 });
      return url.endsWith(`/models/${id}`) ? Response.json(metadata()) : url.endsWith('/download') ? Response.json(authorized()) : Response.json({ url: archive });
    }
  });
  for (const file of ['sketchfab-source.js', 'content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context);
  return { calls, notices, completion, dispatch, stop() { for (const value of timers) clearTimeout(value); },
    gesture() { for (const fn of events.get('pointerdown') || []) fn({ isTrusted: !synthetic, button: 2, altKey: true,
      clientX: 10, clientY: 10, composedPath: () => [canvas, html], preventDefault() {}, stopImmediatePropagation() {} }); } };
}

test('real content gesture binds resolution to its temporary selection without credential or page messages', async () => {
  const fixture = contentHarness();
  try {
    assert.equal((await fixture.dispatch({ type: 'shitu:resolve-sketchfab', modelId: id, clientCaptureId: 'unknown', requestId: '1795100000000-1' })).code, 'SKETCHFAB_SOURCE_CHANGED');
    fixture.gesture(); const result = await fixture.completion;
    assert.equal(result.ok, true); assert.equal(result.archiveUrl, archive); assert.equal(fixture.calls.length, 3);
    assert.deepEqual(Object.keys(fixture.notices[0].media).sort(), ['kind', 'modelId', 'name', 'pageUrl', 'sourceType', 'title', 'url']);
    assert.equal(JSON.stringify(fixture.notices).includes('Signature'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fixture.dispatch({ type: 'shitu:resolve-sketchfab', modelId: id,
      clientCaptureId: fixture.notices[0].clientCaptureId, requestId: '1795100000000-1' })).code, 'SKETCHFAB_SOURCE_CHANGED');
  } finally { fixture.stop(); }
});

test('selected content can export the current viewer after archive resolution fails, only when enabled', async () => {
  const viewerReply = { version: 1, modelId: id, meshes: [{ positions: [0,0,0,1,0,0,0,1,0] }], images: [] };
  const enabled = contentHarness({ viewerCapable: true, viewerReply, officialDenied: true });
  try {
    enabled.gesture(); const result = await enabled.completion;
    assert.equal(result.ok, true); assert.deepEqual(result.viewerSnapshot, viewerReply);
    assert.equal(Object.hasOwn(result, 'archiveUrl'), false);
  } finally { enabled.stop(); }
  const disabled = contentHarness({ viewerReply, officialDenied: true });
  try { disabled.gesture(); assert.equal((await disabled.completion).code, 'SKETCHFAB_NOT_DOWNLOADABLE'); }
  finally { disabled.stop(); }
});

test('real content rejects navigation, detached selection, altered request identity and concurrent resolver replay', async () => {
  for (const beforeResolve of [({ location }) => { location.href = `https://sketchfab.com/3d-models/${other}`; },
    ({ canvas }) => { canvas.isConnected = false; }, ({ resolveMessage }) => { resolveMessage.modelId = other; },
    ({ resolveMessage }) => { resolveMessage.clientCaptureId = '1795100000000-999'; }]) {
    const fixture = contentHarness({ beforeResolve });
    try { fixture.gesture(); assert.equal((await fixture.completion).code, 'SKETCHFAB_SOURCE_CHANGED'); assert.equal(fixture.calls.length, 0); }
    finally { fixture.stop(); }
  }
  let replay;
  const concurrent = contentHarness({ beforeResolve: ({ dispatch, resolveMessage }) => { replay = Promise.resolve().then(() => dispatch(resolveMessage)); } });
  try { concurrent.gesture(); assert.equal((await concurrent.completion).ok, true); assert.equal((await replay).code, 'SKETCHFAB_SOURCE_CHANGED'); }
  finally { concurrent.stop(); }
  const changed = contentHarness({ beforeFetch: ({ location }) => { location.href = 'https://sketchfab.com/search'; } });
  try { changed.gesture(); assert.equal((await changed.completion).code, 'SKETCHFAB_SOURCE_CHANGED'); assert.equal(changed.calls.length, 1); }
  finally { changed.stop(); }
});

test('synthetic model gestures cannot establish a browser download selection', async () => {
  const fixture = contentHarness({ synthetic: true });
  try { fixture.gesture(); assert.equal(fixture.notices.length, 0); assert.equal(fixture.calls.length, 0); }
  finally { fixture.stop(); }
});
