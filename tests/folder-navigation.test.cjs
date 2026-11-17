'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Navigation = require('../src/folder-navigation.js');
const root = 'D:\\素材库';
const folders = [
  { id: 'a', name: '项目' },
  { id: 'b', name: '视频', parentId: 'a' },
  { id: 'c', name: '其他' }
];
const at = (folder = null, view = 'all', tag = null) => ({ view, folder, tag });

test('navigation history loads in browsers and preserves immutable logical destinations', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/folder-navigation.js'), 'utf8'), context);
  assert.equal(typeof context.ShituFolderNavigation.create, 'function');
  const history = Navigation.create(), input = at('a');
  history.record(root, input, folders); input.folder = 'b';
  const current = history.state(root, folders).current;
  assert.deepEqual(current, at('a'));
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(history.state(root, folders)), true);
});

test('back and forward follow destinations without duplicate renders or branching into old future', () => {
  const history = Navigation.create();
  history.record(root, at(), folders);
  history.record(root, at('a'), folders);
  history.record(root, at('a'), folders);
  history.record(root, at('b'), folders);
  assert.deepEqual(history.travel('back', root, folders), at('a'));
  history.record(root, at('a'), folders);
  assert.equal(history.state(root, folders).canForward, true);
  assert.deepEqual(history.travel('forward', root, folders), at('b'));
  history.travel('back', root, folders);
  history.record(root, at('c'), folders);
  assert.equal(history.state(root, folders).canForward, false);
  assert.equal(history.travel('forward', root, folders), null);
  assert.deepEqual(history.travel('back', root, folders), at('a'));
  assert.deepEqual(history.travel('back', root, folders), at());
  assert.equal(history.travel('back', root, folders), null);
});

test('view and tag scopes have independent history while unrelated filter fields do not', () => {
  const history = Navigation.create();
  const destinations = [at(null, 'recent'), at(null, 'favorites'), at(null, 'trash'), at(null, 'unfiled'), at(null, 'all', '参考'), at('a', 'all', '参考')];
  for (const destination of destinations) history.record(root, destination, folders);
  history.record(root, { ...destinations.at(-1), search: 'ignored', sort: 'name' }, folders);
  for (const destination of destinations.slice(0, -1).reverse()) assert.deepEqual(history.travel('back', root, folders), destination);
  assert.equal(history.travel('back', root, folders), null);
});

test('deleted folders are removed from back and forward history and duplicate neighbours collapse', () => {
  const history = Navigation.create();
  for (const destination of [at(), at('a'), at(), at('b'), at('c')]) history.record(root, destination, folders);
  const remaining = folders.filter(folder => !['a', 'b'].includes(folder.id));
  assert.deepEqual(history.travel('back', root, remaining), at());
  assert.equal(history.state(root, remaining).canBack, false);
  assert.deepEqual(history.travel('forward', root, remaining), at('c'));
  history.record(root, at('missing'), remaining);
  assert.deepEqual(history.state(root, remaining).current, at());
  assert.equal(history.travel('forward', root, remaining), null);
});

test('deleting the current or all destinations cannot strand the history cursor', () => {
  const history = Navigation.create();
  history.record(root, at('a'), folders); history.record(root, at('b'), folders); history.record(root, at('c'), folders);
  history.travel('back', root, folders);
  assert.deepEqual(history.state(root, folders.filter(folder => folder.id !== 'b')).current, at('a'));
  assert.deepEqual(history.travel('forward', root, folders.filter(folder => folder.id !== 'b')), at('c'));
  assert.deepEqual(history.state(root, []).current, null);
  assert.equal(history.travel('back', root, []), null);
  history.record(root, at(), []);
  assert.deepEqual(history.state(root, []).current, at());
});

test('opening a different library or closing it clears history, but equivalent Windows path spelling does not', () => {
  const history = Navigation.create();
  history.record(root, at(), folders); history.record(root, at('a'), folders);
  assert.equal(history.state('d:/素材库/', folders).canBack, true);
  assert.deepEqual(history.state('E:\\素材库', folders), { current: null, canBack: false, canForward: false });
  history.record('E:\\素材库', at('b'), folders);
  assert.deepEqual(history.state(null, folders), { current: null, canBack: false, canForward: false });
  assert.deepEqual(history.record(null, at('a'), folders), { current: null, canBack: false, canForward: false });
});

test('history has a strict bounded size and parent navigation stops at the library root', () => {
  const history = Navigation.create({ limit: 3 });
  for (const view of ['all', 'recent', 'favorites', 'trash']) history.record(root, at(null, view), folders);
  assert.deepEqual(history.travel('back', root, folders), at(null, 'favorites'));
  assert.deepEqual(history.travel('back', root, folders), at(null, 'recent'));
  assert.equal(history.travel('back', root, folders), null);
  assert.deepEqual(Navigation.parent(at('b', 'all', '参考'), folders), at('a'));
  assert.deepEqual(Navigation.parent(at('a'), folders), at());
  assert.equal(Navigation.parent(at(), folders), null);
  assert.equal(Navigation.parent(at('missing'), folders), null);
  for (const limit of [0, -1, 201, Infinity, 1.5, '80']) assert.throws(() => Navigation.create({ limit }), /limit/);
  assert.throws(() => history.travel('sideways', root, folders), /direction/);
});
