'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCollector } = require('../src/collector.cjs');
const { createVideoEngine } = require('../src/video-engine.cjs');
const { videoExpectations, checkCapturedVideo } = require('../src/captured-video-check.cjs');

test('video expectations reject misleading constraints and unknown audio stays unknown', () => {
  assert.deepEqual(videoExpectations({}), {});
  assert.deepEqual(videoExpectations({ expectedDuration: 12.4, expectedAudio: true }), { expectedDuration: 12.4, expectedAudio: true });
  for (const expectedDuration of [0, -1, Infinity, NaN, '12', 86401]) assert.throws(() => videoExpectations({ expectedDuration }));
  for (const expectedAudio of [false, 1, 'true', null]) assert.throws(() => videoExpectations({ expectedAudio }));
  const video = { codec: 'h264', width: 64, height: 48, duration: 12.4, hasAudio: false };
  assert.equal(checkCapturedVideo(video, {}), video);
  assert.throws(() => checkCapturedVideo(video, { expectedAudio: true }), /声音/);
});

test('collector probes real downloaded files before import and refuses missing audio or truncated duration', async t => {
  const root = path.resolve(__dirname, '..');
  const testsRoot = path.join(root, '.recovery', 'tests');
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'capture-video-check-'));
  const engine = createVideoEngine({ runtimeDir: path.join(root, 'video-runtime'), cacheDir: path.join(directory, 'cache') });
  const imports = [];
  const library = { root: path.join(directory, 'library'), listFolders: () => [],
    importPaths: async files => { imports.push(await fs.readFile(files[0])); return { imported: 1, duplicates: 0, assetIds: ['verified'], errors: [] }; } };
  const collector = createCollector({ library, configPath: path.join(directory, 'collector.json'), port: 0,
    probeVideo: (file, options) => engine.probe(file, options) });
  t.after(async () => {
    await collector.close(); await engine.shutdown();
    assert.equal(path.dirname(directory), testsRoot);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const makeVideo = async withAudio => {
    const file = path.join(directory, withAudio ? 'with-audio.mp4' : 'silent.mp4');
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=10:d=1'];
    if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-shortest');
    else args.push('-an');
    args.push('-c:v', 'libopenh264', '-threads', '1', '-y', file);
    const made = spawnSync(path.join(root, 'video-runtime', 'ffmpeg.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.ifError(made.error); assert.equal(made.status, 0, made.stderr);
    return fs.readFile(file);
  };
  const silent = await makeVideo(false), audible = await makeVideo(true);
  await collector.start();
  const token = collector.info().code.split('.')[2];
  const capture = async (bytes, extra = {}) => {
    const response = await fetch(collector.info().baseUrl + '/v1/capture', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shitu-Token': token },
      body: JSON.stringify({ kind: 'video', url: 'https://example.test/video.mp4', dataBase64: bytes.toString('base64'), mimeType: 'video/mp4', ...extra }) });
    return response.json();
  };
  const missing = await capture(silent, { expectedAudio: true, expectedDuration: 1 });
  assert.equal(missing.ok, false); assert.match(missing.error, /声音/); assert.equal(imports.length, 0);
  const truncated = await capture(audible, { expectedAudio: true, expectedDuration: 12 });
  assert.equal(truncated.ok, false); assert.match(truncated.error, /时长/); assert.equal(imports.length, 0);
  const valid = await capture(audible, { expectedAudio: true, expectedDuration: 1 });
  assert.equal(valid.ok, true, valid.error); assert.equal(imports.length, 1);
  const validSilent = await capture(silent, { expectedDuration: 1 });
  assert.equal(validSilent.ok, true, validSilent.error); assert.equal(imports.length, 2);
});
