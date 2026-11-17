'use strict';

const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { root, readProject, installerPath } = require('./release-utils.cjs');

function assertReleaseVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Automatic update releases require a stable version such as 0.10.8.');
  }
}

async function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function createUpdateManifest({ version, installer, outputDirectory }) {
  assertReleaseVersion(version);
  installer = path.resolve(installer);
  outputDirectory = path.resolve(outputDirectory);
  const stat = await fs.stat(installer);
  if (!stat.isFile() || stat.size < 2 || stat.size > 2 * 1024 * 1024 * 1024) {
    throw new Error('Installer must be a non-empty Windows executable no larger than 2 GiB.');
  }
  const handle = await fs.open(installer, 'r');
  const header = Buffer.alloc(2);
  try { await handle.read(header, 0, 2, 0); } finally { await handle.close(); }
  if (header.toString('ascii') !== 'MZ') throw new Error('Installer has no Windows executable signature.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const name = `shitu-${version}-setup.exe`;
  const target = path.join(outputDirectory, name);
  if (target !== installer) await fs.copyFile(installer, target, constants.COPYFILE_FICLONE);
  const digest = await sha256File(target);
  // The manifest and installer are the only public release assets needed by clients.
  const manifest = {
    schemaVersion: 1, version, platform: 'win32', arch: 'x64',
    installer: { name, size: stat.size, sha256: digest }
  };
  const manifestPath = path.join(outputDirectory, 'shitu-update.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath, installerPath: target };
}

if (require.main === module) (async () => {
  const project = await readProject();
  const result = await createUpdateManifest({ version: project.version, installer: installerPath(project), outputDirectory: path.join(root, 'dist') });
  console.log(`Update metadata: ${result.manifestPath}\nInstaller: ${result.installerPath}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { assertReleaseVersion, sha256File, createUpdateManifest };
