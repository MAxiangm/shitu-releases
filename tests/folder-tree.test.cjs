'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const FolderTree = require('../src/folder-tree.js');

test('the shared folder helper loads as both CommonJS and a browser script without changing input', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/folder-tree.js'), 'utf8'), context);
  assert.equal(typeof context.ShituFolders.flatten, 'function');
  const folders = [
    { id: 'grand', name: '镜头', parentId: 'child' },
    { id: 'other', name: '其他' },
    { id: 'root', name: '项目', parentId: null },
    { id: 'child', name: '视频', parentId: 'root' },
    { id: 'child2', name: '图片', parentId: 'root' }
  ];
  const unchanged = structuredClone(folders), flat = FolderTree.flatten(folders);
  assert.deepEqual(flat.map(folder => [folder.id, folder.depth, folder.path]), [
    ['other', 0, '其他'], ['root', 0, '项目'], ['child', 1, '项目 / 视频'],
    ['grand', 2, '项目 / 视频 / 镜头'], ['child2', 1, '项目 / 图片']
  ]);
  assert.equal(FolderTree.parentId(folders[1]), null);
  assert.equal(flat[0].parentId, null);
  assert.equal(FolderTree.path(folders, 'grand'), '项目 / 视频 / 镜头');
  assert.equal(FolderTree.path(folders, 'missing'), '');
  assert.equal(FolderTree.path(folders, null), '');
  assert.deepEqual(FolderTree.descendantIds(folders, 'child'), new Set(['child', 'grand']));
  assert.deepEqual(FolderTree.descendantIds(folders, 'missing'), new Set());
  assert.deepEqual(folders, unchanged);
  assert.equal(JSON.stringify(context.ShituFolders.flatten(folders)), JSON.stringify(flat));
});

test('folder trees reject invalid parents, cycles, duplicate IDs and sibling names while allowing separate branches', () => {
  const valid = [{ id: 'r', name: '项目' }, { id: 'r2', name: '其他' },
    { id: 'a', name: '素材', parentId: 'r' }, { id: 'b', name: '素材', parentId: 'r2' }];
  assert.equal(FolderTree.validate(valid), true);
  for (const [folders, expected] of [
    [[{ id: 'r', name: '项目', parentId: 'r' }], /自己/],
    [[{ id: 'r', name: '项目', parentId: 'missing' }], /父级不存在/],
    [[{ id: 'r', name: '项目', parentId: 12 }], /父级无效/],
    [[{ id: 'a', name: '甲', parentId: 'b' }, { id: 'b', name: '乙', parentId: 'a' }], /循环/],
    [[{ id: 'r', name: '项目' }, { id: 'r', name: '其他' }], /索引无效/],
    [[{ id: 'r', name: '项目' }, { id: 'r2', name: '项目', parentId: null }], /同级/],
    [[...valid, { id: 'c', name: '素材', parentId: 'r' }], /同级/]
  ]) assert.throws(() => FolderTree.validate(folders), expected);
  assert.throws(() => FolderTree.flatten([{ id: 'a', name: '甲', parentId: 'b' }, { id: 'b', name: '乙', parentId: 'a' }]), /循环/);
});

test('folder traversal has an explicit depth limit and handles hostile IDs without prototype lookups', () => {
  const chain = Array.from({ length: FolderTree.MAX_DEPTH }, (_, index) => ({
    id: `f${index}`, name: `第${index + 1}层`, parentId: index ? `f${index - 1}` : null
  }));
  assert.equal(FolderTree.validate(chain), true);
  assert.equal(FolderTree.flatten(chain).at(-1).depth, 31);
  assert.throws(() => FolderTree.validate([...chain, { id: 'extra', name: '太深', parentId: 'f31' }]), /32 层/);
  const special = [{ id: '__proto__', name: '根' }, { id: 'constructor', name: '子', parentId: '__proto__' }, { id: '', name: '旧ID', parentId: 'constructor' }];
  assert.deepEqual(FolderTree.descendantIds(special, '__proto__'), new Set(['__proto__', 'constructor', '']));
  assert.equal(FolderTree.path(special, 'constructor'), '根 / 子');
  assert.equal(FolderTree.path(special, ''), '根 / 子 / 旧ID');
});
