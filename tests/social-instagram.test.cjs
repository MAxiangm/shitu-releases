'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const env = { URL };
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
    return selector.includes('canonical') && options.canonical ? { getAttribute: () => options.canonical } : null;
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

test('private, gated, download-disabled and unscoped carousel records do not expose media', () => {
  for (const fields of [{ user: { is_private: true } }, { allows_download: false },
    { clips_metadata: { download_enabled: false } }, { gating_ruling: 'LOGIN_REQUIRED' },
    { if_not_gated_logged_out: null }, { is_drm_protected: true }]) {
    assert.match(resolve(input(metadata(post('OnTarget', fields), { og: [source] }))).error, /下载受限/);
  }
  assert.equal(resolve(input(metadata(post('OnTarget', { media_type: 8 }), { og: [source] }))), null);
});

test('Instagram metadata requires the same canonical page and a genuine video CDN', () => {
  const canonical = 'https://www.instagram.com/reel/Elsewhere/';
  assert.equal(resolve(input(metadata({}, { canonical, og: [source] }))), null);
  assert.equal(resolve(input(metadata({}, { og: [source, unrelated] }))), null);
  for (const url of ['https://evilcdninstagram.com/clip.mp4', 'https://cdninstagram.com.example/clip.mp4',
    'https://user@cdninstagram.com/clip.mp4', 'https://cdninstagram.com/clip.m3u8', 'http://cdninstagram.com/clip.mp4']) {
    assert.equal(resolve(input(metadata(post('OnTarget', { video_versions: [{ url }] })))), null);
  }
  assert.equal(resolve(input(metadata({}, { og: [source, source] }))).url, source);
});
