'use strict';
module.exports = function configureColorsSmoke({ root, base }) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const sharp = require('sharp');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell, Menu } = require('electron');
  const { Library } = require(path.join(root, 'src', 'library.cjs'));
  const fixture = require(path.join(base, 'color-smoke-fixture.json'));
  const resultPath = path.join(base, 'result.json');
  const failures = [], requests = [], nativeChoices = [];
  let completed = false, nativeChoice = 'color-pink';
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => { throw new Error('Color smoke must not open native file pickers'); };
  shell.openPath = async () => { throw new Error('Color smoke must not launch external applications'); };
  shell.openExternal = async () => { throw new Error('Color smoke must not open a browser'); };
  Menu.buildFromTemplate = template => ({ popup(options) {
    const colors = template.find(item => item.id === 'color-label');
    assert.ok(colors?.enabled, 'Native asset color menu is missing or disabled');
    const choice = colors.submenu.find(item => item.id === nativeChoice);
    assert.ok(choice, 'Native asset color menu is missing the expected item');
    nativeChoices.push(nativeChoice); choice.click(); options.callback?.();
  } });
  const fail = async error => {
    if (completed) return; completed = true;
    await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error.stack || String(error), failures }, null, 2)); app.exit(1);
  };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    requests.push(details.url); callback({ cancel: true });
  }));
  app.on('browser-window-created', (_event, window) => {
    window.show = () => {}; window.setSkipTaskbar(true); window.webContents.setBackgroundThrottling(false);
    window.webContents.on('render-process-gone', (_event, details) => failures.push('Renderer exited: ' + details.reason));
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      try {
        assert.equal(app.getPath('userData'), path.join(base, 'profile'));
        const result = await window.webContents.executeJavaScript(`(async () => {
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const wait = async (predicate, label) => { const deadline = Date.now() + 10000; while (!await predicate()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 20)); } };
          const readAsset = id => state.library.assets.find(item => item.id === id);
          const select = ids => { state.selected = new Set(ids); render(); toggleDetails(true); renderDetails(); };
          const detail = color => document.querySelector('#detailColorLabels [data-color-label="' + color + '"]');
          const card = id => document.querySelector('.asset-card[data-asset-id="' + id + '"]');
          const folderRow = id => document.querySelector('#folderNav .folder-row[data-folder-id="' + id + '"]');
          const openFolder = id => { document.querySelector('.folder-browser').open = true; const row = folderRow(id); check(row, 'Folder row missing'); row.querySelector('.folder-more').click(); check(document.getElementById('folderColorLabels'), 'Folder color palette missing'); };
          const initial = await api.getLibrary(); check(!initial.stats.total && !initial.folders.length, 'Color test library was not empty');
          let snapshot = await api.createFolder('带色项目'); applyLibrary(snapshot, false); const parent = snapshot.folders.at(-1).id;
          snapshot = await api.createFolder('子文件夹', parent); applyLibrary(snapshot, false); const child = snapshot.folders.at(-1).id;
          const imported = await api.importPaths(${JSON.stringify(fixture.samples.map(item => item.filename))}, child);
          check(imported.report.imported === 3 && !imported.report.errors.length, 'Color test image import failed'); applyLibrary(imported.snapshot, false);
          const ids = imported.report.assetIds;
          select([ids[0]]);
          check(detail('')?.getAttribute('aria-pressed') === 'true', 'An unlabeled asset must select clear');
          check(document.querySelectorAll('#detailColorLabels [data-color-label]').length === 9, 'Asset palette must include eight colors and clear');
          detail('red').click();
          await wait(() => readAsset(ids[0])?.colorLabel === 'red' && card(ids[0])?.querySelector('.asset-color-mark')?.dataset.colorLabel === 'red', 'Single asset color was not saved and shown');
          check(detail('red').getAttribute('aria-pressed') === 'true', 'Saved asset color is not selected');
          select([ids[0], ids[1]]);
          check(document.getElementById('detailColorLabels').dataset.colorMixed === 'true', 'Mixed asset colors were not identified');
          check(!document.querySelector('#detailColorLabels [aria-pressed="true"]'), 'Mixed colors falsely selected a common value');
          detail('purple').click();
          await wait(() => ids.slice(0, 2).every(id => readAsset(id)?.colorLabel === 'purple' && card(id)?.dataset.colorLabel === 'purple'), 'Batch color was not saved for both assets');
          check(detail('purple').getAttribute('aria-pressed') === 'true', 'Shared batch color is not selected');
          detail('').click();
          await wait(() => ids.slice(0, 2).every(id => readAsset(id)?.colorLabel === null && !card(id)?.querySelector('.asset-color-mark')), 'Clearing color left a saved value or visible marker');
          detail('cyan').click();
          await wait(() => ids.slice(0, 2).every(id => readAsset(id)?.colorLabel === 'cyan'), 'Batch color failed after clearing');
          await showAssetContextMenu(ids[2]);
          await wait(() => readAsset(ids[2])?.colorLabel === 'pink' && card(ids[2])?.dataset.colorLabel === 'pink', 'Native color menu did not dispatch a persisted color change');
          openFolder(parent); document.querySelector('#folderColorLabels [data-color-label="blue"]').click();
          await wait(() => state.library.folders.find(item => item.id === parent)?.colorLabel === 'blue' && folderRow(parent)?.dataset.colorLabel === 'blue', 'Folder color was not persisted and shown');
          check(state.library.folders.find(item => item.id === child)?.colorLabel === null, 'Folder color unexpectedly propagated to a child');
          check(ids.every(id => readAsset(id)?.colorLabel !== 'blue'), 'Folder color unexpectedly propagated to assets');
          openFolder(child); document.querySelector('#folderColorLabels [data-color-label="green"]').click();
          await wait(() => state.library.folders.find(item => item.id === child)?.colorLabel === 'green' && folderRow(child)?.querySelector('.folder-color-mark')?.dataset.colorLabel === 'green', 'Child folder color was not shown');
          openFolder(parent); document.querySelector('#folderColorLabels [data-color-label=""]').click();
          await wait(() => state.library.folders.find(item => item.id === parent)?.colorLabel === null && !folderRow(parent)?.querySelector('.folder-color-mark'), 'Parent folder clear failed');
          check(state.library.folders.find(item => item.id === child)?.colorLabel === 'green', 'Clearing parent erased child color');
          openFolder(parent); document.querySelector('#folderColorLabels [data-color-label="blue"]').click();
          await wait(() => state.library.folders.find(item => item.id === parent)?.colorLabel === 'blue', 'Parent folder restore failed');
          let moved = await api.renameFolder(parent, '带色项目已重命名'); applyLibrary(moved, false);
          moved = await api.moveFolder(child, null); applyLibrary(moved, false);
          moved = await api.moveFolder(child, parent); applyLibrary(moved, false);
          check(state.library.folders.find(item => item.id === child)?.colorLabel === 'green', 'Moving a folder erased its color');
          let trashed = await api.setTrash([ids[2]], true); applyLibrary(trashed, false);
          check(trashed.assets.find(item => item.id === ids[2]).colorLabel === 'pink', 'Trashing an asset erased its color');
          trashed = await api.setTrash([ids[2]], false); applyLibrary(trashed, false);
          check(trashed.assets.find(item => item.id === ids[2]).colorLabel === 'pink', 'Restoring an asset erased its color');
          changeView('all'); select([ids[0], ids[1]]); document.querySelector('.folder-browser').open = true;
          return { root: state.library.root, ids, parent, child, assetSingleColor: true, assetBatchColor: true,
            mixedColorState: true, clearAssetColor: true, nativeMenuDispatch: true, folderColor: true,
            childColorIndependent: true, folderClearIndependent: true, renameMovePreservesColor: true, trashRestorePreservesColor: true };
        })()`);
        await window.webContents.executeJavaScript(`document.querySelector('.folder-browser').open = false; document.getElementById('detailColorLabels-red').focus(); if (document.activeElement.id !== 'detailColorLabels-red') throw new Error('Cannot focus the color keyboard control');`);
        window.webContents.focus();
        const key = code => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode: code }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: code }); };
        key('Right');
        await window.webContents.executeJavaScript(`(async()=>{const end=Date.now()+3000;while(document.activeElement.id!=='detailColorLabels-orange'){if(Date.now()>end)throw new Error('Arrow did not move color focus');await new Promise(r=>setTimeout(r,10));}})()`);
        key('Home');
        await window.webContents.executeJavaScript(`(async()=>{const end=Date.now()+3000;while(document.activeElement.id!=='detailColorLabels-none'){if(Date.now()>end)throw new Error('Home did not focus clear color');await new Promise(r=>setTimeout(r,10));}})()`);
        key('End');
        await window.webContents.executeJavaScript(`(async()=>{const end=Date.now()+3000;while(document.activeElement.id!=='detailColorLabels-pink'){if(Date.now()>end)throw new Error('End did not focus last color');await new Promise(r=>setTimeout(r,10));}})()`);
        key('Space');
        await window.webContents.executeJavaScript(`(async()=>{
          const ids=${JSON.stringify(result.ids.slice(0, 2))},end=Date.now()+5000;
          while(!ids.every(id=>state.library.assets.find(a=>a.id===id)?.colorLabel==='pink')){if(Date.now()>end)throw new Error('Space did not activate the focused color');await new Promise(r=>setTimeout(r,10));}
          if(state.previewId || !document.getElementById('preview').classList.contains('hidden'))throw new Error('Color Space incorrectly opened an asset preview');
          document.getElementById('detailColorLabels-cyan').click();
          while(!ids.every(id=>state.library.assets.find(a=>a.id===id)?.colorLabel==='cyan')){if(Date.now()>end)throw new Error('Keyboard test could not restore the intended saved color');await new Promise(r=>setTimeout(r,10));}
          document.querySelector('.folder-browser').open=true;
        })()`);
        nativeChoice = 'custom-color-label';
        await window.webContents.executeJavaScript(`(async()=>{
          const check=(condition,message)=>{if(!condition)throw new Error(message);};
          const wait=async(predicate,label)=>{const end=Date.now()+5000;while(!await predicate()){if(Date.now()>end)throw new Error(label);await new Promise(r=>setTimeout(r,10));}};
          const ids=${JSON.stringify(result.ids)},parent=${JSON.stringify(result.parent)},child=${JSON.stringify(result.child)};
          const asset=id=>state.library.assets.find(item=>item.id===id);
          const select=values=>{state.selected=new Set(values);render();toggleDetails(true);renderDetails();};
          const isOpen=()=>!document.getElementById('modalOverlay').classList.contains('hidden');
          const openDetail=async()=>{document.getElementById('detailColorLabels-custom').click();await wait(isOpen,'Custom asset color dialog did not open');};
          const enterHex=value=>{const field=document.getElementById('modalColorHex');field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));};
          const accept=()=>document.getElementById('modalForm').requestSubmit();
          document.querySelector('.folder-browser').open=false;select([ids[0]]);
          await openDetail();enterHex('not-a-color');accept();
          check(isOpen()&&asset(ids[0]).colorLabel==='cyan','Invalid custom hex closed the dialog or changed the saved label');
          check(document.getElementById('modalColorError').textContent||!document.getElementById('modalColorHex').checkValidity(),'Invalid custom hex did not show validation feedback');
          enterHex('#aBc');document.getElementById('modalCancel').click();
          await wait(()=>!isOpen(),'Custom color cancel did not close');check(asset(ids[0]).colorLabel==='cyan','Cancel saved a pending custom color');
          await openDetail();enterHex('#1aB');
          check(document.getElementById('modalColorPicker').value.toLowerCase()==='#11aabb','Hex input did not synchronize the native color input');
          accept();await wait(()=>asset(ids[0]).colorLabel==='#11aabb','Single custom color was not normalized/saved');
          check(document.querySelector('.asset-card[data-asset-id="'+ids[0]+'"] .asset-color-mark')?.dataset.colorLabel==='#11aabb','Single custom color marker missing');
          check(document.getElementById('detailColorLabels-custom').getAttribute('aria-pressed')==='true','Custom selected state was not marked');
          check(!document.querySelector('#detailColorLabels [data-color-label][aria-pressed="true"]'),'Custom color falsely selected a preset');
          document.querySelector('#detailColorLabels [data-color-label=""]').click();
          await wait(()=>asset(ids[0]).colorLabel===null,'Custom color could not be cleared');
          await openDetail();enterHex('#1aB');accept();await wait(()=>asset(ids[0]).colorLabel==='#11aabb','Custom color could not be restored after clearing');
          select([ids[0],ids[1]]);check(document.getElementById('detailColorLabels').dataset.colorMixed==='true','Custom/preset mixed selection not identified');
          await openDetail();const picker=document.getElementById('modalColorPicker');picker.value='#3855a8';picker.dispatchEvent(new Event('input',{bubbles:true}));
          check(document.getElementById('modalColorHex').value.toLowerCase()==='#3855a8','Native color input did not synchronize the hex field');
          accept();await wait(()=>ids.slice(0,2).every(id=>asset(id).colorLabel==='#3855a8'),'Batch custom color was not saved');
          const row=id=>document.querySelector('#folderNav .folder-row[data-folder-id="'+id+'"]');
          document.querySelector('.folder-browser').open=true;row(parent).querySelector('.folder-more').click();document.getElementById('folderColorLabels-custom').click();
          await wait(isOpen,'Custom folder color dialog did not open');enterHex('#dA7');document.getElementById('modalCancel').click();
          check(state.library.folders.find(item=>item.id===parent).colorLabel==='blue','Cancelling custom folder color changed its saved label');
          document.querySelector('.folder-browser').open=true;row(parent).querySelector('.folder-more').click();document.getElementById('folderColorLabels-custom').click();
          await wait(isOpen,'Custom folder color dialog did not reopen');enterHex('#dA7');accept();
          await wait(()=>state.library.folders.find(item=>item.id===parent).colorLabel==='#ddaa77','Folder custom color was not normalized/saved');
          check(state.library.folders.find(item=>item.id===child).colorLabel==='green','Custom folder color propagated into its child');
          const task=showAssetContextMenu(ids[2]);await wait(isOpen,'Native custom color menu did not open its dialog');enterHex('#fAb');accept();await task;
          await wait(()=>asset(ids[2]).colorLabel==='#ffaabb','Native custom color action was not persisted');
          select([ids[0],ids[1]]);document.querySelector('.folder-browser').open=true;
        })()`);
        const library = new Library({ root: result.root }); await library.init();
        const snapshot = library.snapshot();
        assert.deepEqual(result.ids.map(id => snapshot.assets.find(asset => asset.id === id).colorLabel), ['#3855a8', '#3855a8', '#ffaabb']);
        assert.equal(snapshot.folders.find(folder => folder.id === result.parent).colorLabel, '#ddaa77');
        assert.equal(snapshot.folders.find(folder => folder.id === result.child).colorLabel, 'green');
        for (let index = 0; index < fixture.samples.length; index++) {
          const asset = snapshot.assets.find(item => item.id === result.ids[index]);
          assert.equal(asset.hash, fixture.samples[index].hash);
          assert.equal(hash(await fs.readFile(library.getAssetPath(asset.id))), fixture.samples[index].hash);
          assert.equal(hash(await fs.readFile(fixture.samples[index].filename)), fixture.samples[index].hash);
        }
        const backup = await library.backupTo(fixture.backupDirectory); const backupLibrary = new Library({ root: backup.path }); await backupLibrary.init();
        assert.deepEqual(backupLibrary.snapshot().assets, snapshot.assets); assert.deepEqual(backupLibrary.snapshot().folders, snapshot.folders);
        assert.deepEqual(nativeChoices, ['color-pink','custom-color-label']); assert.deepEqual(failures, []); assert.deepEqual(requests, []);
        await window.webContents.executeJavaScript("document.getElementById('toastStack').replaceChildren()");
        let screenshotCaptured = false, screenshotError;
        for (let attempt = 0; attempt < 3 && !screenshotCaptured; attempt++) {
          window.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 150));
          try {
            const [width, height] = window.getContentSize(); const screenshot = await window.webContents.capturePage({ x: 0, y: 0, width, height });
            if (screenshot.isEmpty()) throw new Error('The hidden test window has no rendered frame');
            const png = screenshot.toPNG(); const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
            const expected = '#3855a8'.slice(1).match(/../g).map(value => parseInt(value, 16));
            let pixels = 0;
            for (let offset = 0; offset < data.length; offset += info.channels) if (expected.every((value, channel) => Math.abs(data[offset + channel] - value) < 8)) pixels++;
            if (pixels < 35) throw new Error('Color screenshot did not contain the rendered custom color markers/palette');
            await fs.writeFile(path.join(base, 'color-labels.png'), png); screenshotCaptured = true;
          } catch (error) { screenshotError = error.message; }
        }
        const report = { ok: true, electron: process.versions.electron, ...result, root: undefined, ids: undefined, parent: undefined, child: undefined,
          reopenedColorLabels: true, backupColorLabels: true, colorKeyboardNavigation: true, colorSpaceDoesNotOpenPreview: true,
          customSingleColor: true, customBatchColor: true, customFolderColor: true, customNativeMenu: true, customHexNormalized: true, customCancelPreservesColor: true, customClearAndRestore: true, invalidCustomHexRejected: true,
          originalBytesUnchanged: true, browserNetworkRequests: 0,
          nativeMenuBoundaryMocked: true, screenshotCaptured, ...(screenshotCaptured ? {} : { screenshotError }), userData: app.getPath('userData') };
        await fs.writeFile(resultPath, JSON.stringify(report, null, 2)); completed = true; app.quit();
      } catch (error) { await fail(error); }
    });
  });
  setTimeout(() => fail(new Error('Color UI smoke timed out')), 75000).unref();
};
