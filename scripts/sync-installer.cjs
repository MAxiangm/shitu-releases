'use strict';

// Publishing requires an explicit destination; no path from the old PC is assumed.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readProject, installerPath, exists } = require('./release-utils.cjs');

async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  let destination;
  if (args.length === 2 && args[0] === '--destination') destination = args[1];
  else if (args.length === 1 && !args[0].startsWith('-')) destination = args[0];
  else if (args.length) throw new Error('Usage: npm run sync:installer -- --destination "D:\\your-release-folder"');
  destination ||= process.env.SHITU_INSTALLER_DEST;
  if (!destination) throw new Error('No destination configured. Pass --destination "D:\\your-release-folder" or set SHITU_INSTALLER_DEST explicitly. No old-PC path is used.');
  if (!path.isAbsolute(destination)) throw new Error('The installer destination must be an absolute directory path.');
  const project = await readProject();
  const source = installerPath(project);
  if (!(await exists(source))) throw new Error(`Installer not found: ${source}. Run npm run installer first.`);
  await fs.mkdir(destination, { recursive: true });
  const target = path.join(destination, path.basename(source));
  if (path.resolve(target).toLowerCase() === path.resolve(source).toLowerCase()) throw new Error('Source and destination refer to the same installer.');
  const sourceHash = await hash(source);
  if (await exists(target)) {
    if (await hash(target) === sourceHash) { console.log(`Already synchronized: ${target}`); return; }
    throw new Error(`Destination already contains a different installer: ${target}. Move it aside or choose another destination; it will not be overwritten.`);
  }
  await fs.copyFile(source, target, require('node:fs').constants.COPYFILE_EXCL);
  if (await hash(target) !== sourceHash) throw new Error(`Copied installer failed SHA-256 verification: ${target}`);
  console.log(`Installer synchronized: ${target}\nSHA-256: ${sourceHash}`);
}

if (require.main === module) main().catch(error => { console.error(`Installer sync failed: ${error.message}`); process.exitCode = 1; });
