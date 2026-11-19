'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODEL = '0123456789abcdef0123456789abcdef';
function setup(onRequest) {
  const listeners = new Set();
  const target = { postMessage(message, origin) { onRequest(message, origin, data => {
    for (const listener of listeners) listener({ source: target, origin, data });
  }, event => { for (const listener of listeners) listener(event); }); } };
  const scope = { TextEncoder, Uint8Array, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: require('node:crypto').webcrypto, location: { origin: 'https://sketchfab.com' },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/sketchfab-viewer-bridge.js'), 'utf8'), scope);
  return { bridge: scope.MosaicSketchfabViewerBridge, target, listeners };
}
function answer(request, extra = {}) {
  return { type: 'mosaic:sketchfab-viewer-response', requestId: request.requestId, modelId: MODEL, ok: true,
    snapshot: { version: 1, modelId: MODEL, meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }], images: [] }, ...extra };
}
test('viewer bridge accepts only the selected window, origin and one-use request', async () => {
  const harness = setup((request, origin, respond, dispatch) => {
    assert.match(request.requestId, /^[a-f0-9]{32}$/);
    dispatch({ source: {}, origin, data: answer(request) });
    dispatch({ source: harness.target, origin: 'https://example.com', data: answer(request) });
    respond(answer({ ...request, requestId: '0'.repeat(32) }));
    queueMicrotask(() => respond(answer(request)));
  });
  const result = await harness.bridge.capture({ modelId: MODEL, target: harness.target, timeout: 100 });
  assert.equal(result.modelId, MODEL);
  assert.equal(harness.listeners.size, 0);
});
test('viewer bridge cancels when the selected model changes', async () => {
  let current = true;
  const harness = setup((request, origin, respond) => { current = false; respond(answer(request)); });
  await assert.rejects(harness.bridge.capture({ modelId: MODEL, target: harness.target, isCurrent: () => current }), { code: 'SKETCHFAB_SOURCE_CHANGED' });
  assert.equal(harness.listeners.size, 0);
});
test('viewer bridge rejects a different model in the returned snapshot', async () => {
  const harness = setup((request, origin, respond) => respond(answer(request, { snapshot: { version: 1,
    modelId: 'f'.repeat(32), meshes: [{ positions: [] }], images: [] } })));
  await assert.rejects(harness.bridge.capture({ modelId: MODEL, target: harness.target }), { code: 'SKETCHFAB_VIEWER_INVALID' });
});
test('viewer bridge reports an unavailable recorder and removes its listener', async () => {
  const harness = setup(() => {});
  await assert.rejects(harness.bridge.capture({ modelId: MODEL, target: harness.target, timeout: 5 }), { code: 'SKETCHFAB_VIEWER_UNAVAILABLE' });
  assert.equal(harness.listeners.size, 0);
});
