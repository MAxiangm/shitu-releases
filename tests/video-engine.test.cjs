'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { createVideoEngine, displayMetadata } = require('../src/video-engine.cjs');

const root = path.resolve(__dirname, '..');
const fixturesRoot = path.join(root, '.recovery', 'tests');
const binarySuffix = process.platform === 'win32' ? '.exe' : '';
function runtimeDirectory() {
  const candidates = [process.env.SHITU_VIDEO_RUNTIME, path.join(root, 'video-runtime'), path.join(root, 'video-runtime', 'bin')].filter(Boolean);
  const locate = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  if (locate.status === 0) candidates.push(path.dirname(locate.stdout.trim().split(/\r?\n/)[0]));
  return candidates.find(directory => require('node:fs').existsSync(path.join(directory, `ffmpeg${binarySuffix}`)) &&
    require('node:fs').existsSync(path.join(directory, `ffprobe${binarySuffix}`)));
}
const runtime = runtimeDirectory();
const requireRuntime = runtime ? {} : { skip: 'FFmpeg/ffprobe runtime is not available' };
async function fixture(t) {
  await fs.mkdir(fixturesRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixturesRoot, 'video-engine-'));
  t.after(async () => {
    const relative = path.relative(fixturesRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
function command(args) {
  const result = spawnSync(path.join(runtime, `ffmpeg${binarySuffix}`), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}
async function sample(directory, extension, codec, audioCodec = 'pcm_s16le') {
  const filename = path.join(directory, `实际样例.${extension}`);
  command(['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=12:duration=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5',
    '-c:v', codec, '-c:a', audioCodec, '-shortest', '-y', filename]);
  return filename;
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function engine(t, directory, onProgress) {
  const instance = createVideoEngine({ runtimeDir: runtime, cacheDir: path.join(directory, 'cache'), onProgress });
  t.after(() => instance.shutdown());
  return instance;
}

test('video metadata normalizes rotation, duration, codec and alpha flags', () => {
  const result = displayMetadata({ streams: [{ codec_type: 'video', codec_name: 'prores', width: 1920, height: 1080,
    pix_fmt: 'yuva444p10le', side_data_list: [{ rotation: -90 }] }, { codec_type: 'audio', codec_name: 'pcm_s16le' }],
    format: { duration: '3.5', format_name: 'mov,mp4' } });
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.duration, 3.5);
  assert.equal(result.codec, 'prores');
  assert.equal(result.hasAudio, true);
  assert.equal(result.hasAlpha, true);
});

test('AVI, MKV and MPEG decode to thumbnails and browser-compatible previews without changing originals', requireRuntime, async t => {
  const directory = await fixture(t);
  const instance = engine(t, directory);
  for (const [extension, codec, audio] of [['avi', 'mpeg4', 'pcm_s16le'], ['mkv', 'ffv1', 'pcm_s16le'], ['mpg', 'mpeg2video', 'mp2']]) {
    const source = await sample(directory, extension, codec, audio);
    const original = await fs.readFile(source);
    const key = digest(original);
    const metadata = await instance.probe(source);
    assert.equal(metadata.width, 96);
    assert.equal(metadata.height, 64);
    assert.equal(metadata.codec, codec);
    assert.equal(metadata.hasAudio, true);
    const destination = path.join(directory, `${extension}.jpg`);
    assert.equal((await instance.thumbnail(source, destination)).width, 96);
    assert.equal((await sharp(destination).metadata()).format, 'jpeg');
    const preview = await instance.preview(source, { key });
    assert.equal(preview.mimeType, 'video/webm');
    assert.equal(preview.codec, 'vp9');
    assert.equal(preview.hasAudio, true);
    assert.equal(preview.audioCodec, 'opus');
    assert.notEqual(preview.path, source);
    assert.ok((await fs.stat(preview.path)).size > 0);
    assert.deepEqual(await fs.readFile(source), original);
  }
});

test('native VP9/Opus WebM is used directly and the cache is not inflated', requireRuntime, async t => {
  const directory = await fixture(t);
  const source = await sample(directory, 'webm', 'libvpx-vp9', 'libopus');
  const instance = engine(t, directory);
  const result = await instance.preview(source, { key: digest(await fs.readFile(source)) });
  assert.equal(result.direct, true);
  assert.equal(result.path, source);
  assert.equal(result.mimeType, 'video/webm');
  await assert.rejects(fs.access(path.join(directory, 'cache')), { code: 'ENOENT' });
});

test('preview is cached, corrupt cache regenerates, and only one job serves concurrent requests', requireRuntime, async t => {
  const directory = await fixture(t);
  const source = await sample(directory, 'mkv', 'ffv1');
  const events = [];
  const instance = engine(t, directory, event => events.push(event));
  const key = digest(await fs.readFile(source));
  const [first, shared] = await Promise.all([instance.preview(source, { key }), instance.preview(source, { key })]);
  assert.equal(first.path, shared.path);
  assert.equal(events.filter(event => event.state === 'converting' && event.progress === 0).length, 1);
  assert.equal((await instance.preview(source, { key })).cached, true);
  await fs.writeFile(first.path, 'broken cache');
  const regenerated = await instance.preview(source, { key });
  assert.equal(regenerated.cached, false);
  assert.equal((await instance.probe(regenerated.path)).codec, 'vp9');
});

test('one cancelled subscriber does not cancel another preview subscriber', requireRuntime, async t => {
  const directory = await fixture(t);
  const source = await sample(directory, 'avi', 'mpeg4');
  const instance = engine(t, directory);
  const key = digest(await fs.readFile(source));
  const controller = new AbortController();
  const cancelled = instance.preview(source, { key, signal: controller.signal });
  const remaining = instance.preview(source, { key });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await remaining).codec, 'vp9');
});

test('shutdown cancels work, rejects new work, and unsafe identities never become output paths', requireRuntime, async t => {
  const directory = await fixture(t);
  const source = await sample(directory, 'mkv', 'ffv1');
  const instance = engine(t, directory);
  await assert.rejects(instance.preview(source, { key: '../../outside' }), /缓存标识/);
  await assert.rejects(instance.preview('https://example.com/movie.mp4'), /绝对路径/);
  await assert.rejects(instance.preview(source, { key: '0'.repeat(64) }), /内容已变化/);
  const pending = instance.preview(source);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await instance.shutdown();
  await rejected;
  await assert.rejects(instance.probe(source), /已关闭/);
  assert.equal(instance.busy(), false);
  const entries = await fs.readdir(path.join(directory, 'cache')).catch(() => []);
  assert.equal(entries.some(name => name.startsWith('.video-preview-')), false);
});

test('corrupt media fails cleanly without creating previews or modifying the source', requireRuntime, async t => {
  const directory = await fixture(t);
  const source = path.join(directory, 'broken.mov');
  const bytes = Buffer.from('not a movie');
  await fs.writeFile(source, bytes);
  const instance = engine(t, directory);
  await assert.rejects(instance.probe(source), /无法解码/);
  await assert.rejects(instance.thumbnail(source, path.join(directory, 'broken.jpg')), /无法解码/);
  await assert.rejects(instance.preview(source), /无法解码/);
  assert.deepEqual(await fs.readFile(source), bytes);
  await assert.rejects(fs.access(path.join(directory, 'broken.jpg')), { code: 'ENOENT' });
});

test('playlist files cannot make the decoder follow external media URLs', requireRuntime, async t => {
  const directory = await fixture(t);
  const source = path.join(directory, 'playlist.mov');
  await fs.writeFile(source, '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nhttps://example.test/private.ts\n#EXT-X-ENDLIST\n');
  const instance = engine(t, directory);
  await assert.rejects(instance.probe(source), /无法解码/);
});

const dxvDirectory = process.env.SHITU_DXV_SAMPLES || path.join(root, '.recovery', 'samples', 'dxv');
const dxvNames = ['dxv-na.mov', 'dxv-wa.mov', 'dxv3-hqna.mov', 'dxv3-hqwa.mov', 'dxv3-nqna.mov', 'dxv3-nqwa.mov'];
const dxvAvailable = runtime && dxvNames.every(name => require('node:fs').existsSync(path.join(dxvDirectory, name)));
test('all six official DXV/DXV3 samples create thumbnails and VP9 previews', dxvAvailable ? {} : { skip: 'Official DXV fixtures are not available' }, async t => {
  const directory = await fixture(t);
  const instance = engine(t, directory);
  for (const name of dxvNames) {
    const source = path.join(dxvDirectory, name);
    const bytes = await fs.readFile(source);
    const metadata = await instance.probe(source);
    assert.equal(metadata.codec, 'dxv', name);
    const thumbnailPath = path.join(directory, `${name}.jpg`);
    await instance.thumbnail(source, thumbnailPath);
    const thumb = await sharp(thumbnailPath).metadata();
    assert.ok(thumb.width > 0 && thumb.width <= 640, name);
    assert.ok(thumb.height > 0 && thumb.height <= 640, name);
    const preview = await instance.preview(source, { key: digest(bytes) });
    assert.equal(preview.codec, 'vp9', name);
    assert.equal(preview.mimeType, 'video/webm', name);
    if (name.includes('-wa.') || name.includes('hqwa.') || name.includes('nqwa.')) assert.equal(preview.hasAlpha, true, name);
    assert.ok(preview.width <= 1920 && preview.height <= 1080, name);
    assert.deepEqual(await fs.readFile(source), bytes, name);
  }
});
