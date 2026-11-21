'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { IMAGE } = require('./media-formats.cjs');
const { writeImagePdf, IMAGES_PER_PAGE } = require('./image-pdf.cjs');

const MAX_SOURCES = 256;
const MAX_PAGES = 256;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const WORK_PREFIX = '.reimbursement-invoices-';
const abortError = () => Object.assign(new Error('发票合并已取消'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const pathKey = filename => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);
const inside = (parent, filename) => {
  const relative = path.relative(pathKey(parent), pathKey(filename));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function validateSource(filename) {
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (extension !== 'pdf' && !IMAGE.has(extension)) throw new Error('发票合并仅支持图片和 PDF');
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error('请选择有效的普通图片或 PDF 文件');
  return extension;
}

// The PDF reader stays responsible for sandboxed PDF decoding. This helper only
// orchestrates its page images and publishes a completed, independently saved PDF.
async function createReimbursementInvoicePdf({ inputPaths, outputPath, imagesPerPage = 2, pdfReader, pdfWriter = writeImagePdf, signal, onProgress = () => {} } = {}) {
  if (!Array.isArray(inputPaths) || !inputPaths.length || inputPaths.length > MAX_SOURCES || inputPaths.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) throw new Error('请选择 1 至 256 个有效发票文件');
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || outputPath.includes('\0') || path.extname(outputPath).toLowerCase() !== '.pdf') throw new Error('发票 PDF 保存路径无效');
  if (!IMAGES_PER_PAGE.includes(imagesPerPage)) throw new Error('每页发票数只能为 1、2、3、4、6、8 或 9');
  if (typeof pdfWriter !== 'function') throw new Error('PDF 生成组件不可用');
  inputPaths = [...inputPaths];
  checkAbort(signal);
  const extensions = [];
  for (const input of inputPaths) { checkAbort(signal); extensions.push(await validateSource(input)); }
  if (extensions.includes('pdf') && typeof pdfReader?.convert !== 'function') throw new Error('PDF 读取组件不可用');
  if (await fs.lstat(outputPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw Object.assign(new Error('保存位置已存在文件，请选择新的文件名'), { code: 'EEXIST' });

  const parent = path.dirname(outputPath), workDir = await fs.mkdtemp(path.join(parent, WORK_PREFIX));
  let outputHandle, sourceHandle, outputIdentity, published = false, progress = 0;
  const notify = (fraction, message, extra = {}) => {
    progress = Math.max(progress, Math.min(1, Math.max(0, Number(fraction) || 0)));
    onProgress({ ...extra, progress, message });
  };
  try {
    notify(0, '正在准备合并发票…', { phase: 'preparing' });
    const images = [];
    for (let index = 0; index < inputPaths.length; index++) {
      checkAbort(signal);
      if (extensions[index] === 'pdf') {
        const sourceDir = path.join(workDir, `source-${index}`);
        await fs.mkdir(sourceDir);
        const pages = await pdfReader.convert({ inputPath: inputPaths[index], outputDir: sourceDir, signal,
          onProgress: update => notify((index + Math.min(1, Math.max(0, Number(update?.progress) || 0))) / inputPaths.length * .45,
            `正在读取第 ${index + 1} / ${inputPaths.length} 个发票文件`, { phase: 'preparing', current: index + 1, total: inputPaths.length }) });
        checkAbort(signal);
        if (!Array.isArray(pages) || !pages.length) throw new Error('PDF 未包含可合并的页面');
        if (images.length + pages.length > MAX_PAGES) throw new Error('PDF 展开后最多合并 256 页，请分批处理');
        const canonicalDir = await fs.realpath(sourceDir);
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
          checkAbort(signal);
          const page = pages[pageIndex];
          if (!page || typeof page.path !== 'string' || !path.isAbsolute(page.path) || page.pageNumber !== pageIndex + 1 || path.extname(page.path).toLowerCase() !== '.png' || !inside(sourceDir, page.path)) throw new Error('PDF 页面读取结果无效');
          const info = await fs.lstat(page.path);
          if (!info.isFile() || info.isSymbolicLink() || !info.size || !inside(canonicalDir, await fs.realpath(page.path))) throw new Error('PDF 页面文件不在本次临时目录内');
          images.push(page.path);
        }
      } else {
        if (images.length >= MAX_PAGES) throw new Error('PDF 展开后最多合并 256 页，请分批处理');
        images.push(inputPaths[index]);
      }
      notify((index + 1) / inputPaths.length * .45, `已准备 ${index + 1} / ${inputPaths.length} 个发票文件`, { phase: 'preparing', current: index + 1, total: inputPaths.length });
    }
    checkAbort(signal);
    const stagedPdf = path.join(workDir, 'merged.pdf');
    const expectedPages = Math.ceil(images.length / imagesPerPage);
    const result = await pdfWriter({ inputPaths: images, outputPath: stagedPdf, signal,
      options: { pageSize: 'a4', orientation: 'portrait', margin: 18, gap: 10, imagesPerPage },
      onProgress: update => notify(.45 + Math.min(1, Math.max(0, Number(update?.progress) || 0)) * .5,
        '正在排版合并发票…', { phase: 'writing', current: update?.current, total: update?.total }) });
    checkAbort(signal);
    if (!Number.isSafeInteger(result?.pages) || result.pages !== expectedPages) throw new Error('发票 PDF 页数校验失败');
    const generated = await fs.lstat(stagedPdf);
    if (!generated.isFile() || generated.isSymbolicLink() || !generated.size || generated.size > MAX_OUTPUT_BYTES) throw new Error('发票 PDF 生成结果无效');
    sourceHandle = await fs.open(stagedPdf, 'r');
    const header = Buffer.alloc(Math.min(1024, generated.size));
    await sourceHandle.read(header, 0, header.length, 0);
    if (!header.includes(Buffer.from('%PDF-'))) throw new Error('发票 PDF 生成结果无效');
    notify(.95, '正在保存合并发票…', { phase: 'saving' });
    checkAbort(signal);
    outputHandle = await fs.open(outputPath, 'wx');
    outputIdentity = await outputHandle.stat();
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < generated.size) {
      checkAbort(signal);
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, generated.size - offset), offset);
      if (!bytesRead) throw new Error('发票 PDF 在保存时发生变化');
      let written = 0;
      while (written < bytesRead) {
        checkAbort(signal);
        const { bytesWritten } = await outputHandle.write(buffer, written, bytesRead - written, null);
        if (!bytesWritten) throw new Error('无法保存发票 PDF');
        written += bytesWritten;
      }
      offset += bytesRead;
      notify(.95 + offset / generated.size * .049, '正在保存合并发票…', { phase: 'saving' });
    }
    await outputHandle.sync();
    await outputHandle.close(); outputHandle = null;
    await sourceHandle.close(); sourceHandle = null;
    checkAbort(signal);
    notify(1, '发票 PDF 已生成', { phase: 'complete' });
    checkAbort(signal);
    published = true;
    return { pages: expectedPages, invoiceCount: images.length, sourceCount: inputPaths.length };
  } finally {
    await outputHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
    if (!published && outputIdentity) {
      const current = await fs.lstat(outputPath).catch(() => null);
      if (current?.isFile() && !current.isSymbolicLink() && current.dev === outputIdentity.dev && current.ino === outputIdentity.ino) await fs.rm(outputPath, { force: true }).catch(() => {});
    }
    if (path.dirname(workDir) === parent && path.basename(workDir).startsWith(WORK_PREFIX)) await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

module.exports = { createReimbursementInvoicePdf, MAX_SOURCES, MAX_PAGES };
