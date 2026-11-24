'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { IMAGE } = require('./media-formats.cjs');
const { extractInvoiceAmount } = require('./invoice-amounts.js');
const { extractPurchaseAmount } = require('./purchase-amounts.cjs');

const MAX_BYTES = 64 * 1024 * 1024;
// Bump when changes to PDF text extraction or amount parsing require a rescan.
const ENGINE_VERSION = 3;
const EVIDENCE_ENGINE_VERSION = 2;
const abortError = () => Object.assign(new Error('金额识别已取消'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw abortError(); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function invoiceKey(input) {
  const text = String(input || '').normalize('NFKC').replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '');
  const number = /发票号码\s*[:：]?\s*(\d(?:[ \t]*\d){7,19})(?![ \t]*\d)/.exec(text)?.[1]?.replace(/[ \t]/g, '');
  if (!number) return undefined;
  if (number.length === 20) return digest(`invoice:${number}`);
  const code = /发票代码\s*[:：]?\s*(\d{12}|\d{10})(?!\d)/.exec(text)?.[1];
  return number.length === 8 && code ? digest(`invoice:${code}:${number}`) : undefined;
}

function resultPage(pageNumber, text) {
  const parsed = extractInvoiceAmount(text), known = parsed.cents !== null && parsed.confidence === 'high';
  const identity = invoiceKey(text);
  return { pageNumber, amountCents: known ? parsed.cents : null, detectedCents: parsed.cents,
    status: known ? 'recognized' : 'pending', confidence: parsed.confidence,
    reason: known ? '已识别价税合计' : parsed.cents !== null ? '识别到可能金额，请核对后保存' : '未识别到可靠的合计金额，请填写',
    ...(identity ? { invoiceKey: identity } : {}) };
}

async function recognizeReimbursementInvoice({ asset, inputPath, workRoot, ocrEngine, pdfReader, signal, force = false, onProgress = () => {} }) {
  check(signal);
  if (!asset || typeof inputPath !== 'string' || !path.isAbsolute(inputPath) || !path.isAbsolute(workRoot || '')) throw new Error('发票识别参数无效');
  const extension = path.extname(inputPath).slice(1).toLowerCase();
  if (extension !== 'pdf' && !IMAGE.has(extension)) throw new Error('金额识别仅支持图片和 PDF 发票');
  const info = await fs.lstat(inputPath);
  if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > MAX_BYTES) throw new Error('请选择 64 MB 以内的图片或 PDF 发票');
  const bytes = await fs.readFile(inputPath); check(signal);
  if (bytes.length !== info.size) throw new Error('发票文件已变化，请重新识别');
  const sourceHash = digest(bytes), previous = asset.reimbursementAmounts?.sourceHash === sourceHash ? asset.reimbursementAmounts : null;
  // An unreadable PDF can be entered as one document total. Retrying its page
  // reader must never add later pages on top of that confirmed whole total.
  if (previous?.pages.length === 1 && ['manual', 'excluded'].includes(previous.pages[0].status) && previous.pages[0].reason.includes('整份文件')) return { ...structuredClone(previous), engineVersion: ENGINE_VERSION };
  if (previous?.engineVersion === ENGINE_VERSION && !force) return structuredClone(previous);
  await fs.mkdir(workRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(workRoot, 'amounts-'));
  try {
    const source = path.join(directory, `source.${extension}`); await fs.writeFile(source, bytes, { flag: 'wx' });
    let pages;
    try {
      if (extension === 'pdf') {
        if (!pdfReader) throw new Error('PDF 读取组件不可用');
        pages = await pdfReader.convert({ inputPath: source, outputDir: directory, signal, onProgress });
      } else {
        const metadata = await sharp(source, { limitInputPixels: 100_000_000 }).metadata();
        if ((metadata.pages || 1) > 1) throw new Error('请使用静态图片');
        const image = path.join(directory, 'page-1.png');
        await sharp(source, { limitInputPixels: 100_000_000 }).rotate().flatten({ background: '#fff' })
          .resize({ width: 3500, height: 3500, fit: 'inside', withoutEnlargement: true }).png().toFile(image);
        pages = [{ pageNumber: 1, path: image, text: '' }];
      }
      if (!Array.isArray(pages) || !pages.length || pages.length > 100) throw new Error('发票页数超出范围');
      if (previous && pages.length < Math.max(...previous.pages.map(page => page.pageNumber))) throw new Error('发票读取不完整');
      for (let index = 0; index < pages.length; index++) {
        const page = pages[index], relative = path.relative(directory, page?.path || directory);
        if (page?.pageNumber !== index + 1 || !path.isAbsolute(page.path || '') || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('发票页面无效');
        const info = await fs.lstat(page.path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('发票页面不可读取');
      }
    } catch (error) {
      check(signal); if (error.name === 'AbortError') throw error;
      const unavailable = number => ({ pageNumber: number, amountCents: null, detectedCents: null, status: 'pending', confidence: 'none', reason: '无法读取，请手动填写金额' });
      return { version: 1, engineVersion: ENGINE_VERSION, sourceHash, pages: previous ? previous.pages.map(page => ['manual', 'excluded'].includes(page.status) ? structuredClone(page) : unavailable(page.pageNumber)) : [{ ...unavailable(1), reason: '无法读取，请手动填写整份文件的合计金额' }] };
    }
    const results = [];
    for (let index = 0; index < pages.length; index++) {
      check(signal);
      const page = pages[index], pageNumber = index + 1;
      const manual = previous?.pages.find(item => item.pageNumber === pageNumber && ['manual', 'excluded'].includes(item.status));
      if (manual) { results.push(structuredClone(manual)); continue; }
      let text = String(page.text || ''), result = resultPage(pageNumber, text);
      if (result.status !== 'recognized') {
        try {
          if (!ocrEngine?.recognize) throw new Error('OCR 不可用');
          const recognized = await ocrEngine.recognize({ inputPath: page.path, language: 'auto', signal });
          const candidate = resultPage(pageNumber, String(recognized.text || ''));
          if (candidate.status === 'recognized' || result.detectedCents === null) { result = candidate; text = String(recognized.text || ''); }
        } catch (error) { check(signal); if (error.name === 'AbortError') throw error; }
      }
      results.push(result);
      onProgress({ progress: (index + 1) / pages.length, message: `正在识别金额 ${index + 1} / ${pages.length}` });
    }
    check(signal);
    return { version: 1, engineVersion: ENGINE_VERSION, sourceHash, pages: results };
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}); }
}

function evidenceResultPage(text) {
  const parsed = extractPurchaseAmount(text), known = parsed.cents !== null && parsed.confidence === 'high';
  const unresolved = parsed.reason === 'unsupported-currency' ? '截图含外币金额，请核对币种并手动填写人民币金额'
    : parsed.reason === 'ambiguous-totals' ? '检测到多个不一致的支付金额，请核对后填写' : '未识别到可靠的实付金额，请填写';
  return { pageNumber: 1, amountCents: known ? parsed.cents : null, detectedCents: parsed.cents,
    status: known ? 'recognized' : 'pending', confidence: parsed.confidence,
    reason: known ? '已识别实付金额，仅供核对' : parsed.cents !== null ? '识别到可能支付金额，请核对后保存' : unresolved };
}

async function recognizeReimbursementEvidence({ asset, inputPath, workRoot, ocrEngine, signal, force = false, onProgress = () => {} }) {
  check(signal);
  if (!asset || typeof inputPath !== 'string' || !path.isAbsolute(inputPath) || !path.isAbsolute(workRoot || '')) throw new Error('购买截图识别参数无效');
  const extension = path.extname(inputPath).slice(1).toLowerCase();
  if (!IMAGE.has(extension)) throw new Error('购买截图金额识别仅支持静态图片');
  const info = await fs.lstat(inputPath);
  if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > MAX_BYTES) throw new Error('请选择 64 MB 以内的购买截图');
  const bytes = await fs.readFile(inputPath); check(signal);
  if (bytes.length !== info.size || bytes.length > MAX_BYTES) throw new Error('购买截图已变化，请重新识别');
  const sourceHash = digest(bytes);
  const saved = asset.reimbursementEvidenceAmounts;
  const previous = saved?.sourceHash === sourceHash && Array.isArray(saved.pages) && saved.pages.length === 1 && saved.pages[0]?.pageNumber === 1 ? saved : null;
  if (previous && ['manual', 'excluded'].includes(previous.pages[0].status)) return { ...structuredClone(previous), engineVersion: EVIDENCE_ENGINE_VERSION };
  if (previous?.engineVersion === EVIDENCE_ENGINE_VERSION && !force) return structuredClone(previous);
  await fs.mkdir(workRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(workRoot, 'evidence-amounts-'));
  try {
    const source = path.join(directory, `source.${extension}`), image = path.join(directory, 'page-1.png');
    await fs.writeFile(source, bytes, { flag: 'wx' }); check(signal);
    let result;
    try {
      const metadata = await sharp(source, { limitInputPixels: 100_000_000 }).metadata(); check(signal);
      if ((metadata.pages || 1) > 1) throw new Error('请使用静态购买截图');
      await sharp(source, { limitInputPixels: 100_000_000 }).rotate().flatten({ background: '#fff' })
        .resize({ width: 3500, height: 3500, fit: 'inside', withoutEnlargement: true }).png().toFile(image);
      check(signal);
      if (!ocrEngine?.recognize) throw new Error('OCR 不可用');
      const recognized = await ocrEngine.recognize({ inputPath: image, language: 'auto', signal }); check(signal);
      const text = String(recognized.text || '');
      result = evidenceResultPage(text);
      // Small transfer-card glyphs can merge at their original resolution.
      // Retry only an unresolved outgoing card, bounded to the same 3500 px
      // canvas, rather than guessing an unreadable digit in its amount.
      const reason = extractPurchaseAmount(text).reason;
      if (result.status !== 'recognized' && ['unreadable-total', 'no-paid-label'].includes(reason) && /已被接收/.test(text) && /转账/.test(text)) {
        const enlarged = path.join(directory, 'transfer-card.png');
        await sharp(source, { limitInputPixels: 100_000_000 }).rotate().flatten({ background: '#fff' })
          .resize({ width: 3500, height: 3500, fit: 'inside' }).png().toFile(enlarged);
        check(signal);
        const retry = await ocrEngine.recognize({ inputPath: enlarged, language: 'auto', signal }); check(signal);
        const retryText = String(retry.text || ''), candidate = evidenceResultPage(retryText);
        if (candidate.status === 'recognized' && extractPurchaseAmount(retryText).label === '已被接收的转账') result = candidate;
      }
    } catch (error) {
      check(signal); if (error.name === 'AbortError') throw error;
      result = { pageNumber: 1, amountCents: null, detectedCents: null, status: 'pending', confidence: 'none',
        reason: error.message === '请使用静态购买截图' ? '仅支持静态购买截图，请手动核对' : '无法识别购买截图，请手动填写金额' };
    }
    check(signal); onProgress({ progress: 1, message: '购买截图金额识别完成，仅供核对' });
    return { version: 1, engineVersion: EVIDENCE_ENGINE_VERSION, sourceHash, pages: [result] };
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}); }
}

module.exports = { recognizeReimbursementInvoice, recognizeReimbursementEvidence, resultPage, evidenceResultPage, invoiceKey, MAX_BYTES, ENGINE_VERSION, EVIDENCE_ENGINE_VERSION };
