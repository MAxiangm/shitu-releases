const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateYouTubeManifest, verifyYouTubeRuntime } = require('../scripts/prepare-youtube-runtime.cjs');
const manifest = require('../youtube-runtime-manifest.json');

test('YouTube runtime pins official binary URLs, checksums and fixed file names', () => {
  assert.equal(validateYouTubeManifest(manifest), manifest);
  for (const update of [
    { url: manifest.components[0].url.replace('https:', 'http:') },
    { url: manifest.components[0].url.replace('github.com', 'downloads.example.test') },
    { url: `${manifest.components[0].url}?mirror=1` },
    { sha256: '' },
    { file: { ...manifest.components[0].file, path: '../yt-dlp.exe' } },
    { file: { ...manifest.components[0].file, size: 0 } }
  ]) assert.throws(() => validateYouTubeManifest({ ...manifest, components: [{ ...manifest.components[0], ...update }, manifest.components[1]] }));
  assert.throws(() => validateYouTubeManifest({ ...manifest, components: [manifest.components[0], manifest.components[0]] }));
});

test('YouTube runtime verification rejects changed binaries before packaging', async t => {
  const base = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'youtube-runtime-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), base);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from('MZ-test-fixture-never-execute');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const components = manifest.components.map(item => ({ ...item,
    ...(item.name === 'yt-dlp' ? { size: bytes.length, sha256: digest } : {}),
    file: { ...item.file, size: bytes.length, sha256: digest }
  }));
  const fixture = { ...manifest, components };
  for (const item of components) await fs.writeFile(path.join(directory, item.file.path), bytes);
  await verifyYouTubeRuntime(directory, fixture);
  await fs.writeFile(path.join(directory, 'deno.exe'), Buffer.alloc(bytes.length));
  await assert.rejects(verifyYouTubeRuntime(directory, fixture), /deno.exe/);
});
