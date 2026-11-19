'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateSketchfabArchiveUrl } = require('./sketchfab-download.cjs');

const API = 'https://api.sketchfab.com/v3';
const MODEL_ID = /^[a-f0-9]{32}$/;
const FILE_PREFIX = Buffer.from('MOSAIC_SKETCHFAB_V1\0');
const FILE_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 512 * 1024;
const MESSAGES = Object.freeze({
  SKETCHFAB_ACCOUNT_REQUIRED: '请在浏览器采集设置中连接 Sketchfab，再下载模型。',
  SKETCHFAB_TOKEN_INVALID: 'Sketchfab API Token 无效，请检查后重新连接。',
  SKETCHFAB_ACCOUNT_EXPIRED: 'Sketchfab 连接已失效，请在浏览器采集设置中重新连接。',
  SKETCHFAB_ACCOUNT_FORBIDDEN: 'Sketchfab 拒绝了此次请求，请检查账号是否有权下载该模型。',
  SKETCHFAB_STORAGE_UNAVAILABLE: '系统加密不可用，无法安全保存 Sketchfab 连接。',
  SKETCHFAB_STORAGE_FAILED: '无法安全读取或保存 Sketchfab 连接，请检查应用数据目录。',
  SKETCHFAB_MODEL_INVALID: 'Sketchfab 模型编号无效。',
  SKETCHFAB_BROWSER_SOURCE_INVALID: 'Sketchfab 官网下载地址与所选模型不符，请在当前 Chrome 页面重新采集。',
  SKETCHFAB_PUBLIC_MODEL_UNAVAILABLE: '此 Sketchfab 模型无法公开下载或当前不可访问，请在官网确认后重试。',
  SKETCHFAB_NOT_DOWNLOADABLE: '模型作者未开放官方下载，无法采集此模型。',
  SKETCHFAB_MODEL_NOT_FOUND: 'Sketchfab 模型不存在或当前账号无权访问。',
  SKETCHFAB_MODEL_METADATA: 'Sketchfab 模型的作者或许可证信息不完整，无法采集。',
  SKETCHFAB_ARCHIVE_UNAVAILABLE: 'Sketchfab 尚未提供可用的 glTF ZIP，请稍后重试。',
  SKETCHFAB_RATE_LIMITED: 'Sketchfab 请求过于频繁，请稍后重试。',
  SKETCHFAB_REQUEST_FAILED: '无法连接 Sketchfab 官方接口，请检查网络后重试。',
  SKETCHFAB_CANCELLED: '已取消 Sketchfab 操作。'
});

function issue(code) { return Object.assign(new Error(MESSAGES[code]), { code }); }
function cancelled() { return Object.assign(issue('SKETCHFAB_CANCELLED'), { name: 'AbortError' }); }
function tokenValue(value) {
  if (typeof value !== 'string') throw issue('SKETCHFAB_TOKEN_INVALID');
  const token = value.trim();
  if (!/^[A-Za-z0-9._~+/-]{8,1024}={0,2}$/.test(token)) throw issue('SKETCHFAB_TOKEN_INVALID');
  return token;
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value, limit = 240) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, limit) : '';
}
function publicUrl(value, hosts) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw issue('SKETCHFAB_MODEL_METADATA');
  let url;
  try { url = new URL(value); } catch { throw issue('SKETCHFAB_MODEL_METADATA'); }
  if (!['http:', 'https:'].includes(url.protocol) || !hosts.includes(url.hostname) || url.port ||
      url.username || url.password || url.search || url.hash) throw issue('SKETCHFAB_MODEL_METADATA');
  url.protocol = 'https:';
  return url.href;
}
function attributionFor(model, modelId) {
  if (!plain(model.user) || !plain(model.license)) throw issue('SKETCHFAB_MODEL_METADATA');
  const name = text(model.user.displayName || model.user.username);
  const licenseName = text(model.license.label || model.license.fullName || model.license.name);
  const slug = text(model.license.slug, 80);
  if (!name || (!licenseName && !slug)) throw issue('SKETCHFAB_MODEL_METADATA');
  let authorUrl = publicUrl(model.user.profileUrl, ['sketchfab.com', 'www.sketchfab.com']);
  if (!authorUrl && typeof model.user.username === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(model.user.username)) {
    authorUrl = `https://sketchfab.com/${model.user.username}`;
  }
  const licenseUrl = publicUrl(model.license.url, ['creativecommons.org', 'www.creativecommons.org', 'sketchfab.com', 'www.sketchfab.com']);
  return {
    title: text(model.name) || `Sketchfab ${modelId}`,
    author: { name, ...(authorUrl ? { url: authorUrl } : {}) },
    license: { ...(licenseName ? { name: licenseName } : {}), ...(slug ? { slug } : {}), ...(licenseUrl ? { url: licenseUrl } : {}) }
  };
}

function createSketchfabAccount({ filePath, safeStorage, request = globalThis.fetch } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0') ||
      path.resolve(filePath) === path.parse(path.resolve(filePath)).root) throw issue('SKETCHFAB_STORAGE_FAILED');
  if (typeof request !== 'function') throw issue('SKETCHFAB_REQUEST_FAILED');
  filePath = path.resolve(filePath);
  let revision = 0, closed = false, fileQueue = Promise.resolve();
  const activeRequests = new Set();

  function requireEncryption() {
    try {
      if (!safeStorage?.isEncryptionAvailable() || typeof safeStorage.encryptString !== 'function' ||
          typeof safeStorage.decryptString !== 'function') {
        throw issue('SKETCHFAB_STORAGE_UNAVAILABLE');
      }
      // This Linux-only backend can otherwise report availability without OS encryption.
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw issue('SKETCHFAB_STORAGE_UNAVAILABLE');
    } catch { throw issue('SKETCHFAB_STORAGE_UNAVAILABLE'); }
  }
  function assertCurrent(expected) { if (closed || revision !== expected) throw cancelled(); }
  function stopRequests() { for (const controller of activeRequests) controller.abort(); }
  function queueFile(operation) {
    const pending = fileQueue.then(operation, operation);
    fileQueue = pending.catch(() => {});
    return pending;
  }
  async function checkFile() {
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= FILE_PREFIX.length || stat.size > FILE_LIMIT) throw issue('SKETCHFAB_STORAGE_FAILED');
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw issue('SKETCHFAB_STORAGE_FAILED');
    }
  }
  async function readToken() {
    await fileQueue;
    if (!await checkFile()) return null;
    requireEncryption();
    try {
      const encrypted = await fs.readFile(filePath);
      if (encrypted.length > FILE_LIMIT || !encrypted.subarray(0, FILE_PREFIX.length).equals(FILE_PREFIX)) throw issue('SKETCHFAB_STORAGE_FAILED');
      return tokenValue(safeStorage.decryptString(encrypted.subarray(FILE_PREFIX.length)));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw issue('SKETCHFAB_STORAGE_FAILED');
    }
  }
  async function writeToken(token, expected) {
    return queueFile(async () => {
      assertCurrent(expected);
      requireEncryption();
      const temporary = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        const parent = path.dirname(filePath);
        await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        const parentStat = await fs.lstat(parent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw issue('SKETCHFAB_STORAGE_FAILED');
        await checkFile();
        const encrypted = safeStorage.encryptString(token);
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length + FILE_PREFIX.length > FILE_LIMIT) throw issue('SKETCHFAB_STORAGE_FAILED');
        await fs.writeFile(temporary, Buffer.concat([FILE_PREFIX, encrypted]), { flag: 'wx', mode: 0o600 });
        assertCurrent(expected);
        await fs.rename(temporary, filePath);
      } catch (error) {
        if (error.code === 'SKETCHFAB_CANCELLED') throw error;
        throw issue('SKETCHFAB_STORAGE_FAILED');
      } finally { await fs.unlink(temporary).catch(() => {}); }
    });
  }
  async function removeToken(expected) {
    return queueFile(async () => {
      if (revision !== expected) return;
      try { await fs.unlink(filePath); }
      catch (error) { if (error.code !== 'ENOENT') throw issue('SKETCHFAB_STORAGE_FAILED'); }
    });
  }
  async function state() {
    if (closed) return { connected: false };
    return { connected: Boolean(await readToken()) };
  }

  async function requestJson(endpoint, token, { signal, connecting = false, publicModel = false } = {}) {
    if (closed || signal?.aborted) throw cancelled();
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timedOut = false;
    signal?.addEventListener('abort', abort, { once: true });
    activeRequests.add(controller);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 25000);
    timer.unref?.();
    try {
      // Keep credentials on the exact official API origin; never follow redirects.
      // Official API token syntax: https://docs.sketchfab.com/data-api/v3/index.html
      const url = `${API}${endpoint}`;
      const headers = { ...(!publicModel ? { Authorization: `Token ${token}` } : {}), Accept: 'application/json' };
      const response = await request(url, { method: 'GET', headers,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (controller.signal.aborted) throw cancelled();
      if (response.redirected || (response.url && response.url !== url)) throw issue('SKETCHFAB_REQUEST_FAILED');
      if (response.status < 200 || response.status >= 300) {
        try { await response.body?.cancel(); } catch {}
        const code = publicModel && [401, 403].includes(response.status) ? 'SKETCHFAB_PUBLIC_MODEL_UNAVAILABLE' :
          response.status === 401 ? (connecting ? 'SKETCHFAB_TOKEN_INVALID' : 'SKETCHFAB_ACCOUNT_EXPIRED') :
          response.status === 403 ? 'SKETCHFAB_ACCOUNT_FORBIDDEN' : response.status === 404 ? 'SKETCHFAB_MODEL_NOT_FOUND' :
            response.status === 400 ? 'SKETCHFAB_NOT_DOWNLOADABLE' : response.status === 429 ? 'SKETCHFAB_RATE_LIMITED' : 'SKETCHFAB_REQUEST_FAILED';
        throw issue(code);
      }
      if (Number(response.headers?.get?.('content-length')) > RESPONSE_LIMIT) throw issue('SKETCHFAB_REQUEST_FAILED');
      let body;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > RESPONSE_LIMIT) throw issue('SKETCHFAB_REQUEST_FAILED');
            chunks.push(Buffer.from(part.value));
          }
          body = Buffer.concat(chunks, size).toString('utf8');
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } else {
        body = await response.text();
        if (Buffer.byteLength(body, 'utf8') > RESPONSE_LIMIT) throw issue('SKETCHFAB_REQUEST_FAILED');
      }
      if (controller.signal.aborted) throw cancelled();
      const result = JSON.parse(body);
      if (!plain(result)) throw issue('SKETCHFAB_REQUEST_FAILED');
      return result;
    } catch (error) {
      if (timedOut) throw issue('SKETCHFAB_REQUEST_FAILED');
      if (controller.signal.aborted || closed || signal?.aborted) throw cancelled();
      if (Object.hasOwn(MESSAGES, error?.code)) throw issue(error.code);
      // Fetch and JSON errors may include credentials, response bodies or signed URLs.
      throw issue('SKETCHFAB_REQUEST_FAILED');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      activeRequests.delete(controller);
    }
  }
  async function setToken(value) {
    if (closed) throw cancelled();
    requireEncryption();
    let token = tokenValue(value);
    const expected = ++revision;
    stopRequests();
    try {
      const profile = await requestJson('/me', token, { connecting: true });
      assertCurrent(expected);
      if (typeof profile.uid !== 'string' || !MODEL_ID.test(profile.uid)) throw issue('SKETCHFAB_TOKEN_INVALID');
      await writeToken(token, expected);
      assertCurrent(expected);
      return { connected: true };
    } finally { token = ''; }
  }
  async function disconnect() {
    const expected = ++revision;
    stopRequests();
    await removeToken(expected);
    return { connected: false };
  }
  async function resolveModel({ modelId, signal } = {}) {
    if (typeof modelId !== 'string' || !MODEL_ID.test(modelId)) throw issue('SKETCHFAB_MODEL_INVALID');
    if (closed || signal?.aborted) throw cancelled();
    const expected = revision;
    let token = await readToken();
    assertCurrent(expected);
    if (!token) throw issue('SKETCHFAB_ACCOUNT_REQUIRED');
    try {
      const model = await requestJson(`/models/${modelId}`, token, { signal });
      assertCurrent(expected);
      if (model.uid !== modelId) throw issue('SKETCHFAB_MODEL_INVALID');
      if (model.isDownloadable !== true) throw issue('SKETCHFAB_NOT_DOWNLOADABLE');
      const attribution = attributionFor(model, modelId);
      const archive = await requestJson(`/models/${modelId}/download`, token, { signal });
      assertCurrent(expected);
      if ((archive.uid !== undefined && archive.uid !== modelId) || !plain(archive.gltf) ||
          !Number.isFinite(archive.gltf.expires) || archive.gltf.expires <= 0) throw issue('SKETCHFAB_ARCHIVE_UNAVAILABLE');
      let archiveUrl;
      try { archiveUrl = validateSketchfabArchiveUrl(archive.gltf.url, modelId); }
      catch { throw issue('SKETCHFAB_ARCHIVE_UNAVAILABLE'); }
      return { archiveUrl, attribution };
    } catch (error) {
      if (error.code === 'SKETCHFAB_ACCOUNT_EXPIRED') await removeToken(expected);
      throw error;
    } finally { token = ''; }
  }
  async function resolveBrowserModel({ modelId, archiveUrl, signal } = {}) {
    if (typeof modelId !== 'string' || !MODEL_ID.test(modelId)) throw issue('SKETCHFAB_MODEL_INVALID');
    if (closed || signal?.aborted) throw cancelled();
    let validatedUrl;
    try { validatedUrl = validateSketchfabArchiveUrl(archiveUrl, modelId); }
    catch { throw issue('SKETCHFAB_BROWSER_SOURCE_INVALID'); }
    // The current Chrome page obtains the official temporary archive URL.
    // Verify public metadata here without reading saved tokens or sending credentials.
    const model = await requestJson(`/models/${modelId}`, undefined, { signal, publicModel: true });
    if (closed || signal?.aborted) throw cancelled();
    if (model.uid !== modelId) throw issue('SKETCHFAB_MODEL_INVALID');
    if (model.isDownloadable !== true) throw issue('SKETCHFAB_NOT_DOWNLOADABLE');
    return { archiveUrl: validatedUrl, attribution: attributionFor(model, modelId) };
  }
  async function shutdown() { closed = true; revision++; stopRequests(); await fileQueue; }
  return Object.freeze({ state, setToken, disconnect, resolveModel, resolveBrowserModel, shutdown });
}

module.exports = { createSketchfabAccount };
