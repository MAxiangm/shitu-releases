'use strict';
// Test-only OFL fixtures, pinned to Adobe's Source Sans 3 repository. Never ship
// these files with the application or install them into the operating system.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { root } = require('./runtime.cjs');
const revision = '87b37a2daaed80fcb8e8ccb0085c4d72ddade12e';
const files = [
  ['LICENSE.md', '56af9b9c6715597e458284a474dc118a50a4150e9d547c70f7b4a33c3e6a9328'],
  ['TTF/SourceSans3-Regular.ttf', '4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f'],
  ['TTF/SourceSans3-Bold.ttf', '9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a'],
  ['OTF/SourceSans3-Regular.otf', '08df266400933d3178d081a45f94a08814c3e55b4b7dd2e0ff69cb1329f13ab6'],
  ['WOFF/TTF/SourceSans3-Regular.ttf.woff', '56413337e96f5764882f3e18eaa654eec27515ec7c3de3520eec9e36b25371b9'],
  ['WOFF2/TTF/SourceSans3-Regular.ttf.woff2', '53492fb3a0def77354f166a55d09b63a10855e91c206c7620a81cf56e97f8ec3']
];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function combineCollection(fonts) {
  let cursor = 12 + fonts.length * 4;
  const entries = fonts.map(original => {
    cursor = (cursor + 3) & ~3;
    const offset = cursor, bytes = Buffer.from(original), tableCount = bytes.readUInt16BE(4);
    if (![0x00010000, 0x4f54544f].includes(bytes.readUInt32BE(0)) || tableCount < 1 || 12 + tableCount * 16 > bytes.length) throw new Error('Fixture is not an OpenType sfnt');
    for (let index = 0; index < tableCount; index++) {
      const record = 12 + index * 16;
      const tableOffset = bytes.readUInt32BE(record + 8), length = bytes.readUInt32BE(record + 12);
      if (tableOffset + length > bytes.length) throw new Error('Fixture table exceeds the sfnt');
      bytes.writeUInt32BE(tableOffset + offset, record + 8);
      if (bytes.toString('ascii', record, record + 4) === 'head') bytes.writeUInt32BE(0, tableOffset + 8);
    }
    cursor += bytes.length;
    return { bytes, offset };
  });
  const collection = Buffer.alloc(cursor);
  collection.write('ttcf', 0, 'ascii'); collection.writeUInt32BE(0x00010000, 4); collection.writeUInt32BE(entries.length, 8);
  entries.forEach((entry, index) => { collection.writeUInt32BE(entry.offset, 12 + 4 * index); entry.bytes.copy(collection, entry.offset); });
  return collection;
}

async function prepare({ download = false } = {}) {
  const directory = path.join(root, '.recovery', 'font-test-fixtures'); await fs.mkdir(directory, { recursive: true });
  for (const [relative, expected] of files) {
    const destination = path.join(directory, path.basename(relative));
    let bytes = await fs.readFile(destination).catch(() => null);
    if (!bytes || sha256(bytes) !== expected) {
      if (!download) throw new Error('Run node scripts/prepare-font-test-fixtures.cjs to prepare the pinned OFL fonts before the offline smoke test');
      const response = await fetch(`https://raw.githubusercontent.com/adobe-fonts/source-sans/${revision}/${relative}`, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Font fixture download returned HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 2 * 1024 * 1024 || sha256(bytes) !== expected) throw new Error(`Font fixture checksum mismatch: ${relative}`);
      await fs.writeFile(destination, bytes);
    }
  }
  const collection = combineCollection(await Promise.all(['SourceSans3-Regular.ttf', 'SourceSans3-Bold.ttf'].map(name => fs.readFile(path.join(directory, name)))));
  await fs.writeFile(path.join(directory, 'SourceSans3-Collection.ttc'), collection);
  await fs.writeFile(path.join(directory, 'SourceSans3-CFFCollection.otc'), combineCollection([await fs.readFile(path.join(directory, 'SourceSans3-Regular.otf'))]));
  return { directory, revision, license: path.join(directory, 'LICENSE.md'), files: [
    'SourceSans3-Regular.ttf', 'SourceSans3-Regular.otf', 'SourceSans3-Regular.ttf.woff', 'SourceSans3-Regular.ttf.woff2', 'SourceSans3-Collection.ttc', 'SourceSans3-CFFCollection.otc'
  ].map(name => path.join(directory, name)) };
}
if (require.main === module) prepare({ download: true }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, combineCollection };
