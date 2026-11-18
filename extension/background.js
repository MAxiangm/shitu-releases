'use strict';

const CONFIG_KEY = 'shituConnection';
const LAST_KEY = 'shituLastCapture';
const DESTINATIONS_KEY = 'shituCaptureDestinations';
// A running worker can read an updated manifest without having loaded new code.
const WORKER_VERSION = '0.11.19';
const CAPTURE_TIMEOUT = 280000;
const PAGE_READ_TIMEOUT = 22000;
const PROGRESS_INTERVAL = 1000;
const MAX_DATA_LENGTH = 28 * 1024 * 1024;
const MENU_ID = 'shitu-save-media';
const pending = new Map();
const locateReceipts = new Map();
let requestSerial = 0;
let activeStatusId = null;
let statusWrites = Promise.resolve();
let destinationWrites = Promise.resolve();
let connecting = null;
let connectingForced = false;
// The page's content script does not need access to the local pairing secret.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

function checkedConfig(config) {
  // Preserve the port/token object cached by earlier extension versions.
  if (!config || !Number.isInteger(config.port) || config.port < 38475 || config.port > 38484 || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/i.test(config.token)) throw issue('本机连接信息已失效，将重新查找 Mosaic。', 'INVALID_CONNECTION');
  return { port: config.port, token: config.token.toLowerCase() };
}

function issue(message, code) { const error = new Error(message); error.code = code; return error; }

async function requestLocal(port, route, body, token, timeout) {
  if (!Number.isInteger(port) || port < 38475 || port > 38484) throw issue('本机采集端口无效。', 'INVALID_CONNECTION');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  // Chrome's extension API activity keeps the service worker alive during a larger import.
  const keepalive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Shitu-Token': token } : { 'X-Shitu-Extension': chrome.runtime.id }) },
        body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted || error?.name === 'AbortError') throw issue('采集尚未收到确认，桌面可能仍在处理。请先在 Mosaic 检查结果，避免重复操作。', 'TIMEOUT');
      throw issue('尚未找到本机 Mosaic，请先打开桌面软件。', 'CONNECTION_FAILED');
    }
    if (response.status === 401) throw issue('本机连接已更新，正在重新连接。', 'UNAUTHORIZED');
    let result;
    try { result = await response.json(); }
    catch (error) {
      if (abort.signal.aborted || error?.name === 'AbortError') throw issue('采集尚未收到确认，桌面可能仍在处理。请先在 Mosaic 检查结果，避免重复操作。', 'TIMEOUT');
      throw issue('Mosaic 返回了无效响应，请更新软件和扩展。', 'INVALID_RESPONSE');
    }
    if (!response.ok || !result?.ok) {
      const captureCodes = ['VIDEO_BROWSER_READ', 'CAPTURE_LIBRARY_CHANGED', 'CAPTURE_FOLDER_MISSING', 'CAPTURE_PENDING'];
      const code = route === '/v1/capture' && captureCodes.includes(result?.code) ? result.code : 'SERVER_ERROR';
      throw issue(result?.error || `请求失败（${response.status}）`, code);
    }
    return result;
  } finally { clearTimeout(timer); clearInterval(keepalive); }
}

function localRequest(route, body, config, timeout = 90000) {
  config = checkedConfig(config);
  return requestLocal(config.port, route, body, config.token, timeout);
}

function appStatus(result) {
  const version = typeof result?.version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(result.version);
  // The v1 app field identifies the collector protocol across desktop releases.
  if (result?.app !== '拾图' || !version || (Number(version[1]) === 0 && Number(version[2]) < 4) || typeof result.ready !== 'boolean') throw issue('请将桌面端更新到 0.4 或更新版本。', 'INCOMPATIBLE_APP');
  const libraryId = exactId(result.libraryId);
  return { ok: true, app: '拾图', version: result.version, ready: result.ready,
    ...(libraryId ? { libraryId } : {}), ...(result.captureProgress === true ? { captureProgress: true } : {}),
    ...(result.vimeoPlayback === true ? { vimeoPlayback: true } : {}) };
}

async function discoverAt(port) {
  const result = await requestLocal(port, '/v1/connect', {}, null, 900);
  const status = appStatus(result);
  const config = checkedConfig(result.connection);
  if (config.port !== port) throw issue('本机采集服务返回了不匹配的端口。', 'INVALID_CONNECTION');
  return { config, status };
}

async function establishConnection(force = false) {
  const { [CONFIG_KEY]: stored } = await chrome.storage.local.get(CONFIG_KEY);
  let cached;
  try { cached = checkedConfig(stored); } catch {}
  if (cached && !force) {
    try { return { config: cached, status: appStatus(await localRequest('/v1/ping', {}, cached, 900)) }; }
    catch {}
  }
  if (cached) {
    try { const found = await discoverAt(cached.port); await chrome.storage.local.set({ [CONFIG_KEY]: found.config }); return found; }
    catch {}
  }
  const ports = Array.from({ length: 10 }, (_, i) => 38475 + i).filter(port => port !== cached?.port);
  const attempts = await Promise.all(ports.map(async port => { try { return await discoverAt(port); } catch (error) { return { error }; } }));
  const found = attempts.find(result => result.config && result.status.ready) || attempts.find(result => result.config);
  if (!found) {
    const incompatible = attempts.find(result => result.error?.code === 'INCOMPATIBLE_APP');
    throw incompatible?.error || issue('尚未找到本机 Mosaic，请先打开桌面软件。', 'CONNECTION_FAILED');
  }
  await chrome.storage.local.set({ [CONFIG_KEY]: found.config });
  return found;
}

function ensureConnection(force = false) {
  if (connecting) {
    // A forced reconnect must not reuse a ping that validated the old token.
    if (force && !connectingForced) return connecting.catch(() => {}).then(() => ensureConnection(true));
    return connecting;
  }
  connectingForced = force;
  connecting = establishConnection(force).finally(() => { connecting = null; connectingForced = false; });
  return connecting;
}

function safeText(value, limit) { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function exactId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null; }

async function destinationPreferences() {
  const { [DESTINATIONS_KEY]: stored } = await chrome.storage.local.get(DESTINATIONS_KEY);
  return Array.isArray(stored) ? stored.filter(entry => exactId(entry?.libraryId) && (entry.folderId === null || exactId(entry.folderId))) : [];
}

async function listFolders() {
  const connection = await ensureConnection();
  const { libraryId, ready } = connection.status;
  if (!ready || !libraryId) return { ok: true, supported: false };
  const result = await localRequest('/v1/folders', {}, connection.config, 4000);
  if (result.libraryId !== libraryId || !Array.isArray(result.folders)) throw new Error('素材库已切换，请刷新文件夹列表。');
  const folders = result.folders.filter(folder => exactId(folder?.id) && typeof folder.name === 'string')
    .map(folder => ({ id: folder.id, name: safeText(folder.name, 240), parentId: exactId(folder.parentId) }));
  return { ok: true, supported: true, libraryId, folders };
}

async function captureFolders() {
  const state = await listFolders();
  if (!state.supported) return state;
  await destinationWrites.catch(() => {});
  const settings = await destinationPreferences();
  return { ...state, folderId: settings.find(entry => entry.libraryId === state.libraryId)?.folderId ?? null };
}

function setCaptureFolder(libraryId, folderId) {
  if (!exactId(libraryId) || (folderId !== null && !exactId(folderId))) throw new Error('保存位置无效。');
  const write = destinationWrites.catch(() => {}).then(async () => {
    const state = await listFolders();
    if (state.libraryId !== libraryId) throw new Error('素材库已切换，请重新选择保存位置。');
    if (folderId !== null && !state.folders.some(folder => folder.id === folderId)) throw new Error('这个文件夹已不存在，请重新选择保存位置。');
    const settings = (await destinationPreferences()).filter(entry => entry.libraryId !== libraryId);
    if (folderId !== null) settings.push({ libraryId, folderId });
    await chrome.storage.local.set({ [DESTINATIONS_KEY]: settings });
    return { ok: true, libraryId, folderId };
  });
  destinationWrites = write;
  return write;
}

async function captureDestination(libraryId) {
  if (!libraryId) return null;
  await destinationWrites.catch(() => {});
  const settings = await destinationPreferences();
  return { libraryId, folderId: settings.find(entry => entry.libraryId === libraryId)?.folderId ?? null };
}

function savedLocation(result, confirmed) {
  const libraryId = exactId(result.libraryId);
  const existing = confirmed.existingAssets.find(asset => asset.id && !asset.trashedAt) || confirmed.existingAssets.find(asset => asset.id);
  const assetId = exactId(confirmed.imported ? confirmed.assetIds[0] : existing?.id);
  return libraryId && assetId ? { libraryId, assetId } : null;
}

function rememberLocateReceipt(receipt, location, sender) {
  const now = Date.now();
  for (const [key, value] of locateReceipts) if (value.expires <= now) locateReceipts.delete(key);
  locateReceipts.set(receipt, { location, expires: now + 60000, tabId: sender?.tab?.id,
    frameId: sender?.frameId || 0, documentId: sender?.documentId });
}

function resolveLocateReceipt(receipt, sender) {
  const saved = locateReceipts.get(receipt);
  if (!saved || saved.expires <= Date.now() || saved.tabId !== sender.tab.id || saved.frameId !== (sender.frameId || 0) ||
      (saved.documentId && saved.documentId !== sender.documentId)) throw new Error('网页采集提示已过期，请在采集助手中打开上次保存的素材。');
  return saved.location;
}

async function locateAsset(location) {
  const connection = await ensureConnection();
  if (!connection.status.ready || connection.status.libraryId !== location.libraryId) throw new Error('请在 Mosaic 中切回采集时使用的素材库。');
  return localRequest('/v1/locate', location, connection.config, 6000);
}

function recordCapture(record) {
  // An older completion or a second click must not erase another active task.
  const write = statusWrites.catch(() => {}).then(async () => {
    const { [LAST_KEY]: previous } = await chrome.storage.local.get(LAST_KEY);
    if (record.requestId !== activeStatusId && previous) {
      await chrome.storage.local.set({ [LAST_KEY]: { ...previous, lastNotice: record } });
    } else await chrome.storage.local.set({ [LAST_KEY]: record });
  });
  statusWrites = write;
  return write.catch(() => {});
}

async function recordFailure(error, details = {}) {
  const requestId = details.requestId || `failed-${Date.now()}-${++requestSerial}`;
  if (!pending.size && !details.requestId) activeStatusId = requestId;
  return recordCapture({ requestId, ok: false, pending: false, status: 'error', at: Date.now(),
    name: safeText(details.name, 240) || '网页素材', error: safeText(error?.message || String(error), 1500),
    ...(error?.code ? { code: safeText(error.code, 80) } : {}) });
}

function captureResult(result) {
  const { imported = 0, duplicates = 0 } = result || {};
  if (!Number.isSafeInteger(imported) || imported < 0 || !Number.isSafeInteger(duplicates) || duplicates < 0 || (!imported && !duplicates))
    throw issue('桌面未确认素材入库，请在 Mosaic 中检查后重试。', 'IMPORT_NOT_CONFIRMED');
  const existingAssets = Array.isArray(result.existingAssets) ? result.existingAssets.slice(0, 20).map(asset => ({
    id: safeText(asset?.id, 128), name: safeText(asset?.name, 240),
    trashedAt: typeof asset?.trashedAt === 'string' ? safeText(asset.trashedAt, 80) : null,
    folderId: typeof asset?.folderId === 'string' ? safeText(asset.folderId, 128) : null
  })) : [];
  const inTrash = !imported && existingAssets.length > 0 && existingAssets.every(asset => asset.trashedAt);
  const message = imported ? '已保存到素材库，可在“全部素材”或“最近导入”查看。'
    : inTrash ? '这份素材已在回收站，请到 Mosaic 恢复后查看。' : '素材库中已有这份文件，可清除搜索和格式筛选后查看。';
  return { ok: true, imported, duplicates, existingAssets, message, status: inTrash ? 'warning' : 'success',
    assetIds: Array.isArray(result.assetIds) ? result.assetIds.filter(exactId).slice(0, 20) : [],
    ...(typeof result.libraryRoot === 'string' ? { libraryRoot: safeText(result.libraryRoot, 4096) } : {}) };
}

function checkedVimeoPlayback(input, source, senderUrl) {
  const rejected = () => new Error('Vimeo 播放源或页面地址无效。');
  let page;
  try { page = new URL(senderUrl); } catch { throw rejected(); }
  if (page.protocol !== 'https:' || page.port || page.username || page.password || !/^(?:(?:www|player)\.)?vimeo\.com$/.test(page.hostname)) throw rejected();
  const id = page.hostname === 'player.vimeo.com'
    ? /^\/video\/(\d+)\/?$/.exec(page.pathname)?.[1]
    : /^(?:\/(?:channels\/[^/]+|groups\/[^/]+\/videos))?\/(\d+)\/?$/.exec(page.pathname)?.[1];
  const fromCdn = /\.vimeocdn\.com$/.test(source.hostname);
  const fromPlayer = source.hostname === 'player.vimeo.com' && /^\/progressive_redirect\/playback\/(\d+)\//i.exec(source.pathname)?.[1] === id;
  const validPath = input.playback === 'file' && /\.(?:mp4|m4v|mov|webm)$/i.test(source.pathname) ||
    input.playback === 'hls' && /\.m3u8$/i.test(source.pathname) || input.playback === 'dash' && /\.mpd$/i.test(source.pathname);
  if (!id || input.kind !== 'video' || source.protocol !== 'https:' || source.port || source.hash ||
      !validPath || (!fromCdn && !fromPlayer) || Object.hasOwn(input, 'dataBase64')) throw rejected();
  return { playback: input.playback, pageUrl: `https://vimeo.com/${id}` };
}

function checkedMedia(input, senderUrl) {
  if (!input || typeof input !== 'object' || !['image', 'video'].includes(input.kind)) throw new Error('不是可采集的图片或视频。');
  if (typeof input.url !== 'string' || input.url.length > 8192) throw new Error('素材地址过长或无效。');
  const url = input.url;
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('素材地址无效。'); }
  if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)) throw new Error('不支持这种素材地址。');
  if (parsed.username || parsed.password) throw new Error('素材地址不能包含账号密码。');
  const playback = Object.hasOwn(input, 'playback')
    ? checkedVimeoPlayback(input, parsed, acceptedSocialPage(input.socialPageUrl, senderUrl) || senderUrl) : null;
  if (!playback && input.kind === 'video' && /\.(m3u8|mpd)(?:$|[?#])/i.test(url)) {
    throw new Error('这是分段流媒体，暂不能保存为视频文件。请使用网站提供的下载功能。');
  }
  const body = {
    url,
    kind: input.kind,
    name: safeText(input.name, 240),
    title: safeText(input.title, 500),
    pageUrl: safeText(input.pageUrl, 8192),
    ...playback,
  };
  const temporary = ['data:', 'blob:'].includes(parsed.protocol);
  const inline = Object.hasOwn(input, 'dataBase64');
  if (temporary || inline) {
    if (typeof input.dataBase64 !== 'string' || !input.dataBase64 || input.dataBase64.length > MAX_DATA_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) throw new Error('临时素材读取失败或超过 20 MB。');
    const padding = input.dataBase64.endsWith('==') ? 2 : input.dataBase64.endsWith('=') ? 1 : 0;
    if (input.dataBase64.length % 4 || input.dataBase64.length / 4 * 3 - padding > 20 * 1024 * 1024) throw new Error('临时素材读取失败或超过 20 MB。');
    const allowedMime = input.kind === 'image' ? /^image\/(?:png|jpeg|webp|gif|bmp|svg\+xml|avif|tiff)$/i : /^video\/(?:mp4|webm|ogg|quicktime)$/i;
    if (!allowedMime.test(input.mimeType || '')) throw new Error('不支持这种临时素材格式。');
    body.dataBase64 = input.dataBase64;
    body.mimeType = input.mimeType.toLowerCase();
  }
  return body;
}

function pageTarget(sender) {
  return sender.documentId ? { documentId: sender.documentId } : { frameId: sender.frameId || 0 };
}

function notifyTab(sender, message, { status = 'working', locateReceipt, clientCaptureId, progress } = {}) {
  if (typeof sender?.tab?.id !== 'number') return;
  void Promise.resolve().then(() => chrome.tabs.sendMessage(sender.tab.id, {
    type: 'shitu:status', message, status, ...(locateReceipt ? { locateReceipt } : {}),
    ...(clientCaptureId ? { clientCaptureId } : {}), ...(progress ? { progress } : {})
  }, pageTarget(sender))).catch(() => {});
}

function readFromPage(sender, message) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(issue('网页读取超时，请刷新页面后重试。', 'PAGE_READ_TIMEOUT')), PAGE_READ_TIMEOUT);
  });
  const reply = Promise.resolve().then(() => chrome.tabs.sendMessage(sender.tab.id, message, pageTarget(sender)));
  return Promise.race([reply, deadline]).finally(() => clearTimeout(timer));
}

async function readVideoFromPage(body, sender, clientCaptureId) {
  if (body.kind !== 'video' || body.dataBase64 || !/^https?:/i.test(body.url) || typeof sender?.tab?.id !== 'number') return null;
  const reply = await readFromPage(sender, {
    type: 'shitu:resolve-media', media: { ...body, pageUrl: sender.url || body.pageUrl }, browserVideo: true,
    ...(clientCaptureId ? { clientCaptureId } : {})
  }).catch(error => {
    if (error.code === 'PAGE_READ_TIMEOUT') throw error;
    return null;
  });
  const media = reply?.media;
  if (!reply?.ok || media?.url !== body.url || media.kind !== 'video' || !Object.hasOwn(media, 'dataBase64')) return null;
  return checkedMedia({ ...body, dataBase64: media.dataBase64, mimeType: media.mimeType });
}

function captureProgress(value) {
  if (!['receiving', 'downloading', 'muxing', 'importing', 'complete'].includes(value?.phase)) return null;
  const receivedBytes = Number.isSafeInteger(value.receivedBytes) && value.receivedBytes >= 0 ? value.receivedBytes : 0;
  const knownTotal = Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0 && value.totalBytes >= receivedBytes;
  return { phase: value.phase, receivedBytes, ...(knownTotal ? { totalBytes: value.totalBytes } : {}) };
}

function displayBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function progressMessage(progress) {
  if (progress.phase === 'receiving') return '桌面正在接收素材…';
  if (progress.phase === 'muxing') return '正在合并音视频（不重新编码）…';
  if (progress.phase === 'importing') return '正在写入素材库，等待保存确认…';
  if (progress.phase === 'complete') return '正在确认入库结果…';
  const received = displayBytes(progress.receivedBytes);
  if (progress.totalBytes) {
    const percent = Math.floor(progress.receivedBytes / progress.totalBytes * 100);
    return `正在下载素材 · ${percent}% · ${received} / ${displayBytes(progress.totalBytes)}`;
  }
  return progress.receivedBytes ? `正在下载素材 · 已接收 ${received}` : '正在下载素材…';
}

function watchProgress(requestId, config, publish) {
  let stopped = false, timer, previous;
  async function poll() {
    try {
      const reply = await localRequest('/v1/capture-progress', { requestId }, config, 1500);
      if (stopped) return;
      const progress = captureProgress(reply.progress);
      const key = progress && JSON.stringify(progress);
      if (key && key !== previous) {
        previous = key;
        await publish(progress.phase, progressMessage(progress), progress);
      }
    } catch (error) {
      if (['SERVER_ERROR', 'UNAUTHORIZED'].includes(error.code)) stopped = true;
    } finally {
      if (!stopped) timer = setTimeout(poll, PROGRESS_INTERVAL);
    }
  }
  timer = setTimeout(poll, PROGRESS_INTERVAL);
  return () => { stopped = true; clearTimeout(timer); };
}

function acceptedSocialPage(value, frameUrl) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const post = new URL(value), frame = new URL(frameUrl);
    if (post.protocol !== 'https:' || post.origin !== frame.origin || post.username || post.password || post.search || post.hash) return null;
    if (/^(?:www\.)?instagram\.com$/.test(post.hostname) &&
        /^\/(?:[a-z0-9_.]+\/)?(?:reels?|p|tv)\/[a-z0-9_-]+(?:\/embed(?:\/captioned)?)?\/?$/i.test(post.pathname)) return post.href;
    if (/^(?:(?:www|platform)\.)?(?:twitter|x)\.com$/.test(post.hostname) &&
        /^\/(?:[a-z0-9_]+\/status|i\/(?:web\/)?status)\/\d+\/?$/i.test(post.pathname)) return post.href;
    if (/^(?:[a-z0-9-]+\.)?pinterest\.com$/.test(post.hostname) && /^\/pin\/\d{1,32}\/?$/.test(post.pathname)) return post.href;
    if (/^(?:www\.)?vimeo\.com$/.test(post.hostname) && /^(?:\/(?:channels\/[^/]+|groups\/[^/]+\/videos))?\/\d+\/?$/.test(post.pathname)) return post.href;
  } catch {}
  return null;
}

async function capture(input, sender, clientCaptureId) {
  let body, key, requestId, resolveShared, rejectShared;
  try {
    body = checkedMedia(input, sender?.url);
    if (!body.playback) {
      if (/^https?:/i.test(sender?.url || '')) body.pageUrl = (body.kind === 'video' && acceptedSocialPage(input.socialPageUrl, sender.url)) || sender.url;
      else if (!/^https?:/i.test(body.pageUrl || '') && /^https?:/i.test(sender?.tab?.url || '')) body.pageUrl = sender.tab.url;
    }
    key = JSON.stringify([sender?.tab?.id, sender?.documentId || sender?.frameId || 0, body.url]);
    if (pending.has(key)) {
      const shared = pending.get(key);
      key = null;
      if (clientCaptureId) {
        shared.clientCaptureId = clientCaptureId;
        if (shared.status) notifyTab(sender, shared.status.message, { ...shared.status, clientCaptureId });
      }
      await recordFailure(issue('这份素材仍在采集中，正在等待同一任务的保存结果。', 'ALREADY_PENDING'), { name: body.name });
      return shared.promise;
    }
    const shared = new Promise((resolve, reject) => { resolveShared = resolve; rejectShared = reject; });
    shared.catch(() => {});
    const job = { promise: shared, clientCaptureId };
    pending.set(key, job);
    requestId = `${Date.now()}-${++requestSerial}`;
    activeStatusId = requestId;
    const name = body.name || body.title || '网页素材';
    function publish(phase, message, progress) {
      job.status = { message, progress };
      notifyTab(sender, message, { progress, clientCaptureId: job.clientCaptureId });
      return recordCapture({ requestId, ok: false, pending: true, status: 'working', phase, at: Date.now(), name,
        message, ...(progress ? { progress } : {}) });
    }
    await publish('connecting', '正在连接桌面 Mosaic，尚未保存…');
    let connection = await ensureConnection();
    if (!connection.status.ready) throw issue('请先在桌面 Mosaic 中选择或新建素材库。', 'LIBRARY_NOT_READY');
    const destination = await captureDestination(connection.status.libraryId);
    async function submit(media) {
      const payload = { ...media, requestId, ...(destination ? { destination } : {}) };
      async function attempt() {
        if (media.playback && !connection.status.vimeoPlayback) throw issue('请将桌面 Mosaic 更新到支持 Vimeo 播放采集的版本。', 'INCOMPATIBLE_APP');
        await publish(media.dataBase64 ? 'receiving' : 'downloading',
          media.dataBase64 ? '正在把素材交给桌面…' : '正在下载素材…');
        const stop = connection.status.captureProgress ? watchProgress(requestId, connection.config, publish) : null;
        try { return await localRequest('/v1/capture', payload, connection.config, CAPTURE_TIMEOUT); }
        finally { stop?.(); }
      }
      try { return await attempt(); }
      catch (error) {
        if (!['UNAUTHORIZED', 'CONNECTION_FAILED'].includes(error.code)) throw error;
        connection = await ensureConnection(true);
        if (!connection.status.ready) throw issue('请先在桌面 Mosaic 中选择或新建素材库。', 'LIBRARY_NOT_READY');
        if (destination && connection.status.libraryId !== destination.libraryId) throw new Error('素材库已切换，请重新采集。');
        return attempt();
      }
    }
    let result;
    try { result = await submit(body); }
    catch (error) {
      if (body.playback || error.code !== 'VIDEO_BROWSER_READ') throw error;
      await publish('reading', '正在从当前网页读取视频，尚未保存…');
      const browserVideo = await readVideoFromPage(body, sender, job.clientCaptureId);
      if (!browserVideo) throw error;
      result = await submit(browserVideo);
    }
    const confirmed = captureResult(result);
    const location = savedLocation(result, confirmed);
    if (location) rememberLocateReceipt(requestId, location, sender);
    const folderName = safeText(result.folderName, 240).trim();
    const popupMessage = confirmed.imported && folderName ? `已保存到「${folderName}」。` : confirmed.message;
    await recordCapture({ ...confirmed, requestId, at: Date.now(), pending: false, status: confirmed.imported ? 'saved' : 'duplicate', name,
      message: popupMessage, ...(location ? { location } : {}) });
    const reply = location ? { ...confirmed, locateReceipt: requestId } : confirmed;
    resolveShared(reply);
    return reply;
  } catch (error) {
    await recordFailure(error, { requestId, name: body?.name || input?.name });
    rejectShared?.(error);
    throw error;
  } finally { if (key) pending.delete(key); }
}

async function handleMessage(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('请求来源无效。');
  if (message?.type === 'shitu:capture') {
    if (!sender.tab || !/^https?:/i.test(sender.url || '')) throw new Error('请在普通网页中采集素材。');
    const clientCaptureId = typeof message.clientCaptureId === 'string' && /^\d{13}-\d{1,10}$/.test(message.clientCaptureId) ? message.clientCaptureId : undefined;
    return capture(message.media, sender, clientCaptureId);
  }
  if (message?.type === 'shitu:capture-failed' || message?.type === 'shitu:locate') {
    if (!sender.tab || !/^https?:/i.test(sender.url || '')) throw new Error('请求来源无效。');
    if (message.type === 'shitu:locate') return locateAsset(resolveLocateReceipt(message.receipt, sender));
    await recordFailure(new Error(safeText(message.error, 1500) || '浏览器未能读取素材。'), { name: safeText(message.name, 240) });
    return { ok: true };
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('请求来源无效。');
  if (message?.type === 'shitu:extension-info') return { ok: true, protocol: 1, version: WORKER_VERSION, build: WORKER_VERSION };
  if (message?.type === 'shitu:ping' || message?.type === 'shitu:reconnect') return (await ensureConnection(message.type === 'shitu:reconnect')).status;
  if (message?.type === 'shitu:folders') return captureFolders();
  if (message?.type === 'shitu:set-folder') return setCaptureFolder(message.libraryId, message.folderId);
  if (message?.type === 'shitu:locate-recent') {
    const { [LAST_KEY]: recent } = await chrome.storage.local.get(LAST_KEY);
    if (!recent?.ok || recent.requestId !== message.requestId || !exactId(recent.location?.libraryId) || !exactId(recent.location.assetId)) {
      throw new Error('上次采集结果已变化，请重新查看。');
    }
    return locateAsset(recent.location);
  }
  throw new Error('未知请求。');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message, code: error.code }));
  return true;
});

function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: '保存到 Mosaic', contexts: ['image', 'video'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }, () => void chrome.runtime.lastError);
  });
}
function initialize() { createMenu(); ensureConnection().catch(() => {}); }
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  const sender = { tab, url: info.frameUrl || info.pageUrl, frameId: info.frameId || 0 };
  notifyTab(sender, '正在准备采集，尚未保存…');
  try {
    let media = { url: info.srcUrl, kind: info.mediaType === 'video' ? 'video' : 'image', pageUrl: info.frameUrl || info.pageUrl, title: tab.title };
    const temporary = /^(blob|data):/i.test(info.srcUrl || '');
    if (temporary || media.kind === 'image') {
      let resolved;
      try { resolved = await readFromPage(sender, { type: 'shitu:resolve-media', media }); }
      catch (error) { if (temporary) throw error.code === 'PAGE_READ_TIMEOUT' ? error : new Error('无法读取临时素材，请刷新网页后重试。'); }
      if (resolved?.ok) media = resolved.media;
      else if (resolved || temporary) throw new Error(resolved?.error || '无法读取临时素材。');
    }
    const result = await capture(media, sender);
    notifyTab(sender, result.message, { status: result.status, locateReceipt: result.locateReceipt });
  } catch (error) {
    await recordFailure(error, { name: tab.title });
    notifyTab(sender, error.message, { status: 'error' });
  }
});
