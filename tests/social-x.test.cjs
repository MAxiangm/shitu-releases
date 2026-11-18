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

function fixture({ scripts = [], observed = [], fetchImpl, timers } = {}) {
  let onMutations;
  const requests = [];
  const document = {
    querySelectorAll: () => scripts,
    defaultView: { performance: { getEntriesByType: () => observed.map(name => ({ name })) }, location: { href: page.href } },
    createElement(tag) {
      assert.equal(tag, 'template');
      let html = '';
      return { set innerHTML(value) { html = value; }, content: { querySelectorAll(selector) {
        assert.equal(selector, 'script:not([src])');
        return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
          .filter(match => !/\bsrc\s*=/.test(match[1]))
          .map(match => ({ tagName: 'SCRIPT', textContent: match[2] }));
      } } };
    }
  };
  class MutationObserver {
    constructor(callback) { onMutations = callback; }
    observe() {}
  }
  const context = vm.createContext({ URL, document, location: page, MutationObserver, AbortController, TextDecoder,
    setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout,
    fetch: async (...args) => { requests.push(args); return fetchImpl(...args); } });
  vm.runInContext(source, context);
  const resolver = context.MosaicXVideo;
  return {
    find: (video, selectedPage = page) => resolver({ document, page: selectedPage, video, path: [] }),
    findAsync: (video, selectedPage = page, selectedPath = []) => resolver.resolveAsync({ document, page: selectedPage, video, path: selectedPath }),
    matchesSelection: (found, snapshot) => resolver.matchesSelection(found, snapshot),
    document, requests,
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

test('X resolves each video in the observed unified-card JSON-string carousel shape', async () => {
  const first = '1578391494028890119', second = '1578400766095654915';
  const unified = { card: { legacy: { binding_values: [{ key: 'unified_card', value: { type: 'STRING',
    string_value: JSON.stringify({ type: 'video_multi_dest_carousel_website', media_entities: {
      [`13_${first}`]: record(first, [variant(first, '320x320', 432000), variant(first, '720x720', 1280000)]),
      [`13_${second}`]: record(second, [variant(second, '540x540', 832000), variant(second, '720x720', 1280000)])
    } })
  } }] } } };
  const media = fixture({ scripts: [streamScript([unified])] });
  assert.equal(media.find({ poster: thumb(first) }).url, mp4(first, '720x720'));
  assert.equal(media.find({ poster: thumb(second) }).url, mp4(second, '720x720'));
  const fallback = fixture({ fetchImpl: () => htmlResponse([unified]) });
  const target = { poster: thumb(second), currentSrc: 'blob:https://x.com/carousel' };
  assert.equal((await fallback.findAsync(target)).url, mp4(second, '720x720'));
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

test('X uses the active file identity when a recycled player still has another video poster', async () => {
  const media = fixture({ scripts: [streamScript([
    record('34', [variant('34', '720x1280', 9000)]),
    record('35', [variant('35', '320x568', 600), variant('35', '720x1280', 2000)])
  ])], fetchImpl: () => { throw new Error('Active direct source must not refetch'); } });
  const target = { poster: thumb('34'), currentSrc: mp4('35', '320x568') };
  assert.equal(media.find(target).url, mp4('35', '720x1280'));
  assert.equal((await media.findAsync(target)).url, mp4('35', '720x1280'));
  assert.equal(media.requests.length, 0);
});

test('a stale download-disabled poster cannot reject an unrelated active X file', () => {
  const media = fixture({ scripts: [streamScript([record('34', [], { allow_download: false })])] });
  assert.equal(media.find({ poster: thumb('34'), currentSrc: mp4('35', '720x1280') }).url, mp4('35', '720x1280'));
});

function htmlResponse(records, { url = page.href, status = 200, type = 'text/html', redirected = false, html } = {}) {
  const response = new Response(html ?? `<html><script>${streamScript(records).textContent}</script></html>`, {
    status, headers: { 'Content-Type': type }
  });
  Object.defineProperties(response, { url: { value: url }, redirected: { value: redirected } });
  return response;
}

test('X SPA source lookup recovers the selected post HTML with its exact displayed video identity', async () => {
  const target = { poster: thumb('34'), currentSrc: 'blob:https://x.com/test', isConnected: true };
  const media = fixture({ fetchImpl: async () => htmlResponse([
    record('35', [variant('35', '1920x1080', 9000)]),
    record('34', [variant('34', '320x568', 600), variant('34', '720x1280', 2000)])
  ]) });
  const result = await media.findAsync(target);
  assert.equal(result.url, mp4('34', '720x1280'));
  assert.equal(result.pageUrl, page.href);
  assert.equal(media.requests.length, 1);
  assert.equal(media.requests[0][0], page.href);
  assert.equal(media.requests[0][1].credentials, 'same-origin');
  assert.equal(media.requests[0][1].mode, 'same-origin');
  assert.equal(media.requests[0][1].redirect, 'error');
});

test('X does not refetch an already resolved source or an explicitly blocked video', async () => {
  const media = fixture({ scripts: [streamScript([
    record('34', [variant('34', '720x1280', 2000)]),
    record('35', [variant('35', '720x1280', 2000)], { allow_download: false })
  ])], fetchImpl: () => { throw new Error('Must not request'); } });
  assert.equal((await media.findAsync({ poster: thumb('34') })).url, mp4('34', '720x1280'));
  assert.match((await media.findAsync({ poster: thumb('35') })).error, /下载已关闭/);
  assert.match((await media.findAsync({ poster: thumb('99'), mediaKeys: {} })).error, /网站提供/);
  assert.equal(media.requests.length, 0);
});

test('X timeline recovery requires one unambiguous selected post', async () => {
  const timeline = new URL('https://x.com/home');
  const target = { poster: thumb('34'), currentSrc: 'blob:https://x.com/test' };
  const media = fixture({ fetchImpl: async () => htmlResponse([record('34', [variant('34', '720x1280', 2000)])]) });
  media.document.defaultView.location.href = timeline.href;
  assert.equal((await media.findAsync(target, timeline)).url, undefined);
  assert.equal(media.requests.length, 0);
  target.closest = selector => selector === 'article' ? { querySelectorAll: () => [{ tagName: 'A', href: page.href }] } : null;
  assert.equal((await media.findAsync(target, timeline)).url, mp4('34', '720x1280'));
  assert.equal(media.requests[0][0], page.href);
});

test('X replies use their local article post rather than the surrounding detail page', async () => {
  const replyUrl = 'https://x.com/replyauthor/status/2000';
  const target = { poster: thumb('34'), currentSrc: 'blob:https://x.com/test',
    closest: selector => selector === 'article' ? { querySelectorAll: () => [{ tagName: 'A', href: replyUrl }] } : null };
  const media = fixture({ fetchImpl: async () => htmlResponse([record('34', [variant('34', '720x1280', 2000)])], { url: replyUrl }) });
  const result = await media.findAsync(target);
  assert.equal(result.url, mp4('34', '720x1280'));
  assert.equal(result.pageUrl, replyUrl);
  assert.equal(media.requests[0][0], replyUrl);
});

test('X refuses to guess between multiple local article posts even on a detail page', async () => {
  const target = { poster: thumb('34'), currentSrc: 'blob:https://x.com/test',
    closest: selector => selector === 'article' ? { querySelectorAll: () => [
      { tagName: 'A', href: 'https://x.com/replyauthor/status/2000' },
      { tagName: 'A', href: 'https://x.com/quotedauthor/status/3000' }
    ] } : null };
  const media = fixture({ fetchImpl: () => { throw new Error('Ambiguous article must not refetch'); } });
  assert.equal((await media.findAsync(target)).url, undefined);
  assert.equal(media.requests.length, 0);
});

test('X ignores other media and rejects redirects, partial responses, and non-HTML responses', async t => {
  for (const [name, response] of [
    ['other media', () => htmlResponse([record('35', [variant('35', '720x1280', 2000)])])],
    ['other post', () => htmlResponse([record('34', [variant('34', '720x1280', 2000)])], { url: 'https://x.com/other/status/999' })],
    ['redirect', () => htmlResponse([], { redirected: true })],
    ['partial', () => htmlResponse([], { status: 206 })],
    ['JSON', () => htmlResponse([], { type: 'application/json' })],
    ['login page', () => htmlResponse([], { html: '<h1>Log in to X</h1>' })]
  ]) await t.test(name, async () => {
    const media = fixture({ fetchImpl: response });
    const result = await media.findAsync({ poster: thumb('34'), currentSrc: 'blob:https://x.com/test' });
    assert.equal(result.url, undefined);
    assert.ok(result.error);
  });
});

test('X preserves the captured video identity when a player is removed or recycled', async t => {
  for (const [name, change] of [
    ['direct source', video => { video.currentSrc = mp4('35'); }],
    ['cross-origin blob', video => { video.currentSrc = 'blob:https://other.example/replaced'; }],
    ['poster', video => { video.poster = thumb('35'); }],
    ['connection', video => { video.isConnected = false; }],
    ['replacement player protection', video => { video.mediaKeys = {}; }]
  ]) await t.test(name, async () => {
    const target = { poster: thumb('34'), currentSrc: 'blob:https://x.com/test', isConnected: true };
    const media = fixture({ fetchImpl: async () => {
      change(target, media.document);
      return htmlResponse([
        record('34', [variant('34', '720x1280', 2000)]),
        record('35', [variant('35', '1920x1080', 9000)])
      ]);
    } });
    const result = await media.findAsync(target);
    assert.equal(result.url, mp4('34', '720x1280'));
    assert.equal(media.matchesSelection(result, { url: 'blob:https://x.com/test', poster: thumb('34') }), true);
  });
});

test('X still rejects a captured result after navigating to another page', async () => {
  const media = fixture({ fetchImpl: async () => {
    media.document.defaultView.location.href = 'https://x.com/other/status/999';
    return htmlResponse([record('34', [variant('34', '720x1280', 2000)])]);
  } });
  const result = await media.findAsync({ poster: thumb('34'), currentSrc: 'blob:https://x.com/test' });
  assert.equal(result.url, undefined);
  assert.match(result.error, /页面已切换/);
});

test('X snapshot matching requires the original official media identity and never trusts a later poster', () => {
  const media = fixture();
  const result = { url: mp4('34') };
  assert.equal(media.matchesSelection(result, { url: 'blob:https://x.com/test', poster: thumb('34') }), true);
  assert.equal(media.matchesSelection(result, { url: mp4('34'), poster: thumb('35') }), true);
  assert.equal(media.matchesSelection(result, { url: mp4('35'), poster: thumb('34') }), false);
  assert.equal(media.matchesSelection({ url: mp4('35') }, { url: 'blob:https://x.com/test', poster: thumb('34') }), false);
  assert.equal(media.matchesSelection(result, { url: 'blob:https://x.com/test' }), false);
  assert.equal(media.matchesSelection({ url: mp4('34').replace('video.twimg.com', 'evil.example') }, { poster: thumb('34') }), false);
});

test('X first playback can attach or replace a temporary source while the same official poster stays selected', async t => {
  for (const [name, current, next] of [
    ['empty source starts playback', '', 'blob:https://x.com/started'],
    ['missing source starts playback', undefined, 'blob:https://x.com/started'],
    ['MediaSource is replaced', 'blob:https://x.com/initial', 'blob:https://x.com/replaced']
  ]) await t.test(name, async () => {
    const target = { poster: thumb('34'), currentSrc: current, isConnected: true };
    const media = fixture({ fetchImpl: async () => {
      target.currentSrc = next;
      target.poster = `${thumb('34')}&name=large`;
      return htmlResponse([record('34', [variant('34', '720x1280', 2000)])]);
    } });
    const result = await media.findAsync(target);
    assert.equal(result.url, mp4('34', '720x1280'));
  });
});

test('X aborts a stalled recovery request after eight seconds', async () => {
  let deadline;
  const media = fixture({ timers: { setTimeout: (fn, ms) => { assert.equal(ms, 8000); deadline = fn; return 1; }, clearTimeout() {} },
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))) });
  const pending = media.findAsync({ poster: thumb('34'), currentSrc: 'blob:https://x.com/test' });
  deadline();
  assert.match((await pending).error, /超时/);
  assert.equal(media.requests[0][1].signal.aborted, true);
});

test('X limits both declared and streamed HTML size and cancels oversized responses', async t => {
  for (const declared of [true, false]) await t.test(declared ? 'content length' : 'chunked body', async () => {
    let cancelled = false;
    const large = new Uint8Array(8 * 1024 * 1024 + 1);
    const media = fixture({ fetchImpl: async () => ({
      status: 200, url: page.href, redirected: false,
      headers: new Headers({ 'Content-Type': 'text/html', ...(declared ? { 'Content-Length': String(large.length) } : {}) }),
      body: {
        cancel: async () => { cancelled = true; },
        getReader: () => ({ read: async () => ({ done: false, value: large }), cancel: async () => { cancelled = true; } })
      }
    }) });
    const result = await media.findAsync({ poster: thumb('34'), currentSrc: 'blob:https://x.com/test' });
    assert.equal(result.url, undefined);
    assert.ok(result.error);
    assert.equal(cancelled, true);
  });
});
