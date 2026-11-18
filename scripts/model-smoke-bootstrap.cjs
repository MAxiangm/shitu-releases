'use strict';
module.exports = function configureModelSmoke({ root, base }) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const { app, dialog, ipcMain, session } = require('electron');
  const fixture = require(path.join(base, 'model-smoke-fixture.json'));
  const failures = [];
  const network = [];
  const hoverCalls = [];
  const warmupCalls = [];
  let finished = false, hoverReplyGate, smokeWindow;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (test, message, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await test();
      if (result) return result;
      await delay(40);
    }
    throw new Error(message);
  };
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
    if (channel === 'shitu:warm-model-hover') {
      const call = { id: args[1], done: false };
      warmupCalls.push(call);
      call.done = await listener(...args);
      return call.done;
    }
    if (channel !== 'shitu:prepare-model-hover') return listener(...args);
    const gate = hoverReplyGate?.id === args[1] ? hoverReplyGate : null;
    const call = { id: args[1], status: 'pending' };
    hoverCalls.push(call);
    let reply;
    try {
      reply = await listener(...args);
      call.status = reply?.url ? 'prepared' : 'unavailable';
    } catch (error) {
      call.status = error.message;
      throw error;
    }
    if (gate) { gate.entered = true; await gate.promise; }
    return reply;
  });
  const collectorModule = require(path.join(root, 'src', 'collector.cjs'));
  collectorModule.createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  const fail = async error => {
    if (finished) return;
    finished = true;
    hoverReplyGate?.release();
    let gallery;
    try {
      gallery = await smokeWindow?.webContents.executeJavaScript(`({
        hidden: document.hidden,
        preview: state.previewId,
        hover: [...document.querySelectorAll('.asset-thumb[data-model-hover-state]')].map(thumb => ({
          asset: thumb.closest('.asset-card').dataset.assetId, state: thumb.dataset.modelHoverState,
          image: thumb.querySelector('.asset-hover-model')?.currentSrc
        }))
      })`);
    } catch {}
    await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), failures, gallery, hoverCalls }, null, 2));
    app.exit(1);
  };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    network.push(details.url); callback({ cancel: true });
  }));

  async function checkGalleryHover(window) {
    const js = code => window.webContents.executeJavaScript(code);
    const layer = '.asset-hover-model';
    const playingLayer = '.asset-thumb[data-model-hover-state="playing"] ' + layer;
    const assets = await js('window.__modelSmoke.imported.snapshot.assets.map(({id, ext}) => ({id, ext}))');
    const first = assets.find(asset => asset.ext === 'fbx') || assets.find(asset => asset.ext === 'glb');
    const second = assets.find(asset => asset.ext === 'gltf');
    assert.ok(first && second, 'Missing model hover fixtures');
    const thumb = id => `.asset-card[data-asset-id="${id}"] .asset-thumb`;
    const moveOutside = async () => {
      const point = await js(`(() => {
        const bounds = document.querySelector('#searchInput').getBoundingClientRect();
        return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
      })()`);
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      await delay(30);
    };
    const hover = async id => {
      await moveOutside();
      const point = await js(`(async () => {
        const card = document.querySelector(${JSON.stringify(thumb(id))});
        if (!card) throw new Error('Missing model card for hover');
        card.scrollIntoView({ block: 'nearest' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bounds = card.getBoundingClientRect();
        const x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2);
        if (!card.contains(document.elementFromPoint(x, y))) throw new Error('Model card thumbnail is not hit-testable: ' + x + ', ' + y);
        return { x, y };
      })()`);
      await delay(50);
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    };
    const playing = id => wait(() => js(`(() => {
      const image = document.querySelector(${JSON.stringify(thumb(id) + '[data-model-hover-state="playing"] ' + layer)});
      return image?.complete && image.naturalWidth > 0 && image.currentSrc;
    })()`), `Model hover did not start for ${id}`);
    const cleared = () => wait(() => js(`!document.querySelector(${JSON.stringify(layer)})`), 'Model hover did not clear');
    const onlyPlaying = id => js(`[...document.querySelectorAll(${JSON.stringify(playingLayer)})].map(node => node.closest('.asset-card').dataset.assetId)`)
      .then(playingIds => assert.deepEqual(playingIds, [id], 'Gallery shows the wrong rotating model'));
    const posterVisible = id => js(`(() => {
      const image = document.querySelector(${JSON.stringify(thumb(id) + ' > img:not(' + layer + ')')});
      return Boolean(image?.complete && image.naturalWidth && getComputedStyle(image).visibility === 'visible');
    })()`);

    await moveOutside();
    await cleared();
    await hover(first.id);
    const firstUrl = await playing(first.id);
    await onlyPlaying(first.id);
    // Sample the center of the model card after the ordinary image hover
    // transition. The compositor capture includes current animated WebP frames.
    await delay(350);
    const crop = await js(`(() => {
      const rect = document.querySelector(${JSON.stringify(thumb(first.id))}).getBoundingClientRect();
      return { x: Math.ceil(rect.x + rect.width * 0.3), y: Math.ceil(rect.y + rect.height * 0.3),
        width: Math.floor(rect.width * 0.4), height: Math.floor(rect.height * 0.4) };
    })()`);
    const frame = async () => (await window.webContents.capturePage(crop)).toPNG();
    const initialFrame = await frame();
    assert.ok(initialFrame.length, 'Model card compositor capture is empty');
    await wait(async () => !(await frame()).equals(initialFrame), 'Model pixels did not change during hover', 5000);
    await moveOutside();
    await cleared();
    assert.ok(await posterVisible(first.id), 'Leaving model hover did not restore its thumbnail');
    await hover(first.id);
    assert.equal(await playing(first.id), firstUrl, 'Repeated hover did not reuse the prepared turntable');
    await moveOutside();
    await cleared();
    hoverReplyGate = { id: first.id, entered: false };
    hoverReplyGate.promise = new Promise(resolve => { hoverReplyGate.release = resolve; });
    await hover(first.id);
    await wait(() => hoverReplyGate.entered, 'Delayed model hover did not reach the reply gate');
    await hover(second.id);
    await playing(second.id);
    hoverReplyGate.release();
    hoverReplyGate = null;
    await delay(300);
    await onlyPlaying(second.id);
    assert.ok(await posterVisible(first.id), 'Switching models did not restore the previous thumbnail');
    await js(`openPreview(${JSON.stringify(second.id)})`);
    await cleared();
    await wait(() => js("document.querySelector('#previewModel').dataset.ready === 'true'"), 'Full model viewer did not open after hover');
    await js('closePreview()');
    return { formats: [first.ext, second.ext], pixelsChanged: true, posterRestored: true, staleHoverReplyIgnored: true, oneHoverPlayer: true,
      fullPreviewStopsHover: true, cachedTurntableReused: true };
  }

  async function checkGalleryWarmup(window) {
    const js = code => window.webContents.executeJavaScript(code);
    const visible = await js(`(() => {
      const oldFocus = document.hasFocus;
      document.hasFocus = () => true;
      window.__restoreModelSmokeFocus = () => { document.hasFocus = oldFocus; };
      const area = document.querySelector('#galleryScroller').getBoundingClientRect();
      const cards = [...document.querySelectorAll('.asset-card')].filter(card => {
        const rect = card.querySelector('.asset-thumb').getBoundingClientRect();
        const width = Math.min(rect.right, area.right) - Math.max(rect.left, area.left);
        const height = Math.min(rect.bottom, area.bottom) - Math.max(rect.top, area.top);
        return width > 0 && height > 0 && width * height >= rect.width * rect.height / 4;
      });
      modelWarmup.viewportChanged();
      return cards.map(card => card.dataset.assetId);
    })()`);
    assert.ok(visible.length, 'No model card visible for idle warmup');
    const start = warmupCalls.length;
    try {
      const warm = await wait(() => warmupCalls.slice(start).find(call => call.done === true), 'Visible gallery models were not warmed while idle', 30000);
      assert.ok(visible.includes(warm.id), 'Warmup rendered a card outside the visible gallery');
      assert.equal(await js("document.querySelectorAll('.asset-hover-model').length"), 0, 'Warmup played a model before hover');
      await wait(() => js("api.taskCenterState().then(state => state.tasks.some(task => task.kind === 'model-preview' && task.status === 'done'))"),
        'Task center did not receive the completed warmup', 3000);
      return { visibleOnly: true, idlePreparedModel: warm.id, thumbnailRemainedStatic: true, taskCenterReportedCompletion: true };
    } finally {
      await js('modelWarmup.pause(); window.__restoreModelSmokeFocus(); delete window.__restoreModelSmokeFocus');
    }
  }

  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      smokeWindow = window;
      window.setSkipTaskbar(true); window.show = () => {}; window.setOpacity(0); window.showInactive();
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
        const galleryWarmup = await checkGalleryWarmup(window);
        const galleryHover = await checkGalleryHover(window);
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
        result = { ok: true, electron: process.versions.electron, ...result, ...ui, galleryWarmup, galleryHover, browserNetworkRequests: network.length };
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
        finished = true;
        app.quit();
      } catch (error) { await fail(error); }
    });
  });
  setTimeout(() => fail(new Error('Model smoke exceeded its time limit')), 280000).unref();
};
