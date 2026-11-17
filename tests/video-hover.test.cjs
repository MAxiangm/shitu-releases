'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, previewUrl } = require('../src/video-hover.js');
const key = 'a'.repeat(64);
const urlFor = id => `shitu://asset/${encodeURIComponent(id)}?kind=preview&key=${key}`;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

class Thumb extends EventTarget {
  constructor() { super(); this.dataset = {}; this.isConnected = true; this.children = []; }
  prepend(video) { this.children.unshift(video); video.parent = this; }
  enter(pointerType = 'mouse') { const event = new Event('pointerenter'); event.pointerType = pointerType; this.dispatchEvent(event); }
  leave() { this.dispatchEvent(new Event('pointerleave')); }
}
class Video extends EventTarget {
  constructor(playResult) { super(); this.attributes = new Map(); this.playResult = playResult; this.paused = true; this.src = ''; this.loads = 0; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return this.playResult ? this.playResult() : Promise.resolve(); }
  pause() { this.paused = true; }
  load() { this.loads++; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
}
function fixture(options = {}) {
  let timerId = 0;
  const timers = new Map(), prepares = [], cancels = [], videos = [];
  const controller = create({
    prepare: (id, root, token) => { prepares.push({ id, root, token }); return options.prepared ? options.prepared(id) : { url: urlFor(id) }; },
    cancel: (id, root, token) => { cancels.push({ id, root, token }); return options.cancelResult; },
    makeVideo: () => { const video = new Video(options.playResult); videos.push(video); return video; },
    schedule: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    unschedule: id => timers.delete(id),
    allowed: options.allowed || (() => true), current: options.current || (() => true)
  });
  return { controller, prepares, cancels, videos, timers,
    attach: id => { const thumb = new Thumb(); controller.attach(thumb, { id, hash: id }, 'fixture-library'); return thumb; },
    tick: async () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } await flush(); }
  };
}

test('hover dwell avoids preparing videos while sweeping thumbnails or using touch', async () => {
  const f = fixture(), first = f.attach('first'), second = f.attach('second');
  first.enter(); assert.equal(first.dataset.videoHoverState, 'pending');
  first.leave(); second.enter(); second.leave();
  first.enter('touch');
  await f.tick();
  assert.equal(f.prepares.length, 0);
  assert.equal(f.videos.length, 0);
  assert.equal(f.cancels.length, 0);
  assert.equal(f.timers.size, 0);
});

test('one muted looping hover video plays and leaving releases source, player and scoped preparation', async () => {
  const f = fixture(), first = f.attach('first'), second = f.attach('second');
  first.enter(); await f.tick();
  const video = f.videos[0];
  assert.equal(first.dataset.videoHoverState, 'playing');
  assert.equal(video.src, urlFor('first'));
  assert.equal(video.muted, true); assert.equal(video.defaultMuted, true);
  assert.equal(video.loop, true); assert.equal(video.controls, false); assert.equal(video.playsInline, true);
  assert.equal(video.attributes.get('aria-hidden'), 'true'); assert.equal(video.tabIndex, -1);
  second.enter();
  assert.equal(video.paused, true); assert.equal(video.src, ''); assert.equal(video.loads, 1);
  assert.equal(first.children.length, 0); assert.equal(first.dataset.videoHoverState, undefined);
  assert.deepEqual(f.cancels[0], f.prepares[0]);
  await f.tick(); assert.equal(second.dataset.videoHoverState, 'playing');
  second.leave(); assert.equal(second.children.length, 0); assert.equal(f.cancels.length, 2);
});

test('late preparation cannot create a player after mouse leave, another hover, or library replacement', async () => {
  const pending = deferred(); let sameLibrary = true;
  const f = fixture({ prepared: id => id === 'old' ? pending.promise : { url: urlFor(id) }, current: () => sameLibrary });
  const old = f.attach('old'), next = f.attach('next');
  old.enter(); await f.tick(); assert.equal(old.dataset.videoHoverState, 'preparing');
  old.leave(); next.enter(); await f.tick();
  pending.resolve({ url: urlFor('old') }); await flush();
  assert.equal(f.videos.length, 1); assert.equal(f.videos[0].src, urlFor('next'));
  assert.equal(old.children.length, 0);
  f.controller.stop();
  const delayed = deferred();
  const replaced = fixture({ prepared: () => delayed.promise, current: () => sameLibrary });
  const thumb = replaced.attach('replaced'); thumb.enter(); await replaced.tick();
  sameLibrary = false; delayed.resolve({ url: urlFor('replaced') }); await flush();
  assert.equal(replaced.videos.length, 0);
  replaced.controller.stop(); assert.equal(replaced.cancels.length, 1);
});

test('foreground handoff removes hover media immediately and lets the viewer adopt work before scoped cancellation', async () => {
  const f = fixture(), thumb = f.attach('video');
  thumb.enter(); await f.tick();
  f.controller.stop({ deferCancel: true });
  assert.equal(thumb.children.length, 0);
  assert.equal(f.cancels.length, 0);
  let viewerAdopted = false;
  await Promise.resolve().then(() => { viewerAdopted = true; });
  assert.equal(viewerAdopted, true);
  await f.tick();
  assert.deepEqual(f.cancels[0], f.prepares[0]);
});

test('conversion, invalid URL and autoplay failures keep thumbnail and do not leak a player or rejection', async () => {
  for (const options of [
    { prepared: () => Promise.reject(new Error('conversion failed')) },
    { prepared: () => ({ url: 'https://example.test/movie.mp4' }) },
    { playResult: () => Promise.reject(new Error('autoplay failed')) }
  ]) {
    // The play promise is handled by the controller in the same turn.
    const f = fixture(options), thumb = f.attach('video'); thumb.enter(); await f.tick();
    assert.equal(thumb.dataset.videoHoverState, 'error'); assert.equal(thumb.children.length, 0);
    f.controller.stop(); assert.equal(thumb.dataset.videoHoverState, undefined);
    assert.equal(f.cancels.length, 1);
  }
});

test('clear detaches old thumbnails and stops pending or active resources, while disabled hover prepares nothing', async () => {
  let allowed = false;
  const f = fixture({ allowed: () => allowed }), thumb = f.attach('video');
  thumb.enter(); await f.tick(); assert.equal(f.prepares.length, 0);
  allowed = true; thumb.enter(); f.controller.clear(); await f.tick();
  assert.equal(f.prepares.length, 0); assert.equal(thumb.dataset.videoHoverState, undefined);
  thumb.enter(); await f.tick(); assert.equal(f.prepares.length, 0);
  const current = f.attach('current'); current.enter(); await f.tick();
  f.controller.destroy(); assert.equal(f.videos[0].src, ''); assert.equal(current.children.length, 0);
});

test('hover accepts only the matching managed video preview with a complete authorization key', () => {
  assert.equal(previewUrl({ url: urlFor('safe asset') }, 'safe asset'), urlFor('safe asset'));
  for (const url of [
    urlFor('other'), urlFor('safe').replace('kind=preview', 'kind=original'),
    urlFor('safe').replace(key, 'bad'), urlFor('safe') + '#fragment',
    urlFor('safe').replace('asset/', 'asset:443/'), urlFor('safe').replace('asset/', 'user@asset/'),
    'file:///C:/movie.mp4', 'https://asset/safe?kind=preview&key=' + key
  ]) assert.throws(() => previewUrl({ url }, 'safe'));
});
