'use strict';
module.exports = function configureHoverVideoSmoke({ root, base }) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell, ipcMain } = require('electron');
  const fixture = require(path.join(base, 'hover-video-smoke-fixture.json'));
  const resultPath = path.join(base, 'result.json'), failures = [], requests = [], previewStarts = [];
  let completed = false, engine, responseGate, engineGate, lastWindow;
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(base, 'second-library')] });
  shell.openPath = async () => { throw new Error('Hover smoke must not launch external applications'); };
  shell.openExternal = async () => { throw new Error('Hover smoke must not open a browser'); };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
    const result = await listener(...args);
    const gate = responseGate;
    if (channel === 'shitu:prepare-video' && gate && args[1] === gate.id) { gate.entered = true; await gate.promise; }
    return result;
  });
  const videoModule = require(path.join(root, 'src', 'video-engine.cjs'));
  const createVideoEngine = videoModule.createVideoEngine;
  videoModule.createVideoEngine = options => {
    engine = createVideoEngine(options);
    const preview = engine.preview;
    engine.preview = async (source, options) => {
      previewStarts.push(source);
      const gate = engineGate;
      if (gate && source.toLowerCase().endsWith(gate.extension)) {
        gate.entered = true; gate.signal = options.signal;
        await gate.promise;
      }
      return preview(source, options);
    };
    return engine;
  };
  const gateFor = extra => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { ...extra, entered: false, promise, release };
  };
  const wait = async (condition, label, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (!await condition()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  const fail = async error => {
    if (completed) return; completed = true;
    responseGate?.release(); engineGate?.release();
    try { if (lastWindow && !lastWindow.isDestroyed()) await fs.writeFile(path.join(base, 'failure.png'), (await lastWindow.webContents.capturePage()).toPNG()); } catch {}
    let diagnostic;
    try { diagnostic = await lastWindow.webContents.executeJavaScript(`({hidden:document.hidden,visibility:document.visibilityState,width:innerWidth,height:innerHeight,flags:{selectionMode:state.selectionMode,previewId:state.previewId,busy:state.busy,libraryChanging:state.libraryChanging,draggingAssets,deletingAssets,closing,root:state.library.root,libraryCount:state.library.assets.length},overlays:[...document.querySelectorAll('.modal-overlay:not(.hidden),.preview:not(.hidden),.sp-overlay:not([hidden])')].map(n=>n.id),pointer:window.__hoverPointer,lastMove:window.__hoverMove,thumbs:[...document.querySelectorAll('.asset-thumb')].map(n=>({id:n.closest('.asset-card').dataset.assetId,hover:n.dataset.videoHoverState,rect:{x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}}))})`); } catch {}
    await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error.stack || String(error), failures, previewStarts: previewStarts.length, diagnostic }, null, 2));
    await engine?.shutdown(); app.exit(1);
  };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { requests.push(details.url); callback({ cancel: true }); }));
  app.on('browser-window-created', (_event, window) => {
    lastWindow = window;
    window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.setSize(1280, 900); window.showInactive();
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('render-process-gone', (_event, details) => failures.push('Renderer exited: ' + details.reason));
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      const js = code => window.webContents.executeJavaScript(code);
      const moveOutside = async () => { window.webContents.sendInputEvent({ type: 'mouseMove', x: 15, y: 15 }); await new Promise(resolve => setTimeout(resolve, 30)); };
      const hover = async id => {
        await moveOutside();
        const point = await js(`(async () => { const node = document.querySelector('.asset-card[data-asset-id="${id}"] .asset-thumb'); if (!node) throw new Error('Missing hover card'); node.scrollIntoView({block:'nearest'}); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); await new Promise(resolve=>setTimeout(resolve,50)); const r=node.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
        window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        return point;
      };
      const playing = async (id, advancing = true) => js(`(async () => {
        const { wait, check } = window.__hoverSmoke;
        const card = document.querySelector('.asset-card[data-asset-id="${id}"]');
        // The official DXV regression fixture contains one frame. Require a
        // frame actually presented by Chromium instead of time advancement.
        await wait(() => { const v=card.querySelector('video.asset-hover-video'); return v && ${advancing ? 'v.readyState>=2 && !v.paused' : 'v.videoWidth>0 && v.videoHeight>0 && !v.error && v.getVideoPlaybackQuality().totalVideoFrames>0'} && card.querySelector('.asset-thumb').dataset.videoHoverState==='playing'; }, 'Hover playback failed: ${id}');
        const video=card.querySelector('video.asset-hover-video');
        check(video.muted && video.loop && !video.controls, 'Hover video must be muted, looped, and without controls');
        check(document.querySelectorAll('.asset-hover-video').length===1, 'More than one hover player exists');
        ${advancing ? "const start=video.currentTime; await wait(() => video.currentTime > start+0.1 || video.currentTime < start, 'Hover video time did not advance');" : ''}
        return {width:video.videoWidth,height:video.videoHeight,currentTime:video.currentTime,framesPresented:video.getVideoPlaybackQuality().totalVideoFrames,timeAdvancementChecked:${advancing}};
      })()`);
      const stopped = async () => js(`window.__hoverSmoke.wait(() => document.querySelectorAll('.asset-hover-video').length===0, 'Hover player did not release')`);
      try {
        assert.equal(app.getPath('userData'), path.join(base, 'profile'));
        const setup = await js(`(async () => {
          const check=(condition,label)=>{if(!condition)throw new Error(label)};
          const wait=async(predicate,label)=>{const deadline=Date.now()+15000;while(!await predicate()){if(Date.now()>deadline)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,20));}};
          const files=${JSON.stringify(fixture.files)}, initial=await api.getLibrary(); check(initial.stats.total===0,'Hover library must be empty');
          const imported=await api.importPaths(files.map(file=>file.filename)); check(imported.report.imported===files.length && !imported.report.errors.length,'Fixture import failed');
          const assets=Object.fromEntries(files.map(file=>[file.kind,imported.snapshot.assets.find(asset=>asset.hash===file.hash)]));
          check(Object.values(assets).every(Boolean),'Imported fixtures missing'); applyLibrary(imported.snapshot,false);
          window.__hoverSmoke={check,wait,assets,snapshot:imported.snapshot,retired:[]};
          window.__hoverPointer=[];
          document.addEventListener('pointerenter',event=>{window.__hoverPointer.push({id:event.target.id,cls:event.target.className,type:event.pointerType});},true);
          document.addEventListener('mousemove',event=>{window.__hoverMove={x:event.clientX,y:event.clientY,cls:event.target.className};},true);
          new MutationObserver(records=>records.forEach(record=>record.removedNodes.forEach(node=>{if(node.nodeType===1){if(node.matches('.asset-hover-video'))window.__hoverSmoke.retired.push(node);window.__hoverSmoke.retired.push(...node.querySelectorAll('.asset-hover-video'));}}))).observe(document.getElementById('gallery'),{childList:true,subtree:true});
          await wait(()=>document.querySelectorAll('.asset-card').length===files.length,'Gallery cards missing');
          check(document.querySelectorAll('.asset-hover-video').length===0,'Hover players must be lazy');
          return {ids:Object.fromEntries(Object.entries(assets).map(([kind,asset])=>[kind,asset.id])),root:initial.root,originals:imported.snapshot.assets.map(asset=>({filename:asset.filename,hash:asset.hash}))};
        })()`);
        const { ids } = setup, decoded = [];
        for (const kind of ['native', 'converted', ...(ids.dxv ? ['dxv'] : [])]) {
          await hover(ids[kind]);
          decoded.push({ kind, ...await playing(ids[kind], kind !== 'dxv') });
          await moveOutside(); await stopped();
          await js(`(() => { const card=document.querySelector('.asset-card[data-asset-id="${ids[kind]}"]'); window.__hoverSmoke.check(card.querySelector('img')&&!card.querySelector('img').classList.contains('hidden'),'Thumbnail did not return'); })()`);
        }
        // Passing over a thumbnail must not launch a conversion.
        const sweepStarts = previewStarts.length;
        await hover(ids.converted); await moveOutside(); await new Promise(resolve => setTimeout(resolve, 280));
        assert.equal(previewStarts.length, sweepStarts, 'Brief hover started video preparation');
        // Delay the successful IPC reply after preparation, then switch assets.
        responseGate = gateFor({ id: ids.converted });
        await hover(ids.converted); await wait(() => responseGate.entered, 'Delayed preview did not reach response gate');
        await hover(ids.native); await playing(ids.native);
        responseGate.release(); responseGate = null;
        await new Promise(resolve => setTimeout(resolve, 250));
        await js(`window.__hoverSmoke.check(document.querySelector('.asset-hover-video')?.closest('.asset-card')?.dataset.assetId==='${ids.native}','Late preview replaced newer hover')`);
        await moveOutside(); await stopped();
        // Leaving during preparation must cancel its exact lease.
        engineGate = gateFor({ extension: '.avi' });
        await hover(ids.converted); await wait(() => engineGate.entered, 'Cold prepare did not reach engine gate');
        await moveOutside(); await wait(() => engineGate.signal.aborted, 'Leaving hover did not cancel preparation');
        engineGate.release(); engineGate = null; await stopped();
        // Opening the full viewer while preparation is pending must retain the job.
        engineGate = gateFor({ extension: '.avi' });
        await hover(ids.converted); await wait(() => engineGate.entered, 'Full-viewer transfer did not reach engine gate');
        await js(`openPreview('${ids.converted}')`);
        await stopped();
        engineGate.release(); engineGate = null;
        await js(`(async()=>{const {wait,check}=window.__hoverSmoke;const v=document.getElementById('previewVideo');await wait(()=>state.previewId==='${ids.converted}'&&v.readyState>=2&&!v.classList.contains('hidden'),'Full preview failed after hover transfer');check(v.controls,'Full preview controls missing');closePreview();})()`);
        // Real click selection remains available through the video overlay.
        const point = await hover(ids.native); await playing(ids.native);
        await new Promise(resolve => setTimeout(resolve, 120));
        await fs.writeFile(path.join(base, 'hover-playing.png'), (await window.webContents.capturePage()).toPNG());
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
        await js(`window.__hoverSmoke.wait(()=>state.selected.has('${ids.native}'),'Hover overlay blocked card selection')`);
        await moveOutside(); await stopped();
        const selectionStarts = previewStarts.length;
        await js('setSelectionMode(true)'); await hover(ids.native); await new Promise(resolve => setTimeout(resolve, 350));
        assert.equal(previewStarts.length, selectionStarts, 'Selection mode started hover playback');
        await js('setSelectionMode(false)');
        // Closing a pending foreground video must allow another hover to start.
        engineGate = gateFor({ extension: '.avi' });
        await js(`openPreview('${ids.converted}')`);
        await wait(() => engineGate.entered, 'Pending foreground preview did not reach gate');
        await js('closePreview()');
        await hover(ids.native); await playing(ids.native);
        await wait(() => engineGate.signal.aborted, 'Closed full viewer kept priority over a new hover');
        engineGate.release(); engineGate = null;
        await moveOutside(); await stopped();
        for (const [name, action] of [
          ['blur', `window.dispatchEvent(new Event('blur'))`],
          ['scroll', `document.getElementById('galleryScroller').dispatchEvent(new Event('scroll'))`],
          ['rerender', `renderGallery(filteredAssets())`],
          ['modal', `showAppUpdate()`]
        ]) {
          await hover(ids.native); await playing(ids.native); await js(action); await stopped();
          if (name === 'modal') await js('closeAppUpdate()');
        }
        await hover(ids.image); await new Promise(resolve => setTimeout(resolve, 300)); await stopped();
        // A real library switch invalidates pending playback and its response.
        const { Library } = require(path.join(root, 'src', 'library.cjs'));
        await new Library({ root: path.join(base, 'second-library') }).init();
        responseGate = gateFor({ id: ids.converted });
        await hover(ids.converted); await wait(() => responseGate.entered, 'Library switch did not reach response gate');
        await js(`(async()=>{const next=await api.openLibrary();applyLibrary(next.snapshot,false);})()`);
        responseGate.release(); responseGate = null; await stopped();
        await new Promise(resolve => setTimeout(resolve, 250));
        const result = await js(`(() => { const {check,retired}=window.__hoverSmoke;check(state.library.assets.length===0,'Second library not selected');check(retired.length>0&&retired.every(v=>v.paused&&!v.hasAttribute('src')),'Retired hover videos retain playback resources');check(document.querySelectorAll('.asset-hover-video').length===0,'Late reply revived video after library switch');return {retiredPlayersReleased:retired.length};})()`);
        for (const file of setup.originals) assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(setup.root, file.filename))).digest('hex'), file.hash, 'Managed original changed');
        assert.deepEqual(failures, []); assert.deepEqual(requests, []);
        completed = true;
        await fs.writeFile(resultPath, JSON.stringify({ ok: true, electron: process.versions.electron, nativeMouseEvents: true, decoded, lazyPlayers: true, briefHoverSkipped: true, onePlayerOnly: true, staleReplyIgnored: true, leaveCancelsPreparation: true, fullPreviewTransfer: true, closedViewerAllowsHover: true, clickSelection: true, selectionModeSuppressed: true, blurStops: true, scrollStops: true, rerenderStops: true, modalStops: true, imagesUnaffected: true, librarySwitchStops: true, screenshotCaptured: true, managedOriginalsUnchanged: true, networkAccessed: false, ...result }, null, 2) + '\n');
        await engine.shutdown(); window.destroy(); app.quit();
      } catch (error) { await fail(error); }
    });
  });
  setTimeout(() => fail(new Error('Hover video UI smoke timed out')), 110000).unref();
};
