'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
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
  const parent = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'mosaic-youtube-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    return fs.rm(root, { recursive: true, force: true });
  });
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
  const metadata = (child, extra = {}) => child.stdout.write(`MOSAIC_META:${JSON.stringify({ id, title: '测试视频', is_live: false, live_status: 'not_live', has_drm: false, vcodec: 'h264', acodec: 'aac', duration: 1, ...extra })}\n`);
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
    f.progress(child, { filename: 'video', downloaded_bytes: 12, total_bytes: 22 });
    f.progress(child, { filename: 'audio', downloaded_bytes: 3, total_bytes: 10 });
    f.progress(child, { merging: true });
    await f.complete(child);
  });
  const result = await f.download({ url: `${canonical}&list=PLtracking` });
  assert.equal(result.filePath, path.join(f.directory, 'capture.mp4'));
  assert.equal(result.title, '测试视频'); assert.equal(result.pageUrl, canonical);
  assert.equal(result.duration, 1); assert.equal(result.hasAudio, true);
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

test('selected audio and duration constraints remain unknown when the extractor omits them', async t => {
  for (const [acodec, duration, expectedAudio, expectedDuration] of [
    [undefined, undefined, undefined, undefined], ['unknown', null, undefined, undefined],
    ['none', 12.5, false, 12.5], ['opus', -1, true, undefined]
  ]) {
    const f = await fixture(t);
    f.behavior(async child => { f.metadata(child, { acodec, duration }); await f.complete(child); });
    const result = await f.download();
    assert.equal(result.hasAudio, expectedAudio);
    assert.equal(result.duration, expectedDuration);
  }
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
    f.progress(child, { filename: 'video', downloaded_bytes: 70 });
    f.progress(child, { filename: 'audio', downloaded_bytes: 40 });
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

test('app-managed cookie files are passed as one argument without exposing their contents', async t => {
  const f = await fixture(t);
  const cookieFile = path.join(f.root, 'app session 50%.txt');
  const secret = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tprivate-test-value\n';
  await fs.writeFile(cookieFile, secret);
  const result = await f.download({ cookieFile });
  assert.equal(result.pageUrl, canonical);
  const args = f.calls[0].args;
  assert.equal(args.filter(value => value === '--cookies').length, 1);
  assert.equal(args[args.indexOf('--cookies') + 1], cookieFile);
  assert.ok(!JSON.stringify(f.events).includes('private-test-value'));
  assert.ok(!JSON.stringify(result).includes(cookieFile));
  assert.equal(await fs.readFile(cookieFile, 'utf8'), secret, 'the auth service owns the file lifetime');
});

test('missing, relative, empty, oversized and non-file cookie paths fail before launching a downloader', async t => {
  const f = await fixture(t);
  const empty = path.join(f.root, 'empty.txt');
  const large = path.join(f.root, 'large.txt');
  await fs.writeFile(empty, '');
  await fs.writeFile(large, 'test');
  await fs.truncate(large, 8 * 1024 * 1024 + 1);
  for (const cookieFile of [null, '', 'relative.txt', path.join(f.root, 'missing.txt'), f.root, empty, large, `${empty}\0`]) {
    await assert.rejects(f.download({ cookieFile }), error => error.code === 'YOUTUBE_AUTH_FILE_INVALID');
  }
  assert.equal(f.calls.length, 0);
});

test('cookie paths through a redirected directory are rejected before launching a downloader', async t => {
  const f = await fixture(t);
  const original = path.join(f.root, 'auth-owner');
  const redirected = path.join(f.root, 'auth-link');
  await fs.mkdir(original);
  await fs.writeFile(path.join(original, 'session.txt'), '# Netscape HTTP Cookie File\n');
  try { await fs.symlink(original, redirected, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory links are unavailable in this test environment'); return; }
    throw error;
  }
  await assert.rejects(f.download({ cookieFile: path.join(redirected, 'session.txt') }), error => error.code === 'YOUTUBE_AUTH_FILE_INVALID');
  assert.equal(f.calls.length, 0);
});

test('actual bundled yt-dlp accepts an app cookie file and downloads playable media with native JSON progress', { timeout: 60000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Bundled Windows executable integration'); return; }
  const runtimeDir = path.resolve(__dirname, '..', 'video-runtime', 'youtube');
  const ffmpegPath = path.resolve(runtimeDir, '..', 'ffmpeg.exe');
  const ffprobePath = path.resolve(runtimeDir, '..', 'ffprobe.exe');
  try { await Promise.all(['yt-dlp.exe', 'deno.exe'].map(name => fs.access(path.join(runtimeDir, name))).concat([fs.access(ffmpegPath), fs.access(ffprobePath)])); }
  catch { t.skip('Bundled video runtime unavailable'); return; }
  const parent = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'mosaic-youtube-cli-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  const sample = path.join(root, 'sample.mp4');
  const generated = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=12:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libopenh264', '-c:a', 'aac', '-threads', '1', '-movflags', '+faststart', '-shortest', '-y', sample],
  { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(generated.error); assert.equal(generated.status, 0, generated.stderr);
  const bytes = await fs.readFile(sample), requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const infoPath = path.join(root, 'info.json');
  // Real video extractors do not guarantee any of these optional metadata fields.
  // The old hand-built template serialized absent fields as bare NA and failed.
  await fs.writeFile(infoPath, JSON.stringify({ id, title: '真实 "引号" 标题\n第二行',
    url: `http://127.0.0.1:${server.address().port}/video.mp4`, ext: 'mp4', vcodec: 'h264', acodec: 'aac', duration: 1,
    extractor: 'youtube', extractor_key: 'Youtube', webpage_url: canonical }));
  const directory = path.join(root, 'output 50%'); await fs.mkdir(directory);
  const cookieFile = path.join(root, 'active session.txt');
  await fs.writeFile(cookieFile, '# Netscape HTTP Cookie File\n');
  const events = [];
  const result = await downloadYouTube({ url: canonical, directory, runtimeDir, ffmpegPath, cookieFile, maxBytes: 1024 * 1024,
    timeoutMs: 30000, onProgress: event => events.push(event),
    spawnProcess(executable, args, options) {
      assert.deepEqual(args.slice(-2), ['--', canonical]);
      assert.equal(args[args.indexOf('--cookies') + 1], cookieFile);
      return spawn(executable, [...args.slice(0, -2), '--load-info-json', infoPath], options);
    } });
  assert.equal(result.title, '真实 "引号" 标题第二行');
  assert.equal(result.pageUrl, canonical);
  assert.equal(result.duration, 1); assert.equal(result.hasAudio, true);
  assert.ok(requests.includes('/video.mp4'));
  assert.ok(events.filter(event => event.phase === 'downloading' && event.receivedBytes > 0).length >= 2,
    'The real transfer progress and the final file confirmation must both be received');
  const probe = spawnSync(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'stream=codec_type', '-of', 'json', result.filePath], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(probe.error); assert.equal(probe.status, 0, probe.stderr);
  const types = JSON.parse(probe.stdout).streams.map(stream => stream.codec_type);
  assert.ok(types.includes('video')); assert.ok(types.includes('audio'));
});
