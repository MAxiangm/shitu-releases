'use strict';
// OpenType/TTC table offsets are relative to the beginning of the file.
// https://learn.microsoft.com/en-us/typography/opentype/spec/otff
// WOFF 1 table lengths are bounded before zlib inflation.
// https://www.w3.org/TR/WOFF/
const zlib = require('node:zlib');
const MAX_FONT_BYTES = 128 * 1024 * 1024;
const MAX_FACES = 128;
const MAX_TABLES = 512;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565]);
function invalid(message = '字体文件结构无效或不受支持') { return new Error(message); }
function range(buffer, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > buffer.length - length) throw invalid();
}
function count(value, maximum) { if (!Number.isInteger(value) || value < 1 || value > maximum) throw invalid(); return value; }
function text(value, fallback = '') { return String(value || fallback).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 160); }
function tagAt(buffer, offset) { range(buffer, offset, 4); const tag = buffer.toString('ascii', offset, offset + 4); if (!/^[\x20-\x7e]{4}$/.test(tag)) throw invalid(); return tag; }
function sfntTables(buffer, start) {
  range(buffer, start, 12);
  const flavor = buffer.readUInt32BE(start);
  if (!SFNT_VERSIONS.has(flavor)) throw invalid();
  const size = count(buffer.readUInt16BE(start + 4), MAX_TABLES);
  range(buffer, start + 12, size * 16);
  const tables = new Map();
  for (let index = 0; index < size; index++) {
    const record = start + 12 + index * 16;
    const tag = tagAt(buffer, record), offset = buffer.readUInt32BE(record + 8), length = buffer.readUInt32BE(record + 12);
    range(buffer, offset, length);
    if (tables.has(tag)) throw invalid();
    tables.set(tag, { offset, length, read: () => buffer.subarray(offset, offset + length) });
  }
  return { flavor, tables };
}
function woffTables(buffer) {
  range(buffer, 0, 44);
  const flavor = buffer.readUInt32BE(4), size = count(buffer.readUInt16BE(12), MAX_TABLES);
  if (!SFNT_VERSIONS.has(flavor) || buffer.readUInt32BE(8) !== buffer.length || buffer.readUInt16BE(14) !== 0 || buffer.readUInt32BE(16) > MAX_FONT_BYTES) throw invalid();
  range(buffer, 44, size * 20);
  const tables = new Map();
  for (let index = 0; index < size; index++) {
    const record = 44 + index * 20, tag = tagAt(buffer, record), offset = buffer.readUInt32BE(record + 4);
    const compressed = buffer.readUInt32BE(record + 8), length = buffer.readUInt32BE(record + 12);
    range(buffer, offset, compressed);
    if (compressed > length || length > MAX_FONT_BYTES || tables.has(tag)) throw invalid();
    tables.set(tag, { offset, length, read: () => {
      if (length > MAX_METADATA_BYTES) throw invalid('字体元信息过大');
      const input = buffer.subarray(offset, offset + compressed);
      if (compressed === length) return input;
      const inflated = zlib.inflateSync(input, { maxOutputLength: length });
      if (inflated.length !== length) throw invalid();
      return inflated;
    } });
  }
  return { flavor, tables };
}
function smallTable(tables, tag) {
  const table = tables.get(tag);
  if (!table || table.length > MAX_METADATA_BYTES) return null;
  return table.read();
}
function nameMetadata(tables, fallback) {
  const names = new Map(), table = smallTable(tables, 'name');
  if (table) {
    range(table, 0, 6);
    const amount = table.readUInt16BE(2), storage = table.readUInt16BE(4);
    if (amount > 4096) throw invalid('字体名称条目过多');
    range(table, 6, amount * 12);
    for (let index = 0; index < amount; index++) {
      const record = 6 + index * 12, platform = table.readUInt16BE(record), encoding = table.readUInt16BE(record + 2);
      const language = table.readUInt16BE(record + 4), id = table.readUInt16BE(record + 6), length = table.readUInt16BE(record + 8);
      const offset = storage + table.readUInt16BE(record + 10);
      if (![1, 2, 4, 6, 16, 17].includes(id) || length > 4096) continue;
      range(table, offset, length);
      let value;
      if (platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding))) {
        if (length % 2) continue;
        const bytes = Buffer.from(table.subarray(offset, offset + length)); bytes.swap16(); value = bytes.toString('utf16le');
      } else if (platform === 1) value = new TextDecoder('macintosh').decode(table.subarray(offset, offset + length));
      else continue;
      value = text(value);
      const priority = (platform === 3 ? 30 : platform === 0 ? 20 : 0) + (language === 0x409 ? 5 : language === 0x804 ? 4 : 0);
      if (value && (!names.has(id) || names.get(id).priority < priority)) names.set(id, { value, priority });
    }
  }
  const get = id => names.get(id)?.value;
  const family = text(get(16) || get(1), fallback), style = text(get(17) || get(2), 'Regular');
  return { family, style, fullName: text(get(4), `${family} ${style}`), ...(get(6) ? { postscriptName: get(6) } : {}) };
}
function cmapReader(tables) {
  const buffer = smallTable(tables, 'cmap');
  if (!buffer) return null;
  range(buffer, 0, 4);
  const amount = buffer.readUInt16BE(2);
  if (amount > 512) throw invalid();
  range(buffer, 4, amount * 8);
  const candidates = [];
  for (let index = 0; index < amount; index++) {
    const record = 4 + index * 8, platform = buffer.readUInt16BE(record), encoding = buffer.readUInt16BE(record + 2);
    if (platform !== 0 && !(platform === 3 && [0, 1, 10].includes(encoding))) continue;
    const offset = buffer.readUInt32BE(record + 4); range(buffer, offset, 2);
    const format = buffer.readUInt16BE(offset);
    if (format === 12) {
      range(buffer, offset, 16); const length = buffer.readUInt32BE(offset + 4), groups = buffer.readUInt32BE(offset + 12);
      if (groups > 100000 || length < 16 + groups * 12) throw invalid();
      range(buffer, offset, length);
      let previousEnd = -1;
      for (let group = 0; group < groups; group++) {
        const at = offset + 16 + group * 12, start = buffer.readUInt32BE(at), end = buffer.readUInt32BE(at + 4);
        if (start > end || start <= previousEnd || end > 0x10ffff) throw invalid();
        previousEnd = end;
      }
      candidates.push({ priority: 12, supports: code => {
        let low = 0, high = groups - 1;
        while (low <= high) { const mid = (low + high) >>> 1, pos = offset + 16 + mid * 12, start = buffer.readUInt32BE(pos), end = buffer.readUInt32BE(pos + 4);
          if (code < start) high = mid - 1; else if (code > end) low = mid + 1; else return buffer.readUInt32BE(pos + 8) + code - start > 0; }
        return false;
      } });
    } else if (format === 4) {
      range(buffer, offset, 14); const length = buffer.readUInt16BE(offset + 2), segments = buffer.readUInt16BE(offset + 6) / 2;
      if (!Number.isInteger(segments) || !segments || segments > 8192 || length < 16 + segments * 8) throw invalid();
      range(buffer, offset, length);
      const ends = offset + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
      let previousEnd = -1;
      for (let index = 0; index < segments; index++) {
        const end = buffer.readUInt16BE(ends + index * 2);
        if (end < buffer.readUInt16BE(starts + index * 2) || end < previousEnd) throw invalid();
        previousEnd = end;
      }
      candidates.push({ priority: 4, supports: code => {
        if (code > 0xffff) return false;
        let low = 0, high = segments - 1;
        while (low <= high) {
          const index = (low + high) >>> 1;
          if (code > buffer.readUInt16BE(ends + index * 2)) { low = index + 1; continue; }
          const start = buffer.readUInt16BE(starts + index * 2); if (code < start) { high = index - 1; continue; }
          const delta = buffer.readInt16BE(deltas + index * 2), value = buffer.readUInt16BE(ranges + index * 2);
          if (!value) return ((code + delta) & 0xffff) !== 0;
          const address = ranges + index * 2 + value + (code - start) * 2;
          if (address < offset || address + 2 > offset + length) return false;
          const glyph = buffer.readUInt16BE(address); return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
        }
        return false;
      } });
    }
  }
  return candidates.sort((a, b) => b.priority - a.priority)[0]?.supports || null;
}
function sampleFor(tables) {
  const supports = cmapReader(tables);
  if (!supports) return 'Aa Bb Cc 0123456789';
  for (const sample of ['Mosaic 字体预览', '字体预览', 'Aa Bb Cc 0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789']) {
    if ([...sample].filter(value => value !== ' ').every(value => supports(value.codePointAt(0)))) return sample;
  }
  let result = '';
  // Bounded fallback for symbol and non-Latin fonts; avoid rendering only .notdef boxes.
  for (let code = 0x21; code <= 0x4000 && result.length < 16; code++) if (supports(code)) result += String.fromCodePoint(code);
  return result || 'Aa 0123';
}
function parseFont(buffer, { fallbackName = '未命名字体' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_FONT_BYTES) throw invalid('字体文件过大或数据无效');
  range(buffer, 0, 4);
  const magic = buffer.toString('ascii', 0, 4), fallback = text(fallbackName, '未命名字体');
  let definitions, format;
  if (magic === 'ttcf') {
    range(buffer, 0, 12); const version = buffer.readUInt32BE(4), amount = count(buffer.readUInt32BE(8), MAX_FACES);
    if (![0x10000, 0x20000].includes(version)) throw invalid();
    range(buffer, 12, amount * 4); definitions = Array.from({ length: amount }, (_, index) => sfntTables(buffer, buffer.readUInt32BE(12 + index * 4))); format = 'ttc';
  } else if (magic === 'wOFF') { definitions = [woffTables(buffer)]; format = 'woff'; }
  else if (magic === 'wOF2') {
    range(buffer, 0, 48);
    if (buffer.readUInt32BE(8) !== buffer.length || buffer.readUInt16BE(14) !== 0 || buffer.readUInt32BE(16) > MAX_FONT_BYTES || buffer.readUInt32BE(20) > buffer.length - 48) throw invalid();
    count(buffer.readUInt16BE(12), MAX_TABLES);
    // Chromium decodes the transformed tables; do not pretend filename metadata
    // was read from a WOFF2 name table.
    const face = { index: 0, family: fallback, style: 'Regular', fullName: fallback, sampleText: 'Aa Bb Cc 0123456789', metadataFromFilename: true };
    return { format: 'woff2', faces: [face], definitions: [] };
  } else { definitions = [sfntTables(buffer, 0)]; format = definitions[0].flavor === 0x4f54544f ? 'otf' : 'ttf'; }
  const faces = definitions.map((definition, index) => ({ index, ...nameMetadata(definition.tables, fallback), sampleText: sampleFor(definition.tables) }));
  return { format, faces, definitions };
}
function checksum(buffer) { let sum = 0; for (let index = 0; index < buffer.length; index += 4) { let word = 0; for (let byte = 0; byte < 4; byte++) word = (word * 256 + (buffer[index + byte] || 0)) >>> 0; sum = (sum + word) >>> 0; } return sum; }
function extractCollectionFace(buffer, index = 0) {
  const parsed = parseFont(buffer);
  if (parsed.format !== 'ttc' || !Number.isInteger(index) || index < 0 || index >= parsed.faces.length) throw invalid('字体集合中的字型不存在');
  const definition = parsed.definitions[index];
  const tables = [...definition.tables].filter(([tag]) => tag !== 'DSIG').sort(([left], [right]) => left.localeCompare(right, 'en'));
  count(tables.length, MAX_TABLES);
  const align = value => Math.ceil(value / 4) * 4;
  const headerLength = 12 + tables.length * 16, total = tables.reduce((value, [, table]) => value + align(table.length), headerLength);
  if (total > MAX_FONT_BYTES) throw invalid('字体集合中的字型过大');
  const output = Buffer.alloc(total); output.writeUInt32BE(definition.flavor, 0); output.writeUInt16BE(tables.length, 4);
  const power = Math.floor(Math.log2(tables.length)); output.writeUInt16BE(16 * 2 ** power, 6); output.writeUInt16BE(power, 8); output.writeUInt16BE(tables.length * 16 - 16 * 2 ** power, 10);
  let position = headerLength, headOffset;
  tables.forEach(([tag, table], tableIndex) => {
    const record = 12 + tableIndex * 16, data = Buffer.from(table.read());
    if (tag === 'head') { if (data.length < 12) throw invalid(); data.writeUInt32BE(0, 8); headOffset = position; }
    output.write(tag, record, 4, 'ascii'); output.writeUInt32BE(checksum(data), record + 4); output.writeUInt32BE(position, record + 8); output.writeUInt32BE(data.length, record + 12);
    data.copy(output, position); position += align(data.length);
  });
  if (headOffset !== undefined) output.writeUInt32BE((0xb1b0afba - checksum(output)) >>> 0, headOffset + 8);
  return { buffer: output, format: definition.flavor === 0x4f54544f ? 'otf' : 'ttf', face: parsed.faces[index] };
}
module.exports = { MAX_FONT_BYTES, MAX_FACES, parseFont, extractCollectionFace, checksum };
