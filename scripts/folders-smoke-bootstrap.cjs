'use strict';
module.exports = function configureFoldersSmoke({ root, base }) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const sharp = require('sharp');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell } = require('electron');
  const { Library } = require(path.join(root, 'src', 'library.cjs'));
  const fixture = require(path.join(base, 'folder-smoke-fixture.json'));
  const resultPath = path.join(base, 'result.json');
  const failures = [], requests = [];
  let completed = false;
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => { throw new Error('Folder smoke must not open a native file picker'); };
  shell.openPath = async () => { throw new Error('Folder smoke must not launch external applications'); };
  shell.openExternal = async () => { throw new Error('Folder smoke must not open the browser'); };
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
          const wait = async (predicate, label) => {
            const deadline = Date.now() + 10000;
            while (!await predicate()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 20)); }
          };
          const browser = document.querySelector('.folder-browser');
          const row = id => document.querySelector('#folderNav .folder-row[data-folder-id="' + id + '"]');
          const selectFolder = id => { browser.open = true; const button = document.querySelector('#folderNav .nav-item[data-folder-id="' + id + '"]'); check(button, 'Folder is not shown in the tree: ' + id); button.click(); };
          const openManage = async (id, action) => {
            browser.open = true; check(row(id), 'Folder management row missing'); row(id).querySelector('.folder-more').click();
            const button = document.querySelector('#folderContextMenu button[data-folder-action="' + action + '"]'); check(button, 'Folder management action missing: ' + action); button.click();
            await wait(() => !document.getElementById('modalOverlay').classList.contains('hidden'), 'Folder modal did not open');
          };
          const createUI = async (name, parentId, kind = 'plus') => {
            if (kind === 'context') await openManage(parentId, 'create');
            else { browser.open = true; document.getElementById('newFolder').click(); await wait(() => !document.getElementById('modalOverlay').classList.contains('hidden'), 'Create folder modal did not open'); }
            const parents = document.getElementById('modalParent');
            if (kind === 'context') check(parents.value === parentId, 'New child defaulted to the wrong parent');
            parents.value = parentId || ''; document.getElementById('modalInput').value = name;
            document.getElementById('modalForm').requestSubmit();
            await wait(() => state.library.folders.some(item => item.name === name && (item.parentId || null) === parentId), 'Created folder was not persisted');
            return state.library.folders.find(item => item.name === name && (item.parentId || null) === parentId).id;
          };
          const initial = await api.getLibrary(); check(initial.stats.total === 0 && !initial.folders.length, 'Folder test library was not empty');
          const rootA = await createUI('项目 A', null);
          const childA = await createUI('参考', rootA, 'context');
          const leafA = await createUI('细节', childA, 'context');
          selectFolder(leafA);
          browser.open = true; document.getElementById('newFolder').click();
          await wait(() => !document.getElementById('modalOverlay').classList.contains('hidden'), 'Current child create modal did not open');
          check(document.getElementById('modalParent').value === leafA, 'The plus button did not default to the current child folder');
          document.getElementById('modalParent').value = ''; document.getElementById('modalInput').value = '项目 B'; document.getElementById('modalForm').requestSubmit();
          await wait(() => state.library.folders.some(item => item.name === '项目 B' && !item.parentId), 'Root folder could not be created from inside a child');
          const rootB = state.library.folders.find(item => item.name === '项目 B').id;
          const same = await api.createFolder('参考', rootB); applyLibrary(same, false);
          const childB = same.folders.find(item => item.name === '参考' && item.parentId === rootB).id;
          check(childB !== childA, 'Same-name children under separate parents lost their identity');
          let cycleRejected = false; try { await api.moveFolder(rootA, leafA); } catch { cycleRejected = true; }
          check(cycleRejected, 'Moving a parent inside its own descendant was accepted');
          const samples = ${JSON.stringify(fixture.samples)};
          const folderIds = [rootA, childA, leafA, rootB];
          const assetIds = [];
          for (let index = 0; index < 4; index++) {
            const imported = await api.importPaths([samples[index].filename], folderIds[index]);
            check(imported.report.imported === 1 && !imported.report.errors.length, 'Image import into nested folder failed');
            check(imported.snapshot.assets.find(item => item.id === imported.report.assetIds[0]).folderId === folderIds[index], 'Import selected the wrong folder');
            assetIds.push(imported.report.assetIds[0]); applyLibrary(imported.snapshot, false);
          }
          selectFolder(rootA); check(filteredAssets().length === 3, 'A parent view did not include direct and nested assets');
          check(document.getElementById('breadcrumbCurrent').textContent.includes('项目 A'), 'Parent breadcrumb missing');
          browser.open = true;
          const count = row(rootA).querySelector('.nav-count'); check(count.textContent === '3', 'Tree count omitted descendant assets');
          const toggle = () => document.querySelector('[data-folder-toggle="' + rootA + '"]');
          check(toggle() && toggle().getAttribute('aria-expanded') === 'true', 'Parent expander was not available');
          toggle().click(); check(!row(childA) || row(childA).getClientRects().length === 0, 'Collapsing a parent left child rows visible');
          toggle().click(); check(row(childA) && row(leafA), 'Expanding a parent did not restore nested rows');
          selectFolder(childA); check(filteredAssets().length === 2, 'Child view did not include its descendant');
          selectFolder(leafA); check(filteredAssets().length === 1 && filteredAssets()[0].id === assetIds[2], 'Leaf folder view was not exact');
          check(document.getElementById('breadcrumbCurrent').textContent === '项目 A / 参考 / 细节', 'Breadcrumb did not show the complete hierarchy');
          changeView('all', rootA); state.selected = new Set([assetIds[1]]); toggleDetails(true); renderDetails();
          const destinations = [...document.getElementById('detailFolder').options];
          check(destinations.find(item => item.value === leafA)?.textContent === '项目 A / 参考 / 细节', 'Details did not show the leaf path');
          check(destinations.find(item => item.value === childB)?.textContent === '项目 B / 参考', 'Details did not distinguish duplicate child names');
          document.getElementById('detailFolder').value = childB; document.getElementById('detailFolder').dispatchEvent(new Event('change', { bubbles: true }));
          await wait(async () => (await api.getLibrary()).assets.find(item => item.id === assetIds[1]).folderId === childB, 'Details did not move the selected image to the child folder');
          applyLibrary(await api.getLibrary(), false);
          await openManage(rootA, 'move');
          const allowedParents = [...document.getElementById('modalParent').options].map(item => item.value);
          check(!allowedParents.includes(rootA) && !allowedParents.includes(childA) && !allowedParents.includes(leafA), 'Move chooser offered the selected folder or its descendants');
          check(allowedParents.includes(rootB), 'Move chooser omitted an unrelated parent');
          document.getElementById('modalCancel').click();
          await openManage(leafA, 'move'); document.getElementById('modalParent').value = childB; document.getElementById('modalForm').requestSubmit();
          await wait(() => state.library.folders.find(item => item.id === leafA)?.parentId === childB, 'Folder move did not persist');
          check(state.library.assets.find(item => item.id === assetIds[2]).folderId === leafA, 'Moving a folder changed the image assignment');
          const extra = await api.createFolder('待整理子级', childA); applyLibrary(extra, false);
          const deleteLeaf = extra.folders.find(item => item.name === '待整理子级').id;
          const imported = await api.importPaths([samples[4].filename], deleteLeaf); assetIds.push(imported.report.assetIds[0]); applyLibrary(imported.snapshot, false);
          await openManage(childA, 'delete');
          const description = document.getElementById('modalDescription').textContent;
          check(description.includes('1 个子文件夹') && description.includes('保留') && description.includes('未分类'), 'Delete confirmation did not explain subtree and asset preservation');
          document.getElementById('modalForm').requestSubmit();
          await wait(() => !state.library.folders.some(item => item.id === childA || item.id === deleteLeaf), 'Subtree deletion left orphan folder nodes');
          check(state.library.assets.find(item => item.id === assetIds[4]).folderId === null, 'Deleted subtree assets did not return to unfiled');
          check(state.library.assets.find(item => item.id === assetIds[0]).folderId === rootA && state.library.assets.find(item => item.id === assetIds[2]).folderId === leafA, 'Delete changed assets outside its subtree');
          changeView('all', rootB); browser.open = true; state.selected = new Set([assetIds[2]]); toggleDetails(true); renderDetails();
          return { root: state.library.root, rootA, rootB, childB, leafA, assetIds, sameNameChildren: true, threeLevelCreation: true,
            currentFolderDefault: true, createRootInsideChild: true, parentIncludesDescendants: true, expandableTree: true,
            detailFolderPaths: true, moveAssetIntoChild: true, folderMove: true, cycleRejected: true, subtreeDeletePreservesAssets: true };
        })()`);
        const library = new Library({ root: result.root }); await library.init();
        const snapshot = library.snapshot();
        assert.equal(snapshot.folders.length, 4); assert.equal(snapshot.assets.length, fixture.samples.length);
        assert.equal(snapshot.folders.find(item => item.id === result.leafA).parentId, result.childB);
        assert.equal(JSON.parse(await fs.readFile(path.join(result.root, 'index.json'), 'utf8')).version, 2);
        for (let index = 0; index < fixture.samples.length; index++) {
          const expected = fixture.samples[index], asset = snapshot.assets.find(item => item.id === result.assetIds[index]);
          assert.equal(asset.hash, expected.hash);
          assert.equal(hash(await fs.readFile(library.getAssetPath(asset.id))), expected.hash, 'Original image changed while editing folder hierarchy');
          assert.equal(hash(await fs.readFile(expected.filename)), expected.hash, 'Source image changed while editing folders');
        }
        const backup = await library.backupTo(fixture.backupDirectory);
        const backupLibrary = new Library({ root: backup.path }); await backupLibrary.init();
        assert.deepEqual(backupLibrary.snapshot().folders, snapshot.folders);
        assert.deepEqual(backupLibrary.snapshot().assets, snapshot.assets);
        assert.deepEqual(failures, []); assert.deepEqual(requests, []);
        await window.webContents.executeJavaScript("document.getElementById('toastStack').replaceChildren()");
        let screenshotCaptured = false, screenshotError;
        for (let attempt = 0; attempt < 3 && !screenshotCaptured; attempt++) {
          window.webContents.invalidate();
          await new Promise(resolve => setTimeout(resolve, 150));
          try {
            const [width, height] = window.getContentSize();
            const screenshot = await window.webContents.capturePage({ x: 0, y: 0, width, height });
            if (screenshot.isEmpty()) throw new Error('The hidden test window has no rendered frame');
            const png = screenshot.toPNG();
            const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
            let samplePixels = 0;
            for (let offset = 0; offset < data.length; offset += info.channels) {
              if (Math.abs(data[offset] - 186) < 9 && Math.abs(data[offset + 1] - 118) < 9 && Math.abs(data[offset + 2] - 48) < 9) samplePixels++;
            }
            if (samplePixels < 50) throw new Error('The hidden test window returned a stale frame; current folder state was validated through the DOM');
            await fs.writeFile(path.join(base, 'nested-folders.png'), png); screenshotCaptured = true;
          } catch (error) { screenshotError = error.message; }
        }
        const report = { ok: true, electron: process.versions.electron, ...result, root: undefined, assetIds: undefined,
          reopenedHierarchy: true, backupHierarchy: true, originalBytesUnchanged: true, indexVersion: 2,
          browserNetworkRequests: 0, screenshotCaptured, ...(screenshotCaptured ? {} : { screenshotError }), userData: app.getPath('userData') };
        await fs.writeFile(resultPath, JSON.stringify(report, null, 2)); completed = true; app.quit();
      } catch (error) {
        try { await fs.writeFile(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
        await fail(error);
      }
    });
  });
  setTimeout(() => fail(new Error('Folder UI smoke timed out')), 75000).unref();
};
