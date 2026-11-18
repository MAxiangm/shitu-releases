'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createBrowserMediaRelay, CHUNK_LIMIT } = require('../src/browser-media-relay.cjs');

const URL = 'https://relay-test.vimeocdn.com/video.mp4?signature=fixture';
const ID = '1700000000000-1';
const head = (read, extra = {}) => ({ status: 200, url: read.url, contentType: 'video/mp4', ...extra });

async function setup(t, options) {
  const manager = createBrowserMediaRelay();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-relay-test-'));
  const session = manager.createSession(ID, options);
  t.after(async () => { await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, session, directory };
}
async function pending(manager, session, options) {
  const completion = session.read(URL, options);
  completion.catch(() => {});
  let read;
  for (let i = 0; i < 100 && !read; i++) {
    read = manager.poll(ID);
    if (!read) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(read);
  return { completion, read, send: (sequence, fields) => manager.accept({ requestId: ID, readId: read.readId, sequence, ...fields }) };
}

test('relay exposes only the issued source and returns complete in-memory manifest bytes', async t => {
  const { manager, session } = await setup(t);
  assert.equal(manager.poll('not-registered'), null);
  const transfer = await pending(manager, session, { limit: 512 * 1024 });
  assert.deepEqual(Object.keys(transfer.read).sort(), ['limit', 'readId', 'url']);
  assert.match(transfer.read.readId, /^[a-f0-9-]{36}$/);
  const bytes = Buffer.from('#EXTM3U\n#EXT-X-ENDLIST\n');
  await transfer.send(0, { head: head(transfer.read, { contentType: 'application/vnd.apple.mpegurl', contentLength: bytes.length }) });
  await transfer.send(1, { dataBase64: bytes.toString('base64') });
  await transfer.send(2, { done: true });
  const result = await transfer.completion;
  assert.deepEqual(result.body, bytes);
  assert.equal(result.url.href, URL);
  assert.equal(manager.poll(ID), null);
  await assert.rejects(transfer.send(3, { done: true }), /失效/);
});

test('relay streams files larger than the old 20 MB inline limit with acknowledged chunks', async t => {
  const { manager, session, directory } = await setup(t);
  const file = path.join(directory, 'output');
  const counted = [];
  const size = 21 * 1024 * 1024 + 17;
  const transfer = await pending(manager, session, { destination: file, limit: size, onBytes: bytes => counted.push(bytes) });
  await transfer.send(0, { head: head(transfer.read, { contentLength: size }) });
  let sequence = 1;
  for (let offset = 0; offset < size; offset += CHUNK_LIMIT) {
    const chunk = Buffer.alloc(Math.min(CHUNK_LIMIT, size - offset), sequence % 256);
    await transfer.send(sequence++, { dataBase64: chunk.toString('base64') });
    assert.equal((await fs.stat(file)).size, offset + chunk.length, 'acknowledgement follows the file write');
  }
  await transfer.send(sequence, { done: true });
  assert.equal(await transfer.completion, undefined);
  assert.equal(counted.reduce((sum, value) => sum + value, 0), size);
  assert.equal((await fs.stat(file)).size, size);
  const bytes = await fs.readFile(file);
  assert.equal(bytes[0], 1);
  assert.equal(bytes.at(-1), (sequence - 1) % 256);
});

test('relay validates byte-range status, content-range and complete byte count', async t => {
  const { manager, session } = await setup(t);
  const range = { start: 8, end: 11 };
  const transfer = await pending(manager, session, { limit: 4, range });
  assert.deepEqual(transfer.read.range, range);
  await transfer.send(0, { head: head(transfer.read, { status: 206, contentRange: 'bytes 8-11/20', contentLength: 4 }) });
  await transfer.send(1, { dataBase64: 'AQIDBA==' });
  await transfer.send(2, { done: true });
  assert.deepEqual((await transfer.completion).body, Buffer.from([1, 2, 3, 4]));
  const incomplete = await pending(manager, session, { limit: 4, range });
  await incomplete.send(0, { head: head(incomplete.read, { status: 206, contentRange: 'bytes 8-11/20' }) });
  await incomplete.send(1, { dataBase64: 'AQI=' });
  await assert.rejects(incomplete.send(2, { done: true }), /不完整/);
  await assert.rejects(incomplete.completion, /不完整/);
});

test('relay rejects untrusted headers, stale IDs and malformed chunks without leaking another read', async t => {
  const { manager, session } = await setup(t);
  const transfer = await pending(manager, session, { limit: CHUNK_LIMIT });
  await assert.rejects(manager.accept({ requestId: ID, readId: 'unrelated', sequence: 0, head: head(transfer.read) }), /失效/);
  assert.equal(manager.poll(ID).readId, transfer.read.readId);
  await assert.rejects(transfer.send(0, { head: head(transfer.read, { url: 'http://127.0.0.1/private' }) }), /地址无效/);
  await assert.rejects(transfer.completion, /地址无效/);
  const malformed = await pending(manager, session, { limit: CHUNK_LIMIT });
  await malformed.send(0, { head: head(malformed.read) });
  await assert.rejects(malformed.send(1, { dataBase64: 'AR==' }), /无效/);
  await assert.rejects(malformed.completion, /无效/);
});

test('relay fails out-of-order data, oversized chunks and truncated content-length', async t => {
  const { manager, session } = await setup(t);
  const unordered = await pending(manager, session, { limit: CHUNK_LIMIT });
  await assert.rejects(unordered.send(1, { dataBase64: 'AQ==' }), /顺序/);
  await assert.rejects(unordered.completion, /顺序/);
  const oversized = await pending(manager, session, { limit: CHUNK_LIMIT + 1 });
  await oversized.send(0, { head: head(oversized.read) });
  await assert.rejects(oversized.send(1, { dataBase64: Buffer.alloc(CHUNK_LIMIT + 1).toString('base64') }), /无效/);
  await assert.rejects(oversized.completion, /无效/);
  const truncated = await pending(manager, session, { limit: 10 });
  await truncated.send(0, { head: head(truncated.read, { contentLength: 10 }) });
  await truncated.send(1, { dataBase64: 'AQ==' });
  await assert.rejects(truncated.send(2, { done: true }), /不完整/);
  await assert.rejects(truncated.completion, /不完整/);
});

test('relay rejects HTML, incorrect range headers and aggregate read overflow', async t => {
  const { manager, session } = await setup(t);
  const html = await pending(manager, session, { limit: 10 });
  await assert.rejects(html.send(0, { head: head(html.read, { contentType: 'text/html' }) }), /媒体/);
  await assert.rejects(html.completion, /媒体/);
  const ranged = await pending(manager, session, { limit: 4, range: { start: 2, end: 5 } });
  await assert.rejects(ranged.send(0, { head: head(ranged.read, { status: 206, contentRange: 'bytes 3-6/20' }) }), /区间/);
  await assert.rejects(ranged.completion, /区间/);
  const overflow = await pending(manager, session, { limit: 3 });
  await overflow.send(0, { head: head(overflow.read) });
  await overflow.send(1, { dataBase64: 'AQI=' });
  await assert.rejects(overflow.send(2, { dataBase64: 'AwQ=' }), /大小/);
  await assert.rejects(overflow.completion, /大小/);
});

test('abort and shutdown close partial files and invalidate pending reads', async t => {
  const controller = new AbortController();
  const { manager, session, directory } = await setup(t, { signal: controller.signal });
  const file = path.join(directory, 'partial');
  const transfer = await pending(manager, session, { destination: file, limit: 10 });
  await transfer.send(0, { head: head(transfer.read) });
  await transfer.send(1, { dataBase64: 'AQI=' });
  controller.abort(new Error('test timeout'));
  await assert.rejects(transfer.completion, /test timeout/);
  assert.equal(manager.poll(ID), null);
  await fs.rename(file, path.join(directory, 'closed-file'));
  await assert.rejects(transfer.send(2, { done: true }), /失效/);
  const second = manager.createSession('1700000000000-2');
  const completion = second.read(URL, { limit: 10 });
  completion.catch(() => {});
  await manager.close();
  await assert.rejects(completion, /结束/);
});
