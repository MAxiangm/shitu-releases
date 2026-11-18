(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./folder-tree.js') : root.ShituFolders);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituFolderTreeDrag = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (folderTree) {
  'use strict';
  const parentId = folder => folder?.parentId ?? null;
  function fingerprint(folders) {
    return JSON.stringify(folders.map(folder => [folder.id, parentId(folder), folder.name, folder.sortOrder ?? null]));
  }
  function descendants(folders, id) {
    const result = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const parent = queue.pop();
      for (const folder of folders) if (parentId(folder) === parent && !result.has(folder.id)) {
        result.add(folder.id); queue.push(folder.id);
      }
    }
    return result;
  }
  function siblings(folders, parent) {
    return folderTree.children(folders, parent);
  }
  function plan(folders, sourceId, targetId, mode = 'inside') {
    const index = new Map(folders.map(folder => [folder.id, folder]));
    const source = index.get(sourceId), target = targetId == null ? null : index.get(targetId);
    const invalid = reason => ({ valid: false, reason, mode, targetId });
    if (!source || !['inside', 'before', 'after', 'root'].includes(mode) || (mode !== 'root' && !target)) return invalid('文件夹已变化');
    if (sourceId === targetId) return invalid('不能拖到自身');
    const parent = mode === 'root' ? null : mode === 'inside' ? targetId : parentId(target);
    const nested = descendants(folders, sourceId);
    if (nested.has(parent)) return invalid('不能移入自己的子文件夹');
    if (parent != null && !index.has(parent)) return invalid('目标文件夹已不存在');
    if (folders.some(folder => folder.id !== sourceId && parentId(folder) === parent && folder.name === source.name)) {
      return invalid('目标位置已有同名文件夹');
    }
    let depth = 0, cursor = parent;
    const visited = new Set();
    while (cursor != null) {
      if (visited.has(cursor) || !index.has(cursor)) return invalid('文件夹层级无效');
      visited.add(cursor); depth++; cursor = parentId(index.get(cursor));
    }
    let height = 1;
    for (const id of nested) {
      let count = 1, ancestor = id, chain = new Set();
      while (ancestor !== sourceId) {
        if (chain.has(ancestor) || !index.has(ancestor)) return invalid('文件夹层级无效');
        chain.add(ancestor); ancestor = parentId(index.get(ancestor)); count++;
      }
      height = Math.max(height, count);
    }
    if (depth + height > 32) return invalid('文件夹最多支持 32 层');
    const placement = mode === 'before' ? { beforeId: targetId } : mode === 'after' ? { afterId: targetId } : {};
    if (parentId(source) === parent) {
      if (mode === 'inside') return invalid('已位于此文件夹');
      const ordered = siblings(folders, parent), currentIndex = ordered.findIndex(folder => folder.id === sourceId);
      if (mode === 'root') {
        if (currentIndex === ordered.length - 1) return invalid('已位于最外层末尾');
        placement.afterId = ordered.at(-1).id;
      }
      const remaining = ordered.filter(folder => folder.id !== sourceId);
      const nextIndex = mode === 'root' ? remaining.length : remaining.findIndex(folder => folder.id === targetId) + (mode === 'after' ? 1 : 0);
      if (currentIndex === nextIndex) return invalid('位置未改变');
    }
    const name = mode === 'root' ? '最外层' : mode === 'inside' ? `「${target.name}」内` : `「${target.name}」${mode === 'before' ? '上方' : '下方'}`;
    return { valid: true, sourceId, targetId, mode, parentId: parent, placement, name };
  }
  function create({ prepare, current = () => true, targetAt = () => null, start = () => {}, move = () => {},
    target = () => {}, finish = () => {}, drop = () => {}, error = () => {}, threshold = 6 }) {
    let gesture = null;
    function end(reason, destination) {
      const previous = gesture;
      if (!previous) return;
      gesture = null;
      if (!previous.active) return;
      target(null, previous);
      finish(reason, previous);
      if (reason === 'drop') drop(previous.payload, destination);
    }
    function begin(event, sourceId) {
      if (event.button !== 0 || event.isPrimary === false || event.pointerType === 'touch' || event.ctrlKey || event.metaKey || event.altKey) return false;
      end('cancel');
      gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, sourceId, active: false, payload: null };
      return true;
    }
    function update(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return false;
      if (!(event.buttons & 1)) { end('cancel'); return false; }
      try {
        if (!gesture.active) {
          if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < threshold) return false;
          const payload = prepare(gesture.sourceId);
          if (!payload) { end('cancel'); return false; }
          gesture.payload = payload; gesture.active = true;
          start(gesture, event);
        }
        if (!current(gesture.payload)) { end('cancel'); return false; }
        event.preventDefault?.(); move(event, gesture);
        target(targetAt(event, gesture.payload), gesture);
        return true;
      } catch (cause) { end('cancel'); error(cause); return false; }
    }
    function release(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return false;
      if (!gesture.active) { end('cancel'); return false; }
      try {
        event.preventDefault?.();
        const destination = current(gesture.payload) ? targetAt(event, gesture.payload) : null;
        end(destination?.valid ? 'drop' : 'cancel', destination);
        return true;
      } catch (cause) { end('cancel'); error(cause); return false; }
    }
    return Object.freeze({ begin, move: update, end: release, cancel: () => end('cancel'),
      get active() { return Boolean(gesture?.active); }, get pending() { return Boolean(gesture); } });
  }
  return Object.freeze({ create, plan, descendants, fingerprint });
});
