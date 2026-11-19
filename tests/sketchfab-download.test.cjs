'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { deflateRawSync } = require('node:zlib');
const { stageSketchfabModel, checkedSketchfabPage, checkedSketchfabArchiveUrl } = require('../src/sketchfab-download.cjs');
const { Library } = require('../src/library.cjs');

const modelId = '0123456789abcdef0123456789abcdef';
const pageUrl = `https://sketchfab.com/3d-models/test-model-${modelId}`;
const archiveUrl = `https://sketchfab-prod-media.s3.amazonaws.com/archives/${modelId}/gltf/example.zip?Signature=fixture-secret`;
const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) result = table[(result ^ byte) & 0xff] ^ result >>> 8;
  return (result ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName || entry.name);
    const bytes = Buffer.from(entry.data || ''), method = entry.method ?? (entry.name.endsWith('/') ? 0 : 8);
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const flags = entry.flags ?? 0x800, crc = entry.crc ?? crc32(bytes), uncompressed = entry.uncompressed ?? bytes.length;
    const extra = entry.extra || Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    if (!(flags & 8)) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(uncompressed, 22); }
    header.writeUInt16LE(localName.length, 26); header.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(flags & 8 ? 16 : 0);
    if (descriptor.length) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(uncompressed, 12); }
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(3 << 8 | 20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(flags, 8); index.writeUInt16LE(method, 10);
    index.writeUInt32LE(crc, 16); index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(uncompressed, 24); index.writeUInt16LE(name.length, 28); index.writeUInt16LE(extra.length, 30);
    index.writeUInt32LE(entry.attrs ?? ((entry.name.endsWith('/') ? 0o40755 : 0o100644) << 16) >>> 0, 38); index.writeUInt32LE(offset, 42);
    local.push(header, localName, extra, compressed, descriptor); central.push(index, name, extra);
    offset += header.length + localName.length + extra.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function modelEntries(extra = []) {
  return [
    { name: 'source/scene.gltf', data: JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: '../scene.bin', byteLength: 4 }], images: [{ uri: '../textures/base.png' }] }) },
    { name: 'scene.bin', data: Buffer.from([1, 2, 3, 4]), method: 0 },
    { name: 'textures/base.png', data: 'fixed image bytes', flags: 0x808 },
    { name: 'license.txt', data: 'CC BY 4.0, credit Fixture Author' },
    ...extra
  ];
}
async function fixture(t) {
  const parent = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'sketchfab-archive-'));
  t.after(async () => { assert.equal(path.dirname(directory), parent); await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function stage(directory, entries = modelEntries(), options = {}) {
  return stageSketchfabModel({ modelId, pageUrl, archiveUrl, directory,
    downloadArchive: async ({ destination }) => fs.writeFile(destination, Buffer.isBuffer(entries) ? entries : zip(entries)), ...options });
}

test('model archives bind HTTPS host, format and model identity on every redirect', () => {
  assert.equal(checkedSketchfabArchiveUrl(modelId, archiveUrl).hostname, 'sketchfab-prod-media.s3.amazonaws.com');
  assert.equal(checkedSketchfabPage(modelId, pageUrl + '?tracking=ignored#viewer'), pageUrl);
  for (const url of [archiveUrl.replace('https:', 'http:'), archiveUrl.replace('sketchfab-prod-media', 'other'),
    archiveUrl.replace(modelId, 'f'.repeat(32)), archiveUrl.replace('/gltf/', '/original/'),
    archiveUrl.replace('example.zip', '../example.zip'), archiveUrl.replace('example.zip', '%2fexample.zip'),
    archiveUrl.replace('.com/', '.com:444/'), archiveUrl.replace('https://', 'https://user:pass@'), archiveUrl + '#x']) {
    assert.throws(() => checkedSketchfabArchiveUrl(modelId, url), { code: 'SKETCHFAB_SOURCE_INVALID' });
  }
  assert.throws(() => checkedSketchfabPage(modelId, pageUrl.replace(modelId, 'f'.repeat(32))), { code: 'SKETCHFAB_SOURCE_INVALID' });
});

test('archive failures and mismatched public provenance never expose signed URLs or create a package', async t => {
  const directory = await fixture(t);
  await assert.rejects(stage(directory, modelEntries(), { downloadArchive: async () => { throw new Error(archiveUrl); } }),
    error => error.code === 'SKETCHFAB_DOWNLOAD_FAILED' && !error.message.includes('Signature') && !error.message.includes('fixture-secret'));
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(stage(directory, modelEntries(), { attribution: { sourceUrl: pageUrl.replace(modelId, 'f'.repeat(32)) } }), { code: 'SKETCHFAB_SOURCE_INVALID' });
  await assert.rejects(stage(directory, modelEntries(), { attribution: { author: { url: 'https://sketchfab.com/author?token=secret' } } }), { code: 'SKETCHFAB_SOURCE_INVALID' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('safe ZIP staging preserves nested buffers, textures, licenses and deterministic public attribution', async t => {
  const directory = await fixture(t), calls = [], progress = [];
  const result = await stage(directory, modelEntries([{ name: 'source/readme.txt', data: 'source note' }]), {
    attribution: { title: 'Fixture Model', author: { name: 'Fixture Author', url: 'https://sketchfab.com/fixture' },
      license: { name: 'CC BY', url: 'https://creativecommons.org/licenses/by/4.0/' },
      token: 'must-never-persist', archiveUrl, capturedAt: Date.now() },
    onProgress: value => progress.push(value.phase),
    downloadArchive: async options => {
      calls.push(options); assert.equal(options.validateUrl(archiveUrl), archiveUrl);
      await fs.writeFile(options.destination, zip(modelEntries([{ name: 'source/readme.txt', data: 'source note' }])));
      return { url: archiveUrl };
    }
  });
  assert.equal(result.modelId, modelId); assert.equal(result.pageUrl, pageUrl);
  assert.deepEqual(result.files, ['license.txt', 'scene.bin', 'sketchfab-attribution.json', 'source/readme.txt', 'source/scene.gltf', 'textures/base.png']);
  assert.deepEqual(await fs.readFile(path.join(result.root, 'scene.bin')), Buffer.from([1, 2, 3, 4]));
  assert.equal(await fs.readFile(path.join(result.root, 'license.txt'), 'utf8'), 'CC BY 4.0, credit Fixture Author');
  const metadata = await fs.readFile(path.join(result.root, 'sketchfab-attribution.json'), 'utf8');
  assert.equal(metadata.includes('fixture-secret'), false); assert.equal(metadata.includes('must-never-persist'), false);
  assert.equal(metadata.includes('capturedAt'), false); assert.equal(metadata.includes('archiveUrl'), false);
  assert.deepEqual(JSON.parse(metadata), result.attribution);
  await assert.rejects(fs.access(calls[0].destination), { code: 'ENOENT' });
  assert.ok(progress.includes('extracting') && progress.includes('verifying'));
});

test('models import as one complete package and duplicate receipts identify the existing asset', async t => {
  const directory = await fixture(t), result = await stage(directory);
  let thumbnailOptions;
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (_file, destination, options) => {
    thumbnailOptions = options; await fs.writeFile(destination, 'fixed thumbnail fixture'); return { width: 4, height: 4 };
  } }); await library.init();
  const report = await library.importModelPackage({ ...result, metadata: { name: 'Saved model', sourceUrl: pageUrl, pageUrl } });
  assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
  const asset = library.snapshot().assets[0];
  assert.equal(asset.name, 'Saved model'); assert.equal(asset.mediaType, 'model'); assert.equal(asset.modelBundle.entry, 'source/scene.gltf');
  assert.deepEqual(asset.modelBundle.files.map(file => file.path).sort(), result.files);
  assert.equal(thumbnailOptions.modelBundle.entry, 'source/scene.gltf');
  assert.ok(thumbnailOptions.modelBundle.files.some(file => file.path === 'license.txt'));
  const duplicate = await library.importModelPackage({ ...result, metadata: { name: 'Saved model', sourceUrl: pageUrl, pageUrl } });
  assert.equal(duplicate.imported, 0); assert.equal(duplicate.duplicates, 1);
  assert.deepEqual(duplicate.existingAssets, [{ id: asset.id, name: asset.name, trashedAt: null, folderId: null }]);
  assert.equal(await fs.readFile(library.getModelFilePath(asset.id, 'license.txt'), 'utf8'), 'CC BY 4.0, credit Fixture Author');
  await library.updateAssets([asset.id], { notes: 'reviewed' }, { recordHistory: true });
  await library.undo(); assert.equal(library.snapshot().assets[0].notes, '');
  await library.redo(); assert.equal(library.snapshot().assets[0].notes, 'reviewed');
  const exported = await library.exportAssets([asset.id], path.join(directory, 'exported'));
  assert.equal(exported.exported, 1);
  assert.equal(await fs.readFile(path.join(exported.files[0], 'license.txt'), 'utf8'), 'CC BY 4.0, credit Fixture Author');
  assert.deepEqual(await fs.readFile(path.join(exported.files[0], 'sketchfab-attribution.json')), await fs.readFile(path.join(result.root, 'sketchfab-attribution.json')));
});

test('failed package index publication removes managed copies and leaves the staged original intact', async t => {
  const directory = await fixture(t), result = await stage(directory);
  const library = new Library({ root: path.join(directory, 'library') }); await library.init();
  library._persist = async () => { throw new Error('fixed publication failure'); };
  await assert.rejects(library.importModelPackage(result), /fixed publication failure/);
  assert.equal(library.snapshot().assets.length, 0);
  assert.deepEqual(await fs.readdir(path.join(library.root, 'originals')), []);
  assert.equal(await fs.readFile(path.join(result.root, 'license.txt'), 'utf8'), 'CC BY 4.0, credit Fixture Author');
});

test('ZIP traversal, path collisions, links, encryption and header inconsistencies fail before import', async t => {
  const invalidEntries = [
    { name: '../escape.txt', data: 'bad' }, { name: '/absolute.txt', data: 'bad' }, { name: 'C:/escape.txt', data: 'bad' },
    { name: 'folder\\escape.txt', data: 'bad' }, { name: 'nul.txt', data: 'bad' }, { name: 'trailing./file.txt', data: 'bad' },
    { name: 'textures/BASE.png', data: 'collision' }, { name: 'source', data: 'file parent conflict' },
    { name: 'link', data: '../outside', attrs: (0o120777 << 16) >>> 0 },
    { name: 'encrypted', data: 'bad', flags: 0x801 },
    { name: 'different', localName: 'different2', data: 'bad' },
    { name: 'link-extra', data: 'bad', extra: Buffer.from([0x0d, 0, 0, 0]) },
    { name: 'sketchfab-attribution.json', data: '{}' }
  ];
  for (const entry of invalidEntries) await t.test(entry.name, async t => {
    const directory = await fixture(t);
    await assert.rejects(stage(directory, modelEntries([entry])), error => /^SKETCHFAB_/.test(error.code));
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test('corruption, declared and actual zip bombs, and entry count are bounded and cleaned', async t => {
  for (const scenario of [
    { entries: modelEntries([{ name: 'bad-crc.txt', data: 'data', crc: 1 }]) },
    { entries: modelEntries([{ name: 'bomb.txt', data: 'x'.repeat(1024 * 1024), uncompressed: 1 }]) },
    { entries: modelEntries(), limits: { compressedBytes: 100 } },
    { entries: modelEntries(), limits: { expandedBytes: 100 } },
    { entries: modelEntries(), limits: { files: 3 } },
    { entries: Buffer.from('not a zip file') }
  ]) await t.test(JSON.stringify(scenario.limits || { entries: scenario.entries.length }), async t => {
    const directory = await fixture(t);
    await assert.rejects(stage(directory, scenario.entries, { limits: scenario.limits }), error => /^SKETCHFAB_/.test(error.code));
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test('multi-disk, ZIP64 sentinel, truncated central directories and unsupported compression are rejected', async t => {
  const multiDisk = zip(modelEntries()); multiDisk.writeUInt16LE(1, multiDisk.length - 18);
  const zip64 = zip(modelEntries()); zip64.writeUInt16LE(0xffff, zip64.length - 12);
  const truncated = zip(modelEntries()).subarray(0, -10);
  const unsupported = zip(modelEntries([{ name: 'unsupported.bin', data: 'fixture', method: 12 }]));
  for (const bytes of [multiDisk, zip64, truncated, unsupported]) {
    const directory = await fixture(t);
    await assert.rejects(stage(directory, bytes), error => /^SKETCHFAB_/.test(error.code));
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('missing or ambiguous models and missing dependencies never enter the library', async t => {
  for (const entries of [
    [{ name: 'license.txt', data: 'no model' }],
    modelEntries([{ name: 'second.gltf', data: '{"asset":{"version":"2.0"}}' }]),
    [{ name: 'scene.gltf', data: '{"asset":{"version":"2.0"},"buffers":[{"uri":"missing.bin","byteLength":4}]}' }]
  ]) await t.test(String(entries.length), async t => {
    const directory = await fixture(t);
    await assert.rejects(stage(directory, entries), error => /^SKETCHFAB_/.test(error.code));
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test('redirect host changes and cancellation cannot leave a partially staged package', async t => {
  const directory = await fixture(t);
  await assert.rejects(stage(directory, modelEntries(), { downloadArchive: async options => {
    options.validateUrl('https://127.0.0.1/private.zip');
  } }), { code: 'SKETCHFAB_SOURCE_INVALID' });
  assert.deepEqual(await fs.readdir(directory), []);
  const controller = new AbortController();
  await assert.rejects(stage(directory, modelEntries(), { signal: controller.signal, downloadArchive: async options => {
    await fs.writeFile(options.destination, zip(modelEntries())); controller.abort();
  } }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('package imports reject traversing lists and undeclared references without copying unrelated files', async t => {
  const directory = await fixture(t), result = await stage(directory), library = new Library({ root: path.join(directory, 'library') }); await library.init();
  assert.throws(() => library.importModelPackage({ ...result, files: [...result.files, '../outside.txt'] }));
  const report = await library.importModelPackage({ ...result, files: result.files.filter(file => file !== 'scene.bin') });
  assert.equal(report.imported, 0); assert.ok(report.errors.length); assert.equal(library.snapshot().assets.length, 0);
  const outside = path.join(directory, 'outside'); await fs.writeFile(outside, 'do not read');
  await fs.unlink(path.join(result.root, 'license.txt'));
  try { await fs.symlink(outside, path.join(result.root, 'license.txt')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  const linked = await library.importModelPackage(result);
  assert.equal(linked.imported, 0); assert.ok(linked.errors.length);
});
