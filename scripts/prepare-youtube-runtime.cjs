'use strict';

const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'youtube-runtime-manifest.json');
const notices = ['YOUTUBE_RUNTIME_NOTICE.md', 'yt-dlp-LICENSE.txt', 'yt-dlp-THIRD_PARTY_LICENSES.txt', 'deno-LICENSE.md'];

function validateYouTubeManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      !Array.isArray(manifest.components) || manifest.components.length !== 2) throw new Error('YouTube runtime must pin Windows x64 yt-dlp and Deno.');
  const names = new Set();
  for (const item of manifest.components) {
    let url;
    try { url = new URL(item.url); } catch { throw new Error('Invalid YouTube runtime download URL.'); }
    const expected = item.name === 'yt-dlp' ? `/yt-dlp/yt-dlp/releases/download/${item.version}/yt-dlp.exe`
      : item.name === 'deno' ? `/denoland/deno/releases/download/v${item.version}/deno-x86_64-pc-windows-msvc.zip` : null;
    if (!expected || names.has(item.name) || typeof item.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(item.version) ||
        url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash ||
        url.pathname !== expected || !/^[a-f0-9]{64}$/.test(item.sha256 || '') ||
        !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 256 * 1024 * 1024 ||
        item.file?.path !== `${item.name === 'yt-dlp' ? 'yt-dlp' : 'deno'}.exe` ||
        !/^[a-f0-9]{64}$/.test(item.file.sha256 || '') || !Number.isSafeInteger(item.file.size) ||
        item.file.size < 1 || item.file.size > 512 * 1024 * 1024 ||
        (item.name === 'yt-dlp' && (item.file.size !== item.size || item.file.sha256 !== item.sha256))) {
      throw new Error('YouTube runtime manifest contains an invalid or unpinned dependency.');
    }
    names.add(item.name);
  }
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

async function verifyYouTubeRuntime(directory = path.join(root, 'video-runtime', 'youtube'), suppliedManifest) {
  const manifest = validateYouTubeManifest(suppliedManifest || JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  for (const item of manifest.components) {
    if (!await fileMatches(path.join(directory, item.file.path), item.file)) {
      throw new Error(`YouTube runtime file is missing or changed: ${item.file.path}. Run node scripts/prepare-youtube-runtime.cjs.`);
    }
  }
  return manifest;
}

async function assertRealDirectory(directory) {
  const stat = await fs.lstat(directory).catch(() => null);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Refusing a linked or non-directory runtime path: ${directory}`);
}

async function downloadDependency(item, target) {
  if (await fileMatches(target, item)) return;
  const existing = await fs.lstat(target).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Refusing a linked dependency download.');
  const partial = `${target}.${crypto.randomUUID()}.partial`;
  try {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`${item.name} download returned HTTP ${response.status}.`);
    let bytes = 0;
    const digest = crypto.createHash('sha256');
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > item.size) return callback(new Error(`${item.name} exceeded its pinned download size.`));
      digest.update(chunk); callback(null, chunk);
    } }), createWriteStream(partial, { flags: 'wx' }));
    if (bytes !== item.size || digest.digest('hex') !== item.sha256) throw new Error(`${item.name} download SHA-256 or size mismatch.`);
    await fs.rm(target, { force: true });
    await fs.rename(partial, target);
  } finally { await fs.rm(partial, { force: true }); }
}

function extractDeno(archive, target) {
  // Extract one fixed entry; archive paths never decide output paths.
  const command = "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead([Environment]::GetEnvironmentVariable('SHITU_YOUTUBE_ARCHIVE')); try { $entry = $zip.GetEntry('deno.exe'); if ($null -eq $entry) { throw 'Deno archive is missing deno.exe' }; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, [Environment]::GetEnvironmentVariable('SHITU_YOUTUBE_TARGET'), $false) } finally { $zip.Dispose() }";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, stdio: 'inherit', timeout: 120000,
    env: { ...process.env, SHITU_YOUTUBE_ARCHIVE: archive, SHITU_YOUTUBE_TARGET: target }
  });
  if (result.error || result.status !== 0) throw result.error || new Error('Unable to extract the verified Deno archive.');
}

async function writeRuntimeNotices(destination, manifest) {
  for (const notice of notices) await fs.copyFile(path.join(root, 'docs', 'youtube', notice), path.join(destination, notice));
  await fs.writeFile(path.join(destination, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function prepareYouTubeRuntime() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This YouTube runtime supports Windows x64 only.');
  const manifest = validateYouTubeManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  const videoRoot = path.join(root, 'video-runtime');
  const destination = path.join(videoRoot, 'youtube');
  await assertRealDirectory(videoRoot);
  await assertRealDirectory(destination);
  try {
    await verifyYouTubeRuntime(destination, manifest);
    await writeRuntimeNotices(destination, manifest);
    console.log('Verified YouTube runtime (yt-dlp and Deno).');
    return destination;
  } catch { /* Repair only the generated dependency files from pinned official releases. */ }
  const recovery = path.join(root, '.recovery');
  const downloads = path.join(recovery, 'downloads');
  await assertRealDirectory(recovery);
  await assertRealDirectory(downloads);
  await fs.mkdir(downloads, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  const staging = await fs.mkdtemp(path.join(recovery, 'youtube-runtime-'));
  try {
    for (const item of manifest.components) {
      const downloaded = path.join(downloads, item.name === 'yt-dlp' ? `yt-dlp-${item.version}.exe` : `deno-${item.version}-windows-x64.zip`);
      await downloadDependency(item, downloaded);
      const stagedFile = path.join(staging, item.file.path);
      if (item.name === 'deno') extractDeno(downloaded, stagedFile);
      else await fs.copyFile(downloaded, stagedFile);
      if (!await fileMatches(stagedFile, item.file)) throw new Error(`${item.file.path} extracted file integrity mismatch.`);
      const target = path.join(destination, item.file.path);
      const existing = await fs.lstat(target).catch(() => null);
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Refusing a linked runtime file: ${item.file.path}.`);
      await fs.copyFile(stagedFile, target);
    }
    await writeRuntimeNotices(destination, manifest);
    await verifyYouTubeRuntime(destination, manifest);
    for (const item of manifest.components) {
      const result = spawnSync(path.join(destination, item.file.path), ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
      if (result.error || result.status !== 0 || !result.stdout.includes(item.version)) throw result.error || new Error(`The verified ${item.name} runtime could not start.`);
    }
    console.log(`Prepared YouTube runtime: ${destination}`);
    return destination;
  } finally {
    if (path.dirname(staging) !== recovery || !path.basename(staging).startsWith('youtube-runtime-')) throw new Error('Unsafe YouTube staging cleanup path.');
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (require.main === module) prepareYouTubeRuntime().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareYouTubeRuntime, verifyYouTubeRuntime, validateYouTubeManifest };
