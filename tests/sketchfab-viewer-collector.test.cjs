'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Library } = require('../src/library.cjs');
const { createCollector } = require('../src/collector.cjs');
const ID = '0123456789abcdef0123456789abcdef';
const PAGE = `https://sketchfab.com/3d-models/${ID}`;
const source = () => ({ version: 1, modelId: ID, meshes: [{ positions: [0,0,0, 1,0,0, 0,1,0], indices: [0,1,2] }], images: [] });
async function fixture(t, enabled = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-viewer-test-'));
  const library = new Library({ root: path.join(directory, 'library') }); await library.init();
  const collector = createCollector({ library, configPath: path.join(directory, 'collector.json'), port: 0, sketchfabViewerCapture: enabled,
    resolveSketchfabModel() { throw new Error('Viewer export must not need API credentials or archive resolver'); } });
  await collector.start();
  t.after(async () => { await collector.close(); assert.ok(path.basename(directory).startsWith('mosaic-viewer-test-')); await fs.rm(directory, { recursive: true, force: true }); });
  const token = collector.info().code.split('.')[2];
  async function request(body, route = '/v1/capture-sketchfab-viewer') {
    return (await fetch(collector.info().baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shitu-Token': token },
      body: JSON.stringify(body) })).json();
  }
  const body = extra => ({ kind: 'model', sourceType: 'sketchfab', modelId: ID, url: PAGE, pageUrl: PAGE, name: 'Rendered triangle', viewerSnapshot: source(), ...extra });
  return { directory, library, request, body };
}
test('viewer snapshot imports a self-contained GLB without account or archive access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({}, '/v1/ping')).sketchfabViewerCapture, true);
  const body = f.body(); body.viewerSnapshot.warnings = ['部分贴图尚未载入。'];
  const result = await f.request(body);
  assert.equal(result.ok, true); assert.equal(result.imported, 1); assert.equal(result.captureMethod, 'viewer');
  const model = f.library.snapshot().assets.find(item => item.id === result.assetIds[0]);
  assert.equal(model.ext, 'glb'); assert.equal(model.pageUrl, PAGE);
  const bytes = await fs.readFile(f.library.getAssetPath(model.id, 'original'));
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF'); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const packageRoot = path.dirname(f.library.getAssetPath(model.id, 'original'));
  const details = JSON.parse(await fs.readFile(path.join(packageRoot, 'capture-details.json'), 'utf8'));
  assert.deepEqual(Object.keys(details).sort(), ['captureMethod', 'modelId', 'pageUrl', 'stats', 'version', 'warnings']);
  assert.equal(details.captureMethod, 'viewer'); assert.equal(details.modelId, ID); assert.equal(details.pageUrl, PAGE);
  assert.equal(details.stats.meshCount, 1); assert.equal(details.stats.vertexCount, 3); assert.equal(details.stats.triangleCount, 1);
  assert.deepEqual(details.warnings, ['部分贴图尚未载入。']);
  const detailsText = JSON.stringify(details);
  for (const field of ['viewerSnapshot', 'positions', 'indices', 'images', 'base64', 'cookie', 'token']) assert.equal(detailsText.includes(field), false);
  const attribution = JSON.parse(await fs.readFile(path.join(packageRoot, 'sketchfab-attribution.json'), 'utf8'));
  assert.deepEqual(attribution, { version: 1, provider: 'Sketchfab', modelId: ID, pageUrl: PAGE, captureMethod: 'viewer', title: 'Rendered triangle' });
  const duplicate = await f.request(body);
  assert.equal(duplicate.ok, true); assert.equal(duplicate.duplicates, 1);
});
test('viewer export must use its capability and dedicated route', async t => {
  const disabled = await fixture(t, false);
  assert.equal((await disabled.request(disabled.body())).ok, false);
  const enabled = await fixture(t);
  assert.equal((await enabled.request(enabled.body(), '/v1/capture')).ok, false);
  assert.equal(enabled.library.snapshot().assets.length, 0);
});
test('viewer export rejects mixed archive credentials, foreign identity and malformed geometry before import', async t => {
  const f = await fixture(t);
  for (const extra of [{ archiveUrl: 'https://example.com/archive.zip' },
    { viewerSnapshot: { ...source(), modelId: 'f'.repeat(32) } },
    { viewerSnapshot: { ...source(), meshes: [{ positions: [0,0,0,1,0,0,0,1,0], indices: [0,1,3] }] } }]) {
    const result = await f.request(f.body(extra)); assert.equal(result.ok, false);
  }
  assert.equal(f.library.snapshot().assets.length, 0);
});

test('cancelling a real viewer HTTP capture after GLB staging removes files before library import', { timeout: 10000 }, async t => {
  const f = await fixture(t), requestId = '11111111-1111-4111-8111-111111111111';
  let signalWrite, releaseWrite, stageRoot, intercepted = false, pending, timer;
  const staged = new Promise(resolve => { signalWrite = resolve; });
  const resume = new Promise(resolve => { releaseWrite = resolve; });
  const originalWrite = fs.writeFile;
  fs.writeFile = async function (...args) {
    const result = await originalWrite.apply(this, args);
    const filename = String(args[0]);
    if (!intercepted && path.basename(filename) === 'model.glb' && path.basename(path.dirname(filename)).startsWith('viewer-')) {
      intercepted = true; stageRoot = path.dirname(filename); signalWrite(); await resume;
    }
    return result;
  };
  try {
    pending = f.request(f.body({ requestId }));
    await Promise.race([staged, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Viewer GLB staging did not begin')), 5000); })]);
    clearTimeout(timer);
    const cancellation = await f.request({ requestId }, '/v1/capture-browser-cancel');
    assert.equal(cancellation.cancelled, true);
    releaseWrite();
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.code, 'CAPTURE_CANCELLED');
    assert.equal(f.library.snapshot().assets.length, 0);
    await assert.rejects(fs.stat(stageRoot), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.dirname(stageRoot)), { code: 'ENOENT' });
  } finally {
    clearTimeout(timer); releaseWrite(); fs.writeFile = originalWrite;
    await pending?.catch(() => {});
  }
});
