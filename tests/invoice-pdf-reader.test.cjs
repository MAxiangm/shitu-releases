'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { createInvoicePdfReader, resourceFile, validatePage, MAX_PAGE_PIXELS, MAX_FILE_BYTES } = require('../src/invoice-pdf-reader.cjs');

test('PDF reader only serves its own static reader and vendored rendering resources', () => {
  for (const item of ['', 'index.html', 'invoice-pdf-reader.js', 'invoice-text-layout.js', 'vendor/pdfjs/build/pdf.mjs', 'vendor/pdfjs/build/pdf.worker.mjs', 'vendor/pdfjs/wasm/openjpeg.wasm', 'vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap', 'vendor/pdfjs/standard_fonts/FoxitSans.pfb']) assert.ok(resourceFile(item), item);
  for (const item of ['../main.cjs', 'invoice-pdf-preload.cjs', 'vendor/pdfjs/../../main.cjs', 'C:/secret.txt', 'vendor/pdfjs/build/other.mjs', 'vendor/pdfjs/wasm/../../main.cjs', 'http://example.com/file', 'vendor/pdfjs/cmaps/sub/secret.bcmap']) assert.equal(resourceFile(item), null, item);
});

test('PDF page IPC validates pixels, text and binary PNG data', async () => {
  const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const result = validatePage({ png, width: 4, height: 3, text: 'invoice 123' });
  assert.equal(result.width, 4); assert.equal(result.height, 3); assert.equal(result.text, 'invoice 123');
  assert.throws(() => validatePage({ png: 'fake', width: 4, height: 3, text: '' }), /图片无效/);
  assert.throws(() => validatePage({ png, width: 3, height: 4, text: '' }), /尺寸无效/);
  assert.throws(() => validatePage({ png, width: 4, height: 3, text: 'x'.repeat(100001) }), /文字超过/);
  const oversized = Buffer.from(png); oversized.writeUInt32BE(MAX_PAGE_PIXELS, 16);
  assert.throws(() => validatePage({ png: oversized, width: MAX_PAGE_PIXELS, height: 3, text: '' }), /尺寸无效/);
});

test('invalid paths, non-PDF data and pre-cancelled input never create a browser or output files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-pdf-reader-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let windows = 0;
  const reader = createInvoicePdfReader({ BrowserWindow: function () { windows++; throw new Error('unexpected browser'); }, ipcMain: new EventEmitter() });
  const file = path.join(directory, 'not-pdf.pdf'); await fs.writeFile(file, 'not a PDF');
  await assert.rejects(reader.convert({ inputPath: file, outputDir: path.join(directory, 'output') }), /不是有效的 PDF/);
  await assert.rejects(reader.convert({ inputPath: 'relative.pdf', outputDir: path.join(directory, 'output') }), /路径无效/);
  await assert.rejects(reader.convert({ inputPath: file, outputDir: 'relative' }), /目录无效/);
  const oversized = path.join(directory, 'too-large.pdf');
  await fs.writeFile(oversized, '%PDF-1.4');
  await fs.truncate(oversized, MAX_FILE_BYTES + 1);
  await assert.rejects(reader.convert({ inputPath: oversized, outputDir: path.join(directory, 'output') }), /64 MB/);
  await fs.rm(oversized);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reader.convert({ inputPath: file, outputDir: directory, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(windows, 0); assert.equal(reader.busy(), false);
  assert.deepEqual(await fs.readdir(directory), ['not-pdf.pdf']);
});
