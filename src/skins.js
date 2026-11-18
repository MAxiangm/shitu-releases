(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    const controller = api.create({ document: root.document, getStorage: () => root.localStorage,
      onChange: detail => root.dispatchEvent(new CustomEvent('shitu-skin-change', { detail })) });
    root.ShituSkins = Object.freeze({ ...api, ...controller });
    controller.restore();
    root.addEventListener('storage', event => { if (event.key === api.STORAGE_KEY) controller.apply(event.newValue, { persist: false }); });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STORAGE_KEY = 'shitu-skin';
  const catalog = Object.freeze([
    { id: 'default', name: '拾图原版', description: '纯黑界面 · 流线背景', base: '#111111', surface: '#222222', accent: '#dedede', ink: '#ffffff', family: 'original' },
    { id: 'famicom', name: '红白机', description: '奶白机壳 · 酒红按键', base: '#eee8d8', surface: '#faf6e9', accent: '#981f36', ink: '#442c29', family: 'console' },
    { id: 'psp', name: 'PSP', description: '钢琴黑 · 冷光面板', base: '#111722', surface: '#222c3d', accent: '#a9d6ff', ink: '#f0f5ff', family: 'console' },
    { id: 'gameboy', name: 'Game Boy', description: '灰色机壳 · 橄榄绿屏', base: '#b9bdab', surface: '#c9d59b', accent: '#42552c', ink: '#25361d', family: 'console' },
    { id: 'switch', name: 'Switch', description: '深灰底色 · 红蓝点缀', base: '#24272b', surface: '#32363d', accent: '#00c3e3', ink: '#f4f5f7', family: 'console' },
    { id: 'win97', name: 'Win97', description: '经典灰色 · 渐变标题', base: '#527a88', surface: '#d4d0c8', accent: '#294f7e', ink: '#1b2026', family: 'desktop' },
    { id: 'win98', name: 'Win98', description: '青绿桌面 · 立体控件', base: '#008080', surface: '#c0c0c0', accent: '#000080', ink: '#111111', family: 'desktop' },
    { id: 'winxp', name: 'WinXP', description: '蓝色标题 · 奶白面板', base: '#426fa5', surface: '#ece9d8', accent: '#245edb', ink: '#1a2740', family: 'desktop' },
    { id: 'mac', name: 'Mac', description: '浅灰玻璃 · 柔和圆角', base: '#e5e9f0', surface: '#f8f9fc', accent: '#087cf0', ink: '#242832', family: 'desktop' }
  ].map(Object.freeze));
  const get = id => catalog.find(skin => skin.id === id) || catalog[0];
  const normalize = id => get(id).id;
  function create({ document, getStorage = () => null, onChange = () => {} } = {}) {
    if (!document?.documentElement) throw new Error('皮肤界面尚未就绪');
    let currentId = 'default';
    function apply(id, { persist = true } = {}) {
      const skin = get(id), changed = currentId !== skin.id || document.documentElement.dataset.skin !== skin.id;
      currentId = skin.id; document.documentElement.dataset.skin = skin.id;
      if (persist) { try { getStorage()?.setItem(STORAGE_KEY, skin.id); } catch {} }
      if (changed) onChange({ id: skin.id, name: skin.name });
      return skin;
    }
    function restore() {
      let value;
      try { value = getStorage()?.getItem(STORAGE_KEY); } catch {}
      return apply(value, { persist: false });
    }
    return Object.freeze({ apply, restore, current: () => get(currentId) });
  }
  return Object.freeze({ STORAGE_KEY, catalog, get, normalize, create });
});
