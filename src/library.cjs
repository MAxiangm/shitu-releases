const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');

const { VIDEO, SUPPORTED } = require('./media-formats.cjs');
function mediaMetadata(value = {}) {
  const result = {};
  for (const key of ['width', 'height', 'duration']) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) result[key] = number;
  }
  if (typeof value.codec === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value.codec)) result.codec = value.codec;
  for (const key of ['hasAudio', 'hasAlpha']) if (typeof value[key] === 'boolean') result[key] = value[key];
  return result;
}
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const PENDING_DELETE = /^\.pending-delete-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safeName = value => {
  let result = String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 160) || '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result;
};

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

function deletionFiles(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error('永久删除清单无效');
  const ids = new Set();
  return manifest.assets.flatMap(asset => {
    if (!asset || typeof asset.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(asset.id) || ids.has(asset.id) || !SUPPORTED.has(asset.ext) || typeof asset.hasThumbnail !== 'boolean') throw new Error('永久删除清单路径无效');
    ids.add(asset.id);
    const files = [{ id: asset.id, relative: `originals/${asset.id}.${asset.ext}`, staged: `${asset.id}.${asset.ext}` }];
    if (asset.hasThumbnail) files.push({ id: asset.id, relative: `thumbnails/${asset.id}.jpg`, staged: `${asset.id}.thumbnail.jpg` });
    return files;
  });
}

async function fileInfo(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

class Library {
  constructor({ root, createThumbnail } = {}) {
    if (!root) throw new Error('素材库路径不能为空');
    this.root = path.resolve(root);
    this.indexPath = path.join(this.root, 'index.json');
    this.createThumbnail = createThumbnail;
    this.data = null;
    this._queue = Promise.resolve();
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
      const pendingDeletion = (await fs.readdir(this.root)).some(name => PENDING_DELETE.test(name));
      if (backupExists || originalFiles.length || thumbnailFiles.length || pendingDeletion) throw new Error('素材库索引缺失，但发现已有素材或备份，已保留原文件。请恢复 index.json 后重新打开。');
      const data = { version: 1, assets: [], folders: [] };
      await this._persist(data);
    }
    await fs.mkdir(path.join(this.root, 'originals'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'thumbnails'), { recursive: true });
    await this._recoverPendingDeletions();
    return this.snapshot();
  }

  _validate(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.assets) || !Array.isArray(data.folders)) throw new Error('索引格式无效或版本不受支持');
    const folderIds = new Set();
    for (const folder of data.folders) {
      if (!folder || typeof folder.id !== 'string' || folderIds.has(folder.id) || typeof folder.name !== 'string' || !folder.name.trim()) throw new Error('分类索引无效');
      folderIds.add(folder.id);
    }
    const assetIds = new Set();
    for (const asset of data.assets) {
      if (!asset || typeof asset.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(asset.id) || assetIds.has(asset.id) || typeof asset.name !== 'string' || !SUPPORTED.has(asset.ext) || !Array.isArray(asset.tags) || asset.tags.some(tag => typeof tag !== 'string') || typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.hash) || !Number.isFinite(asset.size) || asset.size < 0 || !Number.isFinite(asset.rating) || asset.rating < 0 || asset.rating > 5 || typeof asset.notes !== 'string' || (asset.folderId !== null && !folderIds.has(asset.folderId))) throw new Error('素材索引无效');
      if (asset.filename !== `originals/${asset.id}.${asset.ext}` || (asset.thumbnail !== null && asset.thumbnail !== `thumbnails/${asset.id}.jpg`)) throw new Error('素材路径无效');
      if ('mediaType' in asset && asset.mediaType !== (VIDEO.has(asset.ext) ? 'video' : 'image')) throw new Error('素材媒体类型无效');
      if ('duration' in asset && (!Number.isFinite(asset.duration) || asset.duration < 0)) throw new Error('视频时长无效');
      if ('codec' in asset && (typeof asset.codec !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(asset.codec))) throw new Error('视频编码无效');
      if ('sourceUrl' in asset) webUrl(asset.sourceUrl, '素材链接');
      if ('pageUrl' in asset) webUrl(asset.pageUrl, '来源网页');
      assetIds.add(asset.id);
    }
  }

  _ready() { if (!this.data) throw new Error('素材库尚未初始化'); }

  async flush() { await this._queue; }

  async _persist(data) {
    this._validate(data);
    const temporary = `${this.indexPath}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify(data, null, 2), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.copyFile(this.indexPath, path.join(this.root, 'index.backup.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(temporary, this.indexPath);
      this.data = data;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  _mutate(work) {
    const result = this._queue.then(() => { this._ready(); return work(); });
    this._queue = result.catch(() => {});
    return result;
  }

  snapshot() {
    this._ready();
    const assets = clone(this.data.assets).map(asset => ({ ...asset, mediaType: VIDEO.has(asset.ext) ? 'video' : 'image' }));
    const active = assets.filter(asset => !asset.trashedAt);
    const tagCounts = new Map();
    for (const asset of active) for (const tag of asset.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    return {
      root: this.root,
      assets,
      folders: clone(this.data.folders),
      tags: [...tagCounts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      stats: { total: assets.length, active: active.length, trashed: assets.length - active.length, untagged: active.filter(a => !a.tags.length).length, unfiled: active.filter(a => !a.folderId).length, bytes: assets.reduce((sum, a) => sum + a.size, 0) }
    };
  }

  importPaths(paths, { folderId = null, onProgress, metadata = {} } = {}) {
    return this._mutate(async () => {
      if (!Array.isArray(paths)) throw new Error('导入路径必须是数组');
      const sourceMetadata = importMetadata(metadata);
      this._folder(folderId);
      const report = { imported: 0, duplicates: 0, unsupported: [], errors: [], assetIds: [] };
      const candidates = [];
      const seen = new Set();
      const walk = async entry => {
        const absolute = path.resolve(String(entry));
        if (seen.has(absolute)) return;
        seen.add(absolute);
        try {
          if (isWithin(this.root, absolute)) { report.errors.push({ path: absolute, message: '不能将素材库自身再次导入' }); return; }
          const info = await fs.lstat(absolute);
          if (info.isSymbolicLink()) { report.errors.push({ path: absolute, message: '已跳过符号链接' }); return; }
          if (info.isDirectory()) {
            const children = await fs.readdir(absolute);
            for (const child of children) await walk(path.join(absolute, child));
          } else if (info.isFile()) {
            if (SUPPORTED.has(path.extname(absolute).slice(1).toLowerCase())) candidates.push({ absolute, info });
            else report.unsupported.push(absolute);
          }
        } catch (error) { report.errors.push({ path: absolute, message: error.message }); }
      };
      for (const entry of paths) await walk(entry);
      const draft = clone(this.data);
      const hashes = new Set(draft.assets.map(asset => asset.hash));
      const created = [];
      for (let index = 0; index < candidates.length; index++) {
        const { absolute, info } = candidates[index];
        let copied = null;
        let thumbnailPath = null;
        try {
          const hash = await hashFile(absolute);
          if (hashes.has(hash)) report.duplicates++;
          else {
            const id = crypto.randomUUID();
            const ext = path.extname(absolute).slice(1).toLowerCase();
            const filename = `originals/${id}.${ext}`;
            copied = path.join(this.root, filename);
            await fs.copyFile(absolute, copied, require('node:fs').constants.COPYFILE_EXCL);
            // Hash the managed copy too so a source changing during import never gets a stale identity.
            const copyHash = await hashFile(copied);
            if (hashes.has(copyHash)) { await fs.rm(copied); copied = null; report.duplicates++; }
            else {
              let dimensions = {};
              let thumbnail = null;
              if (this.createThumbnail) {
                thumbnailPath = path.join(this.root, 'thumbnails', `${id}.jpg`);
                try {
                  dimensions = await this.createThumbnail(copied, thumbnailPath) || {};
                  await fs.access(thumbnailPath);
                  thumbnail = `thumbnails/${id}.jpg`;
                } catch { await fs.rm(thumbnailPath, { force: true }).catch(() => {}); thumbnailPath = null; }
              }
              const timestamp = now();
              const copyInfo = await fs.stat(copied);
              draft.assets.push({ id, name: path.basename(absolute, path.extname(absolute)), ext, mediaType: VIDEO.has(ext) ? 'video' : 'image', size: copyInfo.size, width: Number(dimensions.width) || 0, height: Number(dimensions.height) || 0, ...mediaMetadata(dimensions), hash: copyHash, createdAt: timestamp, updatedAt: timestamp, tags: [], folderId, rating: 0, notes: '', trashedAt: null, filename, thumbnail, ...sourceMetadata });
              hashes.add(copyHash);
              created.push(copied);
              if (thumbnail) created.push(thumbnailPath);
              report.imported++;
              report.assetIds.push(id);
            }
          }
        } catch (error) {
          if (copied) await fs.rm(copied, { force: true }).catch(() => {});
          if (thumbnailPath) await fs.rm(thumbnailPath, { force: true }).catch(() => {});
          report.errors.push({ path: absolute, message: error.message });
        }
        if (typeof onProgress === 'function') { try { onProgress({ current: index + 1, total: candidates.length, path: absolute, imported: report.imported, duplicates: report.duplicates }); } catch {} }
      }
      if (report.imported) {
        try { await this._persist(draft); }
        catch (error) { for (const file of created) await fs.rm(file, { force: true }).catch(() => {}); throw error; }
      }
      return report;
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

  updateAssets(ids, patch) {
    return this._mutate(async () => {
      const selected = this._ids(ids);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('修改内容无效');
      const clean = {};
      for (const key of Object.keys(patch)) if (!['name', 'tags', 'folderId', 'rating', 'notes', 'sourceUrl', 'pageUrl'].includes(key)) throw new Error(`不支持修改 ${key}`);
      if ('name' in patch) clean.name = text(patch.name, '名称', 240);
      if ('sourceUrl' in patch) clean.sourceUrl = webUrl(patch.sourceUrl, '素材链接');
      if ('pageUrl' in patch) clean.pageUrl = webUrl(patch.pageUrl, '来源网页');
      if ('tags' in patch) {
        if (!Array.isArray(patch.tags) || patch.tags.length > 100) throw new Error('标签格式无效或数量过多');
        clean.tags = [...new Set(patch.tags.map(tag => text(tag, '标签', 100)))];
      }
      if ('folderId' in patch) { this._folder(patch.folderId); clean.folderId = patch.folderId; }
      if ('rating' in patch) { if (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5) throw new Error('评分必须是 0 至 5 的整数'); clean.rating = patch.rating; }
      if ('notes' in patch) { if (typeof patch.notes !== 'string' || patch.notes.length > 20000) throw new Error('备注格式无效或超过 20000 字符'); clean.notes = patch.notes; }
      const draft = clone(this.data);
      for (const asset of draft.assets) if (selected.has(asset.id)) Object.assign(asset, clean, { updatedAt: now() });
      await this._persist(draft);
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
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('素材目录不能是符号链接');
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
    // Remove only enumerated files, never recursively delete a computed path.
    for (const name of [...files.map(file => file.staged), 'manifest.json.tmp', 'manifest.json']) {
      await fs.unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await fs.rmdir(directory);
  }

  async _finishDeletion(directory, files) {
    // A recovery index must not reference originals that are about to disappear.
    await fs.copyFile(this.indexPath, path.join(this.root, 'index.backup.json'));
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
      if (![asset.filename, asset.thumbnail].includes(file.relative)) throw new Error('永久删除清单与素材路径不一致');
      const staged = path.join(directory, file.staged);
      const info = await fileInfo(staged);
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('永久删除暂存文件无效');
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
      await this._recoverPendingDeletions();
      const manifest = { version: 1, assets: assets.map(asset => ({ id: asset.id, ext: asset.ext, hasThumbnail: Boolean(asset.thumbnail) })) };
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
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('素材文件无效，已停止永久删除');
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

  createFolder(name) {
    return this._mutate(async () => {
      name = text(name, '分类名称', 100);
      if (this.data.folders.some(folder => folder.name === name)) throw new Error('该分类名称已存在');
      const draft = clone(this.data);
      draft.folders.push({ id: crypto.randomUUID(), name, createdAt: now() });
      await this._persist(draft);
      return this.snapshot();
    });
  }

  renameFolder(id, name) {
    return this._mutate(async () => {
      this._folder(id);
      if (id === null) throw new Error('分类不存在');
      name = text(name, '分类名称', 100);
      if (this.data.folders.some(folder => folder.id !== id && folder.name === name)) throw new Error('该分类名称已存在');
      const draft = clone(this.data);
      draft.folders.find(folder => folder.id === id).name = name;
      await this._persist(draft);
      return this.snapshot();
    });
  }

  deleteFolder(id) {
    return this._mutate(async () => {
      this._folder(id);
      if (id === null) throw new Error('分类不存在');
      const draft = clone(this.data);
      draft.folders = draft.folders.filter(folder => folder.id !== id);
      for (const asset of draft.assets) if (asset.folderId === id) Object.assign(asset, { folderId: null, updatedAt: now() });
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

  refreshVideoMetadata(ids, { signal } = {}) {
    return this._mutate(async () => {
      signal?.throwIfAborted();
      const selected = this._ids(ids);
      const draft = clone(this.data);
      let updated = 0;
      const errors = [];
      for (const asset of draft.assets) {
        signal?.throwIfAborted();
        if (!selected.has(asset.id) || !VIDEO.has(asset.ext) || !this.createThumbnail) continue;
        if (asset.thumbnail && asset.codec && asset.width > 0 && asset.height > 0) continue;
        try {
          await this._checkManagedParent(asset.filename);
          const relative = `thumbnails/${asset.id}.jpg`;
          await this._checkManagedParent(relative);
          const destination = path.join(this.root, relative);
          const metadata = await this.createThumbnail(path.join(this.root, asset.filename), destination, { signal });
          await fs.access(destination);
          Object.assign(asset, mediaMetadata(metadata), { thumbnail: relative });
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

  exportAssets(ids, destDir) {
    return this._mutate(async () => {
      const selected = this._ids(ids);
      const destination = path.resolve(text(destDir, '导出目录', 32000));
      if (isWithin(this.root, destination) || isWithin(destination, this.root)) throw new Error('请选择与素材库分开的导出目录');
      await fs.mkdir(destination, { recursive: true });
      const files = [];
      for (const asset of this.data.assets) {
        if (!selected.has(asset.id)) continue;
        const basename = safeName(asset.name);
        let number = 0;
        while (true) {
          const output = path.join(destination, `${basename}${number ? ` (${number})` : ''}.${asset.ext}`);
          try { await fs.copyFile(this.getAssetPath(asset.id), output, require('node:fs').constants.COPYFILE_EXCL); files.push(output); break; }
          catch (error) { if (error.code !== 'EEXIST') throw error; number++; }
        }
      }
      return { exported: files.length, files };
    });
  }

  backupTo(destDir) {
    return this._mutate(async () => {
      const destination = path.resolve(text(destDir, '备份目录', 32000));
      if (isWithin(this.root, destination) || isWithin(destination, this.root)) throw new Error('备份目录与素材库不能互相包含');
      // A fresh child directory prevents overwriting an earlier backup or unrelated files.
      await fs.mkdir(destination, { recursive: true });
      const folder = path.join(destination, `拾图备份-${now().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
      await fs.cp(this.root, folder, { recursive: true, errorOnExist: true, force: false, dereference: false, filter: source => !source.endsWith('.tmp') });
      return { path: folder };
    });
  }
}

module.exports = { Library, SUPPORTED, VIDEO };
