'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const youtubeScript = fs.readFileSync(path.join(root, 'extension/social-youtube.js'), 'utf8');
const contentScript = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
const adapter = { URL };
vm.runInNewContext(youtubeScript, adapter);
const resolve = adapter.MosaicYouTubeVideo;
const id = 'AbCdEfGhI_1';
const otherId = 'ZyXwVuTsR-2';
const canonical = `https://www.youtube.com/watch?v=${id}`;

function link(href, title = 'Selected video') {
  return { tagName: 'A', textContent: title, getAttribute: name => name === 'href' ? href : null };
}

function input({ url = canonical, video = { currentSrc: 'blob:https://www.youtube.com/selected' }, nodes = [] } = {}) {
  return { page: new URL(url), document: { title: 'A sample video - YouTube' }, video, path: nodes };
}

test('YouTube watch, Shorts, live, short links, and privacy embeds canonicalize one selected video', () => {
  for (const url of [canonical + '&list=PLexample&t=30', `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}?feature=share`, `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`, `https://www.youtube-nocookie.com/embed/${id}`,
    `https://youtu.be/${id}?si=example`]) {
    const source = resolve.pageSource(url);
    assert.equal(source.url, canonical);
    assert.equal(source.pageUrl, canonical);
    assert.equal(source.videoId, id);
    assert.equal(source.sourceType, 'youtube');
  }
  const source = resolve(input());
  assert.equal(source.url, canonical);
  assert.equal(source.name, 'A sample video');
});

test('YouTube URL parsing rejects foreign hosts, credentials, ambiguous IDs and non-video routes', () => {
  for (const url of [`https://youtube.com.example/watch?v=${id}`, `http://www.youtube.com/watch?v=${id}`,
    `https://user:pass@www.youtube.com/watch?v=${id}`, `https://www.youtube.com:444/watch?v=${id}`,
    `https://www.youtube.com/watch?v=${id}&v=${otherId}`, `https://www.youtube.com/watch?v=${id}/extra`,
    'https://www.youtube.com/watch?v=short', `https://www.youtube.com/@${id}`,
    `https://www.youtube.com/shorts/${id}/other`, 'https://www.youtube.com/playlist?list=PLexample']) {
    assert.equal(resolve.pageSource(url), null, url);
  }
  assert.equal(resolve(input({ url: 'https://example.com/watch?v=' + id })), null);
});

test('YouTube clicked recommendations and Shorts cards beat the main watch route', () => {
  const selected = link(`/watch?v=${otherId}&list=PLexample`);
  const source = resolve(input({ nodes: [selected] }));
  assert.equal(source.videoId, otherId);
  assert.equal(source.name, 'Selected video');
  const card = { getAttribute: name => name === 'data-video-id' ? otherId : null, querySelector: () => null };
  const overlay = { closest: () => card };
  assert.equal(resolve(input({ nodes: [overlay] })).videoId, otherId);
  const linksCard = { getAttribute: () => null, querySelector: () => ({ textContent: 'Short clip' }),
    querySelectorAll: () => [link(`/shorts/${otherId}`), link(`/watch?v=${otherId}`)] };
  assert.equal(resolve(input({ video: null, nodes: [{ closest: () => linksCard }] })).videoId, otherId);
});

test('YouTube never downloads the main player for an ambiguous card or unrelated image', () => {
  const card = { getAttribute: () => null, querySelectorAll: () => [link(canonical), link(`/watch?v=${otherId}`)] };
  assert.match(resolve(input({ nodes: [{ closest: () => card }] })).error, /无法确定/);
  assert.equal(resolve(input({ video: null, nodes: [{ tagName: 'IMG', closest: () => null }] })), null);
  assert.match(resolve(input({ url: 'https://www.youtube.com/results?search_query=sample' })).error, /打开视频页面/);
  assert.match(resolve(input({ video: { mediaKeys: {} } })).error, /无法保存/);
  assert.match(resolve(input({ video: { srcObject: {} } })).error, /无法保存/);
});

test('YouTube binds a linkless Shorts player only to the explicitly active reel', () => {
  const card = { tagName: 'YTD-REEL-VIDEO-RENDERER', getAttribute: () => null, querySelectorAll: () => [],
    hasAttribute: name => name === 'is-active' };
  const source = resolve(input({ url: `https://www.youtube.com/shorts/${id}`, nodes: [{ closest: () => card }] }));
  assert.equal(source.videoId, id);
  card.hasAttribute = () => false;
  assert.match(resolve(input({ url: `https://www.youtube.com/shorts/${id}`, nodes: [{ closest: () => card }] })).error, /无法确定/);
});

function pageFixture({ url = canonical, kind = 'video', cardId, deepOverlay = false } = {}) {
  const events = new Map(), nodes = [], messages = [], fetches = [];
  let onMessage;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.style = {}; this.isConnected = true; nodes.push(this); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener() {}
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    attachShadow() { return new Element('shadow'); }
    remove() { this.isConnected = false; }
    closest(selector) {
      if (selector.includes('ytd-rich-item-renderer')) return this.card || this.parentElement?.card || null;
      return null;
    }
    querySelector() { return null; }
    querySelectorAll(selector) {
      if (selector === ':scope > video, :scope > * > video') return this.children.flatMap(child => [child, ...child.children]).filter(child => child.tagName === 'VIDEO');
      return [];
    }
    getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 }; }
  }
  const html = new Element('html'), body = new Element('body'), wrapper = new Element('div');
  html.append(body); body.append(wrapper);
  const media = new Element(kind === 'video' ? 'video' : 'img');
  media.currentSrc = kind === 'video' ? 'blob:https://www.youtube.com/player' : 'https://i.ytimg.com/vi/' + otherId + '/hqdefault.jpg';
  if (cardId) {
    const card = new Element('ytd-rich-item-renderer');
    card.setAttribute('data-video-id', cardId);
    media.card = card;
  }
  let selectedPath;
  if (deepOverlay) {
    const player = new Element('div'), overlay = new Element('div'), layer = new Element('div'), surface = new Element('span');
    wrapper.append(player, overlay); player.append(media); overlay.append(layer); layer.append(surface);
    selectedPath = [surface, layer, overlay, wrapper, body, html];
  } else { wrapper.append(media); selectedPath = [media, wrapper, body, html]; }
  const document = { title: 'Example - YouTube', baseURI: url, documentElement: html, body,
    createElement: tag => new Element(tag), elementsFromPoint: () => [media],
    querySelectorAll: selector => selector === 'video' ? nodes.filter(node => node.tagName === 'VIDEO') : [] };
  const location = { href: url };
  const context = { Element, URL, document, location, performance: { now: () => Date.now() },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', backgroundImage: 'none' }),
    setTimeout: () => 1, clearTimeout() {},
    window: { addEventListener: (name, callback) => events.set(name, [...(events.get(name) || []), callback]) },
    chrome: { runtime: { id: 'fixture', onMessage: { addListener: callback => { onMessage = callback; } },
      sendMessage: async message => { messages.push(message); return { ok: true, imported: 1, duplicates: 0 }; } } },
    fetch: async (...args) => { fetches.push(args); throw new Error('YouTube pages and MSE blobs must never be fetched as files'); } };
  vm.runInNewContext(youtubeScript, context);
  vm.runInNewContext(contentScript, context);
  function gesture(name, options = {}) {
    const state = { prevented: false, stopped: false };
    const event = { isTrusted: true, button: 2, altKey: true, clientX: 30, clientY: 30, composedPath: () => selectedPath,
      preventDefault() { state.prevented = true; }, stopImmediatePropagation() { state.stopped = true; }, ...options };
    for (const callback of events.get(name) || []) { callback(event); if (state.stopped) break; }
    return state;
  }
  return { nodes, messages, fetches, media, location, html, gesture,
    request: message => new Promise(resolveResponse => onMessage(message, { id: 'fixture' }, resolveResponse)) };
}

async function captured(fixture) {
  for (let count = 0; count < 40; count++) {
    const message = fixture.messages.find(item => item.type === 'shitu:capture');
    if (message) return message.media;
    await new Promise(resolveDelay => setImmediate(resolveDelay));
  }
  assert.fail('No capture was submitted');
}

test('YouTube Alt+right-click captures one video under the player overlay without fetching a blob', async () => {
  const fixture = pageFixture({ deepOverlay: true });
  assert.deepEqual(fixture.gesture('pointerdown'), { prevented: true, stopped: true });
  assert.deepEqual(fixture.gesture('contextmenu', { altKey: false }), { prevented: true, stopped: true });
  const media = await captured(fixture);
  assert.equal(media.url, canonical);
  assert.equal(media.sourceType, 'youtube');
  assert.equal(media.videoId, id);
  assert.equal(media.socialPageUrl, canonical);
  assert.equal(fixture.fetches.length, 0);
  assert.equal(fixture.messages.filter(item => item.type === 'shitu:capture').length, 1);
});

test('YouTube ordinary right-click on a recommendation saves the video instead of its thumbnail', async () => {
  const fixture = pageFixture({ kind: 'image', cardId: otherId });
  fixture.gesture('contextmenu', { altKey: false });
  const menu = fixture.nodes.find(node => node.isConnected && node.attributes['data-shitu-video-menu'] !== undefined);
  assert.ok(menu);
  fixture.gesture('click', { button: 0, altKey: false, composedPath: () => [menu, fixture.html] });
  const media = await captured(fixture);
  assert.equal(media.kind, 'video');
  assert.equal(media.sourceType, 'youtube');
  assert.equal(media.videoId, otherId);
  assert.equal(fixture.fetches.length, 0);
});

test('YouTube native context-menu resolver uses the selected frame and rejects stale or blank targets', async () => {
  const fixture = pageFixture({ deepOverlay: true });
  fixture.gesture('contextmenu', { altKey: false });
  const response = await fixture.request({ type: 'shitu:resolve-youtube' });
  assert.equal(response.ok, true);
  assert.equal(response.media.videoId, id);
  fixture.location.href = `https://www.youtube.com/watch?v=${otherId}`;
  assert.equal((await fixture.request({ type: 'shitu:resolve-youtube' })).ok, false);
  const fromLink = await fixture.request({ type: 'shitu:resolve-youtube', linkUrl: `/shorts/${otherId}` });
  assert.equal(fromLink.ok, true);
  assert.equal(fromLink.media.videoId, otherId);
  const blank = pageFixture({ kind: 'image' });
  blank.gesture('contextmenu', { altKey: false });
  assert.equal((await blank.request({ type: 'shitu:resolve-youtube' })).ok, false);
});
