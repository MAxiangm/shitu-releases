const fs = require('node:fs');
const path = require('node:path');
const { MODEL, PROJECT } = require('./media-formats.cjs');

const MAX_DRAG_ASSETS = 256;

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Synchronous validation intentionally keeps native drag initiation in the
// original dragstart turn. Renderer input is always IDs, never filesystem paths.
function resolveAssetFiles(library, ids, expectedRoot) {
  if (!library) throw new Error('请先选择素材库');
  if (expectedRoot !== undefined && (typeof expectedRoot !== 'string' || !path.isAbsolute(expectedRoot) || !samePath(expectedRoot, library.root))) throw new Error('素材库已切换，请重新选择素材');
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DRAG_ASSETS || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id))) throw new Error(`请选中 1 至 ${MAX_DRAG_ASSETS} 个有效素材`);
  const uniqueIds = [...new Set(ids)];
  const index = new Map(library.snapshot().assets.map(asset => [asset.id, asset]));
  const originalsRoot = path.join(fs.realpathSync(library.root), 'originals');
  const assets = [];
  const files = [];
  for (const id of uniqueIds) {
    const asset = index.get(id);
    if (!asset) throw new Error('所选素材不存在，请重新选择');
    if (asset.trashedAt) throw new Error('请先从回收站恢复素材');
    const bundled = MODEL.has(asset.ext) || PROJECT.has(asset.ext);
    const manifest = PROJECT.has(asset.ext) ? asset.projectBundle : asset.modelBundle;
    const filename = PROJECT.has(asset.ext) ? library.getProjectBundleDirectory(id) : bundled ? library.getModelBundleDirectory(id) : library.getAssetPath(id, 'original');
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('素材原件路径无效');
    let resolved;
    try {
      const info = fs.lstatSync(filename);
      if (info.isSymbolicLink() || (bundled ? !info.isDirectory() : !info.isFile())) throw new Error('不是有效的素材文件或资源包');
      resolved = fs.realpathSync(filename);
      if (!isWithin(originalsRoot, resolved)) throw new Error('路径不在当前素材库原件目录内');
      fs.accessSync(resolved, fs.constants.R_OK);
      if (bundled) {
        const knownFiles = new Map(manifest.files.map(file => [file.path, file]));
        const visit = (directory, relative = '') => {
          for (const name of fs.readdirSync(directory)) {
            const child = relative ? `${relative}/${name}` : name;
            const childPath = path.join(directory, name);
            const childInfo = fs.lstatSync(childPath);
            if (childInfo.isSymbolicLink()) throw new Error('模型包包含符号链接');
            if (childInfo.isDirectory()) {
              if (![...knownFiles.keys()].some(filename => filename.startsWith(`${child}/`))) throw new Error('模型包包含未知目录');
              visit(childPath, child);
            } else if (!childInfo.isFile() || !knownFiles.has(child)) throw new Error('模型包包含未知文件');
          }
        };
        visit(resolved);
        for (const file of knownFiles.values()) {
          const companion = path.join(resolved, file.path);
          const companionInfo = fs.lstatSync(companion);
          if (!companionInfo.isFile() || companionInfo.isSymbolicLink() || !isWithin(resolved, fs.realpathSync(companion))) throw new Error('模型依赖路径无效');
          fs.accessSync(companion, fs.constants.R_OK);
        }
      }
    } catch (error) { throw new Error(`无法读取素材“${asset.name}”：${error.code === 'ENOENT' ? '原文件不存在' : error.message}`); }
    assets.push(asset);
    files.push(resolved);
  }
  return { assets, files };
}

function createDragIcon(library, asset, nativeImage, fallbackPath) {
  const thumbnail = library.getAssetPath(asset.id, 'thumbnail');
  let icon;
  if (thumbnail) {
    try {
      const root = fs.realpathSync(library.root);
      const resolved = fs.realpathSync(thumbnail);
      if (isWithin(path.join(root, 'thumbnails'), resolved)) icon = nativeImage.createFromPath(resolved);
    } catch {}
  }
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(fallbackPath);
  if (icon.isEmpty()) throw new Error('拖放图标无法读取，请重启应用后重试');
  const { width, height } = icon.getSize();
  const scale = Math.min(1, 96 / Math.max(width, height));
  return icon.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' });
}

module.exports = { resolveAssetFiles, createDragIcon, MAX_DRAG_ASSETS };
