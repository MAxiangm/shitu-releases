'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');

(async () => {
  const testsRoot = path.join(root, '.recovery', 'tests');
  await fs.mkdir(testsRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testsRoot, 'collector-electron-'));
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'shitu-isolated-collector-smoke', main: 'main.cjs' }));
  await fs.writeFile(path.join(base, 'fixture.json'), JSON.stringify({ root, base }));
  await fs.copyFile(path.join(__dirname, 'collector-smoke-bootstrap.cjs'), path.join(base, 'main.cjs'));
  await fs.writeFile(path.join(base, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('__shituSmokeChrome',{runtime:{id:'mdleapcbplpefdgchdklofdnpjgokdhh',getManifest:()=>({version:${JSON.stringify(require('../extension/manifest.json').version)}}),sendMessage:message=>ipcRenderer.invoke('smoke:capture',message),onMessage:{addListener:callback=>ipcRenderer.on('smoke:tab-message',(_event,message)=>callback(message,{id:'mdleapcbplpefdgchdklofdnpjgokdhh'},()=>{}))}}});`);
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
