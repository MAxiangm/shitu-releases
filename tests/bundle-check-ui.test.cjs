'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const controller = renderer.slice(renderer.indexOf('async function recheckAssetBundle('), renderer.indexOf('function updateExportProgress('));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function harness() {
  const state = { library: { root: 'library-a', assets: [] }, selected: new Set(['model']), busy: false, libraryChanging: false };
  const notices = [], errors = [], applied = [], details = { open: false };
  const context = { state, pendingBundleCheck: null, activeExport: null, closing: false, folderMoveSaving: false, deletingAssets: false,
    historyUi: { pending: false }, hasLibrary: () => true, waitForMetadata: async () => true,
    stopGalleryPreviews() {}, modelWarmup: { pause() {}, schedule() {} }, renderDetails() {}, render() {},
    toast: value => notices.push(value), messageError: error => errors.push(error.message),
    $: () => ({ querySelector: () => details }),
    applyLibrary: snapshot => { applied.push(snapshot); state.library = snapshot; },
    api: { recheckBundles: async () => ({ snapshot: { root: 'library-a', assets: [{ id: 'model', modelBundle: { missing: ['normal.png'] } }] }, errors: [] }) }
  };
  vm.createContext(context); vm.runInContext(controller, context);
  return { state, context, notices, errors, applied, details };
}
test('rechecking an old model refreshes its health and opens the repair details', async () => {
  const h = harness(); await h.context.recheckAssetBundle('model', 'library-a');
  assert.equal(h.applied.length, 1); assert.deepEqual(h.state.library.assets[0].modelBundle.missing, ['normal.png']);
  assert.match(h.notices[0], /缺少 1 项资源/); assert.equal(h.details.open, true);
  assert.equal(h.state.busy, false); assert.equal(h.context.pendingBundleCheck, null);
});
test('a failed resource check reports its error without a successful health claim', async () => {
  const h = harness(); h.context.api.recheckBundles = async () => ({ snapshot: h.state.library, errors: [{ id: 'model', message: '资源包内容已变化' }] });
  await h.context.recheckAssetBundle('model', 'library-a');
  assert.deepEqual(h.errors, ['资源包内容已变化']); assert.equal(h.notices.length, 0); assert.equal(h.state.busy, false);
});
test('incomplete or failed parsing remains a review result rather than a clean verification', async () => {
  const h = harness();
  h.context.api.recheckBundles = async () => ({ snapshot: { root: 'library-a', assets: [{ id: 'model', modelBundle: {
    missing: [], warnings: ['FBX 贴图引用未能完整读取'], resources: { complete: false }
  } }] }, errors: [] });
  await h.context.recheckAssetBundle('model', 'library-a');
  assert.match(h.notices[0], /仍需核对/); assert.doesNotMatch(h.notices[0], /未发现缺失/);
});
test('late resource-check results cannot overwrite another library', async () => {
  const h = harness(), pending = deferred(), started = deferred();
  h.context.api.recheckBundles = () => { started.resolve(); return pending.promise; };
  const task = h.context.recheckAssetBundle('model', 'library-a'); await started.promise;
  h.state.library = { root: 'library-b', assets: [] };
  pending.resolve({ snapshot: { root: 'library-a', assets: [] }, errors: [] }); await task;
  assert.equal(h.applied.length, 0); assert.equal(h.state.library.root, 'library-b'); assert.equal(h.notices.length, 0);
});
test('resource checking rejects duplicate requests until the first request finishes', async () => {
  const h = harness(), pending = deferred(), started = deferred(); let calls = 0;
  h.context.api.recheckBundles = () => { calls++; started.resolve(); return pending.promise; };
  const task = h.context.recheckAssetBundle('model', 'library-a'); await started.promise;
  await h.context.recheckAssetBundle('model', 'library-a'); assert.equal(calls, 1);
  pending.resolve({ snapshot: h.state.library, errors: [] }); await task;
  assert.equal(h.state.busy, false);
});
