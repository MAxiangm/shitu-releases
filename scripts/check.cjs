'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');
const { verifyVideoRuntime } = require('./prepare-video-runtime.cjs');
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
const files = ['src', 'extension', 'scripts', 'tests'].flatMap(name => {
  const directory = path.join(root, name);
  return fs.existsSync(directory) ? walk(directory) : [];
}).filter(file => /\.(cjs|js)$/.test(file));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0 || result.error) throw result.error || new Error(`Syntax check failed: ${file}`);
}
for (const file of ['src/main.cjs', 'src/preload.cjs', 'src/index.html', 'assets/icon.ico',
  'extension/manifest.json', 'ai-runtime/upscale/realesrgan-ncnn-vulkan.exe',
  'ai-runtime/cutout/u2net.onnx', 'ai-runtime/cutout/python/python.exe']) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing recovered resource: ${file}`);
}
const sharp = require('sharp');
verifyVideoRuntime().then(manifest => {
  console.log(`Syntax OK: ${files.length} JavaScript files; sharp ${sharp.versions.sharp}; Electron: ${electronPath()}; FFmpeg: ${manifest.version}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
