'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdateManifest, assertReleaseVersion } = require('../scripts/create-update-manifest.cjs');
const { validateRepository, validateReleaseFiles } = require('../scripts/publish-github.cjs');
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
