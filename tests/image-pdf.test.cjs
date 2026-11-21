'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const sharp = require('sharp');
const { writeImagePdf, pageLayout, pdfOptions } = require('../src/image-pdf.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-pdf-test-'));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), dir);
    assert.ok(relative.startsWith('mosaic-pdf-test-') && !relative.includes(path.sep));
    return fs.rm(dir, { recursive: true, force: true });
  });
  const image = async (name, width = 20, height = 10, background = '#2687ce') => {
    const filename = path.join(dir, name);
    await sharp({ create: { width, height, channels: 4, background } }).png().toFile(filename);
    return filename;
  };
  return { dir, image, output: path.join(dir, 'result.pdf') };
}

// Independently read the cross-reference offsets and declared stream lengths;
// binary image data is never scanned for sentinel strings.
function parsePdf(buffer) {
  const all = buffer.toString('latin1');
  assert.ok(all.startsWith('%PDF-1.4\n%'));
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(all)?.[1]);
  assert.equal(all.slice(start, start + 5), 'xref\n');
  const xref = all.slice(start).split('\n');
  const count = Number(xref[1].split(' ')[1]);
  assert.equal(xref[2], '0000000000 65535 f ');
  const objects = new Map();
  for (let id = 1; id < count; id++) {
    const offset = Number(xref[id + 2].slice(0, 10));
    assert.equal(all.slice(offset, offset + `${id} 0 obj\n`.length), `${id} 0 obj\n`);
    const end = id + 1 < count ? Number(xref[id + 3].slice(0, 10)) : start;
    const body = all.slice(offset, end);
    const streamStart = body.indexOf('\nstream\n');
    const length = Number(/\/Length (\d+)/.exec(body)?.[1]);
    objects.set(id, { text: streamStart < 0 ? body : body.slice(0, streamStart),
      stream: streamStart < 0 ? null : buffer.subarray(offset + streamStart + 8, offset + streamStart + 8 + length) });
  }
  return objects;
}

function inspectPages(objects) {
  return [...objects.values()].filter(object => /\/Type \/Page\b/.test(object.text)).map(page => {
    const size = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(page.text).slice(1).map(Number);
    const contentId = Number(/\/Contents (\d+) 0 R/.exec(page.text)[1]);
    const imageIds = [...page.text.matchAll(/\/Im\d+ (\d+) 0 R/g)].map(match => Number(match[1]));
    const rectangles = [...objects.get(contentId).stream.toString('ascii').matchAll(/([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\n\/Im(\d+) Do/g)]
      .map(match => ({ width: Number(match[1]), height: Number(match[2]), x: Number(match[3]), y: Number(match[4]), slot: Number(match[5]) }));
    return { size, imageIds, rectangles };
  });
}

test('writes ordered multi-page PDF with valid xref, lossless RGB images and correct page dimensions', async t => {
  const { image, output } = await fixture(t);
  const first = await image('横向.png', 20, 10, '#ff0000');
  const second = await image('纵向.png', 12, 24, '#00ff00');
  const progress = [];
  const result = await writeImagePdf({ inputPaths: [first, second], outputPath: output, onProgress: p => progress.push(p.progress) });
  const pdf = await fs.readFile(output), objects = parsePdf(pdf);
  assert.equal(result.pages, 2);
  assert.equal(result.inputCount, 2);
  assert.equal(result.imagesPerPage, 1);
  assert.equal(result.size, pdf.length);
  assert.deepEqual(progress, [0, .5, .5, 1]);
  assert.match(objects.get(2).text, /\/Count 2 \/Kids \[5 0 R 8 0 R\]/);
  assert.match(objects.get(5).text, /\/MediaBox \[0 0 15 7.5\]/);
  assert.match(objects.get(8).text, /\/MediaBox \[0 0 9 18\]/);
  assert.match(objects.get(3).text, /\/Width 20 \/Height 10 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8/);
  assert.deepEqual(zlib.inflateSync(objects.get(3).stream), Buffer.from(Array(200).fill([255, 0, 0]).flat()));
  assert.deepEqual(zlib.inflateSync(objects.get(6).stream), Buffer.from(Array(288).fill([0, 255, 0]).flat()));
  assert.equal(objects.get(4).stream.toString(), 'q\n15 0 0 7.5 0 0 cm\n/Im0 Do\nQ\n');
});

test('flattens transparency onto white and applies EXIF orientation before embedding', async t => {
  const { dir, image, output } = await fixture(t);
  const transparent = await image('transparent.png', 1, 1, { r: 15, g: 80, b: 160, alpha: 0 });
  const oriented = path.join(dir, 'rotated.jpg');
  await sharp({ create: { width: 4, height: 7, channels: 3, background: '#de5824' } }).withMetadata({ orientation: 6 }).jpeg().toFile(oriented);
  await writeImagePdf({ inputPaths: [transparent, oriented], outputPath: output });
  const objects = parsePdf(await fs.readFile(output));
  assert.deepEqual(zlib.inflateSync(objects.get(3).stream), Buffer.from([255, 255, 255]));
  assert.match(objects.get(6).text, /\/Width 7 \/Height 4/);
  assert.match(objects.get(8).text, /\/MediaBox \[0 0 5.25 3\]/);
});

test('fits A4 pages with margins and chooses landscape only for wide images', async t => {
  const { image, output } = await fixture(t);
  await writeImagePdf({ inputPaths: [await image('wide.png', 200, 100), await image('tall.png', 10, 20)], outputPath: output, options: { pageSize: 'a4', margin: 36 } });
  const objects = parsePdf(await fs.readFile(output));
  assert.match(objects.get(5).text, /\/MediaBox \[0 0 841.8898 595.2756\]/);
  assert.match(objects.get(8).text, /\/MediaBox \[0 0 595.2756 841.8898\]/);
  const layout = pageLayout(200, 100, { pageSize: 'a4', orientation: 'portrait', margin: 36 });
  assert.ok(layout.width < layout.height);
  assert.ok(Math.abs(layout.drawWidth / layout.drawHeight - 2) < 1e-10);
  assert.ok(layout.x >= 36 && layout.y >= 36);
  assert.ok(pageLayout(100_000, 1, {}).width <= 14_400);
});

test('forced image-size page direction changes the paper and fits the upright image without cropping', async t => {
  const { image, output } = await fixture(t);
  await writeImagePdf({ inputPaths: [await image('wide.png', 40, 20)], outputPath: output, options: { pageSize: 'image', orientation: 'portrait' } });
  const objects = parsePdf(await fs.readFile(output));
  assert.match(objects.get(5).text, /\/MediaBox \[0 0 15 30\]/);
  assert.equal(objects.get(4).stream.toString(), 'q\n15 0 0 7.5 0 11.25 cm\n/Im0 Do\nQ\n');
  assert.match(objects.get(3).text, /\/Width 40 \/Height 20/);
  const landscape = pageLayout(20, 40, { pageSize: 'image', orientation: 'landscape', margin: 5 });
  assert.equal(landscape.width, 40);
  assert.equal(landscape.height, 25);
  assert.equal(landscape.drawWidth / landscape.drawHeight, .5);
  assert.ok(landscape.x >= 5 && landscape.y >= 5);
});

test('five images at two per page produce three physical pages in original order', async t => {
  const { image, output } = await fixture(t);
  const inputs = await Promise.all(Array.from({ length: 5 }, (_, index) => image(`${index}.png`, 120, 40, { r: 20 + index * 30, g: 50, b: 70, alpha: 1 })));
  const result = await writeImagePdf({ inputPaths: inputs, outputPath: output, options: { pageSize: 'a4', imagesPerPage: 2, orientation: 'portrait', margin: 18 } });
  assert.equal(result.pages, 3);
  assert.equal(result.inputCount, 5);
  assert.equal(result.imagesPerPage, 2);
  assert.deepEqual(result.layout, { columns: 1, rows: 2, margin: 18, gap: 10 });
  const objects = parsePdf(await fs.readFile(output)), pages = inspectPages(objects);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(page => page.imageIds.length), [2, 2, 1]);
  assert.ok(pages[0].rectangles[0].y > pages[0].rectangles[1].y);
  assert.deepEqual(pages.flatMap(page => page.imageIds).map(id => zlib.inflateSync(objects.get(id).stream)[0]), [20, 50, 80, 110, 140]);
});

test('all invoice grids respect margins, aspect ratio, row-major order, gaps and last-page capacity', async t => {
  const { dir, image } = await fixture(t);
  const inputs = await Promise.all(Array.from({ length: 10 }, (_, index) => image(`${index}.png`, 120, 40, { r: 10 + index * 20, g: 40, b: 60, alpha: 1 })));
  const expectedGrids = { 2: [1, 2], 3: [1, 3], 4: [2, 2], 6: [2, 3], 8: [2, 4], 9: [3, 3] };
  const tolerance = .001;
  for (const [countString, portraitGrid] of Object.entries(expectedGrids)) {
    const count = Number(countString);
    for (const orientation of ['portrait', 'landscape']) {
      const outputPath = path.join(dir, `${count}-${orientation}.pdf`);
      const result = await writeImagePdf({ inputPaths: inputs.slice(0, count + 1), outputPath,
        options: { imagesPerPage: count, orientation, margin: 24, gap: 12 } });
      const [columns, rows] = orientation === 'portrait' ? portraitGrid : [...portraitGrid].reverse();
      assert.equal(result.pages, 2);
      assert.deepEqual(result.layout, { columns, rows, margin: 24, gap: 12 });
      const objects = parsePdf(await fs.readFile(outputPath)), pages = inspectPages(objects);
      assert.deepEqual(pages.map(page => page.imageIds.length), [count, 1]);
      const rects = pages[0].rectangles, [pageWidth, pageHeight] = pages[0].size;
      assert.equal(pageWidth < pageHeight, orientation === 'portrait');
      for (let slot = 0; slot < rects.length; slot++) {
        const rect = rects[slot];
        assert.equal(rect.slot, slot);
        assert.ok(Math.abs(rect.width / rect.height - 3) < tolerance);
        assert.ok(rect.x >= 24 - tolerance && rect.y >= 24 - tolerance);
        assert.ok(rect.x + rect.width <= pageWidth - 24 + tolerance);
        assert.ok(rect.y + rect.height <= pageHeight - 24 + tolerance);
        if (slot && slot % columns) assert.ok(rect.x >= rects[slot - 1].x + rects[slot - 1].width + 12 - tolerance);
        if (slot >= columns) assert.ok(rect.y + rect.height <= rects[slot - columns].y - 12 + tolerance);
      }
      const reds = pages.flatMap(page => page.imageIds).map(id => zlib.inflateSync(objects.get(id).stream)[0]);
      assert.deepEqual(reds, Array.from({ length: count + 1 }, (_, index) => 10 + index * 20));
      assert.deepEqual(pages[1].rectangles[0], pages[0].rectangles[0]);
    }
  }
});

test('explicit one-image mode keeps the original default PDF bytes', async t => {
  const { dir, image, output } = await fixture(t);
  const inputs = [await image('first.png', 80, 40), await image('second.png', 30, 60)];
  const explicit = path.join(dir, 'explicit.pdf');
  await writeImagePdf({ inputPaths: inputs, outputPath: output });
  await writeImagePdf({ inputPaths: inputs, outputPath: explicit, options: { imagesPerPage: 1, gap: 55 } });
  assert.deepEqual(await fs.readFile(output), await fs.readFile(explicit));
});

test('does not overwrite existing output or remove it after failure', async t => {
  const { image, output } = await fixture(t);
  await fs.writeFile(output, 'existing');
  await assert.rejects(writeImagePdf({ inputPaths: [await image('input.png')], outputPath: output }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(output, 'utf8'), 'existing');
});

test('cancellation removes partial output and emits AbortError', async t => {
  const { image, output } = await fixture(t);
  const input = await image('input.png');
  const controller = new AbortController();
  await assert.rejects(writeImagePdf({ inputPaths: [input, input], outputPath: output, signal: controller.signal,
    onProgress: progress => { if (progress.progress === .5) controller.abort(); } }), { name: 'AbortError' });
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  await assert.rejects(writeImagePdf({ inputPaths: [input], outputPath: output, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});

test('invalid input and multi-page image leave no incomplete document', async t => {
  const { dir, output } = await fixture(t);
  const invalid = path.join(dir, 'invalid.png');
  await fs.writeFile(invalid, 'not an image');
  await assert.rejects(writeImagePdf({ inputPaths: [invalid], outputPath: output }));
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  const animated = path.join(dir, 'animated.gif');
  const frames = Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]);
  await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).gif({ loop: 0, delay: [10, 10] }).toFile(animated);
  const metadata = await sharp(animated).metadata();
  assert.equal(metadata.pages, 2);
  await assert.rejects(writeImagePdf({ inputPaths: [animated], outputPath: output }), /动图或多页/);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});

test('rejects invalid options and input lists before creating output', async t => {
  const { output } = await fixture(t);
  for (const options of [{ pageSize: 'letter' }, { orientation: 'sideways' }, { margin: -1 }, { margin: NaN }, { margin: '20' },
    { imagesPerPage: 5 }, { imagesPerPage: 2.5 }, { imagesPerPage: '2' }, { imagesPerPage: 2, pageSize: 'image' },
    { gap: -1 }, { gap: Infinity }, { gap: 101 }, { gap: '10' }]) assert.throws(() => pdfOptions(options));
  assert.deepEqual(pdfOptions(), { pageSize: 'image', orientation: 'auto', margin: 0, imagesPerPage: 1, gap: 10 });
  for (const inputPaths of [[], ['relative.png'], Array(257).fill('C:\\image.png')]) await assert.rejects(writeImagePdf({ inputPaths, outputPath: output }));
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});
