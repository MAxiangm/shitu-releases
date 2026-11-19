'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const controller = renderer.slice(renderer.indexOf('function updateExportProgress('), renderer.indexOf('function saveMetadata('));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  const calls = [], notices = [], errors = [], nodes = [];
  const state = { library: { root: 'library-a', folders: [{ id: 'folder-a', name: '项目' }] }, busy: false, libraryChanging: false };
  const element = (tag, _className, text = '') => ({ tag, textContent: text, hidden: false, removed: false,
    setAttribute() {}, append(...children) { this.children = children; }, remove() { this.removed = true; } });
  const context = {
    state, activeExport: null, closing: false, folderMoveSaving: false, deletingAssets: false, historyUi: { pending: false },
    hasLibrary: () => true, waitForMetadata: async () => true,
    api: { exportFolder: async (...args) => { calls.push(['folder', ...args]); return { count: 0, folders: 2, path: 'export/project' }; },
      exportAssets: async (...args) => { calls.push(['assets', ...args]); return { count: 1, folders: 1, path: 'export' }; } },
    folderTreeDrag: { cancel() {} }, assetFolderDrag: { cancel() {} }, closeFolderMenu() {}, stopGalleryPreviews() {},
    modelWarmup: { pause() {}, schedule() {} },
    el: (...args) => { const node = element(...args); nodes.push(node); return node; },
    $: () => ({ append(node) { nodes.push(node); } }), document: { querySelectorAll: () => [] },
    renderHeader() {}, filteredAssets: () => [], renderLibraryState() {}, renderSelection() {}, renderHistory() {},
    applyLibrary: snapshot => { state.library = snapshot; },
    toast: (...args) => notices.push(args), messageError: error => errors.push(error.message)
  };
  vm.createContext(context); vm.runInContext(controller, context);
  return { context, state, calls, notices, errors, nodes };
}

test('folder export keeps zero-asset empty folders and reports the actual output path', async () => {
  const h = harness();
  await h.context.exportLibraryItems('folder', 'folder-a', 'library-a');
  assert.deepEqual(h.calls, [['folder', 'folder-a', 'library-a']]);
  assert.match(h.notices[0][0], /0 个素材 · 2 个分类文件夹/);
  assert.match(h.notices[0][0], /export\/project/);
  assert.equal(h.state.busy, false); assert.equal(h.context.activeExport, null);
});

test('individual asset exports do not mislabel package directories as classification folders', async () => {
  const h = harness();
  await h.context.exportLibraryItems('assets', ['one'], 'library-a');
  assert.match(h.notices[0][0], /1 个素材/);
  assert.doesNotMatch(h.notices[0][0], /分类文件夹/);
});

test('export refreshes the current library with persisted dependency diagnostics', async () => {
  const h = harness();
  const snapshot = { root: 'library-a', folders: h.state.library.folders, assets: [{ id: 'model', modelBundle: { missing: ['normal.png'] } }] };
  h.context.api.exportAssets = async () => ({ count: 1, path: 'export', snapshot });
  await h.context.exportLibraryItems('assets', ['model'], 'library-a');
  assert.equal(h.state.library, snapshot);
});

test('a library switch while metadata is draining prevents an export into the new library', async () => {
  const h = harness(), wait = deferred(); h.context.waitForMetadata = () => wait.promise;
  const exporting = h.context.exportLibraryItems('folder', 'folder-a', 'library-a');
  h.state.library.root = 'library-b'; wait.resolve(true); await exporting;
  assert.equal(h.calls.length, 0); assert.equal(h.state.busy, false);
});

test('duplicate export clicks are rejected until completion and failures release the busy state', async () => {
  const h = harness(), operation = deferred();
  h.context.api.exportAssets = async (...args) => { h.calls.push(args); return operation.promise; };
  const first = h.context.exportLibraryItems('assets', ['one'], 'library-a');
  await Promise.resolve();
  await h.context.exportLibraryItems('assets', ['two'], 'library-a');
  assert.equal(h.calls.length, 1); assert.equal(h.state.busy, true);
  operation.reject(new Error('输出目录不可写')); await first;
  assert.deepEqual(h.errors, ['输出目录不可写']);
  assert.equal(h.state.busy, false); assert.equal(h.context.activeExport, null);
  assert.ok(h.nodes.some(node => node.tag === 'div' && node.removed));
});

test('cancelled export has no success message and incomplete results are surfaced as warnings', async () => {
  const h = harness(); h.context.api.exportFolder = async () => ({ cancelled: true });
  await h.context.exportLibraryItems('folder', 'folder-a', 'library-a');
  assert.equal(h.notices.length, 0);
  h.context.api.exportFolder = async () => ({ count: 2, folders: 3, path: 'export', warnings: [{ message: '名称中的非法字符已替换' }] });
  await h.context.exportLibraryItems('folder', 'folder-a', 'library-a');
  assert.equal(h.notices.length, 2); assert.match(h.notices[1][0], /名称中的非法字符已替换/);
});

test('reported export issues use a short notice and distinguish missing files from review notes', async () => {
  const h = harness();
  const warnings = Array.from({ length: 6 }, (_, index) => `素材 ${index}：需核对`);
  h.context.api.exportFolder = async () => ({ count: 6, folders: 2, path: 'export', reportPath: 'export/Mosaic 导出报告.json', warnings, missingDependencies: 0 });
  await h.context.exportLibraryItems('folder', 'folder-a', 'library-a');
  assert.match(h.notices[1][0], /6 项需核对/); assert.match(h.notices[1][0], /Mosaic 导出报告.json/);
  assert.doesNotMatch(h.notices[1][0], /素材 0/); assert.equal(h.notices[1][1], false);
  h.context.api.exportFolder = async () => ({ count: 1, folders: 1, path: 'export', reportPath: 'export/Mosaic 导出报告.json', warnings: ['缺少贴图'], missingDependencies: 1 });
  await h.context.exportLibraryItems('folder', 'folder-a', 'library-a');
  assert.equal(h.notices[3][1], true);
});

test('progress distinguishes thumbnail preparation from copying and ignores events for another library', async () => {
  const h = harness(), operation = deferred(), started = deferred(); h.context.api.exportAssets = () => { started.resolve(); return operation.promise; };
  const exporting = h.context.exportLibraryItems('assets', ['one'], 'library-a'); await started.promise;
  h.context.updateExportProgress({ root: 'library-a', phase: 'preparing', current: 1, total: 3, name: '模型甲' });
  assert.match(h.context.activeExport.label.textContent, /准备导出缩略图 · 1 \/ 3\n模型甲/);
  h.context.updateExportProgress({ root: 'library-b', phase: 'copying', current: 2, total: 3, name: '不相关' });
  assert.match(h.context.activeExport.label.textContent, /模型甲/);
  h.context.updateExportProgress({ root: 'library-a', phase: 'copying', current: 6, total: 3, name: '模型甲' });
  assert.match(h.context.activeExport.label.textContent, /正在导出文件 · 3 \/ 3/);
  assert.equal(h.context.activeExport.progress.value, 3);
  operation.resolve({ cancelled: true }); await exporting;
});
