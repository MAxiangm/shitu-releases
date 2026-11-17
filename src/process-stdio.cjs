'use strict';

// GUI processes can outlive the terminal or launcher that supplied these
// pipes. Node emits EPIPE on the standard stream after a later console write;
// without a listener Electron turns that harmless logging failure into a
// main-process exception dialog. Do not catch unrelated application errors.
const guardedStreams = new WeakMap();
const brokenPipe = error => error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED';

function installProcessStdioGuards({ stdout = process.stdout, stderr = process.stderr, onBroken = () => {} } = {}) {
  const subscriptions = [];
  const states = new Map();
  for (const [name, stream] of [['stdout', stdout], ['stderr', stderr]]) {
    if (!stream || typeof stream.on !== 'function' || typeof stream.removeListener !== 'function') continue;
    let record = guardedStreams.get(stream);
    if (!record) {
      record = { broken: false, code: null, subscribers: new Set(), listener: null };
      record.listener = error => {
        if (!brokenPipe(error)) {
          // Adding our listener must not convert a previously fatal stream
          // error into an ignored error. Existing owners may still handle it.
          if (stream.listenerCount('error') === 1) throw error;
          return;
        }
        if (record.broken) return;
        record.broken = true;
        record.code = error.code;
        for (const subscriber of record.subscribers) {
          try { subscriber(record.code); } catch { /* Never report a pipe error through the same broken pipe. */ }
        }
      };
      guardedStreams.set(stream, record);
      stream.on('error', record.listener);
    }
    const subscriber = code => onBroken({ stream: name, code });
    record.subscribers.add(subscriber);
    states.set(name, record);
    subscriptions.push({ stream, record, subscriber });
  }
  let disposed = false;
  return Object.freeze({
    isBroken(name) { return states.get(name)?.broken === true; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { stream, record, subscriber } of subscriptions) {
        record.subscribers.delete(subscriber);
        if (!record.subscribers.size) {
          stream.removeListener('error', record.listener);
          guardedStreams.delete(stream);
        }
      }
    }
  });
}

module.exports = { installProcessStdioGuards, brokenPipe };
