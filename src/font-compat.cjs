'use strict';

const { parseFont, extractCollectionFace, checksum, MAX_FONT_BYTES } = require('./font-metadata.cjs');
const align4 = value => Math.ceil(value / 4) * 4;

function rebuildSfnt(definition, overrides, omitted) {
  const entries = [...definition.tables]
    .filter(([tag]) => tag !== 'DSIG' && !omitted.has(tag))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([tag, table]) => [tag, overrides.get(tag) || table.read()]);
  const headerLength = 12 + entries.length * 16;
  const length = entries.reduce((total, [, data]) => total + align4(data.length), headerLength);
  if (!entries.length || length > MAX_FONT_BYTES) throw new Error('字体兼容预览数据大小无效');
  const output = Buffer.alloc(length);
  output.writeUInt32BE(definition.flavor, 0);
  output.writeUInt16BE(entries.length, 4);
  const power = Math.floor(Math.log2(entries.length));
  output.writeUInt16BE(16 * 2 ** power, 6);
  output.writeUInt16BE(power, 8);
  output.writeUInt16BE(entries.length * 16 - 16 * 2 ** power, 10);
  let offset = headerLength, headOffset;
  for (let index = 0; index < entries.length; index++) {
    const [tag, original] = entries[index], data = Buffer.from(original);
    if (tag === 'head') {
      if (data.length < 12) throw new Error('字体头部数据无效');
      data.writeUInt32BE(0, 8); headOffset = offset;
    }
    const at = 12 + index * 16;
    output.write(tag, at, 4, 'ascii');
    output.writeUInt32BE(checksum(data), at + 4);
    output.writeUInt32BE(offset, at + 8);
    output.writeUInt32BE(data.length, at + 12);
    data.copy(output, offset); offset += align4(data.length);
  }
  if (headOffset === undefined) throw new Error('字体缺少必要的头部数据');
  output.writeUInt32BE((0xb1b0afba - checksum(output)) >>> 0, headOffset + 8);
  return output;
}

// Only normalize legacy optional vertical metrics. The original font is never
// written or changed, and required table bounds still pass through parseFont.
function prepareFontPreview(buffer, faceIndex = 0) {
  const parsed = parseFont(buffer);
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= parsed.faces.length) {
    throw new Error('字体集合中的字型不存在');
  }
  let preview = buffer, format = parsed.format, definition = parsed.definitions[0];
  if (parsed.format === 'woff' || parsed.format === 'woff2') return { buffer, format, repaired: false, repairs: [] };
  if (parsed.format === 'ttc') {
    const extracted = extractCollectionFace(buffer, faceIndex);
    preview = extracted.buffer; format = extracted.format;
    definition = parseFont(preview).definitions[0];
  }
  const tables = definition.tables, header = tables.get('vhea'), metrics = tables.get('vmtx');
  if (!header && !metrics) return { buffer: preview, format, repaired: false, repairs: [] };
  const overrides = new Map(), omitted = new Set(), repairs = [];
  let invalid = !header || !metrics || header.length < 36;
  let legacyVersion = false;
  if (!invalid) {
    const data = header.read(), version = data.readUInt32BE(0);
    const maximum = tables.get('maxp');
    if (!maximum || maximum.length < 6 || !maximum.read().readUInt16BE(4)) {
      throw new Error('字体缺少有效的字形数量数据');
    }
    const glyphCount = maximum.read().readUInt16BE(4), longCount = data.readUInt16BE(34);
    legacyVersion = version === 0x00010001;
    invalid = (![0x00010000, 0x00011000].includes(version) && !legacyVersion) || data.readInt16BE(32) !== 0 ||
      longCount < 1 || longCount > glyphCount || metrics.length < longCount * 4 + (glyphCount - longCount) * 2;
    if (!invalid && legacyVersion) {
      const normalized = Buffer.from(data); normalized.writeUInt32BE(0x00011000, 0);
      overrides.set('vhea', normalized); repairs.push('vhea-version-normalized');
    }
  }
  if (invalid) {
    omitted.add('vhea'); omitted.add('vmtx'); repairs.push('vertical-metrics-dropped');
  }
  if (!repairs.length) return { buffer: preview, format, repaired: false, repairs };
  return { buffer: rebuildSfnt(definition, overrides, omitted), format, repaired: true, repairs };
}

module.exports = { prepareFontPreview };
