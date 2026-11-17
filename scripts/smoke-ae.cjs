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
  const base = await fs.mkdtemp(path.join(testsRoot, 'ae-electron-'));
  const sourceDirectory = path.join(base, 'source');
  const source = path.join(sourceDirectory, '测试分镜.aep');
  await fs.mkdir(path.join(sourceDirectory, 'Footage'), { recursive: true });
  const image = path.join(sourceDirectory, 'Footage', '静帧.png');
  const sequence = [path.join(sourceDirectory, 'Footage', '帧0001.png'), path.join(sourceDirectory, 'Footage', '帧0002.png')];
  const proxy = path.join(sourceDirectory, 'Footage', '代理.mov');
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#6240b8' } }).png().toBuffer();
  for (const filename of [image, ...sequence]) await fs.writeFile(filename, png);
  await fs.writeFile(proxy, Buffer.from('synthetic proxy footage; no decoder required by project packaging'));
  await fs.writeFile(source, JSON.stringify({ fixtureAEProject: true, footage: [image, ...sequence, proxy] }));
  const fixture = { token: crypto.randomUUID(), sourceDirectory, source, sourceHash: crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex'),
    exportedDirectory: path.join(base, 'exports') };
  await fs.writeFile(path.join(base, 'ae-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_AE_SMOKE: '1', SHITU_AE_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SHITU_VIDEO_SMOKE', 'SHITU_UPDATE_SMOKE', 'SHITU_RECOVERY_SMOKE', 'SHITU_MODEL_SMOKE']) delete env[key];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`AE UI smoke timed out: ${base}`)); }, 90000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'ae-smoke.json'), JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  console.log(JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
