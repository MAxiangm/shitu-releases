'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { createReimbursementPreview, MAX_FILE_BYTES, MAX_EDGE } = require('../src/reimbursement-preview.cjs');

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-reimbursement-preview-'));
  const library = new Library({ root: path.join(base, 'library'), createThumbnail: async (_input, output) => {
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).jpeg().toFile(output); return {};
  } });
  await library.init();
  const created = await library.createReimbursementFolder('预览测试'), rootId = created.folderId;
  const categoryId = library.snapshot().folders.find(folder => folder.reimbursementRootId === rootId && folder.reimbursementCategory === 'travel').id;
  let owner = library;
  const opened = [], work = path.join(base, 'preview-work');
  const service = createReimbursementPreview({ rootDir: work, getLibrary: () => owner, openFile: async filename => { opened.push(filename); return ''; }, ...options });
  const request = (assetId, extra = {}) => ({ libraryRoot: library.root, folderId: rootId, assetId, ...extra });
  let serial = 0;
  async function add(bytes, extension = 'png', folderId = categoryId) {
    const filename = path.join(base, `source-${++serial}.${extension}`); await fs.writeFile(filename, bytes);
    const imported = await library.importPaths([filename], { folderId });
    assert.equal(imported.assetIds.length, 1);
    return imported.assetIds[0];
  }
  t.after(async () => { await service.shutdown(); await fs.rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  return { base, work, library, service, request, add, opened, rootId, categoryId, switchOwner: value => { owner = value; } };
}
const png = (color = '#ff0000', width = 80, height = 40) => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
const previewBytes = result => Buffer.from(result.url.split(',')[1], 'base64');
const pdfBytes = Buffer.from('%PDF-1.4\nsynthetic reader fixture');
async function expectEmptyCache(f) {
  const sessions = await fs.readdir(f.work).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const session of sessions) assert.deepEqual(await fs.readdir(path.join(f.work, session)), []);
}

test('image previews re-encode JPEG, fit 3500 pixels, flatten transparency and preserve source bytes', async t => {
  const f = await fixture(t), original = await png('#00000000', 4200, 1000), id = await f.add(original);
  const result = await f.service.preview(f.request(id));
  assert.equal(result.type, 'image'); assert.equal(result.ext, 'png'); assert.equal(result.pageNumber, 1); assert.equal(result.pageCount, 1);
  assert.match(result.url, /^data:image\/jpeg;base64,/);
  const decoded = sharp(previewBytes(result)), metadata = await decoded.metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, MAX_EDGE); assert.ok(metadata.height < MAX_EDGE);
  const raw = await decoded.raw().toBuffer(); assert.ok(raw[0] > 245 && raw[1] > 245 && raw[2] > 245);
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), original);
  await assert.rejects(f.service.preview(f.request(id, { pageNumber: 2 })), /只有一页/);
});

test('preview enforces the current nearest reimbursement root and rejects deleted or unrelated assets', async t => {
  const f = await fixture(t), outer = await f.add(await png());
  const nested = await f.library.createReimbursementFolder('内部报销', f.categoryId);
  const nestedCategory = f.library.snapshot().folders.find(folder => folder.reimbursementRootId === nested.folderId && folder.reimbursementCategory === 'travel').id;
  const inner = await f.add(await png('#0000ff'), 'png', nestedCategory);
  await assert.rejects(f.service.preview(f.request(inner)), /不属于/);
  assert.equal((await f.service.preview(f.request(inner, { folderId: nested.folderId }))).type, 'image');
  await f.library.setTrash([outer], true);
  await assert.rejects(f.service.preview(f.request(outer)), /删除/);
  await assert.rejects(f.service.preview(f.request('unknown')), /删除/);
  await assert.rejects(f.service.preview({ ...f.request(inner), libraryRoot: path.join(f.base, 'other') }), /素材库已切换/);
  await assert.rejects(f.service.preview({ ...f.request(inner), assetId: '../private' }), /有效/);
});

test('unsupported source formats return external and open only through the separately authorized action', async t => {
  const f = await fixture(t), id = await f.add(Buffer.from('synthetic workbook'), 'xlsx');
  const result = await f.service.preview(f.request(id));
  assert.equal(result.type, 'external'); assert.equal(result.ext, 'xlsx'); assert.equal(Object.hasOwn(result, 'url'), false); assert.deepEqual(f.opened, []);
  assert.deepEqual(await f.service.openSource(f.request(id)), { opened: true });
  assert.deepEqual(f.opened, [f.library.getAssetPath(id)]);
  await f.library.setTrash([id], true);
  await assert.rejects(f.service.openSource(f.request(id)), /删除/); assert.equal(f.opened.length, 1);
});

test('replaced or oversized originals are rejected before rendering or external opening', async t => {
  const f = await fixture(t), id = await f.add(await png());
  await fs.writeFile(f.library.getAssetPath(id), await png('#00ff00'));
  await assert.rejects(f.service.preview(f.request(id)), /原文件已变化/);
  await assert.rejects(f.service.openSource(f.request(id)), /原文件已变化/); assert.deepEqual(f.opened, []);
  await fs.truncate(f.library.getAssetPath(id), MAX_FILE_BYTES + 1);
  await assert.rejects(f.service.preview(f.request(id)), /64 MB/);
});

test('PDF previews select the requested page and reuse only the current verified document cache', async t => {
  let calls = 0;
  const f = await fixture(t, { pdfReader: { convert: async ({ outputDir }) => {
    calls++;
    const pages = [];
    for (const [index, color] of ['#ff0000', '#0000ff'].entries()) {
      const filename = path.join(outputDir, `page-${index + 1}.png`); await fs.writeFile(filename, await png(color)); pages.push({ path: filename, pageNumber: index + 1 });
    }
    return pages;
  } } });
  const id = await f.add(pdfBytes, 'pdf');
  const second = await f.service.preview(f.request(id, { pageNumber: 2 }));
  assert.equal(second.pageCount, 2); assert.equal(second.pageNumber, 2);
  const pixel = await sharp(previewBytes(second)).raw().toBuffer(); assert.ok(pixel[2] > 240 && pixel[0] < 15);
  const first = await f.service.preview(f.request(id)); assert.equal(first.pageNumber, 1); assert.equal(calls, 1);
  await assert.rejects(f.service.preview(f.request(id, { pageNumber: 3 })), /没有此页/);
  await expectEmptyCache(f);
});

test('generated PDFs in the reimbursement root are previewable without regeneration', async t => {
  let calls = 0;
  const f = await fixture(t, { pdfReader: { convert: async ({ outputDir }) => {
    calls++; const filename = path.join(outputDir, 'page.png'); await fs.writeFile(filename, await png()); return [{ path: filename }];
  } } });
  const source = path.join(f.base, 'generated.pdf'); await fs.writeFile(source, pdfBytes);
  const { assetId } = await f.library.upsertReimbursementDocument(f.rootId, 'invoicePdf', source, '生成发票');
  const before = f.library.snapshot();
  assert.equal((await f.service.preview(f.request(assetId))).name, '生成发票'); assert.equal(calls, 1);
  assert.deepEqual(f.library.snapshot(), before);
});

test('changes during PDF rendering never publish a stale preview', async t => {
  for (const mutation of ['trash', 'replace', 'switch']) await t.test(mutation, async child => {
    let f, id;
    f = await fixture(child, { pdfReader: { convert: async ({ outputDir }) => {
      const filename = path.join(outputDir, 'page.png'); await fs.writeFile(filename, await png());
      if (mutation === 'trash') await f.library.setTrash([id], true);
      if (mutation === 'replace') await fs.appendFile(f.library.getAssetPath(id), 'changed');
      if (mutation === 'switch') f.switchOwner(null);
      return [{ path: filename }];
    } } });
    id = await f.add(pdfBytes, 'pdf');
    await assert.rejects(f.service.preview(f.request(id)), /删除|变化|素材库已切换/);
    await expectEmptyCache(f);
  });
});

test('new previews cancel an in-flight PDF and clean staged files before rendering the next source', async t => {
  let entered, signal;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { pdfReader: { convert: async ({ signal: current }) => {
    signal = current; entered();
    return new Promise((_resolve, reject) => current.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
  } } });
  const pdf = await f.add(pdfBytes, 'pdf'), image = await f.add(await png());
  const pending = f.service.preview(f.request(pdf)); pending.catch(() => {});
  await started;
  const next = f.service.preview(f.request(image));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await next).type, 'image'); assert.equal(signal.aborted, true);
  await expectEmptyCache(f);
});

test('cancel and shutdown clean the current PDF cache and prevent later requests', async t => {
  let shutdowns = 0;
  const f = await fixture(t, { pdfReader: { convert: async ({ outputDir }) => {
    const filename = path.join(outputDir, 'page.png'); await fs.writeFile(filename, await png()); return [{ path: filename }];
  }, shutdown: async () => { shutdowns++; } } });
  const id = await f.add(pdfBytes, 'pdf'); await f.service.preview(f.request(id));
  assert.deepEqual(await f.service.cancel(), { cancelled: true }); await expectEmptyCache(f);
  await f.service.preview(f.request(id)); await f.service.shutdown();
  assert.deepEqual(await fs.readdir(f.work), []); assert.equal(shutdowns, 1);
  await assert.rejects(f.service.preview(f.request(id)), /已关闭/);
});

test('reader output outside its dedicated staging directory is rejected without deleting that file', async t => {
  let outside;
  const f = await fixture(t, { pdfReader: { convert: async () => [{ path: outside }] } });
  outside = path.join(f.base, 'unrelated.png'); const bytes = await png(); await fs.writeFile(outside, bytes);
  const id = await f.add(pdfBytes, 'pdf');
  await assert.rejects(f.service.preview(f.request(id)), /页面路径无效/);
  assert.deepEqual(await fs.readFile(outside), bytes); await expectEmptyCache(f);
});

test('a cached PDF cannot bypass original validation or serve a replaced cached page', async t => {
  let page;
  const f = await fixture(t, { pdfReader: { convert: async ({ outputDir }) => {
    page = path.join(outputDir, 'page.png'); await fs.writeFile(page, await png()); return [{ path: page }];
  } } });
  const id = await f.add(pdfBytes, 'pdf'); await f.service.preview(f.request(id));
  await fs.writeFile(page, await png('#0000ff'));
  await assert.rejects(f.service.preview(f.request(id)), /页面已变化/); await expectEmptyCache(f);
  await f.service.preview(f.request(id));
  await fs.appendFile(f.library.getAssetPath(id), 'changed');
  await assert.rejects(f.service.preview(f.request(id)), /原文件已变化/); await expectEmptyCache(f);
});

test('the same path and asset IDs in a newly opened library instance do not reuse the old PDF cache', async t => {
  let calls = 0;
  const f = await fixture(t, { pdfReader: { convert: async ({ outputDir }) => {
    calls++; const filename = path.join(outputDir, 'page.png'); await fs.writeFile(filename, await png()); return [{ path: filename }];
  } } });
  const id = await f.add(pdfBytes, 'pdf'); await f.service.preview(f.request(id));
  const reopened = new Library({ root: f.library.root }); await reopened.init(); f.switchOwner(reopened);
  await f.service.preview(f.request(id)); assert.equal(calls, 2);
});

test('pixel limits and out-of-library originals cannot be bypassed with a small encoded file', async t => {
  const f = await fixture(t);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10001" height="10000"><rect width="100%" height="100%" fill="red"/></svg>');
  const huge = await f.add(svg, 'svg');
  await assert.rejects(f.service.preview(f.request(huge)), /pixel|像素/i);
  const bytes = await png(), id = await f.add(bytes), outside = path.join(f.base, 'outside.png'); await fs.writeFile(outside, bytes);
  const original = f.library.getAssetPath.bind(f.library);
  f.library.getAssetPath = (assetId, kind) => assetId === id ? outside : original(assetId, kind);
  await assert.rejects(f.service.preview(f.request(id)), /不在当前素材库/);
  await assert.rejects(f.service.openSource(f.request(id)), /不在当前素材库/); assert.deepEqual(f.opened, []);
});
