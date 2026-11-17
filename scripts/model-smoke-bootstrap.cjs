'use strict';
module.exports = function configureModelSmoke({ root, base }) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const { app, dialog, session } = require('electron');
  const fixture = require(path.join(base, 'model-smoke-fixture.json'));
  const failures = [];
  const network = [];
  let finished = false;
  const collectorModule = require(path.join(root, 'src', 'collector.cjs'));
  collectorModule.createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  const fail = async error => {
    if (finished) return;
    finished = true;
    await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), failures }, null, 2));
    app.exit(1);
  };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    network.push(details.url); callback({ cancel: true });
  }));
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      window.hide(); window.setSkipTaskbar(true); window.show = () => {};
      window.webContents.setBackgroundThrottling(false);
      try {
        let result = await window.webContents.executeJavaScript(`(async () => {
          const check = (value, message) => { if (!value) throw new Error(message); };
          const waitFor = async (condition, message, timeout = 90000) => {
            const started = Date.now();
            while (!condition()) { if (Date.now() - started > timeout) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 25)); }
          };
          const initial = await api.getLibrary(); check(initial.stats.total === 0, 'Model smoke library is not empty');
          const imported = await api.importPaths([${JSON.stringify(fixture.sources)}]);
          check(imported.report.imported === ${fixture.count} && !imported.report.errors.length, 'Model folder import failed: ' + JSON.stringify(imported.report));
          check(imported.snapshot.assets.every(asset => asset.mediaType === 'model'), 'Packed textures imported as separate images');
          for (const asset of imported.snapshot.assets) {
            check(asset.modelBundle && asset.thumbnail, 'Model bundle or thumbnail missing: ' + asset.ext);
            await new Promise((resolve, reject) => { const image = new Image(); image.onload = resolve; image.onerror = () => reject(new Error('Model thumbnail failed: ' + asset.ext)); image.src = api.assetUrl(asset.id, 'thumbnail'); });
          }
          applyLibrary(imported.snapshot, false);
          state.format = 'model'; check(filteredAssets().length === ${fixture.count}, '3D format filter failed');
          state.format = 'images'; check(filteredAssets().length === 0, 'Models appeared in the image filter'); state.format = 'all';
          window.__modelSmoke = { check, waitFor, imported };
          return { imported: imported.report.imported, thumbnails: imported.snapshot.assets.length, managedBundles: imported.snapshot.assets.map(asset => ({ filename: asset.filename, files: asset.modelBundle.files.length, ext: asset.ext })) };
        })()`);
        // Removing only this generated source directory proves the managed model
        // and all external textures are sufficient for subsequent preview.
        const sourceRelative = path.relative(base, fixture.sources);
        assert.equal(sourceRelative, 'sources');
        await fs.rm(fixture.sources, { recursive: true, force: true });
        const ui = await window.webContents.executeJavaScript(`(async () => {
          const { check, waitFor, imported } = window.__modelSmoke;
          const rendered = [];
          for (const asset of imported.snapshot.assets) {
            openPreview(asset.id);
            await waitFor(() => document.getElementById('previewModel').dataset.ready === 'true', 'Model UI preview failed: ' + asset.ext + ' / ' + document.getElementById('previewModelStatus').textContent);
            check(modelViewer.metadata.vertices > 0, 'Model has no rendered vertices');
            const before = modelViewer.captureJPEG(); check(before.startsWith('data:image/jpeg;base64,'), 'Model JPEG capture failed');
            modelViewer.resetView();
            rendered.push({ format: asset.ext, ...modelViewer.metadata });
            closePreview(); check(modelViewer.metadata === null && !state.previewId, 'Closing model preview did not clear GPU scene');
          }
          const first = imported.snapshot.assets[0]; const last = imported.snapshot.assets.at(-1);
          openPreview(first.id); displayPreviewAsset(last, rendered.length - 1, rendered.length);
          await waitFor(() => state.previewId === last.id && document.getElementById('previewModel').dataset.ready === 'true', 'Rapid model switch failed');
          closePreview(); openPreview(last.id);
          await waitFor(() => document.getElementById('previewModel').dataset.ready === 'true', 'Model reopen failed');
          const options = await api.prepareModel(last.id, imported.snapshot.root);
          check((await fetch(options.url)).ok, 'Authorized model protocol failed');
          const rejected = new URL(options.url); rejected.pathname += '/unlisted.bin'; check((await fetch(rejected)).status === 404, 'Unlisted model resource was served');
          return { rendered, sourcesRemovedBeforePreview: true, stalePreviewIgnored: true, closeClearsScene: true, reopen: true,
            manifestResourceIsolation: true, formatFilters: true, finalScreenshot: modelViewer.captureJPEG() };
        })()`);
        const target = await window.webContents.executeJavaScript(`(() => { const r = modelViewer.canvas.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        window.webContents.debugger.attach('1.3');
        const mouse = parameters => window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', parameters);
        await mouse({ type: 'mousePressed', ...target, button: 'left', buttons: 1, clickCount: 1 });
        await mouse({ type: 'mouseMoved', x: target.x + 110, y: target.y + 35, button: 'left', buttons: 1 });
        await mouse({ type: 'mouseReleased', x: target.x + 110, y: target.y + 35, button: 'left', buttons: 0, clickCount: 1 });
        await new Promise(resolve => setTimeout(resolve, 120));
        const rotated = await window.webContents.executeJavaScript('modelViewer.captureJPEG()');
        assert.notEqual(rotated, ui.finalScreenshot, 'Dragging the 3D canvas did not rotate the model');
        await mouse({ type: 'mouseWheel', ...target, deltaX: 0, deltaY: -240 });
        await new Promise(resolve => setTimeout(resolve, 120));
        const zoomed = await window.webContents.executeJavaScript('modelViewer.captureJPEG()');
        assert.notEqual(zoomed, rotated, 'Wheel input did not zoom the 3D model');
        window.webContents.debugger.detach();
        ui.orbitControls = true; ui.zoomControls = true;
        await fs.writeFile(path.join(base, 'model-preview.jpg'), Buffer.from(zoomed.split(',')[1], 'base64'));
        delete ui.finalScreenshot;
        assert.deepEqual(failures, []); assert.deepEqual(network, []);
        await window.webContents.executeJavaScript('closePreview()');
        result = { ok: true, electron: process.versions.electron, ...result, ...ui, browserNetworkRequests: network.length };
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
        finished = true;
        app.quit();
      } catch (error) { await fail(error); }
    });
  });
  setTimeout(() => fail(new Error('Model smoke exceeded its time limit')), 280000).unref();
};
