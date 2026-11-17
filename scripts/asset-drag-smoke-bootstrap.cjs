'use strict';
module.exports = function configureAssetDragSmoke({ root, base }) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell } = require('electron');
  const { Library } = require(path.join(root, 'src', 'library.cjs'));
  const fixture = require(path.join(base, 'asset-drag-smoke-fixture.json'));
  const resultPath = path.join(base, 'result.json'), failures = [], requests = [], externalDrags = [];
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  let completed = false, pickerTarget = null;
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => {
    if (!pickerTarget) throw new Error('Asset drag smoke must not open a native picker');
    return { canceled: false, filePaths: [pickerTarget] };
  };
  shell.openPath = async () => { throw new Error('Asset drag smoke must not open external applications'); };
  shell.openExternal = async () => { throw new Error('Asset drag smoke must not open the browser'); };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { requests.push(details.url); callback({ cancel: true }); }));
  const fail = async (error, window) => {
    if (completed) return; completed = true;
    let diagnostic;
    try { diagnostic = await window.webContents.executeJavaScript(`({root:state.library.root,selected:[...state.selected],draggingAssets,selectionMode:state.selectionMode,pointerEvents:window.__dragPointerEvents,ghost:document.getElementById('assetDragGhost')?.outerHTML,targets:[...document.querySelectorAll('.asset-drop-target')].map(n=>n.outerHTML.slice(0,700))})`); } catch {}
    try { await fs.writeFile(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
    await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error.stack || String(error), failures, externalDrags: externalDrags.length, diagnostic }, null, 2)); app.exit(1);
  };
  app.on('browser-window-created', (_event, window) => {
    window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.setSize(1440, 1080); window.showInactive(); window.webContents.setBackgroundThrottling(false);
    // Exercise the real trusted main-process export resolution, never start OLE
    // or drop files into a user's applications during the automated test.
    window.webContents.startDrag = options => { externalDrags.push({ files: [...options.files], file: options.file, iconReady: !options.icon.isEmpty() }); };
    window.webContents.on('render-process-gone', (_event, details) => failures.push('Renderer exited: ' + details.reason));
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      const js = async code => {
        try { return await window.webContents.executeJavaScript(code); }
        catch (error) { throw new Error(`${error.message}\nRenderer step: ${code.slice(0, 600)}`); }
      };
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const capture = async name => {
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            window.webContents.invalidate(); await sleep(90);
            const screenshot = await window.webContents.capturePage();
            if (screenshot.isEmpty()) throw new Error('Drag smoke screenshot is empty');
            await fs.writeFile(path.join(base, name), screenshot.toPNG()); return;
          } catch (error) { lastError = error; }
        }
        throw lastError;
      };
      const wait = async (predicate, label, timeout = 15000) => {
        const deadline = Date.now() + timeout;
        while (!await predicate()) { if (Date.now() > deadline) throw new Error(label); await sleep(20); }
      };
      const point = selector => js(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing pointer target '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=Math.round(b.left+b.width/2),y=Math.round(b.top+b.height/2),hit=document.elementFromPoint(x,y);if(!hit||!n.contains(hit))throw new Error('Pointer target covered '+${JSON.stringify(selector)});return {x,y};})()`);
      const move = (p, down = false) => window.webContents.sendInputEvent({ type: 'mouseMove', ...p, modifiers: down ? ['leftButtonDown'] : [] });
      const down = p => window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
      const up = p => window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
      const click = async (selector, modifiers = []) => { const p = await point(selector); move(p); window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p, modifiers }); window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p, modifiers }); await sleep(45); };
      const key = keyCode => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
      const begin = async selector => { const p = await point(selector); move(p); down(p); move({ x: p.x + 12, y: p.y - 10 }, true); await sleep(40); return p; };
      const onto = async selector => { const p = await point(selector); move(p, true); await sleep(45); return p; };
      const released = async () => {
        await js(`window.__dragSmoke.wait(()=>!draggingAssets&&!document.querySelector('.asset-drop-target')&&document.getElementById('assetDragGhost').classList.contains('hidden'),'Drag visuals or flag did not clear')`);
        // Separate user gestures after the release click guard has expired.
        await sleep(400);
      };
      try {
        assert.equal(app.getPath('userData'), path.join(base, 'profile'));
        const data = await js(`(async()=>{
          const check=(ok,label)=>{if(!ok)throw new Error(label)};
          const wait=async(test,label)=>{const end=Date.now()+15000;while(!await test()){if(Date.now()>end)throw new Error(label);await new Promise(r=>setTimeout(r,20));}};
          const initial=await api.getLibrary();check(initial.stats.total===0,'Drag library must be empty');
          let snapshot=await api.createFolder('工作区');const parent=snapshot.folders.find(f=>f.name==='工作区').id;
          snapshot=await api.createFolder('接收 A',parent);const targetA=snapshot.folders.find(f=>f.name==='接收 A').id;
          snapshot=await api.createFolder('接收 B',parent);const targetB=snapshot.folders.find(f=>f.name==='接收 B').id;
          const imported=await api.importPaths(${JSON.stringify(fixture.samples.slice(0, 4).map(f => f.filename))},parent);check(imported.report.imported===4,'Drag fixtures failed to import');
          const ids=${JSON.stringify(fixture.samples.slice(0, 4).map(f => f.hash))}.map(hash=>imported.snapshot.assets.find(a=>a.hash===hash).id);
          snapshot=await api.updateAssets([ids[0]],{notes:'拖动保留备注',tags:['保留标签'],rating:4,colorLabel:'#3855a8'});applyLibrary(snapshot,false);changeView('all',parent);toggleDetails(false);setThumbnailSize(180);render();
          window.__dragSmoke={check,wait,parent,targetA,targetB,ids,originalRoot:initial.root};
          window.__dragPointerEvents=[];for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>{if(window.__dragPointerEvents.length<50)window.__dragPointerEvents.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,pointerId:e.pointerId,target:e.target.className});},true);
          return {parent,targetA,targetB,ids,root:initial.root};
        })()`);
        const asset = id => `.asset-card[data-asset-id="${id}"]`;
        const folder = id => `.folder-card[data-folder-id="${id}"]`;
        const assignments = () => js(`(async()=>Object.fromEntries((await api.getLibrary()).assets.map(a=>[a.id,a.folderId])))()`);
        const hasFolder = (id, target) => js(`(async()=> (await api.getLibrary()).assets.find(a=>a.id==='${id}')?.folderId===${JSON.stringify(target)})()`);
        const restore = async (ids = data.ids) => { await js(`(async()=>{applyLibrary(await api.updateAssets(${JSON.stringify(ids)},{folderId:'${data.parent}'}),false);changeView('all','${data.parent}');setSelectionMode(false);state.selected.clear();updateSelectionClasses();toggleDetails(false);})()`); await sleep(320); };
        await js(`(async()=>{const {check}=window.__dragSmoke;const before=JSON.stringify((await api.getLibrary()).assets.map(a=>[a.id,a.folderId]));for(const [ids,target,root] of [[['${data.ids[0]}'],'${data.targetA}','stale-root'],[['${data.ids[0]}'],'missing-folder',${JSON.stringify(data.root)}],[['${data.ids[0]}','missing-asset'],'${data.targetA}',${JSON.stringify(data.root)}]]){let rejected=false;try{await api.moveAssetsToFolder(ids,target,root);}catch{rejected=true;}check(rejected,'Invalid direct move request was accepted');check(JSON.stringify((await api.getLibrary()).assets.map(a=>[a.id,a.folderId]))===before,'Invalid move partially changed assignments');}})()`);
        await begin(asset(data.ids[0])); const a = await onto(folder(data.targetA));
        await js(`window.__dragSmoke.check(document.querySelector('.asset-drop-target')?.dataset.folderId==='${data.targetA}','Target folder did not highlight');window.__dragSmoke.check(document.getElementById('assetDragGhost')?.textContent.includes('1'),'Single drag count missing')`);
        await capture('single-drag.png');
        up(a); await wait(() => hasFolder(data.ids[0], data.targetA), 'Single asset was not moved to the folder'); await released();
        await js(`(async()=>{const {check}=window.__dragSmoke;const a=(await api.getLibrary()).assets.find(a=>a.id==='${data.ids[0]}');check(a.notes==='拖动保留备注'&&a.tags.includes('保留标签')&&a.rating===4&&a.colorLabel==='#3855a8','Drag changed unrelated asset metadata');check(!document.querySelector('${asset(data.ids[0])}'),'Moved asset remains in the direct parent view');})()`);
        assert.equal(externalDrags.length, 0, 'An internal drop started native OLE');
        await js(`changeView('all');toggleDetails(false)`);
        await click(asset(data.ids[0])); await click(asset(data.ids[1]), ['control']);
        await begin(asset(data.ids[1])); await onto('#folderBrowserToggle');
        await js(`window.__dragSmoke.wait(()=>document.querySelector('.folder-browser').open,'Mixed-selection folder list did not open')`);
        const mixedTarget = await onto('#folderNav .folder-row[data-folder-id="' + data.targetA + '"]'); up(mixedTarget);
        await wait(async () => (await hasFolder(data.ids[0], data.targetA)) && (await hasFolder(data.ids[1], data.targetA)), 'Mixed selection with an already-placed member failed'); await released();
        await restore([data.ids[1]]);
        await click(asset(data.ids[1])); await click(asset(data.ids[2]), ['control']);
        await js(`window.__dragSmoke.check(state.selected.size===2,'Ctrl multiselection failed')`);
        await begin(asset(data.ids[1])); const b = await onto(folder(data.targetB));
        await js(`window.__dragSmoke.check(state.selected.size===2&&document.getElementById('assetDragGhost')?.textContent.includes('2'),'Dragging a selected item lost its multi-selection')`);
        await capture('multi-drag.png');
        up(b); await wait(async () => (await hasFolder(data.ids[1], data.targetB)) && (await hasFolder(data.ids[2], data.targetB)), 'Selected assets did not move together'); await released();
        await restore(data.ids.slice(1, 3)); await js('setSelectionMode(true)');
        await click(asset(data.ids[1])); await click(asset(data.ids[2]));
        await begin(asset(data.ids[2])); const selectionTarget = await onto(folder(data.targetA)); up(selectionTarget);
        await wait(async () => (await hasFolder(data.ids[1], data.targetA)) && (await hasFolder(data.ids[2], data.targetA)), 'Selection-mode drag failed'); await released();
        await js(`(async()=>{applyLibrary(await api.updateAssets(['${data.ids[3]}'],{folderId:'${data.targetA}'}),false);setSelectionMode(false);changeView('all','${data.targetA}');toggleDetails(false);})()`); await sleep(400);
        await begin(asset(data.ids[3])); const parentCrumb = await onto('.folder-breadcrumb[data-folder-id="' + data.parent + '"]'); up(parentCrumb);
        await wait(() => hasFolder(data.ids[3], data.parent), 'Dragging to an ancestor breadcrumb failed'); await released();
        await js(`changeView('all','${data.parent}')`);
        await begin(asset(data.ids[3])); await onto('#folderBrowserToggle');
        await js(`window.__dragSmoke.wait(()=>document.querySelector('.folder-browser').open,'Dragging onto the folder heading did not reveal the list')`);
        const treeTarget = await onto('#folderNav .folder-row[data-folder-id="' + data.targetB + '"]'); up(treeTarget);
        await wait(() => hasFolder(data.ids[3], data.targetB), 'Dragging into the expanded folder list failed'); await released();
        await js(`window.__dragSmoke.check(!document.querySelector('.folder-browser').open,'Drag-opened folder menu did not close after dropping')`);
        await restore(); const unchanged = await assignments();
        await begin(asset(data.ids[0])); const cancelledTarget = await onto(folder(data.targetA)); key('Escape'); up(cancelledTarget); await sleep(150); await released();
        assert.deepEqual(await assignments(), unchanged, 'Escape committed the pending move');
        await begin(asset(data.ids[0])); const invalid = await point('#searchInput'); move(invalid, true); up(invalid); await sleep(150); await released();
        assert.deepEqual(await assignments(), unchanged, 'Dropping outside a folder changed metadata');
        // The same folder is visible in the global overview, so this is a real
        // pointer drop onto the asset's existing parent, rather than an API no-op.
        await js(`changeView('all');toggleDetails(false)`); await sleep(320);
        await begin(asset(data.ids[0])); const same = await onto(folder(data.parent)); up(same); await sleep(150); await released();
        assert.deepEqual(await assignments(), unchanged, 'Same-folder drag changed assignments');
        await restore(); await begin(asset(data.ids[0]));
        move({ x: -12, y: 300 }, true); await wait(() => externalDrags.length === 1, 'Leaving the window did not hand off native export'); up({ x: 15, y: 300 }); await released();
        assert.equal(externalDrags[0].files.length, 1); assert.equal(externalDrags[0].iconReady, true);
        assert.deepEqual(await assignments(), unchanged, 'External export moved the library asset');
        const beforeRootChange = await assignments();
        await begin(asset(data.ids[0])); const stale = await onto(folder(data.targetA));
        const secondRoot = path.join(base, 'second-library'); await new Library({ root: secondRoot }).init(); pickerTarget = secondRoot;
        await js(`(async()=>{const next=await api.openLibrary();applyLibrary(next.snapshot,false);})()`); up(stale); await sleep(150); await released();
        await js(`window.__dragSmoke.check(state.library.assets.length===0,'Stale drag wrote into the new library')`);
        const oldLibrary = new Library({ root: data.root }); await oldLibrary.init();
        assert.deepEqual(Object.fromEntries(oldLibrary.snapshot().assets.map(a => [a.id, a.folderId])), beforeRootChange, 'Stale drag altered the previous library');
        for (const expected of fixture.samples.slice(0, 4)) {
          const original = oldLibrary.snapshot().assets.find(a => a.hash === expected.hash);
          assert.equal(hash(await fs.readFile(oldLibrary.getAssetPath(original.id))), expected.hash, 'Moving changed managed original bytes');
        }
        pickerTarget = data.root;
        await js(`(async()=>{const next=await api.openLibrary();applyLibrary(next.snapshot,false);setSelectionMode(false);})()`);
        const importPoint = await point('#galleryScroller');
        window.webContents.debugger.attach('1.3');
        try {
          const nativeFiles = { items: [], files: [fixture.samples[4].filename], dragOperationsMask: 1 };
          for (const type of ['dragEnter', 'dragOver', 'drop']) {
            await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...importPoint, data: nativeFiles });
          }
        } finally { window.webContents.debugger.detach(); }
        await js(`window.__dragSmoke.wait(async()=> (await api.getLibrary()).assets.some(a=>a.hash==='${fixture.samples[4].hash}'),'External file drop no longer imports a native file')`);
        assert.deepEqual(failures, []); assert.deepEqual(requests, []);
        completed = true;
        await fs.writeFile(resultPath, JSON.stringify({ ok: true, electron: process.versions.electron, nativePointerEvents: true,
          singleMove: true, multiMove: true, selectionModeMove: true, highlightsAndCount: true, metadataPreserved: true,
          mixedDestinationSelection: true,
          ancestorBreadcrumbDrop: true, autoOpenedFolderListDrop: true,
          escapeCancels: true, outsideDropIgnored: true, sameFolderNoop: true, externalExportPreserved: true,
          nativeExportBoundaryMocked: true, staleRootCancelled: true, managedOriginalBytesUnchanged: true,
          incomingFileDrop: true, invalidIpcMovesRejectedAtomically: true,
          browserNetworkRequests: 0, screenshots: ['single-drag.png', 'multi-drag.png'] }, null, 2) + '\n');
        window.destroy(); app.quit();
      } catch (error) { await fail(error, window); }
    });
  });
  setTimeout(() => fail(new Error('Asset drag UI smoke timed out')), 110000).unref();
};
