'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVideoPreviewRequests } = require('../src/video-preview-requests.cjs');

const library = { root: 'D:\\isolated-video-library' };
function identity(id = 'clip', changes = {}) {
  return { library, id, source: `${id}.mov`, hash: `${id}-hash`, ...changes };
}
function controlled() {
  const state = { calls: 0, signal: null, resolve: null };
  state.run = signal => {
    state.calls++;
    state.signal = signal;
    return new Promise((resolve, reject) => {
      state.resolve = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  return state;
}
const tick = () => Promise.resolve();
const aborted = promise => assert.rejects(promise, { name: 'AbortError' });

test('reopening the same source shares preparation instead of cancelling it', async () => {
  const requests = createVideoPreviewRequests(), work = controlled();
  const first = requests.prepare(identity(), undefined, work.run);
  const again = requests.prepare(identity(), undefined, () => assert.fail('duplicate operation'));
  assert.equal(first, again);
  await tick();
  assert.equal(work.calls, 1);
  assert.equal(work.signal.aborted, false);
  work.resolve('prepared');
  assert.equal(await first, 'prepared');
});

test('full viewer adoption survives a delayed hover cancellation', async () => {
  const requests = createVideoPreviewRequests(), work = controlled();
  const hover = requests.prepare(identity(), 'hover-a', work.run);
  await tick();
  const viewer = requests.prepare(identity(), undefined, () => assert.fail('must adopt hover'));
  assert.equal(viewer, hover);
  assert.equal(requests.cancel('clip', library.root, 'hover-a'), true);
  assert.equal(work.signal.aborted, false);
  work.resolve('shared');
  assert.equal(await viewer, 'shared');
});

test('each hover lease cancels only itself, and the last lease aborts conversion', async () => {
  const requests = createVideoPreviewRequests(), work = controlled();
  const pending = requests.prepare(identity(), 'hover-a', work.run);
  requests.prepare(identity(), 'hover-b', () => assert.fail('shared work'));
  const rejected = aborted(pending);
  await tick();
  assert.equal(requests.cancel('clip', library.root, 'hover-a'), true);
  assert.equal(work.signal.aborted, false);
  assert.equal(requests.cancel('clip', library.root, 'hover-a'), false);
  assert.equal(requests.cancel('clip', library.root, 'hover-b'), true);
  assert.equal(work.signal.aborted, true);
  await rejected;
});

test('old or foreign cancellations cannot abort a new hover of the same clip', async () => {
  const requests = createVideoPreviewRequests(), old = controlled(), next = controlled();
  const previous = requests.prepare(identity(), 'old-hover', old.run);
  const previousRejected = aborted(previous);
  await tick();
  requests.cancel('clip', library.root, 'old-hover');
  const current = requests.prepare(identity(), 'new-hover', next.run);
  await tick();
  assert.equal(requests.cancel('clip', library.root, 'old-hover'), false);
  assert.equal(requests.cancel('other-clip', library.root, 'new-hover'), false);
  assert.equal(requests.cancel('clip', 'another-library', 'new-hover'), false);
  assert.equal(next.signal.aborted, false);
  next.resolve('new');
  assert.equal(await current, 'new');
  await previousRejected;
});

test('hover cannot interrupt a different full viewer, but switching viewers cancels obsolete work', async () => {
  const requests = createVideoPreviewRequests(), first = controlled(), next = controlled();
  const viewer = requests.prepare(identity('first'), undefined, first.run);
  const viewerRejected = aborted(viewer);
  await tick();
  await aborted(requests.prepare(identity('hover'), 'hover-token', () => assert.fail('viewer takes priority')));
  assert.equal(first.signal.aborted, false);
  const replacement = requests.prepare(identity('next'), undefined, next.run);
  await tick();
  assert.equal(first.signal.aborted, true);
  next.resolve('next-viewer');
  assert.equal(await replacement, 'next-viewer');
  await viewerRejected;
});

test('changed original bytes or library instance never reuse an obsolete preparation', async () => {
  const requests = createVideoPreviewRequests(), old = controlled(), changed = controlled(), reopened = controlled();
  const first = requests.prepare(identity(), 'first', old.run);
  const firstRejected = aborted(first);
  await tick();
  const second = requests.prepare(identity('clip', { hash: 'new-content' }), 'second', changed.run);
  const secondRejected = aborted(second);
  await tick();
  assert.equal(old.signal.aborted, true);
  const third = requests.prepare(identity('clip', { library: { root: library.root }, hash: 'new-content' }), 'third', reopened.run);
  await tick();
  assert.equal(changed.signal.aborted, true);
  reopened.resolve('fresh-library');
  assert.equal(await third, 'fresh-library');
  await Promise.all([firstRejected, secondRejected]);
});

test('closing a converting viewer permits another hover while quick reopen still shares work', async () => {
  const requests = createVideoPreviewRequests(), work = controlled(), hover = controlled();
  const viewer = requests.prepare(identity(), undefined, work.run);
  const viewerRejected = aborted(viewer);
  await tick();
  assert.equal(requests.releaseViewer('other-clip', library.root), false);
  assert.equal(requests.releaseViewer('clip', 'other-library'), false);
  assert.equal(requests.releaseViewer('clip', library.root), true);
  assert.equal(work.signal.aborted, false);
  assert.equal(requests.prepare(identity(), undefined, () => assert.fail('rapid reopen shares work')), viewer);
  requests.releaseViewer('clip', library.root);
  const next = requests.prepare(identity('next'), 'next-hover', hover.run);
  await tick();
  assert.equal(work.signal.aborted, true);
  hover.resolve('next-video');
  assert.equal(await next, 'next-video');
  await viewerRejected;
});

test('releasing viewer ownership leaves another hover lease intact', async () => {
  const requests = createVideoPreviewRequests(), work = controlled();
  const pending = requests.prepare(identity(), 'hover-a', work.run);
  const rejected = aborted(pending);
  requests.prepare(identity(), undefined, () => assert.fail('must share'));
  await tick();
  assert.equal(requests.releaseViewer('clip', library.root), true);
  assert.equal(requests.releaseViewer('clip', library.root), false);
  assert.equal(work.signal.aborted, false);
  assert.equal(requests.cancel('clip', library.root, 'hover-a'), true);
  assert.equal(work.signal.aborted, true);
  await rejected;
});

test('malformed hover tokens cannot cancel or replace valid work', async () => {
  const requests = createVideoPreviewRequests(), work = controlled();
  const pending = requests.prepare(identity(), 'valid-token', work.run);
  await tick();
  for (const invalid of ['', 'a\n', 'x'.repeat(129), {}, 1, 'bad/token']) {
    assert.throws(() => requests.prepare(identity('other'), invalid, () => {}), /标识无效/);
    assert.throws(() => requests.cancel('clip', library.root, invalid), /标识无效/);
  }
  assert.equal(work.signal.aborted, false);
  work.resolve('unaffected');
  assert.equal(await pending, 'unaffected');
});

test('library switch aborts work and rejects a late successful completion', async () => {
  const requests = createVideoPreviewRequests();
  let signal, finish;
  const pending = requests.prepare(identity(), 'hover-a', value => {
    signal = value;
    return new Promise(resolve => { finish = resolve; });
  });
  const rejected = aborted(pending);
  await tick();
  requests.abortAll();
  assert.equal(signal.aborted, true);
  assert.equal(requests.cancel('clip', library.root, 'hover-a'), false);
  finish('stale');
  await rejected;
  assert.equal(await requests.prepare(identity(), undefined, async () => 'fresh'), 'fresh');
});
