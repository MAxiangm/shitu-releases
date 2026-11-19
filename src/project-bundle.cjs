'use strict';
const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isSafeBundlePath } = require('./model-bundle.cjs');
const { validateDiagnostics } = require('./bundle-diagnostics.cjs');

const PROJECT_EXTENSIONS = new Set(['aep', 'aepx']);
const MAX_FILES = 100000;
function validateCompositions(compositions) {
  if (!Array.isArray(compositions) || compositions.length > MAX_FILES) throw new Error('AE 合成清单无效');
  const ids = new Set();
  for (const composition of compositions) {
    if (!composition || !Number.isSafeInteger(composition.id) || composition.id < 1 || ids.has(composition.id) ||
        !Number.isSafeInteger(composition.index) || composition.index < 1 || typeof composition.name !== 'string' || composition.name.length > 4096 ||
        !Number.isFinite(composition.width) || composition.width <= 0 || !Number.isFinite(composition.height) || composition.height <= 0 ||
        !Number.isFinite(composition.duration) || composition.duration <= 0 || !Number.isFinite(composition.frameRate) || composition.frameRate <= 0)
      throw new Error('AE 合成信息无效');
    for (const key of ['workAreaStart', 'workAreaDuration', 'usedInCount'])
      if (composition[key] !== undefined && (!Number.isFinite(composition[key]) || composition[key] < 0)) throw new Error('AE 合成范围无效');
    ids.add(composition.id);
  }
  return compositions;
}
function projectBundleHash(files, entry) {
  const hash = crypto.createHash('sha256');
  if (!isSafeBundlePath(entry) || !Array.isArray(files) || !files.length) throw new Error('AE 工程包清单无效');
  hash.update(`shitu-ae-project-bundle-v1\0${entry}\0`);
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (!file || !isSafeBundlePath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.hash || '')) throw new Error('AE 工程包文件信息无效');
    hash.update(`${file.path}\0${file.size}\0${file.hash}\0`);
  }
  return hash.digest('hex');
}
function validateProjectBundle(value) {
  if (!value || value.version !== 1 || !isSafeBundlePath(value.entry) || !PROJECT_EXTENSIONS.has(path.posix.extname(value.entry).slice(1).toLowerCase()) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES) throw new Error('AE 工程包清单无效');
  const names = new Set(); let size = 0;
  for (const file of value.files) {
    if (!file || !isSafeBundlePath(file.path) || names.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.hash || '')) throw new Error('AE 工程包文件路径无效');
    names.add(file.path.toLowerCase()); size += file.size;
  }
  if (!value.files.some(file => file.path === value.entry) || !Number.isSafeInteger(size)) throw new Error('AE 工程包入口无效');
  for (const key of ['missing', 'warnings', ...(value.notes === undefined ? [] : ['notes'])]) if (!Array.isArray(value[key]) || value[key].length > MAX_FILES || value[key].some(item => typeof item !== 'string' || item.length > 4096)) throw new Error('AE 工程包提示信息无效');
  if (value.size !== size || value.hash !== projectBundleHash(value.files, value.entry)) throw new Error('AE 工程包校验值或大小无效');
  if (value.sourceIdentity !== undefined && !/^[a-f0-9]{64}$/.test(value.sourceIdentity)) throw new Error('AE 工程源校验值无效');
  if (value.collectedWithVersion !== undefined && (typeof value.collectedWithVersion !== 'string' || value.collectedWithVersion.length > 80)) throw new Error('AE 收集版本信息无效');
  if (value.compositions !== undefined) validateCompositions(value.compositions);
  validateDiagnostics(value, isSafeBundlePath);
  return value;
}
async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function copyProjectBundle(prepared, destination) {
  const manifest = validateProjectBundle(prepared?.manifest);
  if (typeof prepared.directory !== 'string' || !path.isAbsolute(prepared.directory) || typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('AE 工程包必须使用绝对路径');
  const directory = path.resolve(prepared.directory);
  destination = path.resolve(destination);
  if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw new Error('AE 工程临时包不能包含符号链接');
  if (await fs.realpath(path.dirname(destination)) !== path.dirname(destination)) throw new Error('AE 工程目标目录不能包含符号链接');
  if (inside(directory, destination) || inside(destination, directory) || destination === directory) throw new Error('AE 工程源包和目标包不能互相包含');
  // Check every source before creating the destination. Only declared files are
  // copied; collection job files and unrelated siblings never enter the asset.
  for (const file of manifest.files) {
    const source = path.resolve(directory, file.path);
    const info = await fs.lstat(source);
    if (!inside(directory, source) || !info.isFile() || info.isSymbolicLink() || await fs.realpath(source) !== source || info.size !== file.size || await hashFile(source) !== file.hash) throw new Error(`AE 工程包内容已变化或路径无效：${file.path}`);
  }
  await fs.mkdir(destination);
  const copied = [], folders = new Set(['']);
  try {
    for (const file of manifest.files) {
      const target = path.join(destination, file.path);
      let folder = path.posix.dirname(file.path);
      while (folder !== '.') { folders.add(folder); folder = path.posix.dirname(folder); }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(directory, file.path), target, constants.COPYFILE_EXCL);
      copied.push(file.path);
      const info = await fs.lstat(target);
      if (info.size !== file.size || await hashFile(target) !== file.hash) throw new Error(`AE 工程包复制校验失败：${file.path}`);
    }
    return structuredClone(manifest);
  } catch (error) {
    for (const file of copied) await fs.unlink(path.join(destination, file)).catch(() => {});
    const depth = value => value ? value.split('/').length : 0;
    for (const folder of [...folders].sort((a, b) => depth(b) - depth(a))) await fs.rmdir(path.join(destination, folder)).catch(() => {});
    throw error;
  }
}
module.exports = { PROJECT_EXTENSIONS, projectBundleHash, validateProjectBundle, validateCompositions, copyProjectBundle };
