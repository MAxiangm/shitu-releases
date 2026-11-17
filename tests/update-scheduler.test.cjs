'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateScheduler, updateIntervalMs } = require('../src/update-scheduler.cjs');

class Clock {
  time = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.time;
  timer = (callback, delay, repeat) => {
    const id = this.nextId++, value = { id, callback, due: this.time + delay, repeat, unref() {} };
    this.timers.set(id, value); return value;
  };
  setTimeout = (callback, delay) => this.timer(callback, delay, 0);
  setInterval = (callback, delay) => this.timer(callback, delay, delay);
  clear = timer => { if (timer) this.timers.delete(timer.id); };
  async advance(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.values()].filter(timer => timer.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      this.time = next.due;
      if (next.repeat) next.due += next.repeat; else this.timers.delete(next.id);
      next.callback();
      for (let index = 0; index < 8; index++) await Promise.resolve();
    }
    this.time = target;
  }
}
function scheduler(options = {}) {
  const clock = new Clock(), calls = [];
  const instance = createUpdateScheduler({ check: reason => { calls.push({ reason, time: clock.time }); },
    now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clear,
    setIntervalImpl: clock.setInterval, clearIntervalImpl: clock.clear, ...options });
  return { clock, calls, instance };
}

test('checks soon after startup and every five minutes instead of waiting six hours', async () => {
  const { clock, calls, instance } = scheduler();
  await instance.trigger('focus'); assert.deepEqual(calls, []);
  instance.start(); instance.start(); assert.equal(clock.timers.size, 3);
  await clock.advance(1999); assert.deepEqual(calls, []);
  await clock.advance(1); assert.deepEqual(calls, [{ reason: 'startup', time: 2000 }]);
  await clock.advance(298000); assert.deepEqual(calls[1], { reason: 'interval', time: 300000 });
  await clock.advance(300000); assert.deepEqual(calls[2], { reason: 'interval', time: 600000 });
  instance.dispose(); assert.equal(clock.timers.size, 0);
});

test('focus and restore share the throttle and manual checks suppress redundant automatic requests', async () => {
  const { clock, calls, instance } = scheduler(); instance.start(); await clock.advance(2000);
  await instance.trigger('focus'); await instance.trigger('restore'); assert.equal(calls.length, 1);
  await clock.advance(60000); await instance.trigger('focus'); assert.equal(calls.length, 2);
  await clock.advance(60000);
  instance.recordManualCheck();
  await instance.trigger('restore'); assert.equal(calls.length, 2);
  await clock.advance(60000); await instance.trigger('restore'); assert.equal(calls.length, 3);
  instance.dispose();
});

test('offline startup skips requests and connectivity recovery checks within the local sample interval', async () => {
  let online = false;
  const { clock, calls, instance } = scheduler({ isOnline: () => online }); instance.start();
  await clock.advance(22000); assert.equal(calls.length, 0);
  online = true; await clock.advance(8000); assert.deepEqual(calls, [{ reason: 'online', time: 30000 }]);
  await clock.advance(10000); assert.equal(calls.length, 1, 'A stable connection must not poll GitHub every ten seconds');
  online = false; await clock.advance(10000); online = true; await clock.advance(10000);
  assert.equal(calls.length, 1, 'Reconnect bursts must share the throttle');
  instance.dispose();
});

test('automatic triggers share pending work and never interrupt active update operations', async () => {
  let state = 'checking', complete;
  const clock = new Clock(), calls = [];
  const instance = createUpdateScheduler({ getState: () => ({ status: state }),
    check: reason => { calls.push(reason); return new Promise(resolve => { complete = resolve; }); },
    now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clear,
    setIntervalImpl: clock.setInterval, clearIntervalImpl: clock.clear });
  instance.start(); await clock.advance(2000); assert.equal(calls.length, 0);
  for (state of ['downloading', 'installing', 'disabled']) { await instance.trigger('focus'); assert.equal(calls.length, 0); }
  state = 'idle'; const first = instance.trigger('focus'), second = instance.trigger('restore');
  assert.equal(first, second); await Promise.resolve(); assert.deepEqual(calls, ['focus']);
  await clock.advance(300000); assert.equal(calls.length, 1, 'A slow download/check must not spawn another task');
  instance.dispose(); complete(); await first;
  await clock.advance(600000); await instance.trigger('focus'); assert.equal(calls.length, 1);
  assert.equal(clock.timers.size, 0);
});

test('disabled builds create no timers and automatic failures permit a later retry', async () => {
  const disabled = scheduler({ enabled: false }); disabled.instance.start();
  await disabled.clock.advance(600000); await disabled.instance.trigger('online');
  assert.equal(disabled.clock.timers.size, 0); assert.deepEqual(disabled.calls, []);
  const checks = [];
  const retry = scheduler({ check: reason => { checks.push(reason); throw new Error('temporary service error'); } });
  retry.instance.start(); await retry.clock.advance(2000); await retry.clock.advance(60000);
  await retry.instance.trigger('focus'); assert.deepEqual(checks, ['startup', 'focus']); retry.instance.dispose();
});

test('minute configuration retains legacy hours and limits excessive GitHub polling', () => {
  assert.equal(updateIntervalMs(), 300000);
  assert.equal(updateIntervalMs({ checkIntervalMinutes: 5 }), 300000);
  assert.equal(updateIntervalMs({ checkIntervalMinutes: 1 }), 300000);
  assert.equal(updateIntervalMs({ checkIntervalHours: 6 }), 21600000);
  assert.equal(updateIntervalMs({ checkIntervalMinutes: 8, checkIntervalHours: 6 }), 480000);
  assert.equal(updateIntervalMs({ checkIntervalMinutes: 'bad', checkIntervalHours: 2 }), 7200000);
  assert.equal(updateIntervalMs({ checkIntervalMinutes: 5000 }), 86400000);
});
