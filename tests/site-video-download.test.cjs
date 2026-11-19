'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { videoPageSource } = require('../src/video-page-source.cjs');
const { downloadSiteVideo } = require('../src/youtube-download.cjs');

const cases = [
  ['youtube', 'BaW_jenozKc', 'https://youtu.be/BaW_jenozKc?t=3', 'https://www.youtube.com/watch?v=BaW_jenozKc', 'Youtube'],
  ['instagram', 'CxyzAB_1234', 'https://instagram.com/example/reels/CxyzAB_1234/?igsh=tracking', 'https://www.instagram.com/reel/CxyzAB_1234/', 'Instagram'],
  ['x', '1600009574919962625', 'https://twitter.com/example/status/1600009574919962625/video/1?s=20', 'https://x.com/i/status/1600009574919962625', 'Twitter'],
  ['pinterest', '123456789012345678', 'https://de.pinterest.com/pin/123456789012345678/?x=tracking', 'https://www.pinterest.com/pin/123456789012345678/', 'Pinterest'],
  ['vimeo', '123456789', 'https://player.vimeo.com/video/123456789?autoplay=1', 'https://vimeo.com/123456789', 'Vimeo'],
  ['bilibili', 'BV1bK411W797:p2', 'https://m.bilibili.com/video/BV1bK411W797?p=2&share_source=test', 'https://www.bilibili.com/video/BV1bK411W797/?p=2', 'BiliBili']
];

test('video page sources canonicalize only a selected video or post from supported sites', () => {
  for (const [site, videoId, input, url] of cases) assert.deepEqual(videoPageSource(input), { site, videoId, url });
  assert.equal(videoPageSource('https://vimeo.com/channels/staffpicks/123456789').url, 'https://vimeo.com/123456789');
  assert.equal(videoPageSource('https://platform.twitter.com/embed/Tweet.html?id=1600009574919962625').url, cases[2][3]);
  assert.equal(videoPageSource('https://www.instagram.com/p/CxyzAB_1234/embed/captioned/').url, 'https://www.instagram.com/p/CxyzAB_1234/');
});

test('video page sources reject arbitrary hosts, playlists, ambiguous IDs and credential-bearing addresses', () => {
  for (const value of [
    'http://x.com/user/status/123', 'https://x.com.evil.test/user/status/123', 'https://user:pass@vimeo.com/123',
    'https://vimeo.com:444/123', 'https://vimeo.com/123/extra', 'https://pinterest.com/example/board/',
    'https://www.instagram.com/example/', 'https://www.youtube.com/playlist?list=test',
    'https://www.youtube.com/watch?v=BaW_jenozKc&v=aaaaaaaaaaa', 'https://x.com/i/status/123\\evil',
    'https://127.0.0.1/watch?v=BaW_jenozKc', 'https://x.com/user/status/123\n',
    'https://platform.twitter.com/embed/Tweet.html?id=123&id=456'
  ]) assert.throws(() => videoPageSource(value), error => error.code === 'INVALID_VIDEO_PAGE', value);
});

async function fixture(t, data = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-site-video-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'output'), runtimeDir = path.join(root, 'runtime');
  await fs.mkdir(directory); await fs.mkdir(runtimeDir);
  await Promise.all(['yt-dlp.exe', 'deno.exe', 'ffmpeg.exe'].map(name => fs.writeFile(path.join(runtimeDir, name), 'test')));
  const calls = [], filePath = path.join(directory, 'capture.mp4');
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
  const base = cases.find(item => item[0] === (data.site || 'x'));
  const metadata = { id: base[0] === 'x' ? '1599999999999999999' : base[0] === 'bilibili' ? base[1].replace(':p', '_p') : base[1], display_id: base[1],
    webpage_url: base[3], extractor_key: base[4], vcodec: 'h264', acodec: 'aac', duration: 12.5, ...data.metadata };
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { process.nextTick(() => child.emit('close', 1)); return true; };
    calls.push({ executable, args, options });
    setImmediate(async () => {
      try {
        child.stdout.write(`MOSAIC_META:${JSON.stringify(metadata)}\n`);
        await fs.writeFile(filePath, bytes);
        child.stdout.end(`MOSAIC_FILE:${JSON.stringify(filePath)}\n`); child.stderr.end();
        setImmediate(() => child.emit('close', 0));
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
  return { calls, metadata, filePath,
    run: options => downloadSiteVideo({ url: base[2], site: base[0], directory, runtimeDir,
      ffmpegPath: path.join(runtimeDir, 'ffmpeg.exe'), spawnProcess, ...options }) };
}

test('site fallback scopes the extractor and returns canonical provenance and playback constraints', async t => {
  for (const [site, videoId, , url, extractor] of cases) await t.test(site, async t => {
    const f = await fixture(t, { site });
    const result = await f.run();
    assert.equal(result.site, site); assert.equal(result.videoId, videoId); assert.equal(result.pageUrl, url);
    assert.equal(result.duration, 12.5); assert.equal(result.hasAudio, true);
    assert.equal(result.filePath, f.filePath);
    const { args, options } = f.calls[0];
    assert.equal(args[args.indexOf('--use-extractors') + 1], extractor.toLowerCase());
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.ok(args.includes('--no-plugin-dirs')); assert.ok(args.includes('--no-remote-components'));
    assert.deepEqual(args.slice(-2), ['--', url]);
  });
});

test('site fallback rejects cross-site or conflicting post identity even when a format exists', async t => {
  for (const metadata of [
    { webpage_url: 'https://vimeo.com/123456789' },
    { webpage_url: 'https://x.com/i/status/123456789' },
    { original_url: 'https://x.com/i/status/123456789' },
    { display_id: '123456789' },
    { extractor_key: 'Generic' }
  ]) await t.test(JSON.stringify(metadata), async t => {
    const f = await fixture(t, { metadata });
    await assert.rejects(f.run(), error => error.code === 'X_SOURCE_MISMATCH');
  });
  const f = await fixture(t, { site: 'pinterest', metadata: { id: '999999' } });
  await assert.rejects(f.run(), error => error.code === 'PINTEREST_SOURCE_MISMATCH');
});

test('multi-video posts require an explicit selected media identity, never an arbitrary first entry', async t => {
  const ambiguous = await fixture(t, { metadata: { playlist_id: cases[2][1], playlist_count: 2 } });
  await assert.rejects(ambiguous.run(), /多个视频/);
  const unknown = await fixture(t, { metadata: { playlist_id: cases[2][1] } });
  await assert.rejects(unknown.run(), /多个视频/);
  const selected = await fixture(t, { metadata: { playlist_id: cases[2][1], playlist_count: 2 } });
  const result = await selected.run({ selectedMediaId: selected.metadata.id });
  assert.equal(result.videoId, cases[2][1]);
  const args = selected.calls[0].args;
  assert.ok(args[args.indexOf('--match-filters') + 1].includes(`id = '${selected.metadata.id}'`));
  const different = await fixture(t, { metadata: { playlist_id: cases[2][1], playlist_count: 2 } });
  await assert.rejects(different.run({ selectedMediaId: '1111111111111' }), /所选画面|多个视频/);
});

test('site mismatch and unsafe selected identifiers fail before starting any executable', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ site: 'instagram' }), error => error.code === 'INVALID_VIDEO_PAGE');
  await assert.rejects(f.run({ selectedMediaId: "123' & id != '123" }), /编号无效/);
  assert.equal(f.calls.length, 0);
});

test('Bilibili preserves the selected part and rejects a different or ambiguous part before success', async t => {
  for (const metadata of [
    { id: 'BV1bK411W797_p1' },
    { id: 'BV1bK411W797' },
    { id: 'BV13x41117TL_p2' },
    { webpage_url: 'https://www.bilibili.com/video/BV1bK411W797/?p=1' },
    { original_url: 'https://www.bilibili.com/video/BV13x41117TL/?p=2' },
    { webpage_url: null, original_url: null },
    { _type: 'playlist' },
    { _type: 'multi_video' },
    { playlist_count: 2 },
    { playlist_id: 'BV1bK411W797' },
    { extractor_key: 'BiliBiliBangumi' }
  ]) await t.test(JSON.stringify(metadata), async t => {
    const f = await fixture(t, { site: 'bilibili', metadata });
    await assert.rejects(f.run(), error => error.code === 'BILIBILI_SOURCE_MISMATCH');
  });
  const f = await fixture(t, { site: 'bilibili' });
  const result = await f.run();
  assert.equal(result.videoId, 'BV1bK411W797:p2');
  assert.ok(f.calls[0].args.includes('--no-playlist'));
  assert.deepEqual(f.calls[0].args.slice(-2), ['--', 'https://www.bilibili.com/video/BV1bK411W797/?p=2']);
});

test('Bilibili av aliases require extractor proof for the exact requested part', async t => {
  const url = 'https://www.bilibili.com/video/av1074402/?p=1';
  const metadata = { id: 'BV11x411K7CN_p1', webpage_url: 'https://www.bilibili.com/video/BV11x411K7CN/?p=1',
    original_url: url, _old_archive_ids: ['bilibili 1074402_part1'] };
  const accepted = await fixture(t, { site: 'bilibili', metadata });
  assert.equal((await accepted.run({ url })).videoId, 'av1074402:p1');
  for (const changes of [{ _old_archive_ids: undefined }, { _old_archive_ids: ['bilibili 1074402_part2'] },
    { _old_archive_ids: ['bilibili 999999_part1'] }, { id: 'BV11x411K7CN_p2' }]) {
    const f = await fixture(t, { site: 'bilibili', metadata: { ...metadata, ...changes } });
    await assert.rejects(f.run({ url }), error => error.code === 'BILIBILI_SOURCE_MISMATCH');
  }
});
