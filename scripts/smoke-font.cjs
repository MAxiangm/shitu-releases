'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { root, electronPath, devApp } = require('./runtime.cjs');
const { prepare } = require('./prepare-font-test-fixtures.cjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  const prepared = await prepare();
  const testsRoot = path.join(root, '.recovery', 'tests'); await fs.mkdir(testsRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testsRoot, 'font-electron-'));
  const originals = path.join(base, 'input'); await fs.mkdir(originals);
  const samples = [];
  for (const source of prepared.files) {
    const filename = path.join(originals, path.basename(source)), bytes = await fs.readFile(source);
    await fs.writeFile(filename, bytes); samples.push({ filename, hash: sha256(bytes), size: bytes.length, ext: path.extname(filename).slice(1).toLowerCase() });
  }
  const fixture = { token: crypto.randomUUID(), samples, license: 'SIL Open Font License 1.1', revision: prepared.revision };
  await fs.writeFile(path.join(base, 'font-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^SHITU_.*SMOKE/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  Object.assign(env, { SHITU_FONT_SMOKE: '1', SHITU_FONT_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base });
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Font smoke timed out: ${base}`)); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  result.sourceBytesUnchanged = (await Promise.all(samples.map(async sample => sha256(await fs.readFile(sample.filename)) === sample.hash))).every(Boolean);
  if (!result.sourceBytesUnchanged) result.ok = false;
  const report = { ...result, reportDirectory: base };
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'font-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
