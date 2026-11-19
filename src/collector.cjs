const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { createWriteStream, createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { stageVimeoHls, vimeoPlaybackUrl } = require('./vimeo-playback-source.cjs');
const { stageVimeoDash } = require('./vimeo-dash-source.cjs');
const { createBrowserMediaRelay, MESSAGE_LIMIT: BROWSER_MESSAGE_LIMIT } = require('./browser-media-relay.cjs');
const { youtubePageUrl } = require('./youtube-download.cjs');
const { videoPageSource } = require('./video-page-source.cjs');
const { videoExpectations, checkCapturedVideo } = require('./captured-video-check.cjs');
const { youtubeMediaUrl, youtubeBrowserSource, stageYouTubeBrowser } = require('./youtube-browser-source.cjs');
const { youtubeRecordingUrl, youtubeRecordingSource, stageYouTubeRecording } = require('./youtube-recording-source.cjs');
const { stageSketchfabModel, checkedSketchfabPage } = require('./sketchfab-download.cjs');

const DEFAULT_ORIGIN = 'chrome-extension://mdleapcbplpefdgchdklofdnpjgokdhh';
const INLINE_LIMIT = 20 * 1024 * 1024;
const INLINE_BASE64_LIMIT = Math.ceil(INLINE_LIMIT / 3) * 4;
const MAX_PROGRESS_RECORDS = 64;
const PROGRESS_TTL_MS = 5 * 60 * 1000;
const CAPTURE_REQUEST_ID = /^(?:[1-9]\d{0,15}-[1-9]\d{0,15}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const INLINE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  svg: 'image/svg+xml', avif: 'image/avif', tiff: 'image/tiff', mp4: 'video/mp4',
  mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg'
};
function publicAddress(address) {
  if (net.isIPv4(address)) {
    const [a,b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
  }
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) return publicAddress(value.slice(7));
  return net.isIPv6(address) && /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:');
}
function webUrl(value, label = '地址') {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new Error(`${label}无效`);
  let url; try { url = new URL(value); } catch { throw new Error(`${label}无效`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label}只支持 HTTP 或 HTTPS`);
  return url;
}
function identify(buffer) {
  if (buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { ext:'png',kind:'image' };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { ext:'jpg',kind:'image' };
  if (/^GIF8[79]a/.test(buffer.subarray(0,6).toString())) return { ext:'gif',kind:'image' };
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') return { ext:'webp',kind:'image' };
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'AVI ') return { ext:'avi',kind:'video' };
  if (buffer.subarray(0,2).toString() === 'BM') return { ext:'bmp',kind:'image' };
  if (buffer.subarray(0,4).equals(Buffer.from([73,73,42,0])) || buffer.subarray(0,4).equals(Buffer.from([77,77,0,42]))) return { ext:'tiff',kind:'image' };
  if (buffer.subarray(4,8).toString() === 'ftyp') {
    const brands = buffer.subarray(8,80).toString();
    if (/avif|avis/.test(brands)) return {ext:'avif',kind:'image'};
    return {ext:brands.startsWith('qt  ') ? 'mov' : 'mp4',kind:'video'};
  }
  if (buffer.length >= 12 && ['moov', 'mdat', 'wide', 'free'].includes(buffer.subarray(4,8).toString())) return {ext:'mov',kind:'video'};
  if (buffer.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return {ext:buffer.includes(Buffer.from('matroska'))?'mkv':'webm',kind:'video'};
  if (buffer.subarray(0,4).toString() === 'OggS') return {ext:'ogv',kind:'video'};
  if (buffer.subarray(0,3).toString() === 'FLV') return {ext:'flv',kind:'video'};
  if (buffer.subarray(0,4).equals(Buffer.from([0,0,1,186])) || buffer.subarray(0,4).equals(Buffer.from([0,0,1,179]))) return {ext:'mpg',kind:'video'};
  if (buffer.length > 376 && buffer[0] === 0x47 && buffer[188] === 0x47 && buffer[376] === 0x47) return {ext:'ts',kind:'video'};
  if (buffer.subarray(0,16).equals(Buffer.from('3026b2758e66cf11a6d900aa0062ce6c','hex'))) return {ext:'asf',kind:'video'};
  if (buffer.subarray(0,4).equals(Buffer.from([6,14,43,52]))) return {ext:'mxf',kind:'video'};
  const text = buffer.toString('utf8').replace(/^\uFEFF/,'').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text)) return {ext:'svg',kind:'image'};
  return null;
}
async function readJSON(request, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('请求太大，浏览器素材数据上限为 20 MB'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('采集请求格式无效'); }
}

function captureError(code, message) { return Object.assign(new Error(message), { code }); }
function validCaptureRequestId(value) { return typeof value === 'string' && CAPTURE_REQUEST_ID.test(value); }

function createCollector({ library, configPath, onImported = () => {}, onLocate,
  getLibraryRoot = () => library.root, listFolders = () => library.listFolders(), hasAsset = id => library.hasAsset(id),
  isReady=()=>true, allowedOrigin = DEFAULT_ORIGIN, port = 38475, allowPrivate = false, maxDownloadBytes = 512 * 1024 * 1024, timeout = 90000,
  appVersion = require('../package.json').version, muxVimeoPlayback, playbackTimeout = 240000,
  downloadYouTube, downloadSiteVideo, youtubeBrowserSession = false, bilibiliBrowserSession = false, youtubeTimeout = 1800000, probeVideo, youtubeFfmpegPath,
  resolveSketchfabModel, sketchfabTimeout = 18 * 60 * 1000 } = {}) {
  let server, token, listeningPort, active = 0, disabledError, lastCapture;
  const sockets = new Set();
  const captures = new Map();
  const browserRelay = createBrowserMediaRelay();
  const progress = (job, status, extra = {}) => {
    Object.assign(job, { status, at: Date.now() }, extra);
  };
  const rejectedCapture = error => { lastCapture = { status: 'error', at: Date.now(), error: error.message || String(error) }; };
  function pruneProgress() {
    const cutoff = Date.now() - PROGRESS_TTL_MS;
    for (const [id, record] of captures) {
      if (record.finishedAt && (record.finishedAt < cutoff || captures.size > MAX_PROGRESS_RECORDS)) captures.delete(id);
    }
  }
  function captureProgress(id) {
    pruneProgress();
    const job = captures.get(id)?.job;
    return job ? { phase: job.status, at: job.at, receivedBytes: job.receivedBytes,
      ...(job.totalBytes === undefined ? {} : { totalBytes: job.totalBytes }) } : null;
  }
  function libraryId(root) {
    return typeof root === 'string' && root ? crypto.createHmac('sha256', token).update(`capture-library\0${root}`).digest('hex') : null;
  }
  function readyStatus() {
    const ready = Boolean(isReady());
    const id = ready ? libraryId(getLibraryRoot()) : null;
    return { ready, captureProgress: true, vimeoBrowserRead: true, ...(muxVimeoPlayback ? { vimeoPlayback: true } : {}),
      ...(typeof probeVideo === 'function' ? { youtubeBrowserRead: true } : {}),
      ...(typeof downloadYouTube === 'function' ? { youtubeDownload: true } : {}),
      ...(typeof downloadYouTube === 'function' && youtubeBrowserSession ? { youtubeBrowserSession: true } : {}),
      ...(typeof downloadSiteVideo === 'function' && bilibiliBrowserSession ? { bilibiliBrowserSession: true } : {}),
      ...(typeof resolveSketchfabModel === 'function' && typeof library.importModelPackage === 'function' ? { sketchfabDownload: true } : {}),
      ...(typeof downloadSiteVideo === 'function' ? { siteVideoDownload: true } : {}), ...(id ? { libraryId: id } : {}) };
  }
  function currentDestination(destination, id) {
    if (destination === undefined) return null;
    if (!destination || !id || destination.libraryId !== id) {
      throw captureError('CAPTURE_LIBRARY_CHANGED', '素材库已切换，请在采集助手中重新选择目标文件夹');
    }
    const folderId = destination.folderId;
    if (folderId !== null && (typeof folderId !== 'string' || !listFolders().some(folder => folder.id === folderId))) {
      throw captureError('CAPTURE_FOLDER_MISSING', '目标文件夹已不存在，请在采集助手中重新选择');
    }
    return folderId;
  }
  async function openMedia(url, { pageUrl, signal, vimeo = false, range, validateUrl } = {}, redirects = 0) {
    if (redirects > 5) throw new Error('下载重定向次数过多');
    if (vimeo) url = vimeoPlaybackUrl(url.href);
    if (validateUrl) url = new URL(validateUrl(url.href));
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname) ? [{address:hostname,family:net.isIP(hostname)}] : await dns.lookup(hostname, {all:true});
    if (!addresses.length || ((vimeo || validateUrl || !allowPrivate) && addresses.some(a => !publicAddress(a.address)))) throw new Error('不支持从本机或内网地址采集');
    signal.throwIfAborted();
    const response = await new Promise((resolve,reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        signal,
        autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250,
        lookup: (_host, options, callback) => options?.all ? callback(null, addresses) : callback(null,addresses[0].address,addresses[0].family),
        headers: { 'User-Agent': 'Mozilla/5.0 ShituCollector/0.4', 'Accept': 'image/*,video/*;q=0.9,*/*;q=0.5',
          ...(pageUrl && !vimeo ? {Referer:pageUrl} : {}), ...(range ? {Range:`bytes=${range.start}-${range.end}`} : {}) }
      }, resolve);
      request.on('error',reject);
    });
    if ([301,302,303,307,308].includes(response.statusCode)) {
      response.resume();
      if (!response.headers.location) throw new Error('下载重定向地址缺失');
      return openMedia(webUrl(new URL(response.headers.location,url).href), { pageUrl, signal, vimeo, range, validateUrl }, redirects+1);
    }
    return { response, url };
  }
  async function download(url, destination, pageUrl, signal, job, vimeo = false) {
    const { response } = await openMedia(url, { pageUrl, signal, vimeo });
    if (response.statusCode !== 200) {
      response.resume();
      if (vimeo) throw vimeoReadError(response.statusCode);
      const error = new Error(`网站返回 HTTP ${response.statusCode}，可能需要登录或不允许直接下载`);
      if ([401, 403].includes(response.statusCode)) error.code = 'VIDEO_BROWSER_READ';
      throw error;
    }
    const type = String(response.headers['content-type'] || '');
    if (/mpegurl|dash\+xml|text\/html/i.test(type)) {
      response.resume();
      const error = new Error('该地址返回了网页或分段视频流，无法直接保存为视频文件');
      if (!vimeo && /text\/html/i.test(type)) error.code = 'VIDEO_BROWSER_READ';
      throw error;
    }
    const total = Number(response.headers['content-length']);
    if (total > maxDownloadBytes) { response.destroy(); throw new Error('素材超过 512 MB 下载上限'); }
    if (Number.isSafeInteger(total) && total >= 0) progress(job, 'downloading', { totalBytes: total });
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      const receivedBytes = job.receivedBytes + chunk.length;
      if (receivedBytes > maxDownloadBytes) return callback(new Error('素材超过 512 MB 下载上限'));
      progress(job, 'downloading', { receivedBytes });
      callback(null, chunk);
    } });
    await pipeline(response, limiter, createWriteStream(destination, {flags:'wx'}), {signal});
  }
  function vimeoReadError(status) {
    const error = new Error([401, 403].includes(status)
      ? `Vimeo 返回 HTTP ${status}，当前播放源无法读取，未保存视频。`
      : `Vimeo 媒体请求返回 HTTP ${status}，未保存视频。`);
    if ([401, 403].includes(status)) error.code = 'VIMEO_BROWSER_READ';
    return error;
  }
  async function readVimeo(source, { destination, limit = maxDownloadBytes, range } = {}, signal, job) {
    const budget = Math.min(limit, maxDownloadBytes - job.receivedBytes);
    const tooLarge = () => new Error('Vimeo 播放源超出采集大小上限');
    if (budget <= 0 || (range && range.end - range.start + 1 > budget)) throw tooLarge();
    const { response, url } = await openMedia(vimeoPlaybackUrl(source), { signal, vimeo: true, range });
    if (response.statusCode !== (range ? 206 : 200)) {
      response.destroy();
      throw vimeoReadError(response.statusCode);
    }
    const rangeHeader = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(String(response.headers['content-range'] || ''));
    if (range && (!rangeHeader || Number(rangeHeader[1]) !== range.start || Number(rangeHeader[2]) !== range.end)) {
      response.destroy(); throw new Error('Vimeo 返回的分段区间与播放清单不符');
    }
    if (/text\/html/i.test(String(response.headers['content-type'] || '')) || response.headers['content-encoding']) {
      response.destroy(); throw new Error('Vimeo 返回的数据不是可直接读取的媒体文件');
    }
    if (Number(response.headers['content-length']) > budget) { response.destroy(); throw tooLarge(); }
    let bytes = 0;
    function count(chunk) {
      bytes += chunk.length;
      const receivedBytes = job.receivedBytes + chunk.length;
      if (bytes > budget || receivedBytes > maxDownloadBytes) throw tooLarge();
      progress(job, 'downloading', { receivedBytes });
    }
    const chunks = [];
    if (destination) {
      const limiter = new Transform({ transform(chunk, _encoding, callback) {
        try { count(chunk); callback(null, chunk); } catch (error) { callback(error); }
      } });
      await pipeline(response, limiter, createWriteStream(destination, { flags: 'wx' }), { signal });
    } else {
      for await (const chunk of response) { count(chunk); chunks.push(chunk); }
    }
    if (!bytes || (range && bytes !== range.end - range.start + 1)) throw new Error('Vimeo 播放分段不完整，未保存视频');
    return destination ? undefined : { body: Buffer.concat(chunks, bytes), url };
  }
  async function captureSketchfab(body, job, cancellationSignal) {
    const permitted = new Set(['kind', 'sourceType', 'modelId', 'url', 'pageUrl', 'name', 'title', 'requestId', 'destination']);
    if (body.kind !== 'model' || body.sourceType !== 'sketchfab' || Object.keys(body).some(key => !permitted.has(key))) {
      throw captureError('SKETCHFAB_SOURCE_INVALID', 'Sketchfab 模型采集请求无效。');
    }
    if (typeof resolveSketchfabModel !== 'function' || typeof library.importModelPackage !== 'function') {
      throw captureError('SKETCHFAB_UNAVAILABLE', '请更新桌面 Mosaic 后采集 Sketchfab 模型。');
    }
    const pageUrl = checkedSketchfabPage(body.modelId, body.url);
    if (body.url !== pageUrl || body.pageUrl !== pageUrl) {
      throw captureError('SKETCHFAB_SOURCE_INVALID', 'Sketchfab 模型与所选页面不一致。');
    }
    const currentId = libraryId(getLibraryRoot());
    const folderId = currentDestination(body.destination, currentId);
    const deadline = AbortSignal.timeout(sketchfabTimeout);
    const signal = cancellationSignal ? AbortSignal.any([deadline, cancellationSignal]) : deadline;
    let temporary;
    try {
      progress(job, 'reading');
      const resolved = await resolveSketchfabModel({ modelId: body.modelId, signal });
      signal.throwIfAborted();
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-sketchfab-'));
      const staged = await stageSketchfabModel({
        modelId: body.modelId, pageUrl, archiveUrl: resolved?.archiveUrl, attribution: resolved?.attribution,
        directory: temporary, signal, limits: { compressedBytes: maxDownloadBytes },
        onProgress: event => {
          const phase = ['downloading', 'extracting', 'verifying'].includes(event?.phase) ? event.phase : 'downloading';
          const extra = {};
          if (Number.isSafeInteger(event?.receivedBytes) && event.receivedBytes >= 0) extra.receivedBytes = event.receivedBytes;
          if (Number.isSafeInteger(event?.totalBytes) && event.totalBytes > 0) extra.totalBytes = event.totalBytes;
          progress(job, phase, extra);
        },
        downloadArchive: async ({ url, destination, signal: downloadSignal, maxBytes, onProgress, validateUrl }) => {
          const { response } = await openMedia(new URL(url), { pageUrl, signal: downloadSignal, validateUrl });
          if (response.statusCode !== 200) {
            response.resume();
            throw captureError('SKETCHFAB_DOWNLOAD_FAILED', `Sketchfab 下载返回 HTTP ${response.statusCode}，请重新采集。`);
          }
          const type = String(response.headers['content-type'] || '');
          if (/text\/html|application\/json/i.test(type)) {
            response.resume();
            throw captureError('SKETCHFAB_DOWNLOAD_FAILED', 'Sketchfab 未返回模型压缩包，请检查连接后重试。');
          }
          const declared = Number(response.headers['content-length']);
          if (declared > maxBytes) {
            response.destroy();
            throw captureError('SKETCHFAB_DOWNLOAD_FAILED', '模型压缩包超过 512 MB 下载上限。');
          }
          const totalBytes = Number.isSafeInteger(declared) && declared > 0 ? declared : undefined;
          let receivedBytes = 0;
          const limiter = new Transform({ transform(chunk, _encoding, callback) {
            receivedBytes += chunk.length;
            if (receivedBytes > maxBytes) return callback(captureError('SKETCHFAB_DOWNLOAD_FAILED', '模型压缩包超过下载上限。'));
            onProgress({ phase: 'downloading', receivedBytes, ...(totalBytes ? { totalBytes } : {}) });
            callback(null, chunk);
          } });
          await pipeline(response, limiter, createWriteStream(destination, { flags: 'wx' }), { signal: downloadSignal });
          if (!receivedBytes || totalBytes !== undefined && receivedBytes !== totalBytes) {
            throw captureError('SKETCHFAB_DOWNLOAD_FAILED', '模型压缩包下载不完整，请重试。');
          }
          return { bytes: receivedBytes };
        }
      });
      if (resolved && typeof resolved === 'object') delete resolved.archiveUrl;
      if (body.destination !== undefined) currentDestination(body.destination, libraryId(getLibraryRoot()));
      signal.throwIfAborted();
      const title = staged.attribution?.title || resolved?.attribution?.title || body.name || body.title || 'Sketchfab 模型';
      const name = String(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 200) || 'Sketchfab 模型';
      progress(job, 'importing', { name, receivedBytes: 0 });
      const report = await library.importModelPackage({ root: staged.root, entryPath: staged.entryPath, files: staged.files,
        folderId, metadata: { name, sourceUrl: pageUrl, pageUrl } });
      if (report?.errors?.length) throw new Error(report.errors[0].message || '模型写入素材库失败。');
      if (!Number.isSafeInteger(report?.imported) || report.imported < 0 || !Number.isSafeInteger(report?.duplicates) || report.duplicates < 0 ||
          !report.imported && !report.duplicates) throw new Error('素材库未保存这份模型，请重试。');
      let snapshot;
      try { snapshot = typeof library.snapshot === 'function' ? await library.snapshot() : null; } catch {}
      const existingAssets = Array.isArray(report.existingAssets) ? report.existingAssets.map(asset => ({
        id: asset.id, name: asset.name, trashedAt: asset.trashedAt || null, folderId: asset.folderId || null
      })) : [];
      const folderName = folderId ? snapshot?.folders?.find(folder => folder.id === folderId)?.name : undefined;
      const result = { ok: true, imported: report.imported, duplicates: report.duplicates, assetIds: report.assetIds || [], existingAssets,
        libraryRoot: typeof snapshot?.root === 'string' ? snapshot.root : getLibraryRoot() || null,
        ...(currentId ? { libraryId: currentId, ...(report.imported ? { folderId, ...(folderName ? { folderName } : {}) } : {}) } : {}) };
      progress(job, 'complete', result);
      try { await onImported(result); } catch {}
      return result;
    } finally {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }
  async function capture(body, job, cancellationSignal) {
    lastCapture = job;
    let temporary, browserSession, operationSignal;
    try {
      if (body?.kind === 'model' || body?.sourceType === 'sketchfab') return await captureSketchfab(body, job, cancellationSignal);
      if (!body || !['image','video'].includes(body.kind)) throw new Error('只支持图片和视频素材');
      const expectedVideo = videoExpectations(body);
      if (body.kind !== 'video' && Object.keys(expectedVideo).length) throw new Error('图片不能包含视频校验信息');
      const currentId = libraryId(getLibraryRoot());
      const folderId = currentDestination(body.destination, currentId);
      const inline = Object.prototype.hasOwnProperty.call(body, 'dataBase64');
      let source;
      if (typeof body.url !== 'string' || body.url.length > 8192 || /[\x00-\x20\x7f]/.test(body.url)) throw new Error('素材地址无效');
      if (/^https?:/i.test(body.url)) source = webUrl(body.url, '素材地址');
      else {
        let parsed;
        try { parsed = new URL(body.url); } catch { throw new Error('素材地址无效'); }
        if (!inline || !['data:', 'blob:'].includes(parsed.protocol) ||
            (parsed.protocol === 'data:' && !body.url.toLowerCase().startsWith(`data:${body.kind}/`))) throw new Error('素材地址只支持 HTTP、HTTPS 或浏览器提供的临时素材');
      }
      let pageUrl = body.pageUrl ? webUrl(body.pageUrl,'来源页面').href : undefined;
      const playback = body.playback;
      const youtube = body.sourceType === 'youtube';
      const siteVideo = body.sourceType === 'site-video';
      const youtubeBrowser = body.sourceType === 'youtube-browser';
      const youtubeRecording = body.sourceType === 'youtube-recording';
      const pageDownload = youtube || siteVideo;
      if (Object.hasOwn(body, 'youtubeSession') && (!youtube || !youtubeBrowserSession)) {
        throw captureError('VIDEO_BROWSER_SESSION_INVALID', '当前请求不支持 Chrome 的 YouTube 登录，请更新 Mosaic 后在 YouTube 页面重试。');
      }
      if (Object.hasOwn(body, 'bilibiliSession') && (!siteVideo || body.site !== 'bilibili' || !bilibiliBrowserSession)) {
        throw captureError('VIDEO_BROWSER_SESSION_INVALID', '当前请求不支持 Chrome 的 B 站登录，请更新 Mosaic 后在 B 站视频页面重试。');
      }
      if (body.sourceType !== undefined && !pageDownload && !youtubeBrowser && !youtubeRecording) throw new Error('不支持这种视频来源');
      let browserSource;
      if (youtubeBrowser || youtubeRecording) {
        if (!validCaptureRequestId(body.requestId)) throw new Error('YouTube 浏览器读取请求无效');
        if (typeof probeVideo !== 'function') throw new Error('请更新桌面 Mosaic 后采集 YouTube 浏览器视频');
        browserSource = (youtubeRecording ? youtubeRecordingSource : youtubeBrowserSource)(body, { maxBytes: maxDownloadBytes });
        source = new URL(browserSource.url);
        pageUrl = browserSource.url;
      }
      if (youtube) {
        if (body.kind !== 'video' || inline || playback !== undefined || body.browserRead !== undefined) throw new Error('YouTube 视频采集请求无效');
        const canonical = youtubePageUrl(body.url);
        if (body.videoId !== new URL(canonical).searchParams.get('v') || (pageUrl && youtubePageUrl(pageUrl) !== canonical)) throw new Error('YouTube 视频与来源页面不符');
        if (typeof downloadYouTube !== 'function') throw new Error('请更新桌面 Mosaic 后采集 YouTube 视频');
        source = new URL(canonical);
        pageUrl = canonical;
      }
      if (siteVideo) {
        if (body.kind !== 'video' || inline || playback !== undefined || body.browserRead !== undefined) throw new Error('网页视频下载请求无效');
        const selected = videoPageSource(body.url);
        if (selected.site !== body.site || selected.videoId !== body.videoId ||
            (pageUrl && videoPageSource(pageUrl).url !== selected.url)) throw new Error('视频与所选来源页面不符');
        if (typeof downloadSiteVideo !== 'function') throw new Error('请更新桌面 Mosaic 后使用网页视频下载');
        source = new URL(selected.url);
        pageUrl = selected.url;
      }
      const stagePlayback = playback === 'hls' ? stageVimeoHls : playback === 'dash' ? stageVimeoDash : null;
      if (body.browserRead !== undefined && (body.browserRead !== true || (!playback && !youtubeBrowser) || !validCaptureRequestId(body.requestId))) {
        throw new Error('浏览器视频读取请求无效');
      }
      if (playback !== undefined) {
        if ((playback !== 'file' && !stagePlayback) || body.kind !== 'video' || !source || inline ||
            !/^https:\/\/vimeo\.com\/\d{1,20}\/?$/.test(pageUrl || '')) throw new Error('Vimeo 播放源采集请求无效');
        if (stagePlayback && !muxVimeoPlayback) throw new Error('请更新桌面 Mosaic 后采集 Vimeo 播放视频');
        source = vimeoPlaybackUrl(source.href);
        const redirectId = /^\/progressive_redirect\/playback\/(\d+)\//.exec(source.pathname)?.[1];
        if (source.hostname === 'player.vimeo.com' && redirectId !== new URL(pageUrl).pathname.split('/')[1]) throw new Error('Vimeo 播放源与当前视频不符');
      }
      if (source && !stagePlayback && /\.(m3u8|mpd)(?:$|[?#])/i.test(source.href)) throw new Error('暂不支持直播、分段流或受保护视频，请使用可直接下载的视频文件');
      let inlineBytes;
      if (inline) {
        const allowedMime = body.kind === 'image' ? /^image\/(?:png|jpeg|webp|gif|bmp|svg\+xml|avif|tiff)$/i : /^video\/(?:mp4|webm|ogg|quicktime)$/i;
        if (typeof body.mimeType !== 'string' || !allowedMime.test(body.mimeType)) throw new Error('临时素材 MIME 类型无效');
        if (typeof body.dataBase64 !== 'string' || !body.dataBase64.length || body.dataBase64.length > INLINE_BASE64_LIMIT ||
            body.dataBase64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.dataBase64)) throw new Error('临时素材数据无效或超过 20 MB');
        inlineBytes = Buffer.from(body.dataBase64,'base64');
        if (inlineBytes.length > INLINE_LIMIT || inlineBytes.toString('base64') !== body.dataBase64) throw new Error('临时素材数据无效或超过 20 MB');
      }
      temporary = await fs.mkdtemp(path.join(os.tmpdir(),'shitu-capture-'));
      let original = path.join(temporary,'download');
      let sourceTitle;
      if (inline) {
        await fs.writeFile(original,inlineBytes,{flag:'wx'});
        progress(job, 'receiving', { receivedBytes: inlineBytes.length, totalBytes: inlineBytes.length });
      }
      else {
        progress(job, 'downloading');
        const deadline = AbortSignal.timeout(pageDownload || youtubeBrowser || youtubeRecording ? youtubeTimeout : playback ? playbackTimeout : timeout);
        const signal = cancellationSignal ? AbortSignal.any([deadline, cancellationSignal]) : deadline;
        operationSignal = signal;
        if (body.browserRead || youtubeBrowser || youtubeRecording) browserSession = browserRelay.createSession(body.requestId, { signal,
          ...(youtubeBrowser || youtubeRecording ? { validateUrl: youtubeRecording ? youtubeRecordingUrl : youtubeMediaUrl,
            sourceType: body.sourceType, label: 'YouTube' } : {}) });
        const read = async (url, options = {}) => {
          if (!browserSession) return readVimeo(url, options, signal, job);
          let target = youtubeRecording ? youtubeRecordingUrl(url) : youtubeBrowser ? youtubeMediaUrl(url) : vimeoPlaybackUrl(url);
          // Only the existing, address-checked downloader follows Vimeo's
          // progressive redirect. Browser fetches receive terminal CDN URLs.
          if (target.hostname === 'player.vimeo.com') {
            const resolved = await openMedia(target, { signal, vimeo: true, range: options.range });
            resolved.response.destroy();
            target = resolved.url;
            if (target.hostname === 'player.vimeo.com') throw new Error('Vimeo 未提供可由浏览器读取的媒体地址');
          }
          const limit = Math.min(options.limit ?? maxDownloadBytes, maxDownloadBytes - job.receivedBytes);
          return browserSession.read(target, { ...options, limit,
            onBytes: bytes => progress(job, 'downloading', { receivedBytes: job.receivedBytes + bytes }),
            onHead: head => { if (playback === 'file' && Number.isSafeInteger(head.contentLength)) progress(job, 'downloading', { totalBytes: head.contentLength }); } });
        };
        if (youtubeRecording) {
          progress(job, 'downloading', { totalBytes: browserSource.totalBytes });
          const media = await stageYouTubeRecording({ source: browserSource, directory: temporary, signal, read,
            maxBytes: maxDownloadBytes, ffmpegPath: youtubeFfmpegPath, onMux: () => progress(job, 'muxing') });
          original = media.filePath;
        } else if (youtubeBrowser) {
          progress(job, 'downloading', { totalBytes: browserSource.totalBytes });
          const media = await stageYouTubeBrowser({ source: browserSource, directory: temporary, signal,
            read, maxBytes: maxDownloadBytes, ffmpegPath: youtubeFfmpegPath,
            onMux: () => progress(job, 'muxing') });
          original = media.filePath;
        } else if (pageDownload) {
          progress(job, 'reading');
          const downloader = youtube ? downloadYouTube : downloadSiteVideo;
          const media = await downloader({ url: source.href, ...(siteVideo ? { site: body.site } : {}),
            ...(youtube && Object.hasOwn(body, 'youtubeSession') ? { browserSession: body.youtubeSession } : {}), directory: temporary, signal,
            ...(siteVideo && body.site === 'bilibili' && Object.hasOwn(body, 'bilibiliSession') ? { browserSession: body.bilibiliSession } : {}),
            maxBytes: maxDownloadBytes, timeoutMs: youtubeTimeout, onProgress: event => {
              const phase = event?.phase === 'merging' ? 'muxing' : event?.phase === 'connecting' ? 'connecting' : event?.phase === 'reading' ? 'reading' : 'downloading';
              const extra = {};
              if (Number.isSafeInteger(event?.receivedBytes) && event.receivedBytes >= 0) extra.receivedBytes = event.receivedBytes;
              if (Number.isSafeInteger(event?.totalBytes) && event.totalBytes > 0) extra.totalBytes = event.totalBytes;
              progress(job, phase, extra);
            } });
          delete body.youtubeSession;
          delete body.bilibiliSession;
          const relative = typeof media?.filePath === 'string' ? path.relative(temporary, media.filePath) : '';
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('视频下载结果路径无效');
          const stat = await fs.lstat(media.filePath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxDownloadBytes) throw new Error('视频下载结果为空或超过大小上限');
          original = media.filePath;
          sourceTitle = typeof media.title === 'string' ? media.title : '';
          if (Number.isFinite(media.duration) && media.duration > 0 && media.duration <= 86400) expectedVideo.expectedDuration = media.duration;
          if (media.hasAudio === true) expectedVideo.expectedAudio = true;
        } else if (stagePlayback) {
          const media = await stagePlayback({ url: source, directory: temporary, signal,
            read });
          progress(job, 'muxing');
          await muxVimeoPlayback(media, original, { signal });
        } else if (browserSession) await read(source, { destination: original });
        else await download(source,original,pageUrl,signal,job,Boolean(playback));
      }
      const handle = await fs.open(original,'r');
      const head = Buffer.alloc(4096); let bytesRead;
      try { ({bytesRead} = await handle.read(head,0,4096,0)); } finally { await handle.close(); }
      const format = identify(head.subarray(0,bytesRead));
      if (!format || format.kind !== body.kind) throw new Error('下载结果不是支持的图片或视频文件；网站可能返回了登录页面或分段流');
      if (inline && INLINE_MIME[format.ext] !== body.mimeType.toLowerCase()) throw new Error('临时素材 MIME 类型与文件内容不符');
      if (body.kind === 'video' && typeof probeVideo === 'function') {
        progress(job, 'verifying');
        checkCapturedVideo(await probeVideo(original, { signal: operationSignal }), expectedVideo);
      }
      let name = pageDownload && sourceTitle ? sourceTitle : typeof body.name === 'string' ? body.name : '';
      if (!name && source) { try { name = decodeURIComponent(path.posix.basename(source.pathname)); } catch {} }
      if (!name) name = typeof body.title === 'string' ? body.title : '网页素材';
      name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/\.[a-z0-9]{2,5}$/i,'').trim().slice(0,200) || '网页素材';
      const typed = path.join(temporary,`media.${format.ext}`);
      await fs.rename(original,typed);
      if (body.destination !== undefined) currentDestination(body.destination, libraryId(getLibraryRoot()));
      operationSignal?.throwIfAborted();
      progress(job, 'importing', { name });
      const sourceUrl = playback || pageDownload || youtubeBrowser || youtubeRecording ? pageUrl : source?.href;
      const report = await library.importPaths([typed], { folderId, metadata:{name,...(sourceUrl ? {sourceUrl} : {}),...(pageUrl ? {pageUrl} : {})} });
      if (report?.errors?.length) throw new Error(report.errors[0].message || '素材写入素材库失败');
      if (!Number.isSafeInteger(report?.imported) || report.imported < 0 || !Number.isSafeInteger(report?.duplicates) || report.duplicates < 0 || !report.imported && !report.duplicates)
        throw new Error(report?.unsupported?.length ? '素材库不支持此文件格式，未保存素材' : '素材库未保存这份素材，请重试或检查素材库位置');
      let snapshot;
      try { snapshot = typeof library.snapshot === 'function' ? await library.snapshot() : null; } catch {}
      let existingAssets = [];
      if (report.duplicates && Array.isArray(snapshot?.assets)) {
        const hash = crypto.createHash('sha256');
        for await (const chunk of createReadStream(typed)) hash.update(chunk);
        const digest = hash.digest('hex');
        existingAssets = snapshot.assets.filter(asset => asset.hash === digest).map(asset => ({
          id: asset.id, name: asset.name, trashedAt: asset.trashedAt || null, folderId: asset.folderId || null
        }));
      }
      const folderName = folderId ? snapshot?.folders?.find(folder => folder.id === folderId)?.name : undefined;
      const result = {ok:true,imported:report.imported,duplicates:report.duplicates,assetIds:report.assetIds || [],existingAssets,
        libraryRoot: typeof snapshot?.root === 'string' ? snapshot.root : getLibraryRoot() || null,
        ...(currentId ? { libraryId: currentId, ...(report.imported ? { folderId, ...(folderName ? { folderName } : {}) } : {}) } : {})};
      progress(job, 'complete', result);
      // Saving is already committed. A closed renderer must not turn a saved
      // capture into a failure and prompt the user to download the same file.
      try { await onImported(result); } catch {}
      return result;
    } catch (error) {
      const failedPhase = job.status;
      progress(job, 'error', { error: error.name === 'TimeoutError' || error.name === 'AbortError' ? '素材下载超时，请检查网络后重试' : error.message });
      const failure = new Error(job.error);
      if (['CAPTURE_LIBRARY_CHANGED', 'CAPTURE_FOLDER_MISSING', 'CAPTURE_CANCELLED', 'VIDEO_AUTH_CANCELLED', 'VIDEO_AUTH_CLOSED', 'VIDEO_AUTH_UNAVAILABLE',
        'VIDEO_BROWSER_PERMISSION_REQUIRED', 'VIDEO_BROWSER_SESSION_INVALID', 'VIDEO_BROWSER_SESSION_EXPIRED', 'VIDEO_BROWSER_LOGIN_REQUIRED'].includes(error.code) ||
          typeof error.code === 'string' && error.code.startsWith('SKETCHFAB_') ||
          (body?.kind === 'video' && ['VIDEO_BROWSER_READ', 'VIMEO_BROWSER_READ'].includes(error.code))) failure.code = error.code;
      else if (body?.kind === 'video' && ['reading', 'downloading', 'verifying', 'muxing'].includes(failedPhase)) {
        failure.code = error.code === 'VIDEO_INCOMPLETE' || failedPhase === 'verifying' ? 'VIDEO_INCOMPLETE' : 'VIDEO_SOURCE_FAILED';
      }
      throw failure;
    } finally {
      if (body && typeof body === 'object') delete body.youtubeSession;
      if (body && typeof body === 'object') delete body.bilibiliSession;
      await browserSession?.close();
      if (temporary) await fs.rm(temporary,{recursive:true,force:true}).catch(() => {});
    }
  }
  async function handler(request,response) {
    const origin = request.headers.origin;
    const cors = origin === allowedOrigin ? {'Access-Control-Allow-Origin':allowedOrigin,'Vary':'Origin'} : {};
    const json = (status,body) => { response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...cors}); response.end(JSON.stringify(body)); };
    if (request.headers.host !== `127.0.0.1:${listeningPort}` || (origin && origin !== allowedOrigin)) return json(403,{ok:false,error:'不允许的请求来源'});
    if (request.method === 'OPTIONS') {
      response.writeHead(204,{...cors,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Shitu-Token, X-Shitu-Extension','Access-Control-Max-Age':'600'}); return response.end();
    }
    // The browser supplies Origin; ordinary pages cannot forge an extension
    // origin or send our custom header with no-cors. Requests with no Origin
    // are accepted only with the exact extension id (some Chrome worker builds
    // omit Origin on host-permitted requests). This is a loopback-only API.
    if(request.method==='POST' && request.url==='/v1/connect') {
      if(request.headers['x-shitu-extension']!==allowedOrigin.replace('chrome-extension://','')) return json(403,{ok:false,error:'不是受支持的 Mosaic 采集扩展'});
      if(!String(request.headers['content-type']).startsWith('application/json')) return json(415,{ok:false,error:'只支持 JSON 请求'});
      try {
        await readJSON(request,4096);
        // Existing v1 clients treat the app field as the protocol identifier.
        return json(200,{ok:true,app:'拾图',version:appVersion,...readyStatus(),connection:{port:listeningPort,token}});
      } catch(error) {return json(400,{ok:false,error:error.message});}
    }
    const supplied = request.headers['x-shitu-token'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) return json(401,{ok:false,error:'连接已失效，采集助手需要自动重新连接'});
    if (request.method !== 'POST' || !['/v1/ping','/v1/capture','/v1/capture-progress','/v1/capture-browser-read','/v1/capture-browser-data','/v1/capture-browser-cancel','/v1/folders','/v1/locate'].includes(request.url)) return json(404,{ok:false,error:'接口不存在'});
    if (!String(request.headers['content-type']).startsWith('application/json')) {
      if (request.url === '/v1/capture') rejectedCapture(new Error('只支持 JSON 请求'));
      return json(415,{ok:false,error:'只支持 JSON 请求'});
    }
    try {
      const body = await readJSON(request, request.url === '/v1/capture' ? 28*1024*1024+32768 : request.url === '/v1/capture-browser-data' ? BROWSER_MESSAGE_LIMIT : 4096);
      if (request.url === '/v1/ping') return json(200,{ok:true,app:'拾图',version:appVersion,...readyStatus()});
      if (['/v1/capture-browser-read', '/v1/capture-browser-data', '/v1/capture-browser-cancel'].includes(request.url)) {
        if (!validCaptureRequestId(body?.requestId)) return json(400,{ok:false,error:'采集任务编号无效'});
        const record = captures.get(body.requestId);
        if (request.url === '/v1/capture-browser-cancel') {
          // Once importing starts, cancellation cannot revoke the library's
          // commit. Report uncertainty instead of promising an absent file.
          const cancellable = Boolean(record?.browserRead && !record.finishedAt && record.cancelController &&
            !['importing', 'complete'].includes(record.job.status));
          if (cancellable) record.cancelController.abort(captureError('CAPTURE_CANCELLED', '浏览器视频读取已取消，未保存视频'));
          return json(200,{ok:true,cancelled:cancellable});
        }
        if (request.url === '/v1/capture-browser-read') return json(200,{ok:true,read:browserRelay.poll(body.requestId),done:Boolean(record?.browserRead && record.finishedAt)});
        return json(200,await browserRelay.accept(body));
      }
      if (request.url === '/v1/capture-progress') {
        if (!validCaptureRequestId(body?.requestId)) return json(400,{ok:false,error:'采集任务编号无效'});
        return json(200,{ok:true,progress:captureProgress(body.requestId)});
      }
      if(!isReady()) {
        const error = new Error('请先在 Mosaic 中选择素材库位置，或等待切换完成');
        if (request.url === '/v1/capture') rejectedCapture(error);
        return json(409,{ok:false,error:error.message});
      }
      if (request.url === '/v1/folders') {
        const id = libraryId(getLibraryRoot());
        if (!id) return json(409,{ok:false,error:'请先在 Mosaic 中选择素材库'});
        return json(200,{ok:true,libraryId:id,folders:listFolders()});
      }
      if (request.url === '/v1/locate') {
        const root = getLibraryRoot();
        const id = libraryId(root);
        if (!id || id !== body?.libraryId) return json(409,{ok:false,error:'请切换回保存此素材时使用的素材库'});
        const assetId = body?.assetId;
        if (typeof assetId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(assetId) || !hasAsset(assetId)) {
          return json(404,{ok:false,error:'素材已不存在，无法定位'});
        }
        if (!onLocate) return json(409,{ok:false,error:'Mosaic 窗口暂不可用，请稍后重试'});
        await onLocate({libraryRoot:root,assetIds:[assetId]});
        return json(200,{ok:true});
      }
      const id = body?.requestId;
      if (id !== undefined && !validCaptureRequestId(id)) throw new Error('采集任务编号无效');
      const pending = captures.get(id);
      if (pending && !pending.finishedAt) return json(409,{ok:false,error:'此素材仍在采集中',code:'CAPTURE_PENDING'});
      if (active >= 3) {
        rejectedCapture(new Error('当前有多个素材正在采集，请稍候再试'));
        return json(429,{ok:false,error:lastCapture.error});
      }
      const job = { status:'receiving', at:Date.now(), receivedBytes:0, name:typeof body?.name === 'string' ? body.name.slice(0,240) : '',
        kind:['image','video','model'].includes(body?.kind) ? body.kind : undefined };
      const record = { job, browserRead: body?.browserRead === true || ['youtube-browser', 'youtube-recording'].includes(body?.sourceType),
        ...(body?.browserRead === true || ['youtube', 'site-video', 'youtube-browser', 'youtube-recording', 'sketchfab'].includes(body?.sourceType) ? { cancelController: new AbortController() } : {}) };
      if (id !== undefined) {
        captures.delete(id);
        captures.set(id, record);
        pruneProgress();
      }
      active++;
      response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...cors}); response.write('\n');
      const heartbeat = setInterval(()=>{if (!response.destroyed) response.write(' ');},10000); heartbeat.unref();
      try { const result = await capture(body, job, record.cancelController?.signal); if (!response.destroyed) response.end(JSON.stringify(result)); }
      catch(error) { if (!response.destroyed) response.end(JSON.stringify({ok:false,error:error.message,...(error.code ? {code:error.code} : {})})); }
      finally { clearInterval(heartbeat); record.finishedAt = Date.now(); active--; }
    } catch(error) {
      if (request.url === '/v1/capture') rejectedCapture(error);
      if (!response.headersSent) json(400,{ok:false,error:error.message});
    }
  }
  return {
    async start() {
      await fs.mkdir(path.dirname(configPath),{recursive:true});
      try { token = JSON.parse(await fs.readFile(configPath,'utf8')).token; } catch(error) { if (error.code !== 'ENOENT') throw error; }
      if (!/^[a-f0-9]{64}$/.test(token || '')) { token = crypto.randomBytes(32).toString('hex'); await fs.writeFile(configPath,JSON.stringify({token}),{mode:0o600}); }
      for (let attempt=0;attempt<(port===0 ? 1 : 10);attempt++) {
        server=http.createServer(handler); server.requestTimeout=100000; server.headersTimeout=10000;
        server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
        try { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port ? port+attempt : 0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});}); listeningPort=server.address().port; disabledError=null; return this.info(); }
        catch(error) { if (error.code !== 'EADDRINUSE') throw error; disabledError='浏览器采集端口被占用，请关闭其他 Mosaic 实例后重试'; }
      }
      throw new Error(disabledError);
    },
    info() { return {enabled:Boolean(listeningPort),baseUrl:listeningPort?`http://127.0.0.1:${listeningPort}`:null,code:listeningPort?`SHITU1.${listeningPort}.${token}`:null,error:disabledError,lastCapture:lastCapture ? structuredClone(lastCapture) : null}; },
    activeCount: () => active,
    async close() {
      for (const record of captures.values()) if (!record.finishedAt) record.cancelController?.abort(captureError('CAPTURE_CANCELLED', '浏览器视频读取已取消，未保存视频'));
      await browserRelay.close();
      for(const socket of sockets)socket.destroy();
      if(server?.listening)await new Promise(resolve=>server.close(resolve));
      captures.clear();listeningPort=null;
    }
  };
}
module.exports={createCollector,identify,publicAddress,webUrl};
