'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath, devApp } = require('./runtime.cjs');

async function run() {
  if (process.platform !== 'win32') {
    console.log('Window header smoke is intended for Windows.');
    return;
  }
  const tests = path.join(root, '.recovery', 'tests');
  await fs.mkdir(tests, { recursive: true });
  const base = await fs.mkdtemp(path.join(tests, 'window-header-electron-'));
  const sample = path.join(base, 'Caption sample.png');
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#2676e5' } }).png().toFile(sample);
  const fixture = { token: randomUUID(), sample };
  await fs.writeFile(path.join(base, 'window-header-smoke-fixture.json'), JSON.stringify(fixture));

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^SHITU_.*SMOKE/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  Object.assign(env, { SHITU_WINDOW_HEADER_SMOKE: '1', SHITU_WINDOW_HEADER_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base });
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Window header smoke timed out: ${base}`));
    }, 120000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  const report = { ...result, reportDirectory: base };
  const reports = path.join(root, '.recovery', 'reports');
  await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'window-header-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
}

run().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
