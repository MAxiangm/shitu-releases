'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { MODEL, PROJECT } = require('./media-formats.cjs');
const FolderTree = require('./folder-tree.js');

function createAssetExportService({ getLibrary, chooseDirectory, prepareModel, prepareProject, tempDirectory, onProgress, onChanged } = {}) {
  let active = null;
  const busy = () => Boolean(active);
  function owner(request) {
    request.controller.signal.throwIfAborted();
    if (getLibrary() !== request.library || request.library.root !== request.root) throw new Error('素材库已切换，请重新选择要导出的内容');
  }
  function select(library, kind, value) {
    const snapshot = library.snapshot();
    if (kind === 'folder') {
      if (typeof value !== 'string' || !snapshot.folders.some(folder => folder.id === value)) throw new Error('文件夹已不存在');
      const ids = FolderTree.descendantIds(snapshot.folders, value);
      return { folders: snapshot.folders.filter(folder => ids.has(folder.id)),
        assets: snapshot.assets.filter(asset => ids.has(asset.folderId) && !asset.trashedAt) };
    }
    if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || !id)) throw new Error('请选择要导出的素材');
    const ids = new Set(value);
    const assets = snapshot.assets.filter(asset => ids.has(asset.id));
    if (assets.length !== ids.size) throw new Error('部分素材已不存在，请重新选择');
    return { folders: [], assets };
  }
  function signature(selected) {
    return JSON.stringify({ folders: selected.folders.map(({ id, name, parentId, sortOrder }) => [id,name,parentId,sortOrder]),
      assets: selected.assets.map(({ id, name, folderId, hash, trashedAt }) => [id,name,folderId,hash,trashedAt]) });
  }
  function notify(request, value) {
    owner(request);
    try { onProgress?.({ root: request.root, ...value }); } catch {}
  }
  async function validThumbnail(filename) {
    if (!filename || !path.isAbsolute(filename)) return false;
    try {
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 20 * 1024 * 1024 ||
          path.resolve(await fs.realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase()) return false;
      const image = sharp(filename, { limitInputPixels: 40_000_000, failOn: 'warning' });
      const meta = await image.metadata();
      if (!meta.width || !meta.height) return false;
      await image.raw().toBuffer();
      return true;
    } catch { return false; }
  }
  async function unlinkedDirectory(directory) {
    const info = await fs.lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink() &&
      path.resolve(await fs.realpath(directory)).toLowerCase() === path.resolve(directory).toLowerCase();
  }
  async function execute(kind, value, expectedRoot) {
    if (active) throw new Error('正在导出，请等待当前导出完成');
    const library = getLibrary();
    if (!library || typeof expectedRoot !== 'string' || library.root !== expectedRoot) throw new Error('素材库已切换，请重新选择要导出的内容');
    const request = { library, root: expectedRoot, controller: new AbortController(), staging: null, stagedFiles: [] };
    active = request;
    try {
      await library.flush(); owner(request);
      select(library, kind, value);
      const choice = await chooseDirectory(kind);
      owner(request);
      if (!choice || choice.canceled || choice.cancelled) return { cancelled: true };
      const destination = choice.filePaths?.[0] || choice.path;
      if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('请选择有效的导出文件夹');
      const selected = select(library, kind, value), fingerprint = signature(selected);
      const bundles = selected.assets.filter(asset => MODEL.has(asset.ext) || PROJECT.has(asset.ext));
      const thumbnailPaths = new Map(), previewNotes = new Map();
      for (const [index, asset] of bundles.entries()) {
        notify(request, { phase: 'preparing', current: index + 1, total: bundles.length, name: asset.name });
        let thumbnail;
        try {
          thumbnail = library.getAssetPath(asset.id, 'thumbnail');
          if (!await validThumbnail(thumbnail)) {
            if (PROJECT.has(asset.ext)) {
              if (asset.trashedAt) throw new Error('请先从回收站恢复此工程，再生成缩略图');
              await prepareProject(library, asset.id, { expectedRoot, signal: request.controller.signal });
              thumbnail = library.getAssetPath(asset.id, 'thumbnail');
            } else {
              if (!request.staging) {
                await fs.mkdir(tempDirectory, { recursive: true });
                if (!await unlinkedDirectory(tempDirectory)) throw new Error('导出预览临时目录无效');
                request.staging = await fs.mkdtemp(path.join(tempDirectory, 'export-'));
                request.stagingIdentity = await fs.lstat(request.staging);
              }
              thumbnail = path.join(request.staging, `${index}.jpg`);
              try { await prepareModel(library, asset, thumbnail, { signal: request.controller.signal }); }
              finally {
                const identity = await fs.lstat(thumbnail).catch(() => null);
                if (identity?.isFile() && !identity.isSymbolicLink()) request.stagedFiles.push({ path: thumbnail, identity });
              }
            }
            if (!await validThumbnail(thumbnail)) throw new Error('当前环境未能生成可用缩略图');
          }
        } catch (error) {
          owner(request);
          if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
          thumbnail = null;
          previewNotes.set(asset.id, `未附带缩略图：${String(error?.message || '无法生成预览').slice(0, 500)}；原始资源文件照常导出。`);
        }
        owner(request); thumbnailPaths.set(asset.id, thumbnail);
      }
      owner(request);
      if (signature(select(library, kind, value)) !== fingerprint) throw new Error('要导出的素材或文件夹已变化，请重新导出');
      const options = { signal: request.controller.signal, thumbnailPaths, previewNotes,
        onProgress: progress => notify(request, { ...progress, phase: 'copying', current: progress.current ?? progress.completed }) };
      notify(request, { phase: 'copying', current: 0, total: selected.assets.length, name: '' });
      let result;
      try { result = kind === 'folder' ? await library.exportFolder(value, destination, options) : await library.exportAssets(value, destination, options); }
      finally {
        // Dependency checks may persist useful results even if copying later
        // fails. Let the current library view pick up those diagnostics too.
        try { onChanged?.(library); } catch {}
      }
      owner(request);
      return { ...result, cancelled: false, count: result.exported, path: result.path || destination };
    } finally {
      if (request.staging) await (async () => {
        if (!await unlinkedDirectory(tempDirectory) || !await unlinkedDirectory(request.staging)) return;
        const current = await fs.lstat(request.staging), original = request.stagingIdentity;
        if (current.dev !== original.dev || current.ino !== original.ino) return;
        for (const file of request.stagedFiles) {
          const info = await fs.lstat(file.path).catch(() => null);
          if (info?.isFile() && !info.isSymbolicLink() && info.dev === file.identity.dev && info.ino === file.identity.ino) await fs.unlink(file.path);
        }
        // Unknown files or a replaced directory are never recursively removed.
        await fs.rmdir(request.staging).catch(() => {});
      })().catch(() => {});
      if (active === request) active = null;
    }
  }
  return { busy, exportAssets: (ids, expectedRoot) => execute('assets', ids, expectedRoot),
    exportFolder: (id, expectedRoot) => execute('folder', id, expectedRoot),
    cancel: () => active?.controller.abort(new Error('导出已取消')) };
}
module.exports = { createAssetExportService };
