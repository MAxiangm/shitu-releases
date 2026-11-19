'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIAGNOSTIC_VERSION = 1;
const PARSER_VERSION = 2;
const LEGACY_AE_NOTE = '字体、第三方插件、表达式动态引用及部分专用格式内部链接需在原软件中核对。';
const LEGACY_FBX_NOTE = 'FBX 含内嵌资源，同时保留找到的外置贴图；混合引用请在预览中核对。';
const MODEL_NOTES = new Set([LEGACY_FBX_NOTE, '贴图目录层级过深，部分文件未收集',
  '原工程的私有依赖无法完整静态解析，已收集附近常用贴图目录；其他外部资源请在原软件中检查。']);
const modelWarning = message => MODEL_NOTES.has(message) || /^(?:已跳过外部或绝对路径引用：|贴图格式未自动收集：|已从模型附近收集贴图：|未收集引用 |FBX 贴图引用未能完整读取：|同名预览文件无法读取：|模型内部依赖未完整解析：)/.test(message);
const MODEL = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'c4d', 'blend', 'max']);
const TEXTURE = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'tga', 'tif', 'tiff', 'dds', 'ktx', 'ktx2', 'hdr', 'exr', 'pic', 'psd', 'tx', 'tex']);
const extension = filename => path.extname(filename).slice(1).toLowerCase();
const normalized = filename => path.resolve(filename).normalize('NFC').toLowerCase();

function diagnostics(sourceHash) {
  return { version: DIAGNOSTIC_VERSION, parserVersion: PARSER_VERSION, checkedAt: new Date().toISOString(), sourceHash };
}
function resourceSummary(entries, complete = true) {
  const unique = new Map();
  for (const entry of entries) {
    // A buffer can contain several different images. Their image/bufferView
    // labels distinguish textures while ordinary image files remain unique.
    const imageInBuffer = entry.kind === 'texture' && entry.storage === 'file' && !TEXTURE.has(extension(entry.path));
    const identity = entry.storage === 'file' ? [entry.kind, entry.storage, entry.path, imageInBuffer ? entry.reference || '' : ''].join('\0')
      : [entry.kind, entry.storage, entry.container || '', entry.reference || ''].join('\0');
    if (!unique.has(identity)) unique.set(identity, entry);
  }
  const items = [...unique.values()];
  return { version: 1, complete, models: items.filter(item => item.kind === 'model').length,
    embeddedTextures: items.filter(item => item.kind === 'texture' && item.storage === 'embedded').length,
    externalTextures: items.filter(item => item.kind === 'texture' && item.storage === 'file').length,
    missingTextures: items.filter(item => item.kind === 'texture' && item.storage === 'missing').length, entries: items };
}
function fileResources(files, { project = false } = {}) {
  return files.flatMap(file => {
    const type = extension(file.path || file.relative), filename = file.path || file.relative;
    const kind = MODEL.has(type) ? 'model' : !project && TEXTURE.has(type) ? 'texture' : type === 'mtl' ? 'material' : type === 'bin' ? 'buffer' : null;
    return kind ? [{ kind, storage: 'file', path: filename }] : [];
  });
}
function validateDiagnostics(manifest, safePath) {
  const value = manifest.diagnostics;
  if (value !== undefined && (!value || value.version !== DIAGNOSTIC_VERSION || !Number.isSafeInteger(value.parserVersion) || value.parserVersion < 1 ||
      typeof value.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.checkedAt) || !Number.isFinite(Date.parse(value.checkedAt)) ||
      value.sourceHash !== manifest.hash)) throw new Error('资源包检查记录无效');
  const resources = manifest.resources;
  if (resources === undefined) return;
  if (!resources || resources.version !== 1 || typeof resources.complete !== 'boolean' || !Array.isArray(resources.entries) || resources.entries.length > 100000) throw new Error('资源包资源清单无效');
  const files = new Set(manifest.files.map(file => file.path));
  for (const entry of resources.entries) {
    if (!entry || !['model', 'texture', 'material', 'buffer'].includes(entry.kind) || !['file', 'embedded', 'missing'].includes(entry.storage) ||
        Object.keys(entry).some(key => !['kind', 'storage', 'path', 'container', 'reference'].includes(key)) ||
        entry.storage === 'file' && (!safePath(entry.path) || !files.has(entry.path)) ||
        entry.storage !== 'file' && entry.path !== undefined ||
        entry.container !== undefined && (!safePath(entry.container) || !files.has(entry.container)) ||
        entry.reference !== undefined && (typeof entry.reference !== 'string' || entry.reference.length > 4096 || /[\x00-\x1f]/.test(entry.reference) || /^data:[^,]*,/i.test(entry.reference)))
      throw new Error('资源包资源条目无效');
  }
  const expected = resourceSummary(resources.entries, resources.complete);
  for (const key of ['models', 'embeddedTextures', 'externalTextures', 'missingTextures'])
    if (!Number.isSafeInteger(resources[key]) || resources[key] !== expected[key]) throw new Error('资源包资源数量无效');
}
async function verifyFiles(directory, manifest, safePath, signal) {
  const rootInfo = await fs.lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || normalized(await fs.realpath(directory)) !== normalized(directory)) throw new Error('资源包目录无效');
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    if (!safePath(file.path)) throw new Error('资源包文件路径无效');
    let current = directory;
    for (const part of file.path.split('/')) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('资源包包含符号链接');
    }
    const info = await fs.lstat(current);
    if (!info.isFile() || info.size !== file.size || normalized(await fs.realpath(current)) !== normalized(current)) throw new Error(`资源包文件缺失或已变化：${file.path}`);
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(current)) { signal?.throwIfAborted(); hash.update(chunk); }
    if (hash.digest('hex') !== file.hash) throw new Error(`资源包文件内容已变化：${file.path}`);
  }
}
function rebaseResources(resources, baseRoot, directory) {
  const slash = filename => path.relative(directory, path.resolve(baseRoot, filename)).split(path.sep).join('/');
  return resources.entries.map(entry => ({ ...entry, ...(entry.path ? { path: slash(entry.path) } : {}), ...(entry.container ? { container: slash(entry.container) } : {}) }));
}
function verifyParsedFiles(plan, directory, manifest) {
  const known = new Map(manifest.files.map(file => [file.path, file]));
  for (const file of plan.files) {
    const relative = path.relative(directory, file.source).split(path.sep).join('/'), stored = known.get(relative);
    if (!stored || stored.hash !== file.hash || stored.size !== file.size) throw new Error(`资源包在检查期间发生变化：${relative}`);
  }
}
async function recheckStoredBundle(directory, manifest, { project = false, signal } = {}) {
  const { collectModelBundle, isSafeBundlePath } = require('./model-bundle.cjs');
  await verifyFiles(directory, manifest, isSafeBundlePath, signal);
  signal?.throwIfAborted();
  const entry = path.join(directory, manifest.entry);
  if (!project) {
    const plan = await collectModelBundle(entry, { allowedRoots: [directory], signal });
    verifyParsedFiles(plan, directory, manifest);
    const resources = resourceSummary([...rebaseResources(plan.resources, plan.baseRoot, directory), ...fileResources(manifest.files)], plan.resources.complete);
    return { missing: plan.missing, warnings: plan.warnings, resources, diagnostics: diagnostics(manifest.hash) };
  }
  let warnings = manifest.warnings.filter(message => message !== LEGACY_AE_NOTE);
  const notes = [...new Set([...(manifest.notes || []), ...(manifest.warnings.includes(LEGACY_AE_NOTE) ? [LEGACY_AE_NOTE] : [])])];
  const entries = fileResources(manifest.files, { project: true });
  const nestedMissing = [], nestedWarnings = [], modelFiles = manifest.files.filter(file => MODEL.has(extension(file.path)));
  let nestedComplete = true;
  for (const file of modelFiles) {
    signal?.throwIfAborted();
    const plan = await collectModelBundle(path.join(directory, file.path), { allowedRoots: [directory], signal });
    verifyParsedFiles(plan, directory, manifest);
    entries.push(...rebaseResources(plan.resources, plan.baseRoot, directory));
    nestedComplete &&= plan.resources.complete;
    nestedMissing.push(...plan.missing.map(reference => `模型依赖：${reference}`));
    nestedWarnings.push(...plan.warnings);
  }
  // Legacy project manifests flattened model issues into AE diagnostics. Only
  // replace recognized model entries after actually inspecting stored models;
  // unrelated footage and unrecognized warnings remain untouched.
  if (modelFiles.length) warnings = warnings.filter(message => !modelWarning(message));
  const missing = modelFiles.length && nestedComplete ? manifest.missing.filter(reference => !reference.startsWith('模型依赖：')) : manifest.missing;
  return { missing: [...new Set([...missing, ...nestedMissing])], warnings: [...new Set([...warnings, ...nestedWarnings])], notes,
    resources: resourceSummary(entries, false), diagnostics: diagnostics(manifest.hash) };
}

module.exports = { DIAGNOSTIC_VERSION, PARSER_VERSION, diagnostics, resourceSummary, fileResources, validateDiagnostics, recheckStoredBundle };
