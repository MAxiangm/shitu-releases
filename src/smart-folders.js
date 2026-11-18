(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./color-labels.js') : root.ShituColorLabels);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituSmartFolders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ColorLabels) {
  'use strict';
  const NAME_LIMIT = 100;
  const MEDIA_TYPES = Object.freeze(['all', 'image', 'video', 'audio', 'font', 'model', 'project']);
  const DEFAULT_RULE = Object.freeze({ mediaType: 'all', colorLabel: null, recentDays: 0, search: '', favorite: false });
  const fields = new Set(Object.keys(DEFAULT_RULE));
  const names = Object.freeze({ all: '所有素材', image: '图片', video: '视频', audio: '音乐', font: '字体', model: '3D 模型', project: 'AE 工程' });
  const groups = {
    image: new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg', 'avif']),
    video: new Set(['mp4', 'm4v', 'mov', 'qt', 'webm', 'ogv', 'ogg', 'mkv', 'avi', 'wmv', 'asf', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'mts', 'm2ts', 'ts', 'm2t', 'vob', 'flv', 'f4v', 'mxf', '3gp', '3g2', 'divx', 'dxv', 'rm', 'rmvb', 'dv']),
    audio: new Set(['mp3', 'mp2', 'wav', 'wave', 'flac', 'm4a', 'm4b', 'aac', 'oga', 'opus', 'aif', 'aiff', 'aifc', 'ape', 'wma', 'alac', 'amr', 'ac3', 'eac3', 'dts', 'mka', 'au', 'snd', 'wv', 'tta', 'dsf', 'dff', 'caf', 'w64']),
    font: new Set(['ttf', 'otf', 'woff', 'woff2', 'ttc', 'otc']),
    model: new Set(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'blend', 'c4d', 'max']),
    project: new Set(['aep', 'aepx'])
  };
  function validateName(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('请输入智能文件夹名称');
    const name = value.trim();
    if (name.length > NAME_LIMIT || /[\x00-\x1f\x7f]/.test(name)) throw new Error(`智能文件夹名称最多 ${NAME_LIMIT} 个字符，且不能包含控制字符`);
    return name;
  }
  function validateRule(value) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]' || Array.isArray(value)) throw new Error('智能文件夹筛选条件无效');
    if (Object.keys(value).some(key => !fields.has(key))) throw new Error('智能文件夹包含不支持的筛选条件');
    const rule = { ...DEFAULT_RULE, ...value };
    if (!MEDIA_TYPES.includes(rule.mediaType)) throw new Error('请选择有效的素材类型');
    if (rule.colorLabel !== null && typeof rule.colorLabel !== 'string') throw new Error('请选择有效的颜色标记');
    rule.colorLabel = ColorLabels.normalize(rule.colorLabel);
    if (!Number.isInteger(rule.recentDays) || rule.recentDays < 0 || rule.recentDays > 3650) throw new Error('最近导入天数应为 1 至 3650 的整数，0 表示不限');
    if (typeof rule.search !== 'string' || rule.search.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rule.search)) throw new Error('关键词最多 500 个字符，且不能包含控制字符');
    rule.search = rule.search.trim().replace(/\s+/g, ' ');
    if (typeof rule.favorite !== 'boolean') throw new Error('收藏筛选条件无效');
    return rule;
  }
  function mediaType(asset) {
    if (MEDIA_TYPES.includes(asset?.mediaType) && asset.mediaType !== 'all') return asset.mediaType;
    const ext = String(asset?.ext || '').replace(/^\./, '').toLowerCase();
    for (const [type, extensions] of Object.entries(groups)) if (extensions.has(ext)) return type;
    return null;
  }
  function compile(value, now = Date.now()) {
    const rule = validateRule(value);
    const instant = now instanceof Date ? now.getTime() : now;
    if (typeof instant !== 'number' || !Number.isFinite(instant)) throw new Error('筛选时间无效');
    const cutoff = instant - rule.recentDays * 86400000;
    const terms = rule.search.toLocaleLowerCase().split(' ').filter(Boolean);
    return asset => {
      if (!asset || typeof asset !== 'object' || asset.trashedAt) return false;
      if (rule.mediaType !== 'all' && mediaType(asset) !== rule.mediaType) return false;
      if (rule.colorLabel !== null) {
        try { if (ColorLabels.normalize(asset.colorLabel) !== rule.colorLabel) return false; }
        catch { return false; }
      }
      if (rule.favorite && !(Number.isFinite(asset.rating) && asset.rating >= 4)) return false;
      if (rule.recentDays) {
        const imported = typeof asset.createdAt === 'string' ? Date.parse(asset.createdAt) : NaN;
        if (!Number.isFinite(imported) || imported < cutoff || imported > instant) return false;
      }
      if (terms.length) {
        const haystack = [asset.name, asset.font?.family, asset.font?.fullName, asset.font?.style, asset.audio?.title, asset.audio?.artist, asset.audio?.album,
          ...(Array.isArray(asset.tags) ? asset.tags : []), asset.notes, asset.sourceUrl, asset.pageUrl]
          .filter(item => typeof item === 'string').join(' ').toLocaleLowerCase();
        if (!terms.every(term => haystack.includes(term))) return false;
      }
      return true;
    };
  }
  function matches(asset, rule, now = Date.now()) { return compile(rule, now)(asset); }
  function describe(value) {
    const rule = validateRule(value), parts = [names[rule.mediaType]];
    if (rule.colorLabel) parts.push(`${ColorLabels.name(rule.colorLabel)}标记`);
    if (rule.recentDays) parts.push(`最近 ${rule.recentDays} 天导入`);
    if (rule.favorite) parts.push('已收藏');
    if (rule.search) parts.push(`关键词：${rule.search}`);
    return parts.join(' · ');
  }
  return Object.freeze({ NAME_LIMIT, MEDIA_TYPES, DEFAULT_RULE, validateName, validateRule, mediaType, compile, matches, describe });
});
