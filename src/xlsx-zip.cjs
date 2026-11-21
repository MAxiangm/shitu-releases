'use strict';
const { inflateRawSync, deflateRawSync } = require('node:zlib');
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function safeName(name) {
  const clean = name.endsWith('/') ? name.slice(0, -1) : name;
  return clean && clean.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(clean) && !clean.startsWith('/') && clean.split('/').every(part => part && part !== '.' && part !== '..');
}
function extras(bytes) {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw new Error('XLSX ZIP 扩展字段无效');
    const type = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2);
    if (type === 1 || offset + 4 + length > bytes.length) throw new Error('不支持 ZIP64 或损坏的 XLSX 扩展字段');
    offset += 4 + length;
  }
}
function readZip(input) {
  if (!Buffer.isBuffer(input)) input = Buffer.from(input);
  if (input.length < 22 || input.length > MAX_BYTES || input.readUInt32LE(0) !== 0x04034b50) throw new Error('XLSX ZIP 文件无效或超过 16 MB');
  let end = -1;
  for (let offset = input.length - 22; offset >= Math.max(0, input.length - 65557); offset--) {
    if (input.readUInt32LE(offset) === 0x06054b50 && offset + 22 + input.readUInt16LE(offset + 20) === input.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('XLSX ZIP 中央目录缺失');
  const count = input.readUInt16LE(end + 10), centralSize = input.readUInt32LE(end + 12), centralOffset = input.readUInt32LE(end + 16);
  if (!count || count > MAX_ENTRIES || input.readUInt16LE(end + 4) || input.readUInt16LE(end + 6) || count !== input.readUInt16LE(end + 8) || centralOffset + centralSize !== end) throw new Error('不支持分卷、ZIP64 或超限 XLSX ZIP');
  const entries = [], names = new Set(), spans = [];
  let offset = centralOffset, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || input.readUInt32LE(offset) !== 0x02014b50) throw new Error('XLSX ZIP 中央目录无效');
    const flags = input.readUInt16LE(offset + 8), method = input.readUInt16LE(offset + 10), crc = input.readUInt32LE(offset + 16);
    const compressed = input.readUInt32LE(offset + 20), size = input.readUInt32LE(offset + 24);
    const nameLength = input.readUInt16LE(offset + 28), extraLength = input.readUInt16LE(offset + 30), commentLength = input.readUInt16LE(offset + 32);
    const externalAttributes = input.readUInt32LE(offset + 38), localOffset = input.readUInt32LE(offset + 42);
    const fileType = externalAttributes >>> 16 & 0xf000;
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || nameLength > 1024 || next > end || input.readUInt16LE(offset + 34) || flags & ~0x080e || ![0, 8].includes(method) || [compressed, size, localOffset].includes(0xffffffff) || fileType && ![0x8000, 0x4000].includes(fileType)) throw new Error('XLSX ZIP 包含加密、链接或不支持的条目');
    const nameBytes = input.subarray(offset + 46, offset + 46 + nameLength);
    let name;
    try { name = decoder.decode(nameBytes); } catch { throw new Error('XLSX ZIP 文件名不是有效 UTF-8'); }
    const nameKey = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
    if (!safeName(name) || names.has(nameKey)) throw new Error('XLSX ZIP 包含不安全或重复路径');
    names.add(nameKey);
    if ((expanded += size) > MAX_BYTES || compressed > MAX_BYTES) throw new Error('XLSX ZIP 展开后超过 16 MB');
    const extra = input.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength); extras(extra);
    if (localOffset + 30 > centralOffset || input.readUInt32LE(localOffset) !== 0x04034b50 || input.readUInt16LE(localOffset + 6) !== flags || input.readUInt16LE(localOffset + 8) !== method) throw new Error('XLSX ZIP 本地条目无效');
    const localNameLength = input.readUInt16LE(localOffset + 26), localExtraLength = input.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressed > centralOffset || localNameLength !== nameLength || !input.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) throw new Error('XLSX ZIP 本地路径或数据范围无效');
    const localExtra = input.subarray(localOffset + 30 + localNameLength, dataOffset); extras(localExtra);
    if (!(flags & 8) && (input.readUInt32LE(localOffset + 14) !== crc || input.readUInt32LE(localOffset + 18) !== compressed || input.readUInt32LE(localOffset + 22) !== size)) throw new Error('XLSX ZIP 本地校验值不一致');
    let entryEnd = dataOffset + compressed;
    if (flags & 8) {
      const skip = entryEnd + 4 <= centralOffset && input.readUInt32LE(entryEnd) === 0x08074b50 ? 4 : 0;
      if (entryEnd + skip + 12 > centralOffset || input.readUInt32LE(entryEnd + skip) !== crc || input.readUInt32LE(entryEnd + skip + 4) !== compressed || input.readUInt32LE(entryEnd + skip + 8) !== size) throw new Error('XLSX ZIP 数据描述无效');
      entryEnd += skip + 12;
    }
    const packed = input.subarray(dataOffset, dataOffset + compressed);
    let data;
    try { data = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(1, Math.min(MAX_BYTES, size + 1)) }); }
    catch { throw new Error('XLSX ZIP 解压失败或实际大小超限'); }
    if (data.length !== size || crc32(data) !== crc || name.endsWith('/') && size) throw new Error('XLSX ZIP 长度或 CRC 校验失败');
    entries.push({ name, data, method, flags: flags & ~8, time: input.readUInt16LE(offset + 12), date: input.readUInt16LE(offset + 14), versionMadeBy: input.readUInt16LE(offset + 4), versionNeeded: input.readUInt16LE(offset + 6), externalAttributes, extra: Buffer.from(extra), localExtra: Buffer.from(localExtra), comment: Buffer.from(input.subarray(next - commentLength, next)) });
    spans.push([localOffset, entryEnd]); offset = next;
  }
  if (offset !== end) throw new Error('XLSX ZIP 中央目录长度不一致');
  spans.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < spans.length; index++) if (spans[index][0] < spans[index - 1][1]) throw new Error('XLSX ZIP 条目重叠');
  for (const entry of entries) {
    const parts = entry.name.replace(/\/$/, '').split('/');
    for (let index = 1; index < parts.length; index++) if (entries.some(other => other.name === parts.slice(0, index).join('/'))) throw new Error('XLSX ZIP 文件与目录路径冲突');
  }
  return { entries, comment: Buffer.from(input.subarray(end + 22)) };
}
function writeZip(archive) {
  const entries = Array.isArray(archive) ? archive : archive.entries;
  const archiveComment = Buffer.from(archive.comment || []);
  if (!entries?.length || entries.length > MAX_ENTRIES || archiveComment.length > 65535) throw new Error('XLSX ZIP 条目数量无效');
  const locals = [], centrals = [], names = new Set(); let position = 0, expanded = 0;
  for (const entry of entries) {
    if (!safeName(entry.name) || names.has(entry.name.toLowerCase())) throw new Error('XLSX ZIP 输出路径无效');
    names.add(entry.name.toLowerCase());
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), extra = Buffer.from(entry.extra || []), localExtra = Buffer.from(entry.localExtra || []), comment = Buffer.from(entry.comment || []);
    if ((expanded += data.length) > MAX_BYTES || [name.length, extra.length, localExtra.length, comment.length].some(value => value > 65535)) throw new Error('XLSX ZIP 输出超过 16 MB');
    extras(extra); extras(localExtra);
    const method = entry.method ?? 8;
    if (![0, 8].includes(method)) throw new Error('XLSX ZIP 压缩方式无效');
    const packed = method === 0 ? data : deflateRawSync(data), crc = crc32(data), flags = (entry.flags || 0) & 0x0806;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(entry.versionNeeded || 20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(entry.time || 0, 10); local.writeUInt16LE(entry.date || 0, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(localExtra.length, 28);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(entry.versionMadeBy || 20, 4); central.writeUInt16LE(entry.versionNeeded || 20, 6); local.copy(central, 8, 6, 26); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt16LE(comment.length, 32); central.writeUInt32LE(entry.externalAttributes || 0, 38); central.writeUInt32LE(position, 42);
    locals.push(local, name, localExtra, packed); centrals.push(central, name, extra, comment); position += local.length + name.length + localExtra.length + packed.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(position, 16); end.writeUInt16LE(archiveComment.length, 20);
  if (position + central.length + end.length + archiveComment.length > MAX_BYTES) throw new Error('XLSX ZIP 输出超过 16 MB');
  return Buffer.concat([...locals, central, end, archiveComment]);
}
module.exports = { readZip, writeZip, crc32, MAX_BYTES };
