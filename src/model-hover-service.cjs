'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { MODEL, MODEL_NATIVE } = require('./media-formats.cjs');

const CACHE_RECIPE = 'model-turntable-webp-v1';
const MAX_ENTRIES = 128;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_NAME = /^[a-f0-9]{64}\.webp$/;
const ROUTE = /^\/[a-f0-9]{64}$/;

function assertToken(token) {
  if (typeof token !== 'string' || token.length > 80 || !/^hover_[a-z0-9_]+$/.test(token))
    throw new TypeError('模型悬停预览请求标识无效');
}

function cancelled() { return new DOMException('模型悬停预览已取消', 'AbortError'); }

function animatedWebP(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 30 && bytes.length <= MAX_IMAGE_BYTES &&
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === bytes.length &&
    bytes.toString('ascii', 8, 16) === 'WEBPVP8X' && (bytes[20] & 2) !== 0;
}

function createModelHoverService({ cacheDir, getLibrary, render, runTask = (_library, _id, work) => work() }) {
  if (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir)) throw new Error('模型悬停缓存必须为绝对路径');
  const directory = path.resolve(cacheDir);
  const assetOf = (library, id) => library.snapshot().assets.find(asset => asset.id === id);
  let active = null;
  let warming = null;
  let tail = Promise.resolve();
  let closed = false;

  function current(record) {
    return !closed && (active === record || warming === record) && !record.controller.signal.aborted && getLibrary() === record.library &&
      record.library.root === record.root;
  }

  function assertCurrent(record, verifyAsset = false) {
    if (!current(record)) throw cancelled();
    if (verifyAsset) {
      const asset = assetOf(record.library, record.id);
      if (!asset || asset.trashedAt || asset.hash !== record.hash) throw cancelled();
    }
  }

  function abort(record) {
    if (!record) return false;
    if (active === record) active = null;
    if (warming === record) warming = null;
    record.bytes = null;
    record.controller.abort();
    return true;
  }

  function invalidate() {
    abort(active);
    abort(warming);
  }

  async function cacheDirectory() {
    if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory())
      throw new Error('模型悬停缓存路径无效');
  }

  async function readImage(filename) {
    try {
      await cacheDirectory();
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.size < 30 || info.size > MAX_IMAGE_BYTES || await fs.realpath(filename) !== filename) return null;
      const bytes = await fs.readFile(filename);
      return animatedWebP(bytes) ? bytes : null;
    } catch { return null; }
  }

  async function prune(keep) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    let totalBytes = 0;
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !CACHE_NAME.test(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      const info = await fs.lstat(filename).catch(() => null);
      if (!info?.isFile()) continue;
      files.push({ filename, size: info.size, time: info.mtimeMs });
      totalBytes += info.size;
    }
    files.sort((a, b) => a.time - b.time);
    let count = files.length;
    for (const file of files) {
      if (count <= MAX_ENTRIES && totalBytes <= MAX_CACHE_BYTES) break;
      if (file.filename === keep) continue;
      await fs.rm(file.filename, { force: true });
      count--;
      totalBytes -= file.size;
    }
  }

  async function storeImage(record, bytes) {
    if (!animatedWebP(bytes)) throw new Error('模型悬停图像不是有效的动画 WebP');
    await fs.mkdir(directory, { recursive: true });
    await cacheDirectory();
    const temporary = path.join(directory, `.${record.key}.${randomUUID()}.partial`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', signal: record.controller.signal });
      assertCurrent(record);
      await fs.rename(temporary, record.filename);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    await prune(record.filename).catch(() => {});
  }

  function eligibleAsset(library, id, expectedRoot, token) {
    assertToken(token);
    if (closed || !library || getLibrary() !== library || library.root !== expectedRoot) throw cancelled();
    const asset = assetOf(library, id);
    if (!asset || asset.trashedAt || !MODEL.has(asset.ext) || !asset.modelBundle || !/^[a-f0-9]{64}$/.test(asset.hash || ''))
      throw new Error('请选择有效的 3D 模型素材');
    const previewEntry = asset.modelBundle.previewEntry || '';
    if (MODEL_NATIVE.has(asset.ext)) {
      const previewFormat = path.posix.extname(previewEntry).slice(1).toLowerCase();
      if (!MODEL.has(previewFormat) || MODEL_NATIVE.has(previewFormat) || !asset.modelBundle.files?.some(file => file.path === previewEntry)) {
        return null;
      }
    }
    return asset;
  }

  function createRecord(library, asset, token) {
    const previewEntry = asset.modelBundle.previewEntry || '';
    const key = createHash('sha256').update(JSON.stringify([CACHE_RECIPE, asset.hash, previewEntry])).digest('hex');
    return { library, id: asset.id, root: library.root, hash: asset.hash, token, key,
      filename: path.join(directory, key + '.webp'), controller: new AbortController(), bytes: null, task: null };
  }

  function start(record, asset) {
    record.task = tail.then(async () => {
      assertCurrent(record);
      let bytes = await readImage(record.filename);
      if (bytes) {
        const now = new Date();
        await fs.utimes(record.filename, now, now).catch(() => {});
      } else {
        assertCurrent(record, true);
        bytes = await runTask(record.library, asset.id, async () => {
          const rendered = await render(record.library, asset, { signal: record.controller.signal });
          assertCurrent(record, true);
          await storeImage(record, rendered);
          assertCurrent(record, true);
          return rendered;
        });
      }
      assertCurrent(record, true);
      record.bytes = bytes;
      return { url: `shitu://model-hover/${record.key}` };
    }).catch(error => {
      abort(record);
      throw error;
    });
    tail = record.task.catch(() => {});
    return record.task;
  }

  const matches = (record, library, asset) => record?.library === library && record.id === asset.id && record.hash === asset.hash;

  async function prepare(library, id, expectedRoot, token) {
    const asset = eligibleAsset(library, id, expectedRoot, token);
    if (!asset) return null;
    if (matches(active, library, asset) && active.token === token) return active.task;
    abort(active);
    if (matches(warming, library, asset)) {
      // An explicit hover takes over the renderer and retains its progress.
      active = warming;
      warming = null;
      active.token = token;
      return active.task;
    }
    abort(warming);
    active = createRecord(library, asset, token);
    return start(active, asset);
  }

  async function warm(library, id, expectedRoot, token) {
    const asset = eligibleAsset(library, id, expectedRoot, token);
    if (!asset || active || warming) return false;
    const record = warming = createRecord(library, asset, token);
    try { await start(record, asset); return true; }
    finally { if (warming === record) abort(record); }
  }

  function cancel(id, expectedRoot, token) {
    assertToken(token);
    if (!active || active.id !== id || active.root !== expectedRoot || active.token !== token) return false;
    return abort(active);
  }

  function cancelWarm(id, expectedRoot, token) {
    assertToken(token);
    if (!warming || warming.id !== id || warming.root !== expectedRoot || warming.token !== token) return false;
    return abort(warming);
  }

  function response(request) {
    const notFound = () => new Response(null, { status: 404 });
    try {
      const url = new URL(request.url);
      const record = active;
      if (request.method !== 'GET' || url.protocol !== 'shitu:' || url.hostname !== 'model-hover' ||
          url.username || url.password || url.port || url.search || url.hash || !ROUTE.test(url.pathname) ||
          !record?.bytes || url.pathname !== '/' + record.key) return notFound();
      assertCurrent(record, true);
      // Every retrieval passes through the lease check. Disk caching still avoids re-rendering.
      return new Response(record.bytes, { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store',
        'Content-Length': String(record.bytes.length), 'X-Content-Type-Options': 'nosniff' } });
    } catch { return notFound(); }
  }

  function shutdown() {
    closed = true;
    invalidate();
    return tail;
  }

  return { prepare, cancel, warm, cancelWarm, response, invalidate, shutdown };
}

module.exports = { createModelHoverService };
