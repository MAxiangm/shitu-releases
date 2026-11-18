'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stageVimeoHls, vimeoPlaybackUrl } = require('../src/vimeo-playback-source.cjs');

const mediaHost = 'https://vod-adaptive.vimeocdn.com';
const masterUrl = `${mediaHost}/master.m3u8`;
const box = name => Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from(name)]);

async function fixture(t, sources) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-vimeo-playback-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const read = async (url, { destination, range, limit }) => {
    calls.push({ url: url.href, range, limit });
    const source = sources[url.href];
    assert.ok(source, `Unexpected request: ${url}`);
    const body = Buffer.from(typeof source === 'object' && !Buffer.isBuffer(source) ? source.body : source);
    const selected = range ? body.subarray(range.start, range.end + 1) : body;
    assert.ok(selected.length <= limit);
    if (destination) await fs.writeFile(destination, selected, { flag: 'wx' });
    else return { body, url: source.redirect || url.href };
  };
  return { directory, calls, stage: url => stageVimeoHls({ url: url || masterUrl, directory, read }) };
}

test('Vimeo sources require an official public HTTPS host and a valid address', () => {
  assert.equal(vimeoPlaybackUrl('../clip.m4s', `${mediaHost}/asset/video.m3u8`).href, `${mediaHost}/clip.m4s`);
  assert.equal(vimeoPlaybackUrl('https://player.vimeo.com/progressive_redirect/playback/123/clip.mp4').hostname, 'player.vimeo.com');
  for (const value of ['https://example.com/video.m3u8', 'https://cdn.vimeocdn.com.example.com/', 'http://cdn.vimeocdn.com/',
    'https://user:pass@cdn.vimeocdn.com/', 'https://cdn.vimeocdn.com:446/', 'https://player.vimeo.com/video/123/config',
    '//localhost/segment', 'file://host/file', 'https://cdn.vimeocdn.com/{$key}', 'https://cdn.vimeocdn.com\\redirect']) {
    assert.throws(() => vimeoPlaybackUrl(value, masterUrl), /地址无效/);
  }
});

test('uses the highest video rendition and its default audio, with local paths and resolved byte ranges', async t => {
  const folder = `${mediaHost}/asset`;
  const { calls, directory, stage } = await fixture(t, {
    [masterUrl]: { redirect: `${folder}/master.m3u8`, body: `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="en",NAME="Commentary",AUTOSELECT=YES,URI="commentary.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="en",NAME="Default audio",DEFAULT=YES,AUTOSELECT=YES,URI="sound.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,AUDIO="en"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3800000,RESOLUTION=1920x1080,CODECS="avc1.640029,mp4a.40.2",AUDIO="en"
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.5"
unused.m3u8` },
    [`${folder}/high.m3u8`]: `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-MAP:URI="video.mp4",BYTERANGE="8@0"
#EXTINF:1.75,
#EXT-X-BYTERANGE:8@8
video.mp4
#EXT-X-DISCONTINUITY
#EXTINF:1.0,
#EXT-X-BYTERANGE:8
video.mp4
#EXT-X-ENDLIST`,
    [`${folder}/sound.m3u8`]: `#EXTM3U
#EXT-X-MAP:URI="audio-init.mp4"
#EXTINF:2.75,
sound.m4s
#EXT-X-ENDLIST`,
    [`${folder}/video.mp4`]: Buffer.concat([box('ftyp'), box('moof'), box('styp')]),
    [`${folder}/audio-init.mp4`]: box('moov'),
    [`${folder}/sound.m4s`]: box('sidx')
  });
  const result = await stage();
  assert.equal(result.input, path.join(directory, 'playback.m3u8'));
  assert.equal(result.audio, path.join(directory, 'audio.m3u8'));
  assert.equal(result.duration, 2.75);
  assert.equal(result.expectsAudio, true);
  assert.deepEqual(calls.map(call => [call.url.replace(`${mediaHost}/`, ''), call.range]), [
    ['master.m3u8', undefined], ['asset/high.m3u8', undefined], ['asset/sound.m3u8', undefined],
    ['asset/video.mp4', { start: 0, end: 7 }], ['asset/video.mp4', { start: 8, end: 15 }],
    ['asset/video.mp4', { start: 16, end: 23 }], ['asset/audio-init.mp4', undefined], ['asset/sound.m4s', undefined]
  ]);
  const localPlaylist = await fs.readFile(result.input, 'utf8');
  assert.match(localPlaylist, /#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-MAP:URI="playback-init-0\.mp4"/);
  assert.match(localPlaylist, /#EXT-X-DISCONTINUITY\n#EXTINF:1\.0,\nplayback-segment-1\.m4s/);
  assert.doesNotMatch(localPlaylist, /https?:|BYTERANGE/);
  assert.deepEqual(await fs.readFile(path.join(directory, 'playback-segment-1.m4s')), box('styp'));
});

test('rejects incomplete, encrypted, or externally hosted streams before fetching media bytes', async t => {
  const { stage, calls } = await fixture(t, {
    [`${mediaHost}/live.m3u8`]: '#EXTM3U\n#EXTINF:1,\nlive.ts',
    [`${mediaHost}/encrypted.m3u8`]: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:1,\nvideo.ts\n#EXT-X-ENDLIST',
    [`${mediaHost}/external.m3u8`]: '#EXTM3U\n#EXTINF:1,\nhttps://localhost/secret\n#EXT-X-ENDLIST',
    [`${mediaHost}/partial.m3u8`]: '#EXTM3U\n#EXT-X-GAP\n#EXTINF:1,\nmissing.ts\n#EXT-X-ENDLIST',
    [`${mediaHost}/redirect.m3u8`]: { body: '#EXTM3U', redirect: 'https://example.com/path.m3u8' }
  });
  await assert.rejects(stage(`${mediaHost}/live.m3u8`), /尚未完整发布/);
  await assert.rejects(stage(`${mediaHost}/encrypted.m3u8`), /加密/);
  await assert.rejects(stage(`${mediaHost}/external.m3u8`), /地址无效/);
  await assert.rejects(stage(`${mediaHost}/partial.m3u8`), /不完整/);
  await assert.rejects(stage(`${mediaHost}/redirect.m3u8`), /地址无效/);
  assert.equal(calls.length, 5);
});

test('an HTML response in place of a segment fails before producing a playable local playlist', async t => {
  const { stage, directory } = await fixture(t, {
    [masterUrl]: '#EXTM3U\n#EXTINF:1,\nvideo.ts\n#EXT-X-ENDLIST',
    [`${mediaHost}/video.ts`]: '<html>Access limited</html>'
  });
  await assert.rejects(stage(), /不是可识别/);
  await assert.rejects(fs.access(path.join(directory, 'playback.m3u8')), { code: 'ENOENT' });
});
