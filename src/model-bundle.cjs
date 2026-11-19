'use strict';

const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readFbxDependencies } = require('./fbx-dependencies.cjs');
const { diagnostics, resourceSummary, fileResources, validateDiagnostics } = require('./bundle-diagnostics.cjs');

const MODEL_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'c4d', 'blend', 'max']);
const NATIVE_EXTENSIONS = new Set(['c4d', 'blend', 'max']);
const TEXTURES = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'tga', 'tif', 'tiff', 'dds', 'ktx', 'ktx2', 'hdr', 'exr', 'pic', 'psd', 'tx', 'tex']);
const MAX_FILES = 4096;
const MAX_TEXT = 64 * 1024 * 1024;
const slash = value => value.split(path.sep).join('/');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const ext = filename => path.extname(filename).slice(1).toLowerCase();
function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function isSafeBundlePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\\<>:"|?*\x00-\x1f]/.test(value) &&
    !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
async function hashFile(filename, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}
function modelBundleHash(files, entry) {
  if (!isSafeBundlePath(entry) || !Array.isArray(files) || !files.length) throw new Error('模型包清单无效');
  const hash = crypto.createHash('sha256');
  hash.update(`shitu-model-bundle-v1\0${entry}\0`);
  for (const file of [...files].sort((a, b) => {
    const left = a.path || a.relative, right = b.path || b.relative;
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    const name = file.path || file.relative;
    if (!isSafeBundlePath(name) || !/^[a-f0-9]{64}$/.test(file.hash || '') || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('模型包文件信息无效');
    hash.update(`${name}\0${file.size}\0${file.hash}\0`);
  }
  return hash.digest('hex');
}
function validateModelBundle(value) {
  if (!value || value.version !== 1 || !isSafeBundlePath(value.entry) || !MODEL_EXTENSIONS.has(ext(value.entry)) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES) throw new Error('模型包清单无效');
  const names = new Set();
  let size = 0;
  for (const file of value.files) {
    if (!file || !isSafeBundlePath(file.path) || names.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.hash || '')) throw new Error('模型包文件路径无效');
    names.add(file.path.toLowerCase()); size += file.size;
  }
  if (!value.files.some(file => file.path === value.entry) || !Number.isSafeInteger(size)) throw new Error('模型包入口无效');
  if (value.previewEntry !== undefined && (!isSafeBundlePath(value.previewEntry) || !MODEL_EXTENSIONS.has(ext(value.previewEntry)) || !value.files.some(file => file.path === value.previewEntry))) throw new Error('模型预览入口无效');
  for (const key of ['missing', 'warnings']) if (!Array.isArray(value[key]) || value[key].length > MAX_FILES || value[key].some(item => typeof item !== 'string' || item.length > 4096)) throw new Error('模型包提示信息无效');
  if ('size' in value && value.size !== size) throw new Error('模型包大小无效');
  if ('hash' in value && value.hash !== modelBundleHash(value.files, value.entry)) throw new Error('模型包校验值无效');
  validateDiagnostics(value, isSafeBundlePath);
  return value;
}
function words(value) {
  return [...String(value).matchAll(/"((?:\\"|[^"])*)"|'([^']*)'|(\S+)/g)].map(match => (match[1] ?? match[2] ?? match[3]).replace(/\\"/g, '"'));
}
function textureReference(value) {
  const tokens = words(value.replace(/\s+#.*$/, ''));
  let index = 0;
  while (tokens[index]?.startsWith('-')) {
    const option = tokens[index++].toLowerCase();
    if (['-s', '-o', '-t'].includes(option)) {
      for (let count = 0; count < 3 && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(tokens[index] || ''); count++) index++;
    } else index += option === '-mm' ? 2 : 1;
  }
  return tokens.slice(index).join(' ');
}
async function readText(filename) {
  if ((await fs.stat(filename)).size > MAX_TEXT) throw new Error('模型依赖描述文件过大');
  return fs.readFile(filename, 'utf8');
}
async function gltfReferences(filename, binary) {
  let text, binaryBytes = 0;
  if (!binary) text = await readText(filename);
  else {
    const handle = await fs.open(filename, 'r');
    try {
      const header = Buffer.alloc(20);
      if ((await handle.read(header, 0, 20, 0)).bytesRead !== 20 || header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2 || header.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB 文件头或 JSON 数据无效');
      const length = header.readUInt32LE(12);
      if (!length || length > MAX_TEXT || length + 20 > (await handle.stat()).size) throw new Error('GLB JSON 数据长度无效');
      const bytes = Buffer.alloc(length);
      if ((await handle.read(bytes, 0, length, 20)).bytesRead !== length) throw new Error('GLB JSON 数据不完整');
      text = bytes.toString('utf8').replace(/[\x00 ]+$/, '');
      const size = (await handle.stat()).size;
      for (let offset = 20 + length; offset + 8 <= size;) {
        const chunk = Buffer.alloc(8);
        if ((await handle.read(chunk, 0, 8, offset)).bytesRead !== 8 || offset + 8 + chunk.readUInt32LE(0) > size) throw new Error('GLB 二进制数据不完整');
        if (chunk.readUInt32LE(4) === 0x004e4942) binaryBytes += chunk.readUInt32LE(0);
        offset += 8 + chunk.readUInt32LE(0);
      }
    } finally { await handle.close(); }
  }
  const data = JSON.parse(text);
  if (String(data.asset?.version || '').split('.')[0] !== '2') throw new Error('目前支持 glTF 2 模型');
  const references = [
    ...(Array.isArray(data.buffers) ? data.buffers.filter(value => typeof value.uri === 'string').map(value => ({ reference: value.uri, kind: 'buffer' })) : []),
  ];
  let complete = true;
  for (const [index, value] of (Array.isArray(data.images) ? data.images : []).entries()) {
    if (typeof value.uri === 'string') {
      const embedded = /^data:/i.test(value.uri);
      if (embedded && !/^data:[^,]*,[\s\S]+/i.test(value.uri)) { complete = false; continue; }
      references.push({ reference: value.uri, kind: 'texture', embedded, label: `image[${index}]` });
    }
    else if (Number.isInteger(value.bufferView) && data.bufferViews?.[value.bufferView]) {
      const view = data.bufferViews[value.bufferView], buffer = data.buffers?.[view.buffer];
      const end = (view.byteOffset || 0) + view.byteLength;
      if (buffer && Number.isSafeInteger(end) && Number.isSafeInteger(view.byteLength) && view.byteLength > 0 && (view.byteOffset || 0) >= 0 && end <= buffer.byteLength &&
          (typeof buffer.uri === 'string' || binary && end <= binaryBytes)) references.push({ reference: buffer.uri || '', kind: 'texture', embedded: !buffer.uri || /^data:/i.test(buffer.uri), referenceKind: 'buffer', label: `image[${index}] (bufferView ${value.bufferView})` });
      else complete = false;
    } else complete = false;
  }
  return { references, complete };
}
async function collectModelBundle(source, { allowedRoots, repair, signal } = {}) {
  signal?.throwIfAborted();
  if (typeof source !== 'string' || !path.isAbsolute(source) || !MODEL_EXTENSIONS.has(ext(source))) throw new Error('请选择支持的 3D 模型文件');
  source = path.resolve(source);
  const roots = [...new Set((allowedRoots?.length ? allowedRoots : [path.dirname(source)]).map(root => path.resolve(root)))];
  for (const root of roots) if (!(await fs.lstat(root)).isDirectory() || (await fs.lstat(root)).isSymbolicLink()) throw new Error('模型资源根目录无效');
  const realRoots = await Promise.all(roots.map(root => fs.realpath(root)));
  const files = new Map(), missing = new Set(), warnings = new Set(), parsed = new Set();
  const repairedFiles = new Map();
  const resourceHints = [];
  let resourceComplete = true;
  let previewSource;
  async function checked(filename) {
    filename = path.resolve(filename);
    const rootIndex = roots.findIndex(root => within(root, filename));
    if (rootIndex === -1) throw new Error('引用超出导入目录');
    const relative = path.relative(roots[rootIndex], filename);
    let cursor = roots[rootIndex];
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('不自动收集符号链接');
    }
    if (!(await fs.lstat(filename)).isFile() || !within(realRoots[rootIndex], await fs.realpath(filename))) throw new Error('引用不是导入目录内的普通文件');
    return filename;
  }
  async function add(filename) {
    signal?.throwIfAborted();
    const actual = await checked(filename);
    const key = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (!files.has(key)) {
      if (files.size >= MAX_FILES) throw new Error('模型资源文件超过收集上限');
      const info = await fs.stat(actual);
      files.set(key, { source: actual, size: info.size, hash: await hashFile(actual, signal) });
    }
    return actual;
  }
  async function restoredReference(raw, options, from, fallback) {
    const match = repair?.replacements.get(raw);
    if (!match) return null;
    const sourceStem = path.basename(source, path.extname(source));
    const target = options[0] && within(repair.root, options[0]) ? options[0] :
      fallback ? path.join(path.dirname(from), `${sourceStem}.fbm`, path.basename(match.filename)) : null;
    if (!target || !isSafeBundlePath(slash(path.relative(repair.root, target)))) return null;
    if ((await fs.lstat(match.filename)).isSymbolicLink()) throw new Error('匹配资源在补齐期间发生变化，请重新查找');
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.copyFile(match.filename, target, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    const actual = await add(target);
    const file = files.get(process.platform === 'win32' ? actual.toLowerCase() : actual);
    if (file.size !== match.size || file.hash !== match.hash) throw new Error('匹配资源在补齐期间发生变化，请重新查找');
    repairedFiles.set(actual.toLowerCase(), match.hash);
    return actual;
  }
  async function reference(raw, from, kind = 'texture', fallback = false, optional = false) {
    signal?.throwIfAborted();
    const actual = await resolveReference(raw, from, kind, fallback, optional);
    if (actual) resourceHints.push({ kind, storage: 'file', actual, reference: raw, container: from });
    else if (!optional && missing.has(String(raw).trim())) resourceHints.push({ kind, storage: 'missing', reference: String(raw).trim(), container: from });
    return actual;
  }
  async function resolveReference(raw, from, kind = 'texture', fallback = false, optional = false) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    raw = raw.trim();
    if (/^data:/i.test(raw)) return null;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch {}
    decoded = decoded.replace(/\\/g, '/');
    const remote = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(decoded);
    if (remote && !fallback) { missing.add(raw); warnings.add(`已跳过外部或绝对路径引用：${raw}`); return null; }
    if (decoded.includes('\0') || decoded.length > 4096) { if (!optional) missing.add(raw.slice(0, 4096)); return null; }
    if (kind === 'texture' && !TEXTURES.has(ext(decoded))) {
      if (!optional) { missing.add(raw); warnings.add(`贴图格式未自动收集：${raw}`); }
      return null;
    }
    const options = remote ? [] : [path.resolve(path.dirname(from), decoded)];
    if (fallback) {
      const name = path.posix.basename(decoded);
      const directory = path.dirname(source), stem = path.basename(source, path.extname(source));
      for (const folder of ['', 'tex', 'Tex', 'textures', 'Textures', 'maps', 'Maps', `${stem}.fbm`]) options.push(path.join(directory, folder, name));
    }
    let lastError;
    for (const candidate of [...new Set(options)]) {
      try {
        const repairedHash = repairedFiles.get(candidate.toLowerCase());
        const requested = repair?.replacements.get(raw);
        if (repairedHash && requested && repairedHash !== requested.hash) continue;
        const actual = await add(candidate);
        if (remote || !same(actual, options[0])) warnings.add(`已从模型附近收集贴图：${path.basename(actual)}`);
        return actual;
      } catch (error) { signal?.throwIfAborted(); lastError = error; }
    }
    const restored = await restoredReference(raw, options, from, fallback);
    if (restored) return restored;
    if (!optional) missing.add(raw);
    if (!optional && lastError && !['ENOENT', 'ENOTDIR'].includes(lastError.code)) warnings.add(`未收集引用 ${raw}：${lastError.message}`);
    return null;
  }
  async function resourceFolder(directory, depth = 0) {
    signal?.throwIfAborted();
    if (depth > 8) { resourceComplete = false; warnings.add('贴图目录层级过深，部分文件未收集'); return; }
    let children;
    try {
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const child of children) {
      const filename = path.join(directory, child.name);
      if (child.isDirectory()) await resourceFolder(filename, depth + 1);
      else if (child.isFile() && TEXTURES.has(ext(filename))) await add(filename);
    }
  }
  async function parse(filename) {
    const key = process.platform === 'win32' ? filename.toLowerCase() : filename;
    if (parsed.has(key)) return;
    parsed.add(key);
    const type = ext(filename);
    if (type === 'glb' || type === 'gltf') {
      const data = await gltfReferences(filename, type === 'glb');
      resourceComplete &&= data.complete;
      for (const item of data.references) {
        if (item.embedded) {
          resourceHints.push({ kind: item.kind, storage: 'embedded', container: filename, reference: item.label });
        } else {
          const actual = await reference(item.reference, filename, item.referenceKind || item.kind);
          if (item.referenceKind) resourceHints.push({ kind: item.kind, storage: actual ? 'file' : 'missing', ...(actual ? { actual } : {}), container: filename, reference: item.label });
        }
      }
    } else if (type === 'obj') {
      for (const line of (await readText(filename)).split(/\r?\n/)) {
        const match = /^\s*mtllib\s+(.+?)\s*$/i.exec(line);
        if (!match) continue;
        const raw = match[1].replace(/\s+#.*$/, '').trim();
        const whole = words(raw).length === 1 ? words(raw)[0] : raw;
        let refs;
        try { await checked(path.resolve(path.dirname(filename), whole)); refs = [whole]; }
        catch { refs = words(raw); }
        for (const item of refs) { const mtl = await reference(item, filename, 'material'); if (mtl) await parse(mtl); }
      }
    } else if (type === 'mtl') {
      for (const line of (await readText(filename)).split(/\r?\n/)) {
        const match = /^\s*(?:map_\w+|bump|norm|disp|decal|refl)\s+(.+?)\s*$/i.exec(line);
        if (match) await reference(textureReference(match[1]), filename);
      }
    } else if (type === 'fbx' || NATIVE_EXTENSIONS.has(type)) {
      if (type === 'fbx') {
        try {
          for (const [index, media] of (await readFbxDependencies(filename, { signal })).entries()) {
            if (media.embedded) resourceHints.push({ kind: 'texture', storage: 'embedded', container: filename, reference: `${media.references[0] || media.name || '贴图'} #${index + 1}` });
            let found = false;
            // Filename and RelativeFilename are aliases of one media item.
            // A payload in another Video cannot satisfy this item's lookup.
            for (const item of media.references) {
              if (await reference(item, filename, 'texture', true, true)) { found = true; break; }
            }
            if (!media.embedded && !found && media.references.length) await reference(media.references[0], filename, 'texture', true);
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (repair) throw error;
          resourceComplete = false;
          warnings.add(`FBX 贴图引用未能完整读取：${error.message}`);
        }
      } else { resourceComplete = false; warnings.add('原工程的私有依赖无法完整静态解析，已收集附近常用贴图目录；其他外部资源请在原软件中检查。'); }
      const directory = path.dirname(filename), stem = path.basename(filename, path.extname(filename));
      for (const folder of ['tex', 'Tex', 'textures', 'Textures', 'maps', 'Maps', 'images', 'Images', 'materials', 'Materials', 'sourceimages', 'SourceImages', `${stem}.fbm`]) await resourceFolder(path.join(directory, folder));
      if (NATIVE_EXTENSIONS.has(type)) {
        // Native project references are private/renderer-specific. Preserve
        // loose texture files next to the project as well as common folders.
        for (const item of await fs.readdir(directory, { withFileTypes: true }))
          if (item.isFile() && !item.isSymbolicLink() && TEXTURES.has(ext(item.name))) await add(path.join(directory, item.name));
        for (const sideType of ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply']) {
          const sidecar = path.join(directory, `${stem}.${sideType}`);
          try { await checked(sidecar); } catch { continue; }
          await add(sidecar);
          try { await parse(sidecar); previewSource ||= sidecar; break; }
          catch (error) {
            signal?.throwIfAborted();
            if (repair) throw error;
            warnings.add(`同名预览文件无法读取：${path.basename(sidecar)}（${error.message}）`);
          }
        }
      }
    }
  }
  await add(source); await parse(source);
  let baseRoot = path.dirname(source);
  for (const file of files.values()) while (!within(baseRoot, file.source)) {
    const parent = path.dirname(baseRoot);
    if (parent === baseRoot) throw new Error('模型依赖不在同一文件系统');
    baseRoot = parent;
  }
  const planFiles = [...files.values()].map(file => ({ ...file, relative: slash(path.relative(baseRoot, file.source)) }));
  for (const file of planFiles) if (!isSafeBundlePath(file.relative)) throw new Error('模型资源文件名不能安全打包');
  planFiles.sort((a, b) => a.relative.localeCompare(b.relative, 'en'));
  const entry = slash(path.relative(baseRoot, source));
  const metadata = { version: 1, entry, files: planFiles.map(file => ({ path: file.relative, size: file.size, hash: file.hash })), missing: [...missing], warnings: [...warnings] };
  if (previewSource) metadata.previewEntry = slash(path.relative(baseRoot, previewSource));
  metadata.hash = modelBundleHash(metadata.files, entry); metadata.size = metadata.files.reduce((sum, file) => sum + file.size, 0);
  const hints = resourceHints.map(hint => ({ kind: hint.kind, storage: hint.storage,
    ...(hint.actual ? { path: slash(path.relative(baseRoot, hint.actual)) } : {}),
    ...(hint.container ? { container: slash(path.relative(baseRoot, hint.container)) } : {}),
    ...(typeof hint.reference === 'string' ? { reference: hint.reference.replace(/[\x00-\x1f]/g, '').slice(0, 4096) } : {}) }));
  metadata.resources = resourceSummary([...hints, ...fileResources(metadata.files)], resourceComplete);
  metadata.diagnostics = diagnostics(metadata.hash);
  return { baseRoot, entry, files: planFiles, missing: metadata.missing, warnings: metadata.warnings, hash: metadata.hash, size: metadata.size,
    resources: metadata.resources, diagnostics: metadata.diagnostics, ...(metadata.previewEntry ? { previewEntry: metadata.previewEntry } : {}) };
}

async function copyModelBundle(plan, destination) {
  if (!plan || !Array.isArray(plan.files) || !isSafeBundlePath(plan.entry) || !path.isAbsolute(destination)) throw new Error('模型包复制参数无效');
  destination = path.resolve(destination);
  // The caller owns the new destination; never overwrite a pre-existing folder.
  await fs.mkdir(destination);
  const files = [];
  try {
    for (const file of plan.files) {
      if (!isSafeBundlePath(file.relative) || !path.isAbsolute(file.source) || within(destination, file.source)) throw new Error('模型包来源或目标路径无效');
      const target = path.join(destination, ...file.relative.split('/'));
      if (!within(destination, target)) throw new Error('模型包文件路径越界');
      if ((await fs.lstat(file.source)).isSymbolicLink()) throw new Error('模型资源已变为符号链接');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file.source, target, constants.COPYFILE_EXCL);
      const size = (await fs.stat(target)).size, hash = await hashFile(target);
      if (size !== file.size || hash !== file.hash) throw new Error('模型资源在导入期间发生变化，请重新导入');
      files.push({ path: file.relative, size, hash });
    }
    const metadata = { version: 1, entry: plan.entry, files, missing: [...plan.missing], warnings: [...plan.warnings],
      hash: modelBundleHash(files, plan.entry), size: files.reduce((sum, file) => sum + file.size, 0) };
    if (plan.previewEntry) metadata.previewEntry = plan.previewEntry;
    if (plan.resources) metadata.resources = structuredClone(plan.resources);
    if (plan.diagnostics) metadata.diagnostics = structuredClone(plan.diagnostics);
    return validateModelBundle(metadata);
  } catch (error) {
    // Only this freshly-created destination can be removed on a failed copy.
    if (!path.isAbsolute(destination) || destination === path.parse(destination).root) throw error;
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { MODEL_EXTENSIONS, NATIVE_EXTENSIONS, collectModelBundle, copyModelBundle, validateModelBundle, modelBundleHash, isSafeBundlePath };
