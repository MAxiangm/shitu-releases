'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createModelFixtures } = require('./model-test-fixtures.cjs');
const { root, electronPath, devApp } = require('./runtime.cjs');

(async () => {
  const testsRoot = path.join(root, '.recovery', 'tests');
  await fs.mkdir(testsRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testsRoot, 'model-electron-'));
  const sources = path.join(base, 'sources');
  const fixture = { token: crypto.randomUUID(), sources, ...await createModelFixtures(sources) };
  // Optional native fixtures are synthetic scenes prepared explicitly by the
  // developer. The ordinary smoke and CI never require paid DCC software.
  if (process.env.SHITU_NATIVE_MODEL_FIXTURES) {
    const report = JSON.parse(await fs.readFile(process.env.SHITU_NATIVE_MODEL_FIXTURES, 'utf8'));
    for (const result of report.results.filter(item => item.ok)) {
      const relative = path.relative(testsRoot, result.source);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native fixtures must stay inside .recovery/tests');
      await fs.cp(path.dirname(result.source), path.join(sources, result.format), { recursive: true, errorOnExist: true });
      fixture.formats.push(result.format); fixture.count++;
    }
  }
  await fs.writeFile(path.join(base, 'model-smoke-fixture.json'), JSON.stringify(fixture));
  const env = { ...process.env, SHITU_MODEL_SMOKE: '1', SHITU_MODEL_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SHITU_VIDEO_SMOKE', 'SHITU_UPDATE_SMOKE', 'SHITU_RECOVERY_SMOKE']) delete env[key];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [devApp()], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Model smoke timed out: ${base}`)); }, 300000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  const reports = path.join(root, '.recovery', 'reports');
  await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'model-smoke.json'), JSON.stringify({ ...report, reportDirectory: base }, null, 2));
  console.log(JSON.stringify({ ...report, reportDirectory: base }, null, 2));
  if (!report.ok || exitCode !== 0) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
