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
      window.addEventListener('error', event => { window.__browserError = event.message; });
      window.__asset = { id: 'image-editor-fixture', name: '编辑器测试图', mediaType: 'image', width: 256, height: 192, ext: 'png', folderId: null };
      const api = {
        readImageForEditor: async () => ({ bytes: Uint8Array.from(atob(fixture), value => value.charCodeAt(0)), width: 256, height: 192 }),
        saveEditedImage: async request => { window.__saves.push({ ...request, bytes: Array.from(request.bytes) }); return { id: `saved-${window.__saves.length}`, snapshot: { root: '/isolated-image-editor-library', assets: [window.__asset], folders: [] }, duplicate: false }; },
        exportEditedImage: async request => { window.__exports = request; return { canceled: false, path: '/isolated-export.png' }; }
      };
      window.__editor = window.ShituImageEditor.create({ api, assetUrl: () => '', onSaved: () => {} });
      await window.__editor.open(window.__asset, '/isolated-image-editor-library', 'edit');
    }, options.fixture);
    await waitFor(() => !document.querySelector('[data-action="save"]').disabled && document.querySelector('#imageEditorCanvas').width === 256, 'Editor did not become ready');
    assert((await js(() => document.querySelector('#imageEditorCanvas').width)) === 256, 'Editor changed source resolution');
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
  await fs.writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${fileUrl('styles.css')}"><link rel="stylesheet" href="${fileUrl('image-editor.css')}"></head><body><script src="${fileUrl('texture-maps.js')}"></script><script src="${fileUrl('content-aware-fill.js')}"></script><script src="${fileUrl('image-editor.js')}"></script></body></html>`);
  const options = { directory, html, fixture: fixture.toString('base64') };
  await fs.writeFile(path.join(directory, 'main.cjs'), `'use strict';\nconst electron=require('electron');\nconst path=require('node:path');\nelectron.app.setName('Mosaic image editor isolated smoke');\nelectron.app.setPath('userData',path.join(__dirname,'profile'));\nelectron.app.setPath('sessionData',path.join(__dirname,'sessions'));\n(${electronTest.toString()})(electron,${JSON.stringify(options)});\nsetTimeout(()=>electron.app.exit(2),90000).unref();\n`);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'mosaic-image-editor-smoke', main: 'main.cjs' }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [directory], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Image editor smoke timed out: ${directory}`)); }, 100000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  result.reportDirectory = directory;
  if (exitCode === 0 && result.ok) {
    for (const name of ['brush', 'eraser', 'selection', 'clone', 'compound-selection', 'feather', 'pen', 'custom-brush', 'smart-fill', 'displacement', 'normal', 'roughness', 'specular', 'seamless']) {
      const { data, info } = await sharp(path.join(directory, `${name}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 256, `${name}: wrong export width`);
      assert.equal(info.height, 192, `${name}: wrong export height`);
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
