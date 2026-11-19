'use strict';

// Rebuild a portable application using the preserved Electron runtime.
const fs = require('node:fs/promises');
const path = require('node:path');
const { root, recoveredRuntime, installedExecutable, inside, exists, readProject, resetDistDirectory, copyTree, assertNoLinks, packagePath } = require('./release-utils.cjs');
const { verifyVideoRuntime } = require('./prepare-video-runtime.cjs');
const { verifyYouTubeRuntime } = require('./prepare-youtube-runtime.cjs');
const { brandWindowsExecutable } = require('./brand-windows-executable.cjs');

async function findDependency(name, from) {
  if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error(`Invalid dependency name: ${name}`);
  let current = from;
  while (current === root || inside(root, current)) {
    const candidate = path.join(current, 'node_modules', ...name.split('/'));
    if (await exists(path.join(candidate, 'package.json'))) return candidate;
    if (current === root) break;
    current = path.dirname(current);
  }
  return null;
}

async function copyProductionDependencies(project, appDirectory) {
  const visited = new Set();
  async function visit(name, from, optional = false) {
    const source = await findDependency(name, from);
    if (!source) {
      if (optional) return;
      throw new Error(`Required production dependency is missing: ${name}. Restore node_modules or install dependencies before packaging.`);
    }
    if (visited.has(source)) return;
    visited.add(source);
    const relative = path.relative(root, source);
    if (!relative.startsWith(`node_modules${path.sep}`)) throw new Error(`Dependency is outside node_modules: ${source}`);
    await copyTree(source, path.join(appDirectory, relative));
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    for (const child of Object.keys(manifest.dependencies || {})) await visit(child, source);
    for (const child of Object.keys(manifest.optionalDependencies || {})) await visit(child, source, true);
  }
  for (const name of Object.keys(project.dependencies || {})) await visit(name, root);
  for (const name of Object.keys(project.optionalDependencies || {})) await visit(name, root, true);
  return visited.size;
}

async function normalizeBundledAiMarkers(appDirectory) {
  const manifest = JSON.parse(await fs.readFile(path.join(appDirectory, 'src', 'ai-runtime-manifest.json'), 'utf8'));
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) throw new Error('Bundled AI manifest version is invalid.');
  for (const name of ['cutout', 'upscale']) {
    const markerPath = path.join(appDirectory, 'ai-runtime', name, 'installed.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (marker.version !== manifest.version) throw new Error(`Bundled AI ${name} marker does not match the resource manifest.`);
    // Resource availability belongs in the bundle; install timestamps and GPU
    // probes belong to the recipient's own first-time installation.
    await fs.writeFile(markerPath, `${JSON.stringify({ version: manifest.version }, null, 2)}\n`);
  }
}

async function copyApplicationSource(source, destination) {
  await assertNoLinks(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const nativeSource = path.join(source, 'video-auth-native');
  await fs.cp(source, destination, { recursive: true, errorOnExist: false, force: true,
    filter(file) {
      const relative = path.relative(nativeSource, file);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
      // The helper is rebuilt from these top-level sources at runtime. Never
      // ship a stale local binary, symbols, or build output beside the sources.
      return path.basename(relative) === relative && /^[A-Za-z0-9_.-]+\.cs$/i.test(relative);
    }
  });
}

async function createPackage() {
  const project = await readProject();
  await verifyVideoRuntime();
  await verifyYouTubeRuntime();
  const electronVersion = (await fs.readFile(path.join(recoveredRuntime, 'version'), 'utf8').catch(() => '')).trim();
  if (!electronVersion || !(await exists(path.join(recoveredRuntime, '拾图.exe')))) {
    throw new Error('Recovered Electron runtime is missing. Keep .recovery/extracted-0.10.7 from the original installer.');
  }
  if (project.devDependencies?.electron !== electronVersion) {
    throw new Error(`The preserved runtime is Electron ${electronVersion}; package.json requests ${project.devDependencies?.electron}. Update this release script and runtime together before changing Electron.`);
  }
  for (const required of ['src/main.cjs', 'src/video-site-auth.cjs', 'src/video-auth-native/Program.cs',
    'src/video-auth-native/YouTubeConnection.cs', 'assets/icon.ico', 'ai-runtime/cutout/installed.json', 'ai-runtime/upscale/installed.json', 'extension/manifest.json']) {
    if (!(await exists(path.join(root, required)))) throw new Error(`Required release file is missing: ${required}`);
  }
  const target = packagePath(project);
  await resetDistDirectory(target);
  const excluded = new Set(['$PLUGINSDIR', 'resources', 'Chrome扩展', installedExecutable, '卸载拾图.exe', 'README.md', '使用说明.md', '安装指南.html']);
  for (const entry of await fs.readdir(recoveredRuntime, { withFileTypes: true })) {
    if (!excluded.has(entry.name)) await copyTree(path.join(recoveredRuntime, entry.name), path.join(target, entry.name));
  }
  const executable = path.join(target, installedExecutable);
  await copyTree(path.join(recoveredRuntime, '拾图.exe'), executable);
  await brandWindowsExecutable(executable, path.join(root, 'assets', 'icon.ico'), { ...project, executableName: installedExecutable });
  const appDirectory = path.join(target, 'resources', 'app');
  await fs.mkdir(appDirectory, { recursive: true });
  // Retain Electron's default app so the first public installer can bootstrap CI.
  if (await exists(path.join(recoveredRuntime, 'resources', 'default_app.asar'))) {
    await copyTree(path.join(recoveredRuntime, 'resources', 'default_app.asar'), path.join(target, 'resources', 'default_app.asar'));
  }
  await copyApplicationSource(path.join(root, 'src'), path.join(appDirectory, 'src'));
  for (const directory of ['assets', 'ai-runtime', 'video-runtime']) await copyTree(path.join(root, directory), path.join(appDirectory, directory));
  await normalizeBundledAiMarkers(appDirectory);
  const updateConfig = JSON.parse(await fs.readFile(path.join(root, 'update-config.json'), 'utf8'));
  if (updateConfig.repository !== '' && !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(updateConfig.repository || '')) {
    throw new Error('update-config.json repository must be empty or owner/repo.');
  }
  await fs.writeFile(path.join(appDirectory, 'update-config.json'), `${JSON.stringify(updateConfig, null, 2)}\n`);
  await copyTree(path.join(root, 'extension'), path.join(target, 'Chrome扩展'));
  const dependencyCount = await copyProductionDependencies(project, appDirectory);
  const productionManifest = {};
  for (const key of ['name', 'productName', 'version', 'description', 'main', 'private', 'dependencies', 'optionalDependencies']) {
    if (project[key] !== undefined) productionManifest[key] = project[key];
  }
  await fs.writeFile(path.join(appDirectory, 'package.json'), `${JSON.stringify(productionManifest, null, 2)}\n`);
  // Preserve bundled end-user documentation without including development files or data.
  for (const name of ['使用说明.md', '安装指南.html']) {
    if (await exists(path.join(recoveredRuntime, name))) await copyTree(path.join(recoveredRuntime, name), path.join(target, name));
  }
  console.log(`Portable release ready: ${target}\nElectron ${electronVersion}; ${dependencyCount} production dependency packages copied.`);
  return { project, target };
}

if (require.main === module) createPackage().catch(error => { console.error(`Packaging failed: ${error.message}`); process.exitCode = 1; });
module.exports = { createPackage, normalizeBundledAiMarkers, copyApplicationSource };
