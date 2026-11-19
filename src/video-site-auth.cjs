'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { youtubePageUrl } = require('./youtube-download.cjs');

const RESPONSE_LIMIT = 16 * 1024;
const BROWSER_SESSION_LIMIT = 512 * 1024;
const BUILD_VERSION = 'video-site-auth-v1';
const MESSAGES = {
  VIDEO_AUTH_REQUIRED: '请先连接 YouTube，再下载这个视频。',
  VIDEO_AUTH_EXPIRED: 'YouTube 连接已失效，请重新连接。',
  VIDEO_AUTH_CANCELLED: '已取消 YouTube 连接。',
  VIDEO_AUTH_BUSY: 'YouTube 连接正在处理，请先完成当前窗口。',
  VIDEO_AUTH_REJECTED: 'Google 拒绝了此次登录，请保持账号安全设置并稍后重试。',
  VIDEO_AUTH_BROWSER_MISSING: '未找到用于连接 YouTube 的浏览器，请安装 Chrome 后重试。',
  VIDEO_AUTH_FAILED: '无法建立 YouTube 连接，请重试。',
  VIDEO_AUTH_UNAVAILABLE: 'YouTube 连接组件不可用，请安装完整版本的 Mosaic。',
  VIDEO_AUTH_STORAGE: '无法保存或读取 YouTube 连接，请检查 Mosaic 的数据目录。',
  VIDEO_BROWSER_SESSION_INVALID: '当前 Chrome 登录信息无效，请刷新 YouTube 页面后重试。',
  VIDEO_BROWSER_SESSION_EXPIRED: '当前 Chrome 登录信息已过期，请重新发起下载。',
  VIDEO_BROWSER_LOGIN_REQUIRED: '当前 Chrome 尚未登录 YouTube，请在该浏览器中登录后重试。'
};
function failure(code, message = MESSAGES[code] || MESSAGES.VIDEO_AUTH_FAILED) {
  return Object.assign(new Error(message), { code });
}
function cancelled() { return Object.assign(failure('VIDEO_AUTH_CANCELLED'), { name: 'AbortError' }); }
function checkSignal(signal) { if (signal?.aborted) throw cancelled(); }
function checkedSite(site) { if (site !== 'youtube') throw failure('VIDEO_AUTH_UNAVAILABLE', '暂不支持连接这个视频网站。'); return site; }
function checkedBrowserSite(site) {
  if (!['youtube', 'bilibili'].includes(site)) throw failure('VIDEO_BROWSER_SESSION_INVALID', '当前浏览器登录暂不支持这个视频网站。');
  return site;
}
function browserFailure(code, site) {
  if (site !== 'bilibili') return failure(code);
  const messages = {
    VIDEO_BROWSER_SESSION_INVALID: '当前 Chrome 的 Bilibili 登录信息无效，请刷新原视频页面后重试。',
    VIDEO_BROWSER_SESSION_EXPIRED: '当前 Chrome 的 Bilibili 登录信息已过期，请重新发起下载。',
    VIDEO_BROWSER_LOGIN_REQUIRED: '当前 Chrome 尚未登录 Bilibili，请在原来的 Bilibili 标签页登录后重试。',
    VIDEO_AUTH_STORAGE: '无法安全读取 Bilibili 临时登录信息，请检查 Mosaic 的数据目录。'
  };
  return failure(code, messages[code] || '无法读取当前 Chrome 的 Bilibili 登录信息，请重试。');
}
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw failure('VIDEO_AUTH_STORAGE', `${label}无效。`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw failure('VIDEO_AUTH_STORAGE', `${label}无效。`);
  return resolved;
}
function nativeError(code) {
  const mapped = { AUTH_REQUIRED: 'VIDEO_AUTH_REQUIRED', AUTH_EXPIRED: 'VIDEO_AUTH_EXPIRED', AUTH_CANCELLED: 'VIDEO_AUTH_CANCELLED',
    AUTH_BUSY: 'VIDEO_AUTH_BUSY', AUTH_STORAGE: 'VIDEO_AUTH_STORAGE', AUTH_UNAVAILABLE: 'VIDEO_AUTH_UNAVAILABLE',
    AUTH_REJECTED: 'VIDEO_AUTH_REJECTED', AUTH_BROWSER_MISSING: 'VIDEO_AUTH_BROWSER_MISSING',
    AUTH_BROWSER_SESSION_INVALID: 'VIDEO_BROWSER_SESSION_INVALID', AUTH_BROWSER_SESSION_EXPIRED: 'VIDEO_BROWSER_SESSION_EXPIRED',
    AUTH_BROWSER_LOGIN_REQUIRED: 'VIDEO_BROWSER_LOGIN_REQUIRED' }[code] || 'VIDEO_AUTH_FAILED';
  return mapped === 'VIDEO_AUTH_CANCELLED' ? cancelled() : failure(mapped);
}

function createVideoSiteAuth({ directory, onState = () => {}, spawnProcess = spawn,
  nativeSourceDir = path.join(__dirname, 'video-auth-native'), compilerPath } = {}) {
  directory = absolute(directory, '视频连接目录');
  nativeSourceDir = absolute(nativeSourceDir, '视频连接组件目录');
  const lifetime = new AbortController(), running = new Set(), connections = new Map(), errors = new Map(), invalidSessions = new Set();
  let buildPromise, closed = false;
  const sessionFile = site => path.join(directory, `${site}-session.dpapi`);
  const notify = async site => {
    const value = await state(site);
    try { onState(value); } catch {}
    return value;
  };
  async function state(site) {
    checkedSite(site);
    let connected = false;
    try {
      const stat = await fs.lstat(sessionFile(site));
      connected = stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 2 * 1024 * 1024;
    } catch (error) { if (error.code !== 'ENOENT') throw failure('VIDEO_AUTH_STORAGE'); }
    return { site, connected: connected && !invalidSessions.has(site), connecting: connections.has(site),
      ...(errors.has(site) ? { errorCode: errors.get(site) } : {}) };
  }
  function available() { if (closed) throw cancelled(); }

  async function run(executable, args, { signal, connect = false, compiler = false, input } = {}) {
    checkSignal(signal);
    return new Promise((resolve, reject) => {
      let child, output = '', bytes = 0, finished = false, stopTimer, timedOut = false;
      const cleanup = () => { clearTimeout(stopTimer); clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
      const finish = error => {
        if (finished) return;
        finished = true; cleanup();
        if (error) { reject(error); return; }
        if (compiler) { resolve(null); return; }
        let value;
        try { value = JSON.parse(output.trim().replace(/^\uFEFF/, '')); } catch { reject(failure('VIDEO_AUTH_FAILED')); return; }
        if (!value || value.ok !== true) { reject(nativeError(value?.code)); return; }
        resolve(value);
      };
      const abort = () => {
        if (!child || finished) return;
        if (connect) {
          try { child.stdin?.write('cancel\n'); } catch {}
          stopTimer ||= setTimeout(() => { try { child.kill(); } catch {} }, 20000);
          stopTimer.unref?.();
        } else { try { child.kill(); } catch {} }
      };
      const timeout = setTimeout(() => { timedOut = true; abort(); }, compiler ? 60000 : connect ? 16 * 60000 : 30000);
      timeout.unref?.();
      try {
        child = spawnProcess(executable, args, { cwd: directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        // The helper never writes cookie contents. Compiler/native diagnostics
        // are deliberately discarded instead of becoming a public error log.
        child.stderr?.resume();
        child.stdout?.on('data', chunk => {
          if (compiler) return;
          bytes += chunk.length;
          if (bytes > RESPONSE_LIMIT) { try { child.kill(); } catch {} finish(failure('VIDEO_AUTH_FAILED')); return; }
          output += chunk.toString('utf8');
        });
        child.once('error', () => finish(failure('VIDEO_AUTH_UNAVAILABLE')));
        child.once('close', code => {
          if (signal?.aborted) return finish(cancelled());
          if (timedOut) return finish(failure('VIDEO_AUTH_FAILED'));
          if (compiler && code !== 0) return finish(failure('VIDEO_AUTH_UNAVAILABLE'));
          // Native failures return their fixed code as JSON with nonzero exit.
          if (code !== 0 && !output.trim()) return finish(failure('VIDEO_AUTH_FAILED'));
          finish();
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else if (input !== undefined) {
          child.stdin?.once('error', () => { try { child.kill(); } catch {} finish(failure('VIDEO_AUTH_FAILED')); });
          child.stdin?.end(input);
        }
      } catch { finish(failure('VIDEO_AUTH_UNAVAILABLE')); }
    });
  }

  async function compile() {
    available(); checkSignal(lifetime.signal);
    if (buildPromise) return buildPromise;
    buildPromise = (async () => {
      if (process.platform !== 'win32') throw failure('VIDEO_AUTH_UNAVAILABLE');
      await fs.mkdir(directory, { recursive: true });
      const names = (await fs.readdir(nativeSourceDir)).filter(name => /^[A-Za-z0-9_.-]+\.cs$/i.test(name)).sort();
      if (!names.length) throw failure('VIDEO_AUTH_UNAVAILABLE');
      const sources = await Promise.all(names.map(name => fs.readFile(path.join(nativeSourceDir, name))));
      const hash = crypto.createHash('sha256').update(BUILD_VERSION);
      names.forEach((name, index) => { hash.update(name); hash.update(sources[index]); });
      const buildDirectory = path.join(directory, 'native-cache', hash.digest('hex').slice(0, 24));
      const executable = path.join(buildDirectory, 'MosaicVideoAuth.exe');
      try { const stat = await fs.lstat(executable); if (stat.isFile() && !stat.isSymbolicLink() && stat.size) return executable; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const frameworkRoot = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET');
      let compiler = compilerPath;
      if (compiler) compiler = absolute(compiler, '视频连接编译器');
      else for (const candidate of ['Framework64', 'Framework'].map(name => path.join(frameworkRoot, name, 'v4.0.30319', 'csc.exe'))) {
        try { await fs.access(candidate); compiler = candidate; break; } catch {}
      }
      if (!compiler) throw failure('VIDEO_AUTH_UNAVAILABLE');
      const framework = path.dirname(compiler);
      const references = ['System.dll', 'System.Core.dll', 'System.Security.dll', 'System.Net.Http.dll', 'System.Web.Extensions.dll',
        'WPF/WindowsBase.dll', 'System.Xaml.dll', 'WPF/PresentationCore.dll', 'WPF/PresentationFramework.dll'];
      await fs.mkdir(buildDirectory, { recursive: true });
      const temporary = path.join(buildDirectory, `MosaicVideoAuth-${crypto.randomUUID()}.exe`);
      try {
        await run(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${temporary}`,
          ...references.map(name => `/reference:${path.join(framework, name)}`), ...names.map(name => path.join(nativeSourceDir, name))],
        { signal: lifetime.signal, compiler: true });
        const stat = await fs.lstat(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw failure('VIDEO_AUTH_UNAVAILABLE');
        try { await fs.rename(temporary, executable); }
        catch (error) { if (!['EEXIST', 'EPERM'].includes(error.code)) throw error; await fs.access(executable); }
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return executable;
    })().catch(error => { buildPromise = undefined; throw error.code?.startsWith('VIDEO_AUTH_') ? error : failure('VIDEO_AUTH_UNAVAILABLE'); });
    return buildPromise;
  }

  function operation(site, signal, work) {
    available(); checkedBrowserSite(site); checkSignal(signal);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, lifetime.signal, controller.signal]) : AbortSignal.any([lifetime.signal, controller.signal]);
    const record = { site, controller, promise: null };
    const promise = Promise.resolve().then(() => work(combined));
    record.promise = promise; running.add(record);
    return promise.finally(() => running.delete(record));
  }
  async function helper(site, mode, extra, signal, input) {
    const executable = await compile(); checkSignal(signal);
    return run(executable, [`--${mode}`, '--site', site, '--state-dir', directory, ...extra], { signal, connect: mode === 'connect', input });
  }

  async function removeExport(cookieFile, exportDirectory) {
    let cleaned = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { await fs.rm(cookieFile, { force: true }); cleaned = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1))); }
    }
    if (!cleaned) throw failure('VIDEO_AUTH_STORAGE');
    await fs.rmdir(exportDirectory).catch(() => {});
  }

  function withBrowserSession(session, callback, { signal, site = 'youtube' } = {}) {
    if (typeof callback !== 'function') throw new TypeError('A video session callback is required');
    checkedBrowserSite(site);
    return operation(site, signal, async effective => {
      let input;
      try {
        if (!session || typeof session !== 'object' || Array.isArray(session) ||
            Object.keys(session).length !== 2 || !Object.hasOwn(session, 'capturedAt') || !Object.hasOwn(session, 'cookies') ||
            !Number.isSafeInteger(session.capturedAt) || !Array.isArray(session.cookies) || session.cookies.length > 512) {
          throw browserFailure('VIDEO_BROWSER_SESSION_INVALID', site);
        }
        input = JSON.stringify(session);
        if (Buffer.byteLength(input, 'utf8') > BROWSER_SESSION_LIMIT) throw browserFailure('VIDEO_BROWSER_SESSION_INVALID', site);
      } catch { throw browserFailure('VIDEO_BROWSER_SESSION_INVALID', site); }
      const age = Date.now() - session.capturedAt;
      if (age > 120000 || age < -30000) throw browserFailure('VIDEO_BROWSER_SESSION_EXPIRED', site);
      const exportDirectory = path.join(directory, 'exports', crypto.randomUUID().replace(/-/g, ''));
      const cookieFile = path.join(exportDirectory, 'cookies.txt');
      let callbackStarted = false;
      try {
        // This command consumes only this fresh browser payload. It neither
        // reads the saved account nor launches a separate login window.
        await helper(site, 'export-browser-session', ['--output', cookieFile], effective, input);
        checkSignal(effective);
        const stat = await fs.lstat(cookieFile);
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > BROWSER_SESSION_LIMIT) throw failure('VIDEO_AUTH_STORAGE');
        callbackStarted = true;
        return await callback(cookieFile, { signal: effective });
      } catch (error) {
        if (!callbackStarted && !error.code?.startsWith('VIDEO_')) throw browserFailure('VIDEO_AUTH_STORAGE', site);
        if (!callbackStarted && (error.code?.startsWith('VIDEO_BROWSER_') || error.code === 'VIDEO_AUTH_STORAGE')) throw browserFailure(error.code, site);
        throw error;
      } finally { await removeExport(cookieFile, exportDirectory); }
    });
  }

  function connect(site, { url, signal } = {}) {
    available(); checkedSite(site); checkSignal(signal);
    const target = url === undefined ? [] : ['--url', youtubePageUrl(url)];
    if (connections.has(site)) return connections.get(site);
    const work = operation(site, signal, async effective => {
      errors.delete(site); await notify(site);
      try { await helper(site, 'connect', target, effective); errors.delete(site); invalidSessions.delete(site); }
      catch (error) { errors.set(site, error.code || 'VIDEO_AUTH_FAILED'); throw error; }
    });
    const promise = work.finally(async () => { if (connections.get(site) === promise) connections.delete(site); await notify(site); }).then(() => state(site));
    connections.set(site, promise);
    return promise;
  }

  function withSession(site, callback, { signal } = {}) {
    if (typeof callback !== 'function') throw new TypeError('A video session callback is required');
    checkedSite(site);
    return operation(site, signal, async effective => {
      if (!(await state(site)).connected) throw failure('VIDEO_AUTH_REQUIRED');
      const exportDirectory = path.join(directory, 'exports', crypto.randomUUID().replace(/-/g, ''));
      const cookieFile = path.join(exportDirectory, 'cookies.txt');
      let callbackStarted = false;
      try {
        await helper(site, 'export', ['--output', cookieFile], effective);
        checkSignal(effective);
        const stat = await fs.lstat(cookieFile);
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 2 * 1024 * 1024) throw failure('VIDEO_AUTH_STORAGE');
        callbackStarted = true;
        return await callback(cookieFile, { signal: effective });
      } catch (error) {
        if (!callbackStarted && !error.code?.startsWith('VIDEO_AUTH_')) error = failure('VIDEO_AUTH_STORAGE');
        if (['VIDEO_AUTH_REQUIRED', 'VIDEO_AUTH_EXPIRED'].includes(error.code)) { errors.set(site, error.code); invalidSessions.add(site); await notify(site); }
        throw error;
      } finally {
        // Only two fixed generated paths are removed; never recursively delete
        // a caller-provided directory or a browser profile during a download.
        await removeExport(cookieFile, exportDirectory);
      }
    });
  }

  async function disconnect(site) {
    available(); checkedSite(site);
    const pending = [...running].filter(record => record.site === site);
    for (const record of pending) record.controller.abort(cancelled());
    await Promise.allSettled(pending.map(record => record.promise));
    await helper(site, 'disconnect', [], lifetime.signal);
    errors.delete(site); invalidSessions.delete(site);
    return notify(site);
  }
  async function shutdown() {
    if (closed) { await Promise.allSettled([...running].map(record => record.promise)); return; }
    closed = true; lifetime.abort(cancelled());
    await Promise.allSettled([...running].map(record => record.promise));
    if (buildPromise) await buildPromise.catch(() => {});
  }
  return { state, connect, withSession, withBrowserSession, disconnect, shutdown };
}

module.exports = { createVideoSiteAuth };
