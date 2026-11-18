'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');

(async () => {
  const testsRoot = path.join(root, '.recovery', 'tests');
  await fs.mkdir(testsRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testsRoot, 'collector-electron-'));
  const ffmpeg = path.join(root, 'video-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  for (const [name, color] of [['direct-video.mp4', 'blue'], ['session-video.mp4', 'red']]) {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', `color=c=${color}:s=64x48:r=12:d=1`, '-an', '-c:v', 'libopenh264', '-threads', '2',
      '-movflags', '+faststart', '-y', path.join(base, name)], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status !== 0) throw result.error || new Error(`Could not generate ${name}: ${result.stderr}`);
  }
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'shitu-isolated-collector-smoke', main: 'main.cjs' }));
  await fs.writeFile(path.join(base, 'fixture.json'), JSON.stringify({ root, base }));
  await fs.copyFile(path.join(__dirname, 'collector-smoke-bootstrap.cjs'), path.join(base, 'main.cjs'));
  await fs.writeFile(path.join(base, 'preload.cjs'), `
const { contextBridge, ipcRenderer } = require('electron');
const id = 'mdleapcbplpefdgchdklofdnpjgokdhh';
let tabListener;
ipcRenderer.on('smoke:tab-message', (_event, message) => tabListener?.(message, { id }, () => {}));
contextBridge.exposeInMainWorld('__shituSmokeChrome', {
  runtime: {
    id,
    getManifest: () => ({ version: ${JSON.stringify(require('../extension/manifest.json').version)} }),
    sendMessage: message => ipcRenderer.invoke('smoke:capture', message),
    onMessage: { addListener: callback => { tabListener = callback; } }
  },
  resolveMedia: message => new Promise((resolve, reject) => {
    if (!tabListener) reject(new Error('The content script has not registered its listener'));
    else tabListener(message, { id }, resolve);
  })
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [base], { env, cwd: root, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
      reject(new Error(`Collector smoke timed out: ${base}`));
    }, 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', status => { clearTimeout(timer); resolve(status); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'collector-smoke.json'), JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  console.log(JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  if (!result.ok || code !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
