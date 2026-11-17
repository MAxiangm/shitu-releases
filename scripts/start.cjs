'use strict';
const { spawn } = require('node:child_process');
const { root, electronPath, devApp } = require('./runtime.cjs');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath(), [devApp(), ...process.argv.slice(2)], {
  cwd: root, env, stdio: 'inherit', windowsHide: true
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
