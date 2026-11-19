'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { youtubePageUrl, downloadYouTube } = require('../src/youtube-download.cjs');

const id = 'BaW_jenozKc';
const canonical = `https://www.youtube.com/watch?v=${id}`;
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);

test('YouTube URLs normalize a single selected video without playlist or tracking parameters', () => {
  for (const url of [canonical, `${canonical}&list=PLanything&index=2`, `https://m.youtube.com/watch?v=${id}&t=30`,
    `https://youtu.be/${id}?si=tracking`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`, `https://www.youtube.com/live/${id}`]) {
    assert.equal(youtubePageUrl(url), canonical);
  }
});

test('YouTube URL validation rejects arbitrary servers, credentials, playlists and ambiguous IDs', () => {
  for (const url of ['http://www.youtube.com/watch?v=BaW_jenozKc', 'https://www.youtube.com.evil.test/watch?v=BaW_jenozKc',
    'https://user@www.youtube.com/watch?v=BaW_jenozKc', 'https://www.youtube.com:444/watch?v=BaW_jenozKc',
    'https://127.0.0.1/watch?v=BaW_jenozKc', 'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=BaW_jenozKc&v=aaaaaaaaaaa', 'https://youtu.be/short',
    'https://www.youtube.com/redirect?q=https://example.com', 'https://www.youtube.com/watch?v=BaW_jenozKc\n']) {
    assert.throws(() => youtubePageUrl(url), error => error.code === 'INVALID_YOUTUBE_URL', url);
  }
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-youtube-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  const directory = path.join(root, 'capture');
  await fs.mkdir(runtimeDir); await fs.mkdir(directory);
  const ffmpegPath = path.join(runtimeDir, 'ffmpeg.exe');
  await Promise.all(['yt-dlp.exe', 'deno.exe', 'ffmpeg.exe'].map(name => fs.writeFile(path.join(runtimeDir, name), 'test')));
  const calls = [], events = [];
  function spawnProcess(executable, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = 0;
    child.kill = () => { child.kills++; process.nextTick(() => child.emit('close', 1)); return true; };
    calls.push({ executable, args, options, child });
    setImmediate(() => run(child).catch(error => child.emit('error', error)));
    return child;
  }
  const metadata = (child, extra = {}) => child.stdout.write(`MOSAIC_META:${JSON.stringify({ id, title: '测试视频', is_live: false, live_status: 'not_live', has_drm: false, vcodec: 'h264', ...extra })}\n`);
  const progress = (child, data) => child.stderr.write(`MOSAIC_PROGRESS:${JSON.stringify(data)}\n`);
  const complete = async (child, { contents = mp4, filePath = path.join(directory, 'capture.mp4') } = {}) => {
    await fs.writeFile(filePath, contents);
    child.stdout.end(`MOSAIC_FILE:${JSON.stringify(filePath)}\n`); child.stderr.end();
    setImmediate(() => child.emit('close', 0));
  };
  let run = async child => { metadata(child); await complete(child); };
  return { root, directory, runtimeDir, ffmpegPath, calls, events, metadata, progress, complete,
    behavior(value) { run = value; },
    download(options = {}) { return downloadYouTube({ url: canonical, directory, runtimeDir, ffmpegPath, spawnProcess,
      onProgress: event => events.push(event), ...options }); }
  };
}

test('download returns the selected video and isolates helpers, config and output arguments', async t => {
  const f = await fixture(t);
  f.behavior(async child => {
    f.metadata(child);
    f.progress(child, { filename: 'video', downloaded: 12, total: 22 });
    f.progress(child, { filename: 'audio', downloaded: 3, total: 10 });
    f.progress(child, { merging: true });
    await f.complete(child);
  });
  const result = await f.download({ url: `${canonical}&list=PLtracking` });
  assert.equal(result.filePath, path.join(f.directory, 'capture.mp4'));
  assert.equal(result.title, '测试视频'); assert.equal(result.pageUrl, canonical);
  const { executable, args, options } = f.calls[0];
  assert.equal(executable, path.join(f.runtimeDir, 'yt-dlp.exe'));
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.cwd, f.directory);
  for (const flag of ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-update', '--no-playlist', '--no-exec', '--abort-on-unavailable-fragments']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--js-runtimes') + 1], `deno:${path.join(f.runtimeDir, 'deno.exe')}`);
  assert.equal(args[args.indexOf('--ffmpeg-location') + 1], f.ffmpegPath);
  assert.equal(args[args.indexOf('--use-extractors') + 1], 'youtube');
  assert.equal(args[args.indexOf('--output') + 1], path.join(f.directory, 'capture.%(ext)s'));
  assert.deepEqual(args.slice(-2), ['--', canonical]);
  assert.ok(f.events.some(event => event.phase === 'downloading' && event.receivedBytes === 15 && event.totalBytes === 32));
  assert.ok(f.events.some(event => event.phase === 'merging'));
});

test('cancellation stops the downloader and does not return a partial file', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.behavior(async child => { f.metadata(child); controller.abort(); });
  await assert.rejects(f.download({ signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(f.calls[0].child.kills, 1);
});

test('timeout stops the downloader', async t => {
  const f = await fixture(t);
  f.behavior(async child => { f.metadata(child); });
  // Keep the test event loop alive while the implementation's unref'ed timeout fires.
  const active = setTimeout(() => {}, 1000); t.after(() => clearTimeout(active));
  await assert.rejects(f.download({ timeoutMs: 20 }), error => error.code === 'YOUTUBE_TIMEOUT');
  assert.equal(f.calls[0].child.kills, 1);
});

test('aggregate video and audio size is capped even when neither stream exceeds the limit', async t => {
  const f = await fixture(t);
  f.behavior(async child => {
    f.metadata(child);
    f.progress(child, { filename: 'video', downloaded: 70 });
    f.progress(child, { filename: 'audio', downloaded: 40 });
  });
  await assert.rejects(f.download({ maxBytes: 100 }), error => error.code === 'YOUTUBE_TOO_LARGE');
  assert.equal(f.calls[0].child.kills, 1);
});

test('a live, protected, mismatched or audio-only result is rejected before completing download', async t => {
  for (const extra of [{ is_live: true }, { live_status: 'is_upcoming' }, { has_drm: true }, { id: 'aaaaaaaaaaa' }, { vcodec: 'none' }]) {
    await t.test(JSON.stringify(extra), async t => {
      const f = await fixture(t);
      f.behavior(async child => { f.metadata(child, extra); });
      await assert.rejects(f.download());
      assert.equal(f.calls[0].child.kills, 1);
    });
  }
});

test('no success is reported for incomplete output, HTML or a file outside the temporary directory', async t => {
  await t.test('missing final confirmation', async t => {
    const f = await fixture(t); f.behavior(async child => { f.metadata(child); child.emit('close', 0); });
    await assert.rejects(f.download(), /完整的视频文件/);
  });
  await t.test('HTML disguised as MP4', async t => {
    const f = await fixture(t); f.behavior(async child => { f.metadata(child); await f.complete(child, { contents: Buffer.from('<html>This is not a video</html>') }); });
    await assert.rejects(f.download(), /不是视频文件/);
  });
  await t.test('escaped destination', async t => {
    const f = await fixture(t); f.behavior(async child => { f.metadata(child); child.stdout.write(`MOSAIC_FILE:${JSON.stringify(path.join(f.root, 'capture.mp4'))}\n`); });
    await assert.rejects(f.download(), /不在指定临时目录/);
  });
});

test('missing helpers and occupied capture names fail without spawning', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'capture.mp4'), 'existing');
  await assert.rejects(f.download(), /正在使用/); assert.equal(f.calls.length, 0);
  await fs.rm(path.join(f.runtimeDir, 'deno.exe'));
  await assert.rejects(f.download(), error => error.code === 'YOUTUBE_RUNTIME_MISSING'); assert.equal(f.calls.length, 0);
});

test('authentication errors are actionable and do not expose signed URLs or paths', async t => {
  const f = await fixture(t);
  f.behavior(async child => {
    child.stderr.end('ERROR: Sign in to confirm you are not a bot; https://secret.googlevideo.com/file?signature=hidden');
    setImmediate(() => child.emit('close', 1));
  });
  await assert.rejects(f.download(), error => error.code === 'YOUTUBE_AUTH_REQUIRED' && !error.message.includes('signature'));
});
