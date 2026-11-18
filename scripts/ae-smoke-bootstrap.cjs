'use strict';
module.exports = function configureAESmoke({ root, base }) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const sharp = require('sharp');
  const assert = require('node:assert/strict');
  const { app, dialog, session, shell } = require('electron');
  const { Library } = require(path.join(root, 'src', 'library.cjs'));
  const { resolveAssetFiles } = require(path.join(root, 'src', 'asset-actions.cjs'));
  const { assetMenuTemplate } = require(path.join(root, 'src', 'asset-menu.cjs'));
  const { projectBundleHash } = require(path.join(root, 'src', 'project-bundle.cjs'));
  const fixture = require(path.join(base, 'ae-smoke-fixture.json'));
  const resultPath = path.join(base, 'result.json');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const failures = [], requests = [];
  let completed = false, collectionCalls = 0, stagingCleanups = 0, dialogExports = 0;
  const previewCalls = [];
  const compositions = [
    { id: 41, index: 2, name: '同名合成', width: 640, height: 360, duration: 6, frameRate: 24, workAreaStart: 0, workAreaDuration: 6, usedInCount: 0 },
    { id: 77, index: 3, name: '同名合成', width: 400, height: 400, duration: 3, frameRate: 25, workAreaStart: 0, workAreaDuration: 3, usedInCount: 1 }
  ];
  const collectorModule = require(path.join(root, 'src', 'collector.cjs'));
  collectorModule.createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  // Only the native AE collection and rendering boundaries are mocked. All library persistence,
  // API handlers, renderer behavior and export bytes below use production code.
  const aeModule = require(path.join(root, 'src', 'ae-projects.cjs'));
  aeModule.createAEProjectCollector = () => ({
    prepareProjectBundle: async source => {
      assert.equal(source, fixture.source, 'The smoke must not collect another project');
      collectionCalls++;
      const sourceData = JSON.parse(await fs.readFile(source, 'utf8'));
      const stage = await fs.mkdtemp(path.join(base, 'prepared-'));
      await fs.mkdir(path.join(stage, 'Footage'));
      const entry = '测试分镜.aep';
      const files = [];
      const sourceHashes = [hash(await fs.readFile(source))];
      for (const filename of sourceData.footage) {
        const relative = path.relative(fixture.sourceDirectory, filename).split(path.sep).join('/');
        assert.ok(relative.startsWith('Footage/') && !relative.includes('..'));
        const bytes = await fs.readFile(filename); sourceHashes.push(hash(bytes));
        await fs.copyFile(filename, path.join(stage, relative));
        files.push({ path: relative, size: bytes.length, hash: hash(bytes) });
      }
      const project = Buffer.from(JSON.stringify({ fixtureAEProject: true, collected: true, footage: files.map(file => './' + file.path) }));
      await fs.writeFile(path.join(stage, entry), project);
      files.push({ path: entry, size: project.length, hash: hash(project) });
      const manifest = { version: 1, entry, files, missing: [], warnings: ['测试收集器：未启动 After Effects'],
        collectedWithVersion: 'fixture', compositions, sourceIdentity: hash(sourceHashes.join('\0')), hash: projectBundleHash(files, entry), size: files.reduce((sum, file) => sum + file.size, 0) };
      return { directory: stage, manifest, sourceFiles: [source, ...sourceData.footage], cleanup: async () => {
        assert.equal(path.dirname(stage), base); stagingCleanups++; await fs.rm(stage, { recursive: true, force: true });
      } };
    },
    shutdown: async () => {}
  });
  const aePreviewModule = require(path.join(root, 'src', 'ae-preview.cjs'));
  aePreviewModule.createAEPreviewEngine = ({ cacheDir, onProgress }) => ({
    preview: async options => {
      options.signal?.throwIfAborted();
      const relative = path.relative(path.join(base, 'library', 'originals'), options.source);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Preview must use the managed package');
      const project = JSON.parse(await fs.readFile(options.source, 'utf8'));
      assert.equal(project.collected, true, 'Preview must not reopen the uncollected original');
      const composition = compositions.find(item => item.id === (options.compositionId ?? compositions[0].id));
      assert.ok(composition, 'Unexpected preview composition id'); previewCalls.push(composition.id);
      onProgress?.({ assetHash: options.assetHash, compositionId: composition.id, state: 'rendering', progress: 0.5 });
      await new Promise(resolve => setTimeout(resolve, 35)); options.signal?.throwIfAborted();
      await fs.mkdir(cacheDir, { recursive: true });
      const thumbnailPath = path.join(cacheDir, `fixture-composition-${composition.id}.jpg`);
      await sharp({ create: { width: composition.width, height: composition.height, channels: 3,
        background: composition.id === compositions[0].id ? '#6240b8' : '#168e97' } }).jpeg().toFile(thumbnailPath);
      return { thumbnailPath, composition, compositions, metadata: { width: composition.width, height: composition.height,
        duration: composition.duration, frameRate: composition.frameRate, representativeTime: composition.duration / 2 }, warnings: [], cached: false };
    },
    shutdown: async () => {}
  });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async (_window, options) => {
    assert.equal(options.title, '选择导出保存位置', 'Unexpected native file picker');
    dialogExports++;
    return { canceled: false, filePaths: [fixture.exportedDirectory] };
  };
  // A failing test must never launch a synthetic .aep into the user's live AE.
  shell.openPath = async () => { throw new Error('AE smoke refuses to open external applications'); };
  const fail = async error => {
    if (completed) return;
    completed = true;
    await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error.stack || String(error), failures }, null, 2));
    app.exit(1);
  };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    requests.push(details.url); callback({ cancel: true });
  }));
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      window.show = () => {}; window.hide(); window.setSkipTaskbar(true); window.webContents.setBackgroundThrottling(false);
      try {
        assert.equal(app.getPath('userData'), path.join(base, 'profile'));
        const imported = await window.webContents.executeJavaScript(`(async () => {
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const initial = await api.getLibrary(); check(initial.stats.total === 0, 'AE test library was not empty');
          const result = await api.importPaths([${JSON.stringify(fixture.sourceDirectory)}]);
          check(result.report.imported === 1 && !result.report.errors.length, 'AE project import failed: ' + JSON.stringify(result.report));
          const asset = result.snapshot.assets[0]; check(asset.mediaType === 'project' && asset.projectBundle.files.length === 5, 'Project was not an independent five-file package');
          check(asset.projectBundle.compositions.length === 2 && asset.projectBundle.compositions[0].id !== asset.projectBundle.compositions[1].id, 'Composition identities were not retained');
          applyLibrary(result.snapshot, false);
          state.format = 'project'; check(filteredAssets().length === 1, 'AE format filter omitted the project');
          state.format = 'images'; check(filteredAssets().length === 0, 'AE project appeared among images');
          state.format = 'video'; check(filteredAssets().length === 0, 'AE project appeared among videos');
          state.format = 'model'; check(filteredAssets().length === 0, 'AE project appeared among 3D models'); state.format = 'all';
          await openPluginCenter(undefined, [asset.id]);
          const pluginDeadline = Date.now() + 5000;
          while (!document.querySelector('#sp-sources .sp-no-sources')) {
            if (Date.now() > pluginDeadline) throw new Error('Image plugin center did not finish loading its source list');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          check(document.getElementById('sp-library-count').textContent.includes('0 张图片') && document.querySelectorAll('#sp-sources .sp-source').length === 0, 'AE project was offered to image plugins');
          window.shituPlugins.close();
          const thumbnailDeadline = Date.now() + 10000;
          let withPreview;
          while (true) {
            withPreview = await api.getLibrary();
            if (withPreview.assets[0]?.thumbnail && withPreview.assets[0]?.projectPreview) break;
            if (Date.now() > thumbnailDeadline) throw new Error('AE default composition thumbnail did not generate automatically');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          check(withPreview.assets[0].hash === asset.hash && withPreview.assets[0].projectBundle.hash === asset.projectBundle.hash, 'Preview changed the source package identity');
          applyLibrary(withPreview, false);
          const galleryImage = document.querySelector('.asset-card img');
          check(galleryImage, 'Generated composition thumbnail was not used in the gallery');
          if (!galleryImage.complete) await new Promise((resolve, reject) => { galleryImage.onload = resolve; galleryImage.onerror = () => reject(new Error('Gallery composition image failed')); });
          check(galleryImage.naturalWidth > 0, 'Gallery composition image was empty');
          openPreview(asset.id);
          const overview = document.getElementById('previewProject');
          check(!overview.classList.contains('hidden') && overview.textContent.includes('5 个文件'), 'AE project overview was not displayed');
          const readyDeadline = Date.now() + 10000;
          while (!overview.querySelector('img')?.complete || !overview.querySelector('img')?.naturalWidth) {
            if (Date.now() > readyDeadline) throw new Error('Static AE composition preview was not displayed');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          check(!overview.querySelector('video'), 'AE preview unexpectedly created a video player');
          const compositionSelect = overview.querySelector('select');
          check(compositionSelect && compositionSelect.options.length === 2, 'Composition switcher did not include both same-name compositions');
          const beforeUrl = overview.querySelector('img').src;
          compositionSelect.value = '77'; compositionSelect.dispatchEvent(new Event('change', { bubbles: true }));
          while (overview.querySelector('img')?.src === beforeUrl || !overview.querySelector('img')?.complete || !overview.querySelector('img')?.naturalWidth) {
            if (Date.now() > readyDeadline) throw new Error('Different composition id did not display its own static preview');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          check(overview.querySelector('select').value === '77', 'Same-name composition selection lost its id');
          const button = [...overview.querySelectorAll('button')].find(button => button.textContent.includes('导出完整文件夹'));
          check(button, 'AE project folder export button missing'); button.click();
          return { id: asset.id, root: result.snapshot.root, filename: asset.filename, manifest: asset.projectBundle,
            filters: true, projectOverview: true, automaticCompositionThumbnail: true, staticCompositionPreview: true, sameNameCompositionSwitch: true, imagePluginsExcludeProjects: true };
        })()`);
        const deadline = Date.now() + 10000;
        while (dialogExports !== 1 || !(await fs.readdir(fixture.exportedDirectory).catch(() => [])).length) {
          if (Date.now() > deadline) throw new Error('AE folder export button did not produce a directory');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await window.webContents.executeJavaScript(`(async () => { const deadline = Date.now() + 5000; while (!document.getElementById('toastStack').textContent.includes('素材导出完成')) { if (Date.now() > deadline) throw new Error('AE export did not complete'); await new Promise(resolve => setTimeout(resolve, 20)); } })()`);
        assert.equal(hash(await fs.readFile(fixture.source)), fixture.sourceHash, 'Source project was modified');
        assert.equal(path.relative(base, fixture.sourceDirectory), 'source');
        await fs.rm(fixture.sourceDirectory, { recursive: true, force: true });
        await window.webContents.executeJavaScript(`(async () => {
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          closePreview(); openPreview(${JSON.stringify(imported.id)});
          const deadline = Date.now() + 10000;
          while (!document.querySelector('#previewProject img')?.complete || !document.querySelector('#previewProject img')?.naturalWidth) {
            if (Date.now() > deadline) throw new Error('Packaged AE static preview failed after deleting original sources');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          const prepared = await api.prepareProjectPreview(${JSON.stringify(imported.id)}, ${JSON.stringify(imported.root)}, 77);
          check(prepared.composition.id === 77 && !prepared.url, 'Post-delete preview returned the wrong composition or video');
          const image = new Image();
          await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Post-delete composition URL failed')); image.src = prepared.thumbnailUrl; });
          check(image.naturalWidth === 400, 'Post-delete preview was not the packaged alternate composition');
        })()`);
        const library = new Library({ root: imported.root }); await library.init();
        const exportNames = await fs.readdir(fixture.exportedDirectory);
        assert.equal(exportNames.length, 2);
        assert.ok(exportNames.includes('Mosaic 导出报告.json'), 'AE export did not include the complete diagnostic report');
        const exportedName = exportNames.find(name => name !== 'Mosaic 导出报告.json');
        const exported = path.join(fixture.exportedDirectory, exportedName);
        assert.ok((await fs.stat(exported)).isDirectory(), 'AE export package is not a directory');
        const report = JSON.parse(await fs.readFile(path.join(fixture.exportedDirectory, 'Mosaic 导出报告.json'), 'utf8'));
        assert.equal(report.exportedAssets, 1);
        assert.equal(report.packages.length, 1);
        assert.equal(report.packages[0].directory, exportedName);
        assert.equal(report.packages[0].entry, imported.manifest.entry);
        assert.deepEqual(report.packages[0].missing, []);
        assert.deepEqual(report.packages[0].warnings, imported.manifest.warnings);
        assert.deepEqual(report.packages[0].files, imported.manifest.files.map(file => ({ path: file.path, size: file.size, sha256: file.hash })));
        for (const file of imported.manifest.files) {
          const destination = path.join(exported, file.path);
          assert.equal(hash(await fs.readFile(destination)), file.hash, 'Exported AE package file mismatch: ' + file.path);
          assert.equal(hash(await fs.readFile(library.getProjectFilePath(imported.id, file.path))), file.hash);
        }
        const project = JSON.parse(await fs.readFile(path.join(exported, imported.manifest.entry), 'utf8'));
        for (const relative of project.footage) assert.ok((await fs.stat(path.join(exported, relative))).isFile());
        assert.deepEqual(resolveAssetFiles(library, [imported.id], imported.root).files, [library.getProjectBundleDirectory(imported.id)]);
        const menu = assetMenuTemplate(library.snapshot().assets, [], () => {});
        assert.equal(menu.find(item => item.id === 'copy-image').enabled, false);
        assert.equal(menu.find(item => item.id === 'image-plugins').enabled, false);
        assert.equal(collectionCalls, 1); assert.equal(stagingCleanups, 1); assert.deepEqual(failures, []); assert.deepEqual(requests, []);
        assert.ok(previewCalls.includes(41) && previewCalls.includes(77), 'Both native preview boundaries must be exercised');
        assert.equal(library.snapshot().assets[0].projectPreview.composition.id, 41, 'Alternate composition overwrote the main gallery thumbnail');
        let screenshotCaptured = false;
        try { await fs.writeFile(path.join(base, 'ae-overview.png'), (await window.webContents.capturePage()).toPNG()); screenshotCaptured = true; } catch {}
        await window.webContents.executeJavaScript('closePreview()');
        const result = { ok: true, electron: process.versions.electron, actualAEStarted: false, collectionBoundaryMocked: true,
          imported: 1, packagedFiles: imported.manifest.files.length, filters: imported.filters, projectOverview: imported.projectOverview,
          previewBoundaryMocked: true, automaticCompositionThumbnail: imported.automaticCompositionThumbnail,
          staticCompositionPreview: imported.staticCompositionPreview, sameNameCompositionSwitch: imported.sameNameCompositionSwitch,
          staticPreviewAfterSourceRemoval: true, videoRenderingRequired: false,
          exportButtonProducedFolder: true, exportedFilesMatchManifest: true, exportDiagnosticReportVerified: true, sourcesRemovedAfterImport: true,
          managedDependenciesIndependent: true, dragContainsFullFolder: true, imagePluginsExcludeProjects: true,
          sourceProjectUnchanged: true, stagingCleaned: true, browserNetworkRequests: 0, screenshotCaptured, userData: app.getPath('userData') };
        await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
        completed = true;
        app.quit();
      } catch (error) { await fail(error); }
    });
  });
  setTimeout(() => fail(new Error('AE UI smoke timed out')), 75000).unref();
};
