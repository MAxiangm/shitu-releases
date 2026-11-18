'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { VIDEO: VIDEO_EXTENSIONS } = require('./media-formats.cjs');
const { readDXVAlpha } = require('./dxv-format.cjs');

const PREVIEW_VERSION = 1;
const PREVIEW_MIME = 'video/webm';
const HOVER_VERSION = 2;
const HOVER_SECONDS = 2;
const MAX_PROBE_OUTPUT = 2 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;
// Reject playlist/concat demuxers: a media file must not instruct FFmpeg to open
// unrelated local files, and the protocol whitelist also forbids network access.
const INPUT_FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,avi,matroska,webm,mpeg,mpegvideo,mpegts,asf,flv,mxf,ogg,rm,dv';

function aborted() { return Object.assign(new Error('视频处理已取消'), { name: 'AbortError', code: 'ABORT_ERR' }); }
function checkSignal(signal) { if (signal?.aborted) throw aborted(); }
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label}必须是绝对路径`);
  return path.resolve(value);
}
function finite(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function displayMetadata(data) {
  const video = data?.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video || !(finite(video.width) > 0) || !(finite(video.height) > 0)) throw new Error('此文件没有可解码的视频画面');
  const rotation = finite(video.side_data_list?.find(item => item.rotation != null)?.rotation, finite(video.tags?.rotate));
  const swapped = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const duration = Math.max(0, finite(video.duration, finite(data.format?.duration)));
  return {
    width: swapped ? finite(video.height) : finite(video.width),
    height: swapped ? finite(video.width) : finite(video.height),
    duration, startTime: finite(data.format?.start_time),
    codec: String(video.codec_name || ''), pixelFormat: String(video.pix_fmt || ''), profile: String(video.profile || ''),
    streamIndex: Number.isInteger(video.index) && video.index >= 0 ? video.index : 0,
    hasAudio: Boolean(data.streams?.some(stream => stream.codec_type === 'audio')),
    audioCodec: String(data.streams?.find(stream => stream.codec_type === 'audio')?.codec_name || ''),
    hasAlpha: /^(?:yuva|rgba|bgra|argb|abgr|gbrap|ya8|ya16)/.test(String(video.pix_fmt || '')) || String(video.tags?.alpha_mode) === '1',
    rotation, colorSpace: String(video.color_space || ''), format: String(data.format?.format_name || '')
  };
}
async function sha256(filename, signal) {
  const hash = crypto.createHash('sha256');
  // Larger sequential reads reduce event-loop and filesystem overhead for
  // high-bitrate originals while retaining bounded memory and cancellation.
  for await (const chunk of createReadStream(filename, { highWaterMark: 1024 * 1024 })) { checkSignal(signal); hash.update(chunk); }
  checkSignal(signal);
  return hash.digest('hex');
}

function createVideoEngine({ runtimeDir = path.join(__dirname, '..', 'video-runtime'), cacheDir,
  onProgress = () => {}, timeouts = {} } = {}) {
  runtimeDir = absolute(runtimeDir, '视频组件目录');
  cacheDir = absolute(cacheDir, '视频缓存目录');
  const extension = process.platform === 'win32' ? '.exe' : '';
  const ffmpeg = path.join(runtimeDir, `ffmpeg${extension}`);
  const ffprobe = path.join(runtimeDir, `ffprobe${extension}`);
  const controllers = new Set();
  const tasks = new Set();
  const previews = new Map();
  const hoverJobs = new Map();
  const hoverMemory = new Map();
  const probeMemory = new Map();
  const frameMemory = new Map();
  const hashMemory = new Map();
  const fullMemory = new Map();
  const validationMemory = new Map();
  let hoverEncoding = Promise.resolve();
  let closed = false;

  function notify(event) { try { onProgress(event); } catch {} }
  function remember(memory, identity, value) {
    memory.delete(identity); memory.set(identity, value);
    while (memory.size > 64) memory.delete(memory.keys().next().value);
  }
  function track(promise) { tasks.add(promise); promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise; }
  function operation(signal, work) {
    if (closed) return Promise.reject(new Error('视频处理引擎已关闭'));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', cancel, { once: true });
    controllers.add(controller);
    return track(Promise.resolve().then(() => {
      checkSignal(controller.signal);
      return work(controller.signal);
    }).finally(() => {
      controllers.delete(controller);
      signal?.removeEventListener('abort', cancel);
    }));
  }
  async function sourceFile(source) {
    const filename = absolute(source, '视频文件');
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size === 0) throw new Error('视频文件不存在或为空');
    return { filename, stat };
  }
  const fileStamp = stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  async function stableHash(info, signal) {
    const stamp = fileStamp(info.stat), cached = hashMemory.get(info.filename);
    if (cached?.stamp === stamp) { checkSignal(signal); return cached.hash; }
    const hash = await sha256(info.filename, signal);
    if (fileStamp((await sourceFile(info.filename)).stat) !== stamp) throw new Error('视频文件在读取期间发生变化，请重试');
    remember(hashMemory, info.filename, { stamp, hash });
    return hash;
  }
  function run(executable, args, { signal, timeoutMs, outputLimit = MAX_PROBE_OUTPUT, onOutput } = {}) {
    checkSignal(signal);
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', failure = null;
      const child = spawn(executable, args, { cwd: runtimeDir, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = error => { failure ||= error; child.kill(); };
      const abort = () => stop(aborted());
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => stop(new Error('视频处理超时，请尝试较短的视频或重新打开')), timeoutMs);
      timeout.unref();
      child.stdout.on('data', chunk => {
        const text = chunk.toString('utf8');
        if (onOutput) {
          try { onOutput(text); } catch (error) { stop(error); }
        } else {
          stdout += text;
          if (Buffer.byteLength(stdout) > outputLimit) stop(new Error('视频信息超出读取上限'));
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT); });
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
      child.once('error', error => {
        cleanup();
        reject(error.code === 'ENOENT' ? new Error('视频解码组件缺失，请重新安装完整版本') : error);
      });
      child.once('close', code => {
        cleanup();
        if (failure) return reject(failure);
        if (signal?.aborted) return reject(aborted());
        if (code !== 0) {
          const error = new Error(`无法解码或转换此视频${stderr.trim() ? `：${stderr.trim().slice(-1600)}` : ''}`);
          error.exitCode = code;
          return reject(error);
        }
        resolve(stdout);
      });
    });
  }
  async function probeSource(source, signal) {
    const { filename, stat } = await sourceFile(source);
    const stamp = fileStamp(stat), cached = probeMemory.get(filename);
    if (cached?.stamp === stamp) { checkSignal(signal); return { ...cached.metadata }; }
    const output = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-show_streams', '-show_format', '-of', 'json', '-i', filename], {
      signal, timeoutMs: timeouts.probeMs || 30000
    });
    let data;
    try { data = JSON.parse(output); } catch { throw new Error('视频信息无法读取'); }
    const metadata = displayMetadata(data);
    if (metadata.codec === 'dxv') {
      // DXV's decoder reports RGBA for opaque DXT1 as well as alpha DXT5.
      // Read only the first packet header instead of guessing from pix_fmt.
      try {
        const packets = JSON.parse(await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
          '-select_streams', String(metadata.streamIndex), '-read_intervals', '%+#1', '-show_packets', '-show_entries', 'packet=pos', '-of', 'json', '-i', filename],
        { signal, timeoutMs: timeouts.probeMs || 30000 }));
        const value = packets.packets?.[0]?.pos;
        const position = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
        const alpha = await readDXVAlpha(filename, position);
        checkSignal(signal);
        if (alpha !== null) metadata.hasAlpha = alpha;
      } catch { checkSignal(signal); }
    }
    if (fileStamp((await sourceFile(filename)).stat) !== stamp) throw new Error('视频文件在读取期间发生变化，请重试');
    remember(probeMemory, filename, { stamp, metadata: { ...metadata } });
    return metadata;
  }
  function probe(source, { signal } = {}) { return operation(signal, internal => probeSource(source, internal)); }

  function adjacentFrame(source, time, direction) {
    if (!Number.isFinite(time) || time < 0 || ![-1, 1].includes(direction)) throw new Error('逐帧位置无效');
    return operation(undefined, async signal => {
      const { filename, stat } = await sourceFile(source);
      const stamp = fileStamp(stat);
      const metadata = await probeSource(filename, signal);
      const origin = metadata.startTime || 0;
      const position = metadata.duration > 0 ? Math.min(time, metadata.duration) : time;
      if (direction < 0 && position <= .0002) return null;
      const targetFrom = (frames, fromStart) => {
        if (!frames.length || (position + .0002 < frames[0] && (!fromStart || direction < 0))) return null;
        const after = frames.findIndex(frame => frame > position + .0002);
        const index = direction > 0 ? after : (after < 0 ? frames.length : after) - 2;
        if (index < 0 || index >= frames.length) return null;
        const frame = frames[index], next = frames[index + 1];
        // Seek just inside the target's presentation interval to avoid
        // rounding down into the previous frame on a coarse media timebase.
        const inset = next === undefined ? .0001 : Math.min(.0003, (next - frame) / 3);
        return { time: frame, seek: Math.min(frame + inset, metadata.duration || Infinity) };
      };
      const cached = frameMemory.get(filename);
      if (cached?.stamp === stamp && position <= cached.frames.at(-1) + .0004) {
        const result = targetFrom(cached.frames, cached.fromStart);
        if (result) return result;
      }
      const radii = [1, 8, 45];
      let previousStart, previousEnd;
      for (const radius of radii) {
        const start = Math.max(0, position - radius);
        const end = Math.min(metadata.duration ? metadata.duration + .1 : Infinity, position + radius);
        if (start === previousStart && end === previousEnd) break;
        previousStart = start; previousEnd = end;
        const interval = `${(Math.max(0, start + origin)).toFixed(6)}%${(end + origin).toFixed(6)}`;
        const output = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
          '-select_streams', String(metadata.streamIndex), '-read_intervals', interval, '-show_frames',
          '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', '-i', filename],
        { signal, timeoutMs: timeouts.probeMs || 30000 });
        const times = output.split(/\r?\n/).map(line => line.split(',')[0].trim())
          .filter(value => /^-?\d+(?:\.\d+)?$/.test(value)).map(value => Number((Number(value) - origin).toFixed(6)));
        const frames = [...new Set(times.map(frame => Math.max(0, frame)))].sort((a, b) => a - b);
        if (fileStamp((await sourceFile(filename)).stat) !== stamp) throw new Error('视频已变化，请重新打开预览');
        if (frames.length) remember(frameMemory, filename, { stamp, frames, fromStart: start === 0 });
        const result = targetFrom(frames, start === 0);
        if (result) return result;
        if (start === 0 && metadata.duration && end >= metadata.duration) break;
      }
      return null;
    });
  }

  function rememberHover(identity, value) {
    remember(hoverMemory, identity, value);
  }
  function completeMetadata(metadata) {
    return metadata && Number.isFinite(metadata.width) && metadata.width > 0 && Number.isFinite(metadata.height) && metadata.height > 0 && Number.isFinite(metadata.duration) && metadata.duration >= 0 &&
      /^[a-zA-Z0-9_.-]{1,80}$/.test(metadata.pixelFormat || '') && /^[a-zA-Z0-9_.-]{1,80}$/.test(metadata.codec || '') &&
      typeof metadata.hasAlpha === 'boolean' && typeof metadata.hasAudio === 'boolean' &&
      (metadata.hasAudio === false || typeof metadata.audioCodec === 'string') &&
      Number.isInteger(metadata.streamIndex) && metadata.streamIndex >= 0 && metadata.streamIndex <= 2147483647;
  }
  function nativeVideo(filename, metadata) {
    const suffix = path.extname(filename).toLowerCase();
    if (['.mp4', '.m4v'].includes(suffix) && metadata.codec === 'h264' &&
        ['yuv420p', 'yuvj420p'].includes(metadata.pixelFormat) && (!metadata.hasAudio || metadata.audioCodec === 'aac')) return 'video/mp4';
    if (suffix === '.webm' && ['vp8', 'vp9', 'av1'].includes(metadata.codec) &&
        (!metadata.hasAudio || ['opus', 'vorbis'].includes(metadata.audioCodec))) return PREVIEW_MIME;
    return null;
  }
  async function readHoverCache(output, metadataFile, identity, sourceStamp, signal) {
    try {
      const [stat, raw] = await Promise.all([fs.stat(output), fs.readFile(metadataFile, 'utf8')]);
      const data = JSON.parse(raw);
      if (!stat.isFile() || !stat.size || data.version !== HOVER_VERSION || data.identity !== identity || data.sourceStamp !== sourceStamp ||
          stat.size !== data.bytes || !(data.media?.width > 0) || !(data.media?.height > 0) || data.media.codec !== 'vp9' ||
          !(data.media.duration > 0 && data.media.duration <= HOVER_SECONDS + .2) || !/^[a-f0-9]{64}$/.test(data.outputHash || '')) return null;
      if (await sha256(output, signal) !== data.outputHash) return null;
      const result = { ...data.media, path: output, mimeType: PREVIEW_MIME, cached: true, profile: 'hover', sourceDuration: data.sourceDuration };
      rememberHover(identity, { sourceStamp, outputStamp: fileStamp(stat), result });
      return result;
    } catch { checkSignal(signal); return null; }
  }
  async function createHoverPreview(info, key, suppliedMetadata, signal) {
    const { filename, stat } = info;
    const sourceStamp = fileStamp(stat);
    // Hover uses a disposable, stat-bound preview. The catalog hash is already
    // trusted by the caller; scanning a multi-gigabyte original here would make
    // even native MP4s wait. Full-quality preview still verifies the full hash.
    const identity = crypto.createHash('sha256').update(`${key || ''}\0${filename}\0${sourceStamp}`).digest('hex');
    const memory = hoverMemory.get(identity);
    if (memory) {
      if (memory.result.direct) return { ...memory.result, cached: true };
      try {
        const outputStat = await fs.stat(memory.result.path);
        if (outputStat.isFile() && fileStamp(outputStat) === memory.outputStamp) return { ...memory.result, cached: true };
      } catch {}
      hoverMemory.delete(identity);
    }
    const output = path.join(cacheDir, `hover-v${HOVER_VERSION}-${identity}.webm`), metadataFile = `${output}.json`;
    const cached = await readHoverCache(output, metadataFile, identity, sourceStamp, signal);
    if (cached) { notify({ profile: 'hover', key, state: 'ready', cached: true }); return cached; }
    checkSignal(signal);
    const metadata = completeMetadata(suppliedMetadata) ? { ...suppliedMetadata } : await probeSource(filename, signal);
    const directMime = nativeVideo(filename, metadata);
    if (directMime) {
      const result = { ...metadata, path: filename, mimeType: directMime, direct: true, cached: false, profile: 'hover', sourceDuration: metadata.duration };
      rememberHover(identity, { sourceStamp, result });
      notify({ profile: 'hover', key, state: 'ready', direct: true });
      return result;
    }
    const encode = async () => {
      checkSignal(signal);
      await fs.mkdir(cacheDir, { recursive: true });
      const temporary = path.join(cacheDir, `.hover-preview-${crypto.randomUUID()}.webm`), temporaryMetadata = `${temporary}.json`;
      const color = metadata.colorSpace === 'ycgco' ? 'zscale=matrixin=ycgco:matrix=709,' : '';
      const filter = `${color}scale=w='min(640,iw)':h='min(360,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=24:round=up`;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
        '-threads', '4', '-filter_threads', '2', '-t', String(HOVER_SECONDS), '-i', filename, '-map', `0:${metadata.streamIndex || 0}`, '-an', '-sn', '-dn',
        '-vf', filter, '-frames:v', String(HOVER_SECONDS * 24), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
        '-row-mt', '1', '-threads', '4', '-crf', '38', '-b:v', '0', '-pix_fmt', metadata.hasAlpha ? 'yuva420p' : 'yuv420p',
        '-auto-alt-ref', '0', '-f', 'webm', '-y', temporary];
      notify({ profile: 'hover', key, state: 'converting', progress: 0 });
      try {
        await run(ffmpeg, args, { signal, timeoutMs: timeouts.hoverMs || 120000 });
        checkSignal(signal);
        if (fileStamp((await sourceFile(filename)).stat) !== sourceStamp) throw new Error('视频在预览准备期间已变化，请重试');
        const previewMetadata = await probeSource(temporary, signal), outputHash = await sha256(temporary, signal);
        const bytes = (await fs.stat(temporary)).size;
        if (!bytes || !(previewMetadata.duration > 0 && previewMetadata.duration <= HOVER_SECONDS + .2)) throw new Error('悬停预览生成失败');
        const media = { ...previewMetadata, sourceCodec: metadata.codec, sourceHasAlpha: metadata.hasAlpha };
        await fs.writeFile(temporaryMetadata, JSON.stringify({ version: HOVER_VERSION, identity, sourceStamp, outputHash, bytes,
          sourceDuration: metadata.duration, media }) + '\n', { flag: 'wx' });
        checkSignal(signal);
        await fs.rename(temporary, output); await fs.rename(temporaryMetadata, metadataFile);
        const result = { ...media, path: output, mimeType: PREVIEW_MIME, cached: false, profile: 'hover', sourceDuration: metadata.duration };
        rememberHover(identity, { sourceStamp, outputStamp: fileStamp(await fs.stat(output)), result });
        notify({ profile: 'hover', key, state: 'ready', cached: false });
        return result;
      } finally {
        await fs.unlink(temporary).catch(() => {}); await fs.unlink(temporaryMetadata).catch(() => {});
      }
    };
    // Old cancelled conversions finish releasing their process before the next
    // hover begins encoding, so rapid pointer movement cannot launch a swarm.
    const result = hoverEncoding.then(encode, encode);
    hoverEncoding = result.catch(() => {});
    return result;
  }

  async function hoverPreview(source, { key, signal, metadata } = {}) {
    if (closed) throw new Error('视频处理引擎已关闭');
    checkSignal(signal);
    if (key != null && (typeof key !== 'string' || !/^[a-fA-F0-9]{64}$/.test(key))) throw new Error('视频缓存标识无效');
    key = key?.toLowerCase();
    const info = await sourceFile(source);
    checkSignal(signal);
    const identity = `${key || ''}\0${info.filename}\0${fileStamp(info.stat)}`;
    let job = hoverJobs.get(identity);
    if (!job || job.controller.signal.aborted || job.settled) {
      const controller = new AbortController(); controllers.add(controller);
      job = { controller, consumers: new Set(), settled: false, promise: null };
      hoverJobs.set(identity, job);
      job.promise = track(Promise.resolve().then(() => createHoverPreview(info, key, metadata, controller.signal)).finally(() => {
        job.settled = true; controllers.delete(controller);
        if (hoverJobs.get(identity) === job) hoverJobs.delete(identity);
      }));
    }
    return subscribe(job, signal);
  }

  function thumbnail(source, destination, { signal } = {}) {
    return operation(signal, async internal => {
      const { filename } = await sourceFile(source);
      destination = absolute(destination, '缩略图路径');
      if (filename.toLowerCase() === destination.toLowerCase()) throw new Error('缩略图不能覆盖原视频');
      const metadata = await probeSource(filename, internal);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const temporary = path.join(path.dirname(destination), `.video-thumb-${crypto.randomUUID()}.jpg`);
      const seek = metadata.duration >= 1 ? Math.min(1, metadata.duration / 10) : 0;
      const input = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-threads', '2', '-i', filename];
      // DXV3 HQ stores YCoCg. Convert the matrix explicitly before ordinary scaling;
      // otherwise FFmpeg cannot negotiate this colourspace (and simply relabelling it is wrong).
      const color = metadata.colorSpace === 'ycgco' ? 'zscale=matrixin=ycgco:matrix=709,' : '';
      const output = ['-ss', String(seek), '-map', `0:${metadata.streamIndex}`, '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `${color}scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease,setsar=1`, '-q:v', '3', '-f', 'image2', '-update', '1', '-y', temporary];
      try {
        await run(ffmpeg, [...input, ...output], { signal: internal, timeoutMs: timeouts.thumbnailMs || 60000 });
        checkSignal(internal);
        if (!(await fs.stat(temporary)).size) throw new Error('未能生成视频缩略图');
        await fs.rename(temporary, destination);
        return metadata;
      } finally { await fs.unlink(temporary).catch(() => {}); }
    });
  }

  async function cachedPreview(output, metadataFile, hash, signal) {
    try {
      const [file, metadataStat] = await Promise.all([fs.stat(output), fs.stat(metadataFile)]);
      const identity = `${output}\0${hash}`, outputStamp = fileStamp(file), metadataStamp = fileStamp(metadataStat);
      const verified = validationMemory.get(identity);
      if (verified?.outputStamp === outputStamp && verified.metadataStamp === metadataStamp) { checkSignal(signal); return { ...verified.result, cached: true }; }
      const raw = await fs.readFile(metadataFile, 'utf8');
      const metadata = JSON.parse(raw);
      if (!file.isFile() || file.size === 0 || metadata.version !== PREVIEW_VERSION || metadata.sourceHash !== hash || file.size !== metadata.bytes ||
          !(metadata.width > 0) || !(metadata.height > 0) || !/^[a-f0-9]{64}$/.test(metadata.outputHash)) return null;
      if (await stableHash({ filename: output, stat: file }, signal) !== metadata.outputHash) return null;
      if (fileStamp(await fs.stat(metadataFile)) !== metadataStamp) return null;
      const result = { path: output, mimeType: PREVIEW_MIME, ...metadata.media, width: metadata.width, height: metadata.height, cached: true };
      remember(validationMemory, identity, { outputStamp, metadataStamp, result });
      return result;
    } catch (error) { checkSignal(signal); return null; }
  }
  async function rememberFull(info, hash, result) {
    if (fileStamp((await sourceFile(info.filename)).stat) !== fileStamp(info.stat)) throw new Error('视频文件在预览准备期间发生变化，请重试');
    const outputStamp = fileStamp(await fs.stat(result.path));
    const metadataStamp = result.direct ? null : fileStamp(await fs.stat(`${result.path}.json`));
    remember(fullMemory, `${info.filename}\0${hash}`, { sourceStamp: fileStamp(info.stat), outputStamp, metadataStamp, result: { ...result } });
  }
  async function readyPreview(info, key, signal) {
    const stamp = fileStamp(info.stat), known = hashMemory.get(info.filename);
    // This path never establishes trust by itself. Only a prior full read can
    // populate hashMemory, and every relevant file must still have that stamp.
    if (!known || known.stamp !== stamp || (key && key !== known.hash)) return null;
    const identity = `${info.filename}\0${known.hash}`, cached = fullMemory.get(identity);
    if (!cached || cached.sourceStamp !== stamp) return null;
    try {
      if (fileStamp(await fs.stat(cached.result.path)) !== cached.outputStamp ||
          (cached.metadataStamp && fileStamp(await fs.stat(`${cached.result.path}.json`)) !== cached.metadataStamp)) {
        fullMemory.delete(identity); return null;
      }
      checkSignal(signal);
      return { ...cached.result, cached: true };
    } catch { checkSignal(signal); fullMemory.delete(identity); return null; }
  }
  async function getReadyPreview(source, { key, signal } = {}) {
    if (closed) throw new Error('视频处理引擎已关闭');
    checkSignal(signal);
    if (key != null && (typeof key !== 'string' || !/^[a-fA-F0-9]{64}$/.test(key))) throw new Error('视频缓存标识无效');
    return readyPreview(await sourceFile(source), key?.toLowerCase(), signal);
  }
  async function createPreview(source, key, signal, suppliedMetadata, onOperationProgress) {
    const report = event => { notify(event); try { onOperationProgress?.(event); } catch {} };
    const info = await sourceFile(source), { filename } = info;
    const hash = await stableHash(info, signal);
    if (key && key !== hash) throw new Error('视频文件内容已变化，请重新导入后预览');
    const ready = await readyPreview(info, hash, signal);
    if (ready) { report({ key: hash, state: 'ready', progress: 100, cached: true }); return ready; }
    const metadata = completeMetadata(suppliedMetadata) ? { ...suppliedMetadata } : await probeSource(filename, signal);
    const extension = path.extname(filename).toLowerCase();
    const nativeMp4 = ['.mp4', '.m4v'].includes(extension) && metadata.codec === 'h264' &&
      ['yuv420p', 'yuvj420p'].includes(metadata.pixelFormat) && (!metadata.hasAudio || metadata.audioCodec === 'aac');
    const nativeWebm = extension === '.webm' && ['vp8', 'vp9', 'av1'].includes(metadata.codec) &&
      (!metadata.hasAudio || ['opus', 'vorbis'].includes(metadata.audioCodec));
    if (nativeMp4 || nativeWebm) {
      const result = { path: filename, mimeType: nativeMp4 ? 'video/mp4' : PREVIEW_MIME, ...metadata, cached: false, direct: true };
      await rememberFull(info, hash, result);
      report({ key: hash, state: 'ready', progress: 100, direct: true });
      return result;
    }
    await fs.mkdir(cacheDir, { recursive: true });
    const output = path.join(cacheDir, `video-v${PREVIEW_VERSION}-${hash}.webm`);
    const metadataFile = `${output}.json`;
    const cached = await cachedPreview(output, metadataFile, hash, signal);
    if (cached) { await rememberFull(info, hash, cached); report({ key: hash, state: 'ready', progress: 100, cached: true }); return cached; }
    const temporary = path.join(cacheDir, `.video-preview-${crypto.randomUUID()}.webm`);
    const temporaryMetadata = `${temporary}.json`;
    let pending = '', lastProgress = -1;
    const progress = chunk => {
      pending += chunk;
      if (pending.length > 65536) pending = pending.slice(-65536);
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (!match) continue;
        const seconds = Number(match[1]) / 1000000;
        const percent = metadata.duration > 0 ? Math.min(99, Math.floor(seconds / metadata.duration * 100)) : 0;
        if (percent !== lastProgress) { lastProgress = percent; report({ key: hash, state: 'converting', progress: percent, seconds, duration: metadata.duration }); }
      }
    };
    report({ key: hash, state: 'converting', progress: 0, duration: metadata.duration });
    const color = metadata.colorSpace === 'ycgco' ? 'zscale=matrixin=ycgco:matrix=709,' : '';
    const videoFilter = `${color}scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-threads', '2', '-i', filename,
      '-map', `0:${metadata.streamIndex}`, '-map', '0:a:0?', '-sn', '-dn', '-vf', videoFilter,
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-threads', '4', '-crf', '32', '-b:v', '0',
      '-pix_fmt', metadata.hasAlpha ? 'yuva420p' : 'yuv420p', '-auto-alt-ref', '0',
      '-c:a', 'libopus', '-b:a', '96k', '-ac', '2', '-progress', 'pipe:1', '-nostats', '-f', 'webm', '-y', temporary];
    try {
      await run(ffmpeg, args, { signal, timeoutMs: timeouts.previewMs || 30 * 60000, onOutput: progress });
      checkSignal(signal);
      if (fileStamp((await sourceFile(filename)).stat) !== fileStamp(info.stat)) throw new Error('视频文件在预览准备期间发生变化，请重试');
      const previewMetadata = await probeSource(temporary, signal);
      const outputHash = await sha256(temporary, signal);
      const size = (await fs.stat(temporary)).size;
      if (!size) throw new Error('视频预览文件为空');
      const media = { ...previewMetadata, sourceCodec: metadata.codec, sourceHasAlpha: metadata.hasAlpha };
      await fs.writeFile(temporaryMetadata, JSON.stringify({ version: PREVIEW_VERSION, sourceHash: hash, outputHash, bytes: size,
        width: media.width, height: media.height, media }) + '\n', { flag: 'wx' });
      checkSignal(signal);
      await fs.rename(temporary, output);
      await fs.rename(temporaryMetadata, metadataFile);
      const result = { path: output, mimeType: PREVIEW_MIME, ...media, cached: false };
      await rememberFull(info, hash, result);
      report({ key: hash, state: 'ready', progress: 100, cached: false });
      return result;
    } catch (error) {
      report({ key: hash, state: error.name === 'AbortError' ? 'cancelled' : 'error', error: error.message });
      throw error;
    } finally {
      await fs.unlink(temporary).catch(() => {});
      await fs.unlink(temporaryMetadata).catch(() => {});
    }
  }
  function subscribe(job, signal) {
    const token = {};
    job.consumers.add(token);
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (handler, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', cancel);
        job.consumers.delete(token);
        if (!job.settled && job.consumers.size === 0) job.controller.abort();
        handler(value);
      };
      const cancel = () => finish(reject, aborted());
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      job.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  async function preview(source, { key, signal, metadata, onProgress } = {}) {
    if (closed) throw new Error('视频处理引擎已关闭');
    checkSignal(signal);
    source = absolute(source, '视频文件');
    if (key != null && (typeof key !== 'string' || !/^[a-fA-F0-9]{64}$/.test(key))) throw new Error('视频缓存标识无效');
    key = key?.toLowerCase();
    // The source path is included only in the in-flight map, never in a cache filename.
    const identity = `${key || ''}\0${source}`;
    let job = previews.get(identity);
    // Cancelling the last subscriber aborts immediately, while its process and
    // temporary files can still be cleaning up. A retry must not join that job.
    if (!job || job.controller.signal.aborted || job.settled) {
      const controller = new AbortController();
      controllers.add(controller);
      job = { controller, consumers: new Set(), settled: false, promise: null };
      previews.set(identity, job);
      job.promise = track(Promise.resolve().then(() => createPreview(source, key, controller.signal, metadata, onProgress)).finally(() => {
        job.settled = true; controllers.delete(controller);
        if (previews.get(identity) === job) previews.delete(identity);
      }));
    }
    return subscribe(job, signal);
  }
  async function shutdown() {
    closed = true;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...tasks]);
  }
  return { probe, adjacentFrame, thumbnail, preview, getReadyPreview, hoverPreview, busy: () => tasks.size > 0, shutdown };
}

module.exports = { createVideoEngine, VIDEO_EXTENSIONS, PREVIEW_VERSION, HOVER_VERSION, HOVER_SECONDS, displayMetadata };
