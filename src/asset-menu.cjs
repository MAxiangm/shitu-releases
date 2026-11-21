'use strict';
const FolderTree = require('./folder-tree.js');
const ColorLabels = require('./color-labels.js');
const { VIDEO, FONT } = require('./media-formats.cjs');
const { isSearchableImage } = require('./similar-image-service.cjs');

function assetMenuTemplate(assets, folders, choose, transcodePresets = []) {
  const one = assets.length === 1;
  const first = assets[0];
  const allTrashed = assets.every(asset => Boolean(asset.trashedAt));
  const anyTrashed = assets.some(asset => Boolean(asset.trashedAt));
  const allFavorite = assets.every(asset => (asset.rating || 0) >= 4);
  const colorValues = assets.map(asset => ColorLabels.normalize(asset.colorLabel));
  const commonColor = colorValues.length && colorValues.every(value => value === colorValues[0]) ? colorValues[0] : null;
  const customColor = commonColor && ColorLabels.get(commonColor)?.custom ? ColorLabels.get(commonColor) : null;
  const canTranscode = assets.length > 0 && !anyTrashed && assets.every(asset =>
    asset.mediaType === undefined ? VIDEO.has(asset.ext) : asset.mediaType === 'video');
  const item = (id, label, enabled = true) => ({ id, label, enabled, click: () => choose(id) });
  return [
    item('preview', '预览', one),
    ...(one && !anyTrashed && first.mediaType === 'image' ? [
      item('image-edit', '编辑图片…'),
      item('texture-maps', '生成材质贴图 / 无缝平铺…')
    ] : []),
    ...(one && isSearchableImage(first) ? [item('similar-images', '查找相似图片…')] : []),
    item('font-compare', '对比所选字体…', assets.length >= 2 && !anyTrashed && assets.every(asset => asset.mediaType === 'font' || FONT.has(asset.ext))),
    item('open', '使用系统应用打开', one),
    item('reveal', '在资源管理器中显示', one),
    item('source', '打开来源网页', one && Boolean(first.pageUrl || first.sourceUrl)),
    { type: 'separator' },
    item('copy-image', '复制图片', one && !anyTrashed && first.mediaType === 'image'),
    item('copy-paths', one ? '复制文件路径' : '复制所选文件路径', !anyTrashed),
    {
      id: 'image-plugins', label: '插件', enabled: !anyTrashed && assets.every(asset => asset.mediaType === 'image'),
      submenu: [
        { id: 'plugin-ai-upscale', label: one ? 'AI 放大图片' : '批量 AI 放大图片', click: () => choose('plugin', { pluginId: 'ai-upscale' }) },
        { id: 'plugin-ai-cutout', label: one ? 'AI 自动抠图' : '批量 AI 自动抠图', click: () => choose('plugin', { pluginId: 'ai-cutout' }) },
        { id: 'plugin-crop', label: one ? '裁切图片' : '裁切图片（逐张设置）', enabled: one, click: () => choose('plugin', { pluginId: 'crop' }) },
        { id: 'plugin-compress', label: one ? '压缩图片' : '批量压缩图片', click: () => choose('plugin', { pluginId: 'compress' }) },
        { id: 'plugin-convert', label: one ? '转换格式' : '批量转换格式', click: () => choose('plugin', { pluginId: 'convert' }) },
        { id: 'plugin-extract-text', label: one ? '提取文字' : '批量提取文字', click: () => choose('plugin', { pluginId: 'extract-text' }) },
        { id: 'plugin-image-to-pdf', label: '图片转 PDF', click: () => choose('plugin', { pluginId: 'image-to-pdf' }) },
        { type: 'separator' },
        { id: 'plugin-center', label: '打开插件中心…', click: () => choose('plugin') }
      ]
    },
    item('video-transcode', one ? '视频转码…' : '批量视频转码…', canTranscode),
    ...(canTranscode && transcodePresets.length ? [{
      id: 'video-transcode-presets', label: '套用转码预设',
      submenu: transcodePresets.map(preset => ({
        id: `transcode-preset-${preset.id}`, label: preset.name.replaceAll('&', '&&') + '…',
        click: () => choose('video-transcode', { preset })
      }))
    }] : []),
    { type: 'separator' },
    item(one ? 'rename' : 'batch-rename', one ? '重命名' : '批量重命名…', !anyTrashed),
    item('tags', one ? '编辑标签' : '批量添加标签', !anyTrashed),
    {
      id: 'color-label', label: '标记颜色', enabled: assets.length > 0,
      submenu: [
        { id: 'color-none', label: '清除颜色标记', type: 'checkbox', checked: assets.length > 0 && colorValues.every(value => value === null), click: () => choose('color-label', { colorLabel: null }) },
        ...ColorLabels.palette.map(color => ({ id: `color-${color.id}`, label: color.name, type: 'checkbox', checked: assets.length > 0 && colorValues.every(value => value === color.id), click: () => choose('color-label', { colorLabel: color.id }) })),
        ...(customColor ? [{ id: 'color-current-custom', label: customColor.name, type: 'checkbox', checked: true, click: () => choose('color-label', { colorLabel: customColor.id }) }] : []),
        { type: 'separator' },
        item('custom-color-label', '自定义颜色…', assets.length > 0)
      ]
    },
    {
      id: 'move-folder', label: '移入文件夹', enabled: !anyTrashed,
      submenu: [
        { id: 'folder-unfiled', label: '未分类', type: 'checkbox', checked: assets.every(asset => !asset.folderId), click: () => choose('folder', { folderId: null }) },
        ...FolderTree.flatten(folders).map(folder => ({ id: `folder-${folder.id}`, label: folder.path, type: 'checkbox', checked: assets.every(asset => asset.folderId === folder.id), click: () => choose('folder', { folderId: folder.id }) }))
      ]
    },
    item(allFavorite ? 'unfavorite' : 'favorite', allFavorite ? '取消收藏（清除评分）' : '加入收藏', !anyTrashed),
    { type: 'separator' },
    item('export', one ? ['project', 'model'].includes(first.mediaType) ? '导出完整资源文件夹…' : '导出原文件…' : `导出 ${assets.length} 个素材…`),
    item(allTrashed ? 'restore' : 'trash', allTrashed ? '恢复素材' : '移入回收站'),
    ...(allTrashed ? [item('delete-permanently', one ? '永久删除…' : `永久删除 ${assets.length} 个素材…`)] : [])
  ];
}

module.exports = { assetMenuTemplate };
