'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create, plan, descendants, fingerprint } = require('../src/folder-tree-drag.js');

const folders = [
  { id: 'a', name: '项目', sortOrder: 1 },
  { id: 'b', name: '素材', sortOrder: 0 },
  { id: 'c', name: '视频', parentId: 'a' },
  { id: 'd', name: '镜头', parentId: 'c' },
  { id: 'e', name: '图片', parentId: 'a' }
];
function event(x, options = {}) {
  return { pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
    clientX: x, clientY: 10, preventDefault() {}, ...options };
}
function fixture(options = {}) {
  const calls = [], payload = { id: 'a', root: 'D:/library' };
  const drag = create({ prepare: id => { calls.push(['prepare', id]); return payload; },
    targetAt: () => ({ valid: true, parentId: 'b' }), start: () => calls.push(['start']),
    finish: reason => calls.push(['finish', reason]), drop: (data, target) => calls.push(['drop', data, target]),
    error: error => calls.push(['error', error.message]), ...options });
  return { drag, calls, payload };
}

test('drop plans preserve the source subtree and distinguish child and sibling destinations', () => {
  const before = structuredClone(folders);
  assert.deepEqual(descendants(folders, 'a'), new Set(['a', 'c', 'e', 'd']));
  assert.equal(plan(folders, 'a', 'b', 'inside').parentId, 'b');
  assert.deepEqual(plan(folders, 'c', 'b', 'before').placement, { beforeId: 'b' });
  assert.equal(plan(folders, 'c', 'b', 'before').parentId, null);
  assert.deepEqual(plan(folders, 'd', 'e', 'after').placement, { afterId: 'e' });
  assert.equal(plan(folders, 'd', 'e', 'after').parentId, 'a');
  assert.deepEqual(folders, before);
});

test('self, descendant, same position and duplicate names are rejected before IPC', () => {
  for (const [source, target, mode] of [['a', 'a', 'inside'], ['a', 'd', 'inside'],
    ['a', 'd', 'before'], ['c', 'a', 'inside'], ['c', 'e', 'before'], ['e', 'c', 'after']]) {
    assert.equal(plan(folders, source, target, mode).valid, false, `${source} ${mode} ${target}`);
  }
  const duplicate = folders.concat({ id: 'f', name: '视频', parentId: 'b' });
  assert.match(plan(duplicate, 'c', 'b', 'inside').reason, /同名/);
  assert.equal(plan(folders, 'missing', 'a', 'inside').valid, false);
  assert.equal(plan(folders, 'a', 'missing', 'before').valid, false);
});

test('reorder uses persisted sibling order rather than backing array order', () => {
  assert.equal(plan(folders, 'a', 'b', 'before').valid, true);
  assert.equal(plan(folders, 'a', 'b', 'after').valid, false);
  assert.equal(plan(folders, 'b', 'a', 'before').valid, false);
  assert.equal(plan(folders, 'b', 'a', 'after').valid, true);
});

test('root blank target promotes a subtree or appends a root without creating a no-op save', () => {
  const promote = plan(folders, 'c', null, 'root');
  assert.equal(promote.valid, true); assert.equal(promote.parentId, null); assert.deepEqual(promote.placement, {});
  assert.deepEqual(plan(folders, 'b', null, 'root').placement, { afterId: 'a' });
  assert.equal(plan(folders, 'a', null, 'root').valid, false);
});

test('depth validation includes every descendant carried by a moved parent', () => {
  const deep = Array.from({ length: 31 }, (_, index) => ({ id: `n${index}`, name: `层${index}`, parentId: index ? `n${index - 1}` : null }));
  deep.push({ id: 'branch', name: '父级' }, { id: 'leaf', name: '子级', parentId: 'branch' });
  assert.equal(plan(deep, 'branch', 'n29', 'inside').valid, true);
  assert.match(plan(deep, 'branch', 'n30', 'inside').reason, /32/);
});

test('structure fingerprint tracks folder edits and ignores unrelated asset metadata', () => {
  const original = fingerprint(folders);
  for (const change of [{ parentId: 'b' }, { name: '新名称' }, { sortOrder: 8 }]) {
    const copy = structuredClone(folders); Object.assign(copy[0], change);
    assert.notEqual(fingerprint(copy), original);
  }
  assert.equal(fingerprint(folders.map(folder => ({ ...folder, unrelated: true }))), original);
});

test('short motion is a normal click and unsupported pointer gestures never start', () => {
  const { drag, calls } = fixture();
  drag.begin(event(10), 'a'); drag.move(event(13)); drag.end(event(13, { buttons: 0 }));
  assert.deepEqual(calls, []); assert.equal(drag.pending, false);
  for (const options of [{ button: 2 }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { pointerType: 'touch' }, { isPrimary: false }]) assert.equal(drag.begin(event(10, options), 'a'), false);
});

test('a valid gesture captures its source once and cleans up before committing', () => {
  const { drag, calls, payload } = fixture();
  drag.begin(event(10), 'a'); drag.move(event(20)); drag.move(event(25)); drag.end(event(30, { buttons: 0 }));
  assert.deepEqual(calls, [['prepare', 'a'], ['start'], ['finish', 'drop'], ['drop', payload, { valid: true, parentId: 'b' }]]);
  assert.equal(drag.active, false); assert.equal(drag.pending, false);
});

test('invalid target, explicit cancel and stale library never submit a move', () => {
  for (const action of ['invalid', 'cancel', 'stale']) {
    let current = true;
    const { drag, calls } = fixture({ current: () => current, targetAt: () => ({ valid: action !== 'invalid' }) });
    drag.begin(event(10), 'a'); drag.move(event(20));
    if (action === 'cancel') drag.cancel();
    else { if (action === 'stale') current = false; drag.end(event(30, { buttons: 0 })); }
    assert.equal(calls.some(call => call[0] === 'drop'), false);
    assert.deepEqual(calls.at(-1), ['finish', 'cancel']);
  }
});

test('lost buttons cancel, unrelated pointers cannot finish, and targeting errors clean up', () => {
  const { drag, calls } = fixture();
  drag.begin(event(10), 'a'); drag.move(event(20));
  drag.end(event(30, { pointerId: 99 })); assert.equal(drag.active, true);
  drag.move(event(25, { buttons: 0 })); assert.equal(drag.active, false);
  assert.equal(calls.some(call => call[0] === 'drop'), false);
  const broken = fixture({ targetAt: () => { throw new Error('failed'); } });
  broken.drag.begin(event(10), 'a'); broken.drag.move(event(20));
  assert.deepEqual(broken.calls.slice(-2), [['finish', 'cancel'], ['error', 'failed']]);
  assert.equal(broken.drag.pending, false);
});

test('browser script uses the shared folder tree dependency', () => {
  const context = vm.createContext({});
  for (const file of ['folder-tree.js', 'folder-tree-drag.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  assert.equal(typeof context.ShituFolderTreeDrag.create, 'function');
  assert.equal(context.ShituFolderTreeDrag.plan(folders, 'a', 'b', 'before').valid, true);
});
