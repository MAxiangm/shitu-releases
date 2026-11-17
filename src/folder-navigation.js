(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituFolderNavigation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const views = new Set(['all', 'recent', 'favorites', 'unfiled', 'trash']);
  const location = value => Object.freeze({
    view: views.has(value?.view) ? value.view : 'all',
    folder: typeof value?.folder === 'string' && value.folder ? value.folder : null,
    tag: typeof value?.tag === 'string' && value.tag ? value.tag : null
  });
  const same = (left, right) => left?.view === right?.view && left?.folder === right?.folder && left?.tag === right?.tag;
  // Libraries are Windows paths. Case and slash spelling do not create a new
  // navigation session, while opening another actual location always does.
  const rootKey = value => typeof value === 'string' && value
    ? value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : null;
  const folderIds = folders => new Set((Array.isArray(folders) ? folders : []).map(folder => folder.id));

  function parent(value, folders) {
    const current = location(value);
    if (!current.folder) return null;
    const folder = (Array.isArray(folders) ? folders : []).find(item => item.id === current.folder);
    if (!folder) return null;
    const id = typeof folder.parentId === 'string' && folder.parentId ? folder.parentId : null;
    return location({ view: 'all', folder: id, tag: null });
  }

  function create({ limit = 80 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Navigation history limit must be between 1 and 200.');
    let root = null, entries = [], cursor = -1;
    function reconcile(nextRoot, folders) {
      const key = rootKey(nextRoot);
      if (key !== root) { root = key; entries = []; cursor = -1; }
      if (!root) { entries = []; cursor = -1; return; }
      const ids = folderIds(folders), kept = [];
      let nextCursor = -1;
      for (let index = 0; index < entries.length; index++) {
        const item = entries[index];
        if (item.folder && !ids.has(item.folder)) continue;
        // Deleting a destination may make its neighbours identical. Collapse
        // those entries so Back does not appear to stay on the same page.
        if (!same(item, kept.at(-1))) kept.push(item);
        if (index <= cursor) nextCursor = kept.length - 1;
      }
      entries = kept;
      cursor = entries.length ? Math.max(0, nextCursor) : -1;
    }
    function snapshot() {
      return Object.freeze({ current: entries[cursor] || null, canBack: cursor > 0, canForward: cursor >= 0 && cursor < entries.length - 1 });
    }
    function record(nextRoot, value, folders) {
      reconcile(nextRoot, folders);
      if (!root) return snapshot();
      const ids = folderIds(folders), requested = location(value);
      const next = requested.folder && !ids.has(requested.folder)
        ? location({ view: 'all', folder: null, tag: requested.tag }) : requested;
      if (same(next, entries[cursor])) return snapshot();
      entries = entries.slice(0, cursor + 1);
      entries.push(next);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      cursor = entries.length - 1;
      return snapshot();
    }
    function state(nextRoot, folders) { reconcile(nextRoot, folders); return snapshot(); }
    function travel(direction, nextRoot, folders) {
      if (direction !== 'back' && direction !== 'forward') throw new TypeError('Navigation direction must be back or forward.');
      reconcile(nextRoot, folders);
      const index = cursor + (direction === 'back' ? -1 : 1);
      if (index < 0 || index >= entries.length) return null;
      cursor = index;
      return entries[cursor];
    }
    return Object.freeze({ record, state, travel });
  }
  return Object.freeze({ create, parent });
});
