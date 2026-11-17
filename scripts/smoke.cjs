'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { root, electronPath, devApp } = require('./runtime.cjs');
const base = path.join(root, '.recovery', 'tests', `electron-${Date.now()}`);
fs.mkdirSync(base, { recursive: true });
const sharp = require('sharp');
(async () => {
  await sharp({ create: { width: 96, height: 64, channels: 4,
    background: { r: 34, g: 125, b: 190, alpha: 1 } } }).png().toFile(path.join(base, 'sample.png'));
  const env = { ...process.env, SHITU_RECOVERY_SMOKE: '1', SHITU_SMOKE_DIRECTORY: base };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron process timed out')); }, 55000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const resultFile = path.join(base, 'result.json');
  if (!fs.existsSync(resultFile)) throw new Error(`Electron exited ${code} without a result: ${base}`);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  console.log(JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  fs.mkdirSync(path.join(root, '.recovery', 'reports'), { recursive: true });
  fs.copyFileSync(resultFile, path.join(root, '.recovery', 'reports', 'smoke.json'));
  if (result.ok && code === 0) {
    fs.copyFileSync(path.join(base, 'screenshot.png'), path.join(root, '.recovery', 'reports', 'smoke.png'));
  } else process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
