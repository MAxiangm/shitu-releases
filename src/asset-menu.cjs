'use strict';
const FolderTree = require('./folder-tree.js');

function assetMenuTemplate(assets, folders, choose) {
  const one = assets.length === 1;
  const first = assets[0];
  const allTrashed = assets.every(asset => Boolean(asset.trashedAt));
  const anyTrashed = assets.some(asset => Boolean(asset.trashedAt));
  const allFavorite = assets.every(asset => (asset.rating || 0) >= 4);
  const item = (id, label, enabled = true) => ({ id, label, enabled, click: () => choose(id) });
  return [
    item('preview', '预览', one),
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
        { type: 'separator' },
        { id: 'plugin-center', label: '打开插件中心…', click: () => choose('plugin') }
      ]
    },
    { type: 'separator' },
    item('rename', '重命名', one && !anyTrashed),
    item('tags', one ? '编辑标签' : '批量添加标签', !anyTrashed),
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
