'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { resolveAssetFiles } = require('../src/asset-actions.cjs');
const { DOCUMENT, SUPPORTED, MIME } = require('../src/media-formats.cjs');
const DocumentFormats = require('../src/document-formats.js');
const SmartFolders = require('../src/smart-folders.js');

const fixtureRoot = path.resolve(__dirname, '../.recovery/tests');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t, options = {}) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(fixtureRoot, 'document-library-'));
  t.after(async () => {
    const relative = path.relative(fixtureRoot, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const library = new Library({ root: path.join(base, 'library'), ...options });
  await library.init();
  async function source(name, content) {
    const filename = path.join(base, 'sources', name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const bytes = Buffer.from(content || `storage-only fixture: ${name}\n中文文档原件\0`);
    await fs.writeFile(filename, bytes);
    return { filename, bytes };
  }
  return { base, library, source };
}
async function neutralThumbnail(_input, output) {
  await sharp({ create: { width: 96, height: 120, channels: 3, background: '#333844' } }).jpeg().toFile(output);
  return { width: 96, height: 120, mediaType: 'image', codec: 'should-not-be-document-metadata' };
}

test('document formats have shared browser-safe labels, MIME types and supported extensions', async () => {
  assert.deepEqual([...DOCUMENT], ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf', 'odt', 'ods', 'odp']);
  for (const ext of DOCUMENT) { assert.ok(SUPPORTED.has(ext)); assert.equal(MIME[ext], DocumentFormats.mimeTypes[ext]); }
  assert.equal(MIME.pdf, 'application/pdf');
  assert.equal(MIME.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(DocumentFormats.has('.PDF'), true); assert.equal(DocumentFormats.has('exe'), false);
  const context = vm.createContext({});
  vm.runInContext(await fs.readFile(path.join(__dirname, '../src/document-formats.js'), 'utf8'), context);
  assert.equal(context.MosaicDocumentFormats.has('docx'), true);
  assert.equal(context.MosaicDocumentFormats.label('docx'), 'Word');
});

test('all document types import recursively as byte-preserved independent originals', async t => {
  const calls = [];
  const f = await fixture(t, { createThumbnail: async (input, output, options) => { calls.push(options); return neutralThumbnail(input, output); } });
  const sources = await Promise.all([...DOCUMENT].map(ext => f.source(`合同与发票.${ext.toUpperCase()}`)));
  const folder = (await f.library.createFolder('文档')).folders[0];
  const report = await f.library.importPaths([path.join(f.base, 'sources')], { folderId: folder.id });
  assert.equal(report.imported, DOCUMENT.size); assert.deepEqual(report.errors, []); assert.deepEqual(report.warnings, []);
  assert.equal(calls.length, DOCUMENT.size);
  assert.ok(calls.every(options => options.mediaType === 'document' && DOCUMENT.has(options.extension) && options.originalName === '合同与发票'));
  for (const asset of f.library.snapshot().assets) {
    const original = sources.find(item => path.extname(item.filename).slice(1).toLowerCase() === asset.ext);
    assert.equal(asset.mediaType, 'document'); assert.equal(asset.folderId, folder.id);
    assert.equal(asset.hash, hash(original.bytes)); assert.equal(asset.size, original.bytes.length);
    assert.equal(asset.width, 0); assert.equal(asset.height, 0); assert.equal(asset.codec, undefined);
    assert.equal(asset.filename, `originals/${asset.id}.${asset.ext}`);
    assert.deepEqual(await fs.readFile(f.library.getAssetPath(asset.id)), original.bytes);
    assert.equal((await sharp(f.library.getAssetPath(asset.id, 'thumbnail')).metadata()).format, 'jpeg');
  }
  assert.equal(f.library.snapshot().stats.total, DOCUMENT.size);
  const again = await f.library.importPaths(sources.map(item => item.filename));
  assert.equal(again.imported, 0); assert.equal(again.duplicates, DOCUMENT.size);
  const reopened = new Library({ root: f.library.root });
  assert.deepEqual((await reopened.init()).assets, f.library.snapshot().assets);
});

test('PDF, Word and text export, backup and trash retain the exact original bytes', async t => {
  const f = await fixture(t);
  const originals = await Promise.all(['发票.pdf', '合同.docx', '说明.txt'].map(name => f.source(name)));
  const imported = await f.library.importPaths(originals.map(item => item.filename));
  const ids = imported.assetIds;
  assert.equal(ids.length, 3);
  const exportResult = await f.library.exportAssets(ids, path.join(f.base, 'exports'));
  assert.equal(exportResult.exported, 3);
  for (const filename of exportResult.files) {
    const original = originals.find(item => path.extname(item.filename) === path.extname(filename));
    assert.deepEqual(await fs.readFile(filename), original.bytes);
  }
  const backup = await f.library.backupTo(path.join(f.base, 'backups'));
  const reopened = new Library({ root: backup.path }); await reopened.init();
  assert.equal(reopened.snapshot().assets.every(asset => asset.mediaType === 'document'), true);
  for (const id of ids) assert.deepEqual(await fs.readFile(reopened.getAssetPath(id)), await fs.readFile(f.library.getAssetPath(id)));
  await f.library.setTrash(ids, true);
  assert.equal(f.library.snapshot().stats.trashed, 3);
  assert.throws(() => resolveAssetFiles(f.library, ids, f.library.root), /回收站/);
  await f.library.setTrash(ids, false);
  assert.equal(resolveAssetFiles(f.library, ids, f.library.root).files.length, 3);
  await f.library.setTrash(ids, true); await f.library.deletePermanently(ids);
  assert.equal(f.library.snapshot().stats.total, 0);
  for (const original of originals) assert.deepEqual(await fs.readFile(original.filename), original.bytes);
});

test('document cover failures preserve originals and remove invalid JPEG placeholders', async t => {
  const f = await fixture(t, { createThumbnail: async (_input, output) => { await fs.writeFile(output, 'not an actual JPEG'); return { width: 20, height: 20 }; } });
  const original = await f.source('发票.pdf');
  const report = await f.library.importPaths([original.filename]);
  assert.equal(report.imported, 1); assert.deepEqual(report.errors, []);
  assert.equal(report.warnings.length, 1); assert.match(report.warnings[0].message, /文档已收录/);
  const asset = f.library.snapshot().assets[0];
  assert.equal(asset.thumbnail, null); assert.equal(asset.mediaType, 'document');
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(asset.id)), original.bytes);
  assert.deepEqual(await fs.readdir(path.join(f.library.root, 'thumbnails')), []);
});

test('document metadata edits preserve storage type and remain undoable', async t => {
  const f = await fixture(t);
  const original = await f.source('合同.docx');
  const { assetIds: [id] } = await f.library.importPaths([original.filename]);
  await f.library.updateAssets([id], { name: '已审合同', tags: ['合同'], rating: 4, notes: '文档备注' }, { recordHistory: true });
  const edited = f.library.snapshot().assets[0];
  assert.equal(edited.mediaType, 'document'); assert.equal(edited.name, '已审合同');
  assert.deepEqual(edited.tags, ['合同']);
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), original.bytes);
  const history = f.library.historyState();
  assert.equal(history.canUndo, true);
  await f.library.undo();
  assert.equal(f.library.snapshot().assets[0].name, '合同');
  assert.equal(f.library.snapshot().assets[0].mediaType, 'document');
});

test('document smart folders select documents separately from images and load in the browser', async () => {
  for (const ext of DOCUMENT) {
    assert.equal(SmartFolders.matches({ name: '文档', ext, tags: [] }, { mediaType: 'document' }), true);
    assert.equal(SmartFolders.matches({ name: '文档', ext, tags: [] }, { mediaType: 'image' }), false);
  }
  assert.equal(SmartFolders.describe({ mediaType: 'document' }), '文档');
  const context = vm.createContext({});
  for (const filename of ['color-labels.js', 'document-formats.js', 'smart-folders.js']) vm.runInContext(await fs.readFile(path.join(__dirname, '../src', filename), 'utf8'), context);
  assert.equal(context.ShituSmartFolders.mediaType({ ext: 'PDF' }), 'document');
  assert.equal(context.ShituSmartFolders.matches({ mediaType: 'document' }, { mediaType: 'document' }), true);
});

test('persisted document files cannot be reclassified as images', async t => {
  const f = await fixture(t);
  const original = await f.source('说明.txt');
  await f.library.importPaths([original.filename]);
  const stored = JSON.parse(await fs.readFile(f.library.indexPath, 'utf8'));
  stored.assets[0].mediaType = 'image';
  await fs.writeFile(f.library.indexPath, JSON.stringify(stored));
  await assert.rejects(new Library({ root: f.library.root }).init(), /媒体类型无效/);
});
