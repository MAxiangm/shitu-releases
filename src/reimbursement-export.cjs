'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { safeName } = require('./asset-export.cjs');

function inside(parent, child) {
  if (process.platform === 'win32') { parent = parent.toLowerCase(); child = child.toLowerCase(); }
  const relative = path.relative(parent, child);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function reserveDirectory(parent, name, signal) {
  const base = `${safeName(name)}_报销资料`;
  for (let ordinal = 1; ordinal <= 10000; ordinal++) {
    signal?.throwIfAborted();
    const directory = path.join(parent, `${base}${ordinal === 1 ? '' : `（${ordinal}）`}`);
    try { await fs.mkdir(directory); return directory; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('无法创建唯一的报销资料目录，请选择其他导出位置');
}

async function exportReimbursementBundle({ library, assetIds, destination, name = '报销', assertCurrent, signal } = {}) {
  if (!library || typeof library.exportAssets !== 'function' || typeof library.root !== 'string' || !path.isAbsolute(library.root)) throw new Error('报销素材库无效');
  if (typeof destination !== 'string' || !destination.trim() || destination.length > 32000 || !path.isAbsolute(destination)) throw new Error('请选择有效的绝对路径导出目录');
  if (typeof name !== 'string' || !name.trim() || name.length > 1000) throw new Error('报销名称无效');
  if (assertCurrent !== undefined && typeof assertCurrent !== 'function') throw new Error('报销资料检查参数无效');
  if (!Array.isArray(assetIds) || !assetIds.length || new Set(assetIds).size !== assetIds.length || assetIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id))) throw new Error('请选择有效且不重复的报销文件');
  const ids = [...assetIds];
  const check = async () => { signal?.throwIfAborted(); await assertCurrent?.(); signal?.throwIfAborted(); };
  await check();
  const root = await fs.realpath(library.root), parent = await fs.realpath(destination);
  if (!(await fs.stat(parent)).isDirectory()) throw new Error('导出位置必须是文件夹');
  if (inside(root, parent)) throw new Error('请将报销资料导出到素材库以外的文件夹');
  await check();
  let directory, identity;
  const exportedFiles = [];
  const ownsDirectory = async () => {
    if (!directory || !identity) return false;
    const currentParent = await fs.realpath(path.dirname(directory));
    const current = await fs.lstat(directory);
    return currentParent === parent && current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino;
  };
  try {
    directory = await reserveDirectory(parent, name, signal);
    identity = await fs.lstat(directory);
    await check();
    const result = await library.exportAssets(ids, directory, { signal });
    // The core exporter rolls back its own failures. Once it returns, retain
    // identities of its exact file outputs for a later stale/cancel rollback.
    // Bundle directories are intentionally retained rather than traversed.
    if (!Array.isArray(result?.files)) throw new Error('报销导出文件清单无效');
    for (const filename of [...result.files, ...(result.reportPath ? [result.reportPath] : [])]) {
      if (typeof filename !== 'string' || path.dirname(filename) !== directory || !await ownsDirectory()) throw new Error('报销导出路径已变化');
      const info = await fs.lstat(filename);
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error('报销导出文件已变化');
      if (info.isFile()) exportedFiles.push({ filename, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
    }
    await check();
    if (!Number.isSafeInteger(result?.exported) || result.exported !== ids.length) throw new Error('报销资料未完整导出，请重试');
    return { path: directory, count: result.exported };
  } catch (error) {
    if (directory && identity) {
      try {
        // Never follow a changed parent/child or remove external replacements,
        // edits, additions, or unlisted descendants. Each unlink is limited to
        // an unchanged file captured after this export, and rmdir stays empty-only.
        for (const file of exportedFiles) {
          try {
            if (!await ownsDirectory()) break;
            const current = await fs.lstat(file.filename);
            if (current.isFile() && !current.isSymbolicLink() && current.dev === file.dev && current.ino === file.ino && current.size === file.size && current.mtimeMs === file.mtimeMs && await ownsDirectory()) await fs.unlink(file.filename);
          } catch {}
        }
        if (await ownsDirectory()) await fs.rmdir(directory);
      } catch {}
    }
    throw error;
  }
}

module.exports = { exportReimbursementBundle };
