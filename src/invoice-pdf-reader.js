import * as pdfjs from './vendor/pdfjs/build/pdf.mjs';
import './invoice-text-layout.js';

const bridge = window.invoicePdf;
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/build/pdf.worker.mjs', location.href).href;
let documentTask, pdf, busy = false;

async function load({ bytes, maxPages }) {
  if (pdf) throw new Error('此读取窗口已载入 PDF');
  documentTask = pdfjs.getDocument({
    data: bytes, isEvalSupported: false, enableXfa: false, useSystemFonts: false,
    cMapUrl: new URL('./vendor/pdfjs/cmaps/', location.href).href, cMapPacked: true,
    standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', location.href).href,
    wasmUrl: new URL('./vendor/pdfjs/wasm/', location.href).href,
    stopAtErrors: true, maxImageSize: 100_000_000, verbosity: 0
  });
  pdf = await documentTask.promise;
  if (pdf.numPages > maxPages) throw new Error('单个发票 PDF 最多支持 100 页');
  return { pages: pdf.numPages };
}

async function renderPage({ pageNumber, maxPixels, maxTextChars }) {
  if (!pdf || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) throw new Error('PDF 页码无效');
  const page = await pdf.getPage(pageNumber);
  let canvas;
  try {
    const unit = page.getViewport({ scale: 1 });
    if (!Number.isFinite(unit.width) || !Number.isFinite(unit.height) || unit.width <= 0 || unit.height <= 0) throw new Error('PDF 页面尺寸无效');
    let scale = Math.min(200 / 72, Math.sqrt(maxPixels / (unit.width * unit.height)), 16384 / Math.max(unit.width, unit.height));
    let viewport = page.getViewport({ scale });
    let width = Math.max(1, Math.ceil(viewport.width)), height = Math.max(1, Math.ceil(viewport.height));
    if (width * height > maxPixels) {
      scale *= Math.sqrt(maxPixels / (width * height)) * 0.999;
      viewport = page.getViewport({ scale });
      width = Math.max(1, Math.ceil(viewport.width)); height = Math.max(1, Math.ceil(viewport.height));
    }
    canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff', annotationMode: pdfjs.AnnotationMode.DISABLE, intent: 'print' }).promise;
    const content = await page.getTextContent();
    const text = window.MosaicInvoiceTextLayout.layoutTextItems(content.items, { viewport: unit, maxTextChars });
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PDF 页面无法转换为 PNG')), 'image/png'));
    if (blob.size > 32 * 1024 * 1024) throw new Error('PDF 页面图片超过 32 MB，请缩小文件后重试');
    return { png: new Uint8Array(await blob.arrayBuffer()), width, height, text };
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    page.cleanup();
  }
}

bridge.onRequest(async request => {
  if (!request || !Number.isSafeInteger(request.id) || request.id < 1) return;
  if (busy) { bridge.reject(request.id, 'PDF 页面正在处理中'); return; }
  busy = true;
  try {
    if (request.method === 'load') bridge.respond(request.id, await load(request.data));
    else if (request.method === 'page') bridge.respond(request.id, await renderPage(request.data));
    else bridge.reject(request.id, 'PDF 读取请求无效');
  } catch (error) {
    const message = error?.name === 'PasswordException' ? 'PDF 已加密，请先解除密码后再导入' : error?.message || '无法读取此 PDF';
    bridge.reject(request.id, message);
  } finally { busy = false; }
});
bridge.respond(0, { ready: true });
window.addEventListener('unload', () => { documentTask?.destroy().catch(() => {}); });
