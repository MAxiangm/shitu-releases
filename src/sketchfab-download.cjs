'use strict';

const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { createInflateRaw } = require('node:zlib');
const { collectModelBundle, isSafeBundlePath } = require('./model-bundle.cjs');

const DEFAULT_LIMITS = Object.freeze({ compressedBytes: 512 * 1024 * 1024, expandedBytes: 1024 * 1024 * 1024, files: 4096 });
const ATTRIBUTION_FILE = 'sketchfab-attribution.json';
const MODEL_ID = /^[a-f0-9]{32}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function issue(message, code = 'SKETCHFAB_ARCHIVE_INVALID') { return Object.assign(new Error(message), { code }); }
function checkModelId(value) {
  if (typeof value !== 'string' || !MODEL_ID.test(value)) throw issue('Sketchfab 模型编号无效。', 'SKETCHFAB_SOURCE_INVALID');
  return value;
}
function validateSketchfabArchiveUrl(value, modelId) {
  checkModelId(modelId);
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f]/.test(value)) throw issue('Sketchfab 模型下载地址无效。', 'SKETCHFAB_SOURCE_INVALID');
  let url;
  try { url = new URL(value); } catch { throw issue('Sketchfab 模型下载地址无效。', 'SKETCHFAB_SOURCE_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== 'sketchfab-prod-media.s3.amazonaws.com' || url.port || url.username || url.password || url.hash ||
      !url.pathname.startsWith(`/archives/${modelId}/gltf/`)) throw issue('下载地址不属于所选 Sketchfab 模型。', 'SKETCHFAB_SOURCE_INVALID');
  const tail = url.pathname.slice(`/archives/${modelId}/gltf/`.length);
  if (!tail || !/^[A-Za-z0-9_.\/-]+\.zip$/.test(tail) || tail.split('/').some(part => !part || part === '.' || part === '..')) {
    throw issue('Sketchfab 模型压缩包地址无效。', 'SKETCHFAB_SOURCE_INVALID');
  }
  return url.href;
}
function modelPage(value, modelId) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw issue('Sketchfab 模型页面无效。', 'SKETCHFAB_SOURCE_INVALID');
  let url;
  try { url = new URL(value); } catch { throw issue('Sketchfab 模型页面无效。', 'SKETCHFAB_SOURCE_INVALID'); }
  if (url.protocol !== 'https:' || !['sketchfab.com', 'www.sketchfab.com'].includes(url.hostname) || url.port || url.username || url.password ||
      !(url.pathname === `/models/${modelId}` || url.pathname === `/models/${modelId}/` ||
        new RegExp(`^/3d-models/(?:[A-Za-z0-9_-]+-)?${modelId}/?$`).test(url.pathname))) {
    throw issue('Sketchfab 模型页面与模型编号不一致。', 'SKETCHFAB_SOURCE_INVALID');
  }
  return `https://sketchfab.com${url.pathname.replace(/\/$/, '')}`;
}
function text(value, maximum = 240) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maximum) : '';
}
function attributionUrl(value, kind) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2048) throw issue('Sketchfab 署名链接无效。', 'SKETCHFAB_SOURCE_INVALID');
  let url;
  try { url = new URL(value); } catch { throw issue('Sketchfab 署名链接无效。', 'SKETCHFAB_SOURCE_INVALID'); }
  const hosts = kind === 'author' ? ['sketchfab.com', 'www.sketchfab.com'] : ['creativecommons.org', 'www.creativecommons.org', 'sketchfab.com', 'www.sketchfab.com'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || /[\x00-\x20\x7f]/.test(value)) {
    throw issue('Sketchfab 署名链接必须是公开页面。', 'SKETCHFAB_SOURCE_INVALID');
  }
  return url.href;
}
function publicAttribution(input, modelId, pageUrl) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw issue('Sketchfab 署名信息无效。', 'SKETCHFAB_SOURCE_INVALID');
  input ||= {};
  if (input.sourceUrl !== undefined) modelPage(input.sourceUrl, modelId);
  const value = { version: 1, provider: 'Sketchfab', modelId, pageUrl };
  const title = text(input.title || input.name);
  if (title) value.title = title;
  const author = input.author || input.user;
  if (author && typeof author === 'object' && !Array.isArray(author)) {
    const name = text(author.name || author.displayName || author.username);
    const url = attributionUrl(author.url || author.profileUrl, 'author');
    if (name || url) value.author = { ...(name ? { name } : {}), ...(url ? { url } : {}) };
  }
  const license = input.license;
  if (license && typeof license === 'object' && !Array.isArray(license)) {
    const name = text(license.name || license.label || license.fullName), slug = text(license.slug, 80);
    const url = attributionUrl(license.url, 'license');
    if (name || slug || url) value.license = { ...(name ? { name } : {}), ...(slug ? { slug } : {}), ...(url ? { url } : {}) };
  }
  return value;
}
function limitsFor(input = {}) {
  const limits = { ...DEFAULT_LIMITS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw issue('模型下载限制无效。');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > DEFAULT_LIMITS[key]) throw issue('模型下载限制无效。');
    limits[key] = input[key];
  }
  return limits;
}
async function readAt(handle, length, position) {
  const bytes = Buffer.alloc(length);
  if ((await handle.read(bytes, 0, length, position)).bytesRead !== length) throw issue('模型 ZIP 数据不完整。');
  return bytes;
}
function extras(bytes) {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw issue('模型 ZIP 扩展字段无效。');
    const tag = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2);
    if (offset + 4 + length > bytes.length || [0x0001, 0x000d, 0x756e].includes(tag)) throw issue('不支持 ZIP64 或链接类型的模型 ZIP。');
    offset += 4 + length;
  }
}
function entryName(bytes, directory) {
  let name;
  try { name = UTF8.decode(bytes); } catch { throw issue('模型 ZIP 文件名不是有效 UTF-8。'); }
  if (directory && name.endsWith('/')) name = name.slice(0, -1);
  if (!isSafeBundlePath(name) || name.split('/').length > 32) throw issue('模型 ZIP 含有不安全的文件路径。');
  return name;
}
async function zipEntries(handle, size, limits, signal) {
  if (size < 22 || (await readAt(handle, 4, 0)).readUInt32LE() !== 0x04034b50) throw issue('下载结果不是受支持的 ZIP 模型包。');
  const tailLength = Math.min(size, 65557), tail = await readAt(handle, tailLength, size - tailLength);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { eocd = index; break; }
  }
  if (eocd < 0) throw issue('模型 ZIP 中央目录缺失。');
  const count = tail.readUInt16LE(eocd + 10), centralSize = tail.readUInt32LE(eocd + 12), centralOffset = tail.readUInt32LE(eocd + 16);
  if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6) || count !== tail.readUInt16LE(eocd + 8) ||
      !count || count === 0xffff || count > limits.files * 4 || centralSize > 16 * 1024 * 1024 ||
      centralOffset + centralSize !== size - tailLength + eocd) throw issue('不支持分卷、ZIP64 或超限的模型 ZIP。');
  const central = await readAt(handle, centralSize, centralOffset), entries = [], paths = new Map();
  let cursor = 0, expanded = 0, files = 0;
  const keyFor = name => name.normalize('NFC').toLowerCase();
  for (let index = 0; index < count; index++) {
    signal.throwIfAborted();
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw issue('模型 ZIP 中央目录无效。');
    const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10), crc = central.readUInt32LE(cursor + 16);
    const compressed = central.readUInt32LE(cursor + 20), uncompressed = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28), extraLength = central.readUInt16LE(cursor + 30), commentLength = central.readUInt16LE(cursor + 32);
    const attributes = central.readUInt32LE(cursor + 38), localOffset = central.readUInt32LE(cursor + 42), type = attributes >>> 16 & 0xf000;
    if (central.readUInt16LE(cursor + 34) || flags & ~0x080e || ![0, 8].includes(method) ||
        [compressed, uncompressed, localOffset].includes(0xffffffff) || !nameLength || nameLength > 8192 ||
        cursor + 46 + nameLength + extraLength + commentLength > central.length ||
        type && ![0x8000, 0x4000].includes(type) || attributes & 0x400) throw issue('模型 ZIP 含有加密、链接或不支持的条目。');
    const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength);
    const directory = nameBytes.at(-1) === 47 || type === 0x4000 || Boolean(attributes & 0x10);
    if (directory && (compressed || uncompressed || type === 0x8000)) throw issue('模型 ZIP 目录条目无效。');
    const name = entryName(nameBytes, directory), key = keyFor(name);
    extras(central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    if (paths.has(key)) throw issue('模型 ZIP 含有重复或大小写冲突的路径。');
    paths.set(key, directory ? 'directory' : 'file');
    if (!directory && (++files >= limits.files || (expanded += uncompressed) > limits.expandedBytes)) throw issue('模型 ZIP 展开后超过大小或文件数量上限。', 'SKETCHFAB_ARCHIVE_TOO_LARGE');
    if (localOffset + 30 > centralOffset) throw issue('模型 ZIP 本地条目越界。');
    const local = await readAt(handle, 30, localOffset);
    const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method ||
        localNameLength !== nameLength || localOffset + 30 + localNameLength + localExtraLength > centralOffset) throw issue('模型 ZIP 本地目录与中央目录不一致。');
    const localTail = await readAt(handle, localNameLength + localExtraLength, localOffset + 30);
    if (!localTail.subarray(0, localNameLength).equals(nameBytes)) throw issue('模型 ZIP 文件名不一致。');
    extras(localTail.subarray(localNameLength));
    if (!(flags & 8) && (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== uncompressed)) throw issue('模型 ZIP 本地大小或校验值不一致。');
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    let end = dataOffset + compressed;
    if (end > centralOffset) throw issue('模型 ZIP 数据范围越界。');
    if (flags & 8) {
      if (end + 12 > centralOffset) throw issue('模型 ZIP 数据描述缺失。');
      let descriptor = await readAt(handle, Math.min(16, centralOffset - end), end), skip = descriptor.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
      if (descriptor.length < skip + 12 || descriptor.readUInt32LE(skip) !== crc || descriptor.readUInt32LE(skip + 4) !== compressed || descriptor.readUInt32LE(skip + 8) !== uncompressed) throw issue('模型 ZIP 数据描述不一致。');
      end += skip + 12;
    }
    entries.push({ name, directory, method, compressed, uncompressed, crc, dataOffset, localOffset, end });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== central.length) throw issue('模型 ZIP 中央目录长度不一致。');
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let index = 1; index < parts.length; index++) if (paths.get(keyFor(parts.slice(0, index).join('/'))) === 'file') throw issue('模型 ZIP 文件与目录路径冲突。');
  }
  const ranges = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let index = 1; index < ranges.length; index++) if (ranges[index].localOffset < ranges[index - 1].end) throw issue('模型 ZIP 条目数据重叠。');
  if (paths.has(keyFor(ATTRIBUTION_FILE))) throw issue('模型 ZIP 占用了保留的署名文件路径。');
  return entries;
}
async function extractZip(archive, root, limits, signal, onProgress) {
  const handle = await fs.open(archive, 'r');
  try {
    const entries = await zipEntries(handle, (await handle.stat()).size, limits, signal);
    let expanded = 0;
    for (const entry of entries) {
      signal.throwIfAborted();
      const destination = path.join(root, ...entry.name.split('/'));
      if (entry.directory) { await fs.mkdir(destination, { recursive: true }); continue; }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      let count = 0, crc = 0xffffffff;
      const check = new Transform({ transform(chunk, _encoding, callback) {
        count += chunk.length; expanded += chunk.length;
        if (count > entry.uncompressed || expanded > limits.expandedBytes) return callback(issue('模型 ZIP 实际展开量超过上限。', 'SKETCHFAB_ARCHIVE_TOO_LARGE'));
        for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ crc >>> 8;
        onProgress({ phase: 'extracting', receivedBytes: expanded });
        callback(null, chunk);
      } });
      if (!entry.compressed) {
        if (entry.uncompressed || entry.crc) throw issue('模型 ZIP 空条目校验失败。');
        await fs.writeFile(destination, Buffer.alloc(0), { flag: 'wx' });
      } else {
        const input = createReadStream(null, { fd: handle.fd, autoClose: false, start: entry.dataOffset, end: entry.dataOffset + entry.compressed - 1 });
        const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
        if (entry.method === 8) await pipeline(input, createInflateRaw(), check, output, { signal });
        else await pipeline(input, check, output, { signal });
        if (count !== entry.uncompressed || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw issue('模型 ZIP 解压长度或 CRC 校验失败。');
      }
    }
    return entries.filter(entry => !entry.directory).map(entry => entry.name);
  } finally { await handle.close(); }
}
async function checkedDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw issue('模型暂存目录无效。');
  directory = path.resolve(directory);
  for (let cursor = directory, previous; cursor !== previous; previous = cursor, cursor = path.dirname(cursor)) {
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw issue('模型暂存目录不能经过链接。');
  }
  return directory;
}
async function stageSketchfabModel({ modelId, pageUrl, archiveUrl, attribution, directory, signal, downloadArchive, onProgress = () => {}, limits } = {}) {
  modelId = checkModelId(modelId);
  pageUrl = modelPage(pageUrl, modelId);
  archiveUrl = validateSketchfabArchiveUrl(archiveUrl, modelId);
  const provenance = publicAttribution(attribution, modelId, pageUrl), bounds = limitsFor(limits);
  if (typeof downloadArchive !== 'function') throw issue('模型下载服务不可用。');
  directory = await checkedDirectory(directory);
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(18 * 60 * 1000)]) : AbortSignal.timeout(18 * 60 * 1000);
  signal.throwIfAborted();
  const notify = event => { try { onProgress(event); } catch {} };
  const staging = await fs.mkdtemp(path.join(directory, 'sketchfab-')), archive = path.join(staging, 'archive.zip'), root = path.join(staging, 'model');
  try {
    await fs.mkdir(root);
    const response = await downloadArchive({ url: archiveUrl, destination: archive, signal, maxBytes: bounds.compressedBytes, onProgress: notify,
      validateUrl: value => validateSketchfabArchiveUrl(value instanceof URL ? value.href : value, modelId) });
    signal.throwIfAborted();
    if (response?.url) validateSketchfabArchiveUrl(response.url instanceof URL ? response.url.href : response.url, modelId);
    const stat = await fs.lstat(archive);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw issue('模型下载没有返回 ZIP 文件。');
    if (stat.size > bounds.compressedBytes) throw issue('模型 ZIP 超过下载大小上限。', 'SKETCHFAB_ARCHIVE_TOO_LARGE');
    const files = await extractZip(archive, root, bounds, signal, notify);
    const candidates = files.filter(file => /\.(?:gltf|glb)$/i.test(file));
    if (candidates.length !== 1) throw issue(candidates.length ? '模型 ZIP 包含多个模型入口，无法确定要导入的模型。' : '模型 ZIP 中没有 glTF 或 GLB 模型。', 'SKETCHFAB_MODEL_AMBIGUOUS');
    const entryPath = path.join(root, ...candidates[0].split('/'));
    notify({ phase: 'verifying' });
    const plan = await collectModelBundle(entryPath, { allowedRoots: [root], signal });
    if (plan.missing.length) throw issue('模型 ZIP 缺少模型引用的贴图或二进制文件。', 'SKETCHFAB_MODEL_INCOMPLETE');
    const attributionBytes = Buffer.from(JSON.stringify(provenance, null, 2) + '\n');
    const expanded = (await Promise.all(files.map(file => fs.stat(path.join(root, ...file.split('/')))))).reduce((total, info) => total + info.size, 0);
    if (expanded + attributionBytes.length > bounds.expandedBytes || files.length + 1 > bounds.files) throw issue('模型包连同署名信息超过大小或文件数量上限。', 'SKETCHFAB_ARCHIVE_TOO_LARGE');
    await fs.writeFile(path.join(root, ATTRIBUTION_FILE), attributionBytes, { flag: 'wx', mode: 0o600 });
    await fs.unlink(archive);
    return { entryPath, root, files: [...files, ATTRIBUTION_FILE].sort(), modelId, pageUrl, attribution: provenance };
  } catch (error) {
    if (path.dirname(staging) === directory && path.basename(staging).startsWith('sketchfab-')) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (signal.aborted) throw signal.reason;
    if (error.code?.startsWith('SKETCHFAB_')) throw error;
    throw issue('Sketchfab 模型下载或校验失败，请重试。', 'SKETCHFAB_DOWNLOAD_FAILED');
  }
}

function checkedSketchfabPage(modelId, pageUrl) { return modelPage(pageUrl, checkModelId(modelId)); }
function checkedSketchfabArchiveUrl(modelId, url) { return new URL(validateSketchfabArchiveUrl(url, modelId)); }

module.exports = { stageSketchfabModel, validateSketchfabArchiveUrl, checkedSketchfabPage, checkedSketchfabArchiveUrl, DEFAULT_LIMITS };
