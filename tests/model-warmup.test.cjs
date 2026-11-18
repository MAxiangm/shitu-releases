'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createModelHoverService } = require('../src/model-hover-service.cjs');

async function fixture(t, render) {
  const parent = await fs.realpath(os.tmpdir());
  const cacheDir = await fs.mkdtemp(path.join(parent, 'shitu-model-warmup-'));
  const assets = ['a', 'b'].map(id => ({ id, ext: 'fbx', hash: id.repeat(64), modelBundle: {} }));
  const library = { root: path.join(cacheDir, 'library'), snapshot: () => ({ assets }) };
  const service = createModelHoverService({ cacheDir, getLibrary: () => library, render });
  t.after(async () => {
    await service.shutdown();
    assert.equal(path.dirname(await fs.realpath(cacheDir)), parent);
    await fs.rm(cacheDir, { recursive: true, force: true });
  });
  return { service, library, root: library.root };
}

async function webp() {
  const pixels = Buffer.from([240, 20, 20, 20, 20, 240]);
  return sharp(pixels, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } })
    .webp({ loop: 0, delay: [100, 100] }).toBuffer();
}

test('hover on the model being warmed adopts its in-flight render and reuses the cache', async t => {
  let finishRender, startRender, renders = 0;
  const began = new Promise(resolve => { startRender = resolve; });
  const frames = await webp();
  const { service, library, root } = await fixture(t, async (_library, _asset, { signal }) => {
    renders++;
    await new Promise(resolve => { finishRender = resolve; startRender(); });
    assert.equal(signal.aborted, false);
    return frames;
  });
  const warm = service.warm(library, 'a', root, 'hover_warm_a');
  await began;
  const hover = service.prepare(library, 'a', root, 'hover_mouse_a');
  assert.equal(service.cancelWarm('a', root, 'hover_warm_a'), false);
  finishRender();
  const { url } = await hover;
  assert.equal(await warm, true);
  assert.equal(renders, 1);
  assert.equal(service.response(new Request(url)).status, 200);
  assert.equal(service.cancel('a', root, 'hover_mouse_a'), true);
  assert.equal(service.response(new Request(url)).status, 404);
  assert.equal(await service.warm(library, 'a', root, 'hover_warm_again'), true);
  assert.equal(service.response(new Request(url)).status, 404);
  assert.equal(renders, 1);
});

test('hover preempts an unrelated warmup and starts only after its renderer stops', async t => {
  let startWarm, stopping = false;
  const began = new Promise(resolve => { startWarm = resolve; });
  const frames = await webp();
  const { service, library, root } = await fixture(t, async (_library, asset, { signal }) => {
    if (asset.id === 'a') {
      await new Promise(resolve => {
        signal.addEventListener('abort', resolve, { once: true });
        startWarm();
      });
      stopping = true;
      await new Promise(resolve => setImmediate(resolve));
      stopping = false;
      signal.throwIfAborted();
    }
    assert.equal(stopping, false);
    return frames;
  });
  const rejected = assert.rejects(service.warm(library, 'a', root, 'hover_warm_a'), { name: 'AbortError' });
  await began;
  const next = service.prepare(library, 'b', root, 'hover_mouse_b');
  await rejected;
  assert.equal(service.response(new Request((await next).url)).status, 200);
});
