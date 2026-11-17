(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituHistoryUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function keyAction(event, { editing = false, blocked = false } = {}) {
    if (editing || blocked || event.repeat || event.altKey || !(event.ctrlKey || event.metaKey)) return null;
    const key = String(event.key || '').toLowerCase();
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    return key === 'y' && !event.shiftKey ? 'redo' : null;
  }
  function command(snapshot, direction, expectedId) {
    if (!snapshot || snapshot.busy || !['undo', 'redo'].includes(direction)) return null;
    const id = snapshot[`${direction}Id`];
    if (!snapshot[direction === 'undo' ? 'canUndo' : 'canRedo'] || typeof id !== 'string' || !id) return null;
    if (expectedId !== undefined && expectedId !== id) return null;
    return { id, label: String(snapshot[`${direction}Label`] || (direction === 'undo' ? '上一步操作' : '下一步操作')) };
  }
  return { keyAction, command };
});
