'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createSketchfabAccount } = require('../src/sketchfab-account.cjs');

const ID = 'a'.repeat(32), OTHER = 'b'.repeat(32), TOKEN = 'test-api-token-secret-123456789';
const ARCHIVE = `https://sketchfab-prod-media.s3.amazonaws.com/archives/${ID}/gltf/model.zip?signature=private-download-signature`;
const PROFILE = { uid: OTHER, apiToken: TOKEN, email: 'private@example.invalid' };
const MODEL = { uid: ID, isDownloadable: true, name: 'Sample model',
  user: { username: 'artist', displayName: 'Artist', profileUrl: 'https://sketchfab.com/artist', email: 'private@example.invalid' },
  license: { label: 'CC Attribution', slug: 'by', url: 'http://creativecommons.org/licenses/by/4.0/' },
  privateData: TOKEN };
const ARCHIVE_RESPONSE = { gltf: { url: ARCHIVE, expires: 300, size: 400 }, token: TOKEN };

function encryptedStorage(overrides = {}) {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), content]);
    },
    decryptString(buffer) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
    },
    ...overrides
  };
}
function response(body, status = 200, options = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' }, ...options });
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-sketchfab-account-'));
  const filePath = path.join(directory, 'account.bin');
  const calls = [], answers = [];
  const request = options.request || (async (url, init) => {
    calls.push({ url, init });
    return answers.length ? answers.shift() : response(PROFILE);
  });
  const safeStorage = options.safeStorage || encryptedStorage();
  const account = createSketchfabAccount({ filePath, safeStorage, request });
  t.after(async () => { await account.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  return { account, filePath, directory, calls, answers, safeStorage, request };
}
async function connect(f) { assert.deepEqual(await f.account.setToken(TOKEN), { connected: true }); }
async function rejectsCode(operation, code) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.message.includes('private-download-signature'));
    return true;
  });
}

test('connect verifies only with official Token authorization and persists encrypted credentials', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.account.state(), { connected: false });
  assert.equal(f.calls.length, 0);
  await connect(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.sketchfab.com/v3/me');
  assert.deepEqual(f.calls[0].init.headers, { Authorization: `Token ${TOKEN}`, Accept: 'application/json' });
  assert.equal(f.calls[0].init.redirect, 'error');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.calls[0].init.cache, 'no-store');
  const bytes = await fs.readFile(f.filePath);
  assert.equal(bytes.includes(Buffer.from(TOKEN)), false);
  assert.equal(bytes.includes(Buffer.from('private@example.invalid')), false);
  assert.deepEqual(await f.account.state(), { connected: true });
  const reloaded = createSketchfabAccount({ filePath: f.filePath, safeStorage: f.safeStorage, request: f.request });
  assert.deepEqual(await reloaded.state(), { connected: true });
  await reloaded.shutdown();
  assert.deepEqual(await f.account.disconnect(), { connected: false });
  await assert.rejects(fs.stat(f.filePath), { code: 'ENOENT' });
});

test('unavailable or plaintext OS storage refuses connection before any request', async t => {
  const variants = [encryptedStorage({ isEncryptionAvailable: () => false })];
  if (process.platform === 'linux') variants.push(encryptedStorage({ getSelectedStorageBackend: () => 'basic_text' }));
  for (const safeStorage of variants) {
    const f = await fixture(t, { safeStorage });
    await rejectsCode(f.account.setToken(TOKEN), 'SKETCHFAB_STORAGE_UNAVAILABLE');
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.stat(f.filePath), { code: 'ENOENT' });
  }
});

test('bad token, invalid profile and rejected verification never replace a working connection', async t => {
  const f = await fixture(t);
  await connect(f);
  const bytes = await fs.readFile(f.filePath);
  await rejectsCode(f.account.setToken('x\r\nAuthorization: stolen'), 'SKETCHFAB_TOKEN_INVALID');
  f.answers.push(response({ message: TOKEN }, 401));
  await rejectsCode(f.account.setToken('different-token-1234'), 'SKETCHFAB_TOKEN_INVALID');
  f.answers.push(response({ uid: 'not-an-id', apiToken: TOKEN }));
  await rejectsCode(f.account.setToken('different-token-1234'), 'SKETCHFAB_TOKEN_INVALID');
  assert.deepEqual(await fs.readFile(f.filePath), bytes);
  assert.deepEqual(await f.account.state(), { connected: true });
});

test('resolve checks official metadata and returns only a ZIP URL plus public attribution', async t => {
  const f = await fixture(t); await connect(f);
  f.answers.push(response(MODEL), response(ARCHIVE_RESPONSE));
  const result = await f.account.resolveModel({ modelId: ID });
  assert.deepEqual(result, { archiveUrl: ARCHIVE, attribution: {
    title: 'Sample model', author: { name: 'Artist', url: 'https://sketchfab.com/artist' },
    license: { name: 'CC Attribution', slug: 'by', url: 'https://creativecommons.org/licenses/by/4.0/' }
  } });
  assert.deepEqual(f.calls.slice(1).map(call => call.url), [
    `https://api.sketchfab.com/v3/models/${ID}`, `https://api.sketchfab.com/v3/models/${ID}/download`
  ]);
  assert.ok(!JSON.stringify(result.attribution).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
});

test('resolve requires a connection, matching UID and explicit downloadable permission', async t => {
  const f = await fixture(t);
  await rejectsCode(f.account.resolveModel({ modelId: ID }), 'SKETCHFAB_ACCOUNT_REQUIRED');
  await rejectsCode(f.account.resolveModel({ modelId: '../me' }), 'SKETCHFAB_MODEL_INVALID');
  assert.equal(f.calls.length, 0);
  await connect(f);
  for (const [model, code] of [
    [{ ...MODEL, uid: OTHER }, 'SKETCHFAB_MODEL_INVALID'],
    [{ ...MODEL, isDownloadable: false }, 'SKETCHFAB_NOT_DOWNLOADABLE'],
    [{ ...MODEL, isDownloadable: 'true' }, 'SKETCHFAB_NOT_DOWNLOADABLE'],
    [{ ...MODEL, isDownloadable: undefined }, 'SKETCHFAB_NOT_DOWNLOADABLE'],
    [{ ...MODEL, license: undefined }, 'SKETCHFAB_MODEL_METADATA'],
    [{ ...MODEL, user: { ...MODEL.user, profileUrl: `https://attacker.invalid/${TOKEN}` } }, 'SKETCHFAB_MODEL_METADATA']
  ]) {
    const before = f.calls.length;
    f.answers.push(response(model));
    await rejectsCode(f.account.resolveModel({ modelId: ID }), code);
    assert.equal(f.calls.length, before + 1, 'must not request archive for an unauthorized or mismatched model');
  }
});

test('archive validation rejects foreign hosts, another model, expiry, or missing glTF ZIP', async t => {
  const f = await fixture(t); await connect(f);
  for (const archive of [
    { gltf: { url: ARCHIVE.replace('sketchfab-prod-media.s3.amazonaws.com', 'attacker.invalid'), expires: 300 } },
    { gltf: { url: ARCHIVE.replace(ID, OTHER), expires: 300 } },
    { gltf: { url: ARCHIVE, expires: 0 } },
    { gltf: { url: ARCHIVE.replace('model.zip', 'scene.gltf'), expires: 300 } },
    { source: { url: ARCHIVE, expires: 300 } },
    { uid: OTHER, ...ARCHIVE_RESPONSE }
  ]) {
    f.answers.push(response(MODEL), response(archive));
    await rejectsCode(f.account.resolveModel({ modelId: ID }), 'SKETCHFAB_ARCHIVE_UNAVAILABLE');
  }
});

test('HTTP errors are sanitized and revoked credentials disconnect automatically', async t => {
  const f = await fixture(t); await connect(f);
  for (const [status, code] of [[403, 'SKETCHFAB_ACCOUNT_FORBIDDEN'], [404, 'SKETCHFAB_MODEL_NOT_FOUND'], [429, 'SKETCHFAB_RATE_LIMITED'], [500, 'SKETCHFAB_REQUEST_FAILED']]) {
    f.answers.push(response({ details: `${TOKEN} ${ARCHIVE}` }, status));
    await rejectsCode(f.account.resolveModel({ modelId: ID }), code);
  }
  f.answers.push(response({ details: TOKEN }, 401));
  await rejectsCode(f.account.resolveModel({ modelId: ID }), 'SKETCHFAB_ACCOUNT_EXPIRED');
  assert.deepEqual(await f.account.state(), { connected: false });
});

test('network, redirect and oversized response errors do not expose response data', async t => {
  const f = await fixture(t); await connect(f);
  f.answers.push({ status: 200, url: 'https://attacker.invalid/private', text: async () => TOKEN });
  await rejectsCode(f.account.resolveModel({ modelId: ID }), 'SKETCHFAB_REQUEST_FAILED');
  f.answers.push(response({ value: TOKEN.repeat(20000) }));
  await rejectsCode(f.account.resolveModel({ modelId: ID }), 'SKETCHFAB_REQUEST_FAILED');
  const broken = await fixture(t, { request: async () => { throw new Error(`Network error: ${TOKEN} ${ARCHIVE}`); } });
  await rejectsCode(broken.account.setToken(TOKEN), 'SKETCHFAB_REQUEST_FAILED');
});

test('cancel and disconnect abort in-flight requests and cannot restore a connection', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { request: async (_url, init) => {
    entered();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true }));
  } });
  const pending = f.account.setToken(TOKEN);
  await started;
  const rejected = rejectsCode(pending, 'SKETCHFAB_CANCELLED');
  assert.deepEqual(await f.account.disconnect(), { connected: false });
  await rejected;
  assert.deepEqual(await f.account.state(), { connected: false });
  assert.deepEqual(await fs.readdir(f.directory), []);

  const g = await fixture(t); await connect(g);
  const abort = new AbortController(); abort.abort();
  await rejectsCode(g.account.resolveModel({ modelId: ID, signal: abort.signal }), 'SKETCHFAB_CANCELLED');
  assert.equal(g.calls.length, 1);
});

test('existing symlink credential files are refused', async t => {
  const f = await fixture(t), target = path.join(f.directory, 'elsewhere.bin');
  await fs.writeFile(target, 'must remain untouched');
  try { await fs.symlink(target, f.filePath); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink permission unavailable'); return; } throw error; }
  await rejectsCode(f.account.setToken(TOKEN), 'SKETCHFAB_STORAGE_FAILED');
  assert.equal(await fs.readFile(target, 'utf8'), 'must remain untouched');
});

test('browser downloads verify public metadata without reading saved credentials or using Authorization', async t => {
  const unavailableStorage = new Proxy({}, { get() { throw new Error('must not access OS credentials'); } });
  const f = await fixture(t, { safeStorage: unavailableStorage });
  const legacyBytes = Buffer.from('legacy ciphertext retained without access');
  await fs.writeFile(f.filePath, legacyBytes);
  f.answers.push(response(MODEL));
  const result = await f.account.resolveBrowserModel({ modelId: ID, archiveUrl: ARCHIVE });
  assert.equal(result.archiveUrl, ARCHIVE);
  assert.deepEqual(result.attribution, { title: 'Sample model', author: { name: 'Artist', url: 'https://sketchfab.com/artist' },
    license: { name: 'CC Attribution', slug: 'by', url: 'https://creativecommons.org/licenses/by/4.0/' } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `https://api.sketchfab.com/v3/models/${ID}`);
  assert.deepEqual(f.calls[0].init.headers, { Accept: 'application/json' });
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.calls[0].init.redirect, 'error');
  assert.deepEqual(await fs.readFile(f.filePath), legacyBytes);
  assert.ok(!JSON.stringify(result.attribution).includes(TOKEN));
});

test('browser downloads reject mismatched archive hosts and IDs before public requests', async t => {
  const f = await fixture(t);
  for (const archiveUrl of [ARCHIVE.replace(ID, OTHER), ARCHIVE.replace('sketchfab-prod-media.s3.amazonaws.com', 'attacker.invalid'),
    'https://sketchfab.com/models/' + ID, ARCHIVE.replace('/gltf/', '/source/'), ARCHIVE + '#fragment']) {
    await rejectsCode(f.account.resolveBrowserModel({ modelId: ID, archiveUrl }), 'SKETCHFAB_BROWSER_SOURCE_INVALID');
  }
  await rejectsCode(f.account.resolveBrowserModel({ modelId: '../me', archiveUrl: ARCHIVE }), 'SKETCHFAB_MODEL_INVALID');
  assert.equal(f.calls.length, 0);
});

test('browser downloads require public matching downloadable model metadata', async t => {
  const f = await fixture(t);
  for (const [model, code] of [
    [{ ...MODEL, uid: OTHER }, 'SKETCHFAB_MODEL_INVALID'],
    [{ ...MODEL, isDownloadable: false }, 'SKETCHFAB_NOT_DOWNLOADABLE'],
    [{ ...MODEL, isDownloadable: 'true' }, 'SKETCHFAB_NOT_DOWNLOADABLE'],
    [{ ...MODEL, isDownloadable: undefined }, 'SKETCHFAB_NOT_DOWNLOADABLE'],
    [{ ...MODEL, license: null }, 'SKETCHFAB_MODEL_METADATA']
  ]) {
    f.answers.push(response(model));
    await rejectsCode(f.account.resolveBrowserModel({ modelId: ID, archiveUrl: ARCHIVE }), code);
  }
  assert.equal(f.calls.length, 5);
});

test('browser 401 and 403 report unavailable public models and retain legacy credentials', async t => {
  const f = await fixture(t), legacyBytes = Buffer.from('leave old encrypted account untouched');
  await fs.writeFile(f.filePath, legacyBytes);
  for (const status of [401, 403]) {
    f.answers.push(response({ details: `${TOKEN} ${ARCHIVE}` }, status));
    await rejectsCode(f.account.resolveBrowserModel({ modelId: ID, archiveUrl: ARCHIVE }), 'SKETCHFAB_PUBLIC_MODEL_UNAVAILABLE');
    assert.deepEqual(await fs.readFile(f.filePath), legacyBytes);
  }
});

test('browser verification cancellation aborts metadata requests without touching credentials', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { request: async (_url, init) => {
    entered();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(ARCHIVE)), { once: true }));
  } });
  const abort = new AbortController();
  const pending = f.account.resolveBrowserModel({ modelId: ID, archiveUrl: ARCHIVE, signal: abort.signal });
  await started;
  const rejected = rejectsCode(pending, 'SKETCHFAB_CANCELLED');
  abort.abort(); await rejected;
  assert.deepEqual(await fs.readdir(f.directory), []);
});
