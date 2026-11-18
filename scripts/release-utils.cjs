'use strict';

// Recovery implementation: these scripts were not present in the installer.
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const recoveredRuntime = path.join(root, '.recovery', 'extracted-0.10.7');
// Existing installations, pinned Windows shortcuts and the in-app updater
// address this filename. Use productName for the brand shown to users.
const installedExecutable = '拾图.exe';

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function readProject() {
  const project = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(project.version || '')) {
    throw new Error('package.json version must be a valid release version, for example 0.10.8.');
  }
  const productName = project.productName || project.name;
  if (typeof productName !== 'string' || !productName.trim() || /[<>:"/\\|?*\x00-\x1f$]/.test(productName)) {
    throw new Error('package.json productName is not a safe Windows filename.');
  }
  return { ...project, productName };
}

async function assertNoLinks(target) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to copy or remove a linked path: ${target}`);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) await assertNoLinks(path.join(target, entry));
  }
}

async function resetDistDirectory(target) {
  target = path.resolve(target);
  if (!inside(dist, target)) throw new Error(`Refusing to clean outside this project's dist directory: ${target}`);
  // Check every existing ancestor too: a junction must not redirect dist elsewhere.
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    if (await exists(current) && (await fs.lstat(current)).isSymbolicLink()) {
      throw new Error(`Refusing a linked output directory: ${current}`);
    }
  }
  if (await exists(target)) {
    await assertNoLinks(target);
    await fs.rm(target, { recursive: true, force: true });
  }
  await fs.mkdir(target, { recursive: true });
}

async function copyTree(source, destination) {
  await assertNoLinks(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, errorOnExist: false, force: true });
}

function packagePath(project) {
  return path.join(dist, `${project.productName}-${project.version}-win-x64`);
}

function installerPath(project) {
  return path.join(dist, `${project.productName}-${project.version}-Setup.exe`);
}

module.exports = { root, dist, recoveredRuntime, installedExecutable, inside, exists, readProject, assertNoLinks, resetDistDirectory, copyTree, packagePath, installerPath };
