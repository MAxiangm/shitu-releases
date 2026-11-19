'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { youtubeRecordingUrl, youtubeRecordingSource, stageYouTubeRecording } = require('../src/youtube-recording-source.cjs');
const { createCollector } = require('../src/collector.cjs');
const { createVideoEngine } = require('../src/video-engine.cjs');

const canonical = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const blobUrl = 'blob:https://www.youtube.com/483a8d35-4104-4d79-8c22-ae7b5776fdc4';
const stream = extra => ({ url: blobUrl, mimeType: 'video/webm', contentLength: 100, duration: 3, hasVideo: true, hasAudio: true, ...extra });
const body = extra => ({ sourceType: 'youtube-recording', kind: 'video', completed: true, url: canonical, pageUrl: canonical,
  videoId: 'jNQXAC9IVRw', expectedDuration: 3, expectedAudio: true, streams: [stream()], ...extra });

test('recording capture requires a completed exact-video WebM blob with known audio and duration', () => {
  const result = youtubeRecordingSource(body());
  assert.equal(result.totalBytes, 100); assert.equal(result.streams[0].url, blobUrl);
  assert.equal(youtubeRecordingUrl(new URL(blobUrl)).href, blobUrl);
  for (const value of [blobUrl + '?x=1', blobUrl + '#x', blobUrl.replace('https:', 'http:'), blobUrl.replace('www.youtube.com', 'evil.test'),
    blobUrl.replace('www.youtube.com', 'www.youtube.com.evil.test'), blobUrl.replace('483a8d35', 'invalid'),
    blobUrl.replace('blob:', ''), 'blob:null/483a8d35-4104-4d79-8c22-ae7b5776fdc4']) assert.throws(() => youtubeRecordingUrl(value));
  for (const change of [{ completed: false }, { completed: undefined }, { expectedAudio: undefined }, { expectedDuration: 0 },
    { expectedDuration: 86401 }, { videoId: 'aaaaaaaaaaa' }, { pageUrl: canonical + '&t=1' }, { url: 'https://youtu.be/jNQXAC9IVRw' },
    { playback: 'file' }, { browserRead: true }, { dataBase64: 'AQ==' }, { streams: [] }, { streams: [stream(), stream()] },
    { streams: [stream({ mimeType: 'video/mp4' })] }, { streams: [stream({ hasVideo: false })] },
    { streams: [stream({ hasAudio: false })] }, { streams: [stream({ duration: 30 })] }, { streams: [stream({ contentLength: 11 })] }]) {
    assert.throws(() => youtubeRecordingSource(body(change)), Error, JSON.stringify(change));
  }
  assert.throws(() => youtubeRecordingSource(body(), { maxBytes: 99 }));
});

test('recording staging refuses wrong byte counts and non-WebM files without a network fetch', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-stage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = youtubeRecordingSource(body());
  await assert.rejects(stageYouTubeRecording({ source, directory, read: (url, options) => {
    assert.equal(url, blobUrl); assert.equal(options.contentType, 'video/webm');
    return fs.writeFile(options.destination, Buffer.alloc(99));
  } }), /不完整/);
  await assert.rejects(stageYouTubeRecording({ source, directory, read: (_, options) => fs.writeFile(options.destination, Buffer.alloc(100)) }), /不是 WebM/);
});

test('recording relay imports exact completed A/V bytes only after probe and never imports incomplete or silent recordings', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-relay-'));
  const runtimeDir = path.resolve(__dirname, '..', 'video-runtime');
  const ffmpeg = path.join(runtimeDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const engine = createVideoEngine({ runtimeDir, cacheDir: path.join(directory, 'cache') });
  let service;
  t.after(async () => { await service?.close(); engine.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  const run = args => {
    const result = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  };
  const full = path.join(directory, 'recording.webm'), silent = path.join(directory, 'silent.webm');
  run(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=10:d=3', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1', '-c:a', 'libopus', '-f', 'webm', '-live', '1', '-y', full]);
  run(['-v', 'error', '-i', full, '-map', '0:v:0', '-c', 'copy', '-y', silent]);
  const fullBytes = await fs.readFile(full), silentBytes = await fs.readFile(silent);
  assert.equal((await engine.probe(full)).duration, 0, 'fixture mirrors a MediaRecorder WebM without duration metadata');
  const captures = [];
  service = createCollector({ library: { root: path.join(directory, 'library'), listFolders: () => [],
    importPaths: async ([file], options) => {
      const saved = path.join(directory, `saved-${captures.length}.webm`);
      await fs.copyFile(file, saved); captures.push({ saved, options });
      return { imported: 1, duplicates: 0, assetIds: ['fixture'] };
    } }, configPath: path.join(directory, 'collector.json'), port: 0, probeVideo: async (filename, options) => {
      const staged = await fs.readFile(path.join(path.dirname(filename), 'youtube-recording.webm'));
      assert.ok(staged.equals(fullBytes) || staged.equals(silentBytes), 'original browser blob bytes were staged exactly');
      return engine.probe(filename, options);
    } });
  await service.start();
  const token = service.info().code.split('.')[2];
  const request = async (route, input) => {
    const response = await fetch(service.info().baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shitu-Token': token }, body: JSON.stringify(input) });
    return response.json();
  };
  assert.equal(Object.hasOwn(await request('/v1/ping', {}), 'youtubeRecording'), false,
    'the unverified recording prototype must remain unadvertised');
  let serial = 300;
  async function capture(bytes, { truncated = false, contentType = 'video/webm', expectedDuration = 3 } = {}) {
    const requestId = `1700000000000-${serial++}`;
    const input = body({ requestId, expectedDuration, streams: [stream({ contentLength: bytes.length, duration: expectedDuration })] });
    let settled = false;
    const result = request('/v1/capture', input).finally(() => { settled = true; });
    const deadline = Date.now() + 10000;
    while (!settled) {
      assert.ok(Date.now() < deadline);
      const { read } = await request('/v1/capture-browser-read', { requestId });
      if (!read) { await delay(2); continue; }
      assert.equal(read.url, blobUrl); assert.equal(read.sourceType, 'youtube-recording'); assert.equal(read.limit, bytes.length);
      const send = (sequence, fields) => request('/v1/capture-browser-data', { requestId, readId: read.readId, sequence, ...fields });
      const head = await send(0, { head: { status: 200, url: blobUrl, contentType, contentLength: bytes.length } });
      if (!head.ok) { assert.equal(contentType, 'video/mp4'); continue; }
      const data = truncated ? bytes.subarray(0, bytes.length - 1) : bytes;
      assert.equal((await send(1, { dataBase64: data.toString('base64') })).ok, true);
      assert.equal((await send(2, { done: true })).ok, !truncated);
    }
    return result;
  }
  let result = await capture(fullBytes);
  assert.equal(result.ok, true, result.error); assert.equal(captures.length, 1);
  const metadata = await engine.probe(captures[0].saved);
  assert.equal(metadata.codec, 'vp9'); assert.equal(metadata.audioCodec, 'opus');
  assert.equal(metadata.hasAudio, true); assert.ok(Math.abs(metadata.duration - 3) < 0.1, 'copy remux recovers the actual recording duration');
  assert.equal(captures[0].options.metadata.sourceUrl, canonical); assert.equal(captures[0].options.metadata.pageUrl, canonical);
  assert.equal(JSON.stringify(captures[0].options).includes('blob:'), false);
  run(['-v', 'error', '-xerror', '-i', captures[0].saved, '-f', 'null', '-']);
  result = await capture(fullBytes, { truncated: true });
  assert.equal(result.ok, false); assert.equal(captures.length, 1);
  result = await capture(fullBytes, { contentType: 'video/mp4' });
  assert.equal(result.ok, false); assert.equal(captures.length, 1);
  result = await capture(silentBytes);
  assert.equal(result.code, 'VIDEO_INCOMPLETE'); assert.equal(captures.length, 1);
  result = await capture(fullBytes, { expectedDuration: 10 });
  assert.equal(result.code, 'VIDEO_INCOMPLETE'); assert.equal(captures.length, 1);
  const requestId = `1700000000000-${serial++}`;
  const pending = request('/v1/capture', body({ requestId }));
  for (let i = 0; i < 100; i++) { if ((await request('/v1/capture-browser-read', { requestId })).read) break; await delay(2); }
  assert.equal((await request('/v1/capture-browser-cancel', { requestId })).cancelled, true);
  assert.equal((await pending).code, 'CAPTURE_CANCELLED'); assert.equal(captures.length, 1);
});
