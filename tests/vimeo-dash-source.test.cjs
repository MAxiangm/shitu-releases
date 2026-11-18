'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stageVimeoDash } = require('../src/vimeo-dash-source.cjs');

const manifest = 'https://vod-test.vimeocdn.com/path/stream.mpd';
const box = name => Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from(name)]);
const valid = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2.5S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <BaseURL>video/</BaseURL>
      <SegmentTemplate timescale="1000" initialization="$RepresentationID$-init.mp4" media="$RepresentationID$-$Time$.m4s?tag=1&amp;type=video">
        <SegmentTimeline><S t="0" d="1000" r="1"/><S t="2000" d="500"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v1" bandwidth="100" height="360"/>
      <Representation id="v2" bandwidth="200" height="720"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <SegmentTemplate timescale="1000" duration="1250" startNumber="4" initialization="audio-init.mp4" media="audio-$Number%02d$.m4s"/>
      <Representation id="a1" bandwidth="50"/>
    </AdaptationSet>
  </Period>
</MPD>`;

async function fixture(t, body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-vimeo-dash-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const requested = [];
  const stage = () => stageVimeoDash({ url: manifest, directory, async read(url, { destination }) {
    requested.push(url.pathname + url.search);
    if (url.href === manifest) return { body: Buffer.from(body), url };
    assert.ok(destination);
    await fs.writeFile(destination, box(url.pathname.endsWith('.mp4') ? 'ftyp' : 'moof'), { flag: 'wx' });
  } });
  return { stage, requested };
}

test('stages the highest video and default audio representations as local copy-only tracks', async t => {
  const { stage, requested } = await fixture(t, valid);
  const result = await stage();
  assert.equal(result.duration, 2.5);
  assert.equal(result.expectsAudio, true);
  assert.deepEqual(requested, [
    '/path/stream.mpd', '/path/video/v2-init.mp4',
    '/path/video/v2-0.m4s?tag=1&type=video', '/path/video/v2-1000.m4s?tag=1&type=video', '/path/video/v2-2000.m4s?tag=1&type=video',
    '/path/audio-init.mp4', '/path/audio-04.m4s', '/path/audio-05.m4s'
  ]);
  assert.match(await fs.readFile(result.input, 'utf8'), /#EXTINF:0\.5,\ndash-video-segment-2\.m4s\n#EXT-X-ENDLIST/);
  assert.match(await fs.readFile(result.audio, 'utf8'), /#EXT-X-MEDIA-SEQUENCE:4/);
});

test('rejects external XML references, protected media and incomplete manifests before requesting segments', async t => {
  for (const [body, reason] of [
    [valid.replace('<Period>', '<Period xlink:href="https://example.test/period">'), /清单/],
    [valid.replace('<Period>', '<Period><ContentProtection/>'), /加密/],
    [valid.replace('type="static"', 'type="dynamic"'), /点播/],
    [valid.replace('<BaseURL>video/</BaseURL>', '<BaseURL>https://localhost/video/</BaseURL>'), /地址无效/],
    [valid.replace('<S t="2000" d="500"/>', ''), /清单/],
    [valid.replace('<MPD ', '<!DOCTYPE MPD SYSTEM "file:///secret"><MPD '), /清单/]
  ]) {
    const { stage, requested } = await fixture(t, body);
    await assert.rejects(stage(), reason);
    assert.deepEqual(requested, ['/path/stream.mpd']);
  }
});
