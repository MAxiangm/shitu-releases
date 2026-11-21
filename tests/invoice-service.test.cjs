'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { createInvoiceService } = require('../src/invoice-service.cjs');

async function fixture(t, overrides = {}) {
  const parent = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const base = await fs.mkdtemp(path.join(parent, 'invoice-service-'));
  const source = path.join(base, '发票.png');
  await sharp({ create: { width: 160, height: 90, channels: 3, background: '#ffffff' } }).png().toFile(source);
  let files = [source], save, dialogOptions, currentLibrary = null;
  const events = [];
  const service = createInvoiceService({ rootDir: path.join(base, 'work'), getLibrary: () => currentLibrary,
    chooseFiles: async () => ({ canceled: !files, filePaths: files }),
    chooseSavePath: async options => { dialogOptions = options; return save || { canceled: true }; },
    ocrEngine: { status: async () => ({ ready: true, languages: [] }), recognize: async () => ({ text: '价税合计（小写）￥123.45' }) },
    onEvent: event => events.push(event), revealFile: async () => {}, ...overrides });
  t.after(async () => { await service.shutdown(); const relative = path.relative(parent, base); assert.ok(relative && !relative.startsWith('..')); await fs.rm(base, { recursive: true, force: true }); });
  async function done(id) { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const event = events.find(e => e.jobId === id && ['error', 'complete'].includes(e.type)); if (event) return event; await new Promise(r => setTimeout(r, 10)); } throw new Error('invoice job timed out'); }
  async function run(items, mode, options = {}) { return service.run({ mode, itemIds: items.map(item => item.id), options }); }
  const options = items => ({ confirmed: true, imagesPerPage: 2, orientation: 'portrait', items: items.map((item, index) => ({ id: item.id, amount: index ? '0.20' : '0.10' })) });
  return { base, source, service, done, run, options, events, files: value => { files = value; }, save: value => { save = value; }, dialog: () => dialogOptions, library: value => { currentLibrary = value; } };
}

test('invoice image staging preserves originals, deduplicates bytes and recognizes VAT total', async t => {
  const f = await fixture(t); const before = await fs.readFile(f.source);
  const added = await f.service.chooseFiles(); assert.equal(added.errors.length, 0); assert.equal(added.items.length, 1);
  const duplicate = await f.service.chooseFiles(); assert.equal(duplicate.items[0].id, added.items[0].id); assert.equal(duplicate.items[0].duplicate, true);
  const event = await f.done((await f.run(added.items, 'recognize')).jobId);
  assert.equal(event.results[0].amount, '123.45'); assert.equal(event.results[0].sourceId, added.items[0].id);
  assert.deepEqual(await fs.readFile(f.source), before);
});

test('invoice manual amounts use exact cents and default name contains invoice count and total', async t => {
  const f = await fixture(t); const second = path.join(f.base, 'second.png');
  await sharp({ create: { width: 90, height: 160, channels: 3, background: '#3366ff' } }).png().toFile(second);
  f.files([f.source, second]); const { items } = await f.service.chooseFiles();
  f.save({ filePath: path.join(f.base, '2张_合计0.30元.pdf') });
  const event = await f.done((await f.run(items, 'export', f.options(items))).jobId);
  assert.equal(event.type, 'complete'); assert.equal(event.results[0].totalAmount, '0.30'); assert.equal(event.results[0].pages, 1);
  assert.equal(event.results[0].invoiceCount, 2); assert.equal(f.dialog().defaultPath, '2张_合计0.30元.pdf');
  assert.match((await fs.readFile(event.results[0].path)).subarray(0, 8).toString(), /%PDF-1.4/);
});

test('invoice export rejects unchecked, invalid, duplicate or mismatched amounts before opening dialog', async t => {
  const f = await fixture(t); const { items } = await f.service.chooseFiles(); const options = f.options(items);
  await assert.rejects(f.run(items, 'export', { ...options, confirmed: false }), /核对/);
  await assert.rejects(f.run(items, 'export', { ...options, items: [{ id: items[0].id, amount: '-2' }] }), /金额/);
  await assert.rejects(f.run(items, 'export', { ...options, items: [{ id: items[0].id, amount: '1.999' }] }), /金额/);
  await assert.rejects(f.run(items, 'export', { ...options, items: [{ id: 'other', amount: '1.00' }] }), /顺序/);
  await assert.rejects(f.run([items[0], items[0]], 'export', options), /重复/);
  assert.equal(f.dialog(), undefined);
});

test('PDF pages each count as one invoice and use embedded text without installed OCR', async t => {
  let ocrCalls = 0;
  const f = await fixture(t, { ocrEngine: { status: async () => ({ ready: false }), recognize: async () => { ocrCalls++; throw Error('not expected'); } },
    pdfReader: { convert: async ({ outputDir }) => {
      const result = [];
      for (let i = 0; i < 3; i++) { const file = path.join(outputDir, `page${i}.png`); await sharp({ create: { width: 50, height: 30, channels: 3, background: i ? '#ff0000' : '#00ff00' } }).png().toFile(file); result.push({ path: file, text: `价税合计（小写）¥${i + 1}.25`, width: 50, height: 30, pageNumber: i + 1 }); }
      return result;
    } } });
  const pdf = path.join(f.base, '发票.pdf'); await fs.writeFile(pdf, '%PDF fixture'); f.files([pdf]);
  const { items } = await f.service.chooseFiles(); assert.equal(items.length, 3); assert.match(items[2].name, /第 3 页/);
  const event = await f.done((await f.run(items, 'recognize')).jobId);
  assert.equal(ocrCalls, 0); assert.deepEqual(event.results.map(item => item.amount), ['1.25', '2.25', '3.25']);
});

test('invoice save cancellation makes no job and original/library destinations are rejected', async t => {
  const f = await fixture(t); const pdf = path.join(f.base, 'source.pdf'); await fs.writeFile(pdf, '%PDF stub');
  const { items } = await f.service.chooseFiles();
  assert.deepEqual(await f.run(items, 'export', f.options(items)), { cancelled: true }); assert.equal(f.service.busy(), false);
  const library = path.join(f.base, 'library'); await fs.mkdir(library); f.library({ root: library });
  f.save({ filePath: path.join(library, 'bad.pdf') }); await assert.rejects(f.run(items, 'export', f.options(items)), /素材库/);
});

test('cancelled invoice export preserves an existing output and clears incomplete work', async t => {
  let entered; const started = new Promise(r => { entered = r; });
  const f = await fixture(t, { writePdf: async ({ outputPath, signal }) => { await fs.writeFile(outputPath, 'partial'); entered(); await new Promise((r, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' })), { once: true })); } });
  const { items } = await f.service.chooseFiles(); const output = path.join(f.base, 'existing.pdf'); await fs.writeFile(output, 'keep'); f.save({ filePath: output });
  const { jobId } = await f.run(items, 'export', f.options(items)); await started; await f.service.cancel(jobId);
  const event = await f.done(jobId); assert.equal(event.cancelled, true); assert.equal(await fs.readFile(output, 'utf8'), 'keep');
});

test('bad input is reported per file while valid invoices remain usable', async t => {
  const f = await fixture(t); const bad = path.join(f.base, 'bad.pdf'); await fs.writeFile(bad, 'bad'); f.files([bad, f.source]);
  const result = await f.service.chooseFiles(); assert.equal(result.items.length, 1); assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /PDF/);
});

test('removed invoices release staged records and can be added again', async t => {
  const f = await fixture(t); const first = (await f.service.chooseFiles()).items[0];
  const preview = await f.service.preview(first.id); assert.match(preview.url, /^data:image\/jpeg;base64,/);
  await f.service.removeItems([first.id]); await assert.rejects(f.service.preview(first.id), /失效/);
  const second = (await f.service.chooseFiles()).items[0]; assert.notEqual(second.id, first.id);
});

test('a locked temporary preview cannot leave removed invoices stuck in the duplicate index', async t => {
  const f = await fixture(t), first = (await f.service.chooseFiles()).items[0];
  const original = await fs.readFile(f.source), remove = fs.rm;
  fs.rm = async (filename, options) => {
    if (path.resolve(String(filename)).startsWith(path.join(f.base, 'work') + path.sep)) throw Object.assign(new Error('temporary preview is locked'), { code: 'EBUSY' });
    return remove(filename, options);
  };
  try {
    assert.deepEqual(await f.service.removeItems([first.id]), { removed: true });
    await assert.rejects(f.service.preview(first.id), /失效/);
    const added = await f.service.chooseFiles();
    assert.deepEqual(added.errors, []); assert.equal(added.items.length, 1); assert.notEqual(added.items[0].id, first.id);
    assert.deepEqual(await fs.readFile(f.source), original);
  } finally { fs.rm = remove; }
});

test('export cannot overwrite an unselected original PDF already added to the module', async t => {
  const f = await fixture(t, { pdfReader: { convert: async ({ outputDir }) => {
    const image = path.join(outputDir, 'pdf-page.png'); await sharp({ create: { width: 50, height: 30, channels: 3, background: '#ff0000' } }).png().toFile(image);
    return [{ path: image, text: '价税合计￥10.00', width: 50, height: 30, pageNumber: 1 }];
  } } });
  const pdf = path.join(f.base, 'original.pdf'); await fs.writeFile(pdf, '%PDF-original'); f.files([f.source, pdf]);
  const { items } = await f.service.chooseFiles(); f.save({ filePath: pdf });
  await assert.rejects(f.run([items[0]], 'export', f.options([items[0]])), /原件/);
  assert.equal(await fs.readFile(pdf, 'utf8'), '%PDF-original');
});

test('shutdown waits for preparing PDFs and never leaves a recreated staging directory', async t => {
  let start; const entered = new Promise(resolve => { start = resolve; });
  const f = await fixture(t, { pdfReader: { convert: async ({ signal }) => {
    start(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('stop'), { name: 'AbortError' })), { once: true }));
  } } });
  const pdf = path.join(f.base, 'wait.pdf'); await fs.writeFile(pdf, '%PDF-wait'); f.files([pdf]);
  const pending = f.service.chooseFiles(); const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await entered; await f.service.shutdown(); await rejected;
  assert.deepEqual(await fs.readdir(path.join(f.base, 'work')), []);
});

test('readding a partially removed PDF restores only missing pages without duplicate invoice rows', async t => {
  const f = await fixture(t, { pdfReader: { convert: async ({ outputDir }) => {
    const pages = [];
    for (let n = 1; n <= 2; n++) { const file = path.join(outputDir, `p${n}.png`); await sharp({ create: { width: 50, height: 30, channels: 3, background: '#fff' } }).png().toFile(file); pages.push({ path: file, pageNumber: n, width: 50, height: 30, text: '' }); }
    return pages;
  } } });
  const file = path.join(f.base, 'multi.pdf'); await fs.writeFile(file, '%PDF-multi'); f.files([file]);
  const first = (await f.service.chooseFiles()).items;
  await f.service.removeItems([first[0].id]);
  const again = (await f.service.chooseFiles()).items;
  assert.equal(again.length, 2); assert.notEqual(again[0].id, first[0].id); assert.equal(again[1].id, first[1].id);
});
