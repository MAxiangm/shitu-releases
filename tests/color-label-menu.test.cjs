'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assetMenuTemplate } = require('../src/asset-menu.cjs');
const { palette } = require('../src/color-labels.js');

const asset = (colorLabel, extra = {}) => ({ id: 'asset-1', mediaType: 'image', folderId: null, tags: [], rating: 0, colorLabel, ...extra });
function menu(assets) {
  const selected = [];
  const label = assetMenuTemplate(assets, [], (action, detail) => selected.push({ action, ...detail })).find(item => item.id === 'color-label');
  return { label, selected };
}

test('native color menu exposes all preset names and clears old unlabeled assets', () => {
  const { label, selected } = menu([asset(undefined)]);
  assert.equal(label.enabled, true);
  assert.deepEqual(label.submenu.slice(1, 1 + palette.length).map(item => item.label), palette.map(color => color.name));
  assert.deepEqual(label.submenu.filter(item => item.checked).map(item => item.id), ['color-none']);
  label.submenu.find(item => item.id === 'color-red').click();
  label.submenu.find(item => item.id === 'color-none').click();
  assert.deepEqual(selected, [{ action: 'color-label', colorLabel: 'red' }, { action: 'color-label', colorLabel: null }]);
});

test('native bulk color selection marks only a shared color and not mixed assignments', () => {
  const common = menu([asset('blue'), asset('blue', { id: 'asset-2' })]);
  assert.deepEqual(common.label.submenu.filter(item => item.checked).map(item => item.id), ['color-blue']);
  const mixed = menu([asset('blue'), asset('green', { id: 'asset-2' })]);
  assert.ok(mixed.label.submenu.every(item => !item.checked));
  mixed.label.submenu.find(item => item.id === 'color-purple').click();
  assert.deepEqual(mixed.selected, [{ action: 'color-label', colorLabel: 'purple' }]);
});

test('color labels remain available for projects, models, videos and trashed assets', () => {
  for (const mediaType of ['image', 'video', 'model', 'project']) {
    const { label } = menu([asset('pink', { mediaType, trashedAt: '2026-11-17T00:00:00Z' })]);
    assert.equal(label.enabled, true);
    assert.deepEqual(label.submenu.filter(item => item.checked).map(item => item.id), ['color-pink']);
  }
});

test('custom color menu opens the picker and preserves canonical same-value hexadecimal labels', () => {
  const { label, selected } = menu([asset('#aBc'), asset('#AABBCC', { id: 'asset-2' })]);
  assert.deepEqual(label.submenu.filter(item => item.checked).map(item => item.id), ['color-current-custom']);
  const current = label.submenu.find(item => item.id === 'color-current-custom');
  assert.equal(current.label, '自定义 #AABBCC');
  current.click(); label.submenu.find(item => item.id === 'custom-color-label').click();
  assert.deepEqual(selected, [{ action: 'color-label', colorLabel: '#aabbcc' }, { action: 'custom-color-label' }]);
  const mixed = menu([asset('#abc'), asset('#abd', { id: 'asset-2' })]);
  assert.ok(mixed.label.submenu.every(item => !item.checked));
  assert.ok(mixed.label.submenu.find(item => item.id === 'custom-color-label').enabled);
});
