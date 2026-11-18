'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const FolderIcons = require('./folder-icons.js');
const { MIME } = require('./media-formats.cjs');
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;
const MAX_FRAMES = 300;
const IMPORT_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tif', 'tiff', 'svg']);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const decoder = bytes => sharp(bytes, { animated: true, failOn: 'warning', limitInputPixels: MAX_PIXELS });

async function readLimited(filename, expectedSize) {
  const handle = await fs.open(filename, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > MAX_BYTES || (expectedSize !== undefined && info.size !== expectedSize)) throw new Error('请选择不超过 25 MB 的完整图标图片');
    // Bound the read even if another process replaces or grows the source.
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error('读取图标时文件发生了变化，请重试');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function inspect(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw new Error('图标图片不能超过 25 MB');
  let metadata;
  try { metadata = await decoder(bytes).metadata(); }
  catch { throw new Error('无法读取图标图片，请选择完整有效的图片文件'); }
  const width = metadata.width, height = metadata.pageHeight || metadata.height, frames = metadata.pages || 1;
  if (![width, height, frames].every(value => Number.isSafeInteger(value) && value >= 1) ||
      width > FolderIcons.MAX_SIDE || height > FolderIcons.MAX_SIDE || frames > MAX_FRAMES || width * height * frames > MAX_PIXELS) {
    throw new Error('图标图片过大：单边最多 8192 像素，动画最多 300 帧，总像素最多 3200 万');
  }
  let ext = ({ png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' })[metadata.format];
  if (metadata.format === 'heif' && metadata.compression === 'av1') ext = 'avif';
  if (!ext && !['svg', 'tiff', 'heif'].includes(metadata.format)) throw new Error('不支持此图标图片格式，请使用 PNG、JPEG、WebP、GIF、AVIF、SVG 或 TIFF');
  if (!ext && frames > 1) throw new Error('多页图片请先导出为 PNG，动画图标请使用 GIF 或 WebP');
  try {
    // Decode every page before keeping the original. In particular, this catches
    // truncated GIF frames without flattening or re-encoding a valid animation.
    await decoder(bytes).raw().toBuffer();
    if (!ext) {
      const converted = await sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS }).rotate().png().toBuffer();
      return inspect(converted);
    }
  } catch { throw new Error('图标图片不完整或无法解码，请选择其他图片'); }
  return { bytes, icon: FolderIcons.normalizeIcon({ type: 'image', hash: digest(bytes), ext, width, height, animated: frames > 1, size: bytes.length }) };
}

async function directory(root, create = false) {
  const folder = path.join(root, 'folder-icons');
  if (create) await fs.mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await fs.lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('文件夹图标目录不能是符号链接');
  const realRoot = await fs.realpath(root), realFolder = await fs.realpath(folder);
  if (path.relative(realRoot, realFolder) !== 'folder-icons') throw new Error('文件夹图标目录超出当前素材库');
  return folder;
}

async function readStored(root, value, { decode = false } = {}) {
  const icon = FolderIcons.normalizeIcon(value);
  if (icon?.type !== 'image') throw new Error('此文件夹没有自定义图标');
  const folder = await directory(root);
  const filename = path.join(folder, `${icon.hash}.${icon.ext}`);
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== icon.size || info.size > MAX_BYTES) throw new Error('文件夹图标文件无效');
  if (path.dirname(await fs.realpath(filename)) !== await fs.realpath(folder)) throw new Error('文件夹图标路径无效');
  const bytes = await readLimited(filename, icon.size);
  if (bytes.length !== icon.size || digest(bytes) !== icon.hash) throw new Error('文件夹图标内容校验失败');
  if (decode) {
    const checked = (await inspect(bytes)).icon;
    if (JSON.stringify(checked) !== JSON.stringify(icon)) throw new Error('文件夹图标信息与图片不一致');
  }
  return { bytes, icon, filename };
}

async function importImage(root, filename) {
  if (typeof filename !== 'string' || !filename || filename.length > 32000) throw new Error('请选择有效的图标图片');
  const { bytes, icon } = await inspect(await readLimited(filename));
  const folder = await directory(root, true);
  const target = path.join(folder, `${icon.hash}.${icon.ext}`);
  let handle;
  try { handle = await fs.open(target, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await readStored(root, icon);
    return icon;
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await fs.unlink(target).catch(() => {}); throw error; }
  await handle.close();
  return icon;
}

async function response(library, request) {
  try {
    const url = new URL(request.url);
    const id = decodeURIComponent(url.pathname.slice(1)), hash = url.searchParams.get('v');
    if (!library || request.method !== 'GET' || url.hostname !== 'folder-icon' || url.username || url.password || url.port ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(id) || !/^[a-f0-9]{64}$/.test(hash || '')) return new Response(null, { status: 404 });
    const { bytes, icon } = await library.readFolderIcon(id, hash);
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': MIME[icon.ext], 'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' } });
  } catch { return new Response(null, { status: 404 }); }
}

module.exports = { IMPORT_EXTENSIONS, MAX_BYTES, MAX_PIXELS, MAX_FRAMES, inspect, importImage, readStored, response };
