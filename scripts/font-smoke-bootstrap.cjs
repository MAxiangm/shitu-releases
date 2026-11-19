'use strict';
module.exports = function configureFontSmoke({ root, base }) {
  const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
  const assert = require('node:assert/strict');
  const sharp = require('sharp');
  const { app, dialog, session, shell } = require('electron');
  const fixture = require(path.join(base, 'font-smoke-fixture.json'));
  const failures = [], network = [];
  let finished = false, activeWindow, nextPicker, nextSavePath;
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => {
    if (!nextPicker) throw new Error('Font smoke must not open a native picker');
    const directory = nextPicker; nextPicker = null;
    return { canceled: false, filePaths: [directory] };
  };
  dialog.showSaveDialog = async () => {
    if (nextSavePath === undefined) throw new Error('Font smoke must not open an unplanned save picker');
    const filePath = nextSavePath; nextSavePath = undefined;
    return filePath === null ? { canceled: true } : { canceled: false, filePath };
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
      const pngBounds = async filename => {
        const { data: pixels, info } = await sharp(filename).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let left = info.width, right = -1, top = info.height, bottom = -1, count = 0;
        for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
          if (pixels[(y * info.width + x) * 4 + 3] <= 16) continue;
          left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
        }
        return { width: info.width, height: info.height, left, right, top, bottom, inkWidth: right - left + 1, inkHeight: bottom - top + 1, count, cornerAlpha: pixels[3] };
      };
      const pngColumnInk = async (filename, divider) => {
        const { data: pixels, info } = await sharp(filename).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const totals = [0, 0];
        for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) totals[x < divider ? 0 : 1] += pixels[(y * info.width + x) * 4 + 3];
        return totals;
      };
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
            // Frameless window border rounding can add two CSS pixels on Windows.
            assert.ok(Math.abs(narrow.width - 1080) <= 2); assert.ok(Math.abs(narrow.height - 700) <= 2); assert.ok(narrow.scrollWidth <= narrow.width + 1);
            for (const item of [narrow.panel, narrow.text, narrow.sample, narrow.face, narrow.reset]) {
              assert.ok(item.width > 0 && item.height > 0); assert.ok(item.left >= -1 && item.right <= narrow.width + 1); assert.ok(item.top >= -1 && item.bottom <= narrow.height + 1);
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
        const layoutAsset = data.assets.find(asset => asset.ext === 'ttf'); assert.ok(layoutAsset);
        await click(`.asset-card[data-asset-id="${layoutAsset.id}"]`, 2); await ready(layoutAsset.id);
        const widthEdit = await js(`(()=>{
          for(const id of ['fontPreviewPaddingLeft','fontPreviewPaddingRight']){const input=document.getElementById(id);input.value='64';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
          const width=document.getElementById('fontPreviewWidth');width.value='2';width.dispatchEvent(new Event('input',{bubbles:true}));width.value='2048';width.dispatchEvent(new Event('input',{bubbles:true}));width.dispatchEvent(new Event('change',{bubbles:true}));
          return{width:fontPreviewLayout.width,left:fontPreviewLayout.paddingLeft,right:fontPreviewLayout.paddingRight};
        })()`);
        assert.deepEqual(widthEdit, { width: 2048, left: 64, right: 64 }, 'Typing an intermediate canvas width changed the margins');
        const presetState = await js(`(()=>{
          const presets=window.ShituFontLayout.PRESETS,preset=presets.find(item=>item.settings.writingMode==='vertical-rl');if(!preset)throw new Error('No vertical preset');
          const before={...fontPreviewLayout},expected=window.ShituFontLayout.applyPreset(preset.id,before),select=document.getElementById('fontPreviewPreset');
          select.value=preset.id;select.dispatchEvent(new Event('change',{bubbles:true}));
          return{expected,actual:{...fontPreviewLayout},id:select.value,expectedId:preset.id,mode:document.getElementById('fontPreviewWritingMode').value,count:presets.length};
        })()`);
        assert.deepEqual(presetState.actual, presetState.expected, 'The preset did not apply its shared settings');
        assert.equal(presetState.id, presetState.expectedId); assert.equal(presetState.mode, 'vertical-rl'); assert.ok(presetState.count >= 5);
        await capture('font-vertical-preset-preview.png');
        await js(`(()=>{
          const values={fontPreviewText:'Mosaic\\nPreview 123',fontPreviewSize:80,fontPreviewWidth:1920,fontPreviewHeight:1080,
            fontPreviewAlign:'center',fontPreviewVerticalAlign:'center',fontPreviewWritingMode:'horizontal-tb',fontPreviewLetterSpacing:8,fontPreviewLineHeight:1.8,
            fontPreviewPaddingTop:70,fontPreviewPaddingRight:100,fontPreviewPaddingBottom:90,fontPreviewPaddingLeft:120,
            fontPreviewTextColor:'#e6385f',fontPreviewBackgroundColor:'#ffffff'};
          for(const [id,value] of Object.entries(values)){const node=document.getElementById(id);if(!node)throw new Error('Missing layout control '+id);node.value=String(value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}
          const transparent=document.getElementById('fontPreviewTransparent');transparent.checked=true;transparent.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        assert.equal(await js(`document.getElementById('fontPreviewPreset').value`), 'custom', 'Manual layout edits did not mark the preset as custom');
        const layoutStyle = await js(`(()=>{const node=document.getElementById('fontPreviewSample'),style=getComputedStyle(node),box=node.getBoundingClientRect();return{text:node.textContent,align:style.textAlign,letterSpacing:style.letterSpacing,lineHeight:style.lineHeight,width:box.width,height:box.height};})()`);
        assert.equal(layoutStyle.text, 'Mosaic\nPreview 123'); assert.equal(layoutStyle.align, 'center'); assert.equal(layoutStyle.letterSpacing, '8px'); assert.equal(layoutStyle.lineHeight, '144px');
        assert.ok(layoutStyle.width > 0 && layoutStyle.height > 0);
        await capture('font-layout-preview.png');
        const layoutPng = path.join(base, 'font-layout-1920x1080.png'); nextSavePath = layoutPng;
        await click('#fontPreviewExport');
        await wait(async () => (await fs.stat(layoutPng).catch(() => null))?.size > 1000, 'Layout PNG was not exported');
        await wait(() => js(`!document.getElementById('fontPreviewExport').disabled`), 'Export button remained disabled');
        const uiPng = await pngBounds(layoutPng);
        assert.equal(uiPng.width, 1920); assert.equal(uiPng.height, 1080); assert.equal(uiPng.cornerAlpha, 0); assert.ok(uiPng.count > 1000);
        const pngSettings = { width: 640, height: 360, fontSize: 64, letterSpacing: 0, lineHeight: 1.4, align: 'left', verticalAlign: 'top',
          paddingTop: 20, paddingRight: 20, paddingBottom: 20, paddingLeft: 20, textColor: '#112233', backgroundColor: '#ffffff', transparent: true };
        const renderPng = async (name, changes = {}, text = 'Mosaic') => {
          const filename = path.join(base, `font-layout-${name}.png`); nextSavePath = filename;
          await js(`api.exportFontImage(${JSON.stringify(layoutAsset.id)},${JSON.stringify(data.root)},${JSON.stringify({ text, faceIndex: 0, settings: { ...pngSettings, ...changes } })})`);
          return pngBounds(filename);
        };
        const leftPng = await renderPng('left'), centerPng = await renderPng('center', { align: 'center' }), rightPng = await renderPng('right', { align: 'right' });
        assert.ok(leftPng.count > 500); assert.equal(leftPng.width, 640); assert.equal(leftPng.height, 360);
        assert.ok(centerPng.left > leftPng.left + 100, 'Center alignment did not move exported glyphs');
        assert.ok(rightPng.left > centerPng.left + 100, 'Right alignment did not move exported glyphs');
        assert.ok(Math.abs((centerPng.left + centerPng.right) / 2 - 320) < 8, 'Center alignment is not centered on the canvas');
        const bottomPng = await renderPng('bottom', { verticalAlign: 'bottom' }), middlePng = await renderPng('middle', { verticalAlign: 'center' });
        assert.ok(middlePng.top > leftPng.top + 80 && bottomPng.top > middlePng.top + 80, 'Vertical alignment did not move exported glyphs');
        const paddedPng = await renderPng('padding', { paddingTop: 50, paddingLeft: 60 });
        assert.ok(Math.abs(paddedPng.left - leftPng.left - 40) <= 1 && Math.abs(paddedPng.top - leftPng.top - 30) <= 1, 'Exported margins did not match requested pixels');
        const spacedPng = await renderPng('spacing', { letterSpacing: 12 });
        assert.ok(spacedPng.inkWidth > leftPng.inkWidth + 40, 'Letter spacing did not widen exported text');
        const closeLines = await renderPng('lines-close', { lineHeight: 1.2 }, 'Mosaic\nMosaic');
        const looseLines = await renderPng('lines-loose', { lineHeight: 2 }, 'Mosaic\nMosaic');
        assert.ok(looseLines.inkHeight > closeLines.inkHeight + 45, 'Line spacing did not increase exported line separation');
        const verticalSettings = { writingMode: 'vertical-rl', fontSize: 48, letterSpacing: 6, lineHeight: 1.6 };
        const verticalPng = await renderPng('vertical-single', verticalSettings, 'ABCD');
        assert.ok(verticalPng.inkHeight > verticalPng.inkWidth * 3 && verticalPng.count > 300, 'Vertical writing did not draw upright glyphs in a column');
        await renderPng('vertical-rl', verticalSettings, 'ABCD\nEFGH');
        await renderPng('vertical-lr', { ...verticalSettings, writingMode: 'vertical-lr' }, 'ABCD\nEFGH');
        const columnDivider = pngSettings.paddingLeft + (verticalSettings.fontSize + verticalSettings.fontSize * verticalSettings.lineHeight) / 2;
        const rlInk = await pngColumnInk(path.join(base, 'font-layout-vertical-rl.png'), columnDivider);
        const lrInk = await pngColumnInk(path.join(base, 'font-layout-vertical-lr.png'), columnDivider);
        const relativeDifference = (a, b) => Math.abs(a - b) / Math.max(a, b, 1);
        assert.ok(rlInk.every(value => value > 10000) && lrInk.every(value => value > 10000), 'Vertical paragraphs did not produce two visible columns');
        assert.ok(relativeDifference(rlInk[0], lrInk[1]) < 0.02 && relativeDifference(rlInk[1], lrInk[0]) < 0.02, 'Vertical left-to-right and right-to-left did not swap paragraph columns');
        assert.ok(relativeDifference(rlInk[0], lrInk[0]) > 0.005, 'Vertical direction produced identical column glyphs');
        const opaquePng = await renderPng('opaque', { transparent: false }); assert.equal(opaquePng.cornerAlpha, 255);
        nextSavePath = null;
        const cancelledPng = await js(`api.exportFontImage(${JSON.stringify(layoutAsset.id)},${JSON.stringify(data.root)},${JSON.stringify({ text: 'Cancel', faceIndex: 0, settings: pngSettings })})`);
        assert.equal(cancelledPng.canceled, true); assert.equal(nextSavePath, undefined);
        await key('Escape'); await wait(() => js('state.previewId===null'), 'Layout preview did not close');
        assert.deepEqual(await js('[...document.fonts].map(face=>face.family)'), data.baselineFonts, 'Layout export retained a FontFace in the main renderer');
        const exported = path.join(base, 'exported'); await fs.mkdir(exported); nextPicker = exported;
        const exportResult = await js(`api.exportAssets(${JSON.stringify(data.assets.map(asset => asset.id))},${JSON.stringify(data.root)})`);
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
          narrowPreviewControlsVisible: true, layoutControls: true, layoutPng1920x1080: true, transparentAndOpaquePng: true,
          exportedHorizontalAndVerticalAlignment: true, exportedMargins: true, exportedLetterAndLineSpacing: true, cancelPngExport: true,
          verticalUprightGlyphs: true, verticalColumnDirection: true, layoutPresetAndCustom: true, intermediateWidthPreservesMargins: true,
          screenshots: ['font-gallery.png', 'font-custom-preview.png', 'font-collection-preview.png', 'font-collection-1080x700.png', 'font-layout-preview.png', 'font-vertical-preset-preview.png'] };
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(report, null, 2)); finished = true; window.destroy(); app.quit();
      } catch (error) { await fail(error); }
    });
  });
};
