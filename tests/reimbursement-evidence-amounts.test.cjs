'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { recognizeReimbursementEvidence, evidenceResultPage, EVIDENCE_ENGINE_VERSION, ENGINE_VERSION, MAX_BYTES } = require('../src/reimbursement-amounts.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'evidence-amounts-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const inputPath = path.join(directory, 'purchase.png'), workRoot = path.join(directory, 'work');
  await sharp({ create: { width: 32, height: 24, channels: 4, background: '#abc9' } }).png().toFile(inputPath);
  const pending = () => fs.readdir(workRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const scan = options => recognizeReimbursementEvidence({ asset: { id: 'evidence-fixture' }, inputPath, workRoot, ...options });
  return { directory, inputPath, workRoot, pending, scan };
}

test('evidence page records use purchase rules and never carry invoice identities', () => {
  assert.equal(ENGINE_VERSION, 3); assert.equal(EVIDENCE_ENGINE_VERSION, 2);
  const high = evidenceResultPage('发票号码：12345678901234567890\n实付款：￥123.45');
  assert.equal(high.status, 'recognized'); assert.equal(high.amountCents, 12345); assert.equal(high.detectedCents, 12345); assert.equal('invoiceKey' in high, false);
  assert.match(high.reason, /仅供核对/);
  const low = evidenceResultPage('订单金额：100.00');
  assert.equal(low.status, 'pending'); assert.equal(low.amountCents, null); assert.equal(low.detectedCents, 10000);
  const invoice = evidenceResultPage('价税合计（小写）￥113.00');
  assert.equal(invoice.amountCents, null); assert.equal(invoice.detectedCents, null);
  const foreign = evidenceResultPage('实付款 USD 25.00');
  assert.equal(foreign.status, 'pending'); assert.equal(foreign.amountCents, null); assert.equal(foreign.detectedCents, null); assert.match(foreign.reason, /外币/);
});

test('evidence OCR normalizes bounded static PNG, preserves sources and removes work', async t => {
  const f = await fixture(t), bytes = await fs.readFile(f.inputPath), controller = new AbortController(), progress = [];
  const result = await f.scan({ signal: controller.signal, onProgress: update => progress.push(update), ocrEngine: { async recognize(request) {
    assert.notEqual(request.inputPath, f.inputPath); assert.equal(request.language, 'auto'); assert.equal(request.signal, controller.signal);
    const metadata = await sharp(request.inputPath).metadata(); assert.equal(metadata.format, 'png'); assert.equal(metadata.hasAlpha, false);
    assert.ok(metadata.width <= 3500 && metadata.height <= 3500);
    return { text: '订单金额 200.00\n运费 10.00\n优惠 20.00\n实付款 ￥190.00' };
  } } });
  assert.equal(result.engineVersion, 2); assert.equal(result.sourceHash, digest(bytes)); assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].amountCents, 19000); assert.equal(result.pages[0].status, 'recognized'); assert.equal(progress.at(-1).progress, 1);
  assert.deepEqual(await fs.readFile(f.inputPath), bytes); assert.deepEqual(await f.pending(), []);
});

test('evidence cache is detached, source-hash keyed and completely separate from invoice cache', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.inputPath));
  const previous = { version: 1, engineVersion: 2, sourceHash, pages: [evidenceResultPage('实付款 23.45')] };
  let calls = 0;
  const ocrEngine = { async recognize() { calls++; return { text: '实付款 67.89' }; } };
  const result = await f.scan({ asset: { reimbursementAmounts: { ...previous, engineVersion: 3 }, reimbursementEvidenceAmounts: previous }, ocrEngine });
  assert.equal(calls, 0); assert.deepEqual(result, previous); result.pages[0].amountCents = 1; assert.equal(previous.pages[0].amountCents, 2345);
  const withoutEvidence = await f.scan({ asset: { reimbursementAmounts: { ...previous, engineVersion: 3 } }, ocrEngine });
  assert.equal(calls, 1); assert.equal(withoutEvidence.pages[0].amountCents, 6789);
  const changed = await sharp({ create: { width: 40, height: 24, channels: 3, background: '#345' } }).png().toBuffer(); await fs.writeFile(f.inputPath, changed);
  const rescanned = await f.scan({ asset: { reimbursementEvidenceAmounts: previous }, ocrEngine });
  assert.equal(calls, 2); assert.equal(rescanned.sourceHash, digest(changed)); assert.equal(rescanned.pages[0].amountCents, 6789);
  assert.deepEqual(await f.pending(), []);
});

test('force and engine upgrades preserve manual/excluded evidence decisions but rescan automatic results', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.inputPath));
  let calls = 0;
  const ocrEngine = { async recognize() { calls++; return { text: '实付款 60.00' }; } };
  for (const status of ['manual', 'excluded']) {
    const page = { pageNumber: 1, status, amountCents: status === 'manual' ? 2500 : null, detectedCents: 2300, confidence: 'low', reason: '人工核对购买截图' };
    const previous = { version: 1, sourceHash, pages: [page] };
    const result = await f.scan({ asset: { reimbursementEvidenceAmounts: previous }, force: true, ocrEngine });
    assert.equal(result.engineVersion, 2); assert.deepEqual(result.pages, [page]);
  }
  assert.equal(calls, 0);
  for (const engineVersion of [undefined, 1]) {
    const previous = { version: 1, engineVersion, sourceHash, pages: [evidenceResultPage('实付 20.00')] };
    const result = await f.scan({ asset: { reimbursementEvidenceAmounts: previous }, force: true, ocrEngine });
    assert.equal(result.pages[0].amountCents, 6000);
  }
  assert.equal(calls, 2);
});

test('pending OCR results are cached until explicit retry and failures do not invent a payment', async t => {
  const f = await fixture(t); let calls = 0;
  const ocrEngine = { async recognize() { calls++; throw new Error('OCR unavailable'); } };
  const result = await f.scan({ ocrEngine }); assert.equal(result.pages[0].status, 'pending'); assert.equal(result.pages[0].amountCents, null);
  const cached = await f.scan({ ocrEngine, asset: { reimbursementEvidenceAmounts: result } }); assert.equal(calls, 1); assert.deepEqual(cached, result);
  await f.scan({ ocrEngine, asset: { reimbursementEvidenceAmounts: result }, force: true }); assert.equal(calls, 2);
  const ambiguous = await f.scan({ ocrEngine: { async recognize() { return { text: '实付款 10.00\n实际支付 20.00' }; } } });
  assert.equal(ambiguous.pages[0].status, 'pending'); assert.equal(ambiguous.pages[0].detectedCents, null); assert.deepEqual(await f.pending(), []);
});

test('evidence supports only static bounded images and rejects PDF before calling a reader', async t => {
  const f = await fixture(t), pdf = path.join(f.directory, 'purchase.pdf'); await fs.writeFile(pdf, '%PDF-synthetic');
  await assert.rejects(f.scan({ inputPath: pdf, pdfReader: { convert() { throw new Error('must not decode'); } } }), /仅支持静态图片/);
  const large = path.join(f.directory, 'large.png'), handle = await fs.open(large, 'wx'); try { await handle.truncate(MAX_BYTES + 1); } finally { await handle.close(); }
  await assert.rejects(f.scan({ inputPath: large }), /64 MB/);
  const animated = path.join(f.directory, 'animated.gif'), pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]);
  await sharp(pixels, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).gif({ loop: 0, delay: [10, 10] }).toFile(animated);
  let calls = 0;
  const result = await f.scan({ inputPath: animated, ocrEngine: { async recognize() { calls++; return { text: '实付款 10.00' }; } } });
  assert.equal(calls, 0); assert.equal(result.pages[0].status, 'pending'); assert.match(result.pages[0].reason, /静态/); assert.deepEqual(await f.pending(), []);
});

test('evidence cancellation propagates before preparation and during OCR, leaving no work', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.scan({ signal: controller.signal }), { name: 'AbortError' });
  const during = new AbortController();
  await assert.rejects(f.scan({ signal: during.signal, ocrEngine: { async recognize() { during.abort(); return { text: '实付款 10.00' }; } } }), { name: 'AbortError' });
  assert.deepEqual(await f.pending(), []);
});

test('Windows OCR integer fragments become one evidence amount without touching invoice records', async t => {
  const f = await fixture(t), invoice = { version: 1, engineVersion: 3, sourceHash: digest(await fs.readFile(f.inputPath)), pages: [{ pageNumber: 1, amountCents: 9999, detectedCents: 9999, status: 'recognized', confidence: 'high', reason: 'invoice' }] };
  const before = structuredClone(invoice);
  const result = await f.scan({ asset: { reimbursementAmounts: invoice }, ocrEngine: { async recognize() {
    return { text: '订单详情\n商品金额 ¥ 164\n优惠 ¥ 36\n实付款 ¥ 1 28\n订单编号 202611240001234567' };
  } } });
  assert.equal(result.pages[0].status, 'recognized'); assert.equal(result.pages[0].amountCents, 12800);
  assert.equal(result.pages[0].detectedCents, 12800); assert.equal('invoiceKey' in result.pages[0], false);
  assert.deepEqual(invoice, before); assert.deepEqual(await f.pending(), []);
});

test('engine version one pending cards retry with bounded enlargement and cache the confirmed version two amount', async t => {
  const f = await fixture(t), sourceHash = digest(await fs.readFile(f.inputPath));
  const previous = { version: 1, engineVersion: 1, sourceHash, pages: [evidenceResultPage('no amount')] }, paths = [];
  const result = await f.scan({ asset: { reimbursementEvidenceAmounts: previous }, ocrEngine: { async recognize(request) {
    paths.push(request.inputPath);
    const metadata = await sharp(request.inputPath).metadata(); assert.ok(metadata.width <= 3500 && metadata.height <= 3500);
    return { text: paths.length === 1 ? '￥16 & 00\n已被接收\n转账' : '报价999一个月\n￥168 · 00\n已被接收\n转账' };
  } } });
  assert.equal(paths.length, 2); assert.notEqual(paths[0], paths[1]);
  assert.equal(result.engineVersion, 2); assert.equal(result.pages[0].amountCents, 16800); assert.equal(result.pages[0].status, 'recognized');
  assert.equal(previous.engineVersion, 1); assert.equal(previous.pages[0].amountCents, null);
  const cached = await f.scan({ asset: { reimbursementEvidenceAmounts: result }, ocrEngine: { recognize() { throw new Error('cache must not OCR'); } } });
  assert.deepEqual(cached, result); assert.deepEqual(await f.pending(), []);
});

test('card enlargement never replaces an unresolved transfer with an unrelated chat payment or incoming receipt', async t => {
  const f = await fixture(t);
  for (const retry of ['实付款999.00', '￥168.00\n已收款\n转账']) {
    let calls = 0;
    const result = await f.scan({ ocrEngine: { async recognize() { return { text: ++calls === 1 ? '￥16 & 00\n已被接收\n转账' : retry }; } } });
    assert.equal(calls, 2); assert.equal(result.pages[0].status, 'pending'); assert.equal(result.pages[0].amountCents, null);
  }
  assert.deepEqual(await f.pending(), []);
});

test('two conflicting accepted transfers remain pending instead of retrying into one OCR-omitted card', async t => {
  const f = await fixture(t); let calls = 0;
  const result = await f.scan({ ocrEngine: { async recognize() {
    calls++;
    return { text: calls === 1 ? '￥168.00\n已被接收\n转账\n￥200.00\n已被接收\n转账' : '￥168.00\n已被接收\n转账' };
  } } });
  assert.equal(calls, 1); assert.equal(result.pages[0].status, 'pending'); assert.equal(result.pages[0].amountCents, null);
  assert.match(result.pages[0].reason, /多个不一致/); assert.deepEqual(await f.pending(), []);
});
