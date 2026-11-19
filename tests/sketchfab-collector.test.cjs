'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const dns = require('node:dns/promises');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Library } = require('../src/library.cjs');
const { createCollector } = require('../src/collector.cjs');
const { createModelFixtures } = require('../scripts/model-test-fixtures.cjs');

const ID = '0123456789abcdef0123456789abcdef';
const PAGE = `https://sketchfab.com/3d-models/${ID}`;
const ARCHIVE = `https://sketchfab-prod-media.s3.amazonaws.com/archives/${ID}/gltf/model.zip?signature=not-for-metadata`;
const MODEL = { kind: 'model', sourceType: 'sketchfab', modelId: ID, url: PAGE, pageUrl: PAGE, name: 'Selected model' };
const attribution = { title: 'Official model name', author: { name: 'Creator', url: 'https://sketchfab.com/creator' },
  license: { name: 'CC Attribution', slug: 'by', url: 'https://creativecommons.org/licenses/by/4.0/' } };
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const chunks = [], entries = []; let offset = 0;
  for (const [filename, body] of files) {
    const name = Buffer.from(filename), bytes = Buffer.from(body), crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(local, name, bytes); entries.push(central, name); offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(entries), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-sketchfab-test-'));
  const library = new Library({ root: path.join(directory, 'library') });
  await library.init();
  const collector = createCollector({ library, configPath: path.join(directory, 'collector.json'), port: 0, ...options });
  await collector.start();
  const token = collector.info().code.split('.')[2];
  const request = async (route, body) => {
    const response = await fetch(collector.info().baseUrl + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shitu-Token': token }, body: JSON.stringify(body) });
    return response.json();
  };
  t.after(async () => { await collector.close(); assert.ok(path.basename(directory).startsWith('mosaic-sketchfab-test-')); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, library, collector, request, capture: body => request('/v1/capture', { ...MODEL, ...body }) };
}
function mockCdn(t, respond, address = '203.0.113.30') {
  const oldGet = https.get, oldLookup = dns.lookup, requests = [];
  dns.lookup = async (hostname, options) => hostname === 'sketchfab-prod-media.s3.amazonaws.com'
    ? [{ address, family: 4 }] : oldLookup(hostname, options);
  https.get = (url, options, done) => {
    requests.push(url.href);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    const request = new EventEmitter();
    queueMicrotask(() => {
      const answer = respond(url), response = Readable.from([answer.body || Buffer.alloc(0)]);
      response.statusCode = answer.status || 200;
      response.headers = answer.headers || { 'content-length': answer.body.length, 'content-type': 'application/zip' };
      done(response);
    });
    return request;
  };
  t.after(() => { https.get = oldGet; dns.lookup = oldLookup; });
  return requests;
}

test('Sketchfab capability requires a configured model resolver', async t => {
  const setup = await fixture(t);
  assert.equal((await setup.request('/v1/ping', {})).sketchfabDownload, undefined);
  const result = await setup.capture({});
  assert.equal(result.ok, false); assert.equal(result.code, 'SKETCHFAB_UNAVAILABLE');
});

test('browser-download capability requires explicit mode plus both resolver and package importer', async t => {
  const legacy = await fixture(t, { resolveSketchfabModel: async () => ({}) });
  assert.equal((await legacy.request('/v1/ping', {})).sketchfabBrowserDownload, undefined);
  const absent = await fixture(t, { sketchfabBrowserDownload: true });
  assert.equal((await absent.request('/v1/ping', {})).sketchfabBrowserDownload, undefined);
  const enabled = await fixture(t, { sketchfabBrowserDownload: true, resolveSketchfabModel: async () => ({}) });
  const status = await enabled.request('/v1/ping', {});
  assert.equal(status.sketchfabDownload, true); assert.equal(status.sketchfabBrowserDownload, true);
  const noImporter = await fixture(t, { sketchfabBrowserDownload: true, resolveSketchfabModel: async () => ({}),
    library: { root: 'unavailable', listFolders: () => [], snapshot: () => ({}) } });
  assert.equal((await noImporter.request('/v1/ping', {})).sketchfabBrowserDownload, undefined);
});

test('browser model download imports without a user Token and persists only verified public metadata', async t => {
  const calls = [];
  const setup = await fixture(t, { sketchfabBrowserDownload: true, resolveSketchfabModel: async options => {
    calls.push(options);
    assert.deepEqual(Object.keys(options).sort(), ['archiveUrl', 'modelId', 'signal']);
    assert.equal(options.modelId, ID); assert.equal(options.archiveUrl, ARCHIVE);
    assert.ok(options.signal instanceof AbortSignal);
    return { attribution };
  } });
  const fixtures = path.join(setup.directory, 'fixtures'); await createModelFixtures(fixtures);
  const entries = await Promise.all(['triangle.gltf', 'mesh.bin', 'textures/green.png'].map(async name => [name, await fs.readFile(path.join(fixtures, 'gltf', name))]));
  entries.push(['license.txt', Buffer.from('Public model license')]);
  const archive = zip(entries), requests = mockCdn(t, () => ({ body: archive }));
  const result = await setup.capture({ archiveUrl: ARCHIVE, requestId: '12345-11' });
  assert.equal(result.ok, true, result.error); assert.equal(result.imported, 1);
  const asset = setup.library.snapshot().assets[0], bundle = setup.library.getModelBundleDirectory(asset.id);
  assert.equal(asset.sourceUrl, PAGE); assert.equal(asset.name, attribution.title);
  assert.equal(await fs.readFile(path.join(bundle, 'license.txt'), 'utf8'), 'Public model license');
  const index = await fs.readFile(setup.library.indexPath, 'utf8');
  const savedAttribution = await fs.readFile(path.join(bundle, 'sketchfab-attribution.json'), 'utf8');
  for (const serialized of [index, savedAttribution, JSON.stringify(result), JSON.stringify(setup.collector.info())]) {
    assert.equal(serialized.includes('not-for-metadata'), false);
    assert.equal(serialized.includes('archiveUrl'), false);
  }
  const duplicate = await setup.capture({ archiveUrl: ARCHIVE, requestId: '12345-12' });
  assert.equal(duplicate.duplicates, 1); assert.equal(duplicate.existingAssets[0].id, asset.id);
  assert.equal(calls.length, 2); assert.equal(requests.length, 2);
});

test('browser mode requires a fresh archive URL and rejects mixed identity or page-supplied metadata before resolving', async t => {
  let calls = 0;
  const setup = await fixture(t, { sketchfabBrowserDownload: true, resolveSketchfabModel: async () => { calls++; return { attribution }; } });
  const missing = await setup.capture({});
  assert.equal(missing.code, 'SKETCHFAB_BROWSER_DOWNLOAD_REQUIRED');
  assert.match(missing.error, /刷新.*Sketchfab.*Alt.*Chrome/); assert.equal(/Token|令牌/.test(missing.error), false);
  for (const extra of [
    { archiveUrl: ARCHIVE.replace(ID, 'a'.repeat(32)) },
    { archiveUrl: ARCHIVE.replace('sketchfab-prod-media.s3.amazonaws.com', 'evil.example') },
    { archiveUrl: ARCHIVE.replace('https:', 'http:') },
    { archiveUrl: ARCHIVE, pageUrl: PAGE.replace(ID, 'a'.repeat(32)) },
    { archiveUrl: ARCHIVE, modelId: 'a'.repeat(32) },
    { archiveUrl: ARCHIVE, attribution }, { archiveUrl: ARCHIVE, token: 'forged' },
    { archiveUrl: ARCHIVE, headers: { Cookie: 'forged' } }, { archiveUrl: ARCHIVE, youtubeSession: {} }
  ]) {
    const result = await setup.capture(extra);
    assert.equal(result.code, 'SKETCHFAB_SOURCE_INVALID'); assert.equal(result.ok, false);
    assert.equal(result.error.includes('not-for-metadata'), false);
  }
  assert.equal(calls, 0); assert.equal(setup.library.snapshot().assets.length, 0);
});

test('browser public-metadata permission failures never fall back to legacy account or download', async t => {
  let calls = 0;
  const setup = await fixture(t, { sketchfabBrowserDownload: true, resolveSketchfabModel: async options => {
    calls++; assert.equal(options.archiveUrl, ARCHIVE);
    throw Object.assign(new Error('Sketchfab 未授权下载当前模型。'), { code: 'SKETCHFAB_NOT_DOWNLOADABLE' });
  } });
  const requests = mockCdn(t, () => { throw new Error('must not download'); });
  const result = await setup.capture({ archiveUrl: ARCHIVE });
  assert.equal(result.code, 'SKETCHFAB_NOT_DOWNLOADABLE'); assert.match(result.error, /未授权/);
  assert.equal(calls, 1); assert.equal(requests.length, 0); assert.equal(setup.library.snapshot().assets.length, 0);
});

test('resolver exceptions cannot place a signed archive URL in errors, receipts or progress records', async t => {
  for (const code of [undefined, 'SKETCHFAB_METADATA_FAILED']) await t.test(String(code), async t => {
    const setup = await fixture(t, { sketchfabBrowserDownload: true, resolveSketchfabModel: async () => {
      throw Object.assign(new Error(`failed ${ARCHIVE}`), code ? { code } : {});
    } });
    const result = await setup.capture({ archiveUrl: ARCHIVE });
    assert.equal(result.ok, false); assert.equal(result.code, code || 'SKETCHFAB_DOWNLOAD_FAILED');
    assert.equal(JSON.stringify([result, setup.collector.info()]).includes('not-for-metadata'), false);
  });
});

test('Sketchfab imports one self-contained model with textures, license and attribution; repeated capture locates it', async t => {
  const setup = await fixture(t, { resolveSketchfabModel: async ({ modelId }) => {
    assert.equal(modelId, ID); return { archiveUrl: ARCHIVE, attribution };
  } });
  assert.equal((await setup.request('/v1/ping', {})).sketchfabDownload, true);
  const fixtures = path.join(setup.directory, 'fixtures');
  await createModelFixtures(fixtures);
  const entries = await Promise.all(['triangle.gltf', 'mesh.bin', 'textures/green.png'].map(async filename => [filename, await fs.readFile(path.join(fixtures, 'gltf', filename))]));
  entries.push(['license.txt', Buffer.from('Creative Commons Attribution 4.0. Creator credit required.')]);
  const archive = zip(entries), requests = mockCdn(t, () => ({ body: archive }));
  const result = await setup.capture({ requestId: '12345-1' });
  assert.equal(result.ok, true, result.error); assert.equal(result.imported, 1); assert.equal(result.duplicates, 0);
  const asset = setup.library.snapshot().assets.find(item => item.id === result.assetIds[0]);
  assert.equal(asset.ext, 'gltf'); assert.ok(asset.modelBundle); assert.equal(asset.name, attribution.title);
  assert.equal(asset.sourceUrl, PAGE); assert.equal(asset.pageUrl, PAGE);
  const bundle = setup.library.getModelBundleDirectory(asset.id);
  assert.deepEqual(await fs.readFile(path.join(bundle, 'mesh.bin')), entries[1][1]);
  assert.match(await fs.readFile(path.join(bundle, 'license.txt'), 'utf8'), /Creator credit/);
  const savedAttribution = JSON.parse(await fs.readFile(path.join(bundle, 'sketchfab-attribution.json'), 'utf8'));
  assert.equal(savedAttribution.author.name, 'Creator'); assert.equal(savedAttribution.license.slug, 'by');
  const index = await fs.readFile(path.join(setup.library.root, 'index.json'), 'utf8');
  assert.ok(!index.includes('not-for-metadata')); assert.ok(!JSON.stringify(savedAttribution).includes('signature'));
  const duplicate = await setup.capture({ requestId: '12345-2' });
  assert.equal(duplicate.ok, true, duplicate.error); assert.equal(duplicate.imported, 0); assert.equal(duplicate.duplicates, 1);
  assert.equal(duplicate.existingAssets[0].id, asset.id); assert.equal(requests.length, 2);
  assert.equal(setup.library.snapshot().assets.length, 1);
});

test('Sketchfab rejects page-provided download credentials or mismatched model identity before API access', async t => {
  let calls = 0;
  const setup = await fixture(t, { resolveSketchfabModel: async () => { calls++; return { archiveUrl: ARCHIVE, attribution }; } });
  for (const extra of [{ archiveUrl: ARCHIVE }, { youtubeSession: {} }, { token: 'secret' }, { dataBase64: 'YWJj' },
    { pageUrl: 'https://evil.example/model' }, { modelId: 'a'.repeat(32) }]) {
    const result = await setup.capture(extra);
    assert.equal(result.ok, false); assert.equal(result.code, 'SKETCHFAB_SOURCE_INVALID');
  }
  assert.equal(calls, 0); assert.equal(setup.library.snapshot().assets.length, 0);
});

test('Sketchfab validates every CDN redirect before opening a private destination', async t => {
  const setup = await fixture(t, { allowPrivate: true, resolveSketchfabModel: async () => ({ archiveUrl: ARCHIVE, attribution }) });
  const requests = mockCdn(t, () => ({ status: 302, headers: { location: 'http://127.0.0.1/private.zip' } }));
  const result = await setup.capture({});
  assert.equal(result.ok, false); assert.equal(requests.length, 1); assert.equal(setup.library.snapshot().assets.length, 0);
});

test('Sketchfab DNS may not resolve to a private address even when ordinary test downloads allow private hosts', async t => {
  const setup = await fixture(t, { allowPrivate: true, resolveSketchfabModel: async () => ({ archiveUrl: ARCHIVE, attribution }) });
  const requests = mockCdn(t, () => { throw new Error('Network access must be blocked'); }, '127.0.0.1');
  const result = await setup.capture({});
  assert.equal(result.ok, false); assert.equal(requests.length, 0); assert.equal(setup.library.snapshot().assets.length, 0);
});

test('Sketchfab missing account errors preserve the actionable code without downloading or importing', async t => {
  const setup = await fixture(t, { resolveSketchfabModel: async () => { throw Object.assign(new Error('请先连接 Sketchfab。'), { code: 'SKETCHFAB_ACCOUNT_REQUIRED' }); } });
  const requests = mockCdn(t, () => { throw new Error('Unexpected download'); });
  const result = await setup.capture({});
  assert.equal(result.ok, false); assert.equal(result.code, 'SKETCHFAB_ACCOUNT_REQUIRED'); assert.equal(requests.length, 0);
});
