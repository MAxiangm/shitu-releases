'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createAudioEngine } = require('../src/audio-engine.cjs');
const { Library } = require('../src/library.cjs');
const { AUDIO, SUPPORTED, MIME } = require('../src/media-formats.cjs');
const root = path.resolve(__dirname, '..');
const testsRoot = path.join(root, '.recovery', 'tests');
const runtimeDir = path.join(root, 'video-runtime');
const ffmpeg = path.join(runtimeDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
}
async function digest(file) { return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
async function fixture(t) {
  try { await fs.access(ffmpeg); } catch { t.skip('Bundled audio decoder unavailable'); return; }
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'audio-'));
  const cacheDir = path.join(directory, 'cache'), engine = createAudioEngine({ runtimeDir, cacheDir });
  const source = path.join(directory, 'source.wav');
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1.25', '-ac', '2', '-c:a', 'pcm_s16le', source]);
  t.after(async () => { await engine.shutdown(); const relative = path.relative(testsRoot, directory); assert.ok(relative && !relative.startsWith('..')); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, cacheDir, engine, source };
}

test('music formats are supported without changing legacy Ogg video MIME', () => {
  for (const ext of ['mp3', 'mp2', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'ape', 'wma', 'alac', 'amr', 'ac3', 'dts', 'mka']) {
    assert.ok(AUDIO.has(ext)); assert.ok(SUPPORTED.has(ext)); assert.ok(MIME[ext]);
  }
  assert.equal(MIME.ogg, 'video/ogg');
  assert.equal(SUPPORTED.has('m3u8'), false);
});

test('actual lossy and lossless music retain metadata and use native playback when supported', async t => {
  const setup = await fixture(t); if (!setup) return;
  const formats = [['mp3', 'libmp3lame'], ['flac', 'flac'], ['m4a', 'aac'], ['aac', 'aac'], ['ogg', 'libvorbis'], ['opus', 'libopus']];
  const originalHash = await digest(setup.source);
  const wave = await setup.engine.preview(setup.source, { key: originalHash });
  assert.equal(wave.direct, true); assert.equal(wave.mimeType, 'audio/wav');
  for (const [ext, encoder] of formats) {
    const file = path.join(setup.directory, `music.${ext}`);
    run(['-i', setup.source, '-c:a', encoder, '-metadata', 'title=Test Song', '-metadata', 'artist=Test Artist', '-metadata', 'album=Test Album', file]);
    const before = await digest(file), metadata = await setup.engine.probe(file);
    assert.equal(metadata.mediaType, 'audio'); assert.ok(metadata.duration >= 1.2 && metadata.duration < 1.5, ext);
    assert.equal(metadata.channels, 2); assert.ok(metadata.sampleRate >= 44100);
    if (ext !== 'aac') { assert.equal(metadata.audio.artist, 'Test Artist', ext); assert.equal(metadata.audio.album, 'Test Album', ext); }
    const preview = await setup.engine.preview(file, { key: before });
    assert.equal(preview.direct, true, ext); assert.equal(preview.path, file); assert.equal(preview.transcoded, false);
    assert.equal(await digest(file), before);
  }
  assert.equal(await digest(setup.source), originalHash);
});

test('AIFF, WMA and ALAC previews convert to complete cached MP3 without touching originals', async t => {
  const setup = await fixture(t); if (!setup) return;
  for (const [name, encoder] of [['music.aiff', 'pcm_s16be'], ['music.wma', 'wmav2'], ['alac.m4a', 'alac']]) {
    const file = path.join(setup.directory, name);
    run(['-i', setup.source, '-c:a', encoder, '-metadata', 'artist=Unchanged Artist', file]);
    const before = await digest(file), events = [], originalMetadata = await setup.engine.probe(file);
    const preview = await setup.engine.preview(file, { key: before, onProgress: event => events.push(event) });
    assert.equal(preview.transcoded, true); assert.equal(preview.direct, false); assert.equal(preview.mimeType, 'audio/mpeg');
    assert.notEqual(preview.path, file); assert.deepEqual(preview.audio, originalMetadata.audio);
    const playable = await setup.engine.probe(preview.path);
    assert.equal(playable.audioCodec, 'mp3'); assert.ok(playable.duration >= 1.2);
    const again = await setup.engine.preview(file, { key: before }); assert.equal(again.cached, true); assert.equal(again.path, preview.path);
    assert.ok(events.some(event => event.state === 'converting')); assert.equal(await digest(file), before);
    // A corrupt cache must not survive the next open, even with a valid sidecar.
    await fs.writeFile(preview.path, 'broken');
    const repaired = await setup.engine.preview(file, { key: before }); assert.equal(repaired.cached, false);
    assert.equal((await setup.engine.probe(repaired.path)).audioCodec, 'mp3');
  }
});

test('cover art does not turn music into video and thumbnail extraction preserves source', async t => {
  const setup = await fixture(t); if (!setup) return;
  const cover = path.join(setup.directory, 'cover.jpg'), music = path.join(setup.directory, 'cover.mp3'), thumbnail = path.join(setup.directory, 'thumbnail.jpg');
  run(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', cover]);
  run(['-i', setup.source, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic', music]);
  const before = await digest(music), metadata = await setup.engine.thumbnail(music, thumbnail);
  assert.equal(metadata.mediaType, 'audio'); assert.ok((await fs.stat(thumbnail)).size > 20); assert.equal(await digest(music), before);
  assert.equal(metadata.coverIndex, undefined);
  const fastTimeout = createAudioEngine({ runtimeDir, cacheDir: path.join(setup.directory, 'cover-timeout'), timeouts: { thumbnailMs: 1 } });
  try {
    const withoutCover = await fastTimeout.thumbnail(music, path.join(setup.directory, 'failed-cover.jpg'));
    assert.equal(withoutCover.mediaType, 'audio'); assert.ok(withoutCover.duration > 1);
    assert.equal(await digest(music), before);
  } finally { await fastTimeout.shutdown(); }
});

test('cancelled conversion and invalid or changed music never publish a preview', async t => {
  const setup = await fixture(t); if (!setup) return;
  const file = path.join(setup.directory, 'long.aiff'); run(['-i', setup.source, '-c:a', 'pcm_s16be', file]);
  const controller = new AbortController();
  await assert.rejects(setup.engine.preview(file, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(setup.cacheDir), []);
  await assert.rejects(setup.engine.preview(file, { key: '0'.repeat(64) }), /内容已变化/);
  const invalid = path.join(setup.directory, 'bad.mp3'); await fs.writeFile(invalid, '#EXTM3U\nhttps://example.com/private.mp3');
  await assert.rejects(setup.engine.probe(invalid), /无法读取/);
  await setup.engine.shutdown(); await assert.rejects(setup.engine.probe(file), /已关闭/);
});

test('audio-only Ogg and genuine Ogg video remain distinct through import, reopening, export and trash', async t => {
  const setup = await fixture(t); if (!setup) return;
  const audio = path.join(setup.directory, 'song.ogg'), video = path.join(setup.directory, 'movie.ogg');
  run(['-i', setup.source, '-c:a', 'libvorbis', '-metadata', 'artist=Library Artist', audio]);
  run(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=10:d=1', '-i', setup.source, '-shortest', '-c:v', 'libtheora', '-c:a', 'libvorbis', video]);
  await assert.rejects(setup.engine.probe(video), { code: 'AUDIO_HAS_VIDEO' });
  const library = new Library({ root: path.join(setup.directory, 'library'), createThumbnail: async (file, destination) => {
    try { return await setup.engine.thumbnail(file, destination); }
    catch (error) { if (error.code === 'AUDIO_HAS_VIDEO') return { mediaType: 'video', codec: 'theora', width: 64, height: 64 }; throw error; }
  } });
  await library.init();
  const imported = await library.importPaths([audio, video]); assert.equal(imported.imported, 2);
  const [song, movie] = library.snapshot().assets;
  assert.equal(song.mediaType, 'audio'); assert.equal(song.audio.artist, 'Library Artist'); assert.ok(song.duration >= 1.2); assert.equal(song.thumbnail, null);
  assert.equal(movie.mediaType, 'video'); assert.equal(movie.codec, 'theora');
  const legacyIndex = JSON.parse(await fs.readFile(library.indexPath, 'utf8'));
  delete legacyIndex.assets[1].mediaType;
  await fs.writeFile(library.indexPath, JSON.stringify(legacyIndex));
  const reopened = new Library({ root: library.root }); await reopened.init(); assert.equal(reopened.snapshot().assets[0].mediaType, 'audio');
  assert.equal(reopened.snapshot().assets[1].mediaType, 'video', 'an old Ogg video is not reclassified by its suffix');
  const output = path.join(setup.directory, 'exports'); await reopened.exportAssets([song.id], output);
  assert.equal(await digest(path.join(output, 'song.ogg')), await digest(audio));
  await reopened.setTrash([song.id], true); assert.ok(reopened.snapshot().assets[0].trashedAt);
  await reopened.setTrash([song.id], false); assert.equal(reopened.snapshot().assets[0].trashedAt, null);
  const backup = await reopened.backupTo(path.join(setup.directory, 'backups'));
  const restoredBackup = new Library({ root: backup.path }); await restoredBackup.init();
  assert.equal(restoredBackup.snapshot().assets[0].audio.artist, 'Library Artist');
  assert.equal(await digest(restoredBackup.getAssetPath(song.id)), await digest(audio));
  const thumbnailAttempt = await library.refreshVideoMetadata([song.id]); assert.equal(thumbnailAttempt.updated, 0);
  await assert.rejects(library.setVideoThumbnail(song.id, { expectedHash: song.hash, jpeg: Buffer.from('bad') }), /视频已变化/);
  const managed = reopened.getAssetPath(song.id);
  await reopened.setTrash([song.id], true); await reopened.deletePermanently([song.id]);
  await assert.rejects(fs.access(managed)); assert.ok((await fs.stat(audio)).isFile(), 'original imported file stays untouched');
});

test('every declared music extension imports as an audio asset and retains independent metadata', async t => {
  const setup = await fixture(t); if (!setup) return;
  const files = [];
  for (const ext of AUDIO) { const file = path.join(setup.directory, `format.${ext}`); await fs.writeFile(file, `unit fixture for ${ext}`); files.push(file); }
  const library = new Library({ root: path.join(setup.directory, 'format-library'), createThumbnail: async () => ({
    mediaType: 'audio', duration: 2.5, codec: 'pcm_s16le', audioCodec: 'pcm_s16le', sampleRate: 44100, channels: 2, bitrate: 1411200,
    bitsPerSample: 16, audio: { title: 'Song', artist: 'Artist', album: 'Album' }, arbitraryPath: 'must not be saved'
  }) });
  await library.init(); const imported = await library.importPaths(files); assert.equal(imported.imported, AUDIO.size);
  assert.equal(imported.errors.length, 0);
  for (const asset of library.snapshot().assets) {
    assert.equal(asset.mediaType, 'audio', asset.ext); assert.equal(asset.sampleRate, 44100); assert.equal(asset.audio.artist, 'Artist');
    assert.equal(asset.thumbnail, null); assert.equal(Object.hasOwn(asset, 'arbitraryPath'), false);
  }
  const reopened = new Library({ root: library.root }); await reopened.init(); assert.equal(reopened.snapshot().assets.length, AUDIO.size);
  const asset = reopened.snapshot().assets[0], before = await fs.readFile(reopened.indexPath, 'utf8');
  await reopened.setAudioMetadata(asset.id, asset.hash, { ...asset, mediaType: 'audio' });
  assert.equal(await fs.readFile(reopened.indexPath, 'utf8'), before, 'unchanged technical metadata must not rewrite the index');
  await assert.rejects(reopened.setAudioMetadata(asset.id, '0'.repeat(64), asset), /音乐已变化/);
});

test('invalid music metadata in an index is rejected without altering the original index', async t => {
  const setup = await fixture(t); if (!setup) return;
  const library = new Library({ root: path.join(setup.directory, 'invalid-library') }); await library.init();
  await library.importPaths([setup.source]);
  const pristine = await fs.readFile(library.indexPath, 'utf8');
  for (const mutate of [asset => { asset.sampleRate = -1; }, asset => { asset.channels = 100; },
    asset => { asset.audio = { privateUrl: 'https://example.com/' }; }, asset => { asset.audio = { artist: 'bad\nartist' }; },
    asset => { asset.mediaType = 'video'; }]) {
    const data = JSON.parse(pristine); mutate(data.assets[0]); const invalid = JSON.stringify(data);
    await fs.writeFile(library.indexPath, invalid);
    await assert.rejects(new Library({ root: library.root }).init(), /索引无法读取/);
    assert.equal(await fs.readFile(library.indexPath, 'utf8'), invalid);
  }
});
