const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateManifest, verifyVideoRuntime } = require('../scripts/prepare-video-runtime.cjs');
const realManifest = require('../video-runtime-manifest.json');

test('video runtime manifest pins an LGPL Windows build and disallows traversal', () => {
  assert.equal(validateManifest(realManifest), realManifest);
  for (const update of [
    { archive: { ...realManifest.archive, url: 'http://example.test/tool.zip' } },
    { archive: { ...realManifest.archive, sha256: '' } },
    { files: [{ ...realManifest.files[0], path: '../ffmpeg.exe' }] },
    { files: [{ ...realManifest.files[0], archivePath: 'bin/../../tool.exe' }] },
    { files: [] }
  ]) assert.throws(() => validateManifest({ ...realManifest, ...update }));
});

test('video runtime verification rejects altered binaries before execution or packaging', async t => {
  const base = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'video-runtime-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), base);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from('MZ-test-only-never-execute');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const files = ['ffmpeg.exe', 'ffprobe.exe'].map(name => ({ path: name, archivePath: `bin/${name}`, size: bytes.length, sha256: digest }));
  const manifest = { ...realManifest, files };
  for (const file of files) await fs.writeFile(path.join(directory, file.path), bytes);
  await verifyVideoRuntime(directory, manifest);
  await fs.writeFile(path.join(directory, 'ffprobe.exe'), Buffer.alloc(bytes.length));
  await assert.rejects(verifyVideoRuntime(directory, manifest), /ffprobe.exe/);
});
