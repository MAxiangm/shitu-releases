'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, exists, resetDistDirectory, installerPath } = require('./release-utils.cjs');
const { createPackage } = require('./package.cjs');
const { createUpdateManifest } = require('./create-update-manifest.cjs');

async function findMakensis() {
  const supplied = process.env.MAKENSIS || (process.env.NSIS_HOME && path.join(process.env.NSIS_HOME, 'makensis.exe'));
  if (supplied) {
    if (!(await exists(supplied))) throw new Error(`Configured NSIS compiler does not exist: ${supplied}`);
    return supplied;
  }
  const candidates = [
    path.join(root, '.recovery', 'tools', 'nsis', 'nsis-3.12', 'makensis.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NSIS', 'makensis.exe'),
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'makensis.exe'))
  ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error('NSIS makensis.exe is not installed. Install NSIS 3, or set MAKENSIS to its full path (or NSIS_HOME to its directory), then run npm run installer again. Nothing was downloaded.');
}

function nsisQuote(value) {
  return String(value).replace(/\$/g, '$$').replace(/"/g, '$\\"').replace(/[\r\n]/g, '');
}

async function writeUninstallList(source, destination) {
  const files = [], directories = [];
  async function visit(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) { await visit(path.join(directory, entry.name), name); directories.push(name); }
      else files.push(name);
    }
  }
  await visit(source);
  const lines = ['; Generated from the release file list; user-created library data is excluded.'];
  for (const file of files) lines.push(`Delete "$INSTDIR\\${nsisQuote(file)}"`);
  for (const directory of directories) lines.push(`RMDir "$INSTDIR\\${nsisQuote(directory)}"`);
  await fs.writeFile(destination, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This recovered installer builder supports Windows only.');
  const compiler = await findMakensis();
  const { project, target } = await createPackage();
  const buildDirectory = path.join(root, 'dist', '.installer-build');
  await resetDistDirectory(buildDirectory);
  const uninstallList = path.join(buildDirectory, 'uninstall-files.nsh');
  await writeUninstallList(target, uninstallList);
  const installerScript = path.join(buildDirectory, 'installer.nsi');
  // A BOM makes Chinese product names independent of the compiler's system locale.
  const template = await fs.readFile(path.join(__dirname, 'installer.nsi'), 'utf8');
  await fs.writeFile(installerScript, `\uFEFF${template.replace(/^\uFEFF/, '')}`, 'utf8');
  const output = installerPath(project);
  const version = `${project.version.split(/[-+]/)[0]}.0`;
  const args = [
    '/V3', `/DPRODUCT_NAME=${project.productName}`, `/DPRODUCT_VERSION=${project.version}`,
    `/DVERSION_QUAD=${version}`, `/DSOURCE_DIR=${target}`, `/DOUTPUT_FILE=${output}`,
    `/DUNINSTALL_LIST=${uninstallList}`, installerScript
  ];
  const result = spawnSync(compiler, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`NSIS compiler exited with code ${result.status}.`);
  const update = await createUpdateManifest({ version: project.version, installer: output, outputDirectory: path.join(root, 'dist') });
  console.log(`Installer ready: ${output}`);
  console.log(`GitHub release files ready: ${update.installerPath}\n${update.manifestPath}`);
}

if (require.main === module) main().catch(error => { console.error(`Installer build failed: ${error.message}`); process.exitCode = 1; });
module.exports = { findMakensis, writeUninstallList };
