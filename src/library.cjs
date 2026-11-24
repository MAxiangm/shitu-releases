const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const sharp = require('sharp');

const { IMAGE, VIDEO, AUDIO, MODEL, MODEL_NATIVE, PROJECT, FONT, DOCUMENT, SUPPORTED } = require('./media-formats.cjs');
const { collectModelBundle, copyModelBundle, validateModelBundle, isSafeBundlePath } = require('./model-bundle.cjs');
const { validateProjectBundle, copyProjectBundle } = require('./project-bundle.cjs');
const FolderTree = require('./folder-tree.js');
const ColorLabels = require('./color-labels.js');
const FolderIcons = require('./folder-icons.js');
const FolderIconFiles = require('./folder-icons.cjs');
const AssetExport = require('./asset-export.cjs');
const { MetadataHistory, sameField } = require('./metadata-history.cjs');
const SmartFolders = require('./smart-folders.js');
const ReimbursementFolders = require('./reimbursement-folders.cjs');
const { recheckStoredBundle } = require('./bundle-diagnostics.cjs');
const mediaType = (ext, stored) => PROJECT.has(ext) ? 'project' : MODEL.has(ext) ? 'model'
  : (AUDIO.has(ext) && (!VIDEO.has(ext) || stored === 'audio')) ? 'audio'
    : VIDEO.has(ext) ? 'video' : FONT.has(ext) ? 'font' : DOCUMENT.has(ext) ? 'document' : 'image';
const bundleRelative = (id, ext) => `originals/${id}.${PROJECT.has(ext) ? 'project' : 'model'}`;
const isBundle = ext => MODEL.has(ext) || PROJECT.has(ext);
const assetBundle = asset => PROJECT.has(asset.ext) ? asset.projectBundle : asset.modelBundle;
const deletionBundle = file => file.projectBundle || file.modelBundle;
const importPathKey = filename => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);

async function checkBundleTree(directory, paths) {
  const allowed = new Set(paths);
  const folders = new Set(['']);
  for (const relative of paths) {
    if (!isSafeBundlePath(relative)) throw new Error('模型包文件路径无效');
    let folder = path.posix.dirname(relative);
    while (folder !== '.') { folders.add(folder); folder = path.posix.dirname(folder); }
  }
  const visit = async (current, relative = '') => {
    const info = await fileInfo(current);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('模型包目录无效或包含符号链接');
    for (const name of await fs.readdir(current)) {
      const child = relative ? `${relative}/${name}` : name;
      const childPath = path.join(current, name);
      const childInfo = await fs.lstat(childPath);
      if (childInfo.isSymbolicLink()) throw new Error('模型包包含符号链接，已保留');
      if (childInfo.isDirectory()) {
        if (!folders.has(child)) throw new Error('模型包包含未知目录，已保留');
        await visit(childPath, child);
      } else if (!childInfo.isFile() || !allowed.has(child)) throw new Error('模型包包含未知文件，已保留');
    }
  };
  await visit(directory);
  const depth = value => value ? value.split('/').length : 0;
  return [...folders].sort((left, right) => depth(right) - depth(left));
}

async function removeBundleFiles(directory, paths) {
  // The caller supplies a validated UUID package directory or deletion staging
  // directory. Enumerate known contents before removing anything in that tree.
  const folders = await checkBundleTree(directory, paths);
  for (const relative of paths) await fs.unlink(path.join(directory, relative)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  for (const relative of folders) await fs.rmdir(path.join(directory, relative)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
const VIDEO_PREVIEW_METADATA = Object.freeze({
  pixelFormat: value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value),
  audioCodec: value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{0,80}$/.test(value),
  streamIndex: value => Number.isInteger(value) && value >= 0 && value <= 2147483647,
  colorSpace: value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{0,80}$/.test(value),
  rotation: value => Number.isFinite(value) && value >= -360 && value <= 360
});
const AUDIO_METADATA = Object.freeze({
  sampleRate: value => Number.isInteger(value) && value >= 0 && value <= 50000000,
  channels: value => Number.isInteger(value) && value >= 0 && value <= 64,
  bitrate: value => Number.isInteger(value) && value >= 0 && value <= 1000000000,
  bitsPerSample: value => Number.isInteger(value) && value >= 0 && value <= 64
});
const AUDIO_TAGS = new Set(['title', 'artist', 'album', 'albumArtist', 'genre', 'track', 'date']);
function audioTags(value, strict = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new Error('音乐标签无效');
    return undefined;
  }
  const result = {};
  for (const [key, text] of Object.entries(value)) {
    if (!AUDIO_TAGS.has(key) || typeof text !== 'string' || !text.trim() || text.length > 512 || /[\x00-\x1f\x7f]/.test(text)) {
      if (strict) throw new Error('音乐标签无效');
      continue;
    }
    result[key] = text;
  }
  return result;
}
const FONT_METADATA = Object.freeze({
  family: value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value),
  style: value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value),
  fullName: value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value),
  postscriptName: value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value),
  faceCount: value => Number.isInteger(value) && value >= 1 && value <= 128
});
function fontMetadata(value, strict = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new Error('字体信息无效');
    return undefined;
  }
  const result = {};
  if (strict && Object.keys(value).some(key => !Object.hasOwn(FONT_METADATA, key))) throw new Error('字体信息包含无效属性');
  for (const [key, valid] of Object.entries(FONT_METADATA)) {
    if (!Object.hasOwn(value, key)) continue;
    if (valid(value[key])) result[key] = value[key];
    else if (strict) throw new Error('字体信息无效');
  }
  return Object.keys(result).length ? result : undefined;
}
function mediaMetadata(value = {}, video = false, audio = false) {
  const result = {};
  for (const key of ['width', 'height', 'duration']) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) result[key] = number;
  }
  if (typeof value.codec === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value.codec)) result.codec = value.codec;
  for (const key of ['hasAudio', 'hasAlpha']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (video) for (const [key, valid] of Object.entries(VIDEO_PREVIEW_METADATA)) if (valid(value[key])) result[key] = value[key];
  if (audio) {
    for (const [key, valid] of Object.entries(AUDIO_METADATA)) if (valid(value[key])) result[key] = value[key];
    if (VIDEO_PREVIEW_METADATA.audioCodec(value.audioCodec)) result.audioCodec = value.audioCodec;
    const tags = audioTags(value.audio); if (tags) result.audio = tags;
  }
  return result;
}
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const PENDING_DELETE = /^\.pending-delete-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PENDING_BUNDLE_REPAIR = /^\.pending-repair-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PENDING_REIMBURSEMENT = /^\.pending-reimbursement-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isIndexTemporary(root, filename) {
  return path.dirname(filename) === root && /^index\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(path.basename(filename));
}
const bundleRepairValidator = ext => PROJECT.has(ext) ? validateProjectBundle : validateModelBundle;

function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  if (value.trim().length > limit) throw new Error(`${label}不能超过 ${limit} 个字符`);
  return value.trim();
}

function webUrl(value, label) {
  const input = text(value, label, 8192);
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error(`${label}必须是有效的 HTTP 或 HTTPS 链接`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /[\x00-\x20\x7f]/.test(input)) throw new Error(`${label}必须是有效的 HTTP 或 HTTPS 链接，不能包含账号密码`);
  return parsed.href;
}

function importMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('导入来源信息无效');
  const clean = {};
  for (const key of Object.keys(metadata)) if (!['name', 'sourceUrl', 'pageUrl'].includes(key)) throw new Error(`不支持导入属性 ${key}`);
  if ('name' in metadata) clean.name = text(metadata.name, '名称', 240);
  if ('sourceUrl' in metadata) clean.sourceUrl = webUrl(metadata.sourceUrl, '素材链接');
  if ('pageUrl' in metadata) clean.pageUrl = webUrl(metadata.pageUrl, '来源网页');
  return clean;
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function replaceIndexFile(source, destination) {
  // Windows scanners and readers can briefly deny replacing an existing file.
  // Retry the atomic rename itself; never unlink the current valid index.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function copyFileAtomically(source, destination) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary, require('node:fs').constants.COPYFILE_EXCL);
    const handle = await fs.open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    // Replacing the directory entry avoids following a backup file that was
    // hard-linked or symlinked to another document and keeps crash recovery whole.
    await replaceIndexFile(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function deletionFiles(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error('永久删除清单无效');
  const ids = new Set();
  return manifest.assets.flatMap(asset => {
    if (!asset || typeof asset.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(asset.id) || ids.has(asset.id) || !SUPPORTED.has(asset.ext) || typeof asset.hasThumbnail !== 'boolean') throw new Error('永久删除清单路径无效');
    ids.add(asset.id);
    let original;
    if (PROJECT.has(asset.ext)) {
      validateProjectBundle(asset.projectBundle);
      original = { id: asset.id, relative: bundleRelative(asset.id, asset.ext), staged: `${asset.id}.project`, projectBundle: asset.projectBundle };
    } else if (MODEL.has(asset.ext)) {
      validateModelBundle(asset.modelBundle);
      original = { id: asset.id, relative: bundleRelative(asset.id), staged: `${asset.id}.model`, modelBundle: asset.modelBundle };
    } else original = { id: asset.id, relative: `originals/${asset.id}.${asset.ext}`, staged: `${asset.id}.${asset.ext}` };
    const files = [original];
    if (asset.hasThumbnail) files.push({ id: asset.id, relative: `thumbnails/${asset.id}.jpg`, staged: `${asset.id}.thumbnail.jpg` });
    return files;
  });
}

async function fileInfo(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function projectPreviewMetadata(value, hash) {
  const composition = value?.composition;
  if (!value || value.version !== 1 || value.sourceHash !== hash || !composition ||
      !Number.isSafeInteger(composition.id) || composition.id < 1 || !Number.isSafeInteger(composition.index) || composition.index < 1 ||
      typeof composition.name !== 'string' || composition.name.length > 4096 ||
      !Number.isFinite(value.width) || value.width <= 0 || !Number.isFinite(value.height) || value.height <= 0 ||
      !Number.isFinite(value.duration) || value.duration <= 0 ||
      !Number.isFinite(value.frameRate) || value.frameRate <= 0 || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)))
    throw new Error('AE 预览信息无效');
  // Only public metadata enters the library index. Cache paths and renderer
  // authorizations belong to the preview service, not to the source package.
  return { version: 1, sourceHash: hash, composition: { id: composition.id, index: composition.index, name: composition.name },
    width: value.width, height: value.height, duration: value.duration,
    frameRate: value.frameRate, generatedAt: value.generatedAt };
}

class Library {
  constructor({ root, createThumbnail, prepareProjectBundle } = {}) {
    if (!root) throw new Error('素材库路径不能为空');
    this.root = path.resolve(root);
    this.indexPath = path.join(this.root, 'index.json');
    this.createThumbnail = createThumbnail;
    this.prepareProjectBundle = prepareProjectBundle;
    this.data = null;
    this._queue = Promise.resolve();
    this._history = new MetadataHistory();
    this._reimbursementRecoveryPending = false;
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
      this._validate(data);
      this.data = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`素材库索引无法读取，已保留原文件。请从备份恢复：${error.message}`);
      const backupExists = await fs.access(path.join(this.root, 'index.backup.json')).then(() => true, failure => { if (failure.code === 'ENOENT') return false; throw failure; });
      const originalFiles = await fs.readdir(path.join(this.root, 'originals')).catch(failure => { if (failure.code === 'ENOENT') return []; throw failure; });
      const thumbnailFiles = await fs.readdir(path.join(this.root, 'thumbnails')).catch(failure => { if (failure.code === 'ENOENT') return []; throw failure; });
      const folderIconFiles = await fs.readdir(path.join(this.root, 'folder-icons')).catch(failure => { if (failure.code === 'ENOENT') return []; throw failure; });
      const pendingDeletion = (await fs.readdir(this.root)).some(name => PENDING_DELETE.test(name) || PENDING_BUNDLE_REPAIR.test(name) || PENDING_REIMBURSEMENT.test(name));
      if (backupExists || originalFiles.length || thumbnailFiles.length || folderIconFiles.length || pendingDeletion) throw new Error('素材库索引缺失，但发现已有素材或备份，已保留原文件。请恢复 index.json 后重新打开。');
      const data = { version: 1, assets: [], folders: [] };
      await this._persist(data);
    }
    await fs.mkdir(path.join(this.root, 'originals'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'thumbnails'), { recursive: true });
    await this._checkManagedParent('originals/check');
    await this._checkManagedParent('thumbnails/check');
    await this._recoverReimbursementDocuments();
    await this._recoverBundleRepairs();
    await this._recoverPendingDeletions();
    return this.snapshot();
  }

  _validate(data) {
    if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.assets) || !Array.isArray(data.folders)) throw new Error('索引格式无效或版本不受支持');
    FolderTree.validate(data.folders);
    if ('smartFolders' in data) {
      if (!Array.isArray(data.smartFolders) || data.smartFolders.length > 500) throw new Error('智能文件夹列表无效');
      const ids = new Set();
      for (const folder of data.smartFolders) {
        if (!folder || typeof folder !== 'object' || Array.isArray(folder) || Object.keys(folder).some(key => !['id', 'name', 'rule', 'createdAt', 'updatedAt'].includes(key)) ||
            typeof folder.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(folder.id) || ids.has(folder.id)) throw new Error('智能文件夹无效');
        SmartFolders.validateName(folder.name); SmartFolders.validateRule(folder.rule);
        if (![folder.createdAt, folder.updatedAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))) throw new Error('智能文件夹日期无效');
        ids.add(folder.id);
      }
    }
    for (const folder of data.folders) {
      ColorLabels.normalize(folder.colorLabel);
      FolderIcons.normalizeIcon(folder.icon);
      FolderIcons.normalizeColor(folder.iconColor);
    }
    const folderIds = new Set(data.folders.map(folder => folder.id));
    const assetIds = new Set();
    for (const asset of data.assets) {
      if (asset) ColorLabels.normalize(asset.colorLabel);
      if (!asset || typeof asset.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(asset.id) || assetIds.has(asset.id) || typeof asset.name !== 'string' || !SUPPORTED.has(asset.ext) || !Array.isArray(asset.tags) || asset.tags.some(tag => typeof tag !== 'string') || typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.hash) || !Number.isFinite(asset.size) || asset.size < 0 || !Number.isFinite(asset.rating) || asset.rating < 0 || asset.rating > 5 || typeof asset.notes !== 'string' || (asset.folderId !== null && !folderIds.has(asset.folderId))) throw new Error('素材索引无效');
      if (PROJECT.has(asset.ext)) {
        validateProjectBundle(asset.projectBundle);
        if (path.posix.extname(asset.projectBundle.entry).slice(1).toLowerCase() !== asset.ext || asset.projectBundle.hash !== asset.hash || asset.projectBundle.size !== asset.size || asset.filename !== `${bundleRelative(asset.id, asset.ext)}/${asset.projectBundle.entry}` || 'modelBundle' in asset) throw new Error('AE 工程包索引无效');
      } else if (MODEL.has(asset.ext)) {
        validateModelBundle(asset.modelBundle);
        if (path.posix.extname(asset.modelBundle.entry).slice(1).toLowerCase() !== asset.ext || asset.modelBundle.hash !== asset.hash || asset.modelBundle.size !== asset.size || asset.filename !== `${bundleRelative(asset.id)}/${asset.modelBundle.entry}` || 'projectBundle' in asset) throw new Error('模型包索引无效');
      } else if (asset.filename !== `originals/${asset.id}.${asset.ext}` || 'modelBundle' in asset || 'projectBundle' in asset) throw new Error('素材路径无效');
      if (asset.thumbnail !== null && asset.thumbnail !== `thumbnails/${asset.id}.jpg`) throw new Error('缩略图路径无效');
      if ('videoThumbnailRevision' in asset && (mediaType(asset.ext, asset.mediaType) !== 'video' || !asset.thumbnail ||
          typeof asset.videoThumbnailRevision !== 'string' || !/^[a-f0-9-]{36}$/.test(asset.videoThumbnailRevision))) throw new Error('视频封面记录无效');
      if ('mediaType' in asset && asset.mediaType !== mediaType(asset.ext, asset.mediaType)) throw new Error('素材媒体类型无效');
      if ('audio' in asset) {
        if (mediaType(asset.ext, asset.mediaType) !== 'audio') throw new Error('音乐信息素材类型无效');
        audioTags(asset.audio, true);
      }
      for (const [key, valid] of Object.entries(AUDIO_METADATA)) if (key in asset &&
          (mediaType(asset.ext, asset.mediaType) !== 'audio' || !valid(asset[key]))) throw new Error('音乐技术信息无效');
      if ('font' in asset) {
        if (!FONT.has(asset.ext)) throw new Error('字体信息素材类型无效');
        fontMetadata(asset.font, true);
      }
      if ('duration' in asset && (!Number.isFinite(asset.duration) || asset.duration < 0)) throw new Error('视频时长无效');
      if ('projectPreview' in asset) {
        if (!PROJECT.has(asset.ext)) throw new Error('AE 预览素材类型无效');
        projectPreviewMetadata(asset.projectPreview, asset.hash);
      }
      if ('codec' in asset && (typeof asset.codec !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(asset.codec))) throw new Error('视频编码无效');
      for (const [key, valid] of Object.entries(VIDEO_PREVIEW_METADATA)) if (key in asset && !valid(asset[key])) throw new Error('视频预览信息无效');
      if ('sourceUrl' in asset) webUrl(asset.sourceUrl, '素材链接');
      if ('pageUrl' in asset) webUrl(asset.pageUrl, '来源网页');
      assetIds.add(asset.id);
    }
    if (data.folders.some(folder => ReimbursementFolders.isRoot(folder) || 'reimbursement' in folder || 'reimbursementRootId' in folder || 'reimbursementCategory' in folder) ||
        data.assets.some(asset => 'reimbursementGenerated' in asset || 'reimbursementSupplementInvoice' in asset || 'reimbursementAmounts' in asset || 'reimbursementEvidenceAmounts' in asset)) {
      ReimbursementFolders.validate(data.folders, data.assets);
      const categories = ReimbursementFolders.categoryMap(data.folders);
      const itineraryByFolder = new Map();
      for (const asset of data.assets) if (!IMAGE.has(asset.ext) && asset.ext !== 'pdf') {
        if (categories.get(asset.folderId) === 'supplement') throw new Error('补票分类只接受图片或 PDF');
        if (!itineraryByFolder.has(asset.folderId)) itineraryByFolder.set(asset.folderId, Boolean(ReimbursementFolders.itineraryRootForFolder(data.folders, asset.folderId)));
        if (itineraryByFolder.get(asset.folderId)) throw new Error('打车行程单只接受图片或 PDF');
      }
    }
  }

  _ready() { if (!this.data) throw new Error('素材库尚未初始化'); }

  async flush() { await this._queue; }

  async _persist(data) {
    // Older releases ignore folder parents. Mark a hierarchical library with a
    // format they reject, and retain that format after the last child is removed.
    // Keep the caller's draft and current data untouched until the write succeeds.
    if (data?.version === 1 && (this.data?.version === 2 || Array.isArray(data.folders) && data.folders.some(folder => FolderTree.parentId(folder) !== null))) data = { ...data, version: 2 };
    this._validate(data);
    const temporary = `${this.indexPath}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify(data, null, 2), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      try { await copyFileAtomically(this.indexPath, path.join(this.root, 'index.backup.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await replaceIndexFile(temporary, this.indexPath);
      this.data = data;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  _mutate(work) {
    const result = this._queue.then(async () => {
      this._ready();
      if (this._reimbursementRecoveryPending) await this._recoverReimbursementDocuments();
      return work();
    });
    this._queue = result.catch(() => {});
    return result;
  }

  historyState() { this._ready(); return this._history.state(); }

  _recordHistory(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        (options.recordHistory !== undefined && typeof options.recordHistory !== 'boolean')) throw new Error('操作历史设置无效');
    return options.recordHistory === true;
  }

  _replayHistory(direction, { expectedId } = {}) {
    return this._mutate(async () => {
      const entry = this._history.peek(direction, expectedId);
      const draft = this._history.apply(this.data, entry, direction);
      try { this._validate(draft); }
      catch (error) { throw new Error(`操作发生冲突：${error.message}`); }
      await this._persist(draft);
      this._history.commit(direction, entry);
      return this.snapshot();
    });
  }

  undo(options = {}) { return this._replayHistory('undo', options); }
  redo(options = {}) { return this._replayHistory('redo', options); }

  listFolders() {
    this._ready();
    return FolderTree.flatten(this.data.folders).map(({ id, name, parentId = null }) => ({ id, name, parentId }));
  }

  hasAsset(id) {
    this._ready();
    return this.data.assets.some(asset => asset.id === id);
  }

  snapshot() {
    this._ready();
    const assets = clone(this.data.assets).map(asset => ({ ...asset, mediaType: mediaType(asset.ext, asset.mediaType), colorLabel: ColorLabels.normalize(asset.colorLabel) }));
    const active = assets.filter(asset => !asset.trashedAt);
    const tagCounts = new Map();
    for (const asset of active) for (const tag of asset.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    return {
      root: this.root,
      history: this.historyState(),
      assets,
      folders: clone(this.data.folders).map(folder => ({ ...folder, parentId: FolderTree.parentId(folder), colorLabel: ColorLabels.normalize(folder.colorLabel) })),
      smartFolders: clone(this.data.smartFolders || []),
      tags: [...tagCounts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      stats: { total: assets.length, active: active.length, trashed: assets.length - active.length, untagged: active.filter(a => !a.tags.length).length, unfiled: active.filter(a => !a.folderId).length, bytes: assets.reduce((sum, a) => sum + a.size, 0) }
    };
  }

  importPaths(paths, options = {}) {
    return this._importPaths(paths, options);
  }

  importModelPackage({ root, entryPath, files, metadata = {}, folderId = null, onProgress } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || typeof entryPath !== 'string' || !path.isAbsolute(entryPath) ||
        !Array.isArray(files) || !files.length || files.length > 4096) throw new Error('模型下载包参数无效');
    root = path.resolve(root); entryPath = path.resolve(entryPath);
    const relative = path.relative(root, entryPath).split(path.sep).join('/');
    const names = new Set();
    for (const file of files) {
      if (!isSafeBundlePath(file) || names.has(file.toLowerCase())) throw new Error('模型下载包文件路径无效');
      names.add(file.toLowerCase());
    }
    if (!isSafeBundlePath(relative) || !names.has(relative.toLowerCase()) || !MODEL.has(path.extname(entryPath).slice(1).toLowerCase())) {
      throw new Error('模型入口不在下载包清单内');
    }
    return this._importPaths([entryPath], { folderId, onProgress, metadata }, { root, files: [...files] });
  }

  _importPaths(paths, { folderId = null, onProgress, metadata = {}, restoreTrashed = false } = {}, modelPackage) {
    return this._mutate(async () => {
      if (!Array.isArray(paths)) throw new Error('导入路径必须是数组');
      if (typeof restoreTrashed !== 'boolean') throw new Error('回收站恢复选项无效');
      const sourceMetadata = importMetadata(metadata);
      this._folder(folderId);
      const targetCategory = ReimbursementFolders.categoryForFolder(this.data.folders, folderId);
      const targetItinerary = ReimbursementFolders.itineraryRootForFolder(this.data.folders, folderId);
      if (restoreTrashed && !targetCategory && !targetItinerary) throw new Error('仅能在有效的报销分类或行程单目录中恢复重复文件');
      const report = { imported: 0, restored: 0, duplicates: 0, unsupported: [], errors: [], assetIds: [], restoredAssetIds: [], warnings: [] };
      if (modelPackage) report.existingAssets = [];
      const projectPreparations = [];
      try {
      let candidates = [];
      const seen = new Set();
      const seenFiles = new Map();
      const explicitFiles = new Set(paths.map(entry => importPathKey(String(entry))));
      const allowedRoots = modelPackage ? [modelPackage.root] : [];
      const walk = async (entry, explicit = false) => {
        const absolute = path.resolve(String(entry));
        if (seen.has(absolute)) {
          const prior = seenFiles.get(absolute), ext = path.extname(absolute).slice(1).toLowerCase();
          if (restoreTrashed && explicit && prior && (IMAGE.has(ext) || DOCUMENT.has(ext))) candidates.push(prior);
          return;
        }
        seen.add(absolute);
        try {
          if (isWithin(this.root, absolute)) { report.errors.push({ path: absolute, message: '不能将素材库自身再次导入' }); return; }
          const info = await fs.lstat(absolute);
          if (info.isSymbolicLink()) { report.errors.push({ path: absolute, message: '已跳过符号链接' }); return; }
          if (info.isDirectory()) {
            if (explicit) allowedRoots.push(absolute);
            const children = await fs.readdir(absolute);
            for (const child of children) await walk(path.join(absolute, child));
          } else if (info.isFile()) {
            if (SUPPORTED.has(path.extname(absolute).slice(1).toLowerCase())) {
              const candidate = { absolute, info }; candidates.push(candidate); seenFiles.set(absolute, candidate);
            }
            else report.unsupported.push(absolute);
          }
        } catch (error) { report.errors.push({ path: absolute, message: error.message }); }
      };
      for (const entry of paths) await walk(entry, true);
      const plans = new Map();
      const dependencies = new Set();
      const projectPlans = new Map();
      const projectDependencies = new Set();
      for (const candidate of candidates) {
        if (!PROJECT.has(path.extname(candidate.absolute).slice(1).toLowerCase())) continue;
        try {
          if (typeof this.prepareProjectBundle !== 'function') throw new Error('AE 工程自动收集需要本机可用的 After Effects，请安装或检查 AE 后重试');
          const prepared = await this.prepareProjectBundle(candidate.absolute, { allowedRoots });
          projectPreparations.push(prepared);
          validateProjectBundle(prepared?.manifest);
          if (isWithin(this.root, path.resolve(prepared.directory))) throw new Error('不能将素材库自身作为 AE 工程收集目录');
          for (const filename of prepared.sourceFiles || []) {
            if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('AE 工程依赖路径无效');
            if (isWithin(this.root, filename)) throw new Error('不能导入素材库自身的 AE 工程依赖');
            if (importPathKey(filename) !== importPathKey(candidate.absolute)) { projectDependencies.add(importPathKey(filename)); dependencies.add(importPathKey(filename)); }
          }
          projectPlans.set(candidate.absolute, prepared);
        } catch (error) { report.errors.push({ path: candidate.absolute, message: error.message }); }
      }
      for (const candidate of candidates) {
        if (projectDependencies.has(importPathKey(candidate.absolute)) && !explicitFiles.has(importPathKey(candidate.absolute))) continue;
        if (!MODEL.has(path.extname(candidate.absolute).slice(1).toLowerCase())) continue;
        try {
          const plan = await collectModelBundle(candidate.absolute, { allowedRoots,
            ...(modelPackage ? { packageRoot: modelPackage.root, packageFiles: modelPackage.files } : {}) });
          if (modelPackage && plan.missing.length) throw new Error('模型下载包缺少入口引用的资源文件');
          for (const file of plan.files) {
            if (isWithin(this.root, file.source)) throw new Error('不能导入素材库自身的模型依赖');
            if (importPathKey(file.source) !== importPathKey(candidate.absolute)) dependencies.add(importPathKey(file.source));
          }
          plans.set(candidate.absolute, plan);
        } catch (error) { report.errors.push({ path: candidate.absolute, message: error.message }); }
      }
      // A dropped project folder becomes one model asset with its textures.
      // Separately selected image files still import as independent images.
      candidates = candidates.filter(({ absolute }) => {
        const ext = path.extname(absolute).slice(1).toLowerCase();
        if (projectDependencies.has(importPathKey(absolute)) && !explicitFiles.has(importPathKey(absolute))) return false;
        if (PROJECT.has(ext)) return projectPlans.has(absolute);
        return MODEL.has(ext) ? plans.has(absolute) && (MODEL_NATIVE.has(ext) || explicitFiles.has(importPathKey(absolute)) || !dependencies.has(importPathKey(absolute)))
          : explicitFiles.has(importPathKey(absolute)) || !dependencies.has(importPathKey(absolute));
      });
      report.unsupported = report.unsupported.filter(filename => !dependencies.has(importPathKey(filename)));
      const draft = clone(this.data);
      const hashes = new Set(draft.assets.map(asset => asset.hash));
      const created = [];
      const duplicate = async (hash, ext) => {
        if (restoreTrashed && (IMAGE.has(ext) || DOCUMENT.has(ext))) {
          const matches = draft.assets.filter(asset => asset.hash === hash);
          const active = matches.find(asset => !asset.trashedAt && asset.folderId === folderId) || matches.find(asset => !asset.trashedAt);
          const asset = !active && matches.find(asset => asset.trashedAt && !asset.reimbursementGenerated && (IMAGE.has(asset.ext) || DOCUMENT.has(asset.ext)));
          if (asset) {
            if (targetCategory === 'supplement' && !IMAGE.has(asset.ext) && asset.ext !== 'pdf') throw new Error('补票分类只接受图片或 PDF');
            if (targetItinerary && !IMAGE.has(asset.ext) && asset.ext !== 'pdf') throw new Error('打车行程单只接受图片或 PDF');
            await this._checkManagedParent(asset.filename);
            const original = path.join(this.root, asset.filename);
            const info = await fs.lstat(original).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (!info || !info.isFile() || info.isSymbolicLink() || await hashFile(original) !== hash) throw new Error('回收站原件缺失或已变化，无法恢复，请先检查原文件');
            Object.assign(asset, { folderId, trashedAt: null, updatedAt: now() });
            report.restored++; report.restoredAssetIds.push(asset.id);
            return;
          }
        }
        report.duplicates++;
      };
      for (let index = 0; index < candidates.length; index++) {
        const { absolute, info } = candidates[index];
        let copied = null;
        let thumbnailPath = null;
        let modelPlan = null;
        let projectPlan = null;
        try {
          const ext = path.extname(absolute).slice(1).toLowerCase();
          if (!IMAGE.has(ext) && ext !== 'pdf' && ReimbursementFolders.categoryForFolder(draft.folders, folderId) === 'supplement') throw new Error('补票分类只接受图片或 PDF');
          if (!IMAGE.has(ext) && ext !== 'pdf' && targetItinerary) throw new Error('打车行程单只接受图片或 PDF');
          if (PROJECT.has(ext)) {
            projectPlan = projectPlans.get(absolute);
            const manifest = projectPlan.manifest;
            const sameSource = manifest.sourceIdentity && draft.assets.some(asset => asset.projectBundle?.sourceIdentity === manifest.sourceIdentity);
            if (hashes.has(manifest.hash) || sameSource) report.duplicates++;
            else {
              const id = crypto.randomUUID();
              const relativeDirectory = bundleRelative(id, ext);
              const projectDirectory = path.join(this.root, relativeDirectory);
              await this._checkManagedParent(relativeDirectory);
              const projectBundle = await copyProjectBundle(projectPlan, projectDirectory);
              copied = projectDirectory;
              const filename = `${relativeDirectory}/${projectBundle.entry}`;
              const entryExtension = path.posix.extname(projectBundle.entry).slice(1).toLowerCase();
              let dimensions = {}, thumbnail = null;
              if (this.createThumbnail) {
                await this._checkManagedParent(`thumbnails/${id}.jpg`);
                thumbnailPath = path.join(this.root, 'thumbnails', `${id}.jpg`);
                try {
                  dimensions = await this.createThumbnail(path.join(this.root, filename), thumbnailPath, { projectBundle, projectDirectory: copied }) || {};
                  await fs.access(thumbnailPath); thumbnail = `thumbnails/${id}.jpg`;
                } catch { await fs.rm(thumbnailPath, { force: true }).catch(() => {}); thumbnailPath = null; }
              }
              const timestamp = now();
              draft.assets.push({ id, name: path.basename(absolute, path.extname(absolute)), ext: entryExtension, mediaType: 'project', size: projectBundle.size,
                width: Number(dimensions.width) || 0, height: Number(dimensions.height) || 0, hash: projectBundle.hash,
                createdAt: timestamp, updatedAt: timestamp, tags: [], folderId, rating: 0, notes: '', trashedAt: null,
                filename, thumbnail, projectBundle, ...sourceMetadata });
              hashes.add(projectBundle.hash);
              created.push({ path: copied, files: projectBundle.files.map(file => file.path) });
              if (thumbnail) created.push({ path: thumbnailPath });
              for (const message of projectBundle.warnings) report.warnings.push({ path: absolute, message });
              if (projectBundle.missing.length) report.warnings.push({ path: absolute,
                message: `有 ${projectBundle.missing.length} 个 AE 工程引用未收集：${projectBundle.missing.slice(0, 3).join('、')}` });
              report.imported++; report.assetIds.push(id);
            }
          } else if (MODEL.has(ext)) {
            modelPlan = plans.get(absolute);
            if (hashes.has(modelPlan.hash)) {
              report.duplicates++;
              if (modelPackage) report.existingAssets.push(...draft.assets.filter(asset => asset.hash === modelPlan.hash)
                .map(asset => ({ id: asset.id, name: asset.name, trashedAt: asset.trashedAt || null, folderId: asset.folderId || null })));
            } else {
              const id = crypto.randomUUID();
              const relativeDirectory = bundleRelative(id);
              const modelDirectory = path.join(this.root, relativeDirectory);
              await this._checkManagedParent(relativeDirectory);
              const modelBundle = await copyModelBundle(modelPlan, modelDirectory);
              copied = modelDirectory;
              validateModelBundle(modelBundle);
              if (hashes.has(modelBundle.hash)) {
                await removeBundleFiles(copied, modelPlan.files.map(file => file.relative));
                copied = null;
                report.duplicates++;
                if (modelPackage) report.existingAssets.push(...draft.assets.filter(asset => asset.hash === modelBundle.hash)
                  .map(asset => ({ id: asset.id, name: asset.name, trashedAt: asset.trashedAt || null, folderId: asset.folderId || null })));
              } else {
                const filename = `${relativeDirectory}/${modelBundle.entry}`;
                let dimensions = {}, thumbnail = null;
                if (this.createThumbnail) {
                  await this._checkManagedParent(`thumbnails/${id}.jpg`);
                  thumbnailPath = path.join(this.root, 'thumbnails', `${id}.jpg`);
                  try {
                    dimensions = await this.createThumbnail(path.join(this.root, filename), thumbnailPath, { modelBundle, modelDirectory: copied }) || {};
                    await fs.access(thumbnailPath);
                    thumbnail = `thumbnails/${id}.jpg`;
                  } catch { await fs.rm(thumbnailPath, { force: true }).catch(() => {}); thumbnailPath = null; }
                }
                const timestamp = now();
                draft.assets.push({ id, name: path.basename(absolute, path.extname(absolute)), ext, mediaType: 'model', size: modelBundle.size,
                  width: Number(dimensions.width) || 0, height: Number(dimensions.height) || 0, hash: modelBundle.hash,
                  createdAt: timestamp, updatedAt: timestamp, tags: [], folderId, rating: 0, notes: '', trashedAt: null,
                  filename, thumbnail, modelBundle, ...sourceMetadata });
                hashes.add(modelBundle.hash);
                created.push({ path: copied, files: modelPlan.files.map(file => file.relative) });
                if (thumbnail) created.push({ path: thumbnailPath });
                for (const message of modelBundle.warnings) report.warnings.push({ path: absolute, message });
                if (modelBundle.missing.length) report.warnings.push({ path: absolute,
                  message: `有 ${modelBundle.missing.length} 个模型引用未收集：${modelBundle.missing.slice(0, 3).join('、')}` });
                report.imported++;
                report.assetIds.push(id);
              }
            }
          } else {
            const hash = await hashFile(absolute);
            if (hashes.has(hash)) await duplicate(hash, ext);
            else {
              const id = crypto.randomUUID();
              const filename = `originals/${id}.${ext}`;
              await this._checkManagedParent(filename);
              copied = path.join(this.root, filename);
              await fs.copyFile(absolute, copied, require('node:fs').constants.COPYFILE_EXCL);
              // Hash the managed copy too so a source changing during import never gets a stale identity.
              const copyHash = await hashFile(copied);
              if (hashes.has(copyHash)) { await fs.rm(copied); copied = null; await duplicate(copyHash, ext); }
              else {
                let dimensions = {};
                let thumbnail = null;
                if (this.createThumbnail) {
                  await this._checkManagedParent(`thumbnails/${id}.jpg`);
                  thumbnailPath = path.join(this.root, 'thumbnails', `${id}.jpg`);
                  try {
                    dimensions = await this.createThumbnail(copied, thumbnailPath,
                      DOCUMENT.has(ext) ? { mediaType: 'document', extension: ext, originalName: path.basename(absolute, path.extname(absolute)) }
                        : FONT.has(ext) ? { originalName: path.basename(absolute, path.extname(absolute)) } : undefined) || {};
                    await fs.access(thumbnailPath);
                    if (DOCUMENT.has(ext)) {
                      // A document card is a real JPEG, never arbitrary bytes with
                      // an image extension. It does not describe document pages.
                      const preview = sharp(thumbnailPath, { limitInputPixels: 16_777_216 });
                      const metadata = await preview.metadata();
                      if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) throw new Error('文档封面不是有效的 JPEG 图片');
                      await preview.raw().toBuffer();
                    }
                    thumbnail = `thumbnails/${id}.jpg`;
                  } catch (error) {
                    await fs.rm(thumbnailPath, { force: true }).catch(() => {}); thumbnailPath = null;
                    if (FONT.has(ext)) report.warnings.push({ path: absolute, message: `字体已收录，暂时无法生成预览：${String(error?.message || '字体无法解码').slice(0, 600)}` });
                    if (DOCUMENT.has(ext)) report.warnings.push({ path: absolute, message: `文档已收录，暂时无法生成封面：${String(error?.message || '文档封面不可用').slice(0, 600)}` });
                  }
                }
                const timestamp = now();
                const copyInfo = await fs.stat(copied);
                const font = FONT.has(ext) ? fontMetadata(dimensions.font) : undefined;
                const type = mediaType(ext, dimensions.mediaType);
                if (type === 'document') dimensions = { width: 0, height: 0 };
                draft.assets.push({ id, name: path.basename(absolute, path.extname(absolute)), ext, mediaType: type, size: copyInfo.size, width: Number(dimensions.width) || 0, height: Number(dimensions.height) || 0, ...mediaMetadata(dimensions, type === 'video', type === 'audio'), ...(font ? { font } : {}), hash: copyHash, createdAt: timestamp, updatedAt: timestamp, tags: [], folderId, rating: 0, notes: '', trashedAt: null, filename, thumbnail, ...sourceMetadata });
                hashes.add(copyHash);
                created.push({ path: copied });
                if (thumbnail) created.push({ path: thumbnailPath });
                report.imported++;
                report.assetIds.push(id);
              }
            }
          }
        } catch (error) {
          if (copied) {
            if (projectPlan) await removeBundleFiles(copied, projectPlan.manifest.files.map(file => file.path)).catch(() => {});
            else if (modelPlan) await removeBundleFiles(copied, modelPlan.files.map(file => file.relative)).catch(() => {});
            else await fs.rm(copied, { force: true }).catch(() => {});
          }
          if (thumbnailPath) await fs.rm(thumbnailPath, { force: true }).catch(() => {});
          report.errors.push({ path: absolute, message: error.message });
        }
        if (typeof onProgress === 'function') { try { onProgress({ current: index + 1, total: candidates.length, path: absolute, imported: report.imported, restored: report.restored, duplicates: report.duplicates }); } catch {} }
      }
      if (report.imported || report.restored) {
        try { await this._persist(draft); }
        catch (error) {
          for (const file of created) {
            if (file.files) await removeBundleFiles(file.path, file.files).catch(() => {});
            else await fs.rm(file.path, { force: true }).catch(() => {});
          }
          throw error;
        }
      }
      return report;
      } finally {
        for (const prepared of projectPreparations) if (typeof prepared?.cleanup === 'function') await Promise.resolve().then(() => prepared.cleanup()).catch(() => {});
      }
    });
  }

  _folder(id) {
    if (id !== null && !this.data.folders.some(folder => folder.id === id)) throw new Error('分类不存在');
  }

  _ids(ids) {
    if (!Array.isArray(ids)) throw new Error('素材 ID 必须是数组');
    const result = new Set(ids);
    if ([...result].some(id => !this.data.assets.some(asset => asset.id === id))) throw new Error('素材不存在');
    return result;
  }

  updateAssets(ids, patch, options = {}) {
    return this._mutate(async () => {
      const record = this._recordHistory(options);
      const selected = this._ids(ids);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('修改内容无效');
      const clean = {};
      for (const key of Object.keys(patch)) if (!['name', 'tags', 'addTags', 'removeTags', 'folderId', 'rating', 'minRating', 'notes', 'sourceUrl', 'pageUrl', 'colorLabel'].includes(key)) throw new Error(`不支持修改 ${key}`);
      const editTags = 'addTags' in patch || 'removeTags' in patch;
      const editRating = 'minRating' in patch;
      if ('tags' in patch && editTags) throw new Error('标签替换不能与添加或移除标签同时使用');
      if ('rating' in patch && editRating) throw new Error('评分替换不能与最低评分同时使用');
      if (editRating && (!Number.isInteger(patch.minRating) || patch.minRating < 1 || patch.minRating > 5)) throw new Error('最低评分必须是 1 至 5 的整数');
      const checkedTags = values => {
        if (!Array.isArray(values) || values.length > 100) throw new Error('标签格式无效或数量过多');
        return [...new Set(values.map(tag => text(tag, '标签', 100)))];
      };
      const addTags = 'addTags' in patch ? checkedTags(patch.addTags) : [];
      const removeTags = new Set('removeTags' in patch ? checkedTags(patch.removeTags) : []);
      if ('name' in patch) clean.name = text(patch.name, '名称', 240);
      if ('sourceUrl' in patch) clean.sourceUrl = webUrl(patch.sourceUrl, '素材链接');
      if ('pageUrl' in patch) clean.pageUrl = webUrl(patch.pageUrl, '来源网页');
      if ('tags' in patch) clean.tags = checkedTags(patch.tags);
      if ('folderId' in patch) { this._folder(patch.folderId); clean.folderId = patch.folderId; }
      if ('rating' in patch) { if (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5) throw new Error('评分必须是 0 至 5 的整数'); clean.rating = patch.rating; }
      if ('colorLabel' in patch) clean.colorLabel = ColorLabels.normalize(patch.colorLabel);
      if ('notes' in patch) { if (typeof patch.notes !== 'string' || patch.notes.length > 20000) throw new Error('备注格式无效或超过 20000 字符'); clean.notes = patch.notes; }
      const draft = clone(this.data);
      const keys = [...Object.keys(clean), ...(editTags ? ['tags'] : []), ...(editRating ? ['rating'] : [])];
      const changed = new Set();
      for (const asset of draft.assets) {
        if (!selected.has(asset.id)) continue;
        // Keep each asset's other tags. Additions win if a tag appears in both lists.
        const values = { ...clean,
          ...(editTags ? { tags: [...new Set([...asset.tags.filter(tag => !removeTags.has(tag)), ...addTags])] } : {}),
          ...(editRating ? { rating: Math.max(asset.rating, patch.minRating) } : {}) };
        if (editTags && values.tags.length > 100) throw new Error('标签格式无效或数量过多');
        if (keys.some(key => !sameField(asset, { ...asset, ...values }, key))) {
          changed.add(asset.id); Object.assign(asset, values, { updatedAt: now() });
        }
      }
      if (!changed.size) return this.snapshot();
      const entry = record ? this._history.prepare(this.data, draft, 'assets', changed, keys, changed.size > 1 ? `修改 ${changed.size} 个素材` : '修改素材') : null;
      await this._persist(draft);
      this._history.record(entry);
      return this.snapshot();
    });
  }

  batchRenameAssets(changes, options = {}) {
    return this._mutate(async () => {
      const record = this._recordHistory(options);
      if (!Array.isArray(changes) || !changes.length || changes.length > 10000) throw new Error('请选择 1 至 10000 个素材进行批量重命名');
      const ids = new Set(), names = new Map(), byId = new Map(this.data.assets.map(asset => [asset.id, asset]));
      for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).some(key => !['id', 'name', 'beforeName', 'hash'].includes(key)) ||
            typeof change.id !== 'string' || ids.has(change.id) || typeof change.beforeName !== 'string' || typeof change.hash !== 'string') throw new Error('批量重命名内容无效');
        const asset = byId.get(change.id);
        if (!asset || asset.trashedAt || asset.name !== change.beforeName || asset.hash !== change.hash) throw new Error('素材已变化，请关闭窗口后重新选择');
        const name = text(change.name, '名称', 240);
        if (/[\x00-\x1f\x7f]/.test(name)) throw new Error('名称不能包含控制字符');
        ids.add(change.id);
        if (name !== asset.name) names.set(change.id, name);
      }
      if (!names.size) return this.snapshot();
      const draft = clone(this.data), updatedAt = now();
      for (const asset of draft.assets) if (names.has(asset.id)) Object.assign(asset, { name: names.get(asset.id), updatedAt });
      const entry = record ? this._history.prepare(this.data, draft, 'assets', new Set(names.keys()), ['name'], `重命名 ${names.size} 个素材`) : null;
      if (entry?.oversized) throw new Error('本次批量重命名过大，请分批操作，以保留撤销记录');
      await this._persist(draft); this._history.record(entry);
      return this.snapshot();
    });
  }

  saveSmartFolder(value) {
    return this._mutate(async () => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'name', 'rule'].includes(key))) throw new Error('智能文件夹内容无效');
      const name = SmartFolders.validateName(value.name), rule = SmartFolders.validateRule(value.rule);
      const draft = clone(this.data), folders = draft.smartFolders ||= [];
      if (folders.some(folder => folder.id !== value.id && folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('已存在同名智能文件夹');
      if (value.id !== undefined) {
        const folder = folders.find(item => item.id === value.id);
        if (!folder) throw new Error('智能文件夹已不存在');
        Object.assign(folder, { name, rule, updatedAt: now() });
      } else {
        if (folders.length >= 500) throw new Error('智能文件夹最多可创建 500 个');
        const timestamp = now(); folders.push({ id: crypto.randomUUID(), name, rule, createdAt: timestamp, updatedAt: timestamp });
      }
      await this._persist(draft); return this.snapshot();
    });
  }

  deleteSmartFolder(id) {
    return this._mutate(async () => {
      if (typeof id !== 'string' || !(this.data.smartFolders || []).some(folder => folder.id === id)) throw new Error('智能文件夹已不存在');
      const draft = clone(this.data); draft.smartFolders = draft.smartFolders.filter(folder => folder.id !== id);
      await this._persist(draft); return this.snapshot();
    });
  }

  moveAssetsToFolder(ids, folderId, options = {}) {
    return this._mutate(async () => {
      const record = this._recordHistory(options);
      if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id))) throw new Error('请选择有效素材');
      const selected = this._ids(ids);
      this._folder(folderId);
      const assets = this.data.assets.filter(asset => selected.has(asset.id));
      if (assets.some(asset => asset.trashedAt)) throw new Error('请先从回收站恢复素材');
      const changed = new Set(assets.filter(asset => asset.folderId !== folderId).map(asset => asset.id));
      if (!changed.size) return this.snapshot();
      const draft = clone(this.data);
      const updatedAt = now();
      for (const asset of draft.assets) if (changed.has(asset.id)) Object.assign(asset, { folderId, updatedAt });
      const entry = record ? this._history.prepare(this.data, draft, 'assets', changed, ['folderId'], changed.size > 1 ? `移动 ${changed.size} 个素材` : '移动素材') : null;
      await this._persist(draft);
      this._history.record(entry);
      return this.snapshot();
    });
  }

  setTrash(ids, trashed) {
    return this._mutate(async () => {
      const selected = this._ids(ids);
      if (typeof trashed !== 'boolean') throw new Error('回收站状态无效');
      const draft = clone(this.data);
      for (const asset of draft.assets) if (selected.has(asset.id)) Object.assign(asset, { trashedAt: trashed ? now() : null, updatedAt: now() });
      await this._persist(draft);
      return this.snapshot();
    });
  }

  async _checkManagedParent(relative) {
    const directory = path.join(this.root, path.dirname(relative));
    if (!isWithin(this.root, directory)) throw new Error('素材目录超出当前素材库');
    const components = path.relative(this.root, directory).split(path.sep).filter(Boolean);
    let current = this.root;
    for (const component of components) {
      current = path.join(current, component);
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('素材目录不能是符号链接');
    }
  }

  async _deletionDirectoryEntries(directory) {
    if (path.dirname(directory) !== this.root || !PENDING_DELETE.test(path.basename(directory))) throw new Error('永久删除暂存路径无效');
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('永久删除暂存目录无效');
    return fs.readdir(directory);
  }

  async _checkDeletionDirectory(directory, files) {
    const entries = await this._deletionDirectoryEntries(directory);
    const allowed = new Set(['manifest.json', 'manifest.json.tmp', ...files.map(file => file.staged)]);
    if (entries.some(name => !allowed.has(name))) throw new Error('永久删除暂存目录包含未知文件，已保留');
  }

  async _cleanDeletion(directory, files) {
    await this._checkDeletionDirectory(directory, files);
    // Inspect every package before cleaning any files, preserving unexpected
    // user-created contents instead of recursively deleting a directory.
    for (const file of files) if (deletionBundle(file)) await checkBundleTree(path.join(directory, file.staged), deletionBundle(file).files.map(item => item.path));
    for (const file of files) {
      if (deletionBundle(file)) await removeBundleFiles(path.join(directory, file.staged), deletionBundle(file).files.map(item => item.path));
      else await fs.unlink(path.join(directory, file.staged)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    for (const name of ['manifest.json.tmp', 'manifest.json']) {
      await fs.unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await fs.rmdir(directory);
  }

  async _finishDeletion(directory, files) {
    // A recovery index must not reference originals that are about to disappear.
    await copyFileAtomically(this.indexPath, path.join(this.root, 'index.backup.json'));
    await this._cleanDeletion(directory, files);
  }

  async _recoverDeletion(directory) {
    await this._deletionDirectoryEntries(directory);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifestInfo = await fileInfo(manifestPath);
    if (!manifestInfo) { await this._cleanDeletion(directory, []); return; }
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('永久删除清单文件无效');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const files = deletionFiles(manifest);
    await this._checkDeletionDirectory(directory, files);
    const present = manifest.assets.map(item => this.data.assets.find(asset => asset.id === item.id));
    if (present.some(Boolean) && !present.every(Boolean)) throw new Error('永久删除清单与索引不一致，已保留暂存文件');
    if (!present.some(Boolean)) { await this._finishDeletion(directory, files); return; }
    for (const file of files) {
      const asset = present.find(asset => asset.id === file.id);
      const expectedOriginal = isBundle(asset.ext) ? bundleRelative(asset.id, asset.ext) : asset.filename;
      if (![expectedOriginal, asset.thumbnail].includes(file.relative) || (deletionBundle(file) && JSON.stringify(deletionBundle(file)) !== JSON.stringify(assetBundle(asset)))) throw new Error('永久删除清单与素材路径不一致');
      const staged = path.join(directory, file.staged);
      const info = await fileInfo(staged);
      if (!info) continue;
      if (info.isSymbolicLink() || (deletionBundle(file) ? !info.isDirectory() : !info.isFile())) throw new Error('永久删除暂存文件无效');
      await this._checkManagedParent(file.relative);
      const original = path.join(this.root, file.relative);
      if (await fileInfo(original)) throw new Error('恢复删除时发现文件冲突，已保留两份文件');
      await fs.rename(staged, original);
    }
    await this._cleanDeletion(directory, files);
  }

  async _recoverPendingDeletions() {
    for (const name of await fs.readdir(this.root)) {
      if (PENDING_DELETE.test(name)) await this._recoverDeletion(path.join(this.root, name));
    }
  }

  deletePermanently(ids) {
    return this._mutate(async () => {
      const selected = this._ids(ids);
      if (!selected.size) return this.snapshot();
      const assets = this.data.assets.filter(asset => selected.has(asset.id));
      if (assets.some(asset => !asset.trashedAt)) throw new Error('只能永久删除回收站中的素材');
      await this._recoverBundleRepairs();
      await this._recoverPendingDeletions();
      const manifest = { version: 1, assets: assets.map(asset => ({ id: asset.id, ext: asset.ext, hasThumbnail: Boolean(asset.thumbnail),
        ...(PROJECT.has(asset.ext) ? { projectBundle: asset.projectBundle } : MODEL.has(asset.ext) ? { modelBundle: asset.modelBundle } : {}) })) };
      const files = deletionFiles(manifest);
      for (const file of files) await this._checkManagedParent(file.relative);
      const directory = path.join(this.root, `.pending-delete-${crypto.randomUUID()}`);
      await fs.mkdir(directory);
      try {
        const temporary = path.join(directory, 'manifest.json.tmp');
        const handle = await fs.open(temporary, 'wx');
        try { await handle.writeFile(JSON.stringify(manifest)); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, path.join(directory, 'manifest.json'));
        for (const file of files) {
          const original = path.join(this.root, file.relative);
          const info = await fileInfo(original);
          if (!info) continue;
          if (info.isSymbolicLink() || (deletionBundle(file) ? !info.isDirectory() : !info.isFile())) throw new Error('素材文件无效，已停止永久删除');
          if (deletionBundle(file)) await checkBundleTree(original, deletionBundle(file).files.map(item => item.path));
          await fs.rename(original, path.join(directory, file.staged));
        }
        const draft = clone(this.data);
        draft.assets = draft.assets.filter(asset => !selected.has(asset.id));
        await this._persist(draft);
      } catch (error) {
        try { await this._recoverDeletion(directory); }
        catch (recoveryError) { throw new Error(`${error.message}；回滚未完成，暂存文件已保留：${recoveryError.message}`); }
        throw error;
      }
      try { await this._finishDeletion(directory, files); }
      catch (error) { return { ...this.snapshot(), deletionWarning: `素材已移除，但暂存文件清理未完成，将在重新打开素材库时重试：${error.message}` }; }
      return this.snapshot();
    });
  }

  createFolder(name, parentId = null) {
    return this._mutate(async () => {
      name = text(name, '文件夹名称', 100);
      this._folder(parentId);
      if (this.data.folders.some(folder => FolderTree.parentId(folder) === parentId && folder.name === name)) throw new Error('同级文件夹中已存在此名称');
      const draft = clone(this.data);
      const siblings = FolderTree.children(draft.folders, parentId);
      const ordered = siblings.some(folder => folder.sortOrder !== undefined);
      // Appending to an arranged group must not jump in front of its children.
      const nextOrder = ordered ? siblings.reduce((maximum, folder, index) => Math.max(maximum, folder.sortOrder ?? index), -1) + 1 : null;
      if (ordered && !Number.isSafeInteger(nextOrder)) throw new Error('文件夹排序超出范围，请先调整同级顺序');
      draft.folders.push({ id: crypto.randomUUID(), name, parentId, createdAt: now(), ...(ordered ? { sortOrder: nextOrder } : {}) });
      await this._persist(draft);
      return this.snapshot();
    });
  }

  createReimbursementFolder(name, parentId = null) {
    return this._mutate(async () => {
      name = text(name, '文件夹名称', 100);
      this._folder(parentId);
      if (this.data.folders.some(folder => FolderTree.parentId(folder) === parentId && folder.name === name)) throw new Error('同级文件夹中已存在此名称');
      const draft = clone(this.data), timestamp = now(), folderId = crypto.randomUUID();
      const siblings = FolderTree.children(draft.folders, parentId);
      const ordered = siblings.some(folder => folder.sortOrder !== undefined);
      const sortOrder = ordered ? siblings.reduce((maximum, folder, index) => Math.max(maximum, folder.sortOrder ?? index), -1) + 1 : undefined;
      if (ordered && !Number.isSafeInteger(sortOrder)) throw new Error('文件夹排序超出范围，请先调整同级顺序');
      const categoryIds = Object.fromEntries(ReimbursementFolders.CATEGORIES.map(category => [category.key, crypto.randomUUID()]));
      draft.folders.push({ id: folderId, name, parentId, createdAt: timestamp, kind: 'reimbursement',
        ...(ordered ? { sortOrder } : {}), reimbursement: { version: 1, categoryIds, formAssetId: null, supplementPdfAssetId: null, invoicePdfAssetId: null, supplementInvoicePdfAssetId: null, itineraryFolderId: null, itineraryPdfAssetId: null } });
      for (const [index, category] of ReimbursementFolders.CATEGORIES.entries()) draft.folders.push({
        id: categoryIds[category.key], name: category.name, parentId: folderId, createdAt: timestamp, sortOrder: index,
        reimbursementRootId: folderId, reimbursementCategory: category.key
      });
      await this._persist(draft);
      return { snapshot: this.snapshot(), folderId };
    });
  }

  updateReimbursementCategories(rootId, categories) {
    return this._mutate(async () => {
      const root = this.data.folders.find(folder => folder.id === rootId);
      if (!ReimbursementFolders.isRoot(root)) throw new Error('报销文件夹已不存在');
      const values = ReimbursementFolders.normalizeCategories(categories);
      const oldIds = root.reimbursement.categoryIds, keys = new Set(values.map(category => category.key));
      const removed = new Set(Object.entries(oldIds).filter(([key]) => !keys.has(key)).map(([, id]) => id));
      const draft = clone(this.data), timestamp = now();
      // Deleting a classification preserves its direct contents. Nested folders
      // keep their descendants and IDs when promoted to the reimbursement root.
      for (const asset of draft.assets) if (removed.has(asset.folderId)) Object.assign(asset, { folderId: rootId, updatedAt: timestamp });
      for (const folder of draft.folders) if (removed.has(FolderTree.parentId(folder))) Object.assign(folder, { parentId: rootId, updatedAt: timestamp });
      draft.folders = draft.folders.filter(folder => !removed.has(folder.id));
      const byId = new Map(draft.folders.map(folder => [folder.id, folder])), nextIds = {};
      for (const [index, category] of values.entries()) {
        const id = Object.hasOwn(oldIds, category.key) ? oldIds[category.key] : crypto.randomUUID();
        nextIds[category.key] = id;
        const folder = byId.get(id);
        if (folder) {
          if (folder.name !== category.name || folder.sortOrder !== index) Object.assign(folder, { name: category.name, sortOrder: index, updatedAt: timestamp });
        } else {
          const added = { id, name: category.name, parentId: rootId, sortOrder: index, createdAt: timestamp,
            reimbursementRootId: rootId, reimbursementCategory: category.key };
          draft.folders.push(added); byId.set(id, added);
        }
      }
      const changedRoot = byId.get(rootId);
      changedRoot.reimbursement.categoryIds = nextIds;
      // Validate final sibling names before persisting; collisions caused by
      // promoted subfolders reject the entire update without changing files.
      const categoryIds = new Set(Object.values(nextIds));
      const others = FolderTree.children(draft.folders, rootId).filter(folder => !categoryIds.has(folder.id));
      for (const [index, folder] of others.entries()) if (folder.sortOrder !== values.length + index) Object.assign(folder, { sortOrder: values.length + index, updatedAt: timestamp });
      if (JSON.stringify(draft) === JSON.stringify(this.data)) return this.snapshot();
      changedRoot.updatedAt = timestamp;
      await this._persist(draft);
      return this.snapshot();
    });
  }

  ensureReimbursementItinerary(rootId) {
    return this._mutate(async () => {
      const root = this.data.folders.find(folder => folder.id === rootId);
      if (!ReimbursementFolders.isRoot(root)) throw new Error('报销文件夹已不存在');
      const existingId = root.reimbursement.itineraryFolderId;
      if (existingId) {
        const existing = this.data.folders.find(folder => folder.id === existingId);
        if (!existing || existing.parentId !== rootId || ReimbursementFolders.isRoot(existing) || ReimbursementFolders.isCategory(existing)) throw new Error('打车行程单文件夹引用无效');
        return { snapshot: this.snapshot(), folderId: existingId };
      }
      const siblings = FolderTree.children(this.data.folders, rootId), names = new Set(siblings.map(folder => folder.name));
      let name = '打车行程单', suffix = 2;
      while (names.has(name)) name = `打车行程单 ${suffix++}`;
      const sortOrder = siblings.reduce((maximum, folder, index) => Math.max(maximum, folder.sortOrder ?? index), -1) + 1;
      if (!Number.isSafeInteger(sortOrder)) throw new Error('文件夹排序超出范围，请先调整同级顺序');
      const draft = clone(this.data), timestamp = now(), folderId = crypto.randomUUID();
      draft.folders.push({ id: folderId, name, parentId: rootId, createdAt: timestamp, sortOrder });
      const changedRoot = draft.folders.find(folder => folder.id === rootId);
      changedRoot.reimbursement.itineraryFolderId = folderId; changedRoot.reimbursement.itineraryPdfSignature = null; changedRoot.updatedAt = timestamp;
      await this._persist(draft);
      return { snapshot: this.snapshot(), folderId };
    });
  }

  setReimbursementSupplementInvoice(ids, enabled) {
    return this._mutate(async () => {
      if (typeof enabled !== 'boolean') throw new Error('补票发票标记无效');
      const selected = this._ids(ids);
      if (!selected.size) throw new Error('请选择补票素材');
      const categories = ReimbursementFolders.categoryMap(this.data.folders);
      for (const asset of this.data.assets) if (selected.has(asset.id)) {
        if (categories.get(asset.folderId) !== 'supplement' || !IMAGE.has(asset.ext) && asset.ext !== 'pdf') throw new Error('只能修改补票分类中的图片或 PDF');
        if (asset.ext === 'pdf' && !enabled) throw new Error('PDF 补票始终作为发票，不能改为说明截图');
      }
      const draft = clone(this.data), timestamp = now();
      let changed = false;
      for (const asset of draft.assets) if (selected.has(asset.id) && IMAGE.has(asset.ext) && (asset.reimbursementSupplementInvoice === true) !== enabled) {
        if (enabled) asset.reimbursementSupplementInvoice = true;
        else delete asset.reimbursementSupplementInvoice;
        asset.updatedAt = timestamp; changed = true;
      }
      if (changed) await this._persist(draft);
      return this.snapshot();
    });
  }

  setReimbursementAmounts(assetId, value) {
    return this._mutate(async () => {
      const asset = this.data.assets.find(item => item.id === assetId);
      if (!asset) throw new Error('素材不存在');
      if (!IMAGE.has(asset.ext) && asset.ext !== 'pdf') throw new Error('只能记录图片或 PDF 的报销金额');
      const summary = ReimbursementFolders.reimbursementAmounts(value);
      await this._checkManagedParent(asset.filename);
      const filename = path.join(this.root, asset.filename), info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || await hashFile(filename) !== summary.sourceHash) throw new Error('发票原件已变化，请重新识别后再保存金额');
      const next = { ...asset, reimbursementAmounts: summary };
      if (sameField(asset, next, 'reimbursementAmounts')) return this.snapshot();
      const draft = clone(this.data);
      Object.assign(draft.assets.find(item => item.id === assetId), { reimbursementAmounts: summary, updatedAt: now() });
      await this._persist(draft);
      return this.snapshot();
    });
  }

  setReimbursementEvidenceAmounts(assetId, value) {
    return this._mutate(async () => {
      const asset = this.data.assets.find(item => item.id === assetId);
      if (!asset) throw new Error('素材不存在');
      if (!IMAGE.has(asset.ext) || ReimbursementFolders.categoryForFolder(this.data.folders, asset.folderId) !== 'supplement' || ReimbursementFolders.isSupplementInvoice(asset)) throw new Error('只能记录补票分类中购买截图的显示金额');
      const summary = ReimbursementFolders.reimbursementAmounts(value);
      await this._checkManagedParent(asset.filename);
      const filename = path.join(this.root, asset.filename), info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || await hashFile(filename) !== summary.sourceHash) throw new Error('截图原件已变化，请重新识别后再保存金额');
      const next = { ...asset, reimbursementEvidenceAmounts: summary };
      if (sameField(asset, next, 'reimbursementEvidenceAmounts')) return this.snapshot();
      const draft = clone(this.data);
      Object.assign(draft.assets.find(item => item.id === assetId), { reimbursementEvidenceAmounts: summary, updatedAt: now() });
      await this._persist(draft);
      return this.snapshot();
    });
  }

  setReimbursementInvoiceOptions(rootId, options, scope = 'regular') {
    return this._mutate(async () => {
      const root = this.data.folders.find(folder => folder.id === rootId);
      if (!ReimbursementFolders.isRoot(root)) throw new Error('报销文件夹已不存在');
      if (options === undefined) throw new Error('发票 PDF 排版参数无效');
      const fields = ReimbursementFolders.invoicePdfFields(scope);
      const value = ReimbursementFolders.invoicePdfOptions(options);
      if (root.reimbursement[fields.options]?.imagesPerPage === value.imagesPerPage) return this.snapshot();
      const draft = clone(this.data), changedRoot = draft.folders.find(folder => folder.id === rootId);
      changedRoot.reimbursement[fields.options] = value;
      changedRoot.updatedAt = now();
      await this._persist(draft);
      return this.snapshot();
    });
  }

  setReimbursementInvoiceSignature(rootId, signature, scope = 'regular') {
    return this._mutate(async () => {
      const root = this.data.folders.find(folder => folder.id === rootId);
      if (!ReimbursementFolders.isRoot(root)) throw new Error('报销文件夹已不存在');
      const fields = ReimbursementFolders.invoicePdfFields(scope);
      const value = ReimbursementFolders.invoicePdfSignature(signature);
      if ((root.reimbursement[fields.signature] ?? null) === value) return this.snapshot();
      const draft = clone(this.data), changedRoot = draft.folders.find(folder => folder.id === rootId);
      changedRoot.reimbursement[fields.signature] = value;
      changedRoot.updatedAt = now();
      await this._persist(draft);
      return this.snapshot();
    });
  }

  setReimbursementItinerarySignature(rootId, signature) {
    return this._mutate(async () => {
      const root = this.data.folders.find(folder => folder.id === rootId);
      if (!ReimbursementFolders.isRoot(root)) throw new Error('报销文件夹已不存在');
      const value = ReimbursementFolders.invoicePdfSignature(signature);
      if ((root.reimbursement.itineraryPdfSignature ?? null) === value) return this.snapshot();
      const draft = clone(this.data), changedRoot = draft.folders.find(folder => folder.id === rootId);
      changedRoot.reimbursement.itineraryPdfSignature = value;
      changedRoot.updatedAt = now();
      await this._persist(draft);
      return this.snapshot();
    });
  }

  upsertReimbursementDocument(rootId, kind, sourcePath, name, options = {}) {
    return this._mutate(async () => {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'expectedExistingHash') ||
          (options.expectedExistingHash !== undefined && (typeof options.expectedExistingHash !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedExistingHash)))) throw new Error('生成文档更新参数无效');
      const { extension, pointer } = ReimbursementFolders.documentKind(kind);
      const root = this.data.folders.find(folder => folder.id === rootId);
      if (!ReimbursementFolders.isRoot(root)) throw new Error('报销文件夹已不存在');
      name = text(name, '文档名称', 240);
      if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) throw new Error('生成文档路径无效');
      const sourceInfo = await fs.lstat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !sourceInfo.size || sourceInfo.size > 256 * 1024 * 1024) throw new Error('生成文档无效或超过 256 MB');
      const bytes = await fs.readFile(sourcePath);
      if (bytes.length !== sourceInfo.size || bytes.length > 256 * 1024 * 1024) throw new Error('生成文档在读取时发生变化');
      if (extension === 'pdf' ? !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')) : !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new Error(`生成文档不是有效的 ${extension.toUpperCase()} 文件`);
      const previousAsset = this.data.assets.find(asset => asset.id === root.reimbursement[pointer]) ||
        this.data.assets.find(asset => asset.reimbursementGenerated?.rootId === rootId && asset.reimbursementGenerated?.kind === kind);
      if (previousAsset && (previousAsset.ext !== extension || previousAsset.reimbursementGenerated?.rootId !== rootId || previousAsset.reimbursementGenerated?.kind !== kind)) throw new Error('生成文档引用已变化，不能覆盖其他素材');
      const id = previousAsset?.id || crypto.randomUUID(), relative = `originals/${id}.${extension}`;
      await this._checkManagedParent(relative);
      await this._recoverReimbursementDocuments();
      const destination = path.join(this.root, relative), previous = await fileInfo(destination);
      if (previous && (!previousAsset || !previous.isFile() || previous.isSymbolicLink())) throw new Error('原文档已变化，不能覆盖，请先恢复或移走冲突文件');
      const previousFileHash = previous ? await hashFile(destination) : null;
      if ((previous && previousFileHash !== (options.expectedExistingHash ?? previousAsset.hash)) || (options.expectedExistingHash !== undefined && !previous)) throw new Error('原文档已变化，不能覆盖，请重新读取后再更新');
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (previousAsset && previous && previousFileHash === hash) {
        // Reopening/refreshing an unchanged workbook must not rename the file:
        // Excel and WPS can permit reads while holding an exclusive rename lock.
        const values = { name, ext: extension, mediaType: 'document', size: bytes.length, width: 0, height: 0, hash,
          filename: relative, folderId: rootId, trashedAt: null, reimbursementGenerated: { rootId, kind } };
        const next = { ...previousAsset, ...values };
        const changed = Object.keys(values).some(key => !sameField(previousAsset, next, key));
        if (!changed && root.reimbursement[pointer] === id) return { snapshot: this.snapshot(), assetId: id };
        const draft = clone(this.data), timestamp = now();
        Object.assign(draft.assets.find(asset => asset.id === id), values, { updatedAt: timestamp });
        const targetRoot = draft.folders.find(folder => folder.id === rootId);
        targetRoot.reimbursement[pointer] = id; targetRoot.updatedAt = timestamp;
        await this._persist(draft);
        let warning;
        if (previousAsset.hash !== hash) {
          // An explicitly accepted edit made outside Mosaic no longer has the
          // old on-disk bytes, so keep the backup index on the accepted revision.
          try { await copyFileAtomically(this.indexPath, path.join(this.root, 'index.backup.json')); }
          catch (error) { warning = `文档信息已保存，备份索引未更新：${error.message}`; }
        }
        return { snapshot: this.snapshot(), assetId: id, ...(warning ? { warning } : {}) };
      }
      const directory = path.join(this.root, `.pending-reimbursement-${crypto.randomUUID()}`);
      await fs.mkdir(directory);
      let thumbnail = null, newThumbnailHash = null;
      const thumbnailRelative = `thumbnails/${id}.jpg`, thumbnailPath = path.join(this.root, thumbnailRelative);
      try {
        await fs.writeFile(path.join(directory, `replacement.${extension}`), bytes, { flag: 'wx' });
        if (previousAsset?.thumbnail) {
          try {
            await this._checkManagedParent(thumbnailRelative);
            const info = await fs.lstat(thumbnailPath);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('文档封面无效');
            const preview = sharp(thumbnailPath, { limitInputPixels: 16_777_216 });
            const metadata = await preview.metadata();
            if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) throw new Error('文档封面无效');
            await preview.raw().toBuffer(); thumbnail = thumbnailRelative;
          } catch { /* An invalid old cover is not necessary to keep the document. */ }
        }
        if (!thumbnail && this.createThumbnail && !(await fileInfo(thumbnailPath))) {
          const stagedThumbnail = path.join(directory, 'thumbnail.jpg');
          try {
            await this.createThumbnail(path.join(directory, `replacement.${extension}`), stagedThumbnail, { mediaType: 'document', extension, originalName: name });
            const preview = sharp(stagedThumbnail, { limitInputPixels: 16_777_216 });
            const metadata = await preview.metadata();
            if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) throw new Error('文档封面不是 JPEG');
            await preview.raw().toBuffer();
            newThumbnailHash = await hashFile(stagedThumbnail); thumbnail = thumbnailRelative;
          } catch { await fs.rm(stagedThumbnail, { force: true }).catch(() => {}); }
        }
        const journal = { version: 1, id, rootId, kind, extension, newHash: hash, oldHash: previousFileHash, oldAssetHash: previousAsset?.hash || null, hadOriginal: Boolean(previous), newThumbnailHash };
        const handle = await fs.open(path.join(directory, 'manifest.json'), 'wx');
        try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
        if (previous) await fs.rename(destination, path.join(directory, 'previous'));
        await fs.copyFile(path.join(directory, `replacement.${extension}`), destination, require('node:fs').constants.COPYFILE_EXCL);
        if (newThumbnailHash) {
          await this._checkManagedParent(thumbnailRelative);
          await fs.copyFile(path.join(directory, 'thumbnail.jpg'), thumbnailPath, require('node:fs').constants.COPYFILE_EXCL);
        }
        const draft = clone(this.data), timestamp = now();
        const metadata = { name, ext: extension, mediaType: 'document', size: bytes.length, width: 0, height: 0, hash,
          filename: relative, thumbnail, folderId: rootId, updatedAt: timestamp, trashedAt: null, reimbursementGenerated: { rootId, kind } };
        const asset = draft.assets.find(asset => asset.id === id);
        if (asset) Object.assign(asset, metadata);
        else draft.assets.push({ id, createdAt: timestamp, tags: [], rating: 0, notes: '', ...metadata });
        const targetRoot = draft.folders.find(folder => folder.id === rootId);
        targetRoot.reimbursement[pointer] = id; targetRoot.updatedAt = timestamp;
        await this._persist(draft);
      } catch (error) {
        try { await this._recoverReimbursementDocument(directory); }
        catch (recoveryError) { this._reimbursementRecoveryPending = true; throw new Error(`${error.message}；文档回滚未完成，暂存文件已保留：${recoveryError.message}`); }
        throw error;
      }
      let warning;
      try { await this._recoverReimbursementDocument(directory); }
      catch (error) { this._reimbursementRecoveryPending = true; warning = `文档已保存，暂存文件将在下次打开时清理：${error.message}`; }
      return { snapshot: this.snapshot(), assetId: id, ...(warning ? { warning } : {}) };
    });
  }

  clearReimbursementDocument(rootId, kind) {
    return this._mutate(async () => {
      const { pointer } = ReimbursementFolders.documentKind(kind);
      const root = this.data.folders.find(folder => folder.id === rootId);
      if (!ReimbursementFolders.isRoot(root)) throw new Error('报销文件夹已不存在');
      const draft = clone(this.data), targetRoot = draft.folders.find(folder => folder.id === rootId);
      const asset = draft.assets.find(asset => asset.reimbursementGenerated?.rootId === rootId && asset.reimbursementGenerated?.kind === kind);
      const hasItinerarySignature = kind === 'itineraryPdf' && targetRoot.reimbursement.itineraryPdfSignature != null;
      if ((targetRoot.reimbursement[pointer] ?? null) === null && (!asset || asset.trashedAt) && !hasItinerarySignature) return this.snapshot();
      targetRoot.reimbursement[pointer] = null; targetRoot.updatedAt = now();
      if (kind === 'itineraryPdf') targetRoot.reimbursement.itineraryPdfSignature = null;
      if (asset) Object.assign(asset, { trashedAt: asset.trashedAt || now(), updatedAt: now() });
      await this._persist(draft);
      return this.snapshot();
    });
  }

  renameFolder(id, name, options = {}) {
    return this._mutate(async () => {
      const record = this._recordHistory(options);
      this._folder(id);
      if (id === null) throw new Error('分类不存在');
      name = ReimbursementFolders.isCategory(this.data.folders.find(folder => folder.id === id))
        ? ReimbursementFolders.categoryName(name) : text(name, '文件夹名称', 100);
      const parentId = FolderTree.parentId(this.data.folders.find(folder => folder.id === id));
      if (this.data.folders.some(folder => folder.id !== id && FolderTree.parentId(folder) === parentId && folder.name === name)) throw new Error('同级文件夹中已存在此名称');
      if (this.data.folders.find(folder => folder.id === id).name === name) return this.snapshot();
      const draft = clone(this.data);
      draft.folders.find(folder => folder.id === id).name = name;
      const entry = record ? this._history.prepare(this.data, draft, 'folders', new Set([id]), ['name'], '重命名文件夹') : null;
      await this._persist(draft);
      this._history.record(entry);
      return this.snapshot();
    });
  }

  setFolderColor(id, colorLabel, options = {}) {
    return this._mutate(async () => {
      const record = this._recordHistory(options);
      this._folder(id);
      if (id === null) throw new Error('分类不存在');
      colorLabel = ColorLabels.normalize(colorLabel);
      if (ColorLabels.normalize(this.data.folders.find(folder => folder.id === id).colorLabel) === colorLabel) return this.snapshot();
      const draft = clone(this.data);
      Object.assign(draft.folders.find(folder => folder.id === id), { colorLabel, updatedAt: now() });
      const entry = record ? this._history.prepare(this.data, draft, 'folders', new Set([id]), ['colorLabel'], '修改文件夹颜色') : null;
      await this._persist(draft);
      this._history.record(entry);
      return this.snapshot();
    });
  }

  async _saveFolderAppearance(id, key, value, record, label) {
    this._folder(id);
    if (id === null) throw new Error('分类不存在');
    const folder = this.data.folders.find(item => item.id === id);
    const normalize = key === 'icon' ? FolderIcons.normalizeIcon : FolderIcons.normalizeColor;
    if (JSON.stringify(normalize(folder[key])) === JSON.stringify(value)) return this.snapshot();
    const draft = clone(this.data), changed = draft.folders.find(item => item.id === id);
    if (value === null) delete changed[key];
    else changed[key] = value;
    changed.updatedAt = now();
    const entry = record ? this._history.prepare(this.data, draft, 'folders', new Set([id]), [key], label) : null;
    await this._persist(draft);
    this._history.record(entry);
    return this.snapshot();
  }

  setFolderIcon(id, name, options = {}) {
    return this._mutate(async () => {
      const record = this._recordHistory(options);
      const icon = name === null || name === 'folder' ? null : FolderIcons.normalizeIcon({ type: 'builtin', name });
      return this._saveFolderAppearance(id, 'icon', icon, record, '修改文件夹图标');
    });
  }

  setFolderIconColor(id, color, options = {}) {
    return this._mutate(async () => this._saveFolderAppearance(id, 'iconColor', FolderIcons.normalizeColor(color), this._recordHistory(options), '修改图标颜色'));
  }

  importFolderIcon(id, filename, options = {}) {
    return this._mutate(async () => {
      const record = this._recordHistory(options);
      this._folder(id);
      if (id === null) throw new Error('分类不存在');
      const icon = await FolderIconFiles.importImage(this.root, filename);
      // Retain immutable previous images for history and index.backup.json.
      return this._saveFolderAppearance(id, 'icon', icon, record, '自定义文件夹图标');
    });
  }

  async readFolderIcon(id, expectedHash) {
    this._ready();
    const icon = FolderIcons.normalizeIcon(this.data.folders.find(folder => folder.id === id)?.icon);
    if (icon?.type !== 'image' || icon.hash !== expectedHash) throw new Error('文件夹图标已更改或不存在');
    const result = await FolderIconFiles.readStored(this.root, icon);
    if (this.data.folders.find(folder => folder.id === id)?.icon?.hash !== expectedHash) throw new Error('文件夹图标已更改或不存在');
    return result;
  }

  async verifyFolderIcons() {
    this._ready();
    const verified = new Set();
    for (const folder of this.data.folders) {
      const icon = FolderIcons.normalizeIcon(folder.icon);
      if (icon?.type !== 'image') continue;
      const reference = JSON.stringify(icon);
      if (verified.has(reference)) continue;
      try { await FolderIconFiles.readStored(this.root, icon, { decode: true }); }
      catch (error) { throw new Error(`文件夹“${folder.name}”的自定义图标校验失败：${error.message}`); }
      verified.add(reference);
    }
  }

  moveFolder(id, parentId = null, options = {}) {
    return this._mutate(async () => {
      const record = this._recordHistory(options);
      this._folder(id); this._folder(parentId);
      if (id === null) throw new Error('分类不存在');
      if (id === parentId || FolderTree.descendantIds(this.data.folders, id).has(parentId)) throw new Error('文件夹不能移入自己或自己的子文件夹');
      const folder = this.data.folders.find(item => item.id === id);
      const previousParent = FolderTree.parentId(folder);
      if (ReimbursementFolders.isCategory(folder) && parentId !== folder.reimbursementRootId) throw new Error('报销分类不能移出所属报销文件夹');
      const before = options.beforeId !== undefined, after = options.afterId !== undefined;
      if (before && after) throw new Error('文件夹排序位置不能同时指定前后参照');
      const anchorId = before ? options.beforeId : after ? options.afterId : undefined;
      if (anchorId !== undefined) {
        if (typeof anchorId !== 'string' || anchorId === id) throw new Error('文件夹排序参照无效');
        const anchor = this.data.folders.find(item => item.id === anchorId);
        if (!anchor || FolderTree.parentId(anchor) !== parentId) throw new Error('排序参照不在目标文件夹层级中');
      }
      if (previousParent === parentId && anchorId === undefined) return this.snapshot();
      if (this.data.folders.some(item => item.id !== id && FolderTree.parentId(item) === parentId && item.name === folder.name)) throw new Error('同级文件夹中已存在此名称');
      const previousOrder = FolderTree.children(this.data.folders, parentId).map(item => item.id);
      const nextOrder = previousOrder.filter(value => value !== id);
      const anchorIndex = anchorId === undefined ? nextOrder.length : nextOrder.indexOf(anchorId) + (after ? 1 : 0);
      nextOrder.splice(anchorIndex, 0, id);
      if (previousParent === parentId && nextOrder.every((value, index) => value === previousOrder[index])) return this.snapshot();
      const draft = clone(this.data);
      const byId = new Map(draft.folders.map(item => [item.id, item]));
      Object.assign(byId.get(id), { parentId, updatedAt: now() });
      const affected = new Set([id]);
      for (const [index, siblingId] of nextOrder.entries()) {
        const sibling = byId.get(siblingId);
        sibling.sortOrder = index; affected.add(siblingId);
      }
      if (previousParent !== parentId) {
        FolderTree.children(draft.folders, previousParent).forEach((sibling, index) => {
          sibling.sortOrder = index; affected.add(sibling.id);
        });
      }
      const entry = record ? this._history.prepare(this.data, draft, 'folders', affected, ['parentId', 'sortOrder'], previousParent === parentId ? '调整文件夹顺序' : '移动文件夹') : null;
      await this._persist(draft);
      this._history.record(entry);
      return this.snapshot();
    });
  }

  deleteFolder(id) {
    return this._mutate(async () => {
      this._folder(id);
      if (id === null) throw new Error('分类不存在');
      if (ReimbursementFolders.isCategory(this.data.folders.find(folder => folder.id === id))) throw new Error('报销分类不能单独删除，请使用“管理报销分类”保留其中的文件');
      const removed = FolderTree.descendantIds(this.data.folders, id);
      const draft = clone(this.data);
      draft.folders = draft.folders.filter(folder => !removed.has(folder.id));
      for (const asset of draft.assets) if (removed.has(asset.folderId)) Object.assign(asset, { folderId: null, updatedAt: now() });
      for (const folder of draft.folders) if (ReimbursementFolders.isRoot(folder) && removed.has(folder.reimbursement.itineraryFolderId)) {
        folder.reimbursement.itineraryFolderId = null; folder.reimbursement.itineraryPdfSignature = null; folder.updatedAt = now();
      }
      await this._persist(draft);
      return this.snapshot();
    });
  }

  getAssetPath(id, kind = 'original') {
    this._ready();
    const asset = this.data.assets.find(item => item.id === id);
    if (!asset) return null;
    if (kind !== 'original' && kind !== 'thumbnail') throw new Error('素材类型无效');
    const relative = kind === 'thumbnail' ? asset.thumbnail : asset.filename;
    return relative ? path.join(this.root, relative) : null;
  }

  getModelBundleDirectory(id) {
    this._ready();
    const asset = this.data.assets.find(item => item.id === id);
    return asset && MODEL.has(asset.ext) ? path.join(this.root, bundleRelative(asset.id)) : null;
  }

  getModelFilePath(id, relative) {
    this._ready();
    const asset = this.data.assets.find(item => item.id === id);
    if (!asset || !MODEL.has(asset.ext) || !isSafeBundlePath(relative) || !asset.modelBundle.files.some(file => file.path === relative)) return null;
    return path.join(this.root, bundleRelative(asset.id), relative);
  }

  getProjectBundleDirectory(id) {
    this._ready();
    const asset = this.data.assets.find(item => item.id === id);
    return asset && PROJECT.has(asset.ext) ? path.join(this.root, bundleRelative(asset.id, asset.ext)) : null;
  }

  getProjectFilePath(id, relative) {
    this._ready();
    const asset = this.data.assets.find(item => item.id === id);
    if (!asset || !PROJECT.has(asset.ext) || !isSafeBundlePath(relative) || !asset.projectBundle.files.some(file => file.path === relative)) return null;
    return path.join(this.root, bundleRelative(asset.id, asset.ext), relative);
  }

  async _recoverReimbursementDocuments() {
    for (const name of await fs.readdir(this.root))
      if (PENDING_REIMBURSEMENT.test(name)) await this._recoverReimbursementDocument(path.join(this.root, name));
    this._reimbursementRecoveryPending = false;
  }

  async _recoverReimbursementDocument(directory) {
    if (path.dirname(directory) !== this.root || !PENDING_REIMBURSEMENT.test(path.basename(directory))) throw new Error('报销文档暂存路径无效');
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('报销文档暂存目录无效');
    const names = await fs.readdir(directory);
    const allowed = new Set(['manifest.json', 'replacement.xlsx', 'replacement.pdf', 'previous', 'thumbnail.jpg']);
    for (const name of names) {
      const entry = await fs.lstat(path.join(directory, name));
      if (!allowed.has(name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error('报销文档暂存目录包含未知文件，已保留');
    }
    const journal = path.join(directory, 'manifest.json'), journalInfo = await fileInfo(journal);
    if (journalInfo) {
      if (journalInfo.size > 65536) throw new Error('报销文档恢复清单过大');
      const record = JSON.parse(await fs.readFile(journal, 'utf8'));
      const { version, id, rootId, kind, extension, oldHash, newHash, hadOriginal, newThumbnailHash } = record;
      const oldAssetHash = record.oldAssetHash === undefined ? oldHash : record.oldAssetHash;
      if (version !== 1 || typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id) ||
          typeof rootId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(rootId) ||
          ReimbursementFolders.documentKind(kind).extension !== extension || typeof newHash !== 'string' || !/^[a-f0-9]{64}$/.test(newHash) ||
          (oldHash !== null && (typeof oldHash !== 'string' || !/^[a-f0-9]{64}$/.test(oldHash))) || typeof hadOriginal !== 'boolean' ||
          (oldAssetHash !== null && (typeof oldAssetHash !== 'string' || !/^[a-f0-9]{64}$/.test(oldAssetHash))) ||
          (newThumbnailHash !== null && (typeof newThumbnailHash !== 'string' || !/^[a-f0-9]{64}$/.test(newThumbnailHash)))) throw new Error('报销文档恢复清单无效');
      const current = path.join(this.root, `originals/${id}.${extension}`), previous = path.join(directory, 'previous'), replacement = path.join(directory, `replacement.${extension}`);
      await this._checkManagedParent(`originals/${id}.${extension}`);
      const currentInfo = await fileInfo(current), previousInfo = await fileInfo(previous), replacementInfo = await fileInfo(replacement);
      if (currentInfo && (!currentInfo.isFile() || currentInfo.isSymbolicLink())) throw new Error('报销文档恢复时发现原件路径冲突');
      if (replacementInfo && await hashFile(replacement) !== newHash) throw new Error('报销文档新副本校验失败，已保留');
      if (previousInfo && (!hadOriginal || oldHash === null || await hashFile(previous) !== oldHash)) throw new Error('报销文档旧副本校验失败，已保留');
      const asset = this.data.assets.find(item => item.id === id);
      const committed = asset?.hash === newHash && asset?.reimbursementGenerated?.rootId === rootId && asset?.reimbursementGenerated?.kind === kind;
      const currentHash = currentInfo ? await hashFile(current) : null;
      if (committed) {
        if (currentInfo && currentHash !== newHash) throw new Error('已保存的报销文档原件已变化，暂存文件已保留');
        if (!currentInfo) {
          if (!replacementInfo) throw new Error('已保存的报销文档原件缺失');
          await fs.copyFile(replacement, current, require('node:fs').constants.COPYFILE_EXCL);
        }
        // A backup index must describe the same managed document bytes.
        await copyFileAtomically(this.indexPath, path.join(this.root, 'index.backup.json'));
      } else {
        if (asset && (asset.hash !== oldAssetHash || asset.reimbursementGenerated?.rootId !== rootId || asset.reimbursementGenerated?.kind !== kind)) throw new Error('报销文档索引与恢复清单不一致，已保留');
        if (!asset && oldAssetHash !== null) throw new Error('报销文档旧索引已不存在，暂存文件已保留');
        if (previousInfo) {
          if (currentInfo && currentHash !== newHash && currentHash !== oldHash) throw new Error('恢复报销文档时发现文件冲突，已保留两份文件');
          if (currentInfo && currentHash !== oldHash) await fs.unlink(current);
          if (!currentInfo || currentHash !== oldHash) await fs.rename(previous, current);
        } else if (hadOriginal) {
          if (!currentInfo || currentHash !== oldHash) throw new Error('报销文档旧副本未找到，暂存文件已保留');
        } else if (currentInfo) {
          if (currentHash !== newHash) throw new Error('恢复报销文档时发现文件冲突，已保留');
          await fs.unlink(current);
        }
        if (newThumbnailHash) {
          await this._checkManagedParent(`thumbnails/${id}.jpg`);
          const thumbnail = path.join(this.root, `thumbnails/${id}.jpg`), thumbnailInfo = await fileInfo(thumbnail);
          if (thumbnailInfo) {
            if (!thumbnailInfo.isFile() || thumbnailInfo.isSymbolicLink() || await hashFile(thumbnail) !== newThumbnailHash) throw new Error('恢复报销文档时发现封面冲突，已保留');
            await fs.unlink(thumbnail);
          }
        }
      }
    } else if (names.includes('previous')) throw new Error('报销文档旧副本缺少恢复清单，已保留');
    for (const name of names) await fs.unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(directory);
  }

  async _recoverBundleRepairs() {
    for (const name of await fs.readdir(this.root))
      if (PENDING_BUNDLE_REPAIR.test(name)) await this._recoverBundleRepair(path.join(this.root, name));
  }

  async _recoverBundleRepair(directory) {
    if (path.dirname(directory) !== this.root || !PENDING_BUNDLE_REPAIR.test(path.basename(directory))) throw new Error('资源包修复暂存路径无效');
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('资源包修复暂存目录无效');
    const names = await fs.readdir(directory);
    if (names.some(name => !['manifest.json', 'manifest.json.tmp', 'previous', 'replacement'].includes(name))) throw new Error('修复暂存目录包含未知文件，已保留');
    const journal = path.join(directory, 'manifest.json');
    const journalInfo = await fileInfo(journal);
    const previous = path.join(directory, 'previous'), replacement = path.join(directory, 'replacement');
    if (journalInfo) {
      if (!journalInfo.isFile() || journalInfo.isSymbolicLink()) throw new Error('资源包修复清单无效');
      const { version, id, ext, oldBundle, newBundle } = JSON.parse(await fs.readFile(journal, 'utf8'));
      if (version !== 1 || typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id) || !isBundle(ext)) throw new Error('资源包修复清单无效');
      const validator = bundleRepairValidator(ext);
      for (const manifest of [oldBundle, newBundle]) {
        validator(manifest);
        if (path.posix.extname(manifest.entry).slice(1).toLowerCase() !== ext) throw new Error('修复资源包入口格式不一致');
      }
      const asset = this.data.assets.find(item => item.id === id && item.ext === ext);
      const expectedHash = asset?.hash;
      if (oldBundle.hash === newBundle.hash || ![oldBundle.hash, newBundle.hash].includes(expectedHash)) throw new Error('当前索引与修复清单不一致，已保留暂存文件');
      const current = path.join(this.root, bundleRelative(id, ext));
      await this._checkManagedParent(bundleRelative(id, ext));
      await checkBundleTree(previous, oldBundle.files.map(file => file.path));
      await checkBundleTree(replacement, newBundle.files.map(file => file.path));
      if (expectedHash === newBundle.hash) {
        if (!(await fileInfo(current))) throw new Error('已修复的资源包未找到，已保留暂存文件');
        await checkBundleTree(current, newBundle.files.map(file => file.path));
        // Recovery must use the same bundle revision as the active index.
        await copyFileAtomically(this.indexPath, path.join(this.root, 'index.backup.json'));
      } else if (await fileInfo(previous)) {
        if (await fileInfo(current)) {
          if (await fileInfo(replacement)) throw new Error('恢复资源包时发现目录冲突，已保留暂存文件');
          await checkBundleTree(current, newBundle.files.map(file => file.path));
          await fs.rename(current, replacement);
        }
        await fs.rename(previous, current);
      } else if (!(await fileInfo(current))) {
        throw new Error('原资源包未找到，已保留暂存文件');
      }
      await removeBundleFiles(previous, oldBundle.files.map(file => file.path));
      await removeBundleFiles(replacement, newBundle.files.map(file => file.path));
    } else if (names.includes('previous') || names.includes('replacement')) {
      throw new Error('未找到修复清单，资源包暂存文件已保留');
    }
    for (const filename of ['manifest.json.tmp', 'manifest.json'])
      await fs.unlink(path.join(directory, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(directory);
  }

  repairBundle(id, { expectedHash, projectPlan, modelPlan } = {}) {
    return this._mutate(async () => {
      const asset = this.data.assets.find(item => item.id === id);
      if (!asset || asset.trashedAt || !isBundle(asset.ext) || asset.hash !== expectedHash) throw new Error('素材包已变化，请重新查找缺失资源');
      const project = PROJECT.has(asset.ext);
      const oldBundle = assetBundle(asset);
      const newBundle = project ? projectPlan?.manifest : modelPlan && {
        version: 1, entry: modelPlan.entry, files: modelPlan.files.map(({ relative, size, hash }) => ({ path: relative, size, hash })),
        size: modelPlan.size, hash: modelPlan.hash, missing: modelPlan.missing, warnings: modelPlan.warnings,
        ...(modelPlan.resources ? { resources: modelPlan.resources } : {}), ...(modelPlan.diagnostics ? { diagnostics: modelPlan.diagnostics } : {}),
        ...(modelPlan.previewEntry ? { previewEntry: modelPlan.previewEntry } : {})
      };
      const validate = bundleRepairValidator(asset.ext);
      validate(newBundle);
      if (newBundle.hash === oldBundle.hash || path.posix.extname(newBundle.entry).slice(1).toLowerCase() !== asset.ext) throw new Error('修复未产生有效的资源包');
      await this._recoverBundleRepairs();
      const relative = bundleRelative(id, asset.ext), current = path.join(this.root, relative);
      await this._checkManagedParent(relative);
      if (!(await fileInfo(current))) throw new Error('原资源包不存在');
      await checkBundleTree(current, oldBundle.files.map(file => file.path));
      const staging = path.join(this.root, `.pending-repair-${crypto.randomUUID()}`);
      await fs.mkdir(staging);
      try {
        const temporary = path.join(staging, 'manifest.json.tmp');
        const handle = await fs.open(temporary, 'wx');
        try { await handle.writeFile(JSON.stringify({ version: 1, id, ext: asset.ext, oldBundle, newBundle })); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, path.join(staging, 'manifest.json'));
        const replacement = path.join(staging, 'replacement');
        const manifest = await (project ? copyProjectBundle(projectPlan, replacement) : copyModelBundle(modelPlan, replacement));
        if (manifest.hash !== newBundle.hash) throw new Error('补齐后的资源包校验值不一致');
        await fs.rename(current, path.join(staging, 'previous'));
        await fs.rename(replacement, current);
        const draft = clone(this.data), next = draft.assets.find(item => item.id === id);
        Object.assign(next, { filename: `${relative}/${manifest.entry}`, size: manifest.size, hash: manifest.hash, updatedAt: now(),
          [project ? 'projectBundle' : 'modelBundle']: manifest });
        delete next.projectPreview;
        await this._persist(draft);
      } catch (error) {
        try { await this._recoverBundleRepair(staging); }
        catch (recoveryError) { throw new Error(`${error.message}；暂存资源已保留：${recoveryError.message}`); }
        throw error;
      }
      try { await this._recoverBundleRepair(staging); }
      catch (error) { return { ...this.snapshot(), repairWarning: `资源已补齐，暂存文件会在重新打开素材库时再次清理：${error.message}` }; }
      return this.snapshot();
    });
  }

  publishProjectPreview(id, { expectedRoot, expectedHash, thumbnailPath, preview, signal } = {}) {
    return this._mutate(async () => {
      signal?.throwIfAborted();
      const current = this.data.assets.find(asset => asset.id === id);
      if (this.root !== expectedRoot || !current || current.trashedAt || !PROJECT.has(current.ext) || current.hash !== expectedHash) return null;
      const metadata = projectPreviewMetadata(preview, expectedHash);
      if (typeof thumbnailPath !== 'string' || !path.isAbsolute(thumbnailPath)) throw new Error('AE 缩略图路径无效');
      const source = path.resolve(thumbnailPath), info = await fs.lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024 || await fs.realpath(source) !== source) throw new Error('AE 缩略图文件无效');
      const bytes = await fs.readFile(source);
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('AE 缩略图不是 JPEG');
      const relative = `thumbnails/${id}.jpg`;
      await this._checkManagedParent(relative);
      const destination = path.join(this.root, relative), previous = await fileInfo(destination);
      if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('AE 缩略图目标无效');
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`, backup = `${destination}.${crypto.randomUUID()}.previous`;
      let replaced = false, savedPrevious = false, committed = false;
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx' });
        signal?.throwIfAborted();
        if (previous) { await fs.rename(destination, backup); savedPrevious = true; }
        await fs.rename(temporary, destination); replaced = true;
        signal?.throwIfAborted();
        const draft = clone(this.data), asset = draft.assets.find(item => item.id === id);
        Object.assign(asset, { thumbnail: relative, width: metadata.width, height: metadata.height, duration: metadata.duration, projectPreview: metadata });
        await this._persist(draft); committed = true;
        return this.snapshot();
      } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!committed && replaced) await fs.unlink(destination);
        if (savedPrevious) {
          if (committed) await fs.unlink(backup);
          else await fs.rename(backup, destination);
        }
      }
    });
  }

  setVideoThumbnail(id, { expectedHash, jpeg }) {
    return this._mutate(async () => {
      const current = this.data.assets.find(asset => asset.id === id);
      if (!current || current.trashedAt || mediaType(current.ext, current.mediaType) !== 'video' || current.hash !== expectedHash) throw new Error('视频已变化，请重新打开预览');
      const relative = `thumbnails/${id}.jpg`;
      await this._checkManagedParent(relative);
      const destination = path.join(this.root, relative);
      const previous = await fileInfo(destination);
      if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('视频封面目标无效');
      const revision = crypto.randomUUID();
      const temporary = `${destination}.${revision}.tmp`, backup = `${destination}.${revision}.previous`;
      let savedPrevious = false, replaced = false, committed = false;
      try {
        await fs.writeFile(temporary, jpeg, { flag: 'wx' });
        if (previous) { await fs.rename(destination, backup); savedPrevious = true; }
        await fs.rename(temporary, destination);
        replaced = true;
        const draft = clone(this.data);
        const asset = draft.assets.find(item => item.id === id);
        Object.assign(asset, { thumbnail: relative, videoThumbnailRevision: revision, updatedAt: now() });
        await this._persist(draft);
        committed = true;
        return this.snapshot();
      } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!committed && replaced) await fs.unlink(destination);
        if (savedPrevious) {
          if (committed) await fs.unlink(backup);
          else await fs.rename(backup, destination);
        }
      }
    });
  }

  setAudioMetadata(id, expectedHash, metadata) {
    return this._mutate(async () => {
      const current = this.data.assets.find(asset => asset.id === id);
      if (!current || current.trashedAt || !AUDIO.has(current.ext) || current.hash !== expectedHash || metadata?.mediaType !== 'audio') {
        throw new Error('音乐已变化，请重新打开预览');
      }
      const information = mediaMetadata(metadata, false, true);
      if (current.mediaType === 'audio' && Object.entries(information).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value))) return this.snapshot();
      const draft = clone(this.data);
      const asset = draft.assets.find(item => item.id === id);
      Object.assign(asset, information, { mediaType: 'audio' });
      delete asset.videoThumbnailRevision;
      await this._persist(draft);
      return this.snapshot();
    });
  }

  refreshFontPreviews(ids, { expectedRoot, signal } = {}) {
    return this._mutate(async () => {
      signal?.throwIfAborted();
      if (expectedRoot !== undefined && expectedRoot !== this.root) throw new Error('素材库已切换，请重新选择字体');
      if (!Array.isArray(ids) || ids.length > 128 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('请选择有效的字体素材');
      const selected = this._ids(ids);
      if (this.data.assets.some(asset => selected.has(asset.id) && !FONT.has(asset.ext))) throw new Error('请选择有效的字体素材');
      const draft = clone(this.data), published = [], errors = [];
      let committed = false;
      const remove = filename => fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const rollback = async record => {
        if (record.replaced) await remove(record.destination);
        if (record.savedPrevious) await fs.rename(record.backup, record.destination);
        await remove(record.temporary);
      };
      const jpegInfo = async filename => {
        const bytes = await fs.readFile(filename);
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('字体封面不是 JPEG');
        const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
        const information = await image.metadata();
        if (information.format !== 'jpeg' || !information.width || !information.height) throw new Error('字体封面数据无效');
        await image.raw().toBuffer();
        return information;
      };
      try {
        for (const asset of draft.assets) {
          signal?.throwIfAborted();
          if (!selected.has(asset.id) || asset.trashedAt || !this.createThumbnail) continue;
          const relative = `thumbnails/${asset.id}.jpg`, destination = path.join(this.root, relative);
          const record = { destination, temporary: `${destination}.${crypto.randomUUID()}.tmp`, backup: `${destination}.${crypto.randomUUID()}.previous`, replaced: false, savedPrevious: false };
          let accepted = false;
          try {
            await this._checkManagedParent(relative);
            const previous = await fileInfo(destination);
            if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('字体封面目标不是普通文件');
            if (asset.thumbnail && asset.font?.family && asset.width > 0 && asset.height > 0 && previous && previous.size <= 16 * 1024 * 1024) {
              try { await jpegInfo(destination); continue; } catch {}
            }
            await this._checkManagedParent(asset.filename);
            const source = path.join(this.root, asset.filename), original = await fs.lstat(source);
            if (!original.isFile() || original.isSymbolicLink() || importPathKey(await fs.realpath(source)) !== importPathKey(source)) throw new Error('字体原文件包含符号链接或不是普通文件');
            if (await hashFile(source) !== asset.hash) throw new Error('字体原文件已变化，请重新导入');
            signal?.throwIfAborted();
            const metadata = await this.createThumbnail(source, record.temporary, { originalName: asset.name, signal });
            signal?.throwIfAborted();
            const generated = await fs.lstat(record.temporary);
            if (!generated.isFile() || generated.isSymbolicLink() || generated.size < 4 || generated.size > 16 * 1024 * 1024 || importPathKey(await fs.realpath(record.temporary)) !== importPathKey(record.temporary)) throw new Error('字体封面数据无效');
            const imageInfo = await jpegInfo(record.temporary);
            const font = fontMetadata(metadata?.font, true);
            if (!font?.family) throw new Error('字体预览缺少字体信息');
            await this._checkManagedParent(asset.filename);
            await this._checkManagedParent(relative);
            const currentSource = await fs.lstat(source);
            if (!currentSource.isFile() || currentSource.isSymbolicLink() || importPathKey(await fs.realpath(source)) !== importPathKey(source)) throw new Error('字体原文件包含符号链接或不是普通文件');
            if (await hashFile(source) !== asset.hash) throw new Error('字体原文件已变化，请重新导入');
            signal?.throwIfAborted();
            if (previous) { await fs.rename(destination, record.backup); record.savedPrevious = true; }
            await fs.rename(record.temporary, destination); record.replaced = true;
            Object.assign(asset, { thumbnail: relative, width: imageInfo.width, height: imageInfo.height, font });
            published.push(record); accepted = true;
          } catch (error) {
            signal?.throwIfAborted();
            if (error.name === 'AbortError') throw error;
            errors.push({ id: asset.id, message: error.message });
          } finally {
            if (!accepted) await rollback(record);
          }
        }
        signal?.throwIfAborted();
        if (published.length) await this._persist(draft);
        committed = true;
        return { snapshot: this.snapshot(), updated: published.length, errors };
      } finally {
        for (const record of published.reverse()) {
          if (!committed) await rollback(record);
          else if (record.savedPrevious) await remove(record.backup);
        }
      }
    });
  }

  refreshVideoMetadata(ids, { signal } = {}) {
    return this._mutate(async () => {
      signal?.throwIfAborted();
      const selected = this._ids(ids);
      const draft = clone(this.data);
      let updated = 0;
      const errors = [];
      for (const asset of draft.assets) {
        signal?.throwIfAborted();
        if (!selected.has(asset.id) || mediaType(asset.ext, asset.mediaType) !== 'video' || !this.createThumbnail) continue;
        if (asset.videoThumbnailRevision || (asset.thumbnail && asset.codec && asset.width > 0 && asset.height > 0)) continue;
        try {
          await this._checkManagedParent(asset.filename);
          const relative = `thumbnails/${asset.id}.jpg`;
          await this._checkManagedParent(relative);
          const destination = path.join(this.root, relative);
          const metadata = await this.createThumbnail(path.join(this.root, asset.filename), destination, { signal });
          await fs.access(destination);
          Object.assign(asset, mediaMetadata(metadata, true), { thumbnail: relative });
          updated++;
        } catch (error) {
          signal?.throwIfAborted();
          errors.push({ id: asset.id, message: error.message });
        }
      }
      if (updated) await this._persist(draft);
      return { snapshot: this.snapshot(), updated, errors };
    });
  }

  async _recheckBundles(ids, { expectedRoot, signal, onProgress } = {}) {
    signal?.throwIfAborted();
    if (expectedRoot !== undefined && expectedRoot !== this.root) throw new Error('素材库已切换，请重新检查资源');
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw new Error('请选择需要检查的资源包');
    const selected = [...new Set(ids)].map(id => this.data.assets.find(asset => asset.id === id));
    if (selected.some(asset => !asset || !isBundle(asset.ext))) throw new Error('部分资源包已不存在或不支持依赖检查');
    const draft = clone(this.data), results = [], errors = [];
    for (const [index, asset] of selected.entries()) {
      signal?.throwIfAborted();
      try { onProgress?.({ phase: 'checking', current: index + 1, total: selected.length, id: asset.id, name: asset.name }); } catch {}
      try {
        const manifest = assetBundle(asset), directory = path.join(this.root, bundleRelative(asset.id, asset.ext));
        await this._checkManagedParent(bundleRelative(asset.id, asset.ext));
        await checkBundleTree(directory, manifest.files.map(file => file.path));
        const result = await recheckStoredBundle(directory, manifest, { project: PROJECT.has(asset.ext), signal });
        signal?.throwIfAborted();
        const updated = { ...manifest, ...result };
        bundleRepairValidator(asset.ext)(updated);
        draft.assets.find(item => item.id === asset.id)[PROJECT.has(asset.ext) ? 'projectBundle' : 'modelBundle'] = updated;
        results.push({ id: asset.id, ...result });
      } catch (error) {
        signal?.throwIfAborted();
        errors.push({ id: asset.id, name: asset.name, message: error.message });
      }
    }
    signal?.throwIfAborted();
    if (results.length) await this._persist(draft);
    return { snapshot: this.snapshot(), checked: results.length, results, errors };
  }

  recheckBundles(ids, options = {}) {
    return this._mutate(() => this._recheckBundles(ids, options));
  }

  exportAssets(ids, destDir, options = {}) {
    return this._mutate(async () => {
      const selected = this._ids(ids);
      const checked = await this._recheckBundles(this.data.assets.filter(asset => selected.has(asset.id) && isBundle(asset.ext)).map(asset => asset.id), options);
      if (checked.errors.length) throw new Error(checked.errors[0].message);
      return { ...await AssetExport.exportAssets(this, this.data.assets.filter(asset => selected.has(asset.id)), destDir, options), snapshot: this.snapshot() };
    });
  }

  exportFolder(folderId, destDir, options = {}) {
    return this._mutate(async () => {
      this._folder(folderId);
      const included = folderId === null ? null : FolderTree.descendantIds(this.data.folders, folderId);
      const ids = this.data.assets.filter(asset => !asset.trashedAt && isBundle(asset.ext) && (included === null || included.has(asset.folderId))).map(asset => asset.id);
      const checked = await this._recheckBundles(ids, options);
      if (checked.errors.length) throw new Error(checked.errors[0].message);
      return { ...await AssetExport.exportFolder(this, folderId, destDir, options), snapshot: this.snapshot() };
    });
  }

  backupTo(destDir) {
    return this._mutate(async () => {
      const destination = path.resolve(text(destDir, '备份目录', 32000));
      if (isWithin(this.root, destination) || isWithin(destination, this.root)) throw new Error('备份目录与素材库不能互相包含');
      // A fresh child directory prevents overwriting an earlier backup or unrelated files.
      await fs.mkdir(destination, { recursive: true });
      const folder = path.join(destination, `Mosaic 备份-${now().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
      await fs.cp(this.root, folder, { recursive: true, errorOnExist: true, force: false, dereference: false, filter: source => !isIndexTemporary(this.root, source) });
      return { path: folder };
    });
  }
}

module.exports = { Library, SUPPORTED, VIDEO, AUDIO, MODEL, PROJECT, FONT, DOCUMENT, isIndexTemporary, copyFileAtomically };
