'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { alphaFromHeader, readDXVAlpha } = require('../src/dxv-format.cjs');

test('DXV alpha is determined by texture header rather than RGBA decoder output', () => {
  for (const [tag, alpha] of [[0x44585431, false], [0x59434736, false], [0x44585435, true], [0x59473130, true]]) {
    const header = Buffer.alloc(12); header.writeUInt32LE(tag); assert.equal(alphaFromHeader(header), alpha);
  }
  assert.equal(alphaFromHeader(Buffer.from([0, 0, 0, 0xc3])), true);
  assert.equal(alphaFromHeader(Buffer.from([0, 0, 0, 0xa3])), false);
  assert.equal(alphaFromHeader(Buffer.from([0, 0, 0, 0x82])), false);
  assert.equal(alphaFromHeader(Buffer.from([0, 0, 0, 0x99])), null);
  assert.equal(alphaFromHeader(Buffer.alloc(3)), null); assert.equal(alphaFromHeader(null), null);
});

test('DXV header reader uses a bounded packet offset and closes its file', async t => {
  const root = path.resolve(__dirname, '..', '.recovery', 'tests'); await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'dxv-header-'));
  t.after(async () => { const rel = path.relative(root, dir); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); await fs.rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'packet.bin'), bytes = Buffer.alloc(48); bytes.writeUInt32LE(0x44585435, 24); await fs.writeFile(file, bytes);
  assert.equal(await readDXVAlpha(file, 24), true); assert.equal(await readDXVAlpha(file, 47), null);
  for (const offset of [-1, NaN, Infinity, 1.5, '24']) assert.equal(await readDXVAlpha(file, offset), null);
  await fs.rename(file, path.join(dir, 'closed.bin'));
});
