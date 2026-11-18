'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createAEProjectCollector, sequenceFiles, readBridgeReport, projectYear, launchAfterEffects, listAfterEffectsTools } = require('../src/ae-projects.cjs');
const { copyProjectBundle, validateProjectBundle } = require('../src/project-bundle.cjs');
const testsRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
async function fixture(t) {
  await fs.mkdir(testsRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testsRoot, 'ae-project-test-'));
  t.after(async () => {
    const relative = path.relative(testsRoot, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  const sourceDirectory = path.join(base, 'Original'); await fs.mkdir(sourceDirectory);
  const source = path.join(sourceDirectory, '工程 test.aep'); await fs.writeFile(source, 'RIFX synthetic project');
  const image = path.join(sourceDirectory, '材质.png'); await fs.writeFile(image, 'PNG synthetic source bytes');
  return { base, sourceDirectory, source, image };
}
function bridge(report, token, references = []) {
  const encoded = encodeURIComponent(JSON.stringify(report));
  return '<?xml version="1.0"?><AfterEffectsProject>' + references.map(reference => `<fileReference fullpath="${reference.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/>`).join('') +
    `<Comment>SHITU_AE_REPORT_V1:${token}:0:1:${encoded}</Comment></AfterEffectsProject>`;
}
function launcher(records, observe = () => {}) {
  return async (executable, args, settings) => {
    assert.ok(args.includes('-m') && args.includes('-noui') && args.includes('-r'));
    assert.equal(settings.env.ELECTRON_RUN_AS_NODE, undefined);
    const job = JSON.parse(await fs.readFile(settings.env.SHITU_AE_JOB, 'utf8'));
    await observe(job, settings, args);
    let sources = records;
    if (job.mode === 'collect') {
      const rewritten = await fs.readFile(job.source, 'utf8');
      const replacements = [...rewritten.matchAll(/fullpath="([^"]+)"/g)].map(match => match[1].replace(/&amp;/g, '&'));
      sources = records.map((record, index) => ({ ...record, source: replacements[index] || record.source }));
      await fs.writeFile(job.output, `RIFX collected project at ${job.output}`);
    }
    await fs.writeFile(job.reportProject, bridge({ ok: true, version: '17.0.1x52', sources, compositions: [] }, job.token, records.map(record => record.source)));
    return { code: 0, output: '' };
  };
}
function collector(t, item, launch) {
  const instance = createAEProjectCollector({ cacheDir: path.join(item.base, 'cache'), toolLocator: async () => ({ executable: process.execPath, year: 2020 }), launch });
  t.after(() => instance.shutdown()); return instance;
}

test('AE collection uses a fresh instance, copies and relinks footage, preserves source bytes and returns a validated independent bundle', async t => {
  const item = await fixture(t), records = [{ source: item.image, role: 'main', isStill: true, missing: false, useProxy: false }];
  const instance = collector(t, item, launcher(records));
  const original = await fs.readFile(item.source);
  const prepared = await instance.prepareProjectBundle(item.source);
  t.after(() => prepared.cleanup());
  assert.equal(prepared.manifest.entry, path.basename(item.source));
  assert.equal(prepared.manifest.collectedWithVersion, '17.0.1x52');
  assert.equal(prepared.manifest.files.length, 2);
  assert.deepEqual(prepared.manifest.warnings, []);
  assert.deepEqual(prepared.manifest.notes, ['字体、第三方插件、表达式动态引用及部分专用格式内部链接需在原软件中核对。']);
  const copiedManifest = await copyProjectBundle(prepared, path.join(item.base, 'Copied project'));
  assert.deepEqual(copiedManifest.notes, prepared.manifest.notes);
  assert.deepEqual(copiedManifest.warnings, []);
  for (const notes of [null, 'invalid', [42], ['x'.repeat(4097)], Array(100001).fill('note')]) {
    assert.throws(() => validateProjectBundle({ ...prepared.manifest, notes }), /提示信息无效/);
  }
  assert.doesNotThrow(() => validateProjectBundle({ ...prepared.manifest, notes: undefined }));
  assert.ok(prepared.sourceFiles.includes(item.image));
  await fs.rename(item.sourceDirectory, path.join(item.base, 'Source hidden'));
  const copiedImage = prepared.manifest.files.find(file => file.path.endsWith('.png'));
  assert.equal(await fs.readFile(path.join(prepared.directory, copiedImage.path), 'utf8'), 'PNG synthetic source bytes');
  assert.deepEqual(await fs.readFile(path.join(item.base, 'Source hidden', path.basename(item.source))), original);
});

test('stable AE source identity ignores staging project bytes but changes when a dependency changes', async t => {
  const item = await fixture(t), records = [{ source: item.image, role: 'main', isStill: true, missing: false }];
  const instance = collector(t, item, launcher(records));
  const first = await instance.prepareProjectBundle(item.source), second = await instance.prepareProjectBundle(item.source);
  t.after(() => first.cleanup()); t.after(() => second.cleanup());
  assert.equal(first.manifest.sourceIdentity, second.manifest.sourceIdentity);
  assert.notEqual(first.manifest.hash, second.manifest.hash);
  await fs.writeFile(item.image, 'Changed image bytes');
  const changed = await instance.prepareProjectBundle(item.source); t.after(() => changed.cleanup());
  assert.notEqual(changed.manifest.sourceIdentity, first.manifest.sourceIdentity);
});

test('missing AE footage remains explicit and same-name footage in separate folders never overwrites', async t => {
  const item = await fixture(t), otherDirectory = path.join(item.sourceDirectory, 'Other'); await fs.mkdir(otherDirectory);
  const other = path.join(otherDirectory, path.basename(item.image)); await fs.writeFile(other, 'Other image bytes');
  const missing = path.join(item.sourceDirectory, 'Missing.mov');
  const records = [{ source: item.image, role: 'main', isStill: true, missing: false }, { source: other, role: 'proxy', isStill: true, missing: false, useProxy: false }, { source: missing, role: 'main', missing: true }];
  const instance = collector(t, item, launcher(records));
  const prepared = await instance.prepareProjectBundle(item.source); t.after(() => prepared.cleanup());
  assert.deepEqual(prepared.manifest.missing, [missing]);
  assert.deepEqual(prepared.manifest.warnings, []);
  assert.equal(prepared.manifest.notes.length, 1);
  assert.equal(prepared.manifest.files.filter(file => file.path.endsWith('.png')).length, 2);
});

test('AE version compatibility warnings remain actionable warnings beside collection notes', async t => {
  const item = await fixture(t);
  await fs.writeFile(item.source, '<xmp:CreatorTool>Adobe After Effects 2020 (Windows)</xmp:CreatorTool>');
  const instance = createAEProjectCollector({ cacheDir: path.join(item.base, 'cache'),
    toolLocator: async () => ({ executable: process.execPath, year: 2025 }), launch: launcher([]) });
  t.after(() => instance.shutdown());
  const prepared = await instance.prepareProjectBundle(item.source); t.after(() => prepared.cleanup());
  assert.equal(prepared.manifest.warnings.length, 1);
  assert.match(prepared.manifest.warnings[0], /源工程来自 AE 2020.*AE 2025/);
  assert.equal(prepared.manifest.notes.length, 1);
  assert.deepEqual(prepared.manifest.missing, []);
});

test('confirmed AE repairs rewrite the missing source and verify it opens from the rebuilt package', async t => {
  const item = await fixture(t);
  const missing = path.join(item.sourceDirectory, 'not-found', path.basename(item.image));
  const remembered = { itemId: 1, source: missing, role: 'main', isStill: true, missing: true };
  let relinked;
  const instance = collector(t, item, async (_exe, _args, settings) => {
    const job = JSON.parse(await fs.readFile(settings.env.SHITU_AE_JOB, 'utf8'));
    let record = remembered;
    if (job.mode === 'collect') {
      const xml = await fs.readFile(job.source, 'utf8');
      relinked = /fullpath="([^"]+)"/.exec(xml)[1];
      assert.notEqual(relinked, missing);
      assert.deepEqual(await fs.readFile(relinked), await fs.readFile(item.image));
      record = { ...record, source: relinked, missing: false };
      await fs.writeFile(job.output, 'RIFX repaired project');
    }
    await fs.writeFile(job.reportProject, bridge({ ok: true, version: '17.0.1x52', sources: [record], compositions: [] }, job.token, [record.source]));
    return { code: 0 };
  });
  const bytes = await fs.readFile(item.image);
  const prepared = await instance.prepareProjectBundle(item.source, {
    replacements: new Map([[missing, { filename: item.image, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') }]])
  });
  t.after(() => prepared.cleanup());
  assert.deepEqual(prepared.manifest.missing, []);
  assert.ok(prepared.manifest.files.some(file => path.join(prepared.directory, file.path) === relinked));
  assert.equal(await fs.readFile(item.source, 'utf8'), 'RIFX synthetic project');
});

test('sequence enumeration collects all matching frames without mistaking numbered movies or unrelated images for a sequence', async t => {
  const item = await fixture(t);
  for (const name of ['frame-0001.png', 'frame-0002.png', 'frame-0003.png', 'unrelated.png', 'frame-01.png', 'frame-0001.jpg']) await fs.writeFile(path.join(item.sourceDirectory, name), name);
  const frames = await sequenceFiles({ source: path.join(item.sourceDirectory, 'frame-0001.png'), isStill: false });
  assert.deepEqual(frames.map(file => path.basename(file)), ['frame-0001.png', 'frame-0002.png', 'frame-0003.png']);
  assert.deepEqual(await sequenceFiles({ source: path.join(item.sourceDirectory, 'clip-0001.mp4'), isStill: false }), [path.join(item.sourceDirectory, 'clip-0001.mp4')]);
});

test('a first frame used both as a still and as a sequence collects every frame while retaining the original interpretation', async t => {
  const item = await fixture(t);
  const first = path.join(item.sourceDirectory, 'frame-0001.png');
  for (const name of ['frame-0001.png', 'frame-0002.png', 'frame-0003.png']) await fs.writeFile(path.join(item.sourceDirectory, name), name);
  const records = [{ itemId: 1, source: first, role: 'main', isStill: true, missing: false },
    { itemId: 2, source: first, role: 'main', isStill: false, missing: false, interpretation: { conformFrameRate: 12 } }];
  const instance = collector(t, item, launcher(records));
  const prepared = await instance.prepareProjectBundle(item.source); t.after(() => prepared.cleanup());
  assert.equal(prepared.manifest.files.filter(file => /frame-\d+\.png$/.test(file.path)).length, 3);
  assert.equal(prepared.manifest.missing.length, 0);
});

test('newly missing footage or a malformed final source graph cannot be reported as a complete collected package', async t => {
  const item = await fixture(t), records = [{ itemId: 1, source: item.image, role: 'main', isStill: true, missing: false }];
  for (const malformed of [false, true]) {
    const normal = launcher(records);
    const instance = collector(t, item, async (...args) => {
      await normal(...args);
      const job = JSON.parse(await fs.readFile(args[2].env.SHITU_AE_JOB, 'utf8'));
      if (job.mode === 'collect') await fs.writeFile(job.reportProject, bridge({ ok: true,
        ...(malformed ? {} : { sources: [{ ...records[0], missing: true }] }) }, job.token));
      return { code: 0, output: '' };
    });
    await assert.rejects(instance.prepareProjectBundle(item.source), malformed ? /清单不一致/ : /重定位后素材缺失/);
    await instance.shutdown();
  }
});

test('a model sharing the first sequence frame never replaces the AE sequence directory with its single-texture folder', async t => {
  const item = await fixture(t), textures = path.join(item.sourceDirectory, 'textures'); await fs.mkdir(textures);
  for (const frame of ['frame-0001.png', 'frame-0002.png', 'frame-0003.png']) await fs.writeFile(path.join(textures, frame), frame);
  const first = path.join(textures, 'frame-0001.png'), model = path.join(item.sourceDirectory, 'model.gltf');
  await fs.writeFile(model, JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'textures/frame-0001.png' }] }));
  const records = [{ itemId: 1, source: first, role: 'main', isStill: false, missing: false }, { itemId: 2, source: model, role: 'main', isStill: true, missing: false }];
  const instance = collector(t, item, async (_executable, _args, settings) => {
    const job = JSON.parse(await fs.readFile(settings.env.SHITU_AE_JOB, 'utf8'));
    let sources = records;
    if (job.mode === 'collect') {
      const text = await fs.readFile(job.source, 'utf8');
      const paths = [...text.matchAll(/fullpath="([^"]+)"/g)].map(match => match[1]);
      assert.equal((await fs.readdir(paths[0])).filter(name => name.endsWith('.png')).length, 3, 'the referenced sequence directory must contain every frame');
      const document = JSON.parse(await fs.readFile(paths[1], 'utf8'));
      await fs.access(path.resolve(path.dirname(paths[1]), document.images[0].uri));
      sources = [{ ...records[0], source: path.join(paths[0], path.basename(first)) }, { ...records[1], source: paths[1] }];
      await fs.writeFile(job.output, 'RIFX synthetic model/sequence package');
    }
    const xml = bridge({ ok: true, version: '25.6', sources }, job.token).replace('</AfterEffectsProject>',
      `<fileReference target_is_folder="1" fullpath="${textures}"/><fileReference target_is_folder="0" fullpath="${model}"/></AfterEffectsProject>`);
    await fs.writeFile(job.reportProject, xml); return { code: 0, output: '' };
  });
  const prepared = await instance.prepareProjectBundle(item.source); t.after(() => prepared.cleanup());
  assert.equal(prepared.manifest.files.filter(file => file.path.endsWith('.png')).length, 4);
  assert.equal(prepared.manifest.missing.length, 0);
});

test('an explicitly configured After Effects executable takes priority over older detected installations', async t => {
  const item = await fixture(t), adobe = path.join(item.base, 'Adobe');
  const oldDirectory = path.join(adobe, 'Adobe After Effects 2020', 'Support Files'), newDirectory = path.join(adobe, 'Adobe After Effects 2025', 'Support Files');
  await fs.mkdir(oldDirectory, { recursive: true }); await fs.mkdir(newDirectory, { recursive: true });
  await fs.writeFile(path.join(oldDirectory, 'AfterFX.com'), 'Mock AE 2020');
  const explicit = path.join(newDirectory, 'AfterFX.com'); await fs.writeFile(explicit, 'Mock AE 2025');
  const previousProgramFiles = process.env.ProgramFiles, previousOverride = process.env.SHITU_AFTERFX;
  process.env.ProgramFiles = item.base; process.env.SHITU_AFTERFX = explicit;
  try { assert.equal((await listAfterEffectsTools())[0].executable, explicit); }
  finally {
    if (previousProgramFiles === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = previousProgramFiles;
    if (previousOverride === undefined) delete process.env.SHITU_AFTERFX; else process.env.SHITU_AFTERFX = previousOverride;
  }
});

test('an AE result that still references original media is rejected and temporary packages are removed', async t => {
  const item = await fixture(t), records = [{ source: item.image, role: 'main', isStill: true, missing: false }];
  const normal = launcher(records);
  const instance = collector(t, item, async (...args) => {
    await normal(...args);
    const settings = args[2], job = JSON.parse(await fs.readFile(settings.env.SHITU_AE_JOB, 'utf8'));
    if (job.mode === 'collect') await fs.writeFile(job.reportProject, bridge({ ok: true, version: '17.0', sources: records }, job.token));
    return { code: 0, output: '' };
  });
  await assert.rejects(instance.prepareProjectBundle(item.source), /未正确重定位/);
  assert.deepEqual(await fs.readdir(path.join(item.base, 'cache')), []);
});

test('unavailable AE and source changes fail without overwriting the original', async t => {
  const item = await fixture(t);
  const unavailable = createAEProjectCollector({ cacheDir: path.join(item.base, 'unavailable'), toolLocator: async () => null });
  t.after(() => unavailable.shutdown());
  await assert.rejects(unavailable.prepareProjectBundle(item.source), /After Effects/);
  const instance = collector(t, item, launcher([{ source: item.image, role: 'main', isStill: true }], async job => { if (job.mode === 'collect') await fs.writeFile(item.source, 'Externally changed project'); }));
  await assert.rejects(instance.prepareProjectBundle(item.source), /源 AE 工程/);
});

test('bridge metadata is data-only, authenticated by its token and complete chunk indexes', async t => {
  const item = await fixture(t), filename = path.join(item.base, 'report.aepx');
  await fs.writeFile(filename, bridge({ ok: true, sources: [] }, 'correct-token'));
  assert.equal((await readBridgeReport(filename, 'correct-token')).report.ok, true);
  await assert.rejects(readBridgeReport(filename, 'wrong-token'), /完整收集报告/);
  await fs.writeFile(filename, '<?xml version="1.0"?><AfterEffectsProject><Comment>SHITU_AE_REPORT_V1:correct-token:0:2:abc</Comment></AfterEffectsProject>');
  await assert.rejects(readBridgeReport(filename, 'correct-token'), /完整收集报告/);
});

test('existing-project guard never changes, closes or quits an existing After Effects session', async () => {
  const script = await fs.readFile(path.resolve(__dirname, '..', 'src', 'ae-scripts', 'collect.jsx'), 'utf8');
  let calls = 0;
  const app = { project: { file: 'Artist.aep', numItems: 2, close() { calls++; } }, quit() { calls++; }, setSavePreferencesOnQuit() { calls++; } };
  assert.throws(() => vm.runInNewContext(script, { app }), /existing project/);
  assert.equal(calls, 0); assert.equal(app.exitAfterLaunchAndEval, undefined);
});

test('project year detection handles available XMP without assuming every AEP exposes its author version', async t => {
  const item = await fixture(t);
  assert.equal(await projectYear(item.source), null);
  await fs.writeFile(item.source, '<xmp:CreatorTool>Adobe After Effects 2025 (Windows)</xmp:CreatorTool>');
  assert.equal(await projectYear(item.source), 2025);
  assert.throws(() => launchAfterEffects(process.execPath, ['-r', 'untrusted.jsx']), /独立后台实例/);
});
