'use strict';

const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENCODERS = Object.freeze({ nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf' });
const MAX_CPU_THREADS = 64;
const abortError = () => Object.assign(new Error('转码设备检测已取消'), { name: 'AbortError', code: 'ABORT_ERR' });

function normalizeDevice(value) {
  if (value === undefined) return { type: 'cpu', id: 'cpu', threads: 2 };
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['cpu', 'gpu'].includes(value.type)) throw new Error('转码设备选项无效');
  const threads = value.threads === undefined ? 2 : value.threads;
  if (!Number.isInteger(threads) || threads < 1 || threads > MAX_CPU_THREADS) throw new Error(`CPU 线程数必须为 1 至 ${MAX_CPU_THREADS}`);
  if (value.type === 'cpu') {
    if (value.id !== undefined && value.id !== 'cpu') throw new Error('CPU 设备选项无效');
    return { type: 'cpu', id: 'cpu', threads };
  }
  const match = /^(nvenc|qsv|amf):(\d{1,2})$/.exec(value.id);
  if (!match || Number(match[2]) > 31) throw new Error('GPU 设备选项无效，请重新检测设备');
  const encoder = ENCODERS[match[1]], index = Number(match[2]);
  if ((value.encoder !== undefined && value.encoder !== encoder) || (value.index !== undefined && value.index !== index)) throw new Error('GPU 编码器与设备不匹配');
  return { type: 'gpu', id: `${match[1]}:${index}`, encoder, index, threads };
}

// These are encoder selections, not hardware-decoder selections. DXV decoding,
// alpha compositing and rotation stay on the CPU before hardware H.264 encoding.
function encodingProfile(value, bitrateMbps) {
  const device = normalizeDevice(value), bitrate = String(Math.round(bitrateMbps * 1e6));
  const buffer = String(Math.round(bitrateMbps * 2e6));
  const rate = ['-b:v', bitrate, '-maxrate', bitrate, '-bufsize', buffer];
  if (device.type === 'cpu') return { device, initArgs: [], pixelFormat: 'yuv420p', codecArgs: [
    '-c:v', 'libopenh264', '-profile:v', 'high', '-rc_mode', 'bitrate', ...rate, '-allow_skip_frames', '0'] };
  if (device.encoder === 'h264_nvenc') return { device, initArgs: [], pixelFormat: 'yuv420p', codecArgs: [
    '-c:v', 'h264_nvenc', '-gpu', String(device.index), '-preset', 'p4', '-profile:v', 'high', '-rc', 'vbr', ...rate] };
  if (device.encoder === 'h264_qsv') return { device,
    initArgs: ['-init_hw_device', `qsv=shitu:hw,child_device=${device.index},child_device_type=d3d11va`, '-filter_hw_device', 'shitu'],
    pixelFormat: 'nv12', codecArgs: ['-c:v', 'h264_qsv', '-preset', 'fast', '-profile:v', 'high', ...rate] };
  return { device, initArgs: ['-init_hw_device', `d3d11va=shitu:${device.index}`, '-filter_hw_device', 'shitu'],
    pixelFormat: 'nv12', filterSuffix: ['hwupload'], codecArgs: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'vbr_peak', ...rate] };
}

function parseNvencDevices(stderr) {
  return [...String(stderr).matchAll(/GPU\s+#(\d+)\s+-\s+<\s*([^>]+?)\s*>/g)]
    .map(match => ({ id: `nvenc:${Number(match[1])}`, name: match[2].trim(), encoder: 'h264_nvenc', index: Number(match[1]) }));
}
function parseD3dDevice(stderr) {
  const match = /Using device ([0-9a-f]{4}):([0-9a-f]{4}) \(([^\r\n]+)\)\./i.exec(String(stderr));
  return match ? { vendor: match[1].toLowerCase(), product: match[2].toLowerCase(), name: match[3].trim() } : null;
}
function safeProbeError(result) {
  if (result.error?.code === 'ENOENT') return '视频编码组件缺失，请重新安装完整版本';
  if (result.error?.name === 'AbortError') throw result.error;
  if (result.error) return result.error.message;
  const line = result.stderr.split(/\r?\n/).find(value => /failed|cannot|could not|no capable|not supported|not found|unsupported/i.test(value));
  const detail = (line || '未生成有效 H.264 视频数据').replace(/^\[[^\]]+\]\s*/, '').replace(/[A-Z]:[\\/][^\s"']+/gi, '[本地路径]').slice(0, 240);
  return `硬件编码验证失败：${detail}`;
}

function createTranscodeDeviceManager({ runtimeDir = path.join(__dirname, '..', 'video-runtime'), timeoutMs = 10000 } = {}) {
  if (!path.isAbsolute(runtimeDir)) throw new Error('视频组件目录必须是绝对路径');
  const ffmpeg = path.join(runtimeDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const controllers = new Set();
  let cached = null, pending = null, closed = false;
  function command(executable, args, signal, ms = timeoutMs) {
    return new Promise(resolve => {
      if (signal.aborted) return resolve({ stdout: Buffer.alloc(0), stderr: '', code: null, error: abortError() });
      let stdout = Buffer.alloc(0), stderr = '', error;
      const child = spawn(executable, args, { cwd: runtimeDir, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = cause => { error ||= cause; child.kill(); };
      const abort = () => stop(abortError());
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop(new Error('硬件编码检测超时')), ms); timer.unref();
      child.stdout.on('data', data => { if (stdout.length + data.length > 1024 * 1024) stop(new Error('设备检测输出超出上限')); else stdout = Buffer.concat([stdout, data]); });
      child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-32768); });
      child.once('error', cause => { error ||= cause; });
      child.once('close', code => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve({ stdout, stderr, code, error }); });
    });
  }
  async function ffmpegProbe(args, signal) {
    return command(ffmpeg, ['-hide_banner', '-loglevel', 'verbose', '-nostdin', ...args], signal);
  }
  async function verify(device, signal) {
    const profile = encodingProfile({ type: 'gpu', ...device }, 1);
    const result = await ffmpegProbe([...profile.initArgs, '-f', 'lavfi', '-i', 'color=c=black:s=192x128:r=10',
      '-frames:v', '2', '-an', '-vf', [`format=${profile.pixelFormat}`, ...(profile.filterSuffix || [])].join(','), ...profile.codecArgs, '-f', 'h264', 'pipe:1'], signal);
    // A compiled-in encoder alone is not evidence that a driver can encode.
    const bytes = result.stdout;
    const encoded = result.code === 0 && !result.error && bytes.length > 32 && bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]));
    return { ...device, available: encoded, ...(encoded ? {} : { error: safeProbeError(result) }) };
  }
  async function scan(signal) {
    const cpus = os.cpus();
    const cpu = { id: 'cpu', name: cpus[0]?.model?.trim() || 'CPU',
      logicalProcessors: Math.max(1, Math.min(128, os.availableParallelism?.() || cpus.length || 1)) };
    const gpus = [];
    const nvenc = await ffmpegProbe(['-f', 'lavfi', '-i', 'color=c=black:s=192x128:r=10', '-frames:v', '1', '-an',
      '-c:v', 'h264_nvenc', '-gpu', 'list', '-f', 'null', '-'], signal);
    if (signal.aborted) throw abortError();
    for (const device of parseNvencDevices(nvenc.stderr)) gpus.push(await verify(device, signal));

    if (process.platform === 'win32') {
      // Direct3D indices differ from NVENC indices and CIM enumeration order.
      // Ask FFmpeg for each exact adapter; exclude software/virtual displays.
      // DXGI indices are contiguous, so the first absent adapter ends the scan.
      for (let index = 0; index < 8; index++) {
        const probe = await ffmpegProbe(['-init_hw_device', `d3d11va=shitu:${index}`, '-f', 'lavfi', '-i', 'color=c=black:s=192x128:r=10',
          '-frames:v', '1', '-an', '-f', 'null', '-'], signal);
        if (signal.aborted) throw abortError();
        const adapter = parseD3dDevice(probe.stderr);
        if (!adapter) break;
        if (adapter.vendor === '10de' && !gpus.some(device => device.name === adapter.name))
          gpus.push({ id: `unavailable:${index}`, name: adapter.name, encoder: 'h264_nvenc', index: null, available: false, error: safeProbeError(nvenc) });
        if (!['8086', '1002'].includes(adapter.vendor)) continue;
        const family = adapter.vendor === '8086' ? 'qsv' : 'amf';
        const device = { id: `${family}:${index}`, name: adapter.name, encoder: ENCODERS[family], index };
        gpus.push(await verify(device, signal));
      }
    }
    if (signal.aborted) throw abortError();
    // Virtual display adapters can mirror a physical Intel adapter but fail
    // oneVPL initialisation. Do not present those as extra physical GPUs.
    const devices = gpus.filter((device, index) => device.available || !gpus.some((other, otherIndex) =>
      other.name === device.name && other.encoder === device.encoder && (other.available || otherIndex < index)));
    return { cpu, gpus: devices, formats: { mp4: { cpu: true, gpu: devices.some(device => device.available) }, dxv: { cpu: true, gpu: false } },
      note: 'DXV Normal 使用 CPU 编码；MP4 支持已通过验证的 GPU 编码。' };
  }
  function discover({ refresh = false } = {}) {
    if (closed) return Promise.reject(new Error('转码设备检测已关闭'));
    if (pending) return pending.then(value => structuredClone(value));
    if (cached && !refresh) return Promise.resolve(structuredClone(cached));
    const controller = new AbortController(); controllers.add(controller);
    pending = scan(controller.signal).then(value => { cached = value; return value; }).finally(() => { controllers.delete(controller); pending = null; });
    return pending.then(value => structuredClone(value));
  }
  async function shutdown() { closed = true; for (const controller of controllers) controller.abort(); if (pending) await pending.catch(() => {}); }
  return { discover, shutdown };
}

module.exports = { createTranscodeDeviceManager, normalizeDevice, encodingProfile, parseNvencDevices, parseD3dDevice, MAX_CPU_THREADS };
