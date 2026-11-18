const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { Library } = require('./library.cjs');
const { MODEL, PROJECT } = require('./media-formats.cjs');
const { validateModelBundle, modelBundleHash } = require('./model-bundle.cjs');
const { validateProjectBundle, projectBundleHash } = require('./project-bundle.cjs');

function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径`);
  return path.resolve(value);
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function directoryName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || value === '.' || value === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new Error('素材库文件夹名称无效');
  return value.trim();
}

class LibraryManager {
  constructor({ configPath, legacyRoot, createThumbnail, prepareProjectBundle, overrideRoot } = {}) {
    this.configPath = absolute(configPath, '配置路径');
    this.legacyRoot = legacyRoot ? absolute(legacyRoot, '旧素材库路径') : null;
    this.overrideRoot = overrideRoot ? absolute(overrideRoot, '测试素材库路径') : null;
    this.createThumbnail = createThumbnail;
    this.prepareProjectBundle = prepareProjectBundle;
    this._current = null;
    this._error = null;
    this._legacyCandidate = null;
    this._initialized = false;
    this._queue = Promise.resolve();
  }

  current() { return this._current; }

  status() {
    return {
      configured: Boolean(this._current),
      root: this._current?.root || null,
      error: this._error,
      ...(this._legacyCandidate ? { legacyRoot: this._legacyCandidate } : {})
    };
  }

  _enqueue(operation) {
    const result = this._queue.then(operation);
    this._queue = result.catch(() => {});
    return result;
  }

  _library(root) { return new Library({ root, createThumbnail: this.createThumbnail, prepareProjectBundle: this.prepareProjectBundle }); }

  async _existing(root) {
    root = absolute(root, '素材库路径');
    let index;
    try { index = await fs.stat(path.join(root, 'index.json')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`找不到素材库索引，请选择现有素材库文件夹：${root}`);
      throw error;
    }
    if (!index.isFile()) throw new Error(`素材库索引不是文件：${root}`);
    const candidate = this._library(await fs.realpath(root));
    await candidate.init();
    return candidate;
  }

  init() {
    return this._enqueue(async () => {
      if (this._initialized) return this.status();
      this._initialized = true;
      if (this.overrideRoot) {
        try {
          const candidate = this._library(this.overrideRoot);
          await candidate.init();
          this._current = candidate;
        } catch (error) { this._error = error.message; }
        return this.status();
      }
      try {
        const config = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
        if (!config || config.version !== 1) throw new Error('素材库配置格式或版本无效');
        this._current = await this._existing(absolute(config.libraryRoot, '已保存的素材库路径'));
      } catch (error) {
        if (error.code !== 'ENOENT') this._error = error.message;
        else if (this.legacyRoot) {
          const index = await fs.stat(path.join(this.legacyRoot, 'index.json')).catch(() => null);
          if (index?.isFile()) this._legacyCandidate = this.legacyRoot;
        }
      }
      return this.status();
    });
  }

  async _writeConfig(root) {
    if (this.overrideRoot) return;
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ version: 1, libraryRoot: root }, null, 2) + '\n', 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      try { await fs.copyFile(this.configPath, `${this.configPath}.backup`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(temporary, this.configPath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw new Error(`无法保存素材库位置，当前素材库未切换：${error.message}`);
    }
  }

  async _parent(parentDir) {
    const root = absolute(parentDir, '父文件夹路径');
    if (!(await fs.stat(root)).isDirectory()) throw new Error('请选择现有文件夹作为素材库保存位置');
    return fs.realpath(root);
  }

  async _reserve(parent, name, sourceRoot) {
    name = directoryName(name);
    if (sourceRoot && contains(sourceRoot, parent)) throw new Error('新素材库不能放在当前素材库内');
    for (let suffix = 1; suffix <= 10000; suffix++) {
      const candidate = path.join(parent, `${name}${suffix === 1 ? '' : ` ${suffix}`}`);
      if (sourceRoot && (contains(sourceRoot, candidate) || contains(candidate, sourceRoot))) continue;
      try { await fs.mkdir(candidate); return candidate; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw new Error('无法创建唯一的素材库文件夹名称');
  }

  _switch(operation) {
    return this._enqueue(async () => {
      try {
        await this._current?.flush();
        const candidate = await operation();
        await this._writeConfig(candidate.root);
        this._current = candidate;
        this._initialized = true;
        this._error = null;
        this._legacyCandidate = null;
        return candidate;
      } catch (error) { this._error = error.message; throw error; }
    });
  }

  create(parentDir, name = 'Mosaic 素材库') {
    return this._switch(async () => {
      const root = await this._reserve(await this._parent(parentDir), name);
      const candidate = this._library(root);
      await candidate.init();
      return candidate;
    });
  }

  open(root) { return this._switch(() => this._existing(root)); }

  migrate(parentDir) {
    return this._switch(async () => {
      if (!this._current) throw new Error('请先打开要迁移的素材库');
      const source = await fs.realpath(this._current.root);
      const destination = await this._reserve(await this._parent(parentDir), 'Mosaic 素材库', source);
      // Copy into a newly reserved directory. No existing destination files or
      // source files are overwritten or removed, even if saving config fails.
      for (const entry of await fs.readdir(source)) {
        if (entry.endsWith('.tmp')) continue;
        await fs.cp(path.join(source, entry), path.join(destination, entry), { recursive: true, force: false, errorOnExist: true, dereference: false, filter: filename => !filename.endsWith('.tmp') });
      }
      const candidate = await this._existing(destination);
      for (const asset of candidate.snapshot().assets) {
        try {
          if (MODEL.has(asset.ext) || PROJECT.has(asset.ext)) {
            const project = PROJECT.has(asset.ext);
            const manifest = project ? validateProjectBundle(asset.projectBundle) : validateModelBundle(asset.modelBundle);
            const directory = project ? candidate.getProjectBundleDirectory(asset.id) : candidate.getModelBundleDirectory(asset.id);
            const files = [];
            for (const file of manifest.files) {
              const filename = project ? candidate.getProjectFilePath(asset.id, file.path) : candidate.getModelFilePath(asset.id, file.path);
              await candidate._checkManagedParent(path.relative(candidate.root, filename));
              const info = await fs.lstat(filename);
              if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) throw new Error('模型包文件大小与索引不一致');
              if (!contains(directory, await fs.realpath(filename))) throw new Error('资源依赖指向资源包之外');
              const hash = crypto.createHash('sha256');
              for await (const chunk of createReadStream(filename)) hash.update(chunk);
              const digest = hash.digest('hex');
              if (digest !== file.hash) throw new Error('模型包文件校验失败');
              files.push({ ...file, hash: digest });
            }
            if ((project ? projectBundleHash : modelBundleHash)(files, manifest.entry) !== asset.hash || files.reduce((sum, file) => sum + file.size, 0) !== asset.size) throw new Error('资源包整体校验失败');
            continue;
          }
          const filename = candidate.getAssetPath(asset.id, 'original');
          const info = await fs.lstat(filename);
          if (!info.isFile() || info.size !== asset.size) throw new Error('文件大小与索引不一致或不是普通文件');
          const resolved = await fs.realpath(filename);
          if (!contains(destination, resolved)) throw new Error('原件路径指向新素材库之外');
          const hash = crypto.createHash('sha256');
          for await (const chunk of createReadStream(filename)) hash.update(chunk);
          if (hash.digest('hex') !== asset.hash) throw new Error('原件内容与索引校验值不一致');
        } catch (error) {
          throw new Error(`迁移校验失败：${asset.name}。原素材库仍保留，未切换位置。${error.message}`);
        }
      }
      return candidate;
    });
  }
}

module.exports = { LibraryManager };
