'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { copyApplicationSource } = require('../scripts/package.cjs');
const { createVideoSiteAuth } = require('../src/video-site-auth.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-package-native-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'src'), destination = path.join(directory, 'app', 'src');
  await fs.mkdir(source);
  return { directory, source, destination,
    async write(relative, content = relative) {
      const filename = path.join(source, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, content);
    } };
}

test('packaging retains native runtime sources but excludes local binaries and build files', async t => {
  const f = await fixture(t);
  const retained = ['Program.cs', 'YouTubeConnection.cs', 'Additional.Helper.cs'];
  const excluded = ['Mosaic.VideoAuth.exe', 'Mosaic.VideoAuth.pdb', 'Mosaic.VideoAuth.dll', 'helper.EXE',
    'build.ps1', 'README.md', 'obj/Generated.cs', 'bin/Release/Mosaic.VideoAuth.exe'];
  for (const filename of [...retained, ...excluded]) await f.write(`video-auth-native/${filename}`);
  await f.write('main.cjs', 'entry point');
  await f.write('other-runtime/required.exe', 'unrelated runtime binary');
  await copyApplicationSource(f.source, f.destination);
  assert.deepEqual((await fs.readdir(path.join(f.destination, 'video-auth-native'))).sort(), retained.sort());
  for (const filename of retained) {
    assert.equal(await fs.readFile(path.join(f.destination, 'video-auth-native', filename), 'utf8'), `video-auth-native/${filename}`);
  }
  assert.equal(await fs.readFile(path.join(f.destination, 'main.cjs'), 'utf8'), 'entry point');
  assert.equal(await fs.readFile(path.join(f.destination, 'other-runtime', 'required.exe'), 'utf8'), 'unrelated runtime binary');
  assert.equal(await fs.readFile(path.join(f.source, 'video-auth-native', 'Mosaic.VideoAuth.exe'), 'utf8'), 'video-auth-native/Mosaic.VideoAuth.exe');
});

test('source packaging retains the existing refusal to follow linked directories', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'Program.cs'), 'must not be copied');
  await fs.symlink(outside, path.join(f.source, 'video-auth-native'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyApplicationSource(f.source, f.destination), /linked path/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('the packaged native sources still compile without a bundled executable', { timeout: 90000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows native compilation'); return; }
  const f = await fixture(t);
  await fs.cp(path.resolve(__dirname, '..', 'src', 'video-auth-native'), path.join(f.source, 'video-auth-native'), { recursive: true });
  await copyApplicationSource(f.source, f.destination);
  const nativeSourceDir = path.join(f.destination, 'video-auth-native');
  assert.ok((await fs.readdir(nativeSourceDir)).every(name => name.endsWith('.cs')));
  const auth = createVideoSiteAuth({ directory: path.join(f.directory, 'state'), nativeSourceDir });
  try {
    assert.deepEqual(await auth.disconnect('youtube'), { site: 'youtube', connected: false, connecting: false });
  } finally { await auth.shutdown(); }
});
