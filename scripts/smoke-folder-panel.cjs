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
  const base = await fs.mkdtemp(path.join(testsRoot, 'folder-panel-electron-'));
  const samples = [];
  for (const [index, color] of ['#307bac', '#c57749', '#449865'].entries()) {
    const filename = path.join(base, `folder-panel-${index + 1}.png`);
    const bytes = await sharp({ create: { width: 120 + index, height: 90, channels: 3, background: color } }).png().toBuffer();
    await fs.writeFile(filename, bytes); samples.push({ filename, hash: hash(bytes) });
  }
  const fixture = { token: crypto.randomUUID(), samples };
  await fs.writeFile(path.join(base, 'folder-panel-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^SHITU_.*SMOKE/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  Object.assign(env, { SHITU_FOLDER_PANEL_SMOKE: '1', SHITU_FOLDER_PANEL_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base });
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Folder panel smoke timed out: ${base}`)); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  result.sourceBytesUnchanged = (await Promise.all(samples.map(async sample => hash(await fs.readFile(sample.filename)) === sample.hash))).every(Boolean);
  if (!result.sourceBytesUnchanged) result.ok = false;
  const report = { ...result, reportDirectory: base };
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'folder-panel-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
