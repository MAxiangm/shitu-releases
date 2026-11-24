'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { IMAGE } = require('./media-formats.cjs');
const { findRoot } = require('./reimbursement-folders.cjs');

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_EDGE = 3500;
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const ID = /^[a-zA-Z0-9-]{1,128}$/;
const abortError = () => Object.assign(new Error('文件预览已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

function createReimbursementPreview({ rootDir, getLibrary, pdfReader, openFile } = {}) {
  if (!path.isAbsolute(rootDir || '') || typeof getLibrary !== 'function') throw new Error('报销预览初始化参数无效');
  let queue = Promise.resolve(), active, serial = 0, closed = false, cache, directoryPromise;

  function check(signal) { if (closed || signal?.aborted) throw abortError(); }
  function authorize(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.folderId !== 'string' || !ID.test(request.folderId) || typeof request.assetId !== 'string' || !ID.test(request.assetId) ||
        typeof request.libraryRoot !== 'string' || !path.isAbsolute(request.libraryRoot) || request.libraryRoot.includes('\0')) throw new Error('请选择有效的报销文件');
    const owner = getLibrary();
    if (!owner || owner.root !== request.libraryRoot) throw new Error('素材库已切换，请重新打开报销文件');
    const snapshot = owner.snapshot(), folder = snapshot.folders.find(item => item.id === request.folderId && item.kind === 'reimbursement');
    const asset = snapshot.assets.find(item => item.id === request.assetId && !item.trashedAt);
    if (!folder || !asset || findRoot(snapshot.folders, asset.folderId)?.id !== folder.id) throw new Error('文件已删除、移动或不属于当前报销文件夹');
    if (typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.hash)) throw new Error('报销文件校验信息无效');
    const filename = owner.getAssetPath(asset.id, 'original');
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('报销原文件路径无效');
    return { owner, asset, filename, request };
  }
  function stillOwned(context, signal) {
    check(signal);
    const current = authorize(context.request);
    if (current.owner !== context.owner || current.asset.hash !== context.asset.hash || current.asset.ext !== context.asset.ext ||
        current.asset.folderId !== context.asset.folderId || !samePath(current.filename, context.filename)) throw new Error('报销文件已变化，请重新打开预览');
    return current;
  }
  async function readOriginal(context, signal, collect = false) {
    stillOwned(context, signal);
    const info = await fs.lstat(context.filename);
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error('报销原文件不存在或不是普通文件');
    if (collect && info.size > MAX_FILE_BYTES) throw new Error('预览图片或 PDF 不能超过 64 MB');
    const [actual, root] = await Promise.all([fs.realpath(context.filename), fs.realpath(context.owner.root)]);
    const relative = path.relative(root, actual);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('报销原文件不在当前素材库内');
    const handle = await fs.open(context.filename, 'r');
    let bytes;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || stamp(opened) !== stamp(info)) throw new Error('报销文件在读取时发生变化，请重试');
      const hash = crypto.createHash('sha256'), chunk = Buffer.alloc(Math.min(1024 * 1024, info.size));
      if (collect) bytes = Buffer.alloc(info.size);
      let offset = 0;
      for (;;) {
        check(signal);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        if (offset + bytesRead > info.size) throw new Error('报销文件在读取时发生变化，请重试');
        hash.update(chunk.subarray(0, bytesRead));
        if (bytes) chunk.copy(bytes, offset, 0, bytesRead);
        offset += bytesRead;
      }
      if (offset !== info.size || hash.digest('hex') !== context.asset.hash || stamp(await handle.stat()) !== stamp(info)) throw new Error('报销原文件已变化，请刷新或重新导入后再预览');
    } finally { await handle.close(); }
    if (stamp(await fs.lstat(context.filename)) !== stamp(info)) throw new Error('报销文件在读取时发生变化，请重试');
    stillOwned(context, signal);
    return { bytes, stamp: stamp(info) };
  }
  async function directory() {
    directoryPromise ||= (async () => { await fs.mkdir(rootDir, { recursive: true }); return fs.mkdtemp(path.join(rootDir, 'session-')); })();
    return directoryPromise;
  }
  async function removeDirectory(target) {
    if (!target || !directoryPromise) return;
    const parent = await directoryPromise;
    const relative = path.relative(parent, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('预览缓存目录无效');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  }
  async function clearCache() {
    const previous = cache; cache = null;
    if (previous) await removeDirectory(previous.directory);
  }
  async function jpeg(bytes, signal) {
    check(signal);
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new Error('预览图片不能超过 1 亿像素');
    const output = await image.rotate().flatten({ background: '#ffffff' }).resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    check(signal);
    if (output.data.length > MAX_PREVIEW_BYTES) throw new Error('预览图片过大，请缩小后重试');
    return { url: `data:image/jpeg;base64,${output.data.toString('base64')}`, width: output.info.width, height: output.info.height };
  }
  async function readCachedPage(entry, directory, signal) {
    const info = await fs.lstat(entry.path), actual = await fs.realpath(entry.path);
    const relative = path.relative(await fs.realpath(directory), actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !info.isFile() || info.isSymbolicLink() ||
        !info.size || info.size > 32 * 1024 * 1024 || stamp(info) !== entry.stamp) throw new Error('PDF 预览页面已变化');
    const handle = await fs.open(entry.path, 'r');
    try {
      if (stamp(await handle.stat()) !== entry.stamp) throw new Error('PDF 预览页面已变化');
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        check(signal);
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error('PDF 预览页面已变化');
        offset += bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || stamp(await handle.stat()) !== entry.stamp ||
          stamp(await fs.lstat(entry.path)) !== entry.stamp || !samePath(await fs.realpath(entry.path), actual)) throw new Error('PDF 预览页面已变化');
      check(signal);
      return bytes;
    } finally { await handle.close(); }
  }
  async function perform(request, signal, external) {
    check(signal);
    const context = authorize(request), pageNumber = request.pageNumber === undefined ? 1 : request.pageNumber;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 100) throw new Error('预览页码必须为 1 至 100 的整数');
    const { asset } = context, inline = IMAGE.has(asset.ext) || asset.ext === 'pdf';
    const source = await readOriginal(context, signal, inline && !external);
    const base = { name: asset.name, ext: asset.ext, pageNumber, pageCount: 1 };
    if (external || !inline) {
      await clearCache(); await readOriginal(context, signal); stillOwned(context, signal);
      if (!external) return { ...base, type: 'external' };
      if (typeof openFile !== 'function') throw new Error('无法使用默认软件打开文件');
      const error = await openFile(context.filename);
      if (error) throw new Error(`无法打开报销文件：${String(error).slice(0, 500)}`);
      return { opened: true };
    }
    let picture;
    if (asset.ext === 'pdf') {
      const key = JSON.stringify([context.owner.root, request.folderId, asset.id, asset.hash, source.stamp]);
      if (cache?.key !== key || cache.owner !== context.owner) {
        await clearCache();
        if (typeof pdfReader?.convert !== 'function') throw new Error('PDF 预览组件不可用');
        const work = await fs.mkdtemp(path.join(await directory(), 'document-'));
        try {
          const inputPath = path.join(work, 'source.pdf'); await fs.writeFile(inputPath, source.bytes, { flag: 'wx' });
          source.bytes = null;
          const pages = await pdfReader.convert({ inputPath, outputDir: work, signal });
          check(signal);
          if (!Array.isArray(pages) || !pages.length || pages.length > 100) throw new Error('PDF 预览页数无效');
          let total = 0;
          const validatedPages = [];
          for (const page of pages) {
            const relative = typeof page?.path === 'string' ? path.relative(work, page.path) : '..';
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PDF 预览页面路径无效');
            const resolved = path.relative(await fs.realpath(work), await fs.realpath(page.path));
            if (!resolved || resolved.startsWith('..') || path.isAbsolute(resolved)) throw new Error('PDF 预览页面路径无效');
            const info = await fs.lstat(page.path);
            if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > 32 * 1024 * 1024) throw new Error('PDF 预览页面无效');
            total += info.size;
            validatedPages.push({ path: page.path, stamp: stamp(info) });
          }
          if (total > 256 * 1024 * 1024) throw new Error('PDF 预览内容过大，请拆分后重试');
          await readOriginal(context, signal);
          cache = { key, owner: context.owner, directory: work, pages: validatedPages };
        } catch (error) { await removeDirectory(work); throw error; }
      }
      base.pageCount = cache.pages.length;
      if (pageNumber > base.pageCount) throw new Error('该 PDF 没有此页，请选择有效页码');
      picture = await jpeg(await readCachedPage(cache.pages[pageNumber - 1], cache.directory, signal), signal);
    } else {
      await clearCache();
      if (pageNumber !== 1) throw new Error('图片只有一页');
      picture = await jpeg(source.bytes, signal);
    }
    await readOriginal(context, signal);
    return { ...base, type: 'image', ...picture };
  }
  function submit(request, external) {
    if (closed) return Promise.reject(new Error('报销预览服务已关闭'));
    active?.abort();
    const controller = new AbortController(), token = ++serial;
    active = controller;
    const task = queue.catch(() => {}).then(async () => {
      if (token !== serial) throw abortError();
      try { return await perform(request, controller.signal, external); }
      catch (error) { await clearCache(); if (controller.signal.aborted) throw abortError(); throw error; }
      finally { if (active === controller) active = null; }
    });
    queue = task.catch(() => {});
    return task;
  }
  function cancel() {
    serial++; active?.abort(); active = null;
    queue = queue.catch(() => {}).then(clearCache);
    return queue.then(() => ({ cancelled: true }));
  }
  async function shutdown() {
    if (closed) return queue;
    closed = true; await cancel(); await pdfReader?.shutdown?.();
    if (directoryPromise) {
      const target = await directoryPromise;
      const relative = path.relative(path.resolve(rootDir), target);
      if (/^session-[^\\/]+$/.test(relative)) await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
    }
  }
  return { preview: request => submit(request, false), openSource: request => submit(request, true), cancel, shutdown };
}

module.exports = { createReimbursementPreview, MAX_FILE_BYTES, MAX_IMAGE_PIXELS, MAX_EDGE, MAX_PREVIEW_BYTES };
