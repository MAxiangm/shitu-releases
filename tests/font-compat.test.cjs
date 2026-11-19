'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareFontPreview } = require('../src/font-compat.cjs');
const { createFontService } = require('../src/font-service.cjs');
const { parseFont, checksum } = require('../src/font-metadata.cjs');
const align4 = value => Math.ceil(value / 4) * 4;

function fixture({ version = 0x10000, metricsLength = 8, longCount = 1, metricFormat = 0,
  omit = [], headerLength = 36, marker = 'glyph-data', flavor = 0x10000 } = {}) {
  const head = Buffer.alloc(54); head.writeUInt32BE(0x10000); head.writeUInt32BE(0x5f0f3cf5, 12);
  const maxp = Buffer.alloc(32); maxp.writeUInt32BE(0x10000); maxp.writeUInt16BE(3, 4);
  const vhea = Buffer.alloc(Math.max(36, headerLength)); vhea.writeUInt32BE(version); vhea.writeInt16BE(metricFormat, 32); vhea.writeUInt16BE(longCount, 34);
  const hhea = Buffer.alloc(36); hhea.writeUInt32BE(0x10000); hhea.writeUInt16BE(3, 34);
  const entries = [['head', head], ['maxp', maxp], ['hhea', hhea], ['hmtx', Buffer.alloc(12)], ['glyf', Buffer.from(marker)],
    ['vhea', vhea.subarray(0, headerLength)], ['vmtx', Buffer.alloc(metricsLength)], ['DSIG', Buffer.from('sign')]]
    .filter(([tag]) => !omit.includes(tag)).sort(([a], [b]) => a < b ? -1 : 1);
  const output = Buffer.alloc(12 + entries.length * 16 + entries.reduce((sum, [, data]) => sum + align4(data.length), 0));
  output.writeUInt32BE(flavor); output.writeUInt16BE(entries.length, 4);
  const power = Math.floor(Math.log2(entries.length)); output.writeUInt16BE(16 * 2 ** power, 6); output.writeUInt16BE(power, 8); output.writeUInt16BE(entries.length * 16 - 16 * 2 ** power, 10);
  let offset = 12 + entries.length * 16, headOffset;
  entries.forEach(([tag, data], index) => {
    const at = 12 + index * 16; output.write(tag, at, 4, 'ascii'); output.writeUInt32BE(checksum(data), at + 4);
    output.writeUInt32BE(offset, at + 8); output.writeUInt32BE(data.length, at + 12); data.copy(output, offset);
    if (tag === 'head') headOffset = offset; offset += align4(data.length);
  });
  output.writeUInt32BE((0xb1b0afba - checksum(output)) >>> 0, headOffset + 8); return output;
}
function collection(fonts) {
  const header = align4(12 + fonts.length * 4), output = Buffer.alloc(header + fonts.reduce((sum, font) => sum + align4(font.length), 0));
  output.write('ttcf'); output.writeUInt32BE(0x10000, 4); output.writeUInt32BE(fonts.length, 8);
  let offset = header;
  fonts.forEach((font, index) => {
    const data = Buffer.from(font); output.writeUInt32BE(offset, 12 + index * 4);
    for (let entry = 0; entry < data.readUInt16BE(4); entry++) { const at = 12 + entry * 16 + 8; data.writeUInt32BE(data.readUInt32BE(at) + offset, at); }
    data.copy(output, offset); offset += align4(data.length);
  });
  return output;
}
function woff(font) {
  const entries = [...parseFont(font).definitions[0].tables], headerLength = 44 + entries.length * 20;
  const output = Buffer.alloc(headerLength + entries.reduce((sum, [, table]) => sum + align4(table.length), 0));
  output.write('wOFF'); output.writeUInt32BE(font.readUInt32BE(0), 4); output.writeUInt32BE(output.length, 8);
  output.writeUInt16BE(entries.length, 12); output.writeUInt32BE(font.length, 16);
  let offset = headerLength;
  entries.forEach(([tag, table], index) => {
    const at = 44 + index * 20; output.write(tag, at, 4, 'ascii'); output.writeUInt32BE(offset, at + 4);
    output.writeUInt32BE(table.length, at + 8); output.writeUInt32BE(table.length, at + 12);
    output.writeUInt32BE(checksum(table.read()), at + 16); table.read().copy(output, offset); offset += align4(table.length);
  });
  return output;
}
const tables = font => parseFont(font).definitions[0].tables;

test('healthy sfnt fonts retain their exact Buffer and signatures', () => {
  for (const options of [{}, { version: 0x11000 }, { omit: ['vhea', 'vmtx'] }, { flavor: 0x4f54544f }]) {
    const original = fixture(options), result = prepareFontPreview(original);
    assert.equal(result.buffer, original); assert.equal(result.repaired, false); assert.deepEqual(result.repairs, []);
    assert.equal(result.format, options.flavor ? 'otf' : 'ttf'); assert.ok(tables(result.buffer).has('DSIG'));
  }
});
test('truncated vertical metrics are dropped only from a rebuilt preview with valid checksums', () => {
  const original = fixture({ metricsLength: 6 }), before = Buffer.from(original), result = prepareFontPreview(original);
  assert.equal(result.repaired, true); assert.deepEqual(result.repairs, ['vertical-metrics-dropped']);
  const normalized = tables(result.buffer), source = tables(original);
  for (const tag of ['vhea', 'vmtx', 'DSIG']) assert.equal(normalized.has(tag), false);
  for (const tag of ['maxp', 'hhea', 'hmtx', 'glyf']) assert.deepEqual(normalized.get(tag).read(), source.get(tag).read());
  assert.deepEqual(original, before); assert.equal(checksum(result.buffer), 0xb1b0afba);
  for (let index = 0; index < result.buffer.readUInt16BE(4); index++) {
    const at = 12 + index * 16, tag = result.buffer.toString('ascii', at, at + 4), data = Buffer.from(normalized.get(tag).read());
    if (tag === 'head') data.writeUInt32BE(0, 8);
    assert.equal(checksum(data), result.buffer.readUInt32BE(at + 4)); assert.equal(result.buffer.readUInt32BE(at + 8) % 4, 0);
  }
});
test('known legacy vertical-header version is normalized without changing its metrics', () => {
  const original = fixture({ version: 0x10001 }), before = Buffer.from(original), result = prepareFontPreview(original);
  assert.deepEqual(result.repairs, ['vhea-version-normalized']); assert.equal(tables(result.buffer).get('vhea').read().readUInt32BE(0), 0x11000);
  assert.deepEqual(tables(result.buffer).get('vhea').read().subarray(4), tables(original).get('vhea').read().subarray(4));
  assert.deepEqual(tables(result.buffer).get('vmtx').read(), tables(original).get('vmtx').read());
  assert.deepEqual(original, before); assert.equal(checksum(result.buffer), 0xb1b0afba); assert.equal(tables(result.buffer).has('DSIG'), false);
});
test('invalid optional vertical pairs are consistently omitted', () => {
  for (const options of [{ omit: ['vhea'] }, { omit: ['vmtx'] }, { headerLength: 34 }, { longCount: 0 }, { longCount: 4 }, { metricFormat: 1 }, { version: 0x20000 }]) {
    const result = prepareFontPreview(fixture(options)); assert.equal(result.repaired, true);
    assert.equal(tables(result.buffer).has('vhea'), false); assert.equal(tables(result.buffer).has('vmtx'), false);
  }
});
test('selected TTC face is extracted before compatibility processing', () => {
  const original = collection([fixture({ marker: 'first' }), fixture({ marker: 'second', metricsLength: 6, flavor: 0x4f54544f })]), before = Buffer.from(original);
  const first = prepareFontPreview(original, 0), second = prepareFontPreview(original, 1);
  assert.equal(first.format, 'ttf'); assert.equal(first.repaired, false); assert.equal(tables(first.buffer).get('glyf').read().toString(), 'first');
  assert.equal(second.format, 'otf'); assert.equal(second.repaired, true); assert.equal(tables(second.buffer).get('glyf').read().toString(), 'second');
  assert.deepEqual(original, before); assert.throws(() => prepareFontPreview(original, 2), /字型不存在/);
});
test('invalid required-table bounds and invalid face requests are still rejected', () => {
  const original = fixture({ metricsLength: 6 });
  const badOffset = Buffer.from(original);
  for (let index = 0; index < badOffset.readUInt16BE(4); index++) {
    const at = 12 + index * 16; if (badOffset.toString('ascii', at, at + 4) === 'glyf') badOffset.writeUInt32BE(0xffffffff, at + 8);
  }
  assert.throws(() => prepareFontPreview(badOffset), /结构无效/);
  assert.throws(() => prepareFontPreview(fixture({ omit: ['maxp'] })), /字形数量/);
  for (const face of [-1, 1, 0.5, NaN]) assert.throws(() => prepareFontPreview(original, face), /字型不存在/);
});
test('WOFF containers pass through unchanged and do not receive sfnt repairs', () => {
  const woff2 = Buffer.alloc(48); woff2.write('wOF2'); woff2.writeUInt32BE(0x10000, 4); woff2.writeUInt32BE(48, 8); woff2.writeUInt16BE(1, 12); woff2.writeUInt32BE(128, 16);
  for (const [original, format] of [[woff(fixture({ metricsLength: 6 })), 'woff'], [woff2, 'woff2']]) {
    const result = prepareFontPreview(original); assert.equal(result.buffer, original); assert.equal(result.format, format); assert.equal(result.repaired, false);
    assert.throws(() => prepareFontPreview(original, 1), /字型不存在/);
  }
});

test('font service serves repaired preview bytes while retaining the original file and asset hash', async t => {
  const directory = path.resolve(__dirname, '../.recovery/tests');
  await fs.mkdir(directory, { recursive: true });
  const base = await fs.mkdtemp(path.join(directory, 'compat-service-'));
  t.after(async () => { assert.ok(path.relative(directory, base).startsWith('compat-service-')); await fs.rm(base, { recursive: true, force: true }); });
  const original = fixture({ metricsLength: 6 }), source = path.join(base, 'legacy.ttf');
  await fs.writeFile(source, original);
  const hash = crypto.createHash('sha256').update(original).digest('hex');
  const asset = { id: 'legacy-font', ext: 'ttf', name: 'Legacy', hash };
  const library = { root: base, snapshot: () => ({ assets: [asset] }), getAssetPath: () => source };
  const service = createFontService({ BrowserWindow: class {}, cacheDir: path.join(base, 'cache'), getLibrary: () => library });
  t.after(() => service.shutdown());
  const prepared = await service.prepare(library, asset.id, base);
  assert.equal(prepared.compatibility, true);
  const response = await service.response(new Request(prepared.url));
  assert.equal(response.status, 200);
  const preview = Buffer.from(await response.arrayBuffer());
  assert.equal(tables(preview).has('vmtx'), false);
  assert.equal(checksum(preview), 0xb1b0afba);
  assert.deepEqual(await fs.readFile(source), original); assert.equal(asset.hash, hash);
  assert.equal((await service.prepare(library, asset.id, base)).compatibility, true);
});
