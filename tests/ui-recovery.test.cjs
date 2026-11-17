'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUiRecovery } = require('../src/ui-recovery.cjs');

function fixture() {
  const app = new EventEmitter(), window = new EventEmitter(), contents = new EventEmitter();
  let time = 0, id = 0, allowed = true, reloads = 0, paints = 0;
  const tasks = new Map(), logs = [], exhausted = [];
  window.webContents = contents; window.isDestroyed = contents.isDestroyed = () => false;
  contents.reload = () => { reloads++; }; contents.invalidate = () => { paints++; };
  const recovery = createUiRecovery({ app, window, canRecover: () => allowed,
    now: () => time, setTimeoutImpl: (callback, delay) => { const key = ++id; tasks.set(key, { callback, at: time + delay }); return key; },
    clearTimeoutImpl: key => tasks.delete(key), onDiagnostic: entry => logs.push(entry), onExhausted: detail => exhausted.push(detail) });
  function tick(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; tasks.delete(next[0]); next[1].callback();
    }
    time = end;
  }
  const crash = (reason = 'crashed') => contents.emit('render-process-gone', {}, { reason, exitCode: 9 });
  return { app, window, contents, recovery, logs, exhausted, tick, crash, tasks,
    setAllowed: value => { allowed = value; }, get reloads() { return reloads; }, get paints() { return paints; } };
}

test('renderer crashes reload only the renderer and normal exits are ignored', () => {
  const f = fixture(); f.crash('clean-exit'); f.tick(0); assert.equal(f.reloads, 0);
  f.crash(); f.tick(0); assert.equal(f.reloads, 1);
  f.contents.emit('did-finish-load'); assert.equal(f.paints, 1);
  assert.ok(f.logs.some(entry => entry.event === 'recovered'));
  f.recovery.dispose();
});

test('an unresponsive page gets ten seconds to recover before being reloaded', () => {
  const f = fixture(); f.window.emit('unresponsive'); f.tick(9999); assert.equal(f.reloads, 0);
  f.window.emit('responsive'); f.tick(1); assert.equal(f.reloads, 0);
  f.window.emit('unresponsive'); f.tick(10000); assert.equal(f.reloads, 1);
  f.recovery.dispose();
});

test('GPU recovery waits for respawn and ignores other utility processes', () => {
  const f = fixture();
  f.app.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed' }); f.tick(1000); assert.equal(f.reloads, 0);
  f.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 4 });
  f.window.emit('focus'); f.tick(999); assert.equal(f.reloads, 0); assert.equal(f.paints, 1);
  f.tick(1); assert.equal(f.reloads, 1); f.recovery.dispose();
});

test('busy native operations defer recovery until a later safe focus or retry', () => {
  const f = fixture(); f.setAllowed(false); f.crash(); f.tick(0); assert.equal(f.reloads, 0);
  f.tick(5000); assert.equal(f.reloads, 0); assert.equal(f.logs.filter(entry => entry.event === 'deferred').length, 1);
  f.setAllowed(true); f.window.emit('restore'); f.tick(0); assert.equal(f.reloads, 1);
  f.recovery.dispose();
});

test('reloads are limited to two per five minutes and exhaustion is notified once', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) { f.crash(); f.tick(0); f.contents.emit('did-finish-load'); }
  assert.equal(f.reloads, 2); assert.equal(f.exhausted.length, 1);
  f.tick(5 * 60000); f.crash(); f.tick(0); assert.equal(f.reloads, 3);
  f.recovery.dispose();
});

test('reload timeout uses the same bounded budget and disposal removes all listeners', () => {
  const f = fixture(); f.crash(); f.tick(0); f.tick(30000); assert.equal(f.reloads, 2);
  f.tick(30000); assert.equal(f.reloads, 2); assert.equal(f.exhausted.length, 1);
  f.window.emit('closed'); assert.equal(f.tasks.size, 0);
  f.crash(); f.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' }); f.window.emit('focus'); f.tick(60000);
  assert.equal(f.reloads, 2); assert.equal(f.app.listenerCount('child-process-gone'), 0); assert.equal(f.contents.listenerCount('render-process-gone'), 0);
});

test('diagnostic details reject raw text and never expose URLs or external error fields', () => {
  const f = fixture(); f.contents.emit('render-process-gone', {}, { reason: 'https://private.test/path', exitCode: 7, url: 'https://private.test/secret', error: 'raw' }); f.tick(0);
  assert.deepEqual(f.logs[0], { event: 'detected', source: 'renderer', reason: 'unknown', exitCode: 7 });
  assert.ok(f.logs.every(entry => !JSON.stringify(entry).includes('private.test'))); f.recovery.dispose();
});
