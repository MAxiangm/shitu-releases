'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assetMenuTemplate } = require('../src/asset-menu.cjs');

function menu(assets) {
  const calls = [];
  return { item: assetMenuTemplate(assets, [], action => calls.push(action)).find(item => item.id === 'video-transcode'), calls };
}
const video = (id, extra = {}) => ({ id, mediaType: 'video', ext: 'mp4', tags: [], rating: 0, folderId: null, ...extra });

test('video menu offers single and batch transcoding for active videos including DXV', () => {
  const single = menu([video('one', { ext: 'dxv' })]);
  assert.equal(single.item.label, '视频转码…'); assert.equal(single.item.enabled, true);
  single.item.click(); assert.deepEqual(single.calls, ['video-transcode']);
  const batch = menu([video('one'), video('two', { ext: 'mov' })]);
  assert.equal(batch.item.label, '批量视频转码…'); assert.equal(batch.item.enabled, true);
  batch.item.click(); assert.deepEqual(batch.calls, ['video-transcode']);
});

test('transcoding cannot start from empty, mixed-media or trashed selections', () => {
  for (const assets of [[], [video('one', { trashedAt: '2026-11-17T00:00:00Z' })],
    [video('one'), video('two', { mediaType: 'image', ext: 'png' })],
    [video('one', { mediaType: 'model', ext: 'fbx' })], [video('one', { mediaType: 'project', ext: 'aep' })]]) {
    assert.equal(menu(assets).item.enabled, false);
  }
  assert.equal(menu([video('legacy', { mediaType: undefined, ext: 'dxv' })]).item.enabled, true);
});
