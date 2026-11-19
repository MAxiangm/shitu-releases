'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { app, dialog, session, shell } = require('electron');
const root = path.resolve(__dirname, '..'), tests = path.join(root, '.recovery', 'tests');
const base = path.resolve(process.env.SHITU_SMOKE_DIRECTORY || '');
const relative = path.relative(tests, base);
if (process.env.SHITU_BUNDLE_SMOKE !== '1' || !relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(base).isSymbolicLink())
  throw new Error('Bundle smoke requires a real isolated directory inside .recovery/tests');
const fixture = JSON.parse(fs.readFileSync(path.join(base, 'bundle-smoke-fixture.json'), 'utf8'));
if (!process.env.SHITU_BUNDLE_SMOKE_TOKEN || fixture.token !== process.env.SHITU_BUNDLE_SMOKE_TOKEN) throw new Error('Bundle smoke fixture token mismatch');
for (const name of ['profile', 'sessions', 'crashes', 'plugins']) fs.mkdirSync(path.join(base, name), { recursive: true });
app.setPath('userData', path.join(base, 'profile'));
app.setPath('sessionData', path.join(base, 'sessions'));
app.setPath('crashDumps', path.join(base, 'crashes'));
app.setAppPath(root);
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
process.env.SHITU_LIBRARY = fixture.libraryRoot;
process.env.SHITU_PLUGIN_ROOT = path.join(base, 'plugins');

const failures = [], blockedRequests = [];
let completed = false, lastExport, previewAttempts = 0, repairDialogs = 0, exportDialogs = 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
// Only renderer preparation is replaced. Main IPC, persisted checks, repair,
// package copying, thumbnail fallback and reports remain the real application.
require(path.join(root, 'src', 'model-service.cjs')).createModelService = () => ({
  thumbnail: async (_source, destination) => { await fsp.copyFile(fixture.thumbnail, destination); return { width: 320, height: 240 }; },
  prepare: async () => { throw new Error('3D decode is outside this packaging smoke'); },
  prepareHover: async () => null, warmHover: async () => false, cancelHover: () => false, cancelWarmHover: () => false,
  response: async () => new Response(null, { status: 404 }), hoverResponse: async () => new Response(null, { status: 404 }),
  busy: () => false, invalidate() {}, shutdown: async () => {}
});
const exportModule = require(path.join(root, 'src', 'asset-export-service.cjs'));
const createExportService = exportModule.createAssetExportService;
exportModule.createAssetExportService = options => {
  const service = createExportService({ ...options, prepareModel: async (owner, asset) => {
    assert.equal(owner.root, fixture.libraryRoot); assert.equal(asset.id, fixture.assetId);
    previewAttempts++; throw new Error('测试预览引擎不可用');
  } });
  return { ...service, exportAssets: async (...args) => { lastExport = await service.exportAssets(...args); return lastExport; } };
};
dialog.showErrorBox = (title, content) => failures.push(`${title}: ${content}`);
dialog.showOpenDialog = async (_window, options) => {
  if (options.title === '选择缺失资源所在的文件夹') { repairDialogs++; return { canceled: false, filePaths: [fixture.repairDirectory] }; }
  if (options.title === '选择导出保存位置') { exportDialogs++; return { canceled: false, filePaths: [fixture.exportDirectory] }; }
  throw new Error(`Unexpected native dialog: ${options.title}`);
};
shell.openPath = async () => { throw new Error('Bundle smoke refuses external applications'); };
shell.openExternal = async () => { throw new Error('Bundle smoke refuses external navigation'); };
const fail = async (error, window) => {
  if (completed) return; completed = true;
  if (window && !window.isDestroyed()) try { await fsp.writeFile(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
  await fsp.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), failures, previewAttempts, blockedRequests }, null, 2));
  app.exit(1);
};
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
  blockedRequests.push(details.url); callback({ cancel: true });
}));
app.on('browser-window-created', (_event, window) => {
  window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.showInactive();
  window.setContentSize(1280, 900); window.webContents.setBackgroundThrottling(false);
  window.webContents.on('render-process-gone', (_event, details) => { void fail(new Error(`Renderer exited: ${details.reason}`)); });
  window.webContents.once('did-finish-load', async () => {
    if (!window.webContents.getURL().endsWith('/src/index.html')) return;
    try {
      assert.equal(app.getPath('userData'), path.join(base, 'profile'));
      assert.equal(app.getPath('sessionData'), path.join(base, 'sessions'));
      const checked = await window.webContents.executeJavaScript(`(async () => {
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const wait = async (predicate, message) => { const deadline = Date.now() + 10000; while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); } };
        const id = ${JSON.stringify(fixture.assetId)};
        await wait(() => state.library.assets.some(asset => asset.id === id), 'Fixture did not load');
        const initial = state.library.assets.find(asset => asset.id === id);
        check(initial.modelBundle.missing.length === 0 && !initial.modelBundle.resources && !initial.modelBundle.diagnostics, 'Fixture is not a stale legacy bundle');
        document.querySelector('.asset-card[data-asset-id="' + id + '"]').click();
        if (!state.details) document.getElementById('toggleDetails').click();
        check(document.querySelector('.bundle-details-summary').textContent.includes('尚未检查'), 'Legacy resource counts are not unknown');
        document.querySelector('.bundle-details-recheck').click();
        await wait(() => !pendingBundleCheck && state.library.assets.find(asset => asset.id === id).modelBundle.diagnostics, 'Resource check did not finish');
        const bundle = state.library.assets.find(asset => asset.id === id).modelBundle;
        check(bundle.missing.length === 1 && bundle.missing[0] === 'textures/normal.png', 'Missing external texture not persisted');
        check(bundle.resources.models === 1 && bundle.resources.embeddedTextures === 1 && bundle.resources.externalTextures === 0 && bundle.resources.missingTextures === 1, 'Resource counts are wrong after check');
        check(document.querySelector('.bundle-details-summary').textContent.includes('内嵌贴图 1 张'), 'Embedded count not shown');
        check(document.querySelector('.asset-health-badge')?.textContent.includes('1'), 'Missing badge did not update');
        check(document.querySelector('.asset-health-details')?.open, 'Missing repair details did not open after check');
        const choose = [...document.querySelectorAll('.asset-repair button')].find(button => button.textContent === '查找缺失文件');
        check(choose, 'Missing texture has no repair button'); choose.click();
        await wait(() => document.querySelector('.asset-repair-results [data-match="matched"]'), 'Texture directory did not provide a unique match');
        const apply = [...document.querySelectorAll('.asset-repair button')].find(button => button.textContent === '确认并重新打包');
        check(apply && !apply.classList.contains('hidden') && !apply.disabled, 'Matched texture cannot be applied'); apply.click();
        await wait(() => state.library.assets.find(asset => asset.id === id).modelBundle.missing.length === 0, 'Resource repair did not persist');
        const repaired = state.library.assets.find(asset => asset.id === id).modelBundle;
        check(repaired.resources.embeddedTextures === 1 && repaired.resources.externalTextures === 1 && repaired.resources.missingTextures === 0, 'Repair did not refresh embedded/external counts');
        check(!document.querySelector('.asset-health-badge') && !document.querySelector('.asset-repair'), 'Repaired bundle still has a missing badge or repair panel');
        const inventory = document.querySelector('.bundle-details-inventory'); check(inventory, 'Resource inventory missing'); inventory.open = true;
        document.querySelector('.bundle-details').scrollIntoView({ block: 'center' });
        return { id, checked: bundle.resources, repaired: repaired.resources, hash: repaired.hash, entry: repaired.entry };
      })()`);
      const persisted = JSON.parse(await fsp.readFile(path.join(fixture.libraryRoot, 'index.json'), 'utf8')).assets.find(asset => asset.id === fixture.assetId);
      assert.equal(persisted.modelBundle.missing.length, 0);
      assert.equal(persisted.modelBundle.resources.externalTextures, 1);
      assert.equal(hash(await fsp.readFile(path.join(fixture.libraryRoot, persisted.filename))), fixture.originalHash);
      assert.equal(hash(await fsp.readFile(fixture.source)), fixture.originalHash);
      assert.equal(repairDialogs, 1);
      await fsp.unlink(path.join(fixture.libraryRoot, persisted.thumbnail));
      await window.webContents.executeJavaScript(`document.getElementById('exportSelection').click()`);
      const deadline = Date.now() + 15000;
      while (!lastExport) { if (Date.now() > deadline) throw new Error('UI export did not complete'); await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.equal(lastExport.count, 1); assert.equal(lastExport.warnings.length, 0); assert.equal(lastExport.missingDependencies, 0);
      assert.equal(previewAttempts, 1); assert.equal(exportDialogs, 1); assert.equal(lastExport.items[0].thumbnail, undefined);
      const report = JSON.parse(await fsp.readFile(lastExport.reportPath, 'utf8'));
      assert.equal(report.packages[0].resources.embeddedTextures, 1);
      assert.equal(report.packages[0].resources.externalTextures, 1);
      assert.ok(report.packages[0].notes.some(note => /未附带缩略图.*测试预览引擎不可用/.test(note)));
      const output = lastExport.items[0].path, actualFiles = [];
      async function walk(directory, prefix = '') { for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name; if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + '/'); else actualFiles.push(name);
      } }
      await walk(output);
      assert.deepEqual(actualFiles.sort(), persisted.modelBundle.files.map(file => file.path).sort());
      for (const file of persisted.modelBundle.files) assert.equal(hash(await fsp.readFile(path.join(output, file.path))), file.hash);
      await window.webContents.executeJavaScript(`(async () => { const deadline = Date.now() + 5000; while (activeExport) { if (Date.now() > deadline) throw new Error('Export UI remained busy'); await new Promise(resolve => setTimeout(resolve, 20)); } document.querySelector('.bundle-details-inventory').open = true; document.querySelector('.bundle-details').scrollIntoView({ block: 'center' }); })()`);
      await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 400));
      const screenshotPath = path.join(base, 'bundle-result.png');
      const screenshot = await window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
      assert.equal(screenshot.isEmpty(), false); await fsp.writeFile(screenshotPath, screenshot.toPNG());
      assert.deepEqual(failures, []);
      const result = { ok: true, legacyRecheckPersisted: true, countsUpdatedInUI: true, repairThroughNativePicker: true,
        missingBadgeCleared: true, fbxBytesUnchanged: true, exportWithoutThumbnail: true, originalHashesVerified: actualFiles.length,
        previewAttempts, repairDialogs, exportDialogs, checked: checked.checked, repaired: checked.repaired,
        reportPath: lastExport.reportPath, screenshotPath, isolatedProfile: app.getPath('userData'), blockedRequests };
      await fsp.writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
      completed = true; app.quit();
    } catch (error) { await fail(error, window); }
  });
});
setTimeout(() => { void fail(new Error('Bundle smoke timed out')); }, 75000).unref();
require(path.join(root, 'src', 'main.cjs'));
