'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createAEPreviewEngine, chooseComposition } = require('../src/ae-preview.cjs');

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    function poll() { if (predicate()) resolve(); else if (Date.now() - started > 5000) reject(new Error('Test operation did not start')); else setTimeout(poll, 5); }
    poll();
  });
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shitu-ae-static-test-'));
  t.after(async () => { await engine.shutdown(); const relative = path.relative(os.tmpdir(), root); if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, '工程.aep'); await fs.writeFile(source, 'synthetic AE test input');
  const state = { launches: 0, jobs: [], gates: [] };
  const engine = createAEPreviewEngine({ cacheDir: path.join(root, 'cache'), toolLocator: async () => ({ executable: path.join(root, 'AfterFX.com') }),
    launch: async (executable, args, launchOptions) => {
      state.launches++;
      assert.equal(executable, path.join(root, 'AfterFX.com'));
      assert.deepEqual(args.slice(0, 3), ['-m', '-noui', '-r']);
      assert.equal(launchOptions.cwd, root);
      const script = await fs.readFile(args[3]); assert.deepEqual([...script.subarray(0, 3)], [239, 187, 191]);
      const job = JSON.parse(await fs.readFile(launchOptions.env.SHITU_AE_PREVIEW_JOB, 'utf8'));
      state.jobs.push(job);
      if (options.gated) await new Promise((resolve, reject) => {
        state.gates.push(resolve);
        const cancel = () => { launchOptions.signal.removeEventListener('abort', cancel); reject(Object.assign(new Error('cancelled test AE'), { name: 'AbortError' })); };
        launchOptions.signal.addEventListener('abort', cancel, { once: true });
        if (launchOptions.signal.aborted) cancel();
      });
      const frames = [];
      for (let index = 0; index < 3; index++) {
        const filename = path.join(job.outputDirectory, `frame-${index}.png`);
        await sharp({ create: { width: 160, height: 96, channels: 4, background: ['#000000', '#ce3020', '#20ce30'][index] } }).png().toFile(filename);
        frames.push({ path: options.outside ? source : filename, time: [0.1, 0.5, 0.8][index] });
      }
      const composition = { id: Number(job.compositionId || 17), index: 2, name: 'Same name', width: 160, height: 96, duration: 3, frameRate: 60, usedInCount: 0, workAreaStart: 0, workAreaDuration: 3 };
      const report = { ok: true, version: '17.0.1x52', composition, compositions: [composition], frames };
      const encoded = encodeURIComponent(JSON.stringify(report));
      await fs.writeFile(job.reportProject, `<?xml version="1.0"?><AfterEffectsProject><string>SHITU_AE_REPORT_V1:${job.token}:0:1:${encoded}</string></AfterEffectsProject>`);
      if (options.mutate) await fs.appendFile(source, 'modified');
      return { code: 0, output: '' };
    }
  });
  return { root, source, state, engine };
}

test('main composition selection prefers unreferenced, non-empty compositions and stable IDs', () => {
  const comps = [
    { id: 1, name: 'Nested', width: 8000, height: 8000, duration: 300, usedInCount: 1 },
    { id: 2, name: 'Final', width: 1280, height: 720, duration: 10, usedInCount: 0 },
    { id: 3, name: 'Final', width: 1920, height: 1080, duration: 0, usedInCount: 0 },
    { id: 4, name: 'Other', width: 1280, height: 720, duration: 10, usedInCount: 0 }
  ];
  assert.equal(chooseComposition(comps).id, 2);
  assert.equal(chooseComposition([]), null);
});

test('static preview selects a visible frame, caches safely, and uses comp IDs for equal names', async t => {
  const { engine, source, state } = await fixture(t);
  const result = await engine.preview({ source, compositionId: 23 });
  assert.equal(result.composition.id, 23);
  assert.equal(result.metadata.frameRate, 60);
  assert.equal(result.metadata.duration, 3);
  assert.equal(result.metadata.representativeTime, 0.8);
  assert.equal(result.videoPath, undefined);
  const { data } = await sharp(result.thumbnailPath).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[1] > 150 && data[0] < 80, 'thumbnail shows the visible green frame');
  assert.equal((await engine.preview({ source, compositionId: 23 })).cached, true);
  assert.equal(state.launches, 1);
  const manifestFile = path.join(path.dirname(result.thumbnailPath), 'manifest.json');
  const brokenManifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  brokenManifest.metadata.duration = 0;
  await fs.writeFile(manifestFile, JSON.stringify(brokenManifest));
  assert.equal((await engine.preview({ source, compositionId: 23 })).cached, false);
  assert.equal(state.launches, 2);
  await fs.writeFile(result.thumbnailPath, 'corrupted JPEG');
  assert.equal((await engine.preview({ source, compositionId: 23 })).cached, false);
  assert.equal(state.launches, 3);
  await engine.preview({ source, compositionId: 24 });
  assert.equal(state.jobs[3].compositionId, '24');
  assert.equal((await fs.readdir(path.dirname(result.thumbnailPath))).some(name => /\.(?:avi|webm|aepx?)$/.test(name)), false);
});

test('shared jobs survive one consumer cancellation and stop after the last consumer leaves', async t => {
  const { engine, source, state } = await fixture(t, { gated: true });
  const first = new AbortController(), second = new AbortController();
  const cancelled = engine.preview({ source, signal: first.signal });
  const kept = engine.preview({ source, signal: second.signal });
  await waitFor(() => state.gates.length === 1);
  // Both callers finish their source hashing before cancelling the first caller.
  await new Promise(resolve => setTimeout(resolve, 20));
  first.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  state.gates[0]();
  assert.equal((await kept).cached, false);
  assert.equal(state.launches, 1);
  const last = new AbortController();
  const stopped = engine.preview({ source, compositionId: 33, signal: last.signal });
  await waitFor(() => state.gates.length === 2);
  last.abort(); await assert.rejects(stopped, { name: 'AbortError' });
  const retry = engine.preview({ source, compositionId: 33 });
  await waitFor(() => state.gates.length === 3);
  state.gates[2]();
  assert.equal((await retry).composition.id, 33);
  assert.equal(state.launches, 3);
});

test('rejects reports escaping the temporary output directory and changed project sources', async t => {
  const outside = await fixture(t, { outside: true });
  await assert.rejects(outside.engine.preview({ source: outside.source }), /图片路径无效/);
  const changed = await fixture(t, { mutate: true });
  await assert.rejects(changed.engine.preview({ source: changed.source }), /内容已变化/);
  assert.deepEqual((await fs.readdir(path.join(changed.root, 'cache'))).filter(name => name.startsWith('.ae-static-')), []);
});

test('whole-package identity invalidates previews even when the AEP file is unchanged', async t => {
  const { engine, source, state } = await fixture(t);
  const first = await engine.preview({ source, assetHash: 'a'.repeat(64) });
  const changedFootage = await engine.preview({ source, assetHash: 'b'.repeat(64) });
  assert.notEqual(first.thumbnailPath, changedFootage.thumbnailPath);
  assert.equal(state.launches, 2);
  await engine.shutdown();
  await assert.rejects(engine.preview({ source }), /已关闭/);
});
