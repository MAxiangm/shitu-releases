'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;

function publicError(message) {
  return Object.assign(new Error(message), { publicMessage: message });
}
function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function newerThan(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
function trustedURL(value) {
  let url;
  try { url = new URL(value); } catch { throw publicError('更新下载地址无效'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !(['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(host))) {
    throw publicError('更新下载地址不属于受信任的 GitHub 服务');
  }
  return url;
}
function assetURL(asset, repository, tag) {
  if (!asset || typeof asset.name !== 'string') throw publicError('更新附件信息不完整');
  const url = trustedURL(asset.browser_download_url);
  const expected = `/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
  if (url.hostname !== 'github.com' || url.pathname !== expected || url.search) {
    throw publicError('更新附件不属于当前仓库和版本');
  }
  return url.href;
}
async function hashFile(filename, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function createAppUpdater({ currentVersion, repository, cacheDir, enabled = true,
  fetchImpl = globalThis.fetch, onEvent = () => {}, install: installCallback = async () => {} } = {}) {
  const configured = Boolean(enabled && typeof repository === 'string' && REPOSITORY.test(repository) &&
    !['.', '..'].includes(repository.split('/')[1]) && versionParts(currentVersion));
  if (configured && (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir))) {
    throw new TypeError('Update cacheDir must be an absolute path');
  }
  const base = {
    status: configured ? 'idle' : 'disabled', currentVersion: currentVersion || '', latestVersion: null,
    releaseNotes: '', releaseUrl: null, progress: 0, downloadedBytes: 0, totalBytes: 0,
    error: null, message: configured ? '尚未检查更新' : enabled ? '尚未配置 GitHub 更新仓库' : '当前运行方式不启用自动更新'
  };
  let snapshot = { ...base }, release = null, verified = null, running = null, disposed = false;
  const state = () => ({ ...snapshot });
  function emit(patch) {
    snapshot = { ...snapshot, ...patch };
    try { onEvent(state()); } catch { /* A UI listener must not interrupt file validation. */ }
    return state();
  }
  function ensureEnabled() {
    if (!configured || disposed) throw publicError(disposed ? '更新器已关闭' : snapshot.message);
  }
  function task(kind, run) {
    if (running) {
      if (running.kind === kind) return running.promise;
      return Promise.reject(publicError('更新操作正在进行，请稍候'));
    }
    const controller = new AbortController();
    const holder = { kind, controller, promise: null };
    running = holder;
    holder.promise = Promise.resolve().then(() => run(controller.signal)).finally(() => {
      if (running === holder) running = null;
    });
    return holder.promise;
  }
  function failure(error, fallback) {
    if (error?.publicMessage) return error;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return publicError('更新操作已取消或超时，请重试');
    return publicError(fallback);
  }
  async function request(urlValue, signal, { accept = 'application/json', timeoutMs = 30000, fresh = false } = {}) {
    let url = trustedURL(urlValue);
    // Metadata is mutable even when a proxy still considers its URL cacheable.
    // Add our nonce only after validating the advertised release asset URL.
    if (fresh) url.searchParams.set('_shitu_check', crypto.randomUUID());
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    for (let count = 0; count <= 5; count++) {
      combined.throwIfAborted();
      const response = await fetchImpl(url.href, { signal: combined, redirect: 'manual',
        ...(fresh ? { cache: 'no-store' } : {}),
        headers: { Accept: accept, 'User-Agent': `Shitu/${currentVersion}`,
          ...(fresh ? { 'Cache-Control': 'no-cache, no-store, max-age=0', Pragma: 'no-cache' } : {}) } });
      if (response.url) trustedURL(response.url);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        try { await response.body?.cancel(); } catch {}
        if (!location || count === 5) throw publicError('GitHub 下载重定向次数过多或地址缺失');
        url = trustedURL(new URL(location, url).href);
        continue;
      }
      return response;
    }
    throw publicError('GitHub 下载重定向次数过多');
  }
  async function json(response, limit) {
    if (!response.ok || !response.body) throw publicError(`GitHub 更新服务暂时不可用（HTTP ${response.status}）`);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw publicError('更新信息超过允许大小');
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw publicError('GitHub 更新信息格式无效'); }
  }
  async function readRelease(signal) {
    const response = await request(`https://api.github.com/repos/${repository}/releases/latest`, signal, { fresh: true });
    if (response.status === 404) return null;
    const info = await json(response, 1024 * 1024);
    if (info.draft || info.prerelease) return null;
    const tag = info.tag_name;
    const version = typeof tag === 'string' ? tag.replace(/^v/, '') : '';
    if (!versionParts(version) || !newerThan(version, currentVersion)) return null;
    if (!Array.isArray(info.assets)) throw publicError('新版本缺少更新附件');
    const manifests = info.assets.filter(asset => asset.name === 'shitu-update.json');
    if (manifests.length !== 1) throw publicError('新版本缺少唯一的 shitu-update.json 更新清单');
    const manifestAsset = manifests[0];
    if (!Number.isSafeInteger(manifestAsset.size) || manifestAsset.size <= 0 || manifestAsset.size > 64 * 1024) {
      throw publicError('更新清单大小无效');
    }
    const manifest = await json(await request(assetURL(manifestAsset, repository, tag), signal, { fresh: true }), 64 * 1024);
    const installer = manifest?.installer;
    if (manifest?.schemaVersion !== 1 || manifest.version !== version || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
        !installer || installer.name !== `shitu-${version}-setup.exe` ||
        !Number.isSafeInteger(installer.size) || installer.size <= 0 || installer.size > MAX_INSTALLER_BYTES ||
        typeof installer.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(installer.sha256)) {
      throw publicError('更新清单的版本、平台或校验信息无效');
    }
    const assets = info.assets.filter(asset => asset.name === installer.name);
    if (assets.length !== 1 || assets[0].size !== installer.size) throw publicError('安装包大小与更新清单不一致');
    const asset = assets[0];
    if (asset.digest != null && asset.digest !== `sha256:${installer.sha256.toLowerCase()}`) {
      throw publicError('GitHub 附件校验值与更新清单不一致');
    }
    return { version, tag, name: installer.name, size: installer.size, sha256: installer.sha256.toLowerCase(),
      downloadURL: assetURL(asset, repository, tag),
      releaseUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
      releaseNotes: typeof info.body === 'string' ? info.body.slice(0, 20000) : '' };
  }
  async function validFile(filePath, selected, signal) {
    const stat = await fs.lstat(filePath).catch(() => null);
    return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.size === selected.size &&
      await hashFile(filePath, signal) === selected.sha256);
  }
  function check() {
    if (!configured || disposed) return Promise.resolve(state());
    return task('check', async signal => {
      const previous = state();
      emit({ status: 'checking', error: null, message: '正在检查 GitHub 新版本…' });
      try {
        const selected = await readRelease(signal);
        signal.throwIfAborted();
        if (!selected) {
          release = null; verified = null;
          return emit({ ...base, status: 'idle', message: '当前已是最新正式版本' });
        }
        const sameDownload = verified && release?.sha256 === selected.sha256 && release?.version === selected.version;
        release = selected;
        if (!sameDownload) verified = null;
        return emit({ status: sameDownload ? 'downloaded' : 'available', latestVersion: selected.version,
          releaseNotes: selected.releaseNotes, releaseUrl: selected.releaseUrl,
          progress: sameDownload ? 100 : 0, downloadedBytes: sameDownload ? selected.size : 0,
          totalBytes: selected.size, error: null,
          message: sameDownload ? '更新已下载，重启即可安装' : `发现新版本 ${selected.version}` });
      } catch (error) {
        const safe = failure(error, '检查更新失败，请检查网络后重试');
        emit({ ...previous, status: ['available', 'downloaded'].includes(previous.status) ? previous.status : 'error',
          error: safe.message, message: safe.message });
        throw safe;
      }
    });
  }
  function download() {
    try { ensureEnabled(); } catch (error) { return Promise.reject(error); }
    return task('download', async signal => {
      if (!release) throw publicError('请先检查并获取新版本');
      const selected = release;
      let temporary;
      emit({ status: 'downloading', error: null, progress: 0, downloadedBytes: 0,
        totalBytes: selected.size, message: '正在下载更新…' });
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        const filePath = path.join(cacheDir, `${selected.version}-${selected.sha256}.exe`);
        if (!await validFile(filePath, selected, signal)) {
          const response = await request(selected.downloadURL, signal, { accept: 'application/octet-stream', timeoutMs: 30 * 60 * 1000 });
          if (!response.ok || !response.body) throw publicError(`安装包下载失败（HTTP ${response.status}）`);
          const contentLength = response.headers.get('content-length');
          if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) !== selected.size)) {
            try { await response.body.cancel(); } catch {}
            throw publicError('下载的安装包长度与更新清单不一致');
          }
          temporary = path.join(cacheDir, `.download-${crypto.randomUUID()}.tmp`);
          const handle = await fs.open(temporary, 'wx', 0o600);
          const digest = crypto.createHash('sha256');
          let bytes = 0, lastEvent = 0;
          try {
            for await (const chunk of response.body) {
              signal.throwIfAborted();
              const buffer = Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > selected.size) throw publicError('下载的安装包超过预期大小');
              digest.update(buffer);
              await handle.writeFile(buffer);
              if (Date.now() - lastEvent >= 100 || bytes === selected.size) {
                emit({ downloadedBytes: bytes, progress: Math.min(99, Math.floor(bytes / selected.size * 100)) });
                lastEvent = Date.now();
              }
            }
            if (bytes !== selected.size || digest.digest('hex') !== selected.sha256) {
              throw publicError('安装包完整性校验失败，请重新下载');
            }
            await handle.sync();
          } finally { await handle.close(); }
          signal.throwIfAborted();
          // This is a single known cache filename, never a recursive deletion.
          await fs.unlink(filePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await fs.rename(temporary, filePath);
          temporary = null;
        }
        verified = { filePath, version: selected.version };
        return emit({ status: 'downloaded', progress: 100, downloadedBytes: selected.size, error: null,
          message: '更新已下载，重启即可安装' });
      } catch (error) {
        verified = null;
        const safe = failure(error, '下载更新失败，请检查网络或磁盘空间后重试');
        emit({ status: 'available', progress: 0, downloadedBytes: 0, error: safe.message, message: safe.message });
        throw safe;
      } finally {
        if (temporary) await fs.unlink(temporary).catch(() => {});
      }
    });
  }
  function install() {
    try { ensureEnabled(); } catch (error) { return Promise.reject(error); }
    return task('install', async signal => {
      if (!release || !verified) throw publicError('请先下载更新');
      emit({ status: 'installing', error: null, message: '正在准备安装更新…' });
      let validated = false;
      try {
        if (!await validFile(verified.filePath, release, signal)) throw publicError('已下载的更新文件已变化，请重新下载');
        validated = true;
        signal.throwIfAborted();
        await installCallback({ ...verified });
        return state();
      } catch (error) {
        const safe = failure(error, '启动更新安装程序失败，请重试');
        if (!validated) verified = null;
        emit({ status: verified ? 'downloaded' : 'available', error: safe.message, message: safe.message });
        throw safe;
      }
    });
  }
  function dispose() {
    disposed = true;
    running?.controller.abort();
  }
  return { state, check, download, install, dispose };
}

module.exports = { createAppUpdater, newerThan };
