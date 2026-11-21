'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { createImagePlugins, CATALOG, sanitizeOptions } = require('../src/image-plugins.cjs');
const { createOcrEngine } = require('../src/image-ocr.cjs');

async function fixture(t, overrides = {}) {
  const parent = path.resolve(__dirname, '../.recovery/tests');
  await fs.mkdir(parent, { recursive: true });
  const base = await fs.mkdtemp(path.join(parent, 'document-plugins-'));
  const library = new Library({ root: path.join(base, 'library'), createThumbnail: async (input, output) => {
    const bytes = await fs.readFile(input), metadata = await sharp(bytes).metadata();
    await sharp(bytes).resize(20, 20).jpeg().toFile(output);
    return { width: metadata.width, height: metadata.height };
  } });
  await library.init();
  const assets = [];
  for (const [name, color] of [['中文文字', '#ddeeff'], ['第二页', '#66bb33']]) {
    const filename = path.join(base, `${name}.png`);
    await sharp({ create: { width: 32, height: 24, channels: 4, background: color } }).png().toFile(filename);
    const report = await library.importPaths([filename]);
    assets.push(library.snapshot().assets.find(asset => asset.id === report.assetIds[0]));
  }
  let current = library, chosen, copied, revealed;
  const events = [];
  const service = createImagePlugins({ rootDir: path.join(base, 'plugins'), getLibrary: () => current,
    aiEngine: { status: async () => ({ tools: {}, devices: [] }) },
    ocrEngine: { status: async () => ({ ready: true, languages: [{ tag: 'zh-Hans-CN', name: '中文' }] }), recognize: async () => ({ text: '测试文字\nHello', language: 'zh-Hans-CN' }) },
    chooseSavePath: async () => chosen, copyText: value => { copied = value; }, revealFile: value => { revealed = value; },
    onEvent: event => events.push(event), ...overrides });
  t.after(async () => {
    await service.shutdown();
    const relative = path.relative(parent, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  async function run(pluginId, options = {}, ids = assets.map(a => a.id)) {
    return service.run({ pluginId, options, assetIds: ids, libraryRoot: library.root });
  }
  async function completed(jobId) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const event = events.find(event => event.jobId === jobId && ['complete', 'error'].includes(event.type));
      if (event) return event;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Plugin job timed out');
  }
  return { base, library, assets, service, events, run, completed, choose: value => { chosen = value; }, copied: () => copied, revealed: () => revealed, changeLibrary: value => { current = value; } };
}

test('document plugins validate language and PDF options', () => {
  assert.ok(CATALOG.some(p => p.id === 'extract-text'));
  assert.ok(CATALOG.some(p => p.id === 'image-to-pdf'));
  assert.deepEqual(sanitizeOptions('extract-text'), { language: 'auto' });
  assert.deepEqual(sanitizeOptions('image-to-pdf'), { pageSize: 'image', orientation: 'auto', margin: 0 });
  assert.throws(() => sanitizeOptions('extract-text', { language: '../run' }), /语言/);
  assert.throws(() => sanitizeOptions('image-to-pdf', { pageSize: 'letter' }), /尺寸/);
  assert.throws(() => sanitizeOptions('image-to-pdf', { orientation: 'sideways' }), /方向/);
  assert.throws(() => sanitizeOptions('image-to-pdf', { margin: 101 }), /页边距/);
});

test('OCR returns per-image text, copies/saves UTF-8, and leaves source assets unchanged', async t => {
  const f = await fixture(t);
  await f.service.install('extract-text');
  const before = JSON.stringify(f.library.snapshot().assets);
  const event = await f.completed((await f.run('extract-text')).jobId);
  assert.equal(event.type, 'complete'); assert.equal(event.results.length, 2);
  assert.deepEqual(event.results.map(result => result.sourceId), f.assets.map(a => a.id));
  assert.equal(JSON.stringify(f.library.snapshot().assets), before);
  assert.deepEqual(await f.service.copyText(event.jobId), { copied: true });
  assert.match(f.copied(), /【中文文字】\r\n测试文字\nHello/);
  f.choose({ filePath: path.join(f.base, '文字.txt') });
  const saved = await f.service.saveText(event.jobId);
  assert.equal(saved.saved, true);
  assert.equal(await fs.readFile(saved.path, 'utf8'), `\uFEFF${f.copied()}`);
  assert.deepEqual(await fs.readdir(path.join(f.base, 'plugins/jobs')), []);
  f.choose({ canceled: true });
  assert.equal((await f.service.saveText(event.jobId)).cancelled, true);
  assert.equal(f.service.busy(), false);
});

test('OCR reports per-image errors while retaining usable and empty results', async t => {
  let call = 0;
  const f = await fixture(t, { ocrEngine: { status: async () => ({ ready: true }), recognize: async () => {
    if (++call === 2) throw new Error('测试识别失败');
    return { text: '', language: 'zh-Hans-CN' };
  } } });
  await f.service.install('extract-text');
  const event = await f.completed((await f.run('extract-text')).jobId);
  assert.equal(event.type, 'complete'); assert.equal(event.results[0].text, '');
  assert.equal(event.errors[0].sourceId, f.assets[1].id); assert.match(event.errors[0].error, /识别失败/);
});

test('OCR missing language components are actionable and not marked installed', async t => {
  const f = await fixture(t, { ocrEngine: { status: async () => ({ ready: false, languages: [], error: '请添加 Windows 文字识别语言' }) } });
  await assert.rejects(f.service.install('extract-text'), /文字识别语言/);
  const plugin = (await f.service.list()).plugins.find(p => p.id === 'extract-text');
  assert.equal(plugin.installed, false); assert.equal(plugin.resourceReady, false);
});

test('OCR bounds cumulative text and keeps earlier results when the limit is reached', async t => {
  const recognized = 'a'.repeat(5 * 1024 * 1024);
  const f = await fixture(t, { ocrEngine: { status: async () => ({ ready: true }), recognize: async () => ({ text: recognized, language: 'en-GB' }) } });
  await f.service.install('extract-text');
  const event = await f.completed((await f.run('extract-text')).jobId);
  assert.equal(event.type, 'complete'); assert.equal(event.results.length, 1);
  assert.equal(event.results[0].text.length, recognized.length);
  assert.equal(event.errors.length, 1); assert.match(event.errors[0].error, /超过 8 MB/);
});

test('PDF exports all images in requested order and safely replaces an approved output', async t => {
  let inputs;
  const f = await fixture(t, { writePdf: async ({ inputPaths, outputPath, onProgress }) => {
    inputs = inputPaths;
    onProgress({ progress: 0.5 });
    await fs.writeFile(outputPath, '%PDF-1.4\nfixture');
    return { pages: inputPaths.length, engine: '本地 PDF' };
  } });
  await f.service.install('image-to-pdf');
  const destination = path.join(f.base, '合并.pdf');
  await fs.writeFile(destination, 'previous output');
  f.choose({ filePath: destination });
  const event = await f.completed((await f.run('image-to-pdf', {}, f.assets.map(a => a.id).reverse())).jobId);
  assert.equal(event.type, 'complete'); assert.equal(event.results.length, 1); assert.equal(event.results[0].pages, 2);
  assert.deepEqual(inputs, f.assets.map(a => f.library.getAssetPath(a.id, 'original')).reverse());
  assert.match(await fs.readFile(destination, 'utf8'), /^%PDF/);
  assert.equal(f.library.snapshot().assets.length, 2);
  await f.service.revealResult(event.jobId); assert.equal(f.revealed(), destination);
  await assert.rejects(f.service.revealResult('arbitrary-path'), /结果已失效/);
  assert.deepEqual(await fs.readdir(path.join(f.base, 'plugins/jobs')), []);
});

test('PDF dialog cancellation creates no job; library destinations and wrong types are rejected', async t => {
  const f = await fixture(t);
  await f.service.install('image-to-pdf');
  f.choose({ canceled: true });
  assert.deepEqual(await f.run('image-to-pdf'), { cancelled: true });
  assert.equal((await f.service.list()).jobs.length, 0);
  f.choose({ filePath: path.join(f.library.root, 'bad.pdf') });
  await assert.rejects(f.run('image-to-pdf'), /素材库以外/);
  f.choose({ filePath: path.join(f.base, 'bad.png') });
  await assert.rejects(f.run('image-to-pdf'), /\.pdf/);
  assert.equal(f.service.busy(), false);
});

test('failed or cancelled PDF keeps existing output intact and removes job files', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { writePdf: async ({ outputPath, signal }) => {
    await fs.writeFile(outputPath, 'partial PDF');
    entered();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), { name: 'AbortError' })), { once: true }));
  } });
  await f.service.install('image-to-pdf');
  const filename = path.join(f.base, 'previous.pdf'); await fs.writeFile(filename, 'keep me');
  f.choose({ filePath: filename });
  const { jobId } = await f.run('image-to-pdf');
  await started; await f.service.cancel(jobId);
  const event = await f.completed(jobId);
  assert.equal(event.cancelled, true); assert.equal(event.results.length, 0);
  assert.equal(await fs.readFile(filename, 'utf8'), 'keep me');
  assert.deepEqual(await fs.readdir(path.join(f.base, 'plugins/jobs')), []);
});

test('PDF revalidates source and library after asynchronous conversion before publishing', async t => {
  let f;
  f = await fixture(t, { writePdf: async ({ outputPath }) => {
    await fs.writeFile(outputPath, '%PDF fixture'); f.changeLibrary(null); return { pages: 2 };
  } });
  await f.service.install('image-to-pdf');
  const destination = path.join(f.base, 'result.pdf'); f.choose({ filePath: destination });
  const event = await f.completed((await f.run('image-to-pdf')).jobId);
  assert.equal(event.type, 'error'); assert.match(event.error, /素材库已切换/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('existing image conversion still imports an image copy with document plugins present', async t => {
  const f = await fixture(t);
  await f.service.install('convert');
  const event = await f.completed((await f.run('convert', { format: 'webp', quality: 85 }, [f.assets[0].id])).jobId);
  assert.equal(event.type, 'complete'); assert.equal(event.results[0].ext, 'webp');
  assert.equal(f.library.snapshot().assets.length, 3);
});

test('real local engines complete OCR and PDF through the plugin service', { skip: process.platform !== 'win32' }, async t => {
  const ocrEngine = createOcrEngine();
  const status = await ocrEngine.status();
  const language = status.languages.find(item => item.tag.startsWith('en'))?.tag;
  if (!language) { t.skip('English Windows OCR component is not installed'); return; }
  const f = await fixture(t, { ocrEngine });
  const input = path.join(f.base, 'real-text.png');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="160"><rect width="900" height="160" fill="white"/><text x="40" y="105" font-family="Arial" font-size="64" fill="black">MOSAIC OCR 123</text></svg>')).png().toFile(input);
  const imported = await f.library.importPaths([input]);
  const id = imported.assetIds[0];
  await f.service.install('extract-text');
  const textEvent = await f.completed((await f.run('extract-text', { language }, [id])).jobId);
  assert.equal(textEvent.type, 'complete'); assert.match(textEvent.results[0].text, /MOSAIC OCR 123/);
  await f.service.install('image-to-pdf');
  f.choose({ filePath: path.join(f.base, 'real-images.pdf') });
  const pdfEvent = await f.completed((await f.run('image-to-pdf', { pageSize: 'a4', margin: 18 }, [id, f.assets[0].id])).jobId);
  assert.equal(pdfEvent.type, 'complete'); assert.equal(pdfEvent.results[0].pages, 2);
  const pdf = await fs.readFile(pdfEvent.results[0].path);
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.equal(f.library.snapshot().assets.length, 3);
});
