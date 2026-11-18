'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAudioPreviewService } = require('../src/audio-preview-service.cjs');

async function fixture(t, preview) {
  const parent = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'audio-preview-'));
  const source = path.join(root, 'original.ogg');
  const cached = path.join(root, 'preview.mp3');
  const bytes = Buffer.from('0123456789abcdefghijklmnop');
  await Promise.all([fs.writeFile(source, bytes), fs.writeFile(cached, bytes)]);
  const asset = { id: 'music-1', mediaType: 'audio', hash: 'a'.repeat(64), trashedAt: null };
  const library = { root, snapshot: () => ({ assets: [structuredClone(asset)] }), getAssetPath: id => id === asset.id ? source : null };
  let active = library;
  const engine = { preview: preview || (async () => ({ path: source, mimeType: 'audio/ogg', direct: true,
    duration: 4, codec: 'opus', sampleRate: 48000, channels: 2, audio: { artist: 'Fixture Artist' } })) };
  const service = createAudioPreviewService({ engine, getLibrary: () => active });
  t.after(async () => {
    service.invalidate();
    const relative = path.relative(parent, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, source, cached, bytes, library, asset, service, setLibrary: value => { active = value; } };
}

test('audio preview serves only its authorized music source, preserves MIME and supports seeking', async t => {
  const f = await fixture(t);
  const prepared = await f.service.prepare('music-1', f.root, 'audio-viewer-1');
  assert.equal(prepared.direct, true);
  assert.equal(prepared.duration, 4);
  assert.equal(prepared.audio.artist, 'Fixture Artist');
  assert.ok(prepared.url.startsWith('shitu://audio/music-1?key='));
  const response = await f.service.response(new Request(prepared.url, { headers: { Range: 'bytes=4-9' } }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'audio/ogg');
  assert.equal(response.headers.get('content-range'), `bytes 4-9/${f.bytes.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(4, 10));
  const head = await f.service.response(new Request(prepared.url, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(f.bytes.length));
  assert.equal(await head.text(), '');
  assert.equal((await f.service.response(new Request(prepared.url, { method: 'POST' }))).status, 405);
  assert.equal((await f.service.response(new Request(prepared.url.replace('music-1', 'music-2')))).status, 404);
});

test('audio cancellation revokes the completed playback URL without affecting another token', async t => {
  const f = await fixture(t);
  const first = await f.service.prepare('music-1', f.root, 'first');
  const next = await f.service.prepare('music-1', f.root, 'next');
  assert.equal((await f.service.response(new Request(first.url))).status, 404);
  f.service.cancel('first');
  const response = await f.service.response(new Request(next.url));
  assert.equal(response.status, 200);
  await response.body.cancel();
  assert.equal(f.service.cancel('next'), true);
  assert.equal((await f.service.response(new Request(next.url))).status, 404);
});

test('an audio preparation finishing after cancellation cannot publish a playable URL', async t => {
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async source => {
    started();
    await new Promise(resolve => { finish = resolve; });
    return { path: source, mimeType: 'audio/ogg' };
  });
  const pending = f.service.prepare('music-1', f.root, 'waiting');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await began;
  assert.equal(f.service.cancel('waiting'), true);
  finish();
  await rejected;
});

test('audio leases reject changed source files, trashed assets and replaced libraries', async t => {
  const f = await fixture(t);
  const prepared = await f.service.prepare('music-1', f.root, 'initial');
  await fs.appendFile(f.source, 'changed');
  assert.equal((await f.service.response(new Request(prepared.url))).status, 404);
  const another = await f.service.prepare('music-1', f.root, 'another');
  f.asset.trashedAt = new Date().toISOString();
  assert.equal((await f.service.response(new Request(another.url))).status, 404);
  f.asset.trashedAt = null;
  const third = await f.service.prepare('music-1', f.root, 'third');
  f.setLibrary({ root: f.root, snapshot: f.library.snapshot, getAssetPath: f.library.getAssetPath });
  assert.equal((await f.service.response(new Request(third.url))).status, 404);
  await assert.rejects(f.service.prepare('music-1', 'foreign-root', 'foreign'), /素材库已切换/);
});

test('changed transcoded cache bytes cannot be served as an already authorized preview', async t => {
  let f;
  f = await fixture(t, async () => ({ path: f.cached, mimeType: 'audio/mpeg', transcoded: true, cached: true }));
  const prepared = await f.service.prepare('music-1', f.root, 'cached');
  assert.equal(prepared.transcoded, true);
  await fs.appendFile(f.cached, 'corrupted');
  assert.equal((await f.service.response(new Request(prepared.url))).status, 404);
});

test('audio preparation validates type, identity, token and engine output', async t => {
  const f = await fixture(t, async source => ({ path: source, mimeType: 'text/html' }));
  await assert.rejects(f.service.prepare('music-1', f.root, 'invalid token'), /标识无效/);
  await assert.rejects(f.service.prepare('../private', f.root, 'token'), /标识无效/);
  await assert.rejects(f.service.prepare('music-1', f.root, 'html'), /预览结果无效/);
  f.asset.mediaType = 'image';
  await assert.rejects(f.service.prepare('music-1', f.root, 'image'), /音乐素材/);
});

test('selecting another track aborts only the old audio request and ignores its late completion', async t => {
  let calls = 0, finish, started;
  const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async source => {
    if (++calls === 1) { started(); await new Promise(resolve => { finish = resolve; }); }
    return { path: source, mimeType: 'audio/ogg', direct: true };
  });
  const old = f.service.prepare('music-1', f.root, 'old');
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await began;
  const current = await f.service.prepare('music-1', f.root, 'current');
  f.service.cancel('old');
  finish();
  await rejected;
  const response = await f.service.response(new Request(current.url));
  assert.equal(response.status, 200);
  await response.body.cancel();
});
