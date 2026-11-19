'use strict';
async function executeRendererStep(contents, code) {
  const result = await contents.executeJavaScript(`(async () => {
    try { return { ok: true, value: await (${code}) }; }
    catch (error) { return { ok: false, error: {
      message: String(error?.message || error), stack: String(error?.stack || ''),
      step: String(window.__folderSmokeStep || '')
    } }; }
  })()`);
  if (!result?.ok) {
    const error = result?.error || {};
    throw new Error(`Folder renderer${error.step ? ` (${error.step})` : ''}: ${error.message || 'No script result'}\n${error.stack || ''}`);
  }
  return result.value;
}
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
  const failures = [], requests = [], rendererDiagnostics = [];
  let completed = false, libraryPickerTarget = null;
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => {
    if (!libraryPickerTarget) throw new Error('Folder smoke must not open a native file picker');
    return { canceled: false, filePaths: [libraryPickerTarget] };
  };
  shell.openPath = async () => { throw new Error('Folder smoke must not launch external applications'); };
  shell.openExternal = async () => { throw new Error('Folder smoke must not open the browser'); };
  const fail = async error => {
    if (completed) return; completed = true;
    await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error.stack || String(error), failures, rendererDiagnostics }, null, 2)); app.exit(1);
  };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    requests.push(details.url); callback({ cancel: true });
  }));
  app.on('browser-window-created', (_event, window) => {
    window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.showInactive(); window.webContents.setBackgroundThrottling(false);
    window.webContents.on('render-process-gone', (_event, details) => failures.push('Renderer exited: ' + details.reason));
    window.webContents.on('console-message', (_event, value, message, lineNumber, sourceId) => {
      const entry = typeof value === 'object' && value ? value : { level: value, message, lineNumber, sourceId };
      if (entry.level !== 'error' && entry.level !== 3) return;
      rendererDiagnostics.push({ message: String(entry.message || '').slice(0, 4000), line: entry.lineNumber, source: entry.sourceId });
      if (rendererDiagnostics.length > 20) rendererDiagnostics.shift();
    });
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      try {
        assert.equal(app.getPath('userData'), path.join(base, 'profile'));
        const result = await executeRendererStep(window.webContents, `(async () => {
          window.__folderSmokeStep = 'create and navigate hierarchy';
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
            else if (kind === 'path') { document.getElementById('createFolderHere').click(); await wait(() => !document.getElementById('modalOverlay').classList.contains('hidden'), 'Path bar create folder modal did not open'); }
            else { browser.open = true; document.getElementById('newFolder').click(); await wait(() => !document.getElementById('modalOverlay').classList.contains('hidden'), 'Create folder modal did not open'); }
            const parents = document.getElementById('modalParent');
            if (kind === 'context' || kind === 'path') check(parents.value === (parentId || ''), 'New child defaulted to the wrong parent');
            parents.value = parentId || ''; document.getElementById('modalInput').value = name;
            document.getElementById('modalForm').requestSubmit();
            await wait(() => state.library.folders.some(item => item.name === name && (item.parentId || null) === parentId), 'Created folder was not persisted');
            return state.library.folders.find(item => item.name === name && (item.parentId || null) === parentId).id;
          };
          const initial = await api.getLibrary(); check(initial.stats.total === 0 && !initial.folders.length, 'Folder test library was not empty');
          check(document.getElementById('folderUp').disabled, 'Up must be disabled at the library root');
          check(document.getElementById('folderBack').disabled && document.getElementById('folderForward').disabled, 'A fresh library must not have navigation history');
          const rootA = await createUI('项目 A', null, 'path');
          const childA = await createUI('参考', rootA, 'context');
          const leafA = await createUI('细节', childA, 'path');
          selectFolder(leafA);
          const navigate = async (id, expected) => { document.getElementById(id).click(); await wait(() => state.folder === expected, 'Navigation did not reach the expected folder: ' + id); };
          const breadcrumb = async expected => { const button = document.querySelector('#folderBreadcrumbs [data-folder-id="' + (expected || '') + '"]'); check(button, 'Ancestor breadcrumb is missing'); button.click(); await wait(() => state.folder === expected, 'Ancestor breadcrumb did not navigate'); };
          check(!document.getElementById('folderUp').disabled, 'Up must be enabled inside a folder');
          check(document.querySelector('#folderBreadcrumbs [aria-current="page"]')?.textContent.includes('细节'), 'Current breadcrumb is not identified');
          await navigate('folderUp', childA);
          await navigate('folderBack', leafA);
          await navigate('folderForward', childA);
          await breadcrumb(rootA);
          await navigate('folderBack', childA);
          await navigate('folderForward', rootA);
          await breadcrumb(null);
          check(document.getElementById('folderUp').disabled && state.view === 'all', 'Library root did not disable Up');
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
          window.__folderSmokeStep = 'import assets into nested folders';
          const samples = ${JSON.stringify(fixture.samples)};
          const folderIds = [rootA, childA, leafA, rootB];
          const assetIds = [];
          for (let index = 0; index < 4; index++) {
            const imported = await api.importPaths([samples[index].filename], folderIds[index]);
            check(imported.report.imported === 1 && !imported.report.errors.length, 'Image import into nested folder failed');
            check(imported.snapshot.assets.find(item => item.id === imported.report.assetIds[0]).folderId === folderIds[index], 'Import selected the wrong folder');
            assetIds.push(imported.report.assetIds[0]); applyLibrary(imported.snapshot, false);
          }
          selectFolder(rootA); check(filteredAssets().length === 1 && filteredAssets()[0].id === assetIds[0], 'A folder view mixed descendants into its direct assets');
          window.__folderSmokeStep = 'tree counts and expansion';
          check(document.getElementById('breadcrumbCurrent').textContent.includes('项目 A'), 'Parent breadcrumb missing');
          browser.open = true;
          const count = row(rootA).querySelector('.nav-count'); check(count.textContent === '3', 'Tree count omitted descendant assets');
          const toggle = () => document.querySelector('[data-folder-toggle="' + rootA + '"]');
          check(toggle() && toggle().getAttribute('aria-expanded') === 'true', 'Parent expander was not available');
          toggle().click(); check(!row(childA) || row(childA).getClientRects().length === 0, 'Collapsing a parent left child rows visible');
          toggle().click(); check(row(childA) && row(leafA), 'Expanding a parent did not restore nested rows');
          selectFolder(childA); check(filteredAssets().length === 1 && filteredAssets()[0].id === assetIds[1], 'Child view mixed its descendant into direct assets');
          selectFolder(leafA); check(filteredAssets().length === 1 && filteredAssets()[0].id === assetIds[2], 'Leaf folder view was not exact');
          check(document.getElementById('breadcrumbCurrent').textContent === '项目 A / 参考 / 细节', 'Breadcrumb did not show the complete hierarchy');
          window.__folderSmokeStep = 'details folder destinations';
          changeView('all', rootA); state.selected = new Set([assetIds[1]]); toggleDetails(true); renderDetails();
          const destinations = [...document.getElementById('detailFolder').options];
          check(destinations.find(item => item.value === leafA)?.textContent === '项目 A / 参考 / 细节', 'Details did not show the leaf path');
          check(destinations.find(item => item.value === childB)?.textContent === '项目 B / 参考', 'Details did not distinguish duplicate child names');
          document.getElementById('detailFolder').value = childB; document.getElementById('detailFolder').dispatchEvent(new Event('change', { bubbles: true }));
          await wait(async () => (await api.getLibrary()).assets.find(item => item.id === assetIds[1]).folderId === childB, 'Details did not move the selected image to the child folder');
          applyLibrary(await api.getLibrary(), false);
          window.__folderSmokeStep = 'move folder and verify breadcrumbs';
          await openManage(rootA, 'move');
          const allowedParents = [...document.getElementById('modalParent').options].map(item => item.value);
          check(!allowedParents.includes(rootA) && !allowedParents.includes(childA) && !allowedParents.includes(leafA), 'Move chooser offered the selected folder or its descendants');
          check(allowedParents.includes(rootB), 'Move chooser omitted an unrelated parent');
          document.getElementById('modalCancel').click();
          await openManage(leafA, 'move'); document.getElementById('modalParent').value = childB; document.getElementById('modalForm').requestSubmit();
          await wait(() => state.library.folders.find(item => item.id === leafA)?.parentId === childB, 'Folder move did not persist');
          check(state.library.assets.find(item => item.id === assetIds[2]).folderId === leafA, 'Moving a folder changed the image assignment');
          check(document.getElementById('folderBreadcrumbs').textContent.includes('项目 B') && !document.getElementById('folderBreadcrumbs').textContent.includes('项目 A'), 'Moved folder breadcrumb kept its old parent');
          const extra = await api.createFolder('待整理子级', childA); applyLibrary(extra, false);
          window.__folderSmokeStep = 'delete subtree and prune history';
          const deleteLeaf = extra.folders.find(item => item.name === '待整理子级').id;
          const imported = await api.importPaths([samples[4].filename], deleteLeaf); assetIds.push(imported.report.assetIds[0]); applyLibrary(imported.snapshot, false);
          changeView('all', childA); changeView('all', deleteLeaf); changeView('all', rootA);
          await openManage(childA, 'delete');
          const description = document.getElementById('modalDescription').textContent;
          check(description.includes('1 个子文件夹') && description.includes('保留') && description.includes('未分类'), 'Delete confirmation did not explain subtree and asset preservation');
          document.getElementById('modalForm').requestSubmit();
          await wait(() => !state.library.folders.some(item => item.id === childA || item.id === deleteLeaf), 'Subtree deletion left orphan folder nodes');
          check(state.library.assets.find(item => item.id === assetIds[4]).folderId === null, 'Deleted subtree assets did not return to unfiled');
          check(state.library.assets.find(item => item.id === assetIds[0]).folderId === rootA && state.library.assets.find(item => item.id === assetIds[2]).folderId === leafA, 'Delete changed assets outside its subtree');
          for (const direction of ['folderBack', 'folderForward']) {
            let visits = 0;
            while (!document.getElementById(direction).disabled) {
              check(visits++ < 100, 'Navigation history did not terminate');
              document.getElementById(direction).click();
              check(![childA, deleteLeaf].includes(state.folder), 'Navigation history restored a deleted folder');
            }
          }
          changeView('all', rootB); browser.open = true; state.selected = new Set([assetIds[2]]); toggleDetails(true); renderDetails();
          window.__folderNavigationSmoke = { check, wait, rootA, rootB, childB, leafA };
          return { root: state.library.root, rootA, rootB, childB, leafA, assetIds, sameNameChildren: true, threeLevelCreation: true,
            currentFolderDefault: true, createRootInsideChild: true, directFolderContents: true, expandableTree: true,
            detailFolderPaths: true, moveAssetIntoChild: true, folderMove: true, cycleRejected: true, subtreeDeletePreservesAssets: true,
            pathBarCreateRoot: true, pathBarCreateChild: true, upAndHistoryButtons: true, clickableAncestorBreadcrumbs: true,
            rootUpDisabled: true, movedBreadcrumbUpdated: true, deletedHistoryPruned: true };
        })()`);
        const js = async code => {
          try { return await window.webContents.executeJavaScript(code); }
          catch (error) { throw new Error(`${error.message}\nFolder renderer step: ${code.slice(0, 800)}`); }
        };
        const altKey = keyCode => {
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['alt'] });
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['alt'] });
        };
        await js(`changeView('all', '${result.rootB}'); changeView('all', '${result.leafA}'); document.getElementById('folderUp').focus();`);
        altKey('Up');
        await js(`window.__folderNavigationSmoke.wait(() => state.folder === '${result.childB}', 'Alt+Up did not navigate to the parent')`);
        altKey('Left');
        await js(`window.__folderNavigationSmoke.wait(() => state.folder === '${result.leafA}', 'Alt+Left did not navigate back')`);
        altKey('Right');
        await js(`window.__folderNavigationSmoke.wait(() => state.folder === '${result.childB}', 'Alt+Right did not navigate forward')`);
        await js(`document.getElementById('searchInput').focus()`);
        altKey('Up'); await new Promise(resolve => setTimeout(resolve, 100));
        await js(`window.__folderNavigationSmoke.check(state.folder === '${result.childB}', 'Alt+Up navigated while editing the search input')`);
        await js(`document.getElementById('createFolderHere').click()`);
        altKey('Up'); await new Promise(resolve => setTimeout(resolve, 100));
        await js(`window.__folderNavigationSmoke.check(state.folder === '${result.childB}', 'Alt+Up navigated behind an open modal'); document.getElementById('modalCancel').click();`);
        await js(`openPreview('${result.assetIds[1]}')`);
        altKey('Up'); await new Promise(resolve => setTimeout(resolve, 100));
        await js(`window.__folderNavigationSmoke.check(state.folder === '${result.childB}', 'Alt+Up navigated behind a media preview'); closePreview(); changeView('all', '${result.leafA}');`);
        result.nativeNavigationKeys = true; result.editableAndModalKeyGuards = true; result.previewKeyGuard = true;
        const nativeKey = keyCode => {
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
          if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
          if (keyCode === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        };
        const nativeClick = async selector => {
          const point = await js(`(() => {
            const node = document.querySelector(${JSON.stringify(selector)});
            if (!node) throw new Error('Native click target is missing: ' + ${JSON.stringify(selector)});
            const r = node.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
            const hit = document.elementFromPoint(x, y);
            if (!r.width || !r.height || !hit || !node.contains(hit)) throw new Error('Native click target is covered: ' + ${JSON.stringify(selector)} + ' by ' + (hit?.id || hit?.className));
            return { x, y };
          })()`);
          window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
          await new Promise(resolve => setTimeout(resolve, 40));
          return point;
        };
        const summary = '.folder-browser > summary';
        await js(`document.querySelector('.folder-browser').open = false; document.getElementById('toastStack').replaceChildren();`);
        await nativeClick(summary);
        await js(`window.__folderNavigationSmoke.wait(() => document.querySelector('.folder-browser').open, 'Clicking the folder heading did not open the folder list')`);
        await js(`(() => {
          const popover = document.querySelector('.folder-browser .browser-popover'), row = document.querySelector('#folderNav .folder-row[data-folder-id="${result.rootB}"]');
          const r = row.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          window.__folderNavigationSmoke.check(getComputedStyle(popover).display !== 'none' && r.width > 0 && r.height > 0 && hit && row.contains(hit), 'Opened folder list is hidden or covered by the workspace');
        })()`);
        await nativeClick('[data-folder-toggle="' + result.rootB + '"]');
        await js(`window.__folderNavigationSmoke.check(!document.querySelector('#folderNav .folder-row[data-folder-id="${result.childB}"]'), 'Native collapse left child rows visible')`);
        await nativeClick('[data-folder-toggle="' + result.rootB + '"]');
        await js(`window.__folderNavigationSmoke.check(!!document.querySelector('#folderNav .folder-row[data-folder-id="${result.childB}"]'), 'Native expand did not show child rows')`);
        for (let attempt = 0; attempt < 3 && !result.dropdownScreenshotCaptured; attempt++) {
          window.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 150));
          try {
            const screenshot = await window.webContents.capturePage();
            if (screenshot.isEmpty()) throw new Error('Folder dropdown has no rendered frame');
            await fs.writeFile(path.join(base, 'folder-dropdown.png'), screenshot.toPNG()); result.dropdownScreenshotCaptured = true;
          } catch {}
        }
        await nativeClick('#folderNav .nav-item[data-folder-id="' + result.childB + '"]');
        await js(`window.__folderNavigationSmoke.wait(() => state.folder === '${result.childB}' && !document.querySelector('.folder-browser').open, 'Selecting a folder did not navigate and close the dropdown')`);
        await nativeClick(summary); await nativeClick('#searchInput');
        await js(`window.__folderNavigationSmoke.check(!document.querySelector('.folder-browser').open, 'Outside click did not close the folder dropdown')`);
        await js(`document.querySelector('.folder-browser > summary').focus()`);
        nativeKey('Enter');
        await js(`window.__folderNavigationSmoke.wait(() => document.querySelector('.folder-browser').open, 'Enter did not open the focused folder heading')`);
        nativeKey('Escape');
        await js(`window.__folderNavigationSmoke.wait(() => !document.querySelector('.folder-browser').open, 'Escape did not close the folder dropdown')`);
        await js(`state.selected = new Set(['${result.assetIds[2]}']); updateSelectionClasses(); document.querySelector('.folder-browser > summary').focus();`);
        nativeKey('Space');
        await js(`window.__folderNavigationSmoke.wait(() => document.querySelector('.folder-browser').open && !state.previewId, 'Space on the folder heading opened media or failed to open the folder list')`);
        await nativeClick(summary);
        await js(`window.__folderNavigationSmoke.check(!document.querySelector('.folder-browser').open, 'Second native heading click did not close the folder list'); changeView('all', '${result.leafA}');`);
        result.nativeFolderDropdown = true; result.folderDropdownHitTest = true; result.nativeFolderExpandSelect = true;
        result.dropdownOutsideAndEscape = true; result.dropdownKeyboardDisclosure = true;
        await js(`(() => {
          const { check } = window.__folderNavigationSmoke;
          const cards = () => [...document.querySelectorAll('#folderGallery .folder-card')].map(node => node.dataset.folderId).sort();
          changeView('all');
          check(JSON.stringify(cards()) === JSON.stringify(['${result.rootA}', '${result.rootB}'].sort()), 'Library root did not show only top-level folders');
          check(filteredAssets().length === ${fixture.samples.length}, 'All assets view lost its global scope');
          changeView('all', '${result.rootB}');
          check(JSON.stringify(cards()) === JSON.stringify(['${result.childB}']), 'Parent did not show its direct child folder only');
          check(filteredAssets().length === 1 && filteredAssets()[0].id === '${result.assetIds[3]}', 'Parent folder mixed descendant assets into direct contents');
        })()`);
        const childClickPoint = await nativeClick('#folderGallery .folder-card[data-folder-id="' + result.childB + '"] .folder-card-open');
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 2, ...childClickPoint });
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 2, ...childClickPoint });
        await js(`window.__folderNavigationSmoke.wait(() => state.folder === '${result.childB}', 'Native child folder click did not enter it')`);
        await js(`(() => {
          const { check } = window.__folderNavigationSmoke;
          check(!state.selected.size, 'Opening a folder card selected an asset');
          const cards = [...document.querySelectorAll('#folderGallery .folder-card')].map(node => node.dataset.folderId);
          check(cards.length === 1 && cards[0] === '${result.leafA}', 'Nested child card did not appear after entering its parent');
          check(filteredAssets().length === 1 && filteredAssets()[0].id === '${result.assetIds[1]}', 'Nested folder did not show its direct asset');
          document.querySelector('#folderGallery .folder-card-open').focus();
        })()`);
        await new Promise(resolve => setTimeout(resolve, 320));
        nativeKey('Enter');
        await js(`window.__folderNavigationSmoke.wait(() => state.folder === '${result.leafA}', 'Enter did not open the focused child folder card')`);
        await js(`(() => {
          const { check } = window.__folderNavigationSmoke;
          check(document.querySelectorAll('#folderGallery .folder-card').length === 0, 'Leaf folder showed unrelated child folders');
          check(filteredAssets().length === 1 && filteredAssets()[0].id === '${result.assetIds[2]}', 'Leaf folder did not show its own asset');
          check(document.getElementById('folderBreadcrumbs').textContent.includes('项目 B') && document.getElementById('folderBreadcrumbs').textContent.includes('细节'), 'Child card navigation did not update breadcrumbs');
        })()`);
        const emptyFolders = await js(`(async () => {
          const first = await api.createFolder('空分类', '${result.rootA}');
          const parent = first.folders.find(folder => folder.name === '空分类').id;
          const second = await api.createFolder('空子分类', parent);
          const child = second.folders.find(folder => folder.name === '空子分类').id;
          applyLibrary(second, false); changeView('all', parent);
          const { check } = window.__folderNavigationSmoke;
          check(filteredAssets().length === 0, 'Empty folder fixture unexpectedly contains assets');
          check(document.querySelector('#folderGallery .folder-card[data-folder-id="' + child + '"]'), 'Empty child folder was omitted');
          check(document.getElementById('emptyState').classList.contains('hidden'), 'Folder-only page incorrectly says it is empty');
          return { parent, child };
        })()`);
        await new Promise(resolve => setTimeout(resolve, 320));
        await nativeClick('#folderGallery .folder-card[data-folder-id="' + emptyFolders.child + '"] .folder-card-open');
        await js(`window.__folderNavigationSmoke.wait(() => state.folder === '${emptyFolders.child}', 'Empty child folder could not be opened')`);
        await js(`(() => {
          const { check } = window.__folderNavigationSmoke;
          check(filteredAssets().length === 0 && document.querySelectorAll('#folderGallery .folder-card').length === 0, 'Empty child folder showed unrelated contents');
          check(!document.getElementById('emptyState').classList.contains('hidden'), 'A truly empty child folder lacks its empty state');
          document.getElementById('folderUp').click(); check(state.folder === '${emptyFolders.parent}', 'Up did not return from the empty child');
          for (const view of ['recent', 'favorites', 'unfiled', 'trash']) {
            changeView(view);
            check(document.getElementById('folderChildren').getClientRects().length === 0, 'Virtual view showed root folder cards: ' + view);
          }
        })()`);
        await js(`(async () => {
          const clean = await api.deleteFolder('${emptyFolders.parent}'); applyLibrary(clean, false);
          changeView('all', '${result.rootA}');
          window.__folderNavigationSmoke.check(document.querySelectorAll('#folderGallery .folder-card').length === 0, 'Deleted child folder stayed in the direct folder grid');
          changeView('all', '${result.childB}');
          document.getElementById('toastStack').replaceChildren();
        })()`);
        for (let attempt = 0; attempt < 3 && !result.childFoldersScreenshotCaptured; attempt++) {
          window.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 150));
          try {
            const screenshot = await window.webContents.capturePage();
            if (screenshot.isEmpty()) throw new Error('Child folder page has no rendered frame');
            await fs.writeFile(path.join(base, 'folder-children.png'), screenshot.toPNG()); result.childFoldersScreenshotCaptured = true;
          } catch {}
        }
        await js(`changeView('all', '${result.leafA}')`);
        result.directChildFolderCards = true; result.nativeFolderCardOpen = true; result.keyboardFolderCardOpen = true; result.doubleClickStaysOneLevel = true;
        result.emptyChildFoldersVisible = true; result.folderOnlyPageNotEmpty = true; result.virtualViewsHideFolders = true;
        result.deletedChildCardRemoved = true;
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
        await js("document.getElementById('toastStack').replaceChildren()");
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
        const secondRoot = path.join(base, 'second-library');
        await new Library({ root: secondRoot }).init();
        libraryPickerTarget = secondRoot;
        await js(`(async () => {
          const next = await api.openLibrary(); applyLibrary(next.snapshot, false);
          const { check } = window.__folderNavigationSmoke;
          check(state.library.root !== ${JSON.stringify(result.root)}, 'The isolated second library was not opened');
          check(state.folder === null && state.view === 'all', 'The new library retained the previous folder');
          check(document.getElementById('folderBack').disabled && document.getElementById('folderForward').disabled, 'Navigation history crossed library boundaries');
          check(document.getElementById('folderUp').disabled && !document.getElementById('createFolderHere').disabled, 'Empty library navigation controls are incorrect');
          applyLibrary({ ...next.snapshot, root: null, needsLibrary: true }, false);
          check(document.getElementById('folderUp').disabled && document.getElementById('createFolderHere').disabled, 'Navigation controls are enabled without a library');
        })()`);
        result.libraryHistoryReset = true; result.noLibraryControlsDisabled = true;
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
module.exports.executeRendererStep = executeRendererStep;
