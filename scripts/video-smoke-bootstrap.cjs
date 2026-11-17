'use strict';

module.exports = function configureVideoSmoke({ root, base }) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { app, dialog, net } = require('electron');
  const fixture = JSON.parse(fs.readFileSync(path.join(base, 'video-smoke-fixture.json'), 'utf8'));
  const resultPath = path.join(base, 'result.json');
  const failures = [];
  let engine, collectorInstance, engineShutdown = false, collectorClosed = false, uiResult;
  assert.equal(app.isPackaged, false, 'Video smoke keeps production updates disabled.');
  net.fetch = async () => { throw new Error('Video smoke refuses network requests.'); };
  dialog.showErrorBox = (title, content) => failures.push(`${title}: ${content}`);
  const collector = require(path.join(root, 'src', 'collector.cjs'));
  collector.createCollector = () => (collectorInstance = {
    start: async () => ({}), info: () => ({ enabled: false, baseUrl: null, code: null }),
    activeCount: () => 0, close: async () => { collectorClosed = true; }
  });
  const videoModule = require(path.join(root, 'src', 'video-engine.cjs'));
  const createEngine = videoModule.createVideoEngine;
  videoModule.createVideoEngine = options => {
    engine = createEngine(options);
    const preview = engine.preview;
    engine.preview = async (source, settings) => {
      // Make the AVI result deterministically arrive after a later MKV result.
      if (source.toLowerCase().endsWith('.avi')) await new Promise(resolve => setTimeout(resolve, 180));
      return preview(source, settings);
    };
    const shutdown = engine.shutdown;
    engine.shutdown = async () => { await shutdown(); engineShutdown = true; };
    return engine;
  };
  const fail = error => {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: error.stack || String(error), failures }, null, 2));
    Promise.resolve(engine?.shutdown()).finally(() => app.exit(1));
  };
  app.on('before-quit', () => {
    if (!uiResult) return;
    fs.writeFileSync(resultPath, JSON.stringify({
      ok: true, electron: process.versions.electron, quitObserved: true, engineShutdown,
      collectorClosed, networkAccessed: false, userData: app.getPath('userData'), ...uiResult
    }, null, 2) + '\n');
  });
  app.on('browser-window-created', (_event, window) => {
    window.show = () => {};
    window.setSkipTaskbar(true);
    window.setOpacity(0);
    window.showInactive();
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('console-message', event => {
      if (event.level === 'error' || event.level === 3) failures.push(event.message);
    });
    window.webContents.on('render-process-gone', (_event, details) => failures.push(JSON.stringify(details)));
    window.webContents.once('did-finish-load', async () => {
      try {
        uiResult = await window.webContents.executeJavaScript(`(async () => {
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const waitFor = async (condition, message, timeout = 20000) => {
            const started = Date.now();
            while (!condition()) { if (Date.now() - started > timeout) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 25)); }
          };
          const loadImage = url => new Promise((resolve, reject) => {
            const image = new Image(); const timer = setTimeout(() => reject(new Error('Thumbnail load timed out')), 10000);
            image.onload = () => { clearTimeout(timer); image.naturalWidth > 0 ? resolve() : reject(new Error('Empty thumbnail')); };
            image.onerror = () => { clearTimeout(timer); reject(new Error('Thumbnail failed')); }; image.src = url;
          });
          const files = ${JSON.stringify(fixture.files)};
          const api = window.shitu;
          check(api && typeof api.prepareVideo === 'function', 'Video preview API missing');
          const initial = await api.getLibrary(); check(initial.stats.total === 0, 'Video smoke library is not empty');
          const imported = await api.importPaths(files.map(file => file.filename));
          check(imported.report.imported === files.length && !imported.report.errors.length, 'Video imports failed');
          const snapshot = imported.snapshot;
          const assets = files.map(file => {
            const asset = snapshot.assets.find(item => item.hash === file.sha256);
            check(asset && asset.mediaType === 'video', 'Video was misclassified: ' + file.kind);
            check(asset.codec === file.expectedCodec, 'Source codec mismatch: ' + file.kind);
            check(asset.width > 0 && asset.height > 0 && asset.duration > 0 && asset.thumbnail, 'Video metadata or thumbnail missing: ' + file.kind);
            return { ...asset, fixtureKind: file.kind };
          });
          for (const asset of assets) await loadImage(api.assetUrl(asset.id, 'thumbnail'));
          const decoded = [];
          for (const asset of assets) {
            const prepared = await api.prepareVideo(asset.id, snapshot.root);
            const video = document.createElement('video'); video.preload = 'auto'; video.muted = true; video.src = prepared.url;
            document.body.append(video);
            try {
              await waitFor(() => video.readyState >= 2 || video.error, 'Prepared video did not load: ' + asset.fixtureKind);
              check(!video.error && video.videoWidth > 0 && video.videoHeight > 0, 'Chromium could not decode ' + asset.fixtureKind);
              if (asset.fixtureKind !== 'dxv') {
                video.loop = true;
                await Promise.race([video.play(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Video playback timed out: ' + asset.fixtureKind)), 15000))]);
                await new Promise(resolve => setTimeout(resolve, 120));
                check(!video.error && !video.paused, 'Chromium could not play ' + asset.fixtureKind);
                video.pause();
                let seeked = false; video.addEventListener('seeked', () => { seeked = true; }, { once: true });
                video.currentTime = Math.min(0.4, video.duration / 2);
                await waitFor(() => seeked || video.error, 'Video seeking failed: ' + asset.fixtureKind);
                check(!video.error, 'Seek produced a decode error');
              }
              decoded.push({ kind: asset.fixtureKind, sourceCodec: asset.codec, reportedCodec: prepared.codec, mimeType: prepared.mimeType,
                width: video.videoWidth, height: video.videoHeight, duration: video.duration, playbackStarted: asset.fixtureKind !== 'dxv' });
            } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); }
          }
          applyLibrary(snapshot, false);
          check(document.querySelectorAll('.asset-card video').length === 0, 'Gallery must use thumbnails instead of video elements');
          check(document.querySelectorAll('.asset-card img').length === files.length, 'Gallery is missing generated thumbnails');
          const avi = assets.find(asset => asset.fixtureKind === 'avi');
          const mkv = assets.find(asset => asset.fixtureKind === 'mkv');
          const dxv = assets.find(asset => asset.fixtureKind === 'dxv');
          openPreview(avi.id);
          displayPreviewAsset(mkv, 1, assets.length);
          const focused = document.getElementById('previewVideo');
          await waitFor(() => state.previewId === mkv.id && focused.readyState >= 2 && !focused.classList.contains('hidden'), 'Fast video switch did not resolve to MKV');
          await new Promise(resolve => setTimeout(resolve, 400));
          check(decodeURIComponent(new URL(focused.currentSrc || focused.src).pathname.slice(1)) === mkv.id, 'Stale AVI request replaced the active video');
          closePreview();
          check(focused.paused && !focused.hasAttribute('src') && state.previewId === null, 'Closing preview did not stop video');
          openPreview(dxv.id);
          await waitFor(() => state.previewId === dxv.id && focused.readyState >= 2 && !focused.classList.contains('hidden'), 'DXV UI preview did not load');
          check(focused.controls && focused.muted && focused.loop, 'Video controls, mute and loop were not preserved');
          await Promise.race([
            new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            new Promise(resolve => setTimeout(resolve, 250))
          ]);
          return { imported: imported.report.imported, thumbnailsLoaded: assets.length, decoded, galleryUsesThumbnails: true,
            stalePreviewIgnored: true, closeStopsPlayback: true, dxvUserInterface: true, controls: focused.controls,
            library: snapshot.root, managedOriginals: assets.map(asset => ({ path: asset.filename, sha256: asset.hash })) };
        })()`);
        assert.deepEqual(failures, []);
        // Capturing pixels is optional on machines without an active display.
        // The real decoder, media elements, seeking and IPC assertions above still run.
        try {
          await window.webContents.capturePage();
          await new Promise(resolve => setTimeout(resolve, 350));
          fs.writeFileSync(path.join(base, 'screenshot.png'), (await window.webContents.capturePage()).toPNG());
          uiResult.screenshotCaptured = true;
        } catch (error) {
          uiResult.screenshotCaptured = false;
          uiResult.screenshotNote = error.message;
        }
        await window.webContents.executeJavaScript('closePreview()');
        const crypto = require('node:crypto');
        for (const file of uiResult.managedOriginals) {
          const bytes = fs.readFileSync(path.join(uiResult.library, file.path));
          assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256);
        }
        uiResult.managedOriginalsUnchanged = true;
        await engine.shutdown();
        await collectorInstance.close();
        app.quit();
      } catch (error) {
        try { fs.writeFileSync(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
        fail(error);
      }
    });
  });
  setTimeout(() => fail(new Error('Video smoke test timed out')), 120000).unref();
};
