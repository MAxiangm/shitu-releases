'use strict';
module.exports = function configureUiRecoverySmoke({ root, base }) {
  const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell } = require('electron');
  const fixture = require(path.join(base, 'ui-recovery-smoke-fixture.json'));
  const events = [], failures = [], requests = [];
  let finished = false, exhausted = 0;
  const recovery = require(path.join(root, 'src', 'ui-recovery.cjs'));
  const create = recovery.createUiRecovery;
  recovery.createUiRecovery = options => create({ ...options, onDiagnostic: event => {
    events.push(event); options.onDiagnostic?.(event);
  }, onExhausted: detail => { exhausted++; options.onExhausted?.(detail); } });
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows'); app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showMessageBox = async () => ({ response: 1 });
  shell.openPath = shell.openExternal = async () => { throw new Error('Recovery smoke must not open external applications'); };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (detail, callback) => { requests.push(detail.url); callback({ cancel: true }); }));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (condition, message) => {
    const deadline = Date.now() + 12000;
    while (!await condition()) { if (Date.now() > deadline) throw new Error(message); await sleep(25); }
  };
  app.on('browser-window-created', (_event, window) => {
    window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.showInactive(); window.webContents.setBackgroundThrottling(false);
    const js = code => window.webContents.executeJavaScript(code);
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      try {
        const setup = await js(`(async()=>{
          const imported=await api.importPaths([${JSON.stringify(fixture.filename)}]);
          if(imported.report.imported!==1)throw new Error('Fixture image import failed');
          const id=imported.report.assetIds[0];await api.updateAssets([id],{tags:['已保存'],notes:'renderer recovery smoke',rating:4,colorLabel:'#267891'});
          applyLibrary(await api.getLibrary());return {id,root:state.library.root};
        })()`);
        const indexPath = path.join(setup.root, 'index.json'); const beforeIndex = await fs.readFile(indexPath);
        const mainPid = process.pid, windowId = window.id;
        const waitForReload = async action => {
          let reloaded = false; window.webContents.once('did-finish-load', () => { reloaded = true; });
          action(); await wait(() => reloaded, 'Renderer did not recover automatically');
          await wait(() => js(`Boolean(state.library.assets.find(a=>a.id===${JSON.stringify(setup.id)}))`), 'Recovered renderer did not restore library');
        };
        await waitForReload(() => window.webContents.forcefullyCrashRenderer());
        assert.equal(process.pid, mainPid); assert.equal(window.id, windowId);
        assert.ok(events.some(event => event.event === 'reload' && event.source === 'renderer'), 'Main recovery handler did not reload a crashed renderer');
        const restored = await js(`(async()=>{const lib=await api.getLibrary(),a=lib.assets.find(a=>a.id===${JSON.stringify(setup.id)});return {notes:a.notes,tags:a.tags,rating:a.rating,colorLabel:a.colorLabel,filename:a.filename,root:lib.root};})()`);
        assert.deepEqual({ notes: restored.notes, tags: restored.tags, rating: restored.rating, colorLabel: restored.colorLabel }, { notes: 'renderer recovery smoke', tags: ['已保存'], rating: 4, colorLabel: '#267891' });
        assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
        const original = await fs.readFile(path.join(restored.root, restored.filename)); assert.equal(crypto.createHash('sha256').update(original).digest('hex'), fixture.sha256);
        await waitForReload(() => app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 17 }));
        assert.ok(events.some(event => event.event === 'reload' && event.source === 'gpu'), 'Simulated GPU exit did not schedule recovery');
        window.emit('restore'); window.emit('focus'); await sleep(150);
        let screenshotCaptured = false;
        try { const screenshot = await window.webContents.capturePage(); if (!screenshot.isEmpty()) { await fs.writeFile(path.join(base, 'recovered.png'), screenshot.toPNG()); screenshotCaptured = true; } } catch {}
        assert.deepEqual(requests, []); assert.deepEqual(failures, []); assert.equal(exhausted, 0);
        finished = true;
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: true, electron: process.versions.electron, rendererCrashRecovered: true, gpuExitSimulated: true, gpuRecoveryTriggered: true, mainProcessUnchanged: true, windowUnchanged: true, metadataPreserved: true, originalBytesUnchanged: true, indexBytesUnchanged: true, screenshotCaptured, reloads: events.filter(e=>e.event==='reload').length, browserNetworkRequests: requests.length }, null, 2));
        window.destroy(); app.quit();
      } catch (error) {
        finished = true;
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), events, failures }, null, 2)); app.exit(1);
      }
    });
  });
  setTimeout(async () => { if (!finished) { await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: 'UI recovery smoke timed out', events })); app.exit(1); } }, 60000).unref();
};
