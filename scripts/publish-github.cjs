'use strict';

// Publishes release binaries only. Credentials stay in gh or environment variables.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
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

function command(cli, args) {
  const result = spawnSync(cli, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh command failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

async function publishWithGh({ repository, tag, title, notes, files, publish, cli }) {
  const repo = JSON.parse(command(cli, ['api', `repos/${repository}`]));
  if (repo.private) throw new Error('Automatic updates require a public release repository; this repository is private.');
  const existing = spawnSync(cli, ['release', 'view', tag, '--repo', repository, '--json', 'id'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (existing.status === 0) throw new Error(`Release ${tag} already exists. Use a new project version; published assets will not be replaced.`);
  const noteDirectory = path.join(root, '.recovery', 'release');
  await fs.mkdir(noteDirectory, { recursive: true });
  const noteFile = path.join(noteDirectory, `${tag}-notes.md`);
  await fs.writeFile(noteFile, notes);
  const created = command(cli, ['release', 'create', tag, ...files, '--repo', repository, '--title', title, '--notes-file', noteFile, '--draft']);
  if (publish) command(cli, ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
  return publish ? `https://github.com/${repository}/releases/tag/${tag}` : created;
}

async function publishWithToken({ repository, tag, title, notes, files, publish, token }) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Shitu-Release-Publisher' };
  async function api(endpoint, method = 'GET', body, allowMissing = false) {
    const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
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
  // Always upload into a draft first so clients cannot observe a half-uploaded release.
  const release = await api('/releases', 'POST', { tag_name: tag, name: title, body: notes, draft: true, prerelease: false });
  for (const file of files) {
    const stat = await fs.stat(file);
    const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(path.basename(file))}`, {
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
  if (publish) await api(`/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'true' });
  return release.html_url;
}

async function main(args = process.argv.slice(2)) {
  let publish = false;
  let noteFile;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--publish') publish = true;
    else if (args[index] === '--notes-file' && args[index + 1]) noteFile = path.resolve(args[++index]);
    else throw new Error('Usage: node scripts/publish-github.cjs [--publish] [--notes-file release-notes.md]');
  }
  const project = await readProject();
  const config = JSON.parse(await fs.readFile(path.join(root, 'update-config.json'), 'utf8'));
  const repository = validateRepository(config.repository);
  const release = await validateReleaseFiles(project.version, path.join(root, 'dist'));
  const options = { repository, tag: `v${project.version}`, title: `${project.productName} v${project.version}`,
    notes: noteFile ? await fs.readFile(noteFile, 'utf8') : `拾图 ${project.version}\n\nWindows x64 安装包。已有自动更新版用户可在应用内更新。`,
    files: [release.installer, release.manifestPath], publish };
  const cli = findGitHubCli();
  let url;
  if (cli) url = await publishWithGh({ ...options, cli });
  else {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) throw new Error('Authenticate gh, or provide GH_TOKEN in this process environment. Credentials are never written to the app.');
    url = await publishWithToken({ ...options, token });
  }
  console.log(`${publish ? 'Published' : 'Draft ready'}: ${url}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateRepository, validateReleaseFiles, findGitHubCli, publishWithToken, main };
