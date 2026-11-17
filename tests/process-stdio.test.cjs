'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { installProcessStdioGuards } = require('../src/process-stdio.cjs');

test('standard-stream guards ignore only broken-pipe failures and report each stream once', () => {
  const stdout = new EventEmitter(), stderr = new EventEmitter(), events = [];
  const guard = installProcessStdioGuards({ stdout, stderr, onBroken: event => events.push(event) });
  stdout.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }));
  stdout.emit('error', Object.assign(new Error('again'), { code: 'EPIPE' }));
  stderr.emit('error', Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' }));
  assert.deepEqual(events, [{ stream: 'stdout', code: 'EPIPE' }, { stream: 'stderr', code: 'ERR_STREAM_DESTROYED' }]);
  assert.equal(guard.isBroken('stdout'), true);
  assert.equal(guard.isBroken('stderr'), true);
  guard.dispose();
});

test('unexpected stream errors remain fatal without another error owner', () => {
  const stdout = new EventEmitter(), error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const guard = installProcessStdioGuards({ stdout, stderr: null });
  assert.throws(() => stdout.emit('error', error), caught => caught === error);
  assert.equal(guard.isBroken('stdout'), false);
  guard.dispose();
});

test('existing error owners and repeated installation retain their semantics', () => {
  const stdout = new EventEmitter(), errors = [];
  stdout.on('error', error => errors.push(error));
  const first = installProcessStdioGuards({ stdout, stderr: null });
  const second = installProcessStdioGuards({ stdout, stderr: null });
  assert.equal(stdout.listenerCount('error'), 2);
  const error = Object.assign(new Error('disk failure'), { code: 'EIO' });
  stdout.emit('error', error);
  assert.deepEqual(errors, [error]);
  first.dispose(); assert.equal(stdout.listenerCount('error'), 2);
  second.dispose(); second.dispose(); assert.equal(stdout.listenerCount('error'), 1);
});

test('broken-pipe diagnostic callbacks cannot recursively crash logging', () => {
  const stdout = new EventEmitter();
  const guard = installProcessStdioGuards({ stdout, stderr: null, onBroken: () => { throw new Error('reporter unavailable'); } });
  assert.doesNotThrow(() => stdout.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' })));
  guard.dispose();
});

async function closedPipeChild(guarded) {
  const source = `
    const { Console } = require('node:console');
    ${guarded ? `require(${JSON.stringify(require.resolve('../src/process-stdio.cjs'))}).installProcessStdioGuards();` : ''}
    const logger = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: false });
    process.once('message', () => {
      logger.error('A diagnostic after the GUI launcher exited');
      process.stdout.write('a later standard-output write\\n');
      setTimeout(() => {
        logger.error('The application is still usable');
        process.send({ survived: true });
        setTimeout(() => process.exit(0), 30);
      }, 80);
    });
    process.send({ ready: true });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let survived = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Closed-pipe child timed out')); }, 5000);
    child.on('message', message => {
      if (message.ready) {
        child.stdout.destroy(); child.stderr.destroy();
        setTimeout(() => { if (child.connected) child.send({ write: true }); }, 50);
      }
      if (message.survived) survived = true;
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, survived }); });
  });
}

test('a real console EPIPE after its launcher closes both pipes does not terminate the guarded process', { timeout: 15000 }, async () => {
  const control = await closedPipeChild(false);
  assert.notEqual(control.code, 0, 'The unguarded control must reproduce the broken-pipe crash');
  assert.equal(control.survived, false);
  assert.deepEqual(await closedPipeChild(true), { code: 0, signal: null, survived: true });
});
