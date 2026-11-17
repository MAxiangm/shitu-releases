'use strict';
// Public FFmpeg FATE decoder samples are downloaded for tests, never packaged.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const fixtures = [
  ['dxv-na.mov', '70151d33af69df482dd8d52ccd851e81ab732a2565c55e94259def6c91b866a1'],
  ['dxv-wa.mov', '62b6d0beeb82c36448165503e8a75fa2d22d8d82dbcac0fac1c7ce039270c5e8'],
  ['dxv3-hqna.mov', '0a9855ce13a58d3861a5626532ba52099b05d4329f8b468c6774c00fd709bc4c'],
  ['dxv3-hqwa.mov', '30f2f60095b2ff62702a01d574fc2270a0dd428bf7c08a3456aa30cadb28b243'],
  ['dxv3-nqna.mov', '58623e216687e53d84c3c31d77618c4b498cea706fd0cfc110565bfb1a8bf4b0'],
  ['dxv3-nqwa.mov', '47b770ab642eb32c743b8b700943870fae8a5d013fd94f869bc3f600db08b8b5']
];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function prepare() {
  const directory = path.resolve(__dirname, '..', '.recovery', 'samples', 'dxv');
  await fs.mkdir(directory, { recursive: true });
  for (const [name, digest] of fixtures) {
    const file = path.join(directory, name);
    const existing = await fs.readFile(file).catch(() => null);
    if (existing && hash(existing) === digest) continue;
    const response = await fetch(`https://fate-suite.ffmpeg.org/dxv/${name}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`DXV test fixture returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 1024 * 1024 || hash(bytes) !== digest) throw new Error(`DXV test fixture failed SHA-256: ${name}`);
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, file);
  }
  console.log('Verified 6 FFmpeg FATE DXV/DXV3 test samples.');
}
if (require.main === module) prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare };
