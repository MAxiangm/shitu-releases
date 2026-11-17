'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const MODES = new Set(['auto', 'cpu', 'gpu', 'hybrid']);
function processorCount() { return Math.max(1, Math.min(128, os.availableParallelism?.() || os.cpus().length || 1)); }
function defaults(logicalProcessors = processorCount()) {
  return { mode: 'auto', cpuThreads: Math.max(1, Math.min(32, Math.floor(logicalProcessors / 2))), gpuId: 'auto' };
}
function validateSettings(value, logicalProcessors = processorCount()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !MODES.has(value.mode)) throw new Error('请选择有效的转码模式');
  if (!Number.isInteger(value.cpuThreads) || value.cpuThreads < 1 || value.cpuThreads > Math.min(64, logicalProcessors)) throw new Error(`CPU 线程数必须为 1 至 ${Math.min(64, logicalProcessors)}`);
  if (typeof value.gpuId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(value.gpuId)) throw new Error('请选择有效的 GPU 设备');
  return { mode: value.mode, cpuThreads: value.cpuThreads, gpuId: value.gpuId };
}
function createTranscodeSettings({ filePath, logicalProcessors = processorCount() }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('Settings path must be absolute');
  let queue = Promise.resolve();
  async function get() {
    await queue.catch(() => {});
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (data.version !== 1) return defaults(logicalProcessors);
      return validateSettings(data.settings, logicalProcessors);
    } catch { return defaults(logicalProcessors); }
  }
  function save(value) {
    const settings = validateSettings(value, logicalProcessors);
    const task = queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, settings }, null, 2) + '\n', { flag: 'wx' });
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(temporary, filePath); break; }
          catch (error) {
            if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
            await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 25));
          }
        }
        return { ...settings };
      } finally { await fs.unlink(temporary).catch(() => {}); }
    });
    queue = task;
    return task;
  }
  return Object.freeze({ get, save, flush: () => queue.catch(() => {}) });
}
function executionPlan(settings, devices, { format, total = 1 } = {}) {
  const logical = devices?.cpu?.logicalProcessors || processorCount();
  const selected = validateSettings(settings, logical);
  const cpu = { id: 'cpu', label: devices?.cpu?.name || 'CPU', device: { type: 'cpu', threads: selected.cpuThreads } };
  if (format === 'dxv') return { mode: 'cpu', lanes: [cpu], notice: selected.mode === 'cpu' ? '' : 'DXV 编码使用 CPU；GPU 和双线加速适用于 MP4。' };
  if (format !== 'mp4') throw new Error('请选择 MP4 或 DXV Normal');
  if (selected.mode === 'cpu') return { mode: 'cpu', lanes: [cpu] };
  const gpus = Array.isArray(devices?.gpus) ? devices.gpus : [];
  const gpu = selected.gpuId === 'auto' ? gpus.find(item => item.available) : gpus.find(item => item.id === selected.gpuId && item.available);
  if (!gpu) {
    if (selected.mode === 'auto') return { mode: 'cpu', lanes: [cpu], notice: '未找到可用的所选 GPU 编码设备，本次使用 CPU。' };
    throw new Error('所选 GPU 不可用于编码，请在设置中重新检测设备或选择 CPU。');
  }
  const gpuLane = { id: 'gpu', label: gpu.name || 'GPU', device: { ...gpu, type: 'gpu', threads: selected.cpuThreads } };
  const hybrid = selected.mode === 'hybrid';
  return { mode: hybrid ? 'hybrid' : 'gpu', lanes: hybrid && total > 1 ? [gpuLane, cpu] : [gpuLane],
    notice: hybrid ? total > 1 ? 'CPU 与 GPU 同时处理不同视频。' : '单个视频由 CPU 解码、GPU 编码。' : '' };
}
module.exports = { createTranscodeSettings, defaults, validateSettings, executionPlan };
