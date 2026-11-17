'use strict';

// Publishes release binaries only. Credentials stay in gh or environment variables.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { root, readProject } = require('./release-utils.cjs');
const { assertReleaseVersion, sha256File } = require('./create-update-manifest.cjs');

function validateRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) || repository.endsWith('/.') || repository.endsWith('/..')) {
    throw new Error('Set update-config.json repository to a public GitHub owner/repo first.');
  }
  return repository;
}

async function validateReleaseFiles(version, directory) {
  assertReleaseVersion(version);
  const manifestPath = path.join(directory, 'shitu-update.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const name = `shitu-${version}-setup.exe`;
  if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      manifest.installer?.name !== name || !/^[a-f0-9]{64}$/.test(manifest.installer?.sha256 || '')) {
    throw new Error('Update manifest does not match this project version and Windows x64 installer. Build the installer again.');
  }
  const installer = path.join(directory, name);
  const stat = await fs.stat(installer);
  if (!stat.isFile() || stat.size !== manifest.installer.size || await sha256File(installer) !== manifest.installer.sha256) {
    throw new Error('Installer size or SHA-256 no longer matches the update manifest. Build the installer again.');
  }
  return { manifest, manifestPath, installer };
}

function findGitHubCli() {
  const candidates = [process.env.GH_PATH, path.join(root, '.recovery', 'tools', 'gh', 'unpacked', 'bin', 'gh.exe')].filter(Boolean);
  for (const candidate of candidates) if (require('node:fs').existsSync(candidate)) return candidate;
  const probe = spawnSync('gh', ['--version'], { windowsHide: true, stdio: 'ignore' });
  return !probe.error && probe.status === 0 ? 'gh' : null;
}

function command(cli, args, { allowMissing = false } = {}) {
  const result = spawnSync(cli, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing && /HTTP 404/.test(result.stderr || '')) return null;
    throw new Error(`gh command failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function targetSHA(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) throw new Error('--target must be a full Git commit SHA.');
  return value.toLowerCase();
}
async function localAssets(files) {
  return Promise.all(files.map(async file => ({ name: path.basename(file), size: (await fs.stat(file)).size, sha256: await sha256File(file) })));
}
function validateUploadedAssets(release, expected, { tag, draft } = {}) {
  if (!release || release.tag_name !== tag || release.draft !== draft || release.prerelease || !Array.isArray(release.assets)) throw new Error('GitHub release state does not match the requested version.');
  for (const wanted of expected) {
    const matches = release.assets.filter(asset => asset.name === wanted.name);
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== wanted.size || matches[0].digest !== `sha256:${wanted.sha256}`) {
      throw new Error(`GitHub attachment ${wanted.name} is missing, incomplete, or has a different size/SHA-256.`);
    }
  }
}
async function publishWithGh({ repository, tag, title, notes, files, publish, cli, target, run = command,
  noteDirectory = path.join(root, '.recovery', 'release') }) {
  target = targetSHA(target);
  const repo = JSON.parse(run(cli, ['api', `repos/${repository}`]));
  if (repo.private) throw new Error('Automatic updates require a public release repository; this repository is private.');
  const existing = run(cli, ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`], { allowMissing: true });
  if (existing !== null) throw new Error(`Release ${tag} already exists. Published assets will not be replaced; use --verify-only to check an existing publication.`);
  if (JSON.parse(run(cli, ['api', `repos/${repository}/commits/${target}`])).sha !== target) throw new Error('The target commit is not present in the remote repository. Push the source commit first.');
  const priorRef = run(cli, ['api', `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`], { allowMissing: true });
  if (priorRef !== null && JSON.parse(run(cli, ['api', `repos/${repository}/commits/${encodeURIComponent(tag)}`])).sha !== target) throw new Error('The existing Git tag points to a different source commit. Use a new version.');
  await fs.mkdir(noteDirectory, { recursive: true });
  const noteFile = path.join(noteDirectory, `${tag}-notes.md`);
  await fs.writeFile(noteFile, notes);
  const expected = await localAssets(files);
  const created = run(cli, ['release', 'create', tag, ...files, '--repo', repository, '--target', target, '--title', title, '--notes-file', noteFile, '--draft']);
  const draft = JSON.parse(run(cli, ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`]));
  validateUploadedAssets(draft, expected, { tag, draft: true });
  if (publish) run(cli, ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
  return publish ? `https://github.com/${repository}/releases/tag/${tag}` : created;
}

async function publishWithToken({ repository, tag, title, notes, files, publish, token, target, fetchImpl = globalThis.fetch }) {
  target = targetSHA(target);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Shitu-Release-Publisher' };
  async function api(endpoint, method = 'GET', body, allowMissing = false) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${endpoint}`, {
      method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(60000)
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status} for ${method} ${endpoint || '/repository'}.`);
    return response.json();
  }
  const repo = await api('');
  if (repo.private) throw new Error('Automatic updates require a public release repository; this repository is private.');
  if (await api(`/releases/tags/${encodeURIComponent(tag)}`, 'GET', undefined, true)) {
    throw new Error(`Release ${tag} already exists. Use a new project version; published assets will not be replaced.`);
  }
  if ((await api(`/commits/${target}`)).sha !== target) throw new Error('The target commit is not present in the remote repository. Push the source commit first.');
  const priorRef = await api(`/git/ref/tags/${encodeURIComponent(tag)}`, 'GET', undefined, true);
  if (priorRef && (await api(`/commits/${encodeURIComponent(tag)}`)).sha !== target) throw new Error('The existing Git tag points to a different source commit. Use a new version.');
  // Always upload into a draft first so clients cannot observe a half-uploaded release.
  const expected = await localAssets(files);
  const release = await api('/releases', 'POST', { tag_name: tag, target_commitish: target, name: title, body: notes, draft: true, prerelease: false });
  for (const file of files) {
    const stat = await fs.stat(file);
    const response = await fetchImpl(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(path.basename(file))}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'Content-Length': String(stat.size) }, body: createReadStream(file), duplex: 'half', redirect: 'error',
      signal: AbortSignal.timeout(30 * 60 * 1000)
    });
    if (!response.ok) throw new Error(`GitHub upload failed with HTTP ${response.status}; the release remains a draft.`);
    const asset = await response.json();
    if (asset.size !== stat.size) throw new Error('Uploaded asset size mismatch; the release remains a draft.');
    if (asset.digest && asset.digest !== `sha256:${await sha256File(file)}`) {
      throw new Error('Uploaded asset SHA-256 mismatch; the release remains a draft.');
    }
  }
  validateUploadedAssets(await api(`/releases/${release.id}`), expected, { tag, draft: true });
  if (publish) await api(`/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'true' });
  return release.html_url;
}

async function verifyPublishedRelease({ repository, tag, files, fetchImpl = globalThis.fetch, attempts = 6,
  delayMs = 2500, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  validateRepository(repository);
  const version = typeof tag === 'string' ? tag.replace(/^v/, '') : ''; assertReleaseVersion(version);
  const expected = await localAssets(files);
  const manifestAsset = expected.find(asset => asset.name === 'shitu-update.json');
  if (!manifestAsset) throw new Error('Public verification requires the local shitu-update.json.');
  const allowed = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  function trusted(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !allowed.has(url.hostname) || url.username || url.password || url.port || url.hash) throw new Error('Public verification encountered an untrusted GitHub redirect.');
    return url;
  }
  async function read(url, limit) {
    let address = trusted(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetchImpl(address.href, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30000),
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store, max-age=0', Pragma: 'no-cache', 'User-Agent': 'Shitu-Public-Release-Verification' } });
      if (response.url) trusted(response.url);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || redirects === 5) throw new Error('Public verification exceeded the redirect limit.');
        address = trusted(new URL(location, address).href); continue;
      }
      if (!response.ok || !response.body) throw new Error(`Public verification returned HTTP ${response.status}.`);
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw new Error('Public verification metadata exceeds the size limit.'); chunks.push(Buffer.from(chunk)); }
      const buffer = Buffer.concat(chunks); return { value: JSON.parse(buffer.toString('utf8')), sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
    }
    throw new Error('Public verification exceeded the redirect limit.');
  }
  let lastError;
  for (let index = 0; index < Math.max(1, Math.min(10, attempts)); index++) {
    try {
      const latest = (await read(`https://api.github.com/repos/${repository}/releases/latest?shitu_verify=${crypto.randomUUID()}`, 1024 * 1024)).value;
      validateUploadedAssets(latest, expected, { tag, draft: false });
      const asset = latest.assets.find(item => item.name === 'shitu-update.json');
      const exact = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/shitu-update.json`;
      if (asset.browser_download_url !== exact) throw new Error('Public update manifest URL does not match this repository and version.');
      for (const wanted of expected) {
        const published = latest.assets.find(item => item.name === wanted.name);
        if (published.browser_download_url !== `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(wanted.name)}`) throw new Error('Public release attachment URL is invalid.');
      }
      const downloaded = await read(`${exact}?shitu_verify=${crypto.randomUUID()}`, 64 * 1024);
      if (downloaded.sha256 !== manifestAsset.sha256 || downloaded.value.version !== version) throw new Error('The public update manifest does not match the local verified release.');
      return { url: `https://github.com/${repository}/releases/tag/${tag}`, tag, verified: true };
    } catch (error) { lastError = error; }
    if (index + 1 < Math.max(1, Math.min(10, attempts))) await sleep(delayMs);
  }
  const error = new Error(`Release ${tag} has been published, but anonymous latest/manifest verification failed: ${lastError?.message}. Do not publish it again; run --verify-only after checking GitHub/network.`);
  error.published = true; throw error;
}

async function main(args = process.argv.slice(2)) {
  let publish = false;
  let noteFile;
  let target, verifyOnly = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--publish') publish = true;
    else if (args[index] === '--notes-file' && args[index + 1]) noteFile = path.resolve(args[++index]);
    else if (args[index] === '--target' && args[index + 1]) target = targetSHA(args[++index]);
    else if (args[index] === '--verify-only') verifyOnly = true;
    else throw new Error('Usage: node scripts/publish-github.cjs [--publish | --verify-only] [--target full-commit-SHA] [--notes-file release-notes.md]');
  }
  const project = await readProject();
  const config = JSON.parse(await fs.readFile(path.join(root, 'update-config.json'), 'utf8'));
  const repository = validateRepository(config.repository);
  const release = await validateReleaseFiles(project.version, path.join(root, 'dist'));
  if (publish && verifyOnly) throw new Error('Choose --publish or --verify-only.');
  if (!target) {
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (revision.error || revision.status !== 0) throw new Error('Cannot determine the source commit; pass --target with a full pushed commit SHA.');
    target = targetSHA(revision.stdout.trim());
  }
  const options = { repository, tag: `v${project.version}`, title: `${project.productName} v${project.version}`,
    notes: noteFile ? await fs.readFile(noteFile, 'utf8') : `拾图 ${project.version}\n\nWindows x64 安装包。已有自动更新版用户可在应用内更新。`,
    files: [release.installer, release.manifestPath], publish, target };
  if (verifyOnly) { console.log(`Public release verified: ${(await verifyPublishedRelease(options)).url}`); return; }
  const cli = findGitHubCli();
  let url;
  if (cli) url = await publishWithGh({ ...options, cli });
  else {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) throw new Error('Authenticate gh, or provide GH_TOKEN in this process environment. Credentials are never written to the app.');
    url = await publishWithToken({ ...options, token });
  }
  if (publish) await verifyPublishedRelease(options);
  console.log(`${publish ? 'Published' : 'Draft ready'}: ${url}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateRepository, validateReleaseFiles, findGitHubCli, targetSHA, validateUploadedAssets,
  publishWithGh, publishWithToken, verifyPublishedRelease, main };
