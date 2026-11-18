'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PREVIEW_VERSION = 1;
const MAX_OUTPUT = 512 * 1024 * 1024;
// A music file must not instruct the decoder to open playlists, network URLs,
// or unrelated files. Every source below is a self-contained media container.
const INPUT_FORMATS = 'mp3,wav,flac,mov,mp4,m4a,3gp,3g2,mj2,aac,ogg,aiff,ape,asf,amr,amrnb,amrwb,ac3,eac3,dts,dtshd,matroska,webm,au,wv,tta,dsf,iff,caf,w64';
function cancelled() { return Object.assign(new Error('音乐预览已取消'), { name: 'AbortError', code: 'ABORT_ERR' }); }
function check(signal) { if (signal?.aborted) throw cancelled(); }
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('音乐文件必须是绝对路径');
  return path.resolve(value);
}
function number(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
function tag(value) { return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 512) : ''; }
function audioMetadata(data) {
  const stream = data?.streams?.find(item => item.codec_type === 'audio');
  if (!stream || !stream.codec_name) throw new Error('此文件没有可解码的音轨');
  if (data.streams.some(item => item.codec_type === 'video' && !item.disposition?.attached_pic)) {
    throw Object.assign(new Error('此文件包含视频画面'), { code: 'AUDIO_HAS_VIDEO' });
  }
  const audio = {};
  const tags = { ...data.format?.tags, ...stream.tags };
  const normalized = Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]));
  for (const [field, keys] of Object.entries({ title: ['title'], artist: ['artist', 'author'], album: ['album'],
    albumArtist: ['album_artist', 'albumartist'], genre: ['genre'], track: ['track', 'tracknumber'], date: ['date', 'year'] })) {
    const value = keys.map(key => tag(normalized[key])).find(Boolean); if (value) audio[field] = value;
  }
  return { mediaType: 'audio', duration: number(stream.duration) || number(data.format?.duration),
    codec: String(stream.codec_name), audioCodec: String(stream.codec_name), hasAudio: true,
    sampleRate: number(stream.sample_rate), channels: number(stream.channels),
    bitrate: number(stream.bit_rate) || number(data.format?.bit_rate),
    bitsPerSample: number(stream.bits_per_raw_sample) || number(stream.bits_per_sample),
    audio, streamIndex: Number.isInteger(stream.index) ? stream.index : 0,
    coverIndex: data.streams.find(item => item.codec_type === 'video' && item.disposition?.attached_pic)?.index ?? null };
}
function publicMetadata(metadata) { const { streamIndex, coverIndex, ...result } = metadata; return result; }
function nativeMime(filename, metadata) {
  const ext = path.extname(filename).slice(1).toLowerCase(), codec = metadata.audioCodec;
  if (ext === 'mp3' && codec === 'mp3') return 'audio/mpeg';
  if (['wav', 'wave'].includes(ext) && ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'].includes(codec)) return 'audio/wav';
  if (ext === 'flac' && codec === 'flac') return 'audio/flac';
  if (['m4a', 'm4b'].includes(ext) && codec === 'aac') return 'audio/mp4';
  if (ext === 'aac' && codec === 'aac') return 'audio/aac';
  if (['ogg', 'oga', 'opus'].includes(ext) && ['opus', 'vorbis'].includes(codec)) return 'audio/ogg';
  return null;
}

function createAudioEngine({ runtimeDir = path.join(__dirname, '..', 'video-runtime'), cacheDir, timeouts = {} } = {}) {
  runtimeDir = absolute(runtimeDir); cacheDir = absolute(cacheDir);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const ffmpeg = path.join(runtimeDir, `ffmpeg${suffix}`), ffprobe = path.join(runtimeDir, `ffprobe${suffix}`);
  const controllers = new Set(), tasks = new Set(), previews = new Map(), probes = new Map();
  let closed = false;
  const stamp = info => `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
  async function sourceFile(value) {
    const filename = absolute(value), info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error('音乐文件不存在、为空或不是普通文件');
    return { filename, info };
  }
  function track(promise) { tasks.add(promise); promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise; }
  function operation(signal, work) {
    if (closed) return Promise.reject(new Error('音乐预览引擎已关闭'));
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    controllers.add(controller);
    return track(Promise.resolve().then(() => { check(controller.signal); return work(controller.signal); }).finally(() => {
      controllers.delete(controller); signal?.removeEventListener('abort', abort);
    }));
  }
  function run(executable, args, { signal, timeoutMs, onOutput } = {}) {
    check(signal);
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', failure;
      const child = spawn(executable, args, { windowsHide: true, shell: false, cwd: runtimeDir, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = error => { failure ||= error; child.kill(); };
      const abort = () => stop(cancelled());
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop(new Error('音乐预览处理超时')), timeoutMs); timer.unref();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      child.stdout.on('data', bytes => {
        const value = bytes.toString('utf8');
        if (onOutput) { try { onOutput(value); } catch (error) { stop(error); } }
        else { stdout += value; if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) stop(new Error('音乐信息超出读取上限')); }
      });
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-12000); });
      child.once('error', error => { cleanup(); reject(error.code === 'ENOENT' ? new Error('音乐解码组件缺失，请重新安装完整版本') : error); });
      child.once('close', code => {
        cleanup();
        if (failure) return reject(failure);
        if (signal?.aborted) return reject(cancelled());
        if (code !== 0) return reject(new Error(`无法读取或转换此音乐文件${stderr.trim() ? `：${stderr.trim().slice(-1000)}` : ''}`));
        resolve(stdout);
      });
    });
  }
  async function hash(filename, signal) {
    const digest = crypto.createHash('sha256');
    for await (const bytes of createReadStream(filename, { highWaterMark: 1024 * 1024 })) { check(signal); digest.update(bytes); }
    return digest.digest('hex');
  }
  async function probeSource(source, signal) {
    const { filename, info } = await sourceFile(source), before = stamp(info), cached = probes.get(filename);
    if (cached?.stamp === before) { check(signal); return structuredClone(cached.metadata); }
    const output = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
      '-show_streams', '-show_format', '-of', 'json', '-i', filename], { signal, timeoutMs: timeouts.probeMs || 30000 });
    const metadata = audioMetadata(JSON.parse(output));
    if (stamp((await sourceFile(filename)).info) !== before) throw new Error('音乐文件在读取时发生变化，请重试');
    probes.delete(filename); probes.set(filename, { stamp: before, metadata });
    while (probes.size > 64) probes.delete(probes.keys().next().value);
    return structuredClone(metadata);
  }
  function probe(source, { signal } = {}) { return operation(signal, async internal => publicMetadata(await probeSource(source, internal))); }
  function thumbnail(source, destination, { signal } = {}) {
    return operation(signal, async internal => {
      const { filename, info } = await sourceFile(source), metadata = await probeSource(filename, internal);
      if (metadata.coverIndex === null) return publicMetadata(metadata);
      const target = absolute(destination);
      if (target === filename) throw new Error('音乐封面不能覆盖原文件');
      const temporary = `${target}.${crypto.randomUUID()}.tmp.jpg`;
      try {
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
          '-i', filename, '-map', `0:${metadata.coverIndex}`, '-frames:v', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease',
          '-c:v', 'mjpeg', '-q:v', '3', '-threads', '1', '-f', 'image2', '-n', temporary], { signal: internal, timeoutMs: timeouts.thumbnailMs || 30000 });
        check(internal);
        if (stamp((await sourceFile(filename)).info) !== stamp(info)) throw new Error('音乐文件在读取时发生变化，请重试');
        await fs.rename(temporary, target);
      } catch (error) {
        check(internal);
        if (stamp((await sourceFile(filename)).info) !== stamp(info)) throw new Error('音乐文件在读取时发生变化，请重试');
        // An unreadable picture must not discard valid music metadata or stop
        // the original track from being imported and played.
      } finally { await fs.unlink(temporary).catch(() => {}); }
      return publicMetadata(metadata);
    });
  }
  async function cachedPreview(output, metadataFile, sourceHash, signal) {
    try {
      const data = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
      if (data.version !== PREVIEW_VERSION || data.sourceHash !== sourceHash || !/^[a-f0-9]{64}$/.test(data.outputHash)) return null;
      const info = await fs.lstat(output);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== data.bytes || !info.size || info.size > MAX_OUTPUT || await hash(output, signal) !== data.outputHash) return null;
      const metadata = await probeSource(output, signal);
      if (metadata.audioCodec !== 'mp3' || !(metadata.duration > 0)) return null;
      return { ...publicMetadata(metadata), audio: data.audio || {}, path: output, mimeType: 'audio/mpeg', direct: false, transcoded: true, cached: true };
    } catch { check(signal); return null; }
  }
  async function createPreview(source, key, signal, forceTranscode, progress) {
    const { filename, info } = await sourceFile(source), before = stamp(info);
    const sourceHash = await hash(filename, signal);
    if (key && key !== sourceHash) throw new Error('音乐文件内容已变化，请重新导入后预览');
    const metadata = await probeSource(filename, signal), mimeType = forceTranscode ? null : nativeMime(filename, metadata);
    if (stamp((await sourceFile(filename)).info) !== before) throw new Error('音乐文件在读取时发生变化，请重试');
    if (mimeType) return { ...publicMetadata(metadata), path: filename, mimeType, direct: true, transcoded: false, cached: false };
    if (metadata.duration > 86400) throw new Error('此音乐过长，请使用系统播放器打开原文件');
    await fs.mkdir(cacheDir, { recursive: true });
    const output = path.join(cacheDir, `audio-v${PREVIEW_VERSION}-${sourceHash}.mp3`), metadataFile = `${output}.json`;
    const cached = await cachedPreview(output, metadataFile, sourceHash, signal);
    if (cached) return { ...cached, ...publicMetadata(metadata), path: output, mimeType: 'audio/mpeg', direct: false, transcoded: true, cached: true };
    const temporary = path.join(cacheDir, `.audio-${crypto.randomUUID()}.mp3`), temporaryMetadata = `${temporary}.json`;
    let pending = '';
    try {
      progress?.({ state: 'converting', progress: 0 });
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
        '-i', filename, '-map', `0:${metadata.streamIndex}`, '-vn', '-sn', '-dn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '48000',
        '-ac', '2', '-threads', '2', '-fs', String(MAX_OUTPUT), '-progress', 'pipe:1', '-nostats', '-f', 'mp3', '-n', temporary], {
        signal, timeoutMs: timeouts.previewMs || 10 * 60 * 1000, onOutput: value => {
          pending = (pending + value).slice(-65536); const lines = pending.split(/\r?\n/); pending = lines.pop();
          for (const line of lines) { const match = /^out_time_us=(\d+)$/.exec(line); if (match) progress?.({ state: 'converting', progress: metadata.duration ? Math.min(99, Number(match[1]) / 10000 / metadata.duration) : 0 }); }
        }
      });
      check(signal);
      if (stamp((await sourceFile(filename)).info) !== before || await hash(filename, signal) !== sourceHash) throw new Error('音乐文件在预览准备期间发生变化，请重试');
      const previewMetadata = await probeSource(temporary, signal), bytes = (await fs.stat(temporary)).size;
      if (!bytes || !(previewMetadata.duration > 0) || (metadata.duration > 0 && previewMetadata.duration < metadata.duration - Math.max(.5, metadata.duration * .001))) throw new Error('音乐预览不完整');
      const outputHash = await hash(temporary, signal);
      await fs.writeFile(temporaryMetadata, JSON.stringify({ version: PREVIEW_VERSION, sourceHash, outputHash, bytes, audio: metadata.audio }), { flag: 'wx' });
      check(signal); await fs.rename(temporary, output); await fs.rename(temporaryMetadata, metadataFile);
      progress?.({ state: 'ready', progress: 100 });
      return { ...publicMetadata(metadata), path: output, mimeType: 'audio/mpeg', direct: false, transcoded: true, cached: false };
    } finally { await fs.unlink(temporary).catch(() => {}); await fs.unlink(temporaryMetadata).catch(() => {}); }
  }
  function subscribe(job, signal) {
    const token = {}; job.consumers.add(token);
    return new Promise((resolve, reject) => {
      let ended = false;
      const finish = (handler, value) => {
        if (ended) return; ended = true; signal?.removeEventListener('abort', abort); job.consumers.delete(token);
        if (!job.settled && !job.consumers.size) job.controller.abort(); handler(value);
      };
      const abort = () => finish(reject, cancelled());
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      job.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  function preview(source, { key, signal, forceTranscode = false, onProgress } = {}) {
    if (closed) return Promise.reject(new Error('音乐预览引擎已关闭'));
    check(signal); source = absolute(source);
    if (key != null && (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key))) throw new Error('音乐缓存标识无效');
    const identity = `${source}\0${key || ''}\0${Boolean(forceTranscode)}`;
    let job = previews.get(identity);
    if (!job || job.controller.signal.aborted || job.settled) {
      const controller = new AbortController(); controllers.add(controller);
      job = { controller, consumers: new Set(), settled: false };
      previews.set(identity, job);
      job.promise = track(Promise.resolve().then(() => createPreview(source, key?.toLowerCase(), controller.signal, forceTranscode, onProgress)).finally(() => {
        job.settled = true; controllers.delete(controller); if (previews.get(identity) === job) previews.delete(identity);
      }));
    }
    return subscribe(job, signal);
  }
  async function shutdown() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...tasks]); }
  return { probe, thumbnail, preview, shutdown, busy: () => tasks.size > 0 };
}
module.exports = { createAudioEngine, audioMetadata, nativeMime, INPUT_FORMATS, PREVIEW_VERSION };
