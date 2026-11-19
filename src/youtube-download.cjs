'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_LIMIT = 512 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;
const LINE_LIMIT = 64 * 1024;
const META_PREFIX = 'MOSAIC_META:';
const FILE_PREFIX = 'MOSAIC_FILE:';
const PROGRESS_PREFIX = 'MOSAIC_PROGRESS:';

function failure(message, code = 'YOUTUBE_DOWNLOAD_FAILED') { return Object.assign(new Error(message), { code }); }
function aborted() { return Object.assign(failure('YouTube 视频下载已取消', 'ABORT_ERR'), { name: 'AbortError' }); }
function checkSignal(signal) { if (signal?.aborted) throw aborted(); }

function youtubePageUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw failure('YouTube 视频地址无效', 'INVALID_YOUTUBE_URL');
  let url;
  try { url = new URL(value); } catch { throw failure('YouTube 视频地址无效', 'INVALID_YOUTUBE_URL'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw failure('YouTube 视频地址无效', 'INVALID_YOUTUBE_URL');
  let id;
  if (url.hostname === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
    if (url.pathname === '/watch' && !url.hostname.endsWith('youtube-nocookie.com')) {
      const ids = url.searchParams.getAll('v');
      if (ids.length === 1) id = ids[0];
    } else id = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  if (!VIDEO_ID.test(id || '')) throw failure('请选择单个 YouTube 视频', 'INVALID_YOUTUBE_URL');
  return `https://www.youtube.com/watch?v=${id}`;
}

function absolute(value, label) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) throw failure(`${label}无效`);
  return path.resolve(value);
}

function downloadError(stderr) {
  if (/sign in|login|log in|private video|members.only|age.restrict|confirm you.re not a bot/i.test(stderr)) {
    return failure('YouTube 要求登录或验证，当前视频无法直接下载。', 'YOUTUBE_AUTH_REQUIRED');
  }
  if (/drm|copyright|not available|unavailable|removed|geo.restrict|not made.*available/i.test(stderr)) {
    return failure('这个 YouTube 视频不可用或受访问限制，未保存视频。', 'YOUTUBE_UNAVAILABLE');
  }
  if (/larger than|max.filesize|file.*too large/i.test(stderr)) return failure('YouTube 视频超过采集大小上限', 'YOUTUBE_TOO_LARGE');
  if (/is_live|is_upcoming|live_status|does not pass filter|match filter/i.test(stderr)) return failure('暂不支持正在直播或尚未开始的 YouTube 视频', 'YOUTUBE_LIVE_UNSUPPORTED');
  // Keep network diagnostics useful without returning signed media URLs or local paths.
  const status = /HTTP Error (\d{3})/.exec(stderr)?.[1];
  return failure(status ? `YouTube 请求失败（HTTP ${status}），请稍后重试。` : 'YouTube 视频下载失败，请检查网络后重试。');
}

function stopProcessTree(child) {
  // Killing only yt-dlp can leave its ffmpeg or JavaScript child running on Windows.
  if (process.platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    let killer;
    try {
      killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore'
      });
      killer.once('error', () => child.kill());
      killer.once('close', code => { if (code !== 0) child.kill(); });
    } catch { child.kill(); }
  } else child.kill();
}

async function downloadYouTube({ url, directory, ffmpegPath, signal, maxBytes = DEFAULT_LIMIT,
  onProgress = () => {}, runtimeDir = path.join(__dirname, '..', 'video-runtime', 'youtube'),
  timeoutMs = 900000, spawnProcess = spawn } = {}) {
  const pageUrl = youtubePageUrl(url);
  directory = absolute(directory, 'YouTube 临时目录');
  runtimeDir = absolute(runtimeDir, 'YouTube 下载组件目录');
  ffmpegPath = absolute(ffmpegPath || path.join(runtimeDir, '..', 'ffmpeg.exe'), '视频合并组件');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw failure('YouTube 下载限制无效');
  checkSignal(signal);
  const executable = path.join(runtimeDir, 'yt-dlp.exe');
  const denoPath = path.join(runtimeDir, 'deno.exe');
  try {
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('not a directory');
    await Promise.all([executable, denoPath, ffmpegPath].map(file => fs.access(file)));
  } catch { throw failure('YouTube 下载组件缺失，请安装完整版本的 Mosaic。', 'YOUTUBE_RUNTIME_MISSING'); }
  if ((await fs.readdir(directory)).some(name => /^capture(?:\.|$)/i.test(name))) throw failure('YouTube 临时目录正在使用，请重试。');
  checkSignal(signal);
  const args = [
    '--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-update', '--no-remote-components',
    '--no-js-runtimes', '--js-runtimes', `deno:${denoPath}`, '--ffmpeg-location', ffmpegPath,
    '--use-extractors', 'youtube', '--no-playlist', '--no-live-from-start', '--no-wait-for-video',
    '--match-filters', '!is_live & !is_upcoming & !has_drm', '--abort-on-error', '--abort-on-unavailable-fragments',
    '--no-overwrites', '--no-continue', '--no-cache-dir', '--no-write-info-json', '--no-write-playlist-metafiles',
    '--no-write-comments', '--no-write-thumbnail', '--no-write-subs', '--no-write-auto-subs', '--no-exec',
    '--socket-timeout', '20', '--retries', '2', '--fragment-retries', '2', '--extractor-retries', '2',
    '--max-filesize', String(maxBytes), '--format', 'bv*+ba/b[vcodec!=none]', '--format-sort', 'res,vcodec:h264,acodec:aac',
    '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--no-simulate', '--newline', '--progress', '--progress-delta', '0.5',
    '--print', `before_dl:${META_PREFIX}{"id":%(id)j,"title":%(title)j,"is_live":%(is_live)j,"live_status":%(live_status)j,"has_drm":%(has_drm)j,"vcodec":%(vcodec)j}`,
    '--print', `after_move:${FILE_PREFIX}%(filepath)j`,
    '--progress-template', `download:${PROGRESS_PREFIX}{"filename":%(progress.filename)j,"downloaded":%(progress.downloaded_bytes)j,"total":%(progress.total_bytes)j,"estimate":%(progress.total_bytes_estimate)j}`,
    '--progress-template', `postprocess:${PROGRESS_PREFIX}{"merging":true}`,
    '--output', path.join(directory.replace(/%/g, '%%'), 'capture.%(ext)s'), '--', pageUrl
  ];
  const notify = event => { try { onProgress(event); } catch {} };
  notify({ phase: 'reading', receivedBytes: 0 });
  let title, output, diagnostic = '', metadataSeen = false;
  await new Promise((resolve, reject) => {
    let child, timer, stopTimer, failureReason, stderr = '', settled = false;
    const streams = new Map();
    const cleanup = () => { clearTimeout(timer); clearTimeout(stopTimer); signal?.removeEventListener('abort', abort); };
    const finish = error => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve();
    };
    const stop = error => {
      failureReason ||= error;
      if (!child || settled) return;
      stopProcessTree(child);
      // A second direct kill is a fallback if taskkill could not reach the child.
      stopTimer ||= setTimeout(() => child.kill(), 2000);
      stopTimer.unref?.();
    };
    const abort = () => stop(aborted());
    const readLine = line => {
      if (failureReason) return;
      if (line.startsWith(META_PREFIX)) {
        let data;
        try { data = JSON.parse(line.slice(META_PREFIX.length)); } catch { throw failure('YouTube 视频信息无效'); }
        if (metadataSeen || data?.id !== new URL(pageUrl).searchParams.get('v')) throw failure('YouTube 返回的视频与选择的视频不一致');
        if (data.is_live === true || ['is_live', 'is_upcoming', 'post_live'].includes(data.live_status)) throw failure('暂不支持正在直播或尚未开始的 YouTube 视频', 'YOUTUBE_LIVE_UNSUPPORTED');
        if (data.has_drm === true) throw failure('暂不支持受保护的 YouTube 视频', 'YOUTUBE_UNAVAILABLE');
        if (data.vcodec === 'none') throw failure('YouTube 返回的文件没有视频画面');
        metadataSeen = true;
        title = typeof data.title === 'string' ? data.title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500) : undefined;
      } else if (line.startsWith(FILE_PREFIX)) {
        let file;
        try { file = JSON.parse(line.slice(FILE_PREFIX.length)); } catch { throw failure('YouTube 下载结果无效'); }
        file = absolute(file, 'YouTube 下载文件');
        if (output || path.dirname(file) !== directory || !/^capture\.(?:mp4|webm|mkv)$/.test(path.basename(file))) throw failure('YouTube 下载文件不在指定临时目录');
        output = file;
      } else if (line.startsWith(PROGRESS_PREFIX)) {
        let data;
        try { data = JSON.parse(line.slice(PROGRESS_PREFIX.length)); } catch { return; }
        if (data?.merging === true) {
          notify({ phase: 'merging', receivedBytes: [...streams.values()].reduce((sum, item) => sum + item.received, 0) });
          return;
        }
        if (typeof data?.filename !== 'string' || !Number.isSafeInteger(data.downloaded) || data.downloaded < 0) return;
        const known = streams.get(data.filename) || { received: 0 };
        known.received = Math.max(known.received, data.downloaded);
        const total = Number.isSafeInteger(data.total) && data.total > 0 ? data.total : data.estimate;
        if (Number.isSafeInteger(total) && total > 0) known.total = Math.max(known.total || 0, total);
        streams.set(data.filename, known);
        const receivedBytes = [...streams.values()].reduce((sum, item) => sum + item.received, 0);
        if (receivedBytes > maxBytes) throw failure('YouTube 视频超过采集大小上限', 'YOUTUBE_TOO_LARGE');
        const totalBytes = [...streams.values()].every(item => item.total) ? [...streams.values()].reduce((sum, item) => sum + item.total, 0) : undefined;
        notify({ phase: 'downloading', receivedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
      }
    };
    function lines(stream, isStderr) {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const processText = text => {
        if (isStderr) diagnostic = stderr = (stderr + text).slice(-STDERR_LIMIT);
        pending += text;
        const values = pending.split(/\r?\n/); pending = values.pop();
        if (pending.length > LINE_LIMIT || values.some(line => line.length > LINE_LIMIT)) {
          stop(failure('YouTube 下载输出超出上限')); pending = ''; return;
        }
        for (const line of values) { try { readLine(line); } catch (error) { stop(error); } }
      };
      stream.on('data', chunk => processText(decoder.write(chunk)));
      stream.on('end', () => { processText(decoder.end()); if (pending) { try { readLine(pending); } catch (error) { stop(error); } } });
    }
    try {
      child = spawnProcess(executable, args, { cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      lines(child.stdout, false); lines(child.stderr, true);
      child.once('error', error => finish(failureReason || (error.code === 'ENOENT' ? failure('YouTube 下载组件缺失，请安装完整版本的 Mosaic。', 'YOUTUBE_RUNTIME_MISSING') : failure('无法启动 YouTube 下载组件'))));
      child.once('close', code => finish(failureReason || (signal?.aborted ? aborted() : code === 0 ? null : downloadError(stderr))));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop(failure('YouTube 视频下载超时，请稍后重试。', 'YOUTUBE_TIMEOUT')), timeoutMs);
      timer.unref?.();
      if (signal?.aborted) abort();
    } catch (error) { finish(error); }
  });
  checkSignal(signal);
  if (!metadataSeen || !output) {
    if (/larger than|max.filesize|does not pass filter|match filter/i.test(diagnostic)) throw downloadError(diagnostic);
    throw failure('YouTube 没有返回完整的视频文件，未保存视频。');
  }
  const stat = await fs.lstat(output);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 12) throw failure('YouTube 下载结果不是完整视频文件');
  if (stat.size > maxBytes) throw failure('YouTube 视频超过采集大小上限', 'YOUTUBE_TOO_LARGE');
  const handle = await fs.open(output, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const valid = bytesRead >= 12 && (header.subarray(4, 8).toString() === 'ftyp' || header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])));
    if (!valid) throw failure('YouTube 返回的内容不是视频文件，未保存。');
  } finally { await handle.close(); }
  notify({ phase: 'downloading', receivedBytes: stat.size, totalBytes: stat.size });
  return { filePath: output, title, pageUrl };
}

module.exports = { youtubePageUrl, downloadYouTube };
