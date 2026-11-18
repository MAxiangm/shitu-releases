'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const dns = require('node:dns/promises');
const { EventEmitter } = require('node:events');
const { Library } = require('../src/library.cjs');
const { createCollector } = require('../src/collector.cjs');

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
  assert.equal((await setup.request('/v1/ping', {})).body.version, '7.8.9');
  const wrongToken = await setup.capture(image(), { headers: { 'X-Shitu-Token': '0'.repeat(64) } });
  assert.equal(wrongToken.status, 401); assert.equal(setup.service.info().lastCapture, null);
  const wrongOrigin = await setup.capture(image(), { headers: { Origin: 'https://untrusted.example.test' } });
  assert.equal(wrongOrigin.status, 403); assert.equal(setup.service.info().lastCapture, null);
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
  const pending = setup.capture(image());
  await enteredPromise;
  assert.equal(setup.service.info().lastCapture.status, 'importing'); assert.equal(setup.service.activeCount(), 1);
  release(); const result = (await pending).body;
  assert.equal(result.ok, true); assert.equal(setup.service.info().lastCapture.status, 'complete'); assert.equal(setup.service.activeCount(), 0);
});

test('download failures and timeouts become explicit errors without a saved asset or a stuck active capture', async t => {
  const denied = await sourceServer(t, (_request, response) => { response.writeHead(403); response.end('Denied'); });
  const setup = await fixture(t, { allowPrivate: true, timeout: 30 });
  const failure = (await setup.capture({ kind: 'image', url: denied.url + '/image.png' })).body;
  assert.equal(failure.ok, false); assert.match(failure.error, /403/); assert.equal(setup.service.info().lastCapture.status, 'error');
  const slow = await sourceServer(t, () => {});
  const timedOut = (await setup.capture({ kind: 'image', url: slow.url + '/image.png' })).body;
  assert.equal(timedOut.ok, false); assert.match(timedOut.error, /超时/);
  assert.equal(setup.service.activeCount(), 0); assert.equal(setup.library.snapshot().stats.total, 0);
});

test('the web video retry signal is reserved for browser-readable authorization failures', async t => {
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
  assert.equal(playlist.body.code, undefined);
  const imageResult = await setup.capture({ kind: 'image', url: server.url + '/session.mp4' });
  assert.equal(imageResult.body.code, undefined);
  assert.equal(setup.library.snapshot().stats.total, 0);
});
