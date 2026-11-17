'use strict';

const CONFIG_KEY = 'shituConnection';
const LAST_KEY = 'shituLastCapture';
const MAX_DATA_LENGTH = 28 * 1024 * 1024;
const MENU_ID = 'shitu-save-media';
const pending = new Set();
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
      if (error.name === 'AbortError') throw issue('请求超时，请回到素材库检查结果后再试。', 'TIMEOUT');
      throw issue('尚未找到本机拾图，请先打开桌面软件。', 'CONNECTION_FAILED');
    }
    if (response.status === 401) throw issue('本机连接已更新，正在重新连接。', 'UNAUTHORIZED');
    let result;
    try { result = await response.json(); }
    catch (error) {
      if (error.name === 'AbortError') throw issue('采集超时，请回到素材库检查结果后再试。', 'TIMEOUT');
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

function checkedMedia(input) {
  if (!input || typeof input !== 'object' || !['image', 'video'].includes(input.kind)) throw new Error('不是可采集的图片或视频。');
  if (typeof input.url !== 'string' || input.url.length > 8192) throw new Error('素材地址过长或无效。');
  const url = input.url;
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('素材地址无效。'); }
  if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)) throw new Error('不支持这种素材地址。');
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
  if (['data:', 'blob:'].includes(parsed.protocol)) {
    if (typeof input.dataBase64 !== 'string' || !input.dataBase64 || input.dataBase64.length > MAX_DATA_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) throw new Error('临时素材读取失败或超过 20 MB。');
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
  const body = checkedMedia(input);
  if (sender?.tab?.url && /^https?:/i.test(sender.tab.url)) body.pageUrl = sender.tab.url;
  const key = `${sender?.tab?.id}:${body.url}`;
  if (pending.has(key)) throw new Error('这份素材正在采集中，请稍候。');
  pending.add(key);
  try {
    let connection = await ensureConnection();
    if (!connection.status.ready) throw issue('请先在桌面拾图中选择或新建素材库。', 'LIBRARY_NOT_READY');
    let result;
    try { result = await localRequest('/v1/capture', body, connection.config); }
    catch (error) {
      if (!['UNAUTHORIZED', 'CONNECTION_FAILED'].includes(error.code)) throw error;
      connection = await ensureConnection(true);
      if (!connection.status.ready) throw issue('请先在桌面拾图中选择或新建素材库。', 'LIBRARY_NOT_READY');
      result = await localRequest('/v1/capture', body, connection.config);
    }
    await chrome.storage.local.set({ [LAST_KEY]: { ok: true, at: Date.now(), name: body.name || body.title || '网页素材', imported: result.imported || 0, duplicates: result.duplicates || 0 } });
    return result;
  } catch (error) {
    await chrome.storage.local.set({ [LAST_KEY]: { ok: false, at: Date.now(), error: error.message } });
    throw error;
  } finally { pending.delete(key); }
}

async function handleMessage(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('请求来源无效。');
  if (message?.type === 'shitu:capture') {
    if (!sender.tab || !/^https?:/i.test(sender.url || '')) throw new Error('请在普通网页中采集素材。');
    return capture(message.media, sender);
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('请求来源无效。');
  if (message?.type === 'shitu:extension-info') return { ok: true, protocol: 1, version: chrome.runtime.getManifest().version };
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
  await notifyTab(tab.id, frameId, '正在采集到拾图…');
  try {
    let media = { url: info.srcUrl, kind: info.mediaType === 'video' ? 'video' : 'image', pageUrl: info.pageUrl, title: tab.title };
    if (/^(blob|data):/i.test(info.srcUrl || '')) {
      const resolved = await chrome.tabs.sendMessage(tab.id, { type: 'shitu:resolve-media', media }, { frameId });
      if (!resolved?.ok) throw new Error(resolved?.error || '无法读取临时图片。');
      media = resolved.media;
    }
    const result = await capture(media, { tab });
    await notifyTab(tab.id, frameId, result.imported ? '已保存到拾图' : '素材库中已有这份文件', 'success');
  } catch (error) { await notifyTab(tab.id, frameId, error.message, 'error'); }
});
