'use strict';

// Isolated Chromium/Electron integration check for the production image editor.
// Mock persistence keeps this test completely separate from a user's library.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath } = require('./runtime.cjs');

async function electronTest({ app, BrowserWindow, session }, options) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const checks = [];
  const errors = [];
  let window;
  let networkAttempts = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  async function waitFor(fn, message, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await js(fn)) return;
      await pause(30);
    }
    throw new Error(message);
  }
  async function click(selector) {
    await js(selector => { const node = document.querySelector(selector); if (!node || node.disabled) throw new Error(`Unavailable control ${selector}`); node.click(); }, selector);
    await js(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function parameter(name, value) {
    await js((name, value) => {
      const node = document.querySelector(`[data-param="${name}"]`);
      if (!node) throw new Error(`Missing parameter ${name}`);
      if (node.type === 'checkbox') node.checked = value;
      else node.value = String(value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, name, value);
    await pause(180);
  }
  async function layerParameter(name, value) {
    await js((name, value) => {
      const node = document.querySelector(`[data-layer-param="${name}"]`);
      if (!node || node.disabled) throw new Error(`Unavailable layer parameter ${name}`);
      node.value = String(value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, name, value);
    await pause(80);
  }
  async function editorOption(attribute, name, value) {
    await js((attribute, name, value) => {
      const node = document.querySelector(`[${attribute}="${name}"]`);
      if (!node || node.disabled) throw new Error(`Unavailable editor option ${attribute}=${name}`);
      if (node.type === 'checkbox') node.checked = value;
      else node.value = String(value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, attribute, name, value);
    await pause(80);
  }
  const documentSize = () => js(() => {
    const canvas = document.querySelector('#imageEditorCanvas'); return { width: canvas.width, height: canvas.height };
  });
  const dragBounds = (first, last) => js((first, last) => {
    const canvas = document.querySelector('#imageEditorOverlayCanvas'), bounds = canvas.getBoundingClientRect();
    const point = ([x, y]) => ({
      x: (Math.round(bounds.left + x / canvas.width * bounds.width) - bounds.left) * canvas.width / bounds.width,
      y: (Math.round(bounds.top + y / canvas.height * bounds.height) - bounds.top) * canvas.height / bounds.height
    });
    const p = point(first), q = point(last), left = Math.floor(Math.min(p.x, q.x)), top = Math.floor(Math.min(p.y, q.y));
    return { left, top, width: Math.ceil(Math.max(p.x, q.x)) - left, height: Math.ceil(Math.max(p.y, q.y)) - top };
  }, first, last);
  const layerCount = () => js(() => document.querySelectorAll('.ie-layer-row').length);
  const activeLayerId = () => js(() => document.querySelector('.ie-layer-row.is-active')?.dataset.layerId);
  async function importLayer(name, color, rectangle = [96, 72, 64, 48]) {
    const before = await layerCount();
    await js(async (name, color, rectangle) => {
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 192;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(...rectangle);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const files = new DataTransfer(); files.items.add(new File([blob], name, { type: 'image/png' }));
      const input = document.querySelector('#imageEditorLayerFile');
      if (!input) throw new Error('Missing image-layer import input');
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    }, name, color, rectangle);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && await layerCount() !== before + 1) await pause(30);
    assert(await layerCount() === before + 1, `Image import did not create a layer: ${name}`);
    await pause(100);
    return activeLayerId();
  }
  async function transferLayer(kind, color, rectangle) {
    const before = await layerCount();
    const eventResult = await js(async (kind, color, rectangle) => {
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 192;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(...rectangle);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], `${kind}.png`, { type: 'image/png' }));
      const event = kind === 'drop'
        ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
        : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
      let bubbled = 0;
      const observe = () => { bubbled++; };
      document.addEventListener(kind, observe);
      document.querySelector(kind === 'drop' ? '#imageEditorStage' : '#imageEditorOverlayCanvas').dispatchEvent(event);
      document.removeEventListener(kind, observe);
      return { prevented: event.defaultPrevented, bubbled };
    }, kind, color, rectangle);
    assert(eventResult.prevented && eventResult.bubbled === 0, `${kind} event escaped the editor into the asset library: ${JSON.stringify(eventResult)}`);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && await layerCount() !== before + 1) await pause(30);
    assert(await layerCount() === before + 1, `${kind} did not create an image layer`);
    await pause(100);
    return activeLayerId();
  }
  async function layerAction(id, action) { await click(`.ie-layer-row[data-layer-id="${id}"] [data-layer-action="${action}"]`); }
  const assertPixel = (actual, expected, message, tolerance = 2) => assert(actual.every((value, channel) => Math.abs(value - expected[channel]) <= tolerance), `${message}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  async function pressKey(keyCode, modifiers = []) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await pause(80);
  }
  async function key(keyCode, modifiers = []) {
    await js(() => document.querySelector('#imageEditorOverlayCanvas').focus());
    await pressKey(keyCode, modifiers);
  }
  async function zoom(value) {
    await js(value => {
      const node = document.querySelector('[data-view="zoom"]');
      node.value = String(value);
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await pause(80);
  }
  async function dragStage() {
    const point = await js(() => {
      const stage = document.querySelector('#imageEditorStage');
      stage.scrollTop = 200; stage.scrollLeft = 100;
      const bounds = stage.getBoundingClientRect();
      return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2), top: stage.scrollTop };
    });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y - 70, button: 'left' });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y - 70, button: 'left', clickCount: 1 });
    await pause(80);
    return { before: point.top, after: await js(() => document.querySelector('#imageEditorStage').scrollTop) };
  }
  async function mouse(kind, x, y, modifiers = []) {
    const point = await js((x, y) => {
      const canvas = document.querySelector('#imageEditorOverlayCanvas');
      const bounds = canvas.getBoundingClientRect();
      return { x: Math.round(bounds.left + x / canvas.width * bounds.width), y: Math.round(bounds.top + y / canvas.height * bounds.height) };
    }, x, y);
    window.webContents.sendInputEvent({ type: kind, ...point, button: 'left', clickCount: 1, modifiers });
    await pause(20);
  }
  async function stroke(points, modifiers = []) {
    await mouse('mouseMove', ...points[0], modifiers);
    await mouse('mouseDown', ...points[0], modifiers);
    for (const point of points.slice(1)) await mouse('mouseMove', ...point, modifiers);
    await mouse('mouseUp', ...points.at(-1), modifiers);
    await js(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await pause(100);
  }
  const selectionOverlay = () => js(() => {
    const canvas = document.querySelector('#imageEditorOverlayCanvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0, pixels = 0;
    for (let at = 3; at < data.length; at += 4) { hash = (hash * 31 + data[at]) | 0; if (data[at]) pixels++; }
    return { hash, pixels };
  });
  const pixel = (x, y) => js(async (x, y) => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return Array.from(document.querySelector('#imageEditorCanvas').getContext('2d').getImageData(x, y, 1, 1).data);
  }, x, y);
  async function save(name) {
    const count = await js(() => window.__saves.length);
    await click('[data-action="save"]');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && await js(() => window.__saves.length) === count) await pause(30);
    const bytes = await js(index => window.__saves[index]?.bytes, count);
    assert(bytes?.length, `No PNG produced for ${name}`);
    const filename = path.join(options.directory, `${name}.png`);
    await fs.writeFile(filename, Buffer.from(bytes));
    return filename;
  }
  async function reopen(mode = 'edit') {
    await js(async mode => {
      window.__editor.close();
      const discard = document.querySelector('[data-action="discard"]');
      if (discard && discard.getClientRects().length) discard.click();
      await window.__editor.open(window.__asset, '/isolated-image-editor-library', mode);
    }, mode);
    await waitFor(() => !document.querySelector('[data-action="save"]').disabled, 'Editor did not load fixture');
    await pause(80);
  }
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => { networkAttempts++; done({ cancel: true }); });
    window = new BrowserWindow({ width: 1460, height: 950, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    window.setSkipTaskbar(true);
    window.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) errors.push(event.message); });
    await window.loadFile(options.html);
    await js(async fixture => {
      window.__saves = [];
      window.__psds = [];
      window.addEventListener('error', event => { window.__browserError = event.message; });
      window.__asset = { id: 'image-editor-fixture', name: '编辑器测试图', mediaType: 'image', width: 256, height: 192, ext: 'png', folderId: null };
      const api = {
        readImageForEditor: async () => ({ bytes: Uint8Array.from(atob(fixture), value => value.charCodeAt(0)), width: 256, height: 192 }),
        saveEditedImage: async request => { window.__saves.push({ ...request, bytes: Array.from(request.bytes) }); return { id: `saved-${window.__saves.length}`, snapshot: { root: '/isolated-image-editor-library', assets: [window.__asset], folders: [] }, duplicate: false }; },
        exportEditedImage: async request => { window.__exports = request; return { canceled: false, path: '/isolated-export.png' }; },
        exportEditedPsd: async request => { window.__psds.push(request); return { canceled: false, path: '/isolated-export.psd' }; }
      };
      window.__editor = window.ShituImageEditor.create({ api, assetUrl: () => '', onSaved: () => {} });
      await window.__editor.open(window.__asset, '/isolated-image-editor-library', 'edit');
    }, options.fixture);
    await waitFor(() => !document.querySelector('[data-action="save"]').disabled && document.querySelector('#imageEditorCanvas').width === 256, 'Editor did not become ready');
    assert((await js(() => document.querySelector('#imageEditorCanvas').width)) === 256, 'Editor changed source resolution');

    const layout = await js(() => {
      const bounds = selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const tools = [...document.querySelectorAll('.ie-toolrail [data-tool]')];
      return {
        rail: bounds('.ie-toolrail'), main: bounds('.ie-main'), sidebar: bounds('.ie-sidebar'), options: bounds('.ie-options'),
        tools: tools.map(node => ({ name: node.dataset.tool, icon: Boolean(node.querySelector('svg')), label: node.getAttribute('aria-label'), title: node.title, tooltip: node.dataset.tooltip })),
        active: tools.filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.dataset.tool)
      };
    });
    assert(layout.tools.length === 14 && layout.tools.every(tool => tool.icon && tool.label && tool.title && tool.tooltip), 'Every editor tool must have a real icon, accessible name and tooltip');
    assert(layout.active.length === 1 && layout.active[0] === 'brush', 'Tool rail must mark exactly the current tool as pressed');
    assert(layout.rail.width <= 104 && layout.rail.right <= layout.main.left + 1 && layout.main.right <= layout.sidebar.left + 1, 'Expected a narrow left tool rail, center canvas and right property panel');
    assert(layout.options.width > 0 && layout.options.height > 0, 'Current-tool options are not visible');
    await fs.writeFile(path.join(options.directory, 'edit-layout.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(900, 650);
    await pause(140);
    const compact = await js(() => {
      const stage = document.querySelector('#imageEditorStage').getBoundingClientRect();
      const save = document.querySelector('[data-action="save"]').getBoundingClientRect();
      return { stageWidth: stage.width, stageHeight: stage.height, saveRight: save.right, saveBottom: save.bottom, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert(compact.stageWidth >= 200 && compact.stageHeight >= 160 && compact.saveRight <= compact.width && compact.saveBottom <= compact.height && !compact.overflow, `Compact editor clips its canvas or save action: ${JSON.stringify(compact)}`);
    await fs.writeFile(path.join(options.directory, 'edit-compact.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(1460, 950);
    await pause(140);
    checks.push('accessible icon toolbar, left/canvas/right layout and compact 900 x 650 workspace');

    for (const [keyCode, modifiers, expected] of [['I', [], 'eyedropper'], ['H', [], 'hand'], ['Z', [], 'zoom'], ['M', [], 'rect'], ['M', ['shift'], 'ellipse'], ['B', [], 'brush'], ['E', [], 'eraser'], ['S', [], 'clone'], ['P', [], 'pen'], ['L', [], 'lasso'], ['C', [], 'crop'], ['T', [], 'text'], ['U', [], 'shape'], ['V', [], 'move']]) {
      await key(keyCode, modifiers);
      const active = await js(() => document.querySelector('.ie-toolrail [aria-pressed="true"]')?.dataset.tool);
      assert(active === expected, `${modifiers.join('+')}+${keyCode} selected ${active}, expected ${expected}`);
    }
    checks.push('all fourteen tools switch through their keyboard shortcuts, including marquee cycling, crop, text and shapes');

    await key('I');
    const sampled = await js(() => {
      const canvas = document.querySelector('#imageEditorOverlayCanvas'), bounds = canvas.getBoundingClientRect();
      const screenX = Math.round(bounds.left + 180.5 / canvas.width * bounds.width);
      const screenY = Math.round(bounds.top + 120.5 / canvas.height * bounds.height);
      const x = Math.floor((screenX - bounds.left) * canvas.width / bounds.width);
      const y = Math.floor((screenY - bounds.top) * canvas.height / bounds.height);
      return Array.from(document.querySelector('#imageEditorCanvas').getContext('2d').getImageData(x, y, 1, 1).data);
    });
    await stroke([[180.5, 120.5]]);
    const expectedColor = '#' + sampled.slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('');
    const pickedColor = await js(() => document.querySelector('[data-param="color"]').value);
    assert(pickedColor === expectedColor, `Eyedropper did not update foreground color from source pixels: ${pickedColor}, expected ${expectedColor}`);
    await key('B');
    await parameter('size', 24); await parameter('opacity', 100); await parameter('hardness', 100);
    await stroke([[55, 120]]);
    const sampledPaint = await pixel(55, 120);
    assert(sampled.every((channel, index) => Math.abs(channel - sampledPaint[index]) <= 1), 'Brush did not paint the picked foreground color');
    await click('[data-action="undo"]');
    checks.push('eyedropper samples source RGB and the brush paints with that foreground color');

    await click('[data-action="zoom-actual"]');
    const actualWidth = await js(() => document.querySelector('#imageEditorOverlayCanvas').getBoundingClientRect().width);
    assert(Math.abs(actualWidth - 256) <= 1, `Actual-size zoom is not 100%: ${actualWidth}`);
    await click('[data-action="zoom-in"]');
    const largerWidth = await js(() => document.querySelector('#imageEditorOverlayCanvas').getBoundingClientRect().width);
    assert(largerWidth > actualWidth, 'Zoom-in button did not increase canvas display size');
    await click('[data-action="zoom-out"]');
    assert(Math.abs(await js(() => document.querySelector('#imageEditorOverlayCanvas').getBoundingClientRect().width) - actualWidth) <= 1, 'Zoom-out button did not restore display size');
    await key('Z'); await stroke([[100, 80]]);
    assert(await js(() => document.querySelector('#imageEditorOverlayCanvas').getBoundingClientRect().width) > actualWidth, 'Zoom tool click did not zoom in');
    await stroke([[100, 80]], ['alt']);
    assert(Math.abs(await js(() => document.querySelector('#imageEditorOverlayCanvas').getBoundingClientRect().width) - actualWidth) <= 1, 'Alt-click zoom did not zoom out');
    await key('0', ['control']);
    assert(await js(() => document.querySelector('[data-view="zoom"]').value) === 'fit', 'Ctrl+0 did not fit the image');
    await key('1', ['control']);
    assert(await js(() => document.querySelector('[data-view="zoom"]').value) === '1', 'Ctrl+1 did not use actual size');
    checks.push('zoom buttons, canvas click / Alt-click, fit and actual-size shortcuts');

    await zoom(8);
    const imageHash = () => js(() => {
      const canvas = document.querySelector('#imageEditorCanvas');
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.reduce((hash, value) => (hash * 31 + value) | 0, 0);
    });
    const beforePan = await imageHash();
    await key('H');
    const pan = await dragStage();
    assert(pan.after > pan.before + 20, `Hand tool did not pan the zoomed canvas: ${JSON.stringify(pan)}`);
    await key('B');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    const temporaryPan = await dragStage();
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await pause(80);
    assert(temporaryPan.after > temporaryPan.before + 20, 'Holding Space did not temporarily pan the canvas');
    assert(await js(() => document.querySelector('.ie-toolrail [aria-pressed="true"]')?.dataset.tool) === 'brush', 'Releasing Space did not restore the brush');
    assert(await imageHash() === beforePan, 'Pan or temporary hand interaction modified image pixels');
    checks.push('hand and temporary Space panning preserve image pixels and restore the active tool');

    await js(() => document.querySelector('[data-view="original"]').focus());
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await pause(80);
    assert(await js(() => document.querySelector('[data-view="original"]').checked), 'Space did not activate the focused original-reference checkbox');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await pause(80);
    assert(!(await js(() => document.querySelector('[data-view="original"]').checked)), 'Space did not restore the focused original-reference checkbox');
    await js(() => document.querySelector('[data-tool="eraser"]').focus());
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await pause(80);
    assert(await js(() => document.querySelector('[data-tool="eraser"]').getAttribute('aria-pressed')) === 'true', 'Space did not activate the focused eraser button');
    checks.push('Space keeps native checkbox toggles and tool-button keyboard activation');
    await reopen();

    await key('M'); await key('M', ['shift']);
    await key('M');
    assert(await js(() => document.querySelector('[data-tool="ellipse"]').getAttribute('aria-pressed')) === 'true', 'M did not retain the current marquee tool');
    await key('M', ['shift']);
    assert(await js(() => document.querySelector('[data-tool="rect"]').getAttribute('aria-pressed')) === 'true', 'Shift+M did not cycle back to the rectangular marquee');
    await stroke([[20, 20], [70, 70]]);
    const shortcutSelection = await selectionOverlay();
    await key('D', ['control']);
    assert((await selectionOverlay()).pixels === 0, 'Ctrl+D did not deselect');
    await key('D', ['control', 'shift']);
    assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(shortcutSelection), 'Ctrl+Shift+D did not restore the last selection');
    await key('I', ['control', 'shift']);
    assert((await selectionOverlay()).pixels > shortcutSelection.pixels * 2, 'Ctrl+Shift+I did not invert the selected area');
    await key('Z', ['control']);
    assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(shortcutSelection), 'Ctrl+Z did not undo selection inversion');
    await key('A', ['control']);
    assert((await selectionOverlay()).pixels > 256 * 192 * .9, 'Ctrl+A did not select the complete canvas');
    await key('D', ['control']);
    checks.push('marquee cycling and Photoshop selection shortcuts select, deselect, reselect and invert');

    await reopen();
    const copiedSource = await pixel(35, 35), baseLayerId = await activeLayerId();
    await key('M'); await stroke([[20, 20], [70, 70]]);
    await key('J', ['control']);
    assert(await layerCount() === 2 && await activeLayerId() !== baseLayerId, 'Ctrl+J did not copy the selection to a new layer');
    await key('D', ['control']);
    await layerAction(baseLayerId, 'visible');
    assertPixel(await pixel(35, 35), copiedSource, 'Layer via copy lost the selected pixels');
    assert((await pixel(110, 110))[3] === 0, 'Layer via copy included pixels outside the selection');
    await key('J', ['control']);
    assert(await layerCount() === 3, 'Ctrl+J without a selection did not duplicate the layer');
    await key('N', ['control', 'shift']);
    assert(await layerCount() === 4, 'Ctrl+Shift+N did not create a transparent layer');
    assert(await js(() => document.activeElement === document.querySelector('[data-layer-param="name"]')), 'New-layer shortcut did not focus its name');
    assertPixel(await pixel(35, 35), copiedSource, 'Creating a transparent layer changed visible image pixels');
    checks.push('Ctrl+J copies only selected pixels or duplicates a complete layer; Ctrl+Shift+N creates a transparent named layer');

    await reopen();
    const cutPixel = await pixel(35, 35), cutOutside = await pixel(110, 110);
    await key('M'); await stroke([[20, 20], [70, 70]]); await key('J', ['control', 'shift']);
    assert(await layerCount() === 2, 'Ctrl+Shift+J did not create a layer from the cut selection');
    const cutLayerId = await activeLayerId();
    await key('D', ['control']); await layerAction(cutLayerId, 'visible');
    assert((await pixel(35, 35))[3] === 0, 'Layer via cut left selected pixels on the original layer');
    assertPixel(await pixel(110, 110), cutOutside, 'Layer via cut removed pixels outside the selection');
    await layerAction(cutLayerId, 'visible');
    assertPixel(await pixel(35, 35), cutPixel, 'Layer via cut changed the visible selection pixels');
    checks.push('Ctrl+Shift+J cuts selected pixels to an independent layer while preserving the surrounding image');

    await reopen();
    const shortcutLowerId = await importLayer('快捷键下层.png', '#c86432');
    const shortcutUpperId = await importLayer('快捷键上层.png', '#3264c8');
    await key('[', ['control']);
    assertPixel(await pixel(128, 96), [200, 100, 50, 255], 'Ctrl+[ did not send the current layer backward');
    await key(']', ['control']);
    assertPixel(await pixel(128, 96), [50, 100, 200, 255], 'Ctrl+] did not bring the current layer forward');
    await key('[', ['control', 'shift']);
    assert(await js(id => [...document.querySelectorAll('.ie-layer-row')].at(-1)?.dataset.layerId === id, shortcutUpperId), 'Ctrl+Shift+[ did not send the layer to the back');
    await key(']', ['control', 'shift']);
    assert(await js(id => document.querySelector('.ie-layer-row')?.dataset.layerId === id, shortcutUpperId), 'Ctrl+Shift+] did not bring the layer to the front');
    await key('[', ['alt']);
    assert(await activeLayerId() === shortcutLowerId, 'Alt+[ did not select the next lower layer');
    await key(']', ['alt']);
    assert(await activeLayerId() === shortcutUpperId, 'Alt+] did not select the next higher layer');
    await key('V'); await key('Right'); await key('Right', ['shift']); await key('Down', ['shift']);
    const nudged = await js(() => ({ x: Number(document.querySelector('[data-layer-param="x"]').value), y: Number(document.querySelector('[data-layer-param="y"]').value) }));
    assert(nudged.x === 11 && nudged.y === 10, `Move-tool arrow shortcuts used incorrect distances: ${JSON.stringify(nudged)}`);
    assertPixel(await pixel(100, 90), [200, 100, 50, 255], 'Keyboard layer movement did not change its rendered position');
    await key('T', ['control']);
    assert(await js(() => document.querySelector('.ie-layer-details').open && document.activeElement === document.querySelector('[data-layer-param="scale"]')), 'Ctrl+T did not open and focus the layer transform controls');
    await pressKey('Escape');
    assert(!(await js(() => document.querySelector('#imageEditorOverlay').hidden)), 'Escape from a transform input closed the image editor');
    checks.push('layer ordering, layer selection, arrow-key movement and transform focus follow Photoshop shortcuts');

    await reopen();
    await key('B'); await key('5');
    assert(await js(() => Number(document.querySelector('[data-param="opacity"]').value)) === 50, 'A single number key did not change brush opacity by tens');
    await pause(700); await key('2'); await key('5');
    assert(await js(() => Number(document.querySelector('[data-param="opacity"]').value)) === 25, 'Fast numeric keys did not set exact brush opacity');
    assert(await js(() => Number(document.querySelector('[data-layer-param="opacity"]').value)) === 100, 'Brush opacity keys changed layer opacity');
    await key('V'); await key('4');
    assert(await js(() => Number(document.querySelector('[data-layer-param="opacity"]').value)) === 40, 'Number keys outside paint tools did not set layer opacity');
    assert(await js(() => Number(document.querySelector('[data-param="opacity"]').value)) === 25, 'Layer opacity keys changed brush opacity');
    await pause(700); await key('0');
    assert(await js(() => Number(document.querySelector('[data-layer-param="opacity"]').value)) === 100, 'Zero did not restore full layer opacity');
    await key('B'); await parameter('size', 20); await parameter('hardness', 50);
    await key(']');
    assert(await js(() => Number(document.querySelector('[data-param="size"]').value)) > 20, 'Right bracket did not enlarge the brush');
    await key('[');
    assert(await js(() => Number(document.querySelector('[data-param="size"]').value)) === 20, 'Left bracket did not restore the brush size');
    await key(']', ['shift']);
    assert(await js(() => Number(document.querySelector('[data-param="hardness"]').value)) === 75, 'Shift+] did not increase brush hardness');
    await key('[', ['shift']);
    assert(await js(() => Number(document.querySelector('[data-param="hardness"]').value)) === 50, 'Shift+[ did not decrease brush hardness');
    checks.push('number keys target brush or layer opacity and bracket shortcuts adjust brush size and hardness');

    await reopen();
    await key('D');
    assert(await js(() => document.querySelector('[data-param="color"]').value === '#000000' && document.querySelector('[data-background-color]').value === '#ffffff'), 'D did not restore black foreground and white background');
    await key('X');
    assert(await js(() => document.querySelector('[data-param="color"]').value === '#ffffff' && document.querySelector('[data-background-color]').value === '#000000'), 'X did not swap foreground and background colors');
    await key('Backspace', ['alt']);
    assertPixel(await pixel(100, 100), [255, 255, 255, 255], 'Alt+Backspace did not fill with foreground color');
    await key('Backspace', ['control']);
    assertPixel(await pixel(100, 100), [0, 0, 0, 255], 'Ctrl+Backspace did not fill with background color');
    await key('Z', ['control']);
    assertPixel(await pixel(100, 100), [255, 255, 255, 255], 'Ctrl+Z did not undo the fill');
    await key('Z', ['control', 'shift']);
    assertPixel(await pixel(100, 100), [0, 0, 0, 255], 'Ctrl+Shift+Z did not redo the fill');
    await key('Z', ['control', 'alt']);
    assertPixel(await pixel(100, 100), [255, 255, 255, 255], 'Ctrl+Alt+Z did not step backward');
    const shortcutSaveCount = await js(() => window.__saves.length);
    await key('S', ['control']);
    await waitFor(() => window.__saves.length > 0 && !document.querySelector('[data-action="save"]').disabled, 'Ctrl+S did not complete image saving');
    assert(await js(() => window.__saves.length) === shortcutSaveCount + 1, 'Ctrl+S did not save exactly one copy');
    await js(() => { window.__exports = null; });
    await key('S', ['control', 'shift']);
    await waitFor(() => Boolean(window.__exports?.bytes?.length) && !document.querySelector('[data-action="export"]').disabled, 'Ctrl+Shift+S did not export the PNG');
    checks.push('foreground/background color shortcuts fill pixels and undo/redo/save/export operate through real editor actions');

    await reopen();
    await key('V'); await key('N', ['control', 'shift']);
    const inputLayerCount = await layerCount();
    await js(() => {
      const input = document.querySelector('[data-layer-param="name"]');
      input.value = 'Layer'; input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus(); input.setSelectionRange(input.value.length, input.value.length);
      window.__typingKey = null;
      input.addEventListener('keydown', event => { window.__typingKey = { prevented: event.defaultPrevented, focused: document.activeElement === input }; }, { once: true });
    });
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: 'b' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
    await pause(80);
    assert(await js(() => document.querySelector('[data-layer-param="name"]').value.toLowerCase() === 'layerb'), 'Text input did not receive ordinary typing');
    assert(await js(() => window.__typingKey?.focused && window.__typingKey.prevented === false), 'Canvas shortcuts prevented native text-key handling or stole input focus');
    assert(await js(() => document.querySelector('[data-tool="move"]').getAttribute('aria-pressed')) === 'true', 'Typing B in a layer name switched canvas tools');
    await pressKey('J', ['control']);
    assert(await layerCount() === inputLayerCount, 'Ctrl+J in a text input duplicated a canvas layer');
    await pressKey('Escape');
    assert(!(await js(() => document.querySelector('#imageEditorOverlay').hidden)), 'Escape while editing a name closed the editor');
    await js(() => {
      const input = document.querySelector('[data-layer-param="x"]');
      document.querySelector('.ie-layer-details').open = true; input.focus();
    });
    await pressKey('Right', ['shift']);
    assert(await js(() => Number(document.querySelector('[data-layer-param="x"]').value)) === 0, 'A numeric input arrow moved the canvas layer');
    await js(() => {
      const editable = document.createElement('div'); editable.id = 'shortcutEditable'; editable.contentEditable = 'true'; editable.tabIndex = 0;
      document.querySelector('#imageEditorOverlay').append(editable); editable.focus();
    });
    await pressKey('B');
    assert(await js(() => document.querySelector('[data-tool="move"]').getAttribute('aria-pressed')) === 'true', 'Contenteditable typing switched canvas tools');
    await js(() => document.querySelector('#shortcutEditable').remove());
    await js(() => {
      const canvas = document.querySelector('#imageEditorOverlayCanvas'); canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true, cancelable: true, isComposing: true }));
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true, cancelable: true, keyCode: 229 }));
    });
    assert(await js(() => document.querySelector('[data-tool="move"]').getAttribute('aria-pressed')) === 'true', 'IME composition events switched canvas tools');
    checks.push('text, numeric and contenteditable inputs retain native keys and IME events never trigger canvas shortcuts');

    await key('F7');
    assert(await js(() => document.querySelector('#imageEditorOverlay').classList.contains('ie-layers-hidden')), 'F7 did not hide the layer panel');
    await key('F7');
    assert(!(await js(() => document.querySelector('#imageEditorOverlay').classList.contains('ie-layers-hidden'))), 'F7 did not restore the layer panel');
    await key('Tab');
    assert(await js(() => document.querySelector('#imageEditorOverlay').classList.contains('ie-panels-hidden')), 'Tab from the canvas did not hide editor panels');
    await key('Tab');
    assert(!(await js(() => document.querySelector('#imageEditorOverlay').classList.contains('ie-panels-hidden'))), 'Tab from the canvas did not restore editor panels');
    await key('K', ['control', 'alt', 'shift']);
    assert(!(await js(() => document.querySelector('.ie-shortcuts').hidden)), 'Shortcut reference did not open from Ctrl+Alt+Shift+K');
    await fs.writeFile(path.join(options.directory, 'shortcuts-help.png'), (await window.webContents.capturePage()).toPNG());
    await pressKey('Escape');
    assert(await js(() => document.querySelector('.ie-shortcuts').hidden && !document.querySelector('#imageEditorOverlay').hidden), 'Escape did not close only the shortcut reference');
    checks.push('panel visibility shortcuts and the keyboard reference are reversible without closing the editor');
    await reopen();

    const originalCenter = await pixel(70, 60);
    await parameter('size', 28);
    await parameter('opacity', 100);
    await parameter('hardness', 100);
    await parameter('color', '#ff0000');
    await click('[data-tool="brush"]');
    await stroke([[60, 60], [70, 60], [80, 60]]);
    const redCenter = await pixel(70, 60);
    assert(redCenter[0] > 245 && redCenter[1] < 10 && redCenter[2] < 10, `Brush did not paint the selected color: ${JSON.stringify(redCenter)}`);
    await click('[data-action="undo"]');
    assert(JSON.stringify(await pixel(70, 60)) === JSON.stringify(originalCenter), 'Undo did not restore image pixels');
    await click('[data-action="redo"]');
    assert((await pixel(70, 60))[0] > 245, 'Redo did not restore brush stroke');
    checks.push('brush pixels, undo and redo');
    await save('brush');
    await click('[data-tool="eraser"]');
    await stroke([[70, 60]]);
    assert((await pixel(70, 60))[3] < 10, 'Eraser did not clear alpha');
    checks.push('eraser transparency');
    await save('eraser');

    await reopen();
    await parameter('feather', 0);
    await parameter('selectionMode', 'replace');
    await click('[data-tool="rect"]');
    await stroke([[20, 20], [55, 55]]);
    const outside = await pixel(85, 35);
    await parameter('size', 20);
    await parameter('opacity', 100);
    await parameter('hardness', 100);
    await parameter('color', '#ff0000');
    await click('[data-tool="brush"]');
    await stroke([[30, 35], [45, 35], [60, 35], [75, 35], [90, 35]]);
    assert((await pixel(35, 35))[0] > 245, 'Selection blocked paint inside its area');
    assert(JSON.stringify(await pixel(85, 35)) === JSON.stringify(outside), 'Painting escaped the rectangular selection');
    checks.push('selection constrains brush');
    await save('selection');

    await reopen();
    await parameter('feather', 0); await parameter('selectionMode', 'replace');
    await click('[data-tool="rect"]'); await stroke([[20, 20], [70, 70]]);
    const initialSelection = await selectionOverlay();
    assert(initialSelection.pixels > 100, 'Deselect checks require an existing selection');
    for (const selectionTool of ['rect', 'ellipse', 'lasso']) {
      await click(`[data-tool="${selectionTool}"]`);
      await stroke([[40, 40]]);
      assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(initialSelection), `${selectionTool} click inside the selection changed it`);
      for (const modifiers of [['shift'], ['alt']]) {
        await stroke([[180, 140]], modifiers);
        assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(initialSelection), `${selectionTool} modifier click discarded the selection`);
      }
      for (const mode of ['add', 'subtract']) {
        await parameter('selectionMode', mode); await stroke([[180, 140]]);
        assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(initialSelection), `${selectionTool} ${mode} mode click discarded the selection`);
      }
      await parameter('selectionMode', 'replace');
      await stroke([[180, 140]]);
      assert((await selectionOverlay()).pixels === 0, `${selectionTool} click outside did not remove the selection`);
      await click('[data-action="undo"]');
      assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(initialSelection), `${selectionTool} deselection did not support undo`);
    }
    checks.push('rectangle, ellipse and lasso outside clicks deselect with undo; inside and add/subtract clicks preserve the selection');

    await click('[data-tool="rect"]');
    await stroke([[100, 20], [145, 70]]);
    const replacementSelection = await selectionOverlay();
    assert(replacementSelection.pixels > 100 && replacementSelection.hash !== initialSelection.hash, 'Dragging did not replace the selection');
    await click('[data-action="undo"]');
    assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(initialSelection), 'Replacing a selection inserted an extra deselect undo step');
    const outsideScreen = await js(() => {
      const canvas = document.querySelector('#imageEditorOverlayCanvas').getBoundingClientRect();
      return { x: Math.round(canvas.left + canvas.width * .8), y: Math.round(canvas.top + canvas.height * .8) };
    });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...outsideScreen, button: 'right', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...outsideScreen, button: 'right', clickCount: 1 });
    await pause(80);
    assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(initialSelection), 'Right click discarded the selection');
    const blankScreen = await js(() => {
      const stage = document.querySelector('#imageEditorStage').getBoundingClientRect();
      const canvas = document.querySelector('#imageEditorOverlayCanvas').getBoundingClientRect();
      const point = { x: Math.round(stage.left + 8), y: Math.round(stage.top + 8) };
      if (point.x >= canvas.left && point.x <= canvas.right && point.y >= canvas.top && point.y <= canvas.bottom) throw new Error('Blank click fixture overlaps the image');
      return point;
    });
    window.webContents.sendInputEvent({ type: 'mouseMove', ...blankScreen });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...blankScreen, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...blankScreen, button: 'left', clickCount: 1 });
    await pause(100);
    assert((await selectionOverlay()).pixels === 0, 'Clicking empty stage outside the image did not deselect');
    await click('[data-action="undo"]');
    assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(initialSelection), 'Blank-stage deselection did not support undo');
    checks.push('selection replacement stays one undo step; right click preserves and blank-stage click cancels selection');

    await click('[data-tool="lasso"]');
    await stroke([[180, 140], [181, 140], [181, 141], [180, 141]]);
    assert((await selectionOverlay()).pixels === 0, 'Lasso click jitter left a selection');
    await parameter('size', 12); await parameter('hardness', 100); await parameter('color', '#ff0000');
    await click('[data-tool="brush"]'); await stroke([[180, 140]]);
    assertPixel(await pixel(180, 140), [255, 0, 0, 255], 'Lasso click jitter created an empty mask that blocks painting');
    await click('[data-action="undo"]'); await click('[data-action="undo"]');
    assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(initialSelection), 'Jitter deselection did not restore the old selection through undo');
    await parameter('feather', 6); await click('[data-tool="rect"]'); await stroke([[50, 50], [100, 100]]);
    const featheredClickSelection = await selectionOverlay();
    await stroke([[200, 150]]);
    assert((await selectionOverlay()).pixels === 0, 'Outside click did not cancel a feathered selection');
    await click('[data-action="undo"]');
    assert(JSON.stringify(await selectionOverlay()) === JSON.stringify(featheredClickSelection), 'Undo did not restore feathered selection exactly');
    checks.push('lasso click jitter cancels rather than making an empty mask; feathered deselection restores exactly');

    await reopen();
    await parameter('size', 24);
    await parameter('opacity', 100);
    await parameter('hardness', 100);
    await click('[data-tool="clone"]');
    const cloneSource = await pixel(180, 120);
    await stroke([[180, 120]], ['alt']);
    await stroke([[55, 120]]);
    const cloneDestination = await pixel(55, 120);
    assert(cloneSource.every((channel, index) => Math.abs(channel - cloneDestination[index]) <= 2), 'Clone stamp did not copy its sampled source');
    checks.push('Alt-click clone sample and stamp');
    await save('clone');

    await reopen();
    await click('[data-tool="rect"]');
    await stroke([[20, 20], [80, 80]]);
    await stroke([[110, 20], [160, 80]], ['shift']);
    await click('[data-tool="ellipse"]');
    await stroke([[40, 35], [65, 65]], ['alt']);
    await click('[data-tool="lasso"]');
    await parameter('selectionMode', 'add');
    await stroke([[180, 20], [220, 20], [220, 70], [180, 70], [180, 20]]);
    await click('[data-action="clear-pixels"]');
    assert((await pixel(30, 30))[3] === 0, 'Rectangle selection was not retained');
    assert((await pixel(135, 45))[3] === 0, 'Shift-add did not add a second selection');
    assert((await pixel(50, 50))[3] === 255, 'Alt-subtract ellipse did not leave the selection hole');
    assert((await pixel(200, 45))[3] === 0, 'Freehand selection did not add its enclosed area');
    assert((await pixel(100, 45))[3] === 255, 'Compound selection affected outside pixels');
    checks.push('rectangle, ellipse and lasso with Shift-add and Alt-subtract');
    await save('compound-selection');

    await reopen();
    await parameter('feather', 6);
    await click('[data-tool="rect"]');
    await stroke([[55, 55], [105, 105]]);
    await click('[data-action="clear-pixels"]');
    const featherEdge = (await pixel(55, 80))[3];
    assert(featherEdge > 10 && featherEdge < 245, `Feather edge did not contain partial alpha: ${featherEdge}`);
    assert((await pixel(80, 80))[3] < 10 && (await pixel(20, 20))[3] === 255, 'Feather changed the wrong image area');
    checks.push('feathered selection creates a gradual alpha edge');
    await save('feather');

    await reopen();
    await parameter('color', '#ff0000');
    await parameter('opacity', 100);
    await click('[data-tool="pen"]');
    await stroke([[40, 130], [40, 90]]);
    await stroke([[180, 130], [180, 170]]);
    await stroke([[110, 45]]);
    await click('[data-action="pen-close"]');
    await click('[data-action="pen-fill"]');
    assert((await pixel(110, 75))[0] > 245 && (await pixel(110, 75))[1] < 10, 'Curved pen path was not filled');
    checks.push('pen path supports dragged Bézier handles, closing and fill');
    await save('pen');

    await reopen();
    await js(async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const context = canvas.getContext('2d'); context.fillStyle = '#000'; context.fillRect(0, 0, 8, 16);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const files = new DataTransfer(); files.items.add(new File([png], 'half-tip.png', { type: 'image/png' }));
      const input = document.querySelector('#imageEditorBrushFile'); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => document.querySelector('[data-param="preset"]').value === 'custom', 'Custom brush was not loaded');
    await parameter('size', 32);
    await parameter('hardness', 100);
    await parameter('color', '#ff0000');
    const customOutside = await pixel(130, 80);
    await stroke([[120, 80]]);
    assert((await pixel(109, 80))[0] > 245 && (await pixel(109, 80))[1] < 10, 'Custom brush opaque half did not paint');
    assert(JSON.stringify(await pixel(130, 80)) === JSON.stringify(customOutside), 'Custom brush ignored transparent pixels');
    checks.push('custom PNG brush preserves its transparent pattern');
    await save('custom-brush');

    await reopen();
    await parameter('color', '#ff0000');
    await parameter('hardness', 100);
    await parameter('size', 22);
    await stroke([[80, 80]]);
    await click('[data-tool="rect"]');
    await stroke([[62, 62], [98, 98]]);
    const fillOutside = await pixel(20, 20);
    await click('[data-action="content-aware-fill"]');
    await waitFor(() => !document.querySelector('[data-action="save"]').disabled && document.querySelector('#imageEditorStatus').textContent.includes('智能填充完成'), 'Content-aware fill did not complete', 20000);
    assert((await pixel(80, 80))[0] < 230, 'Content-aware fill did not replace the selected red object');
    assert(JSON.stringify(await pixel(20, 20)) === JSON.stringify(fillOutside), 'Content-aware fill changed outside its selection');
    await save('smart-fill');
    await click('[data-action="undo"]');
    assert((await pixel(80, 80))[0] > 245 && (await pixel(80, 80))[1] < 10, 'Content-aware fill did not support undo');
    checks.push('content-aware fill replaces a selected object, preserves outside and supports undo');

    await reopen();
    assert(await layerCount() === 1, 'Opening an image should create one source layer');
    const baseCenter = await pixel(128, 96), baseOutside = await pixel(20, 20);
    const overlayId = await importLayer('叠加色块.png', '#c86432');
    const overlayColor = [200, 100, 50, 255];
    assertPixel(await pixel(128, 96), overlayColor, 'Imported PNG did not composite above the source');
    assertPixel(await pixel(20, 20), baseOutside, 'Transparent imported pixels covered the source');
    await layerParameter('opacity', 50);
    assertPixel(await pixel(128, 96), baseCenter.map((value, channel) => channel === 3 ? 255 : (value + overlayColor[channel]) / 2), 'Layer opacity did not blend with the source');
    await layerParameter('opacity', 100);
    for (const blend of ['multiply', 'screen', 'overlay']) {
      await layerParameter('blend', blend);
      const expected = baseCenter.map((backdrop, channel) => {
        if (channel === 3) return 255;
        const source = overlayColor[channel];
        if (blend === 'multiply') return backdrop * source / 255;
        if (blend === 'screen') return 255 - (255 - backdrop) * (255 - source) / 255;
        return backdrop <= 127.5 ? 2 * backdrop * source / 255 : 255 - 2 * (255 - backdrop) * (255 - source) / 255;
      });
      assertPixel(await pixel(128, 96), expected, `${blend} produced incorrect composite pixels`);
    }
    await layerParameter('blend', 'source-over');
    checks.push('transparent PNG import, independent layer opacity and multiply/screen/overlay pixel formulas');

    await layerAction(overlayId, 'visible');
    assertPixel(await pixel(128, 96), baseCenter, 'Hiding the layer did not reveal the source');
    await parameter('color', '#000000'); await parameter('size', 12); await parameter('hardness', 100);
    await key('B'); await stroke([[128, 96]]);
    await layerAction(overlayId, 'visible');
    assertPixel(await pixel(128, 96), overlayColor, 'Painting modified a hidden layer');
    await layerAction(overlayId, 'locked');
    await stroke([[128, 96]]);
    assertPixel(await pixel(128, 96), overlayColor, 'Painting modified a locked layer');
    const lockControls = await js(() => ({
      blend: document.querySelector('[data-layer-param="blend"]').disabled,
      opacity: document.querySelector('[data-layer-param="opacity"]').disabled,
      name: document.querySelector('[data-layer-param="name"]').disabled
    }));
    assert(lockControls.blend && lockControls.opacity && !lockControls.name, 'A locked layer must prevent blend/opacity edits while allowing its name to change');
    await click('[data-mode="maps"]');
    assert(await js(() => document.querySelector('[data-action="apply-map"]').disabled), 'Apply-map remained enabled with a locked layer');
    await js(() => document.querySelector('[data-action="apply-map"]').click());
    assert(await layerCount() === 2, 'Applying a map flattened locked layers');
    await click('[data-mode="edit"]');
    await layerAction(overlayId, 'locked');
    await stroke([[128, 96]]);
    assertPixel(await pixel(128, 96), [0, 0, 0, 255], 'Brush did not modify the active layer');
    await click('[data-action="undo"]');
    assertPixel(await pixel(128, 96), overlayColor, 'Undo did not restore active layer pixels');
    await click('[data-action="redo"]');
    assertPixel(await pixel(128, 96), [0, 0, 0, 255], 'Redo did not restore active layer painting');
    await layerAction(overlayId, 'visible');
    assertPixel(await pixel(128, 96), baseCenter, 'Painting one layer changed the underlying source layer');
    await layerAction(overlayId, 'visible');
    checks.push('hidden and locked layers reject paint; brush, undo and redo affect only the active layer');
    checks.push('layer locks protect compositing controls and prevent destructive map application');

    await reopen();
    const movingId = await importLayer('可移动色块.png', '#c86432');
    await layerParameter('x', 30); await layerParameter('y', -20);
    await layerParameter('scale', 50); await layerParameter('rotation', 90);
    assertPixel(await pixel(158, 76), overlayColor, 'Layer transform did not place its center correctly');
    assertPixel(await pixel(128, 96), baseCenter, 'Transform left pixels at the old layer location');
    await key('V'); await stroke([[158, 76], [168, 86]]);
    const moved = await js(() => ({ x: Number(document.querySelector('[data-layer-param="x"]').value), y: Number(document.querySelector('[data-layer-param="y"]').value) }));
    assert(Math.abs(moved.x - 40) <= 1 && Math.abs(moved.y + 10) <= 1, `Move tool did not translate the active layer: ${JSON.stringify(moved)}`);
    await click('[data-action="undo"]');
    assert(await js(() => Number(document.querySelector('[data-layer-param="x"]').value)) === 30, 'Undo did not restore the layer transform');
    assert(await activeLayerId() === movingId, 'Transform undo changed the active layer');
    await key('B'); await parameter('color', '#000000'); await parameter('size', 8); await parameter('hardness', 100);
    await stroke([[158, 76]]);
    assertPixel(await pixel(158, 76), [0, 0, 0, 255], 'Brush did not paint the transformed layer at the pointer');
    await layerParameter('x', 0); await layerParameter('y', 0); await layerParameter('scale', 100); await layerParameter('rotation', 0);
    assertPixel(await pixel(128, 96), [0, 0, 0, 255], 'Painting was not mapped into the transformed layer coordinate system');
    checks.push('layer position, scale, rotation, V drag and transformed-layer paint coordinates');

    await reopen();
    const lowerId = await importLayer('下层.png', '#c86432');
    const upperId = await importLayer('上层.png', '#3264c8');
    const upperColor = [50, 100, 200, 255];
    assertPixel(await pixel(128, 96), upperColor, 'Last imported layer was not placed on top');
    await click('[data-action="layer-down"]');
    assertPixel(await pixel(128, 96), overlayColor, 'Moving layer down did not change stacking order');
    await click('[data-action="layer-up"]');
    assertPixel(await pixel(128, 96), upperColor, 'Moving layer up did not restore stacking order');
    await layerParameter('name', '<img src=x onerror="window.__layerNameInjected=true">');
    assert(!(await js(() => window.__layerNameInjected || document.querySelector('.ie-layer-title img'))), 'Layer name was interpreted as HTML');
    await layerParameter('name', '上层');
    await click('[data-action="layer-duplicate"]');
    assert(await layerCount() === 4 && await activeLayerId() !== upperId, 'Duplicate did not create and select a separate layer');
    await click('[data-action="layer-delete"]');
    assert(await layerCount() === 3, 'Delete did not remove the active layer');
    await click('[data-action="undo"]');
    assert(await layerCount() === 4, 'Undo did not restore the deleted layer');
    await click('[data-action="redo"]');
    assert(await layerCount() === 3, 'Redo did not remove the restored layer');
    await click(`[data-layer-select="${lowerId}"]`);
    assert(await activeLayerId() === lowerId, 'Clicking a layer row did not select that layer');
    await click(`[data-layer-select="${upperId}"]`);
    await fs.writeFile(path.join(options.directory, 'layers-layout.png'), (await window.webContents.capturePage()).toPNG());
    await click('[data-action="layer-flatten"]');
    assert(await layerCount() === 1, 'Flatten did not merge visible layers into one');
    assertPixel(await pixel(128, 96), upperColor, 'Flatten changed composite pixels');
    await click('[data-action="undo"]');
    assert(await layerCount() === 3, 'Undo did not restore the layer stack after flatten');
    await save('layers');
    assert(await layerCount() === 3, 'Saving a composite PNG discarded editable layers');
    checks.push('layer selection, stacking, rename safety, duplicate/delete/flatten undo and composite PNG export');

    await click('[data-action="layer-add"]');
    assert(await layerCount() === 4, 'New-layer action did not create a blank layer');
    assertPixel(await pixel(128, 96), upperColor, 'A new blank layer changed the image');
    await click('[data-action="layer-delete"]');
    for (let count = 3; count < 12; count++) await click('[data-action="layer-add"]');
    assert(await layerCount() === 12, 'New-layer actions did not reach the documented layer limit');
    assert(await js(() => document.querySelector('[data-action="layer-add"]').disabled && document.querySelector('[data-action="layer-duplicate"]').disabled), 'Layer creation controls did not honor the layer limit');
    await click('[data-action="undo"]');
    assert(await layerCount() === 11 && !(await js(() => document.querySelector('[data-action="layer-add"]').disabled)), 'Undo from the layer limit did not restore creation controls');
    checks.push('blank-layer creation preserves pixels and layer limit recovers after undo');

    await reopen();
    const baseDropPixel = await pixel(30, 30), basePastePixel = await pixel(175, 135), untouched = await pixel(10, 10);
    const droppedId = await transferLayer('drop', '#e04020', [20, 20, 32, 32]);
    assertPixel(await pixel(30, 30), [224, 64, 32, 255], 'Dropped PNG did not appear as a layer');
    assertPixel(await pixel(10, 10), untouched, 'Drop changed pixels outside the added image');
    const pastedId = await transferLayer('paste', '#2080e0', [160, 120, 40, 40]);
    assertPixel(await pixel(175, 135), [32, 128, 224, 255], 'Pasted PNG did not appear as a layer');
    assertPixel(await pixel(30, 30), [224, 64, 32, 255], 'Paste changed the earlier dropped layer');
    await layerAction(droppedId, 'visible');
    assertPixel(await pixel(30, 30), baseDropPixel, 'Drop modified the original source layer');
    await layerAction(pastedId, 'visible');
    assertPixel(await pixel(175, 135), basePastePixel, 'Paste modified the original source layer');
    await layerAction(droppedId, 'visible'); await layerAction(pastedId, 'visible');
    await fs.writeFile(path.join(options.directory, 'layers-imports.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('image drop and clipboard paste create independent layers without leaking events to the asset library');

    await reopen();
    const geometryHash = await imageHash(), geometryPixel = await pixel(40, 50);
    await click('[data-action="rotate-right"]');
    assert(JSON.stringify(await documentSize()) === JSON.stringify({ width: 192, height: 256 }), 'Clockwise rotation did not exchange image dimensions');
    assertPixel(await pixel(141, 40), geometryPixel, 'Clockwise rotation moved a source pixel to the wrong position');
    await key('Z', ['control']);
    assert(JSON.stringify(await documentSize()) === JSON.stringify({ width: 256, height: 192 }) && await imageHash() === geometryHash, 'Undo did not restore the original dimensions and pixels after rotation');
    await click('[data-action="flip-horizontal"]');
    assertPixel(await pixel(215, 50), geometryPixel, 'Horizontal flip did not mirror a source pixel');
    await key('Z', ['control']);
    assert(await imageHash() === geometryHash, 'Undo did not restore flipped pixels exactly');
    await editorOption('data-basic-param', 'lockRatio', false);
    await editorOption('data-basic-param', 'width', 128); await editorOption('data-basic-param', 'height', 80);
    await click('[data-action="resize-apply"]');
    assert(JSON.stringify(await documentSize()) === JSON.stringify({ width: 128, height: 80 }), 'Image-size controls did not resize the actual document');
    await save('resized');
    await key('Z', ['control']);
    assert(JSON.stringify(await documentSize()) === JSON.stringify({ width: 256, height: 192 }) && await imageHash() === geometryHash, 'Resize undo did not restore the original image');
    checks.push('rotate, horizontal flip and resize change document pixels and dimensions, support undo and export the resized PNG');

    await reopen();
    const selectionCropBounds = await dragBounds([20, 30], [80, 90]);
    const selectionCropPixel = await pixel(selectionCropBounds.left + 10, selectionCropBounds.top + 10);
    await key('M'); await stroke([[20, 30], [80, 90]]); await click('[data-action="crop-selection"]');
    assert(JSON.stringify(await documentSize()) === JSON.stringify({ width: selectionCropBounds.width, height: selectionCropBounds.height }), 'Crop-to-selection used incorrect image bounds');
    assertPixel(await pixel(10, 10), selectionCropPixel, 'Crop-to-selection did not retain the selected source pixels');
    await key('Z', ['control']);
    assert(JSON.stringify(await documentSize()) === JSON.stringify({ width: 256, height: 192 }) && await imageHash() === geometryHash, 'Crop-to-selection undo did not restore the original image');
    await key('D', ['control']); await key('C');
    const dragCropBounds = await dragBounds([30, 40], [130, 120]);
    const dragCropPixel = await pixel(dragCropBounds.left + 10, dragCropBounds.top + 10);
    await stroke([[30, 40], [130, 120]]);
    assert(!(await js(() => document.querySelector('[data-action="crop-apply"]').disabled)), 'Dragging with the crop tool did not create a crop region');
    await click('[data-action="crop-apply"]');
    assert(JSON.stringify(await documentSize()) === JSON.stringify({ width: dragCropBounds.width, height: dragCropBounds.height }), 'Crop tool did not apply its drawn bounds');
    assertPixel(await pixel(10, 10), dragCropPixel, 'Crop tool changed retained source pixels');
    await key('Z', ['control']);
    assert(JSON.stringify(await documentSize()) === JSON.stringify({ width: 256, height: 192 }) && await imageHash() === geometryHash, 'Crop tool undo did not restore the image');
    checks.push('selection crop and the C crop tool retain the correct source region and restore dimensions through undo');

    await reopen();
    const adjustmentPixel = await pixel(90, 70);
    await editorOption('data-adjust-param', 'brightness', 20); await click('[data-action="adjust-apply"]');
    const brighter = await pixel(90, 70);
    assert(brighter.slice(0, 3).every((channel, index) => channel > adjustmentPixel[index]) && brighter[3] === adjustmentPixel[3], 'Brightness did not raise RGB while preserving alpha');
    await key('Z', ['control']);
    await editorOption('data-adjust-param', 'contrast', 30); await click('[data-action="adjust-apply"]');
    const contrast = await pixel(90, 70);
    assert(contrast[0] < adjustmentPixel[0] && contrast[2] > adjustmentPixel[2], 'Contrast did not expand pixel values away from the midpoint');
    await key('Z', ['control']);
    await editorOption('data-adjust-param', 'saturation', -100); await click('[data-action="adjust-apply"]');
    const desaturated = await pixel(90, 70);
    assert(desaturated[0] === desaturated[1] && desaturated[1] === desaturated[2], 'Saturation controls did not remove color');
    await key('Z', ['control']);
    assertPixel(await pixel(90, 70), adjustmentPixel, 'Adjustment undo did not restore original RGB');
    const adjustmentBaseId = await activeLayerId();
    await importLayer('半透明调色.png', 'rgba(100,150,200,0.4)'); await layerAction(adjustmentBaseId, 'visible');
    const translucent = await pixel(128, 96);
    assert(translucent[3] > 0 && translucent[3] < 255, 'Transparency fixture is not translucent');
    await click('[data-action="grayscale"]');
    const grayscale = await pixel(128, 96);
    assert(grayscale[0] === grayscale[1] && grayscale[1] === grayscale[2] && grayscale[3] === translucent[3], 'Grayscale did not preserve layer transparency');
    await key('Z', ['control']); await click('[data-action="invert-image"]');
    assertPixel(await pixel(128, 96), translucent.map((channel, index) => index === 3 ? channel : 255 - channel), 'Image inversion did not invert RGB while preserving alpha', 3);
    checks.push('brightness, contrast, saturation, grayscale and inversion edit RGB independently of alpha and support undo');

    await reopen();
    await key('T'); await editorOption('data-text-param', 'text', 'Mosaic'); await editorOption('data-text-param', 'fontFamily', 'Arial'); await editorOption('data-text-param', 'fontSize', 24);
    await parameter('color', '#ffffff');
    const beforeText = await imageHash(); await stroke([[30, 40]]);
    assert(await layerCount() === 2 && await imageHash() !== beforeText, 'Text tool did not create visible text on an independent layer');
    const initialText = await imageHash();
    await editorOption('data-text-param', 'text', 'Edit'); await click('[data-action="text-update"]');
    assert(await layerCount() === 2 && await imageHash() !== initialText, 'Updating text created a duplicate layer or failed to redraw the text');
    await key('Z', ['control']);
    assert(await imageHash() === initialText, 'Text undo did not restore the previous content');
    await editorOption('data-text-param', 'text', 'Mosaic'); await editorOption('data-text-param', 'fontSize', 20);
    await click('[data-action="watermark"]');
    assert(await layerCount() === 3 && Number(await js(() => document.querySelector('[data-layer-param="opacity"]').value)) === 35, 'Watermark was not created as a translucent independent layer');
    assert(await imageHash() !== initialText, 'Watermark did not appear in the image');
    await fs.writeFile(path.join(options.directory, 'text-watermark.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('text placement, text updates, undo and a translucent watermark remain independent editable layers');

    await reopen();
    await key('U'); await parameter('color', '#ff0000'); await editorOption('data-shape-param', 'strokeWidth', 4);
    const shapeOutside = await pixel(20, 20);
    await editorOption('data-shape-param', 'type', 'rect'); await stroke([[30, 30], [70, 70]]);
    assert(await layerCount() === 2, 'Rectangle shape did not create its own layer');
    assertPixel(await pixel(50, 50), [255, 0, 0, 255], 'Rectangle shape did not fill its interior');
    assertPixel(await pixel(20, 20), shapeOutside, 'Rectangle shape changed pixels outside its bounds');
    await editorOption('data-shape-param', 'type', 'ellipse'); await stroke([[100, 40], [150, 90]]);
    assert(await layerCount() === 3, 'Ellipse shape did not create its own layer');
    assertPixel(await pixel(125, 65), [255, 0, 0, 255], 'Ellipse shape did not fill its center');
    const beforeLine = await pixel(195, 75);
    await editorOption('data-shape-param', 'type', 'line'); await stroke([[170, 50], [220, 100]]);
    assert(await layerCount() === 4, 'Line shape did not create its own layer');
    assertPixel(await pixel(195, 75), [255, 0, 0, 255], 'Line shape did not stroke the dragged path');
    await key('Z', ['control']);
    assert(await layerCount() === 3, 'Undo did not remove the last shape layer');
    assertPixel(await pixel(195, 75), beforeLine, 'Undo did not restore pixels under the shape');
    checks.push('rectangle, ellipse and line shapes produce independent visible layers and support undo');

    await reopen();
    const psdHiddenId = await importLayer('PSD隐藏层.png', '#c86432');
    await layerAction(psdHiddenId, 'visible');
    const psdUpperId = await importLayer('PSD叠加层.png', '#3264c8');
    await layerParameter('opacity', 45); await layerParameter('blend', 'multiply'); await layerParameter('x', 170); await layerParameter('scale', 50);
    const psdComposite = await pixel(128, 96);
    await click('[data-action="export-psd"]');
    await waitFor(() => window.__psds.length === 1 && !document.querySelector('[data-action="export-psd"]').disabled, 'PSD export did not reach the persistence API');
    const psd = await js(() => {
      const request = window.__psds[0];
      const sample = (image, x, y) => x < 0 || y < 0 || x >= image.width || y >= image.height ? null : Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
      return {
        width: request.width, height: request.height, assetId: request.assetId, hasPngBytes: Object.hasOwn(request, 'bytes'),
        imageBytes: request.imageData.data.byteLength, composite: sample(request.imageData, 128, 96),
        layers: request.layers.map(layer => ({ name: layer.name, visible: layer.visible, opacity: layer.opacity, blend: layer.blend, left: layer.left, top: layer.top, width: layer.imageData.width, height: layer.imageData.height, bytes: layer.imageData.data.byteLength, pixel: sample(layer.imageData, 298 - (layer.left || 0), 96 - (layer.top || 0)) }))
      };
    });
    assert(psd.width === 256 && psd.height === 192 && psd.assetId === 'image-editor-fixture' && !psd.hasPngBytes, 'PSD export reused a flattened PNG request instead of layer data');
    assert(psd.layers.length === 3 && psd.imageBytes === 256 * 192 * 4 && psd.layers.every(layer => layer.width > 0 && layer.height > 0 && layer.bytes === layer.width * layer.height * 4), 'PSD export omitted document dimensions or independent RGBA layers');
    assert(psd.layers.some(layer => layer.name === 'PSD隐藏层' && layer.visible === false), 'PSD export lost hidden layers');
    const psdUpper = psd.layers.find(layer => layer.name === 'PSD叠加层');
    assert(psdUpper?.opacity === 45 && psdUpper.blend === 'multiply' && psdUpper.visible, 'PSD export lost opacity or blend mode');
    assert(psdUpper.left > 128 && psdUpper.width === 128 && psdUpper.height === 96, 'PSD export cropped away or lost the transformed off-canvas layer bounds');
    assertPixel(psdUpper.pixel, [50, 100, 200, 255], 'PSD export did not rasterize the transformed layer independently of its opacity');
    assertPixel(psd.composite, psdComposite, 'PSD composite preview differs from the editor');
    assert(await layerCount() === 3 && await activeLayerId() === psdUpperId, 'PSD export discarded the editing layer stack');
    checks.push('PSD export passes independent RGBA layers, hidden state, opacity, blend modes and the matching composite to persistence');

    await reopen('maps');
    for (const type of ['displacement', 'normal', 'roughness', 'specular']) {
      await parameter('type', type);
      await save(type);
      checks.push(`${type} PNG export`);
    }
    await parameter('type', 'color');
    await parameter('seamless', true);
    await parameter('seamWidth', 0.2);
    await save('seamless');
    const tiled = await js(() => document.querySelector('[data-view="tiled"]'));
    if (tiled) await click('[data-view="tiled"]');
    await fs.writeFile(path.join(options.directory, 'editor.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('seamless generation and tiled preview');
    assert(networkAttempts === 0, 'Editor made unexpected network requests');
    assert(!(await js(() => window.__browserError)), `Browser error: ${await js(() => window.__browserError)}`);
    assert(errors.length === 0, `Browser console errors: ${errors.join('; ')}`);
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: true, checks, networkAttempts, errors }, null, 2));
    window.destroy();
    app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) await fs.writeFile(path.join(options.directory, 'failure.png'), (await window.webContents.capturePage()).toPNG()).catch(() => {});
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), checks, networkAttempts, errors }, null, 2));
    app.exit(1);
  }
}

async function main() {
  const tests = path.join(root, '.recovery', 'tests');
  await fs.mkdir(tests, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tests, 'image-editor-'));
  const raw = Buffer.alloc(256 * 192 * 4);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    raw[i] = x; raw[i + 1] = y; raw[i + 2] = (x + y) % 256; raw[i + 3] = 255;
  }
  const fixture = await sharp(raw, { raw: { width: 256, height: 192, channels: 4 } }).png().toBuffer();
  const { pathToFileURL } = require('node:url');
  const fileUrl = name => pathToFileURL(path.join(root, 'src', name)).href;
  const html = path.join(directory, 'index.html');
  await fs.writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${fileUrl('styles.css')}"><link rel="stylesheet" href="${fileUrl('image-editor.css')}"></head><body><script src="${fileUrl('texture-maps.js')}"></script><script src="${fileUrl('content-aware-fill.js')}"></script><script src="${fileUrl('image-layers.js')}"></script><script src="${fileUrl('image-basics.js')}"></script><script src="${fileUrl('image-editor.js')}"></script></body></html>`);
  const options = { directory, html, fixture: fixture.toString('base64') };
  await fs.writeFile(path.join(directory, 'main.cjs'), `'use strict';\nconst electron=require('electron');\nconst path=require('node:path');\nelectron.app.setName('Mosaic image editor isolated smoke');\nelectron.app.setPath('userData',path.join(__dirname,'profile'));\nelectron.app.setPath('sessionData',path.join(__dirname,'sessions'));\n(${electronTest.toString()})(electron,${JSON.stringify(options)});\nsetTimeout(()=>electron.app.exit(2),210000).unref();\n`);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'mosaic-image-editor-smoke', main: 'main.cjs' }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [directory], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Image editor smoke timed out: ${directory}`)); }, 220000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  result.reportDirectory = directory;
  if (exitCode === 0 && result.ok) {
    for (const name of ['brush', 'eraser', 'selection', 'clone', 'compound-selection', 'feather', 'pen', 'custom-brush', 'smart-fill', 'layers', 'resized', 'displacement', 'normal', 'roughness', 'specular', 'seamless']) {
      const { data, info } = await sharp(path.join(directory, `${name}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, name === 'resized' ? 128 : 256, `${name}: wrong export width`);
      assert.equal(info.height, name === 'resized' ? 80 : 192, `${name}: wrong export height`);
      if (name === 'layers') assert.deepEqual([...data.subarray((96 * info.width + 128) * 4, (96 * info.width + 128) * 4 + 4)], [50, 100, 200, 255], 'Exported PNG does not contain the top layer composite');
      if (name === 'normal') assert.ok(data.some((value, index) => index % 4 === 2 && value > 200), 'Normal map lacks blue normal vectors');
      if (['displacement', 'roughness', 'specular'].includes(name)) for (let i = 0; i < data.length; i += 4) assert.ok(data[i] === data[i + 1] && data[i] === data[i + 2], `${name}: expected grayscale pixels`);
      if (name === 'seamless') {
        for (let y = 0; y < info.height; y++) for (let c = 0; c < 4; c++) assert.equal(data[y * info.width * 4 + c], data[(y * info.width + info.width - 1) * 4 + c], 'Horizontal seamless edge mismatch');
        for (let x = 0; x < info.width; x++) for (let c = 0; c < 4; c++) assert.equal(data[x * 4 + c], data[((info.height - 1) * info.width + x) * 4 + c], 'Vertical seamless edge mismatch');
      }
    }
    result.checks.push('all PNG dimensions, grayscale/vector encoding and exact opposite edges');
  }
  const reports = path.join(root, '.recovery', 'reports');
  await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'image-editor-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (exitCode !== 0 || !result.ok) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
