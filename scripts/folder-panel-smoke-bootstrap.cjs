'use strict';
module.exports = function configureFolderPanelSmoke({ root, base }) {
  const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell } = require('electron');
  const fixture = require(path.join(base, 'folder-panel-smoke-fixture.json'));
  const failures = [], network = [], externalDrags = [];
  let finished = false, activeWindow;
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => { throw new Error('Folder panel smoke must not open a native picker'); };
  shell.openPath = shell.openExternal = async () => { throw new Error('Folder panel smoke must not launch external applications'); };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); }));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (predicate, label, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) { if (Date.now() > deadline) throw new Error(label); await sleep(20); }
  };
  const fail = async error => {
    if (finished) return; finished = true;
    let diagnostic;
    try { diagnostic = await activeWindow.webContents.executeJavaScript(`({mode:localStorage.getItem('shitu-folder-panel-mode'),classes:document.querySelector('.app-shell')?.className,folderOpen:document.querySelector('.folder-browser')?.open,navs:document.querySelectorAll('#folderNav').length,panel:document.getElementById('folderPanel')?.outerHTML.slice(0,1600),sidebar:document.getElementById('folderSidebar')?.outerHTML.slice(0,1600),toasts:document.getElementById('toastStack')?.textContent})`); } catch {}
    try { await fs.writeFile(path.join(base, 'failure.png'), (await activeWindow.webContents.capturePage()).toPNG()); } catch {}
    await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), diagnostic, failures, network }, null, 2));
    app.exit(1);
  };
  app.on('browser-window-created', (_event, window) => {
    activeWindow = window; window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.setContentSize(1600, 960); window.showInactive();
    window.webContents.setBackgroundThrottling(false);
    window.webContents.startDrag = options => externalDrags.push(options.files || [options.file]);
    window.webContents.on('render-process-gone', (_event, detail) => failures.push(`Renderer exited: ${detail.reason}`));
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      const js = async code => {
        try { return await window.webContents.executeJavaScript(code); }
        catch (error) { throw new Error(`${error.message}\nRenderer step: ${code.slice(0, 600)}`); }
      };
      const point = selector => js(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing pointer target '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const box=node.getBoundingClientRect(),x=Math.round(box.left+box.width/2),y=Math.round(box.top+box.height/2),hit=document.elementFromPoint(x,y);if(!hit||!node.contains(hit))throw new Error('Pointer target covered '+${JSON.stringify(selector)});return{x,y};})()`);
      const move = (location, down = false) => window.webContents.sendInputEvent({ type: 'mouseMove', ...location, modifiers: down ? ['leftButtonDown'] : [] });
      const click = async (selector, modifiers = []) => {
        const location = await point(selector); move(location);
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...location, modifiers });
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...location, modifiers }); await sleep(70);
      };
      const key = async keyCode => {
        window.webContents.focus(); window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        if (keyCode === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(70);
      };
      const pinned = () => js(`document.querySelector('.app-shell').classList.contains('folder-panel-pinned')`);
      const assertPlacement = async expected => {
        const result = await js(`(()=>{const panel=document.getElementById('folderPanel'),nav=document.getElementById('folderNav'),sidebar=document.getElementById('folderSidebar'),browser=document.querySelector('.folder-browser');return {navs:document.querySelectorAll('#folderNav').length,panels:document.querySelectorAll('#folderPanel').length,pinned:document.querySelector('.app-shell').classList.contains('folder-panel-pinned'),panelInSidebar:sidebar.contains(panel),navInPanel:panel.contains(nav),panelInBrowser:browser.contains(panel),sidebarVisible:sidebar.getBoundingClientRect().width>0&&getComputedStyle(sidebar).display!=='none'};})()`);
        assert.equal(result.navs, 1); assert.equal(result.panels, 1); assert.equal(result.navInPanel, true);
        assert.equal(result.pinned, expected); assert.equal(result.panelInSidebar, expected); assert.equal(result.panelInBrowser, !expected);
        assert.equal(result.sidebarVisible, expected);
      };
      const capture = async filename => {
        window.webContents.invalidate(); await sleep(150);
        const image = await window.webContents.capturePage(); assert.equal(image.isEmpty(), false);
        await fs.writeFile(path.join(base, filename), image.toPNG());
      };
      const readLayout = () => js(`(()=>{const rect=id=>{const b=document.querySelector(id).getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};},doc=document.documentElement;return{width:innerWidth,height:innerHeight,scrollWidth:doc.scrollWidth,clientWidth:doc.clientWidth,sidebar:rect('#folderSidebar'),details:rect('#detailsPanel'),workspace:rect('.workspace'),gallery:rect('#galleryScroller')};})()`);
      const assertLayout = (layout, width, height) => {
        // Windows can round the thick frame to physical pixels at fractional DPI.
        assert.ok(Math.abs(layout.width - width) <= 2 && Math.abs(layout.height - height) <= 2,
          `Expected a viewport near ${width}×${height}, got ${layout.width}×${layout.height}`);
        assert.ok(layout.scrollWidth <= layout.clientWidth + 1, 'Docked panel and details cause horizontal page overflow');
        assert.ok(layout.sidebar.width >= 180 && layout.workspace.width > 200 && layout.details.width > 200, 'Layout hid an active panel');
        assert.ok(layout.workspace.left >= layout.sidebar.right + 8, 'Workspace overlaps the pinned folder sidebar');
        assert.ok(layout.workspace.right <= layout.details.left - 8, 'Workspace overlaps the open details panel');
        assert.ok(layout.gallery.width > 0 && layout.gallery.height > 0, 'Gallery has no visible area');
        assert.ok(layout.gallery.left >= layout.workspace.left - 1 && layout.gallery.right <= layout.workspace.right + 1, 'Gallery extends beyond its workspace');
        assert.ok(layout.sidebar.left >= -1 && layout.details.right <= layout.width + 1, 'Layout extends outside viewport');
      };
      const reload = async () => {
        const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.webContents.reload(); await loaded;
        await wait(() => js(`Boolean(state.library.root)&&!state.libraryChanging&&Boolean(document.getElementById('folderPanelPin'))`), 'Reload did not restore the library and panel');
        await sleep(200);
      };
      try {
        assert.equal(app.getPath('userData'), path.join(base, 'profile'));
        const data = await js(`(async()=>{
          const initial=await api.getLibrary();if(initial.stats.total!==0)throw new Error('Panel test library not empty');
          const folder=async(name,parent=null)=>{const snapshot=await api.createFolder(name,parent);return snapshot.folders.find(f=>f.name===name).id;};
          const parent=await folder('设计项目'),child=await folder('参考素材',parent),other=await folder('待整理');
          const imported=await api.importPaths(${JSON.stringify(fixture.samples.map(sample => sample.filename))},parent);
          if(imported.report.imported!==3)throw new Error('Panel fixtures were not imported');
          const ids=${JSON.stringify(fixture.samples.map(sample => sample.hash))}.map(hash=>imported.snapshot.assets.find(a=>a.hash===hash).id);
          applyLibrary(await api.updateAssets([ids[0]],{tags:['面板测试'],notes:'移动后仍保留',colorLabel:'#225588'}),false);
          changeView('all');toggleDetails(false);setThumbnailSize(180);render();
          window.__originalPanel=document.getElementById('folderPanel');window.__originalFolderNav=document.getElementById('folderNav');
          return {parent,child,other,ids,root:initial.root};
        })()`);
        const row = id => `#folderNav .folder-row[data-folder-id="${id}"]`;
        const nav = id => `${row(id)} .nav-item`;
        const more = id => `${row(id)} .folder-more`;
        await assertPlacement(false);
        await click('#folderBrowserToggle');
        await wait(() => js(`document.querySelector('.folder-browser').open`), 'Dropdown failed to open');
        await click(`${row(data.parent)} [data-folder-toggle]`);
        assert.equal(await js(`Boolean(document.querySelector(${JSON.stringify(row(data.child))}))`), false, 'Collapse did not hide the child');
        await click('#folderPanelPin'); await wait(pinned, 'Pin did not dock the folder panel'); await assertPlacement(true);
        assert.equal(await js(`document.getElementById('folderPanel')===window.__originalPanel&&document.getElementById('folderNav')===window.__originalFolderNav`), true, 'Pin recreated the panel instead of moving it');
        assert.equal(await js(`Boolean(document.querySelector(${JSON.stringify(row(data.child))}))`), false, 'Pin lost the collapsed state');
        await click(`${row(data.parent)} [data-folder-toggle]`); await click(nav(data.child));
        await wait(() => js(`state.folder===${JSON.stringify(data.child)}`), 'Sidebar selection failed');
        await assertPlacement(true);
        assert.equal(await js(`document.querySelector(${JSON.stringify(nav(data.child))}).getAttribute('aria-current')`), 'page');
        await click('#searchInput'); await key('Escape'); await assertPlacement(true);
        await click('.tag-browser > summary');
        assert.equal(await js(`document.querySelector('.tag-browser').open`), true); await assertPlacement(true);
        await key('Escape'); await assertPlacement(true);
        await click(more(data.child)); await click('#folderColorLabels [data-color-label="red"]');
        await wait(() => js(`state.library.folders.find(f=>f.id===${JSON.stringify(data.child)}).colorLabel==='red'`), 'Sidebar color action failed');
        assert.equal(await js(`document.querySelector(${JSON.stringify(row(data.child))}).dataset.colorLabel`), 'red');
        await click(more(data.child)); await click('[data-folder-action="rename"]');
        await js(`document.getElementById('modalInput').value='已重命名参考';`); await click('#modalConfirm');
        await wait(() => js(`state.library.folders.find(f=>f.id===${JSON.stringify(data.child)}).name==='已重命名参考'`), 'Sidebar rename failed');
        await click('#newFolder'); await js(`document.getElementById('modalInput').value='面板新建子目录';`); await click('#modalConfirm');
        await wait(() => js(`state.library.folders.some(f=>f.name==='面板新建子目录')`), 'Sidebar create-folder failed');
        const created = await js(`state.library.folders.find(f=>f.name==='面板新建子目录').id`);
        assert.equal(await js(`state.library.folders.find(f=>f.id===${JSON.stringify(created)}).parentId`), data.child);
        await click(more(created)); await click('[data-folder-action="move"]');
        await js(`document.getElementById('modalParent').value=${JSON.stringify(data.other)};`); await click('#modalConfirm');
        await wait(() => js(`state.library.folders.find(f=>f.id===${JSON.stringify(created)}).parentId===${JSON.stringify(data.other)}`), 'Sidebar move-folder failed');
        await assertPlacement(true);
        await js(`changeView('all');toggleDetails(false);setThumbnailSize(180);`); await sleep(120);
        const card = id => `.asset-card[data-asset-id="${id}"]`;
        await click(card(data.ids[0])); await click(card(data.ids[1]), ['control']);
        assert.equal(await js('state.selected.size'), 2);
        const beforeHistory = await js('(async()=> (await api.historyState()).undoCount)()');
        const start = await point(card(data.ids[0])); move(start);
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
        move({ x: start.x + 14, y: start.y - 10 }, true); await sleep(70);
        const target = await point(row(data.other)); move(target, true); await sleep(70);
        assert.equal(await js(`document.querySelector(${JSON.stringify(row(data.other))}).classList.contains('asset-drop-target')`), true, 'Sidebar drop target did not highlight');
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...target });
        await wait(() => js(`(async()=>{const snapshot=await api.getLibrary();return ${JSON.stringify(data.ids.slice(0, 2))}.every(id=>snapshot.assets.find(a=>a.id===id).folderId===${JSON.stringify(data.other)});})()`), 'Multi-selection was not moved into sidebar folder');
        await wait(() => js('!draggingAssets'), 'Drag state did not clear'); await sleep(400); await assertPlacement(true);
        assert.equal(await js('(async()=> (await api.historyState()).undoCount)()'), beforeHistory + 1, 'Sidebar batch move was not one history step');
        await click('#undoHistoryButton');
        await wait(() => js(`state.library.assets.filter(a=>${JSON.stringify(data.ids.slice(0, 2))}.includes(a.id)).every(a=>a.folderId===${JSON.stringify(data.parent)})`), 'Sidebar drag undo failed');
        assert.equal(await js(`state.library.assets.find(a=>a.id===${JSON.stringify(data.ids[0])}).notes`), '移动后仍保留');
        assert.equal(externalDrags.length, 0, 'Internal sidebar move triggered native drag export');
        await click(card(data.ids[0]));
        assert.equal(await js(`state.selected.has(${JSON.stringify(data.ids[0])})`), true, 'Keyboard regression needs a selected asset');
        await js(`document.getElementById('folderPanelPin').focus();`); await key('Space');
        await wait(async () => !await pinned(), 'Space on the pin button did not restore dropdown mode'); await assertPlacement(false);
        assert.equal(await js('state.previewId'), null, 'Pin Space bubbled into the selected asset preview');
        await js(`document.getElementById('folderPanelPin').focus();`); await key('Space');
        await wait(pinned, 'Space on the pin button did not restore the sidebar'); await assertPlacement(true);
        assert.equal(await js('state.previewId'), null, 'Pin Space opened the selected asset instead of docking');
        assert.equal(await js(`document.getElementById('folderPanel')===window.__originalPanel&&document.getElementById('folderNav')===window.__originalFolderNav`), true, 'Keyboard pin duplicated or replaced the shared panel');
        const beforeDelete = await js(`(async()=>JSON.stringify((await api.getLibrary()).assets.map(a=>[a.id,a.trashedAt])))()`);
        await js(`document.getElementById('folderPanelPin').focus();`); await key('Delete'); await sleep(150);
        assert.equal(await js(`(async()=>JSON.stringify((await api.getLibrary()).assets.map(a=>[a.id,a.trashedAt])))()`), beforeDelete, 'Delete on a panel button moved selected assets to trash');
        assert.equal(await js(`document.getElementById('modalOverlay').classList.contains('hidden')`), true, 'Delete on a panel button opened a destructive dialog');
        await click('#folderPanelPin'); await wait(async () => !await pinned(), 'Unpin did not restore dropdown mode'); await assertPlacement(false);
        assert.equal(await js(`localStorage.getItem('shitu-folder-panel-mode')`), 'dropdown');
        await reload(); await assertPlacement(false);
        await click('#folderBrowserToggle'); await click('#folderPanelPin'); await wait(pinned, 'Pin after reload failed');
        assert.equal(await js(`localStorage.getItem('shitu-folder-panel-mode')`), 'sidebar');
        await reload(); await assertPlacement(true);
        window.setContentSize(1920, 1080); await sleep(150); await js('changeView("all");toggleDetails(true);');
        const wideLayout = await readLayout(); assertLayout(wideLayout, 1920, 1080);
        await capture('folder-panel-wide.png');
        window.setContentSize(1080, 700); await sleep(200); await assertPlacement(true);
        const layout = await readLayout(); assertLayout(layout, 1080, 700);
        await capture('folder-panel-1080x700.png');
        const snapshot = await js('(async()=>await api.getLibrary())()');
        for (const sample of fixture.samples) {
          const asset = snapshot.assets.find(asset => asset.hash === sample.hash);
          assert.ok(asset); assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(data.root, asset.filename))).digest('hex'), sample.hash);
        }
        assert.deepEqual(failures, []); assert.deepEqual(network, []);
        const report = { ok: true, electron: process.versions.electron, oneSharedPanel: true, dropdownAndSidebarMutuallyExclusive: true,
          pinAndUnpinPersistAcrossReload: true, collapseAndSelectionRetained: true, outsideEscapeAndTagMenuKeepSidebar: true,
          pinKeyboardSpaceTogglesWithoutPreview: true, panelKeyboardDeletePreservesAssets: true,
          sidebarColorRenameCreateMove: true, sidebarMultiDragAndUndo: true, narrowDetailsWithoutOverflow: true,
          layout, wideLayout, screenshots: ['folder-panel-wide.png', 'folder-panel-1080x700.png'], originalFilesUnchanged: true, networkRequests: 0 };
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(report, null, 2)); finished = true; window.destroy(); app.quit();
      } catch (error) { await fail(error); }
    });
  });
};
