(function (scope, factory) {
  'use strict';
  const api = factory(scope);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.MosaicSketchfabViewerTransfer = api;
})(typeof globalThis === 'object' ? globalThis : this, function (scope) {
  'use strict';
  // Chrome extension messages have a 64 MiB ceiling. Keep even JSON-escaped
  // chunks comfortably below it; the full snapshot remains bounded separately.
  const MAX_BYTES = 384 * 1024 * 1024, CHUNK_SIZE = 4 * 1024 * 1024, INLINE_BYTES = 8 * 1024 * 1024;
  const TTL_MS = 120000, READ_TIMEOUT_MS = 10000;
  const MODEL_ID = /^[a-f0-9]{32}$/, REQUEST_ID = /^\d{13}-\d{1,10}$/;
  const failure = code => Object.assign(new Error(code), { code });
  const invalid = () => { throw failure('SKETCHFAB_VIEWER_INVALID'); };
  function utf8Length(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x80) bytes++;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }
  function binding(value) {
    if (!value || !MODEL_ID.test(value.modelId || '') || !REQUEST_ID.test(value.requestId || '') || !REQUEST_ID.test(value.clientCaptureId || '')) invalid();
    return { modelId: value.modelId, requestId: value.requestId, clientCaptureId: value.clientCaptureId };
  }
  function sameBinding(a, b) {
    return a.modelId === b?.modelId && a.requestId === b?.requestId && a.clientCaptureId === b?.clientCaptureId;
  }
  function configured(options) {
    const value = { maxBytes: MAX_BYTES, chunkSize: CHUNK_SIZE, inlineBytes: INLINE_BYTES, ttlMs: TTL_MS, ...options };
    for (const [key, maximum] of [['maxBytes', MAX_BYTES], ['chunkSize', CHUNK_SIZE], ['inlineBytes', INLINE_BYTES], ['ttlMs', TTL_MS]]) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > maximum) invalid();
    }
    return value;
  }
  function randomId() {
    const bytes = new Uint8Array(16); scope.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function createStore(options = {}) {
    const config = configured(options), now = options.now || Date.now;
    const setTimer = options.setTimeout || scope.setTimeout.bind(scope), clearTimer = options.clearTimeout || scope.clearTimeout.bind(scope);
    let current = null, timer;
    function clear(expected) {
      if (expected && current && !sameBinding(current.binding, expected)) return false;
      clearTimer(timer); timer = undefined;
      if (current) current.text = '';
      current = null; return true;
    }
    function live(record) {
      if (current !== record || now() >= record.expires || !record.isCurrent()) {
        if (current === record) clear();
        throw failure('SKETCHFAB_SOURCE_CHANGED');
      }
    }
    function watch(record) {
      timer = setTimer(() => {
        try { live(record); watch(record); } catch { /* The record was released. */ }
      }, Math.min(1000, Math.max(1, record.expires - now())));
      timer?.unref?.();
    }
    function prepare(snapshot, identity, isCurrent = () => true) {
      const expected = binding(identity); clear();
      if (!isCurrent()) throw failure('SKETCHFAB_SOURCE_CHANGED');
      if (!snapshot || snapshot.version !== 1 || snapshot.modelId !== expected.modelId) invalid();
      let text;
      try { text = JSON.stringify(snapshot); } catch { invalid(); }
      if (typeof text !== 'string') invalid();
      const bytes = utf8Length(text);
      if (bytes > config.maxBytes) throw failure('SKETCHFAB_VIEWER_TOO_LARGE');
      if (bytes <= config.inlineBytes) return { viewerSnapshot: snapshot };
      const id = (options.randomId || randomId)(); if (!MODEL_ID.test(id)) invalid();
      const descriptor = { id, length: text.length, bytes, chunks: Math.ceil(text.length / config.chunkSize), chunkSize: config.chunkSize };
      current = { binding: expected, text, descriptor, sequence: 0, expires: now() + config.ttlMs, isCurrent };
      watch(current);
      return { viewerTransfer: { ...descriptor } };
    }
    function read(message) {
      const record = current;
      if (!record || !sameBinding(record.binding, message) || message.transferId !== record.descriptor.id) throw failure('SKETCHFAB_SOURCE_CHANGED');
      live(record);
      if (!Number.isSafeInteger(message.sequence) || message.sequence !== record.sequence) { clear(); invalid(); }
      const sequence = record.sequence++, start = sequence * config.chunkSize;
      const data = record.text.slice(start, start + config.chunkSize), done = record.sequence === record.descriptor.chunks;
      const response = { ok: true, ...record.binding, transferId: record.descriptor.id, sequence, data, done };
      if (done) clear();
      return response;
    }
    function release(message) {
      if (!current || !sameBinding(current.binding, message) || message.transferId !== current.descriptor.id) return false;
      return clear();
    }
    function clearCapture(clientCaptureId) { if (current?.binding.clientCaptureId === clientCaptureId) clear(); }
    return { prepare, read, release, clear, clearCapture };
  }
  function descriptor(value, config) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'length', 'bytes', 'chunks', 'chunkSize'].includes(key)) ||
        !MODEL_ID.test(value.id || '') || !Number.isSafeInteger(value.length) || value.length < 1 || !Number.isSafeInteger(value.bytes) || value.bytes < value.length ||
        value.length > config.maxBytes || value.bytes > config.maxBytes || value.chunkSize !== config.chunkSize ||
        value.chunks !== Math.ceil(value.length / value.chunkSize)) invalid();
    return value;
  }
  async function receive(transfer, identity, options = {}) {
    const config = configured(options), expected = binding(identity), now = options.now || Date.now;
    const isCurrent = options.isCurrent || (() => true), timeoutMs = options.timeoutMs ?? TTL_MS, readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
    if (typeof options.read !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TTL_MS ||
        !Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > READ_TIMEOUT_MS) invalid();
    const setTimer = options.setTimeout || scope.setTimeout.bind(scope), clearTimer = options.clearTimeout || scope.clearTimeout.bind(scope);
    const deadline = now() + timeoutMs, parts = [];
    const check = () => { if (!isCurrent()) throw failure('SKETCHFAB_SOURCE_CHANGED'); if (now() >= deadline) throw failure('SKETCHFAB_VIEWER_TIMEOUT'); };
    async function timed(action, duration) {
      let timer;
      try { return await Promise.race([Promise.resolve().then(action), new Promise((_resolve, reject) => { timer = setTimer(() => reject(failure('SKETCHFAB_VIEWER_TIMEOUT')), duration); })]); }
      finally { clearTimer(timer); }
    }
    try {
      descriptor(transfer, config); check(); let length = 0, bytes = 0, previousTail = 0;
      for (let sequence = 0; sequence < transfer.chunks; sequence++) {
        check();
        const response = await timed(() => options.read({ ...expected, transferId: transfer.id, sequence }), Math.max(1, Math.min(readTimeoutMs, deadline - now())));
        check();
        if (!response?.ok) throw failure(response?.code === 'SKETCHFAB_SOURCE_CHANGED' ? response.code : 'SKETCHFAB_VIEWER_INVALID');
        const expectedLength = Math.min(config.chunkSize, transfer.length - sequence * config.chunkSize);
        if (!sameBinding(expected, response) || response.transferId !== transfer.id || response.sequence !== sequence ||
            typeof response.data !== 'string' || response.data.length !== expectedLength || response.done !== (sequence === transfer.chunks - 1)) invalid();
        length += response.data.length; if (length > transfer.length || length > config.maxBytes) invalid();
        bytes += utf8Length(response.data);
        const first = response.data.charCodeAt(0);
        // A split surrogate pair costs four UTF-8 bytes when rejoined, not the
        // six replacement bytes charged by inspecting the two chunks alone.
        if (previousTail >= 0xd800 && previousTail <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
        previousTail = response.data.charCodeAt(response.data.length - 1);
        if (bytes > config.maxBytes || bytes > transfer.bytes + (previousTail >= 0xd800 && previousTail <= 0xdbff ? 2 : 0)) invalid();
        parts.push(response.data);
      }
      if (length !== transfer.length || bytes !== transfer.bytes) invalid();
      const text = parts.join(''); parts.length = 0;
      let snapshot;
      try { snapshot = JSON.parse(text); } catch { invalid(); }
      if (!snapshot || snapshot.version !== 1 || snapshot.modelId !== expected.modelId) invalid();
      check(); return snapshot;
    } finally {
      parts.length = 0;
      if (typeof options.release === 'function' && MODEL_ID.test(transfer?.id || '')) {
        try { await timed(() => options.release({ ...expected, transferId: transfer.id }), 1000); } catch { /* Local TTL also releases the string. */ }
      }
    }
  }
  return { MAX_BYTES, CHUNK_SIZE, INLINE_BYTES, TTL_MS, READ_TIMEOUT_MS, utf8Length, createStore, receive };
});
