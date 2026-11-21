'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MODEL, PROJECT } = require('./media-formats.cjs');

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const MAX_HISTORY = 80;

function detailText(value) {
  return String(value || '').trim().slice(0, 640);
}

function progressOf(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function isSelectedPath(filename, inputs) {
  return inputs.some(input => {
    const relative = path.relative(input, filename);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function canRetryImport(filename, inputs) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !isSelectedPath(filename, inputs)) return false;
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (!MODEL.has(extension) && !PROJECT.has(extension)) return true;
  // A package discovered in a folder may need references from that scan root.
  // Re-run from a single file only when the original import had that same scope.
  return inputs.length === 1 && path.relative(inputs[0], filename) === '';
}

function createTaskCenter({ getLibrary, onEvent = () => {} }) {
  const records = new Map();
  const imports = new WeakMap();
  let timer;
  let order = 0;

  function state() {
    const owner = getLibrary();
    return {
      root: owner?.root ?? null,
      tasks: Array.from(records.values()).filter(record => record.owner === owner)
        .sort((a, b) => Number(TERMINAL.has(a.status)) - Number(TERMINAL.has(b.status)) || b.order - a.order)
        .map(({ id, kind, title, note, status, progress, retry, retrying, relatedId }) =>
          ({ id, kind, title, note, status, progress, retryable: Boolean(retry) && status === 'failed', retrying: Boolean(retrying), relatedId }))
    };
  }

  function emit() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      try { onEvent(state()); } catch {}
    }, 60);
    timer.unref();
  }

  function record(owner, id, changes) {
    if (!owner || owner !== getLibrary()) return;
    let entry = records.get(id);
    if (entry?.owner !== owner) {
      entry = { id, owner, status: 'queued', progress: null, order: ++order };
      records.set(id, entry);
    } else if (TERMINAL.has(entry.status) && changes.status && !TERMINAL.has(changes.status)) {
      entry.order = ++order;
    }
    Object.assign(entry, changes);
    const ended = Array.from(records.values()).filter(item => TERMINAL.has(item.status) && !item.retrying)
      .sort((a, b) => a.order - b.order);
    for (const item of ended.slice(0, Math.max(0, ended.length - MAX_HISTORY))) records.delete(item.id);
    emit();
    return entry;
  }

  function refresh() {
    for (const [id, entry] of records) if (entry.owner !== getLibrary()) records.delete(id);
    emit();
  }

  function clear() {
    for (const [id, entry] of records) if (entry.owner === getLibrary() && TERMINAL.has(entry.status) && !entry.retrying) records.delete(id);
    emit();
    return state();
  }

  async function retry(id) {
    const entry = records.get(id);
    if (!entry || entry.owner !== getLibrary() || entry.status !== 'failed' || !entry.retry || entry.retrying)
      throw new Error('这个任务目前无法重试');
    entry.retrying = true;
    emit();
    try {
      await entry.retry();
      if (records.get(id) === entry && entry.status === 'failed') records.delete(id);
      return state();
    } finally {
      entry.retrying = false;
      emit();
    }
  }

  function importStage(owner, event) {
    const id = imports.get(owner);
    if (!id || !records.has(id)) return;
    const total = Number(event.total) || 0;
    const current = Math.max(0, Math.min(total, Number(event.current) || 0));
    const filename = event.path ? path.basename(event.path) : event.name;
    const count = total && current ? ` · ${current} / ${total}` : '';
    record(owner, id, { status: 'running', progress: total && current ? current / total : null,
      note: detailText((filename || '扫描待导入文件') + count) });
  }

  async function runImport(owner, { paths, folderId, retry: retryFile }, run) {
    const id = randomUUID();
    const title = paths.length === 1 ? path.basename(paths[0]) || '导入素材' : `导入 ${paths.length} 项`;
    record(owner, id, { kind: 'import', title, note: '扫描待导入文件', status: 'running' });
    imports.set(owner, id);
    try {
      const report = await run(event => importStage(owner, event));
      const failures = new Map((report.errors || []).map(error => [error.path, error]));
      record(owner, id, { status: failures.size ? 'failed' : 'done', progress: 1,
        note: `${report.restored && !report.imported ? `已恢复 ${report.restored} 个素材` : `已导入 ${report.imported || 0} 个素材${report.restored ? ` · 已恢复 ${report.restored} 个` : ''}`}${report.duplicates ? ` · 跳过 ${report.duplicates} 个重复文件` : ''}${failures.size ? ` · ${failures.size} 项失败` : ''}` });
      for (const [filename, error] of failures) {
        const extension = typeof filename === 'string' ? path.extname(filename).slice(1).toLowerCase() : '';
        const canRetry = retryFile && canRetryImport(filename, paths);
        record(owner, randomUUID(), { kind: PROJECT.has(extension) ? 'ae-package' : 'import',
          title: typeof filename === 'string' ? path.basename(filename) : '导入素材',
          status: 'failed', note: detailText(error.message || '导入失败'),
          retry: canRetry ? () => retryFile(filename, folderId) : null });
      }
      return report;
    } catch (error) {
      record(owner, id, { status: error?.name === 'AbortError' ? 'cancelled' : 'failed', note: detailText(error?.message || '导入失败') });
      throw error;
    } finally {
      if (imports.get(owner) === id) imports.delete(owner);
    }
  }

  function transcode(snapshot, startAgain) {
    const owner = getLibrary();
    if (!snapshot?.id || !owner || owner.root !== snapshot.root) return;
    const active = snapshot.status === 'running' || snapshot.status === 'cancelling';
    const inProgress = snapshot.runningItems || [];
    const title = snapshot.total > 1 ? `批量转码 · ${snapshot.total} 个视频` : '视频转码';
    const status = active ? snapshot.status === 'cancelling' ? 'running' : inProgress.length ? 'running' : 'queued'
      : snapshot.status === 'cancelled' ? 'cancelled' : snapshot.status === 'error' || snapshot.failed ? 'failed' : 'done';
    const remaining = Math.max(0, snapshot.total - snapshot.completed - inProgress.length);
    const note = active
      ? (snapshot.status === 'cancelling' ? '正在取消' : [...inProgress.map(item => item.name), ...(remaining ? [`${remaining} 项排队`] : [])].join(' · '))
      : `已收录 ${snapshot.imported || 0} 项${snapshot.failed ? ` · ${snapshot.failed} 项失败` : ''}`;
    record(owner, `transcode:${snapshot.id}`, { kind: 'transcode', title, status, relatedId: snapshot.id,
      progress: progressOf(snapshot.progress / 100), note: detailText(note) });
    if (active) return;
    for (const failure of snapshot.errors || []) {
      const id = failure.id;
      const entryId = `transcode:${snapshot.id}:${id || 'general'}`;
      const result = snapshot.results?.find(item => item.id === id);
      const asset = id ? owner.snapshot().assets.find(item => item.id === id && !item.trashedAt) : null;
      const run = startAgain && asset && !result?.assetIds?.length ? () => {
        const current = owner.snapshot().assets.find(item => item.id === id && item.hash === asset.hash && !item.trashedAt);
        if (!current || getLibrary() !== owner) throw new Error('源视频已变化或移入回收站');
        const { format, bitrateMbps, alpha } = snapshot;
        return startAgain({ ids: [id], expectedRoot: owner.root, format, ...(format === 'mp4' ? { bitrateMbps } : { alpha }) });
      } : null;
      record(owner, entryId, { kind: 'transcode', title: failure.name || '视频转码', status: 'failed',
        note: detailText(failure.error || '转码失败'), retry: run, relatedId: snapshot.id });
    }
  }

  function projectPreview(owner, detail, prepareAgain) {
    if (!detail || !owner || getLibrary() !== owner || detail.root !== owner.root) return;
    const asset = owner.snapshot().assets.find(item => item.id === detail.id && !item.trashedAt);
    if (!asset) return;
    const statuses = { queued: 'queued', preparing: 'running', rendering: 'running', encoding: 'running', ready: 'done', error: 'failed', cancelled: 'cancelled' };
    const status = statuses[detail.status];
    if (!status) return;
    const compositionId = detail.requestedCompositionId ?? undefined;
    const id = `ae-preview:${asset.id}:${compositionId ?? 'default'}`;
    const note = ({ preparing: '正在读取合成', rendering: '正在渲染静态预览', encoding: '正在保存缩略图' })[detail.status];
    const run = status === 'failed' && prepareAgain ? () => {
      const current = owner.snapshot().assets.find(item => item.id === asset.id && item.hash === asset.hash && !item.trashedAt);
      if (!current || getLibrary() !== owner) throw new Error('工程已变化或移入回收站');
      return prepareAgain(asset.id, compositionId);
    } : null;
    record(owner, id, { kind: 'ae-preview', title: asset.name, status, progress: progressOf(detail.progress),
      note: detailText(detail.error || note), retry: run });
  }

  async function runModel(owner, assetId, run, { retry: retryModel } = {}) {
    const asset = owner?.snapshot()?.assets.find(item => item.id === assetId && !item.trashedAt);
    if (!asset || owner !== getLibrary()) return run();
    const id = `model-preview:${assetId}`;
    record(owner, id, { kind: 'model-preview', title: asset.name, status: 'running', progress: null, note: '正在生成旋转预览', retry: null });
    try {
      const result = await run();
      record(owner, id, { status: 'done', progress: 1, note: '', retry: null });
      return result;
    } catch (error) {
      const cancelled = error?.name === 'AbortError';
      record(owner, id, { status: cancelled ? 'cancelled' : 'failed', note: cancelled ? '' : detailText(error?.message || '预览生成失败'),
        retry: !cancelled && retryModel ? () => {
          const current = owner.snapshot().assets.find(item => item.id === assetId && item.hash === asset.hash && !item.trashedAt);
          if (!current || getLibrary() !== owner) throw new Error('模型已变化或移入回收站');
          return retryModel();
        } : null });
      throw error;
    }
  }

  return { state, clear, retry, refresh, importStage, runImport, transcode, projectPreview, runModel };
}

module.exports = { createTaskCenter };
