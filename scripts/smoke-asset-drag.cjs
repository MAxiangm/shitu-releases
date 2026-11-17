'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath, devApp } = require('./runtime.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  const testsRoot = path.join(root, '.recovery', 'tests'); await fs.mkdir(testsRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testsRoot, 'asset-drag-electron-'));
  const source = path.join(base, 'source'); await fs.mkdir(source);
  const samples = [];
  for (let index = 0; index < 5; index++) {
    const filename = path.join(source, `drag-${index + 1}.png`);
    const bytes = await sharp({ create: { width: 96 + index, height: 64 + index, channels: 3,
      background: ['#4075a7', '#bf7045', '#3c9873', '#a658a5', '#b3a540'][index] } }).png().toBuffer();
    await fs.writeFile(filename, bytes); samples.push({ filename, hash: hash(bytes) });
  }
  const fixture = { token: crypto.randomUUID(), samples };
  await fs.writeFile(path.join(base, 'asset-drag-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_ASSET_DRAG_SMOKE: '1', SHITU_ASSET_DRAG_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SHITU_AE_SMOKE', 'SHITU_VIDEO_SMOKE', 'SHITU_UPDATE_SMOKE', 'SHITU_RECOVERY_SMOKE', 'SHITU_MODEL_SMOKE', 'SHITU_FOLDER_SMOKE', 'SHITU_COLORS_SMOKE', 'SHITU_HOVER_VIDEO_SMOKE']) delete env[key];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Asset drag smoke timed out: ${base}`)); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  result.sourceBytesUnchanged = (await Promise.all(samples.map(async file => hash(await fs.readFile(file.filename)) === file.hash))).every(Boolean);
  if (!result.sourceBytesUnchanged) result.ok = false;
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  const report = { ...result, reportDirectory: base };
  await fs.writeFile(path.join(reports, 'asset-drag-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
