'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath, devApp } = require('./runtime.cjs');
const { prepare } = require('./prepare-font-test-fixtures.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
  const fonts = await prepare();
  const directory = path.join(root, '.recovery', 'tests'); await fs.mkdir(directory, { recursive: true });
  const base = await fs.mkdtemp(path.join(directory, 'organize-electron-'));
  const inputs = path.join(base, 'input'); await fs.mkdir(inputs);
  const samples = [];
  for (const source of [fonts.files[0], fonts.files.find(file => file.endsWith('.ttc')), fonts.files[1]]) {
    const bytes = await fs.readFile(source), filename = path.join(inputs, path.basename(source));
    await fs.writeFile(filename, bytes); samples.push({ filename, hash: hash(bytes), ext: path.extname(filename).slice(1) });
  }
  for (const [name, color] of [['scene_red', '#b73548'], ['scene_blue', '#285f9d']]) {
    const bytes = await sharp({ create: { width: 160, height: 120, channels: 3, background: color } }).png().toBuffer(), filename = path.join(inputs, `${name}.png`);
    await fs.writeFile(filename, bytes); samples.push({ filename, hash: hash(bytes), ext: 'png' });
  }
  const fixture = { token: crypto.randomUUID(), samples, initial: samples.filter(sample => sample.ext !== 'otf'), later: samples.find(sample => sample.ext === 'otf') };
  await fs.writeFile(path.join(base, 'organize-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^SHITU_.*SMOKE/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  Object.assign(env, { SHITU_ORGANIZE_SMOKE: '1', SHITU_ORGANIZE_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base });
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Organize smoke timed out: ${base}`)); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  result.originalBytesUnchanged = (await Promise.all(samples.map(async sample => hash(await fs.readFile(sample.filename)) === sample.hash))).every(Boolean);
  if (!result.originalBytesUnchanged) result.ok = false;
  const report = { ...result, reportDirectory: base };
  await fs.writeFile(path.join(root, '.recovery/reports/organize-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
