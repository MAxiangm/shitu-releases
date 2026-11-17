'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createTranscodeDeviceManager, normalizeDevice, encodingProfile, parseNvencDevices, parseD3dDevice } = require('../src/transcode-devices.cjs');
const { createVideoTranscoder, normalizeOptions } = require('../src/video-transcode.cjs');

const root = path.resolve(__dirname, '..'), testRoot = path.join(root, '.recovery', 'tests');
const runtimeDir = path.join(root, 'video-runtime'), suffix = process.platform === 'win32' ? '.exe' : '';
const ffmpeg = path.join(runtimeDir, `ffmpeg${suffix}`), ffprobe = path.join(runtimeDir, `ffprobe${suffix}`);
const runtime = syncFs.existsSync(ffmpeg) ? {} : { skip: 'Bundled FFmpeg is unavailable' };

test('explicit CPU threads and GPU device identities cannot be replaced by arbitrary encoder options', () => {
  assert.deepEqual(normalizeDevice({ type: 'cpu', threads: 7 }), { type: 'cpu', id: 'cpu', threads: 7 });
  assert.deepEqual(normalizeDevice({ type: 'gpu', id: 'nvenc:1', threads: 3 }), { type: 'gpu', id: 'nvenc:1', index: 1, encoder: 'h264_nvenc', threads: 3 });
  assert.equal(normalizeOptions({ format: 'dxv', alpha: true, device: { type: 'cpu', threads: 4 } }).device.threads, 4);
  for (const device of [null, { type: 'auto' }, { type: 'cpu', threads: 0 }, { type: 'cpu', threads: 65 }, { type: 'cpu', threads: 1.5 },
    { type: 'gpu', id: 'nvenc:0', encoder: 'h264_qsv' }, { type: 'gpu', id: 'qsv:1', index: 0 }, { type: 'gpu', id: 'nvenc:-1' },
    { type: 'gpu', id: 'nvenc:99' }, { type: 'gpu', id: 'nvenc:0 -y' }]) assert.throws(() => normalizeDevice(device));
  assert.throws(() => normalizeOptions({ format: 'dxv', device: { type: 'gpu', id: 'nvenc:0' } }), /仅支持 CPU/);
});

test('encoder profiles pin the selected native GPU and use the requested MP4 bitrate', () => {
  const cpu = encodingProfile({ type: 'cpu', threads: 6 }, 12.5);
  assert.equal(cpu.device.threads, 6); assert.ok(cpu.codecArgs.includes('libopenh264'));
  const nvenc = encodingProfile({ type: 'gpu', id: 'nvenc:2' }, 12.5);
  assert.deepEqual(nvenc.codecArgs.slice(nvenc.codecArgs.indexOf('-gpu'), nvenc.codecArgs.indexOf('-gpu') + 2), ['-gpu', '2']);
  const qsv = encodingProfile({ type: 'gpu', id: 'qsv:3' }, 12.5);
  assert.ok(qsv.initArgs.includes('qsv=shitu:hw,child_device=3,child_device_type=d3d11va'));
  for (const profile of [cpu, nvenc, qsv]) {
    assert.equal(profile.codecArgs[profile.codecArgs.indexOf('-b:v') + 1], '12500000');
    assert.equal(profile.codecArgs[profile.codecArgs.indexOf('-maxrate') + 1], '12500000');
    assert.equal(profile.codecArgs[profile.codecArgs.indexOf('-bufsize') + 1], '25000000');
  }
  const amf = encodingProfile({ type: 'gpu', id: 'amf:1' }, 10);
  assert.ok(amf.initArgs.includes('d3d11va=shitu:1')); assert.deepEqual(amf.filterSuffix, ['hwupload']);
});

test('hardware enumeration uses native encoder/Direct3D indices and ignores compiler listings', () => {
  assert.deepEqual(parseNvencDevices(' V....D h264_nvenc NVIDIA NVENC H.264 encoder'), []);
  assert.deepEqual(parseNvencDevices('[h264_nvenc @ 123] [ GPU #2 - < NVIDIA Test > has Compute SM 8.6 ]'), [
    { id: 'nvenc:2', name: 'NVIDIA Test', encoder: 'h264_nvenc', index: 2 }]);
  assert.deepEqual(parseD3dDevice('[D3D11VA @ 123] Using device 8086:7d67 (Intel(R) Graphics).'), { vendor: '8086', product: '7d67', name: 'Intel(R) Graphics' });
  assert.equal(parseD3dDevice('Intel(R) Graphics'), null);
});

test('unavailable GPU selection fails before transcoding instead of silently using CPU', async t => {
  const engine = createVideoTranscoder({ runtimeDir, deviceManager: { discover: async () => ({ gpus: [
    { id: 'nvenc:0', encoder: 'h264_nvenc', index: 0, available: false, error: '驱动未通过验证' }] }) } });
  t.after(() => engine.shutdown());
  await assert.rejects(engine.transcode(path.join(root, 'missing.mov'), path.join(testRoot, 'never-written.mp4'),
    { format: 'mp4', device: { type: 'gpu', id: 'nvenc:0' } }), /驱动未通过验证/);
  await assert.rejects(engine.transcode(path.join(root, 'missing.mov'), path.join(testRoot, 'never-written.mp4'),
    { format: 'mp4', device: { type: 'gpu', id: 'qsv:0' } }), /重新检测设备/);
});

test('an absent FFmpeg cannot claim hardware availability and device-manager shutdown cancels probes', async t => {
  const missing = createTranscodeDeviceManager({ runtimeDir: path.join(testRoot, 'nonexistent-runtime') });
  t.after(() => missing.shutdown());
  assert.deepEqual((await missing.discover()).gpus, []);
  const manager = createTranscodeDeviceManager({ runtimeDir });
  const pending = manager.discover();
  await manager.shutdown();
  await assert.rejects(pending, /已取消/);
  await assert.rejects(manager.discover(), /已关闭/);
});

test('available hardware actually encodes H.264 with audio, dimensions, rotation and original bytes preserved', runtime, async t => {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'hardware-transcode-'));
  const manager = createTranscodeDeviceManager({ runtimeDir });
  const engine = createVideoTranscoder({ runtimeDir, deviceManager: manager });
  t.after(async () => { await engine.shutdown(); await manager.shutdown(); const rel = path.relative(testRoot, dir); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); await fs.rm(dir, { recursive: true, force: true }); });
  const capabilities = await manager.discover();
  assert.ok(capabilities.cpu.logicalProcessors > 0); assert.equal(capabilities.formats.dxv.gpu, false);
  const devices = structuredClone(capabilities.gpus.filter(device => device.available));
  if (!devices.length) return t.skip('No hardware encoder passed the actual encode probe');
  capabilities.gpus[0].available = false;
  assert.deepEqual((await manager.discover()).gpus.filter(device => device.available), devices, 'Callers cannot mutate cached capabilities');
  const input = path.join(dir, 'input.avi');
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=322x182:rate=20',
    '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000', '-t', '0.8', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-threads', '2', '-y', input],
  { windowsHide: true, timeout: 30000 });
  assert.ifError(generated.error); assert.equal(generated.status, 0, generated.stderr.toString());
  const hash = crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex');
  const dxv = await engine.transcode(input, path.join(dir, 'source-dxv.mov'), { format: 'dxv', device: { type: 'cpu', threads: 3 } });
  assert.equal(dxv.codec, 'dxv');
  const dxvHash = crypto.createHash('sha256').update(await fs.readFile(dxv.path)).digest('hex');
  for (const gpu of devices) {
    const output = path.join(dir, `${gpu.id.replace(':', '-')}.mp4`);
    const result = await engine.transcode(dxv.path, output, { format: 'mp4', bitrateMbps: 3, device: { type: 'gpu', id: gpu.id, threads: 3 } });
    assert.equal(result.codec, 'h264'); assert.equal(result.audioCodec, 'aac');
    assert.equal(result.width, 322); assert.equal(result.height, 182); assert.equal(result.frameRate, 20); assert.equal(result.rotation, 0);
    assert.equal(result.device.id, gpu.id); assert.equal(result.device.threads, 3); assert.equal(result.encoder, gpu.encoder);
    assert.ok(Math.abs(result.duration - 0.8) < 0.08);
    const inspected = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output], { windowsHide: true, timeout: 10000 });
    assert.ifError(inspected.error); assert.equal(inspected.status, 0, inspected.stderr.toString());
    assert.equal(JSON.parse(inspected.stdout).streams.find(stream => stream.codec_type === 'video').nb_frames, '16');
    const rotated = path.join(dir, `${gpu.id.replace(':', '-')}-rotated.mp4`);
    const rotate = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-display_rotation', '90', '-i', output, '-c', 'copy', '-y', rotated], { windowsHide: true, timeout: 30000 });
    assert.ifError(rotate.error); assert.equal(rotate.status, 0, rotate.stderr.toString());
    const upright = await engine.transcode(rotated, path.join(dir, `${gpu.id.replace(':', '-')}-upright.mp4`),
      { format: 'mp4', bitrateMbps: 3, device: { type: 'gpu', id: gpu.id, threads: 3 } });
    assert.equal(upright.width, 182); assert.equal(upright.height, 322); assert.equal(upright.rotation, 0);
    const alphaFixture = path.join(root, '.recovery', 'samples', 'dxv', 'dxv3-hqwa.mov');
    if (syncFs.existsSync(alphaFixture)) {
      const alpha = await engine.transcode(alphaFixture, path.join(dir, `${gpu.id.replace(':', '-')}-alpha.mp4`),
        { format: 'mp4', bitrateMbps: 3, device: { type: 'gpu', id: gpu.id, threads: 3 } });
      assert.equal(alpha.width, 256); assert.equal(alpha.height, 256); assert.equal(alpha.codec, 'h264');
      assert.equal(alpha.alphaDropped, true); assert.equal(alpha.hasAlpha, false);
    }
  }
  const cpu = await engine.transcode(input, path.join(dir, 'cpu.mp4'), { format: 'mp4', bitrateMbps: 3, device: { type: 'cpu', threads: 5 } });
  assert.equal(cpu.encoder, 'libopenh264'); assert.equal(cpu.device.threads, 5); assert.equal(cpu.codec, 'h264');
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'), hash);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(dxv.path)).digest('hex'), dxvHash);
});
