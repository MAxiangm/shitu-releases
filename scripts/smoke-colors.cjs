'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath, devApp } = require('./runtime.cjs');

(async () => {
  const testsRoot = path.join(root, '.recovery', 'tests'); await fs.mkdir(testsRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testsRoot, 'colors-electron-'));
  const sourceDirectory = path.join(base, 'source'); await fs.mkdir(sourceDirectory);
  const samples = [];
  for (const [index, color] of ['#314954', '#615040', '#424766'].entries()) {
    const filename = path.join(sourceDirectory, `颜色样图-${index + 1}.png`);
    const bytes = await sharp({ create: { width: 52 + index, height: 40 + index, channels: 4, background: color } }).png().toBuffer();
    await fs.writeFile(filename, bytes);
    samples.push({ filename, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const fixture = { token: crypto.randomUUID(), samples, backupDirectory: path.join(base, 'backups') };
  await fs.writeFile(path.join(base, 'color-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_COLORS_SMOKE: '1', SHITU_COLORS_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SHITU_AE_SMOKE', 'SHITU_VIDEO_SMOKE', 'SHITU_UPDATE_SMOKE', 'SHITU_RECOVERY_SMOKE', 'SHITU_MODEL_SMOKE', 'SHITU_FOLDER_SMOKE']) delete env[key];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Color UI smoke timed out: ${base}`)); }, 90000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  const report = { ...result, reportDirectory: base };
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'colors-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
