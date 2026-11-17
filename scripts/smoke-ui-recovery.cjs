'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath, devApp } = require('./runtime.cjs');

(async () => {
  const tests = path.join(root, '.recovery', 'tests'); await fs.mkdir(tests, { recursive: true });
  const base = await fs.mkdtemp(path.join(tests, 'ui-recovery-electron-'));
  const filename = path.join(base, 'recovery-image.png');
  const bytes = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#267891' } }).png().toBuffer(); await fs.writeFile(filename, bytes);
  const fixture = { token: crypto.randomUUID(), filename, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(path.join(base, 'ui-recovery-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_UI_RECOVERY_SMOKE: '1', SHITU_UI_RECOVERY_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SHITU_RECOVERY_SMOKE', 'SHITU_VIDEO_SMOKE', 'SHITU_UPDATE_SMOKE', 'SHITU_MODEL_SMOKE', 'SHITU_AE_SMOKE', 'SHITU_FOLDER_SMOKE', 'SHITU_COLORS_SMOKE', 'SHITU_HOVER_VIDEO_SMOKE', 'SHITU_ASSET_DRAG_SMOKE', 'SHITU_TRANSCODE_SMOKE']) delete env[key];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`UI recovery smoke timed out: ${base}`)); }, 65000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  const full = { ...report, reportDirectory: base };
  await fs.mkdir(path.join(root, '.recovery', 'reports'), { recursive: true });
  await fs.writeFile(path.join(root, '.recovery', 'reports', 'ui-recovery-smoke.json'), JSON.stringify(full, null, 2));
  console.log(JSON.stringify(full, null, 2)); if (exitCode !== 0 || !report.ok) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
