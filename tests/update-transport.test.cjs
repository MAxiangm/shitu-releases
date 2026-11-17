'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const { createUpdateTransport } = require('../src/update-transport.cjs');

class NativeRequest extends EventEmitter {
  constructor(options, start) { super(); this.options = options; this.start = start; this.aborted = false; this.followed = 0; }
  end() { this.started = true; queueMicrotask(() => { if (!this.aborted) this.start(this); }); }
  abort() { this.aborted = true; this.message?.destroy(); }
  followRedirect() { this.followed++; }
  redirect(location, status = 302) {
    this.emit('redirect', status, 'GET', location, { location: [location], 'x-update': ['first', 'second'] });
    if (!this.aborted && !this.followed) this.emit('error', new Error('Redirect was cancelled'));
  }
  response(message) { this.message = message; this.emit('response', message); }
}
function incoming({ status = 200, headers = { 'content-type': 'application/octet-stream' }, rawHeaders, stream } = {}) {
  const message = stream || new PassThrough();
  message.statusCode = status; message.statusMessage = status === 200 ? 'OK' : 'Status'; message.headers = headers;
  if (rawHeaders) message.rawHeaders = rawHeaders;
  return message;
}
function setup(start) {
  const requests = [], diagnostics = [];
  const transport = createUpdateTransport({ net: { request(options) {
    const request = new NativeRequest(options, start); requests.push(request); return request;
  } }, onDiagnostic: detail => diagnostics.push(detail) });
  return { requests, diagnostics, transport };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native manual redirect returns a response and aborts before Electron cancels it', async () => {
  const signal = new AbortController(), signed = 'https://release-assets.githubusercontent.com/example/file?secret=temporary';
  const { requests, diagnostics, transport } = setup(request => request.redirect(signed));
  const response = await transport('https://github.com/example/releases/download/v1.0.0/shitu-update.json', {
    signal: signal.signal, redirect: 'manual', cache: 'no-store', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }
  });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), signed);
  assert.equal(response.headers.get('x-update'), 'first, second'); assert.equal(response.body, null);
  const request = requests[0]; assert.equal(request.aborted, true); assert.equal(request.followed, 0);
  assert.equal(request.options.redirect, 'manual'); assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.useSessionCookies, false);
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  assert.equal(request.listenerCount('redirect'), 0); assert.equal(request.listenerCount('response'), 0);
  assert.doesNotThrow(() => request.emit('error', new Error('late native cancellation')));
  assert.ok(diagnostics.every(detail => !JSON.stringify(detail).includes('secret')));
  assert.deepEqual(diagnostics[1], { phase: 'transport', event: 'redirect', host: 'github.com', status: 302 });
});

test('native response streams binary bytes and raw duplicate headers without buffering a file', async () => {
  const signal = new AbortController(), bytes = Buffer.concat([Buffer.from([77, 90, 0, 255]), Buffer.alloc(150000, 73)]);
  const { requests, transport } = setup(request => {
    const message = incoming({ rawHeaders: ['Content-Type', 'application/octet-stream', 'Content-Length', String(bytes.length), 'X-Note', 'one', 'X-Note', 'two'] });
    request.response(message); message.write(bytes.subarray(0, 4)); message.end(bytes.subarray(4));
  });
  const response = await transport('https://release-assets.githubusercontent.com/package.exe', { signal: signal.signal, headers: { Range: 'bytes=0-1' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('x-note'), 'one, two');
  assert.equal(requests[0].options.headers.range, 'bytes=0-1');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  assert.equal(requests[0].listenerCount('response'), 0); assert.equal(requests[0].listenerCount('redirect'), 0);
});

test('a slow reader applies byte backpressure and cancelling the body stops native download', async () => {
  let generated = 0;
  const source = new Readable({ highWaterMark: 65536, read() {
    if (generated++ >= 50000) this.push(null); else this.push(Buffer.alloc(1024));
  } });
  const controller = new AbortController();
  const { requests, transport } = setup(request => request.response(incoming({ stream: source })));
  const response = await transport('https://release-assets.githubusercontent.com/large.exe', { signal: controller.signal });
  await tick(); await tick();
  assert.ok(generated > 0 && generated < 512, `An unread response eagerly generated ${generated} chunks`);
  await response.body.cancel(); await tick();
  assert.equal(requests[0].aborted, true); assert.equal(source.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation and timeout reject before headers, abort once, and release listeners', async () => {
  for (const reason of [new DOMException('cancelled', 'AbortError'), new DOMException('timed out', 'TimeoutError')]) {
    const controller = new AbortController(); const { requests, transport } = setup(() => {});
    const pending = transport('https://api.github.com/repos/example/app/releases/latest', { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(requests[0].aborted, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(requests[0].listenerCount('response'), 0); assert.equal(requests[0].listenerCount('redirect'), 0);
  }
  const controller = new AbortController(); controller.abort();
  const { requests, transport } = setup(() => {});
  await assert.rejects(transport('https://github.com/example', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests.length, 0);
});

test('abort after headers fails a waiting body read and native errors stay visible', async () => {
  const controller = new AbortController();
  const first = setup(request => request.response(incoming()));
  const response = await first.transport('https://github.com/example', { signal: controller.signal });
  const reading = response.arrayBuffer(); controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(first.requests[0].aborted, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const nativeError = new Error('net::ERR_PROXY_CONNECTION_FAILED');
  const before = setup(request => request.emit('error', nativeError));
  await assert.rejects(before.transport('https://api.github.com/example'), error => error === nativeError);
  assert.equal(before.diagnostics.at(-1).code, 'ERR_PROXY_CONNECTION_FAILED');
  const after = setup(request => { const message = incoming(); request.response(message); queueMicrotask(() => message.destroy(nativeError)); });
  const interrupted = await after.transport('https://release-assets.githubusercontent.com/example');
  await assert.rejects(interrupted.arrayBuffer(), error => error === nativeError);
});

test('HTTP failures and null-body responses retain status while unsupported requests never start', async () => {
  const failure = setup(request => { const message = incoming({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }); request.response(message); message.end('limited'); });
  const response = await failure.transport('https://api.github.com/example');
  assert.equal(response.status, 403); assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
  assert.equal(await response.text(), 'limited');
  for (const status of [204, 205, 304]) {
    const empty = setup(request => request.response(incoming({ status })));
    const item = await empty.transport('https://api.github.com/example');
    assert.equal(item.status, status); assert.equal(item.body, null); assert.equal(empty.requests[0].aborted, true);
  }
  const invalid = setup(() => {});
  for (const [url, options] of [['file:///secret', {}], ['https://user:pass@github.com/example', {}], ['https://github.com/example', { method: 'POST', body: 'private' }]])
    await assert.rejects(invalid.transport(url, options), TypeError);
  assert.equal(invalid.requests.length, 0);
});
