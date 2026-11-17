'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { root, electronPath, devApp } = require('./runtime.cjs');

(async () => {
  const testsRoot = path.join(root, '.recovery', 'tests');
  fs.mkdirSync(testsRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(testsRoot, 'update-electron-'));
  const token = crypto.randomUUID();
  const currentVersion = require(path.join(root, 'package.json')).version;
  const parts = currentVersion.split('.').map(Number);
  if (parts.length !== 3 || !parts.every(Number.isSafeInteger)) throw new Error('Smoke test requires a stable project version.');
  const nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  const installer = Buffer.alloc(512, 0x51);
  installer.write('MZ');
  const fixture = {
    token, currentVersion, nextVersion, installerBase64: installer.toString('base64'),
    sha256: crypto.createHash('sha256').update(installer).digest('hex'),
    notes: '更新验证\n<img src=x onerror="window.__updateSmokeXss=true">\n改进素材整理体验。'
  };
  fs.writeFileSync(path.join(base, 'update-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_UPDATE_SMOKE: '1', SHITU_UPDATE_SMOKE_TOKEN: token, SHITU_SMOKE_DIRECTORY: base };
  delete env.SHITU_RECOVERY_SMOKE;
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Update smoke Electron process timed out')); }, 55000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const resultPath = path.join(base, 'result.json');
  if (!fs.existsSync(resultPath)) throw new Error(`Electron exited ${code} without an update smoke result: ${base}`);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const reports = path.join(root, '.recovery', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.copyFileSync(resultPath, path.join(reports, 'update-smoke.json'));
  if (result.ok && result.quitObserved && result.installerExecuted === false && code === 0) {
    fs.copyFileSync(path.join(base, 'screenshot.png'), path.join(reports, 'update-smoke.png'));
    console.log(JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  } else {
    console.error(JSON.stringify({ ...result, exitCode: code, reportDirectory: base }, null, 2));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
