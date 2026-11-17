'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTranscodeSettings, defaults, validateSettings, executionPlan } = require('../src/transcode-settings.cjs');
const caps = { cpu: { name: 'CPU fixture', logicalProcessors: 8 }, gpus: [
  { id: 'nvenc:0', name: 'GPU fixture', encoder: 'h264_nvenc', index: 0, available: true },
  { id: 'qsv:1', name: 'Unavailable GPU', encoder: 'h264_qsv', index: 1, available: false }
] };
test('transcode settings persist atomically and reject invalid preferences without replacing the file', async () => {
  const base = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'transcode-settings-'));
  try {
    const filename = path.join(dir, 'settings.json'), store = createTranscodeSettings({ filePath: filename, logicalProcessors: 8 });
    assert.deepEqual(await store.get(), defaults(8));
    const value = { mode: 'hybrid', cpuThreads: 3, gpuId: 'nvenc:0' };
    await store.save(value); assert.deepEqual(await store.get(), value);
    const before = await fs.readFile(filename);
    for (const invalid of [{ ...value, mode: 'bad' }, { ...value, cpuThreads: 9 }, { ...value, gpuId: '../gpu' }]) assert.throws(() => store.save(invalid));
    assert.deepEqual(await fs.readFile(filename), before);
    await fs.writeFile(filename, '{broken'); assert.deepEqual(await store.get(), defaults(8));
  } finally {
    assert.ok(path.relative(base, dir) && !path.relative(base, dir).startsWith('..'));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('execution plans use the selected tested GPU and create independent CPU/GPU batch lanes', () => {
  const selected = { mode: 'hybrid', cpuThreads: 4, gpuId: 'nvenc:0' };
  const plan = executionPlan(selected, caps, { format: 'mp4', total: 3 });
  assert.deepEqual(plan.lanes.map(l => l.device.type), ['gpu', 'cpu']);
  assert.equal(plan.lanes[0].device.id, 'nvenc:0'); assert.equal(plan.lanes[1].device.threads, 4);
  assert.equal(executionPlan(selected, caps, { format: 'mp4', total: 1 }).lanes.length, 1);
  assert.equal(executionPlan(selected, caps, { format: 'dxv', total: 4 }).lanes[0].device.type, 'cpu');
});
test('explicit unavailable GPUs fail while automatic mode reports CPU fallback', () => {
  const selected = { mode: 'gpu', cpuThreads: 4, gpuId: 'qsv:1' };
  assert.throws(() => executionPlan(selected, caps, { format: 'mp4', total: 2 }), /GPU/);
  const fallback = executionPlan({ ...selected, mode: 'auto' }, caps, { format: 'mp4' });
  assert.equal(fallback.mode, 'cpu'); assert.ok(fallback.notice);
  assert.throws(() => validateSettings({ ...selected, cpuThreads: 0 }, 8));
});
