'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { createFontExportService } = require('../src/font-export-service.cjs');
const fixturesRoot = path.resolve(__dirname, '..', '.recovery', 'tests');

async function setup(t, overrides = {}) {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(fixturesRoot, 'font-export-'));
  t.after(async () => {
    const relative = path.relative(fixturesRoot, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  const source = path.join(base, 'font.ttf'); await fs.writeFile(source, 'font-source');
  const asset = { id: 'font-id', name: '测试字体', ext: 'ttf', hash: 'source-hash' };
  const library = { root: path.join(base, 'library'), snapshot: () => ({ assets: [asset] }), getAssetPath: () => source };
  const destination = path.join(base, 'layout.png'), windows = [], dialogs = [], prepared = [];
  let selectedLibrary = library;
  const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#00000000' } }).png().toBuffer();
  class MockWindow {
    constructor(options) {
      this.options = options; this.destroyed = false; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.webContents.executeJavaScript = async script => {
        this.payload = JSON.parse(script.slice('window.renderFontExport('.length, -1));
        return overrides.execute ? overrides.execute(this) : { dataUrl: `data:image/png;base64,${image.toString('base64')}`, width: 64, height: 64, overflow: false };
      };
      windows.push(this);
    }
    loadFile(filename) { this.loadedFile = filename; return overrides.load ? overrides.load(this) : Promise.resolve(); }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }
  const service = createFontExportService({
    BrowserWindow: MockWindow, getLibrary: () => selectedLibrary,
    dialog: { showSaveDialog: async (...args) => { dialogs.push(args); return overrides.dialog ? overrides.dialog(...args) : { canceled: false, filePath: destination }; } },
    prepareFont: async (...args) => { prepared.push(args); return overrides.prepare ? overrides.prepare(...args) : { url: 'shitu://font/00000000-0000-0000-0000-000000000000/preview.ttf', faceIndex: args[3] }; },
    renderTimeoutMs: overrides.timeout || 5000
  });
  t.after(() => service.shutdown());
  return { base, source, asset, library, destination, image, service, windows, dialogs, prepared, setLibrary: value => { selectedLibrary = value; } };
}
const options = { text: '测试 Aa\n第二行', faceIndex: 1, settings: { width: 64, height: 64, fontSize: 12, paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4, transparent: true } };

test('exports a validated PNG through a sandboxed renderer and native save dialog', async t => {
  const f = await setup(t);
  const result = await f.service.exportImage(f.asset.id, f.library.root, options);
  assert.deepEqual(result, { canceled: false, filePath: f.destination, width: 64, height: 64, overflow: false });
  assert.deepEqual(await fs.readFile(f.destination), f.image);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'font-source');
  assert.deepEqual(f.prepared[0], [f.library, f.asset.id, f.library.root, 1]);
  assert.equal(f.windows[0].options.show, false);
  assert.deepEqual(f.windows[0].options.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false });
  assert.equal(f.windows[0].payload.settings.transparent, true);
  assert.equal(f.windows[0].payload.text, options.text);
  assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.service.busy(), false);
  assert.deepEqual(f.windows[0].openHandler(), { action: 'deny' });
  assert.equal(f.dialogs[0][0].defaultPath, '测试字体-排版.png');
  assert.deepEqual(await fs.readdir(f.base), ['font.ttf', 'layout.png']);
});

test('canceling the save dialog creates no output and cleans the render window', async t => {
  const f = await setup(t, { dialog: () => ({ canceled: true }) });
  assert.deepEqual(await f.service.exportImage(f.asset.id, f.library.root, options), { canceled: true });
  assert.equal(f.windows[0].destroyed, true);
  assert.deepEqual(await fs.readdir(f.base), ['font.ttf']);
});

test('rejects stale libraries, non-font assets, invalid text and invalid face indexes before rendering', async t => {
  const f = await setup(t);
  await assert.rejects(f.service.exportImage(f.asset.id, 'other', options), /素材库已切换/);
  await assert.rejects(f.service.exportImage('missing', f.library.root, options), /有效的字体/);
  f.asset.ext = 'png'; await assert.rejects(f.service.exportImage(f.asset.id, f.library.root, options), /有效的字体/); f.asset.ext = 'ttf';
  for (const invalid of [null, { text: 123 }, { text: 'a'.repeat(2001) }, { text: 'a', settings: [] }, { text: 'a', faceIndex: -1 }, { text: 'a', faceIndex: 128 }, { text: 'a', faceIndex: 0.5 }, { text: '  \n ' }]) {
    await assert.rejects(f.service.exportImage(f.asset.id, f.library.root, invalid));
  }
  assert.equal(f.windows.length, 0); assert.equal(f.dialogs.length, 0);
});

test('rejects invalid PNG data and mismatched render size without showing save dialog', async t => {
  for (const invalid of [
    { dataUrl: 'data:image/png;base64,bm90LXBuZw==', width: 64, height: 64 },
    { dataUrl: 'data:image/jpeg;base64,AAAA', width: 64, height: 64 },
    { dataUrl: 'data:image/png;base64,%%%', width: 64, height: 64 },
    { dataUrl: 'data:image/png;base64,AAAA', width: 65, height: 64 }
  ]) {
    const f = await setup(t, { execute: () => invalid });
    await assert.rejects(f.service.exportImage(f.asset.id, f.library.root, options), /无效|有效的 PNG/);
    assert.equal(f.windows[0].destroyed, true); assert.equal(f.dialogs.length, 0);
  }
});

test('a library or font change while choosing a destination prevents a stale file write', async t => {
  let f;
  f = await setup(t, { dialog: () => { f.asset.hash = 'changed'; return { canceled: false, filePath: f.destination }; } });
  await assert.rejects(f.service.exportImage(f.asset.id, f.library.root, options), /字体已变化/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('only a PNG destination is accepted, and a missing extension is supplied', async t => {
  let f;
  f = await setup(t, { dialog: () => ({ canceled: false, filePath: f.source }) });
  await assert.rejects(f.service.exportImage(f.asset.id, f.library.root, options), /\.png/);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'font-source');
  let g;
  g = await setup(t, { dialog: () => ({ canceled: false, filePath: path.join(g.base, 'output') }) });
  const result = await g.service.exportImage(g.asset.id, g.library.root, options);
  assert.equal(result.filePath, path.join(g.base, 'output.png'));
});

test('shutdown aborts an in-progress export and rejects concurrent requests', async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { execute: () => { entered(); return new Promise(() => {}); } });
  const pending = f.service.exportImage(f.asset.id, f.library.root, options);
  await ready;
  await assert.rejects(f.service.exportImage(f.asset.id, f.library.root, options), /正在导出/);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await f.service.shutdown(); await rejected;
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.dialogs.length, 0); assert.equal(f.service.busy(), false);
  await assert.rejects(f.service.exportImage(f.asset.id, f.library.root, options), { name: 'AbortError' });
});

test('shutdown also aborts a pending native save dialog', async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { dialog: () => { entered(); return new Promise(() => {}); } });
  const pending = f.service.exportImage(f.asset.id, f.library.root, options);
  await ready;
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await f.service.shutdown(); await rejected;
  assert.equal(f.service.busy(), false); await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});
