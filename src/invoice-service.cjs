'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { resolveAssetFiles } = require('./asset-actions.cjs');
const { IMAGE } = require('./media-formats.cjs');
const { parseAmount, formatAmount, extractInvoiceAmount } = require('./invoice-amounts.js');

const MAX_ITEMS = 256, MAX_BYTES = 64 * 1024 * 1024;
const aborted = () => Object.assign(new Error('任务已取消'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw aborted(); };
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const inside = (file, root) => { const rel = path.relative(key(root), key(file)); return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };

function createInvoiceService({ rootDir, getLibrary, chooseFiles, chooseSavePath, pdfReader, ocrEngine, writePdf, revealFile, onEvent = () => {} }) {
  if (!path.isAbsolute(rootDir || '')) throw new Error('发票工作目录无效');
  const sessionDir = path.join(rootDir, crypto.randomUUID());
  const ready = fs.mkdir(sessionDir, { recursive: true });
  const records = new Map(), fingerprints = new Map(), jobs = new Map(), preparations = new Set(), sourcePaths = new Set();
  let preparing = null, queue = Promise.resolve(), closed = false;
  const ocr = ocrEngine || require('./image-ocr.cjs').createOcrEngine();
  const writer = writePdf || require('./image-pdf.cjs').writeImagePdf;
  const emit = detail => { try { onEvent(detail); } catch {} };
  const busy = () => Boolean(preparing) || [...jobs.values()].some(job => ['queued', 'running'].includes(job.state));
  async function status() {
    const state = await ocr.status();
    return { ocrReady: state.ready, languages: state.languages || [], error: state.error || '', maxItems: MAX_ITEMS };
  }
  function descriptor(record) {
    const { id, name, previewUrl, width, height, pageNumber, sourceType } = record;
    return { id, name, previewUrl, width, height, pageNumber, sourceType };
  }
  function withPreparation(task) {
    if (closed || busy()) return Promise.reject(new Error('请等待当前发票任务完成'));
    const controller = new AbortController(); preparing = controller;
    const promise = Promise.resolve().then(() => task(controller.signal)).finally(() => { preparations.delete(promise); if (preparing === controller) preparing = null; });
    preparations.add(promise); return promise;
  }
  async function prepareSources(sources, signal) {
    await ready;
    check(signal); if (closed) throw aborted();
    const items = [], errors = [];
    try {
      for (const source of sources) {
        check(signal);
        let directory, committed = false;
        try {
          const ext = path.extname(source.path).slice(1).toLowerCase();
          if (ext !== 'pdf' && !IMAGE.has(ext)) throw new Error('发票仅支持 PDF 和图片');
          const stat = await fs.lstat(source.path);
          if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_BYTES) throw new Error('请选择 64 MB 以内的普通 PDF 或图片文件');
          const bytes = await fs.readFile(source.path);
          if (bytes.length > MAX_BYTES) throw new Error('发票文件超过 64 MB');
          sourcePaths.add(await fs.realpath(source.path));
          const digest = crypto.createHash('sha256').update(bytes).digest('hex');
          const existing = fingerprints.get(digest);
          if (existing) { items.push(...existing.map(id => ({ ...descriptor(records.get(id)), duplicate: true }))); continue; }
          if (records.size >= MAX_ITEMS) throw new Error('一次最多准备 256 张发票，请清空当前发票后分批处理');
          directory = path.join(sessionDir, crypto.randomUUID());
          await fs.mkdir(directory);
          const copy = path.join(directory, `source.${ext}`);
          await fs.writeFile(copy, bytes, { flag: 'wx' });
          check(signal);
          let pages;
          if (ext === 'pdf') {
            if (!pdfReader) throw new Error('PDF 读取组件不可用');
            pages = await pdfReader.convert({ inputPath: copy, outputDir: directory, signal });
          } else {
            const meta = await sharp(copy, { limitInputPixels: 100_000_000 }).metadata();
            if ((meta.pages || 1) > 1) throw new Error('请先把动图或多页图片转为静态发票图片');
            const output = path.join(directory, 'page-1.png');
            const info = await sharp(copy, { limitInputPixels: 100_000_000 }).rotate().flatten({ background: '#fff' }).png().toFile(output);
            pages = [{ path: output, width: info.width, height: info.height, pageNumber: 1, text: '' }];
          }
          const existingPage = pageNumber => [...records.values()].find(record => record.sourceKey === `${digest}:${pageNumber}`);
          if (!pages.length || records.size + pages.filter(page => !existingPage(page.pageNumber)).length > MAX_ITEMS) throw new Error('展开后超过 256 张发票，请分批添加');
          const pending = [];
          for (const page of pages) {
            check(signal);
            const known = existingPage(page.pageNumber);
            if (known) { pending.push(known); continue; }
            const preview = await sharp(page.path).resize({ width: 480, height: 360, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
            const name = `${source.name}${pages.length > 1 ? ` · 第 ${page.pageNumber} 页` : ''}`;
            pending.push({ id: `invoice-${crypto.randomUUID()}`, name, path: page.path, directory, sourceKey: `${digest}:${page.pageNumber}`, originalPath: source.path,
              sourceType: ext === 'pdf' ? 'pdf' : 'image', pageNumber: page.pageNumber, width: page.width, height: page.height,
              text: String(page.text || '').slice(0, 64000), previewUrl: `data:image/jpeg;base64,${preview.toString('base64')}` });
          }
          for (const record of pending) records.set(record.id, record);
          fingerprints.set(digest, pending.map(record => record.id));
          items.push(...pending.map(descriptor));
          committed = pending.some(record => record.directory === directory);
        } catch (error) {
          if (signal.aborted || error.name === 'AbortError') throw aborted();
          errors.push({ name: source.name, error: error.message });
        } finally { if (directory && !committed) await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
      }
      return { items, errors };
    } finally { /* The caller owns the preparation lock. */ }
  }
  async function selectFiles() {
    return withPreparation(async signal => {
      const selected = await chooseFiles({ title: '添加发票图片或 PDF', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '发票图片和 PDF', extensions: ['pdf', ...IMAGE] }] });
      check(signal);
      if (selected.canceled || !selected.filePaths?.length) return { cancelled: true, items: [], errors: [] };
      if (selected.filePaths.length > MAX_ITEMS) throw new Error('一次最多选择 256 个文件');
      return prepareSources([...new Set(selected.filePaths)].map(file => ({ path: file, name: path.basename(file, path.extname(file)) })), signal);
    });
  }
  async function addAssets(request) {
    if (!request || typeof request.libraryRoot !== 'string') throw new Error('素材库信息无效');
    const library = getLibrary();
    const { assets, files } = resolveAssetFiles(library, request.assetIds, request.libraryRoot);
    if (assets.some(asset => asset.mediaType !== 'image' && asset.ext !== 'pdf')) throw new Error('请选择图片或 PDF 发票');
    return withPreparation(signal => prepareSources(assets.map((asset, index) => ({ path: files[index], name: asset.name })), signal));
  }
  function selectedRecords(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ITEMS || new Set(ids).size !== ids.length) throw new Error('请选择 1 至 256 张不重复的发票');
    return ids.map(id => { const item = records.get(id); if (!item) throw new Error('发票暂存已失效，请重新添加'); return item; });
  }
  async function destination(candidate, items) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('保存位置无效');
    if (!path.extname(candidate)) candidate += '.pdf';
    if (path.extname(candidate).toLowerCase() !== '.pdf') throw new Error('请保存为 PDF 文件');
    const parent = await fs.realpath(path.dirname(candidate));
    const file = path.join(parent, path.basename(candidate));
    const library = getLibrary?.();
    if (inside(file, sessionDir) || (library && inside(file, await fs.realpath(library.root)))) throw new Error('请保存到素材库和临时工作目录以外');
    for (const originalPath of sourcePaths) {
      const original = await fs.realpath(originalPath).catch(() => path.resolve(originalPath));
      if (key(file) === key(original)) throw new Error('请另存为新文件，避免覆盖发票原件');
    }
    const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('保存目标不是普通文件');
    return file;
  }
  async function run(request) {
    await ready;
    if (closed || preparing) throw new Error('请等待发票准备完成');
    if (!request || !['recognize', 'export'].includes(request.mode)) throw new Error('发票操作无效');
    if (busy()) throw new Error('请等待当前发票任务完成');
    const items = selectedRecords(request.itemIds);
    const options = request.options || {};
    let amounts, totalCents, target;
    if (request.mode === 'export') {
      if (options.confirmed !== true) throw new Error('请先核对并确认每张发票的金额');
      if (![1, 2, 3, 4, 6, 8, 9].includes(options.imagesPerPage) || !['portrait', 'landscape'].includes(options.orientation)) throw new Error('发票排版参数无效');
      if (!Array.isArray(options.items) || options.items.length !== items.length || options.items.some((item, i) => item.id !== items[i].id)) throw new Error('金额列表与发票顺序不一致');
      amounts = options.items.map(item => parseAmount(item.amount));
      if (amounts.some(value => value === null)) throw new Error('请为每张发票填写有效的非负金额，最多两位小数');
      totalCents = amounts.reduce((sum, value) => sum + value, 0);
      if (!Number.isSafeInteger(totalCents)) throw new Error('金额合计超过可处理范围');
      const name = `${items.length}张_合计${formatAmount(totalCents)}元.pdf`;
      const chosenPath = await withPreparation(async signal => {
        const chosen = await chooseSavePath({ title: '导出合并发票 PDF', defaultPath: name, buttonLabel: '导出 PDF', filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] });
        check(signal); if (closed) throw aborted();
        if (chosen.canceled || !chosen.filePath) return null;
        const result = await destination(chosen.filePath, items); check(signal); return result;
      });
      if (!chosenPath) return { cancelled: true }; target = chosenPath;
    }
    if (closed) throw aborted();
    const job = { id: crypto.randomUUID(), mode: request.mode, state: 'queued', controller: new AbortController(), items, options, amounts, totalCents, target, results: [] };
    jobs.set(job.id, job);
    queue = queue.then(() => new Promise(resolve => setTimeout(resolve, 20))).then(() => execute(job));
    return { jobId: job.id };
  }
  async function execute(job) {
    const signal = job.controller.signal;
    const results = [], errors = [];
    let work;
    const progress = (fraction, message) => emit({ type: 'progress', jobId: job.id, mode: job.mode, progress: fraction, message });
    job.state = 'running';
    try {
      check(signal);
      if (job.mode === 'recognize') {
        const runtime = await status();
        for (let i = 0; i < job.items.length; i++) {
          const item = job.items[i]; check(signal); progress(i / job.items.length, `正在识别 ${i + 1} / ${job.items.length}：${item.name}`);
          try {
            let text = item.text, parsed = extractInvoiceAmount(text);
            if (parsed.amount === null && runtime.ocrReady) {
              const result = await ocr.recognize({ inputPath: item.path, language: job.options.language || 'auto', signal });
              text = result.text; parsed = extractInvoiceAmount(text);
            }
            if (!text && !runtime.ocrReady) throw new Error('系统 OCR 不可用，请手动填写金额');
            check(signal);
            results.push({ sourceId: item.id, name: item.name, text: text.slice(0, 500000), ...parsed });
          } catch (error) { if (signal.aborted || error.name === 'AbortError') throw aborted(); errors.push({ sourceId: item.id, name: item.name, error: error.message }); }
        }
      } else {
        work = path.join(sessionDir, job.id); await fs.mkdir(work);
        const output = path.join(work, 'invoices.pdf');
        const outcome = await writer({ inputPaths: job.items.map(item => item.path), outputPath: output, signal,
          options: { pageSize: 'a4', orientation: job.options.orientation, margin: 18, gap: 10, imagesPerPage: job.options.imagesPerPage },
          onProgress: update => progress(Math.min(0.95, Number(update.progress) || 0), '正在排版合并发票…') });
        check(signal);
        const target = await destination(job.target, job.items);
        const temp = path.join(path.dirname(target), `.${path.basename(target)}.${job.id}.tmp`);
        try { await fs.copyFile(output, temp, constants.COPYFILE_EXCL); check(signal); await destination(target, job.items); check(signal); await fs.rename(temp, target); }
        finally { await fs.rm(temp, { force: true }).catch(() => {}); }
        results.push({ path: target, name: path.basename(target), pages: outcome.pages, invoiceCount: job.items.length, totalAmount: formatAmount(job.totalCents), engine: '本地 PDF' });
      }
      job.state = results.length ? 'complete' : 'error'; job.results = results;
      emit({ type: job.state, jobId: job.id, mode: job.mode, progress: 1, results, errors, error: job.state === 'error' ? errors[0]?.error : undefined });
    } catch (error) {
      job.state = signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'error'; job.results = results;
      emit({ type: job.state === 'cancelled' ? 'complete' : 'error', jobId: job.id, mode: job.mode, cancelled: job.state === 'cancelled', results, errors, error: error.message });
    } finally {
      delete job.items; delete job.options;
      if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
      for (const old of [...jobs.values()].slice(0, -10)) if (!['queued', 'running'].includes(old.state)) jobs.delete(old.id);
    }
  }
  async function cancel(id) { const job = jobs.get(id); if (!job) throw new Error('任务不存在'); job.controller.abort(); return { cancelled: true }; }
  async function preview(id) {
    const item = records.get(id); if (!item) throw new Error('发票暂存已失效');
    const image = await sharp(item.path).resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    return { url: `data:image/jpeg;base64,${image.toString('base64')}` };
  }
  async function removeItems(ids) {
    if (closed || busy()) throw new Error('请等待当前发票任务完成');
    if (!Array.isArray(ids) || ids.length > MAX_ITEMS || new Set(ids).size !== ids.length || ids.some(id => !records.has(id))) throw new Error('发票条目无效');
    const directories = new Set();
    for (const id of ids) { const item = records.get(id); directories.add(item.directory); records.delete(id); await fs.rm(item.path, { force: true }); }
    for (const directory of directories) if (![...records.values()].some(item => item.directory === directory)) await fs.rm(directory, { recursive: true, force: true });
    for (const [hash, entries] of fingerprints) if (entries.some(id => ids.includes(id))) fingerprints.delete(hash);
    return { removed: true };
  }
  async function revealResult(id) {
    const result = jobs.get(id)?.results?.find(item => item.path);
    if (!result || !(await fs.stat(result.path)).isFile()) throw new Error('导出结果已失效或已移动');
    await revealFile(result.path); return { revealed: true };
  }
  async function shutdown() {
    closed = true; preparing?.abort(); for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...preparations]); await queue;
    await pdfReader?.shutdown?.();
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }
  return { status, chooseFiles: selectFiles, addAssets, run, cancel, revealResult, preview, removeItems, busy, shutdown };
}

module.exports = { createInvoiceService, MAX_ITEMS };
