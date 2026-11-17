(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituFolders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_DEPTH = 32;
  function parentId(folder) { return folder?.parentId === undefined ? null : folder.parentId; }

  function validate(folders) {
    if (!Array.isArray(folders)) throw new Error('文件夹索引无效');
    const byId = new Map(), siblings = new Map();
    for (const folder of folders) {
      if (!folder || typeof folder.id !== 'string' || byId.has(folder.id) ||
          typeof folder.name !== 'string' || !folder.name.trim()) throw new Error('文件夹索引无效');
      const parent = parentId(folder);
      if (parent !== null && typeof parent !== 'string') throw new Error('文件夹父级无效');
      byId.set(folder.id, folder);
      if (!siblings.has(parent)) siblings.set(parent, new Set());
      if (siblings.get(parent).has(folder.name)) throw new Error('同级文件夹中已存在此名称');
      siblings.get(parent).add(folder.name);
    }
    for (const folder of folders) {
      const parent = parentId(folder);
      if (parent === folder.id) throw new Error('文件夹不能作为自己的父级');
      if (parent !== null && !byId.has(parent)) throw new Error('文件夹父级不存在');
    }
    const depths = new Map();
    for (const folder of folders) {
      if (depths.has(folder.id)) continue;
      const chain = [], visiting = new Set();
      let current = folder.id;
      while (current !== null && !depths.has(current)) {
        if (visiting.has(current)) throw new Error('文件夹层级存在循环');
        visiting.add(current); chain.push(current);
        if (chain.length > MAX_DEPTH) throw new Error(`文件夹最多支持 ${MAX_DEPTH} 层`);
        current = parentId(byId.get(current));
      }
      let depth = current === null ? 0 : depths.get(current);
      while (chain.length) {
        const id = chain.pop(); depth++;
        if (depth > MAX_DEPTH) throw new Error(`文件夹最多支持 ${MAX_DEPTH} 层`);
        depths.set(id, depth);
      }
    }
    return true;
  }

  function tree(folders) {
    validate(folders);
    const byId = new Map(), children = new Map();
    for (const folder of folders) {
      byId.set(folder.id, folder);
      const parent = parentId(folder);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(folder);
    }
    return { byId, children };
  }

  function flatten(folders) {
    const { children } = tree(folders), result = [];
    const stack = (children.get(null) || []).slice().reverse().map(folder => ({ folder, depth: 0, ancestors: [] }));
    while (stack.length) {
      const { folder, depth, ancestors } = stack.pop(), names = ancestors.concat(folder.name);
      result.push({ ...folder, parentId: parentId(folder), depth, path: names.join(' / ') });
      const nested = children.get(folder.id) || [];
      for (let index = nested.length - 1; index >= 0; index--) stack.push({ folder: nested[index], depth: depth + 1, ancestors: names });
    }
    return result;
  }

  function path(folders, id) {
    if (id === null || id === undefined) return '';
    const { byId } = tree(folders), names = [];
    let current = byId.get(id);
    while (current) { names.push(current.name); current = byId.get(parentId(current)); }
    return names.reverse().join(' / ');
  }

  function descendantIds(folders, id) {
    const { byId, children } = tree(folders), result = new Set();
    if (!byId.has(id)) return result;
    const stack = [id];
    while (stack.length) {
      const current = stack.pop(); result.add(current);
      for (const folder of children.get(current) || []) stack.push(folder.id);
    }
    return result;
  }

  return Object.freeze({ MAX_DEPTH, parentId, validate, flatten, path, descendantIds });
});
