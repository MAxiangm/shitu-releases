'use strict';

const fs = require('node:fs/promises');

function alphaFromHeader(header) {
  if (!Buffer.isBuffer(header) || header.length < 4) return null;
  const tag = header.readUInt32LE(0);
  if (tag === 0x44585431 || tag === 0x59434736) return false; // DXT1 / YCG6
  if (tag === 0x44585435 || tag === 0x59473130) return true; // DXT5 / YG10
  // Legacy packets start with a 24-bit size and a type/version byte.
  const type = header[3], version = (type & 15) - 1;
  if (version < 1 || version > 2 || !(type & 0xe0)) return null;
  if (type & 0x40) return true;
  if (type & 0x20 || version === 1) return false;
  return null;
}

async function readDXVAlpha(filename, position) {
  if (!Number.isSafeInteger(position) || position < 0) return null;
  const handle = await fs.open(filename, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
    return alphaFromHeader(bytes.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

module.exports = { alphaFromHeader, readDXVAlpha };
