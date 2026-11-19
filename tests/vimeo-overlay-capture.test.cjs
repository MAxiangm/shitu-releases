'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';

async function capture({ outsidePlayer = false, readyState = 4, ended = true, duration = 15.89,
  secondVideo = false, pointerOutside = false, page = 'https://vimeo.com/798860' } = {}) {
  const messages = [], listeners = new Map();
  class Element {
    constructor(tag, attributes = {}) { this.tagName = tag.toUpperCase(); this.attributes = attributes; this.children = []; this.style = {}; this.isConnected = true; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    addEventListener() {}
    attachShadow() { return new Element('shadow'); }
    closest(selector) {
      if (selector !== '.player') return null;
      for (let element = this; element; element = element.parentElement) if (element.attributes.class === 'player') return element;
      return null;
    }
    querySelector() { return null; }
    querySelectorAll(selector) {
      if (selector !== 'video') return [];
      return this.children.flatMap(child => [...(child.tagName === 'VIDEO' ? [child] : []), ...child.querySelectorAll('video')]);
    }
    getBoundingClientRect() {
      return this.tagName === 'IMG' ? { left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 }
        : { left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 };
    }
    remove() { this.isConnected = false; }
  }
  const html = new Element('html'), body = new Element('body'), player = new Element('div', { class: 'player' });
  const videoWrapper = new Element('div'), video = new Element('video'), link = new Element('a', { href: 'https://vimeo.com/9999' });
  const image = new Element('img', { src: 'https://i.vimeocdn.com/video/next.jpg' });
  html.append(body); body.append(player); player.append(videoWrapper); videoWrapper.append(video); link.append(image);
  (outsidePlayer ? body : player).append(link);
  Object.assign(video, { currentSrc: 'blob:https://vimeo.com/current', readyState, ended, duration });
  if (secondVideo) videoWrapper.append(Object.assign(new Element('video'), { currentSrc: 'blob:https://vimeo.com/other', readyState: 4, duration }));
  const document = { baseURI: page, title: 'Current Vimeo video', documentElement: html, body,
    createElement: tag => new Element(tag), querySelectorAll: selector => html.querySelectorAll(selector), elementsFromPoint: () => [image, link] };
  const hitPath = outsidePlayer ? [image, link, body, html] : [image, link, player, body, html];
  vm.runInNewContext(source, { Element, URL, AbortController, AbortSignal, document, location: { href: page }, performance: { now: () => Date.now() },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', backgroundImage: 'none' }),
    setTimeout: () => 1, clearTimeout() {}, fetch: async () => ({ ok: false }),
    window: { addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) || []), listener]) },
    MosaicVimeoVideo: ({ video: selected }) => selected ? ({ url: 'https://vod.vimeocdn.com/current/video.mp4', playback: 'file', pageUrl: page }) : null,
    chrome: { runtime: { id: extensionId, onMessage: { addListener() {} }, sendMessage: async message => {
      messages.push(message); return { ok: true, imported: 1, duplicates: 0 };
    } } }
  });
  const event = { isTrusted: true, button: 2, altKey: true, clientX: pointerOutside ? 250 : 20, clientY: 20,
    composedPath: () => hitPath, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
  for (const listener of listeners.get('pointerdown') || []) { listener(event); if (event.stopped) break; }
  event.stopped = false;
  for (const listener of listeners.get('contextmenu') || []) { listener(event); if (event.stopped) break; }
  for (let i = 0; i < 100; i++) {
    const message = messages.find(item => item.type === 'shitu:capture');
    if (message) return message.media;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(JSON.stringify(messages));
}

test('Vimeo ended-player recommendation artwork keeps the current video intent on Alt+right', async () => {
  const media = await capture();
  assert.equal(media.kind, 'video');
  assert.equal(media.url, 'https://vod.vimeocdn.com/current/video.mp4');
  assert.equal(media.expectedDuration, 15.89);
});

test('Vimeo active-player overlay links also keep the loaded player intent', async () => {
  assert.equal((await capture({ ended: false, readyState: 2 })).kind, 'video');
});

test('Vimeo sidebar images and ambiguous or unloaded player overlays remain images', async () => {
  for (const options of [{ outsidePlayer: true }, { pointerOutside: true }, { secondVideo: true },
    { ended: false, readyState: 0 }, { duration: Infinity }, { page: 'https://vimeo.com/channels/staffpicks' }]) {
    const media = await capture(options);
    assert.equal(media.kind, 'image', JSON.stringify(options));
    assert.equal(media.url, 'https://i.vimeocdn.com/video/next.jpg');
  }
});
