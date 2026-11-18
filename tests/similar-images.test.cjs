'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { assetMenuTemplate } = require('../src/asset-menu.cjs');
const { createSimilarImageService } = require('../src/similar-image-service.cjs');

const WIDTH = 320;
const HEIGHT = 240;

function drawing(other = false) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const circle = (x - 168) ** 2 + (y - 65) ** 2 < 43 ** 2;
    const roof = Math.abs(x - 100) + y < 152 && y > 74;
    const tower = x > 224 && x < 257 && y > 80 && y < 196;
    const floor = y > 150 + x * 0.13;
    const rgb = circle ? [222, 178, 31] : roof ? [49, 91, 62] : tower ? [202, 98, 60] :
      floor ? [35, 48, 112] : [84 + Math.floor(y / 4), 142 + Math.floor(x / 14), 182];
    const target = ((other ? HEIGHT - y - 1 : y) * WIDTH + x) * 3;
    pixels.set(rgb, target);
  }
  return sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shitu-similar-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.match(path.basename(root), /^shitu-similar-test-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  await Promise.all([
    drawing().png().toFile(path.join(root, 'reference.png')),
    drawing().resize(190).jpeg({ quality: 35 }).toFile(path.join(root, 'smaller.jpg')),
    drawing().extract({ left: 32, top: 36, width: 238, height: 177 }).jpeg({ quality: 48 }).toFile(path.join(root, 'cropped.jpg')),
    drawing().extract({ left: 77, top: 20, width: 205, height: 200 }).jpeg({ quality: 55 }).toFile(path.join(root, 'offset.jpg')),
    drawing(true).jpeg({ quality: 80 }).toFile(path.join(root, 'unrelated.jpg')),
    drawing().png().toFile(path.join(root, 'trashed.png')),
    fs.writeFile(path.join(root, 'unreadable.jpg'), 'Invalid JPEG')
  ]);
  const names = ['reference.png', 'smaller.jpg', 'cropped.jpg', 'offset.jpg', 'unrelated.jpg', 'trashed.png', 'unreadable.jpg', 'outside.jpg'];
  const assets = names.map(name => ({ id: name.split('.')[0], filename: name, hash: name,
    ext: name.split('.')[1], mediaType: 'image', ...(name.startsWith('trashed') ? { trashedAt: 'today' } : {}) }));
  const library = {
    root,
    snapshot: () => ({ assets: [...assets] }),
    getAssetPath(id, kind) {
      if (kind === 'thumbnail') return null;
      const found = assets.find(item => item.id === id);
      return found && (id === 'outside' ? path.join(root, '..', 'outside.jpg') : path.join(root, found.filename));
    }
  };
  return { library, assets };
}

test('similar image search matches compressed, resized and cropped variants without same-palette false matches', async t => {
  const { library } = await fixture(t);
  const progress = [];
  const service = createSimilarImageService({ getLibrary: () => library, onProgress: detail => progress.push(detail) });
  const result = await service.search(library, 'reference', library.root, 'similar_first');
  assert.deepEqual(result.matches.map(item => item.id).sort(), ['cropped', 'offset', 'smaller']);
  assert.equal(result.matches[0].id, 'smaller');
  assert.equal(result.matches.find(item => item.id === 'offset').kind, 'crop');
  assert.equal(result.skipped, 2);
  assert.equal(result.current, 6);
  assert.equal(progress[0].token, 'similar_first');
  const reverse = await service.search(library, 'offset', library.root, 'similar_reverse');
  assert.ok(reverse.matches.some(item => item.id === 'reference'));
});

test('cancellation rejects stale work and a later lookup can complete', async t => {
  const { library } = await fixture(t);
  const service = createSimilarImageService({ getLibrary: () => library, onProgress(detail) {
    if (detail.token === 'similar_cancel') {
      assert.equal(service.cancel(detail.root, 'similar_old'), false);
      assert.equal(service.cancel(detail.root, detail.token), true);
    }
  } });
  await assert.rejects(service.search(library, 'reference', library.root, 'similar_cancel'), { name: 'AbortError' });
  const next = await service.search(library, 'reference', library.root, 'similar_next');
  assert.ok(next.matches.length);
  assert.throws(() => service.search(library, 'trashed', library.root, 'similar_trash'), /请选择/);
  assert.throws(() => service.search(library, 'reference', 'old root', 'similar_switch'), /已切换/);
});

test('similar image command only appears for one active image', () => {
  const image = { id: 'id', mediaType: 'image', ext: 'jpg' };
  const find = assets => assetMenuTemplate(assets, [], () => {}).find(item => item.id === 'similar-images');
  assert.ok(find([image]));
  assert.equal(find([{ ...image, trashedAt: 'today' }]), undefined);
  assert.equal(find([image, image]), undefined);
  assert.equal(find([{ ...image, mediaType: 'video', ext: 'mov' }]), undefined);
});
