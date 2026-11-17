'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function electronPath() {
  if (process.env.SHITU_ELECTRON) {
    const file = path.resolve(process.env.SHITU_ELECTRON);
    if (!fs.existsSync(file)) throw new Error(`SHITU_ELECTRON does not exist: ${file}`);
    return file;
  }
  try {
    const file = require('electron');
    if (typeof file === 'string' && fs.existsSync(file)) return file;
  } catch {}
  const file = path.join(root, '.recovery', 'runtime', 'electron.exe');
  if (fs.existsSync(file)) return file;
  throw new Error('Electron is missing. Restore .recovery/runtime or install the package.json dependencies.');
}

function devApp() {
  const directory = path.join(root, '.recovery', 'dev-app');
  fs.mkdirSync(directory, { recursive: true });
  const project = require(path.join(root, 'package.json'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'shitu-development', version: project.version,
    main: '../../scripts/dev-bootstrap.cjs', private: true
  }, null, 2) + '\n');
  return directory;
}

module.exports = { root, electronPath, devApp };
