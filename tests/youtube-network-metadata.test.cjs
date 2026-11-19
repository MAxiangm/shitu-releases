'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mediaAddress, fullMediaAddress, cleanPlayer, matchingFormat } = require('../extension/youtube-network-metadata.js');
const { selectSource } = require('../extension/youtube-browser-source.js');

const videoId = 'jNQXAC9IVRw';
const raw = 'https://rr1---sn-test.googlevideo.com/videoplayback?id=opaque_id&itag=137&lmt=123456&clen=1000&n=raw&expire=1999999999&sparams=expire,id,itag,clen,lmt';
function player(extra = {}) {
  return { videoDetails: { videoId, title: 'Example video', lengthSeconds: '19' }, playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', contentLength: '1000',
      lastModified: '123456', approxDurationMs: '19000', width: 1920, height: 1080,
      signatureCipher: new URLSearchParams({ url: raw, s: 'cipher-not-executed' }).toString() }] }, ...extra };
}

test('YouTube observer binds only a matching player format and keeps solved signature parameters', () => {
  const record = cleanPlayer(player());
  assert.equal(record.videoId, videoId); assert.equal(record.duration, 19);
  const observed = raw.replace('n=raw', 'n=solved') + '&sig=already-solved&pot=player-token&range=0-255';
  const stream = matchingFormat(record, observed);
  assert.equal(stream.itag, 137); assert.equal(stream.contentLength, 1000);
  assert.equal(stream.hasVideo, true); assert.equal(stream.hasAudio, false);
  const result = new URL(stream.url);
  assert.equal(result.searchParams.get('n'), 'solved'); assert.equal(result.searchParams.get('pot'), 'player-token');
  assert.equal(result.searchParams.get('sig'), 'already-solved'); assert.equal(result.searchParams.has('range'), false);
});

test('YouTube observer rejects another video, format, version, byte count or audio track', () => {
  const record = cleanPlayer(player());
  for (const changed of [raw.replace('opaque_id', 'advertisement'), raw.replace('itag=137', 'itag=140'),
    raw.replace('lmt=123456', 'lmt=123457'), raw.replace('clen=1000', 'clen=2000'), raw + '&xtags=lang=en']) {
    assert.equal(matchingFormat(record, changed), null, changed);
  }
  const ambiguous = cleanPlayer(player());
  ambiguous.formats.push({ ...ambiguous.formats[0], audioTrack: 'alternate', isDrc: true });
  assert.equal(matchingFormat(ambiguous, raw), null);
});

test('YouTube observer rejects signed range changes, live fragments, proprietary wrappers and foreign hosts', () => {
  for (const value of [raw.replace('sparams=expire', 'sparams=range,expire') + '&range=0-255',
    raw + '&lsparams=range&range=0-255', raw + '&range=invalid', raw + '&sq=2', raw + '&live=1',
    raw + '&ump=1', raw + '&sabr=1', raw + '&ump=0', raw + '&sabr=0', raw + '&live=0', raw + '&sq=0', raw.replace('googlevideo.com', 'googlevideo.com.evil.test'),
    raw.replace('https:', 'http:'), raw.replace('https://', 'https://user:pass@'), raw + '&itag=137']) {
    assert.equal(fullMediaAddress(value), null, value);
  }
  assert.equal(mediaAddress('https://127.0.0.1/videoplayback?id=x&itag=1'), null);
});

test('YouTube observer preserves signed query bytes when removing only an unsigned range', () => {
  const exact = raw + '&sig=lowercase%2fsignature%20value&xtags=a%3db%26c%3dd';
  assert.equal(fullMediaAddress(exact + '&range=1-9').href, exact);
  const record = cleanPlayer(player());
  assert.equal(matchingFormat(record, raw + '&mime=audio%2Fmp4'), null);
  assert.equal(matchingFormat(record, raw + '&mime=video%2Fmp4&mime=audio%2Fmp4'), null);
  const mismatch = player(); mismatch.streamingData.adaptiveFormats[0].contentLength = '999';
  assert.equal(cleanPlayer(mismatch).formats.length, 0);
  mismatch.streamingData.adaptiveFormats[0].contentLength = '1000';
  mismatch.streamingData.adaptiveFormats[0].lastModified = '124';
  assert.equal(cleanPlayer(mismatch).formats.length, 0);
});

test('YouTube observer flags denied, DRM and active-live players and distinguishes combined audio', () => {
  for (const extra of [{ playabilityStatus: { status: 'LOGIN_REQUIRED' } },
    { streamingData: { drmParams: 'protected' } },
    { microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } } }]) {
    const record = cleanPlayer(player(extra)); assert.equal(record.restricted, true); assert.equal(matchingFormat(record, raw), null);
  }
  const sample = player(); sample.streamingData.adaptiveFormats[0].audioQuality = 'AUDIO_QUALITY_MEDIUM';
  assert.equal(cleanPlayer(sample).formats[0].hasAudio, true);
  sample.streamingData.adaptiveFormats[0].contentLength = String(1024 * 1024 * 1024);
  assert.equal(cleanPlayer(sample).formats.length, 0);
});

test('MAIN observer publishes inert metadata under enforced Trusted Types and selection reads it', () => {
  const scripts = [], attributes = new WeakMap();
  const element = (tag, text = '') => ({ tagName: tag.toUpperCase(), src: '',
    get textContent() { return text; },
    set textContent(value) {
      if (this.tagName === 'SCRIPT') throw new TypeError('This document requires TrustedScript assignment.');
      text = value;
    },
    hasAttribute(name) { return attributes.get(this)?.has(name); },
    setAttribute(name) { const values = attributes.get(this) || new Set(); values.add(name); attributes.set(this, values); },
    remove() { const index = scripts.indexOf(this); if (index >= 0) scripts.splice(index, 1); } });
  const record = player(); record.secretUnrelatedField = 'not exported';
  record.streamingData.adaptiveFormats[0].audioQuality = 'AUDIO_QUALITY_MEDIUM';
  scripts.push(element('script', 'var ytInitialPlayerResponse = ' + JSON.stringify(record) + ';'));
  let observe;
  const document = { documentElement: { appendChild(node) { scripts.push(node); } },
    createElement: tag => element(tag), getElementById: id => scripts.find(node => node.id === id),
    querySelectorAll: selector => selector === 'div[data-mosaic-youtube-media]'
      ? scripts.filter(node => node.tagName === 'DIV' && node.hasAttribute('data-mosaic-youtube-media'))
      : scripts.filter(node => node.tagName === 'SCRIPT') };
  const context = { location: new URL(`https://www.youtube.com/watch?v=${videoId}`), document, URL, URLSearchParams, Date,
    trustedTypes: { createPolicy() { assert.fail('must not weaken the page policy'); } },
    performance: { getEntriesByType: () => [{ name: raw.replace('n=raw', 'n=solved') + '&sig=resolved&range=0-99' }] },
    PerformanceObserver: class { constructor(callback) { observe = callback; } observe() {} }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', 'extension', 'youtube-network-metadata.js'), 'utf8'), context);
  let published = scripts.find(node => node.hasAttribute('data-mosaic-youtube-media'));
  let data = JSON.parse(published.textContent);
  assert.equal(published.tagName, 'DIV'); assert.equal(published.hasAttribute('hidden'), true);
  assert.equal(data.videos.length, 1); assert.equal(data.videos[0].videoId, videoId); assert.equal(data.videos[0].streams.length, 1);
  assert.equal(published.textContent.includes('not exported'), false);
  assert.equal(selectSource(document, videoId).videoId, videoId);
  observe({ getEntries: () => [{ name: raw.replace('opaque_id', 'another-video') }] });
  published = scripts.find(node => node.hasAttribute('data-mosaic-youtube-media')); data = JSON.parse(published.textContent);
  assert.equal(data.videos[0].streams.length, 1);
});
