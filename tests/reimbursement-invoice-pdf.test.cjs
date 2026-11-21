'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const sharp = require('sharp');
const { writeImagePdf } = require('../src/image-pdf.cjs');
const { createReimbursementInvoicePdf } = require('../src/reimbursement-invoice-pdf.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'reimbursement-invoice-pdf-'));
  t.after(async () => {
    const relative = path.relative(parent, directory);
    assert.ok(relative.startsWith('reimbursement-invoice-pdf-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const image = async (name, red) => {
    const file = path.join(directory, name);
    await sharp({ create: { width: 60, height: 30, channels: 3, background: { r: red, g: 30, b: 60 } } }).png().toFile(file);
    return file;
  };
  const pdf = async name => { const file = path.join(directory, name); await fs.writeFile(file, '%PDF-1.4\nfixture'); return file; };
  const noWork = async () => assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('.reimbursement-invoices-')), []);
  return { directory, image, pdf, noWork, outputPath: path.join(directory, 'invoices.pdf') };
}

function imageSamples(pdf) {
  const source = pdf.toString('latin1'), start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(source)[1]);
  const lines = source.slice(start).split('\n'), count = Number(lines[1].split(' ')[1]), reds = [];
  for (let id = 1; id < count; id++) {
    const offset = Number(lines[id + 2].slice(0, 10)), end = id + 1 < count ? Number(lines[id + 3].slice(0, 10)) : start;
    const body = source.slice(offset, end), marker = body.indexOf('\nstream\n');
    if (!/\/Subtype \/Image\b/.test(body.slice(0, marker))) continue;
    const length = Number(/\/Length (\d+)/.exec(body)[1]);
    reds.push(zlib.inflateSync(pdf.subarray(offset + marker + 8, offset + marker + 8 + length))[0]);
  }
  return reds;
}

test('mixed images and PDF pages retain input order, render into A4 grids and clean temporary page images', async t => {
  const f = await fixture(t), first = await f.image('first.png', 10), document = await f.pdf('middle.pdf'), last = await f.image('last.png', 40);
  const before = await fs.readFile(first), progress = [], readerCalls = [];
  const reader = { convert: async request => {
    readerCalls.push(request);
    const pages = [];
    for (const [index, red] of [20, 30].entries()) {
      const filename = path.join(request.outputDir, `page-${index + 1}.png`);
      await sharp({ create: { width: 60, height: 30, channels: 3, background: { r: red, g: 30, b: 60 } } }).png().toFile(filename);
      pages.push({ path: filename, pageNumber: index + 1, width: 60, height: 30, text: '' });
      request.onProgress({ progress: (index + 1) / 2 });
    }
    return pages;
  } };
  const result = await createReimbursementInvoicePdf({ inputPaths: [first, document, last], outputPath: f.outputPath, imagesPerPage: 3, pdfReader: reader,
    pdfWriter: async request => {
      assert.deepEqual(request.options, { pageSize: 'a4', orientation: 'portrait', margin: 18, gap: 10, imagesPerPage: 3 });
      return writeImagePdf(request);
    }, onProgress: event => progress.push(event.progress) });
  assert.deepEqual(result, { pages: 2, invoiceCount: 4, sourceCount: 3 });
  const bytes = await fs.readFile(f.outputPath);
  assert.deepEqual(imageSamples(bytes), [10, 20, 30, 40]);
  assert.match(bytes.toString('latin1'), /\/Count 2\b/);
  assert.match(bytes.toString('latin1'), /\/MediaBox \[0 0 595.2756 841.8898\]/);
  assert.equal(readerCalls.length, 1); assert.equal(readerCalls[0].inputPath, document);
  assert.equal(progress.at(-1), 1); assert.ok(progress.every((value, index) => !index || value >= progress[index - 1]));
  assert.deepEqual(await fs.readFile(first), before);
  await assert.rejects(fs.access(readerCalls[0].outputDir), { code: 'ENOENT' });
  await f.noWork();
});

test('images-only merging does not require a PDF reader and defaults to two invoices per page', async t => {
  const f = await fixture(t), files = [await f.image('a.png', 50), await f.image('b.png', 60)];
  const result = await createReimbursementInvoicePdf({ inputPaths: files, outputPath: f.outputPath });
  assert.deepEqual(result, { pages: 1, invoiceCount: 2, sourceCount: 2 });
  assert.deepEqual(imageSamples(await fs.readFile(f.outputPath)), [50, 60]);
  await f.noWork();
});

test('validates inputs, types, page counts and preserves an existing output', async t => {
  const f = await fixture(t), file = await f.image('source.png', 70), document = await f.pdf('source.pdf');
  for (const inputPaths of [[], ['relative.png'], Array(257).fill(file)]) await assert.rejects(createReimbursementInvoicePdf({ inputPaths, outputPath: f.outputPath }), /256/);
  await fs.writeFile(path.join(f.directory, 'other.txt'), 'text');
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [path.join(f.directory, 'other.txt')], outputPath: f.outputPath }), /仅支持/);
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [file], outputPath: f.outputPath, imagesPerPage: 5 }), /每页发票/);
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [document], outputPath: f.outputPath }), /PDF 读取组件/);
  await fs.writeFile(f.outputPath, 'existing user file');
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [file], outputPath: f.outputPath }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(f.outputPath, 'utf8'), 'existing user file');
  await f.noWork();
});

test('rejects a PDF reader returning out-of-directory or unordered pages and more than 256 expanded pages', async t => {
  const f = await fixture(t), document = await f.pdf('source.pdf'), outside = await f.image('outside.png', 80);
  const cases = [
    async () => [],
    async () => [{ path: outside, pageNumber: 1 }],
    async request => { const filename = path.join(request.outputDir, 'page.png'); await fs.copyFile(outside, filename); return [{ path: filename, pageNumber: 2 }]; },
    async () => Array.from({ length: 257 }, (_, i) => ({ path: outside, pageNumber: i + 1 }))
  ];
  for (const convert of cases) {
    await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [document], outputPath: f.outputPath, pdfReader: { convert } }), /PDF/);
    await assert.rejects(fs.access(f.outputPath), { code: 'ENOENT' });
    await f.noWork();
  }
});

test('limits the total expansion across multiple PDF documents before invoking the writer', async t => {
  const f = await fixture(t), documents = [await f.pdf('a.pdf'), await f.pdf('b.pdf'), await f.pdf('c.pdf')];
  let writeCalls = 0;
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: documents, outputPath: f.outputPath, pdfReader: { convert: async request => {
    const filename = path.join(request.outputDir, 'page.png');
    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toFile(filename);
    return Array.from({ length: 100 }, (_, i) => ({ path: filename, pageNumber: i + 1 }));
  } }, pdfWriter: async () => { writeCalls++; } }), /展开后最多合并 256/);
  assert.equal(writeCalls, 0); await f.noWork();
});

test('reader and writer failures remove staging pages without publishing output', async t => {
  const f = await fixture(t), document = await f.pdf('source.pdf'), file = await f.image('a.png', 90);
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [document], outputPath: f.outputPath, pdfReader: { convert: async request => {
    await fs.writeFile(path.join(request.outputDir, 'partial.png'), 'partial'); throw new Error('reader failed');
  } } }), /reader failed/);
  await f.noWork();
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [file], outputPath: f.outputPath, pdfWriter: async request => {
    await fs.writeFile(request.outputPath, '%PDF-1.4\npartial'); throw new Error('writer failed');
  } }), /writer failed/);
  await assert.rejects(fs.access(f.outputPath), { code: 'ENOENT' }); await f.noWork();
});

test('cancellation during PDF preparation and output publication removes all owned files', async t => {
  const f = await fixture(t), document = await f.pdf('source.pdf'), file = await f.image('a.png', 100);
  const preparation = new AbortController();
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [document], outputPath: f.outputPath, signal: preparation.signal, pdfReader: { convert: async request => {
    await fs.writeFile(path.join(request.outputDir, 'page.png'), 'partial'); preparation.abort(); return [];
  } } }), { name: 'AbortError' });
  await f.noWork();
  const publication = new AbortController();
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [file], outputPath: f.outputPath, signal: publication.signal,
    pdfWriter: async request => { await fs.writeFile(request.outputPath, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3 * 1024 * 1024)])); return { pages: 1 }; },
    onProgress: event => { if (event.phase === 'saving' && event.progress > .95) publication.abort(); } }), { name: 'AbortError' });
  await assert.rejects(fs.access(f.outputPath), { code: 'ENOENT' }); await f.noWork();
});

test('an output created by another process during generation is preserved', async t => {
  const f = await fixture(t), file = await f.image('a.png', 110);
  await assert.rejects(createReimbursementInvoicePdf({ inputPaths: [file], outputPath: f.outputPath, pdfWriter: async request => {
    const result = await writeImagePdf(request);
    await fs.writeFile(f.outputPath, 'created by another process', { flag: 'wx' });
    return result;
  } }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(f.outputPath, 'utf8'), 'created by another process'); await f.noWork();
});
