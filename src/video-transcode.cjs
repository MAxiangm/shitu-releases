'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { displayMetadata } = require('./video-engine.cjs');
const { createAlphaMovie } = require('./dxv-alpha.cjs');
const { readDXVAlpha } = require('./dxv-format.cjs');
const { createTranscodeDeviceManager, normalizeDevice, encodingProfile } = require('./transcode-devices.cjs');

const INPUT_FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,avi,matroska,webm,mpeg,mpegvideo,mpegts,asf,flv,mxf,ogg,rm,dv';
const MIN_BITRATE_MBPS = 0.5;
const MAX_BITRATE_MBPS = 200;
const DEFAULT_BITRATE_MBPS = 20;
const OUTPUT_FORMATS = Object.freeze({ mp4: '.mp4', dxv: '.mov' });
const abortError = () => Object.assign(new Error('视频转码已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
function checkSignal(signal) { if (signal?.aborted) throw abortError(); }
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label}必须是绝对路径`);
  return path.resolve(value);
}
function normalizeOptions(options = {}) {
  if (!options || typeof options !== 'object' || !Object.hasOwn(OUTPUT_FORMATS, options.format)) throw new Error('请选择 MP4 或 DXV Normal 格式');
  if (options.alpha !== undefined && typeof options.alpha !== 'boolean') throw new Error('透明通道选项无效');
  const device = normalizeDevice(options.device);
  if (options.format === 'dxv') {
    if (device.type === 'gpu') throw new Error('DXV Normal 编码目前仅支持 CPU，请使用 CPU 转码');
    return { format: 'dxv', extension: '.mov', bitrateMbps: null, alpha: options.alpha === true, device };
  }
  const bitrateMbps = options.bitrateMbps === undefined ? DEFAULT_BITRATE_MBPS : options.bitrateMbps;
  if (typeof bitrateMbps !== 'number' || !Number.isFinite(bitrateMbps) || bitrateMbps < MIN_BITRATE_MBPS || bitrateMbps > MAX_BITRATE_MBPS)
    throw new Error(`MP4 码率必须为 ${MIN_BITRATE_MBPS} 至 ${MAX_BITRATE_MBPS} Mbps`);
  return { format: 'mp4', extension: '.mp4', bitrateMbps, alpha: false, device };
}
function ratio(value) {
  const parts = String(value || '').split('/').map(Number);
  return parts.length === 2 && parts[1] > 0 && Number.isFinite(parts[0]) ? parts[0] / parts[1] : 0;
}

function createVideoTranscoder({ runtimeDir = path.join(__dirname, '..', 'video-runtime'), timeouts = {}, deviceManager } = {}) {
  runtimeDir = absolute(runtimeDir, '视频组件目录');
  const ownsDeviceManager = !deviceManager;
  deviceManager ||= createTranscodeDeviceManager({ runtimeDir });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const ffmpeg = path.join(runtimeDir, `ffmpeg${suffix}`), ffprobe = path.join(runtimeDir, `ffprobe${suffix}`);
  const controllers = new Set(), tasks = new Set();
  let closed = false;
  function operation(signal, work) {
    if (closed) return Promise.reject(new Error('视频转码服务已关闭'));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    controllers.add(controller);
    const promise = Promise.resolve().then(() => { checkSignal(controller.signal); return work(controller.signal); }).finally(() => {
      controllers.delete(controller); signal?.removeEventListener('abort', cancel); tasks.delete(promise);
    });
    tasks.add(promise);
    return promise;
  }
  async function sourceInfo(filename) {
    filename = absolute(filename, '视频文件');
    const stat = await fs.stat(filename);
    if (!stat.isFile() || !stat.size) throw new Error('视频文件不存在或为空');
    return { filename, stat };
  }
  function run(executable, args, { signal, timeoutMs, onOutput } = {}) {
    checkSignal(signal);
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', failure;
      const child = spawn(executable, args, { cwd: runtimeDir, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = cause => { failure ||= cause; child.kill(); };
      const onAbort = () => stop(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop(new Error('视频转码超时，请取消后重试或分段处理')), timeoutMs);
      timer.unref();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      child.stdout.on('data', chunk => {
        if (onOutput) { try { onOutput(chunk.toString('utf8')); } catch (error) { stop(error); } }
        else { stdout += chunk.toString('utf8'); if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) stop(new Error('视频信息超出读取上限')); }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-16384); });
      child.once('error', cause => { cleanup(); reject(cause.code === 'ENOENT' ? new Error('视频转码组件缺失，请重新安装完整版本') : cause); });
      child.once('close', code => {
        cleanup();
        if (failure) reject(failure);
        else if (signal?.aborted) reject(abortError());
        else if (code !== 0) reject(new Error(`视频转码失败${stderr.trim() ? `：${stderr.trim().slice(-1600)}` : ''}`));
        else resolve(stdout);
      });
    });
  }
  async function probeSource(source, signal) {
    const { filename } = await sourceInfo(source);
    const output = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
      '-show_streams', '-show_format', '-of', 'json', '-i', filename], { signal, timeoutMs: timeouts.probeMs || 30000 });
    let data;
    try { data = JSON.parse(output); } catch { throw new Error('视频信息无法读取'); }
    const metadata = displayMetadata(data);
    if (metadata.codec === 'dxv') {
      try {
        const packets = JSON.parse(await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
          '-select_streams', String(metadata.streamIndex), '-read_intervals', '%+#1', '-show_packets', '-show_entries', 'packet=pos', '-of', 'json', '-i', filename],
        { signal, timeoutMs: timeouts.probeMs || 30000 }));
        const value = packets.packets?.[0]?.pos;
        const alpha = await readDXVAlpha(filename, typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
        checkSignal(signal);
        if (alpha !== null) metadata.hasAlpha = alpha;
      } catch { checkSignal(signal); }
    }
    const video = data.streams.find(stream => stream.index === metadata.streamIndex);
    const rate = String(video?.avg_frame_rate || '0/0').split('/').map(Number);
    const fallback = String(video?.r_frame_rate || '30/1').split('/').map(Number);
    const [frameRateNumerator, frameRateDenominator] = rate.length === 2 && rate[0] > 0 && rate[1] > 0 ? rate : fallback;
    return { ...metadata, frameRate: ratio(video?.avg_frame_rate) || ratio(video?.r_frame_rate),
      frameRateNumerator, frameRateDenominator,
      videoBitRate: Number(video?.bit_rate) || 0, bitRate: Number(data.format?.bit_rate) || 0 };
  }
  function probe(source, { signal } = {}) { return operation(signal, internal => probeSource(source, internal)); }
  async function encodeAlphaMovie(source, destination, metadata, signal, notify, threads) {
    if (metadata.width * metadata.height > 67108864) throw new Error('透明视频分辨率过大，请先缩小到 8K 范围再转码');
    const numerator = Number.isInteger(metadata.frameRateNumerator) && metadata.frameRateNumerator > 0 ? metadata.frameRateNumerator : 30;
    const denominator = Number.isInteger(metadata.frameRateDenominator) && metadata.frameRateDenominator > 0 ? metadata.frameRateDenominator : 1;
    const rate = numerator / denominator;
    const movie = await createAlphaMovie(destination, { width: metadata.width, height: metadata.height, numerator, denominator });
    const color = metadata.colorSpace === 'ycgco' ? 'zscale=matrixin=ycgco:matrix=709,' : '';
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
      '-threads', String(threads), '-filter_threads', String(threads), '-i', source, '-map', `0:${metadata.streamIndex}`, '-an', '-sn', '-dn',
      '-vf', `${color}format=rgba,premultiply=inplace=1,pad=ceil(iw/16)*16:ceil(ih/16)*16:color=black@0,format=rgba`,
      '-r', `${numerator}/${denominator}`, '-fps_mode', 'cfr', '-c:v', 'hap', '-format', 'hap_alpha', '-compressor', 'none', '-chunks', '1', '-threads', String(threads), '-f', 'data', 'pipe:1'];
    const child = spawn(ffmpeg, args, { cwd: runtimeDir, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', failure, finished = false;
    const stop = cause => { failure ||= cause; child.kill(); };
    const abort = () => stop(abortError());
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error('视频转码超时，请取消后重试或分段处理')), timeouts.transcodeMs || 24 * 60 * 60 * 1000); timer.unref();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-16384); });
    const completion = new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('close', code => resolve({ code }));
    });
    const iterator = child.stdout[Symbol.asyncIterator]();
    let remainder = Buffer.alloc(0), frames = 0, lastProgress = -1;
    async function readBytes(length, eof = false) {
      const output = Buffer.allocUnsafe(length); let copied = 0;
      while (copied < length) {
        checkSignal(signal);
        if (!remainder.length) {
          const next = await iterator.next();
          if (next.done) { if (!copied && eof) return null; throw new Error('透明视频帧不完整'); }
          remainder = next.value;
        }
        const take = Math.min(length - copied, remainder.length);
        remainder.copy(output, copied, 0, take); copied += take; remainder = remainder.subarray(take);
      }
      return output;
    }
    try {
      while (true) {
        const header = await readBytes(4, true); if (!header) break;
        let length = header.readUIntLE(0, 3);
        if (!length) length = (await readBytes(4)).readUInt32LE(0);
        const expected = Math.ceil(metadata.width / 16) * 16 * Math.ceil(metadata.height / 16) * 16;
        if (header[3] !== 0xae || length !== expected) throw new Error('透明视频纹理格式无效');
        await movie.append(await readBytes(length)); frames++;
        const seconds = frames / rate;
        const progress = metadata.duration > 0 ? Math.min(95, Math.floor(seconds / metadata.duration * 95)) : 0;
        if (progress !== lastProgress) { lastProgress = progress; notify({ state: 'encoding', progress, seconds, duration: metadata.duration }); }
      }
      const result = await completion;
      if (failure) throw failure;
      if (result.error || result.code !== 0) throw result.error || new Error(`透明视频编码失败：${stderr.trim().slice(-1600)}`);
      checkSignal(signal); await movie.finish(); finished = true;
    } catch (error) { stop(error); child.stdout.destroy(); await completion; throw failure || error; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); if (!finished) await movie.abort(); }
  }
  function transcode(source, destination, options = {}) {
    return operation(options.signal, async signal => {
      const config = normalizeOptions(options);
      if (config.device.type === 'gpu') {
        const capabilities = await deviceManager.discover();
        checkSignal(signal);
        const device = capabilities.gpus.find(candidate => candidate.id === config.device.id);
        if (!device?.available || device.encoder !== config.device.encoder || device.index !== config.device.index)
          throw new Error(`所选 GPU 无法用于转码${device?.error ? `：${device.error}` : '，请在设置中重新检测设备'}`);
      }
      const profile = encodingProfile(config.device, config.bitrateMbps || DEFAULT_BITRATE_MBPS);
      const threads = String(config.device.threads);
      const { filename, stat } = await sourceInfo(source);
      destination = absolute(destination, '转码输出路径');
      if (filename.toLowerCase() === destination.toLowerCase()) throw new Error('转码不能覆盖原视频');
      if (path.extname(destination).toLowerCase() !== config.extension) throw new Error(`输出文件必须使用 ${config.extension} 扩展名`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try { await fs.lstat(destination); throw new Error('输出文件已存在，转码不会覆盖已有文件'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const metadata = await probeSource(filename, signal);
      const temporary = path.join(path.dirname(destination), `.shitu-transcode-${crypto.randomUUID()}${config.extension}`);
      const alphaVideo = config.alpha ? path.join(path.dirname(destination), `.shitu-alpha-${crypto.randomUUID()}.mov`) : null;
      const notify = event => { try { options.onProgress?.(event); } catch {} };
      let pending = '', lastPercent = -1;
      const onOutput = chunk => {
        pending = (pending + chunk).slice(-65536);
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) {
          const match = /^out_time_us=(\d+)/.exec(line);
          if (!match) continue;
          const seconds = Number(match[1]) / 1e6;
          const progress = metadata.duration > 0 ? Math.min(99, Math.max(0, Math.floor(seconds / metadata.duration * 100))) : 0;
          if (progress !== lastPercent) { lastPercent = progress; notify({ state: 'encoding', progress, seconds, duration: metadata.duration }); }
        }
      };
      const filters = [];
      if (metadata.colorSpace === 'ycgco') filters.push('zscale=matrixin=ycgco:matrix=709');
      // Neither requested output supports alpha. Premultiplication makes its
      // removal a black composite instead of exposing hidden RGB colours.
      if (metadata.hasAlpha) filters.push('format=rgba', 'premultiply=inplace=1');
      if (config.format === 'mp4') filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black', `format=${profile.pixelFormat}`, ...(profile.filterSuffix || []));
      else filters.push('format=rgba');
      const codecArgs = config.format === 'mp4'
        ? [...profile.codecArgs, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4']
        : ['-c:v', 'dxv', '-format', 'dxt1', '-c:a', 'pcm_s16le', '-f', 'mov'];
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(config.format === 'mp4' ? profile.initArgs : []),
        '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
        '-threads', threads, '-filter_threads', threads, '-i', filename, '-map', `0:${metadata.streamIndex}`, '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
        '-sn', '-dn', '-vf', filters.join(','), '-fps_mode', 'passthrough', '-threads', threads, ...codecArgs,
        '-progress', 'pipe:1', '-nostats', '-y', temporary];
      notify({ state: 'encoding', progress: 0, seconds: 0, duration: metadata.duration });
      try {
        if (config.alpha) {
          await encodeAlphaMovie(filename, alphaVideo, metadata, signal, notify, config.device.threads);
          await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
            '-i', alphaVideo, '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-i', filename,
            '-map', '0:v:0', '-map', '1:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'copy', '-c:a', 'pcm_s16le',
            '-f', 'mov', '-y', temporary], { signal, timeoutMs: timeouts.transcodeMs || 24 * 60 * 60 * 1000 });
        } else await run(ffmpeg, args, { signal, timeoutMs: timeouts.transcodeMs || 24 * 60 * 60 * 1000, onOutput });
        checkSignal(signal);
        const output = await probeSource(temporary, signal);
        const expectedCodec = config.format === 'mp4' ? 'h264' : 'dxv';
        if (output.codec !== expectedCodec) throw new Error('转码输出的编码与所选格式不一致');
        const bytes = (await fs.stat(temporary)).size;
        if (!bytes) throw new Error('转码输出文件为空');
        const sourceAfter = await fs.stat(filename);
        if (stat.size !== sourceAfter.size || stat.mtimeMs !== sourceAfter.mtimeMs) throw new Error('原视频在转码期间发生变化，请重新转码');
        checkSignal(signal);
        // link is an atomic create-only publish; unlike rename it never
        // overwrites a destination created by another process during encoding.
        await fs.link(temporary, destination);
        notify({ state: 'complete', progress: 100, seconds: output.duration, duration: output.duration });
        return { ...output, hasAlpha: config.alpha, path: destination, bytes, format: config.format,
          mimeType: config.format === 'mp4' ? 'video/mp4' : 'video/quicktime', bitrateMbps: config.bitrateMbps,
          alphaDropped: metadata.hasAlpha && !config.alpha, alpha: config.alpha, sourceWidth: metadata.width, sourceHeight: metadata.height,
          quality: config.format === 'dxv' ? 'normal' : undefined, device: config.device,
          encoder: config.format === 'dxv' ? (config.alpha ? 'dxv-dxt5' : 'dxv') : (config.device.encoder || 'libopenh264') };
      } finally { await fs.unlink(temporary).catch(() => {}); if (alphaVideo) await fs.unlink(alphaVideo).catch(() => {}); }
    });
  }
  async function shutdown() {
    closed = true; for (const controller of controllers) controller.abort();
    if (ownsDeviceManager) await deviceManager.shutdown();
    await Promise.allSettled([...tasks]);
  }
  return { probe, transcode, shutdown, busy: () => tasks.size > 0 };
}

module.exports = { createVideoTranscoder, normalizeOptions, MIN_BITRATE_MBPS, MAX_BITRATE_MBPS, DEFAULT_BITRATE_MBPS, OUTPUT_FORMATS };
