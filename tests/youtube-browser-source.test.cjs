'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { youtubeMediaUrl, youtubeBrowserSource, stageYouTubeBrowser } = require('../src/youtube-browser-source.cjs');
const { createCollector } = require('../src/collector.cjs');
const { createVideoEngine } = require('../src/video-engine.cjs');
const { checkedSource } = require('../extension/youtube-browser-source.js');

const canonical = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const address = (itag, size) => `https://rr1---sn-fixture.googlevideo.com/videoplayback?id=fixture&itag=${itag}&clen=${size}&lmt=123&sig=fixture%2fSignature%20Value&n=resolved`;
const stream = (extra = {}) => ({ url: address(18, 100), mimeType: 'video/mp4', contentLength: 100,
  duration: 3, itag: 18, hasVideo: true, hasAudio: true, ...extra });
const body = (extra = {}) => ({ sourceType: 'youtube-browser', kind: 'video', url: canonical, pageUrl: canonical,
  videoId: 'jNQXAC9IVRw', expectedDuration: 3, expectedAudio: true, streams: [stream()], ...extra });

test('YouTube browser source requires one exact full video with known duration and audio', () => {
  const result = youtubeBrowserSource(body());
  assert.equal(result.totalBytes, 100); assert.equal(result.hasAudio, true);
  assert.equal(result.streams[0].url, address(18, 100));
  assert.equal(youtubeMediaUrl(new URL(address(18, 100))).href, address(18, 100));
  const mutations = [{ pageUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }, { url: 'https://youtu.be/jNQXAC9IVRw' },
    { videoId: 'aqz-KE-bpKQ' }, { expectedDuration: undefined }, { expectedAudio: undefined }, { expectedAudio: false },
    { playback: 'file' }, { browserRead: false }, { dataBase64: 'AQ==' }, { streams: [] }, { streams: [stream({ hasAudio: false })] },
    { streams: [stream({ contentLength: 101 })] }, { streams: [stream({ duration: 30 })] },
    { streams: [stream({ itag: 0, url: address(0, 100) })] }, { streams: [stream({ mimeType: 'audio/mp4' })] }];
  for (const mutation of mutations) assert.throws(() => youtubeBrowserSource(body(mutation)), Error, JSON.stringify(mutation));
});

test('YouTube browser source accepts only a same-container video/audio pair inside its byte budget', () => {
  const video = stream({ itag: 137, url: address(137, 100), hasAudio: false });
  const audio = stream({ itag: 140, url: address(140, 100), mimeType: 'audio/mp4', hasVideo: false });
  assert.equal(youtubeBrowserSource(body({ streams: [video, audio] })).totalBytes, 200);
  for (const streams of [[video, video], [video, audio, audio], [video, { ...audio, mimeType: 'audio/webm' }],
    [video, { ...audio, hasVideo: true }], [stream(), audio]]) assert.throws(() => youtubeBrowserSource(body({ streams })));
  assert.throws(() => youtubeBrowserSource(body({ streams: [video, audio] }), { maxBytes: 199 }));
});

test('desktop validation agrees with the extension for normalized exact streams and duration bounds', () => {
  const pairs = [body(), body({ expectedDuration: 86400, streams: [stream({ duration: 86400 })] }),
    body({ expectedDuration: 100, streams: [stream({ duration: 102 })] }),
    body({ expectedDuration: 100, streams: [stream({ duration: 102.01 })] }),
    body({ expectedDuration: 86400, streams: [stream({ duration: 86401 })] }),
    body({ streams: [stream({ url: address('018', 100) })] }), body({ streams: [stream({ url: address(18, '0100') })] })];
  for (const sample of pairs) {
    let desktop;
    try { desktop = youtubeBrowserSource(sample); } catch {}
    assert.equal(Boolean(desktop), Boolean(checkedSource(sample)));
  }
});

test('YouTube media policy rejects redirects, fragments, ranges, repeated params and proprietary transports', () => {
  for (const url of [address(18, 100).replace('https:', 'http:'), address(18, 100).replace('googlevideo.com', 'googlevideo.com.evil.test'),
    address(18, 100).replace('https://', 'https://user:secret@'), address(18, 100) + '#fragment', address(18, 100) + '&itag=18',
    ...['range=0-99', 'sq=0', 'live=0', 'ump=0', 'sabr=0'].map(query => address(18, 100) + '&' + query)]) {
    assert.throws(() => youtubeMediaUrl(url));
  }
});

test('YouTube browser staging rejects truncated stream bytes before invoking mux', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-truncated-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(stageYouTubeBrowser({ source: youtubeBrowserSource(body()), directory,
    read: (_, { destination }) => fs.writeFile(destination, Buffer.alloc(99)),
    spawnProcess: () => assert.fail('must not mux truncated input') }), /不完整/);
});

test('YouTube browser staging also copy-muxes separate WebM picture and Opus sound', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-webm-'));
  const runtimeDir = path.resolve(__dirname, '..', 'video-runtime');
  const ffmpeg = path.join(runtimeDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const engine = createVideoEngine({ runtimeDir, cacheDir: path.join(directory, 'cache') });
  t.after(async () => { engine.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  const run = args => {
    const result = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  };
  const input = path.join(directory, 'input.webm');
  run(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=10:d=3', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1', '-c:a', 'libopus', '-y', input]);
  const tracks = [];
  for (const [kind, itag, mimeType] of [['v', 248, 'video/webm'], ['a', 251, 'audio/webm']]) {
    const file = path.join(directory, `${kind}.webm`);
    run(['-v', 'error', '-i', input, '-map', `0:${kind}:0`, '-c', 'copy', '-y', file]);
    const bytes = await fs.readFile(file);
    tracks.push({ bytes, stream: stream({ itag, url: address(itag, bytes.length), contentLength: bytes.length,
      mimeType, hasVideo: kind === 'v', hasAudio: kind === 'a' }) });
  }
  const source = youtubeBrowserSource(body({ streams: tracks.map(track => track.stream) }));
  const result = await stageYouTubeBrowser({ source, directory, read: (url, { destination }) =>
    fs.writeFile(destination, tracks.find(track => track.stream.url === url).bytes) });
  const metadata = await engine.probe(result.filePath);
  assert.equal(metadata.codec, 'vp9'); assert.equal(metadata.audioCodec, 'opus');
  assert.equal(metadata.hasAudio, true); assert.ok(Math.abs(metadata.duration - 3) < 0.1);
  run(['-v', 'error', '-xerror', '-i', result.filePath, '-f', 'null', '-']);
});

test('YouTube browser collector performs real copy mux, probes duration/audio and commits only complete files', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-browser-'));
  const runtimeDir = path.resolve(__dirname, '..', 'video-runtime');
  const ffmpeg = path.join(runtimeDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const engine = createVideoEngine({ runtimeDir, cacheDir: path.join(directory, 'cache') });
  let service;
  t.after(async () => { await service?.close(); engine.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  const run = args => {
    const result = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  };
  const full = path.join(directory, 'full.mp4'), video = path.join(directory, 'video.mp4'), audio = path.join(directory, 'audio.mp4');
  run(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=10:d=3', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3',
    '-c:v', 'libopenh264', '-threads', '1', '-c:a', 'aac', '-y', full]);
  for (const [kind, filename] of [['v', video], ['a', audio]]) run(['-v', 'error', '-i', full, '-map', `0:${kind}:0`, '-c', 'copy', '-y', filename]);
  const fullBytes = await fs.readFile(full), videoBytes = await fs.readFile(video), audioBytes = await fs.readFile(audio);
  const objects = new Map([[18, fullBytes], [137, videoBytes], [140, audioBytes]]);
  const captures = [];
  service = createCollector({ library: { root: path.join(directory, 'library'), listFolders: () => [],
    importPaths: async ([file], options) => {
      const saved = path.join(directory, `saved-${captures.length}.mp4`);
      await fs.copyFile(file, saved); captures.push({ saved, options });
      return { imported: 1, duplicates: 0, assetIds: ['fixture'] };
    } }, configPath: path.join(directory, 'collector.json'), port: 0, probeVideo: engine.probe });
  await service.start();
  const token = service.info().code.split('.')[2];
  const request = async (route, input) => {
    const response = await fetch(service.info().baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shitu-Token': token }, body: JSON.stringify(input) });
    return response.json();
  };
  assert.equal((await request('/v1/ping', {})).youtubeBrowserRead, true);
  const track = (itag, hasVideo, hasAudio) => stream({ itag, url: address(itag, objects.get(itag).length),
    contentLength: objects.get(itag).length, mimeType: hasVideo ? 'video/mp4' : 'audio/mp4', hasVideo, hasAudio });
  async function capture(input, { truncate = false } = {}) {
    let settled = false;
    const result = request('/v1/capture', input).finally(() => { settled = true; });
    const deadline = Date.now() + 15000;
    while (!settled) {
      assert.ok(Date.now() < deadline, 'relay should complete');
      const poll = await request('/v1/capture-browser-read', { requestId: input.requestId });
      if (!poll.read) { await delay(2); continue; }
      const read = poll.read;
      assert.equal(read.sourceType, 'youtube-browser');
      const bytes = objects.get(Number(new URL(read.url).searchParams.get('itag')));
      const send = async (sequence, fields) => request('/v1/capture-browser-data', { requestId: input.requestId, readId: read.readId, sequence, ...fields });
      assert.equal((await send(0, { head: { status: 200, url: read.url, contentType: 'video/mp4', contentLength: bytes.length } })).ok, true);
      const sent = truncate ? bytes.subarray(0, bytes.length - 1) : bytes;
      assert.equal((await send(1, { dataBase64: sent.toString('base64') })).ok, true);
      const done = await send(2, { done: true });
      if (truncate) assert.equal(done.ok, false); else assert.equal(done.ok, true, done.error);
    }
    return result;
  }
  let result = await capture(body({ requestId: '1700000000000-100', streams: [track(137, true, false), track(140, false, true)] }));
  assert.equal(result.ok, true, result.error); assert.equal(captures.length, 1);
  const metadata = await engine.probe(captures[0].saved);
  assert.equal(metadata.hasAudio, true); assert.ok(Math.abs(metadata.duration - 3) < 0.1);
  assert.equal(metadata.codec, 'h264'); assert.equal(metadata.audioCodec, 'aac');
  run(['-v', 'error', '-xerror', '-i', captures[0].saved, '-f', 'null', '-']);
  assert.equal(captures[0].options.metadata.sourceUrl, canonical);
  assert.equal(JSON.stringify(captures[0].options).includes('googlevideo'), false);
  result = await capture(body({ requestId: '1700000000000-101', streams: [track(18, true, true)] }));
  assert.equal(result.ok, true, result.error); assert.deepEqual(await fs.readFile(captures[1].saved), fullBytes);
  result = await capture(body({ requestId: '1700000000000-102', streams: [track(18, true, true)] }), { truncate: true });
  assert.equal(result.ok, false); assert.equal(captures.length, 2);
  result = await capture(body({ requestId: '1700000000000-103', streams: [track(137, true, true)] }));
  assert.equal(result.ok, false); assert.equal(result.code, 'VIDEO_INCOMPLETE'); assert.equal(captures.length, 2);
  const wrongDuration = track(18, true, true); wrongDuration.duration = 10;
  result = await capture(body({ requestId: '1700000000000-104', expectedDuration: 10, streams: [wrongDuration] }));
  assert.equal(result.ok, false); assert.equal(result.code, 'VIDEO_INCOMPLETE'); assert.equal(captures.length, 2);
  const cancellation = request('/v1/capture', body({ requestId: '1700000000000-105', streams: [track(18, true, true)] }));
  for (let i = 0; i < 100; i++) { if ((await request('/v1/capture-browser-read', { requestId: '1700000000000-105' })).read) break; await delay(2); }
  assert.equal((await request('/v1/capture-browser-cancel', { requestId: '1700000000000-105' })).cancelled, true);
  assert.equal((await cancellation).code, 'CAPTURE_CANCELLED'); assert.equal(captures.length, 2);
});
