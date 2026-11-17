'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { keyAction, command } = require('../src/history-ui.js');
test('history shortcuts support undo and redo without stealing native input undo', () => {
  assert.equal(keyAction({ key: 'z', ctrlKey: true }), 'undo');
  assert.equal(keyAction({ key: 'Z', ctrlKey: true, shiftKey: true }), 'redo');
  assert.equal(keyAction({ key: 'y', ctrlKey: true }), 'redo');
  assert.equal(keyAction({ key: 'z', metaKey: true }), 'undo');
  for (const options of [{ editing: true }, { blocked: true }]) assert.equal(keyAction({ key: 'z', ctrlKey: true }, options), null);
  for (const event of [{ key: 'z' }, { key: 'z', ctrlKey: true, altKey: true }, { key: 'z', ctrlKey: true, repeat: true }, { key: 'y', ctrlKey: true, shiftKey: true }]) assert.equal(keyAction(event), null);
});
test('toast commands bind the exact top history entry and reject stale or unavailable actions', () => {
  const snapshot = { canUndo: true, undoId: 'entry-b', undoLabel: '移动素材', canRedo: true, redoId: 'entry-c', redoLabel: '设置颜色' };
  assert.deepEqual(command(snapshot, 'undo', 'entry-b'), { id: 'entry-b', label: '移动素材' });
  assert.equal(command(snapshot, 'undo', 'entry-a'), null);
  assert.deepEqual(command(snapshot, 'redo'), { id: 'entry-c', label: '设置颜色' });
  assert.equal(command({ ...snapshot, canUndo: false }, 'undo'), null);
  assert.equal(command({ ...snapshot, busy: true }, 'redo'), null);
  assert.equal(command(snapshot, 'delete'), null);
});
