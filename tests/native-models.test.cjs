'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { collectModelBundle, copyModelBundle } = require('../src/model-bundle.cjs');
const { createNativeModelConverter, runNativeProcess } = require('../src/native-models.cjs');
const testsRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
async function fixture(t) {
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'native-model-'));
  t.after(async () => {
    const relative = path.relative(testsRoot, directory);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const original = path.join(directory, 'original'); await fs.mkdir(original);
  const native = path.join(original, 'asset.blend'); await fs.writeFile(native, 'BLENDER-v300 fixture');
  const bundleDirectory = path.join(directory, 'managed');
  const manifest = await copyModelBundle(await collectModelBundle(native), bundleDirectory);
  return { directory, bundleDirectory, manifest, source: path.join(bundleDirectory, manifest.entry), format: 'blend' };
}
function fakeLauncher(observe = () => {}) {
  return async (executable, args, options) => {
    await observe(executable, args, options);
    const job = JSON.parse(await fs.readFile(options.env.SHITU_MODEL_JOB, 'utf8'));
    await fs.writeFile(job.output, Buffer.from('glTF\x02\x00\x00\x00MOCK CONVERSION BYTES'));
    await fs.writeFile(job.resultPath, JSON.stringify({ ok: true, warnings: ['Preview material approximation'] }));
  };
}
test('native conversion is independent, shared, checks cached bytes and regenerates corruption', async t => {
  const request = await fixture(t), original = await fs.readFile(request.source);
  let launches = 0;
  const converter = createNativeModelConverter({ cacheDir: path.join(request.directory, 'cache'), toolLocator: async () => process.execPath,
    launch: fakeLauncher((_executable, args, options) => {
      launches++; assert.ok(args.includes('--disable-autoexec')); assert.ok(args.includes('--background'));
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
    }) });
  t.after(() => converter.shutdown());
  const [first, shared] = await Promise.all([converter.preview(request), converter.preview(request)]);
  assert.equal(launches, 1); assert.equal(first.entry, 'preview.glb'); assert.equal(first.files[0].source, shared.files[0].source);
  assert.ok(!first.files[0].source.startsWith(request.bundleDirectory));
  assert.equal((await converter.preview(request)).cached, true); assert.equal(launches, 1);
  await fs.writeFile(first.files[0].source, 'changed');
  assert.equal((await converter.preview(request)).cached, false); assert.equal(launches, 2);
  assert.deepEqual(await fs.readFile(request.source), original);
});
test('native conversion rejects changed originals and invalid package entry before launching software', async t => {
  const request = await fixture(t);
  let launches = 0;
  const converter = createNativeModelConverter({ cacheDir: path.join(request.directory, 'cache'), toolLocator: async () => process.execPath, launch: fakeLauncher(() => launches++) });
  t.after(() => converter.shutdown());
  await assert.rejects(converter.preview({ ...request, source: path.join(request.directory, 'outside.blend') }), /入口/);
  await fs.writeFile(request.source, 'changed');
  await assert.rejects(converter.preview(request), /已变化或缺失/); assert.equal(launches, 0);
});
test('unavailable native software explains how to preserve and preview the original project', async t => {
  const request = await fixture(t), converter = createNativeModelConverter({ cacheDir: path.join(request.directory, 'cache'), toolLocator: async () => null });
  t.after(() => converter.shutdown());
  await assert.rejects(converter.preview(request), /Blender.*GLB\/FBX.*已保留/);
});
test('native diagnostics remain in a local log instead of the user-facing error message', async t => {
  const request = await fixture(t);
  const converter = createNativeModelConverter({ cacheDir: path.join(request.directory, 'cache'), toolLocator: async () => process.execPath,
    launch: async () => { throw Object.assign(new Error('原软件许可证不可用'), { diagnostics: 'Detailed native bridge stderr for local troubleshooting' }); } });
  t.after(() => converter.shutdown());
  let observed;
  await assert.rejects(converter.preview(request), error => {
    observed = error;
    return true;
  });
  assert.equal(observed.message, '原软件许可证不可用');
  assert.ok(observed.logPath.startsWith(path.join(request.directory, 'cache', 'diagnostics')));
  assert.match(await fs.readFile(observed.logPath, 'utf8'), /Detailed native bridge stderr/);
});
test('one cancelled native subscriber does not cancel another and shutdown prevents new conversions', async t => {
  const request = await fixture(t), controller = new AbortController();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const converter = createNativeModelConverter({ cacheDir: path.join(request.directory, 'cache'), toolLocator: async () => process.execPath,
    launch: fakeLauncher(async () => { entered(); await gate; }) });
  t.after(() => converter.shutdown());
  const first = converter.preview({ ...request, signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const remaining = converter.preview(request);
  await started; controller.abort(); release();
  await rejected; assert.equal((await remaining).format, 'glb');
  await converter.shutdown(); await assert.rejects(converter.preview(request), /已关闭/);
});
test('cancelled native jobs can immediately be retried without subscribing to their aborted work', async t => {
  const request = await fixture(t), controller = new AbortController();
  const converter = createNativeModelConverter({ cacheDir: path.join(request.directory, 'cache'), toolLocator: async () => process.execPath, launch: fakeLauncher() });
  t.after(() => converter.shutdown());
  const first = converter.preview({ ...request, signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' }); controller.abort();
  const retry = converter.preview(request); await rejected; assert.equal((await retry).format, 'glb');
});
test('cancelling a real bridge process stops only the spawned process tree', async t => {
  const request = await fixture(t), controller = new AbortController();
  const running = runNativeProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: request.directory, env: process.env, signal: controller.signal, timeoutMs: 5000 });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  setTimeout(() => controller.abort(), 100); await rejected;
  assert.ok(process.pid > 0, 'test runner remains alive');
});
test('a native license prompt in UTF-16 output fails promptly without answering authentication', async t => {
  const request = await fixture(t);
  await assert.rejects(runNativeProcess(process.execPath, ['-e', "process.stdout.write(Buffer.from('Error running authentication: No License Model defined', 'utf16le')); setInterval(() => {}, 1000)"],
    { cwd: request.directory, env: process.env, timeoutMs: 5000 }), /许可证不可用/);
});
