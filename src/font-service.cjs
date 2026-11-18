'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { mediaResponse } = require('./media-response.cjs');
const { MAX_FONT_BYTES, parseFont, extractCollectionFace } = require('./font-metadata.cjs');
const FORMATS = new Set(['ttf', 'otf', 'woff', 'woff2', 'ttc', 'otc']);
const MIME = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fingerprint = stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
function cancelled() { return Object.assign(new Error('字体预览已取消'), { name: 'AbortError' }); }
function createFontService({ BrowserWindow, cacheDir, getLibrary, thumbnailTimeoutMs = 20000 }) {
  const sessions = new Map(), pending = new Map(), tasks = new Set(), windows = new Set(), descriptors = new Map();
  const stop = new AbortController();
  let closed = false, shutdownTask, thumbnailQueue = Promise.resolve();
  function track(task) { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  async function untilStopped(promise) {
    if (closed) throw cancelled();
    let abort;
    const stopped = new Promise((_resolve, reject) => { abort = () => reject(cancelled()); stop.signal.addEventListener('abort', abort, { once: true }); });
    try { return await Promise.race([promise, stopped]); } finally { stop.signal.removeEventListener('abort', abort); }
  }
  async function sourceStat(filename) {
    if (closed) throw cancelled();
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('字体文件路径无效');
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || pathKey(await fs.realpath(filename)) !== pathKey(filename)) throw new Error('字体文件包含符号链接或不是普通文件');
    if (stat.size < 4 || stat.size > MAX_FONT_BYTES) throw new Error('字体文件为空或超过 128 MB 预览限制');
    return stat;
  }
  async function cachedFace(data, hash, index, format) {
    const directory = path.resolve(cacheDir);
    await fs.mkdir(directory, { recursive: true });
    if (pathKey(await fs.realpath(directory)) !== pathKey(directory) || !(await fs.lstat(directory)).isDirectory()) throw new Error('字体缓存路径无效');
    const filename = path.join(directory, `${hash}-${index}.${format}`), expected = crypto.createHash('sha256').update(data).digest('hex');
    try {
      const stat = await sourceStat(filename);
      if (stat.size === data.length && crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex') === expected) return filename;
    } catch (error) { if (closed) throw error; }
    const temporary = path.join(directory, `${hash}-${index}-${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, data, { flag: 'wx' });
      if (closed) throw cancelled();
      await fs.rename(temporary, filename);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return filename;
  }
  async function descriptor(source, faceIndex = 0, expectedHash, fallbackName) {
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= 128) throw new Error('请选择有效的字体字型');
    if (!FORMATS.has(path.extname(source).slice(1).toLowerCase())) throw new Error('不支持此字体格式');
    const before = await sourceStat(source), stamp = fingerprint(before), cacheKey = `${pathKey(source)}\0${stamp}\0${faceIndex}\0${fallbackName || ''}`;
    const existing = descriptors.get(cacheKey);
    if (existing && (!expectedHash || existing.hash === expectedHash)) {
      try { if (fingerprint(await sourceStat(existing.filename)) === existing.fileStamp) return existing; } catch (error) { if (closed) throw error; }
      descriptors.delete(cacheKey);
    }
    const buffer = await fs.readFile(source);
    if (closed) throw cancelled();
    if (fingerprint(await sourceStat(source)) !== stamp) throw new Error('字体文件已变化，请重新打开');
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (expectedHash && hash !== expectedHash) throw new Error('字体原文件已变化，请重新导入');
    const parsed = parseFont(buffer, { fallbackName: fallbackName || path.basename(source, path.extname(source)) });
    if (faceIndex >= parsed.faces.length) throw new Error('字体集合中的字型不存在');
    let filename = source, format = parsed.format;
    if (format === 'ttc') {
      const extracted = extractCollectionFace(buffer, faceIndex); format = extracted.format;
      filename = await cachedFace(extracted.buffer, hash, faceIndex, format);
    }
    if (closed) throw cancelled();
    const result = { filename, source, sourceStamp: stamp, fileStamp: fingerprint(await sourceStat(filename)), hash, format,
      faceIndex, faces: parsed.faces.map(face => ({ ...face })), ...parsed.faces[faceIndex], faceCount: parsed.faces.length };
    descriptors.set(cacheKey, result);
    while (descriptors.size > 64) descriptors.delete(descriptors.keys().next().value);
    return result;
  }
  function issue(prepared, owner) {
    if (closed) throw cancelled();
    const token = crypto.randomUUID(), url = `shitu://font/${token}/preview.${prepared.format}`;
    sessions.set(token, { prepared, owner, url });
    while (sessions.size > 64) sessions.delete(sessions.keys().next().value);
    const { format, family, style, fullName, postscriptName, faceIndex, faceCount, sampleText, metadataFromFilename } = prepared;
    return { token, options: { url, format, family, style, fullName, ...(postscriptName ? { postscriptName } : {}), faceIndex, faceCount,
      sampleText, ...(metadataFromFilename ? { metadataFromFilename: true } : {}), faces: prepared.faces.map(({ index, family, style, fullName }) => ({ index, family, style, fullName })) } };
  }
  function assetFrom(library, id) { return library.snapshot().assets.find(asset => asset.id === id); }
  function prepare(library, id, expectedRoot, faceIndex = 0) {
    if (closed) return Promise.reject(cancelled());
    if (!library || library.root !== expectedRoot || getLibrary() !== library) return Promise.reject(new Error('素材库已切换，请重新选择字体'));
    const asset = assetFrom(library, id);
    if (!asset || !FORMATS.has(asset.ext)) return Promise.reject(new Error('请选择有效的字体素材'));
    const key = `${library.root}\0${id}\0${asset.hash}\0${faceIndex}`, prior = pending.get(key);
    if (prior?.library === library) return prior.task;
    const record = { library, task: null };
    record.task = track((async () => {
      const prepared = await descriptor(library.getAssetPath(id, 'original'), faceIndex, asset.hash, asset.font?.family || asset.name);
      if (getLibrary() !== library || assetFrom(library, id)?.hash !== asset.hash) throw new Error('素材库或字体已变化，请重新选择');
      // Keep already issued faces valid. An older concurrent request can finish
      // after the current face, so revoking every URL here could interrupt it.
      // Authorizations remain bounded and are revoked on library invalidation.
      return issue(prepared, { library, id, hash: asset.hash }).options;
    })().finally(() => { if (pending.get(key) === record) pending.delete(key); }));
    pending.set(key, record); return record.task;
  }
  function thumbnail(source, destination, { originalName } = {}) {
    const task = thumbnailQueue.then(async () => {
      const prepared = await descriptor(source, 0, undefined, originalName), { token, options } = issue(prepared, null);
      let window, timer;
      try {
        window = new BrowserWindow({ width: 640, height: 480, useContentSize: true, show: false, skipTaskbar: true, backgroundColor: '#17181d',
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        windows.add(window); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        const render = (async () => { await window.loadFile(path.join(__dirname, 'font-thumbnail.html')); return window.webContents.executeJavaScript(`window.renderFontThumbnail(${JSON.stringify(options)})`); })();
        const result = await untilStopped(Promise.race([render, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('字体缩略图生成超时，原字体仍可保留')), thumbnailTimeoutMs); timer.unref();
        })]));
        if (closed) throw cancelled();
        if (result?.fontLoaded !== true || typeof result.dataUrl !== 'string' || !result.dataUrl.startsWith('data:image/jpeg;base64,') || result.dataUrl.length > 8 * 1024 * 1024) throw new Error('字体封面数据无效');
        const image = Buffer.from(result.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64');
        if (image[0] !== 0xff || image[1] !== 0xd8) throw new Error('字体封面不是有效的 JPEG');
        await fs.writeFile(destination, image);
        return { width: 640, height: 480, font: { family: prepared.family, style: prepared.style, fullName: prepared.fullName,
          ...(prepared.postscriptName ? { postscriptName: prepared.postscriptName } : {}), faceCount: prepared.faceCount } };
      } finally {
        clearTimeout(timer); sessions.delete(token);
        if (window) { windows.delete(window); if (!window.isDestroyed()) window.destroy(); }
      }
    });
    thumbnailQueue = task.catch(() => {}); return track(task);
  }
  async function response(request) {
    try {
      const url = new URL(request.url);
      if (closed || request.method !== 'GET' || url.protocol !== 'shitu:' || url.hostname !== 'font' || url.username || url.password || url.port || url.search || url.hash) return new Response(null, { status: 404 });
      const match = /^\/([0-9a-f-]{36})\/preview\.(ttf|otf|woff|woff2)$/.exec(url.pathname), session = match && sessions.get(match[1]);
      if (!session || session.url !== url.href) return new Response(null, { status: 404 });
      if (session.owner) { const { library, id, hash } = session.owner; if (getLibrary() !== library || assetFrom(library, id)?.hash !== hash) return new Response(null, { status: 404 }); }
      const { prepared } = session;
      if (fingerprint(await sourceStat(prepared.source)) !== prepared.sourceStamp || fingerprint(await sourceStat(prepared.filename)) !== prepared.fileStamp) return new Response(null, { status: 404 });
      const result = await mediaResponse(prepared.filename, request); result.headers.set('Content-Type', MIME[prepared.format]);
      result.headers.set('Access-Control-Allow-Origin', '*'); result.headers.set('Cache-Control', 'no-store');
      return result;
    } catch { return new Response(null, { status: 404 }); }
  }
  function invalidate() { for (const [token, session] of sessions) if (session.owner) sessions.delete(token); descriptors.clear(); }
  function shutdown() {
    if (shutdownTask) return shutdownTask;
    closed = true; stop.abort(); sessions.clear(); descriptors.clear();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    shutdownTask = Promise.allSettled([...tasks]); return shutdownTask;
  }
  return { prepare, thumbnail, response, invalidate, shutdown, busy: () => tasks.size > 0 };
}
module.exports = { createFontService };
