'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { youtubePageUrl } = require('./youtube-download.cjs');

const MAX_BYTES = 512 * 1024 * 1024;
function invalid(message = 'YouTube 录制视频来源无效') { return new Error(message); }

function youtubeRecordingUrl(value) {
  if (value instanceof URL) value = value.href;
  if (typeof value !== 'string' || !/^blob:https:\/\/www\.youtube\.com\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
    throw invalid('YouTube 录制文件地址无效');
  }
  const url = new URL(value);
  if (url.origin !== 'https://www.youtube.com' || url.search || url.hash) throw invalid('YouTube 录制文件地址无效');
  return url;
}

function youtubeRecordingSource(body, { maxBytes = MAX_BYTES } = {}) {
  if (!body || body.sourceType !== 'youtube-recording' || body.kind !== 'video' || body.completed !== true ||
      body.playback !== undefined || body.dataBase64 !== undefined || body.browserRead !== undefined) throw invalid();
  const canonical = youtubePageUrl(body.url);
  if (body.url !== canonical || body.pageUrl !== canonical || body.videoId !== new URL(canonical).searchParams.get('v')) {
    throw invalid('YouTube 录制视频与来源页面不符');
  }
  const duration = body.expectedDuration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 86400 ||
      body.expectedAudio !== true || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Array.isArray(body.streams) || body.streams.length !== 1) throw invalid('YouTube 录制缺少完整时长或声音信息');
  const stream = body.streams[0];
  if (!stream || stream.mimeType !== 'video/webm' || stream.hasVideo !== true || stream.hasAudio !== true ||
      !Number.isSafeInteger(stream.contentLength) || stream.contentLength < 12 || stream.contentLength > Math.min(maxBytes, MAX_BYTES) ||
      typeof stream.duration !== 'number' || !Number.isFinite(stream.duration) || stream.duration <= 0 || stream.duration > 86400 ||
      Math.abs(stream.duration - duration) > Math.max(2, duration * 0.02)) throw invalid('YouTube 录制文件信息无效');
  const url = youtubeRecordingUrl(stream.url);
  return { url: canonical, videoId: body.videoId, duration, hasAudio: true, totalBytes: stream.contentLength,
    streams: [{ url: url.href, mimeType: 'video/webm', contentLength: stream.contentLength,
      duration: stream.duration, hasVideo: true, hasAudio: true }] };
}

async function remuxRecording(input, output, { signal, ffmpegPath, spawnProcess = spawn }) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawnProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror',
      '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'matroska,webm', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'webm', '-n', output],
    { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let finished = false, cancelled;
    const complete = error => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => { cancelled = signal.reason || invalid('YouTube 录制整理已取消'); child.kill(); };
    child.stderr?.resume();
    child.once('error', () => complete(cancelled || invalid('无法启动录制文件整理程序')));
    child.once('close', code => complete(cancelled || (code === 0 ? null : invalid('YouTube 录制文件无法完整整理，未保存'))));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function stageYouTubeRecording({ source, directory, read, signal, maxBytes = MAX_BYTES,
  ffmpegPath = path.resolve(__dirname, '..', 'video-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  spawnProcess, onMux = () => {} }) {
  if (!source || !path.isAbsolute(directory) || typeof read !== 'function') throw invalid();
  signal?.throwIfAborted();
  const stream = source.streams[0], stagedPath = path.join(directory, 'youtube-recording.webm');
  // Blob URLs have no desktop network representation. Only the selected browser
  // document can supply this exact, completed recording through the byte relay.
  await read(stream.url, { destination: stagedPath, limit: stream.contentLength, contentType: 'video/webm' });
  signal?.throwIfAborted();
  const stat = await fs.lstat(stagedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== stream.contentLength) throw invalid('YouTube 录制文件不完整，未保存');
  const handle = await fs.open(stagedPath, 'r');
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    if (!header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw invalid('YouTube 录制结果不是 WebM 视频，未保存');
  } finally { await handle.close(); }
  // MediaRecorder may omit WebM duration/cues. A copy remux writes a seekable
  // file whose actual timeline can be checked by the collector's probe.
  const filePath = path.join(directory, 'youtube-recording-complete.webm');
  onMux();
  await remuxRecording(stagedPath, filePath, { signal, ffmpegPath, spawnProcess });
  signal?.throwIfAborted();
  const output = await fs.lstat(filePath);
  if (!output.isFile() || output.isSymbolicLink() || output.size < 12 || output.size > maxBytes) throw invalid('YouTube 录制整理结果为空或超过大小上限');
  return { filePath, duration: source.duration, hasAudio: true };
}

module.exports = { youtubeRecordingUrl, youtubeRecordingSource, stageYouTubeRecording };
