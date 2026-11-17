'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath, devApp } = require('./runtime.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  const tests = path.join(root, '.recovery', 'tests'); await fs.mkdir(tests, { recursive: true });
  const base = await fs.mkdtemp(path.join(tests, 'transcode-electron-'));
  const ffmpeg = path.join(root, 'video-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const generate = args => {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
  };
  const avi = path.join(base, '彩色视频.avi'), alpha = path.join(base, '透明视频.mov'), dxv = path.join(base, 'DXV视频.dxv');
  generate(['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-threads', '2', '-y', avi]);
  generate(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x48:r=10:d=0.3,format=rgba', '-c:v', 'qtrle', '-pix_fmt', 'argb', '-threads', '2', '-y', alpha]);
  await fs.copyFile(path.join(root, '.recovery', 'samples', 'dxv', 'dxv3-hqwa.mov'), dxv);
  const image = path.join(base, '图片.png'); await sharp({ create: { width: 16, height: 16, channels: 3, background: '#315674' } }).png().toFile(image);
  const files = await Promise.all([['avi', avi], ['alpha', alpha], ['dxv', dxv], ['image', image]].map(async ([kind, filename]) => ({ kind, filename, sha256: hash(await fs.readFile(filename)) })));
  const fixture = { token: crypto.randomUUID(), files }; await fs.writeFile(path.join(base, 'transcode-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_TRANSCODE_SMOKE: '1', SHITU_TRANSCODE_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SHITU_RECOVERY_SMOKE', 'SHITU_VIDEO_SMOKE', 'SHITU_UPDATE_SMOKE', 'SHITU_MODEL_SMOKE', 'SHITU_AE_SMOKE', 'SHITU_FOLDER_SMOKE', 'SHITU_COLORS_SMOKE', 'SHITU_HOVER_VIDEO_SMOKE', 'SHITU_ASSET_DRAG_SMOKE']) delete env[key];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Transcode smoke timed out: ${base}`)); }, 150000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  report.originalFilesUnchanged = (await Promise.all(files.map(async file => hash(await fs.readFile(file.filename)) === file.sha256))).every(Boolean);
  if (!report.originalFilesUnchanged) report.ok = false;
  const full = { ...report, reportDirectory: base }; await fs.mkdir(path.join(root, '.recovery', 'reports'), { recursive: true });
  await fs.writeFile(path.join(root, '.recovery', 'reports', 'transcode-smoke.json'), JSON.stringify(full, null, 2));
  console.log(JSON.stringify(full, null, 2)); if (!report.ok || code !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
