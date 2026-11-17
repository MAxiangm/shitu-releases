'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAppUpdater, newerThan } = require('../src/app-updater.cjs');

const repository = 'example/shitu-releases';
const apiURL = `https://api.github.com/repos/${repository}/releases/latest`;
const version = '0.10.8';
const tag = `v${version}`;
const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
const payload = Buffer.from('MZ-shitu-test-installer-only');
const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
function releaseFixture() {
  const manifest = { schemaVersion: 1, version, platform: 'win32', arch: 'x64',
    installer: { name: `shitu-${version}-setup.exe`, size: payload.length, sha256 } };
  const manifestText = JSON.stringify(manifest);
  const release = { tag_name: tag, body: 'A useful update', draft: false, prerelease: false, assets: [
    { name: 'shitu-update.json', size: Buffer.byteLength(manifestText), browser_download_url: prefix + 'shitu-update.json' },
    { name: manifest.installer.name, size: payload.length, digest: `sha256:${sha256}`,
      browser_download_url: prefix + manifest.installer.name }
  ] };
  return { manifest, release };
}
async function fixture(t, options = {}) {
  const base = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'updater-'));
  const data = releaseFixture();
  const calls = [], events = [], installations = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (options.fetch) return options.fetch(url, init, data);
    if (url === apiURL) return new Response(JSON.stringify(data.release));
    if (url === prefix + 'shitu-update.json') return new Response(JSON.stringify(data.manifest));
    if (url === prefix + data.manifest.installer.name) return new Response(payload, { headers: { 'Content-Length': String(payload.length) } });
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const updater = createAppUpdater({ currentVersion: '0.10.7', repository, cacheDir: directory,
    fetchImpl, onEvent: event => events.push(event), install: args => { installations.push(args); }, ...options.updater });
  t.after(async () => {
    updater.dispose();
    const relative = path.relative(base, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { ...data, updater, calls, events, installations, directory };
}

test('stable version comparison handles minor and major versions without string ordering', () => {
  assert.equal(newerThan('0.10.10', '0.10.9'), true);
  assert.equal(newerThan('1.0.0', '0.99.999'), true);
  assert.equal(newerThan('0.10.7', '0.10.7'), false);
  assert.equal(newerThan('0.10.6', '0.10.7'), false);
  assert.equal(newerThan('0.10.8-beta.1', '0.10.7'), false);
  assert.equal(newerThan('01.1.0', '0.10.7'), false);
});

test('finds a stable update only after validating manifest and exact release assets', async t => {
  const { updater, calls, events } = await fixture(t);
  const result = await updater.check();
  assert.equal(result.status, 'available');
  assert.equal(result.latestVersion, version);
  assert.equal(result.releaseNotes, 'A useful update');
  assert.equal(result.totalBytes, payload.length);
  assert.equal(result.releaseUrl, `https://github.com/${repository}/releases/tag/${tag}`);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.init.redirect === 'manual' && !call.init.headers.Authorization));
  assert.equal(events[0].status, 'checking');
  const detached = updater.state();
  detached.status = 'broken';
  assert.equal(updater.state().status, 'available');
});

test('ignores draft, prerelease, equal and older releases without downloading metadata', async t => {
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.10.8-beta.1' },
    { tag_name: 'v0.10.7' }, { tag_name: 'v0.9.99' }]) {
    const item = await fixture(t);
    Object.assign(item.release, patch);
    assert.equal((await item.updater.check()).status, 'idle');
    assert.equal(item.calls.length, 1);
  }
});

test('missing repository disables requests and an empty published release list is handled', async t => {
  for (const repository of ['', 'owner/..', 'owner/.', 'https://example.com/repo']) {
    const disabled = await fixture(t, { updater: { repository } });
    assert.equal((await disabled.updater.check()).status, 'disabled');
    assert.equal(disabled.calls.length, 0);
  }
  const empty = await fixture(t, { fetch: async () => new Response('', { status: 404 }) });
  assert.equal((await empty.updater.check()).status, 'idle');
});

test('rejects installer or manifest URLs outside the exact repository release', async t => {
  for (const url of ['http://github.com/example/shitu-releases/releases/download/v0.10.8/shitu-update.json',
    'https://evil.example/shitu-update.json',
    'https://github.com/another/repo/releases/download/v0.10.8/shitu-update.json',
    'https://user:password@github.com/example/shitu-releases/releases/download/v0.10.8/shitu-update.json',
    prefix + 'shitu-update.json?redirect=evil']) {
    const item = await fixture(t);
    item.release.assets[0].browser_download_url = url;
    await assert.rejects(item.updater.check(), /地址|附件/);
    assert.equal(item.calls.length, 1);
  }
  const installer = await fixture(t);
  installer.release.assets[1].browser_download_url = 'https://evil.example/setup.exe';
  await assert.rejects(installer.updater.check(), /地址/);
});

test('rejects malformed manifests, platform mismatch and missing integrity values', async t => {
  for (const patch of [{ version: '0.10.9' }, { schemaVersion: 2 }, { platform: 'linux' }, { arch: 'arm64' },
    { installer: { name: `shitu-${version}-setup.exe`, size: payload.length } },
    { installer: { name: '../setup.exe', size: payload.length, sha256 } },
    { installer: { name: `shitu-${version}-setup.exe`, size: 3 * 1024 ** 3, sha256 } }]) {
    const item = await fixture(t);
    Object.assign(item.manifest, patch);
    await assert.rejects(item.updater.check(), /清单/);
    assert.equal(item.updater.state().status, 'error');
  }
});

test('rejects mismatched GitHub asset size and optional server digest', async t => {
  const badSize = await fixture(t);
  badSize.release.assets[1].size++;
  await assert.rejects(badSize.updater.check(), /大小/);
  const badHash = await fixture(t);
  badHash.release.assets[1].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(badHash.updater.check(), /校验值/);
});

test('follows permitted GitHub asset redirects and rejects an external redirect', async t => {
  let redirected = false;
  const item = await fixture(t, { fetch: async (url, _init, data) => {
    if (url === apiURL) return new Response(JSON.stringify(data.release));
    if (url === prefix + 'shitu-update.json') return new Response(null, { status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/assets/manifest?token=example' } });
    if (url.startsWith('https://release-assets.githubusercontent.com/')) {
      redirected = true;
      return new Response(JSON.stringify(data.manifest));
    }
  } });
  assert.equal((await item.updater.check()).status, 'available');
  assert.equal(redirected, true);
  const malicious = await fixture(t, { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/metadata' } }) });
  await assert.rejects(malicious.updater.check(), /受信任/);
  assert.equal(malicious.calls.length, 1);
});

test('streams a verified download, reports progress and installs only verified bytes', async t => {
  const item = await fixture(t);
  await item.updater.check();
  const result = await item.updater.download();
  assert.equal(result.status, 'downloaded');
  assert.equal(result.progress, 100);
  assert.equal(result.downloadedBytes, payload.length);
  assert.ok(item.events.some(event => event.status === 'downloading'));
  assert.equal(Object.hasOwn(result, 'filePath'), false);
  const files = await fs.readdir(item.directory);
  assert.equal(files.length, 1);
  assert.deepEqual(await fs.readFile(path.join(item.directory, files[0])), payload);
  await item.updater.install();
  assert.equal(item.installations.length, 1);
  assert.equal(item.installations[0].version, version);
  assert.equal(item.updater.state().status, 'installing');
});

test('reuses verified cache bytes and preserves downloaded status across another check', async t => {
  const item = await fixture(t);
  await item.updater.check();
  await item.updater.download();
  assert.equal((await item.updater.check()).status, 'downloaded');
  const before = item.calls.length;
  await item.updater.download();
  assert.equal(item.calls.length, before);
});

test('rejects corrupt or truncated downloads, removes partial files and allows retry', async t => {
  for (const bytes of [Buffer.from('x'.repeat(payload.length)), payload.subarray(0, 4), Buffer.concat([payload, payload])]) {
    let bad = true;
    const item = await fixture(t, { fetch: async (url, _init, data) => {
      if (url === apiURL) return new Response(JSON.stringify(data.release));
      if (url.endsWith('/shitu-update.json')) return new Response(JSON.stringify(data.manifest));
      return new Response(bad ? bytes : payload);
    } });
    await item.updater.check();
    await assert.rejects(item.updater.download(), /校验|大小/);
    assert.equal(item.updater.state().status, 'available');
    assert.deepEqual(await fs.readdir(item.directory), []);
    assert.equal(item.installations.length, 0);
    bad = false;
    assert.equal((await item.updater.download()).status, 'downloaded');
  }
});

test('rejects response content-length mismatch before writing an installer', async t => {
  const item = await fixture(t, { fetch: async (url, _init, data) => {
    if (url === apiURL) return new Response(JSON.stringify(data.release));
    if (url.endsWith('/shitu-update.json')) return new Response(JSON.stringify(data.manifest));
    return new Response(payload, { headers: { 'Content-Length': String(payload.length + 1) } });
  } });
  await item.updater.check();
  await assert.rejects(item.updater.download(), /长度/);
  assert.deepEqual(await fs.readdir(item.directory), []);
});

test('rehashes immediately before install and never launches a changed installer', async t => {
  const item = await fixture(t);
  await item.updater.check();
  await item.updater.download();
  const [file] = await fs.readdir(item.directory);
  await fs.writeFile(path.join(item.directory, file), Buffer.from('z'.repeat(payload.length)));
  await assert.rejects(item.updater.install(), /文件已变化/);
  assert.equal(item.installations.length, 0);
  assert.equal(item.updater.state().status, 'available');
});

test('deduplicates concurrent checks and downloads', async t => {
  let releaseResolve;
  const releaseWait = new Promise(resolve => { releaseResolve = resolve; });
  let fileResolve;
  const fileWait = new Promise(resolve => { fileResolve = resolve; });
  const item = await fixture(t, { fetch: async (url, _init, data) => {
    if (url === apiURL) { await releaseWait; return new Response(JSON.stringify(data.release)); }
    if (url.endsWith('/shitu-update.json')) return new Response(JSON.stringify(data.manifest));
    await fileWait;
    return new Response(payload);
  } });
  const first = item.updater.check(), second = item.updater.check();
  assert.equal(first, second);
  releaseResolve();
  await Promise.all([first, second]);
  const a = item.updater.download(), b = item.updater.download();
  assert.equal(a, b);
  await assert.rejects(item.updater.install(), /正在进行/);
  fileResolve();
  await Promise.all([a, b]);
  assert.equal(item.calls.filter(call => call.url === apiURL).length, 1);
  assert.equal(item.calls.filter(call => call.url.endsWith('.exe')).length, 1);
});

test('network failure preserves a downloaded update and a failed installer can retry', async t => {
  let networkFails = false, installFails = true;
  const installations = [];
  const item = await fixture(t, { fetch: async (url, _init, data) => {
    if (networkFails) throw new Error('secret signed CDN URL should never reach the UI');
    if (url === apiURL) return new Response(JSON.stringify(data.release));
    if (url.endsWith('/shitu-update.json')) return new Response(JSON.stringify(data.manifest));
    return new Response(payload);
  }, updater: { install: async args => {
    if (installFails) throw new Error('a private local filesystem path');
    installations.push(args);
  } } });
  await item.updater.check();
  await item.updater.download();
  networkFails = true;
  await assert.rejects(item.updater.check(), /检查更新失败/);
  assert.equal(item.updater.state().status, 'downloaded');
  assert.ok(!item.updater.state().error.includes('secret'));
  await assert.rejects(item.updater.install(), /启动更新安装程序失败/);
  assert.equal(item.updater.state().status, 'downloaded');
  installFails = false;
  await item.updater.install();
  assert.equal(installations.length, 1);
});

test('dispose cancels an in-flight check without leaving a runnable installer', async t => {
  const item = await fixture(t, { fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }) });
  const pending = item.updater.check();
  await new Promise(resolve => setImmediate(resolve));
  item.updater.dispose();
  await assert.rejects(pending, /取消或超时/);
  await assert.rejects(item.updater.install(), /已关闭/);
  assert.deepEqual(await fs.readdir(item.directory), []);
});
