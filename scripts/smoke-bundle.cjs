'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath } = require('./runtime.cjs');
const { Library } = require('../src/library.cjs');

(async () => {
  const tests = path.join(root, '.recovery', 'tests');
  await fs.mkdir(tests, { recursive: true });
  const base = await fs.mkdtemp(path.join(tests, 'bundle-electron-'));
  const sourceDirectory = path.join(base, 'source'), repairDirectory = path.join(base, 'repair-textures');
  await fs.mkdir(sourceDirectory); await fs.mkdir(repairDirectory);
  const texture = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#529983' } }).png().toBuffer();
  const thumbnail = path.join(base, 'fixture-preview.jpg');
  await sharp({ create: { width: 320, height: 240, channels: 3, background: '#45758c' } }).jpeg().toFile(thumbnail);
  await fs.writeFile(path.join(repairDirectory, 'normal.png'), texture);
  const source = path.join(sourceDirectory, 'Mixed.fbx');
  const original = Buffer.from(`; FBX 7.4.0 project file\nObjects: {
    Video: 1, "Video::Paint", "Clip" { RelativeFilename: "Mixed.fbm/color.png" Content: , "${texture.toString('base64')}" }
    Texture: 2, "Texture::Paint", "" { RelativeFilename: "Mixed.fbm/color.png" }
    Video: 3, "Video::Normal", "Clip" { RelativeFilename: "textures/normal.png" }
    Texture: 4, "Texture::Normal", "" { RelativeFilename: "textures/normal.png" }
  }
  Connections: { C: "OO", 1, 2 C: "OO", 3, 4 }
  `);
  await fs.writeFile(source, original);
  const library = new Library({ root: path.join(base, 'library'), createThumbnail: async (_source, destination) => {
    await fs.copyFile(thumbnail, destination); return { width: 320, height: 240 };
  } });
  await library.init();
  const imported = await library.importPaths([source]);
  if (imported.imported !== 1 || imported.errors.length) throw new Error(`Unable to seed bundle fixture: ${JSON.stringify(imported)}`);
  await library.updateAssets(imported.assetIds, { name: '混合贴图模型' }); await library.flush();
  const indexPath = path.join(library.root, 'index.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const asset = index.assets.find(item => item.id === imported.assetIds[0]);
  asset.modelBundle.missing = [];
  asset.modelBundle.warnings = ['FBX 含内嵌资源，同时保留找到的外置贴图；混合引用请在预览中核对。'];
  delete asset.modelBundle.resources; delete asset.modelBundle.diagnostics;
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  const fixture = { token: crypto.randomUUID(), assetId: asset.id, source, thumbnail, repairDirectory,
    originalHash: crypto.createHash('sha256').update(original).digest('hex'), libraryRoot: library.root,
    exportDirectory: path.join(base, 'exports') };
  await fs.writeFile(path.join(base, 'bundle-smoke-fixture.json'), JSON.stringify(fixture));
  const appDirectory = path.join(base, 'app'); await fs.mkdir(appDirectory);
  await fs.writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'mosaic-bundle-smoke', private: true,
    version: require('../package.json').version, main: path.join(root, 'scripts', 'bundle-smoke-bootstrap.cjs') }));
  const env = { ...process.env, SHITU_BUNDLE_SMOKE: '1', SHITU_BUNDLE_SMOKE_TOKEN: fixture.token, SHITU_SMOKE_DIRECTORY: base };
  delete env.ELECTRON_RUN_AS_NODE;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [appDirectory], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Bundle smoke timed out: ${base}`)); }, 90000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8'));
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'bundle-smoke.json'), JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  console.log(JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  if (exitCode !== 0 || !result.ok) process.exitCode = 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
