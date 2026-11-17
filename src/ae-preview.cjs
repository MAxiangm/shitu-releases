'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { findAfterEffectsTool, launchAfterEffects, readBridgeReport } = require('./ae-projects.cjs');

// Includes wrapper size, representative-frame sampling and JPEG selection policy.
const PREVIEW_VERSION = 1;
const SCRIPT = path.join(__dirname, 'ae-scripts', 'preview.jsx');
function aborted() { return Object.assign(new Error('AE 合成预览已取消'), { name: 'AbortError', code: 'ABORT_ERR' }); }
function check(signal) { if (signal?.aborted) throw aborted(); }
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label}必须是绝对路径`);
  return path.resolve(value);
}
function inside(parent, filename) {
  const relative = path.relative(path.resolve(parent), path.resolve(filename));
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function regular(filename) {
  const info = await fs.lstat(filename);
  // Windows TEMP commonly uses an 8.3 parent alias; canonicalize the parent
  // before comparing so a normal file there is not mistaken for a symlink.
  const expected = path.join(await fs.realpath(path.dirname(filename)), path.basename(filename));
  if (!info.isFile() || info.isSymbolicLink() || path.resolve(await fs.realpath(filename)).toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error('AE 预览路径不是普通文件');
  return info;
}
async function digest(filename, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) { check(signal); hash.update(chunk); }
  check(signal); return hash.digest('hex');
}
async function remove(parent, directory) {
  if (!inside(parent, directory)) throw new Error('AE 预览临时目录范围无效');
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
function compositionId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^[1-9]\d{0,14}$/.test(String(value))) throw new Error('AE 合成编号无效');
  return String(value);
}
function chooseComposition(compositions) {
  if (!Array.isArray(compositions)) return null;
  const all = compositions.filter(item => item && Number(item.duration) > 0 && Number(item.width) > 0 && Number(item.height) > 0 && /^[1-9]\d{0,14}$/.test(String(item.id)));
  const roots = all.filter(item => Number(item.usedInCount) === 0);
  const candidates = roots.length ? roots : all;
  function score(item) {
    let value = Math.log(Math.max(1, item.width * item.height)) + Math.log(Math.max(1, item.duration));
    if (/^(?:main|final|master|主合成|最终|成片)(?:$|\b|[ _\-\d])/i.test(String(item.name))) value += 3;
    return value;
  }
  return candidates.reduce((best, item) => !best || score(item) > score(best) ? item : best, null);
}
function validComposition(value) {
  return value && /^[1-9]\d{0,14}$/.test(String(value.id)) && Number.isInteger(value.index) && value.index > 0 &&
    typeof value.name === 'string' && ['width', 'height', 'duration', 'frameRate'].every(key => Number.isFinite(value[key]) && value[key] > 0);
}
function validMetadata(value) {
  return value && Number.isInteger(value.width) && value.width > 0 && value.width <= 1280 && Number.isInteger(value.height) && value.height > 0 && value.height <= 720 &&
    Number.isFinite(value.duration) && value.duration > 0 && Number.isFinite(value.frameRate) && value.frameRate > 0 &&
    Number.isFinite(value.representativeTime) && value.representativeTime >= 0 && value.representativeTime < value.duration && value.mimeType === 'image/jpeg';
}
async function imageCandidate(filename) {
  await regular(filename);
  const image = sharp(filename, { limitInputPixels: 1280 * 720 });
  const info = await image.metadata();
  if (info.format !== 'png' || !info.width || !info.height || info.width > 1280 || info.height > 720) throw new Error('AE 未生成有效的合成预览图片');
  const { data, info: sample } = await image.flatten({ background: '#111111' }).removeAlpha().resize(64, 64, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  let total = 0, squared = 0, visible = 0;
  const count = sample.width * sample.height;
  for (let index = 0; index < data.length; index += sample.channels) {
    const luminance = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    total += luminance; squared += luminance * luminance;
    if (Math.max(data[index], data[index + 1], data[index + 2]) > 28) visible++;
  }
  const mean = total / count, deviation = Math.sqrt(Math.max(0, squared / count - mean * mean));
  // Prefer an informative visible frame over opening black/transparent frames.
  // Preserve the earlier candidate when two frames are visually equivalent.
  return { width: info.width, height: info.height, score: visible / count * 100 + Math.min(40, deviation) + Math.min(10, mean / 25) };
}

function createAEPreviewEngine({ cacheDir, runtimeDir, onProgress = () => {}, timeoutMs = 180000,
  toolLocator = findAfterEffectsTool, launch = launchAfterEffects } = {}) {
  cacheDir = absolute(cacheDir, 'AE 预览缓存目录');
  // Accepted for API compatibility; static previews use native AE + bundled sharp.
  if (runtimeDir !== undefined) absolute(runtimeDir, '视频组件目录');
  const jobs = new Map(), active = new Set();
  let queue = Promise.resolve(), closed = false;
  function notify(job, state, progress, extra = {}) {
    try { onProgress({ assetHash: job.assetHash, compositionId: job.compositionId === null ? null : Number(job.compositionId), state, progress, ...extra }); } catch {}
  }
  async function cached(directory, job, signal) {
    try {
      const directoryInfo = await fs.lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return null;
      const filename = path.join(directory, 'thumbnail.jpg'), manifestFile = path.join(directory, 'manifest.json');
      if ((await regular(manifestFile)).size > 8 * 1024 * 1024) return null;
      const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
      const info = await regular(filename);
      if (manifest.version !== PREVIEW_VERSION || manifest.identity !== job.identity || manifest.sourceHash !== job.sourceHash || manifest.assetHash !== job.assetHash ||
          manifest.bytes !== info.size || !(info.size > 0) || !/^[a-f0-9]{64}$/.test(manifest.outputHash) || !validComposition(manifest.composition) || !validMetadata(manifest.metadata) ||
          job.compositionId !== null && String(manifest.composition.id) !== job.compositionId || !Array.isArray(manifest.compositions) || manifest.compositions.length > 10000 ||
          !manifest.compositions.every(validComposition) || !manifest.compositions.some(comp => String(comp.id) === String(manifest.composition.id)) ||
          !Array.isArray(manifest.warnings) || manifest.warnings.some(warning => typeof warning !== 'string')) return null;
      if (await digest(filename, signal) !== manifest.outputHash) return null;
      const image = await sharp(filename, { limitInputPixels: 1280 * 720 }).metadata();
      if (image.format !== 'jpeg' || image.width !== manifest.metadata.width || image.height !== manifest.metadata.height) return null;
      return { thumbnailPath: filename, composition: manifest.composition, compositions: manifest.compositions,
        metadata: manifest.metadata, warnings: manifest.warnings || [], cached: true };
    } catch { check(signal); return null; }
  }
  async function generate(job) {
    const signal = job.controller.signal;
    check(signal);
    if (closed) throw aborted();
    await fs.mkdir(cacheDir, { recursive: true });
    const destination = path.join(cacheDir, `ae-static-v${PREVIEW_VERSION}-${job.identity}`);
    const existing = await cached(destination, job, signal);
    if (existing) { notify(job, 'ready', 1, { cached: true, compositionId: existing.composition.id }); return existing; }
    notify(job, 'preparing', 0.05);
    const tool = await toolLocator(job.source);
    check(signal);
    if (!tool) throw new Error('未找到可读取此工程版本的 After Effects，请安装对应 AE 后生成合成预览');
    const work = await fs.mkdtemp(path.join(cacheDir, '.ae-static-'));
    let control;
    try {
      control = await fs.mkdtemp(path.join(os.tmpdir(), 'shitu-ae-preview-'));
      const token = crypto.randomUUID(), script = path.join(control, 'preview.jsx'), task = path.join(control, 'job.json');
      const reportProject = path.join(work, 'report.aepx');
      await fs.writeFile(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await fs.readFile(SCRIPT)]));
      await fs.writeFile(task, JSON.stringify({ protocol: 1, token, source: job.source, compositionId: job.compositionId,
        outputDirectory: work, reportProject }));
      const env = { ...process.env, SHITU_AE_PREVIEW_JOB: task }; delete env.ELECTRON_RUN_AS_NODE;
      const executable = tool.executable || tool;
      notify(job, 'rendering', 0.15);
      const launched = await launch(executable, ['-m', '-noui', '-r', script], { env, cwd: path.dirname(executable), signal, timeoutMs });
      check(signal);
      let report;
      try { report = (await readBridgeReport(reportProject, token)).report; }
      catch (error) {
        if (launched?.output) error.diagnostics = launched.output.slice(-16000);
        throw new Error(`AE 合成预览未完成：${error.message}`, { cause: error });
      }
      if (!validComposition(report.composition) || job.compositionId !== null && String(report.composition.id) !== job.compositionId || !Array.isArray(report.compositions) ||
          !report.compositions.every(validComposition) || !Array.isArray(report.frames) || report.frames.length < 1 || report.frames.length > 3) throw new Error('AE 返回的合成预览信息无效');
      const frames = [];
      for (const frame of report.frames) {
        check(signal);
        if (typeof frame.path !== 'string' || !inside(work, frame.path) || !/^frame-[0-2]\.png$/.test(path.basename(frame.path)) || !Number.isFinite(frame.time)) throw new Error('AE 返回的预览图片路径无效');
        const image = await imageCandidate(frame.path);
        frames.push({ ...frame, ...image });
      }
      const chosen = frames.reduce((best, frame) => !best || frame.score > best.score + 0.05 ? frame : best, null);
      // Never publish a preview if its managed project was changed while AE read it.
      if (await digest(job.source, signal) !== job.sourceHash) throw new Error('AE 工程内容已变化，请重新生成预览');
      notify(job, 'rendering', 0.9, { compositionId: report.composition.id });
      const completed = path.join(work, 'completed'); await fs.mkdir(completed);
      const output = path.join(completed, 'thumbnail.jpg');
      await sharp(chosen.path, { limitInputPixels: 1280 * 720 }).flatten({ background: '#171717' }).jpeg({ quality: 88, mozjpeg: true }).toFile(output);
      check(signal);
      const metadata = { width: chosen.width, height: chosen.height, frameRate: Number(report.composition.frameRate),
        duration: Number(report.composition.duration), representativeTime: chosen.time, mimeType: 'image/jpeg', aeVersion: String(report.version || '') };
      if (!validMetadata(metadata)) throw new Error('AE 返回的代表帧时间无效');
      const warnings = Array.isArray(report.warnings) ? report.warnings.map(value => String(value).slice(0, 1000)).slice(0, 100) : [];
      if (chosen.score < 1) warnings.push('当前合成的代表帧为黑场或透明画面，可切换其他合成查看。');
      const manifest = { version: PREVIEW_VERSION, identity: job.identity, sourceHash: job.sourceHash, assetHash: job.assetHash,
        composition: report.composition, compositions: report.compositions || [report.composition], metadata, warnings,
        bytes: (await fs.stat(output)).size, outputHash: await digest(output, signal) };
      await fs.writeFile(path.join(completed, 'manifest.json'), JSON.stringify(manifest));
      check(signal);
      await remove(cacheDir, destination);
      await fs.rename(completed, destination);
      const result = { thumbnailPath: path.join(destination, 'thumbnail.jpg'), composition: manifest.composition,
        compositions: manifest.compositions, metadata, warnings, cached: false };
      notify(job, 'ready', 1, { compositionId: report.composition.id });
      return result;
    } finally {
      await Promise.allSettled([remove(cacheDir, work), ...(control ? [remove(os.tmpdir(), control)] : [])]);
    }
  }
  function subscribe(job, signal) {
    return new Promise((resolve, reject) => {
      const consumer = {}; let done = false;
      function detach() {
        signal?.removeEventListener('abort', cancel);
        job.consumers.delete(consumer);
        if (!job.settled && job.consumers.size === 0) {
          job.controller.abort();
          if (jobs.get(job.identity) === job) jobs.delete(job.identity);
        }
      }
      function cancel() { if (done) return; done = true; detach(); reject(aborted()); }
      job.consumers.add(consumer);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) return cancel();
      job.promise.then(result => { if (!done) { done = true; detach(); resolve(result); } }, error => { if (!done) { done = true; detach(); reject(error); } });
    });
  }
  async function request(options = {}) {
    if (closed) throw new Error('AE 预览引擎已关闭');
    const signal = options.signal; check(signal);
    const source = absolute(options.source, 'AE 工程');
    if (!['.aep', '.aepx'].includes(path.extname(source).toLowerCase())) throw new Error('请选择 AEP 或 AEPX 工程');
    if (!(await regular(source)).size) throw new Error('AE 工程为空');
    const sourceHash = await digest(source, signal);
    const assetHash = options.assetHash || options.sourceHash || sourceHash;
    if (typeof assetHash !== 'string' || !/^[a-f0-9]{64}$/i.test(assetHash)) throw new Error('AE 工程包身份无效');
    const selected = options.compositionId === undefined || options.compositionId === null ? chooseComposition(options.compositions)?.id : options.compositionId;
    const id = compositionId(selected);
    const identity = crypto.createHash('sha256').update(JSON.stringify([PREVIEW_VERSION, source.toLowerCase(), sourceHash, assetHash.toLowerCase(), id])).digest('hex');
    check(signal); if (closed) throw new Error('AE 预览引擎已关闭');
    let job = jobs.get(identity);
    if (!job || job.controller.signal.aborted) {
      job = { identity, source, sourceHash, assetHash: assetHash.toLowerCase(), compositionId: id, controller: new AbortController(), consumers: new Set(), settled: false };
      jobs.set(identity, job);
      notify(job, 'queued', 0);
      job.promise = queue.then(() => generate(job)).catch(error => {
        notify(job, error.name === 'AbortError' ? 'cancelled' : 'error', 0, { message: error.message });
        throw error;
      }).finally(() => { job.settled = true; if (jobs.get(identity) === job) jobs.delete(identity); });
      active.add(job.promise);
      job.promise.then(() => active.delete(job.promise), () => active.delete(job.promise));
      queue = job.promise.catch(() => {});
    }
    return subscribe(job, signal);
  }
  async function shutdown() {
    closed = true;
    for (const job of jobs.values()) job.controller.abort();
    await Promise.allSettled([...active]);
  }
  return { preview: request, prepare: request, shutdown };
}

module.exports = { createAEPreviewEngine, chooseComposition, PREVIEW_VERSION };
