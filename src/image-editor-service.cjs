'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const crypto = require('node:crypto');
const { createPsdBuffer } = require('./psd-export.cjs');

const MAX_PIXELS = 16_777_216;
const MAX_BYTES = 80 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SUFFIXES = new Set(['编辑', '无缝', '置换', '法线', '粗糙度', '高光度', 'displacement', 'normal', 'roughness', 'specular', 'color']);
const LABELS = { displacement: '置换', normal: '法线', roughness: '粗糙度', specular: '高光度', color: '编辑' };
for (const label of ['彩色原图', '置换贴图', '法线贴图', '粗糙度图', '高光度图']) {
  SUFFIXES.add(label); SUFFIXES.add(`无缝 · ${label}`);
}
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function inside(filename, directory) {
  const relative = path.relative(key(directory), key(filename));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function outputSuffix(value) {
  if (typeof value !== 'string' || !SUFFIXES.has(value)) return '编辑';
  return LABELS[value] || value;
}
function validateBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 45 || value.byteLength > MAX_BYTES) throw new Error('图片数据无效或超过 80 MB');
  const bytes = Buffer.from(value);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('编辑结果必须是 PNG 图片');
  return bytes;
}

function createImageEditorService({ getLibrary, dialog, getParentWindow = () => null, onChanged = () => {}, tempRoot = os.tmpdir() }) {
  let operations = 0;
  function source(id, expectedRoot) {
    const library = getLibrary();
    if (!library || typeof expectedRoot !== 'string' || library.root !== expectedRoot) throw new Error('素材库已切换，请重新打开图片');
    const asset = library.snapshot().assets.find(item => item.id === id);
    if (typeof id !== 'string' || !asset || asset.trashedAt || asset.mediaType !== 'image') throw new Error('请选择未删除的静态图片');
    const filename = library.getAssetPath(id, 'original');
    if (!filename) throw new Error('图片原件不存在');
    return { library, asset, filename, hash: asset.hash };
  }
  function current(owner) {
    const latest = source(owner.asset.id, owner.library.root);
    if (latest.library !== owner.library || latest.hash !== owner.hash || latest.filename !== owner.filename) throw new Error('图片已变化，请重新打开后编辑');
    return latest.asset;
  }
  async function dimensions(owner) {
    const metadata = await sharp(owner.filename, { limitInputPixels: MAX_PIXELS }).metadata();
    if ((metadata.pages || 1) > 1) throw new Error('图片编辑暂不支持动图或多页图片，请先转为静态图片');
    const rotated = [5, 6, 7, 8].includes(metadata.orientation);
    const width = rotated ? metadata.height : metadata.width, height = rotated ? metadata.width : metadata.height;
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('图片编辑最多支持 1677 万像素，请先缩小图片');
    current(owner);
    return { width, height };
  }
  async function run(task) {
    operations++;
    try { return await task(); } finally { operations--; }
  }
  function read(id, expectedRoot) {
    return run(async () => {
      const owner = source(id, expectedRoot), size = await dimensions(owner);
      const bytes = await sharp(owner.filename, { limitInputPixels: MAX_PIXELS }).rotate().toColourspace('srgb').ensureAlpha().png().toBuffer();
      current(owner);
      if (bytes.length > MAX_BYTES) throw new Error('图片数据超过编辑器内存限制，请先缩小图片');
      return { bytes: new Uint8Array(bytes), ...size };
    });
  }
  async function prepare(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('图片保存参数无效');
    const owner = source(request.assetId, request.libraryRoot), input = validateBytes(request.bytes);
    await dimensions(owner);
    const metadata = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
    if (metadata.format !== 'png' || (metadata.pages || 1) > 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) throw new Error('编辑结果必须是 1677 万像素以内的静态 PNG');
    const size = { width: metadata.width, height: metadata.height };
    const bytes = await sharp(input, { limitInputPixels: MAX_PIXELS }).toColourspace('srgb').ensureAlpha().png().toBuffer();
    current(owner);
    return { owner, bytes, size, suffix: outputSuffix(request.suffix) };
  }
  function save(request) {
    return run(async () => {
      const { owner, bytes, size, suffix } = await prepare(request);
      await fs.mkdir(tempRoot, { recursive: true });
      const temporary = path.join(tempRoot, `mosaic-edit-${crypto.randomUUID()}.png`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx' });
        const asset = current(owner);
        const report = await owner.library.importPaths([temporary], { folderId: asset.folderId || null, metadata: {
          name: `${asset.name.slice(0, 210)} · ${suffix}`,
          ...(asset.sourceUrl ? { sourceUrl: asset.sourceUrl } : {}), ...(asset.pageUrl ? { pageUrl: asset.pageUrl } : {})
        } });
        if (report.errors?.length) throw new Error(report.errors[0].message || '编辑结果未能保存到素材库');
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const id = report.assetIds?.[0] || (report.duplicates ? owner.library.snapshot().assets.find(item => item.hash === hash)?.id : null);
        if (!id) throw new Error('编辑结果未能保存到素材库');
        const snapshot = owner.library.snapshot();
        if (snapshot.assets.find(item => item.id === id)?.trashedAt) throw new Error('相同结果已在回收站，请先恢复该素材后再保存');
        onChanged(owner.library);
        return { snapshot, id, duplicate: !report.imported, ...size };
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
  }
  async function writeExport(owner, bytes, size, suffix, extension) {
      const name = owner.asset.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || '图片';
      const label = extension.toUpperCase();
      const options = { title: extension === 'psd' ? '导出分层 PSD' : '导出编辑结果', defaultPath: `${name}-${suffix}.${extension}`, buttonLabel: `导出 ${label}`, filters: [{ name: extension === 'psd' ? 'Photoshop 分层文档' : 'PNG 图片', extensions: [extension] }] };
      const parent = getParentWindow();
      const chosen = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options));
      current(owner);
      if (!chosen || chosen.canceled || !chosen.filePath) return { canceled: true };
      if (typeof chosen.filePath !== 'string' || !path.isAbsolute(chosen.filePath)) throw new Error('请选择有效的保存位置');
      let destination = chosen.filePath;
      if (!path.extname(destination)) destination += `.${extension}`;
      if (path.extname(destination).toLowerCase() !== `.${extension}`) throw new Error(`请保存为 .${extension} 文件`);
      const directory = await fs.realpath(path.dirname(destination));
      const libraryRoot = await fs.realpath(owner.library.root);
      destination = path.join(directory, path.basename(destination));
      if (inside(destination, libraryRoot) || key(destination) === key(owner.filename)) throw new Error('请导出到素材库以外的文件夹，避免覆盖原件');
      const existing = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('保存目标不是普通文件');
      const temporary = path.join(directory, `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx' });
        current(owner);
        await fs.rename(temporary, destination);
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return { canceled: false, path: destination, ...size };
  }
  function exportImage(request) {
    return run(async () => {
      const { owner, bytes, size, suffix } = await prepare(request);
      return writeExport(owner, bytes, size, suffix, 'png');
    });
  }
  function exportPsd(request) {
    return run(async () => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('PSD 导出参数无效');
      const owner = source(request.assetId, request.libraryRoot);
      await dimensions(owner);
      const output = createPsdBuffer(request);
      current(owner);
      return writeExport(owner, output.bytes, { width: output.width, height: output.height, layerCount: output.layerCount }, '分层编辑', 'psd');
    });
  }
  return { read, save, exportImage, exportPsd, busy: () => operations > 0 };
}

module.exports = { createImageEditorService, MAX_PIXELS, MAX_BYTES, validateBytes, outputSuffix };
