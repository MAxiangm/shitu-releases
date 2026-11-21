const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream, constants: fsConstants } = require('node:fs');
const sharp = require('sharp');
const { resolveAssetFiles } = require('./asset-actions.cjs');

// File-backed libvips cache entries otherwise keep Windows temporary files open.
sharp.cache({ files: 0 });

const VERSION = '1.0.0';
const MAX_PIXELS = 100_000_000;
const MAX_JOB_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_TEXT_BYTES = 16 * 1024 * 1024;
const CATALOG = Object.freeze([
  { id: 'ai-upscale', name: 'AI 放大图片', description: '使用 Real-ESRGAN 模型放大 2 倍或 4 倍，重建图片细节。', ai: true, engine: 'Vulkan GPU', gpuRequired: true, suffix: 'AI放大' },
  { id: 'ai-cutout', name: 'AI 自动抠图', description: '自动识别主体，导出保留透明背景的 PNG 图片。', ai: true, engine: 'DirectML GPU / CPU', suffix: '抠图' },
  { id: 'crop', name: '裁切图片', description: '框选或输入精确尺寸，裁切图片并保存副本。', ai: false, engine: 'CPU · libvips', suffix: '裁切' },
  { id: 'compress', name: '压缩图片', description: '调整编码质量与分辨率，减少图片体积。', ai: false, engine: 'CPU · libvips', suffix: '压缩' },
  { id: 'convert', name: '转换格式', description: '转换 PNG、JPEG、WebP、AVIF 与 TIFF 格式。', ai: false, engine: 'CPU · libvips', suffix: '转换' },
  { id: 'extract-text', name: '提取文字', description: '在本机识别图片中的文字，支持复制和保存文本。', ai: false, engine: 'Windows OCR', suffix: '文字' },
  { id: 'image-to-pdf', name: '图片转 PDF', description: '将所选图片依次合并为 PDF，保存到指定位置。', ai: false, engine: '本地 PDF', suffix: '图片合并' }
]);
const FORMATS = new Set(['png', 'jpeg', 'webp', 'avif', 'tiff']);
const cancelled = () => Object.assign(new Error('任务已取消'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw cancelled(); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function knownPlugin(id) {
  const plugin = CATALOG.find(item => item.id === id);
  if (!plugin) throw new Error('插件不存在');
  return plugin;
}
function integer(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}必须是 ${min} 至 ${max} 的整数`);
  return number;
}
function format(value, fallback = 'png') {
  const result = value === undefined ? fallback : String(value).toLowerCase().replace(/^jpg$/, 'jpeg').replace(/^tif$/, 'tiff');
  if (!FORMATS.has(result)) throw new Error('不支持的输出格式');
  return result;
}
function sanitizeOptions(pluginId, value = {}) {
  if (!plain(value)) throw new Error('处理参数无效');
  if (pluginId === 'extract-text') {
    const language = value.language ?? 'auto';
    if (typeof language !== 'string' || !/^(auto|[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*)$/.test(language)) throw new Error('文字识别语言无效');
    return { language };
  }
  if (pluginId === 'image-to-pdf') {
    const pageSize = value.pageSize ?? 'image', orientation = value.orientation ?? 'auto';
    if (!['image', 'a4'].includes(pageSize)) throw new Error('PDF 页面尺寸无效');
    if (!['auto', 'portrait', 'landscape'].includes(orientation)) throw new Error('PDF 页面方向无效');
    return { pageSize, orientation, margin: integer(value.margin, pageSize === 'a4' ? 18 : 0, 0, 100, '页边距') };
  }
  const device = value.device ?? value.accelerator ?? 'auto';
  if (!['auto', 'gpu', 'cpu'].includes(device)) throw new Error('计算设备无效');
  if (pluginId === 'ai-upscale') {
    if (device === 'cpu') throw new Error('AI 放大使用 Vulkan GPU 引擎，请选择自动或 GPU；此引擎不支持 CPU 模式');
    const scale = integer(value.scale, 2, 2, 4, '放大倍数');
    if (![2, 4].includes(scale)) throw new Error('放大倍数只能是 2 或 4');
    return { scale, accelerator: device, device };
  }
  if (pluginId === 'ai-cutout') return { accelerator: device, device };
  const quality = integer(value.quality, 80, 1, 100, '质量');
  if (pluginId === 'crop') return {
    left: integer(value.left ?? value.x, undefined, 0, 100000, '左侧位置'),
    top: integer(value.top ?? value.y, undefined, 0, 100000, '顶部位置'),
    width: integer(value.width, undefined, 1, 100000, '宽度'),
    height: integer(value.height, undefined, 1, 100000, '高度'),
    format: format(value.format), quality
  };
  if (pluginId === 'compress') return {
    format: value.format === undefined || value.format === 'original' ? 'original' : format(value.format),
    quality,
    maxWidth: integer(value.maxWidth ?? value.maxSize, undefined, 0, 32768, '最大宽度') || undefined,
    maxSize: value.maxSize === undefined ? undefined : integer(value.maxSize, undefined, 0, 32768, '最长边') || undefined
  };
  return { format: format(value.format), quality };
}

function orientedSize(metadata) {
  const swap = metadata.orientation >= 5 && metadata.orientation <= 8;
  return { width: swap ? metadata.height : metadata.width, height: swap ? metadata.width : metadata.height };
}
function extension(outputFormat) { return outputFormat === 'jpeg' ? 'jpg' : outputFormat; }
function sourceFormat(metadata) { return metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format; }
async function fileHash(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function encoder(pipeline, outputFormat, quality, compression = false) {
  if (outputFormat === 'jpeg') return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
  if (outputFormat === 'png') return pipeline.png({ compressionLevel: 9, ...(compression ? { palette: true, quality, effort: 7 } : {}) });
  if (outputFormat === 'webp') return pipeline.webp({ quality, effort: 5 });
  if (outputFormat === 'avif') return pipeline.avif({ quality, effort: 4 });
  return pipeline.tiff({ compression: 'lzw' });
}

async function processCpu({ pluginId, inputPath, outputPath, options, signal }) {
  checkAbort(signal);
  const metadata = await sharp(inputPath, { limitInputPixels: MAX_PIXELS, animated: false }).metadata();
  if ((metadata.pages || 1) > 1) throw new Error('此工具暂不处理动图或多页图片，请先选择静态图片');
  const size = orientedSize(metadata);
  if (!size.width || !size.height) throw new Error('无法读取图片尺寸');
  let pipeline = sharp(inputPath, { limitInputPixels: MAX_PIXELS }).rotate();
  if (pluginId === 'crop') {
    const { left, top, width, height } = options;
    if (![left, top, width, height].every(Number.isInteger)) throw new Error('请填写完整的裁切区域');
    if (left + width > size.width || top + height > size.height) throw new Error(`裁切区域超出图片边界（${size.width} × ${size.height}）`);
    pipeline = pipeline.extract({ left, top, width, height });
  } else if (pluginId === 'compress' && options.maxWidth) {
    pipeline = pipeline.resize({ width: options.maxWidth, ...(options.maxSize ? { height: options.maxSize, fit: 'inside' } : {}), withoutEnlargement: true });
  }
  const detectedFormat = sourceFormat(metadata);
  const outputFormat = options.format === 'original' ? (FORMATS.has(detectedFormat) ? detectedFormat : 'png') : options.format;
  const result = await encoder(pipeline, outputFormat, options.quality, pluginId === 'compress').toBuffer({ resolveWithObject: true });
  checkAbort(signal);
  await fs.writeFile(outputPath, result.data, { flag: 'wx' });
  return { width: result.info.width, height: result.info.height, engine: 'CPU · libvips', accelerator: 'cpu', provider: 'libvips', format: outputFormat };
}

function createImagePlugins({ rootDir, getLibrary, onEvent = () => {}, aiEngine, ocrEngine, writePdf, chooseSavePath, copyText, revealFile } = {}) {
  if (!rootDir || !path.isAbsolute(rootDir) || typeof getLibrary !== 'function') throw new Error('插件初始化参数无效');
  rootDir = path.resolve(rootDir);
  const statePath = path.join(rootDir, 'plugins.json');
  const workDir = path.join(rootDir, 'jobs');
  const states = new Map();
  const jobs = new Map();
  const installations = new Map();
  const mutations = new Set();
  const exports = new Set();
  let queue = Promise.resolve();
  let writeQueue = Promise.resolve();
  let engine = aiEngine;
  let ocr = ocrEngine;
  let closed = false;
  const emit = event => { try { onEvent(event); } catch {} };
  const ready = (async () => {
    await fs.mkdir(workDir, { recursive: true });
    let saved = {};
    try {
      const content = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (content.version !== 1 || !plain(content.plugins)) throw new Error('插件配置格式无效');
      saved = content.plugins;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const plugin of CATALOG) {
      const stored = saved[plugin.id];
      states.set(plugin.id, { installed: stored?.installed === true, enabled: stored?.installed === true && stored?.enabled !== false, error: '' });
    }
  })();
  // Avoid an unhandled rejection before the first IPC invokes list().
  ready.catch(() => {});
  const getEngine = () => engine ||= require('./ai-image-engine.cjs').createAiEngine({ rootDir: path.join(rootDir, 'ai') });
  const getOcr = () => ocr ||= require('./image-ocr.cjs').createOcrEngine();
  const persist = () => {
    const snapshot = { version: 1, plugins: Object.fromEntries([...states].map(([id, value]) => [id, { installed: value.installed, enabled: value.enabled }])) };
    const save = writeQueue.then(async () => {
      const temp = `${statePath}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(snapshot, null, 2)); await fs.rename(temp, statePath); }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    });
    writeQueue = save.catch(() => {});
    return save;
  };
  const pluginBusy = id => installations.has(id) || mutations.has(id) || [...jobs.values()].some(job => job.pluginId === id && ['queued', 'running'].includes(job.state));

  async function list() {
    await ready;
    const [ai, ocrStatus] = await Promise.all([getEngine().status(), getOcr().status()]);
    return {
      plugins: CATALOG.map(plugin => {
        const state = states.get(plugin.id);
        const runtime = plugin.id === 'extract-text' ? ocrStatus : ai?.tools?.[plugin.id] || {};
        const needsRuntime = plugin.ai || plugin.id === 'extract-text';
        const missing = needsRuntime && state.installed && !runtime.ready;
        return { ...plugin, version: VERSION, ...state, state: installations.has(plugin.id) ? 'installing' : state.error ? 'error' : missing ? 'missing' : state.installed ? 'ready' : 'available', resourceReady: !needsRuntime || runtime.ready === true, downloadBytes: runtime.downloadBytes || 0, engine: runtime.engine || plugin.engine, runtime };
      }),
      devices: ai?.devices || [],
      jobs: [...jobs.values()].slice(-30).map(({ controller, library, files, assets, ...job }) => structuredClone(job))
    };
  }

  async function install(id) {
    await ready;
    const plugin = knownPlugin(id);
    if (closed) throw new Error('插件系统已关闭');
    if (installations.has(id)) return installations.get(id).promise;
    if (pluginBusy(id)) throw new Error('请等待插件任务完成');
    const controller = new AbortController();
    const item = { controller, promise: null };
    installations.set(id, item);
    item.promise = (async () => {
      const state = states.get(id);
      state.error = '';
      emit({ type: 'state', pluginId: id, state: 'installing' });
      try {
        if (plugin.ai) await getEngine().ensureReady(id, { signal: controller.signal, onProgress: progress => {
          emit({ ...progress, type: 'install-progress', pluginId: id });
        } });
        if (id === 'extract-text') {
          const status = await getOcr().status({ refresh: true });
          if (!status.ready) throw new Error(status.error || '系统未安装文字识别语言，请在 Windows 语言设置中添加语言和文字识别组件');
        }
        checkAbort(controller.signal);
        state.installed = true;
        state.enabled = true;
        await persist();
        emit({ type: 'state', pluginId: id, state: 'ready' });
        return { installed: true, pluginId: id };
      } catch (error) {
        const wasCancelled = controller.signal.aborted || error.name === 'AbortError';
        state.error = wasCancelled ? '' : error.message;
        emit({ type: wasCancelled ? 'install-cancelled' : 'install-error', pluginId: id, cancelled: wasCancelled, error: wasCancelled ? '安装已取消' : error.message });
        if (wasCancelled) return { installed: state.installed, cancelled: true, pluginId: id };
        throw error;
      } finally { installations.delete(id); }
    })();
    return item.promise;
  }

  async function setEnabled(id, enabled) {
    await ready;
    knownPlugin(id);
    if (typeof enabled !== 'boolean') throw new Error('插件开关参数无效');
    const state = states.get(id);
    if (!state.installed) throw new Error('请先安装插件');
    if (pluginBusy(id)) throw new Error('请等待插件任务完成');
    state.enabled = enabled;
    await persist();
    emit({ type: 'state', pluginId: id });
    return { enabled };
  }

  async function uninstall(id) {
    await ready;
    const plugin = knownPlugin(id);
    if (pluginBusy(id)) throw new Error('请等待插件任务完成后再卸载');
    mutations.add(id);
    try {
      if (plugin.ai && typeof getEngine().uninstall === 'function') await getEngine().uninstall(id);
      Object.assign(states.get(id), { installed: false, enabled: false, error: '' });
      await persist();
      emit({ type: 'state', pluginId: id, state: 'available' });
      return { uninstalled: true };
    } finally { mutations.delete(id); }
  }

  const safeName = name => String(name || '图片').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '图片';
  const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  function inside(filename, directory) {
    const relative = path.relative(pathKey(directory), pathKey(filename));
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }
  async function destinationPath(candidate, extension, libraryRoot) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('请选择有效的保存位置');
    if (!path.extname(candidate)) candidate += `.${extension}`;
    if (path.extname(candidate).toLowerCase() !== `.${extension}`) throw new Error(`请保存为 .${extension} 文件`);
    const directory = await fs.realpath(path.dirname(candidate));
    const destination = path.join(directory, path.basename(candidate));
    const current = getLibrary();
    for (const root of new Set([libraryRoot, current?.root].filter(Boolean))) {
      const resolved = await fs.realpath(root).catch(error => { if (error.code !== 'ENOENT') throw error; return path.resolve(root); });
      if (inside(destination, resolved)) throw new Error('请保存到素材库以外的文件夹，避免覆盖素材库文件');
    }
    const existing = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('保存目标不是普通文件');
    return destination;
  }
  async function chooseDestination({ extension, name, title, libraryRoot }) {
    if (typeof chooseSavePath !== 'function') throw new Error('当前环境无法打开保存窗口');
    const chosen = await chooseSavePath({ title, defaultPath: `${safeName(name)}.${extension}`, buttonLabel: `保存 ${extension.toUpperCase()}`, filters: [{ name: extension === 'pdf' ? 'PDF 文档' : 'UTF-8 文本', extensions: [extension] }] });
    if (!chosen || chosen.canceled || chosen.cancelled || !chosen.filePath) return null;
    return destinationPath(chosen.filePath, extension, libraryRoot);
  }
  async function commitFile(source, destination, extension, libraryRoot, signal) {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
    try {
      checkAbort(signal);
      await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
      checkAbort(signal);
      await destinationPath(destination, extension, libraryRoot);
      checkAbort(signal);
      await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  function completedJob(id, pluginId) {
    const job = jobs.get(id);
    if (!job || job.pluginId !== pluginId || ['queued', 'running'].includes(job.state) || !job.results?.length) throw new Error('处理结果已失效，请重新运行工具');
    return job;
  }
  function textResult(job) {
    return job.results.length === 1 ? job.results[0].text : job.results.map(result => `【${result.name}】\r\n${result.text}`).join('\r\n\r\n');
  }
  async function copyTextResult(id) {
    const job = completedJob(id, 'extract-text');
    if (typeof copyText !== 'function') throw new Error('当前环境无法复制文字');
    await copyText(textResult(job));
    return { copied: true };
  }
  async function saveTextResult(id) {
    if (closed) throw new Error('插件系统已关闭');
    const job = completedJob(id, 'extract-text');
    const token = crypto.randomUUID();
    exports.add(token);
    let temporary;
    try {
      const destination = await chooseDestination({ extension: 'txt', name: `${job.results[0].name}${job.results.length > 1 ? '等' : ''}-提取文字`, title: '保存提取文字', libraryRoot: job.libraryRoot });
      if (!destination) return { saved: false, cancelled: true };
      temporary = path.join(workDir, `${token}.txt`);
      await fs.writeFile(temporary, `\uFEFF${textResult(job)}`, { flag: 'wx' });
      if (closed) throw new Error('插件系统已关闭');
      await commitFile(temporary, destination, 'txt', job.libraryRoot);
      return { saved: true, cancelled: false, path: destination };
    } finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
      exports.delete(token);
    }
  }
  async function revealResult(id) {
    const job = completedJob(id, 'image-to-pdf');
    const filename = job.results[0].path;
    if (!(await fs.stat(filename)).isFile()) throw new Error('PDF 文件已移动或删除');
    if (typeof revealFile !== 'function') throw new Error('当前环境无法打开保存位置');
    await revealFile(filename);
    return { revealed: true };
  }

  async function executeDocument(job, directory, progress, results, errors) {
    const { pluginId, library, options, controller: { signal } } = job;
    const currentFiles = () => {
      if (getLibrary() !== library) throw new Error('素材库已切换，任务已停止');
      return resolveAssetFiles(library, job.assetIds, job.libraryRoot).files;
    };
    if (pluginId === 'image-to-pdf') {
      const files = currentFiles();
      const outputPath = path.join(directory, 'images.pdf');
      const outcome = await (writePdf || require('./image-pdf.cjs').writeImagePdf)({ inputPaths: files, outputPath, options, signal, onProgress: update => {
        const fraction = typeof update === 'number' ? update : update?.progress;
        progress(Math.min(0.95, Number(fraction) || 0), update?.message || '正在生成 PDF…');
      } });
      currentFiles();
      checkAbort(signal);
      await commitFile(outputPath, job.destination, 'pdf', job.libraryRoot, signal);
      results.push({ path: job.destination, name: path.basename(job.destination), pages: outcome.pages, engine: outcome.engine || '本地 PDF' });
      progress(1, `已导出 PDF，共 ${outcome.pages} 页。`);
      return;
    }
    let textBytes = 0;
    for (let index = 0; index < job.assets.length; index++) {
      checkAbort(signal);
      const source = job.assets[index];
      progress(index / job.assets.length, `正在提取文字 ${index + 1} / ${job.assets.length}：${source.name}`);
      try {
        if (getLibrary() !== library) throw new Error('素材库已切换，任务已停止');
        const inputPath = resolveAssetFiles(library, [source.id], job.libraryRoot).files[0];
        const metadata = await sharp(inputPath, { limitInputPixels: MAX_PIXELS, animated: false }).metadata();
        if ((metadata.pages || 1) > 1) throw new Error('暂不处理动图或多页图片');
        const normalized = path.join(directory, `${index}.ocr.png`);
        try {
          await sharp(inputPath, { limitInputPixels: MAX_PIXELS }).rotate().flatten({ background: '#ffffff' }).png().toFile(normalized);
          checkAbort(signal);
          const outcome = await getOcr().recognize({ inputPath: normalized, language: options.language, signal });
          checkAbort(signal);
          if (getLibrary() !== library) throw new Error('素材库已切换，任务已停止');
          const bytes = Buffer.byteLength(outcome.text, 'utf8');
          if (textBytes + bytes > MAX_JOB_TEXT_BYTES) {
            for (const skipped of job.assets.slice(index)) errors.push({ sourceId: skipped.id, name: skipped.name, error: '本次文字结果超过 8 MB，请将剩余图片分批提取' });
            break;
          }
          textBytes += bytes;
          results.push({ sourceId: source.id, name: source.name, text: outcome.text, language: outcome.language, engine: outcome.engine || 'Windows OCR' });
        } finally { await fs.rm(normalized, { force: true }).catch(() => {}); }
      } catch (error) {
        if (signal.aborted || error.name === 'AbortError') throw cancelled();
        errors.push({ sourceId: source.id, name: source.name, error: error.message });
      }
    }
  }

  async function execute(job) {
    const { controller, pluginId, library, options } = job;
    const plugin = knownPlugin(pluginId);
    const signal = controller.signal;
    const directory = path.join(workDir, job.id);
    const results = [];
    const errors = [];
    let terminalEvent;
    job.state = 'running';
    const progress = (fraction, message, extra = {}) => {
      job.progress = Math.max(job.progress, Math.min(1, Math.max(0, Number(fraction) || 0)));
      job.message = message || '';
      emit({ ...extra, type: 'progress', jobId: job.id, pluginId, progress: job.progress, message: job.message });
    };
    try {
      checkAbort(signal);
      await fs.mkdir(directory, { recursive: true });
      if (['extract-text', 'image-to-pdf'].includes(pluginId)) await executeDocument(job, directory, progress, results, errors);
      else for (let index = 0; index < job.assets.length; index++) {
        checkAbort(signal);
        const source = job.assets[index];
        progress(index / job.assets.length, `正在处理 ${index + 1} / ${job.assets.length}：${source.name}`, { current: index + 1, total: job.assets.length });
        try {
          // Re-resolve for every item, so a source moved to trash after queueing is not processed.
          const validated = resolveAssetFiles(library, [source.id], job.libraryRoot);
          if (getLibrary() !== library) throw new Error('素材库已切换，任务已停止');
          const inputPath = validated.files[0];
          const metadata = await sharp(inputPath, { limitInputPixels: MAX_PIXELS, animated: false }).metadata();
          if ((metadata.pages || 1) > 1) throw new Error('暂不处理动图或多页图片');
          const detectedFormat = sourceFormat(metadata);
          const outputFormat = plugin.ai ? 'png' : options.format === 'original' ? (FORMATS.has(detectedFormat) ? detectedFormat : 'png') : options.format;
          const outputPath = path.join(directory, `${index}.${extension(outputFormat)}`);
          let outcome;
          if (plugin.ai) {
            const dimensions = orientedSize(metadata);
            // The general ESRGAN model always performs 4x inference, including
            // requested 2x output, which is downsampled only after inference.
            const factor = pluginId === 'ai-upscale' ? 4 : 1;
            if (dimensions.width * dimensions.height * factor * factor > MAX_PIXELS) throw new Error('AI 处理中间结果超过 1 亿像素，请先缩小或裁切图片');
            const normalizedInput = path.join(directory, `${index}.input.png`);
            await sharp(inputPath, { limitInputPixels: MAX_PIXELS }).rotate().png().toFile(normalizedInput);
            checkAbort(signal);
            outcome = await getEngine().process({ toolId: pluginId, inputPath: normalizedInput, outputPath, options, signal, onProgress: update => {
              const fraction = typeof update === 'number' ? update : Number(update?.progress || 0);
              progress((index + Math.min(0.9, Math.max(0, fraction)) * 0.9) / job.assets.length, update?.message || `正在计算：${source.name}`, { engine: update?.engine, accelerator: update?.accelerator });
            } });
            if (pluginId === 'ai-upscale') {
              const targetWidth = dimensions.width * options.scale;
              const targetHeight = dimensions.height * options.scale;
              const produced = await sharp(outputPath).metadata();
              if (produced.width !== targetWidth || produced.height !== targetHeight) {
                if (produced.width !== dimensions.width * 4 || produced.height !== dimensions.height * 4) throw new Error('AI 输出尺寸异常，未保存结果');
                const resized = `${outputPath}.resize.png`;
                await sharp(outputPath, { limitInputPixels: MAX_PIXELS }).resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' }).png().toFile(resized);
                checkAbort(signal);
                await fs.rename(resized, outputPath);
              }
            }
          } else outcome = await processCpu({ pluginId, inputPath, outputPath, options, signal });
          checkAbort(signal);
          if (getLibrary() !== library) throw new Error('素材库已切换，任务已停止');
          const outputInfo = await sharp(outputPath, { limitInputPixels: MAX_PIXELS }).metadata();
          if (!outputInfo.width || !outputInfo.height) throw new Error('处理结果无法解码');
          const report = await library.importPaths([outputPath], { folderId: source.folderId, metadata: { name: `${source.name.slice(0, 210)} · ${plugin.suffix}`, ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}), ...(source.pageUrl ? { pageUrl: source.pageUrl } : {}) } });
          if (report.errors.length) throw new Error(report.errors[0].message);
          const resultId = report.assetIds[0];
          if (resultId) {
            let warning;
            try { await library.updateAssets([resultId], { tags: source.tags, rating: source.rating, notes: source.notes }); }
            catch (error) { warning = `结果已保存，复制标签与备注失败：${error.message}`; }
            const item = library.snapshot().assets.find(asset => asset.id === resultId);
            results.push({ sourceId: source.id, id: resultId, name: item.name, ext: item.ext, width: outputInfo.width, height: outputInfo.height, size: item.size, beforeSize: source.size, engine: outcome?.engine || plugin.engine, accelerator: outcome?.accelerator || 'cpu', provider: outcome?.provider, device: outcome?.device, diagnostics: outcome?.diagnostics, fallback: outcome?.fallback, elapsedMs: outcome?.elapsedMs, ...(warning ? { warning } : {}) });
          } else if (report.duplicates) {
            // Import deduplication is expected when an operation leaves the bytes unchanged.
            const hash = await fileHash(outputPath);
            const existing = library.snapshot().assets.find(asset => asset.hash === hash);
            if (!existing) throw new Error('发现重复结果，但未找到相应素材');
            results.push({ sourceId: source.id, id: existing.id, name: existing.name, ext: existing.ext, width: outputInfo.width, height: outputInfo.height, size: existing.size, beforeSize: source.size, duplicate: true, engine: outcome?.engine || plugin.engine, accelerator: outcome?.accelerator || 'cpu', ...(existing.trashedAt ? { warning: '相同图片已在回收站，可恢复后查看。' } : {}) });
          } else throw new Error('处理结果未能导入素材库');
          await fs.rm(outputPath, { force: true }).catch(() => {});
        } catch (error) {
          if (signal.aborted || error.name === 'AbortError') throw cancelled();
          errors.push({ sourceId: source.id, name: source.name, error: error.message });
        }
      }
      job.state = errors.length === job.assets.length ? 'error' : 'complete';
      job.progress = 1;
      job.results = results;
      job.errors = errors;
      terminalEvent = { type: job.state, jobId: job.id, pluginId, progress: 1, results, errors, message: pluginId === 'image-to-pdf' ? job.message : undefined, error: job.state === 'error' ? errors[0]?.error : undefined, cancelled: false };
    } catch (error) {
      const wasCancelled = signal.aborted || error.name === 'AbortError';
      job.state = wasCancelled ? 'cancelled' : 'error';
      job.results = results;
      job.errors = errors;
      terminalEvent = { type: wasCancelled ? 'complete' : 'error', jobId: job.id, pluginId, progress: job.progress, results, errors, cancelled: wasCancelled, error: wasCancelled ? undefined : error.message };
    } finally {
      delete job.library;
      delete job.files;
      delete job.assets;
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      const completed = [...jobs.values()].filter(item => !['queued', 'running'].includes(item.state));
      for (const item of completed.slice(0, Math.max(0, completed.length - 30))) jobs.delete(item.id);
      let historyTextBytes = 0;
      for (const item of completed.reverse()) {
        historyTextBytes += (item.results || []).reduce((sum, result) => sum + (typeof result.text === 'string' ? Buffer.byteLength(result.text, 'utf8') : 0), 0);
        if (historyTextBytes > MAX_HISTORY_TEXT_BYTES) jobs.delete(item.id);
      }
      if (terminalEvent) emit(terminalEvent);
    }
  }

  async function run(request) {
    await ready;
    if (closed) throw new Error('插件系统已关闭');
    if (!plain(request)) throw new Error('任务参数无效');
    const plugin = knownPlugin(request.pluginId);
    const state = states.get(plugin.id);
    if (!state.installed) throw new Error('请先安装插件');
    if (!state.enabled) throw new Error('插件已停用，请先启用');
    if (installations.has(plugin.id) || mutations.has(plugin.id)) throw new Error('插件正在安装或卸载');
    if (typeof request.libraryRoot !== 'string') throw new Error('素材库信息已失效，请重新选择素材');
    const library = getLibrary();
    const { assets, files } = resolveAssetFiles(library, request.assetIds, request.libraryRoot);
    if (assets.some(asset => asset.mediaType !== 'image')) throw new Error('这些工具仅支持静态图片，请移除视频、模型和工程');
    const options = sanitizeOptions(plugin.id, request.options);
    let destination;
    if (plugin.id === 'extract-text') {
      const status = await getOcr().status();
      if (!status.ready) throw new Error(status.error || '系统文字识别组件不可用');
    }
    if (plugin.id === 'image-to-pdf') {
      const token = crypto.randomUUID();
      exports.add(token);
      try {
        destination = await chooseDestination({ extension: 'pdf', name: `${assets[0].name}${assets.length > 1 ? '等-合并' : ''}`, title: '图片转 PDF', libraryRoot: library.root });
        if (!destination) return { cancelled: true };
        if (closed || getLibrary() !== library) throw new Error('素材库已切换或正在关闭');
        resolveAssetFiles(library, request.assetIds, request.libraryRoot);
        if (!state.installed || !state.enabled) throw new Error('请先安装并启用插件');
      } finally { exports.delete(token); }
    }
    const job = { id: crypto.randomUUID(), pluginId: plugin.id, libraryRoot: library.root, assetIds: assets.map(asset => asset.id), assets, files, library, options, ...(destination ? { destination } : {}), controller: new AbortController(), state: 'queued', progress: 0, message: '等待处理', createdAt: new Date().toISOString() };
    jobs.set(job.id, job);
    // Defer initial events until the IPC response has delivered the job ID to the UI.
    queue = queue.then(() => new Promise(resolve => setTimeout(resolve, 20))).then(() => execute(job)).catch(error => {
      job.state = 'error';
      emit({ type: 'error', jobId: job.id, pluginId: plugin.id, error: error.message, results: [], errors: [] });
    });
    return { jobId: job.id };
  }
  async function cancel(id) {
    await ready;
    if (installations.has(id)) {
      installations.get(id).controller.abort();
      return { cancelled: true, pluginId: id };
    }
    const job = jobs.get(id);
    if (!job) throw new Error('任务不存在');
    if (['queued', 'running'].includes(job.state)) job.controller.abort();
    return { cancelled: true };
  }
  function busy() { return exports.size > 0 || installations.size > 0 || mutations.size > 0 || [...jobs.values()].some(job => ['queued', 'running'].includes(job.state)); }
  async function shutdown() {
    closed = true;
    for (const job of jobs.values()) job.controller.abort();
    for (const install of installations.values()) install.controller.abort();
    await Promise.allSettled([queue, ...[...installations.values()].map(item => item.promise)]);
    await writeQueue;
  }
  return { list, install, setEnabled, uninstall, run, cancel, busy, shutdown, copyText: copyTextResult, saveText: saveTextResult, revealResult };
}

module.exports = { createImagePlugins, CATALOG, sanitizeOptions, processCpu };
