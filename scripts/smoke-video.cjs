'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { root, electronPath, devApp } = require('./runtime.cjs');

const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
function generate(executable, args) {
  const result = spawnSync(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw result.error || new Error(`Unable to create video fixture: ${result.stderr}`);
}

(async () => {
  const ffmpeg = path.join(root, 'video-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobe = path.join(root, 'video-runtime', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) throw new Error('Prepare the bundled video-runtime before running the video smoke test.');
  const dxvSource = path.join(root, '.recovery', 'samples', 'dxv', 'dxv3-hqwa.mov');
  if (!fs.existsSync(dxvSource)) throw new Error('Missing local DXV sample: .recovery/samples/dxv/dxv3-hqwa.mov. Prepare the official FFmpeg FATE sample first; this smoke test never downloads files.');
  const testsRoot = path.join(root, '.recovery', 'tests');
  fs.mkdirSync(testsRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(testsRoot, 'video-electron-'));
  const avi = path.join(base, 'sample-mpeg4.avi');
  const mkv = path.join(base, 'sample-ffv1.mkv');
  const dxv = path.join(base, 'sample-dxv.dxv');
  generate(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=12', '-t', '1', '-an', '-c:v', 'mpeg4', '-q:v', '3', '-threads', '2', '-y', avi]);
  generate(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=48000', '-t', '1', '-c:v', 'ffv1', '-level', '3', '-c:a', 'pcm_s16le', '-threads', '2', '-y', mkv]);
  fs.copyFileSync(dxvSource, dxv);
  const files = [
    { kind: 'avi', filename: avi, expectedCodec: 'mpeg4' },
    { kind: 'mkv', filename: mkv, expectedCodec: 'ffv1' },
    { kind: 'dxv', filename: dxv, expectedCodec: 'dxv' }
  ].map(file => ({ ...file, sha256: hash(file.filename) }));
  const fixture = { token: crypto.randomUUID(), files, dxvSource, dxvSourceHash: hash(dxvSource) };
  fs.writeFileSync(path.join(base, 'video-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_VIDEO_SMOKE: '1', SHITU_VIDEO_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  delete env.SHITU_RECOVERY_SMOKE;
  delete env.SHITU_UPDATE_SMOKE;
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Video smoke Electron process timed out: ${base}`)); }, 150000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const resultPath = path.join(base, 'result.json');
  if (!fs.existsSync(resultPath)) throw new Error(`Electron exited ${code} without a video smoke result: ${base}`);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  result.originalFilesUnchanged = files.every(file => hash(file.filename) === file.sha256) && hash(dxvSource) === fixture.dxvSourceHash;
  if (!result.originalFilesUnchanged) result.ok = false;
  const reports = path.join(root, '.recovery', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, 'video-smoke.json'), JSON.stringify({ ...result, reportDirectory: base }, null, 2) + '\n');
  if (result.ok && result.quitObserved && result.engineShutdown && code === 0) {
    if (fs.existsSync(path.join(base, 'screenshot.png')))
      fs.copyFileSync(path.join(base, 'screenshot.png'), path.join(reports, 'video-smoke.png'));
    console.log(JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  } else {
    console.error(JSON.stringify({ ...result, exitCode: code, reportDirectory: base }, null, 2));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
