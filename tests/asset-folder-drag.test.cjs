'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/asset-folder-drag.js');
function event(x, y = 10, options = {}) {
  return { pointerId: 3, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, preventDefault() {}, ...options };
}
function fixture(options = {}) {
  const calls = [], payload = { ids: ['asset-a', 'asset-b'], root: 'D:/library' };
  const drag = create({ prepare: id => { calls.push(['prepare', id]); return payload; },
    targetAt: () => ({ folderId: 'folder' }),
    start: () => calls.push(['start']), finish: reason => calls.push(['finish', reason]),
    drop: (data, to) => calls.push(['drop', data, to]), external: data => calls.push(['external', data]),
    error: error => calls.push(['error', error.message]), ...options });
  return { drag, calls, payload };
}
test('a click or short motion does not capture selection or start a drag', () => {
  const { drag, calls } = fixture();
  assert.equal(drag.begin(event(10), 'asset-a'), true);
  drag.move(event(13)); drag.end(event(13, 10, { buttons: 0 }));
  assert.deepEqual(calls, []); assert.equal(drag.pending, false);
  assert.equal(drag.begin(event(10, 10, { button: 2 }), 'asset-a'), false);
  assert.equal(drag.begin(event(10, 10, { pointerType: 'touch' }), 'asset-a'), false);
});
test('an internal drop preserves the captured batch and finishes before mutation', () => {
  const { drag, calls, payload } = fixture();
  drag.begin(event(10), 'asset-a'); drag.move(event(20));
  assert.equal(drag.active, true);
  drag.end(event(35, 10, { buttons: 0 }));
  assert.deepEqual(calls, [['prepare', 'asset-a'], ['start'], ['finish', 'drop'], ['drop', payload, { folderId: 'folder' }]]);
  assert.equal(drag.active, false);
});
test('Escape cancellation and invalid destinations never move assets', () => {
  for (const cancel of [true, false]) {
    const { drag, calls } = fixture({ targetAt: () => null });
    drag.begin(event(10), 'asset-a'); drag.move(event(20));
    if (cancel) drag.cancel(); else drag.end(event(30, 10, { buttons: 0 }));
    assert.equal(calls.some(call => call[0] === 'drop'), false);
    assert.deepEqual(calls.at(-1), ['finish', 'cancel']);
  }
});
test('stale library state cancels the drag before a drop or external handoff', () => {
  let current = true;
  const { drag, calls } = fixture({ current: () => current, outside: e => e.clientX < 0 });
  drag.begin(event(10), 'asset-a'); drag.move(event(20)); current = false;
  drag.move(event(-2)); drag.end(event(-2));
  assert.deepEqual(calls.at(-1), ['finish', 'cancel']);
  assert.equal(calls.some(call => ['drop', 'external'].includes(call[0])), false);
});
test('leaving the window hands off once after internal pointer cleanup', () => {
  const { drag, calls, payload } = fixture({ outside: e => e.clientX < 0 });
  drag.begin(event(10), 'asset-a'); drag.move(event(20)); drag.move(event(-2));
  drag.move(event(-10)); drag.end(event(-10, 10, { buttons: 0 }));
  assert.deepEqual(calls.slice(-2), [['finish', 'external'], ['external', payload]]);
  assert.equal(drag.pending, false);
});
test('lost buttons or another pointer cannot accidentally complete the drop', () => {
  const { drag, calls } = fixture();
  drag.begin(event(10), 'asset-a'); drag.move(event(20));
  drag.end(event(25, 10, { pointerId: 99, buttons: 0 })); assert.equal(drag.active, true);
  drag.move(event(25, 10, { buttons: 0 }));
  assert.equal(drag.active, false); assert.equal(calls.some(call => call[0] === 'drop'), false);
});
test('errors while targeting release the gesture and report the failure', () => {
  const { drag, calls } = fixture({ targetAt: () => { throw new Error('target failed'); } });
  drag.begin(event(10), 'asset-a'); drag.move(event(20));
  assert.equal(drag.pending, false);
  assert.deepEqual(calls.slice(-2), [['finish', 'cancel'], ['error', 'target failed']]);
});
