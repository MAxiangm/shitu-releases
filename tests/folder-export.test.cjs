'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { projectBundleHash } = require('../src/project-bundle.cjs');
const { safeName, assetBase } = require('../src/asset-export.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = path.resolve(__dirname, '../.recovery/tests');
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(path.join(root, 'folder-export-'));
  const preview = await sharp({ create: { width: 20, height: 12, channels: 3, background: '#43827a' } }).jpeg().toBuffer();
  const library = new Library({ root: path.join(base, 'library'),
    createThumbnail: async (_source, destination) => { await fs.writeFile(destination, preview); return { width: 20, height: 12 }; },
    prepareProjectBundle: async source => {
      const directory = await fs.mkdtemp(path.join(base, 'ae-stage-'));
      const entry = path.basename(source), original = await fs.readFile(source), footage = Buffer.from('footage original bytes');
      await fs.mkdir(path.join(directory, 'Footage'));
      await fs.writeFile(path.join(directory, entry), original);
      await fs.writeFile(path.join(directory, 'Footage', 'clip.mov'), footage);
      const files = [{ path: entry, size: original.length, hash: digest(original) }, { path: 'Footage/clip.mov', size: footage.length, hash: digest(footage) }];
      const manifest = { version: 1, entry, files, missing: [], warnings: [], sourceIdentity: digest(original), hash: projectBundleHash(files, entry), size: original.length + footage.length };
      return { directory, manifest, sourceFiles: [source], cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
    } });
  await library.init();
  t.after(async () => {
    await library.flush();
    const relative = path.relative(root, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  let serial = 0;
  async function image(name, folderId = null) {
    const filename = path.join(base, `source-${++serial}.png`);
    await sharp({ create: { width: 7, height: 9, channels: 3, background: { r: serial, g: 100, b: 180 } } }).png().toFile(filename);
    const imported = await library.importPaths([filename], { folderId });
    assert.equal(imported.imported, 1);
    await library.updateAssets(imported.assetIds, { name });
    return imported.assetIds[0];
  }
  async function model(name, folderId = null, thumbnailCollision = false) {
    const directory = path.join(base, `model-${++serial}`); await fs.mkdir(directory);
    const filename = path.join(directory, 'Original.obj');
    await fs.writeFile(filename, 'mtllib Original.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    await fs.writeFile(path.join(directory, 'Original.mtl'), 'newmtl sample\n' + (thumbnailCollision ? 'map_Kd Chair.jpg\n' : ''));
    if (thumbnailCollision) await fs.writeFile(path.join(directory, 'Chair.jpg'), preview);
    const imported = await library.importPaths([filename], { folderId });
    assert.equal(imported.imported, 1);
    await library.updateAssets(imported.assetIds, { name });
    return imported.assetIds[0];
  }
  async function project(name, folderId = null) {
    const filename = path.join(base, `Original-${++serial}.aep`);
    await fs.writeFile(filename, 'AE original with ./Footage/clip.mov reference');
    const imported = await library.importPaths([filename], { folderId }); assert.equal(imported.imported, 1);
    await library.updateAssets(imported.assetIds, { name }); return imported.assetIds[0];
  }
  async function folder(name, parent = null) { return (await library.createFolder(name, parent)).folders.at(-1).id; }
  return { base, library, preview, image, model, project, folder };
}

test('folder export preserves nested and empty classifications, readable names and original bytes without exporting trash', async t => {
  const f = await fixture(t), parent = await f.folder('客户项目'), child = await f.folder('分镜', parent), leaf = await f.folder('图片', child);
  await f.folder('空文件夹', leaf);
  const first = await f.image('首页.PNG', parent), second = await f.image('山景.最终.png', leaf), trashed = await f.image('已删除', leaf);
  await f.library.setTrash([trashed], true);
  const before = f.library.snapshot();
  const result = await f.library.exportFolder(parent, path.join(f.base, 'exports'));
  assert.equal(path.basename(result.path), '客户项目'); assert.equal(result.exported, 2); assert.equal(result.folders, 4);
  assert.deepEqual(await fs.readdir(path.join(result.path, '分镜', '图片')), ['山景.最终.png', '空文件夹']);
  assert.deepEqual(await fs.readFile(path.join(result.path, '首页.png')), await fs.readFile(f.library.getAssetPath(first)));
  assert.deepEqual(await fs.readFile(path.join(result.path, '分镜', '图片', '山景.最终.png')), await fs.readFile(f.library.getAssetPath(second)));
  assert.deepEqual(f.library.snapshot(), before);
  const again = await f.library.exportFolder(parent, path.join(f.base, 'exports'));
  assert.equal(path.basename(again.path), '客户项目 (1)');
});

test('model and AE packages have independent display-named folders and matching previews while keeping internal names and references', async t => {
  const f = await fixture(t), parent = await f.folder('总项目'); await f.folder('Chair', parent);
  const model = await f.model('Chair.obj', parent), project = await f.project('Chair.aep', parent);
  const result = await f.library.exportFolder(parent, path.join(f.base, 'exports'));
  assert.equal(result.folders, 2); assert.equal(result.exported, 2);
  assert.deepEqual(result.items.map(item => item.name), ['Chair (1)', 'Chair (2)']);
  for (const item of result.items) {
    assert.equal(path.basename(item.thumbnail), `${path.basename(item.path)}.jpg`);
    assert.equal((await sharp(item.thumbnail).metadata()).format, 'jpeg');
  }
  const modelItem = result.items.find(item => item.assetId === model), projectItem = result.items.find(item => item.assetId === project);
  assert.equal((await fs.readFile(path.join(modelItem.path, 'Original.obj'), 'utf8')).includes('mtllib Original.mtl'), true);
  const asset = f.library.snapshot().assets.find(item => item.id === project);
  assert.equal((await fs.readFile(path.join(projectItem.path, asset.projectBundle.entry), 'utf8')).includes('./Footage/clip.mov'), true);
  assert.equal(await fs.readFile(path.join(projectItem.path, 'Footage', 'clip.mov'), 'utf8'), 'footage original bytes');
});

test('a same-named original texture is preserved and the whole package name is disambiguated with its preview', async t => {
  const f = await fixture(t), id = await f.model('Chair', null, true);
  const result = await f.library.exportAssets([id], path.join(f.base, 'exports'));
  assert.equal(path.basename(result.files[0]), 'Chair (1)');
  assert.deepEqual(await fs.readFile(path.join(result.files[0], 'Chair.jpg')), f.preview);
  assert.ok((await fs.stat(path.join(result.files[0], 'Chair (1).jpg'))).isFile());
});

test('Windows file names, case-insensitive collisions and duplicate extensions retain every original and existing export', async t => {
  const f = await fixture(t), ids = [];
  for (const name of ['Photo.PNG', 'photo.png', 'CON', 'clip.final.png', 'bad: name?.png', 'nul.txt']) ids.push(await f.image(name));
  const destination = path.join(f.base, 'exports'); await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'PHOTO.png'), 'existing');
  const result = await f.library.exportAssets(ids, destination);
  assert.deepEqual(result.items.map(item => item.name), ['Photo (1).png', 'photo (2).png', '_CON.png', 'clip.final.png', 'bad_ name_.png', '_nul.txt.png']);
  assert.equal(await fs.readFile(path.join(destination, 'PHOTO.png'), 'utf8'), 'existing');
  for (const item of result.items) assert.deepEqual(await fs.readFile(item.path), await fs.readFile(f.library.getAssetPath(item.assetId)));
  assert.equal(assetBase({ name: 'value.other.JPG', ext: 'jpg' }), 'value.other');
  assert.equal(safeName('A'.repeat(159) + '. end'), 'A'.repeat(159));
});

test('missing and corrupt bundle previews omit only the JPG while exporting every original file', async t => {
  const f = await fixture(t), parent = await f.folder('项目'), id = await f.model('模型', parent), project = await f.project('工程', parent);
  const before = f.library.snapshot(), ids = [id, project];
  for (const assetId of ids) await fs.unlink(f.library.getAssetPath(assetId, 'thumbnail'));
  const output = path.join(f.base, 'exports');
  const verify = async result => {
    assert.equal(result.exported, 2); assert.deepEqual(result.warnings, []); assert.equal(result.missingDependencies, 0);
    const report = JSON.parse(await fs.readFile(result.reportPath, 'utf8'));
    for (const item of result.items) {
      const asset = before.assets.find(value => value.id === item.assetId), bundle = asset.modelBundle || asset.projectBundle;
      assert.equal(item.thumbnail, undefined);
      const actual = [];
      async function walk(directory, prefix = '') {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const relative = prefix + entry.name;
          if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/'); else actual.push(relative);
        }
      }
      await walk(item.path);
      assert.deepEqual(actual.sort(), bundle.files.map(file => file.path).sort());
      const packageReport = report.packages.find(value => value.name === asset.name);
      assert.equal(packageReport.status, 'collected');
      assert.ok(packageReport.notes.some(note => note.includes('未附带缩略图')));
      for (const file of bundle.files) assert.equal(digest(await fs.readFile(path.join(item.path, file.path))), file.hash);
    }
    const after = f.library.snapshot();
    for (const previous of before.assets) {
      const current = after.assets.find(value => value.id === previous.id);
      const oldBundle = previous.modelBundle || previous.projectBundle, newBundle = current.modelBundle || current.projectBundle;
      assert.equal(current.hash, previous.hash); assert.equal(current.filename, previous.filename);
      assert.deepEqual(newBundle.files, oldBundle.files); assert.deepEqual(newBundle.missing, oldBundle.missing);
      assert.equal(newBundle.diagnostics.sourceHash, oldBundle.hash);
    }
  };
  await verify(await f.library.exportFolder(parent, output));
  for (const assetId of ids) await fs.writeFile(f.library.getAssetPath(assetId, 'thumbnail'), 'not a thumbnail');
  await verify(await f.library.exportAssets(ids, output));
});

test('a failed preview supplied by the service is not retried and its original resource files are intact', async t => {
  const f = await fixture(t), id = await f.model('模型');
  const note = '未附带缩略图：未安装预览引擎；原始资源文件照常导出。';
  const result = await f.library.exportAssets([id], path.join(f.base, 'exports'), {
    thumbnailPaths: new Map([[id, null]]), previewNotes: new Map([[id, note]])
  });
  assert.equal(result.items[0].thumbnail, undefined);
  assert.deepEqual((await fs.readdir(result.items[0].path)).sort(), ['Original.mtl', 'Original.obj']);
  const report = JSON.parse(await fs.readFile(result.reportPath, 'utf8'));
  assert.deepEqual(report.packages[0].notes, [note]);
  assert.deepEqual(result.warnings, []); assert.equal(result.missingDependencies, 0);
});

test('a missing original is still fatal when the bundle preview is also missing', async t => {
  const f = await fixture(t), id = await f.model('模型');
  await fs.unlink(f.library.getAssetPath(id, 'thumbnail'));
  await fs.unlink(f.library.getAssetPath(id));
  const output = path.join(f.base, 'exports');
  await assert.rejects(f.library.exportAssets([id], output), /ENOENT|缺失/);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});

test('a late source hash failure rolls back new exports while preserving pre-existing destination contents', async t => {
  const f = await fixture(t), parent = await f.folder('项目'), first = await f.image('正常', parent), second = await f.image('已变化', parent);
  const source = f.library.getAssetPath(second), original = await fs.readFile(source);
  const changed = Buffer.from(original); changed[changed.length - 1] ^= 1; await fs.writeFile(source, changed);
  const destination = path.join(f.base, 'exports'); await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'keep.txt'), 'keep');
  const before = f.library.snapshot();
  await assert.rejects(f.library.exportFolder(parent, destination), /内容校验失败/);
  assert.deepEqual(await fs.readdir(destination), ['keep.txt']);
  await assert.rejects(f.library.exportAssets([first, second], destination), /内容校验失败/);
  assert.deepEqual(await fs.readdir(destination), ['keep.txt']); assert.deepEqual(f.library.snapshot(), before);
});

test('cancellation removes the newly exported hierarchy but preserves earlier exports', async t => {
  const f = await fixture(t), parent = await f.folder('项目'); await f.image('图片', parent); await f.folder('空目录', parent);
  const destination = path.join(f.base, 'exports'); await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'keep.txt'), 'keep');
  const controller = new AbortController();
  await assert.rejects(f.library.exportFolder(parent, destination, { signal: controller.signal, onProgress: event => { if (event.completed === 1) controller.abort(); } }), /abort/i);
  assert.deepEqual(await fs.readdir(destination), ['keep.txt']);
});

test('linked destination ancestors and ordinary source links are refused', async t => {
  const f = await fixture(t), id = await f.image('图片');
  const alias = path.join(f.base, 'alias'); await fs.symlink(f.library.root, alias, 'junction');
  await assert.rejects(f.library.exportAssets([id], path.join(alias, 'exports')), /链接|联接|分开/);
  assert.equal(await fs.access(path.join(f.library.root, 'exports')).then(()=>true,()=>false), false);
  const original = f.library.getAssetPath(id), moved = path.join(f.base, 'source.png'); await fs.rename(original, moved);
  try { await fs.symlink(moved, original, 'file'); }
  catch (error) { if (['EPERM','EACCES'].includes(error.code)) { await fs.rename(moved, original); return; } throw error; }
  await assert.rejects(f.library.exportAssets([id], path.join(f.base, 'exports')), /链接|联接/);
});

test('an empty folder tree exports successfully and whole-library export includes unclassified files', async t => {
  const f = await fixture(t), parent = await f.folder('空项目'); await f.folder('子目录', parent);
  const empty = await f.library.exportFolder(parent, path.join(f.base, 'exports'));
  assert.equal(empty.exported, 0); assert.equal(empty.folders, 2);
  assert.ok((await fs.stat(path.join(empty.path, '子目录'))).isDirectory());
  await f.image('未分类');
  const whole = await f.library.exportFolder(null, path.join(f.base, 'exports'));
  assert.equal(whole.exported, 1); assert.equal(whole.folders, 2);
  assert.ok((await fs.stat(path.join(whole.path, '未分类.png'))).isFile());
});

test('selected assets retain export of original files from the recycle bin', async t => {
  const f = await fixture(t), id = await f.image('回收站图片.png'); await f.library.setTrash([id], true);
  const result = await f.library.exportAssets([id], path.join(f.base, 'exports'));
  assert.equal(result.exported, 1); assert.equal(result.items[0].name, '回收站图片.png');
  assert.deepEqual(await fs.readFile(result.files[0]), await fs.readFile(f.library.getAssetPath(id)));
});

test('pre-existing missing dependencies remain explicit export warnings', async t => {
  const f = await fixture(t), filename = path.join(f.base, 'warning.gltf');
  await fs.writeFile(filename, JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'missing-texture.png' }] }));
  const imported = await f.library.importPaths([filename]); assert.equal(imported.imported, 1);
  await f.library.updateAssets(imported.assetIds, { name: '缺纹理模型' });
  const result = await f.library.exportAssets(imported.assetIds, path.join(f.base, 'exports'));
  assert.ok(result.warnings.some(message => message.includes('缺纹理模型') && message.includes('missing-texture.png')));
  assert.ok((await fs.stat(result.items[0].thumbnail)).isFile());
});

test('nested bundle exports include a portable report with file hashes and all missing dependencies', async t => {
  const f = await fixture(t), parent = await f.folder('项目'), child = await f.folder('模型', parent);
  const missing = Array.from({ length: 7 }, (_, index) => `missing-${index}.png`);
  const filename = path.join(f.base, 'warning.gltf');
  await fs.writeFile(filename, JSON.stringify({ asset: { version: '2.0' }, images: missing.map(uri => ({ uri })) }));
  const imported = await f.library.importPaths([filename], { folderId: child }); assert.equal(imported.imported, 1);
  const result = await f.library.exportFolder(parent, path.join(f.base, 'exports'));
  const report = JSON.parse(await fs.readFile(result.reportPath, 'utf8'));
  assert.equal(path.dirname(result.reportPath), result.path);
  assert.equal(result.missingDependencies, 7);
  assert.equal(report.packages[0].directory, '模型/warning');
  assert.equal(report.packages[0].status, 'missing-dependencies');
  assert.deepEqual(report.packages[0].missing, missing);
  for (const file of report.packages[0].files) {
    assert.equal(file.sha256, digest(await fs.readFile(path.join(result.path, report.packages[0].directory, file.path))));
  }
});

test('legacy AE format caveats are report notes while actual warnings and missing resources remain explicit', async t => {
  const f = await fixture(t), id = await f.project('工程');
  const asset = f.library.data.assets.find(item => item.id === id);
  const note = '字体、第三方插件、表达式动态引用及部分专用格式内部链接需在原软件中核对。';
  asset.projectBundle.warnings = [note];
  const destination = path.join(f.base, 'exports'); await fs.mkdir(destination);
  const oldReport = path.join(destination, 'Mosaic 导出报告.json'); await fs.writeFile(oldReport, 'previous report');
  const first = await f.library.exportAssets([id], destination);
  assert.deepEqual(first.warnings, []); assert.equal(first.missingDependencies, 0);
  assert.notEqual(first.reportPath, oldReport); assert.equal(await fs.readFile(oldReport, 'utf8'), 'previous report');
  const firstReport = JSON.parse(await fs.readFile(first.reportPath, 'utf8'));
  assert.deepEqual(firstReport.packages[0].notes, [note]);
  assert.equal(firstReport.packages[0].status, 'collected');
  const refreshed = f.library.data.assets.find(item => item.id === id);
  refreshed.projectBundle.warnings.push('源工程来自较新 AE 版本');
  refreshed.projectBundle.missing.push('missing.mov');
  const second = await f.library.exportAssets([id], destination);
  assert.equal(second.warnings.length, 2); assert.equal(second.missingDependencies, 1);
  const secondReport = JSON.parse(await fs.readFile(second.reportPath, 'utf8'));
  assert.deepEqual(secondReport.packages[0].warnings, ['源工程来自较新 AE 版本']);
  assert.deepEqual(secondReport.packages[0].missing, ['missing.mov']);
});

test('export refreshes stale FBX manifests so embedded textures stay quiet and unrelated missing textures are reported', async t => {
  const f = await fixture(t), source = path.join(f.base, 'model.fbx');
  await fs.writeFile(source, `Objects: {
    Video: 1, "Video::Paint", "Clip" { RelativeFilename: "model.fbm/paint.png" Content: , "YWJj" }
    Texture: 2, "Texture::Paint", "" { RelativeFilename: "model.fbm/paint.png" }
    Video: 3, "Video::External", "Clip" { RelativeFilename: "other/normal.png" }
  }
  Connections: { C: "OO", 1, 2 }
  `);
  const imported = await f.library.importPaths([source]); assert.equal(imported.imported, 1);
  const asset = f.library.data.assets.find(item => item.id === imported.assetIds[0]);
  asset.modelBundle.missing = [];
  asset.modelBundle.warnings = ['FBX 含内嵌资源，同时保留找到的外置贴图；混合引用请在预览中核对。'];
  const before = f.library.snapshot();
  const result = await f.library.exportAssets(imported.assetIds, path.join(f.base, 'exports'));
  assert.equal(result.missingDependencies, 1);
  assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /other\/normal.png/);
  assert.doesNotMatch(result.warnings[0], /内嵌资源|paint.png/);
  const report = JSON.parse(await fs.readFile(result.reportPath, 'utf8'));
  assert.deepEqual(report.packages[0].missing, ['other/normal.png']);
  const checked = f.library.snapshot().assets.find(item => item.id === asset.id);
  assert.deepEqual(checked.modelBundle.missing, ['other/normal.png']);
  assert.deepEqual(checked.modelBundle.warnings, []);
  assert.equal(checked.hash, before.assets[0].hash);
  assert.deepEqual(checked.modelBundle.files, before.assets[0].modelBundle.files);
  assert.equal(result.snapshot.assets[0].modelBundle.diagnostics.sourceHash, checked.hash);
});

test('FBX export refresh allows parent-relative textures inside a bundle with a nested entry', async t => {
  const f = await fixture(t), directory = path.join(f.base, 'nested-model');
  await fs.mkdir(path.join(directory, 'models'), { recursive: true });
  await fs.mkdir(path.join(directory, 'textures'));
  await fs.writeFile(path.join(directory, 'models', 'object.fbx'), 'Video: 1, "Video::Paint", "Clip" { RelativeFilename: "../textures/paint.png" }');
  await fs.writeFile(path.join(directory, 'textures', 'paint.png'), f.preview);
  const imported = await f.library.importPaths([directory]); assert.equal(imported.imported, 1);
  const asset = f.library.data.assets.find(item => item.id === imported.assetIds[0]);
  assert.equal(asset.modelBundle.entry, 'models/object.fbx');
  const result = await f.library.exportAssets(imported.assetIds, path.join(f.base, 'exports'));
  assert.deepEqual(result.warnings, []); assert.equal(result.missingDependencies, 0);
  assert.deepEqual(await fs.readFile(path.join(result.items[0].path, 'textures', 'paint.png')), f.preview);
});

test('rollback never follows an export root replaced with a junction', async t => {
  const f = await fixture(t), parent = await f.folder('项目'); await f.image('第一', parent); await f.image('第二', parent);
  const destination = path.join(f.base, 'exports'), outside = path.join(f.base, 'outside'); await fs.mkdir(outside);
  const protectedFile = path.join(outside, '第一.png'); await fs.writeFile(protectedFile, 'external bytes');
  let swapped = false;
  await assert.rejects(f.library.exportFolder(parent, destination, { onProgress: event => {
    if (event.completed !== 1 || swapped) return;
    swapped = true;
    fsSync.renameSync(path.join(destination, '项目'), path.join(f.base, 'owned-output'));
    fsSync.symlinkSync(outside, path.join(destination, '项目'), 'junction');
  } }), /未完成|联接|链接/);
  assert.equal(swapped, true); assert.equal(await fs.readFile(protectedFile, 'utf8'), 'external bytes');
});
