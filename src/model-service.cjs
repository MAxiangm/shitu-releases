'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { MODEL, MODEL_NATIVE } = require('./media-formats.cjs');
const { validateModelBundle } = require('./model-bundle.cjs');
const { createNativeModelConverter } = require('./native-models.cjs');
const { mediaResponse } = require('./media-response.cjs');
const { createModelHoverService } = require('./model-hover-service.cjs');

const HOVER_SIZE = 384;
const HOVER_FRAMES = 32;
const HOVER_FRAME_MS = 110;

function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function cancelled() { return Object.assign(new Error('模型预览已取消'), { name: 'AbortError' }); }

function createModelService({ BrowserWindow, cacheDir, getLibrary, thumbnailTimeoutMs = 90000,
  onHoverTask }) {
  const sessions = new Map();
  const windows = new Set();
  const tasks = new Set();
  const pending = new Map();
  const converter = createNativeModelConverter({ cacheDir: path.join(cacheDir, 'native') });
  const stop = new AbortController();
  let closed = false;
  let shutdownTask;
  let thumbnailQueue = Promise.resolve();
  function track(promise) {
    tasks.add(promise);
    promise.then(() => tasks.delete(promise), () => tasks.delete(promise));
    return promise;
  }
  async function untilStopped(promise) {
    if (closed) throw cancelled();
    let abort;
    const stopped = new Promise((_resolve, reject) => {
      abort = () => reject(cancelled());
      stop.signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, stopped]); }
    finally { stop.signal.removeEventListener('abort', abort); }
  }
  async function descriptor(source, modelDirectory, manifest, { signal, allowConvert = true } = {}) {
    if (closed) throw cancelled();
    validateModelBundle(manifest);
    if (typeof source !== 'string' || !path.isAbsolute(source) || typeof modelDirectory !== 'string' || !path.isAbsolute(modelDirectory)) throw new Error('模型托管路径无效');
    const directory = path.resolve(modelDirectory);
    // Reject links in both the bundle directory and its ancestors before
    // authorizing any resources, including native converter input.
    if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw new Error('模型包目录不能包含符号链接');
    if (path.resolve(source) !== path.join(directory, manifest.entry)) throw new Error('模型入口不在托管包中');
    const files = [];
    for (const file of manifest.files) {
      if (closed || signal?.aborted) throw cancelled();
      const filename = path.resolve(directory, file.path);
      if (!within(directory, filename)) throw new Error('模型资源路径无效');
      const resolved = await fs.realpath(filename);
      if (!within(directory, resolved) || resolved !== filename || !(await fs.lstat(filename)).isFile()) throw new Error('模型资源不在托管包内或包含符号链接');
      files.push({ path: file.path, source: resolved });
    }
    const format = path.extname(source).slice(1).toLowerCase();
    let entry = manifest.entry;
    let previewFormat = format;
    const warnings = [...(manifest.warnings || [])];
    if (MODEL_NATIVE.has(format)) {
      if (manifest.previewEntry && files.some(file => file.path === manifest.previewEntry)) {
        entry = manifest.previewEntry;
        previewFormat = path.extname(entry).slice(1).toLowerCase();
        warnings.push('使用随模型打包的兼容文件预览，导出仍保留原始工程。');
      } else {
        if (!allowConvert) throw new Error('模型需要先准备兼容预览');
        const converted = await untilStopped(converter.preview({ source, format, bundleDirectory: directory, manifest }));
        return { ...converted, warnings: [...warnings, ...(converted.warnings || [])], missing: manifest.missing || [] };
      }
    }
    return { entry, format: previewFormat, files, warnings, missing: manifest.missing || [] };
  }
  function issue(prepared, owner) {
    if (closed) throw cancelled();
    const token = crypto.randomUUID();
    const files = prepared.files.map(file => ({ path: file.path, source: file.source,
      url: `shitu://model/${token}/${file.path.split('/').map(encodeURIComponent).join('/')}` }));
    const entry = files.find(file => file.path === prepared.entry);
    if (!entry) throw new Error('模型预览入口不在资源包中');
    sessions.set(token, { files: new Map(files.map(file => [file.path, file.source])), owner });
    return { token, options: { url: entry.url, format: prepared.format, entry: prepared.entry,
      files: files.map(({ path: filePath, url }) => ({ path: filePath, url })),
      missing: prepared.missing || [], warnings: prepared.warnings || [] } };
  }
  function prepare(library, id, expectedRoot) {
    if (!library || library.root !== expectedRoot) return Promise.reject(new Error('素材库已切换，请重新选择模型'));
    const asset = library.snapshot().assets.find(item => item.id === id);
    if (!asset || !MODEL.has(asset.ext) || !asset.modelBundle) return Promise.reject(new Error('请选择有效的 3D 模型素材'));
    const identity = `${library.root}\0${id}\0${asset.hash}`;
    const existing = pending.get(identity);
    if (existing?.library === library) return existing.task;
    const record = { library, task: null };
    const task = track((async () => {
      const prepared = await descriptor(library.getAssetPath(id, 'original'), library.getModelBundleDirectory(id), asset.modelBundle);
      if (getLibrary() !== library) throw new Error('素材库已切换，请重新选择模型');
      // Replace older authorizations for this asset while retaining other open
      // thumbnail operations. No filesystem path is exposed to the renderer.
      for (const [token, session] of sessions) if (session.owner?.library === library && session.owner.id === id) sessions.delete(token);
      const result = issue(prepared, { library, id, hash: asset.hash });
      return result.options;
    })().finally(() => { if (pending.get(identity) === record) pending.delete(identity); }));
    record.task = task;
    pending.set(identity, record);
    return task;
  }
  async function renderInWindow(prepared, { size, signal, script, timeoutMessage }) {
    if (signal?.aborted) throw cancelled();
    const { token, options } = issue(prepared, null);
    let window, timer, abort;
    try {
      window = new BrowserWindow({ width: size, height: size, useContentSize: true, show: false, skipTaskbar: true,
        backgroundColor: '#11151c', webPreferences: { sandbox: true, contextIsolation: true,
          nodeIntegration: false, backgroundThrottling: false } });
      windows.add(window);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), thumbnailTimeoutMs);
        timer.unref();
        abort = () => reject(cancelled());
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      const render = (async () => {
        await window.loadFile(path.join(__dirname, 'model-viewer.html'));
        return window.webContents.executeJavaScript(script(JSON.stringify(options)));
      })();
      return await untilStopped(Promise.race([render, deadline]));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      sessions.delete(token);
      if (window) { windows.delete(window); if (!window.isDestroyed()) window.destroy(); }
    }
  }
  function jpegFrame(data, label) {
    const prefix = 'data:image/jpeg;base64,';
    if (typeof data !== 'string' || !data.startsWith(prefix) || data.length > 8 * 1024 * 1024)
      throw new Error(label + '数据无效');
    const image = Buffer.from(data.slice(prefix.length), 'base64');
    if (image[0] !== 0xff || image[1] !== 0xd8) throw new Error(label + '不是有效的 JPEG');
    return image;
  }
  function thumbnail(source, destination, { modelBundle, modelDirectory } = {}) {
    const task = thumbnailQueue.then(async () => {
      const prepared = await descriptor(source, modelDirectory, modelBundle);
      const result = await renderInWindow(prepared, { size: 640,
        timeoutMessage: '模型封面生成超时，仍可导入并打开模型预览',
        script: json => `window.renderModelThumbnail(${json})` });
      if (closed) throw cancelled();
      await fs.writeFile(destination, jpegFrame(result?.dataUrl, '模型封面'));
      return { width: 640, height: 640 };
    });
    thumbnailQueue = task.catch(() => {});
    return track(task);
  }
  async function renderHover(library, asset, { signal }) {
    const { id, modelBundle } = asset;
    const prepared = await descriptor(library.getAssetPath(id, 'original'), library.getModelBundleDirectory(id),
      modelBundle, { signal, allowConvert: false });
    const frames = await renderInWindow(prepared, { size: HOVER_SIZE, signal,
      timeoutMessage: '模型旋转预览生成超时',
      script: json => `window.renderModelTurntable(${json}, ${HOVER_FRAMES})` });
    if (signal.aborted || closed) throw cancelled();
    if (!Array.isArray(frames) || frames.length !== HOVER_FRAMES) throw new Error('模型旋转帧不完整');
    return sharp(frames.map(frame => jpegFrame(frame, '模型旋转帧')), { join: { animated: true } })
      .webp({ loop: 0, delay: Array(HOVER_FRAMES).fill(HOVER_FRAME_MS), quality: 80, effort: 2 }).toBuffer();
  }
  const hover = createModelHoverService({
    cacheDir: path.join(cacheDir, 'hover'), getLibrary, render: renderHover, runTask: onHoverTask
  });
  async function response(request) {
    try {
      const url = new URL(request.url);
      if (closed || request.method !== 'GET' || url.protocol !== 'shitu:' || url.hostname !== 'model' || url.username || url.password || url.port) return new Response(null, { status: 404 });
      const parts = url.pathname.slice(1).split('/');
      const token = parts.shift();
      const relative = parts.map(decodeURIComponent).join('/');
      const session = sessions.get(token);
      if (!session || !session.files.has(relative)) return new Response(null, { status: 404 });
      if (session.owner) {
        const { library, id, hash } = session.owner;
        if (getLibrary() !== library || library.snapshot().assets.find(asset => asset.id === id)?.hash !== hash) return new Response(null, { status: 404 });
      }
      const filename = session.files.get(relative);
      if (await fs.realpath(filename) !== filename || !(await fs.lstat(filename)).isFile()) return new Response(null, { status: 404 });
      const result = await mediaResponse(filename, request);
      result.headers.set('Access-Control-Allow-Origin', '*');
      return result;
    } catch { return new Response(null, { status: 404 }); }
  }
  function invalidate() {
    hover.invalidate();
    for (const [token, session] of sessions) if (session.owner) sessions.delete(token);
  }
  function shutdown() {
    if (shutdownTask) return shutdownTask;
    closed = true;
    stop.abort();
    sessions.clear();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    shutdownTask = (async () => {
      await Promise.all([converter.shutdown(), hover.shutdown()]);
      await Promise.allSettled([...tasks]);
    })();
    return shutdownTask;
  }
  return { prepare, thumbnail, response, invalidate, shutdown, busy: () => tasks.size > 0,
    prepareHover: hover.prepare, cancelHover: hover.cancel, warmHover: hover.warm, cancelWarmHover: hover.cancelWarm,
    hoverResponse: hover.response };
}
module.exports = { createModelService };
