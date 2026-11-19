'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const env = { URL, AbortController, TextDecoder, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/social-instagram.js'), 'utf8'), env);
const resolve = env.MosaicInstagramVideo;
const home = new URL('https://www.instagram.com/reel/OnTarget/');
const source = 'https://scontent-lax3-1.cdninstagram.com/clip.mp4?variant=untouched';
const unrelated = 'https://scontent-lax3-1.cdninstagram.com/other.mp4';
const trustedMedia = value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : null;
};
const metadata = (raw, options = {}) => ({
  querySelector(selector) {
    if (selector.includes('canonical') && options.canonical) return { getAttribute: () => options.canonical };
    if (selector.includes('og:url') && options.ogPage) return { getAttribute: () => options.ogPage };
    return null;
  },
  querySelectorAll(selector) {
    if (selector.startsWith('script')) return [{ textContent: typeof raw === 'string' ? raw : JSON.stringify(raw) }];
    return (options.og || []).map(value => ({ getAttribute: () => value }));
  }
});
const post = (code, fields) => ({ code, user: { is_private: false }, video_versions: [{ type: 101, url: source }], ...fields });
const link = href => ({ tagName: 'A', getAttribute: attribute => attribute === 'href' ? href : null });
const input = (document, overrides = {}) => ({ document, page: home, video: {}, path: [], trustedMedia, singleVideo: true, ...overrides });

test('public Reel uses only the exact post and preserves the original CDN URL', () => {
  const state = { require: [{ __bbox: { result: { data: { xig_polaris_media: {
    code: 'OnTarget', if_not_gated_logged_out: post('OnTarget'), gating_ruling: null
  } } } } }, post('Elsewhere', { video_versions: [{ url: unrelated, width: 3840, height: 2160 }] })] };
  const result = resolve(input(metadata(state)));
  assert.equal(result.url, source);
  assert.equal(result.pageUrl, home.href);
  assert.equal(result.name, 'Instagram OnTarget');
});

test('a feed player needs one matching post link and cannot reuse a different card source', () => {
  const page = new URL('https://www.instagram.com/');
  const document = metadata([post('OnTarget'), post('Elsewhere', { video_url: unrelated, video_versions: [] })]);
  assert.equal(resolve(input(document, { page, singleVideo: false, path: [link('/reel/OnTarget/?utm_source=feed')] })).pageUrl, home.href);
  assert.equal(resolve(input(document, { page, singleVideo: false })), null);
  assert.equal(resolve(input(document, { page, path: [link('/reel/OnTarget/'), link('/reel/Elsewhere/')] })), null);
  assert.equal(resolve(input(metadata(post('Elsewhere')))), null);
});

test('private, gated, live, protected and unscoped carousel records do not expose media', () => {
  for (const fields of [{ user: { is_private: true } }, { is_live: true }, { gating_ruling: 'LOGIN_REQUIRED' },
    { if_not_gated_logged_out: null }, { is_drm_protected: true }]) {
    assert.match(resolve(input(metadata(post('OnTarget', fields), { og: [source] }))).error, /下载受限/);
  }
  assert.equal(resolve(input(metadata(post('OnTarget', { media_type: 8 }), { og: [source] }))), null);
});

test('Instagram save-button flags do not reject a matching readable video', () => {
  for (const key of ['can_download', 'is_downloadable', 'downloadable', 'download_allowed',
    'allows_download', 'allow_download', 'allow_downloads', 'download_enabled', 'is_download_enabled', 'viewer_can_download']) {
    const fields = { [key]: false, clips_metadata: { [key]: false } };
    assert.equal(resolve(input(metadata(post('OnTarget', fields)))).url, source, key);
    // A presentation flag cannot allow reuse of a different post's media.
    assert.equal(resolve(input(metadata(post('Elsewhere', fields)))), null, key);
  }
});

test('Instagram page fallback identifies the selected single video and retains actual restrictions', () => {
  const selected = input(metadata(post('OnTarget', { video_versions: [], allows_download: false })),
    { video: { currentSrc: 'blob:https://www.instagram.com/selected' } });
  assert.equal(resolve(selected), null);
  assert.equal(resolve.selectedPage(selected).url, home.href);
  assert.equal(resolve.selectedPage(selected).videoId, 'OnTarget');
  const embedded = input(metadata({}), { page: new URL('https://www.instagram.com/reel/OnTarget/embed/?utm_source=test') });
  assert.equal(resolve.selectedPage(embedded).url, home.href);
  for (const fields of [{ is_drm_protected: true }, { is_live: true },
    { user: { is_private: true } }, { gating_ruling: 'LOGIN_REQUIRED' }]) {
    assert.equal(resolve.selectedPage(input(metadata(post('OnTarget', fields)))).blocked, true);
  }
  assert.equal(resolve.selectedPage(input(metadata(post('OnTarget', { media_type: 8 })))), null);
  assert.equal(resolve.selectedPage({ ...selected, video: { mediaKeys: {} } }).blocked, true);
  assert.equal(resolve.selectedPage({ ...selected, video: null }), null);
  assert.equal(resolve.selectedPage({ ...selected, video: { isConnected: false } }), null);
  assert.equal(resolve.selectedPage({ ...selected, page: new URL('https://www.instagram.com/'), singleVideo: false }), null);
  assert.equal(resolve.selectedPage({ ...selected, document: { ...selected.document, defaultView: { location: { href: 'https://www.instagram.com/reel/OtherPost/' } } } }), null);
});

test('Instagram metadata requires the same canonical page and a genuine video CDN', () => {
  const canonical = 'https://www.instagram.com/reel/Elsewhere/';
  assert.equal(resolve(input(metadata({}, { canonical, og: [source] }))), null);
  assert.equal(resolve(input(metadata({}, { og: [source, unrelated] }))), null);
  for (const url of ['https://evilcdninstagram.com/clip.mp4', 'https://cdninstagram.com.example/clip.mp4',
    'https://user@cdninstagram.com/clip.mp4', 'https://cdninstagram.com/clip.m3u8', 'http://cdninstagram.com/clip.mp4']) {
    assert.equal(resolve(input(metadata(post('OnTarget', { video_versions: [{ url }] })))), null);
  }
  assert.equal(resolve(input(metadata({}, { canonical: home.href, og: [source, source] }))).url, source);
});

test('Instagram never reuses unbound or conflicting OG video tags after SPA navigation', () => {
  const oldPost = 'https://www.instagram.com/reel/Elsewhere/';
  assert.equal(resolve(input(metadata({}, { og: [unrelated] }))), null);
  assert.equal(resolve(input(metadata({}, { ogPage: oldPost, og: [unrelated] }))), null);
  assert.equal(resolve(input(metadata({}, { canonical: home.href, ogPage: oldPost, og: [unrelated] }))), null);
  assert.equal(resolve(input(metadata({}, { canonical: oldPost, ogPage: home.href, og: [unrelated] }))), null);
  assert.equal(resolve(input(metadata({}, { ogPage: 'https://evil.example/reel/OnTarget/', og: [unrelated] }))), null);
  assert.equal(resolve(input(metadata({}, { ogPage: home.href, og: [source] }))).url, source);
  assert.equal(resolve(input(metadata({}, { canonical: home.href, ogPage: home.href, og: [source] }))).url, source);
});

test('Instagram accepts declared extensionless Meta video URLs and the selected direct player source', () => {
  const extensionless = 'https://scontent-lax3-1.cdninstagram.com/o1/v/t16/f2/m86/AQMfixture?efg=opaque';
  assert.equal(resolve(input(metadata(post('OnTarget', { video_versions: [{ url: extensionless }] })))).url, extensionless);
  assert.equal(resolve(input(metadata({}), { video: { currentSrc: extensionless } })).url, extensionless);
  assert.equal(resolve(input(metadata({}), { video: { currentSrc: 'https://scontent-lax3-1.cdninstagram.com/v/t51/photo.jpg' } })), null);
  assert.equal(resolve(input(metadata({}), { video: { currentSrc: 'https://scontent-lax3-1.cdninstagram.com.evil.test/o1/v/video' } })), null);
  assert.match(resolve(input(metadata(post('OnTarget', { is_drm_protected: true })), { video: { currentSrc: source } })).error, /下载受限/);
});

function asynchronousPage({ raw = {}, fetched = post('OnTarget'), video = {}, response = {}, fetchImpl } = {}) {
  const page = new URL(home), requests = [];
  const selected = { currentSrc: 'blob:https://www.instagram.com/selected', poster: 'https://cdn.example/selected.jpg', isConnected: true, ...video };
  const document = metadata(raw);
  document.defaultView = { location: { href: page.href } };
  document.createElement = tag => {
    assert.equal(tag, 'template');
    return { content: metadata(fetched) };
  };
  env.fetch = async (url, options) => {
    requests.push({ url, options });
    if (fetchImpl) return fetchImpl(url, options, selected, document);
    const result = new Response('<!doctype html><html>fixture</html>', { headers: { 'content-type': 'text/html' }, ...response });
    Object.defineProperty(result, 'url', { value: page.href });
    return result;
  };
  return { context: input(document, { page, video: selected }), requests, video: selected, document };
}

test('Instagram SPA source lookup reads the same post only after current document sources are exhausted', async () => {
  const instance = asynchronousPage();
  const result = await resolve.resolveAsync(instance.context);
  assert.equal(result.url, source);
  assert.equal(result.pageUrl, home.href);
  assert.equal(instance.requests.length, 1);
  assert.equal(instance.requests[0].url, home.href);
  assert.equal(instance.requests[0].options.credentials, 'same-origin');
  assert.equal(instance.requests[0].options.mode, 'same-origin');
  assert.equal(instance.requests[0].options.redirect, 'error');
  const existing = asynchronousPage({ raw: post('OnTarget') });
  assert.equal((await resolve.resolveAsync(existing.context)).url, source);
  assert.equal(existing.requests.length, 0);
  const direct = asynchronousPage({ video: { currentSrc: source } });
  assert.equal((await resolve.resolveAsync(direct.context)).url, source);
  assert.equal(direct.requests.length, 0);
});

test('Instagram async lookup cannot erase current restrictions or retrieve an unrelated post', async () => {
  const blocked = asynchronousPage({ raw: post('OnTarget', { user: { is_private: true } }) });
  assert.match((await resolve.resolveAsync(blocked.context)).error, /下载受限/);
  assert.equal(blocked.requests.length, 0);
  const other = asynchronousPage({ fetched: post('Elsewhere') });
  assert.match((await resolve.resolveAsync(other.context)).error, /完整文件/);
  const protectedResponse = asynchronousPage({ fetched: post('OnTarget', { is_drm_protected: true }) });
  assert.match((await resolve.resolveAsync(protectedResponse.context)).error, /下载受限/);
});

test('Instagram async lookup refuses a login page, invalid response, and source returned after navigation', async t => {
  for (const [name, fields] of [
    ['login HTML', { fetched: {} }],
    ['partial response', { response: { status: 206 } }],
    ['non HTML response', { response: { headers: { 'content-type': 'application/json' } } }],
    ['oversized response', { response: { headers: { 'content-type': 'text/html', 'content-length': String(8 * 1024 * 1024 + 1) } } }],
    ['network failure', { fetchImpl: async () => { throw new TypeError('Network failure'); } }],
    ['redirect', { fetchImpl: async () => ({ status: 200, redirected: true, url: home.href, body: { cancel: async () => {} } }) }]
  ]) {
    await t.test(name, async () => {
      const instance = asynchronousPage(fields);
      assert.equal(typeof (await resolve.resolveAsync(instance.context)).error, 'string');
    });
  }
  for (const change of [
    (video) => { video.isConnected = false; },
    (video) => { video.currentSrc = 'blob:https://www.instagram.com/other'; },
    (video) => { video.poster = 'https://cdn.example/other.jpg'; },
    (_video, document) => { document.defaultView.location.href = 'https://www.instagram.com/reel/OtherPost/'; }
  ]) {
    const instance = asynchronousPage({ fetchImpl: async (_url, _options, video, document) => {
      change(video, document);
      const response = new Response('<html>fixture</html>', { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: home.href });
      return response;
    } });
    assert.match((await resolve.resolveAsync(instance.context)).error, /已切换/);
  }
});

test('Instagram async source lookup aborts a stalled request after eight seconds', async () => {
  const originalTimer = env.setTimeout;
  let timeout, request;
  env.setTimeout = (callback, milliseconds) => { assert.equal(milliseconds, 8000); timeout = callback; return 42; };
  env.clearTimeout = () => {};
  try {
    const instance = asynchronousPage({ fetchImpl: async (_url, options) => { request = options; return new Promise(() => {}); } });
    const result = resolve.resolveAsync(instance.context);
    timeout();
    assert.equal(request.signal.aborted, true);
    assert.match((await result).error, /超时/);
  } finally { env.setTimeout = originalTimer; env.clearTimeout = clearTimeout; }
});
