'use strict';

const CONFIG_KEY = 'shituConnection';
const LAST_KEY = 'shituLastCapture';
// A running worker can read an updated manifest without having loaded new code.
const WORKER_VERSION = '0.11.1';
const CAPTURE_TIMEOUT = 280000;
const MAX_DATA_LENGTH = 28 * 1024 * 1024;
const MENU_ID = 'shitu-save-media';
const pending = new Map();
let requestSerial = 0;
let activeStatusId = null;
let statusWrites = Promise.resolve();
let connecting = null;
let connectingForced = false;
// The page's content script does not need access to the local pairing secret.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

function checkedConfig(config) {
  // Preserve the port/token object cached by earlier extension versions.
  if (!config || !Number.isInteger(config.port) || config.port < 38475 || config.port > 38484 || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/i.test(config.token)) throw issue('本机连接信息已失效，将重新查找拾图。', 'INVALID_CONNECTION');
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
      if (error.name === 'AbortError') throw issue('采集尚未收到确认，桌面可能仍在处理。请先在拾图检查结果，避免重复操作。', 'TIMEOUT');
      throw issue('尚未找到本机拾图，请先打开桌面软件。', 'CONNECTION_FAILED');
    }
    if (response.status === 401) throw issue('本机连接已更新，正在重新连接。', 'UNAUTHORIZED');
    let result;
    try { result = await response.json(); }
    catch (error) {
      if (error.name === 'AbortError') throw issue('采集尚未收到确认，桌面可能仍在处理。请先在拾图检查结果，避免重复操作。', 'TIMEOUT');
      throw issue('拾图返回了无效响应，请更新软件和扩展。', 'INVALID_RESPONSE');
    }
    if (!response.ok || !result?.ok) throw issue(result?.error || `请求失败（${response.status}）`, 'SERVER_ERROR');
    return result;
  } finally { clearTimeout(timer); clearInterval(keepalive); }
}

function localRequest(route, body, config, timeout = 90000) {
  config = checkedConfig(config);
  return requestLocal(config.port, route, body, config.token, timeout);
}

function appStatus(result) {
  const version = typeof result?.version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(result.version);
  if (result?.app !== '拾图' || !version || (Number(version[1]) === 0 && Number(version[2]) < 4) || typeof result.ready !== 'boolean') throw issue('请将桌面拾图更新到 0.4 或更新版本。', 'INCOMPATIBLE_APP');
  return { ok: true, app: '拾图', version: result.version, ready: result.ready };
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
    throw incompatible?.error || issue('尚未找到本机拾图，请先打开桌面软件。', 'CONNECTION_FAILED');
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
    throw issue('桌面未确认素材入库，请在拾图中检查后重试。', 'IMPORT_NOT_CONFIRMED');
  const existingAssets = Array.isArray(result.existingAssets) ? result.existingAssets.slice(0, 20).map(asset => ({
    id: safeText(asset?.id, 128), name: safeText(asset?.name, 240),
    trashedAt: typeof asset?.trashedAt === 'string' ? safeText(asset.trashedAt, 80) : null,
    folderId: typeof asset?.folderId === 'string' ? safeText(asset.folderId, 128) : null
  })) : [];
  const inTrash = !imported && existingAssets.some(asset => asset.trashedAt);
  const message = imported ? '已保存到素材库，可在“全部素材”或“最近导入”查看。'
    : inTrash ? '这份素材已在回收站，请到拾图恢复后查看。' : '素材库中已有这份文件，可清除搜索和格式筛选后查看。';
  return { ok: true, imported, duplicates, existingAssets, message, status: inTrash ? 'warning' : 'success',
    assetIds: Array.isArray(result.assetIds) ? result.assetIds.filter(id => typeof id === 'string').slice(0, 20) : [],
    ...(typeof result.libraryRoot === 'string' ? { libraryRoot: safeText(result.libraryRoot, 4096) } : {}) };
}

function checkedMedia(input) {
  if (!input || typeof input !== 'object' || !['image', 'video'].includes(input.kind)) throw new Error('不是可采集的图片或视频。');
  if (typeof input.url !== 'string' || input.url.length > 8192) throw new Error('素材地址过长或无效。');
  const url = input.url;
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('素材地址无效。'); }
  if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)) throw new Error('不支持这种素材地址。');
  if (parsed.username || parsed.password) throw new Error('素材地址不能包含账号密码。');
  if (input.kind === 'video' && /\.(m3u8|mpd)(?:$|[?#])/i.test(url)) {
    throw new Error('这是分段流媒体，暂不能保存为视频文件。请使用网站提供的下载功能。');
  }
  const body = {
    url,
    kind: input.kind,
    name: safeText(input.name, 240),
    title: safeText(input.title, 500),
    pageUrl: safeText(input.pageUrl, 8192),
  };
  const temporary = ['data:', 'blob:'].includes(parsed.protocol);
  const inline = Object.hasOwn(input, 'dataBase64');
  if (temporary || inline) {
    if (!temporary && input.kind !== 'image') throw new Error('直链视频应由桌面下载，请重新采集。');
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

async function notifyTab(tabId, frameId, message, status = 'working') {
  if (typeof tabId !== 'number') return;
  await chrome.tabs.sendMessage(tabId, { type: 'shitu:status', message, status }, { frameId: frameId || 0 }).catch(() => {});
}

async function capture(input, sender) {
  let body, key, requestId, resolveShared, rejectShared;
  try {
    body = checkedMedia(input);
    if (/^https?:/i.test(sender?.url || '')) body.pageUrl = sender.url;
    else if (!/^https?:/i.test(body.pageUrl || '') && /^https?:/i.test(sender?.tab?.url || '')) body.pageUrl = sender.tab.url;
    key = `${sender?.tab?.id}:${body.url}`;
    if (pending.has(key)) {
      const shared = pending.get(key);
      key = null;
      await recordFailure(issue('这份素材仍在采集中，正在等待同一任务的保存结果。', 'ALREADY_PENDING'), { name: body.name });
      return shared;
    }
    const shared = new Promise((resolve, reject) => { resolveShared = resolve; rejectShared = reject; });
    shared.catch(() => {});
    pending.set(key, shared);
    requestId = `${Date.now()}-${++requestSerial}`;
    activeStatusId = requestId;
    const name = body.name || body.title || '网页素材';
    await recordCapture({ requestId, ok: false, pending: true, status: 'working', phase: 'connecting', at: Date.now(), name,
      message: '正在连接桌面拾图，尚未保存。' });
    let connection = await ensureConnection();
    if (!connection.status.ready) throw issue('请先在桌面拾图中选择或新建素材库。', 'LIBRARY_NOT_READY');
    const message = body.dataBase64 ? '正在写入素材库，等待保存确认…' : '正在下载并写入素材库，等待保存确认…';
    await recordCapture({ requestId, ok: false, pending: true, status: 'working', phase: 'saving', at: Date.now(), name, message });
    await notifyTab(sender?.tab?.id, sender?.frameId, message);
    let result;
    try { result = await localRequest('/v1/capture', body, connection.config, CAPTURE_TIMEOUT); }
    catch (error) {
      if (!['UNAUTHORIZED', 'CONNECTION_FAILED'].includes(error.code)) throw error;
      connection = await ensureConnection(true);
      if (!connection.status.ready) throw issue('请先在桌面拾图中选择或新建素材库。', 'LIBRARY_NOT_READY');
      result = await localRequest('/v1/capture', body, connection.config, CAPTURE_TIMEOUT);
    }
    const confirmed = captureResult(result);
    await recordCapture({ ...confirmed, requestId, at: Date.now(), pending: false, status: confirmed.imported ? 'saved' : 'duplicate', name });
    resolveShared(confirmed);
    return confirmed;
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
    return capture(message.media, sender);
  }
  if (message?.type === 'shitu:capture-failed') {
    if (!sender.tab || !/^https?:/i.test(sender.url || '')) throw new Error('请求来源无效。');
    await recordFailure(new Error(safeText(message.error, 1500) || '浏览器未能读取素材。'), { name: safeText(message.name, 240) });
    return { ok: true };
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('请求来源无效。');
  if (message?.type === 'shitu:extension-info') return { ok: true, protocol: 1, version: WORKER_VERSION, build: WORKER_VERSION };
  if (message?.type === 'shitu:ping' || message?.type === 'shitu:reconnect') return (await ensureConnection(message.type === 'shitu:reconnect')).status;
  throw new Error('未知请求。');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message, code: error.code }));
  return true;
});

function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: '保存到拾图', contexts: ['image', 'video'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }, () => void chrome.runtime.lastError);
  });
}
function initialize() { createMenu(); ensureConnection().catch(() => {}); }
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  const frameId = info.frameId || 0;
  await notifyTab(tab.id, frameId, '正在准备采集，尚未保存…');
  try {
    let media = { url: info.srcUrl, kind: info.mediaType === 'video' ? 'video' : 'image', pageUrl: info.frameUrl || info.pageUrl, title: tab.title };
    const temporary = /^(blob|data):/i.test(info.srcUrl || '');
    if (temporary || media.kind === 'image') {
      let resolved;
      try { resolved = await chrome.tabs.sendMessage(tab.id, { type: 'shitu:resolve-media', media }, { frameId }); }
      catch (error) { if (temporary) throw new Error('无法读取临时素材，请刷新网页后重试。'); }
      if (resolved?.ok) media = resolved.media;
      else if (resolved || temporary) throw new Error(resolved?.error || '无法读取临时素材。');
    }
    const result = await capture(media, { tab, url: info.frameUrl || info.pageUrl, frameId });
    await notifyTab(tab.id, frameId, result.message, result.status);
  } catch (error) {
    await recordFailure(error, { name: tab.title });
    await notifyTab(tab.id, frameId, error.message, 'error');
  }
});
