'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createVideoEngine, HOVER_SECONDS } = require('../src/video-engine.cjs');

const root = path.resolve(__dirname, '..');
const fixtures = path.join(root, '.recovery', 'tests');
const runtimeDir = path.join(root, 'video-runtime');
const ffmpeg = path.join(runtimeDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const enabled = require('node:fs').existsSync(ffmpeg) ? {} : { skip: 'Bundled FFmpeg is not available' };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  await fs.mkdir(fixtures, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtures, 'hover-engine-'));
  t.after(async () => {
    const relative = path.relative(fixtures, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
function generate(file, { duration = 15, dimensions = '160x96', codec = 'mpeg4' } = {}) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${dimensions}:rate=24`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(duration), '-c:v', codec,
    '-c:a', codec === 'libvpx-vp9' ? 'libopus' : 'pcm_s16le', '-threads', '2', '-y', file],
  { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}
function engine(t, directory, options = {}) {
  const value = createVideoEngine({ runtimeDir, cacheDir: path.join(directory, 'cache'), ...options });
  t.after(() => value.shutdown());
  return value;
}

test('hover converts only a short silent clip, with persistent and fast in-memory reuse', enabled, async t => {
  const directory = await fixture(t), source = path.join(directory, 'long.avi');
  generate(source, { duration: 20, dimensions: '640x360' });
  const original = await fs.readFile(source), key = hash(original), events = [];
  const value = engine(t, directory, { onProgress: event => events.push(event) });
  const started = performance.now(), first = await value.hoverPreview(source, { key });
  const coldMs = performance.now() - started;
  assert.equal(first.profile, 'hover');
  assert.equal(first.codec, 'vp9'); assert.equal(first.hasAudio, false);
  assert.ok(first.duration > 0 && first.duration <= HOVER_SECONDS + .2);
  assert.ok(first.sourceDuration >= 19.9);
  assert.ok(first.width <= 640 && first.height <= 360);
  const repeatAt = performance.now(), repeated = await value.hoverPreview(source, { key });
  const warmMs = performance.now() - repeatAt;
  assert.equal(repeated.cached, true); assert.equal(repeated.path, first.path);
  assert.equal(events.filter(event => event.profile === 'hover' && event.state === 'converting').length, 1);
  // A fresh process-equivalent engine can reuse the checked short cache even
  // when no decoder binaries exist. It neither probes nor starts FFmpeg.
  const emptyRuntime = path.join(directory, 'empty-runtime'); await fs.mkdir(emptyRuntime);
  const fresh = engine(t, directory, { runtimeDir: emptyRuntime });
  const persisted = await fresh.hoverPreview(source, { key });
  assert.equal(persisted.cached, true); assert.equal(persisted.path, first.path);
  assert.deepEqual(await fs.readFile(source), original);
  t.diagnostic(`20-second clip: first hover ${coldMs.toFixed(1)} ms, repeated hover ${warmMs.toFixed(1)} ms`);
});

test('native WebM uses original immediately and complete catalog metadata needs no decoder', enabled, async t => {
  const directory = await fixture(t), source = path.join(directory, 'native.webm');
  generate(source, { duration: 1, codec: 'libvpx-vp9' });
  const value = engine(t, directory), key = hash(await fs.readFile(source));
  const metadata = await value.probe(source);
  const emptyRuntime = path.join(directory, 'empty-runtime'); await fs.mkdir(emptyRuntime);
  const noDecoder = engine(t, directory, { runtimeDir: emptyRuntime });
  const result = await noDecoder.hoverPreview(source, { key, metadata });
  assert.equal(result.path, source); assert.equal(result.direct, true);
  assert.equal((await noDecoder.hoverPreview(source, { key })).cached, true);
  await assert.rejects(fs.access(path.join(directory, 'cache')), { code: 'ENOENT' });
});

test('hover invalidates changed cache bytes and changed original identity instead of showing stale frames', enabled, async t => {
  const directory = await fixture(t), source = path.join(directory, 'changing.avi');
  generate(source, { duration: 1 });
  const value = engine(t, directory), key = hash(await fs.readFile(source));
  const first = await value.hoverPreview(source, { key });
  await fs.writeFile(first.path, 'broken hover preview');
  const repaired = await value.hoverPreview(source, { key });
  assert.equal(repaired.cached, false); assert.equal(repaired.codec, 'vp9');
  generate(source, { duration: 2, dimensions: '192x112' });
  const changed = await value.hoverPreview(source, { key });
  assert.notEqual(changed.path, first.path);
  assert.equal(changed.width, 192); assert.equal(changed.height, 112);
  assert.ok(changed.sourceDuration >= 1.9);
});

test('hover shares one conversion, keeps independent subscribers, and removes cancelled work', enabled, async t => {
  const directory = await fixture(t), source = path.join(directory, 'shared.avi');
  generate(source, { duration: 10 });
  const key = hash(await fs.readFile(source)), events = [];
  const value = engine(t, directory, { onProgress: event => events.push(event) });
  const controller = new AbortController();
  const cancelled = value.hoverPreview(source, { key, signal: controller.signal });
  const cancelledCheck = assert.rejects(cancelled, { name: 'AbortError' });
  const left = value.hoverPreview(source, { key }), right = value.hoverPreview(source, { key });
  controller.abort();
  const [a, b] = await Promise.all([left, right]); await cancelledCheck;
  assert.equal(a.path, b.path);
  assert.equal(events.filter(event => event.profile === 'hover' && event.state === 'converting').length, 1);
  const cancellation = new AbortController();
  const fresh = engine(t, directory, { cacheDir: path.join(directory, 'cancel-cache'), onProgress: event => {
    if (event.profile === 'hover' && event.state === 'converting') cancellation.abort();
  } });
  await assert.rejects(fresh.hoverPreview(source, { key, signal: cancellation.signal }), { name: 'AbortError' });
  await fresh.shutdown();
  assert.deepEqual(await fs.readdir(path.join(directory, 'cancel-cache')), []);
});

const dxvDir = path.join(root, '.recovery', 'samples', 'dxv');
const dxvNames = ['dxv-na.mov', 'dxv-wa.mov', 'dxv3-hqna.mov', 'dxv3-hqwa.mov', 'dxv3-nqna.mov', 'dxv3-nqwa.mov'];
test('short hover previews decode every supported DXV family, including single-frame and alpha files',
  require('node:fs').existsSync(ffmpeg) && dxvNames.every(name => require('node:fs').existsSync(path.join(dxvDir, name))) ? {} : { skip: 'DXV fixtures missing' }, async t => {
    const directory = await fixture(t), value = engine(t, directory);
    for (const name of dxvNames) {
      const source = path.join(dxvDir, name), original = await fs.readFile(source);
      const result = await value.hoverPreview(source, { key: hash(original) });
      assert.equal(result.codec, 'vp9'); assert.equal(result.profile, 'hover');
      assert.ok(result.width > 0 && result.width <= 640 && result.height > 0 && result.height <= 360, name);
      assert.ok(result.duration > 0 && result.duration <= HOVER_SECONDS + .2, name);
      assert.equal(result.hasAudio, false);
      assert.deepEqual(await fs.readFile(source), original);
    }
  });
