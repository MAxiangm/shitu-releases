'use strict';

// Restores only binary dependencies from the pinned first public installer.
// Never replaces the checked-out src/, assets/, extension/ or package.json.
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { root, inside, exists, copyTree, assertNoLinks } = require('./release-utils.cjs');
const { validateRepository } = require('./publish-github.cjs');
const { sha256File } = require('./create-update-manifest.cjs');

function validateBootstrap(config) {
  validateRepository(config.repository);
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(config.tag || '') ||
      config.asset !== `shitu-${config.tag.slice(1)}-setup.exe` ||
      !/^[a-f0-9]{64}$/.test(config.sha256 || '') || /^0+$/.test(config.sha256)) {
    throw new Error('build-resources.json must pin a published stable installer and its real SHA-256.');
  }
  return config;
}

async function resetOwnDirectory(directory) {
  const base = path.join(root, '.recovery');
  if (!inside(base, directory)) throw new Error('Build resource output must stay inside .recovery.');
  for (let current = directory; current !== root; current = path.dirname(current)) {
    if (await exists(current) && (await fs.lstat(current)).isSymbolicLink()) throw new Error(`Linked output is not allowed: ${current}`);
  }
  if (await exists(directory)) { await assertNoLinks(directory); await fs.rm(directory, { recursive: true, force: true }); }
  await fs.mkdir(directory, { recursive: true });
}

async function find7zip() {
  const candidates = [process.env.SEVEN_ZIP, 'C:\\Program Files\\7-Zip\\7z.exe',
    path.join(root, '.recovery', 'tools', '7zip', '7z.exe')].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  const probe = spawnSync('7z', ['i'], { windowsHide: true, stdio: 'ignore' });
  if (!probe.error && probe.status === 0) return '7z';
  throw new Error('7-Zip is required to unpack the pinned build resources.');
}

async function downloadPinned(config, output) {
  if (await exists(output) && await sha256File(output) === config.sha256) return;
  const url = `https://github.com/${config.repository}/releases/download/${config.tag}/${config.asset}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Build resource download returned HTTP ${response.status}.`);
  const temporary = `${output}.${crypto.randomUUID()}.partial`;
  let bytes = 0;
  const hash = crypto.createHash('sha256');
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024 * 1024) return callback(new Error('Bootstrap installer exceeded 2 GiB.'));
      hash.update(chunk); callback(null, chunk);
    } }), createWriteStream(temporary, { flags: 'wx' }));
    if (hash.digest('hex') !== config.sha256) throw new Error('Bootstrap installer SHA-256 mismatch.');
    await fs.rm(output, { force: true });
    await fs.rename(temporary, output);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function restoreBuildResources() {
  if (process.platform !== 'win32') throw new Error('The current build resources support Windows x64 only.');
  const config = validateBootstrap(JSON.parse(await fs.readFile(path.join(root, 'build-resources.json'), 'utf8')));
  const directory = path.join(root, '.recovery', 'downloads');
  await fs.mkdir(directory, { recursive: true });
  const installer = path.join(directory, config.asset);
  await downloadPinned(config, installer);
  const extracted = path.join(root, '.recovery', 'extracted-0.10.7');
  await resetOwnDirectory(extracted);
  const unpack = spawnSync(await find7zip(), ['x', installer, `-o${extracted}`, '-y', '-bso0', '-bsp0'], { windowsHide: true, stdio: 'inherit' });
  if (unpack.error || unpack.status !== 0) throw unpack.error || new Error(`7-Zip exited ${unpack.status}.`);
  const app = path.join(extracted, 'resources', 'app');
  for (const name of ['ai-runtime', 'node_modules']) {
    const source = path.join(app, name);
    if (!(await exists(source))) throw new Error(`Bootstrap installer is missing ${name}.`);
    await copyTree(source, path.join(root, name));
  }
  const runtime = path.join(root, '.recovery', 'runtime');
  await resetOwnDirectory(runtime);
  for (const entry of await fs.readdir(extracted, { withFileTypes: true })) {
    if (['resources', 'Chrome扩展', '$PLUGINSDIR'].includes(entry.name) || /卸载|安装指南|使用说明/.test(entry.name)) continue;
    await copyTree(path.join(extracted, entry.name), path.join(runtime, entry.name === '拾图.exe' ? 'electron.exe' : entry.name));
  }
  const defaultApp = path.join(extracted, 'resources', 'default_app.asar');
  if (!(await exists(defaultApp))) throw new Error('Bootstrap installer is missing Electron default_app.asar.');
  await copyTree(defaultApp, path.join(runtime, 'resources', 'default_app.asar'));
  console.log(`Build resources restored from ${config.repository}@${config.tag}; checked-out application source was preserved.`);
}

if (require.main === module) restoreBuildResources().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateBootstrap, restoreBuildResources };
