'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { recognizeReimbursementInvoice, resultPage, invoiceKey, MAX_BYTES, ENGINE_VERSION } = require('../src/reimbursement-amounts.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const high = '增值税电子普通发票\n发票号码：12345678901234567890\n金额 100.00\n税额 13.00\n价税合计（小写）￥113.00';
const low = 'Invoice total: 98.76';

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'reimbursement-amounts-'));
  t.after(async () => {
    const relative = path.relative(parent, directory);
    assert.ok(relative.startsWith('reimbursement-amounts-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const image = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#abc9' } }).png().toBuffer();
  const source = async (name, bytes = image) => { const filename = path.join(directory, name); await fs.writeFile(filename, bytes); return filename; };
  const imagePath = await source('invoice.png'), pdfPath = await source('invoice.pdf', Buffer.from('%PDF-1.4\nSynthetic amount test PDF\n%%EOF'));
  const workRoot = path.join(directory, 'work');
  const pendingWork = async () => fs.readdir(workRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  function pdfReader(texts, calls = []) {
    return { async convert(request) {
      calls.push(request);
      const pages = [];
      for (const [index, text] of texts.entries()) {
        const filename = path.join(request.outputDir, `page-${index + 1}.png`);
        await fs.writeFile(filename, image);
        pages.push({ pageNumber: index + 1, path: filename, text });
      }
      return pages;
    } };
  }
  return { directory, image, imagePath, pdfPath, workRoot, source, pendingWork, pdfReader };
}
const asset = summary => ({ id: 'fixture-asset', hash: '0'.repeat(64), ...(summary ? { reimbursementAmounts: summary } : {}) });
const manualPage = (pageNumber, cents = 4321) => ({ pageNumber, amountCents: cents, detectedCents: null, status: 'manual', confidence: 'none', reason: '人工确认' });
const excludedPage = pageNumber => ({ pageNumber, amountCents: null, detectedCents: 1234, status: 'excluded', confidence: 'low', reason: '购买说明截图，不是发票' });

test('high-confidence VAT totals become recognized amounts while low-confidence totals remain suggestions', () => {
  const recognized = resultPage(1, high);
  assert.equal(recognized.status, 'recognized'); assert.equal(recognized.amountCents, 11300);
  assert.equal(recognized.detectedCents, 11300); assert.equal(recognized.confidence, 'high');
  assert.equal(recognized.invoiceKey, digest('invoice:12345678901234567890'));
  const suggestion = resultPage(2, low);
  assert.equal(suggestion.status, 'pending'); assert.equal(suggestion.amountCents, null);
  assert.equal(suggestion.detectedCents, 9876); assert.equal(suggestion.confidence, 'low');
  const unknown = resultPage(3, '订单号：12345678901234567890\n金额 22.00\n税额 1.20');
  assert.equal(unknown.status, 'pending'); assert.equal(unknown.detectedCents, null);
  const conflicting = resultPage(4, '价税合计（小写）￥100.00\n价税合计（小写）￥200.00');
  assert.equal(conflicting.status, 'pending'); assert.equal(conflicting.amountCents, null);
});

test('invoice identities normalize full-width digits and require a complete electronic number or traditional code-number pair', () => {
  assert.equal(invoiceKey('发 票 号 码：１２３４５６７８９０１２３４５６７８９０'), digest('invoice:12345678901234567890'));
  assert.equal(invoiceKey('发票号码：1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0'), digest('invoice:12345678901234567890'));
  assert.equal(invoiceKey('发票代码：044001900111\n发票号码：12345678'), digest('invoice:044001900111:12345678'));
  assert.notEqual(invoiceKey('发票代码：044001900111\n发票号码：12345678'), invoiceKey('发票代码：044001900112\n发票号码：12345678'));
  for (const text of ['订单号：12345678901234567890', '发票号码：12345678', '发票号码：123456789012345678901', '发票号码：1234567890123456789']) assert.equal(invoiceKey(text), undefined);
});

test('image OCR receives a normalized local PNG and successful scans do not modify the source', async t => {
  const f = await fixture(t), original = await fs.readFile(f.imagePath), calls = [], progress = [], controller = new AbortController();
  const result = await recognizeReimbursementInvoice({ asset: asset(), inputPath: f.imagePath, workRoot: f.workRoot, signal: controller.signal,
    ocrEngine: { async recognize(request) {
      calls.push(request);
      assert.notEqual(request.inputPath, f.imagePath); assert.equal(request.language, 'auto'); assert.equal(request.signal, controller.signal);
      const metadata = await sharp(request.inputPath).metadata(); assert.equal(metadata.format, 'png'); assert.equal(metadata.hasAlpha, false);
      assert.ok(metadata.width <= 3500 && metadata.height <= 3500);
      return { text: high };
    } }, onProgress: update => progress.push(update) });
  assert.equal(calls.length, 1); assert.equal(result.sourceHash, digest(original));
  assert.equal(result.engineVersion, ENGINE_VERSION);
  assert.equal(result.pages[0].amountCents, 11300); assert.equal(result.pages[0].status, 'recognized');
  assert.equal(progress.at(-1).progress, 1);
  assert.deepEqual(await fs.readFile(f.imagePath), original); assert.deepEqual(await f.pendingWork(), []);
});

test('PDF pages use embedded high-confidence text and OCR only unresolved pages', async t => {
  const f = await fixture(t), convertCalls = [], ocrCalls = [];
  const original = await fs.readFile(f.pdfPath);
  const result = await recognizeReimbursementInvoice({ asset: asset(), inputPath: f.pdfPath, workRoot: f.workRoot,
    pdfReader: f.pdfReader([high, low, '没有合计'], convertCalls), ocrEngine: { async recognize(request) {
      ocrCalls.push(path.basename(request.inputPath)); await fs.access(request.inputPath);
      return { text: ocrCalls.length === 1 ? '价税合计（小写）￥77.30' : 'TOTAL: 12.34' };
    } } });
  assert.equal(convertCalls.length, 1); assert.notEqual(convertCalls[0].inputPath, f.pdfPath);
  assert.deepEqual(ocrCalls, ['page-2.png', 'page-3.png']);
  assert.deepEqual(result.pages.map(page => [page.pageNumber, page.status, page.amountCents, page.detectedCents]), [[1, 'recognized', 11300, 11300], [2, 'recognized', 7730, 7730], [3, 'pending', null, 1234]]);
  assert.deepEqual(await fs.readFile(f.pdfPath), original); assert.deepEqual(await f.pendingWork(), []);
});

test('OCR failures and lower-confidence OCR do not discard an existing PDF amount suggestion', async t => {
  const f = await fixture(t);
  for (const failure of [false, true]) {
    const result = await recognizeReimbursementInvoice({ asset: asset(), inputPath: f.pdfPath, workRoot: f.workRoot,
      pdfReader: f.pdfReader([low]), ocrEngine: { async recognize() { if (failure) throw new Error('OCR unavailable'); return { text: 'TOTAL: 11.00' }; } } });
    assert.equal(result.pages[0].amountCents, null); assert.equal(result.pages[0].detectedCents, 9876);
    assert.equal(result.pages[0].status, 'pending'); assert.equal(result.pages[0].confidence, 'low');
  }
  assert.deepEqual(await f.pendingWork(), []);
});

test('same-byte cache uses the actual source hash and returns a detached summary without decoding', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.pdfPath));
  const previous = { version: 1, engineVersion: ENGINE_VERSION, sourceHash, pages: [manualPage(1)] };
  const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.pdfPath, workRoot: f.workRoot,
    pdfReader: { async convert() { throw new Error('cache should not decode'); } }, ocrEngine: { async recognize() { throw new Error('cache should not OCR'); } } });
  assert.deepEqual(result, previous); result.pages[0].amountCents = 1;
  assert.equal(previous.pages[0].amountCents, 4321);
  assert.deepEqual(await f.pendingWork(), []);
});

test('old engine caches rescan automatic pages once while preserving manual and excluded decisions', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.pdfPath));
  for (const engineVersion of [undefined, 1]) {
    const previous = { version: 1, ...(engineVersion === undefined ? {} : { engineVersion }), sourceHash,
      pages: [manualPage(1, 0), excludedPage(2), resultPage(3, ''), resultPage(4, high)] };
    const before = structuredClone(previous), convertCalls = [];
    const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.pdfPath, workRoot: f.workRoot,
      pdfReader: f.pdfReader(['unused manual text', 'unused excluded text', '价税合计（小写）￥21.23', '价税合计（小写）￥42.34'], convertCalls) });
    assert.equal(convertCalls.length, 1, 'legacy pending and recognized pages must reach the updated reader');
    assert.equal(result.engineVersion, ENGINE_VERSION);
    assert.deepEqual(result.pages.slice(0, 2), previous.pages.slice(0, 2));
    assert.deepEqual(result.pages.slice(2).map(page => [page.status, page.amountCents]), [['recognized', 2123], ['recognized', 4234]]);
    assert.deepEqual(previous, before, 'migration must not mutate the caller cache');
    const cachedCalls = [];
    const cached = await recognizeReimbursementInvoice({ asset: asset(result), inputPath: f.pdfPath, workRoot: f.workRoot,
      pdfReader: f.pdfReader(['changed text'], cachedCalls) });
    assert.equal(cachedCalls.length, 0, 'upgraded cache must not rescan on the next build');
    assert.deepEqual(cached, result);
  }
  assert.deepEqual(await f.pendingWork(), []);
});

test('upgraded pending results are reused until an explicit retry, including reader failures', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.pdfPath));
  for (const fail of [false, true]) {
    const reads = [];
    const reader = fail ? { async convert() { reads.push(true); throw new Error('still unreadable'); } }
      : f.pdfReader(['no reliable total'], reads);
    const previous = { version: 1, sourceHash, pages: [resultPage(1, '')] };
    const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.pdfPath, workRoot: f.workRoot, pdfReader: reader });
    assert.equal(reads.length, 1); assert.equal(result.engineVersion, ENGINE_VERSION); assert.equal(result.pages[0].status, 'pending');
    const cached = await recognizeReimbursementInvoice({ asset: asset(result), inputPath: f.pdfPath, workRoot: f.workRoot, pdfReader: reader });
    assert.equal(reads.length, 1, 'pending must not schedule endless automatic retries'); assert.deepEqual(cached, result);
    await recognizeReimbursementInvoice({ asset: asset(result), inputPath: f.pdfPath, workRoot: f.workRoot, pdfReader: reader, force: true });
    assert.equal(reads.length, 2, 'explicit retry may reprocess a current pending cache');
  }
  assert.deepEqual(await f.pendingWork(), []);
});

test('changing source bytes invalidates the cache and does not attach an old manual amount to a different invoice', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.imagePath));
  const previous = { version: 1, sourceHash, pages: [manualPage(1)] };
  await sharp({ create: { width: 33, height: 25, channels: 3, background: '#f00' } }).png().toFile(f.imagePath);
  let calls = 0;
  const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.imagePath, workRoot: f.workRoot,
    ocrEngine: { async recognize() { calls++; return { text: high }; } } });
  assert.equal(calls, 1); assert.notEqual(result.sourceHash, sourceHash);
  assert.equal(result.pages[0].status, 'recognized'); assert.equal(result.pages[0].amountCents, 11300);
});

test('forced rescanning preserves manual and excluded pages while rescanning automatic pages', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.pdfPath));
  const manual = { ...manualPage(1), invoiceKey: digest('manual identity') }, excluded = excludedPage(2);
  const previous = { version: 1, sourceHash, pages: [manual, excluded, resultPage(3, high)] };
  let ocrCalls = 0;
  const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.pdfPath, workRoot: f.workRoot, force: true,
    pdfReader: f.pdfReader(['changed text', 'changed text', '']), ocrEngine: { async recognize() { ocrCalls++; return { text: '价税合计（小写）￥55.50' }; } } });
  assert.deepEqual(result.pages[0], manual); assert.deepEqual(result.pages[1], excluded);
  assert.equal(result.pages[2].amountCents, 5550); assert.equal(ocrCalls, 1);
  assert.deepEqual(previous.pages, [manual, excluded, resultPage(3, high)]); assert.deepEqual(await f.pendingWork(), []);
});

test('unreadable PDFs produce a pending whole-file entry without guessing an amount', async t => {
  const f = await fixture(t);
  for (const pdfReader of [undefined, { async convert() { throw new Error('encrypted or malformed PDF'); } }, { async convert() { return []; } }]) {
    const result = await recognizeReimbursementInvoice({ asset: asset(), inputPath: f.pdfPath, workRoot: f.workRoot, pdfReader });
    assert.equal(result.pages.length, 1); assert.equal(result.pages[0].pageNumber, 1);
    assert.equal(result.pages[0].status, 'pending'); assert.equal(result.pages[0].amountCents, null);
    assert.equal(result.pages[0].detectedCents, null); assert.match(result.pages[0].reason, /整份文件/);
    assert.equal(result.sourceHash, digest(await fs.readFile(f.pdfPath))); assert.equal(result.engineVersion, ENGINE_VERSION);
  }
  assert.deepEqual(await f.pendingWork(), []);
});

test('forced unreadable PDF rescans retain already manual and excluded decisions for unchanged source bytes', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.pdfPath));
  const previous = { version: 1, sourceHash, pages: [manualPage(1), excludedPage(2), resultPage(3, high)] };
  const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.pdfPath, workRoot: f.workRoot, force: true,
    pdfReader: { async convert() { throw new Error('PDF reader temporarily unavailable'); } } });
  assert.deepEqual(result.pages[0], previous.pages[0]);
  assert.deepEqual(result.pages[1], previous.pages[1]);
  assert.equal(result.pages[2].pageNumber, 3); assert.equal(result.pages[2].status, 'pending'); assert.equal(result.pages[2].amountCents, null);
  assert.deepEqual(await f.pendingWork(), []);
});

test('a confirmed whole-file total or exclusion survives a recovered two-page reader without double counting', async t => {
  const f = await fixture(t);
  const unreadable = await recognizeReimbursementInvoice({ asset: asset(), inputPath: f.pdfPath, workRoot: f.workRoot,
    pdfReader: { async convert() { throw new Error('temporarily unreadable'); } } });
  assert.match(unreadable.pages[0].reason, /整份文件/);
  for (const status of ['manual', 'excluded']) {
    const previous = { ...unreadable, pages: [{ ...unreadable.pages[0], status, amountCents: status === 'manual' ? 4321 : 0,
      reason: status === 'manual' ? '已手动核对整份文件' : '不计入报销整份文件' }] };
    const convertCalls = [];
    const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.pdfPath, workRoot: f.workRoot, force: true,
      pdfReader: f.pdfReader([high, '价税合计（小写）￥55.50'], convertCalls), ocrEngine: { async recognize() { throw new Error('whole-file decision must bypass OCR'); } } });
    assert.deepEqual(result, previous);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages.reduce((sum, page) => sum + (page.status === 'excluded' ? 0 : page.amountCents || 0), 0), status === 'manual' ? 4321 : 0);
    assert.equal(convertCalls.length, 0, 'retained whole-file total must not append recovered PDF page amounts');
    result.pages[0].amountCents = 99;
    assert.equal(previous.pages[0].amountCents, status === 'manual' ? 4321 : 0);
  }
  assert.deepEqual(await f.pendingWork(), []);
});

test('legacy whole-file decisions are stamped with the new engine without decoding or losing their scope', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.pdfPath));
  for (const status of ['manual', 'excluded']) {
    const previous = { version: 1, sourceHash, pages: [{ ...manualPage(1), status, amountCents: status === 'excluded' ? 0 : 4321,
      reason: status === 'excluded' ? '整份文件不计入报销' : '已手动核对整份文件合计' }] };
    const before = structuredClone(previous), calls = [];
    const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.pdfPath, workRoot: f.workRoot,
      pdfReader: f.pdfReader([high, high], calls) });
    assert.deepEqual(result, { ...previous, engineVersion: ENGINE_VERSION });
    assert.equal(calls.length, 0); assert.deepEqual(previous, before);
    const again = await recognizeReimbursementInvoice({ asset: asset(result), inputPath: f.pdfPath, workRoot: f.workRoot,
      pdfReader: f.pdfReader([high, high], calls) });
    assert.deepEqual(again, result); assert.equal(calls.length, 0);
  }
});

test('whole-file manual totals do not transfer to a PDF whose source bytes changed', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.pdfPath));
  const previous = { version: 1, sourceHash, pages: [{ ...manualPage(1), reason: '已手动核对整份文件' }] };
  await fs.writeFile(f.pdfPath, '%PDF-1.4\nDifferent invoice content\n%%EOF');
  const calls = [];
  const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.pdfPath, workRoot: f.workRoot, force: true,
    pdfReader: f.pdfReader(['价税合计（小写）￥10.00', '价税合计（小写）￥20.00'], calls) });
  assert.equal(calls.length, 1); assert.notEqual(result.sourceHash, sourceHash);
  assert.deepEqual(result.pages.map(page => [page.status, page.amountCents]), [['recognized', 1000], ['recognized', 2000]]);
  assert.deepEqual(await f.pendingWork(), []);
});

test('an incomplete PDF page result cannot silently drop saved manual or excluded tail pages', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.pdfPath));
  const previous = { version: 1, sourceHash, pages: [resultPage(1, high), excludedPage(2), manualPage(3)] };
  const result = await recognizeReimbursementInvoice({ asset: asset(previous), inputPath: f.pdfPath, workRoot: f.workRoot, force: true,
    pdfReader: f.pdfReader([high]) });
  assert.equal(result.pages.length, 3);
  assert.deepEqual(result.pages[1], previous.pages[1]); assert.deepEqual(result.pages[2], previous.pages[2]);
  assert.equal(result.pages[0].status, 'pending');
  assert.deepEqual(await f.pendingWork(), []);
});

test('PDF pages outside the conversion directory are rejected before OCR or embedded text is trusted', async t => {
  const f = await fixture(t); let ocrCalls = 0;
  const result = await recognizeReimbursementInvoice({ asset: asset(), inputPath: f.pdfPath, workRoot: f.workRoot,
    pdfReader: { async convert() { return [{ pageNumber: 1, path: f.imagePath, text: high }]; } },
    ocrEngine: { async recognize() { ocrCalls++; return { text: high }; } } });
  assert.equal(ocrCalls, 0); assert.equal(result.pages[0].status, 'pending'); assert.equal(result.pages[0].amountCents, null);
  assert.deepEqual(await f.pendingWork(), []);
});

test('pre-aborted and mid-OCR scans throw AbortError and remove temporary work', async t => {
  const f = await fixture(t), pre = new AbortController(); pre.abort();
  await assert.rejects(recognizeReimbursementInvoice({ asset: asset(), inputPath: f.imagePath, workRoot: f.workRoot, signal: pre.signal }), { name: 'AbortError' });
  assert.deepEqual(await f.pendingWork(), []);
  const controller = new AbortController();
  await assert.rejects(recognizeReimbursementInvoice({ asset: asset(), inputPath: f.imagePath, workRoot: f.workRoot, signal: controller.signal,
    ocrEngine: { async recognize() { controller.abort(); return { text: high }; } } }), { name: 'AbortError' });
  assert.deepEqual(await f.pendingWork(), []);
});

test('PDF cancellation is propagated instead of becoming an ordinary pending amount', async t => {
  const f = await fixture(t);
  await assert.rejects(recognizeReimbursementInvoice({ asset: asset(), inputPath: f.pdfPath, workRoot: f.workRoot,
    pdfReader: { async convert() { throw Object.assign(new Error('PDF cancelled'), { name: 'AbortError' }); } } }), { name: 'AbortError' });
  assert.deepEqual(await f.pendingWork(), []);
});

test('unsupported and oversized sources fail before attempting OCR', async t => {
  const f = await fixture(t);
  const document = await f.source('invoice.txt', Buffer.from(high));
  await assert.rejects(recognizeReimbursementInvoice({ asset: asset(), inputPath: document, workRoot: f.workRoot }), /仅支持图片和 PDF/);
  const large = await fs.open(path.join(f.directory, 'large.pdf'), 'wx');
  try { await large.truncate(MAX_BYTES + 1); } finally { await large.close(); }
  await assert.rejects(recognizeReimbursementInvoice({ asset: asset(), inputPath: path.join(f.directory, 'large.pdf'), workRoot: f.workRoot }), /64 MB/);
  assert.deepEqual(await f.pendingWork(), []);
});
