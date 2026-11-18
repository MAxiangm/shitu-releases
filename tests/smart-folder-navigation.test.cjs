'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Navigation = require('../src/folder-navigation.js');
test('smart folders have separate navigable locations and return to the library root', () => {
  const history = Navigation.create(), root = 'D:\\library', folders = [{ id: 'physical' }], smart = [{ id: 'smart-a' }];
  history.record(root, { view: 'all' }, folders, smart);
  history.record(root, { view: 'all', smartFolder: 'smart-a' }, folders, smart);
  history.record(root, { view: 'all', folder: 'physical' }, folders, smart);
  assert.equal(history.travel('back', root, folders, smart).smartFolder, 'smart-a');
  assert.deepEqual(Navigation.parent(history.state(root, folders, smart).current, folders), { view: 'all', folder: null, tag: null });
  assert.equal(history.travel('forward', root, folders, smart).folder, 'physical');
});
test('removed smart folders are pruned from history without affecting physical destinations', () => {
  const history = Navigation.create(), root = 'D:\\library', folders = [{ id: 'physical' }];
  history.record(root, { view: 'all' }, folders, [{ id: 'removed' }]);
  history.record(root, { view: 'all', smartFolder: 'removed' }, folders, [{ id: 'removed' }]);
  history.record(root, { folder: 'physical' }, folders, [{ id: 'removed' }]);
  assert.deepEqual(history.travel('back', root, folders, []), { view: 'all', folder: null, tag: null });
});
