'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { youtubePageUrl } = require('./youtube-download.cjs');

const MAX_BYTES = 512 * 1024 * 1024;
function invalid(message = 'YouTube 浏览器视频来源无效') { return new Error(message); }

function youtubeMediaUrl(value) {
  if (value instanceof URL) value = value.href;
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\x00-\x20\x7f\\]/.test(value)) throw invalid('YouTube 媒体地址无效');
  let url;
  try { url = new URL(value); } catch { throw invalid('YouTube 媒体地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !/^(?:[a-z0-9-]+\.)+googlevideo\.com$/i.test(url.hostname) || url.pathname !== '/videoplayback' ||
      ['sq', 'live', 'ump', 'sabr'].some(key => url.searchParams.has(key)) || url.searchParams.has('range')) throw invalid('YouTube 媒体地址无效');
  for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw invalid('YouTube 媒体参数重复');
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(url.searchParams.get('id') || '') ||
      !/^\d{1,5}$/.test(url.searchParams.get('itag') || '') ||
      (url.searchParams.has('clen') && !/^[1-9]\d{0,11}$/.test(url.searchParams.get('clen'))) ||
      (url.searchParams.has('lmt') && !/^\d{1,24}$/.test(url.searchParams.get('lmt')))) throw invalid('YouTube 媒体参数无效');
  return url;
}

function youtubeBrowserSource(body, { maxBytes = MAX_BYTES } = {}) {
  if (!body || body.sourceType !== 'youtube-browser' || body.kind !== 'video' ||
      body.playback !== undefined || body.dataBase64 !== undefined ||
      (body.browserRead !== undefined && body.browserRead !== true)) throw invalid();
  const canonical = youtubePageUrl(body.url);
  if (body.url !== canonical || body.pageUrl !== canonical || body.videoId !== new URL(canonical).searchParams.get('v')) throw invalid('YouTube 视频与来源页面不符');
  const duration = body.expectedDuration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 86400 || body.expectedAudio !== true) throw invalid('YouTube 视频缺少完整时长或声音信息');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Array.isArray(body.streams) || ![1, 2].includes(body.streams.length)) throw invalid();
  let totalBytes = 0;
  const streams = body.streams.map(stream => {
    if (!stream || typeof stream !== 'object' || Array.isArray(stream) ||
        typeof stream.hasVideo !== 'boolean' || typeof stream.hasAudio !== 'boolean' ||
        (!stream.hasVideo && !stream.hasAudio) || !/^(?:video|audio)\/(?:mp4|webm)$/.test(stream.mimeType || '') ||
        stream.mimeType.startsWith('video/') !== stream.hasVideo ||
        !Number.isSafeInteger(stream.contentLength) || stream.contentLength < 1 || stream.contentLength > Math.min(maxBytes, MAX_BYTES) ||
        typeof stream.duration !== 'number' || !Number.isFinite(stream.duration) || stream.duration <= 0 || stream.duration > 86400 ||
        Math.abs(stream.duration - duration) > Math.max(2, duration * 0.02) ||
        !Number.isSafeInteger(stream.itag) || stream.itag < 1 || stream.itag > 99999) throw invalid('YouTube 媒体流信息无效');
    const url = youtubeMediaUrl(stream.url);
    if (url.searchParams.get('itag') !== String(stream.itag) ||
        (url.searchParams.has('clen') && url.searchParams.get('clen') !== String(stream.contentLength))) throw invalid('YouTube 媒体流与播放信息不符');
    totalBytes += stream.contentLength;
    return { url: url.href, mimeType: stream.mimeType, contentLength: stream.contentLength,
      duration: stream.duration, itag: stream.itag, hasVideo: stream.hasVideo, hasAudio: stream.hasAudio };
  });
  const video = streams.filter(stream => stream.hasVideo), audio = streams.filter(stream => stream.hasAudio);
  if (totalBytes > Math.min(maxBytes, MAX_BYTES) || video.length !== 1 || audio.length !== 1 ||
      (streams.length === 2 && (video[0] === audio[0] || streams[0].mimeType.split('/')[1] !== streams[1].mimeType.split('/')[1])) ||
      new Set(streams.map(stream => stream.url)).size !== streams.length) throw invalid('YouTube 视频流不完整或存在歧义');
  return { url: canonical, videoId: body.videoId, streams, duration, hasAudio: true, totalBytes };
}

async function runMux(ffmpegPath, args, { signal, spawnProcess = spawn } = {}) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawnProcess(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let settled = false, cancelled;
    const complete = error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => { cancelled = signal.reason || invalid('YouTube 视频合并已取消'); child.kill(); };
    // Do not retain ffmpeg diagnostics: malformed files can contain signed URLs.
    child.stderr?.resume();
    child.once('error', () => complete(cancelled || invalid('无法启动 YouTube 视频合并程序')));
    child.once('close', code => complete(cancelled || (code === 0 ? null : invalid('YouTube 视频和声音合并失败，未保存'))));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function stageYouTubeBrowser({ source, directory, read, signal, maxBytes = MAX_BYTES,
  ffmpegPath = path.resolve(__dirname, '..', 'video-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  spawnProcess, onMux = () => {} }) {
  if (!source || !path.isAbsolute(directory) || typeof read !== 'function') throw invalid();
  const staged = [];
  for (const stream of source.streams) {
    signal?.throwIfAborted();
    const file = path.join(directory, `youtube-${stream.hasVideo ? 'video' : 'audio'}.${stream.mimeType.split('/')[1]}`);
    await read(stream.url, { destination: file, limit: stream.contentLength });
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== stream.contentLength) throw invalid('YouTube 媒体流不完整，未保存');
    staged.push({ ...stream, file });
  }
  if (staged.length === 1) return { filePath: staged[0].file, duration: source.duration, hasAudio: true };
  const video = staged.find(stream => stream.hasVideo), audio = staged.find(stream => stream.hasAudio);
  const extension = video.mimeType.endsWith('/webm') ? 'webm' : 'mp4';
  const filePath = path.join(directory, `youtube-merged.${extension}`);
  const input = file => ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-i', file];
  onMux();
  await runMux(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input(video.file), ...input(audio.file),
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...(extension === 'mp4' ? ['-movflags', '+faststart'] : []),
    '-f', extension, '-n', filePath], { signal, spawnProcess });
  signal?.throwIfAborted();
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) throw invalid('YouTube 合并视频为空或超过大小上限');
  return { filePath, duration: source.duration, hasAudio: true };
}

module.exports = { youtubeMediaUrl, youtubeBrowserSource, stageYouTubeBrowser };
