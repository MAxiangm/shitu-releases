'use strict';
// Development-only entry point. The recovered application source stays intact.
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const root = path.resolve(__dirname, '..');
const smoke = process.env.SHITU_RECOVERY_SMOKE === '1';
const updateSmoke = process.env.SHITU_UPDATE_SMOKE === '1';
const videoSmoke = process.env.SHITU_VIDEO_SMOKE === '1';
if ([smoke, updateSmoke, videoSmoke].filter(Boolean).length > 1) throw new Error('Choose one smoke test mode at a time.');
const testing = smoke || updateSmoke || videoSmoke;
const base = testing
  ? path.resolve(process.env.SHITU_SMOKE_DIRECTORY)
  : path.join(root, '.recovery', 'development');
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
          if (!document.querySelector('#pageTitle') || !document.body.textContent.includes('拾图'))
            throw new Error('Main interface did not render');
          return { initialTotal: initial.stats.total, imported: imported.report.imported,
            active: restored.stats.active, protocol: true, thumbnail: true,
            pluginsAvailable: Boolean(plugins), userInterface: true };
        })()`);
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
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: true });

  const repository = require(path.join(root, 'update-config.json')).repository;
  assert.match(repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
  const tag = `v${fixture.nextVersion}`;
  const assetName = `shitu-${fixture.nextVersion}-setup.exe`;
  const manifestURL = `https://github.com/${repository}/releases/download/${tag}/shitu-update.json`;
  const installerURL = `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
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
  electron.net.fetch = async (url, options = {}) => {
    const address = String(url);
    assert.equal(options.redirect, 'manual');
    networkRequests.push(address);
    if (address === `https://api.github.com/repos/${repository}/releases/latest`)
      return new Response(JSON.stringify(release), { headers: { 'content-type': 'application/json' } });
    if (address === manifestURL)
      return new Response(manifestBody, { headers: { 'content-type': 'application/json' } });
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

  let installRequest = null, flushCount = 0, collectorClosed = false, uiResult = null;
  let collectorOptions = null, collectorBlockedDuringInstall = false;
  const failures = [];
  childProcess.spawn = (filePath, args, options) => {
    const expected = path.join(base, 'profile', 'updates', `${fixture.nextVersion}-${sha256}.exe`);
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
        latestVersion: fixture.nextVersion, sha256, networkRequests, networkMocked: true,
        installerExecuted: false, installRequest, libraryFlushCalls: flushCount,
        collectorClosed, collectorBlockedDuringInstall, quitObserved: true, userData: app.getPath('userData'), ...uiResult
      }, null, 2) + '\n');
    } catch (error) { fail(error); }
  });
  app.on('browser-window-created', (_event, window) => {
    // Keep a live compositor without exposing or focusing the test window.
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
        uiResult = await window.webContents.executeJavaScript(`(async () => {
          const api = window.shitu;
          if (!api || !api.checkUpdate || !document.getElementById('appUpdateButton'))
            throw new Error('Update API or header button missing');
          const initial = await api.updateState();
          if (initial.status !== 'idle' || initial.currentVersion !== ${JSON.stringify(fixture.currentVersion)})
            throw new Error('Updater did not initialize as packaged application');
          const downloaded = await api.checkUpdate();
          if (downloaded.status !== 'downloaded' || downloaded.latestVersion !== ${JSON.stringify(fixture.nextVersion)})
            throw new Error('GitHub check and automatic download did not finish');
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

require(path.join(root, 'src', 'main.cjs'));
