'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Library } = require('../src/library.cjs');
const { createCollector } = require('../src/collector.cjs');
const { createVideoEngine } = require('../src/video-engine.cjs');

const testsRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
const EXTENSION = 'mdleapcbplpefdgchdklofdnpjgokdhh';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Zf8AAAAASUVORK5CYII=', 'base64');
const image = extra => ({ kind: 'image', url: 'https://offline.example.invalid/picture.png',
  name: '网页测试图', dataBase64: PNG.toString('base64'), mimeType: 'image/png', ...extra });

async function fixture(t, options = {}) {
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'collector-'));
  const library = new Library({ root: path.join(directory, 'library') });
  await library.init();
  const service = createCollector({ library, configPath: path.join(directory, 'collector.json'), port: 0, ...options });
  await service.start();
  const token = service.info().code.split('.')[2];
  const request = async (route, body, extra = {}) => {
    const response = await fetch(service.info().baseUrl + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shitu-Token': token, ...extra.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body), signal: extra.signal });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    await service.close();
    const relative = path.relative(testsRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, library, service, token, request, capture: (body, extra) => request('/v1/capture', body, extra) };
}
async function sourceServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

test('Vimeo playback combines a complete video and separate audio without encoding and retains only the public page URL', async t => {
  const runtimeDir = path.resolve(__dirname, '..', 'video-runtime');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const ffmpeg = path.join(runtimeDir, `ffmpeg${suffix}`);
  const ffprobe = path.join(runtimeDir, `ffprobe${suffix}`);
  try { await Promise.all([fs.access(ffmpeg), fs.access(ffprobe)]); }
  catch { t.skip('Bundled video runtime unavailable'); return; }
  const engine = createVideoEngine({ runtimeDir, cacheDir: path.join(testsRoot, 'unused-capture-cache') });
  t.after(() => engine.shutdown());
  const setup = await fixture(t, { muxVimeoPlayback: engine.muxVimeoPlayback });
  assert.equal((await setup.request('/v1/ping', {})).body.vimeoPlayback, true);
  const media = path.join(setup.directory, 'fixture');
  await fs.mkdir(media);
  const run = (executable, args) => {
    const result = spawnSync(executable, args, { cwd: media, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=10:d=2', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2',
    '-c:v', 'libopenh264', '-g', '10', '-threads', '1', '-c:a', 'aac', 'original.mp4']);
  for (const [type, label] of [['v', 'picture'], ['a', 'sound']]) {
    run(ffmpeg, ['-v', 'error', '-i', 'original.mp4', '-map', `0:${type}:0`, '-c', 'copy', '-f', 'hls',
      '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', `${label}-init.mp4`, `${label}.m3u8`]);
  }
  await fs.writeFile(path.join(media, 'master.m3u8'), ['#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="original-audio",NAME="Original",DEFAULT=YES,URI="sound.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=96x64,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="original-audio"', 'picture.m3u8', ''].join('\n'));
  const hosts = [];
  const originalGet = https.get;
  const originalLookup = dns.lookup;
  dns.lookup = async (host, options) => host === 'capture-test.vimeocdn.com' ? [{ address: '203.0.113.80', family: 4 }] : originalLookup(host, options);
  https.get = (url, options, responseReady) => {
    assert.equal(url.hostname, 'capture-test.vimeocdn.com');
    assert.equal(options.headers.Referer, undefined);
    assert.equal(options.headers.Cookie, undefined);
    hosts.push(url.pathname);
    const request = new EventEmitter();
    if (url.pathname === '/denied.mp4') {
      queueMicrotask(() => {
        const response = Readable.from(['Forbidden']);
        response.statusCode = 403;
        response.headers = {};
        responseReady(response);
      });
      return request;
    }
    fs.readFile(path.join(media, path.posix.basename(url.pathname))).then(bytes => {
      const response = Readable.from([bytes]);
      response.statusCode = 200;
      response.headers = { 'content-length': bytes.length };
      responseReady(response);
    }, error => request.emit('error', error));
    return request;
  };
  t.after(() => { https.get = originalGet; dns.lookup = originalLookup; });
  const pageUrl = 'https://vimeo.com/123';
  const { body } = await setup.capture({ kind: 'video', playback: 'hls', name: 'Vimeo fixture', pageUrl,
    url: 'https://capture-test.vimeocdn.com/master.m3u8?ephemeral=fixture-value' });
  assert.equal(body.ok, true, body.error);
  assert.equal(body.imported, 1);
  assert.ok(hosts.includes('/picture.m3u8') && hosts.includes('/sound.m3u8'));
  const [asset] = setup.library.snapshot().assets;
  assert.equal(asset.sourceUrl, pageUrl);
  assert.equal(asset.pageUrl, pageUrl);
  const saved = setup.library.getAssetPath(asset.id, 'original');
  const streams = await engine.probe(saved);
  assert.equal(streams.codec, 'h264');
  assert.equal(streams.audioCodec, 'aac');
  assert.ok(streams.duration >= 1.99);
  const packetHashes = (filename, type) => {
    const json = run(ffprobe, ['-v', 'error', '-select_streams', `${type}:0`, '-show_packets', '-show_data_hash', 'sha256',
      '-show_entries', 'packet=data_hash', '-of', 'json', filename]);
    return JSON.parse(json).packets.map(packet => packet.data_hash);
  };
  assert.deepEqual(packetHashes(saved, 'v'), packetHashes('picture.m3u8', 'v'));
  assert.deepEqual(packetHashes(saved, 'a'), packetHashes('sound.m3u8', 'a'));

  const direct = (await setup.capture({ kind: 'video', playback: 'file', name: 'Vimeo file', pageUrl,
    url: 'https://capture-test.vimeocdn.com/original.mp4?ephemeral=fixture-value' })).body;
  assert.equal(direct.imported, 1, direct.error);
  const directFile = setup.library.getAssetPath(direct.assetIds[0], 'original');
  assert.deepEqual(await fs.readFile(directFile), await fs.readFile(path.join(media, 'original.mp4')));

  // Exercise the same parser/mux/import flow with all media bytes relayed from
  // the browser. The local HTTPS downloader must not be used in this mode.
  const beforeRelay = hosts.length;
  let relaySerial = 0;
  async function relayCapture(playback, filename, existingRequestId) {
    const requestId = existingRequestId || `1700000000000-${++relaySerial}`;
    const reads = [];
    let settled = false;
    const result = setup.capture({ kind: 'video', playback, pageUrl, name: `browser-${filename}`,
      url: `https://capture-test.vimeocdn.com/${filename}?ephemeral=browser-fixture`, requestId, browserRead: true });
    result.finally(() => { settled = true; });
    const deadline = Date.now() + 10000;
    while (!settled) {
      assert.ok(Date.now() < deadline, 'browser relay capture completes');
      const { body: polling } = await setup.request('/v1/capture-browser-read', { requestId });
      assert.equal(polling.ok, true, polling.error);
      const read = polling.read;
      if (!read) { await delay(2); continue; }
      reads.push(read);
      const pathname = new URL(read.url).pathname;
      let bytes = await fs.readFile(path.join(media, path.posix.basename(pathname)));
      const fullLength = bytes.length;
      if (read.range) bytes = bytes.subarray(read.range.start, read.range.end + 1);
      const send = async (sequence, fields) => {
        const { status, body } = await setup.request('/v1/capture-browser-data', { requestId, readId: read.readId, sequence, ...fields });
        assert.equal(status, 200, body.error);
        assert.equal(body.ok, true, body.error);
      };
      await send(0, { head: { status: read.range ? 206 : 200, url: read.url, contentType: 'application/octet-stream',
        contentLength: bytes.length, ...(read.range ? { contentRange: `bytes ${read.range.start}-${read.range.end}/${fullLength}` } : {}) } });
      let sequence = 1;
      for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
        await send(sequence++, { dataBase64: bytes.subarray(offset, offset + 256 * 1024).toString('base64') });
      }
      await send(sequence, { done: true });
    }
    const { body } = await result;
    assert.equal(body.ok, true, body.error);
    assert.equal(body.imported + body.duplicates, 1);
    const assetId = body.assetIds[0] || body.existingAssets[0].id;
    return { saved: setup.library.getAssetPath(assetId, 'original'), reads, requestId };
  }
  const browserHls = await relayCapture('hls', 'master.m3u8');
  assert.ok(browserHls.reads.some(read => read.url.includes('picture.m3u8')));
  assert.ok(browserHls.reads.some(read => read.url.includes('sound.m3u8')));
  assert.deepEqual(packetHashes(browserHls.saved, 'v'), packetHashes('picture.m3u8', 'v'));
  assert.deepEqual(packetHashes(browserHls.saved, 'a'), packetHashes('sound.m3u8', 'a'));

  run(ffmpeg, ['-v', 'error', '-i', 'original.mp4', '-map', '0:v', '-map', '0:a', '-c', 'copy', '-f', 'dash',
    '-seg_duration', '1', '-init_seg_name', 'dash-init-$RepresentationID$.mp4',
    '-media_seg_name', 'dash-media-$RepresentationID$-$Number$.m4s', 'browser.mpd']);
  const browserDash = await relayCapture('dash', 'browser.mpd');
  assert.ok(browserDash.reads.some(read => read.url.includes('dash-init-0')));
  assert.ok(browserDash.reads.some(read => read.url.includes('dash-init-1')));
  const dashProbe = await engine.probe(browserDash.saved);
  assert.equal(dashProbe.codec, 'h264');
  assert.equal(dashProbe.audioCodec, 'aac');
  assert.ok(dashProbe.duration >= 1.99);

  const originalBytes = await fs.readFile(path.join(media, 'original.mp4'));
  const padding = Buffer.alloc(21 * 1024 * 1024);
  padding.writeUInt32BE(padding.length, 0); padding.write('free', 4);
  const largeFile = Buffer.concat([originalBytes, padding]);
  await fs.writeFile(path.join(media, 'large.mp4'), largeFile);
  const browserFile = await relayCapture('file', 'large.mp4');
  assert.deepEqual(await fs.readFile(browserFile.saved), largeFile);
  assert.equal(hosts.length, beforeRelay, 'the desktop does not request CDN bytes for browser relay captures');
  assert.equal((await setup.request('/v1/capture-browser-read', { requestId: browserFile.requestId })).body.done, true);

  const rejectedId = '1700000000000-401';
  const denied = (await setup.capture({ requestId: rejectedId, kind: 'video', playback: 'file', pageUrl,
    url: 'https://capture-test.vimeocdn.com/denied.mp4' })).body;
  assert.equal(denied.code, 'VIMEO_BROWSER_READ');
  assert.deepEqual((await setup.request('/v1/capture-browser-read', { requestId: rejectedId })).body,
    { ok: true, read: null, done: false }, 'the original native failure does not prematurely finish a pending browser retry');
  await fs.copyFile(path.join(media, 'original.mp4'), path.join(media, 'denied.mp4'));
  const retried = await relayCapture('file', 'denied.mp4', rejectedId);
  assert.deepEqual(await fs.readFile(retried.saved), originalBytes);
});

test('HTTP inline image bytes import without local DNS or download and retain the original source URL', async t => {
  let notified;
  const setup = await fixture(t, { onImported: result => { notified = result; } });
  const sourceUrl = 'https://offline.example.invalid/image.png?secret=source-signature';
  const originalLookup = dns.lookup;
  let remoteLookups = 0;
  dns.lookup = async (host, options) => {
    if (host === 'offline.example.invalid') { remoteLookups++; throw new Error('Local DNS must not be used'); }
    return originalLookup(host, options);
  };
  t.after(() => { dns.lookup = originalLookup; });
  const result = (await setup.capture(image({ url: sourceUrl, pageUrl: 'https://page.example.test/gallery' }))).body;
  assert.equal(result.ok, true);
  assert.equal(result.imported, 1);
  assert.equal(remoteLookups, 0);
  assert.equal(result.libraryRoot, setup.library.root);
  assert.deepEqual(result.existingAssets, []);
  assert.deepEqual(notified, result);
  const asset = setup.library.snapshot().assets[0];
  assert.equal(asset.sourceUrl, sourceUrl);
  assert.equal(asset.pageUrl, 'https://page.example.test/gallery');
  assert.deepEqual(await fs.readFile(setup.library.getAssetPath(asset.id, 'original')), PNG);
  assert.equal(setup.service.info().lastCapture.status, 'complete');
  const diagnostics = JSON.stringify(setup.service.info().lastCapture);
  assert.ok(!diagnostics.includes('source-signature') && !diagnostics.includes(setup.token));
  const info = setup.service.info(); info.lastCapture.status = 'changed';
  assert.equal(setup.service.info().lastCapture.status, 'complete', 'diagnostic snapshots must not mutate service state');
});

test('inline image validation rejects unsupported URLs, malformed data, MIME mismatches and oversized bytes', async t => {
  let imports = 0;
  const setup = await fixture(t, { library: { importPaths: () => { imports++; throw new Error('Invalid input reached the library'); } } });
  const invalid = [
    { url: 'file:///private/image.png' }, { url: 'https://name:password@example.test/image.png' },
    { url: 'https://example.test/image.png\n' }, { url: 'not-a-url' },
    { dataBase64: '' }, { dataBase64: 'AB==' }, { dataBase64: 'aGVsbG8' },
    { dataBase64: PNG.toString('base64') + '\n' }, { dataBase64: 'a!==' },
    { mimeType: undefined }, { mimeType: 'text/html' }, { mimeType: 'image/jpeg' },
    { url: 'data:text/html;base64,anything' }, { kind: 'unknown' },
    { dataBase64: 'A'.repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 4) }
  ];
  for (const extra of invalid) {
    const response = await setup.capture(image(extra));
    assert.equal(response.body.ok, false, `Accepted invalid inline input: ${JSON.stringify({ ...extra, dataBase64: typeof extra.dataBase64 })}`);
    assert.equal(setup.service.info().lastCapture.status, 'error');
    assert.ok(setup.service.info().lastCapture.error);
  }
  assert.equal(imports, 0);
});

test('legacy data and blob image uploads still import without recording temporary URLs as permanent sources', async t => {
  for (const url of ['data:image/placeholder;base64,', 'blob:https://example.test/42']) {
    const setup = await fixture(t);
    const result = (await setup.capture(image({ url }))).body;
    assert.equal(result.ok, true); assert.equal(result.imported, 1);
    assert.equal(setup.library.snapshot().assets[0].sourceUrl, undefined);
  }
});

test('a duplicate in the recycle bin identifies its existing asset without silently restoring it', async t => {
  const setup = await fixture(t);
  const first = (await setup.capture(image())).body;
  const folder = await setup.library.createFolder('已有分类');
  const folderId = folder.folders.at(-1).id;
  await setup.library.updateAssets(first.assetIds, { folderId });
  await setup.library.setTrash(first.assetIds, true);
  const duplicate = (await setup.capture(image())).body;
  const existing = setup.library.snapshot().assets[0];
  assert.equal(duplicate.ok, true); assert.equal(duplicate.imported, 0); assert.equal(duplicate.duplicates, 1);
  assert.deepEqual(duplicate.existingAssets, [{ id: existing.id, name: existing.name, trashedAt: existing.trashedAt, folderId }]);
  assert.equal(setup.library.snapshot().stats.active, 0);
  assert.equal(setup.library.snapshot().stats.trashed, 1);
  assert.deepEqual(setup.service.info().lastCapture.existingAssets, duplicate.existingAssets);
});

test('a zero-import zero-duplicate report is a visible failure rather than a successful capture', async t => {
  let notified = false;
  const setup = await fixture(t, { library: { importPaths: async () => ({ imported: 0, duplicates: 0, errors: [], unsupported: ['media.png'], assetIds: [] }) },
    onImported: () => { notified = true; } });
  const result = (await setup.capture(image())).body;
  assert.equal(result.ok, false); assert.match(result.error, /未保存|不支持/);
  assert.equal(setup.service.info().lastCapture.status, 'error');
  assert.equal(notified, false); assert.equal(setup.service.activeCount(), 0);
});

test('committed imports stay successful when notification callbacks or optional snapshot diagnostics fail', async t => {
  const setup = await fixture(t, { onImported: () => { throw new Error('Renderer closed after saving'); } });
  const first = (await setup.capture(image())).body;
  assert.equal(first.ok, true); assert.equal(first.imported, 1);
  assert.equal(setup.library.snapshot().stats.active, 1);
  assert.equal(setup.service.info().lastCapture.status, 'complete');
  const withoutSnapshot = await fixture(t, { library: { importPaths: async () => ({ imported: 1, duplicates: 0, errors: [], assetIds: ['saved'] }),
    snapshot: () => { throw new Error('Renderer diagnostics unavailable'); } } });
  const second = (await withoutSnapshot.capture(image())).body;
  assert.equal(second.ok, true); assert.equal(second.imported, 1);
  assert.equal(second.libraryRoot, null);
});

test('download falls back from an unreachable IPv6 address to the validated IPv4 address', async t => {
  const server = await sourceServer(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(PNG); });
  const setup = await fixture(t, { allowPrivate: true });
  const originalLookup = dns.lookup;
  dns.lookup = async (host, options) => host === 'family.example.test'
    ? [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }] : originalLookup(host, options);
  t.after(() => { dns.lookup = originalLookup; });
  const result = (await setup.capture({ kind: 'image', url: `http://family.example.test:${server.port}/image.png` })).body;
  assert.equal(result.ok, true); assert.equal(result.imported, 1);
});

test('direct downloads still reject any private DNS address and private redirect targets before connecting', async t => {
  const setup = await fixture(t);
  const originalLookup = dns.lookup, originalGet = http.get;
  let requests = 0;
  dns.lookup = async host => host === 'mixed.example.test'
    ? [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]
    : [{ address: '93.184.216.34', family: 4 }];
  http.get = (_url, _options, callback) => {
    requests++;
    const request = new EventEmitter();
    process.nextTick(() => callback({ statusCode: 302, headers: { location: 'http://127.0.0.1/private.png' }, resume() {} }));
    return request;
  };
  t.after(() => { dns.lookup = originalLookup; http.get = originalGet; });
  const mixed = (await setup.capture({ kind: 'image', url: 'http://mixed.example.test/image.png' })).body;
  assert.equal(mixed.ok, false); assert.match(mixed.error, /内网/); assert.equal(requests, 0);
  const redirected = (await setup.capture({ kind: 'image', url: 'http://public.example.test/image.png' })).body;
  assert.equal(redirected.ok, false); assert.match(redirected.error, /内网/); assert.equal(requests, 1);
  assert.equal(setup.library.snapshot().stats.total, 0);
});

test('connect and ping report the actual configured application version while request authentication remains enforced', async t => {
  const setup = await fixture(t, { appVersion: '7.8.9' });
  const connected = await setup.request('/v1/connect', {}, { headers: { 'X-Shitu-Extension': EXTENSION } });
  assert.equal(connected.body.version, '7.8.9');
  assert.equal(connected.body.captureProgress, true);
  const ping = (await setup.request('/v1/ping', {})).body;
  assert.equal(ping.version, '7.8.9');
  assert.equal(ping.captureProgress, true);
  const wrongToken = await setup.capture(image(), { headers: { 'X-Shitu-Token': '0'.repeat(64) } });
  assert.equal(wrongToken.status, 401); assert.equal(setup.service.info().lastCapture, null);
  const wrongOrigin = await setup.capture(image(), { headers: { Origin: 'https://untrusted.example.test' } });
  assert.equal(wrongOrigin.status, 403); assert.equal(setup.service.info().lastCapture, null);
});

test('progress reports actual bytes from an active capture and never exposes another capture or its source', async t => {
  const prefix = PNG.subarray(0, 16);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const source = await sourceServer(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    response.write(prefix);
    void gate.then(() => response.end(PNG.subarray(prefix.length)));
  });
  const setup = await fixture(t, { allowPrivate: true });
  const requestId = '1710000000000-1';
  const check = id => setup.request('/v1/capture-progress', { requestId: id });
  assert.deepEqual((await check(requestId)).body, { ok: true, progress: null });
  assert.equal((await check('bad-id')).status, 400);
  assert.equal((await setup.request('/v1/capture-progress', { requestId },
    { headers: { 'X-Shitu-Token': '0'.repeat(64) } })).status, 401);
  const payload = { kind: 'image', url: source.url + '/image.png?signature=private-fixture', requestId };
  const pending = setup.capture(payload, { signal: AbortSignal.timeout(5000) });
  let current;
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      current = (await check(requestId)).body.progress;
      if (current?.receivedBytes === prefix.length) break;
      await delay(10);
    }
    assert.deepEqual(current, { phase: 'downloading', at: current.at, receivedBytes: prefix.length, totalBytes: PNG.length });
    assert.equal((await check('1710000000000-2')).body.progress, null);
    assert.equal((await setup.capture(payload)).body.code, 'CAPTURE_PENDING');
    assert.equal(setup.library.snapshot().stats.total, 0);
  } finally { release(); }
  assert.equal((await pending).body.imported, 1);
  const complete = (await check(requestId)).body.progress;
  assert.deepEqual(complete, { phase: 'complete', at: complete.at, receivedBytes: PNG.length, totalBytes: PNG.length });
});

test('web captures use the chosen nested folder and locate the exact saved or duplicate asset', async t => {
  const located = [];
  const setup = await fixture(t, { onLocate: result => located.push(result) });
  const parentId = (await setup.library.createFolder('项目')).folders[0].id;
  const folderId = (await setup.library.createFolder('视频参考', parentId)).folders[1].id;
  const ping = (await setup.request('/v1/ping', {})).body;
  const list = (await setup.request('/v1/folders', {})).body;
  assert.match(list.libraryId, /^[a-f0-9]{64}$/);
  assert.equal(list.libraryId, ping.libraryId);
  assert.deepEqual(list.folders.map(folder => [folder.id, folder.parentId]), [[parentId, null], [folderId, parentId]]);
  assert.ok(!JSON.stringify(list).includes(setup.library.root));
  const captured = (await setup.capture(image({ destination: { libraryId: list.libraryId, folderId } }))).body;
  assert.equal(captured.ok, true);
  assert.equal(captured.folderId, folderId);
  assert.equal(captured.folderName, '视频参考');
  const [assetId] = captured.assetIds;
  assert.equal(setup.library.snapshot().assets[0].folderId, folderId);
  const duplicate = (await setup.capture(image({ destination: { libraryId: list.libraryId, folderId: null } }))).body;
  assert.equal(duplicate.existingAssets[0].folderId, folderId);
  assert.equal(duplicate.existingAssets[0].id, assetId);
  assert.equal(duplicate.libraryId, list.libraryId);
  await setup.library.setTrash([assetId], true);
  assert.equal((await setup.request('/v1/locate', { libraryId: list.libraryId, assetId })).body.ok, true);
  assert.deepEqual(located, [{ libraryRoot: setup.library.root, assetIds: [assetId] }]);
});

test('a stale library or folder never silently sends a web capture to unclassified', async t => {
  let calls = 0;
  const setup = await fixture(t, { onLocate: () => calls++ });
  const { libraryId } = (await setup.request('/v1/folders', {})).body;
  const [{ id: folderId }] = (await setup.library.createFolder('将删除')).folders;
  await setup.library.deleteFolder(folderId);
  const stale = (await setup.capture(image({ destination: { libraryId, folderId } }))).body;
  assert.equal(stale.code, 'CAPTURE_FOLDER_MISSING');
  const otherLibrary = '0'.repeat(64);
  const switched = (await setup.capture(image({ destination: { libraryId: otherLibrary, folderId: null } }))).body;
  assert.equal(switched.code, 'CAPTURE_LIBRARY_CHANGED');
  assert.equal(setup.library.snapshot().stats.total, 0);
  assert.equal((await setup.request('/v1/locate', { libraryId: otherLibrary, assetId: 'fixture' })).status, 409);
  assert.equal((await setup.request('/v1/locate', { libraryId, assetId: 'fixture' })).status, 404);
  assert.equal((await setup.request('/v1/folders', {}, { headers: { 'X-Shitu-Token': '0'.repeat(64) } })).status, 401);
  assert.equal(calls, 0);
});

test('capture readiness and malformed JSON failures appear in local diagnostics without losing their HTTP error', async t => {
  const setup = await fixture(t, { isReady: () => false });
  const response = await setup.capture(image());
  assert.equal(response.status, 409); assert.equal(response.body.ok, false);
  assert.equal(setup.service.info().lastCapture.status, 'error'); assert.match(setup.service.info().lastCapture.error, /素材库/);
  const malformed = await setup.request('/v1/capture', '{');
  assert.equal(malformed.status, 400); assert.match(setup.service.info().lastCapture.error, /格式/);
});

test('importing state stays visible during library work and ends only after the library confirms persistence', async t => {
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const setup = await fixture(t, { library: { importPaths: async () => { entered(); await gate; return { imported: 1, duplicates: 0, errors: [], assetIds: ['saved'] }; } } });
  t.after(() => release());
  const requestId = '1710000000000-3';
  const pending = setup.capture(image({ requestId }));
  await enteredPromise;
  assert.equal(setup.service.info().lastCapture.status, 'importing'); assert.equal(setup.service.activeCount(), 1);
  const importing = (await setup.request('/v1/capture-progress', { requestId })).body.progress;
  assert.deepEqual(importing, { phase: 'importing', at: importing.at, receivedBytes: PNG.length, totalBytes: PNG.length });
  release(); const result = (await pending).body;
  assert.equal(result.ok, true); assert.equal(setup.service.info().lastCapture.status, 'complete'); assert.equal(setup.service.activeCount(), 0);
});

test('download failures and timeouts become explicit errors without a saved asset or a stuck active capture', async t => {
  const denied = await sourceServer(t, (_request, response) => { response.writeHead(403); response.end('Denied'); });
  const setup = await fixture(t, { allowPrivate: true, timeout: 30 });
  const failure = (await setup.capture({ kind: 'image', url: denied.url + '/image.png' })).body;
  assert.equal(failure.ok, false); assert.match(failure.error, /403/); assert.equal(setup.service.info().lastCapture.status, 'error');
  const slow = await sourceServer(t, () => {});
  const requestId = '1710000000000-4';
  const timedOut = (await setup.capture({ kind: 'image', url: slow.url + '/image.png', requestId })).body;
  assert.equal(timedOut.ok, false); assert.match(timedOut.error, /超时/);
  assert.equal(setup.service.activeCount(), 0); assert.equal(setup.library.snapshot().stats.total, 0);
  const failed = (await setup.request('/v1/capture-progress', { requestId })).body.progress;
  assert.deepEqual(failed, { phase: 'error', at: failed.at, receivedBytes: 0 });
});

test('browser retries keep their authorization signal while unsupported streams allow only a selected-page fallback', async t => {
  const server = await sourceServer(t, (request, response) => {
    if (request.url === '/session.mp4') response.writeHead(403).end('Sign in');
    else if (request.url === '/login.mp4') response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Sign in</html>');
    else response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U');
  });
  const setup = await fixture(t, { allowPrivate: true });
  const denied = await setup.capture({ kind: 'video', url: server.url + '/session.mp4' });
  assert.equal(denied.body.code, 'VIDEO_BROWSER_READ');
  const html = await setup.capture({ kind: 'video', url: server.url + '/login.mp4' });
  assert.equal(html.body.code, 'VIDEO_BROWSER_READ');
  const playlist = await setup.capture({ kind: 'video', url: server.url + '/playlist' });
  assert.equal(playlist.body.ok, false);
  assert.equal(playlist.body.code, 'VIDEO_SOURCE_FAILED');
  const imageResult = await setup.capture({ kind: 'image', url: server.url + '/session.mp4' });
  assert.equal(imageResult.body.code, undefined);
  assert.equal(setup.library.snapshot().stats.total, 0);
});

test('browser relay endpoints retain authentication and expire incomplete captures without importing bytes', async t => {
  const setup = await fixture(t, { playbackTimeout: 50 });
  assert.equal((await setup.request('/v1/ping', {})).body.vimeoBrowserRead, true);
  const requestId = '1700000000000-901';
  for (const route of ['/v1/capture-browser-read', '/v1/capture-browser-data', '/v1/capture-browser-cancel']) {
    assert.equal((await setup.request(route, { requestId }, { headers: { 'X-Shitu-Token': '0'.repeat(64) } })).status, 401);
    assert.equal((await setup.request(route, { requestId }, { headers: { Origin: 'https://unrelated.example' } })).status, 403);
    assert.equal((await setup.request(route, { requestId: 'invalid' })).status, 400);
  }
  assert.deepEqual((await setup.request('/v1/capture-browser-read', { requestId })).body, { ok: true, read: null, done: false });
  assert.equal((await setup.request('/v1/capture-browser-data', { requestId, readId: 'absent', sequence: 0, done: true })).status, 400);
  for (const body of [image({ browserRead: true, requestId }),
    { kind: 'video', url: 'https://capture-test.vimeocdn.com/video.mp4', browserRead: true, requestId },
    { kind: 'video', url: 'https://capture-test.vimeocdn.com/video.mp4', playback: 'file', pageUrl: 'https://vimeo.com/123', browserRead: true }]) {
    const result = (await setup.capture(body)).body;
    assert.equal(result.ok, false);
    assert.match(result.error, /浏览器视频读取请求无效/);
  }
  const expired = (await setup.capture({ kind: 'video', url: 'https://capture-test.vimeocdn.com/video.mp4',
    playback: 'file', pageUrl: 'https://vimeo.com/123', browserRead: true, requestId })).body;
  assert.equal(expired.ok, false);
  assert.match(expired.error, /超时/);
  assert.equal(setup.service.activeCount(), 0);
  assert.equal(setup.library.snapshot().stats.total, 0);
  assert.deepEqual((await setup.request('/v1/capture-browser-read', { requestId })).body, { ok: true, read: null, done: true });
});

test('browser cancellation stops waiting reads and muxing but cannot cancel native or committed imports', async t => {
  const setup = await fixture(t, { playbackTimeout: 5000, timeout: 100, allowPrivate: true });
  const input = requestId => ({ requestId, kind: 'video', playback: 'file', browserRead: true,
    pageUrl: 'https://vimeo.com/123', url: 'https://capture-test.vimeocdn.com/video.mp4' });
  const waitForRead = async (target, requestId) => {
    for (let i = 0; i < 100; i++) {
      const value = (await target.request('/v1/capture-browser-read', { requestId })).body.read;
      if (value) return value;
      await delay(5);
    }
    assert.fail('expected a pending browser read');
  };
  const sendRead = async (target, requestId, bytes) => {
    const read = await waitForRead(target, requestId);
    for (const [sequence, fields] of [
      { head: { status: 200, url: read.url, contentType: 'application/octet-stream', contentLength: bytes.length } },
      { dataBase64: bytes.toString('base64') }, { done: true }
    ].entries()) {
      const response = await target.request('/v1/capture-browser-data', { requestId, readId: read.readId, sequence, ...fields });
      assert.equal(response.body.ok, true, response.body.error);
    }
  };
  const requestId = '1700000000000-902';
  const pending = setup.capture(input(requestId));
  await waitForRead(setup, requestId);
  assert.equal((await setup.request('/v1/capture-browser-cancel', { requestId })).body.cancelled, true);
  assert.equal((await pending).body.code, 'CAPTURE_CANCELLED');
  assert.equal(setup.service.activeCount(), 0);
  assert.equal(setup.library.snapshot().stats.total, 0);
  assert.equal((await setup.request('/v1/capture-browser-cancel', { requestId })).body.cancelled, false);
  assert.equal((await setup.request('/v1/capture-browser-cancel', { requestId: '1700000000000-999' })).body.cancelled, false);

  const nativeSource = await sourceServer(t, () => {});
  const nativeId = '1700000000000-903';
  const native = setup.capture({ kind: 'video', url: nativeSource.url + '/video.mp4', requestId: nativeId });
  await delay(5);
  assert.equal((await setup.request('/v1/capture-browser-cancel', { requestId: nativeId })).body.cancelled, false);
  assert.notEqual((await native).body.code, 'CAPTURE_CANCELLED');

  let enteredMux;
  const muxEntered = new Promise(resolve => { enteredMux = resolve; });
  const muxSetup = await fixture(t, { playbackTimeout: 5000, muxVimeoPlayback: async (_media, _output, { signal }) => {
    enteredMux();
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  const muxId = '1700000000000-904';
  const muxCapture = muxSetup.capture({ ...input(muxId), playback: 'hls', url: 'https://capture-test.vimeocdn.com/video.m3u8' });
  await sendRead(muxSetup, muxId, Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n'));
  const segment = Buffer.alloc(377); segment[0] = segment[188] = segment[376] = 0x47;
  await sendRead(muxSetup, muxId, segment);
  await muxEntered;
  assert.equal((await muxSetup.request('/v1/capture-browser-cancel', { requestId: muxId })).body.cancelled, true);
  assert.equal((await muxCapture).body.code, 'CAPTURE_CANCELLED');

  let importing, releaseImport;
  const importEntered = new Promise(resolve => { importing = resolve; });
  const importGate = new Promise(resolve => { releaseImport = resolve; });
  t.after(() => releaseImport());
  const importSetup = await fixture(t, { library: { root: 'fake-library', importPaths: async () => {
    importing(); await importGate; return { imported: 1, duplicates: 0, errors: [], assetIds: ['saved'] };
  }, snapshot: () => ({ assets: [] }) } });
  const importId = '1700000000000-905';
  const committed = importSetup.capture(input(importId));
  const mp4 = Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom'), 0, 0, 0, 0]);
  await sendRead(importSetup, importId, mp4);
  await importEntered;
  assert.equal((await importSetup.request('/v1/capture-browser-cancel', { requestId: importId })).body.cancelled, false);
  releaseImport();
  assert.equal((await committed).body.ok, true);
});
