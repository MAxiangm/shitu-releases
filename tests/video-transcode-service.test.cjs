'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { createVideoTranscodeService, checkedExecutionPlan } = require('../src/video-transcode-service.cjs');

const wait = async (condition, label = 'Condition timed out') => {
  const deadline = Date.now() + 10000;
  while (!await condition()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 5)); }
};
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const hybridPlan = () => ({ mode: 'hybrid', lanes: [
  { id: 'cpu', label: 'CPU (4 线程)', device: { type: 'cpu', threads: 4 } },
  { id: 'gpu', label: 'NVIDIA 测试 GPU', device: { type: 'gpu', id: 'nvenc:0', encoder: 'h264_nvenc', index: 0, threads: 4 } }
] });
function holdUntilReleased(release, signal) {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal.aborted) return cancelled();
    signal.addEventListener('abort', cancelled, { once: true });
    release.promise.then(() => { signal.removeEventListener('abort', cancelled); resolve(); });
  });
}
async function fixture(t, options = {}) {
  const root = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'transcode-service-'));
  const thumbnail = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#5872a9' } }).jpeg().toBuffer();
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (source, destination) => {
    await fs.writeFile(destination, thumbnail); return { width: 16, height: 16, duration: 1, codec: 'h264', hasAudio: false };
  } });
  await library.init();
  const folder = (await library.createFolder('源文件夹')).folders[0].id;
  const target = (await library.createFolder('目标文件夹')).folders.find(item => item.name === '目标文件夹').id;
  const sources = [];
  for (let index = 0; index < (options.count || 2); index++) {
    const filename = path.join(directory, `source-${index}.mp4`), bytes = Buffer.from(`source-${index}-${crypto.randomUUID()}`);
    await fs.writeFile(filename, bytes);
    const report = await library.importPaths([filename], { folderId: folder });
    sources.push({ ...library.snapshot().assets.find(item => item.id === report.assetIds[0]), bytes });
  }
  await library.updateAssets([sources[0].id], { tags: ['原标签'], rating: 4, notes: '原备注', colorLabel: '#225588' });
  const workDir = path.join(directory, 'work'); let owner = library;
  const events = [], changed = [], calls = [];
  const engine = { transcode: async (source, destination, settings) => {
    calls.push({ source, destination, ...settings });
    return options.transcode ? options.transcode(source, destination, settings, calls.length) : (await fs.writeFile(destination, `converted-${calls.length}`), { alphaDropped: false });
  } };
  const service = createVideoTranscodeService({ getLibrary: () => owner, engine, workDir, onEvent: event => events.push(event), onChanged: value => changed.push(value) });
  t.after(async () => {
    await service.shutdown(); await library.flush();
    const relative = path.relative(root, directory); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, library, folder, target, sources, workDir, events, changed, calls, service,
    setOwner: value => { owner = value; },
    request: extra => ({ ids: sources.map(item => item.id), expectedRoot: library.root, format: 'mp4', bitrateMbps: 12, ...extra }),
    finish: async () => { await wait(() => !service.busy(), 'Transcode service did not finish'); return service.state(); }
  };
}

test('batch transcode runs sequentially, imports derivatives and preserves originals and labels', async t => {
  let active = 0, maximum = 0;
  const f = await fixture(t, { transcode: async (_source, destination, settings, index) => {
    active++; maximum = Math.max(maximum, active); settings.onProgress({ progress: 40 });
    await new Promise(resolve => setTimeout(resolve, 10)); await fs.writeFile(destination, `converted-batch-${index}`); active--; return { alphaDropped: index === 1 };
  } });
  const started = f.service.start(f.request()); assert.equal(started.status, 'running'); assert.equal(started.total, 2);
  started.results.push('mutated');
  const state = await f.finish();
  assert.equal(state.status, 'completed'); assert.equal(state.completed, 2); assert.equal(state.imported, 2); assert.equal(state.failed, 0); assert.equal(state.progress, 100); assert.equal(maximum, 1);
  assert.equal(state.results[0].warning, '输出格式不保留透明通道'); assert.equal(f.changed.length, 2);
  for (let index = 0; index < f.sources.length; index++) {
    const source = f.library.snapshot().assets.find(item => item.id === f.sources[index].id);
    assert.deepEqual(await fs.readFile(f.library.getAssetPath(source.id, 'original')), f.sources[index].bytes);
    const derived = f.library.snapshot().assets.find(item => item.id === state.results[index].assetIds[0]);
    assert.equal(derived.folderId, f.folder); assert.equal(derived.name, `${source.name} · MP4`);
    for (const key of ['tags', 'rating', 'notes', 'colorLabel']) assert.deepEqual(derived[key] || null, source[key] || null);
    assert.equal(f.calls[index].format, 'mp4'); assert.equal(f.calls[index].bitrateMbps, 12);
  }
  assert.deepEqual(await fs.readdir(f.workDir), []);
  assert.ok(f.events.some(event => event.current?.progress === 40));
});

test('duplicates are reported without changing an existing asset and item failures continue the batch', async t => {
  const f = await fixture(t, { transcode: async (source, destination, _settings, index) => {
    if (index === 1) throw new Error('fixture decode failure');
    await fs.copyFile(source, destination); return {};
  } });
  const before = f.library.snapshot(); f.service.start(f.request()); const state = await f.finish();
  assert.equal(state.status, 'completed'); assert.equal(state.failed, 1); assert.equal(state.completed, 2); assert.equal(state.duplicates, 1); assert.equal(state.imported, 0);
  assert.equal(state.results[0].status, 'failed'); assert.match(state.results[0].error, /decode failure/); assert.equal(state.results[1].status, 'duplicate');
  assert.deepEqual(f.library.snapshot(), before); assert.deepEqual(await fs.readdir(f.workDir), []);
});

test('cancellation stops pending work while keeping already imported results', async t => {
  const entered = gate();
  const f = await fixture(t, { count: 3, transcode: async (_source, destination, settings, index) => {
    if (index === 1) { await fs.writeFile(destination, 'completed-first'); return {}; }
    entered.resolve();
    return new Promise((_resolve, reject) => settings.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
  } });
  const initial = f.service.start(f.request()); await entered.promise;
  assert.equal(f.service.cancel('stale-id').status, 'running');
  assert.equal(f.service.cancel(initial.id).status, 'cancelling');
  const state = await f.finish();
  assert.equal(state.status, 'cancelled'); assert.equal(state.imported, 1); assert.equal(f.calls.length, 2); assert.equal(state.results.at(-1).status, 'cancelled');
  assert.equal(f.library.snapshot().assets.length, 4); assert.deepEqual(await fs.readdir(f.workDir), []);
});

test('sources moved during encoding inherit current metadata, while trashed sources are skipped', async t => {
  const entered = gate(), resume = gate();
  const f = await fixture(t, { transcode: async (_source, destination, _settings, index) => {
    if (index === 1) { entered.resolve(); await resume.promise; }
    await fs.writeFile(destination, `moved-${index}`); return {};
  } });
  f.service.start(f.request()); await entered.promise;
  await f.library.updateAssets([f.sources[0].id], { folderId: f.target, tags: ['最新标签'], colorLabel: '#332211' });
  await f.library.setTrash([f.sources[1].id], true); resume.resolve(); const state = await f.finish();
  const derivative = f.library.snapshot().assets.find(item => item.id === state.results[0].assetIds[0]);
  assert.equal(derivative.folderId, f.target); assert.deepEqual(derivative.tags, ['最新标签']); assert.equal(derivative.colorLabel, '#332211');
  assert.equal(state.imported, 1); assert.equal(state.failed, 1); assert.match(state.errors[0].error, /源视频已变化/);
});

test('a library change rejects stale completion before import and validation rejects malformed jobs', async t => {
  const entered = gate(), resume = gate();
  const f = await fixture(t, { transcode: async (_source, destination) => { entered.resolve(); await resume.promise; await fs.writeFile(destination, 'stale'); return {}; } });
  for (const extra of [{ expectedRoot: 'other' }, { ids: [] }, { ids: ['../bad'] }, { format: 'webm' }, { bitrateMbps: 0 }, { bitrateMbps: '12' }, { ids: ['missing'] }])
    assert.throws(() => f.service.start(f.request(extra)));
  f.service.start(f.request()); assert.throws(() => f.service.start(f.request()), /已有视频/); await entered.promise;
  f.setOwner({ root: f.library.root }); resume.resolve(); const state = await f.finish();
  assert.equal(state.status, 'error'); assert.equal(state.imported, 0); assert.equal(f.library.snapshot().assets.length, 2);
  assert.deepEqual(await fs.readdir(f.workDir), []);
});

test('Ogg audio is rejected before encoding but a legacy Ogg asset without a media type remains supported', async t => {
  const f = await fixture(t, { count: 1 });
  const snapshot = f.library.snapshot.bind(f.library);
  let type = 'audio';
  f.library.snapshot = () => {
    const value = snapshot();
    value.assets = value.assets.map(asset => asset.id === f.sources[0].id ? { ...asset, ext: 'ogg', mediaType: type } : asset);
    return value;
  };
  assert.throws(() => f.service.start(f.request()), /请选择有效.*视频/);
  assert.equal(f.calls.length, 0);
  type = undefined;
  f.service.start(f.request());
  const state = await f.finish();
  assert.equal(state.status, 'completed');
  assert.equal(state.imported, 1);
  assert.equal(f.calls.length, 1);
});

test('a video reclassified as Ogg music during encoding is not imported as a video derivative', async t => {
  const entered = gate(), resume = gate();
  const f = await fixture(t, { count: 1, transcode: async (_source, destination) => {
    entered.resolve(); await resume.promise; await fs.writeFile(destination, 'completed-video'); return {};
  } });
  const snapshot = f.library.snapshot.bind(f.library);
  let type = 'video';
  f.library.snapshot = () => {
    const value = snapshot();
    value.assets = value.assets.map(asset => asset.id === f.sources[0].id ? { ...asset, ext: 'ogg', mediaType: type } : asset);
    return value;
  };
  f.service.start(f.request()); await entered.promise;
  type = 'audio'; resume.resolve();
  const state = await f.finish();
  assert.equal(state.imported, 0);
  assert.equal(state.failed, 1);
  assert.match(state.errors[0].error, /源视频已变化/);
  assert.deepEqual(await fs.readdir(f.workDir), []);
});

test('metadata save failures report an imported partial result instead of hiding the failure', async t => {
  const f = await fixture(t, { count: 1 });
  const original = f.library.updateAssets.bind(f.library);
  f.library.updateAssets = async (ids, patch) => {
    if (ids[0] !== f.sources[0].id) throw new Error('fixture metadata failure');
    return original(ids, patch);
  };
  f.service.start(f.request()); const state = await f.finish();
  assert.equal(state.imported, 1); assert.equal(state.failed, 1); assert.equal(state.results[0].status, 'failed');
  assert.match(state.errors[0].error, /视频已收录/); assert.equal(f.changed.length, 1);
});

test('DXV alpha selection is forwarded explicitly and MP4 cannot imply alpha preservation', async t => {
  const f = await fixture(t, { count: 1 });
  const state = f.service.start(f.request({ format: 'dxv', alpha: true, bitrateMbps: undefined }));
  assert.equal(state.alpha, true);
  const done = await f.finish();
  assert.equal(f.calls[0].alpha, true); assert.equal(f.calls[0].format, 'dxv');
  const asset = f.library.snapshot().assets.find(item => item.id === done.results[0].assetIds[0]);
  assert.match(asset.name, /DXV Normal Alpha$/);
  assert.throws(() => f.service.start(f.request({ alpha: 'yes' })), /透明通道/);
  const next = f.service.start(f.request({ alpha: true })); assert.equal(next.alpha, false);
  await f.finish(); assert.equal(f.calls[1].alpha, false);
});

test('late progress from an earlier job cannot overwrite the current batch state', async t => {
  const callbacks = [], entered = gate(), resume = gate();
  const f = await fixture(t, { count: 1, transcode: async (_source, destination, settings, index) => {
    callbacks.push(settings.onProgress);
    if (index === 2) { entered.resolve(); await resume.promise; }
    await fs.writeFile(destination, `progress-job-${index}`); return {};
  } });
  f.service.start(f.request()); await f.finish();
  f.service.start(f.request()); await entered.promise;
  callbacks[0]({ progress: 99 });
  assert.equal(f.service.state().current.progress, 0);
  callbacks[1]({ progress: 25 }); assert.equal(f.service.state().current.progress, 25);
  resume.resolve(); await f.finish();
});

test('hybrid batches run CPU and GPU simultaneously, claim each source once and keep ordered results', async t => {
  const releases = Array.from({ length: 4 }, gate);
  let active = 0, maximum = 0;
  const f = await fixture(t, { count: 4, transcode: async (_source, destination, settings, index) => {
    active++; maximum = Math.max(maximum, active);
    try {
      await holdUntilReleased(releases[index - 1], settings.signal);
      await fs.writeFile(destination, `hybrid-result-${index}`); return {};
    } finally { active--; }
  } });
  const request = f.request({ executionPlan: hybridPlan() });
  request.ids.push(request.ids[0]);
  f.service.start(request);
  await wait(() => f.calls.length === 2);
  assert.deepEqual(f.calls.map(call => call.device.type), ['cpu', 'gpu']);
  assert.equal(f.calls[0].device.threads, 4); assert.equal(f.calls[1].device.encoder, 'h264_nvenc');
  f.calls[0].onProgress({ progress: 40 }); f.calls[1].onProgress({ progress: 60 });
  let state = f.service.state();
  assert.equal(state.executionMode, 'hybrid'); assert.equal(state.progress, 25);
  assert.equal(state.current.id, f.sources[0].id); assert.equal(state.runningItems.length, 2);
  assert.deepEqual(state.lanes.map(lane => lane.status), ['running', 'running']);
  assert.ok(f.events.some(event => event.runningItems.length === 2 && event.progress === 25));
  releases[1].resolve(); await wait(() => f.calls.length === 3);
  f.calls[1].onProgress({ progress: 99 });
  state = f.service.state();
  assert.deepEqual(state.runningItems.map(item => item.index), [1, 3]);
  assert.equal(state.runningItems[1].progress, 0); assert.equal(state.progress, 35);
  releases[2].resolve(); await wait(() => f.calls.length === 4);
  releases[3].resolve(); await wait(() => f.service.state().completed === 3);
  assert.equal(f.service.state().runningItems[0].id, f.sources[0].id);
  releases[0].resolve(); state = await f.finish();
  assert.equal(maximum, 2); assert.equal(state.status, 'completed'); assert.equal(state.imported, 4);
  assert.equal(state.failed, 0); assert.equal(state.progress, 100); assert.deepEqual(state.runningItems, []);
  assert.deepEqual(state.results.map(result => result.id), f.sources.map(source => source.id));
  assert.deepEqual(state.results.map(result => result.deviceType), ['cpu', 'gpu', 'gpu', 'gpu']);
  assert.equal(new Set(f.calls.map(call => call.source)).size, 4);
  assert.ok(state.lanes.every(lane => lane.status === 'completed' && lane.current === null));
  const inherited = f.library.snapshot().assets.find(asset => asset.id === state.results[0].assetIds[0]);
  assert.deepEqual(inherited.tags, ['原标签']); assert.equal(inherited.colorLabel, '#225588');
  assert.deepEqual(await fs.readdir(f.workDir), []);
});

test('hybrid cancellation aborts both lanes, keeps completed imports and leaves queued videos untouched', async t => {
  const releaseGpu = gate(), aborted = [];
  const f = await fixture(t, { count: 5, transcode: async (_source, destination, settings, index) => {
    settings.signal.addEventListener('abort', () => aborted.push(index), { once: true });
    await holdUntilReleased(index === 2 ? releaseGpu : gate(), settings.signal);
    await fs.writeFile(destination, `cancel-result-${index}`); return {};
  } });
  const started = f.service.start(f.request({ executionPlan: hybridPlan() }));
  await wait(() => f.calls.length === 2);
  releaseGpu.resolve(); await wait(() => f.calls.length === 3);
  assert.equal(f.service.state().imported, 1);
  f.service.cancel(started.id);
  const state = await f.finish();
  assert.equal(state.status, 'cancelled'); assert.equal(f.calls.length, 3); assert.equal(state.imported, 1);
  assert.equal(f.library.snapshot().assets.length, 6);
  assert.deepEqual(state.results.map(result => result.id), f.sources.slice(0, 3).map(source => source.id));
  assert.deepEqual(state.results.map(result => result.status), ['cancelled', 'completed', 'cancelled']);
  assert.ok(aborted.includes(1) && aborted.includes(3));
  assert.ok(state.lanes.every(lane => lane.status === 'cancelled' && lane.current === null));
  assert.deepEqual(await fs.readdir(f.workDir), []);
});

test('a failed CPU item does not stop the GPU lane or remaining hybrid work', async t => {
  const enteredGpu = gate(), releaseGpu = gate();
  const f = await fixture(t, { count: 3, transcode: async (_source, destination, settings, index) => {
    if (index === 1) { await enteredGpu.promise; throw new Error('fixture CPU failure'); }
    if (index === 2) { enteredGpu.resolve(); await holdUntilReleased(releaseGpu, settings.signal); }
    await fs.writeFile(destination, `resilient-result-${index}`); return {};
  } });
  f.service.start(f.request({ executionPlan: hybridPlan() }));
  await wait(() => f.service.state().completed === 2);
  assert.equal(f.service.state().failed, 1); assert.equal(f.service.state().imported, 1);
  releaseGpu.resolve(); const state = await f.finish();
  assert.equal(state.status, 'completed'); assert.equal(state.failed, 1); assert.equal(state.imported, 2);
  assert.deepEqual(state.results.map(result => result.id), f.sources.map(source => source.id));
  assert.match(state.errors[0].error, /CPU failure/);
});

test('single-item hybrid uses GPU while DXV with or without alpha uses CPU only', async t => {
  const f = await fixture(t, { count: 1 });
  const initial = f.service.start(f.request({ executionPlan: hybridPlan() }));
  assert.equal(initial.executionMode, 'gpu'); assert.match(initial.executionNotice, /单个视频/);
  await f.finish(); assert.equal(f.calls[0].device.type, 'gpu');
  for (const alpha of [false, true]) {
    const start = f.service.start(f.request({ format: 'dxv', alpha, executionPlan: hybridPlan() }));
    assert.equal(start.executionMode, 'cpu'); assert.match(start.executionNotice, /DXV 使用 CPU/);
    await f.finish();
    assert.equal(f.calls.at(-1).device.type, 'cpu'); assert.equal(f.calls.at(-1).alpha, alpha);
    assert.equal(f.service.state().lanes.length, 1);
  }
});

test('execution plans reject malformed devices and ambiguous parallel lanes', () => {
  assert.deepEqual(checkedExecutionPlan(undefined, 'mp4', 2).lanes[0].device, { type: 'cpu' });
  for (const plan of [
    null, {}, { mode: 'fast', lanes: [] }, { ...hybridPlan(), lanes: [] },
    { ...hybridPlan(), mode: 'gpu' },
    { ...hybridPlan(), lanes: [hybridPlan().lanes[0], hybridPlan().lanes[0]] },
    { ...hybridPlan(), lanes: [...hybridPlan().lanes, hybridPlan().lanes[0]] },
    { mode: 'cpu', lanes: [{ id: 'cpu', label: 'CPU', device: { type: 'cpu', threads: 0 } }] },
    { mode: 'gpu', lanes: [{ id: 'gpu', label: 'GPU', device: { type: 'gpu', id: 'nvenc:0', encoder: 'arbitrary', index: 0 } }] }
  ]) assert.throws(() => checkedExecutionPlan(plan, 'mp4', 2));
  const gpuOnly = { mode: 'gpu', lanes: [hybridPlan().lanes[1]] };
  const dxv = checkedExecutionPlan(gpuOnly, 'dxv', 2);
  assert.equal(dxv.mode, 'cpu'); assert.equal(dxv.lanes[0].device.type, 'cpu');
  assert.equal(dxv.lanes[0].device.threads, 4); assert.match(dxv.notice, /DXV/);
  const amd = { mode: 'gpu', lanes: [{ id: 'gpu', label: 'AMD GPU', device: { type: 'gpu', id: 'amf:1', encoder: 'h264_amf', index: 1, threads: 4 } }] };
  assert.equal(checkedExecutionPlan(amd, 'mp4', 2).lanes[0].device.encoder, 'h264_amf');
});
