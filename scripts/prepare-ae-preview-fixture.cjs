'use strict';
// Developer-only native integration check. Uses a fresh -m -noui AE instance,
// synthetic solids, and an isolated cache. Never addresses an existing session.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { listAfterEffectsTools, launchAfterEffects, readBridgeReport } = require('../src/ae-projects.cjs');
const { createAEPreviewEngine } = require('../src/ae-preview.cjs');
const execute = promisify(execFile);

// Fixed script: all paths and task identity are read as JSON data, never code.
const FIXTURE_SCRIPT = String.raw`(function () {
 var job = null, project = null, owned = false;
 function parse(text) {
  if (typeof JSON !== 'undefined' && JSON.parse) return JSON.parse(text);
  if (!/^[\],:{}\s]*$/.test(text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, '@').replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']').replace(/(?:^|:|,)(?:\s*\[)+/g, ''))) throw new Error('Invalid fixture JSON');
  return eval('(' + text + ')');
 }
 function report(text) {
  var item = project.items.addFolder('__Shitu_Metadata_' + job.token);
  item.comment = 'SHITU_AE_REPORT_V1:' + job.token + ':0:1:' + encodeURIComponent(text);
  project.save(new File(job.reportProject));
 }
 try {
  if (app.project && (app.project.file || app.project.numItems > 0)) throw new Error('Existing project detected; fixture refused');
  owned = true; app.exitAfterLaunchAndEval = true;
  if (typeof app.setSavePreferencesOnQuit === 'function') app.setSavePreferencesOnQuit(false);
  var input = new File($.getenv('SHITU_AE_PREVIEW_FIXTURE')); input.encoding = 'UTF-8';
  if (!input.open('r')) throw new Error('Cannot read fixture task');
  try { job = parse(input.read()); } finally { input.close(); }
  if (!/^[a-f0-9-]{36}$/.test(job.token)) throw new Error('Invalid task marker');
  app.beginSuppressDialogs(); project = app.project || app.newProject();
  var nested = project.items.addComp('Nested helper', 800, 800, 1, 3, 60);
  nested.layers.addSolid([0,0,1], 'Blue helper', 800, 800, 1, 3);
  var green = project.items.addComp('Duplicate name', 160, 96, 1, 3, 60);
  green.displayStartTime = 3600; green.workAreaStart = 1; green.workAreaDuration = 1.5;
  green.preserveNestedFrameRate = true;
  var helper = green.layers.add(nested); helper.enabled = false;
  var greenLayer = green.layers.addSolid([0.08,0.85,0.12], 'Visible after opening black', 160, 96, 1, 3);
  greenLayer.inPoint = 1.2;
  var red = project.items.addComp('Duplicate name', 160, 96, 1, 3, 60);
  red.layers.addSolid([0.9,0.08,0.05], 'Red composition', 160, 96, 1, 3);
  project.save(new File(job.output));
  report('{"ok":true,"greenId":' + green.id + ',"redId":' + red.id + ',"nestedId":' + nested.id + ',"version":"' + app.version + '"}');
  app.exitCode = 0;
 } catch (error) {
  if (!owned) throw error;
  app.exitCode = 17;
  if (job) try { report('{"ok":false,"error":"Fixture native operation failed"}'); } catch (ignoredReport) {}
 } finally {
  if (owned) {
   try { if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (ignoredClose) {}
   try { app.endSuppressDialogs(false); } catch (ignoredDialogs) {}
   app.quit();
  }
 }
})();`;
async function hash(filename) { return crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex'); }
async function artistSession() {
  if (process.platform !== 'win32') return null;
  const output = await execute('powershell.exe', ['-NoProfile', '-Command', 'Get-Process -Name AfterFX -ErrorAction SilentlyContinue | Sort-Object Id | Select-Object Id,@{Name="Started";Expression={$_.StartTime.ToUniversalTime().Ticks}},MainWindowTitle | ConvertTo-Json -Compress'], { windowsHide: true });
  return output.stdout.trim() ? JSON.parse(output.stdout) : null;
}

(async () => {
  const root = path.resolve(__dirname, '..'), tests = path.join(root, '.recovery', 'tests');
  await fs.mkdir(tests, { recursive: true });
  const base = await fs.mkdtemp(path.join(tests, 'ae-preview-fixture-'));
  const requestedYear = Number(process.argv[2] || 2020);
  const tool = (await listAfterEffectsTools()).find(item => item.year === requestedYear);
  if (!tool) throw new Error(`AE ${requestedYear} is not installed`);
  const before = await artistSession();
  const source = path.join(base, 'Synthetic Static Preview.aep');
  const control = await fs.mkdtemp(path.join(os.tmpdir(), 'shitu-ae-static-fixture-'));
  const jobPath = path.join(control, 'job.json'), script = path.join(control, 'fixture.jsx');
  const token = crypto.randomUUID(), reportProject = path.join(base, 'fixture-report.aepx');
  let engine;
  try {
    await fs.writeFile(script, Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(FIXTURE_SCRIPT)]));
    await fs.writeFile(jobPath, JSON.stringify({ token, output: source, reportProject }));
    await launchAfterEffects(tool.executable, ['-m', '-noui', '-r', script], { cwd: path.dirname(tool.executable), env: { ...process.env, SHITU_AE_PREVIEW_FIXTURE: jobPath }, timeoutMs: 120000 });
    const fixture = (await readBridgeReport(reportProject, token)).report;
    const sourceHash = await hash(source);
    const events = [];
    engine = createAEPreviewEngine({ cacheDir: path.join(base, 'cache'), toolLocator: async () => tool, onProgress: event => events.push(event) });
    const green = await engine.preview({ source, assetHash: sourceHash, compositionId: fixture.greenId });
    const red = await engine.preview({ source, assetHash: sourceHash, compositionId: fixture.redId });
    const automatic = await engine.preview({ source, assetHash: sourceHash, compositions: green.compositions });
    const cached = await engine.preview({ source, assetHash: sourceHash, compositionId: fixture.greenId });
    const greenStats = await sharp(green.thumbnailPath).stats(), redStats = await sharp(red.thumbnailPath).stats();
    if (green.composition.id !== fixture.greenId || red.composition.id !== fixture.redId || green.composition.name !== red.composition.name) throw new Error('Same-name compositions were not selected by exact ID');
    if (!(greenStats.channels[1].mean > 150 && greenStats.channels[0].mean < 80 && redStats.channels[0].mean > 150 && redStats.channels[1].mean < 80)) throw new Error('Native thumbnails do not show the requested green/red compositions');
    if (green.metadata.frameRate !== 60 || green.metadata.duration !== 3 || green.metadata.representativeTime < 1.2 || green.metadata.representativeTime >= 2.5) throw new Error('Nonzero work area/display start or opening black affected representative-frame sampling');
    if (automatic.composition.id === fixture.nestedId || !cached.cached || (await hash(source)) !== sourceHash) throw new Error('Main composition, cache or source preservation check failed');
    const after = await artistSession();
    if (before && (!after || before.Id !== after.Id || before.Started !== after.Started || before.MainWindowTitle !== after.MainWindowTitle)) throw new Error('Existing artist session changed during the test');
    const result = { ok: true, base, aeVersion: fixture.version, source, sourceUnchanged: true, existingArtistSessionUnchanged: true,
      checks: ['native PNG + JPEG', 'same-name compositions selected by ID', '60fps source preserved', 'displayStartTime 3600', 'nonzero work area', 'opening black avoided', 'unreferenced main composition', 'cache hit', 'no video generated'],
      green, red, automaticCompositionId: automatic.composition.id, events };
    await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
    await fs.mkdir(path.join(root, '.recovery', 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, '.recovery', 'reports', 'ae-static-preview-fixture.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: true, base, aeVersion: fixture.version, sourceUnchanged: true, existingArtistSessionUnchanged: true, green: green.thumbnailPath, red: red.thumbnailPath, representativeTime: green.metadata.representativeTime }, null, 2));
  } finally {
    await engine?.shutdown();
    const relative = path.relative(os.tmpdir(), control);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(control, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
