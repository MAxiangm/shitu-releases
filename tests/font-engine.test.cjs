'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { parseFont, extractCollectionFace, checksum, MAX_FONT_BYTES } = require('../src/font-metadata.cjs');
const { createFontService } = require('../src/font-service.cjs');
const align = value => Math.ceil(value / 4) * 4;
function sfnt(family = 'Test Font', style = 'Regular', flavor = 0x10000) {
  const strings = [family, style, `${family} ${style}`, `${family.replaceAll(' ', '')}-${style}`];
  const data = strings.map(value => { const buffer = Buffer.from(value, 'utf16le'); buffer.swap16(); return buffer; });
  const name = Buffer.alloc(6 + data.length * 12 + data.reduce((total, buffer) => total + buffer.length, 0));
  name.writeUInt16BE(data.length, 2); name.writeUInt16BE(6 + data.length * 12, 4);
  let stringOffset = 0;
  data.forEach((buffer, index) => { const at = 6 + index * 12; name.writeUInt16BE(3, at); name.writeUInt16BE(1, at + 2); name.writeUInt16BE(0x409, at + 4); name.writeUInt16BE([1, 2, 4, 6][index], at + 6); name.writeUInt16BE(buffer.length, at + 8); name.writeUInt16BE(stringOffset, at + 10); buffer.copy(name, 6 + data.length * 12 + stringOffset); stringOffset += buffer.length; });
  const head = Buffer.alloc(54); head.writeUInt32BE(0x10000); head.writeUInt32BE(0x5f0f3cf5, 12);
  const cmap = Buffer.alloc(44); cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(1, 6); cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(4, 12); cmap.writeUInt16BE(32, 14); cmap.writeUInt16BE(4, 18); cmap.writeUInt16BE(4, 20); cmap.writeUInt16BE(1, 22);
  cmap.writeUInt16BE(126, 26); cmap.writeUInt16BE(0xffff, 28); cmap.writeUInt16BE(32, 32); cmap.writeUInt16BE(0xffff, 34); cmap.writeInt16BE(-31, 36); cmap.writeInt16BE(1, 38);
  const entries = [['cmap', cmap], ['head', head], ['name', name]];
  const result = Buffer.alloc(12 + entries.length * 16 + entries.reduce((total, [, buffer]) => total + align(buffer.length), 0));
  result.writeUInt32BE(flavor); result.writeUInt16BE(entries.length, 4); result.writeUInt16BE(32, 6); result.writeUInt16BE(1, 8); result.writeUInt16BE(16, 10);
  let offset = 12 + entries.length * 16, headOffset;
  entries.forEach(([tag, data], index) => { const at = 12 + index * 16; result.write(tag, at, 4, 'ascii'); result.writeUInt32BE(checksum(data), at + 4); result.writeUInt32BE(offset, at + 8); result.writeUInt32BE(data.length, at + 12); data.copy(result, offset); if (tag === 'head') headOffset = offset; offset += align(data.length); });
  result.writeUInt32BE((0xb1b0afba - checksum(result)) >>> 0, headOffset + 8);
  return result;
}
function collection(fonts) {
  const header = align(12 + fonts.length * 4), result = Buffer.alloc(header + fonts.reduce((total, buffer) => total + align(buffer.length), 0));
  result.write('ttcf'); result.writeUInt32BE(0x10000, 4); result.writeUInt32BE(fonts.length, 8);
  let offset = header;
  fonts.forEach((font, index) => { const data = Buffer.from(font); result.writeUInt32BE(offset, 12 + index * 4); for (let entry = 0; entry < data.readUInt16BE(4); entry++) { const at = 12 + entry * 16 + 8; data.writeUInt32BE(data.readUInt32BE(at) + offset, at); } data.copy(result, offset); offset += align(data.length); });
  return result;
}
function woff(font) {
  const count = font.readUInt16BE(4), entries = []; let offset = 44 + count * 20;
  for (let index = 0; index < count; index++) { const at = 12 + index * 16, length = font.readUInt32BE(at + 12), start = font.readUInt32BE(at + 8), data = font.subarray(start, start + length), compressed = zlib.deflateSync(data); entries.push({ tag: font.toString('ascii', at, at + 4), check: font.readUInt32BE(at + 4), length, data: compressed.length < length ? compressed : data, offset }); offset += align(entries.at(-1).data.length); }
  const result = Buffer.alloc(offset); result.write('wOFF'); result.writeUInt32BE(font.readUInt32BE(0), 4); result.writeUInt32BE(offset, 8); result.writeUInt16BE(count, 12); result.writeUInt32BE(font.length, 16);
  entries.forEach((entry, index) => { const at = 44 + index * 20; result.write(entry.tag, at, 4, 'ascii'); result.writeUInt32BE(entry.offset, at + 4); result.writeUInt32BE(entry.data.length, at + 8); result.writeUInt32BE(entry.length, at + 12); result.writeUInt32BE(entry.check, at + 16); entry.data.copy(result, entry.offset); });
  return result;
}
test('font metadata reads Unicode sfnt/OTF names and bounded compressed WOFF tables', () => {
  for (const [buffer, format] of [[sfnt('字体测试'), 'ttf'], [sfnt('CFF test', 'Book', 0x4f54544f), 'otf'], [woff(sfnt('WOFF test')), 'woff']]) {
    const result = parseFont(buffer); assert.equal(result.format, format); assert.equal(result.faces.length, 1); assert.equal(result.faces[0].style, format === 'otf' ? 'Book' : 'Regular'); assert.equal(result.faces[0].sampleText, 'Aa Bb Cc 0123456789');
  }
  assert.equal(parseFont(sfnt('字体测试')).faces[0].family, '字体测试');
  assert.equal(parseFont(woff(sfnt('WOFF test'))).faces[0].family, 'WOFF test');
});
test('TTC extraction preserves distinct faces and builds aligned sfnt tables and complete checksum', () => {
  const source = collection([sfnt('Test Family', 'Regular'), sfnt('Test Family', 'Bold')]), untouched = Buffer.from(source);
  assert.deepEqual(parseFont(source).faces.map(face => face.style), ['Regular', 'Bold']);
  for (let index = 0; index < 2; index++) {
    const result = extractCollectionFace(source, index); assert.equal(result.format, 'ttf'); assert.equal(checksum(result.buffer), 0xb1b0afba);
    assert.equal(parseFont(result.buffer).faces[0].style, index ? 'Bold' : 'Regular');
    for (let entry = 0; entry < result.buffer.readUInt16BE(4); entry++) assert.equal(result.buffer.readUInt32BE(12 + entry * 16 + 8) % 4, 0);
  }
  assert.deepEqual(source, untouched); assert.throws(() => extractCollectionFace(source, 2), /字型不存在/);
});
test('font parser rejects corrupt sizes, table directories, TTC counts and compressed bombs', () => {
  assert.throws(() => parseFont(Buffer.from('nope')));
  const invalidOffset = sfnt(); invalidOffset.writeUInt32BE(0xffffffff, 20); assert.throws(() => parseFont(invalidOffset));
  const tooManyFaces = collection([sfnt()]); tooManyFaces.writeUInt32BE(0xffffffff, 8); assert.throws(() => parseFont(tooManyFaces));
  const invalidWoff = woff(sfnt()); invalidWoff.writeUInt32BE(MAX_FONT_BYTES + 1, 16); assert.throws(() => parseFont(invalidWoff));
  const invalidName = woff(sfnt()); const nameAt = 44 + 2 * 20; invalidName.writeUInt32BE(32, nameAt + 12); assert.throws(() => parseFont(invalidName));
  const woff2 = Buffer.alloc(48); woff2.write('wOF2'); woff2.writeUInt32BE(48, 8); woff2.writeUInt16BE(1, 12); woff2.writeUInt32BE(128, 16);
  const inspected = parseFont(woff2, { fallbackName: 'Original title' }); assert.equal(inspected.faces[0].family, 'Original title'); assert.equal(inspected.faces[0].metadataFromFilename, true);
});
const fixturesRoot = path.resolve(__dirname, '..', '.recovery', 'tests');
async function fixture(t, ttc = false) {
  await fs.mkdir(fixturesRoot, { recursive: true }); const base = await fs.mkdtemp(path.join(fixturesRoot, 'font-engine-'));
  t.after(async () => { const relative = path.relative(fixturesRoot, base); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(base, { recursive: true, force: true }); });
  const source = path.join(base, ttc ? 'font.ttc' : 'font.ttf'), data = ttc ? collection([sfnt('Family', 'Regular'), sfnt('Family', 'Bold')]) : sfnt(); await fs.writeFile(source, data);
  const asset = { id: 'test-font', name: 'Original title', ext: ttc ? 'ttc' : 'ttf', hash: crypto.createHash('sha256').update(data).digest('hex') };
  const library = { root: path.join(base, 'library'), snapshot: () => ({ assets: [asset] }), getAssetPath: () => source };
  return { base, source, data, asset, library };
}
function setup(t, fixture, { execute, load, timeout = 1000 } = {}) {
  let active = fixture.library; const windows = [];
  class MockWindow {
    constructor(options) { this.options = options; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; }; this.webContents.executeJavaScript = async script => { this.fontOptions = JSON.parse(script.slice('window.renderFontThumbnail('.length, -1)); return execute ? execute(this) : { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', fontLoaded: true }; }; windows.push(this); }
    loadFile() { return load ? load(this) : Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const service = createFontService({ BrowserWindow: MockWindow, cacheDir: path.join(fixture.base, 'cache'), getLibrary: () => active, thumbnailTimeoutMs: timeout }); t.after(() => service.shutdown());
  return { service, windows, setLibrary: library => { active = library; } };
}
test('font service serves only authorized bytes, blocks stale roots, identity, paths and changed originals', async t => {
  const data = await fixture(t), { service, setLibrary } = setup(t, data); const prepared = await service.prepare(data.library, data.asset.id, data.library.root);
  assert.equal(JSON.stringify(prepared).includes(data.base), false); assert.equal(prepared.family, 'Test Font');
  const response = await service.response(new Request(prepared.url)); assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'font/ttf'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.data);
  for (const url of [prepared.url + '?other=1', prepared.url + '#other', prepared.url.replace('/preview.ttf', '/../index.json'), prepared.url.replace('font/', 'model/'), prepared.url.replace('shitu:', 'https:'), prepared.url.replace('preview.ttf', '%70review.ttf')]) assert.equal((await service.response(new Request(url))).status, 404, url);
  assert.equal((await service.response(new Request(prepared.url, { method: 'POST' }))).status, 404);
  await assert.rejects(service.prepare(data.library, data.asset.id, data.base), /素材库已切换/);
  setLibrary({ root: 'other' }); assert.equal((await service.response(new Request(prepared.url))).status, 404); setLibrary(data.library);
  data.asset.hash = 'bad'; assert.equal((await service.response(new Request(prepared.url))).status, 404); data.asset.hash = crypto.createHash('sha256').update(data.data).digest('hex');
  await fs.appendFile(data.source, '\0'); assert.equal((await service.response(new Request(prepared.url))).status, 404); await assert.rejects(service.prepare(data.library, data.asset.id, data.library.root), /原文件已变化/);
});
test('font service extracts selected TTC faces without touching original and invalidates on library change', async t => {
  const data = await fixture(t, true), { service } = setup(t, data); const regular = await service.prepare(data.library, data.asset.id, data.library.root, 0);
  const bold = await service.prepare(data.library, data.asset.id, data.library.root, 1); assert.equal(bold.faceIndex, 1); assert.equal(bold.style, 'Bold'); assert.equal(bold.faces.length, 2);
  assert.equal((await service.response(new Request(regular.url))).status, 200);
  const buffer = Buffer.from(await (await service.response(new Request(bold.url))).arrayBuffer()); assert.equal(checksum(buffer), 0xb1b0afba); assert.equal(parseFont(buffer).faces[0].style, 'Bold');
  assert.deepEqual(await fs.readFile(data.source), data.data); service.invalidate(); assert.equal((await service.response(new Request(bold.url))).status, 404);
  await assert.rejects(service.prepare(data.library, data.asset.id, data.library.root, 2), /字型不存在/);
});
test('reverse completion of concurrent TTC face requests does not revoke the newer face URL', async t => {
  const data = await fixture(t, true), { service } = setup(t, data);
  const originalRead = fs.readFile; let release, started;
  const waiting = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  let held = false;
  fs.readFile = async function(filename, ...args) {
    const result = await originalRead.call(this, filename, ...args);
    if (!held && filename === data.source) { held = true; started(); await waiting; }
    return result;
  };
  let regular, bold;
  try {
    const old = service.prepare(data.library, data.asset.id, data.library.root, 0); await entered;
    bold = await service.prepare(data.library, data.asset.id, data.library.root, 1);
    release(); regular = await old;
  } finally { release(); fs.readFile = originalRead; }
  assert.equal((await service.response(new Request(bold.url))).status, 200);
  assert.equal((await service.response(new Request(regular.url))).status, 200);
});
test('font thumbnails require successful font decoding and clean up on timeout, retry and shutdown', async t => {
  const data = await fixture(t); let attempts = 0;
  const { service, windows } = setup(t, data, { execute: async () => { if (++attempts === 1) return { dataUrl: 'data:image/jpeg;base64,/9j/2Q==' }; return { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', fontLoaded: true }; } });
  const destination = path.join(data.base, 'thumbnail.jpg'); await assert.rejects(service.thumbnail(data.source, destination), /封面数据无效/); assert.equal(windows[0].destroyed, true);
  const result = await service.thumbnail(data.source, destination); assert.equal(result.font.family, 'Test Font'); assert.equal(result.font.faceCount, 1); assert.equal(result.width, 640); assert.equal(windows[1].destroyed, true); assert.equal((await service.response(new Request(windows[1].fontOptions.url))).status, 404);
  const timed = setup(t, data, { timeout: 10, execute: () => new Promise(() => {}) }); await assert.rejects(timed.service.thumbnail(data.source, destination), /超时/); assert.equal(timed.windows[0].destroyed, true);
  const blocked = setup(t, data, { load: () => new Promise(() => {}) }); const first = blocked.service.thumbnail(data.source, destination), second = blocked.service.thumbnail(data.source, destination);
  const rejections = [assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })];
  while (!blocked.windows.length) await new Promise(resolve => setTimeout(resolve, 2));
  await blocked.service.shutdown(); await Promise.all(rejections); assert.equal(blocked.windows.length, 1); assert.equal(blocked.service.busy(), false);
});
test('font service refuses source files reached through a directory junction', async t => {
  const data = await fixture(t), sourceDir = path.join(data.base, 'inside'), outside = path.join(data.base, 'outside'); await fs.mkdir(outside); await fs.rename(data.source, path.join(outside, 'font.ttf')); await fs.symlink(outside, sourceDir, process.platform === 'win32' ? 'junction' : 'dir'); data.library.getAssetPath = () => path.join(sourceDir, 'font.ttf');
  const { service } = setup(t, data); await assert.rejects(service.prepare(data.library, data.asset.id, data.library.root), /符号链接/);
});
