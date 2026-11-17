'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath, devApp } = require('./runtime.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  const testsRoot = path.join(root, '.recovery', 'tests'); await fs.mkdir(testsRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testsRoot, 'hover-video-electron-'));
  const source = path.join(base, 'source'); await fs.mkdir(source);
  const ffmpeg = path.join(root, 'video-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const files = [];
  for (const [kind, extension, encoder] of [['native', 'webm', 'libvpx-vp9'], ['converted', 'avi', 'mpeg4']]) {
    const filename = path.join(source, `${kind}.${extension}`);
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=192x128:rate=20', '-t', '3', '-an', '-c:v', encoder, '-threads', '2', '-y', filename], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status) throw result.error || new Error(result.stderr);
    files.push({ kind, filename, hash: hash(await fs.readFile(filename)) });
  }
  const dxvSource = path.join(root, '.recovery', 'samples', 'dxv', 'dxv3-hqwa.mov');
  try {
    const bytes = await fs.readFile(dxvSource), filename = path.join(source, 'sample.dxv');
    await fs.writeFile(filename, bytes); files.push({ kind: 'dxv', filename, hash: hash(bytes) });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const image = path.join(source, 'still.png');
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#25485d' } }).png().toFile(image);
  files.push({ kind: 'image', filename: image, hash: hash(await fs.readFile(image)) });
  const fixture = { token: crypto.randomUUID(), files };
  await fs.writeFile(path.join(base, 'hover-video-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_HOVER_VIDEO_SMOKE: '1', SHITU_HOVER_VIDEO_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SHITU_AE_SMOKE', 'SHITU_VIDEO_SMOKE', 'SHITU_UPDATE_SMOKE', 'SHITU_RECOVERY_SMOKE', 'SHITU_MODEL_SMOKE', 'SHITU_FOLDER_SMOKE', 'SHITU_COLORS_SMOKE']) delete env[key];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Hover video smoke timed out: ${base}`)); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  result.originalFilesUnchanged = (await Promise.all(files.map(async file => hash(await fs.readFile(file.filename)) === file.hash))).every(Boolean);
  if (!result.originalFilesUnchanged) result.ok = false;
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  const report = { ...result, reportDirectory: base };
  await fs.writeFile(path.join(reports, 'hover-video-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
