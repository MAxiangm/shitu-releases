'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const MAX_STEPS = 50;
const MAX_BYTES = 16 * 1024 * 1024;
const cell = (object, key) => Object.hasOwn(object, key) ? { present: true, value: structuredClone(object[key]) } : { present: false };
function sameField(left, right, key) {
  // Optional legacy fields have the same meaning as explicit null values.
  if (key === 'colorLabel' || key === 'parentId') return isDeepStrictEqual(left[key] ?? null, right[key] ?? null);
  return isDeepStrictEqual(cell(left, key), cell(right, key));
}

class MetadataHistory {
  constructor({ maxSteps = MAX_STEPS, maxBytes = MAX_BYTES } = {}) {
    this.maxSteps = maxSteps; this.maxBytes = maxBytes;
    this.undoStack = []; this.redoStack = []; this.warning = null;
  }
  state() {
    const undo = this.undoStack.at(-1), redo = this.redoStack.at(-1);
    return { canUndo: Boolean(undo), canRedo: Boolean(redo), undoLabel: undo?.label || null, redoLabel: redo?.label || null,
      undoId: undo?.id || null, redoId: redo?.id || null, undoCount: this.undoStack.length, redoCount: this.redoStack.length,
      warning: this.warning };
  }
  prepare(before, after, collection, ids, keys, label) {
    const oldById = new Map(before[collection].map(value => [value.id, value])), patches = [];
    for (const value of after[collection]) {
      if (!ids.has(value.id)) continue;
      const old = oldById.get(value.id), fields = {};
      if (!old) throw new Error('无法记录不存在对象的修改');
      for (const key of keys) if (!sameField(old, value, key)) fields[key] = { before: cell(old, key), after: cell(value, key) };
      if (!Object.keys(fields).length) continue;
      const identityKeys = collection === 'assets' ? ['createdAt', 'hash', 'filename', 'ext', 'trashedAt'] : ['createdAt'];
      const identity = Object.fromEntries(identityKeys.map(key => [key, cell(old, key)]));
      patches.push({ collection, id: value.id, identity, fields });
    }
    if (!patches.length) return null;
    const entry = { id: crypto.randomUUID(), label, patches };
    entry.bytes = Buffer.byteLength(JSON.stringify(entry));
    if (entry.bytes > this.maxBytes) return { oversized: true };
    return entry;
  }
  record(entry) {
    if (!entry) return;
    this.redoStack = []; this.warning = null;
    if (entry.oversized) { this.warning = '本次修改内容过多，未保存撤销记录。'; return; }
    this.undoStack.push(entry);
    let bytes = this.undoStack.reduce((total, step) => total + step.bytes, 0);
    while (this.undoStack.length > this.maxSteps || bytes > this.maxBytes) bytes -= this.undoStack.shift().bytes;
  }
  peek(direction, expectedId) {
    const entry = (direction === 'undo' ? this.undoStack : this.redoStack).at(-1);
    if (!entry) throw new Error(direction === 'undo' ? '没有可撤销的操作' : '没有可重做的操作');
    if (expectedId !== undefined && (typeof expectedId !== 'string' || expectedId !== entry.id)) throw new Error('操作历史已变化，请刷新后重试');
    return entry;
  }
  apply(data, entry, direction) {
    const expected = direction === 'undo' ? 'after' : 'before', target = direction === 'undo' ? 'before' : 'after';
    const draft = structuredClone(data);
    for (const patch of entry.patches) {
      const value = draft[patch.collection].find(value => value.id === patch.id);
      if (!value || Object.entries(patch.identity).some(([key, identity]) => !isDeepStrictEqual(cell(value, key), identity)))
        throw new Error('操作发生冲突：相关素材或文件夹已删除或变化');
      for (const [key, versions] of Object.entries(patch.fields)) {
        if (!isDeepStrictEqual(cell(value, key), versions[expected])) throw new Error('操作发生冲突：相关内容已被修改');
        if (versions[target].present) value[key] = structuredClone(versions[target].value);
        else delete value[key];
      }
      value.updatedAt = new Date().toISOString();
    }
    return draft;
  }
  commit(direction, entry) {
    const source = direction === 'undo' ? this.undoStack : this.redoStack, target = direction === 'undo' ? this.redoStack : this.undoStack;
    if (source.at(-1) !== entry) throw new Error('操作历史已变化');
    source.pop(); target.push(entry); this.warning = null;
  }
}

module.exports = { MetadataHistory, sameField, MAX_STEPS, MAX_BYTES };
