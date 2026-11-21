'use strict';
// Development-only entry point. The recovered application source stays intact.
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const root = path.resolve(__dirname, '..');
const smoke = process.env.SHITU_RECOVERY_SMOKE === '1';
const updateSmoke = process.env.SHITU_UPDATE_SMOKE === '1';
const videoSmoke = process.env.SHITU_VIDEO_SMOKE === '1';
const modelSmoke = process.env.SHITU_MODEL_SMOKE === '1';
const aeSmoke = process.env.SHITU_AE_SMOKE === '1';
const folderSmoke = process.env.SHITU_FOLDER_SMOKE === '1';
const colorsSmoke = process.env.SHITU_COLORS_SMOKE === '1';
const hoverVideoSmoke = process.env.SHITU_HOVER_VIDEO_SMOKE === '1';
const assetDragSmoke = process.env.SHITU_ASSET_DRAG_SMOKE === '1';
const transcodeSmoke = process.env.SHITU_TRANSCODE_SMOKE === '1';
const uiRecoverySmoke = process.env.SHITU_UI_RECOVERY_SMOKE === '1';
const undoSmoke = process.env.SHITU_UNDO_SMOKE === '1';
const folderPanelSmoke = process.env.SHITU_FOLDER_PANEL_SMOKE === '1';
const fontSmoke = process.env.SHITU_FONT_SMOKE === '1';
const organizeSmoke = process.env.SHITU_ORGANIZE_SMOKE === '1';
const skinsSmoke = process.env.SHITU_SKINS_SMOKE === '1';
const windowHeaderSmoke = process.env.SHITU_WINDOW_HEADER_SMOKE === '1';
const modes = [smoke, updateSmoke, videoSmoke, modelSmoke, aeSmoke, folderSmoke, colorsSmoke, hoverVideoSmoke, assetDragSmoke, transcodeSmoke, uiRecoverySmoke, undoSmoke, folderPanelSmoke, fontSmoke, organizeSmoke, skinsSmoke, windowHeaderSmoke];
if (modes.filter(Boolean).length > 1) throw new Error('Choose one smoke test mode at a time.');
const testing = modes.includes(true);
const base = testing
  ? path.resolve(process.env.SHITU_SMOKE_DIRECTORY)
  : path.join(root, '.recovery', 'development');
if (windowHeaderSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Window header smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'window-header-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_WINDOW_HEADER_SMOKE_TOKEN || marker.token !== process.env.SHITU_WINDOW_HEADER_SMOKE_TOKEN) throw new Error('Window header smoke marker does not match.');
}
if (skinsSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Skins smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'skins-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_SKINS_SMOKE_TOKEN || marker.token !== process.env.SHITU_SKINS_SMOKE_TOKEN) throw new Error('Skins smoke marker does not match.');
}
if (organizeSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Organize smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'organize-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_ORGANIZE_SMOKE_TOKEN || marker.token !== process.env.SHITU_ORGANIZE_SMOKE_TOKEN) throw new Error('Organize smoke marker does not match.');
}
if (fontSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Font smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'font-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_FONT_SMOKE_TOKEN || marker.token !== process.env.SHITU_FONT_SMOKE_TOKEN) throw new Error('Font smoke marker does not match.');
}
if (folderPanelSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Folder panel smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'folder-panel-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_FOLDER_PANEL_SMOKE_TOKEN || marker.token !== process.env.SHITU_FOLDER_PANEL_SMOKE_TOKEN) throw new Error('Folder panel smoke marker does not match.');
}
if (undoSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Undo smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'undo-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_UNDO_SMOKE_TOKEN || marker.token !== process.env.SHITU_UNDO_SMOKE_TOKEN) throw new Error('Undo smoke marker does not match.');
}
if (updateSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink())
    throw new Error('Update smoke directory must be a real child of .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'update-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_UPDATE_SMOKE_TOKEN || marker.token !== process.env.SHITU_UPDATE_SMOKE_TOKEN)
    throw new Error('Update smoke test marker does not match.');
}
if (videoSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink())
    throw new Error('Video smoke directory must be a real child of .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'video-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_VIDEO_SMOKE_TOKEN || marker.token !== process.env.SHITU_VIDEO_SMOKE_TOKEN)
    throw new Error('Video smoke test marker does not match.');
}
if (modelSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Model smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'model-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_MODEL_SMOKE_TOKEN || marker.token !== process.env.SHITU_MODEL_SMOKE_TOKEN) throw new Error('Model smoke marker does not match.');
}
if (aeSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('AE smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'ae-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_AE_SMOKE_TOKEN || marker.token !== process.env.SHITU_AE_SMOKE_TOKEN) throw new Error('AE smoke marker does not match.');
}
if (folderSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Folder smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'folder-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_FOLDER_SMOKE_TOKEN || marker.token !== process.env.SHITU_FOLDER_SMOKE_TOKEN) throw new Error('Folder smoke marker does not match.');
}
if (colorsSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Color smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'color-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_COLORS_SMOKE_TOKEN || marker.token !== process.env.SHITU_COLORS_SMOKE_TOKEN) throw new Error('Color smoke marker does not match.');
}
if (hoverVideoSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Hover video smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'hover-video-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_HOVER_VIDEO_SMOKE_TOKEN || marker.token !== process.env.SHITU_HOVER_VIDEO_SMOKE_TOKEN) throw new Error('Hover video smoke marker does not match.');
}
if (uiRecoverySmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('UI recovery smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'ui-recovery-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_UI_RECOVERY_SMOKE_TOKEN || marker.token !== process.env.SHITU_UI_RECOVERY_SMOKE_TOKEN) throw new Error('UI recovery smoke marker does not match.');
}
if (transcodeSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Transcode smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'transcode-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_TRANSCODE_SMOKE_TOKEN || marker.token !== process.env.SHITU_TRANSCODE_SMOKE_TOKEN) throw new Error('Transcode smoke marker does not match.');
}
if (assetDragSmoke) {
  const relative = path.relative(path.join(root, '.recovery', 'tests'), base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink()) throw new Error('Asset drag smoke directory must stay inside .recovery/tests.');
  const marker = JSON.parse(fs.readFileSync(path.join(base, 'asset-drag-smoke-fixture.json'), 'utf8'));
  if (!process.env.SHITU_ASSET_DRAG_SMOKE_TOKEN || marker.token !== process.env.SHITU_ASSET_DRAG_SMOKE_TOKEN) throw new Error('Asset drag smoke marker does not match.');
}
for (const name of ['profile', 'sessions', 'crashes', 'plugins']) {
  fs.mkdirSync(path.join(base, name), { recursive: true });
}
app.setPath('userData', path.join(base, 'profile'));
app.setPath('sessionData', path.join(base, 'sessions'));
app.setPath('crashDumps', path.join(base, 'crashes'));
app.setAppPath(root);
process.env.SHITU_LIBRARY = testing ? path.join(base, 'library') :
  (process.env.SHITU_LIBRARY || path.join(base, 'library'));
process.env.SHITU_PLUGIN_ROOT = testing ? path.join(base, 'plugins') :
  (process.env.SHITU_PLUGIN_ROOT || path.join(base, 'plugins'));

if (!testing && process.argv.includes('--devtools')) {
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => window.webContents.openDevTools({ mode: 'detach' }));
  });
}

if (smoke) {
  // No collector socket is opened during the automated smoke test.
  const collector = require(path.join(root, 'src', 'collector.cjs'));
  collector.createCollector = () => ({
    start: async () => ({}), info: () => ({ enabled: false, baseUrl: null, code: null }),
    activeCount: () => 0, close: async () => {}
  });
  const failures = [];
  dialog.showErrorBox = (title, content) => failures.push(`${title}: ${content}`);
  app.on('browser-window-created', (_event, window) => {
    window.show = () => {};
    window.webContents.on('console-message', event => {
      if (event.level === 'error' || event.level === 3) failures.push(event.message);
    });
    window.webContents.on('render-process-gone', (_event, details) => failures.push(JSON.stringify(details)));
    window.webContents.once('did-finish-load', async () => {
      try {
        const result = await window.webContents.executeJavaScript(`(async () => {
          const api = window.shitu;
          if (!api) throw new Error('Preload API did not load');
          const initial = await api.getLibrary();
          if (!initial.root || initial.stats.total !== 0) throw new Error('Isolated library is not empty');
          const imported = await api.importPaths([${JSON.stringify(path.join(base, 'sample.png'))}]);
          if (imported.report.imported !== 1) throw new Error('Image import failed');
          const id = imported.report.assetIds[0];
          const loadImage = kind => new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => image.naturalWidth > 0 ? resolve() : reject(new Error('Empty image'));
            image.onerror = () => reject(new Error('Asset protocol failed: ' + kind));
            image.src = api.assetUrl(id, kind);
          });
          await loadImage('original');
          await loadImage('thumbnail');
          const updated = await api.updateAssets([id], { tags: ['recovery-smoke'], rating: 5 });
          if (updated.assets[0].rating !== 5) throw new Error('Metadata update failed');
          const trashed = await api.setTrash([id], true);
          if (trashed.stats.trashed !== 1) throw new Error('Trash failed');
          const restored = await api.setTrash([id], false);
          if (restored.stats.active !== 1) throw new Error('Restore failed');
          applyLibrary(restored);
          const plugins = await api.pluginsList();
          await new Promise(resolve => setTimeout(resolve, 350));
          if (!document.querySelector('#pageTitle') || !document.querySelector('.brand')?.textContent.includes('Mosaic'))
            throw new Error('Main interface did not render');
          return { initialTotal: initial.stats.total, imported: imported.report.imported, capturedId: id,
            active: restored.stats.active, protocol: true, thumbnail: true,
            pluginsAvailable: Boolean(plugins), userInterface: true };
        })()`);
        await window.webContents.executeJavaScript(`state.search = 'no-match-for-capture'; state.format = 'model'; state.folder = 'filtered-folder'; render();`);
        window.webContents.send('shitu:web-capture', { ok: true, imported: 1, assetIds: [result.capturedId], libraryRoot: process.env.SHITU_LIBRARY });
        result.captureNoticeRevealsHiddenAsset = await window.webContents.executeJavaScript(`(async () => {
          const deadline = Date.now() + 5000;
          while (!document.querySelector('[data-web-capture] button')) {
            if (Date.now() > deadline) throw new Error('Capture success notice did not appear');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          document.querySelector('[data-web-capture] button').click();
          while (state.search || state.format !== 'all' || state.folder || state.selected.size !== 1 || !document.querySelector('.asset-card')) {
            if (Date.now() > deadline) throw new Error('Capture View action did not clear filters and locate the asset');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          return true;
        })()`);
        delete result.capturedId;
        if (failures.length) throw new Error(failures.join('\n'));
        let screenshotCaptured = false;
        try {
          const screenshot = await window.webContents.capturePage();
          fs.writeFileSync(path.join(base, 'screenshot.png'), screenshot.toPNG());
          screenshotCaptured = true;
        } catch {}
        fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({
          ok: true, electron: process.versions.electron, node: process.versions.node,
          ...result, screenshotCaptured, userData: app.getPath('userData'), library: process.env.SHITU_LIBRARY
        }, null, 2) + '\n');
        window.destroy();
        app.quit();
      } catch (error) {
        try {
          const screenshot = await window.webContents.capturePage();
          fs.writeFileSync(path.join(base, 'failure.png'), screenshot.toPNG());
        } catch {}
        fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack, failures }, null, 2));
        app.exit(1);
      }
    });
  });
  setTimeout(() => {
    fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: 'Electron smoke test timed out', failures }, null, 2));
    app.exit(1);
  }, 45000).unref();
}

if (updateSmoke) configureUpdateSmoke();
if (videoSmoke) require('./video-smoke-bootstrap.cjs')({ root, base });
if (modelSmoke) require('./model-smoke-bootstrap.cjs')({ root, base });
if (aeSmoke) require('./ae-smoke-bootstrap.cjs')({ root, base });
if (folderSmoke) require('./folders-smoke-bootstrap.cjs')({ root, base });
if (colorsSmoke) require('./colors-smoke-bootstrap.cjs')({ root, base });
if (hoverVideoSmoke) require('./hover-video-smoke-bootstrap.cjs')({ root, base });
if (assetDragSmoke) require('./asset-drag-smoke-bootstrap.cjs')({ root, base });
if (transcodeSmoke) require('./transcode-smoke-bootstrap.cjs')({ root, base });
if (uiRecoverySmoke) require('./ui-recovery-smoke-bootstrap.cjs')({ root, base });
if (undoSmoke) require('./undo-smoke-bootstrap.cjs')({ root, base });
if (folderPanelSmoke) require('./folder-panel-smoke-bootstrap.cjs')({ root, base });

function configureUpdateSmoke() {
  // This branch only runs inside an explicitly marked, isolated smoke process.
  // No downloaded bytes are ever executed: spawn is a closed, validating mock.
  const assert = require('node:assert/strict');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const electron = require('electron');
  const childProcess = require('node:child_process');
  const fixture = JSON.parse(fs.readFileSync(path.join(base, 'update-smoke-fixture.json'), 'utf8'));
  const installer = Buffer.from(fixture.installerBase64, 'base64');
  const sha256 = crypto.createHash('sha256').update(installer).digest('hex');
  assert.equal(sha256, fixture.sha256);
  assert.equal(app.getVersion(), fixture.currentVersion);
  // Production pins its packaged profile under appData. Keep that path inside
  // this fixture too, so a running installed app cannot own the smoke lock.
  const updateAppData = path.join(base, 'app-data');
  const updateProfile = path.join(updateAppData, '拾图');
  fs.mkdirSync(updateProfile, { recursive: true });
  app.setPath('appData', updateAppData);
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: true });

  const repository = require(path.join(root, 'update-config.json')).repository;
  assert.match(repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
  const tag = `v${fixture.nextVersion}`;
  const assetName = `shitu-${fixture.nextVersion}-setup.exe`;
  const manifestURL = `https://github.com/${repository}/releases/download/${tag}/shitu-update.json`;
  const installerURL = `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
  const officialReleaseURL = `https://github.com/${repository}/releases/latest`;
  const openedReleasePages = [];
  electron.shell.openExternal = async address => {
    assert.equal(address, officialReleaseURL, 'Only the fixed official release page may be opened');
    openedReleasePages.push(address);
  };
  const manifest = {
    schemaVersion: 1, version: fixture.nextVersion, platform: 'win32', arch: 'x64',
    installer: { name: assetName, size: installer.length, sha256 }
  };
  const manifestBody = JSON.stringify(manifest);
  const release = {
    tag_name: tag, draft: false, prerelease: false, body: fixture.notes,
    assets: [
      { name: 'shitu-update.json', size: Buffer.byteLength(manifestBody), browser_download_url: manifestURL },
      { name: assetName, size: installer.length, digest: `sha256:${sha256}`, browser_download_url: installerURL }
    ]
  };
  const networkRequests = [];
  let updateNetworkBlocked = true;
  electron.net.fetch = async (url, options = {}) => {
    const address = String(url);
    assert.equal(options.redirect, 'manual');
    networkRequests.push(address);
    const metadataAddress = new URL(address);
    const nonce = metadataAddress.searchParams.getAll('_shitu_check');
    metadataAddress.searchParams.delete('_shitu_check');
    if (metadataAddress.href === `https://api.github.com/repos/${repository}/releases/latest` || metadataAddress.href === manifestURL) {
      assert.equal(nonce.length, 1, 'Each metadata request must carry exactly one freshness nonce');
      assert.match(nonce[0], /^[a-f0-9-]{36}$/);
      assert.equal(options.cache, 'no-store');
      assert.equal(options.headers['Cache-Control'], 'no-cache, no-store, max-age=0');
      assert.equal(options.headers.Pragma, 'no-cache');
      if (updateNetworkBlocked) throw new Error('net::ERR_CONNECTION_RESET');
      return new Response(metadataAddress.href === manifestURL ? manifestBody : JSON.stringify(release),
        { headers: { 'content-type': 'application/json' } });
    }
    if (address === installerURL) {
      let offset = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (offset >= installer.length) return controller.close();
          const end = Math.min(offset + 97, installer.length);
          controller.enqueue(installer.subarray(offset, end)); offset = end;
        }
      }), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(installer.length) } });
    }
    throw new Error(`Smoke test refused unexpected network request: ${address}`);
  };
  // The transport is the network boundary in production. Keep this UI/IPC smoke
  // closed, while the separate live smoke exercises real Electron networking.
  require(path.join(root, 'src', 'update-transport.cjs')).createUpdateTransport = ({ net }) => (...args) => net.fetch(...args);

  let installRequest = null, flushCount = 0, collectorClosed = false, uiResult = null;
  let collectorOptions = null, collectorBlockedDuringInstall = false;
  const failures = [];
  childProcess.spawn = (filePath, args, options) => {
    const expected = path.join(updateProfile, 'updates', `${fixture.nextVersion}-${sha256}.exe`);
    assert.equal(app.getPath('userData'), updateProfile);
    assert.equal(filePath, expected);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), sha256);
    assert.deepEqual(args, ['/S', '/SHITUUPDATE']);
    assert.equal(options.detached, true);
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.env.SHITU_UPDATE_PID, String(process.pid));
    assert.equal(options.env.SHITU_UPDATE_INSTALL_DIR, path.dirname(process.execPath));
    assert.equal(collectorOptions.isReady(), false);
    assert.throws(() => collectorOptions.library.importPaths(['x']), /正在安装更新/);
    collectorBlockedDuringInstall = true;
    installRequest = { filePath, args, detached: options.detached, windowsHide: options.windowsHide,
      parentPid: options.env.SHITU_UPDATE_PID, installDirectory: options.env.SHITU_UPDATE_INSTALL_DIR };
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const { Library } = require(path.join(root, 'src', 'library.cjs'));
  const originalFlush = Library.prototype.flush;
  Library.prototype.flush = function (...args) { flushCount++; return originalFlush.apply(this, args); };
  const collector = require(path.join(root, 'src', 'collector.cjs'));
  collector.createCollector = options => {
    collectorOptions = options;
    return {
    start: async () => ({}), info: () => ({ enabled: false, baseUrl: null, code: null }),
    activeCount: () => 0, close: async () => { collectorClosed = true; }
    };
  };
  const resultPath = path.join(base, 'result.json');
  const fail = error => {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: error.stack || String(error), failures }, null, 2));
    app.exit(1);
  };
  dialog.showErrorBox = (title, content) => failures.push(`${title}: ${content}`);
  app.on('before-quit', () => {
    try {
      assert.ok(uiResult, 'UI checks must finish before application quit.');
      assert.ok(installRequest, 'Installer launch must be captured.');
      assert.ok(flushCount > 0, 'Library must be flushed.');
      assert.equal(collectorClosed, true);
      assert.deepEqual(failures, []);
      fs.writeFileSync(resultPath, JSON.stringify({
        ok: true, electron: process.versions.electron, currentVersion: fixture.currentVersion,
        latestVersion: fixture.nextVersion, sha256, networkRequests, networkMocked: true, updateTransportBoundaryMocked: true, metadataFreshnessVerified: true,
        officialReleasePageRequests: openedReleasePages,
        installerExecuted: false, installRequest, libraryFlushCalls: flushCount,
        collectorClosed, collectorBlockedDuringInstall, quitObserved: true, userData: app.getPath('userData'), ...uiResult
      }, null, 2) + '\n');
    } catch (error) { fail(error); }
  });
  app.on('browser-window-created', (_event, window) => {
    // Keep a live compositor without exposing or focusing the test window.
    const sendToRenderer = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, payload, ...rest) => {
      if (channel === 'shitu:update-state' && payload?.status === 'downloaded' && payload.error) {
        // State notifications and invoke rejections use separate renderer IPC
        // paths. Exercise their ordering explicitly instead of depending on CPU load.
        setTimeout(() => { if (!window.webContents.isDestroyed()) sendToRenderer(channel, payload, ...rest); }, 75);
        return;
      }
      return sendToRenderer(channel, payload, ...rest);
    };
    window.setSkipTaskbar(true);
    window.setOpacity(0);
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
    window.show = () => {};
    window.webContents.on('console-message', event => {
      if (event.level === 'error' || event.level === 3) failures.push(event.message);
    });
    window.webContents.on('render-process-gone', (_event, details) => failures.push(JSON.stringify(details)));
    window.webContents.once('did-finish-load', async () => {
      try {
        const errorUi = await window.webContents.executeJavaScript(`(async () => {
          const initial = await api.updateState();
          if (initial.status !== 'idle') throw new Error('Updater did not initialize before failure test');
          document.getElementById('appUpdateButton').click();
          document.getElementById('appUpdateCheck').click();
          const deadline = Date.now() + 7000;
          let failed;
          while (true) {
            failed = await api.updateState();
            if (failed.status === 'error' && !document.getElementById('appUpdateCheck').disabled) break;
            if (Date.now() > deadline) throw new Error('Failed update check did not finish');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          const message = document.getElementById('appUpdateStatus').textContent;
          if (!failed.error || message !== failed.error || /Error invoking remote method|shitu:update-|^Error:/.test(message))
            throw new Error('Update error exposed the IPC wrapper instead of the public error');
          if (/Error invoking remote method|shitu:update-/.test(document.getElementById('toastStack').textContent))
            throw new Error('Update error toast exposed the IPC wrapper');
          if (document.getElementById('appUpdateCheck').textContent !== '重新检查') throw new Error('Failed check is not retryable');
          const fallback = document.getElementById('appUpdateOpenRelease');
          if (!fallback || fallback.classList.contains('hidden') || fallback.disabled) throw new Error('Official download fallback is unavailable after a failed check');
          fallback.click();
          if (updateUi.pending) throw new Error('Opening the official page must not start an update operation');
          return { updateErrorSanitized: true, updateErrorRetryEnabled: true, manualDownloadFallbackVerified: true };
        })()`);
        const fallbackDeadline = Date.now() + 5000;
        while (!openedReleasePages.length) {
          if (Date.now() > fallbackDeadline) throw new Error('The official download button did not open the fixed release URL');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.deepEqual(openedReleasePages, [officialReleaseURL]);
        updateNetworkBlocked = false;
        uiResult = await window.webContents.executeJavaScript(`(async () => {
          const api = window.shitu;
          if (!api || !api.checkUpdate || !document.getElementById('appUpdateButton'))
            throw new Error('Update API or header button missing');
          const initial = await api.updateState();
          if (initial.status !== 'error' || initial.currentVersion !== ${JSON.stringify(fixture.currentVersion)})
            throw new Error('Updater did not initialize as packaged application');
          document.getElementById('appUpdateCheck').click();
          const retryDeadline = Date.now() + 7000;
          let downloaded;
          while (true) {
            downloaded = await api.updateState();
            if (downloaded.status === 'downloaded' && !document.getElementById('appUpdateCheck').disabled) break;
            if (Date.now() > retryDeadline) throw new Error('Update retry did not recover and download');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          if (downloaded.status !== 'downloaded' || downloaded.latestVersion !== ${JSON.stringify(fixture.nextVersion)})
            throw new Error('GitHub check and automatic download did not finish');
          if (!document.getElementById('appUpdateOpenRelease').classList.contains('hidden'))
            throw new Error('Official download fallback remained visible after update recovery');
          document.getElementById('appUpdateButton').click();
          await Promise.race([
            new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            new Promise(resolve => setTimeout(resolve, 250))
          ]);
          const overlay = document.getElementById('appUpdateOverlay');
          const panel = document.getElementById('appUpdateDialog');
          const bounds = panel.getBoundingClientRect();
          if (overlay.classList.contains('hidden') || getComputedStyle(overlay).display === 'none' ||
              getComputedStyle(panel).visibility !== 'visible' || bounds.width < 300 || bounds.height < 200)
            throw new Error('Update panel did not open');
          if (document.getElementById('appUpdateLabel').textContent !== '重启更新')
            throw new Error('Header did not render downloaded state');
          const notes = document.getElementById('appUpdateNotes');
          if (notes.textContent !== ${JSON.stringify(fixture.notes)} || notes.querySelector('img') || window.__updateSmokeXss)
            throw new Error('Release notes must render as plain text');
          const button = document.getElementById('appUpdateInstall');
          if (button.disabled || button.classList.contains('hidden')) throw new Error('Install action is not ready');
          return { updatePanel: true, automaticallyDownloaded: true, releaseNotesPlainText: true,
            downloadState: downloaded.status, downloadProgress: downloaded.progress,
            panelBounds: { width: bounds.width, height: bounds.height }, panelDisplay: getComputedStyle(overlay).display,
            headerLabel: document.getElementById('appUpdateLabel').textContent };
        })()`);
        Object.assign(uiResult, errorUi);
        updateNetworkBlocked = true;
        const preservedUi = await window.webContents.executeJavaScript(`(async () => {
          document.getElementById('appUpdateCheck').click();
          const deadline = Date.now() + 7000;
          let failed;
          while (true) {
            failed = await api.updateState();
            if (failed.error && updateUi.snapshot.status === failed.status && updateUi.snapshot.error === failed.error &&
                !updateUi.pending && !document.getElementById('appUpdateCheck').disabled) break;
            if (Date.now() > deadline) throw new Error('Downloaded update recheck failure did not finish');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          if (failed.status !== 'downloaded' || document.getElementById('appUpdateInstall').disabled ||
              document.getElementById('appUpdateInstall').classList.contains('hidden'))
            throw new Error('Network failure discarded the already verified downloaded update: ' + JSON.stringify({ main: failed, ui: updateUi.snapshot, pending: updateUi.pending, installDisabled: document.getElementById('appUpdateInstall').disabled, installHidden: document.getElementById('appUpdateInstall').classList.contains('hidden') }));
          const text = document.getElementById('appUpdateStatus').textContent;
          if (text !== failed.error || /Error invoking remote method|shitu:update-|^Error:/.test(text))
            throw new Error('Downloaded state displayed a raw IPC error');
          return { downloadedUpdatePreservedAfterCheckFailure: true, delayedUpdateErrorStateSynchronized: true };
        })()`);
        Object.assign(uiResult, preservedUi);
        updateNetworkBlocked = false;
        await window.webContents.executeJavaScript(`runUpdateAction(() => api.checkUpdate())`);
        const editorGuard = await window.webContents.executeJavaScript(`(async () => {
          const original = imageEditorUi.canCloseApp;
          imageEditorUi.canCloseApp = () => false;
          let rejected = false;
          try { await api.installUpdate(); }
          catch (error) {
            if (!/保存或放弃图片编辑/.test(error.message)) throw error;
            rejected = true;
          }
          finally { imageEditorUi.canCloseApp = original; }
          if (!rejected) throw new Error('Update installation ignored unsaved image-editor work');
          const state = await api.updateState();
          if (state.status !== 'downloaded') throw new Error('Blocked update lost its verified download');
          return { unsavedEditorBlocksInstallation: true };
        })()`);
        assert.equal(installRequest, null, 'Unsaved editor must block installer launch.');
        assert.equal(collectorClosed, false, 'Rejected installation must leave services running.');
        assert.equal(collectorOptions.isReady(), true, 'Rejected installation must leave the library usable.');
        Object.assign(uiResult, editorGuard);
        assert.deepEqual(failures, []);
        // Pixel capture is optional on headless CI; the UI/IPC assertions above are required.
        try {
          await window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
          await new Promise(resolve => setTimeout(resolve, 350));
          const screenshot = await window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
          fs.writeFileSync(path.join(base, 'screenshot.png'), screenshot.toPNG());
          uiResult.screenshotCaptured = true;
        } catch { uiResult.screenshotCaptured = false; }
        await window.webContents.executeJavaScript(`document.getElementById('appUpdateInstall').click()`);
      } catch (error) {
        try { fs.writeFileSync(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
        fail(error);
      }
    });
  });
  setTimeout(() => fail(new Error('Update smoke test timed out')), 45000).unref();
}

if (fontSmoke) require('./font-smoke-bootstrap.cjs')({ root, base });
if (organizeSmoke) require('./organize-smoke-bootstrap.cjs')({ root, base });
if (skinsSmoke) require('./skins-smoke-bootstrap.cjs')({ root, base });
if (windowHeaderSmoke) require('./window-header-smoke-bootstrap.cjs')({ root, base });
require(path.join(root, 'src', 'main.cjs'));
