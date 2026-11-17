'use strict';
// Developer-only: creates a synthetic project in a new AE instance. Never
// addresses the user's running AE instance or opens a real user project.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { listAfterEffectsTools, launchAfterEffects, readBridgeReport, createAEProjectCollector, projectYear } = require('../src/ae-projects.cjs');

(async () => {
  const root = path.resolve(__dirname, '..'), tests = path.join(root, '.recovery', 'tests');
  await fs.mkdir(tests, { recursive: true });
  const base = await fs.mkdtemp(path.join(tests, 'ae-fixture-'));
  const original = path.join(base, 'Original'); await fs.mkdir(original);
  const tools = await listAfterEffectsTools();
  const requestedYear = Number(process.argv[2] || '2020');
  const tool = tools.find(item => item.year === requestedYear);
  if (!tool) throw new Error(`AE ${requestedYear} is not installed`);
  const image = path.join(original, '素材图片.png'), proxy = path.join(original, '代理图片.png');
  await sharp({ create: { width: 64, height: 64, channels: 4, background: '#2ab581' } }).png().toFile(image);
  await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ba4181' } }).png().toFile(proxy);
  const frames = path.join(original, 'Frames'); await fs.mkdir(frames);
  for (let frame = 1; frame <= 3; frame++) await sharp({ create: { width: 64, height: 64, channels: 4, background: frame === 1 ? '#a23623' : frame === 2 ? '#31c8a2' : '#1b2ec6' } }).png().toFile(path.join(frames, `frame-${String(frame).padStart(4, '0')}.png`));
  const extension = process.argv[3] || 'aep';
  if (!['aep', 'aepx'].includes(extension)) throw new Error('Choose aep or aepx');
  const token = crypto.randomUUID(), source = path.join(original, `Synthetic AE Collection.${extension}`);
  const control = await fs.mkdtemp(path.join(os.tmpdir(), 'shitu-ae-fixture-'));
  const script = path.join(control, 'collect.jsx'), jobPath = path.join(control, 'job.json');
  const reportProject = path.join(base, 'fixture-report.aepx');
  await fs.writeFile(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await fs.readFile(path.join(root, 'src', 'ae-scripts', 'collect.jsx'))]));
  await fs.writeFile(jobPath, JSON.stringify({ protocol: 1, token, mode: 'fixture', image, proxy, sequence: path.join(frames, 'frame-0001.png'), output: source, reportProject }));
  let result;
  try {
    await launchAfterEffects(tool.executable, ['-m', '-noui', '-r', script], { cwd: path.dirname(tool.executable), env: { ...process.env, SHITU_AE_JOB: jobPath }, timeoutMs: 120000 });
    result = (await readBridgeReport(reportProject, token)).report;
    if (requestedYear === 2020 && !/^17\./.test(result.version) || requestedYear === 2025 && !/^25\./.test(result.version)) throw new Error('Synthetic project saved with an unexpected AE version');
    const sourceHash = crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
    const collector = createAEProjectCollector({ cacheDir: path.join(base, 'cache'), timeoutMs: 120000 });
    let prepared;
    try {
      prepared = await collector.prepareProjectBundle(source);
      const exported = path.join(base, 'Exported Folder'); await fs.cp(prepared.directory, exported, { recursive: true });
      // Disappear both the source folder and collection staging. A successful
      // reopen can only use the exported package's own media files.
      await fs.rename(original, path.join(base, 'Source Hidden'));
      await prepared.cleanup(); prepared = null;
      await fs.writeFile(jobPath, JSON.stringify({ protocol: 1, token, mode: 'verify', source: path.join(exported, path.basename(source)), reportProject: path.join(base, 'verify-report.aepx') }));
      await launchAfterEffects(tool.executable, ['-m', '-noui', '-r', script], { cwd: path.dirname(tool.executable), env: { ...process.env, SHITU_AE_JOB: jobPath }, timeoutMs: 120000 });
      const verified = (await readBridgeReport(path.join(base, 'verify-report.aepx'), token)).report;
      if (!verified.sources.length || verified.sources.some(item => item.missing || !path.resolve(item.source).startsWith(path.resolve(exported) + path.sep))) throw new Error('Moved AE project references files outside its exported package');
      const relocatedSources = verified.sources.map(item => ({ role: item.role, source: item.source, isStill: item.isStill, useProxy: item.useProxy, interpretation: item.interpretation }));
      const originalAfter = path.join(base, 'Source Hidden', path.basename(source));
      if (crypto.createHash('sha256').update(await fs.readFile(originalAfter)).digest('hex') !== sourceHash) throw new Error('Source project changed');
      result = { ok: true, base, source: originalAfter, exported, aeVersion: verified.version, sourceYear: requestedYear,
        originalUnchanged: true, sourceAndStagingUnavailable: true, sources: relocatedSources };
    } finally { await prepared?.cleanup(); await collector.shutdown(); }
  } finally {
    const relative = path.relative(os.tmpdir(), control);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(control, { recursive: true, force: true }).catch(() => {});
  }
  await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
  await fs.mkdir(path.join(root, '.recovery', 'reports'), { recursive: true });
  await fs.writeFile(path.join(root, '.recovery', 'reports', 'ae-project-fixtures.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
