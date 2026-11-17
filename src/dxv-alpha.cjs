'use strict';

// DXV 3 normal-alpha frames store premultiplied BC3 (DXT5/DXT4) textures.
// The packet's raw-texture flag is a standard DXV path; it avoids inventing a
// different codec when the bundled FFmpeg encoder only exposes opaque DXT1.
const fs = require('node:fs/promises');
const path = require('node:path');

const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
const zeros = count => Buffer.alloc(count);
const atom = (name, ...parts) => { const data = Buffer.concat(parts); return Buffer.concat([u32(data.length + 8), Buffer.from(name), data]); };
const full = (name, flags, ...parts) => atom(name, u32(flags), ...parts);
const matrix = () => Buffer.concat([u32(65536), u32(0), u32(0), u32(0), u32(65536), u32(0), u32(0), u32(0), u32(1073741824)]);
function movieHeader(width, height, frames, frameBytes, timescale, delta, offset) {
  const duration = frames * delta, durationMs = Math.round(duration / timescale * 1000);
  if (duration > 0xffffffff || durationMs > 0xffffffff) throw new Error('DXV duration exceeds container limits');
  const mvhd = full('mvhd', 0, u32(0), u32(0), u32(1000), u32(durationMs), u32(65536), u16(256), zeros(10), matrix(), zeros(24), u32(2));
  const tkhd = full('tkhd', 7, u32(0), u32(0), u32(1), u32(0), u32(durationMs), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix(), u32(width * 65536), u32(height * 65536));
  const mdhd = full('mdhd', 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, u32(0), Buffer.from('vide'), zeros(12), Buffer.from('DXV video\0'));
  const compressor = Buffer.alloc(32); compressor[0] = 5; compressor.write('DXV 3', 1);
  const sample = atom('DXD3', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(72 * 65536), u32(72 * 65536), u32(0), u16(1), compressor, u16(32), u16(65535));
  const stbl = atom('stbl', full('stsd', 0, u32(1), sample), full('stts', 0, u32(1), u32(frames), u32(delta)),
    full('stsc', 0, u32(1), u32(1), u32(frames), u32(1)), full('stsz', 0, u32(frameBytes), u32(frames)), full('co64', 0, u32(1), u64(offset)));
  const minf = atom('minf', full('vmhd', 1, zeros(8)), atom('dinf', full('dref', 0, u32(1), full('url ', 1))), stbl);
  return atom('moov', mvhd, atom('trak', tkhd, atom('mdia', mdhd, hdlr, minf)));
}

async function createAlphaMovie(filename, { width, height, numerator, denominator }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535 || !Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 1 || denominator < 1) throw new Error('DXV movie dimensions or frame rate invalid');
  const handle = await fs.open(path.resolve(filename), 'wx');
  const ftyp = atom('ftyp', Buffer.from('qt  '), u32(0), Buffer.from('qt  '));
  const mdatOffset = ftyp.length, sampleOffset = mdatOffset + 16;
  let frames = 0, bytes = 0, finished = false;
  const write = async data => { let position = 0; while (position < data.length) { const written = await handle.write(data, position, data.length - position); position += written.bytesWritten; } };
  try { await write(ftyp); await write(Buffer.concat([u32(1), Buffer.from('mdat'), u64(16)])); }
  catch (error) { await handle.close(); await fs.unlink(filename).catch(() => {}); throw error; }
  return {
    async append(texture) { if (finished) throw new Error('DXV movie is closed'); const expected = Math.ceil(width / 16) * 16 * Math.ceil(height / 16) * 16; if (texture.length !== expected) throw new Error('DXV alpha texture size mismatch'); const header = Buffer.alloc(12); header.writeUInt32LE(0x44585435, 0); header[4] = 4; header[6] = 1; header.writeUInt32LE(texture.length, 8); await write(header); await write(texture); frames++; bytes += header.length + texture.length; },
    async finish() {
      if (finished) throw new Error('DXV movie is closed');
      finished = true;
      try {
        if (!frames) throw new Error('DXV movie has no frames');
        await write(movieHeader(width, height, frames, bytes / frames, numerator, denominator, sampleOffset));
        await handle.write(u64(bytes + 16), 0, 8, mdatOffset + 8);
        await handle.close();
        return { frames, duration: frames * denominator / numerator };
      } catch (error) { await handle.close().catch(() => {}); await fs.unlink(filename).catch(() => {}); throw error; }
    },
    async abort() { if (!finished) { finished = true; await handle.close().catch(() => {}); await fs.unlink(filename).catch(() => {}); } }
  };
}

module.exports = { createAlphaMovie };
