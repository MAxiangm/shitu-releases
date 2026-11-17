'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createVideoTranscoder, normalizeOptions } = require('../src/video-transcode.cjs');
const { createVideoEngine } = require('../src/video-engine.cjs');
const root = path.resolve(__dirname, '..'), testRoot = path.join(root, '.recovery', 'tests');
const runtimeDir = path.join(root, 'video-runtime'), ffmpeg = path.join(runtimeDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const runtime = syncFs.existsSync(ffmpeg) ? {} : { skip: 'Bundled FFmpeg is unavailable' };
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true }); const dir = await fs.mkdtemp(path.join(testRoot, 'video-transcode-'));
  const transcoder = createVideoTranscoder({ runtimeDir });
  const decoder = createVideoEngine({ runtimeDir, cacheDir: path.join(dir, 'cache') });
  t.after(async () => { await Promise.all([transcoder.shutdown(), decoder.shutdown()]); const rel = path.relative(testRoot, dir); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, transcoder, decoder };
}
function command(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
}
function source(dir) {
  const filename = path.join(dir, '原视频.avi');
  command(['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000', '-t', '0.6', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-threads', '2', '-y', filename]);
  return filename;
}
function transparentSource(dir) {
  const filename = path.join(dir, '透明视频.mov');
  command(['-f', 'lavfi', '-i', 'color=c=red@0.5:size=99x67:rate=12,format=rgba', '-t', '0.5', '-c:v', 'qtrle', '-threads', '2', '-y', filename]);
  return filename;
}
function frame(filename) { return command(['-i', filename, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']); }

test('transcode options permit only supported targets, bitrates and explicit alpha mode', () => {
  assert.equal(normalizeOptions({ format: 'mp4' }).bitrateMbps, 20);
  assert.equal(normalizeOptions({ format: 'mp4', bitrateMbps: 0.5 }).bitrateMbps, 0.5);
  assert.equal(normalizeOptions({ format: 'dxv', alpha: true }).alpha, true);
  for (const value of [null, {}, { format: 'avi' }, { format: 'mp4', bitrateMbps: 0.1 }, { format: 'mp4', bitrateMbps: 201 }, { format: 'mp4', bitrateMbps: NaN }, { format: 'mp4', bitrateMbps: '20' }, { format: 'dxv', alpha: 'yes' }]) assert.throws(() => normalizeOptions(value));
});

test('MP4 and DXV Normal encode actual source frames, preserve timing/audio and leave source bytes unchanged', runtime, async t => {
  const { dir, transcoder, decoder } = await fixture(t), input = source(dir), before = digest(await fs.readFile(input));
  for (const [format, ext, codec, audio] of [['mp4', '.mp4', 'h264', 'aac'], ['dxv', '.mov', 'dxv', 'pcm_s16le']]) {
    const events = [], destination = path.join(dir, format + ext);
    const result = await transcoder.transcode(input, destination, { format, bitrateMbps: 2, onProgress: event => events.push(event) });
    assert.equal(result.path, destination); assert.equal(result.codec, codec); assert.equal(result.audioCodec, audio);
    assert.equal(result.width, 96); assert.equal(result.height, 64); assert.equal(result.frameRate, 20);
    assert.ok(Math.abs(result.duration - 0.6) < 0.08); assert.equal(result.hasAlpha, false);
    assert.equal((await decoder.probe(destination)).hasAlpha, false, 'Library decoder must not mistake opaque DXV RGBA for transparency');
    assert.equal(events.at(-1).progress, 100); assert.ok(frame(destination).length > 0);
    assert.equal(digest(await fs.readFile(input)), before);
  }
  const withAlpha = await transcoder.transcode(input, path.join(dir, 'audio-alpha.mov'), { format: 'dxv', alpha: true });
  assert.equal(withAlpha.audioCodec, 'pcm_s16le'); assert.equal(withAlpha.hasAudio, true); assert.equal(withAlpha.hasAlpha, true);
  assert.equal((await decoder.probe(withAlpha.path)).hasAlpha, true); assert.equal(frame(withAlpha.path)[3], 255);
});

test('rotation is baked into MP4 and DXV pictures without retaining a second rotation transform', runtime, async t => {
  const { dir, transcoder } = await fixture(t), input = source(dir);
  const base = await transcoder.transcode(input, path.join(dir, 'base.mp4'), { format: 'mp4', bitrateMbps: 2 });
  const rotated = path.join(dir, 'rotated.mp4'); command(['-display_rotation', '90', '-i', base.path, '-c', 'copy', '-y', rotated]);
  assert.equal((await transcoder.probe(rotated)).rotation, 90);
  for (const [format, alpha, ext] of [['mp4', false, '.mp4'], ['dxv', true, '.mov']]) {
    const result = await transcoder.transcode(rotated, path.join(dir, 'upright-' + format + ext), { format, alpha, bitrateMbps: 2 });
    assert.equal(result.width, 64); assert.equal(result.height, 96); assert.equal(result.rotation, 0);
    assert.equal(frame(result.path).length, 64 * 96 * 4);
  }
});

test('DXV Normal alpha produces genuine DXD3 DXT5 packets and decoded transparency; opaque targets composite onto black', runtime, async t => {
  const { dir, transcoder, decoder } = await fixture(t), input = transparentSource(dir), before = digest(await fs.readFile(input));
  const alpha = await transcoder.transcode(input, path.join(dir, 'alpha.mov'), { format: 'dxv', alpha: true });
  assert.equal(alpha.codec, 'dxv'); assert.equal(alpha.quality, 'normal'); assert.equal(alpha.hasAlpha, true); assert.equal(alpha.alphaDropped, false);
  assert.equal((await decoder.probe(alpha.path)).hasAlpha, true);
  assert.equal(alpha.width, 99); assert.equal(alpha.height, 67); assert.equal(alpha.frameRate, 12);
  const pixels = frame(alpha.path); assert.equal(pixels.length, 99 * 67 * 4);
  assert.ok(pixels[0] > 235 && pixels[1] < 12 && pixels[2] < 12, `Straight RGB must be recovered: ${[...pixels.subarray(0, 4)]}`);
  assert.ok(pixels[3] >= 120 && pixels[3] <= 135, 'Half transparency was not retained');
  const encoded = await fs.readFile(alpha.path); assert.ok(encoded.includes(Buffer.from('DXD3'))); assert.ok(encoded.includes(Buffer.from([0x35, 0x54, 0x58, 0x44, 4, 0, 1, 0])));
  for (const [format, ext] of [['mp4', '.mp4'], ['dxv', '.mov']]) {
    const result = await transcoder.transcode(input, path.join(dir, 'opaque-' + format + ext), { format, bitrateMbps: 2, alpha: false });
    assert.equal(result.width, format === 'mp4' ? 100 : 99); assert.equal(result.height, format === 'mp4' ? 68 : 67);
    const rgba = frame(result.path); assert.equal(result.alphaDropped, true); assert.equal(rgba[3], 255);
    assert.ok(rgba[0] > 105 && rgba[0] < 150 && rgba[1] < 15 && rgba[2] < 15, 'Opaque outputs must composite half-red on black');
  }
  assert.equal(digest(await fs.readFile(input)), before);
});

test('official DXV HQ alpha source converts directly to MP4 and normal-alpha DXV', runtime, async t => {
  const input = path.join(root, '.recovery', 'samples', 'dxv', 'dxv3-hqwa.mov');
  if (!syncFs.existsSync(input)) return t.skip('Official DXV fixture unavailable');
  const { dir, transcoder } = await fixture(t), before = digest(await fs.readFile(input));
  for (const [format, ext, alpha] of [['mp4', '.mp4', false], ['dxv', '.mov', true]]) {
    const result = await transcoder.transcode(input, path.join(dir, format + ext), { format, alpha, bitrateMbps: 4 });
    assert.equal(result.width, 256); assert.equal(result.height, 256); assert.ok(frame(result.path).length > 0);
  }
  assert.equal(digest(await fs.readFile(input)), before);
});

test('transcoding never overwrites an existing or concurrently-created output', runtime, async t => {
  const { dir, transcoder } = await fixture(t), input = source(dir), output = path.join(dir, 'existing.mp4');
  await fs.writeFile(output, 'do not replace');
  await assert.rejects(transcoder.transcode(input, output, { format: 'mp4' }), /已存在/);
  assert.equal(await fs.readFile(output, 'utf8'), 'do not replace');
  const racing = path.join(dir, 'racing.mp4');
  await assert.rejects(transcoder.transcode(input, racing, { format: 'mp4', onProgress: event => { if (event.progress === 0) syncFs.writeFileSync(racing, 'concurrent writer'); } }), /EEXIST/);
  assert.equal(await fs.readFile(racing, 'utf8'), 'concurrent writer');
  await assert.rejects(transcoder.transcode(input, input, { format: 'mp4' }), /覆盖/);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.startsWith('.shitu-')), []);
});

test('cancellation and shutdown remove partial opaque and alpha files without publishing output', runtime, async t => {
  const { dir, transcoder } = await fixture(t), input = source(dir);
  for (const [format, alpha, ext] of [['mp4', false, '.mp4'], ['dxv', true, '.mov']]) {
    const controller = new AbortController(), output = path.join(dir, 'cancel-' + format + ext);
    await assert.rejects(transcoder.transcode(input, output, { format, alpha, signal: controller.signal,
      onProgress: event => { if (event.progress > 0) controller.abort(); } }), { name: 'AbortError' });
    assert.equal(syncFs.existsSync(output), false);
  }
  assert.equal(transcoder.busy(), false); await transcoder.shutdown();
  await assert.rejects(transcoder.transcode(input, path.join(dir, 'closed.mp4'), { format: 'mp4' }), /已关闭/);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.startsWith('.shitu-')), []);
});
