'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { FONT } = require('./media-formats.cjs');
const { normalizeSettings, normalizeText } = require('./font-layout.js');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DATA_LENGTH = 96 * 1024 * 1024;
const pathKey = filename => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);
function canceled() { return Object.assign(new Error('字体排版导出已取消'), { name: 'AbortError' }); }
function safeName(value) {
  const name = String(value || '字体').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120);
  return `${name || '字体'}-排版.png`;
}
function pngData(result, settings) {
  const prefix = 'data:image/png;base64,';
  if (!result || result.width !== settings.width || result.height !== settings.height ||
      typeof result.dataUrl !== 'string' || !result.dataUrl.startsWith(prefix) || result.dataUrl.length > MAX_DATA_LENGTH) {
    throw new Error('排版图片数据无效');
  }
  const encoded = result.dataUrl.slice(prefix.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('排版图片编码无效');
  const data = Buffer.from(encoded, 'base64');
  if (data.length < 45 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.readUInt32BE(8) !== 13 ||
      data.toString('ascii', 12, 16) !== 'IHDR' || data.readUInt32BE(16) !== settings.width || data.readUInt32BE(20) !== settings.height ||
      !data.subarray(-8, -4).equals(Buffer.from('IEND'))) throw new Error('排版图片不是有效的 PNG');
  return data;
}

function createFontExportService({ BrowserWindow, dialog, getLibrary, prepareFont, getParentWindow = () => undefined, renderTimeoutMs = 30000 }) {
  let active = null, closed = false;
  function current(request) {
    if (closed || request.controller.signal.aborted) throw canceled();
    const asset = request.library.snapshot().assets.find(item => item.id === request.id);
    if (getLibrary() !== request.library || request.library.root !== request.root || !asset || asset.trashedAt || asset.hash !== request.hash || !FONT.has(asset.ext)) {
      throw new Error('素材库或字体已变化，请重新打开后导出');
    }
  }
  async function abortable(request, promise) {
    current(request);
    let onAbort;
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () => reject(canceled());
      request.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([promise, aborted]); }
    finally { request.controller.signal.removeEventListener('abort', onAbort); }
  }
  async function render(request, payload) {
    current(request);
    const window = new BrowserWindow({ width: 600, height: 400, useContentSize: true, show: false, skipTaskbar: true,
      backgroundColor: '#00000000', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    request.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    let timer, onAbort;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('排版图片生成超时，请重试')), renderTimeoutMs);
      timer.unref?.();
      onAbort = () => reject(canceled());
      request.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const work = (async () => {
        await window.loadFile(path.join(__dirname, 'font-export.html'));
        current(request);
        return window.webContents.executeJavaScript(`window.renderFontExport(${JSON.stringify(payload)})`);
      })();
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      request.controller.signal.removeEventListener('abort', onAbort);
      if (!window.isDestroyed()) window.destroy();
      request.window = null;
    }
  }
  function exportImage(id, expectedRoot, options) {
    if (closed) return Promise.reject(canceled());
    if (active) return Promise.reject(new Error('正在导出排版，请等待当前导出完成'));
    const library = getLibrary();
    if (!library || typeof expectedRoot !== 'string' || library.root !== expectedRoot) return Promise.reject(new Error('素材库已切换，请重新选择字体'));
    const asset = library.snapshot().assets.find(item => item.id === id);
    if (typeof id !== 'string' || !asset || asset.trashedAt || !FONT.has(asset.ext)) return Promise.reject(new Error('请选择有效的字体素材'));
    if (!options || typeof options !== 'object' || Array.isArray(options) || typeof options.text !== 'string' || options.text.length > 2000 ||
        (options.settings !== undefined && (!options.settings || typeof options.settings !== 'object' || Array.isArray(options.settings)))) {
      return Promise.reject(new Error('字体排版参数无效'));
    }
    const faceIndex = options.faceIndex ?? 0;
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= 128) return Promise.reject(new Error('请选择有效的字体字型'));
    const settings = normalizeSettings(options.settings || {}), text = normalizeText(options.text);
    if (!text.trim()) return Promise.reject(new Error('请输入要导出的文字'));
    const request = { library, id, root: expectedRoot, hash: asset.hash, controller: new AbortController(), window: null, task: null };
    active = request;
    request.task = (async () => {
      current(request);
      const font = await abortable(request, prepareFont(library, id, expectedRoot, faceIndex));
      current(request);
      const result = await render(request, { font, text, settings });
      current(request);
      const bytes = pngData(result, settings);
      const parent = getParentWindow();
      const saveOptions = { title: '导出字体排版', defaultPath: safeName(asset.name), buttonLabel: '导出 PNG', filters: [{ name: 'PNG 图片', extensions: ['png'] }] };
      const chosen = await abortable(request, parent && !parent.isDestroyed?.() ? dialog.showSaveDialog(parent, saveOptions) : dialog.showSaveDialog(saveOptions));
      current(request);
      if (!chosen || chosen.canceled || !chosen.filePath) return { canceled: true };
      if (typeof chosen.filePath !== 'string' || !path.isAbsolute(chosen.filePath)) throw new Error('请选择有效的保存位置');
      let destination = chosen.filePath;
      if (!path.extname(destination)) destination += '.png';
      if (path.extname(destination).toLowerCase() !== '.png') throw new Error('排版图片请保存为 .png 文件');
      const source = library.getAssetPath(id, 'original');
      if (pathKey(source) === pathKey(destination)) throw new Error('不能覆盖原字体文件');
      const existing = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('保存目标不是普通文件');
      const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx' });
        current(request);
        await fs.rename(temporary, destination);
      } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return { canceled: false, filePath: destination, width: settings.width, height: settings.height, overflow: Boolean(result.overflow) };
    })().finally(() => { if (active === request) active = null; });
    return request.task;
  }
  async function shutdown() {
    closed = true;
    const request = active;
    if (!request) return;
    request.controller.abort();
    if (request.window && !request.window.isDestroyed()) request.window.destroy();
    await Promise.allSettled([request.task]);
  }
  return { exportImage, shutdown, busy: () => Boolean(active) };
}
module.exports = { createFontExportService };
