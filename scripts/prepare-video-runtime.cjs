'use strict';

const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'video-runtime-manifest.json');

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
    !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..') &&
    !/[:\x00-\x1f]/.test(value);
}

function validateManifest(manifest) {
  const archive = manifest?.archive;
  let url;
  try { url = new URL(archive?.url); } catch { throw new Error('Video runtime archive URL is invalid.'); }
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      !archive || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith('/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-') ||
      !/^[a-f0-9]{64}$/.test(archive.sha256 || '') || !Number.isSafeInteger(archive.size) || archive.size < 1 || archive.size > 256 * 1024 * 1024 ||
      !safeRelative(archive.directory) || archive.directory.includes('/') ||
      !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Video runtime manifest must pin a Windows x64 archive, size and SHA-256.');
  }
  const names = new Set();
  for (const file of manifest.files) {
    if (!safeRelative(file.path) || !safeRelative(file.archivePath) || names.has(file.path.toLowerCase()) ||
        !/^[a-f0-9]{64}$/.test(file.sha256 || '') || !Number.isSafeInteger(file.size) || file.size < 1) {
      throw new Error('Video runtime manifest contains an invalid file.');
    }
    names.add(file.path.toLowerCase());
  }
  if (!names.has('ffmpeg.exe') || !names.has('ffprobe.exe')) throw new Error('Video runtime requires ffmpeg.exe and ffprobe.exe.');
  return manifest;
}

async function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function fileMatches(filename, expected) {
  const stat = await fs.lstat(filename).catch(() => null);
  return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.size === expected.size && await sha256File(filename) === expected.sha256);
}

async function verifyVideoRuntime(directory = path.join(root, 'video-runtime'), suppliedManifest) {
  const manifest = validateManifest(suppliedManifest || JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  for (const file of manifest.files) {
    if (!await fileMatches(path.join(directory, ...file.path.split('/')), file)) {
      throw new Error(`Video runtime file is missing or changed: ${file.path}. Run node scripts/prepare-video-runtime.cjs.`);
    }
  }
  return manifest;
}

async function downloadArchive(manifest, filename) {
  if (await fileMatches(filename, manifest.archive)) return;
  const partial = `${filename}.${crypto.randomUUID()}.partial`;
  try {
    const response = await fetch(manifest.archive.url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`FFmpeg download returned HTTP ${response.status}.`);
    let bytes = 0;
    const digest = crypto.createHash('sha256');
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > manifest.archive.size) return callback(new Error('FFmpeg archive exceeded expected size.'));
      digest.update(chunk); callback(null, chunk);
    } }), createWriteStream(partial, { flags: 'wx' }));
    if (bytes !== manifest.archive.size || digest.digest('hex') !== manifest.archive.sha256) throw new Error('FFmpeg archive SHA-256 or size mismatch.');
    await fs.rm(filename, { force: true });
    await fs.rename(partial, filename);
  } finally { await fs.rm(partial, { force: true }); }
}

function expandArchive(archive, destination) {
  const command = "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory([System.Environment]::GetEnvironmentVariable('SHITU_VIDEO_ARCHIVE'), [System.Environment]::GetEnvironmentVariable('SHITU_VIDEO_DESTINATION'))";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, stdio: 'inherit', timeout: 120000,
    env: { ...process.env, SHITU_VIDEO_ARCHIVE: archive, SHITU_VIDEO_DESTINATION: destination }
  });
  if (result.error || result.status !== 0) throw result.error || new Error(`FFmpeg archive extraction failed: ${result.status}.`);
}

async function assertRealDirectory(directory) {
  const stat = await fs.lstat(directory).catch(() => null);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Refusing a linked or non-directory runtime path: ${directory}`);
}

async function writeRuntimeNotices(destination, manifest) {
  await fs.copyFile(path.join(root, 'docs', 'VIDEO_RUNTIME_LICENSE.md'), path.join(destination, 'SHITU_VIDEO_RUNTIME_NOTICE.md'));
  await fs.copyFile(path.join(root, 'docs', 'ffmpeg', 'COPYING.GPLv3'), path.join(destination, 'COPYING.GPLv3'));
  const configuration = spawnSync(path.join(destination, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (configuration.error || configuration.status !== 0) throw configuration.error || new Error('The verified FFmpeg runtime could not start.');
  await fs.writeFile(path.join(destination, 'build-configuration.txt'), configuration.stdout, 'utf8');
  await fs.writeFile(path.join(destination, 'runtime.json'), `${JSON.stringify({ version: manifest.version, archiveSha256: manifest.archive.sha256, source: manifest.source }, null, 2)}\n`);
}

async function prepareVideoRuntime() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This video runtime supports Windows x64 only.');
  const manifest = validateManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  const destination = path.join(root, 'video-runtime');
  await assertRealDirectory(destination);
  try {
    await verifyVideoRuntime(destination, manifest);
    await writeRuntimeNotices(destination, manifest);
    console.log(`Verified video runtime ${manifest.version}.`);
    return destination;
  } catch { /* Restore a missing or damaged generated runtime from the pinned archive. */ }
  const recovery = path.join(root, '.recovery');
  const downloads = path.join(recovery, 'downloads');
  await assertRealDirectory(recovery);
  await fs.mkdir(downloads, { recursive: true });
  await assertRealDirectory(downloads);
  const archive = path.join(downloads, path.posix.basename(new URL(manifest.archive.url).pathname));
  await downloadArchive(manifest, archive);
  const staging = path.join(recovery, `video-runtime-${crypto.randomUUID()}`);
  await fs.mkdir(staging);
  try {
    expandArchive(archive, staging);
    const unpacked = path.join(staging, manifest.archive.directory);
    await fs.mkdir(destination, { recursive: true });
    for (const file of manifest.files) {
      const source = path.join(unpacked, ...file.archivePath.split('/'));
      if (!await fileMatches(source, file)) throw new Error(`FFmpeg archive file integrity mismatch: ${file.path}.`);
      const target = path.join(destination, ...file.path.split('/'));
      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isSymbolicLink() || existing?.isDirectory()) throw new Error(`Refusing a linked runtime file: ${file.path}.`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    await writeRuntimeNotices(destination, manifest);
    await verifyVideoRuntime(destination, manifest);
    console.log(`Prepared video runtime ${manifest.version}: ${destination}`);
    return destination;
  } finally {
    // staging is a freshly generated direct child of the verified recovery folder.
    if (path.dirname(staging) !== recovery || !path.basename(staging).startsWith('video-runtime-')) throw new Error('Unsafe video staging cleanup path.');
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (require.main === module) prepareVideoRuntime().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareVideoRuntime, verifyVideoRuntime, validateManifest, safeRelative };
