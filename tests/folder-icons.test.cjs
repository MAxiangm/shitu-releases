'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const { LibraryManager } = require('../src/library-manager.cjs');
const FolderIcons = require('../src/folder-icons.js');
const IconFiles = require('../src/folder-icons.cjs');
const record = { recordHistory: true };

async function fixture(t) {
  const base = path.resolve(__dirname, '../.recovery/tests');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'folder-icons-'));
  const library = new Library({ root: path.join(directory, 'library') });
  await library.init();
  const id = (await library.createFolder('图标文件夹')).folders[0].id;
  t.after(async () => {
    await library.flush();
    const relative = path.relative(base, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const folder = () => library.snapshot().folders.find(folder => folder.id === id);
  const source = async (bytes, name = 'input.png') => { const filename = path.join(directory, name); await fs.writeFile(filename, bytes); return filename; };
  return { library, directory, id, folder, source };
}
const png = (background = { r: 40, g: 80, b: 120, alpha: 0.4 }) => sharp({ create: { width: 8, height: 6, channels: 4, background } }).png().toBuffer();
async function gif(frames = 3) {
  const pixels = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) { pixels[i * 4] = i % 256; pixels[i * 4 + 1] = Math.floor(i / 256); pixels[i * 4 + 2] = 100; pixels[i * 4 + 3] = i % 2 ? 255 : 0; }
  return sharp(pixels, { raw: { width: 1, height: frames, channels: 4, pageHeight: 1 } }).gif({ loop: 2, delay: Array(frames).fill(120), keepDuplicateFrames: true }).toBuffer();
}

test('shared icon metadata accepts only builtins, bounded image descriptors and hexadecimal colors', () => {
  assert.equal(FolderIcons.BUILTINS.length, 16);
  for (const name of FolderIcons.BUILTINS) assert.deepEqual(FolderIcons.normalizeIcon({ type: 'builtin', name }), { type: 'builtin', name });
  assert.equal(FolderIcons.normalizeColor('#aBc'), '#aabbcc');
  assert.equal(FolderIcons.normalizeColor('#A0B1C2'), '#a0b1c2');
  assert.equal(FolderIcons.normalizeIcon(undefined), null);
  const icon = { type: 'image', hash: 'a'.repeat(64), ext: 'gif', width: 8, height: 6, animated: true, size: 100 };
  assert.equal(FolderIcons.iconUrl({ id: 'valid-id', icon }), `shitu://folder-icon/valid-id?v=${icon.hash}`);
  assert.equal(FolderIcons.iconUrl({ id: '../outside', icon }), null);
  for (const invalid of [
    { type: 'builtin', name: 'javascript:alert(1)' }, { type: 'builtin', name: 'folder', path: '../file' },
    { ...icon, ext: 'svg' }, { ...icon, hash: '../outside' }, { ...icon, filename: 'outside.png' },
    { ...icon, width: 8193 }, { ...icon, size: IconFiles.MAX_BYTES + 1 }, { ...icon, animated: 'true' }
  ]) assert.throws(() => FolderIcons.normalizeIcon(invalid), /图标无效/);
  for (const invalid of ['red', 'url(file:...)', '#12345', '#12345678', 123]) assert.throws(() => FolderIcons.normalizeColor(invalid), /图标颜色无效/);
});

test('transparent and opaque browser images retain original bytes and persist inside the library', async t => {
  const f = await fixture(t);
  for (const format of ['png', 'jpeg', 'webp', 'avif']) {
    const image = sharp({ create: { width: 8, height: 6, channels: format === 'jpeg' ? 3 : 4, background: { r: 30, g: 60, b: 90, alpha: 0.4 } } });
    const bytes = await image[format]().toBuffer();
    await f.library.importFolderIcon(f.id, await f.source(bytes, `actual-${format}.txt`), record);
    const icon = f.folder().icon;
    assert.equal(icon.ext, format === 'jpeg' ? 'jpg' : format);
    assert.equal(icon.animated, false); assert.equal(icon.size, bytes.length);
    const stored = await f.library.readFolderIcon(f.id, icon.hash);
    assert.equal(path.dirname(stored.filename), path.join(f.library.root, 'folder-icons'));
    assert.deepEqual(stored.bytes, bytes);
    assert.equal((await sharp(stored.bytes).metadata()).hasAlpha, format !== 'jpeg');
  }
  await f.library.verifyFolderIcons();
  const reopened = new Library({ root: f.library.root }); await reopened.init();
  assert.deepEqual(reopened.snapshot().folders[0].icon, f.folder().icon);
});

test('animated GIF is copied byte for byte and served only for the current folder reference', async t => {
  const f = await fixture(t), bytes = await gif();
  const original = await sharp(bytes, { animated: true }).metadata();
  assert.equal(original.pages, 3);
  await f.library.importFolderIcon(f.id, await f.source(bytes, 'animation.gif'), record);
  const icon = f.folder().icon;
  assert.equal(icon.ext, 'gif'); assert.equal(icon.animated, true);
  const url = FolderIcons.iconUrl(f.folder());
  const response = await IconFiles.response(f.library, new Request(url));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/gif');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await IconFiles.response(f.library, new Request(url, { method: 'POST' }))).status, 404);
  assert.equal((await IconFiles.response(f.library, new Request(url.replace(icon.hash, '0'.repeat(64))))).status, 404);
  await f.library.setFolderIcon(f.id, 'music', record);
  assert.equal((await IconFiles.response(f.library, new Request(url))).status, 404);
  await f.library.undo();
  assert.equal((await IconFiles.response(f.library, new Request(url))).status, 200);
  const restored = await sharp((await f.library.readFolderIcon(f.id, icon.hash)).bytes, { animated: true }).metadata();
  assert.deepEqual(restored.delay, original.delay); assert.equal(restored.loop, original.loop); assert.equal(restored.pages, original.pages);
});

test('SVG and TIFF icons are rasterized to safe transparent PNGs', async t => {
  const f = await fixture(t);
  const vector = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="12"><rect width="5" height="12" fill="red"/></svg>');
  const tiff = await sharp({ create: { width: 10, height: 12, channels: 4, background: '#33557780' } }).tiff({ compression: 'lzw' }).toBuffer();
  for (const [name, bytes] of [['vector.svg', vector], ['raster.tiff', tiff]]) {
    await f.library.importFolderIcon(f.id, await f.source(bytes, name));
    const icon = f.folder().icon; assert.equal(icon.ext, 'png'); assert.equal(icon.width, 10); assert.equal(icon.height, 12);
    const stored = await f.library.readFolderIcon(f.id, icon.hash);
    assert.notDeepEqual(stored.bytes, bytes); assert.equal((await sharp(stored.bytes).metadata()).hasAlpha, true);
  }
});

test('invalid, truncated, oversized and overlong animations are rejected without changing metadata', async t => {
  const f = await fixture(t), before = await fs.readFile(f.library.indexPath, 'utf8');
  const valid = await png();
  const largeDimensions = await sharp({ create: { width: 8193, height: 1, channels: 3, background: '#333333' } }).png().toBuffer();
  const longAnimation = await gif(301);
  assert.equal((await sharp(longAnimation, { animated: true }).metadata()).pages, 301);
  for (const [index, bytes] of [Buffer.from('not a valid picture'), valid.subarray(0, valid.length - 20), largeDimensions, longAnimation].entries()) {
    await assert.rejects(f.library.importFolderIcon(f.id, await f.source(bytes, `invalid-${index}.png`), record), /图标|图片/);
    assert.equal(await fs.readFile(f.library.indexPath, 'utf8'), before);
  }
  const oversized = await f.source(Buffer.alloc(0), 'oversized.png'); await fs.truncate(oversized, IconFiles.MAX_BYTES + 1);
  await assert.rejects(f.library.importFolderIcon(f.id, oversized, record), /25 MB/);
  assert.equal(f.library.historyState().canUndo, false);
  await assert.rejects(fs.access(path.join(f.library.root, 'folder-icons')), { code: 'ENOENT' });
});

test('changing and resetting icons and custom colors undo independently without affecting children or labels', async t => {
  const f = await fixture(t);
  const child = (await f.library.createFolder('子文件夹', f.id)).folders.at(-1);
  await f.library.setFolderColor(f.id, 'blue');
  const bytes = await png(); await f.library.importFolderIcon(f.id, await f.source(bytes), record);
  const image = f.folder().icon;
  await f.library.setFolderIconColor(f.id, '#ABC', record);
  await f.library.setFolderIcon(f.id, 'star', record);
  assert.deepEqual(f.folder().icon, { type: 'builtin', name: 'star' }); assert.equal(f.folder().iconColor, '#aabbcc');
  await f.library.setFolderIcon(f.id, null, record); assert.equal(f.folder().icon, undefined);
  await f.library.undo(); assert.equal(f.folder().icon.name, 'star');
  await f.library.undo(); assert.deepEqual(f.folder().icon, image);
  await f.library.undo(); assert.equal(f.folder().iconColor, undefined);
  await f.library.redo(); assert.equal(f.folder().iconColor, '#aabbcc');
  assert.equal(f.folder().colorLabel, 'blue'); assert.equal(f.library.snapshot().folders.find(item => item.id === child.id).parentId, f.id);
  assert.deepEqual((await f.library.readFolderIcon(f.id, image.hash)).bytes, bytes);
  const history = f.library.historyState(), index = await fs.readFile(f.library.indexPath, 'utf8');
  await f.library.importFolderIcon(f.id, await f.source(bytes), record);
  await f.library.setFolderIconColor(f.id, '#aabbcc', record);
  assert.deepEqual(f.library.historyState(), history); assert.equal(await fs.readFile(f.library.indexPath, 'utf8'), index);
  await f.library.redo(); assert.equal(f.folder().icon.name, 'star');
  assert.deepEqual((await IconFiles.readStored(f.library.root, image)).bytes, bytes);
});

test('failed metadata saves preserve previous icon and history and keep immutable files for later recovery', async t => {
  const f = await fixture(t);
  await f.library.setFolderIcon(f.id, 'image', record);
  const before = await fs.readFile(f.library.indexPath, 'utf8'), history = f.library.historyState();
  const persist = f.library._persist; f.library._persist = async () => { throw new Error('simulated disk failure'); };
  const filename = await f.source(await png());
  await assert.rejects(f.library.importFolderIcon(f.id, filename, record), /disk failure/);
  assert.deepEqual(f.folder().icon, { type: 'builtin', name: 'image' });
  assert.equal(await fs.readFile(f.library.indexPath, 'utf8'), before); assert.deepEqual(f.library.historyState(), history);
  f.library._persist = persist;
  await f.library.importFolderIcon(f.id, filename, record);
  assert.equal(f.folder().icon.type, 'image'); assert.equal((await fs.readdir(path.join(f.library.root, 'folder-icons'))).length, 1);
});

test('managed icons reject tampering, file links, directory junctions and forged index paths', async t => {
  const f = await fixture(t), bytes = await png();
  await f.library.importFolderIcon(f.id, await f.source(bytes));
  const icon = f.folder().icon, stored = await f.library.readFolderIcon(f.id, icon.hash), url = FolderIcons.iconUrl(f.folder());
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1; await fs.writeFile(stored.filename, corrupt);
  await assert.rejects(f.library.readFolderIcon(f.id, icon.hash), /校验失败/);
  assert.equal((await IconFiles.response(f.library, new Request(url))).status, 404);
  await assert.rejects(f.library.importFolderIcon(f.id, await f.source(bytes)), /校验失败/);
  await fs.writeFile(stored.filename, bytes);
  const linkTarget = path.join(f.directory, 'linked-image.png');
  await fs.rename(stored.filename, linkTarget);
  let linked = false;
  try { await fs.symlink(linkTarget, stored.filename, 'file'); linked = true; }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  if (linked) {
    await assert.rejects(f.library.readFolderIcon(f.id, icon.hash), /文件无效/);
    await fs.unlink(stored.filename);
  } else t.diagnostic('File symlinks require additional Windows privileges; junction path check still runs.');
  await fs.rename(linkTarget, stored.filename);
  const saved = structuredClone(f.library.data); saved.folders[0].icon = { ...icon, ext: '../outside' };
  assert.throws(() => f.library._validate(saved), /图标无效/);
  const folder = path.join(f.library.root, 'folder-icons'), moved = path.join(f.directory, 'outside');
  await fs.rename(folder, moved); await fs.symlink(moved, folder, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.library.readFolderIcon(f.id, icon.hash), /符号链接/);
  await assert.rejects(f.library.importFolderIcon(f.id, await f.source(bytes)), /符号链接/);
  await fs.unlink(folder); await fs.rename(moved, folder);
});

test('backups and migration preserve current and previous icon files, and migration rejects corrupt icons', async t => {
  const f = await fixture(t), first = await png(), second = await png('#773311');
  await f.library.importFolderIcon(f.id, await f.source(first, 'first.png'));
  const previous = f.folder().icon;
  await f.library.importFolderIcon(f.id, await f.source(second, 'second.png'));
  const current = f.folder().icon;
  const backup = await f.library.backupTo(path.join(f.directory, 'backups'));
  const restored = new Library({ root: backup.path }); await restored.init(); await restored.verifyFolderIcons();
  assert.deepEqual((await restored.readFolderIcon(f.id, current.hash)).bytes, second);
  assert.deepEqual((await IconFiles.readStored(restored.root, previous)).bytes, first);
  const manager = new LibraryManager({ configPath: path.join(f.directory, 'manager.json') }); await manager.open(f.library.root);
  const destination = path.join(f.directory, 'migration'); await fs.mkdir(destination);
  const migrated = await manager.migrate(destination);
  assert.deepEqual((await migrated.readFolderIcon(f.id, current.hash)).bytes, second);
  assert.deepEqual((await IconFiles.readStored(migrated.root, previous)).bytes, first);
  await fs.writeFile((await migrated.readFolderIcon(f.id, current.hash)).filename, Buffer.alloc(current.size));
  const before = manager.current(), config = await fs.readFile(manager.configPath, 'utf8');
  await assert.rejects(manager.migrate(destination), /迁移校验失败.*图标/s);
  assert.equal(manager.current(), before); assert.equal(await fs.readFile(manager.configPath, 'utf8'), config);
});

test('verification checks every distinct metadata reference even when folders share image bytes', async t => {
  const f = await fixture(t);
  await f.library.importFolderIcon(f.id, await f.source(await png()));
  const duplicate = (await f.library.createFolder('同图不同信息')).folders.at(-1).id;
  const draft = structuredClone(f.library.data);
  draft.folders.find(folder => folder.id === duplicate).icon = { ...f.folder().icon, width: 1 };
  await f.library._persist(draft);
  await assert.rejects(f.library.verifyFolderIcons(), /同图不同信息.*信息与图片不一致/);
});

test('missing index with only custom folder icons is preserved instead of replaced by an empty library', async t => {
  const f = await fixture(t);
  await f.library.importFolderIcon(f.id, await f.source(await png()));
  await fs.unlink(f.library.indexPath); await fs.unlink(path.join(f.library.root, 'index.backup.json'));
  const reopened = new Library({ root: f.library.root });
  await assert.rejects(reopened.init(), /索引缺失/);
  await assert.rejects(fs.access(f.library.indexPath), { code: 'ENOENT' });
});
