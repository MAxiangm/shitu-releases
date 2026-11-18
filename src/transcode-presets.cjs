'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeOptions } = require('./video-transcode.cjs');

const MAX_PRESETS = 40;

function nameOf(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 40 || /[\x00-\x1f]/.test(name)) throw new Error('请输入 1 至 40 个字符的预设名称');
  return name;
}

function optionsOf(value) {
  const { format, alpha, bitrateMbps } = normalizeOptions({
    format: value?.format, alpha: value?.alpha, bitrateMbps: value?.bitrateMbps
  });
  return format === 'mp4' ? { format, bitrateMbps } : { format, alpha };
}

function createTranscodePresets(filePath) {
  if (!path.isAbsolute(filePath)) throw new TypeError('Preset file path must be absolute');
  let queue = Promise.resolve();

  async function read() {
    let saved;
    try { saved = JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (saved?.version !== 1 || !Array.isArray(saved.presets) || saved.presets.length > MAX_PRESETS) throw new Error('转码预设文件格式无效');
    return saved.presets.map(({ id, name, ...value }) => {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('转码预设编号无效');
      return { id, name: nameOf(name), ...optionsOf(value) };
    });
  }

  function change(update) {
    const task = queue.catch(() => {}).then(async () => {
      const presets = update(await read());
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, presets }, null, 2) + '\n', { flag: 'wx' });
        await fs.rename(temporary, filePath);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      return presets;
    });
    queue = task;
    return task;
  }

  return {
    async list() { await queue.catch(() => {}); return read(); },
    save(value) {
      const name = nameOf(value?.name);
      const preset = { id: crypto.randomUUID(), name, ...optionsOf(value) };
      return change(presets => {
        if (presets.length >= MAX_PRESETS) throw new Error('最多可保存 40 个转码预设');
        if (presets.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('已存在同名预设');
        return [...presets, preset];
      });
    },
    remove(id) {
      return change(presets => {
        if (!presets.some(item => item.id === id)) throw new Error('此预设已不存在');
        return presets.filter(item => item.id !== id);
      });
    },
    flush: () => queue.catch(() => {})
  };
}

module.exports = { createTranscodePresets };
