'use strict';

const fs = require('node:fs/promises');
const { constants: FS_CONSTANTS } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { videoPageSource } = require('./video-page-source.cjs');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_LIMIT = 512 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;
const LINE_LIMIT = 64 * 1024;
const META_PREFIX = 'MOSAIC_META:';
const FILE_PREFIX = 'MOSAIC_FILE:';
const PROGRESS_PREFIX = 'MOSAIC_PROGRESS:';
const SITE_LABELS = { youtube: 'YouTube', vimeo: 'Vimeo', pinterest: 'Pinterest', instagram: 'Instagram', x: 'X', bilibili: 'Bilibili' };
const SITE_EXTRACTORS = { youtube: 'youtube', vimeo: 'vimeo', pinterest: 'pinterest', instagram: 'instagram', x: 'twitter', bilibili: 'bilibili' };
const MAX_COOKIE_BYTES = 8 * 1024 * 1024;

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

async function checkedCookieFile(value, site) {
  if (value === undefined) return undefined;
  const invalid = () => failure('下载登录会话文件无效，请重新连接网站。', `${site.toUpperCase()}_AUTH_FILE_INVALID`);
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) throw invalid();
  const file = path.resolve(value);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_COOKIE_BYTES) throw invalid();
    // Walk ancestors rather than comparing realpath strings: Windows may
    // legitimately expand the current user's 8.3 name in a temporary path.
    for (let parent = path.dirname(file), previous; parent !== previous; previous = parent, parent = path.dirname(parent)) {
      const ancestor = await fs.lstat(parent);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw invalid();
    }
    await fs.access(file, FS_CONSTANTS.R_OK);
    return file;
  } catch { throw invalid(); }
}

function downloadError(stderr, site = 'youtube') {
  const label = SITE_LABELS[site], prefix = site.toUpperCase();
  if (/sign in|login|log in|private video|members.only|age.restrict|confirm you.re not a bot/i.test(stderr)) {
    return failure(`${label} 要求登录或验证，当前视频无法直接下载。`, `${prefix}_AUTH_REQUIRED`);
  }
  if (/drm|copyright|not available|unavailable|removed|geo.restrict|not made.*available/i.test(stderr)) {
    return failure(`这个 ${label} 视频不可用或受访问限制，未保存视频。`, `${prefix}_UNAVAILABLE`);
  }
  if (/larger than|max.filesize|file.*too large/i.test(stderr)) return failure(`${label} 视频超过采集大小上限`, `${prefix}_TOO_LARGE`);
  if (/is_live|is_upcoming|live_status|does not pass filter|match filter/i.test(stderr)) return failure(`暂不支持正在直播或尚未开始的 ${label} 视频`, `${prefix}_LIVE_UNSUPPORTED`);
  // Keep network diagnostics useful without returning signed media URLs or local paths.
  const status = /HTTP Error (\d{3})/.exec(stderr)?.[1];
  return failure(status ? `${label} 请求失败（HTTP ${status}），请稍后重试。` : `${label} 视频下载失败，请检查网络后重试。`, `${prefix}_DOWNLOAD_FAILED`);
}

function checkSelectedMetadata(data, source, selectedMediaId) {
  const fail = message => { throw failure(message, `${source.site.toUpperCase()}_SOURCE_MISMATCH`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('视频来源信息无效');
  if (typeof data.extractor_key === 'string' && data.extractor_key.toLowerCase() !== SITE_EXTRACTORS[source.site]) fail('返回的视频网站与选择的网站不一致');
  if (source.site === 'bilibili') {
    const [, requestedId, partText] = /^(BV[A-Za-z0-9]{10}|av[1-9]\d{0,19}):p([1-9]\d{0,3}|10000)$/.exec(source.videoId) || [];
    const [, returnedId, returnedPart] = /^(BV[A-Za-z0-9]{10})_p([1-9]\d{0,3}|10000)$/.exec(data.id || '') || [];
    const avAlias = requestedId?.startsWith('av') && Array.isArray(data._old_archive_ids) &&
      data._old_archive_ids.includes(`bilibili ${requestedId.slice(2)}_part${partText}`);
    if (!requestedId || !returnedId || returnedPart !== partText || requestedId !== returnedId && !avAlias) {
      fail('下载的 Bilibili 视频或分 P 与所选内容不一致');
    }
    let pageMatched = false;
    for (const field of ['webpage_url', 'original_url']) {
      if (typeof data[field] !== 'string' || !data[field]) continue;
      let actual; try { actual = videoPageSource(data[field]); } catch { fail('Bilibili 返回的来源地址无效'); }
      if (actual.site !== 'bilibili' || ![source.videoId, `${returnedId}:p${partText}`].includes(actual.videoId)) {
        fail('下载的 Bilibili 来源页与所选分 P 不一致');
      }
      pageMatched = true;
    }
    if (!pageMatched) fail('无法确认 Bilibili 视频的来源页面');
    if (data._type === 'playlist' || data._type === 'multi_video' ||
        [data.playlist_count, data.n_entries].some(count => Number.isSafeInteger(count) && count > 1) ||
        data.playlist_id != null && data.playlist_id !== '') fail('请选中单个 Bilibili 视频分 P 后再下载');
    if (selectedMediaId !== undefined && data.id !== selectedMediaId) fail('下载的 Bilibili 视频与选中画面不一致');
    return;
  }
  let pageMatched = false;
  for (const field of ['webpage_url', 'original_url']) {
    if (typeof data[field] !== 'string' || !data[field]) continue;
    let actual; try { actual = videoPageSource(data[field]); } catch { fail('返回的视频来源页面无效'); }
    if (actual.site !== source.site || actual.videoId !== source.videoId) fail('返回的视频与选择的帖子不一致');
    pageMatched = true;
  }
  const id = typeof data.id === 'string' ? data.id : '';
  const displayId = typeof data.display_id === 'string' ? data.display_id : '';
  if (source.site === 'youtube' && id !== source.videoId) fail('YouTube 返回的视频与选择的视频不一致');
  if (source.site === 'x' && displayId && displayId !== source.videoId) fail('返回的视频与选择的帖子不一致');
  if (source.site !== 'x' && id !== source.videoId && id !== selectedMediaId) fail('返回的视频编号与选择的帖子不一致');
  if (!pageMatched && id !== source.videoId && displayId !== source.videoId) fail('无法确认返回视频属于所选帖子');
  const counts = [data.playlist_count, data.n_entries].filter(Number.isSafeInteger);
  const multiple = data._type === 'playlist' || counts.some(count => count > 1) ||
    (data.playlist_id != null && data.playlist_id !== '' && !counts.some(count => count === 1));
  if (multiple && (!selectedMediaId || id !== selectedMediaId)) fail('这个帖子包含多个视频，无法确认所选画面，请使用该视频的直接播放源');
  if (selectedMediaId && id !== selectedMediaId) fail('返回的视频与所选画面不一致');
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

async function downloadSiteVideo({ url, site, selectedMediaId, cookieFile, directory, ffmpegPath, signal, maxBytes = DEFAULT_LIMIT,
  onProgress = () => {}, runtimeDir = path.join(__dirname, '..', 'video-runtime', 'youtube'),
  timeoutMs = 900000, spawnProcess = spawn } = {}) {
  const source = videoPageSource(url);
  if (site !== undefined && site !== source.site) throw failure('视频地址与网站类型不一致', 'INVALID_VIDEO_PAGE');
  site = source.site;
  const label = SITE_LABELS[site], prefix = site.toUpperCase();
  const issue = (message, suffix = 'DOWNLOAD_FAILED') => failure(message, `${prefix}_${suffix}`);
  if (selectedMediaId !== undefined && (typeof selectedMediaId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(selectedMediaId))) throw issue('所选视频编号无效');
  const pageUrl = source.url;
  directory = absolute(directory, `${label} 临时目录`);
  runtimeDir = absolute(runtimeDir, '视频下载组件目录');
  ffmpegPath = absolute(ffmpegPath || path.join(runtimeDir, '..', 'ffmpeg.exe'), '视频合并组件');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw issue('视频下载限制无效');
  checkSignal(signal);
  cookieFile = await checkedCookieFile(cookieFile, site);
  const executable = path.join(runtimeDir, 'yt-dlp.exe');
  const denoPath = path.join(runtimeDir, 'deno.exe');
  try {
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('not a directory');
    await Promise.all([executable, denoPath, ffmpegPath].map(file => fs.access(file)));
  } catch { throw issue('视频下载组件缺失，请安装完整版本的 Mosaic。', 'RUNTIME_MISSING'); }
  if ((await fs.readdir(directory)).some(name => /^capture(?:\.|$)/i.test(name))) throw issue('视频临时目录正在使用，请重试。');
  checkSignal(signal);
  const args = [
    '--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-update', '--no-remote-components',
    '--encoding', 'utf-8', '--output-na-placeholder', 'null',
    '--no-js-runtimes', '--js-runtimes', `deno:${denoPath}`, '--ffmpeg-location', ffmpegPath,
    '--use-extractors', SITE_EXTRACTORS[site], '--no-playlist', '--no-live-from-start', '--no-wait-for-video',
    '--match-filters', `!is_live & !is_upcoming & !has_drm${selectedMediaId ? ` & id = '${selectedMediaId}'` : ''}`, '--abort-on-error', '--abort-on-unavailable-fragments',
    '--no-overwrites', '--no-continue', '--no-cache-dir', '--no-write-info-json', '--no-write-playlist-metafiles',
    '--no-write-comments', '--no-write-thumbnail', '--no-write-subs', '--no-write-auto-subs', '--no-exec',
    '--socket-timeout', '20', '--retries', '2', '--fragment-retries', '2', '--extractor-retries', '2',
    '--max-filesize', String(maxBytes), '--format', 'bv*+ba/b[vcodec!=none]', '--format-sort', 'res,vcodec:h264,acodec:aac',
    '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--no-simulate', '--newline', '--progress', '--progress-delta', '0.5',
    '--print', `before_dl:${META_PREFIX}%(.{id,display_id,title,is_live,live_status,has_drm,vcodec,acodec,duration,webpage_url,original_url,extractor_key,_type,playlist_id,playlist_count,n_entries,_old_archive_ids})j`,
    '--print', `after_move:${FILE_PREFIX}%(filepath)j`,
    '--progress-template', `download:${PROGRESS_PREFIX}%(progress.{filename,downloaded_bytes,total_bytes,total_bytes_estimate})j`,
    '--progress-template', `postprocess:${PROGRESS_PREFIX}{"merging":true}`,
    '--output', path.join(directory.replace(/%/g, '%%'), 'capture.%(ext)s'), ...(cookieFile ? ['--cookies', cookieFile] : []), '--', pageUrl
  ];
  const notify = event => { try { onProgress(event); } catch {} };
  notify({ phase: 'reading', receivedBytes: 0 });
  let title, output, duration, hasAudio, diagnostic = '', metadataSeen = false;
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
        try { data = JSON.parse(line.slice(META_PREFIX.length)); } catch { throw issue(`${label} 视频信息无效`); }
        if (metadataSeen) throw issue('返回了多个视频，未保存任何视频');
        checkSelectedMetadata(data, source, selectedMediaId);
        if (data.is_live === true || ['is_live', 'is_upcoming', 'post_live'].includes(data.live_status)) throw issue(`暂不支持正在直播或尚未开始的 ${label} 视频`, 'LIVE_UNSUPPORTED');
        if (data.has_drm === true) throw issue(`暂不支持受保护的 ${label} 视频`, 'UNAVAILABLE');
        if (data.vcodec === 'none') throw issue('返回的文件没有视频画面');
        metadataSeen = true;
        title = typeof data.title === 'string' ? data.title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500) : undefined;
        if (typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration > 0) duration = data.duration;
        if (typeof data.acodec === 'string' && data.acodec.trim() && !/^(?:unknown|n\/a|null)$/i.test(data.acodec)) {
          hasAudio = data.acodec !== 'none';
        }
      } else if (line.startsWith(FILE_PREFIX)) {
        let file;
        try { file = JSON.parse(line.slice(FILE_PREFIX.length)); } catch { throw issue('视频下载结果无效'); }
        file = absolute(file, '视频下载文件');
        if (output || path.dirname(file) !== directory || !/^capture\.(?:mp4|webm|mkv)$/.test(path.basename(file))) throw issue('视频下载文件不在指定临时目录');
        output = file;
      } else if (line.startsWith(PROGRESS_PREFIX)) {
        let data;
        try { data = JSON.parse(line.slice(PROGRESS_PREFIX.length)); } catch { return; }
        if (data?.merging === true) {
          notify({ phase: 'merging', receivedBytes: [...streams.values()].reduce((sum, item) => sum + item.received, 0) });
          return;
        }
        if (typeof data?.filename !== 'string' || !Number.isSafeInteger(data.downloaded_bytes) || data.downloaded_bytes < 0) return;
        const known = streams.get(data.filename) || { received: 0 };
        known.received = Math.max(known.received, data.downloaded_bytes);
        const total = Number.isSafeInteger(data.total_bytes) && data.total_bytes > 0 ? data.total_bytes : data.total_bytes_estimate;
        if (Number.isSafeInteger(total) && total > 0) known.total = Math.max(known.total || 0, total);
        streams.set(data.filename, known);
        const receivedBytes = [...streams.values()].reduce((sum, item) => sum + item.received, 0);
        if (receivedBytes > maxBytes) throw issue('视频超过采集大小上限', 'TOO_LARGE');
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
          stop(issue('视频下载输出超出上限')); pending = ''; return;
        }
        for (const line of values) { try { readLine(line); } catch (error) { stop(error); } }
      };
      stream.on('data', chunk => processText(decoder.write(chunk)));
      stream.on('end', () => { processText(decoder.end()); if (pending) { try { readLine(pending); } catch (error) { stop(error); } } });
    }
    try {
      child = spawnProcess(executable, args, { cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      lines(child.stdout, false); lines(child.stderr, true);
      child.once('error', error => finish(failureReason || (error.code === 'ENOENT' ? issue('视频下载组件缺失，请安装完整版本的 Mosaic。', 'RUNTIME_MISSING') : issue('无法启动视频下载组件'))));
      child.once('close', code => finish(failureReason || (signal?.aborted ? aborted() : code === 0 ? null : downloadError(stderr, site))));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop(issue('视频下载超时，请稍后重试。', 'TIMEOUT')), timeoutMs);
      timer.unref?.();
      if (signal?.aborted) abort();
    } catch (error) { finish(error); }
  });
  checkSignal(signal);
  if (!metadataSeen || !output) {
    if (selectedMediaId && /does not pass filter|match filter/i.test(diagnostic)) throw issue('未找到与所选画面一致的视频', 'SOURCE_MISMATCH');
    if (/larger than|max.filesize|does not pass filter|match filter/i.test(diagnostic)) throw downloadError(diagnostic, site);
    throw issue('没有返回完整的视频文件，未保存视频。');
  }
  const stat = await fs.lstat(output);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 12) throw issue('下载结果不是完整视频文件');
  if (stat.size > maxBytes) throw issue('视频超过采集大小上限', 'TOO_LARGE');
  const handle = await fs.open(output, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const valid = bytesRead >= 12 && (header.subarray(4, 8).toString() === 'ftyp' || header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])));
    if (!valid) throw issue('返回的内容不是视频文件，未保存。');
  } finally { await handle.close(); }
  notify({ phase: 'downloading', receivedBytes: stat.size, totalBytes: stat.size });
  return { filePath: output, title, pageUrl, site, videoId: source.videoId, ...(duration === undefined ? {} : { duration }),
    ...(hasAudio === undefined ? {} : { hasAudio }) };
}

async function downloadYouTube(options = {}) {
  return downloadSiteVideo({ ...options, url: youtubePageUrl(options.url), site: 'youtube' });
}

module.exports = { youtubePageUrl, downloadYouTube, downloadSiteVideo };
