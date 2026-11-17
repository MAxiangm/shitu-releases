'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assetMenuTemplate } = require('../src/asset-menu.cjs');

function menu(assets, folders) {
  const chosen = [];
  const template = assetMenuTemplate(assets, folders, (action, detail) => chosen.push({ action, ...detail }));
  return { move: template.find(item => item.id === 'move-folder'), chosen };
}
const asset = (folderId, extra = {}) => ({ id: 'asset-1', mediaType: 'image', folderId, tags: [], rating: 0, ...extra });

test('asset folder menu preserves root folders and exact unfiled choice for existing libraries', () => {
  const { move, chosen } = menu([asset(null)], [{ id: 'root-a', name: '项目 A' }, { id: 'root-b', name: '项目 B' }]);
  assert.equal(move.enabled, true);
  assert.deepEqual(move.submenu.map(item => [item.label, item.checked]), [['未分类', true], ['项目 A', false], ['项目 B', false]]);
  move.submenu[2].click(); move.submenu[0].click();
  assert.deepEqual(chosen, [{ action: 'folder', folderId: 'root-b' }, { action: 'folder', folderId: null }]);
});

test('nested destinations show their complete path and target same-name child folders independently', () => {
  const folders = [
    { id: 'detail-a', name: '贴图', parentId: 'shots-a' },
    { id: 'project-a', name: '项目 A' },
    { id: 'shots-a', name: '镜头', parentId: 'project-a' },
    { id: 'project-b', name: '项目 B', parentId: null },
    { id: 'detail-b', name: '贴图', parentId: 'project-b' }
  ];
  const { move, chosen } = menu([asset('detail-a')], folders);
  assert.deepEqual(move.submenu.map(item => item.label), ['未分类', '项目 A', '项目 A / 镜头', '项目 A / 镜头 / 贴图', '项目 B', '项目 B / 贴图']);
  const byId = id => move.submenu.find(item => item.id === 'folder-' + id);
  assert.equal(byId('project-a').checked, false, 'Parent must not claim assets assigned to a descendant');
  assert.equal(byId('detail-a').checked, true);
  assert.equal(byId('detail-b').checked, false);
  byId('detail-b').click(); byId('project-a').click();
  assert.deepEqual(chosen, [{ action: 'folder', folderId: 'detail-b' }, { action: 'folder', folderId: 'project-a' }]);
});

test('mixed assignments do not show a false common target and trashed assets cannot use the move menu', () => {
  const folders = [{ id: 'parent', name: '参考' }, { id: 'child', name: '素材', parentId: 'parent' }];
  const mixed = menu([asset('parent'), asset('child', { id: 'asset-2' })], folders);
  assert.ok(mixed.move.submenu.every(item => !item.checked));
  const trashed = menu([asset('child', { trashedAt: '2026-11-17T00:00:00Z' })], folders);
  assert.equal(trashed.move.enabled, false);
});
