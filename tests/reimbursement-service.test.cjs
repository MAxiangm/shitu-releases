'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { createReimbursementService, profileValue, DEFAULT_COMPANY_NAME, reimbursementFormName } = require('../src/reimbursement-service.cjs');
const { readZip, writeZip } = require('../src/xlsx-zip.cjs');

async function fixture(t, overrides = {}) {
  const parent = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const base = await fs.mkdtemp(path.join(parent, 'reimbursement-service-'));
  const library = new Library({ root: path.join(base, 'library'), createThumbnail: async (_input, output) => {
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } }).jpeg().toFile(output); return { width: 0, height: 0 };
  } }); await library.init();
  let current = library, date = new Date('2026-11-21T10:00:00Z'), chosenSave, chosenDirectory;
  const events = [];
  const profilePath = path.join(base, 'profile.json');
  const service = createReimbursementService({ rootDir: path.join(base, 'work'), profilePath, getLibrary: () => current, dateNow: () => date,
    chooseFiles: async () => ({ canceled: true }), chooseSavePath: async () => chosenSave || { canceled: true }, chooseDirectory: async () => chosenDirectory || { canceled: true }, openFile: async () => '',
    ocrEngine: { recognize: async () => ({ text: '' }) }, onEvent: event => events.push(event), ...overrides });
  t.after(async () => { await service.shutdown(); const relative = path.relative(parent, base); assert.ok(relative && !relative.startsWith('..')); await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const request = id => ({ folderId: id, libraryRoot: library.root });
  const profile = { companyName: '测试公司', applicant: '测试申请人', accountName: '测试户名', bankName: '测试银行', accountNumber: '001234567890' };
  async function create() { await service.saveProfile(profile); return service.create({ name: '本月报销', libraryRoot: library.root }); }
  const sheet = async (assetId, name = 'xl/worksheets/sheet1.xml') => readZip(await fs.readFile(library.getAssetPath(assetId, 'original'))).entries.find(e => e.name === name).data.toString();
  return { base, library, profilePath, service, request, profile, create, sheet, events, setDate: value => { date = value; }, saveTo: file => { chosenSave = { filePath: file }; }, exportAllTo: directory => { chosenDirectory = { filePaths: [directory] }; }, switchLibrary: value => { current = value; } };
}

test('reimbursement creation saves profile as strings and generates the real template with current dates', async t => {
  const f = await fixture(t); const result = await f.create();
  assert.equal(result.workspace.categories.length, 5); assert.equal(f.library.snapshot().folders.length, 6);
  assert.deepEqual(await f.service.getProfile(), f.profile);
  assert.equal(JSON.parse(await fs.readFile(f.profilePath, 'utf8')).accountNumber, '001234567890');
  const xml = await f.sheet(result.workspace.artifacts.form.assetId);
  assert.match(xml, /测试申请人/); assert.match(xml, /测试银行/); assert.match(xml, /001234567890/); assert.match(xml, /2026年11月21日/);
  assert.equal(result.workspace.artifacts.supplementPdf.ready, false);
});

test('legacy reimbursement profiles keep the template company and explicit company changes regenerate existing forms', async t => {
  const legacy = { applicant: '原申请人', accountName: '原户名', bankName: '原开户行', accountNumber: '00001234' };
  assert.deepEqual(profileValue(legacy), { companyName: DEFAULT_COMPANY_NAME, ...legacy });
  for (const companyName of [123, 'a'.repeat(181), '坏\0名称', '\ud800']) assert.throws(() => profileValue({ ...legacy, companyName }), /无效/);
  const f = await fixture(t), result = await f.create(), request = f.request(result.folderId);
  const formId = result.workspace.artifacts.form.assetId;
  await f.service.saveProfile({ ...f.profile, companyName: '更新后的示例公司' });
  await f.service.refresh(request);
  assert.match(await f.sheet(formId), /更新后的示例公司/);
  assert.equal((await f.service.get(request)).artifacts.form.assetId, formId);
  assert.equal((await f.service.get(request)).artifacts.form.name, '财务报销申请表（更新后的示例公司）2026年11月');
  assert.equal(JSON.parse(await fs.readFile(f.profilePath, 'utf8')).companyName, '更新后的示例公司');
  await f.service.saveProfile(legacy);
  assert.equal((await f.service.getProfile()).companyName, '更新后的示例公司');
  await f.service.saveProfile({ ...f.profile, companyName: '' });
  await f.service.refresh(request);
  assert.doesNotMatch(await f.sheet(formId), /更新后的示例公司/);
  assert.equal((await f.service.getProfile()).companyName, '');
});

test('form names follow company and month and use valid filename characters without changing the heading', async t => {
  assert.equal(reimbursementFormName({ companyName: '示例公司' }, '2027-01-03'), '财务报销申请表（示例公司）2027年1月');
  assert.equal(reimbursementFormName({ companyName: '' }, '2027-01-03'), '财务报销申请表2027年1月');
  const f = await fixture(t), result = await f.create(), request = f.request(result.folderId);
  f.setDate(new Date('2026-12-01T00:00:00Z'));
  await f.service.saveProfile({ ...f.profile, companyName: '示例/研发:公司' });
  await f.service.refresh(request);
  const workspace = await f.service.get(request);
  assert.equal(workspace.artifacts.form.assetId, result.workspace.artifacts.form.assetId);
  assert.equal(workspace.artifacts.form.name, '财务报销申请表（示例_研发_公司）2026年12月');
  assert.match(await f.sheet(workspace.artifacts.form.assetId), /示例\/研发:公司/);
  f.saveTo(path.join(f.base, 'company.xlsx'));
  await f.service.exportArtifact({ ...request, kind: 'form' });
});

test('locked reimbursement files report a useful message and refresh recovers after release', async t => {
  const f = await fixture(t), created = await f.create(), request = f.request(created.folderId);
  const id = created.workspace.artifacts.form.assetId, before = await fs.readFile(f.library.getAssetPath(id, 'original'));
  const original = f.library.upsertReimbursementDocument.bind(f.library);
  f.library.upsertReimbursementDocument = async () => { throw Object.assign(new Error('EBUSY: rename D:\\private\\file.xlsx'), { code: 'EBUSY' }); };
  await assert.rejects(f.service.refresh(request), error => error.code === 'EBUSY' && /报销申请表.*占用/.test(error.message) && /保存并关闭/.test(error.message) && !error.message.includes('private'));
  const locked = await f.service.get(request);
  assert.equal(locked.state, 'error'); assert.match(locked.message, /刷新生成文件/);
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(id, 'original')), before);
  f.library.upsertReimbursementDocument = original;
  assert.equal((await f.service.refresh(request)).state, 'idle');
});

test('loading old profiles supplies a company default and an explicitly blank company survives restart', async t => {
  const f = await fixture(t); await f.service.shutdown();
  const { companyName, ...legacy } = f.profile;
  await fs.writeFile(f.profilePath, JSON.stringify(legacy));
  const reopen = () => createReimbursementService({ rootDir: path.join(f.base, 'work'), profilePath: f.profilePath, getLibrary: () => f.library });
  let service = reopen();
  try {
    assert.equal((await service.getProfile()).companyName, DEFAULT_COMPANY_NAME);
    await service.saveProfile({ ...legacy, companyName: '' });
    await service.shutdown(); service = reopen();
    assert.equal((await service.getProfile()).companyName, '');
  } finally { await service.shutdown(); }
});

test('only supplement screenshots generate a print PDF and regenerating keeps document IDs', async t => {
  const f = await fixture(t), { folderId } = await f.create(), request = f.request(folderId);
  const pdf = path.join(f.base, 'invoice.pdf'); await fs.writeFile(pdf, '%PDF-invoice');
  await f.service.importFiles({ ...request, category: 'travel', paths: [pdf] });
  let workspace = await f.service.get(request); assert.equal(workspace.categories[0].count, 1); assert.equal(workspace.artifacts.supplementPdf.ready, false);
  const images = [];
  for (let i = 0; i < 3; i++) { const file = path.join(f.base, `purchase-${i}.png`); await sharp({ create: { width: 200, height: 100, channels: 3, background: i ? '#33cc44' : '#cc4433' } }).png().toFile(file); images.push(file); }
  const before = await fs.readFile(images[0]);
  await f.service.importFiles({ ...request, category: 'supplement', paths: images });
  workspace = await f.service.get(request); const generated = workspace.artifacts.supplementPdf.assetId;
  // Identical screenshots deduplicate in the library; both distinct pages still fit one A4 sheet.
  assert.equal(workspace.categories.find(c => c.key === 'supplement').count, 2);
  assert.match((await fs.readFile(f.library.getAssetPath(generated, 'original'))).toString('latin1'), /\/Count 1\b/);
  await f.service.refresh(request); assert.equal((await f.service.get(request)).artifacts.supplementPdf.assetId, generated);
  assert.deepEqual(await fs.readFile(images[0]), before);
  await assert.rejects(f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [pdf] }), /仅支持图片/);
});

test('date and profile refresh preserve externally edited expense entries with optimistic concurrency', async t => {
  const f = await fixture(t), result = await f.create(), request = f.request(result.folderId);
  const id = result.workspace.artifacts.form.assetId, file = f.library.getAssetPath(id, 'original');
  const zip = readZip(await fs.readFile(file)), sheet = zip.entries.find(e => e.name === 'xl/worksheets/sheet1.xml');
  sheet.data = Buffer.from(sheet.data.toString().replace(/<c\b[^>]*\br="C8"[^>]*\/>|<c\b[^>]*\br="C8"[^>]*>[\s\S]*?<\/c>/, '<c r="C8" s="69" t="inlineStr"><is><t>手工填写的交通费</t></is></c>'));
  await fs.writeFile(file, writeZip(zip));
  f.setDate(new Date('2026-11-22T06:00:00Z'));
  await f.service.saveProfile({ ...f.profile, applicant: '更新后的申请人' });
  await f.service.refresh(request);
  const changed = await f.sheet(id); assert.match(changed, /手工填写的交通费/); assert.match(changed, /更新后的申请人/); assert.match(changed, /2026年11月22日/);
  const asset = f.library.snapshot().assets.find(a => a.id === id);
  assert.equal(asset.hash, crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'));
});

test('native library imports and trash changes automatically update and retire generated supplement PDF', async t => {
  const f = await fixture(t), result = await f.create(), request = f.request(result.folderId);
  const category = result.workspace.categories.find(c => c.key === 'supplement');
  const image = path.join(f.base, 'native.png'); await sharp({ create: { width: 100, height: 80, channels: 3, background: '#998822' } }).png().toFile(image);
  const added = await f.library.importPaths([image], { folderId: category.folderId });
  const until = async predicate => { const deadline = Date.now() + 6000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw Error('auto-generation timed out'); };
  await until(async () => (await f.service.get(request)).artifacts.supplementPdf.ready);
  await f.library.setTrash(added.assetIds, true);
  await until(async () => !(await f.service.get(request)).artifacts.supplementPdf.ready);
  assert.equal((await f.service.get(request)).categories.find(c => c.key === 'supplement').count, 0);
});

test('reimbursement exports copies outside the library and rejects stale library requests', async t => {
  const f = await fixture(t), result = await f.create(), request = { ...f.request(result.folderId), kind: 'form' };
  const output = path.join(f.base, 'copy.xlsx'); f.saveTo(output);
  const exported = await f.service.exportArtifact(request); assert.equal(exported.saved, true); assert.ok((await fs.stat(output)).size > 10000);
  f.saveTo(path.join(f.library.root, 'bad.xlsx')); await assert.rejects(f.service.exportArtifact(request), /素材库之外/);
  f.switchLibrary(null); await assert.rejects(f.service.get(request), /素材库已切换/);
});

test('export waits for a newer generation when another screenshot arrives during PDF rendering', async t => {
  const { writeImagePdf } = require('../src/image-pdf.cjs');
  let release, started, calls = 0;
  const rendering = new Promise(resolve => { started = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { pdfWriter: async options => { if (++calls === 1) { started(); await paused; } return writeImagePdf(options); } });
  const result = await f.create(), request = f.request(result.folderId), category = result.workspace.categories.find(c => c.key === 'supplement');
  const first = path.join(f.base, 'first.png'), second = path.join(f.base, 'second.png');
  await sharp({ create: { width: 100, height: 80, channels: 3, background: '#44aa11' } }).png().toFile(first);
  await sharp({ create: { width: 100, height: 80, channels: 3, background: '#bb2244' } }).png().toFile(second);
  const importing = f.service.importFiles({ ...request, category: 'supplement', paths: [first] });
  await rendering;
  await f.library.importPaths([second], { folderId: category.folderId });
  const output = path.join(f.base, 'latest.pdf'); f.saveTo(output);
  const exporting = f.service.exportArtifact({ ...request, kind: 'supplementPdf' });
  release(); await importing; await exporting;
  const pdf = await fs.readFile(output);
  assert.equal((pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length, 2);
  assert.ok(calls >= 2);
});

test('custom categories follow folder order and only nonempty invoice categories enter the workbook', async t => {
  const { createReimbursementWorkbook } = require('../src/reimbursement-workbook.cjs');
  const received = [];
  const f = await fixture(t, { workbookBuilder: options => {
    received.push(structuredClone(options.categories));
    return createReimbursementWorkbook(options);
  } });
  const created = await f.create(), request = f.request(created.folderId);
  assert.deepEqual(received.at(-1), []);
  await f.service.saveCategories({ ...request, categories: [
    { key: 'custom-food', name: '餐饮' }, { key: 'travel', name: '差旅' }, { key: 'supplement', name: '购买说明' }
  ] });
  const notes = path.join(f.base, 'travel-notes.txt'); await fs.writeFile(notes, 'supporting attachment only');
  await f.service.importFiles({ ...request, category: 'travel', paths: [notes] });
  assert.deepEqual(received.at(-1), [], 'ordinary documents without invoice pages never create workbook rows');
  const first = path.join(f.base, 'travel.pdf'), second = path.join(f.base, 'food.pdf');
  await fs.writeFile(first, '%PDF-travel'); await fs.writeFile(second, '%PDF-food');
  await f.service.importFiles({ ...request, category: 'travel', paths: [first] });
  assert.deepEqual(received.at(-1), [{ key: 'travel', name: '差旅', count: 1, amountCents: 0, pendingCount: 1 }]);
  const image = path.join(f.base, 'receipt.png');
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#3344cc' } }).png().toFile(image);
  await f.service.importFiles({ ...request, category: 'supplement', paths: [image] });
  assert.deepEqual(received.at(-1), [{ key: 'travel', name: '差旅', count: 1, amountCents: 0, pendingCount: 1 }]);
  const populated = await f.service.importFiles({ ...request, category: 'custom-food', paths: [second] });
  const foodId = populated.workspace.categories.find(item => item.key === 'custom-food').folderId;
  assert.deepEqual(received.at(-1).map(item => item.key), ['custom-food', 'travel']);
  const reordered = await f.service.saveCategories({ ...request, categories: [
    { key: 'travel', name: '交通出行' }, { key: 'custom-food', name: '餐费' }, { key: 'supplement', name: '购买说明' }
  ] });
  assert.equal(reordered.workspace.categories[1].folderId, foodId);
  assert.deepEqual(received.at(-1), [{ key: 'travel', name: '交通出行', count: 1, amountCents: 0, pendingCount: 1 }, { key: 'custom-food', name: '餐费', count: 1, amountCents: 0, pendingCount: 1 }]);
  const travelAsset = f.library.snapshot().assets.find(item => item.folderId === reordered.workspace.categories[0].folderId && item.ext === 'pdf');
  await f.library.setTrash([travelAsset.id], true); await f.service.refresh(request);
  assert.deepEqual(received.at(-1), [{ key: 'custom-food', name: '餐费', count: 1, amountCents: 0, pendingCount: 1 }]);
  const removed = await f.service.saveCategories({ ...request, categories: [] });
  assert.deepEqual(removed.workspace.categories, []); assert.deepEqual(received.at(-1), []);
  assert.equal(removed.workspace.artifacts.supplementPdf.ready, false);
  assert.equal(f.library.snapshot().assets.find(item => item.id === populated.report.assetIds[0]).folderId, created.folderId);
  assert.equal((await fs.readFile(second)).toString(), '%PDF-food');
  await assert.rejects(f.service.importFiles({ ...request, category: 'custom-food', paths: [second] }), /分类不存在/);
});

test('invoice merging combines normal-category images and PDF pages, remembers layout and rejects stale exports', async t => {
  const { createReimbursementInvoicePdf } = require('../src/reimbursement-invoice-pdf.cjs');
  let pdfPages = [], received;
  const reader = { convert: async ({ outputDir }) => {
    const result = [];
    for (const [index, source] of pdfPages.entries()) {
      const target = path.join(outputDir, `${index + 1}.png`); await fs.copyFile(source, target);
      result.push({ path: target, pageNumber: index + 1 });
    }
    return result;
  } };
  const f = await fixture(t, { pdfReader: reader, invoicePdfBuilder: async options => { received = options.inputPaths; return createReimbursementInvoicePdf(options); } });
  const created = await f.create(), request = f.request(created.folderId), images = [];
  for (let index = 0; index < 5; index++) {
    const filename = path.join(f.base, `invoice-${index}.png`);
    await sharp({ create: { width: 120 + index, height: 80, channels: 3, background: ['#ee1111', '#22cc22', '#3344dd', '#eeee22', '#cc22cc'][index] } }).png().toFile(filename); images.push(filename);
  }
  pdfPages = images.slice(2, 4);
  const pdf = path.join(f.base, 'invoice.pdf'), other = path.join(f.base, 'notes.txt');
  await fs.writeFile(pdf, '%PDF-test'); await fs.writeFile(other, 'attachment');
  await f.service.importFiles({ ...request, category: 'travel', paths: [images[0], pdf] });
  await f.service.importFiles({ ...request, category: 'equipment', paths: [images[1], other] });
  await f.service.importFiles({ ...request, category: 'supplement', paths: [images[4]] });
  let view = await f.service.get(request);
  assert.equal(view.invoiceMerge.sourceCount, 3); assert.equal(view.invoiceMerge.unsupportedCount, 1);
  const merged = await f.service.mergeInvoices({ ...request, imagesPerPage: 2 });
  view = merged.workspace;
  assert.equal(view.invoiceMerge.imagesPerPage, 2); assert.equal(view.invoiceMerge.stale, false);
  const mergedId = view.artifacts.invoicePdf.assetId; assert.ok(mergedId);
  assert.equal(view.artifacts.invoicePdf.name, '测试申请人_2026年11月_报销发票汇总_4张_金额待核对');
  assert.equal(received.length, 3); assert.ok(!received.includes(images[4]));
  let output = await fs.readFile(f.library.getAssetPath(mergedId, 'original'));
  assert.equal((output.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 2);
  assert.equal((output.toString('latin1').match(/\/Subtype \/Image/g) || []).length, 4);
  f.saveTo(path.join(f.base, 'combined.pdf'));
  assert.equal((await f.service.exportArtifact({ ...request, kind: 'invoicePdf' })).saved, true);
  const changedImage = path.join(f.base, 'additional.png');
  await sharp({ create: { width: 70, height: 60, channels: 3, background: '#11bbaa' } }).png().toFile(changedImage);
  await f.service.importFiles({ ...request, category: 'membership', paths: [changedImage] });
  assert.equal((await f.service.get(request)).invoiceMerge.stale, true);
  await assert.rejects(f.service.exportArtifact({ ...request, kind: 'invoicePdf' }), /先一键合并/);
  view = (await f.service.mergeInvoices({ ...request, imagesPerPage: 1 })).workspace;
  assert.equal(view.artifacts.invoicePdf.assetId, mergedId); assert.equal(view.invoiceMerge.stale, false);
  output = await fs.readFile(f.library.getAssetPath(mergedId, 'original'));
  assert.equal((output.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 5);
  await f.service.shutdown();
  const reopened = createReimbursementService({ rootDir: path.join(f.base, 'reopen'), profilePath: f.profilePath, getLibrary: () => f.library, pdfReader: reader });
  try { const restored = await reopened.get(request); assert.equal(restored.invoiceMerge.imagesPerPage, 1); assert.equal(restored.invoiceMerge.stale, false); }
  finally { await reopened.shutdown(); }
  assert.equal((await fs.readFile(pdf)).toString(), '%PDF-test');
});

async function imageFixture(f, name, color) {
  const filename = path.join(f.base, `${name}.png`);
  await sharp({ create: { width: 120, height: 80, channels: 3, background: color } }).png().toFile(filename);
  return filename;
}

function invoiceReaders() {
  const documents = new Map(), texts = new Map(), ocrCalls = [];
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const pdfReader = { convert: async ({ inputPath, outputDir }) => {
    const pages = documents.get(digest(await fs.readFile(inputPath)));
    assert.ok(pages, 'the PDF reader should receive a registered, byte-preserved PDF');
    const result = [];
    for (const [index, page] of pages.entries()) {
      const filename = path.join(outputDir, `test-render-${crypto.randomUUID()}-${index + 1}.png`);
      await fs.copyFile(page.path, filename);
      result.push({ path: filename, pageNumber: index + 1, text: page.text || '', width: 120, height: 80 });
    }
    return result;
  } };
  const ocrEngine = { recognize: async ({ inputPath }) => {
    const data = await sharp(inputPath).removeAlpha().raw().toBuffer(), color = [...data.subarray(0, 3)].join(',');
    ocrCalls.push(color);
    return { text: texts.get(color) || '' };
  } };
  return { pdfReader, ocrEngine, ocrCalls,
    text: (color, text) => { texts.set(color, text); },
    pdf: async (f, name, pages) => {
      const filename = path.join(f.base, `${name}.pdf`);
      await require('../src/image-pdf.cjs').writeImagePdf({ inputPaths: pages.map(page => page.path), outputPath: filename });
      documents.set(digest(await fs.readFile(filename)), pages);
      return filename;
    }
  };
}

const worksheetCells = xml => new Map([...xml.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)].map(match => [/\br="([^"]+)"/.exec(match[0])[1], match[0]]));
const pdfCounts = bytes => ({ pages: (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, images: (bytes.toString('latin1').match(/\/Subtype \/Image/g) || []).length });

test('automatic amounts include image and multipage PDF invoices plus supplement invoices, with manual corrections and pending totals', { timeout: 20000 }, async t => {
  const readers = invoiceReaders();
  readers.text('255,0,0', '价税合计（小写）￥10.10');
  readers.text('0,0,255', '价税合计（小写）￥30.30');
  readers.text('255,0,255', '价税合计（小写）￥40.40');
  readers.text('128,128,128', 'Total Amount: CNY 60.60');
  readers.text('255,255,0', '实付款 ￥9999.99');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const regularImage = await imageFixture(f, 'regular', '#ff0000');
  const directPage = await imageFixture(f, 'direct-pdf-page', '#00ff00');
  const scanPage = await imageFixture(f, 'scanned-pdf-page', '#0000ff');
  const supplementImage = await imageFixture(f, 'supplement-invoice', '#ff00ff');
  const supplementPage = await imageFixture(f, 'supplement-pdf-page', '#00ffff');
  const pendingImage = await imageFixture(f, 'pending-invoice', '#808080');
  const evidence = await imageFixture(f, 'purchase-evidence', '#ffff00');
  const regularPdf = await readers.pdf(f, 'regular-bundle', [{ path: directPage, text: '价税合计（小写）￥20.20' }, { path: scanPage }]);
  const supplementPdf = await readers.pdf(f, 'supplement-bundle', [{ path: supplementPage, text: '价税合计（小写）￥50.50' }]);
  const originalBytes = new Map(await Promise.all([regularImage, regularPdf, supplementImage, supplementPdf, pendingImage, evidence].map(async filename => [filename, await fs.readFile(filename)])));
  const imported = await f.service.importFiles({ ...request, category: 'travel', paths: [regularImage, regularPdf] });
  const supplement = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [supplementImage, supplementPdf] });
  const pending = await f.service.importFiles({ ...request, category: 'other', paths: [pendingImage] });
  await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [evidence] });
  let view = await f.service.get(request);
  const travel = view.categories.find(item => item.key === 'travel'), missing = view.categories.find(item => item.key === 'other'), supplementCategory = view.categories.find(item => item.key === 'supplement');
  assert.equal(travel.invoiceCount, 3); assert.equal(travel.amountCents, 6060);
  assert.equal(supplementCategory.invoiceCount, 2); assert.equal(supplementCategory.amountCents, 9090);
  assert.equal(supplementCategory.invoiceItems.length, 2); assert.equal(supplementCategory.evidenceItems.length, 1);
  assert.equal(missing.amountCents, 0); assert.equal(missing.pendingCount, 1);
  assert.equal(view.amounts.totalCents, 15150); assert.equal(view.amounts.totalAmount, '151.50'); assert.equal(view.amounts.pendingCount, 1);
  assert.equal(view.amounts.items.length, 6);
  assert.equal(readers.ocrCalls.includes('0,255,0'), false, 'reliable PDF text avoids unnecessary OCR');
  assert.equal(readers.ocrCalls.includes('0,0,255'), true, 'scanned PDF pages use OCR');
  assert.equal(readers.ocrCalls.includes('255,255,0'), true, 'evidence screenshots have independent amount recognition');
  assert.equal(view.evidenceAmounts.totalCents, 999999);
  assert.equal(view.amounts.items.some(item => item.purpose === 'evidence'), false, 'evidence recognition never enters invoice totals');
  const stored = f.library.snapshot().assets;
  const pdfId = imported.report.assetIds.find(id => stored.find(asset => asset.id === id).ext === 'pdf');
  const imageId = imported.report.assetIds.find(id => stored.find(asset => asset.id === id).ext === 'png');
  const pendingId = pending.report.assetIds[0], pendingItem = view.amounts.items.find(item => item.assetId === pendingId);
  assert.equal(pendingItem.status, 'pending'); assert.equal(pendingItem.amountCents, null); assert.equal(pendingItem.detectedAmount, '60.60');
  assert.equal(stored.find(asset => asset.id === pdfId).reimbursementAmounts.pages.length, 2);
  const imageSupplement = stored.find(asset => supplement.report.assetIds.includes(asset.id) && asset.ext === 'png');
  assert.equal(imageSupplement.reimbursementSupplementInvoice, true);
  let cells = worksheetCells(await f.sheet(view.artifacts.form.assetId));
  assert.match(cells.get('G18'), /待核对/); assert.match(cells.get('B18'), /待核对/);
  assert.match(cells.get('G8'), /<v>60\.60<\/v>/); assert.match(cells.get('G10'), /<v>90\.90<\/v>/);
  view = (await f.service.setAmount({ ...request, assetId: pendingId, pageNumber: 1, amount: '61.23' })).workspace;
  assert.equal(view.amounts.totalCents, 21273); assert.equal(view.amounts.pendingCount, 0);
  view = (await f.service.setAmount({ ...request, assetId: pdfId, pageNumber: 2, excluded: true })).workspace;
  assert.equal(view.amounts.totalCents, 18243); assert.equal(view.amounts.items.find(item => item.assetId === pdfId && item.pageNumber === 2).status, 'excluded');
  assert.equal(view.amounts.items.find(item => item.assetId === pdfId && item.pageNumber === 2).amountCents, 0);
  assert.equal(view.categories.find(item => item.key === 'travel').invoiceCount, 2, 'excluded pages do not count as reimbursable invoices');
  view = (await f.service.setAmount({ ...request, assetId: imageId, pageNumber: 1, amount: '11.11' })).workspace;
  assert.equal(view.amounts.totalCents, 18344);
  view = await f.service.refresh(request);
  assert.equal(view.amounts.totalCents, 18344, 'forced recognition preserves manual values and exclusions');
  assert.equal(view.amounts.pendingCount, 0);
  cells = worksheetCells(await f.sheet(view.artifacts.form.assetId));
  assert.match(cells.get('G8'), /<v>31\.31<\/v>/); assert.match(cells.get('G9'), /<v>61\.23<\/v>/); assert.match(cells.get('G10'), /<v>90\.90<\/v>/);
  assert.match(cells.get('G18'), /<f>SUM\(G8:G17\)<\/f>/); assert.doesNotMatch(cells.get('G18'), /待核对/);
  for (const [filename, bytes] of originalBytes) assert.deepEqual(await fs.readFile(filename), bytes);
  assert.deepEqual(await fs.readdir(path.join(f.base, 'work')), []);
});

test('invoice identity duplicates across normal and supplement categories require confirmation or exclusion', { timeout: 20000 }, async t => {
  const readers = invoiceReaders(), invoiceNumber = '24312000000012345678';
  for (const color of ['255,0,0', '0,255,0', '0,0,255']) readers.text(color, `发票号码：${invoiceNumber}\n价税合计（小写）￥12.34`);
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const a = await imageFixture(f, 'invoice-first', '#ff0000'), b = await imageFixture(f, 'invoice-copy', '#00ff00'), c = await imageFixture(f, 'invoice-supplement-copy', '#0000ff');
  const first = await f.service.importFiles({ ...request, category: 'travel', paths: [a] });
  const second = await f.service.importFiles({ ...request, category: 'equipment', paths: [b] });
  const third = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [c] });
  let view = third.workspace;
  assert.equal(view.amounts.totalCents, 1234); assert.equal(view.amounts.pendingCount, 2);
  for (const id of [second.report.assetIds[0], third.report.assetIds[0]]) {
    const item = view.amounts.items.find(item => item.assetId === id);
    assert.equal(item.status, 'pending'); assert.equal(item.amountCents, null); assert.match(item.reason, /重复/);
  }
  const summaries = [first, second, third].map(result => f.library.snapshot().assets.find(asset => asset.id === result.report.assetIds[0]).reimbursementAmounts);
  assert.equal(new Set(summaries.map(summary => summary.pages[0].invoiceKey)).size, 1);
  assert.match(summaries[0].pages[0].invoiceKey, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(summaries).includes(invoiceNumber), false, 'only an invoice identity hash is stored');
  view = (await f.service.setAmount({ ...request, assetId: second.report.assetIds[0], pageNumber: 1, amount: '12.34' })).workspace;
  assert.equal(view.amounts.totalCents, 2468); assert.equal(view.amounts.pendingCount, 1);
  view = (await f.service.setAmount({ ...request, assetId: third.report.assetIds[0], pageNumber: 1, excluded: true })).workspace;
  assert.equal(view.amounts.totalCents, 2468); assert.equal(view.amounts.pendingCount, 0);
  view = await f.service.refresh(request);
  assert.equal(view.amounts.totalCents, 2468); assert.equal(view.amounts.pendingCount, 0);
  const before = f.library.snapshot();
  for (const requestPatch of [{ amount: '1.234', pageNumber: 1 }, { amount: '-1', pageNumber: 1 }, { amount: '1', pageNumber: 3 }]) {
    await assert.rejects(f.service.setAmount({ ...request, assetId: first.report.assetIds[0], ...requestPatch }), /有效金额|发票页/);
    assert.deepEqual(f.library.snapshot(), before);
  }
});

test('supplement evidence and invoice PDFs use separate inputs, layout scopes, IDs and safe exports', { timeout: 20000 }, async t => {
  const readers = invoiceReaders();
  for (const color of ['255,0,0', '0,255,0', '0,0,255', '255,0,255', '0,255,255', '100,120,140', '110,130,150']) readers.text(color, '价税合计（小写）￥1.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const regular = [await imageFixture(f, 'regular-one', '#ff0000'), await imageFixture(f, 'regular-two', '#00ff00')];
  const invoices = [await imageFixture(f, 'supplement-one', '#0000ff'), await imageFixture(f, 'supplement-two', '#ff00ff')];
  const pdfPages = [await imageFixture(f, 'supplement-pdf-one', '#00ffff'), await imageFixture(f, 'supplement-pdf-two', '#64788c')];
  const evidence = [await imageFixture(f, 'evidence-one', '#ffff00'), await imageFixture(f, 'evidence-two', '#ff8000')];
  const pdf = await readers.pdf(f, 'supplement-invoice', pdfPages.map(filename => ({ path: filename, text: '价税合计（小写）￥1.00' })));
  await f.service.importFiles({ ...request, category: 'travel', paths: regular });
  await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [...invoices, pdf] });
  await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: evidence });
  let view = await f.service.get(request);
  const evidenceId = view.artifacts.supplementPdf.assetId;
  assert.equal(view.invoiceMerge.sourceCount, 2); assert.equal(view.supplementInvoiceMerge.sourceCount, 3);
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(evidenceId))), { pages: 1, images: 2 });
  view = (await f.service.mergeInvoices({ ...request, imagesPerPage: 1 })).workspace;
  const regularId = view.artifacts.invoicePdf.assetId;
  view = (await f.service.mergeInvoices({ ...request, scope: 'supplement', imagesPerPage: 3 })).workspace;
  const invoiceId = view.artifacts.supplementInvoicePdf.assetId;
  assert.equal(new Set([evidenceId, regularId, invoiceId]).size, 3);
  assert.equal(view.artifacts.supplementInvoicePdf.name, '测试申请人_2026年11月_补票发票汇总_4张_合计4.00元');
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(regularId))), { pages: 2, images: 2 });
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(invoiceId))), { pages: 2, images: 4 });
  view = (await f.service.mergeInvoices({ ...request, imagesPerPage: 2 })).workspace;
  assert.equal(view.artifacts.invoicePdf.assetId, regularId); assert.equal(view.artifacts.supplementInvoicePdf.assetId, invoiceId);
  assert.equal(view.invoiceMerge.imagesPerPage, 2); assert.equal(view.supplementInvoiceMerge.imagesPerPage, 3);
  assert.equal(view.supplementInvoiceMerge.stale, false);
  for (const kind of ['invoicePdf', 'supplementInvoicePdf', 'supplementPdf']) {
    const destination = path.join(f.base, `${kind}-export.pdf`); f.saveTo(destination);
    assert.equal((await f.service.exportArtifact({ ...request, kind })).saved, true);
    assert.deepEqual(await fs.readFile(destination), await fs.readFile(f.library.getAssetPath(view.artifacts[kind].assetId)));
  }
  const extraEvidence = await imageFixture(f, 'evidence-three', '#ff9900');
  view = (await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [extraEvidence] })).workspace;
  assert.equal(view.invoiceMerge.stale, false); assert.equal(view.supplementInvoiceMerge.stale, false);
  assert.equal(view.artifacts.supplementPdf.assetId, evidenceId);
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(evidenceId))), { pages: 2, images: 3 });
  const extraInvoice = await imageFixture(f, 'supplement-three', '#6e8296');
  view = (await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [extraInvoice] })).workspace;
  assert.equal(view.invoiceMerge.stale, false); assert.equal(view.supplementInvoiceMerge.stale, true);
  await assert.rejects(f.service.exportArtifact({ ...request, kind: 'supplementInvoicePdf' }), /先一键合并/);
  view = (await f.service.mergeInvoices({ ...request, scope: 'supplement', imagesPerPage: 4 })).workspace;
  assert.equal(view.artifacts.supplementInvoicePdf.assetId, invoiceId); assert.equal(view.supplementInvoiceMerge.imagesPerPage, 4);
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(invoiceId))), { pages: 2, images: 5 });
  const root = f.library.snapshot().folders.find(folder => folder.id === created.folderId);
  assert.deepEqual(root.reimbursement.invoicePdfOptions, { imagesPerPage: 2 });
  assert.deepEqual(root.reimbursement.supplementInvoicePdfOptions, { imagesPerPage: 4 });
  assert.notEqual(root.reimbursement.invoicePdfSignature, root.reimbursement.supplementInvoicePdfSignature);
  assert.deepEqual(await fs.readdir(path.join(f.base, 'work')), []);
});

test('invoice changes during rendering cannot publish an outdated merged PDF', async t => {
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { invoicePdfBuilder: async ({ outputPath }) => { started(); await waiting; await fs.writeFile(outputPath, '%PDF-staged'); return { pages: 1, invoiceCount: 1, sourceCount: 1 }; } });
  t.after(() => release());
  const created = await f.create(), request = f.request(created.folderId);
  const first = path.join(f.base, 'one.png'), second = path.join(f.base, 'two.png');
  await sharp({ create: { width: 90, height: 60, channels: 3, background: '#bbaaaa' } }).png().toFile(first);
  await sharp({ create: { width: 91, height: 60, channels: 3, background: '#aabbbb' } }).png().toFile(second);
  await f.service.importFiles({ ...request, category: 'travel', paths: [first] });
  const merging = f.service.mergeInvoices({ ...request, imagesPerPage: 2 });
  const rejected = assert.rejects(merging, /合并期间发票发生变化/);
  await began;
  await f.library.importPaths([second], { folderId: created.workspace.categories.find(item => item.key === 'travel').folderId });
  release(); await rejected;
  assert.equal((await f.service.get(request)).artifacts.invoicePdf.ready, false);
});

test('invoice export refuses changes during the save dialog or copy and removes temporary output', async t => {
  let mode, source, destination;
  const f = await fixture(t, { chooseSavePath: async () => {
    if (mode === 'dialog') await fs.appendFile(source, '\nchanged');
    return { filePath: destination };
  } });
  const created = await f.create(), request = f.request(created.folderId);
  const image = path.join(f.base, 'receipt.png');
  await sharp({ create: { width: 95, height: 70, channels: 3, background: '#33aa66' } }).png().toFile(image);
  const imported = await f.service.importFiles({ ...request, category: 'travel', paths: [image] });
  source = f.library.getAssetPath(imported.report.assetIds[0], 'original');
  const originalBytes = await fs.readFile(source), copyFile = fs.copyFile;
  for (mode of ['dialog', 'copy']) {
    await fs.writeFile(source, originalBytes);
    await f.service.mergeInvoices({ ...request, imagesPerPage: 2 });
    destination = path.join(f.base, `${mode}.pdf`);
    try {
      if (mode === 'copy') fs.copyFile = async (from, to, ...rest) => {
        await copyFile(from, to, ...rest);
        if (String(to).startsWith(`${destination}.`) && String(to).endsWith('.tmp')) await fs.appendFile(source, '\nchanged');
      };
      await assert.rejects(f.service.exportArtifact({ ...request, kind: 'invoicePdf' }), /发票或排版已变化/);
    } finally { fs.copyFile = copyFile; }
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    assert.equal((await fs.readdir(f.base)).some(name => name.startsWith(`${mode}.pdf.`)), false);
  }
});

test('cancel reaches the screenshot PDF writer and leaves no partial generated document', { timeout: 10000 }, async t => {
  let entered, stopWriter, writerSignal;
  const writing = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { pdfWriter: async options => {
    writerSignal = options.signal;
    entered();
    await new Promise((resolve, reject) => {
      stopWriter = () => reject(Object.assign(new Error('screenshot PDF cancelled'), { name: 'AbortError' }));
      if (options.signal?.aborted) stopWriter();
      else options.signal?.addEventListener('abort', stopWriter, { once: true });
    });
  } });
  const created = await f.create(), request = f.request(created.folderId), image = await imageFixture(f, 'cancelled-evidence', '#123456');
  const importing = f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [image] });
  await writing;
  await f.service.cancel(request);
  if (!writerSignal?.aborted) stopWriter();
  const result = await importing;
  assert.ok(writerSignal instanceof AbortSignal, 'the writer needs the active reimbursement cancellation signal');
  assert.equal(writerSignal.aborted, true);
  assert.equal(result.workspace.artifacts.supplementPdf.ready, false);
  assert.match(result.workspace.message, /取消/);
  assert.deepEqual(await fs.readdir(path.join(f.base, 'work')), []);
  assert.equal(f.library.snapshot().assets.some(asset => asset.reimbursementGenerated?.kind === 'supplementPdf'), false);
});

test('a native image import during recognition receives a later automatic scan and cannot be skipped by the saved signature', { timeout: 10000 }, async t => {
  let begin, release, first = true;
  const started = new Promise(resolve => { begin = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { ocrEngine: { recognize: async ({ inputPath }) => {
    const pixel = await sharp(inputPath).removeAlpha().raw().toBuffer();
    if (first) { first = false; begin(); await blocked; }
    return { text: pixel[0] === 255 ? '价税合计（小写）￥10.00' : '价税合计（小写）￥20.00' };
  } } });
  const created = await f.create(), request = f.request(created.folderId);
  const initial = await imageFixture(f, 'initial-scan', '#ff0000'), added = await imageFixture(f, 'arriving-during-scan', '#00ff00');
  const importing = f.service.importFiles({ ...request, category: 'travel', paths: [initial] });
  await started;
  const folderId = created.workspace.categories.find(category => category.key === 'travel').folderId;
  const addedResult = await f.library.importPaths([added], { folderId });
  release(); await importing;
  const deadline = Date.now() + 6000;
  let view;
  while (Date.now() < deadline) {
    view = await f.service.get(request);
    if (view.amounts.totalCents === 3000 && view.amounts.pendingCount === 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(view.amounts.totalCents, 3000, 'the queued follow-up must include the image added after the first scan snapshot');
  assert.equal(view.amounts.pendingCount, 0);
  const newlyRecognized = f.library.snapshot().assets.find(asset => asset.id === addedResult.assetIds[0]);
  assert.equal(newlyRecognized.reimbursementAmounts.pages[0].amountCents, 2000);
});

async function activeFormCategories(f, assetId) {
  const { readMetadata } = require('../src/reimbursement-rows.cjs');
  const archive = readZip(await fs.readFile(f.library.getAssetPath(assetId)));
  return readMetadata(new Map(archive.entries.map(entry => [entry.name, entry]))).rows.filter(row => row.managed).map(row => row.key);
}

test('remove file trashes an ordinary invoice, updates totals and empty form rows, and preserves recoverable original bytes', { timeout: 15000 }, async t => {
  const readers = invoiceReaders();
  readers.text('255,0,0', '价税合计（小写）￥10.00'); readers.text('0,255,0', '价税合计（小写）￥20.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const first = await imageFixture(f, 'remove-normal-first', '#ff0000'), second = await imageFixture(f, 'remove-normal-second', '#00ff00');
  const firstImport = await f.service.importFiles({ ...request, category: 'travel', paths: [first] });
  const secondImport = await f.service.importFiles({ ...request, category: 'equipment', paths: [second] });
  const id = firstImport.report.assetIds[0], otherId = secondImport.report.assetIds[0], bytes = await fs.readFile(f.library.getAssetPath(id));
  const travel = created.workspace.categories.find(category => category.key === 'travel');
  const nested = (await f.library.createFolder('行程明细', travel.folderId)).folders.at(-1);
  await f.library.moveAssetsToFolder([id], nested.id);
  await f.service.refresh(request);
  const merged = (await f.service.mergeInvoices({ ...request, imagesPerPage: 2 })).workspace;
  assert.equal(merged.amounts.totalCents, 3000); assert.equal(merged.invoiceMerge.stale, false);
  assert.deepEqual(await activeFormCategories(f, merged.artifacts.form.assetId), ['travel', 'equipment']);
  const result = await f.service.removeFile({ ...request, category: 'travel', assetId: id });
  assert.equal(result.removed, true); assert.equal(result.syncError, undefined);
  assert.ok(result.snapshot.assets.find(asset => asset.id === id).trashedAt);
  assert.equal(result.snapshot.assets.find(asset => asset.id === otherId).trashedAt, null);
  assert.equal(result.workspace.amounts.totalCents, 2000);
  assert.equal(result.workspace.categories.find(category => category.key === 'travel').count, 0);
  assert.equal(result.workspace.invoiceMerge.sourceCount, 1); assert.equal(result.workspace.invoiceMerge.stale, true);
  assert.deepEqual(await activeFormCategories(f, result.workspace.artifacts.form.assetId), ['equipment']);
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), bytes);
  assert.deepEqual(await fs.readFile(first), bytes);
  await assert.rejects(f.service.exportArtifact({ ...request, kind: 'invoicePdf' }), /先一键合并/);
  await f.library.setTrash([id], false);
  const restored = await f.service.refresh(request);
  assert.equal(restored.amounts.totalCents, 3000);
  assert.equal(restored.categories.find(category => category.key === 'travel').count, 1);
  assert.deepEqual(await activeFormCategories(f, restored.artifacts.form.assetId), ['travel', 'equipment']);
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), bytes);
});

test('remove file rebuilds the screenshot PDF and retires it when the last evidence image is trashed', { timeout: 15000 }, async t => {
  const f = await fixture(t), created = await f.create(), request = f.request(created.folderId);
  const files = [await imageFixture(f, 'remove-evidence-one', '#ff0000'), await imageFixture(f, 'remove-evidence-two', '#00ff00'), await imageFixture(f, 'remove-evidence-three', '#0000ff')];
  const imported = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: files });
  const ids = imported.report.assetIds, generatedId = imported.workspace.artifacts.supplementPdf.assetId;
  const originals = await Promise.all(ids.map(id => fs.readFile(f.library.getAssetPath(id))));
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(generatedId))), { pages: 2, images: 3 });
  let result = await f.service.removeFile({ ...request, category: 'supplement', assetId: ids[0] });
  assert.equal(result.removed, true); assert.equal(result.workspace.artifacts.supplementPdf.assetId, generatedId);
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(generatedId))), { pages: 1, images: 2 });
  result = await f.service.removeFile({ ...request, category: 'supplement', assetId: ids[1] });
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(generatedId))), { pages: 1, images: 1 });
  result = await f.service.removeFile({ ...request, category: 'supplement', assetId: ids[2] });
  assert.equal(result.workspace.artifacts.supplementPdf.ready, false);
  assert.ok(result.snapshot.assets.find(asset => asset.id === generatedId).trashedAt);
  assert.equal(result.workspace.categories.find(category => category.key === 'supplement').evidenceItems.length, 0);
  assert.equal(result.workspace.amounts.totalCents, 0);
  for (const [index, id] of ids.entries()) assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), originals[index]);
  await f.library.setTrash([ids[0]], false);
  const restored = await f.service.refresh(request);
  assert.equal(restored.artifacts.supplementPdf.assetId, generatedId);
  assert.equal(restored.artifacts.supplementPdf.ready, true);
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(generatedId))), { pages: 1, images: 1 });
});

test('remove file decreases supplement invoice totals and invalidates only its merge scope', { timeout: 15000 }, async t => {
  const readers = invoiceReaders();
  readers.text('255,0,0', '价税合计（小写）￥10.00'); readers.text('0,0,255', '价税合计（小写）￥30.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const image = await imageFixture(f, 'remove-supplement-invoice', '#ff0000'), pdfPage = await imageFixture(f, 'remove-supplement-pdf-page', '#00ff00'), ordinary = await imageFixture(f, 'keep-ordinary-invoice', '#0000ff');
  const pdf = await readers.pdf(f, 'remove-supplement-pdf', [{ path: pdfPage, text: '价税合计（小写）￥20.00' }]);
  await f.service.importFiles({ ...request, category: 'travel', paths: [ordinary] });
  const imported = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [image, pdf] });
  const [imageId, pdfId] = imported.report.assetIds;
  const originals = await Promise.all([imageId, pdfId].map(id => fs.readFile(f.library.getAssetPath(id))));
  await f.service.mergeInvoices({ ...request, imagesPerPage: 2 });
  const merged = (await f.service.mergeInvoices({ ...request, scope: 'supplement', imagesPerPage: 2 })).workspace;
  assert.equal(merged.amounts.totalCents, 6000);
  let result = await f.service.removeFile({ ...request, category: 'supplement', assetId: imageId });
  assert.equal(result.workspace.amounts.totalCents, 5000);
  assert.equal(result.workspace.supplementInvoiceMerge.sourceCount, 1); assert.equal(result.workspace.supplementInvoiceMerge.stale, true);
  assert.equal(result.workspace.invoiceMerge.stale, false);
  await assert.rejects(f.service.exportArtifact({ ...request, kind: 'supplementInvoicePdf' }), /先一键合并/);
  result = await f.service.removeFile({ ...request, category: 'supplement', assetId: pdfId });
  assert.equal(result.workspace.amounts.totalCents, 3000);
  assert.equal(result.workspace.categories.find(category => category.key === 'supplement').invoiceCount, 0);
  assert.deepEqual(await activeFormCategories(f, result.workspace.artifacts.form.assetId), ['travel']);
  for (const [index, id] of [imageId, pdfId].entries()) assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), originals[index]);
  await f.library.setTrash([imageId, pdfId], false);
  const restored = await f.service.refresh(request);
  assert.equal(restored.amounts.totalCents, 6000); assert.equal(restored.categories.find(category => category.key === 'supplement').invoiceCount, 2);
});

test('remove file rejects stale ownership, another category, generated documents and already-trashed or invalid IDs without mutation', { timeout: 15000 }, async t => {
  const f = await fixture(t), created = await f.create(), request = f.request(created.folderId);
  const files = [await imageFixture(f, 'reject-keep-invoice', '#ff0000'), await imageFixture(f, 'reject-trashed-invoice', '#00ff00')];
  const imported = await f.service.importFiles({ ...request, category: 'travel', paths: files });
  const [id, trashedId] = imported.report.assetIds;
  const other = await f.service.create({ name: '其他报销项目', libraryRoot: f.library.root });
  const external = await imageFixture(f, 'outside-reimbursement', '#0000ff');
  const externalImport = await f.library.importPaths([external]);
  await f.library.setTrash([trashedId], true); await f.service.refresh(request);
  const before = f.library.snapshot(), index = await fs.readFile(f.library.indexPath);
  for (const patch of [
    { libraryRoot: path.join(f.base, 'other-library') }, { folderId: other.folderId }, { folderId: crypto.randomUUID() },
    { category: 'equipment' }, { category: 'missing-category' },
    { assetId: externalImport.assetIds[0] }, { assetId: created.workspace.artifacts.form.assetId }, { assetId: trashedId },
    { assetId: crypto.randomUUID() }, { assetId: null }, { assetId: {} }, { assetId: '../invalid' }
  ]) {
    await assert.rejects(f.service.removeFile({ ...request, category: 'travel', assetId: id, ...patch }));
    assert.deepEqual(f.library.snapshot(), before);
    assert.deepEqual(await fs.readFile(f.library.indexPath), index);
  }
  const travel = created.workspace.categories.find(category => category.key === 'travel');
  const generatedId = created.workspace.artifacts.form.assetId;
  await f.library.moveAssetsToFolder([generatedId], travel.folderId);
  const relocated = f.library.snapshot();
  await assert.rejects(f.service.removeFile({ ...request, category: 'travel', assetId: generatedId }), /已移动|不属于/);
  assert.deepEqual(f.library.snapshot(), relocated, 'generated documents stay protected even if the user moved one into the category');
});

test('remove file reports committed trash with a sync error when rebuilding the workbook fails', { timeout: 15000 }, async t => {
  const { createReimbursementWorkbook } = require('../src/reimbursement-workbook.cjs');
  let fail = false;
  const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥10.00');
  const f = await fixture(t, { ...readers, workbookBuilder: options => { if (fail) throw new Error('fixture workbook rebuild failed'); return createReimbursementWorkbook(options); } });
  const created = await f.create(), request = f.request(created.folderId), file = await imageFixture(f, 'remove-sync-failure', '#ff0000');
  const imported = await f.service.importFiles({ ...request, category: 'travel', paths: [file] });
  const id = imported.report.assetIds[0], original = await fs.readFile(f.library.getAssetPath(id));
  await f.service.mergeInvoices({ ...request, imagesPerPage: 2 });
  fail = true;
  const result = await f.service.removeFile({ ...request, category: 'travel', assetId: id });
  assert.equal(result.removed, true);
  assert.equal(typeof result.syncError, 'string'); assert.ok(result.syncError.length > 0);
  assert.ok(result.snapshot.assets.find(asset => asset.id === id).trashedAt);
  assert.ok(f.library.snapshot().assets.find(asset => asset.id === id).trashedAt);
  assert.equal(result.workspace.amounts.totalCents, 0); assert.equal(result.workspace.categories.find(category => category.key === 'travel').count, 0);
  assert.equal(result.workspace.invoiceMerge.stale, true);
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), original);
  fail = false;
  const refreshed = await f.service.refresh(request);
  assert.deepEqual(await activeFormCategories(f, refreshed.artifacts.form.assetId), []);
  assert.equal(refreshed.state, 'idle');
});

test('reimporting a trashed invoice restores the same ID into the selected category with its manual amount', { timeout: 15000 }, async t => {
  const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥10.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const file = await imageFixture(f, 'reimport-invoice', '#ff0000');
  const imported = await f.service.importFiles({ ...request, category: 'travel', paths: [file] });
  const id = imported.report.assetIds[0], createdAt = imported.snapshot.assets.find(asset => asset.id === id).createdAt;
  await f.service.setAmount({ ...request, assetId: id, pageNumber: 1, amount: '12.34' });
  await f.library.updateAssets([id], { notes: 'keep source notes', tags: ['invoice'], rating: 4 });
  const original = await fs.readFile(f.library.getAssetPath(id));
  await f.service.removeFile({ ...request, category: 'travel', assetId: id });
  const restored = await f.service.importFiles({ ...request, category: 'equipment', paths: [file] });
  assert.equal(restored.report.restored, 1); assert.equal(restored.report.imported, 0);
  assert.deepEqual(restored.report.restoredAssetIds, [id]);
  const asset = restored.snapshot.assets.find(item => item.id === id);
  assert.equal(asset.trashedAt, null); assert.equal(asset.createdAt, createdAt);
  assert.equal(asset.folderId, restored.workspace.categories.find(item => item.key === 'equipment').folderId);
  assert.equal(asset.notes, 'keep source notes'); assert.deepEqual(asset.tags, ['invoice']); assert.equal(asset.rating, 4);
  assert.equal(restored.workspace.amounts.totalCents, 1234);
  assert.equal(restored.workspace.amounts.items.find(item => item.assetId === id).status, 'manual');
  assert.deepEqual(await activeFormCategories(f, restored.workspace.artifacts.form.assetId), ['equipment']);
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), original);
  assert.equal(restored.snapshot.assets.filter(item => item.id === id).length, 1);
});

test('reimported supplement images adopt the current invoice or evidence purpose and keep one source record', { timeout: 15000 }, async t => {
  const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥10.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const file = await imageFixture(f, 'reimport-purpose', '#ff0000');
  const initial = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [file] });
  const id = initial.report.assetIds[0];
  assert.equal(initial.workspace.amounts.totalCents, 0); assert.equal(initial.workspace.artifacts.supplementPdf.ready, true);
  await f.service.removeFile({ ...request, category: 'supplement', assetId: id });
  const asInvoice = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [file] });
  assert.equal(asInvoice.report.restored, 1); assert.deepEqual(asInvoice.report.restoredAssetIds, [id]);
  assert.equal(asInvoice.snapshot.assets.find(item => item.id === id).reimbursementSupplementInvoice, true);
  assert.equal(asInvoice.workspace.categories.find(item => item.key === 'supplement').invoiceItems.length, 1);
  assert.equal(asInvoice.workspace.amounts.totalCents, 1000); assert.equal(asInvoice.workspace.artifacts.supplementPdf.ready, false);
  await f.service.removeFile({ ...request, category: 'supplement', assetId: id });
  const asEvidence = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [file] });
  assert.equal(asEvidence.report.restored, 1); assert.deepEqual(asEvidence.report.restoredAssetIds, [id]);
  assert.notEqual(asEvidence.snapshot.assets.find(item => item.id === id).reimbursementSupplementInvoice, true);
  assert.equal(asEvidence.workspace.categories.find(item => item.key === 'supplement').evidenceItems.length, 1);
  assert.equal(asEvidence.workspace.amounts.totalCents, 0); assert.equal(asEvidence.workspace.artifacts.supplementPdf.ready, true);
  assert.equal(asEvidence.snapshot.assets.filter(item => !item.reimbursementGenerated).length, 1);
});

test('an active duplicate stays in its existing category and does not change supplement purpose or count twice', { timeout: 15000 }, async t => {
  const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥10.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const file = await imageFixture(f, 'active-duplicate', '#ff0000');
  const initial = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [file] });
  const id = initial.report.assetIds[0], folderId = initial.snapshot.assets.find(item => item.id === id).folderId;
  for (const patch of [{ category: 'travel' }, { category: 'supplement', purpose: 'evidence' }]) {
    const duplicate = await f.service.importFiles({ ...request, ...patch, paths: [file] });
    assert.equal(duplicate.report.restored, 0); assert.equal(duplicate.report.imported, 0); assert.equal(duplicate.report.duplicates, 1);
    assert.deepEqual(duplicate.report.restoredAssetIds, []);
    assert.equal(duplicate.snapshot.assets.find(item => item.id === id).folderId, folderId);
    assert.equal(duplicate.snapshot.assets.find(item => item.id === id).reimbursementSupplementInvoice, true);
    assert.equal(duplicate.workspace.amounts.totalCents, 1000);
    assert.equal(duplicate.workspace.amounts.items.filter(item => item.assetId === id).length, 1);
  }
});

test('a trashed invoice can be reimported into another reimbursement folder without losing its source identity', { timeout: 15000 }, async t => {
  const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥10.00');
  const f = await fixture(t, readers), first = await f.create(), firstRequest = f.request(first.folderId);
  const file = await imageFixture(f, 'reimport-other-project', '#ff0000');
  const imported = await f.service.importFiles({ ...firstRequest, category: 'travel', paths: [file] });
  const id = imported.report.assetIds[0];
  await f.service.setAmount({ ...firstRequest, assetId: id, pageNumber: 1, amount: '15.50' });
  const before = f.library.snapshot().assets.find(item => item.id === id), original = await fs.readFile(f.library.getAssetPath(id));
  await f.service.removeFile({ ...firstRequest, category: 'travel', assetId: id });
  const second = await f.service.create({ name: '另一个报销夹', libraryRoot: f.library.root });
  const restored = await f.service.importFiles({ ...f.request(second.folderId), category: 'equipment', paths: [file] });
  assert.equal(restored.report.restored, 1); assert.deepEqual(restored.report.restoredAssetIds, [id]);
  const after = restored.snapshot.assets.find(item => item.id === id);
  assert.equal(after.createdAt, before.createdAt); assert.equal(after.filename, before.filename); assert.equal(after.hash, before.hash);
  assert.equal(after.folderId, restored.workspace.categories.find(item => item.key === 'equipment').folderId);
  assert.equal(after.trashedAt, null); assert.equal(restored.workspace.amounts.totalCents, 1550);
  const firstView = await f.service.refresh(firstRequest);
  assert.equal(firstView.amounts.totalCents, 0);
  assert.deepEqual(await activeFormCategories(f, firstView.artifacts.form.assetId), []);
  assert.deepEqual(await activeFormCategories(f, restored.workspace.artifacts.form.assetId), ['equipment']);
  assert.equal(restored.snapshot.assets.filter(item => !item.reimbursementGenerated).length, 1);
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), original);
});

test('native folder imports, trash, restore and moves synchronize the same reimbursement records through the index watcher', { timeout: 20000 }, async t => {
  const { createReimbursementWorkbook } = require('../src/reimbursement-workbook.cjs');
  const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥10.00');
  let builds = 0;
  const f = await fixture(t, { ...readers, workbookBuilder: options => { builds++; return createReimbursementWorkbook(options); } });
  const created = await f.create(), request = f.request(created.folderId), formId = created.workspace.artifacts.form.assetId;
  const category = key => created.workspace.categories.find(item => item.key === key).folderId;
  const nested = (await f.library.createFolder('原生子目录', category('travel'))).folders.at(-1).id;
  const waitFor = async predicate => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const view = await f.service.get(request);
      if (view.state !== 'generating' && !f.service.busy()) {
        try { if (await predicate(view)) return view; }
        catch (error) {
          // A watcher generation can begin after the idle check. Only retry
          // the brief missing-path interval of its atomic document replacement.
          if (error.code !== 'ENOENT') throw error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail('the index watcher did not synchronize the native folder edit');
  };
  const source = await imageFixture(f, 'native-folder-invoice', '#ff0000'), bytes = await fs.readFile(source);
  const imported = await f.library.importPaths([source], { folderId: nested, restoreTrashed: true }), id = imported.assetIds[0];
  await waitFor(async view => view.amounts.totalCents === 1000 && (await activeFormCategories(f, formId)).join(',') === 'travel');
  await f.library.setTrash([id], true);
  await waitFor(async view => view.amounts.totalCents === 0 && (await activeFormCategories(f, formId)).length === 0);
  const restored = await f.library.importPaths([source], { folderId: category('equipment'), restoreTrashed: true });
  assert.deepEqual(restored.restoredAssetIds, [id]); assert.equal(restored.assetIds.length, 0);
  await waitFor(async view => view.amounts.totalCents === 1000 && (await activeFormCategories(f, formId)).join(',') === 'equipment');
  await f.library.moveAssetsToFolder([id], nested);
  await waitFor(async view => view.amounts.totalCents === 1000 && (await activeFormCategories(f, formId)).join(',') === 'travel');
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), bytes);
  assert.equal(f.library.snapshot().assets.filter(asset => !asset.reimbursementGenerated && asset.hash === crypto.createHash('sha256').update(bytes).digest('hex')).length, 1);
  const screenshot = await imageFixture(f, 'native-folder-evidence', '#00ff00');
  const evidence = await f.library.importPaths([screenshot], { folderId: category('supplement'), restoreTrashed: true });
  const ready = await waitFor(view => view.artifacts.supplementPdf.ready && view.categories.find(item => item.key === 'supplement').evidenceItems.length === 1);
  const pdfId = ready.artifacts.supplementPdf.assetId;
  await f.library.setTrash(evidence.assetIds, true);
  await waitFor(view => !view.artifacts.supplementPdf.ready);
  const recovered = await f.library.importPaths([screenshot], { folderId: category('supplement'), restoreTrashed: true });
  assert.deepEqual(recovered.restoredAssetIds, evidence.assetIds);
  await waitFor(view => view.artifacts.supplementPdf.ready && view.artifacts.supplementPdf.assetId === pdfId);
  const settledBuilds = builds;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(builds, settledBuilds, 'generated-file index writes and read-only reloads must not cause a regeneration loop');
  assert.equal((await f.service.get(request)).amounts.totalCents, 1000);
});

test('purchase screenshot amounts are recognized and corrected independently without entering the workbook or invoice total', { timeout: 20000 }, async t => {
  const readers = invoiceReaders();
  readers.text('255,0,0', '商品金额 ￥200.00\n优惠 ￥71.20\n实付款 ￥128.80');
  readers.text('0,0,255', '价税合计（小写）￥98.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const screenshot = await imageFixture(f, 'purchase-reference', '#ff0000');
  const imported = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [screenshot] });
  const id = imported.report.assetIds[0], formId = imported.workspace.artifacts.form.assetId;
  let view = imported.workspace;
  assert.equal(view.evidenceAmounts.totalCents, 12880);
  assert.equal(view.evidenceAmounts.items[0].purpose, 'evidence');
  assert.equal(view.evidenceAmounts.items[0].status, 'recognized');
  assert.equal(view.amounts.totalCents, 0); assert.equal(view.amounts.items.length, 0);
  assert.deepEqual(await activeFormCategories(f, formId), []);
  const asset = f.library.snapshot().assets.find(asset => asset.id === id);
  assert.equal(asset.reimbursementAmounts, undefined);
  assert.equal(asset.reimbursementEvidenceAmounts.pages[0].amountCents, 12880);
  const invoice = await imageFixture(f, 'actual-supplement-invoice', '#0000ff');
  view = (await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [invoice] })).workspace;
  assert.equal(view.amounts.totalCents, 9800); assert.equal(view.evidenceAmounts.totalCents, 12880);
  const workbookBefore = await fs.readFile(f.library.getAssetPath(formId));
  view = (await f.service.setAmount({ ...request, purpose: 'evidence', assetId: id, pageNumber: 1, amount: '120.05' })).workspace;
  assert.equal(view.evidenceAmounts.totalCents, 12005); assert.equal(view.amounts.totalCents, 9800);
  assert.equal(view.evidenceAmounts.items[0].status, 'manual');
  assert.deepEqual(await fs.readFile(f.library.getAssetPath(formId)), workbookBefore, 'reference edits cannot change the reimbursement workbook');
  view = await f.service.refresh(request);
  assert.equal(view.evidenceAmounts.totalCents, 12005, 'forced OCR preserves a confirmed reference amount');
  view = (await f.service.setAmount({ ...request, purpose: 'evidence', assetId: id, pageNumber: 1, excluded: true })).workspace;
  assert.equal(view.evidenceAmounts.totalCents, 0); assert.equal(view.evidenceAmounts.pendingCount, 0);
  assert.equal(view.evidenceAmounts.items[0].status, 'excluded'); assert.equal(view.amounts.totalCents, 9800);
  view = (await f.service.setAmount({ ...request, purpose: 'evidence', assetId: id, pageNumber: 1, amount: '128.80' })).workspace;
  assert.equal(view.evidenceAmounts.totalCents, 12880); assert.equal(view.amounts.totalCents, 9800);
});

test('unreadable screenshot amount stays pending while printing and a zero reimbursement form remain available', async t => {
  const f = await fixture(t), created = await f.create(), request = f.request(created.folderId);
  const screenshot = await imageFixture(f, 'unreadable-reference', '#22aa66');
  let result = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [screenshot] });
  const id = result.report.assetIds[0];
  assert.equal(result.workspace.evidenceAmounts.pendingCount, 1);
  assert.equal(result.workspace.evidenceAmounts.items[0].amountCents, null);
  assert.equal(result.workspace.amounts.pendingCount, 0); assert.equal(result.workspace.amounts.totalCents, 0);
  assert.equal(result.workspace.artifacts.supplementPdf.ready, true);
  assert.deepEqual(await activeFormCategories(f, result.workspace.artifacts.form.assetId), []);
  result = await f.service.setAmount({ ...request, purpose: 'evidence', assetId: id, pageNumber: 1, amount: '15.20' });
  assert.equal(result.workspace.evidenceAmounts.totalCents, 1520);
  await f.service.removeFile({ ...request, category: 'supplement', assetId: id });
  assert.equal((await f.service.get(request)).evidenceAmounts.items.length, 0);
  result = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [screenshot] });
  assert.deepEqual(result.report.restoredAssetIds, [id]);
  assert.equal(result.workspace.evidenceAmounts.totalCents, 1520);
  assert.equal(result.workspace.amounts.totalCents, 0);
});

test('amount editing rejects the wrong purpose and evidence data survives a library reopen', async t => {
  const f = await fixture(t), created = await f.create(), request = f.request(created.folderId);
  const screenshot = await imageFixture(f, 'reference-role', '#448822');
  const imported = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [screenshot] });
  const id = imported.report.assetIds[0], change = { ...request, assetId: id, pageNumber: 1, amount: '56.78' };
  await assert.rejects(f.service.setAmount(change), /发票.*移动或删除/);
  await assert.rejects(f.service.setAmount({ ...change, purpose: 'unknown' }), /用途无效/);
  await f.service.setAmount({ ...change, purpose: 'evidence' });
  const reopened = new Library({ root: f.library.root }); await reopened.init();
  assert.equal(reopened.snapshot().assets.find(asset => asset.id === id).reimbursementEvidenceAmounts.pages[0].amountCents, 5678);
  const invoice = await imageFixture(f, 'invoice-role', '#1188bb');
  const invoiceResult = await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [invoice] });
  await assert.rejects(f.service.setAmount({ ...change, purpose: 'evidence', assetId: invoiceResult.report.assetIds[0] }), /截图.*移动或删除/);
});

test('nested reimbursement workspaces cannot leak invoices or evidence into their parent while ordinary subfolders remain owned', { timeout: 30000 }, async t => {
  const f = await fixture(t), outer = await f.create(), request = f.request(outer.folderId);
  const category = key => outer.workspace.categories.find(item => item.key === key).folderId;
  const firstInner = await f.service.create({ name: '普通分类内的独立报销', parentId: category('travel'), libraryRoot: f.library.root });
  const secondInner = await f.service.create({ name: '补票分类内的独立报销', parentId: category('supplement'), libraryRoot: f.library.root });
  const invoiceSummary = async (id, cents) => ({ version: 1, sourceHash: crypto.createHash('sha256').update(await fs.readFile(f.library.getAssetPath(id))).digest('hex'),
    pages: [{ pageNumber: 1, amountCents: cents, detectedCents: null, status: 'manual', confidence: 'none', reason: '已手动核对' }] });
  const innerEvidenceIds = [];
  for (const [index, inner] of [firstInner, secondInner].entries()) {
    const screenshot = await imageFixture(f, `nested-evidence-${index}`, index ? '#00ff00' : '#ff0000');
    const added = await f.service.importFiles({ ...f.request(inner.folderId), category: 'supplement', purpose: 'evidence', paths: [screenshot] });
    const id = added.report.assetIds[0]; innerEvidenceIds.push(id);
    await f.service.setAmount({ ...f.request(inner.folderId), purpose: 'evidence', assetId: id, pageNumber: 1, amount: index ? '9.99' : '8.88' });
    // A previous invoice-role decision must not leak when the current role is evidence.
    await f.library.setReimbursementAmounts(id, await invoiceSummary(id, index ? 22222 : 12345));
  }
  const innerInvoice = await imageFixture(f, 'nested-real-invoice', '#0000ff');
  const invoiceImport = await f.service.importFiles({ ...f.request(firstInner.folderId), category: 'equipment', paths: [innerInvoice] });
  const innerInvoiceId = invoiceImport.report.assetIds[0];
  await f.service.setAmount({ ...f.request(firstInner.folderId), assetId: innerInvoiceId, pageNumber: 1, amount: '50.00' });
  const ordinaryChild = (await f.library.createFolder('普通明细子目录', category('travel'))).folders.at(-1).id;
  const ordinaryEvidenceChild = (await f.library.createFolder('普通购买截图子目录', category('supplement'))).folders.at(-1).id;
  const ownInvoice = await imageFixture(f, 'parent-real-invoice', '#ffff00'), ownEvidence = await imageFixture(f, 'parent-real-evidence', '#ff00ff');
  const ownInvoiceId = (await f.library.importPaths([ownInvoice], { folderId: ordinaryChild })).assetIds[0];
  const ownEvidenceId = (await f.library.importPaths([ownEvidence], { folderId: ordinaryEvidenceChild })).assetIds[0];
  await f.library.setReimbursementAmounts(ownInvoiceId, await invoiceSummary(ownInvoiceId, 2500));
  await f.library.setReimbursementEvidenceAmounts(ownEvidenceId, await invoiceSummary(ownEvidenceId, 700));
  const view = await f.service.refresh(request);
  assert.equal(view.amounts.totalCents, 2500);
  assert.deepEqual(view.amounts.items.map(item => item.assetId), [ownInvoiceId]);
  assert.equal(view.evidenceAmounts.totalCents, 700);
  assert.deepEqual(view.evidenceAmounts.items.map(item => item.assetId), [ownEvidenceId]);
  assert.equal(view.invoiceMerge.sourceCount, 1); assert.equal(view.supplementInvoiceMerge.sourceCount, 0);
  assert.deepEqual(view.categories.find(item => item.key === 'travel').items.map(item => item.id), [ownInvoiceId]);
  assert.deepEqual(view.categories.find(item => item.key === 'supplement').items.map(item => item.id), [ownEvidenceId]);
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(view.artifacts.supplementPdf.assetId))), { pages: 1, images: 1 });
  const merged = (await f.service.mergeInvoices({ ...request, imagesPerPage: 2 })).workspace;
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(merged.artifacts.invoicePdf.assetId))), { pages: 1, images: 1 });
  for (const [assetId, categoryKey] of [[innerEvidenceIds[0], 'travel'], [innerInvoiceId, 'travel'], [innerEvidenceIds[1], 'supplement']]) {
    await assert.rejects(f.service.removeFile({ ...request, category: categoryKey, assetId }), /不属于当前报销分类|已移动/);
    assert.equal(f.library.snapshot().assets.find(asset => asset.id === assetId).trashedAt, null);
  }
  await assert.rejects(f.service.setAmount({ ...request, purpose: 'evidence', assetId: innerEvidenceIds[1], pageNumber: 1, amount: '1.00' }), /已移动或删除/);
  assert.equal((await f.service.get(f.request(firstInner.folderId))).amounts.totalCents, 5000);
  assert.equal((await f.service.get(f.request(firstInner.folderId))).evidenceAmounts.totalCents, 888);
  assert.equal((await f.service.get(f.request(secondInner.folderId))).evidenceAmounts.totalCents, 999);
  const removed = await f.service.removeFile({ ...request, category: 'travel', assetId: ownInvoiceId });
  assert.equal(removed.removed, true); assert.equal(removed.workspace.amounts.totalCents, 0);
  assert.deepEqual(await activeFormCategories(f, removed.workspace.artifacts.form.assetId), []);
  const removedEvidence = await f.service.removeFile({ ...request, category: 'supplement', assetId: ownEvidenceId });
  assert.equal(removedEvidence.removed, true); assert.equal(removedEvidence.workspace.artifacts.supplementPdf.ready, false);
});

test('itinerary images and PDFs automatically merge into independent A4 pages without OCR or reimbursement amounts', async t => {
  const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥9999.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  assert.equal(created.workspace.itinerary.count, 0); assert.equal(created.workspace.categories.length, 5);
  const picture = await imageFixture(f, 'trip-picture', '#ff0000');
  const pages = [await imageFixture(f, 'trip-p1', '#00ff00'), await imageFixture(f, 'trip-p2', '#0000ff')];
  const pdf = await readers.pdf(f, 'trip-list', pages.map(path => ({ path, text: '支付金额 ￥100.00' })));
  let result = await f.service.importFiles({ ...request, purpose: 'itinerary', paths: [picture, pdf] });
  const id = result.report.assetIds[0], artifact = result.workspace.artifacts.itineraryPdf;
  assert.equal(result.workspace.itinerary.count, 2); assert.equal(artifact.ready, true);
  assert.equal(artifact.name, '测试申请人_2026年11月_打车行程单_3页');
  assert.deepEqual(pdfCounts(await fs.readFile(f.library.getAssetPath(artifact.assetId))), { pages: 3, images: 3 });
  assert.equal(result.workspace.amounts.totalCents, 0); assert.equal(result.workspace.amounts.items.length, 0);
  assert.equal(result.workspace.evidenceAmounts.items.length, 0); assert.deepEqual(readers.ocrCalls, []);
  assert.deepEqual(await activeFormCategories(f, result.workspace.artifacts.form.assetId), []);
  await assert.rejects(f.service.setAmount({ ...request, assetId: id, pageNumber: 1, amount: '100.00' }), /发票已移动或删除/);
  result = await f.service.removeFile({ ...request, purpose: 'itinerary', assetId: id });
  assert.equal(result.workspace.itinerary.count, 1);
  result = await f.service.importFiles({ ...request, purpose: 'itinerary', paths: [picture] });
  assert.deepEqual(result.report.restoredAssetIds, [id]); assert.equal(result.workspace.itinerary.count, 2);
  f.saveTo(path.join(f.base, 'trip-export.pdf'));
  assert.equal((await f.service.exportArtifact({ ...request, kind: 'itineraryPdf' })).saved, true);
  assert.deepEqual(await fs.readFile(path.join(f.base, 'trip-export.pdf')), await fs.readFile(f.library.getAssetPath(artifact.assetId)));
});

test('export all creates one named folder with the form and every applicable PDF and refreshes stale merges', { timeout: 20000 }, async t => {
  const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥10.00'); readers.text('0,255,0', '价税合计（小写）￥5.00'); readers.text('0,0,255', '实付款 ￥80.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const regular = await imageFixture(f, 'export-regular', '#ff0000'), invoice = await imageFixture(f, 'export-supplement', '#00ff00');
  const screenshot = await imageFixture(f, 'export-reference', '#0000ff'), trip = await imageFixture(f, 'export-trip', '#ffffff');
  await f.service.importFiles({ ...request, category: 'travel', paths: [regular] });
  await f.service.importFiles({ ...request, category: 'supplement', purpose: 'invoice', paths: [invoice] });
  await f.service.importFiles({ ...request, category: 'supplement', purpose: 'evidence', paths: [screenshot] });
  await f.service.importFiles({ ...request, purpose: 'itinerary', paths: [trip] });
  const output = path.join(f.base, 'exports'); await fs.mkdir(output); f.exportAllTo(output);
  const first = await f.service.exportAll(request);
  assert.equal(first.saved, true); assert.equal(first.count, 5); assert.equal(path.basename(first.path), '测试申请人_2026年11月_报销资料');
  const names = await fs.readdir(first.path);
  assert.equal(names.filter(name => name.endsWith('.pdf')).length, 4); assert.equal(names.filter(name => name.endsWith('.xlsx')).length, 1);
  assert.ok(names.filter(name => name.endsWith('.pdf')).every(name => name.startsWith('测试申请人_2026年11月_')));
  assert.ok(names.includes('测试申请人_2026年11月_报销发票汇总_1张_合计10.00元.pdf'));
  assert.ok(names.includes('测试申请人_2026年11月_补票发票汇总_1张_合计5.00元.pdf'));
  assert.ok(names.includes('测试申请人_2026年11月_购买截图说明_1张.pdf'));
  const before = await Promise.all(names.map(name => fs.readFile(path.join(first.path, name))));
  readers.text('255,255,0', '价税合计（小写）￥3.00');
  await f.service.importFiles({ ...request, category: 'travel', paths: [await imageFixture(f, 'export-extra', '#ffff00')] });
  assert.equal((await f.service.get(request)).invoiceMerge.stale, true);
  const second = await f.service.exportAll(request);
  assert.equal(path.basename(second.path), '测试申请人_2026年11月_报销资料（2）');
  assert.ok((await fs.readdir(second.path)).includes('测试申请人_2026年11月_报销发票汇总_2张_合计13.00元.pdf'));
  assert.equal((await f.service.get(request)).invoiceMerge.stale, false);
  for (let index = 0; index < names.length; index++) assert.deepEqual(await fs.readFile(path.join(first.path, names[index])), before[index]);
  f.setDate(new Date('2027-01-03T00:00:00Z')); await f.service.saveProfile({ ...f.profile, applicant: '新申请人' });
  const third = await f.service.exportAll(request);
  assert.equal(path.basename(third.path), '新申请人_2027年1月_报销资料');
  assert.ok((await fs.readdir(third.path)).filter(name => name.endsWith('.pdf')).every(name => name.startsWith('新申请人_2027年1月_')));
  assert.equal((await f.service.get(request)).amounts.totalCents, 1800);
});

test('export all with empty optional sections exports only the form and cancellation writes nothing', async t => {
  const f = await fixture(t), created = await f.create(), request = f.request(created.folderId);
  assert.deepEqual(await f.service.exportAll(request), { saved: false, cancelled: true });
  const output = path.join(f.base, 'exports'); await fs.mkdir(output); f.exportAllTo(output);
  const result = await f.service.exportAll(request);
  assert.equal(result.count, 1); assert.equal((await fs.readdir(result.path))[0].endsWith('.xlsx'), true);
});

test('profile saves retry brief Windows file locks without deleting the existing settings', async t => {
  const f = await fixture(t); await f.service.saveProfile(f.profile);
  const original = fs.rename; let attempts = 0;
  fs.rename = async (source, target) => {
    if (target === f.profilePath && attempts++ < 2) throw Object.assign(new Error('brief file lock'), { code: 'EPERM' });
    return original(source, target);
  };
  try { await f.service.saveProfile({ ...f.profile, applicant: '更新申请人' }); }
  finally { fs.rename = original; }
  assert.equal(attempts, 3);
  assert.equal((await f.service.getProfile()).applicant, '更新申请人');
  assert.equal(JSON.parse(await fs.readFile(f.profilePath, 'utf8')).applicant, '更新申请人');
});

test('export all cannot publish stale files when a native import lands at the end of invoice merging', { timeout: 20000 }, async t => {
  const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥10.00'); readers.text('0,255,0', '价税合计（小写）￥20.00');
  const f = await fixture(t, readers), created = await f.create(), request = f.request(created.folderId);
  const first = await imageFixture(f, 'export-race-first', '#ff0000'), second = await imageFixture(f, 'export-race-second', '#00ff00');
  await f.service.importFiles({ ...request, category: 'travel', paths: [first] });
  const categoryId = (await f.service.get(request)).categories.find(item => item.key === 'travel').folderId;
  const output = path.join(f.base, 'exports'); await fs.mkdir(output); f.exportAllTo(output);
  const original = f.library.setReimbursementInvoiceSignature.bind(f.library);
  let imported = false, result, failure;
  f.library.setReimbursementInvoiceSignature = async (...args) => {
    const saved = await original(...args);
    // The ordinary library import is independent of the service queue. Place it
    // after the merge freshness check but before exportAll captures its inputs.
    if (!imported && args[0] === created.folderId && (args[2] || 'regular') === 'regular') {
      imported = true;
      await f.library.importPaths([second], { folderId: categoryId });
    }
    return saved;
  };
  try { result = await f.service.exportAll(request); }
  catch (error) { failure = error; }
  finally { f.library.setReimbursementInvoiceSignature = original; }
  assert.equal(imported, true, 'the concurrent native import must occur during the merge');
  if (failure) {
    assert.match(failure.message, /变化|重新|过期|同步/);
    return;
  }
  assert.equal(result.saved, true);
  const names = await fs.readdir(result.path), invoices = names.filter(name => name.includes('报销发票汇总'));
  assert.equal(invoices.length, 1);
  assert.deepEqual(pdfCounts(await fs.readFile(path.join(result.path, invoices[0]))), { pages: 2, images: 2 }, 'a successful export must include the concurrently imported invoice');
  assert.match(invoices[0], /_2张_合计30\.00元\.pdf$/);
  const view = await f.service.get(request);
  assert.equal(view.invoiceMerge.stale, false); assert.equal(view.amounts.totalCents, 3000);
});

test('export all restores trashed generated invoice PDFs and exports every applicable scope', { timeout: 20000 }, async t => {
  for (const scope of ['regular', 'supplement']) await t.test(scope, async child => {
    const readers = invoiceReaders(); readers.text('255,0,0', '价税合计（小写）￥10.00');
    const f = await fixture(child, readers), created = await f.create(), request = f.request(created.folderId);
    const source = await imageFixture(f, `trashed-export-${scope}`, '#ff0000');
    await f.service.importFiles({ ...request, category: scope === 'regular' ? 'travel' : 'supplement', purpose: 'invoice', paths: [source] });
    const merged = (await f.service.mergeInvoices({ ...request, scope })).workspace;
    const kind = scope === 'regular' ? 'invoicePdf' : 'supplementInvoicePdf', id = merged.artifacts[kind].assetId;
    const originalBytes = await fs.readFile(f.library.getAssetPath(id));
    await f.library.setTrash([id], true);
    assert.equal((await f.service.get(request)).artifacts[kind].ready, false);
    const output = path.join(f.base, 'exports'); await fs.mkdir(output); f.exportAllTo(output);
    const result = await f.service.exportAll(request);
    assert.equal(result.saved, true); assert.equal(result.count, 2, 'the form and applicable invoice PDF must both be exported');
    const names = await fs.readdir(result.path), pdf = names.find(name => name.endsWith('.pdf'));
    assert.equal(names.length, 2); assert.ok(names.some(name => name.endsWith('.xlsx'))); assert.ok(pdf);
    assert.deepEqual(pdfCounts(await fs.readFile(path.join(result.path, pdf))), { pages: 1, images: 1 });
    const view = await f.service.get(request);
    assert.equal(view.artifacts[kind].ready, true); assert.equal(view.artifacts[kind].assetId, id);
    assert.equal(f.library.snapshot().assets.find(asset => asset.id === id).trashedAt, null);
    assert.deepEqual(await fs.readFile(f.library.getAssetPath(id)), originalBytes);
  });
});
