'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdateManifest, assertReleaseVersion } = require('../scripts/create-update-manifest.cjs');
const { validateRepository, validateReleaseFiles, targetSHA, validateUploadedAssets,
  publishWithGh, publishWithToken, verifyPublishedRelease } = require('../scripts/publish-github.cjs');
const { validateBootstrap } = require('../scripts/prepare-build-resources.cjs');

async function fixture(t) {
  const root = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'update-release-'));
  t.after(async () => {
    const relative = path.relative(root, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('release manifest names ASCII installer and verifies the exact uploaded bytes', async t => {
  const directory = await fixture(t);
  const input = path.join(directory, '拾图-0.10.8-Setup.exe');
  const data = Buffer.from('MZ fixture executable bytes');
  await fs.writeFile(input, data);
  const output = await createUpdateManifest({ version: '0.10.8', installer: input, outputDirectory: directory });
  assert.deepEqual(output.manifest, {
    schemaVersion: 1, version: '0.10.8', platform: 'win32', arch: 'x64',
    installer: { name: 'shitu-0.10.8-setup.exe', size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
  });
  assert.deepEqual(await fs.readFile(output.installerPath), data);
  assert.equal((await validateReleaseFiles('0.10.8', directory)).installer, output.installerPath);
});

test('release preparation rejects traversal, prerelease and malformed version strings', () => {
  for (const version of ['../0.10.8', '0.10.8-beta.1', '01.2.3', 'v0.10.8', '0.10', '']) {
    assert.throws(() => assertReleaseVersion(version), /stable version/);
  }
  assert.doesNotThrow(() => assertReleaseVersion('1.20.300'));
  for (const repo of ['', '../repo', 'owner/repo/another', 'https://github.com/a/b', 'a/..']) {
    assert.throws(() => validateRepository(repo), /public GitHub/);
  }
  assert.equal(validateRepository('MAxiangm/shitu-releases'), 'MAxiangm/shitu-releases');
});

test('release preparation rejects non-executables and tampered publication assets', async t => {
  const directory = await fixture(t);
  const source = path.join(directory, 'source.exe');
  await fs.writeFile(source, 'text only');
  await assert.rejects(createUpdateManifest({ version: '0.10.8', installer: source, outputDirectory: directory }), /signature/);
  await fs.writeFile(source, 'MZ initial bytes');
  const output = await createUpdateManifest({ version: '0.10.8', installer: source, outputDirectory: directory });
  await fs.writeFile(output.installerPath, 'MZ changed bytes');
  await assert.rejects(validateReleaseFiles('0.10.8', directory), /SHA-256/);
  await fs.writeFile(output.manifestPath, JSON.stringify({ ...output.manifest, version: '0.10.9' }));
  await assert.rejects(validateReleaseFiles('0.10.8', directory), /does not match/);
});

test('CI bootstrap requires a pinned stable installer and non-placeholder hash', () => {
  const config = { repository: 'MAxiangm/shitu-releases', tag: 'v0.10.8', asset: 'shitu-0.10.8-setup.exe', sha256: 'a'.repeat(64) };
  assert.equal(validateBootstrap(config), config);
  assert.throws(() => validateBootstrap({ ...config, sha256: '0'.repeat(64) }), /real SHA-256/);
  assert.throws(() => validateBootstrap({ ...config, asset: '../setup.exe' }), /real SHA-256/);
  assert.throws(() => validateBootstrap({ ...config, tag: 'main' }), /real SHA-256/);
});

async function publication(t) {
  const directory = await fixture(t), version = '0.99.1', tag = `v${version}`, repository = 'MAxiangm/shitu-releases';
  const input = path.join(directory, 'input.exe'); await fs.writeFile(input, 'MZ synthetic publication bytes');
  const local = await createUpdateManifest({ version, installer: input, outputDirectory: directory });
  const files = [local.installerPath, local.manifestPath], assets = [];
  for (const file of files) {
    const bytes = await fs.readFile(file), name = path.basename(file);
    assets.push({ name, size: bytes.length, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      state: 'uploaded', browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}` });
  }
  return { directory, version, tag, repository, files, assets, local, target: 'd'.repeat(40),
    info: { tag_name: tag, draft: false, prerelease: false, assets } };
}

test('publication requires a full source SHA and complete uploaded bytes', async t => {
  const data = await publication(t);
  assert.equal(targetSHA('A'.repeat(40)), 'a'.repeat(40));
  for (const value of ['main', 'HEAD', '../main', 'd'.repeat(39), 'd'.repeat(40) + '\n']) assert.throws(() => targetSHA(value), /full Git commit SHA/);
  const expected = data.assets.map(asset => ({ name: asset.name, size: asset.size, sha256: asset.digest.slice(7) }));
  assert.doesNotThrow(() => validateUploadedAssets(data.info, expected, { tag: data.tag, draft: false }));
  for (const change of [{ size: data.assets[0].size + 1 }, { state: 'new' }, { digest: undefined }, { digest: 'sha256:' + '0'.repeat(64) }]) {
    const invalid = structuredClone(data.info); Object.assign(invalid.assets[0], change);
    assert.throws(() => validateUploadedAssets(invalid, expected, { tag: data.tag, draft: false }), /different size\/SHA-256/);
  }
});

test('gh publication pins the pushed source commit and never publishes corrupt draft assets', async t => {
  const data = await publication(t);
  for (const corrupt of [false, true]) {
    const calls = []; let created = false;
    const run = (_cli, args) => {
      calls.push(args);
      if (args[0] === 'api') {
        const endpoint = args[1];
        if (endpoint === `repos/${data.repository}`) return JSON.stringify({ private: false });
        if (endpoint.endsWith(`/commits/${data.target}`)) return JSON.stringify({ sha: data.target });
        if (endpoint.endsWith(`/git/ref/tags/${data.tag}`)) return null;
        if (endpoint.endsWith(`/releases/tags/${data.tag}`)) {
          if (!created) return null;
          const draft = structuredClone({ ...data.info, draft: true }); if (corrupt) draft.assets[0].digest = 'sha256:' + '0'.repeat(64);
          return JSON.stringify(draft);
        }
      }
      if (args[0] === 'release' && args[1] === 'create') {
        assert.equal(args[args.indexOf('--target') + 1], data.target); assert.ok(args.includes('--draft')); created = true; return 'draft';
      }
      if (args[0] === 'release' && args[1] === 'edit') return '';
      throw new Error('Unexpected gh request');
    };
    const task = publishWithGh({ ...data, title: 'fixture', notes: 'fixture', publish: true, cli: 'fixture-gh', run, noteDirectory: data.directory });
    if (corrupt) await assert.rejects(task, /different size\/SHA-256/); else assert.equal(await task, `https://github.com/${data.repository}/releases/tag/${data.tag}`);
    assert.equal(calls.filter(args => args[0] === 'release' && args[1] === 'edit').length, corrupt ? 0 : 1);
  }
});

test('an existing tag pointing at another commit cannot be published as new source', async t => {
  const data = await publication(t); let mutations = 0;
  const run = (_cli, args) => {
    if (args[0] !== 'api') { mutations++; throw new Error('Unexpected mutation'); }
    if (args[1] === `repos/${data.repository}`) return JSON.stringify({ private: false });
    if (args[1].endsWith(`/releases/tags/${data.tag}`)) return null;
    if (args[1].endsWith(`/git/ref/tags/${data.tag}`)) return JSON.stringify({ ref: `refs/tags/${data.tag}` });
    if (args[1].endsWith(`/commits/${data.target}`)) return JSON.stringify({ sha: data.target });
    return JSON.stringify({ sha: 'b'.repeat(40) });
  };
  await assert.rejects(publishWithGh({ ...data, title: 'fixture', notes: '', publish: true, cli: 'fixture-gh', run, noteDirectory: data.directory }), /different source commit/);
  assert.equal(mutations, 0);
});

test('token publication pins the source and verifies every draft attachment before setting latest', async t => {
  const data = await publication(t); const calls = [];
  const fetchImpl = async (urlValue, options = {}) => {
    const url = new URL(urlValue); calls.push({ url, options });
    const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'uploads.github.com') {
      const bytes = []; for await (const chunk of options.body) bytes.push(chunk);
      const asset = data.assets.find(item => item.name === url.searchParams.get('name'));
      assert.equal(Buffer.concat(bytes).length, asset.size); return json(asset);
    }
    if (url.pathname === `/repos/${data.repository}`) return json({ private: false });
    if (url.pathname.endsWith(`/commits/${data.target}`)) return json({ sha: data.target });
    if (url.pathname.endsWith(`/git/ref/tags/${data.tag}`) || url.pathname.endsWith(`/releases/tags/${data.tag}`)) return new Response(null, { status: 404 });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); assert.equal(body.target_commitish, data.target); assert.equal(body.draft, true);
      return json({ id: 19, html_url: `https://github.com/${data.repository}/releases/tag/${data.tag}` });
    }
    if (options.method === 'PATCH') { assert.deepEqual(JSON.parse(options.body), { draft: false, make_latest: 'true' }); return json({}); }
    return json({ ...data.info, draft: true });
  };
  await publishWithToken({ ...data, title: 'fixture', notes: '', publish: true, token: 'synthetic-unit-test-token', fetchImpl });
  const patchIndex = calls.findIndex(call => call.options.method === 'PATCH');
  const inspectIndex = calls.findIndex(call => call.url.pathname.endsWith('/releases/19') && call.options.method === 'GET');
  assert.ok(inspectIndex > 0 && inspectIndex < patchIndex);
});

test('public verification retries stale latest anonymously and checks the exact version manifest', async t => {
  const data = await publication(t); const calls = [], sleeps = []; let checks = 0;
  const fetchImpl = async (urlValue, options) => {
    const url = new URL(urlValue); calls.push({ url, options });
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'manual'); assert.match(options.headers['Cache-Control'], /no-cache/);
    assert.equal(options.headers.Authorization, undefined); assert.ok(url.searchParams.get('shitu_verify'));
    if (url.pathname.endsWith('/latest')) return new Response(JSON.stringify(++checks === 1 ? { ...data.info, tag_name: 'v0.10.9' } : data.info));
    return new Response(await fs.readFile(data.local.manifestPath));
  };
  const result = await verifyPublishedRelease({ ...data, fetchImpl, sleep: async milliseconds => sleeps.push(milliseconds) });
  assert.equal(result.verified, true); assert.equal(checks, 2); assert.equal(sleeps.length, 1);
  assert.notEqual(calls[0].url.search, calls[1].url.search);
  assert.ok(calls[2].url.pathname.includes(`/releases/download/${data.tag}/shitu-update.json`));
});

test('public verification rejects wrong manifest bytes and reports already-published failure without mutation', async t => {
  const data = await publication(t); const calls = [];
  const fetchImpl = async (value, options) => {
    const url = new URL(value); calls.push(options.method || 'GET');
    return new Response(url.pathname.endsWith('/latest') ? JSON.stringify(data.info) : JSON.stringify({ ...data.local.manifest, version: '0.10.9' }));
  };
  await assert.rejects(verifyPublishedRelease({ ...data, fetchImpl, attempts: 2, sleep: async () => {} }), error => error.published === true && /Do not publish it again/.test(error.message));
  assert.equal(calls.length, 4); assert.ok(calls.every(method => method === 'GET'));
});

test('CI preflight preserves a complete publication and always builds manual validations', async t => {
  const data = await publication(t);
  const workflow = await fs.readFile(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const code = workflow.split('          script: |')[1].split('\n  windows:')[0].split('\n').map(line => line.replace(/^            /, '')).join('\n');
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('core', 'context', 'github', 'fetch', 'require', code);
  for (const scenario of ['published', 'draft', 'manual']) {
    const outputs = {}; let reads = 0;
    const context = { eventName: scenario === 'manual' ? 'workflow_dispatch' : 'push', ref: `refs/tags/${data.tag}`, repo: { owner: 'MAxiangm', repo: 'shitu-releases' } };
    await execute({ setOutput: (key, value) => { outputs[key] = value; }, notice: () => {} }, context,
      { rest: { repos: { getReleaseByTag: async () => { reads++; return { data: { ...data.info, draft: scenario === 'draft' } }; } } } },
      async () => new Response(await fs.readFile(data.local.manifestPath)), require);
    assert.equal(outputs.build, scenario === 'published' ? 'false' : 'true');
    if (scenario === 'manual') assert.equal(reads, 0);
  }
});
