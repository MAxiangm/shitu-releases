'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const FolderTree = require('./folder-tree.js');
const { MODEL, PROJECT } = require('./media-formats.cjs');
const { validateModelBundle, isSafeBundlePath, collectModelBundle } = require('./model-bundle.cjs');
const { validateProjectBundle } = require('./project-bundle.cjs');
const { DIAGNOSTIC_VERSION, PARSER_VERSION } = require('./bundle-diagnostics.cjs');

const MAX_THUMBNAIL_BYTES = 32 * 1024 * 1024;
const MAX_THUMBNAIL_PIXELS = 16 * 1024 * 1024;
const LEGACY_AE_NOTE = '字体、第三方插件、表达式动态引用及部分专用格式内部链接需在原软件中核对。';
const key = value => value.normalize('NFC').toLowerCase();
function inside(parent, filename) {
  const a = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const b = process.platform === 'win32' ? filename.toLowerCase() : filename;
  const relative = path.relative(a, b);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function safeName(value) {
  let name = String(value ?? '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').trim();
  let clipped = '';
  for (const character of name) { if ((clipped + character).length > 160) break; clipped += character; }
  name = clipped.replace(/[. ]+$/, '') || '未命名';
  if (/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
function assetBase(asset) {
  const name = String(asset.name ?? '').trim();
  const suffix = `.${asset.ext}`;
  return safeName(name.toLowerCase().endsWith(suffix.toLowerCase()) ? name.slice(0, -suffix.length) : name);
}
function abort(signal) { signal?.throwIfAborted(); }
function fail(label, cause) { return new Error(`${label}：${cause.message}`, { cause }); }

async function inspectPath(filename, { allowMissing = false, directory = false } = {}) {
  const absolute = path.resolve(filename), parsed = path.parse(absolute);
  let current = parsed.root, missing = false, finalInfo;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (missing) continue;
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) throw new Error(`路径包含符号链接或目录联接：${current}`);
      if (current !== absolute && !info.isDirectory()) throw new Error(`路径上级不是文件夹：${current}`);
      finalInfo = info;
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
      missing = true; finalInfo = null;
    }
  }
  if (absolute === parsed.root) finalInfo = await fs.lstat(absolute);
  if (!missing && directory && !finalInfo?.isDirectory()) throw new Error('目标不是有效文件夹');
  return { absolute, info: missing ? null : finalInfo };
}
async function canonicalMissing(filename) {
  let ancestor = filename;
  const tail = [];
  for (;;) {
    try { return path.join(await fs.realpath(ancestor), ...tail.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.push(path.basename(ancestor)); ancestor = parent;
    }
  }
}
async function destinationPath(libraryRoot, value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32000) throw new Error('请选择有效的导出目录');
  const destination = path.resolve(value.trim());
  await inspectPath(libraryRoot, { directory: true });
  await inspectPath(destination, { allowMissing: true, directory: true });
  const root = await fs.realpath(libraryRoot), canonical = await canonicalMissing(destination);
  if (inside(root, canonical) || inside(canonical, root)) throw new Error('请选择与素材库分开的导出目录');
  return destination;
}
async function ensureDirectory(directory, created) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await fs.mkdir(current); const made = await fs.lstat(current); created.push({ path: current, directory: true, dev: made.dev, ino: made.ino }); }
      catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
      info = await fs.lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`导出路径不是安全的文件夹：${current}`);
  }
}
async function readThumbnail(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('缺少可导出的缩略图');
  const { info } = await inspectPath(filename);
  if (!info?.isFile() || !info.size || info.size > MAX_THUMBNAIL_BYTES) throw new Error('缩略图文件无效或过大');
  const handle = await fs.open(filename, 'r');
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== info.size) throw new Error('缩略图在读取时发生变化');
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== info.size) throw new Error('缩略图在读取时发生变化');
    bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_THUMBNAIL_PIXELS });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw new Error('缩略图必须是有效的静态图片');
  await image.clone().raw().toBuffer();
  return metadata.format === 'jpeg' ? bytes : image.rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
}
async function preflightAsset(library, asset, options) {
  abort(options.signal);
  const bundled = MODEL.has(asset.ext) || PROJECT.has(asset.ext);
  if (!bundled) {
    const source = library.getAssetPath(asset.id);
    const { info } = await inspectPath(source);
    if (!info?.isFile() || info.size !== asset.size || !inside(path.join(library.root, 'originals'), source)) throw new Error('素材原件无效或已变化');
    return { asset, files: [{ source, relative: null, size: asset.size, hash: asset.hash }], bundled: false, warnings: [] };
  }
  const manifest = PROJECT.has(asset.ext) ? validateProjectBundle(asset.projectBundle) : validateModelBundle(asset.modelBundle);
  const source = PROJECT.has(asset.ext) ? library.getProjectBundleDirectory(asset.id) : library.getModelBundleDirectory(asset.id);
  await inspectPath(source, { directory: true });
  const allowed = new Set(manifest.files.map(file => file.path));
  const allowedDirectories = new Set(['']);
  for (const name of allowed) {
    if (!isSafeBundlePath(name)) throw new Error('资源包路径无效');
    let ancestor = path.posix.dirname(name);
    while (ancestor !== '.') { allowedDirectories.add(ancestor); ancestor = path.posix.dirname(ancestor); }
  }
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      abort(options.signal);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('资源包包含符号链接或目录联接');
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(name)) throw new Error('资源包包含未知目录');
        await walk(path.join(directory, entry.name), name);
      } else if (!entry.isFile() || !allowed.has(name)) throw new Error('资源包包含未知文件');
    }
  }
  await walk(source);
  const files = [];
  for (const file of manifest.files) {
    abort(options.signal);
    const filename = path.join(source, file.path), { info } = await inspectPath(filename);
    if (!info?.isFile() || info.size !== file.size) throw new Error(`资源包文件缺失或已变化：${file.path}`);
    files.push({ source: filename, relative: file.path, size: file.size, hash: file.hash });
  }
  const supplied = options.thumbnailPaths instanceof Map ? options.thumbnailPaths.get(asset.id) : options.thumbnailPaths?.[asset.id];
  const suppliedNote = options.previewNotes instanceof Map ? options.previewNotes.get(asset.id) : options.previewNotes?.[asset.id];
  let thumbnail, previewNote = typeof suppliedNote === 'string' ? suppliedNote : '';
  if (supplied !== null) {
    try { thumbnail = await readThumbnail(supplied || library.getAssetPath(asset.id, 'thumbnail')); }
    catch (error) {
      abort(options.signal);
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
      previewNote = `未附带缩略图：${String(error?.message || '没有可用预览').slice(0, 500)}；原始资源文件照常导出。`;
    }
  } else if (!previewNote) previewNote = '未附带缩略图；原始资源文件照常导出。';
  // Older FBX manifests treated any embedded image as proof that all textures
  // were embedded. Reinspect the stored bundle so those libraries also benefit
  // from per-texture checks without changing their originals or metadata.
  const currentDiagnostics = manifest.diagnostics?.version === DIAGNOSTIC_VERSION &&
    manifest.diagnostics.parserVersion === PARSER_VERSION && manifest.diagnostics.sourceHash === manifest.hash;
  const dependencies = path.extname(manifest.entry).toLowerCase() === '.fbx' && !currentDiagnostics
    ? await collectModelBundle(path.join(source, manifest.entry), { allowedRoots: [source], signal: options.signal }) : manifest;
  abort(options.signal);
  const missing = [...new Set(dependencies.missing || [])];
  const notes = [...new Set([...(PROJECT.has(asset.ext) ? [...(manifest.notes || []), ...(manifest.warnings.includes(LEGACY_AE_NOTE) ? [LEGACY_AE_NOTE] : [])] : []), ...(previewNote ? [previewNote] : [])])];
  const issues = [...new Set((dependencies.warnings || []).filter(message => !PROJECT.has(asset.ext) || message !== LEGACY_AE_NOTE))];
  const warnings = issues.map(message => `${asset.name}：${message}`);
  if (missing.length) warnings.push(`${asset.name}：有 ${missing.length} 个依赖未收集：${missing.slice(0, 5).join('、')}${missing.length > 5 ? '…' : ''}`);
  return { asset, files, bundled: true, thumbnail, warnings, missing, notes, issues, resources: manifest.resources,
    occupiedRootNames: new Set(manifest.files.map(file => key(file.path.split('/')[0]))) };
}
async function copyChecked(file, target, created, signal) {
  abort(signal);
  const { info } = await inspectPath(file.source);
  if (!info?.isFile() || info.size !== file.size) throw new Error('导出时素材原件发生变化');
  await ensureDirectory(path.dirname(target), created);
  const input = await fs.open(file.source, constants.O_RDONLY);
  let output;
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.size !== file.size) throw new Error('导出时素材原件发生变化');
    output = await fs.open(target, 'wx');
    const made = await output.stat(); created.push({ path: target, directory: false, dev: made.dev, ino: made.ino });
    const buffer = Buffer.alloc(1024 * 1024), hash = crypto.createHash('sha256');
    let offset = 0;
    for (;;) {
      abort(signal);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        abort(signal);
        const result = await output.write(buffer, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) throw new Error('写入导出文件失败');
        written += result.bytesWritten;
      }
      offset += bytesRead;
      if (offset > file.size) throw new Error('导出时素材原件发生变化');
    }
    if (offset !== file.size || hash.digest('hex') !== file.hash) throw new Error('导出时素材内容校验失败');
    await output.sync();
  } finally { await input.close(); await output?.close(); }
}
async function writeExclusive(filename, bytes, created) {
  await inspectPath(path.dirname(filename), { directory: true });
  const output = await fs.open(filename, 'wx');
  const made = await output.stat(); created.push({ path: filename, directory: false, dev: made.dev, ino: made.ino });
  try { await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
}
async function rollback(created) {
  const failed = [];
  for (const entry of created.slice().reverse()) {
    try {
      const { info } = await inspectPath(entry.path);
      if (info.isSymbolicLink() || info.dev !== entry.dev || info.ino !== entry.ino ||
          (entry.directory ? !info.isDirectory() : !info.isFile())) { failed.push(entry.path); continue; }
      if (entry.directory) await fs.rmdir(entry.path); else await fs.unlink(entry.path);
    } catch (error) { if (error.code !== 'ENOENT') failed.push(entry.path); }
  }
  return failed;
}
async function namesAt(directory) {
  return new Set((await fs.readdir(directory)).map(key));
}
function chooseName(base, reserved, { extension = '', occupiedRootNames } = {}) {
  for (let number = 0; number < 100000; number++) {
    const stem = `${base}${number ? ` (${number})` : ''}`, name = stem + extension;
    if (!reserved.has(key(name)) && !occupiedRootNames?.has(key(`${stem}.jpg`))) {
      reserved.add(key(name)); return name;
    }
  }
  throw new Error('同名导出文件过多，请选择其他导出目录');
}
async function createUniqueDirectory(parent, base, reserved, created, occupiedRootNames) {
  for (;;) {
    const name = chooseName(base, reserved, { occupiedRootNames }), filename = path.join(parent, name);
    try { await fs.mkdir(filename); const made = await fs.lstat(filename); created.push({ path: filename, directory: true, dev: made.dev, ino: made.ino }); return filename; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
async function exportOne(item, parent, reserved, created, options) {
  abort(options.signal);
  const base = assetBase(item.asset);
  if (item.bundled) {
    const output = await createUniqueDirectory(parent, base, reserved, created, item.occupiedRootNames);
    for (const file of item.files) await copyChecked(file, path.join(output, file.relative), created, options.signal);
    const result = { assetId: item.asset.id, name: path.basename(output), path: output };
    if (item.thumbnail) {
      result.thumbnail = path.join(output, `${path.basename(output)}.jpg`);
      await writeExclusive(result.thumbnail, item.thumbnail, created);
    }
    return result;
  }
  for (;;) {
    const name = chooseName(base, reserved, { extension: `.${item.asset.ext}` }), output = path.join(parent, name);
    try { await copyChecked(item.files[0], output, created, options.signal); return { assetId: item.asset.id, name, path: output }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
function progress(options, completed, total, asset) {
  try { options.onProgress?.({ phase: 'exporting', completed, total, name: asset?.name || '' }); } catch {}
}
async function exportReport(directory, prepared, items, created, options) {
  const bundles = prepared.filter(item => item.bundled);
  if (!bundles.length) return {};
  abort(options.signal);
  const relative = filename => path.relative(directory, filename).split(path.sep).join('/');
  const report = {
    version: 1, exportedAt: new Date().toISOString(), exportedAssets: items.length,
    description: '资源包内的文件已逐一复制并校验 SHA-256。missing 为确认未收集的依赖，warnings 为需要核对的问题，notes 为格式说明。内嵌贴图保存在模型文件中，无需外置贴图目录。',
    packages: bundles.map(item => {
      const output = items.find(value => value.assetId === item.asset.id);
      return { name: item.asset.name, format: item.asset.ext, directory: relative(output.path),
        entry: item.asset.modelBundle?.entry || item.asset.projectBundle.entry,
        status: item.missing.length ? 'missing-dependencies' : item.issues.length ? 'needs-review' : 'collected',
        files: item.files.map(file => ({ path: file.relative, size: file.size, sha256: file.hash })),
        missing: item.missing, warnings: item.issues, notes: item.notes,
        ...(item.resources ? { resources: item.resources } : {}) };
    })
  };
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  const reserved = await namesAt(directory);
  for (;;) {
    const reportPath = path.join(directory, chooseName('Mosaic 导出报告', reserved, { extension: '.json' }));
    try {
      await writeExclusive(reportPath, bytes, created);
      abort(options.signal);
      return { reportPath, missingDependencies: bundles.reduce((sum, item) => sum + item.missing.length, 0) };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
async function exportAssets(library, assets, destDir, options = {}) {
  const destination = await destinationPath(library.root, destDir), prepared = [];
  for (const asset of assets) {
    try { prepared.push(await preflightAsset(library, asset, options)); }
    catch (error) { throw fail(`无法导出“${asset.name}”`, error); }
  }
  const created = [], items = [];
  try {
    abort(options.signal); await ensureDirectory(destination, created);
    const reserved = await namesAt(destination);
    progress(options, 0, prepared.length);
    for (const item of prepared) { items.push(await exportOne(item, destination, reserved, created, options)); progress(options, items.length, prepared.length, item.asset); }
    abort(options.signal);
    const report = await exportReport(destination, prepared, items, created, options);
    return { exported: items.length, files: items.map(item => item.path), items, path: destination, folders: 0, warnings: prepared.flatMap(item => item.warnings), ...report };
  } catch (error) {
    const leftovers = await rollback(created);
    if (leftovers.length) throw fail('导出未完成，部分新建路径无法清理，请检查导出位置', error);
    throw error;
  }
}
async function exportFolder(library, folderId, destDir, options = {}) {
  const data = library.data, selected = folderId === null ? null : data.folders.find(folder => folder.id === folderId);
  if (folderId !== null && !selected) throw new Error('文件夹已不存在');
  const included = selected ? FolderTree.descendantIds(data.folders, folderId) : new Set(data.folders.map(folder => folder.id));
  const assets = data.assets.filter(asset => !asset.trashedAt && (included.has(asset.folderId) || folderId === null && asset.folderId === null));
  const destination = await destinationPath(library.root, destDir), prepared = new Map();
  for (const asset of assets) {
    try { prepared.set(asset.id, await preflightAsset(library, asset, options)); }
    catch (error) { throw fail(`无法导出“${asset.name}”`, error); }
  }
  const created = [], items = [];
  let folders = 0;
  try {
    abort(options.signal); await ensureDirectory(destination, created);
    const output = await createUniqueDirectory(destination, safeName(selected?.name || path.basename(library.root)), await namesAt(destination), created);
    progress(options, 0, assets.length);
    async function visit(id, directory) {
      abort(options.signal); folders++;
      const reserved = await namesAt(directory), children = FolderTree.children(data.folders, id), directories = [];
      // Reserve every real child folder before same-named model/project packages.
      for (const child of children) {
        if (!included.has(child.id)) continue;
        directories.push([child, await createUniqueDirectory(directory, safeName(child.name), reserved, created)]);
      }
      for (const asset of assets) if (asset.folderId === id) {
        items.push(await exportOne(prepared.get(asset.id), directory, reserved, created, options));
        progress(options, items.length, assets.length, asset);
      }
      for (const [child, directory] of directories) await visit(child.id, directory);
    }
    await visit(folderId, output); abort(options.signal);
    const report = await exportReport(output, [...prepared.values()], items, created, options);
    return { exported: items.length, files: items.map(item => item.path), items, path: output, folders: selected ? folders : folders - 1, warnings: [...prepared.values()].flatMap(item => item.warnings), ...report };
  } catch (error) {
    const leftovers = await rollback(created);
    if (leftovers.length) throw fail('导出未完成，部分新建路径无法清理，请检查导出位置', error);
    throw error;
  }
}

module.exports = { safeName, assetBase, exportAssets, exportFolder };
