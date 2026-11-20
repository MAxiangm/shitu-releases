'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_BYTES, CHUNK_SIZE, INLINE_BYTES, utf8Length, createStore, receive } = require('../extension/sketchfab-viewer-transfer.js');

const identity = { modelId: '0123456789abcdef0123456789abcdef', requestId: '1795100000000-1', clientCaptureId: '1795100000000-2' };
const transferId = 'fedcba9876543210fedcba9876543210';
const snapshot = (text = '') => ({ version: 1, modelId: identity.modelId, meshes: [{ positions: [0, 0, 0] }], images: [], text });
function clock() {
  let time = 0, next = 0;
  const timers = new Map();
  return { now: () => time, get pending() { return timers.size; },
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = time + ms;
      while (true) {
        const item = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!item) break;
        const [id, timer] = item; timers.delete(id); time = timer.at; timer.fn();
      }
      time = end;
    }
  };
}
function harness({ current = () => true, ...options } = {}) {
  const time = clock(), config = { maxBytes: 4096, chunkSize: 64, inlineBytes: 128, ttlMs: 1000, ...options };
  const store = createStore({ ...config, ...time, randomId: () => transferId });
  const releases = [];
  return { store, time, config, releases,
    prepare: value => store.prepare(value, identity, current),
    receive: (descriptor, overrides = {}) => receive(descriptor, identity, { ...config, now: time.now,
      read: message => store.read(message), release: message => { releases.push(message); return store.release(message); }, ...overrides }) };
}

test('UTF-8 budget counts Unicode and surrogate boundaries as the actual wire encoding', () => {
  for (const text of ['', 'plain', '佛像', '😀', 'a\ud800b', '\udc00', '中😀\u0000']) assert.equal(utf8Length(text), Buffer.byteLength(text));
});

test('small snapshots remain direct responses and replace any outstanding transfer', () => {
  const h = harness({ inlineBytes: 160 });
  const old = h.prepare(snapshot('x'.repeat(300))).viewerTransfer;
  assert.ok(old); assert.equal(h.time.pending, 1);
  const small = snapshot(); assert.equal(h.prepare(small).viewerSnapshot, small);
  assert.equal(h.time.pending, 0);
  assert.throws(() => h.store.read({ ...identity, transferId: old.id, sequence: 0 }), { code: 'SKETCHFAB_SOURCE_CHANGED' });
});

test('ordered chunks restore a Unicode snapshot and release sender storage on completion', async () => {
  const h = harness({ chunkSize: 17 });
  const value = snapshot('佛像😀'.repeat(40)), descriptor = h.prepare(value).viewerTransfer;
  assert.ok(descriptor.chunks > 1);
  assert.deepEqual(await h.receive(descriptor), value);
  assert.equal(h.releases.length, 1); assert.equal(h.time.pending, 0);
  assert.throws(() => h.store.read({ ...identity, transferId, sequence: descriptor.chunks }), { code: 'SKETCHFAB_SOURCE_CHANGED' });
});

test('wrong request, model, capture or transfer identity cannot read or release another transfer', async () => {
  const h = harness(), value = snapshot('x'.repeat(300)), descriptor = h.prepare(value).viewerTransfer;
  for (const mismatch of [{ modelId: 'a'.repeat(32) }, { requestId: '1795100000000-3' }, { clientCaptureId: '1795100000000-4' }, { transferId: 'b'.repeat(32) }]) {
    const message = { ...identity, transferId, sequence: 0, ...mismatch };
    assert.throws(() => h.store.read(message), { code: 'SKETCHFAB_SOURCE_CHANGED' });
    assert.equal(h.store.release(message), false);
  }
  assert.deepEqual(await h.receive(descriptor), value);
});

test('out-of-order and repeated chunks fail closed and discard the active sender record', () => {
  for (const sequence of [1, -1, 0.5]) {
    const h = harness(); h.prepare(snapshot('x'.repeat(300)));
    assert.throws(() => h.store.read({ ...identity, transferId, sequence }), { code: 'SKETCHFAB_VIEWER_INVALID' });
    assert.equal(h.time.pending, 0);
    assert.throws(() => h.store.read({ ...identity, transferId, sequence: 0 }), { code: 'SKETCHFAB_SOURCE_CHANGED' });
  }
  const h = harness(); h.prepare(snapshot('x'.repeat(300)));
  h.store.read({ ...identity, transferId, sequence: 0 });
  assert.throws(() => h.store.read({ ...identity, transferId, sequence: 0 }), { code: 'SKETCHFAB_VIEWER_INVALID' });
  assert.equal(h.time.pending, 0);
});

test('expiry, navigation, a new capture and explicit cleanup release retained strings', () => {
  let current = true;
  for (const action of [h => h.time.advance(1000), h => { current = false; h.time.advance(1000); }, h => h.store.clearCapture(identity.clientCaptureId), h => h.store.clear()]) {
    current = true;
    const h = harness({ current: () => current }); h.prepare(snapshot('x'.repeat(300))); action(h);
    assert.equal(h.time.pending, 0);
    assert.throws(() => h.store.read({ ...identity, transferId, sequence: 0 }), { code: 'SKETCHFAB_SOURCE_CHANGED' });
  }
  const h = harness(); h.prepare(snapshot('x'.repeat(300)));
  const changed = { ...identity, clientCaptureId: '1795100000000-3' };
  h.store.prepare(snapshot('y'.repeat(300)), changed);
  assert.throws(() => h.store.read({ ...identity, transferId, sequence: 0 }), { code: 'SKETCHFAB_SOURCE_CHANGED' });
  assert.equal(h.store.release({ ...changed, transferId }), true);
  assert.equal(h.time.pending, 0);
});

test('sender checks actual UTF-8 size and refuses policies above production ceilings', () => {
  const value = snapshot('佛'.repeat(100)), bytes = Buffer.byteLength(JSON.stringify(value));
  const pass = harness({ maxBytes: bytes }); assert.ok(pass.prepare(value).viewerTransfer); pass.store.clear();
  const fail = harness({ maxBytes: bytes - 1 }); assert.throws(() => fail.prepare(value), { code: 'SKETCHFAB_VIEWER_TOO_LARGE' });
  assert.equal(fail.time.pending, 0);
  for (const options of [{ maxBytes: MAX_BYTES + 1 }, { chunkSize: CHUNK_SIZE + 1 }, { inlineBytes: INLINE_BYTES + 1 }, { ttlMs: 120001 }]) {
    assert.throws(() => createStore(options), { code: 'SKETCHFAB_VIEWER_INVALID' });
  }
});

test('receiver validates the descriptor before requesting data and always attempts release', async () => {
  const h = harness(), descriptor = h.prepare(snapshot('x'.repeat(300))).viewerTransfer;
  for (const change of [{ bytes: MAX_BYTES + 1 }, { length: MAX_BYTES + 1 }, { chunks: 0 }, { chunkSize: 63 }, { unknown: true }, { bytes: descriptor.length - 1 }]) {
    let reads = 0;
    await assert.rejects(h.receive({ ...descriptor, ...change }, { read() { reads++; } }), { code: 'SKETCHFAB_VIEWER_INVALID' });
    assert.equal(reads, 0);
  }
  assert.equal(h.time.pending, 0);
});

test('receiver rejects altered identities, ordering, lengths, completion and UTF-8 totals', async () => {
  for (const mutate of [r => ({ ...r, modelId: 'a'.repeat(32) }), r => ({ ...r, transferId: 'b'.repeat(32) }),
    r => ({ ...r, sequence: r.sequence + 1 }), r => ({ ...r, data: r.data + 'x' }), r => ({ ...r, done: !r.done })]) {
    const h = harness(), descriptor = h.prepare(snapshot('x'.repeat(300))).viewerTransfer;
    await assert.rejects(h.receive(descriptor, { read: message => mutate(h.store.read(message)) }), { code: 'SKETCHFAB_VIEWER_INVALID' });
    assert.equal(h.time.pending, 0); assert.equal(h.releases.length, 1);
  }
  const h = harness(), descriptor = h.prepare(snapshot('x'.repeat(300))).viewerTransfer;
  await assert.rejects(h.receive({ ...descriptor, bytes: descriptor.bytes + 1 }), { code: 'SKETCHFAB_VIEWER_INVALID' });
  assert.equal(h.releases.length, 1);
});

test('receiver navigation and bounded read timeout release the sender without accepting late data', async () => {
  const h = harness(), descriptor = h.prepare(snapshot('x'.repeat(300))).viewerTransfer;
  let current = true, resolveRead;
  const pending = h.receive(descriptor, { readTimeoutMs: 5, isCurrent: () => current, read: () => new Promise(resolve => { resolveRead = resolve; }) });
  await assert.rejects(pending, { code: 'SKETCHFAB_VIEWER_TIMEOUT' });
  assert.equal(h.releases.length, 1); assert.equal(h.time.pending, 0);
  resolveRead({ ok: true, data: 'late' });
  const moved = harness(), next = moved.prepare(snapshot('x'.repeat(300))).viewerTransfer;
  await assert.rejects(moved.receive(next, { isCurrent: () => current, read: message => { current = false; return moved.store.read(message); } }), { code: 'SKETCHFAB_SOURCE_CHANGED' });
  assert.equal(moved.time.pending, 0);
});

test('a response larger than Chrome 64 MiB crosses only bounded serialized messages', async () => {
  const chromeLimit = 64 * 1024 * 1024;
  const value = snapshot('x'.repeat(65 * 1024 * 1024));
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, viewerSnapshot: value })) > chromeLimit);
  const store = createStore(), response = store.prepare(value, identity);
  assert.ok(response.viewerTransfer); assert.equal(response.viewerSnapshot, undefined);
  let messages = 0, largest = 0;
  const result = await receive(response.viewerTransfer, identity, {
    read(message) {
      const serialized = JSON.stringify(store.read(JSON.parse(JSON.stringify(message))));
      const bytes = Buffer.byteLength(serialized); largest = Math.max(largest, bytes); messages++;
      assert.ok(bytes < chromeLimit, 'a real serialized extension message exceeded Chrome limit');
      return JSON.parse(serialized);
    }, release: message => store.release(message)
  });
  assert.ok(messages > 16); assert.ok(largest < 5 * 1024 * 1024);
  assert.equal(result.text, value.text); assert.equal(result.modelId, identity.modelId);
  // Even every source character requiring a six-character JSON escape fits.
  assert.ok(Buffer.byteLength(JSON.stringify({ data: '\u0000'.repeat(CHUNK_SIZE) })) < chromeLimit);
});
