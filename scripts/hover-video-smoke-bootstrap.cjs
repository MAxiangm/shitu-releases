'use strict';
module.exports = function configureHoverVideoSmoke({ root, base }) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell, ipcMain } = require('electron');
  const fixture = require(path.join(base, 'hover-video-smoke-fixture.json'));
  const resultPath = path.join(base, 'result.json'), failures = [], requests = [], previewStarts = [], viewerCalls = [];
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
    if (channel === 'shitu:prepare-video') viewerCalls.push({ id: args[1], profile: args[4] || 'full' });
    const result = await listener(...args);
    const gate = responseGate;
    if (channel === 'shitu:prepare-video' && gate && args[1] === gate.id && (!gate.profile || args[4] === gate.profile)) { gate.entered = true; await gate.promise; }
    return result;
  });
  const videoModule = require(path.join(root, 'src', 'video-engine.cjs'));
  const createVideoEngine = videoModule.createVideoEngine;
  videoModule.createVideoEngine = options => {
    engine = createVideoEngine(options);
    const wrapPreview = (method, profile) => async (source, options) => {
      previewStarts.push({ source, profile });
      const gate = engineGate;
      if (gate && source.toLowerCase().endsWith(gate.extension) && (!gate.profile || gate.profile === profile)) {
        gate.entered = true; gate.signal ||= options.signal; gate.signals ||= []; gate.signals.push(options.signal);
        await gate.promise;
        if (gate.error) throw new Error(gate.error);
      }
      return method.call(engine, source, options);
    };
    engine.preview = wrapPreview(engine.preview, 'full');
    engine.hoverPreview = wrapPreview(engine.hoverPreview, 'hover');
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
        const readyAt=performance.now();
        const video=card.querySelector('video.asset-hover-video');
        check(video.muted && video.loop && !video.controls, 'Hover video must be muted, looped, and without controls');
        check(document.querySelectorAll('.asset-hover-video').length===1, 'More than one hover player exists');
        ${advancing ? "const start=video.currentTime; await wait(() => video.currentTime > start+0.1 || video.currentTime < start, 'Hover video time did not advance');" : ''}
        return {width:video.videoWidth,height:video.videoHeight,currentTime:video.currentTime,framesPresented:video.getVideoPlaybackQuality().totalVideoFrames,timeAdvancementChecked:${advancing},duration:video.duration,latencyMs:Math.round(readyAt-(window.__hoverSmoke.starts['${id}']||readyAt))};
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
          window.__hoverSmoke={check,wait,assets,snapshot:imported.snapshot,retired:[],starts:{}};
          window.__hoverPointer=[];
          document.addEventListener('pointerenter',event=>{window.__hoverPointer.push({id:event.target.id,cls:event.target.className,type:event.pointerType});if(event.target.matches?.('.asset-thumb'))window.__hoverSmoke.starts[event.target.closest('.asset-card').dataset.assetId]=performance.now();},true);
          document.addEventListener('mousemove',event=>{window.__hoverMove={x:event.clientX,y:event.clientY,cls:event.target.className};},true);
          new MutationObserver(records=>records.forEach(record=>record.removedNodes.forEach(node=>{if(node.nodeType===1){if(node.matches('.asset-hover-video'))window.__hoverSmoke.retired.push(node);window.__hoverSmoke.retired.push(...node.querySelectorAll('.asset-hover-video'));}}))).observe(document.getElementById('gallery'),{childList:true,subtree:true});
          await wait(()=>document.querySelectorAll('.asset-card').length===files.length,'Gallery cards missing');
          check(document.querySelectorAll('.asset-hover-video').length===0,'Hover players must be lazy');
          return {ids:Object.fromEntries(Object.entries(assets).map(([kind,asset])=>[kind,asset.id])),root:initial.root,originals:imported.snapshot.assets.map(asset=>({filename:asset.filename,hash:asset.hash}))};
        })()`);
        const { ids } = setup, decoded = [];
        for (const kind of ['native', 'webm', 'converted', ...(ids.dxv ? ['dxv'] : []), 'longDxv']) {
          await hover(ids[kind]);
          decoded.push({ kind, ...await playing(ids[kind], kind !== 'dxv') });
          await moveOutside(); await stopped();
          await js(`(() => { const card=document.querySelector('.asset-card[data-asset-id="${ids[kind]}"]'); window.__hoverSmoke.check(card.querySelector('img')&&!card.querySelector('img').classList.contains('hidden'),'Thumbnail did not return'); })()`);
        }
        const longCold = decoded.find(item => item.kind === 'longDxv');
        assert.ok(longCold.duration <= 6.2, 'Hover encoded the entire 24-second source instead of a short preview');
        assert.ok(longCold.width <= 640 && longCold.height <= 360, 'Hover proxy is unnecessarily large');
        assert.ok(longCold.latencyMs < 6000, 'Small cold DXV hover took too long');
        await hover(ids.longDxv);
        const longWarm = await playing(ids.longDxv);
        assert.ok(longWarm.latencyMs < 1500, 'Cached hover should start promptly');
        await moveOutside(); await stopped();
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
        // Full playback must replace a pending short hover with a full-quality request.
        engineGate = gateFor({ extension: '.avi' });
        await hover(ids.converted); await wait(() => engineGate.entered, 'Full-viewer transfer did not reach engine gate');
        await js(`openPreview('${ids.converted}')`);
        await stopped();
        await wait(() => engineGate.signals?.length >= 2, 'Full viewer did not request a separate full preview');
        assert.equal(engineGate.signals[0].aborted, true, 'Full viewer left the obsolete short hover running');
        assert.equal(engineGate.signals[1].aborted, false, 'Full viewer was cancelled by the outgoing hover');
        engineGate.release(); engineGate = null;
        await js(`(async()=>{const {wait,check}=window.__hoverSmoke;const v=document.getElementById('previewVideo');await wait(()=>state.previewId==='${ids.converted}'&&v.readyState>=2&&v.controls&&!v.classList.contains('hidden'),'Full preview failed after hover transfer');check(v.dataset.previewOnly==='false','Full preview incorrectly marked as short');closePreview();})()`);
        // A fast, clearly labelled short preview must play before a blocked full conversion.
        engineGate = gateFor({ extension: '.mov', profile: 'full' });
        await js(`openPreview('${ids.longDxv}')`);
        await wait(() => engineGate.entered, 'Quick viewer did not start background full preparation');
        const quickViewer = await js(`(async()=>{const {wait,check}=window.__hoverSmoke;const v=document.getElementById('previewVideo');await wait(()=>videoPreviewSession?.quickReady&&v.readyState>=2&&!v.paused,'Quick preview did not play while full conversion waited');check(!v.controls&&v.loop,'Quick preview must loop without full-video controls');check(v.duration<=2.2,'Quick viewer encoded beyond two seconds');check(document.getElementById('previewVideoStatusText').textContent.includes('前 2 秒快速预览'),'Quick preview was not labelled');v.currentTime=0.8;v.pause();return {duration:v.duration,requestSerial:videoPreviewSession.requests.full};})()`);
        window.webContents.send('shitu:video-preview', { id: ids.longDxv, root: setup.root, profile: 'full', requestSerial: quickViewer.requestSerial, state: 'encoding', progress: 42 });
        await js(`window.__hoverSmoke.wait(()=>document.getElementById('previewVideoStatusText').textContent.includes('42%'),'Current full progress missing')`);
        window.webContents.send('shitu:video-preview', { id: ids.longDxv, root: setup.root, profile: 'full', requestSerial: quickViewer.requestSerial - 1, state: 'encoding', progress: 99 });
        await new Promise(resolve => setTimeout(resolve, 40));
        await js(`window.__hoverSmoke.check(!document.getElementById('previewVideoStatusText').textContent.includes('99%'),'Stale progress replaced current progress')`);
        await fs.writeFile(path.join(base, 'quick-viewer.png'), (await window.webContents.capturePage()).toPNG());
        engineGate.release(); engineGate = null;
        const fullViewer = await js(`(async()=>{const {wait,check}=window.__hoverSmoke;const v=document.getElementById('previewVideo');await wait(()=>videoPreviewSession?.phase==='full'&&v.readyState>=2,'Quick viewer did not switch to full');check(v.controls&&v.dataset.previewOnly==='false','Full viewer controls did not return');check(v.duration>20,'Short preview was presented as a complete video');check(v.currentTime>=0.65&&v.currentTime<=1,'Playback position was not preserved');check(v.paused,'Switching resumed a user-paused video');check(document.getElementById('previewVideoStatus').classList.contains('hidden'),'Quick label remained after full playback');return {duration:v.duration,currentTime:v.currentTime};})()`);
        await js('closePreview()');
        const fullCallsBeforeWarm = viewerCalls.filter(call => call.id === ids.longDxv && call.profile === 'full').length;
        await js(`openPreview('${ids.longDxv}');`);
        await js(`(async()=>{const {wait,check}=window.__hoverSmoke;await wait(()=>videoPreviewSession?.phase==='full'&&document.getElementById('previewVideo').readyState>=2,'Warm full preview did not open directly');check(document.getElementById('previewVideo').dataset.previewOnly==='false','Warm full cache was labelled quick');closePreview();})()`);
        assert.equal(viewerCalls.filter(call => call.id === ids.longDxv && call.profile === 'full').length, fullCallsBeforeWarm, 'Warm full cache triggered duplicate conversion');
        // Failure leaves the playable short clip available, and retry can finish.
        engineGate = gateFor({ extension: '.mov', profile: 'full', error: 'Fixture full conversion failure' });
        await js(`openPreview('${ids.failureDxv}')`);
        await wait(() => engineGate.entered, 'Full failure fixture did not reach gate');
        engineGate.release(); engineGate = null;
        await js(`(async()=>{const {wait,check}=window.__hoverSmoke;await wait(()=>videoPreviewSession?.error,'Full conversion failure missing');const v=document.getElementById('previewVideo');check(v.readyState>=2&&!v.classList.contains('hidden')&&!v.controls,'Full failure discarded the short preview');check(!document.getElementById('previewVideoRetry').classList.contains('hidden'),'Retry was not offered');document.getElementById('previewVideoRetry').click();await wait(()=>videoPreviewSession?.phase==='full','Full retry failed');closePreview();})()`);
        // Delay a complete result past closing and opening another video.
        responseGate = gateFor({ id: ids.staleDxv, profile: 'full' });
        await js(`openPreview('${ids.staleDxv}')`);
        await wait(() => responseGate.entered, 'Stale full response did not reach gate');
        const staleSerial = await js('videoPreviewSession.requests.full');
        await js(`closePreview();openPreview('${ids.staleDxv}')`);
        await js(`window.__hoverSmoke.wait(()=>videoPreviewSession?.phase==='full'&&document.getElementById('previewVideo').readyState>=2,'Same video did not reopen from completed cache')`);
        const newSerial = await js('videoPreviewSession.serial');
        responseGate.release(); responseGate = null;
        window.webContents.send('shitu:video-preview', { id: ids.staleDxv, root: setup.root, profile: 'full', requestSerial: staleSerial, state: 'encoding', progress: 99 });
        await new Promise(resolve => setTimeout(resolve, 120));
        await js(`window.__hoverSmoke.check(state.previewId==='${ids.staleDxv}'&&videoPreviewSession.serial===${newSerial}&&document.getElementById('previewVideoStatus').classList.contains('hidden'),'Late full response or progress replaced a reopened viewer');closePreview()`);
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
        engineGate = gateFor({ extension: '.mov', profile: 'full' });
        await js(`openPreview('${ids.cancelDxv}')`);
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
        await fs.writeFile(resultPath, JSON.stringify({ ok: true, electron: process.versions.electron, nativeMouseEvents: true, decoded, longWarm, shortHoverProxy: true, separateFullPlayback: true, lazyPlayers: true, briefHoverSkipped: true, onePlayerOnly: true, staleReplyIgnored: true, leaveCancelsPreparation: true, fullPreviewTransfer: true, quickBeforeFull: true, quickViewer, fullViewer, warmFullCacheDirect: true, fullFailureKeepsQuick: true, fullRetry: true, staleFullIgnored: true, staleProgressIgnored: true, sameVideoReopenIsolated: true, closedViewerAllowsHover: true, clickSelection: true, selectionModeSuppressed: true, blurStops: true, scrollStops: true, rerenderStops: true, modalStops: true, imagesUnaffected: true, librarySwitchStops: true, screenshotCaptured: true, managedOriginalsUnchanged: true, networkAccessed: false, ...result }, null, 2) + '\n');
        await engine.shutdown(); window.destroy(); app.quit();
      } catch (error) { await fail(error); }
    });
  });
  setTimeout(() => fail(new Error('Hover video UI smoke timed out')), 110000).unref();
};
