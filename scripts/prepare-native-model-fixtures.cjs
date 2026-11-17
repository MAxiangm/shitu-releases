'use strict';
// Developer-only, synthetic native scenes. Never opens an existing user project.
const fs = require('node:fs/promises');
const path = require('node:path');
const { findNativeTool, runNativeProcess, createNativeModelConverter } = require('../src/native-models.cjs');
const { collectModelBundle, copyModelBundle } = require('../src/model-bundle.cjs');
const sharp = require('sharp');

(async () => {
  const root = path.resolve(__dirname, '..'), tests = path.join(root, '.recovery', 'tests');
  await fs.mkdir(tests, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tests, 'native-fixtures-'));
  const formats = (process.argv[2] || 'blend').split(',');
  if (formats.some(format => !['blend', 'c4d', 'max'].includes(format))) throw new Error('Choose blend,c4d,max');
  const results = [];
  const timeoutMs = Number(process.env.SHITU_NATIVE_FIXTURE_TIMEOUT_MS || 60000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new Error('Invalid fixture timeout');
  const converter = createNativeModelConverter({ cacheDir: path.join(directory, 'cache'), timeoutMs });
  try {
    for (const format of formats) {
      const base = path.join(directory, format); await fs.mkdir(path.join(base, 'tex'), { recursive: true });
      const image = path.join(base, 'tex', 'fixture.png');
      await sharp({ create: { width: 8, height: 8, channels: 4, background: '#168cce' } }).png().toFile(image);
      const source = path.join(base, `fixture.${format}`), jobPath = path.join(base, 'fixture-job.json');
      await fs.writeFile(jobPath, JSON.stringify({ source, image }));
      const executable = await findNativeTool(format);
      if (!executable) { results.push({ format, ok: false, error: 'Native software unavailable' }); continue; }
      const script = path.join(__dirname, 'native-fixture-scripts', format === 'max' ? 'max.ms' : `${format}.py`);
      const args = format === 'blend' ? ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '6', '--python', script] :
        format === 'max' ? [script, '-safescene', 'ON'] : [script];
      try {
        await runNativeProcess(executable, args, { cwd: base, env: { ...process.env, SHITU_MODEL_FIXTURE_JOB: jobPath }, timeoutMs });
        const bundleDirectory = path.join(directory, `managed-${format}`);
        const manifest = await copyModelBundle(await collectModelBundle(source), bundleDirectory);
        const preview = await converter.preview({ source: path.join(bundleDirectory, manifest.entry), format, bundleDirectory, manifest });
        results.push({ format, ok: true, source, bundleDirectory, manifest, preview });
      } catch (error) { results.push({ format, ok: false, source, error: error.message }); }
      console.log(JSON.stringify(results.at(-1)));
    }
  } finally { await converter.shutdown(); }
  const report = { ok: results.every(result => result.ok), directory, results };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  await fs.mkdir(path.join(root, '.recovery', 'reports'), { recursive: true });
  await fs.writeFile(path.join(root, '.recovery', 'reports', 'native-model-fixtures.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, directory }));
  if (!report.ok) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
