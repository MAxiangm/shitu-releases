'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { root } = require('./runtime.cjs');
const task = process.argv[2] || 'start';
const entries = { start: 'start.cjs', check: 'check.cjs', smoke: 'smoke.cjs',
  package: 'package.cjs', installer: 'build-installer.cjs', sync: 'sync-installer.cjs',
  publish: 'publish-github.cjs', 'prepare-resources': 'prepare-build-resources.cjs', 'smoke-update': 'smoke-update.cjs',
  'smoke-video': 'smoke-video.cjs', 'video-fixtures': 'prepare-video-test-fixtures.cjs', 'smoke-model': 'smoke-model.cjs', 'smoke-collector': 'smoke-collector.cjs', 'smoke-ae': 'smoke-ae.cjs' };
let args;
if (task === 'test') {
  args = ['--test', ...fs.readdirSync(path.join(root, 'tests'))
    .filter(name => name.endsWith('.test.cjs')).map(name => path.join(root, 'tests', name))];
} else if (entries[task]) args = [path.join(__dirname, entries[task]), ...process.argv.slice(3)];
else {
  console.error('Usage: 开发工具.cmd [start|check|test|smoke|smoke-update|smoke-video|video-fixtures|package|installer|publish|prepare-resources|sync]');
  process.exit(1);
}
const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exitCode = result.status ?? 1;
