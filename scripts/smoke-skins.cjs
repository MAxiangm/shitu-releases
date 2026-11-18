'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath, devApp } = require('./runtime.cjs');
const { prepare } = require('./prepare-font-test-fixtures.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

(async () => {
  const fonts = await prepare();
  const tests = path.join(root, '.recovery', 'tests'); await fs.mkdir(tests, { recursive: true });
  const base = await fs.mkdtemp(path.join(tests, 'skins-electron-'));
  const input = path.join(base, 'input'); await fs.mkdir(input);
  const samples = [];
  for (const [name, color] of [['Skin_red', '#e84137'], ['Skin_blue', '#2676e5']]) {
    const filename = path.join(input, `${name}.png`), bytes = await sharp({ create: { width: 300, height: 200, channels: 3, background: color } }).png().toBuffer();
    await fs.writeFile(filename, bytes); samples.push({ filename, ext: 'png', hash: hash(bytes) });
  }
  for (const source of [fonts.files[0], fonts.files.find(file => file.endsWith('.ttc'))]) {
    const bytes = await fs.readFile(source), filename = path.join(input, path.basename(source));
    await fs.writeFile(filename, bytes); samples.push({ filename, ext: path.extname(source).slice(1), hash: hash(bytes) });
  }
  const fixture = { token: crypto.randomUUID(), samples };
  await fs.writeFile(path.join(base, 'skins-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^SHITU_.*SMOKE/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  Object.assign(env, { SHITU_SKINS_SMOKE: '1', SHITU_SKINS_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base });
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Skin smoke timed out: ${base}`)); }, 240000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  result.originalBytesUnchanged = (await Promise.all(samples.map(async sample => hash(await fs.readFile(sample.filename)) === sample.hash))).every(Boolean);
  if (!result.originalBytesUnchanged) result.ok = false;
  const report = { ...result, reportDirectory: base };
  await fs.mkdir(path.join(root, '.recovery', 'reports'), { recursive: true });
  await fs.writeFile(path.join(root, '.recovery', 'reports', 'skins-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
