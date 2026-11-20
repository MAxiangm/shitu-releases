'use strict';

// Launch the production index, preload, main-process IPC and library service.
// Every run owns an isolated profile and library under .recovery/tests.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath } = require('./runtime.cjs');
const { Library } = require('../src/library.cjs');

async function runProduction(electron, options) {
  const { app, BrowserWindow, dialog, session } = electron;
  const fs = require('node:fs/promises'), path = require('node:path');
  const checks = [], errors = [], warnings = [], nativeDialogs = [];
  let window;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const js = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const persist = result => fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ...result, checks, errors, warnings, nativeDialogs }, null, 2));
  async function waitFor(fn, message, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await fn()) return;
      await pause(50);
    }
    throw new Error(message);
  }
  async function parameter(name, value) {
    await js((name, value) => {
      const node = document.querySelector(`[data-param="${name}"]`);
      if (!node || node.disabled) throw new Error(`Unavailable editor parameter ${name}`);
      if (node.type === 'checkbox') node.checked = value; else node.value = String(value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, name, value);
    await pause(180);
  }
  async function capture(name) {
    // A hidden native window can retain its previous compositor frame even
    // while WebGL/DOM have updated. Briefly show without activating it before
    // taking visual evidence, then restore the background test state.
    window.showInactive();
    await pause(160);
    await fs.writeFile(path.join(options.directory, name), (await window.webContents.capturePage()).toPNG());
    window.hide();
  }
  function unexpectedDialog(kind, args) {
    nativeDialogs.push({ kind, title: args.find(value => typeof value === 'string') || args.at(-1)?.title || '' });
    throw new Error(`Unexpected native dialog: ${kind}`);
  }
  dialog.showErrorBox = (...args) => { nativeDialogs.push({ kind: 'error', title: args[0], message: args[1] }); };
  for (const method of ['showOpenDialog', 'showSaveDialog', 'showMessageBox']) dialog[method] = async (...args) => unexpectedDialog(method, args);
  app.on('browser-window-created', (_event, candidate) => {
    window = candidate;
    candidate.setSkipTaskbar(true);
    candidate.webContents.setBackgroundThrottling(false);
    candidate.webContents.on('console-message', event => {
      if (event.level === 'error' || event.level === 3) errors.push(event.message);
      else if (event.level === 'warning' || event.level === 2) warnings.push(event.message);
    });
    candidate.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${JSON.stringify(details)}`));
    candidate.webContents.on('preload-error', (_event, filename, error) => errors.push(`Preload ${filename}: ${error.message}`));
  });
  process.on('uncaughtException', error => { errors.push(error.stack || String(error)); });
  process.on('unhandledRejection', error => { errors.push(error?.stack || String(error)); });
  try {
    require(options.productionMain);
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
    await waitFor(async () => {
      if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return false;
      return js(() => typeof imageEditorUi === 'object' && typeof window.shitu?.readImageForEditor === 'function' && typeof window.shitu?.saveEditedImage === 'function').catch(() => false);
    }, 'Production index/preload did not initialize');
    await waitFor(() => js(root => typeof state === 'object' && state.library?.root === root && state.library.assets.length === 1, options.library), 'Production renderer did not load isolated library');
    checks.push('production main, index.html, sandboxed preload and isolated library initialized');
    const api = await js(async sourceId => {
      const snapshot = await window.shitu.getLibrary();
      const source = snapshot.assets.find(asset => asset.id === sourceId);
      const read = await window.shitu.readImageForEditor(source.id, snapshot.root);
      if (!(read.bytes instanceof Uint8Array) || !read.bytes.length) throw new Error('Real IPC returned no PNG bytes');
      const opened = await imageEditorUi.open(source, snapshot.root, 'maps');
      return { opened, width: read.width, height: read.height, root: snapshot.root, name: source.name };
    }, options.sourceId);
    check(api.opened && api.width === 256 && api.height === 192, 'Editor failed to open image through production read IPC');
    await waitFor(() => js(() => document.querySelector('#imageEditorOverlay [data-action="save"]')?.disabled === false && document.querySelector('#imageEditorCanvas')?.width === 256), 'Editor canvas did not become ready');
    checks.push('real image-editor-read IPC decoded original PNG at source resolution');
    await parameter('type', 'normal');
    await parameter('seamless', true);
    await parameter('seamWidth', 0.2);
    await parameter('strength', 5);
    await capture('editor-maps.png');

    await js(() => {
      const button = document.querySelector('[data-action="material-preview"]');
      if (!button || button.hidden || button.disabled) throw new Error('Material preview entry is unavailable');
      button.click();
    });
    await waitFor(() => js(() => {
      const canvas = document.querySelector('#imageEditorMaterialPreview canvas');
      return canvas && canvas.width > 10 && canvas.height > 10 && !document.querySelector('#imageEditorMaterialPreview').hidden;
    }), 'Material preview did not create its WebGL canvas');
    await pause(500);
    const material = await js(() => {
      const canvas = document.querySelector('#imageEditorMaterialPreview canvas');
      const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
      const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
      const background = Array.from(pixels.slice(0, 3));
      let changed = 0;
      for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - background[0]) + Math.abs(pixels[i + 1] - background[1]) + Math.abs(pixels[i + 2] - background[2]) > 30) changed++;
      return { width: copy.width, height: copy.height, changed, background, dataUrl: copy.toDataURL('image/png') };
    });
    check(material.changed > material.width * material.height * 0.03, `Material preview is blank: ${JSON.stringify({ ...material, dataUrl: undefined })}`);
    await fs.writeFile(path.join(options.directory, 'material-sphere.png'), Buffer.from(material.dataUrl.split(',')[1], 'base64'));
    await capture('material-preview.png');
    checks.push(`material sphere rendered ${material.changed} non-background pixels`);
    await js(() => document.querySelector('[data-action="material-preview"]').click());
    await waitFor(() => js(() => document.querySelector('#imageEditorMaterialPreview').hidden && !document.querySelector('#imageEditorMaterialPreview canvas') && !document.querySelector('#imageEditorCanvas').parentElement.hidden), 'Returning from material preview failed to restore 2D canvas');
    checks.push('material resources released and 2D preview restored');
    window.close();
    await pause(250);
    check(!window.isDestroyed(), 'Native window close discarded unsaved map changes');
    await waitFor(() => js(() => !document.querySelector('#imageEditorOverlay .ie-discard').hidden), 'Native close did not show the unsaved-changes choice');
    const afterCloseRead = await js(async sourceId => {
      const snapshot = await window.shitu.getLibrary();
      const read = await window.shitu.readImageForEditor(sourceId, snapshot.root);
      document.querySelector('[data-action="continue"]').click();
      return { bytes: read.bytes.length, width: read.width, height: read.height };
    }, options.sourceId);
    check(afterCloseRead.bytes > 0 && afterCloseRead.width === 256 && afterCloseRead.height === 192, 'Image service stopped after native-close veto');
    checks.push('native window close preserved unsaved work and image IPC remained usable');
    await js(() => {
      const button = document.querySelector('[data-action="save"]');
      if (button.disabled) throw new Error('Save control is disabled');
      button.click();
    });
    await waitFor(async () => {
      const snapshot = await js(() => window.shitu.getLibrary());
      return snapshot.assets.length === 2;
    }, 'Production save IPC did not import an output image');
    await waitFor(() => js(() => !document.querySelector('[data-action="save"]').disabled && document.querySelector('#imageEditorStatus').textContent.includes('已保存')), 'Editor did not report save completion');
    const snapshot = await js(() => window.shitu.getLibrary());
    const saved = snapshot.assets.find(asset => asset.id !== options.sourceId);
    check(saved?.name === `${api.name} · 无缝 · 法线贴图`, `Unexpected saved image name: ${saved?.name}`);
    check(saved?.width === 256 && saved?.height === 192, 'Saved image dimensions changed');
    check(await js(() => state.library.assets.length) === 2, 'Production renderer did not receive the imported asset');
    checks.push('real image-editor-save IPC imported named full-resolution PNG and refreshed gallery');
    await capture('editor-saved.png');
    await js(() => imageEditorUi.close(true));
    check(errors.length === 0, `Production console/process errors: ${errors.join('; ')}`);
    check(nativeDialogs.length === 0, `Unexpected native dialogs: ${JSON.stringify(nativeDialogs)}`);
    await persist({ ok: true, snapshot, material: { width: material.width, height: material.height, changed: material.changed } });
    for (const candidate of BrowserWindow.getAllWindows()) candidate.destroy();
    app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) await fs.writeFile(path.join(options.directory, 'failure.png'), (await window.webContents.capturePage()).toPNG()).catch(() => {});
    await persist({ ok: false, error: error.stack || String(error) });
    app.exit(1);
  }
}

async function main() {
  const tests = path.join(root, '.recovery', 'tests'); await fs.mkdir(tests, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tests, 'image-editor-app-'));
  const libraryRoot = path.join(directory, 'library'), source = path.join(directory, '生产编辑器测试图.png');
  const raw = Buffer.alloc(256 * 192 * 4);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const p = (y * 256 + x) * 4;
    raw[p] = x; raw[p + 1] = y; raw[p + 2] = (x * 3 + y * 5) % 256; raw[p + 3] = 255;
  }
  await sharp(raw, { raw: { width: 256, height: 192, channels: 4 } }).png().toFile(source);
  const library = new Library({ root: libraryRoot, createThumbnail: async (input, output) => {
    await sharp(input).rotate().resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true }).jpeg().toFile(output);
    return { width: 256, height: 192 };
  } });
  await library.init();
  const imported = await library.importPaths([source]);
  assert.equal(imported.imported, 1);
  await library.flush();
  const sourceId = imported.assetIds[0], originalPath = library.getAssetPath(sourceId, 'original');
  const hash = async filename => crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex');
  const sourceHash = await hash(source), originalHash = await hash(originalPath);
  const options = { directory, library: libraryRoot, sourceId, productionMain: path.join(root, 'src', 'main.cjs') };
  const profile = path.join(directory, 'profile'), sessions = path.join(directory, 'sessions');
  await fs.mkdir(profile); await fs.mkdir(sessions);
  await fs.writeFile(path.join(directory, 'main.cjs'), `'use strict';\nconst electron=require('electron');\nelectron.app.setPath('userData',${JSON.stringify(profile)});\nelectron.app.setPath('sessionData',${JSON.stringify(sessions)});\nelectron.app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');\nprocess.env.SHITU_LIBRARY=${JSON.stringify(libraryRoot)};\n(${runProduction.toString()})(electron,${JSON.stringify(options)});\nsetTimeout(()=>electron.app.exit(2),110000).unref();\n`);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'mosaic-image-editor-app-smoke', version: require('../package.json').version, main: 'main.cjs' }));
  const env = { ...process.env, SHITU_LIBRARY: libraryRoot };
  for (const name of Object.keys(env)) if (name === 'ELECTRON_RUN_AS_NODE' || /SMOKE/.test(name) || name === 'SHITU_PLUGIN_ROOT') delete env[name];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [directory, '--background'], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Production image editor smoke timed out: ${directory}`)); }, 120000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  result.reportDirectory = directory;
  if (exitCode === 0 && result.ok) {
    assert.equal(await hash(source), sourceHash, 'Fixture source was overwritten');
    assert.equal(await hash(originalPath), originalHash, 'Library original was overwritten');
    const index = JSON.parse(await fs.readFile(path.join(libraryRoot, 'index.json'), 'utf8'));
    assert.equal(index.assets.length, 2, 'New image was not persisted to index.json');
    const saved = index.assets.find(asset => asset.id !== sourceId);
    const { data, info } = await sharp(path.join(libraryRoot, saved.filename)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 256); assert.equal(info.height, 192);
    assert.ok(data.some((value, i) => i % 4 === 2 && value > 200), 'Saved normal map has no forward-facing blue vectors');
    for (let y = 0; y < info.height; y++) for (let c = 0; c < 4; c++) assert.equal(data[y * info.width * 4 + c], data[(y * info.width + info.width - 1) * 4 + c], 'Saved horizontal edges differ');
    for (let x = 0; x < info.width; x++) for (let c = 0; c < 4; c++) assert.equal(data[x * 4 + c], data[((info.height - 1) * info.width + x) * 4 + c], 'Saved vertical edges differ');
    result.checks.push('persisted index and normal PNG verified; opposing edges match and both originals retain SHA-256');
    result.originalHashes = { fixture: sourceHash, library: originalHash };
  }
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'image-editor-app-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (exitCode !== 0 || !result.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
