'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath, devApp } = require('./runtime.cjs');

(async () => {
  const testsRoot = path.join(root, '.recovery', 'tests');
  await fs.mkdir(testsRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testsRoot, 'folders-electron-'));
  const sourceDirectory = path.join(base, 'source'); await fs.mkdir(sourceDirectory);
  const samples = [];
  const names = ['父级样图', '子级样图', '三级样图', '其他项目样图', '待整理样图'];
  const colors = ['#7852bb', '#2c9c70', '#ba7630', '#326dac', '#ad375a'];
  for (let index = 0; index < names.length; index++) {
    const filename = path.join(sourceDirectory, names[index] + '.png');
    const bytes = await sharp({ create: { width: 48 + index, height: 36 + index, channels: 4, background: colors[index] } }).png().toBuffer();
    await fs.writeFile(filename, bytes);
    samples.push({ name: names[index], filename, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const fixture = { token: crypto.randomUUID(), samples, backupDirectory: path.join(base, 'backups') };
  await fs.writeFile(path.join(base, 'folder-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_FOLDER_SMOKE: '1', SHITU_FOLDER_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SHITU_AE_SMOKE', 'SHITU_VIDEO_SMOKE', 'SHITU_UPDATE_SMOKE', 'SHITU_RECOVERY_SMOKE', 'SHITU_MODEL_SMOKE']) delete env[key];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Folder UI smoke timed out: ${base}`)); }, 90000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'folders-smoke.json'), JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  console.log(JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
