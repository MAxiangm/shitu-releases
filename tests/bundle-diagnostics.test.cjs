'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { recheckStoredBundle } = require('../src/bundle-diagnostics.cjs');
const { projectBundleHash, validateProjectBundle } = require('../src/project-bundle.cjs');

const testsRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
const aeNote = '字体、第三方插件、表达式动态引用及部分专用格式内部链接需在原软件中核对。';
const fbxNote = 'FBX 含内嵌资源，同时保留找到的外置贴图；混合引用请在预览中核对。';
async function project(t, model) {
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'bundle-diagnostics-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), testsRoot);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const files = [];
  for (const [name, bytes] of [['project.aep', Buffer.from('fixture project')], ...(model === undefined ? [] : [['model.fbx', Buffer.from(model)]])]) {
    await fs.writeFile(path.join(directory, name), bytes);
    files.push({ path: name, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifest = { version: 1, entry: 'project.aep', files, size: files.reduce((sum, file) => sum + file.size, 0),
    hash: projectBundleHash(files, 'project.aep'), missing: ['missing.mov', '模型依赖：model.fbm/paint.png'],
    warnings: [aeNote, fbxNote, '源工程来自 AE 2026，本包由 AE 2025 收集，导出需对应或更新版本打开。', '第三方扩展需要核对自定义缓存'], notes: [] };
  return { directory, manifest };
}

test('AE recheck replaces resolved nested FBX issues while retaining footage, version and unknown warnings', async t => {
  const fbx = 'Objects: { Video: 1, "Video::Paint", "Clip" { RelativeFilename: "model.fbm/paint.png" Content: , "YWJj" } }';
  const { directory, manifest } = await project(t, fbx);
  const result = await recheckStoredBundle(directory, manifest, { project: true });
  assert.deepEqual(result.missing, ['missing.mov']);
  assert.deepEqual(result.warnings, manifest.warnings.slice(2));
  assert.deepEqual(result.notes, [aeNote]);
  assert.equal(result.resources.embeddedTextures, 1); assert.equal(result.resources.complete, false);
  assert.equal(result.diagnostics.sourceHash, manifest.hash);
  validateProjectBundle({ ...manifest, ...result });
  assert.equal(await fs.readFile(path.join(directory, 'model.fbx'), 'utf8'), fbx);
});

test('AE recheck preserves unattributed model diagnostics when no stored model was inspected', async t => {
  const { directory, manifest } = await project(t);
  const result = await recheckStoredBundle(directory, manifest, { project: true });
  assert.deepEqual(result.missing, manifest.missing);
  assert.deepEqual(result.warnings, manifest.warnings.slice(1));
});

test('AE recheck retains prior nested missing references when the current model could not be parsed completely', async t => {
  const { directory, manifest } = await project(t, 'Video: 1, "Video::Paint", "Clip" { Content: "unterminated');
  const result = await recheckStoredBundle(directory, manifest, { project: true });
  assert.deepEqual(result.missing, manifest.missing);
  assert.equal(result.warnings.includes(fbxNote), false);
  assert.ok(result.warnings.some(message => message.startsWith('FBX 贴图引用未能完整读取：')));
  assert.ok(result.warnings.includes(manifest.warnings[2]));
});
