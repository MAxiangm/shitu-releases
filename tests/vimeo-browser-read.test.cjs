'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { gzipSync } = require('node:zlib');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';
const cdnUrl = 'https://test.vimeocdn.com/video.mp4?signature=fixture';
const sender = { id: extensionId, url: 'https://player.vimeo.com/video/469819587',
  documentId: 'vimeo-document', frameId: 4, tab: { id: 17 } };
const readMessage = extra => ({ type: 'shitu:vimeo-browser-read', requestId: '1234567890123-1',
  readId: 'read-fixture', url: cdnUrl, limit: 32 * 1024 * 1024, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function contentHarness({ page = sender.url, fetchImpl, packet = async () => ({ ok: true }) } = {}) {
  let listener;
  const fetches = [];
  const chrome = { runtime: { id: extensionId,
    onMessage: { addListener: callback => { listener = callback; } }, sendMessage: packet } };
  vm.runInNewContext(await fs.readFile(path.join(root, 'extension/vimeo-browser-read.js'), 'utf8'), {
    chrome, location: new URL(page), URL, AbortController, setTimeout, clearTimeout,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: async (url, options) => { fetches.push({ url, options }); return fetchImpl(url, options); }
  }, { filename: 'extension/vimeo-browser-read.js' });
  return { fetches, send(message = readMessage(), from = { id: extensionId }) {
    return new Promise(resolve => listener(message, from, resolve));
  }, dispatch(message, from, reply) { return listener(message, from, reply); } };
}

function response({ url = cdnUrl, status = 200, headers = {}, read, cancel = async () => {} } = {}) {
  return { url, status, headers: new Headers({ 'content-type': 'video/mp4', ...headers }),
    body: { getReader: () => ({ read, cancel }) } };
}

test('Vimeo browser reader streams more than 20 MB in bounded chunks and waits for each desktop acknowledgement', async () => {
  const size = 21 * 1024 * 1024 + 19;
  const firstAck = deferred();
  let produced = 0, reads = 0, chunks = 0, received = 0, ended = false, cancelled = false;
  const sequences = [];
  const firstChunk = deferred();
  const harness = await contentHarness({
    fetchImpl: async () => response({ headers: { 'content-length': String(size) }, read: async () => {
      reads++;
      if (produced === size) return { done: true };
      const length = Math.min(256 * 1024, size - produced);
      produced += length;
      return { done: false, value: new Uint8Array(length).fill(37) };
    }, cancel: async () => { cancelled = true; } }),
    packet: async message => {
      sequences.push(message.sequence);
      if (message.dataBase64) {
        const bytes = Buffer.from(message.dataBase64, 'base64');
        assert.ok(bytes.length <= 256 * 1024);
        assert.equal(bytes[0], 37);
        received += bytes.length;
        if (++chunks === 1) { firstChunk.resolve(); await firstAck.promise; }
      }
      if (message.head) assert.equal(message.head.contentLength, size);
      if (message.done) ended = true;
      return { ok: true };
    }
  });
  const pending = harness.send();
  await firstChunk.promise;
  assert.equal(reads, 1, 'no next reader.read occurs before the pending chunk is acknowledged');
  assert.equal(received, 256 * 1024);
  firstAck.resolve();
  assert.equal((await pending).ok, true);
  assert.equal(received, size);
  assert.equal(chunks, Math.ceil(size / (256 * 1024)));
  assert.deepEqual(sequences, sequences.map((_, index) => index));
  assert.ok(ended && cancelled);
  assert.equal(harness.fetches[0].options.credentials, 'omit');
  assert.equal(harness.fetches[0].options.redirect, 'error');
  assert.equal(harness.fetches[0].options.cache, 'no-store');
});

test('Vimeo browser reader preserves range request and response metadata', async () => {
  const packets = [];
  let reads = 0;
  const harness = await contentHarness({ fetchImpl: async () => response({ status: 206,
    headers: { 'content-length': '4', 'content-range': 'bytes 8-11/100' },
    read: async () => ++reads === 1 ? { done: false, value: new Uint8Array([1, 2, 3, 4]) } : { done: true } }),
  packet: async message => { packets.push(message); return { ok: true }; } });
  assert.equal((await harness.send(readMessage({ limit: 4, range: { start: 8, end: 11 } }))).ok, true);
  assert.equal(harness.fetches[0].options.headers.Range, 'bytes=8-11');
  assert.equal(packets[0].head.status, 206);
  assert.equal(packets[0].head.contentRange, 'bytes 8-11/100');
  assert.equal(packets[0].head.url, cdnUrl);
  assert.equal(packets.at(-1).done, true);
});

for (const [extension, contentType, text] of [
  ['m3u8', 'application/vnd.apple.mpegurl', '#EXTM3U\n' + '#EXTINF:1,\nsegment.m4s\n'.repeat(80) + '#EXT-X-ENDLIST\n'],
  ['mpd', 'application/dash+xml', '<MPD><Period>' + '<SegmentURL media="segment.m4s"/>'.repeat(80) + '</Period></MPD>']
]) {
  test(`Vimeo browser reader ignores compressed ${extension} wire length when CORS hides its encoding`, async () => {
    const url = `https://test.vimeocdn.com/master.${extension}?signature=fixture`;
    const decoded = Buffer.from(text);
    const wireLength = gzipSync(decoded).length;
    assert.notEqual(wireLength, decoded.length);
    const packets = [], chunks = [];
    let offset = 0;
    const harness = await contentHarness({ fetchImpl: async () => response({ url,
      // This is what fetch exposes after decoding when CORS hides Content-Encoding.
      headers: { 'content-type': contentType, 'content-length': String(wireLength) },
      read: async () => {
        if (offset === decoded.length) return { done: true };
        const value = decoded.subarray(offset, Math.min(offset + 137, decoded.length));
        offset += value.length;
        return { done: false, value };
      } }),
    packet: async message => {
      packets.push(message);
      if (message.dataBase64) chunks.push(Buffer.from(message.dataBase64, 'base64'));
      return { ok: true };
    } });
    const result = await harness.send(readMessage({ url, limit: 512 * 1024 }));
    assert.equal(result.ok, true, result.error);
    assert.equal(Object.hasOwn(packets[0].head, 'contentLength'), false);
    assert.equal(packets[0].head.contentType, contentType);
    assert.ok(chunks.length > 1);
    assert.deepEqual(Buffer.concat(chunks), decoded);
    assert.equal(packets.at(-1).done, true);
  });
}

test('Vimeo browser reader rejects foreign pages, unsafe URLs and invalid ranges without a network request', async () => {
  for (const configuration of [
    { page: 'https://example.com/' },
    { message: { url: 'https://vimeocdn.com.evil.example/file.mp4' } },
    { message: { url: 'http://test.vimeocdn.com/video.mp4' } },
    { message: { url: 'https://user:pass@test.vimeocdn.com/video.mp4' } },
    { message: { url: 'https://test.vimeocdn.com:8443/video.mp4' } },
    { message: { url: 'https://test.vimeocdn.com/video.mp4#fragment' } },
    { message: { limit: 2, range: { start: 5, end: 7 } } },
    { message: { range: { start: -1, end: 7 } } },
    { message: { limit: 513 * 1024 * 1024 } }
  ]) {
    const harness = await contentHarness({ page: configuration.page, fetchImpl: async () => { throw new Error('unexpected fetch'); } });
    assert.equal((await harness.send(readMessage(configuration.message))).ok, false);
    assert.equal(harness.fetches.length, 0);
  }
});

test('Vimeo browser reader rejects changed response URLs before forwarding bytes', async () => {
  const packets = [];
  const harness = await contentHarness({ fetchImpl: async () => response({ url: 'https://other.vimeocdn.com/video.mp4',
    read: async () => { throw new Error('must not read'); } }), packet: async message => { packets.push(message); return { ok: true }; } });
  assert.equal((await harness.send()).ok, false);
  assert.equal(packets.length, 1);
  assert.ok(packets[0].error);
  assert.equal(packets[0].dataBase64, undefined);
});

test('Vimeo browser reader stops before an over-budget chunk and permits a clean retry after cancellation', async () => {
  let attempt = 0, firstRead = true, cancelled = 0;
  const packets = [];
  const harness = await contentHarness({ fetchImpl: async (_url, options) => {
    attempt++;
    firstRead = true;
    return response({ read: async () => {
      if (!firstRead) return { done: true };
      firstRead = false;
      return { done: false, value: new Uint8Array(attempt === 1 ? 9 : 4) };
    }, cancel: async () => { assert.ok(options.signal.aborted); cancelled++; } });
  }, packet: async message => { packets.push(message); return { ok: true }; } });
  const first = await harness.send(readMessage({ limit: 4 }));
  assert.equal(first.ok, false);
  assert.match(first.error, /大小上限/);
  assert.equal(packets.some(item => item.dataBase64), false);
  assert.equal((await harness.send(readMessage({ limit: 4 }))).ok, true);
  assert.equal(cancelled, 2);
});

test('Vimeo browser reader cancels the active fetch and ignores messages from a different extension', async () => {
  const fetched = deferred();
  const harness = await contentHarness({ fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
    fetched.resolve();
  }) });
  let unexpected = false;
  assert.equal(harness.dispatch(readMessage(), { id: 'foreign-extension' }, () => { unexpected = true; }), undefined);
  assert.equal(unexpected, false);
  const pending = harness.send();
  await fetched.promise;
  assert.equal((await harness.send({ ...readMessage(), type: 'shitu:vimeo-browser-cancel' })).ok, true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /已取消/);
});

async function workerHarness({ fetchImpl, sendToTab, capabilities = {}, initial = {} } = {}) {
  const storage = { shituConnection: { port: 38475, token: 'a'.repeat(64) }, ...initial };
  const requests = [], tabMessages = [];
  let listener;
  const chrome = {
    runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`,
      getManifest: () => ({ version: '0.11.19' }), getPlatformInfo: async () => ({}),
      onMessage: { addListener: callback => { listener = callback; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: storage[key] }),
      set: async values => { Object.assign(storage, structuredClone(values)); } } },
    contextMenus: { removeAll: callback => callback(), create: (_item, callback) => callback(), onClicked: { addListener() {} } },
    tabs: { sendMessage: async (tabId, message, options) => {
      tabMessages.push({ tabId, message, options });
      return sendToTab?.(message, { tabId, options });
    } }
  };
  vm.runInNewContext(await fs.readFile(path.join(root, 'extension/background.js'), 'utf8'), {
    chrome, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval,
    fetch: async (url, options) => {
      const request = { url: String(url), route: new URL(url).pathname, body: JSON.parse(options.body), options };
      requests.push(request);
      const result = request.route === '/v1/ping'
        ? { ok: true, app: '拾图', version: '0.29.14', ready: true, libraryId: 'library-fixture', vimeoPlayback: true, vimeoBrowserRead: true, ...capabilities }
        : await fetchImpl(request);
      return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    }
  }, { filename: 'extension/background.js' });
  return { storage, requests, tabMessages,
    send(message, from = sender) { return new Promise(resolve => listener(message, from, resolve)); } };
}
const vimeoMedia = { kind: 'video', playback: 'hls', name: 'Vimeo sample', title: 'Sample',
  url: 'https://test.vimeocdn.com/master.m3u8?signature=fixture', pageUrl: sender.url };
const imported = { ok: true, imported: 1, duplicates: 0, assetIds: ['saved-video'], existingAssets: [], libraryId: 'library-fixture' };

test('Vimeo worker retries 403 through the original document, retains destination, and validates every upload sender and sequence', async () => {
  const fallback = deferred();
  let harness, attempts = 0, polls = 0, packets = 0, capturedRequestId;
  const maliciousResults = [];
  harness = await workerHarness({ initial: { shituCaptureDestinations: [{ libraryId: 'library-fixture', folderId: 'chosen-folder' }] },
    fetchImpl: async request => {
      if (request.route === '/v1/capture') {
        attempts++;
        if (!request.body.browserRead) return { ok: false, code: 'VIMEO_BROWSER_READ', error: 'Vimeo returned HTTP 403' };
        capturedRequestId = request.body.requestId;
        return fallback.promise;
      }
      if (request.route === '/v1/capture-browser-read') return ++polls === 1 ? { ok: true, read: null }
        : { ok: true, read: { readId: 'active-read', url: cdnUrl, limit: 99 } };
      if (request.route === '/v1/capture-browser-data') { packets++; return { ok: true }; }
      throw new Error(`unexpected route ${request.route}`);
    },
    sendToTab: async (message, target) => {
      if (message.type !== 'shitu:vimeo-browser-read') return;
      assert.equal(target.tabId, sender.tab.id);
      assert.equal(target.options.documentId, sender.documentId);
      assert.equal(JSON.stringify(message).includes('a'.repeat(64)), false, 'pairing token never enters the page');
      const packet = fields => ({ type: 'shitu:vimeo-browser-data', requestId: message.requestId, readId: message.readId, sequence: 0, ...fields });
      maliciousResults.push(await harness.send(packet({ head: {} }), { ...sender, documentId: 'other-document' }));
      maliciousResults.push(await harness.send(packet({ head: {} }), { ...sender, tab: { id: 18 } }));
      maliciousResults.push(await harness.send(packet({ sequence: 2, head: {} })));
      assert.equal((await harness.send(packet({ head: { status: 200, url: cdnUrl, contentType: 'video/mp4' } }))).ok, true);
      assert.equal((await harness.send(packet({ sequence: 1, dataBase64: 'AQID' }))).ok, true);
      assert.equal((await harness.send(packet({ sequence: 2, done: true }))).ok, true);
      fallback.resolve(imported);
      return { ok: true };
    }
  });
  const result = await harness.send({ type: 'shitu:capture', media: vimeoMedia });
  assert.equal(result.ok, true, result.error);
  assert.equal(attempts, 2);
  assert.ok(polls >= 2, 'an empty poll before registration does not stop the pump');
  assert.equal(packets, 3);
  assert.ok(maliciousResults.every(reply => reply.ok === false));
  const captures = harness.requests.filter(request => request.route === '/v1/capture');
  assert.equal(captures[0].body.requestId, captures[1].body.requestId);
  assert.equal(captures[1].body.destination.folderId, 'chosen-folder');
  assert.equal(captures[1].body.destination.libraryId, 'library-fixture');
  assert.equal(captures[1].body.browserRead, true);
  const stale = await harness.send({ type: 'shitu:vimeo-browser-data', requestId: capturedRequestId, readId: 'active-read', sequence: 3, done: true });
  assert.equal(stale.ok, false);
});

test('Vimeo worker does not start browser relay for ordinary errors or an old desktop without the capability', async () => {
  for (const scenario of [
    { capabilities: { vimeoBrowserRead: false }, code: 'VIMEO_BROWSER_READ' },
    { capabilities: {}, code: 'OTHER_ERROR' }
  ]) {
    const harness = await workerHarness({ capabilities: scenario.capabilities,
      fetchImpl: async request => {
        assert.equal(request.route, '/v1/capture');
        return { ok: false, code: scenario.code, error: 'fixture denial' };
      } });
    const result = await harness.send({ type: 'shitu:capture', media: vimeoMedia });
    assert.equal(result.ok, false);
    assert.equal(harness.requests.filter(request => request.route === '/v1/capture').length, 1);
    assert.equal(harness.tabMessages.some(item => item.message.type === 'shitu:vimeo-browser-read'), false);
  }
});

test('Vimeo worker keeps polling between consecutive manifest and media reads', async () => {
  const fallback = deferred();
  let harness, reads = 0, polls = 0;
  harness = await workerHarness({ fetchImpl: async request => {
    if (request.route === '/v1/capture') return request.body.browserRead ? fallback.promise
      : { ok: false, code: 'VIMEO_BROWSER_READ', error: 'Vimeo returned HTTP 403' };
    if (request.route === '/v1/capture-browser-read') {
      polls++;
      return polls % 2 ? { ok: true, read: null, done: false }
        : { ok: true, read: { readId: `read-${polls}`, url: cdnUrl, limit: 99 } };
    }
    if (request.route === '/v1/capture-browser-data') return { ok: true };
    throw new Error(`unexpected route ${request.route}`);
  }, sendToTab: async message => {
    if (message.type !== 'shitu:vimeo-browser-read') return;
    for (const [sequence, payload] of [
      { head: { status: 200, url: cdnUrl, contentType: reads ? 'video/mp4' : 'application/vnd.apple.mpegurl' } },
      { dataBase64: 'AQID' }, { done: true }
    ].entries()) {
      const result = await harness.send({ type: 'shitu:vimeo-browser-data', requestId: message.requestId,
        readId: message.readId, sequence, ...payload });
      assert.equal(result.ok, true, result.error);
    }
    if (++reads === 2) fallback.resolve(imported);
    return { ok: true };
  } });
  assert.equal((await harness.send({ type: 'shitu:capture', media: vimeoMedia })).ok, true);
  assert.equal(reads, 2);
  assert.ok(polls >= 4, 'the pump survives the empty gap before both reads');
});

test('Vimeo worker cancels an active browser transfer once the desktop capture finishes', async () => {
  const fallback = deferred(), started = deferred(), cancelled = deferred();
  const harness = await workerHarness({ fetchImpl: async request => {
    if (request.route === '/v1/capture') return request.body.browserRead ? fallback.promise
      : { ok: false, code: 'VIMEO_BROWSER_READ', error: 'Vimeo returned HTTP 403' };
    if (request.route === '/v1/capture-browser-read') return { ok: true, read: { readId: 'pending-read', url: cdnUrl, limit: 99 } };
    throw new Error(`unexpected route ${request.route}`);
  }, sendToTab: async message => {
    if (message.type === 'shitu:vimeo-browser-read') { started.resolve(); return cancelled.promise; }
    if (message.type === 'shitu:vimeo-browser-cancel') { cancelled.resolve({ ok: false, error: 'cancelled' }); return { ok: true }; }
  } });
  const pending = harness.send({ type: 'shitu:capture', media: vimeoMedia });
  await started.promise;
  fallback.resolve(imported);
  assert.equal((await pending).ok, true);
  await delay(0);
  assert.equal(harness.tabMessages.filter(item => item.message.type === 'shitu:vimeo-browser-cancel').length, 1);
});

test('Vimeo worker retries transient relay poll failures before completing the same capture', async () => {
  const fallback = deferred();
  let harness, polls = 0, cancels = 0;
  harness = await workerHarness({ fetchImpl: async request => {
    if (request.route === '/v1/capture') return request.body.browserRead ? fallback.promise
      : { ok: false, code: 'VIMEO_BROWSER_READ', error: 'Vimeo returned HTTP 403' };
    if (request.route === '/v1/capture-browser-read') {
      if (++polls < 3) throw new Error('transient connection failure');
      return { ok: true, read: { readId: 'recovered-read', url: cdnUrl, limit: 99 } };
    }
    if (request.route === '/v1/capture-browser-data') return { ok: true };
    if (request.route === '/v1/capture-browser-cancel') { cancels++; return { ok: true, cancelled: true }; }
    throw new Error(`unexpected route ${request.route}`);
  }, sendToTab: async message => {
    if (message.type !== 'shitu:vimeo-browser-read') return;
    for (const [sequence, fields] of [
      { head: { status: 200, url: cdnUrl, contentType: 'video/mp4' } },
      { dataBase64: 'AQID' }, { done: true }
    ].entries()) {
      assert.equal((await harness.send({ type: 'shitu:vimeo-browser-data', requestId: message.requestId,
        readId: message.readId, sequence, ...fields })).ok, true);
    }
    fallback.resolve(imported);
    return { ok: true };
  } });
  assert.equal((await harness.send({ type: 'shitu:capture', media: vimeoMedia })).ok, true);
  assert.ok(polls >= 3);
  assert.equal(cancels, 0);
  assert.equal(harness.requests.filter(request => request.route === '/v1/capture').length, 2);
});

test('three failed relay polls cancel the pending desktop read and promptly return a confirmed failure', async () => {
  const fallback = deferred();
  let polls = 0, cancels = 0;
  const harness = await workerHarness({ fetchImpl: async request => {
    if (request.route === '/v1/capture') return request.body.browserRead ? fallback.promise
      : { ok: false, code: 'VIMEO_BROWSER_READ', error: 'Vimeo returned HTTP 403' };
    if (request.route === '/v1/capture-browser-read') { polls++; throw new Error('relay poll disconnected'); }
    if (request.route === '/v1/capture-browser-cancel') { cancels++; return { ok: true, cancelled: true }; }
    throw new Error(`unexpected route ${request.route}`);
  } });
  const start = Date.now();
  try {
    const result = await harness.send({ type: 'shitu:capture', media: vimeoMedia });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BROWSER_READ_FAILED');
    assert.match(result.error, /采集已停止/);
    assert.equal(polls, 3);
    assert.equal(cancels, 1);
    assert.ok(Date.now() - start < 5000, 'does not wait for the 240 second media deadline');
    assert.equal(harness.storage.shituLastCapture.status, 'error');
  } finally {
    // The HTTP capture can finish after the separate cancellation acknowledgement.
    fallback.resolve({ ok: false, error: 'desktop read cancelled' });
    await delay(0);
  }
});

test('a relay cancellation refused during import waits for the original successful save receipt', async () => {
  const fallback = deferred(), cancellationAttempted = deferred();
  let polls = 0, settled = false;
  const harness = await workerHarness({ fetchImpl: async request => {
    if (request.route === '/v1/capture') return request.body.browserRead ? fallback.promise
      : { ok: false, code: 'VIMEO_BROWSER_READ', error: 'Vimeo returned HTTP 403' };
    if (request.route === '/v1/capture-browser-read') { polls++; throw new Error('relay poll disconnected'); }
    if (request.route === '/v1/capture-browser-cancel') {
      cancellationAttempted.resolve();
      return { ok: true, cancelled: false };
    }
    throw new Error(`unexpected route ${request.route}`);
  } });
  const pending = harness.send({ type: 'shitu:capture', media: vimeoMedia }).then(result => { settled = true; return result; });
  await cancellationAttempted.promise;
  await delay(20);
  assert.equal(polls, 3);
  assert.equal(settled, false, 'an already committing import must not be reported as failed');
  fallback.resolve(imported);
  assert.equal((await pending).ok, true);
  assert.equal(harness.storage.shituLastCapture.status, 'saved');
});

test('an unconfirmed relay cancellation reports uncertainty rather than claiming the capture stopped', async () => {
  const fallback = deferred();
  let polls = 0, cancels = 0;
  const harness = await workerHarness({ fetchImpl: async request => {
    if (request.route === '/v1/capture') return request.body.browserRead ? fallback.promise
      : { ok: false, code: 'VIMEO_BROWSER_READ', error: 'Vimeo returned HTTP 403' };
    if (request.route === '/v1/capture-browser-read') { polls++; throw new Error('relay poll disconnected'); }
    if (request.route === '/v1/capture-browser-cancel') { cancels++; throw new Error('cancellation connection failed'); }
    throw new Error(`unexpected route ${request.route}`);
  } });
  try {
    const result = await harness.send({ type: 'shitu:capture', media: vimeoMedia });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TIMEOUT');
    assert.match(result.error, /未收到最终确认/);
    assert.match(result.error, /检查结果/);
    assert.equal(result.error.includes('采集已停止'), false);
    assert.equal(polls, 3);
    assert.equal(cancels, 1);
  } finally {
    fallback.resolve({ ok: false, error: 'late response after interrupted connection' });
    await delay(0);
  }
});
