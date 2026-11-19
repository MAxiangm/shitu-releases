'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyWebVideo, videoIdentity, createVerificationServer } = require('../scripts/verify-web-video.cjs');

const now = Date.parse('2026-11-19T14:00:00Z');
const sha256 = 'a'.repeat(64);
async function fixture(t) {
  const base = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(base, { recursive: true });
  const libraryRoot = await fs.mkdtemp(path.join(base, 'web-video-verify-'));
  t.after(async () => {
    assert.equal(path.dirname(libraryRoot), base);
    await fs.rm(libraryRoot, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(libraryRoot, 'originals'));
  await fs.writeFile(path.join(libraryRoot, 'originals', 'asset-1.mp4'), 'saved original fixture');
  const index = { assets: [{ id: 'asset-1', filename: 'originals/asset-1.mp4', hash: sha256, pageUrl: 'https://www.youtube.com/watch?v=AbCdEfGhI_1' }] };
  await fs.writeFile(path.join(libraryRoot, 'index.json'), JSON.stringify(index));
  return { evidence: { site: 'YouTube', pageUrl: index.assets[0].pageUrl, assetId: 'asset-1', libraryRoot,
    capturedAt: new Date(now - 10_000).toISOString(), gesture: { type: 'Alt+right', trusted: true },
    page: { realSite: true, fixture: false }, source: { durationSeconds: 12, hasAudio: true },
    receipt: { ok: true, imported: 1, duplicates: 0, assetIds: ['asset-1'] } }, index,
    decoded: { ok: true, sourceUnchanged: true, sha256, bytes: 100, durationSeconds: 12,
      audio: [{ codec: 'aac' }], decode: { complete: true, sampled: false } } };
}

test('same-video identities normalize supported site routes without trusting unrelated hosts', () => {
  for (const [site, first, second] of [
    ['YouTube', 'https://youtu.be/AbCdEfGhI_1?t=2', 'https://www.youtube.com/shorts/AbCdEfGhI_1'],
    ['Vimeo', 'https://player.vimeo.com/video/798860?h=ab', 'https://vimeo.com/798860'],
    ['Pinterest', 'https://ca.pinterest.com/pin/123/', 'https://www.pinterest.com/pin/123/'],
    ['Instagram', 'https://www.instagram.com/reel/abc/', 'https://www.instagram.com/name/reel/abc/'],
    ['X', 'https://twitter.com/name/status/123', 'https://x.com/i/status/123']
  ]) assert.equal(videoIdentity(first, site), videoIdentity(second, site));
  assert.equal(videoIdentity('https://youtube.com.example/watch?v=AbCdEfGhI_1', 'YouTube'), null);
  assert.equal(videoIdentity('https://www.youtube.com/watch?v=AbCdEfGhI_1&v=AbCdEfGhI_2', 'YouTube'), null);
});

test('fresh real gesture and persisted full video with matching duration/audio can pass', async t => {
  const data = await fixture(t);
  let original;
  const report = await verifyWebVideo(data.evidence, { now, verify: async file => { original = file; return data.decoded; } });
  assert.equal(report.status, 'passed');
  assert.equal(report.ok, true);
  assert.equal(original, path.join(data.evidence.libraryRoot, 'originals', 'asset-1.mp4'));
  assert.equal(report.checks.durationMatches, true);
  assert.equal(report.checks.audioPreserved, true);
});

test('old, synthetic or unobserved captures cannot be advertised as fresh end-to-end success', async t => {
  const data = await fixture(t);
  const cases = [
    { capturedAt: '2026-11-18T14:00:00Z' }, { gesture: { type: 'Alt+right', trusted: false } },
    { page: { realSite: true, fixture: true } }, { source: { hasAudio: true } }, { source: { durationSeconds: 12 } },
    { receipt: { ok: true, imported: 1, assetIds: ['other-asset'] } }, { receipt: undefined }
  ];
  for (const change of cases) {
    const report = await verifyWebVideo({ ...data.evidence, ...change }, { now, verify: async () => data.decoded });
    assert.equal(report.status, 'incomplete'); assert.equal(report.ok, false);
  }
});

test('silent, shortened, changed or partially decoded files fail independent checks', async t => {
  const data = await fixture(t);
  for (const change of [{ audio: [] }, { durationSeconds: 4 }, { sha256: 'b'.repeat(64) }, { decode: { complete: true, sampled: true } }]) {
    const report = await verifyWebVideo(data.evidence, { now, verify: async () => ({ ...data.decoded, ...change }) });
    assert.equal(report.status, 'failed'); assert.equal(report.ok, false);
  }
});

test('a mismatched page or a path escaping the library cannot pass', async t => {
  const data = await fixture(t);
  const wrong = { ...data.evidence, pageUrl: 'https://www.youtube.com/watch?v=AbCdEfGhI_2' };
  assert.equal((await verifyWebVideo(wrong, { now, verify: async () => data.decoded })).status, 'failed');
  data.index.assets[0].filename = '../outside.mp4';
  await fs.writeFile(path.join(data.evidence.libraryRoot, 'index.json'), JSON.stringify(data.index));
  await assert.rejects(verifyWebVideo(data.evidence, { now, verify: async () => data.decoded }), /leaves the library/);
});

test('isolated server starts without Electron and reports no pairing secret', async t => {
  const data = await fixture(t), messages = [];
  const directory = path.join(data.evidence.libraryRoot, 'server');
  const server = await createVerificationServer({ directory, port: 0, output: message => messages.push(JSON.parse(message)) });
  try {
    assert.equal(messages[0].event, 'ready');
    assert.match(messages[0].baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(messages[0].token, undefined);
    assert.equal((await fs.stat(path.join(server.libraryRoot, 'index.json'))).isFile(), true);
  } finally { await server.close(); }
});

test('isolated server imports and completely decodes actual AV bytes without promoting a fixture to a live pass', async t => {
  const data = await fixture(t);
  const ffmpeg = path.resolve(__dirname, '..', 'video-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  try { await fs.access(ffmpeg); } catch { t.skip('Bundled FFmpeg is unavailable'); return; }
  const source = path.join(data.evidence.libraryRoot, 'source.mp4');
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=12:d=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
    '-c:v', 'libopenh264', '-c:a', 'aac', '-shortest', '-y', source], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.ifError(generated.error); assert.equal(generated.status, 0, generated.stderr);
  const server = await createVerificationServer({ directory: path.join(data.evidence.libraryRoot, 'av-server'), port: 0, output() {} });
  try {
    const token = server.collector.info().code.split('.')[2];
    const response = await fetch(server.baseUrl + '/v1/capture', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shitu-Token': token },
      body: JSON.stringify({ kind: 'video', url: data.evidence.pageUrl, pageUrl: data.evidence.pageUrl,
        name: 'Harness AV fixture', mimeType: 'video/mp4', dataBase64: (await fs.readFile(source)).toString('base64') }) });
    const receipt = await response.json(); assert.equal(receipt.ok, true); assert.equal(receipt.imported, 1);
    const deadline = Date.now() + 30000;
    let captures;
    do {
      captures = JSON.parse(await fs.readFile(server.reportPath, 'utf8'));
      if (captures.captures[0]?.assets[0]?.decoded) break;
      if (captures.captures[0]?.assets[0]?.decodeError) throw new Error(captures.captures[0].assets[0].decodeError);
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    const decoded = captures.captures[0]?.assets[0]?.decoded;
    assert.equal(decoded?.decode.complete, true); assert.equal(decoded?.decode.sampled, false);
    assert.equal(decoded.audio.length, 1); assert.ok(decoded.decode.videoFrames > 0);
    const report = await verifyWebVideo({ ...data.evidence, libraryRoot: server.libraryRoot,
      assetId: receipt.assetIds[0], receipt, source: { durationSeconds: 0.5, hasAudio: true },
      page: { realSite: false, fixture: true } }, { now });
    assert.equal(report.checks.hashMatches, true); assert.equal(report.checks.fullDecode, true);
    assert.equal(report.status, 'incomplete'); assert.equal(report.ok, false);
  } finally { await server.close(); }
});
