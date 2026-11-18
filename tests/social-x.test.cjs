'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'social-x.js'), 'utf8');
const page = new URL('https://x.com/example/status/1000');
const thumb = id => `https://pbs.twimg.com/amplify_video_thumb/${id}/img/poster?format=webp&name=medium`;
const mp4 = (id, quality) => `https://video.twimg.com/amplify_video/${id}/vid/avc1/${quality}/file.mp4?tag=21`;
const variant = (id, resolution, bitrate) => ({ content_type: 'video/mp4', bitrate, url: mp4(id, resolution) });
const record = (id, variants, extra = {}) => ({
  type: 'video', media_url_https: thumb(id), expanded_url: `${page.href}/video/1`, video_info: { variants }, ...extra
});
const streamScript = records => ({
  tagName: 'SCRIPT',
  textContent: `($R=>$R[2].next({value:${JSON.stringify(JSON.stringify({ data: { records } }))}}))($R["tsr"]);document.currentScript.remove()`
});

function fixture({ scripts = [], observed = [] } = {}) {
  let onMutations;
  const document = {
    querySelectorAll: () => scripts,
    defaultView: { performance: { getEntriesByType: () => observed.map(name => ({ name })) } }
  };
  class MutationObserver {
    constructor(callback) { onMutations = callback; }
    observe() {}
  }
  const context = vm.createContext({ URL, document, location: page, MutationObserver });
  vm.runInContext(source, context);
  const resolver = context.MosaicXVideo;
  return {
    find: (video, selectedPage = page) => resolver({ document, page: selectedPage, video, path: [] }),
    observe: script => onMutations([{ target: document, addedNodes: [script] }])
  };
}

test('X resolves exact displayed media from a self-removed public stream script', () => {
  const fixtureResult = fixture();
  fixtureResult.observe(streamScript([
    record('34', [variant('34', '320x568', 600), variant('34', '720x1280', 2000),
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/amplify_video/34/pl/manifest.m3u8' }]),
    record('35', [variant('35', '1920x1080', 9000)])
  ]));
  const result = fixtureResult.find({ poster: thumb('34') });
  assert.equal(result.url, mp4('34', '720x1280'));
  assert.equal(result.pageUrl, page.href);
});

test('explicit X download-disabled flags override direct and observed MP4 URLs', () => {
  const media = fixture({ scripts: [{ type: 'application/json', textContent: JSON.stringify([
    record('34', [variant('34', '320x568', 600)], { allow_download_status: { allow_download: false } })
  ]) }], observed: [mp4('34', '720x1280')] });
  const result = media.find({ poster: thumb('34'), currentSrc: mp4('34', '320x568') });
  assert.match(result.error, /下载已关闭/);
  assert.equal(result.url, undefined);
});

test('X remembers explicit download denial even if its metadata omits all variants', () => {
  const media = fixture({ observed: [mp4('34', '720x1280')] });
  media.observe(streamScript([{
    type: 'video', media_url_https: thumb('34'), allow_download_status: { allow_download: false }
  }]));
  assert.match(media.find({ poster: thumb('34') }).error, /下载已关闭/);
});

test('X timeline fallback trusts only an exact observed media key and complete official MP4', () => {
  const url = mp4('34', '320x568');
  const media = fixture({ observed: [
    url, mp4('35', '1920x1080'), url.replace('video.twimg.com', 'video.twimg.com.example.com'),
    'https://video.twimg.com/amplify_video/34/pl/manifest.m3u8'
  ] });
  assert.equal(media.find({ poster: thumb('34'), currentSrc: 'blob:https://x.com/video' }).url, url);
  assert.equal(media.find({ poster: thumb('99') }).url, undefined);
  assert.equal(media.find({ poster: thumb('34') }, new URL('https://x.com.example.com/')), null);
});
