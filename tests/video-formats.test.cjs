'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Library, SUPPORTED, VIDEO } = require('../src/library.cjs');
const { identify } = require('../src/collector.cjs');
const { mediaResponse } = require('../src/media-response.cjs');

test('video containers are accepted consistently and sent with media MIME types', async () => {
  for (const extension of ['dxv','mov','avi','mkv','mp4','webm','wmv','asf','mpg','mpeg','mts','m2ts','ts','vob','flv','mxf','3gp','rmvb','dv']) {
    assert.ok(VIDEO.has(extension), extension);
    assert.ok(SUPPORTED.has(extension), extension);
  }
  assert.deepEqual(identify(Buffer.from('RIFFxxxxAVI xxxxxxxxx')), { ext: 'avi', kind: 'video' });
  assert.deepEqual(identify(Buffer.concat([Buffer.from([0,0,0,20]), Buffer.from('moovxxxxxxxx')])), { ext: 'mov', kind: 'video' });
  assert.deepEqual(identify(Buffer.from([0,0,1,186,0,0,0,0])), { ext: 'mpg', kind: 'video' });
  assert.deepEqual(identify(Buffer.from('FLVxxxxxxxx')), { ext: 'flv', kind: 'video' });
  const directory = await fs.mkdtemp(path.join(await testRoot(), 'mime-'));
  try {
    const filename = path.join(directory, 'clip.mkv');
    await fs.writeFile(filename, 'video');
    const response = await mediaResponse(filename, new Request('https://example.test/clip'));
    assert.equal(response.headers.get('content-type'), 'video/x-matroska');
    assert.equal(await response.text(), 'video');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

async function testRoot() {
  const root = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(root, { recursive: true });
  return root;
}

test('video metadata and thumbnails survive import, reopen and lazy repair', async () => {
  const directory = await fs.mkdtemp(path.join(await testRoot(), 'video-library-'));
  try {
    const source = path.join(directory, 'sample.dxv');
    const original = Buffer.from('fake encoded video only used to test library persistence');
    await fs.writeFile(source, original);
    let calls = 0;
    const createThumbnail = async (_source, target) => {
      calls++;
      await fs.writeFile(target, 'fixture JPEG');
      return { width: 1920, height: 1080, duration: 3.25, codec: 'dxv', hasAlpha: true, hasAudio: false,
        pixelFormat: 'rgba', audioCodec: '', streamIndex: 2, colorSpace: 'ycgco', rotation: -90 };
    };
    const library = new Library({ root: path.join(directory, 'library'), createThumbnail });
    await library.init();
    const imported = await library.importPaths([source]);
    assert.equal(imported.imported, 1);
    let asset = library.snapshot().assets[0];
    assert.equal(asset.mediaType, 'video');
    assert.equal(asset.codec, 'dxv');
    assert.equal(asset.duration, 3.25);
    assert.equal(asset.hasAlpha, true);
    assert.equal(asset.width, 1920);
    const previewMetadata = { pixelFormat: 'rgba', audioCodec: '', streamIndex: 2, colorSpace: 'ycgco', rotation: -90 };
    for (const [key, value] of Object.entries(previewMetadata)) assert.equal(asset[key], value, key);
    const reopened = new Library({ root: library.root, createThumbnail });
    await reopened.init();
    asset = reopened.snapshot().assets[0];
    assert.equal(asset.codec, 'dxv');
    for (const [key, value] of Object.entries(previewMetadata)) assert.equal(asset[key], value, key);
    assert.equal((await reopened.refreshVideoMetadata([asset.id])).updated, 0);
    assert.equal(calls, 1);
    const legacy = JSON.parse(await fs.readFile(reopened.indexPath, 'utf8'));
    delete legacy.assets[0].codec;
    delete legacy.assets[0].duration;
    for (const key of Object.keys(previewMetadata)) delete legacy.assets[0][key];
    legacy.assets[0].thumbnail = null;
    await fs.writeFile(reopened.indexPath, JSON.stringify(legacy));
    const oldLibrary = new Library({ root: library.root, createThumbnail });
    await oldLibrary.init();
    const repaired = await oldLibrary.refreshVideoMetadata([asset.id]);
    assert.equal(repaired.updated, 1);
    assert.equal(repaired.snapshot.assets[0].codec, 'dxv');
    for (const [key, value] of Object.entries(previewMetadata)) assert.equal(repaired.snapshot.assets[0][key], value, key);
    assert.equal(calls, 2);
    assert.deepEqual(await fs.readFile(source), original);
    assert.deepEqual(await fs.readFile(oldLibrary.getAssetPath(asset.id)), original);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('video preview metadata stays optional for legacy libraries and absent from images', async () => {
  const directory = await fs.mkdtemp(path.join(await testRoot(), 'preview-metadata-'));
  try {
    const video = path.join(directory, 'legacy.mp4'), image = path.join(directory, 'image.png');
    await fs.writeFile(video, 'legacy video'); await fs.writeFile(image, 'image fixture');
    const metadata = { width: 640, height: 360, pixelFormat: 'yuv420p', audioCodec: 'aac', streamIndex: 0, colorSpace: '', rotation: 0 };
    const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (_source, target) => {
      await fs.writeFile(target, 'thumbnail'); return metadata;
    } });
    await library.init();
    const imported = await library.importPaths([video, image]);
    assert.equal(imported.imported, 2);
    const videoAsset = library.snapshot().assets.find(asset => asset.ext === 'mp4');
    const imageAsset = library.snapshot().assets.find(asset => asset.ext === 'png');
    for (const key of ['pixelFormat', 'audioCodec', 'streamIndex', 'colorSpace', 'rotation']) {
      assert.equal(videoAsset[key], metadata[key]);
      assert.equal(Object.hasOwn(imageAsset, key), false, key);
    }
    const legacy = JSON.parse(await fs.readFile(library.indexPath, 'utf8'));
    for (const key of ['pixelFormat', 'audioCodec', 'streamIndex', 'colorSpace', 'rotation']) delete legacy.assets.find(asset => asset.ext === 'mp4')[key];
    await fs.writeFile(library.indexPath, JSON.stringify(legacy));
    const reopened = new Library({ root: library.root });
    await reopened.init();
    assert.equal(reopened.snapshot().assets.length, 2);
    assert.equal(Object.hasOwn(reopened.snapshot().assets.find(asset => asset.ext === 'mp4'), 'pixelFormat'), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('video preview metadata rejects malformed values without copying arbitrary probe fields', async () => {
  const directory = await fs.mkdtemp(path.join(await testRoot(), 'preview-validation-'));
  try {
    const source = path.join(directory, 'sample.mov'); await fs.writeFile(source, 'video fixture');
    const invalid = { pixelFormat: '../rgba', audioCodec: 'aac\n', streamIndex: 1.5, colorSpace: 'x'.repeat(81), rotation: Infinity };
    const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (_source, target) => {
      await fs.writeFile(target, 'thumbnail'); return { width: 640, height: 360, codec: 'h264', ...invalid, path: 'private path', sourceUrl: 'not probe metadata' };
    } });
    await library.init(); await library.importPaths([source]);
    const asset = library.snapshot().assets[0];
    for (const key of [...Object.keys(invalid), 'path', 'sourceUrl']) assert.equal(Object.hasOwn(asset, key), false, key);
    const validIndex = await fs.readFile(library.indexPath, 'utf8');
    for (const [key, value] of Object.entries({ ...invalid, rotation: 361, streamIndex: -1 })) {
      const index = JSON.parse(validIndex); index.assets[0][key] = value;
      await fs.writeFile(library.indexPath, JSON.stringify(index));
      await assert.rejects(new Library({ root: library.root }).init(), /视频预览信息无效/, key);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('cancelled legacy thumbnail repair releases the library mutation queue', async () => {
  const directory = await fs.mkdtemp(path.join(await testRoot(), 'cancel-video-'));
  try {
    const source = path.join(directory, 'sample.avi');
    await fs.writeFile(source, 'test video identity');
    const library = new Library({ root: path.join(directory, 'library') });
    await library.init();
    const { assetIds: [id] } = await library.importPaths([source]);
    let signalSeen, start;
    const started = new Promise(resolve => { start = resolve; });
    library.createThumbnail = async (_source, _destination, { signal }) => {
      signalSeen = signal;
      start();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const controller = new AbortController();
    const repair = library.refreshVideoMetadata([id], { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(repair, error => error.name === 'AbortError');
    assert.equal(signalSeen, controller.signal);
    const snapshot = await library.createFolder('repair cancellation retained responsiveness');
    assert.equal(snapshot.folders.length, 1);
    assert.equal(snapshot.assets[0].thumbnail, null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
