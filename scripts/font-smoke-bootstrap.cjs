'use strict';
module.exports = function configureFontSmoke({ root, base }) {
  const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell } = require('electron');
  const fixture = require(path.join(base, 'font-smoke-fixture.json'));
  const failures = [], network = [];
  let finished = false, activeWindow, nextPicker;
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => {
    if (!nextPicker) throw new Error('Font smoke must not open a native picker');
    const directory = nextPicker; nextPicker = null;
    return { canceled: false, filePaths: [directory] };
  };
  shell.openPath = shell.openExternal = async () => { throw new Error('Font smoke must not launch external applications'); };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); }));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (predicate, label, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) { if (Date.now() > deadline) throw new Error(label); await sleep(25); }
  };
  const fail = async error => {
    if (finished) return; finished = true;
    let diagnostic;
    try { diagnostic = await activeWindow.webContents.executeJavaScript(`({previewId:state.previewId,fontState:document.getElementById('previewFont')?.outerHTML,status:document.getElementById('fontPreviewStatus')?.textContent,toasts:document.getElementById('toastStack')?.textContent,assets:state.library.assets})`); } catch {}
    try { await fs.writeFile(path.join(base, 'failure.png'), (await activeWindow.webContents.capturePage()).toPNG()); } catch {}
    await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), diagnostic, failures, network }, null, 2));
    app.exit(1);
  };
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      activeWindow = window;
      window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.setContentSize(1400, 900); window.showInactive();
      window.webContents.setBackgroundThrottling(false);
      window.webContents.on('render-process-gone', (_event, detail) => failures.push(`Renderer exited: ${detail.reason}`));
      const js = async code => {
        try { return await window.webContents.executeJavaScript(code); }
        catch (error) { throw new Error(`${error.message}\nRenderer step: ${code.slice(0, 600)}`); }
      };
      const point = selector => js(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing pointer target '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const box=node.getBoundingClientRect(),x=Math.round(box.left+box.width/2),y=Math.round(box.top+box.height/2),hit=document.elementFromPoint(x,y);if(!hit||!node.contains(hit))throw new Error('Pointer target covered '+${JSON.stringify(selector)});return{x,y};})()`);
      const click = async (selector, count = 1) => {
        const location = await point(selector);
        window.webContents.sendInputEvent({ type: 'mouseMove', ...location });
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: count, ...location });
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: count, ...location }); await sleep(60);
      };
      const key = async keyCode => {
        window.webContents.focus(); window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        if (keyCode === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(60);
      };
      const capture = async filename => {
        window.webContents.invalidate(); await sleep(120); const image = await window.webContents.capturePage();
        assert.equal(image.isEmpty(), false); await fs.writeFile(path.join(base, filename), image.toPNG());
      };
      const ready = id => wait(() => js(`state.previewId===${JSON.stringify(id)}&&document.getElementById('previewFont').dataset.ready==='true'`), `Font did not load: ${id}`);
      const fingerprint = () => js(`(()=>{const c=document.createElement('canvas');c.width=900;c.height=120;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.fillStyle='black';x.font='64px '+getComputedStyle(document.getElementById('fontPreviewSample')).fontFamily;x.fillText('Hamburgefontsiv 0123456789',8,88);let hash=0;for(const value of x.getImageData(0,0,c.width,c.height).data)hash=((hash<<5)-hash+value)|0;return hash;})()`);
      try {
        assert.equal(app.getPath('userData'), path.join(base, 'profile'));
        const data = await js(`(async()=>{
          const initial=await api.getLibrary();if(initial.stats.total!==0)throw new Error('Font test library not empty');
          const baselineFonts=[...document.fonts].map(face=>face.family);
          const imported=await api.importPaths(${JSON.stringify(fixture.samples.map(sample => sample.filename))});
          applyLibrary(imported.snapshot,false);toggleDetails(false);setThumbnailSize(190);render();
          return{root:initial.root,report:imported.report,assets:imported.snapshot.assets,baselineFonts};
        })()`);
        assert.equal(data.report.imported, fixture.samples.length); assert.equal(data.assets.length, fixture.samples.length); assert.equal(data.report.failed?.length || 0, 0);
        for (const asset of data.assets) {
          assert.equal(asset.mediaType, 'font'); assert.ok(asset.thumbnail, `No thumbnail for ${asset.ext}`); assert.ok(asset.font?.family, `No family metadata for ${asset.ext}`);
          assert.ok((await fs.stat(path.join(data.root, asset.thumbnail))).size > 1000);
        }
        await js(`document.getElementById('formatFilter').value='font';document.getElementById('formatFilter').dispatchEvent(new Event('change',{bubbles:true}));`);
        assert.equal(await js('filteredAssets().length'), fixture.samples.length);
        await capture('font-gallery.png');
        const previews = [];
        for (const sample of fixture.samples) {
          const asset = data.assets.find(item => item.hash === sample.hash); assert.ok(asset);
          await click(`.asset-card[data-asset-id="${asset.id}"]`, 2); await ready(asset.id);
          const current = await js(`({status:fontPreviewSession.face.status,family:fontPreviewSession.face.family,ready:document.getElementById('previewFont').dataset.ready,visible:!document.getElementById('fontPreviewSample').classList.contains('hidden'),loaded:[...document.fonts].some(face=>face===fontPreviewSession.face),text:document.getElementById('fontPreviewSample').textContent,faces:fontPreviewSession.prepared.faces.length})`);
          assert.equal(current.status, 'loaded'); assert.equal(current.loaded, true); assert.equal(current.visible, true); assert.ok(current.text.trim());
          previews.push({ ext: sample.ext, loaded: true, faceCount: current.faces });
          await js(`document.getElementById('fontPreviewText').value='Custom preview <b> Aa 123';document.getElementById('fontPreviewText').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('fontPreviewSize').value='96';document.getElementById('fontPreviewSize').dispatchEvent(new Event('input',{bubbles:true}));`);
          assert.deepEqual(await js(`({text:document.getElementById('fontPreviewSample').textContent,size:getComputedStyle(document.getElementById('fontPreviewSample')).fontSize,html:document.getElementById('fontPreviewSample').innerHTML})`), { text: 'Custom preview <b> Aa 123', size: '96px', html: 'Custom preview &lt;b&gt; Aa 123' });
          await js(`document.getElementById('fontPreviewText').focus();`); await key('ArrowLeft');
          assert.equal(await js('state.previewId'), asset.id, 'Text editing navigated to another asset');
          const textLength = await js(`document.getElementById('fontPreviewText').value.length`);
          await key('Space');
          assert.equal(await js('state.previewId'), asset.id, 'Typing Space closed the font preview');
          assert.equal(await js(`document.getElementById('fontPreviewText').value.length`), textLength + 1, 'Space was swallowed by the preview keyboard handler');
          if (sample.ext === 'ttc') {
            assert.equal(current.faces, 2); assert.equal(await js(`document.getElementById('fontPreviewFaceField').classList.contains('hidden')`), false);
            const firstShape = await fingerprint();
            await js(`document.getElementById('fontPreviewFace').value='1';document.getElementById('fontPreviewFace').dispatchEvent(new Event('change',{bubbles:true}));`);
            await wait(() => js(`document.getElementById('previewFont').dataset.ready==='true'&&document.getElementById('previewFont').dataset.faceIndex==='1'`), 'Collection face did not switch');
            assert.notEqual(await fingerprint(), firstShape, 'TTC styles rendered identical glyphs');
            await capture('font-collection-preview.png');
            window.setContentSize(1080, 700); await sleep(140);
            const narrow = await js(`(()=>{const rect=id=>{const b=document.querySelector(id).getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};};return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,panel:rect('#previewFont'),text:rect('#fontPreviewText'),sample:rect('#fontPreviewSample'),face:rect('#fontPreviewFace'),reset:rect('#fontPreviewReset')};})()`);
            assert.equal(narrow.width, 1080); assert.equal(narrow.height, 700); assert.ok(narrow.scrollWidth <= 1081);
            for (const item of [narrow.panel, narrow.text, narrow.sample, narrow.face, narrow.reset]) {
              assert.ok(item.width > 0 && item.height > 0); assert.ok(item.left >= -1 && item.right <= 1081); assert.ok(item.top >= -1 && item.bottom <= 701);
            }
            await capture('font-collection-1080x700.png');
            window.setContentSize(1400, 900); await sleep(100);
            await js(`void loadFontPreviewFace(0);void loadFontPreviewFace(1);void loadFontPreviewFace(0);`);
            await wait(() => js(`document.getElementById('previewFont').dataset.ready==='true'&&document.getElementById('previewFont').dataset.faceIndex==='0'`), 'Rapid face selection ended on stale face');
          }
          if (sample.ext === 'ttf') await capture('font-custom-preview.png');
          await js(`document.getElementById('fontPreviewReset').focus();`); await key('Space');
          assert.equal(await js('state.previewId'), asset.id, 'Space on the reset button closed the font preview');
          assert.equal(await js(`document.getElementById('fontPreviewText').value===fontPreviewSession.prepared.sampleText`), true, 'Keyboard activation did not restore the font sample');
          await key('Escape'); await wait(() => js('state.previewId===null'), 'Escape failed to close font preview');
          assert.deepEqual(await js('[...document.fonts].map(face=>face.family)'), data.baselineFonts, 'Closed preview retained a loaded FontFace');
        }
        const exported = path.join(base, 'exported'); await fs.mkdir(exported); nextPicker = exported;
        const exportResult = await js(`api.exportAssets(${JSON.stringify(data.assets.map(asset => asset.id))})`);
        assert.equal(exportResult.count, fixture.samples.length);
        const exportedHashes = await Promise.all((await fs.readdir(exported)).map(async name => crypto.createHash('sha256').update(await fs.readFile(path.join(exported, name))).digest('hex')));
        assert.deepEqual(exportedHashes.sort(), fixture.samples.map(sample => sample.hash).sort());
        const oldPrepared = await js(`api.prepareFont(${JSON.stringify(data.assets[0].id)},${JSON.stringify(data.root)})`);
        const createTarget = path.join(base, 'other-library-parent'); await fs.mkdir(createTarget); nextPicker = createTarget;
        const switched = await js('(async()=>{const result=await api.createLibrary();applyLibrary(result.snapshot);return result.snapshot;})()');
        assert.notEqual(switched.root, data.root); assert.equal(switched.assets.length, 0);
        assert.equal(await js(`(async()=>{try{await api.prepareFont(${JSON.stringify(data.assets[0].id)},${JSON.stringify(data.root)});return false;}catch{return true;}})()`), true, 'Stale library request was accepted');
        assert.equal(await js(`fetch(${JSON.stringify(oldPrepared.url)}).then(response=>response.status)`), 404, 'Old font URL remained readable after library switch');
        assert.deepEqual(failures, []); assert.deepEqual(network, []);
        const report = { ok: true, electron: process.versions.electron, formats: previews, actualFontFaceLoaded: true, actualThumbnails: true, customTextAndSize: true,
          escapedText: true, textEditingKeepsAsset: true, nativeSpaceTypingAndResetButton: true, collectionStyleGlyphsDiffer: true, rapidFaceSwitchNotStale: true, closeRemovesFontFace: true,
          fontFilter: true, exportedOriginalHashesMatch: true, staleLibraryAndURLRejected: true, networkRequests: 0,
          narrowPreviewControlsVisible: true,
          screenshots: ['font-gallery.png', 'font-custom-preview.png', 'font-collection-preview.png', 'font-collection-1080x700.png'] };
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(report, null, 2)); finished = true; window.destroy(); app.quit();
      } catch (error) { await fail(error); }
    });
  });
};
