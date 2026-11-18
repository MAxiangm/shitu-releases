(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituFolderIcons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const BUILTINS = Object.freeze(['folder', 'image', 'video', 'music', 'camera', 'document', 'font', 'code', 'archive', 'model', 'brush', 'palette', 'layers', 'project', 'star', 'heart']);
  const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'webp', 'gif', 'avif']);
  const MAX_SIDE = 8192;
  function normalizeIcon(value) {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件夹图标无效');
    const keys = Object.keys(value);
    if (value.type === 'builtin' && keys.length === 2 && keys.includes('type') && keys.includes('name') && BUILTINS.includes(value.name)) return { type: 'builtin', name: value.name };
    if (value.type === 'image' && keys.length === 7 && keys.every(key => ['type', 'hash', 'ext', 'width', 'height', 'animated', 'size'].includes(key)) &&
        typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) && IMAGE_EXTENSIONS.includes(value.ext) &&
        [value.width, value.height].every(size => Number.isSafeInteger(size) && size >= 1 && size <= MAX_SIDE) &&
        Number.isSafeInteger(value.size) && value.size >= 1 && value.size <= 25 * 1024 * 1024 && typeof value.animated === 'boolean') {
      return { type: 'image', hash: value.hash, ext: value.ext, width: value.width, height: value.height, animated: value.animated, size: value.size };
    }
    throw new Error('文件夹图标无效');
  }
  function normalizeColor(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value)) return value.toLowerCase();
    if (typeof value === 'string' && /^#[a-f0-9]{3}$/i.test(value)) return '#' + [...value.slice(1).toLowerCase()].map(character => character + character).join('');
    throw new Error('图标颜色无效，请输入有效的十六进制颜色');
  }
  function iconUrl(folder) {
    if (!folder || typeof folder.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(folder.id)) return null;
    const icon = normalizeIcon(folder.icon);
    return icon?.type === 'image' ? `shitu://folder-icon/${folder.id}?v=${icon.hash}` : null;
  }
  return Object.freeze({ BUILTINS, IMAGE_EXTENSIONS, MAX_SIDE, normalizeIcon, normalizeColor, iconUrl });
});
