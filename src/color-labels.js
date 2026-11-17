(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituColorLabels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const palette = Object.freeze([
    { id: 'red', name: '红色', color: '#e06b70' },
    { id: 'orange', name: '橙色', color: '#e9a25d' },
    { id: 'yellow', name: '黄色', color: '#d5c05b' },
    { id: 'green', name: '绿色', color: '#75b483' },
    { id: 'cyan', name: '青色', color: '#64b6ba' },
    { id: 'blue', name: '蓝色', color: '#789fe8' },
    { id: 'purple', name: '紫色', color: '#ae8bdc' },
    { id: 'pink', name: '粉色', color: '#d886b0' }
  ].map(item => Object.freeze(item)));
  const byId = new Map(palette.map(item => [item.id, item]));
  function normalize(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      if (byId.has(value)) return value;
      if (value.length === 7 && /^#[a-f0-9]{6}$/i.test(value)) return value.toLowerCase();
      if (value.length === 4 && /^#[a-f0-9]{3}$/i.test(value)) return '#' + [...value.slice(1).toLowerCase()].map(character => character + character).join('');
    }
    throw new Error('颜色标记无效，请选择颜色或输入有效的十六进制颜色');
  }
  function get(value) {
    const id = normalize(value);
    if (id === null) return null;
    return byId.get(id) || Object.freeze({ id, name: '自定义 ' + id.toUpperCase(), color: id, custom: true });
  }
  function name(value) { return get(value)?.name || '无颜色'; }
  return Object.freeze({ palette, normalize, get, name });
});
