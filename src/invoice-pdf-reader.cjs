'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_PAGE_PIXELS = 8_000_000;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_PNG_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;
const CHANNEL_REQUEST = 'shitu:invoice-pdf-request';
const CHANNEL_RESPONSE = 'shitu:invoice-pdf-response';
const abortError = () => Object.assign(new Error('发票 PDF 读取已取消'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

function resourceFile(relative) {
  if (relative === '' || relative === 'index.html') return path.join(__dirname, 'invoice-pdf-reader.html');
  if (['invoice-pdf-reader.js', 'invoice-text-layout.js'].includes(relative)) return path.join(__dirname, relative);
  if (/^vendor\/pdfjs\/(?:build\/pdf(?:\.worker)?\.mjs|cmaps\/[A-Za-z0-9_.-]+\.bcmap|standard_fonts\/[A-Za-z0-9_.-]+\.(?:pfb|ttf)|wasm\/[A-Za-z0-9_.-]+\.(?:wasm|js))$/.test(relative)) return path.join(__dirname, ...relative.split('/'));
  return null;
}

async function startResourceServer() {
  const token = crypto.randomBytes(24).toString('hex');
  const prefix = `/${token}/`;
  const server = http.createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const file = pathname.startsWith(prefix) ? resourceFile(pathname.slice(prefix.length)) : null;
      if (!file) { response.writeHead(404).end(); return; }
      const bytes = await fs.readFile(file);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.ttf': 'font/ttf' }[path.extname(file)] || 'application/octet-stream';
      response.writeHead(200, {
        'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; font-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}${prefix}`, origin, async close() {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  } };
}

async function readInputPdf(inputPath, signal) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath) || inputPath.includes('\0')) throw new Error('发票 PDF 路径无效');
  const handle = await fs.open(inputPath, 'r');
  try {
    checkAbort(signal);
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size) throw new Error('请选择有效的发票 PDF 文件');
    if (stat.size > MAX_FILE_BYTES) throw new Error('单个发票 PDF 不能超过 64 MB');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('PDF 文件在读取时发生变化，请重试');
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw new Error('PDF 文件在读取时发生变化，请重试');
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('所选文件不是有效的 PDF');
    return bytes;
  } finally { await handle.close(); }
}

function validatePage(result) {
  const png = result?.png;
  if (!(png instanceof Uint8Array) || !png.byteLength || png.byteLength > MAX_PNG_BYTES) throw new Error('PDF 页面图片无效或超过 32 MB');
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PDF 页面未能生成有效 PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > MAX_PAGE_PIXELS || result.width !== width || result.height !== height) throw new Error('PDF 页面渲染尺寸无效');
  if (typeof result.text !== 'string' || result.text.length > MAX_TEXT_CHARS) throw new Error('PDF 页面文字超过处理上限');
  return { bytes, width, height, text: result.text };
}

function createInvoicePdfReader({ BrowserWindow, ipcMain, timeoutMs = 180_000, requestTimeoutMs = 60_000 } = {}) {
  if (typeof BrowserWindow !== 'function' || !ipcMain?.on || !ipcMain?.removeListener) throw new Error('PDF 阅读器初始化参数无效');
  const active = new Set();

  function convert({ inputPath, outputDir, signal, onProgress = () => {} } = {}) {
    const controller = new AbortController();
    const entry = { cancel: () => controller.abort(), promise: null };
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    entry.promise = perform({ inputPath, outputDir, signal: controller.signal, onProgress }).finally(() => {
      signal?.removeEventListener('abort', forwardAbort);
      active.delete(entry);
    });
    active.add(entry);
    return entry.promise;
  }

  async function perform({ inputPath, outputDir, signal, onProgress }) {
    checkAbort(signal);
    if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || outputDir.includes('\0')) throw new Error('PDF 页面输出目录无效');
    const documentBytes = await readInputPdf(inputPath, signal);
    checkAbort(signal);
    let server, window, workDir, finished = false, timer, fatalError;
    const pending = new Map();
    let serial = 0;
    const fail = error => {
      fatalError ||= error;
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(fatalError); }
      pending.clear();
      if (window && !window.isDestroyed()) window.destroy();
    };
    const abort = () => fail(abortError());
    const reply = (event, payload) => {
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame?.routingId !== window.webContents.mainFrame.routingId) return;
      if (!payload || !Number.isSafeInteger(payload.id) || !pending.has(payload.id)) return;
      const task = pending.get(payload.id);
      pending.delete(payload.id); clearTimeout(task.timer);
      if (payload.ok === true) task.resolve(payload.result);
      else task.reject(new Error(String(payload.error || '无法读取 PDF 页面').slice(0, 500)));
    };
    const waitFor = id => {
      const promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => fail(new Error('PDF 读取超时，请减少页数或缩小文件后重试')), requestTimeoutMs);
        pending.set(id, { resolve, reject, timer: timeout });
      });
      promise.catch(() => {});
      return promise;
    };
    const request = (method, data) => {
      checkAbort(signal);
      if (fatalError) throw fatalError;
      const id = ++serial;
      const promise = waitFor(id);
      window.webContents.send(CHANNEL_REQUEST, { id, method, data });
      return promise;
    };
    try {
      await fs.mkdir(outputDir, { recursive: true });
      workDir = await fs.mkdtemp(path.join(outputDir, 'pdf-pages-'));
      server = await startResourceServer();
      checkAbort(signal);
      window = new BrowserWindow({
        show: false, width: 100, height: 100, skipTaskbar: true,
        webPreferences: {
          preload: path.join(__dirname, 'invoice-pdf-preload.cjs'),
          nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true,
          webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
          backgroundThrottling: false, spellcheck: false, navigateOnDragDrop: false,
          partition: `invoice-pdf-${crypto.randomUUID()}`
        }
      });
      const contents = window.webContents, session = contents.session;
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.setPermissionCheckHandler(() => false);
      session.on('will-download', event => event.preventDefault());
      session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(server.url) && !details.url.startsWith(`blob:${server.origin}/`) }));
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-redirect', event => event.preventDefault());
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.on('render-process-gone', () => fail(new Error('PDF 读取进程意外退出，请重试')));
      contents.on('destroyed', () => { if (!finished && !fatalError) fail(new Error('PDF 读取窗口已关闭')); });
      ipcMain.on(CHANNEL_RESPONSE, reply);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => fail(new Error('PDF 读取超时，请减少页数或缩小文件后重试')), timeoutMs);
      const ready = waitFor(0);
      await window.loadURL(server.url);
      await ready;
      const info = await request('load', { bytes: new Uint8Array(documentBytes), maxPages: MAX_PAGES });
      if (!Number.isSafeInteger(info?.pages) || info.pages < 1 || info.pages > MAX_PAGES) throw new Error('单个发票 PDF 最多支持 100 页');
      const results = [];
      let totalBytes = 0, totalText = 0;
      for (let pageNumber = 1; pageNumber <= info.pages; pageNumber++) {
        checkAbort(signal);
        onProgress({ progress: (pageNumber - 1) / info.pages, current: pageNumber, total: info.pages, message: `正在读取 PDF 第 ${pageNumber} / ${info.pages} 页` });
        const response = await request('page', { pageNumber, maxPixels: MAX_PAGE_PIXELS, maxTextChars: MAX_TEXT_CHARS });
        checkAbort(signal);
        const page = validatePage(response);
        totalBytes += page.bytes.length; totalText += page.text.length;
        if (totalBytes > MAX_TOTAL_PNG_BYTES || totalText > 1_000_000) throw new Error('PDF 页面内容超过处理上限，请拆分文件后重试');
        const filename = path.join(workDir, `page-${String(pageNumber).padStart(3, '0')}.png`);
        await fs.writeFile(filename, page.bytes, { flag: 'wx' });
        results.push({ path: filename, text: page.text, width: page.width, height: page.height, pageNumber });
        onProgress({ progress: pageNumber / info.pages, current: pageNumber, total: info.pages, message: `已读取 PDF 第 ${pageNumber} / ${info.pages} 页` });
      }
      checkAbort(signal);
      if (fatalError) throw fatalError;
      finished = true;
      return results;
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw fatalError || error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      ipcMain.removeListener(CHANNEL_RESPONSE, reply);
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(abortError()); }
      pending.clear();
      if (window && !window.isDestroyed()) window.destroy();
      await server?.close();
      if (!finished && workDir) {
        const relative = path.relative(path.resolve(outputDir), workDir);
        if (/^pdf-pages-[^\\/]+$/.test(relative)) await fs.rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    }
  }

  return { convert, busy: () => active.size > 0, async shutdown() {
    const jobs = [...active];
    for (const job of jobs) job.cancel();
    await Promise.allSettled(jobs.map(job => job.promise));
  } };
}

module.exports = { createInvoicePdfReader, resourceFile, validatePage, MAX_FILE_BYTES, MAX_PAGES, MAX_PAGE_PIXELS };
