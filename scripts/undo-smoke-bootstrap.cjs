'use strict';
module.exports = function configureUndoSmoke({ root, base }) {
  const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell } = require('electron');
  const { Library } = require(path.join(root, 'src', 'library.cjs'));
  const fixture = require(path.join(base, 'undo-smoke-fixture.json'));
  const secondRoot = path.join(base, 'second-library');
  const failures = [], network = []; let finished = false, lastWindow;
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [secondRoot] });
  shell.openPath = shell.openExternal = async () => { throw new Error('Undo smoke must not launch external applications'); };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); }));
  const wait = async (check, label) => { const deadline = Date.now() + 15000; while (!await check()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const fail = async error => {
    if (finished) return; finished = true;
    let diagnostic;
    try { diagnostic = await lastWindow.webContents.executeJavaScript('({history:historyUi?.snapshot,pending:historyUi?.pending,toasts:document.getElementById("toastStack").textContent})'); } catch {}
    await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), diagnostic, failures }, null, 2));
    app.exit(1);
  };
  app.on('browser-window-created', (_event, window) => {
    lastWindow = window; window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.showInactive();
    window.webContents.setBackgroundThrottling(false);
    const js = code => window.webContents.executeJavaScript(code);
    const shortcut = async (keyCode, modifiers = ['control']) => {
      window.webContents.focus();
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const focusSurface = () => js('document.activeElement?.blur(); document.body.tabIndex=-1; document.body.focus()');
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      try {
        assert.equal(app.getPath('userData'), path.join(base, 'profile'));
        const setup = await js(`(async()=>{
          const check=(value,label)=>{if(!value)throw new Error(label)};
          const wait=async(test,label)=>{const end=Date.now()+15000;while(!await test()){if(Date.now()>end)throw new Error(label);await new Promise(r=>setTimeout(r,20));}};
          const initial=await api.getLibrary();check(initial.stats.total===0,'Undo test library not empty');
          const folder=async name=>{const s=await api.createFolder(name);return s.folders.find(f=>f.name===name).id;};
          const a=await folder('A'),b=await folder('B'),target=await folder('目标');
          const samples=${JSON.stringify(fixture.samples)};
          const ids=[];for(let i=0;i<samples.length;i++){const r=await api.importPaths([samples[i].filename],i===0?a:i===1?b:null);check(r.report.imported===1,'Import failed');ids.push(r.report.assetIds[0]);}
          applyLibrary(await api.getLibrary(),false);
          const original=state.library.assets.map(v=>({id:v.id,folderId:v.folderId,name:v.name,filename:v.filename,hash:v.hash}));
          check((await api.historyState()).undoCount===0,'Import or create folder unexpectedly entered undo history');
          window.__undoSmoke={check,wait,ids,a,b,target,original,root:state.library.root,read:id=>state.library.assets.find(v=>v.id===id)};
          const s=await api.moveAssetsToFolder(ids.slice(0,2),target,state.library.root);applyLibrary(s);
          await wait(()=>!document.getElementById('undoHistoryButton').disabled,'Undo button missing');
          const undoRect=document.getElementById('undoHistoryButton').getBoundingClientRect(),createRect=document.getElementById('createFolderHere').getBoundingClientRect();
          check(Math.abs(undoRect.top-createRect.top)<12,'History buttons pushed new folder onto a separate row');
          check(s.history.undoCount===1,'Batch move must create one history step');
          return {root:state.library.root,ids,a,b,target,original,moveId:s.history.undoId};
        })()`);
        await focusSurface(); await shortcut('Z');
        await wait(() => js('__undoSmoke.ids.slice(0,2).every((id,i)=>__undoSmoke.read(id).folderId===[__undoSmoke.a,__undoSmoke.b][i])'), 'Ctrl+Z did not restore each original folder');
        await js('__undoSmoke.check(historyUi.snapshot.redoCount===1,"Redo entry missing")');
        await focusSurface(); await shortcut('Z', ['control', 'shift']);
        await wait(() => js('__undoSmoke.ids.slice(0,2).every(id=>__undoSmoke.read(id).folderId===__undoSmoke.target)'), 'Ctrl+Shift+Z did not redo the move');
        const metadata = await js(`(async()=>{
          const x=__undoSmoke;
          const s=await api.updateAssets(x.ids.slice(0,2),{name:'批量命名',tags:['共同'],colorLabel:'#abc'});applyLibrary(s);
          await x.wait(()=>document.querySelector('[data-history-undo-id="'+s.history.undoId+'"]'),'Action toast undo missing');
          return {id:s.history.undoId};
        })()`);
        await js(`document.querySelector('[data-history-undo-id="${metadata.id}"]').click()`);
        await wait(() => js('__undoSmoke.ids.slice(0,2).every(id=>{const v=__undoSmoke.read(id);return v.name!=="批量命名"&&!v.tags.length&&!v.colorLabel})'), 'Toast undo did not restore metadata');
        await js(`(async()=>{
          const x=__undoSmoke;
          applyLibrary(await api.updateAssets([x.ids[0]],{tags:['A标签']}));
          applyLibrary(await api.updateAssets([x.ids[1]],{tags:['B标签']}));
          const before=(await api.historyState()).undoCount;
          state.selected=new Set(x.ids.slice(0,2));render();toggleDetails(true);renderDetails();
          const input=document.getElementById('detailTags');input.value='共享标签';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
          await x.wait(()=>x.ids.slice(0,2).every(id=>x.read(id).tags.includes('共享标签')),'Batch tags failed');
          x.check((await api.historyState()).undoCount===before+1,'Batch tags were split across history steps');
          document.getElementById('undoHistoryButton').click();
          await x.wait(()=>!x.ids.slice(0,2).some(id=>x.read(id).tags.includes('共享标签')),'One undo did not restore all original tag sets');
          x.check(x.read(x.ids[0]).tags.join()==='A标签'&&x.read(x.ids[1]).tags.join()==='B标签','Per-asset tags were lost');
          const history=await api.historyState();x.redoId=history.redoId;
          applyLibrary(await api.updateAssets([x.ids[2]],{name:'新的分支'}));
          x.check(!(await api.historyState()).canRedo,'A new edit did not clear the redo branch');
          const beforeState=JSON.stringify(state.library.assets);
          let rejected=false;try{await api.undoHistory(x.root,'${setup.moveId}')}catch{rejected=true}
          x.check(rejected,'Outdated action ID was allowed to undo a different edit');
          x.check(JSON.stringify((await api.getLibrary()).assets)===beforeState,'Outdated undo changed data');
          state.selected=new Set([x.ids[0]]);render();toggleDetails(true);renderDetails();
          const name=document.getElementById('detailName');name.focus();name.setSelectionRange(name.value.length,name.value.length);
          x.beforeTyping=name.value;x.beforeTypingHistory=(await api.historyState()).undoId;
        })()`);
        window.webContents.insertText('临时文字'); await shortcut('Z');
        await js(`(async()=>{const x=__undoSmoke;x.check(document.getElementById('detailName').value===x.beforeTyping,'Text field did not retain native undo');x.check((await api.historyState()).undoId===x.beforeTypingHistory,'Text undo affected library history');})()`);
        await js(`(()=>{const input=document.getElementById('detailName');input.value='未提交的名称';document.getElementById('undoHistoryButton').click();})()`);
        await wait(() => js('__undoSmoke.read(__undoSmoke.ids[0]).name===__undoSmoke.beforeTyping&&!historyUi.pending'), 'Undo did not flush and undo the pending name edit');
        await js(`(async()=>{
          const x=__undoSmoke;
          const before=state.library.folders.find(f=>f.id===x.a).name;
          applyLibrary(await api.renameFolder(x.a,'文件夹改名'));document.getElementById('undoHistoryButton').click();
          await x.wait(()=>state.library.folders.find(f=>f.id===x.a).name===before,'Folder name undo failed');
          applyLibrary(await api.setFolderColor(x.a,'#124578'));document.getElementById('undoHistoryButton').click();
          await x.wait(()=>!state.library.folders.find(f=>f.id===x.a).colorLabel,'Folder color undo failed');
          x.check(document.getElementById('toastStack').children.length<=3,'Notifications overflow the work area');
        })()`);
        let screenshot = false;
        for (let attempt = 0; attempt < 3 && !screenshot; attempt++) {
          try { window.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 100)); const picture = await window.webContents.capturePage(); if (!picture.isEmpty()) { await fs.writeFile(path.join(base, 'undo-history.png'), picture.toPNG()); screenshot = true; } } catch {}
        }
        const saved = JSON.parse(await fs.readFile(path.join(setup.root, 'index.json'), 'utf8'));
        assert.equal(Object.hasOwn(saved, 'history'), false, 'Session history must not enter the library format');
        for (const original of setup.original) {
          const bytes = await fs.readFile(path.join(setup.root, original.filename));
          assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), original.hash);
        }
        await new Library({ root: secondRoot }).init();
        await js(`(async()=>{const x=__undoSmoke;const r=await api.openLibrary();applyLibrary(r.snapshot,false);await x.wait(()=>document.getElementById('undoHistoryButton').disabled&&document.getElementById('redoHistoryButton').disabled,'History not reset for the new library');let rejected=false;try{await api.undoHistory(x.root)}catch{rejected=true}x.check(rejected,'Stale-library undo accepted');})()`);
        assert.deepEqual(failures, []); assert.deepEqual(network, []);
        const report = { ok: true, electron: process.versions.electron, keyboardUndo: true, keyboardRedo: true, batchOriginalFolders: true,
          toastUndo: true, staleToastRejected: true, batchTagsOneStep: true, nativeTextUndo: true, pendingDraftFlushed: true,
          folderNameAndColor: true, newEditClearsRedo: true, libraryIsolation: true, historyNotPersistedInIndex: true,
          originalFilesUnchanged: true, screenshotCaptured: screenshot, networkRequests: 0 };
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(report, null, 2));
        finished = true; window.destroy(); app.quit();
      } catch (error) { await fail(error); }
    });
  });
};
