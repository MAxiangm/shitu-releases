'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { VIDEO } = require('./media-formats.cjs');

const MAX_ITEMS = 256;
const clone = value => structuredClone(value);
const abortError = () => Object.assign(new Error('视频转码已取消'), { name: 'AbortError' });
const isAbort = error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
function checkedExecutionPlan(value, format, count) {
  if (value === undefined) return { mode: 'cpu', lanes: [{ id: 'cpu', label: 'CPU', device: { type: 'cpu' } }], notice: null };
  if (!value || typeof value !== 'object' || !['auto', 'cpu', 'gpu', 'hybrid'].includes(value.mode) ||
      !Array.isArray(value.lanes) || value.lanes.length < 1 || value.lanes.length > 2) throw new Error('转码设备设置无效');
  const ids = new Set();
  let lanes = value.lanes.map(lane => {
    if (!lane || typeof lane.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(lane.id) || ids.has(lane.id) ||
        typeof lane.label !== 'string' || !lane.label.trim() || lane.label.length > 160 ||
        !lane.device || !['cpu', 'gpu'].includes(lane.device.type)) throw new Error('转码设备设置无效');
    ids.add(lane.id);
    const device = { ...lane.device };
    if (device.threads !== undefined && (!Number.isInteger(device.threads) || device.threads < 1 || device.threads > 64)) throw new Error('CPU 线程数无效');
    if (device.type === 'gpu' && (typeof device.id !== 'string' || !device.id ||
        !['h264_nvenc', 'h264_qsv', 'h264_amf'].includes(device.encoder) || !Number.isInteger(device.index) || device.index < 0)) throw new Error('GPU 设备设置无效');
    return { id: lane.id, label: lane.label, device };
  });
  let mode = value.mode, notice = typeof value.notice === 'string' ? value.notice.slice(0, 400) : null;
  if (lanes.length === 2 && (mode !== 'hybrid' || new Set(lanes.map(lane => lane.device.type)).size !== 2)) throw new Error('双线模式需要一个 CPU 和一个 GPU');
  if (format === 'dxv') {
    const cpu = lanes.find(lane => lane.device.type === 'cpu');
    if (lanes.some(lane => lane.device.type === 'gpu')) notice = 'DXV 使用 CPU 编码，当前设备选择仅用于 MP4。';
    lanes = [cpu || { id: 'cpu', label: 'CPU', device: { type: 'cpu', ...(lanes[0].device.threads ? { threads: lanes[0].device.threads } : {}) } }];
    mode = 'cpu';
  } else if (count === 1 && mode === 'hybrid') {
    lanes = [lanes.find(lane => lane.device.type === 'gpu') || lanes[0]];
    mode = lanes[0].device.type;
    notice ||= '单个视频使用 GPU 编码；CPU 与 GPU 双线用于批量任务。';
  }
  return { mode, lanes, notice };
}
function checkedOptions(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('转码设置无效');
  if (!['mp4', 'dxv'].includes(request.format)) throw new Error('请选择 MP4 或 DXV Normal');
  if (request.alpha !== undefined && typeof request.alpha !== 'boolean') throw new Error('透明通道设置无效');
  if (request.format === 'mp4' && (typeof request.bitrateMbps !== 'number' || !Number.isFinite(request.bitrateMbps) || request.bitrateMbps < 0.5 || request.bitrateMbps > 200))
    throw new Error('MP4 视频码率必须在 0.5 至 200 Mbps 之间');
  if (!Array.isArray(request.ids) || !request.ids.length || request.ids.length > MAX_ITEMS || request.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)))
    throw new Error(`请选择 1 至 ${MAX_ITEMS} 个视频`);
  const ids = [...new Set(request.ids)];
  return { ids, format: request.format, bitrateMbps: request.format === 'mp4' ? request.bitrateMbps : null,
    alpha: request.format === 'dxv' && request.alpha === true, executionPlan: checkedExecutionPlan(request.executionPlan, request.format, ids.length) };
}

function createVideoTranscodeService({ getLibrary, engine, workDir, onEvent = () => {}, onChanged = () => {} }) {
  if (typeof getLibrary !== 'function' || typeof engine?.transcode !== 'function') throw new TypeError('Video transcode service requires a library provider and transcoder');
  if (typeof workDir !== 'string' || !path.isAbsolute(workDir)) throw new TypeError('Video transcode work directory must be absolute');
  workDir = path.resolve(workDir);
  let active = null, closed = false, lastEmit = 0;
  let snapshot = { id: null, status: 'idle', root: null, format: null, bitrateMbps: null, alpha: false, total: 0, completed: 0, failed: 0, imported: 0, duplicates: 0, progress: 0, current: null, runningItems: [], lanes: [], executionMode: null, executionNotice: null, results: [], errors: [] };
  function state() { return clone(snapshot); }
  function emit(force = false) {
    if (!force && Date.now() - lastEmit < 80) return;
    lastEmit = Date.now();
    try { onEvent(state()); } catch {}
  }
  function currentSource(job, source) {
    const owner = getLibrary();
    if (owner !== job.library || owner?.root !== job.root) throw new Error('素材库已切换，已停止转码');
    const asset = owner.snapshot().assets.find(item => item.id === source.id);
    if (!asset || asset.trashedAt || asset.hash !== source.hash || !VIDEO.has(asset.ext)) throw new Error('源视频已变化或移入回收站，已跳过');
    return asset;
  }
  function check(job) {
    if (job.controller.signal.aborted) throw abortError();
    if (getLibrary() !== job.library || job.library.root !== job.root) throw new Error('素材库已切换，已停止转码');
  }
  function syncJob(job) {
    snapshot.runningItems = job.lanes.filter(lane => lane.current).map(lane => ({ ...lane.current })).sort((a, b) => a.index - b.index);
    snapshot.current = snapshot.runningItems[0] || null;
    snapshot.lanes = job.lanes.map(lane => ({ id: lane.id, label: lane.label, device: { ...lane.device }, status: lane.status,
      current: lane.current ? { ...lane.current } : null }));
    snapshot.results = job.results.filter(Boolean);
    snapshot.errors = snapshot.results.filter(result => result.status === 'failed').map(result => ({ id: result.id, name: result.name, error: result.error }));
    if (job.failure) snapshot.errors.push({ id: null, name: '', error: job.failure.message || String(job.failure) });
    snapshot.completed = snapshot.results.length;
    snapshot.progress = Math.min(100, job.progress.reduce((total, value) => total + value, 0) / snapshot.total);
  }
  function progress(job, lane, index, value) {
    const firstProgress = job.progress[index] === 0 && Number(value) > 0;
    const fraction = Math.max(job.progress[index], Math.max(0, Math.min(100, Number(value) || 0)));
    job.progress[index] = fraction;
    if (lane.current) lane.current.progress = fraction;
    syncJob(job);
    emit(firstProgress);
  }
  async function cleanup(directory) {
    if (!directory) return;
    const relative = path.relative(workDir, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(relative) !== '.' || !path.basename(relative).startsWith('job-')) throw new Error('临时转码目录校验失败');
    const stat = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('临时转码目录已变化');
    await fs.rm(directory, { recursive: true, force: true });
  }
  async function processJob(job) {
    let directory;
    try {
      check(job);
      await fs.mkdir(workDir, { recursive: true });
      const stat = await fs.lstat(workDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('临时转码位置无效');
      directory = await fs.mkdtemp(path.join(workDir, 'job-'));
      let nextIndex = 0;
      const processItem = async (lane, index) => {
        const source = job.sources[index];
        lane.current = { id: source.id, name: source.name, index: index + 1, progress: 0, laneId: lane.id, deviceLabel: lane.label };
        lane.status = 'running'; syncJob(job);
        emit(true);
        const output = path.join(directory, `${index + 1}.${job.format === 'mp4' ? 'mp4' : 'mov'}`);
        const result = { id: source.id, name: source.name, status: 'failed', assetIds: [], laneId: lane.id, deviceLabel: lane.label, deviceType: lane.device.type };
        let imported = false;
        try {
          currentSource(job, source);
          const input = job.library.getAssetPath(source.id, 'original');
          const media = await engine.transcode(input, output, { format: job.format, bitrateMbps: job.bitrateMbps, alpha: job.alpha, device: { ...lane.device },
            signal: job.controller.signal, onProgress: event => {
              if (active === job && lane.current?.id === source.id && ['running', 'cancelling'].includes(snapshot.status))
                progress(job, lane, index, typeof event === 'number' ? event : event?.progress);
            } });
          check(job);
          const outputInfo = await fs.lstat(output);
          if (!outputInfo.isFile() || outputInfo.isSymbolicLink() || outputInfo.size === 0) throw new Error('转码未生成有效视频文件');
          check(job);
          const latest = currentSource(job, source);
          const suffix = job.format === 'mp4' ? ' · MP4' : job.alpha ? ' · DXV Normal Alpha' : ' · DXV Normal';
          const name = (latest.name || '视频').slice(0, 240 - suffix.length) + suffix;
          const metadata = { name };
          if (latest.sourceUrl) metadata.sourceUrl = latest.sourceUrl;
          if (latest.pageUrl) metadata.pageUrl = latest.pageUrl;
          // Import is an atomic library operation. Once it starts, cancellation
          // preserves this finished result and stops before the next clip.
          const report = await job.library.importPaths([output], { folderId: latest.folderId, metadata });
          result.assetIds = [...(report.assetIds || [])];
          snapshot.imported += Number(report.imported) || 0;
          snapshot.duplicates += Number(report.duplicates) || 0;
          imported = Boolean(report.imported);
          if (report.errors?.length || (!report.imported && !report.duplicates)) throw new Error(report.errors?.[0]?.message || '转码文件未能收录到素材库');
          if (report.imported && result.assetIds.length) {
            await job.library.updateAssets(result.assetIds, { tags: [...(latest.tags || [])], rating: latest.rating || 0,
              colorLabel: latest.colorLabel || null, notes: latest.notes || '' });
          }
          result.status = report.imported ? 'completed' : 'duplicate';
          if (media?.alphaDropped) result.warning = '输出格式不保留透明通道';
        } catch (error) {
          if (isAbort(error) || job.controller.signal.aborted) {
            result.status = 'cancelled';
            result.error = '视频转码已取消';
          } else {
            result.error = `${imported ? '视频已收录，但继承整理信息未完成：' : ''}${error?.message || '视频转码失败'}`;
            snapshot.failed++;
            if (getLibrary() !== job.library || job.library.root !== job.root) { job.failure ||= error; job.controller.abort(); }
          }
        } finally {
          await fs.unlink(output).catch(() => {});
          job.results[index] = result; job.progress[index] = 100; lane.current = null;
          syncJob(job);
          if (imported) { try { onChanged(job.library); } catch {} }
          emit(true);
        }
      };
      const worker = async lane => {
        try {
          while (!job.controller.signal.aborted) {
            check(job);
            const index = nextIndex++;
            if (index >= job.sources.length) break;
            await processItem(lane, index);
          }
          lane.status = job.controller.signal.aborted ? 'cancelled' : 'completed';
        } catch (error) {
          if (!isAbort(error) && !job.controller.signal.aborted) job.failure ||= error;
          job.controller.abort(); lane.status = job.failure ? 'error' : 'cancelled';
        } finally { lane.current = null; syncJob(job); emit(true); }
      };
      await Promise.all(job.lanes.map(worker));
      snapshot.status = job.failure ? 'error' : job.controller.signal.aborted ? 'cancelled' : 'completed';
      if (job.failure) snapshot.error = job.failure.message || String(job.failure);
    } catch (error) {
      snapshot.status = isAbort(error) || job.controller.signal.aborted ? 'cancelled' : 'error';
      if (snapshot.status === 'error') {
        snapshot.error = error?.message || '视频转码失败';
        snapshot.errors.push({ id: null, name: '', error: snapshot.error });
      }
    } finally {
      try { await cleanup(directory); } catch { snapshot.cleanupWarning = '部分临时转码文件未能清理'; }
      snapshot.current = null; snapshot.runningItems = [];
      if (snapshot.status === 'completed') snapshot.progress = 100;
      if (active === job) active = null;
      emit(true);
    }
  }
  function start(request) {
    if (closed) throw new Error('视频转码服务已关闭');
    if (active) throw new Error('已有视频正在转码，请先等待或取消');
    const settings = checkedOptions(request);
    const library = getLibrary();
    if (!library || typeof request.expectedRoot !== 'string' || request.expectedRoot !== library.root) throw new Error('素材库已切换，请重新选择视频');
    const byId = new Map(library.snapshot().assets.map(asset => [asset.id, asset]));
    const sources = settings.ids.map(id => {
      const asset = byId.get(id);
      if (!asset || asset.trashedAt || !VIDEO.has(asset.ext)) throw new Error('请选择有效且未移入回收站的视频');
      return { id, name: asset.name, hash: asset.hash };
    });
    const job = { ...settings, library, root: library.root, sources, controller: new AbortController(), promise: null,
      progress: sources.map(() => 0), results: sources.map(() => null),
      lanes: settings.executionPlan.lanes.map(lane => ({ ...lane, status: 'idle', current: null })) };
    snapshot = { id: crypto.randomUUID(), status: 'running', root: job.root, format: job.format, bitrateMbps: job.bitrateMbps, alpha: job.alpha,
      total: sources.length, completed: 0, failed: 0, imported: 0, duplicates: 0, progress: 0, current: null, runningItems: [],
      lanes: job.lanes.map(lane => ({ ...lane, device: { ...lane.device } })), executionMode: job.executionPlan.mode,
      executionNotice: job.executionPlan.notice, results: [], errors: [] };
    active = job;
    emit(true);
    job.promise = Promise.resolve().then(() => processJob(job));
    return state();
  }
  function cancel(id) {
    if (!active || (id !== undefined && id !== snapshot.id)) return state();
    active.controller.abort();
    snapshot.status = 'cancelling'; emit(true);
    return state();
  }
  async function shutdown() {
    closed = true;
    const job = active;
    if (job) { job.controller.abort(); await job.promise; }
  }
  return Object.freeze({ start, state, cancel, busy: () => Boolean(active), shutdown });
}

module.exports = { createVideoTranscodeService, checkedOptions, checkedExecutionPlan };
