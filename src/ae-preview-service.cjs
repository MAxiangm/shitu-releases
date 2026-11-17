'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROJECT } = require('./media-formats.cjs');
const { validateProjectBundle, validateCompositions } = require('./project-bundle.cjs');
const { mediaResponse } = require('./media-response.cjs');

function cancelled() { return Object.assign(new Error('AE 预览已取消'), { name: 'AbortError' }); }
function message(error) {
  return String(typeof error === 'string' ? error : error?.message || 'AE 预览生成失败').replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*/g, '（本地文件）').slice(0, 1200);
}
async function fileHash(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function createAEPreviewService({ engine, getLibrary, onChanged, onProgress } = {}) {
  if (!engine || typeof engine.preview !== 'function' || typeof getLibrary !== 'function') throw new Error('AE 预览服务配置无效');
  const sessions = new Map(), pending = new Map(), ready = new Map();
  let states = new WeakMap();
  let epoch = 0, closed = false, shutdownTask;
  function assetOf(library, id) { return library?.snapshot().assets.find(asset => asset.id === id); }
  function ownerValid(owner) {
    if (closed || owner.epoch !== epoch || getLibrary() !== owner.library) return false;
    const asset = assetOf(owner.library, owner.id);
    return Boolean(asset && !asset.trashedAt && PROJECT.has(asset.ext) && asset.hash === owner.hash && owner.library.root === owner.root);
  }
  function notify(owner, update) {
    if (!ownerValid(owner)) return;
    let entries = states.get(owner.library);
    if (!entries) { entries = new Map(); states.set(owner.library, entries); }
    const value = { id: owner.id, root: owner.root, ...update };
    entries.set(owner.id, value);
    try { onProgress?.(owner.library, structuredClone(value)); } catch {}
  }
  function identify(library, id, { expectedRoot = library?.root, compositionId } = {}) {
    if (closed) throw cancelled();
    if (!library || getLibrary() !== library || library.root !== expectedRoot) throw new Error('素材库已切换，请重新选择 AE 工程');
    const asset = assetOf(library, id);
    if (!asset || asset.trashedAt || !PROJECT.has(asset.ext)) throw new Error('请选择有效的 AE 工程素材');
    if (compositionId !== undefined && (!Number.isSafeInteger(compositionId) || compositionId < 1)) throw new Error('AE 合成编号无效');
    validateProjectBundle(asset.projectBundle);
    return { library, id, root: library.root, hash: asset.hash, epoch, compositionId, asset,
      key: `${library.root}\0${id}\0${asset.hash}\0${compositionId ?? 'default'}` };
  }
  async function regularFile(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('AE 预览文件路径无效');
    const resolved = path.resolve(filename), info = await fs.lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink() || await fs.realpath(resolved) !== resolved) throw new Error('AE 预览文件不能包含符号链接');
    return resolved;
  }
  async function sourceOf(owner) {
    const directory = owner.library.getProjectBundleDirectory(owner.id), source = owner.library.getAssetPath(owner.id);
    if (!directory || await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw new Error('AE 工程目录不能包含符号链接');
    for (const file of owner.asset.projectBundle.files) {
      owner.controller.signal.throwIfAborted();
      const filename = await regularFile(path.join(directory, file.path));
      if ((await fs.lstat(filename)).size !== file.size) throw new Error('AE 工程文件已变化，请重新收录');
    }
    if (source !== path.join(directory, owner.asset.projectBundle.entry)) throw new Error('AE 工程入口无效');
    return source;
  }
  function issue(owner, output, info) {
    if (!ownerValid(owner)) throw cancelled();
    const token = crypto.randomUUID();
    sessions.set(token, { owner, files: new Map([['thumbnail.jpg', output.thumbnailPath]]) });
    return { ...info, status: 'ready', thumbnailUrl: `shitu://project-preview/${token}/thumbnail.jpg` };
  }
  function taskFor(owner) {
    const existing = pending.get(owner.key);
    if (existing && existing.library === owner.library && existing.epoch === epoch) return existing.task;
    owner.controller = new AbortController();
    notify(owner, { status: 'queued', progress: 0, compositionId: owner.compositionId ?? null });
    owner.task = (async () => {
      notify(owner, { status: 'preparing', progress: 0, compositionId: owner.compositionId ?? null });
      const source = await sourceOf(owner);
      if (!ownerValid(owner)) throw cancelled();
      const output = await engine.preview({ source, assetHash: owner.hash, compositionId: owner.compositionId,
        compositions: owner.asset.projectBundle.compositions, signal: owner.controller.signal });
      if (!ownerValid(owner)) throw cancelled();
      output.thumbnailPath = await regularFile(output.thumbnailPath);
      const thumbnailHash = await fileHash(output.thumbnailPath);
      const composition = output.composition;
      validateCompositions([composition]);
      const compositions = output.compositions || owner.asset.projectBundle.compositions || [composition];
      validateCompositions(compositions);
      const metadata = output.metadata || output;
      const info = { composition: structuredClone(composition), compositions: structuredClone(compositions),
        width: composition.width, height: composition.height,
        duration: composition.duration,
        frameRate: metadata.frameRate ?? composition.frameRate, warnings: Array.isArray(output.warnings) ? output.warnings.map(message) : [] };
      if (![info.width, info.height, info.duration, info.frameRate].every(value => Number.isFinite(value) && value > 0)) throw new Error('AE 预览元数据无效');
      if (owner.compositionId === undefined) {
        const snapshot = await owner.library.publishProjectPreview(owner.id, { expectedRoot: owner.root, expectedHash: owner.hash,
          thumbnailPath: output.thumbnailPath, signal: owner.controller.signal,
          preview: { version: 1, sourceHash: owner.hash, ...info, generatedAt: new Date().toISOString() } });
        if (!snapshot || !ownerValid(owner)) throw cancelled();
        try { onChanged?.(owner.library, snapshot); } catch {}
      }
      const result = issue(owner, output, info);
      ready.set(owner.key, { ...owner, result, output, thumbnailHash });
      notify(owner, { ...result, progress: 1, compositionId: composition.id });
      return structuredClone(result);
    })().catch(error => {
      if (ownerValid(owner)) notify(owner, { status: error.name === 'AbortError' ? 'cancelled' : 'error', error: message(error), compositionId: owner.compositionId ?? null });
      if (error.name === 'AbortError') throw cancelled();
      throw new Error(message(error));
    }).finally(() => { if (pending.get(owner.key) === owner) pending.delete(owner.key); });
    pending.set(owner.key, owner);
    return owner.task;
  }
  async function prepare(library, id, options) {
    const owner = identify(library, id, options), cached = ready.get(owner.key);
    if (cached && cached.library === owner.library && ownerValid(cached)) {
      try {
        await regularFile(cached.output.thumbnailPath);
        if (await fileHash(cached.output.thumbnailPath) !== cached.thumbnailHash) throw new Error('AE 预览缓存已变化');
        if (!ownerValid(cached)) throw cancelled();
        return structuredClone(cached.result);
      } catch {
        ready.delete(owner.key);
        for (const [token, session] of sessions) if (session.owner.library === library && session.owner.key === owner.key) sessions.delete(token);
      }
    }
    if (!ownerValid(owner)) throw cancelled();
    return taskFor(owner);
  }
  function schedule(library, id) {
    const status = states.get(library)?.get(id)?.status;
    // Background imports must not repeatedly launch AE for a failed project.
    // Explicit prepare requests and a new library session can retry it.
    if (status === 'error' || status === 'cancelled') return;
    prepare(library, id).catch(() => {});
  }
  function scheduleLibrary(library) {
    if (closed || !library || getLibrary() !== library) return;
    for (const asset of library.snapshot().assets) if (PROJECT.has(asset.ext) && !asset.trashedAt) schedule(library, asset.id);
  }
  function state(library, id) {
    if (closed || !library || getLibrary() !== library) return null;
    const asset = assetOf(library, id);
    if (!asset || asset.trashedAt || !PROJECT.has(asset.ext)) return null;
    const value = states.get(library)?.get(id);
    return structuredClone({ id, status: 'idle', compositions: asset.projectBundle.compositions || [], ...value });
  }
  function progress(detail) {
    const candidateId = detail.compositionId == null ? undefined : Number(detail.compositionId);
    const detailId = Number.isSafeInteger(candidateId) && candidateId > 0 ? candidateId : undefined;
    for (const owner of pending.values()) {
      if (detail.assetHash !== owner.hash || (owner.compositionId !== undefined && detailId !== undefined && owner.compositionId !== detailId)) continue;
      const status = ['queued', 'preparing', 'rendering', 'encoding'].includes(detail.state) ? detail.state : null;
      if (status) notify(owner, { status, compositionId: detailId ?? owner.compositionId ?? null,
        progress: Number.isFinite(detail.progress) ? Math.max(0, Math.min(1, detail.progress)) : null });
    }
  }
  async function response(request) {
    try {
      const url = new URL(request.url);
      if (closed || request.method !== 'GET' || url.protocol !== 'shitu:' || url.hostname !== 'project-preview' || url.username || url.password || url.port || url.search || url.hash) return new Response(null, { status: 404 });
      const parts = url.pathname.slice(1).split('/'), session = sessions.get(parts[0]);
      if (parts.length !== 2 || !session || !ownerValid(session.owner) || !session.files.has(parts[1])) return new Response(null, { status: 404 });
      const filename = await regularFile(session.files.get(parts[1]));
      if (!ownerValid(session.owner)) return new Response(null, { status: 404 });
      const result = await mediaResponse(filename, request);
      if (!ownerValid(session.owner)) { await result.body?.cancel(); return new Response(null, { status: 404 }); }
      result.headers.set('Access-Control-Allow-Origin', '*');
      return result;
    } catch { return new Response(null, { status: 404 }); }
  }
  function invalidate() {
    epoch++; sessions.clear(); ready.clear(); states = new WeakMap();
    for (const owner of pending.values()) owner.controller.abort();
    pending.clear();
  }
  function shutdown() {
    if (shutdownTask) return shutdownTask;
    closed = true;
    const tasks = [...pending.values()].map(owner => owner.task);
    invalidate();
    shutdownTask = (async () => { await engine.shutdown?.(); await Promise.allSettled(tasks); })();
    return shutdownTask;
  }
  return { prepare, schedule, scheduleLibrary, state, progress, response, invalidate, shutdown };
}
module.exports = { createAEPreviewService };
