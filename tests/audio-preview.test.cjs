'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Preview = require('../src/audio-preview.js');

class Element {
  constructor() {
    this.dataset = {}; this.attributes = new Map(); this.events = new Map(); this.textContent = '';
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
      toggle(value, enabled) { if (enabled === undefined) enabled = !classes.has(value); if (enabled) classes.add(value); else classes.delete(value); } };
  }
  set src(value) { this.attributes.set('src', value); }
  get src() { return this.attributes.get('src') || ''; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(type, listener) { this.events.set(type, listener); }
  dispatch(type) { this.events.get(type)?.(); }
}
const asset = (id = 'one') => ({ id, ext: 'mp3', name: 'Original file', mediaType: 'audio', duration: 65,
  audio: { title: 'Song <title>', artist: 'Artist', album: 'Album' } });
const prepared = (id = 'one') => ({ url: `shitu://audio/${id}?key=authorized`, duration: 65, audioCodec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 192000 });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides = {}) {
  const elements = Object.fromEntries(['panel', 'audio', 'title', 'artist', 'album', 'details', 'status', 'retry', 'artwork', 'placeholder', 'loop'].map(key => [key, new Element()]));
  const cancelled = [], played = [], metadata = [];
  elements.audio.paused = true;
  elements.audio.pause = () => { elements.audio.paused = true; };
  elements.audio.load = () => {};
  elements.audio.play = async () => { elements.audio.paused = false; played.push(elements.audio.src); };
  const api = Preview.create({ ...elements, prepare: async id => prepared(id), cancel: token => cancelled.push(token),
    onMetadata: (_asset, value) => metadata.push(value), assetUrl: id => `shitu://asset/${id}?kind=thumbnail`, ...overrides });
  return { ...elements, api, cancelled, played, metadata };
}

test('audio metadata describes sound rather than image dimensions and validates managed playback URLs', () => {
  assert.equal(Preview.duration(3665), '1:01:05');
  assert.equal(Preview.duration(0), '0:00');
  assert.equal(Preview.duration(NaN), '');
  assert.equal(Preview.metadata(prepared()), '1:05 · MP3 · 44.1 kHz · 立体声 · 192 kbps');
  assert.equal(Preview.playbackUrl(prepared().url, 'one'), prepared().url);
  for (const url of ['https://example.test/file.mp3', 'shitu://asset/one?key=a', 'shitu://audio/two?key=a', 'shitu://audio/one', 'shitu://user:pass@audio/one?key=a']) {
    assert.throws(() => Preview.playbackUrl(url, 'one'));
  }
});

test('music navigation advances one visible asset at a time independently of cylinder rows', () => {
  const visible = Array.from({ length: 9 }, (_, index) => asset(`track-${index + 1}`));
  let current = visible[0];
  for (let index = 1; index < visible.length; index++) {
    current = Preview.adjacent(visible, current.id, 1);
    assert.equal(current.id, visible[index].id, 'three cylinder rows must not skip two tracks');
  }
  assert.equal(Preview.adjacent(visible, current.id, 1).id, 'track-1');
  assert.equal(Preview.adjacent(visible, 'track-1', -1).id, 'track-9');
  assert.equal(Preview.adjacent(visible, 'track-5', -1).id, 'track-4');
  assert.equal(Preview.adjacent([visible[0]], 'track-1', 1).id, 'track-1');
  assert.equal(Preview.adjacent([], 'track-1', 1), null);
  assert.equal(Preview.adjacent(visible, 'missing', 1), null);
  assert.equal(Preview.adjacent(visible, 'track-1', 3), null);
});

test('audio preview renders title, artwork and metadata, plays and completely unloads on reset', async () => {
  const f = fixture();
  await f.api.show({ ...asset(), thumbnail: 'cover.jpg' }, 'library');
  assert.equal(f.panel.dataset.ready, 'true');
  assert.equal(f.title.textContent, 'Song <title>');
  assert.equal(f.artist.textContent, 'Artist');
  assert.equal(f.album.textContent, 'Album');
  assert.equal(f.artwork.src, 'shitu://asset/one?kind=thumbnail');
  assert.deepEqual(f.played, [prepared().url]);
  f.api.reset();
  assert.equal(f.audio.src, ''); assert.equal(f.audio.paused, true);
  assert.equal(f.panel.classList.contains('hidden'), true);
  assert.equal(f.panel.dataset.ready, undefined);
  assert.equal(f.cancelled.length, 1);
  assert.match(f.cancelled[0], /^audio-viewer-\d+-\d+$/);
});

test('late preparation cannot play after changing music or leaving its library', async () => {
  const first = deferred();
  let currentRoot = 'first';
  const f = fixture({ prepare: id => id === 'one' ? first.promise : Promise.resolve(prepared(id)), current: (_asset, root) => root === currentRoot });
  const pending = f.api.show(asset(), 'first');
  await f.api.show(asset('two'), 'first');
  first.resolve(prepared('one')); await pending;
  assert.deepEqual(f.played, [prepared('two').url]);
  assert.equal(f.title.textContent, 'Song <title>');
  const third = deferred();
  const g = fixture({ prepare: () => third.promise, current: (_asset, root) => root === currentRoot });
  const waiting = g.api.show(asset(), 'first'); currentRoot = 'second';
  third.resolve(prepared()); await waiting;
  assert.deepEqual(g.played, []);
  g.api.reset();
});

test('audio failure offers retry and system-player guidance without loading untrusted URLs', async () => {
  let attempts = 0;
  const f = fixture({ prepare: async () => { attempts++; return attempts === 1 ? { url: 'https://evil.test/sound' } : prepared(); } });
  await f.api.show(asset(), 'library');
  assert.equal(f.audio.src, '');
  assert.equal(f.retry.classList.contains('hidden'), false);
  assert.match(f.status.textContent, /系统播放器/);
  f.retry.dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.played, [prepared().url]);
  f.audio.error = {}; f.audio.dispatch('error');
  assert.equal(f.panel.dataset.ready, undefined);
  assert.match(f.status.textContent, /重试/);
  f.api.reset();
});

test('autoplay denial keeps usable controls and loop changes target only the current audio player', async () => {
  const f = fixture();
  f.audio.play = async () => { throw new Error('NotAllowedError'); };
  await f.api.show(asset(), 'library');
  assert.equal(f.panel.dataset.ready, 'true');
  assert.equal(f.audio.classList.contains('hidden'), false);
  assert.equal(f.status.textContent, '点击播放按钮试听');
  f.loop.checked = true; f.loop.dispatch('change'); assert.equal(f.audio.loop, true);
  f.loop.checked = false; f.loop.dispatch('change'); assert.equal(f.audio.loop, false);
  f.api.reset();
});
