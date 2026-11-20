'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODEL = '0123456789abcdef0123456789abcdef';
function setup(onRequest, timers = {}) {
  const listeners = new Set();
  const target = { postMessage(message, origin) { onRequest(message, origin, data => {
    for (const listener of listeners) listener({ source: target, origin, data });
  }, event => { for (const listener of listeners) listener(event); }); } };
  const scope = { TextEncoder, Uint8Array, setTimeout, clearTimeout, setInterval, clearInterval,
    ...timers,
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
test('viewer bridge reports a distinct export timeout and removes its listener', async () => {
  const harness = setup(() => {});
  await assert.rejects(harness.bridge.capture({ modelId: MODEL, target: harness.target, timeout: 5 }), { code: 'SKETCHFAB_VIEWER_TIMEOUT' });
  assert.equal(harness.listeners.size, 0);
});

function clock() {
  let time = 0, nextId = 0;
  const jobs = new Map();
  const schedule = (fn, delay, repeat) => { const id = ++nextId; jobs.set(id, { fn, delay, at: time + delay, repeat }); return id; };
  return {
    timers: { setTimeout: (fn, delay) => schedule(fn, delay, false), clearTimeout: id => jobs.delete(id),
      setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => jobs.delete(id) },
    get pending() { return jobs.size; },
    advance(duration) {
      const end = time + duration;
      while (true) {
        const entry = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, job] = entry; time = job.at;
        if (job.repeat) job.at += job.delay; else jobs.delete(id);
        job.fn();
      }
      time = end;
    }
  };
}

test('a large viewer export may finish after the former 12-second deadline', async () => {
  const time = clock(); let request, reply;
  const harness = setup((value, _origin, respond) => { request = value; reply = respond; }, time.timers);
  const capture = harness.bridge.capture({ modelId: MODEL, target: harness.target });
  assert.equal(harness.bridge.CAPTURE_TIMEOUT_MS, 60000);
  time.advance(59000);
  assert.equal(harness.listeners.size, 1);
  reply(answer(request));
  const value = await capture;
  assert.equal(value.modelId, MODEL);
  assert.equal(harness.listeners.size, 0);
  assert.equal(time.pending, 0);
});

test('the bounded deadline ignores late messages without reading their payload or settling twice', async () => {
  const time = clock(); let request;
  const harness = setup(value => { request = value; }, time.timers);
  let resolved = 0, rejected = 0;
  const capture = harness.bridge.capture({ modelId: MODEL, target: harness.target, timeout: 120000 });
  const observed = capture.then(() => { resolved++; }, error => { rejected++; assert.equal(error.code, 'SKETCHFAB_VIEWER_TIMEOUT'); });
  const staleListener = [...harness.listeners][0];
  time.advance(60000);
  await observed;
  assert.equal(harness.listeners.size, 0); assert.equal(time.pending, 0);
  let read = false;
  const late = answer(request); Object.defineProperty(late, 'snapshot', { get() { read = true; throw new Error('Late payload must not be consumed'); } });
  staleListener({ source: harness.target, origin: 'https://sketchfab.com', data: late });
  assert.equal(read, false); assert.equal(resolved, 0); assert.equal(rejected, 1);
});

test('navigation still cancels a slow export immediately and clears its longer deadline', async () => {
  const time = clock(); let current = true;
  const harness = setup(() => {}, time.timers);
  const capture = harness.bridge.capture({ modelId: MODEL, target: harness.target, isCurrent: () => current });
  const rejection = assert.rejects(capture, { code: 'SKETCHFAB_SOURCE_CHANGED' });
  time.advance(30000); current = false; time.advance(100);
  await rejection;
  assert.equal(harness.listeners.size, 0); assert.equal(time.pending, 0);
});
