'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ctx = { URL, AbortController, TextDecoder, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/social-vimeo.js'), 'utf8'), ctx);
const resolve = ctx.MosaicVimeoVideo;
const link = (href, { hidden = false, download, dialog = false, label = '' } = {}) => ({
  tagName: 'A',
  getAttribute: key => ({ href, download, 'aria-label': label })[key],
  hasAttribute: key => key === 'download' && download !== undefined,
  closest: selector => selector.includes('dialog') ? dialog && {} : hidden && {},
  getClientRects: () => hidden ? [] : [{}]
});
const official = (id = '1234', quality = '1080p') =>
  `https://player.vimeo.com/progressive_redirect/download/${id}/rendition/${quality}/movie.mp4?signature=fixture`;
const page = (href = 'https://vimeo.com/1234', options = {}) => {
  const address = new URL(href);
  return {
    page: address,
    path: options.path || [],
    video: options.video === false ? null : options.video || {},
    singleVideo: options.singleVideo !== false,
    document: { title: 'Example on Vimeo',
      getElementById: id => id === '__NEXT_DATA__' && options.nextData ? { textContent: JSON.stringify(options.nextData) } : null,
      querySelectorAll: selector => selector === 'video' ? options.players || []
        : selector.includes('data-mosaic-vimeo-config') ? (options.configs || []).map(config => ({ textContent: JSON.stringify(config) }))
        : options.links || [],
      ...(options.embedScripts ? { createElement: () => ({ set innerHTML(value) { this.html = value; },
        content: { querySelectorAll: () => options.embedScripts } }) } : {}),
      defaultView: { location: address, performance: { getEntriesByType: () => options.entries || [] } } },
    absolute: value => value ? new URL(value, address).href : null,
    trustedMedia: value => value && new URL(value).protocol === 'https:' ? value : null
  };
};

test('Vimeo Alt+right-click can select an official quality in the download dialog', () => {
  const clicked = link(official('1234', '720p'), { download: 'Export.mp4' });
  const result = resolve(page(undefined, { video: false, path: [clicked] }));
  assert.equal(result.url, official('1234', '720p'));
  assert.equal(result.name, 'Export.mp4');
});

test('Vimeo video uses one visible official link explicitly tied to the same video', () => {
  const expected = official();
  const result = resolve(page(undefined, {
    links: [link(expected), link(expected), link(official('9859')), link(official('1234', '720p'), { hidden: true })]
  }));
  assert.equal(result.url, expected);
  assert.equal(result.name, 'Example');
  assert.match(resolve(page(undefined, { links: [link(expected), link(official('1234', '720p'))] })).error, /Alt/);
  assert.match(resolve(page(undefined, { links: [link(expected)], singleVideo: false })).error, /Alt/);
});

test('Vimeo ignores unselected playback links and unrelated URLs and guides embedded users to the video page', () => {
  const playback = official().replace('/download/', '/playback/');
  const wrongHostname = official().replace('player.vimeo.com', 'player.vimeo.com.other.test');
  assert.match(resolve(page(undefined, { path: [link(playback), link(wrongHostname)] })).error, /打开「下载」/);
  const iframe = resolve(page('https://player.vimeo.com/video/1234?h=fixture&autoplay=1'));
  assert.equal(iframe.openUrl, 'https://vimeo.com/1234');
  assert.match(iframe.error, /作者开放/);
});

test('Vimeo uses the selected player file or playlist when no explicit download is offered', () => {
  const currentSrc = 'https://vod.vimeocdn.com/fixture/movie.mp4';
  const direct = resolve(page(undefined, { video: { currentSrc } }));
  assert.equal(direct.url, currentSrc);
  assert.equal(direct.playback, 'file');
  assert.equal(direct.name, 'Example');
  assert.equal(resolve(page(undefined, { video: { currentSrc }, links: [link(official())] })).url, official());
  const playlist = 'https://vod.vimeocdn.com/fixture/playlist.m3u8';
  assert.equal(resolve(page(undefined, { video: { currentSrc: playlist } })).playback, 'hls');
  const manifest = 'https://vod.vimeocdn.com/fixture/manifest.mpd';
  assert.equal(resolve(page(undefined, { video: { currentSrc: manifest } })).playback, 'dash');
});

test('Vimeo accepts one observed master only inside the matching single-video public player', () => {
  const currentSrc = 'blob:https://player.vimeo.com/fixture';
  const master = 'https://vod.vimeocdn.com/fixture/master.m3u8';
  const variant = 'https://vod.vimeocdn.com/fixture/variant.m3u8';
  const embed = 'https://player.vimeo.com/video/1234';
  const resource = (name, responseStatus = 200) => ({ name, initiatorType: 'fetch', responseStatus });
  const options = { video: { currentSrc }, entries: [resource(master), resource(master), resource(variant)] };
  assert.equal(resolve(page(embed, options)).url, master);
  assert.equal(resolve(page(embed, options)).playback, 'hls');
  const adaptive = 'https://vod-adaptive-ak.vimeocdn.com/fixture/';
  const observedVimeo = [resource(`${adaptive}playlist.m3u8`), resource(`${adaptive}video/media.m3u8`), resource(`${adaptive}audio/media.m3u8`)];
  assert.equal(resolve(page(embed, { ...options, entries: observedVimeo })).url, `${adaptive}playlist.m3u8`);
  assert.ok(resolve(page(embed, { ...options, entries: [...observedVimeo, resource(`${adaptive}another/playlist.m3u8`)] })).error);
  assert.equal(resolve(page(embed, { ...options, entries: [resource('https://vod.vimeocdn.com/fixture/manifest.mpd')] })).playback, 'dash');
  assert.ok(resolve(page(embed, { ...options, singleVideo: false })).error);
  assert.equal(resolve(page(embed + '?h=fixture', options)).url, master);
  assert.ok(resolve(page(embed, { ...options, entries: [resource(master, 401)] })).error);
  assert.ok(resolve(page(embed, { ...options, entries: [...options.entries, resource(master.replace('/fixture/', '/another/'))] })).error);
});

test('Vimeo playback rejects misleading hosts, another video and protected sources', () => {
  const currentSrc = 'https://player.vimeo.com/progressive_redirect/playback/1234/rendition/720p/clip.mp4';
  assert.equal(resolve(page(undefined, { video: { currentSrc } })).url, currentSrc);
  for (const url of [currentSrc.replace('1234', '5678'), 'https://vimeocdn.com.other.test/clip.mp4', 'http://vod.vimeocdn.com/clip.mp4']) {
    assert.ok(resolve(page(undefined, { video: { currentSrc: url } })).error);
  }
  assert.ok(resolve(page(undefined, { video: { currentSrc, mediaKeys: {} } })).error);
  assert.ok(resolve(page(undefined, { video: { currentSrc, srcObject: {} } })).error);
  assert.equal(resolve(page(undefined, { video: { currentSrc, controlsList: { contains: name => name === 'nodownload' } } })).url, currentSrc);
});

test('Vimeo only accepts a CDN download URL when the link is explicitly offered for download', () => {
  const source = 'https://download-video-ak.vimeocdn.com/fixture.mp4';
  assert.equal(resolve(page(undefined, { video: false, path: [link(source)] })), null);
  const result = resolve(page(undefined, { video: false, path: [link(source, { dialog: true, label: 'Download 1080p' })] }));
  assert.equal(result.url, source);
});

const mainData = (id = '1234') => ({ query: { clipId: id }, props: { pageProps: { clipId: id,
  clipMetadata: { jsonLd: { embedUrl: `https://player.vimeo.com/video/${id}?h=matching` } } } } });
const configFor = (id = 1234, files = {}) => ({ video: { id }, request: { files } });
const media = currentSrc => ({ tagName: 'VIDEO', currentSrc, getAttribute: () => null });

test('Vimeo main page binds its observed playlist to matching NEXT_DATA and ignores an empty preload player', () => {
  const video = media('blob:https://vimeo.com/active');
  const preload = media('');
  const playlist = 'https://vod-adaptive-ak.vimeocdn.com/clip/playlist.m3u8';
  const options = { video, players: [video, preload], singleVideo: false, nextData: mainData(),
    entries: [{ name: playlist, initiatorType: 'fetch', responseStatus: 200 }] };
  assert.equal(resolve(page('https://vimeo.com/1234?autoplay=1&muted=1', options)).url, playlist);
  assert.ok(resolve(page('https://vimeo.com/1234', { ...options, nextData: mainData('9999') })).error);
  assert.ok(resolve(page('https://vimeo.com/1234', { ...options, nextData: null })).error);
  assert.ok(resolve(page('https://vimeo.com/1234', { ...options, players: [video, media('blob:https://vimeo.com/another')] })).error);
  const hidden = { ...media('blob:https://vimeo.com/preloaded'), getClientRects: () => [] };
  assert.equal(resolve(page('https://vimeo.com/1234', { ...options, players: [video, hidden] })).url, playlist);
  hidden.getClientRects = () => [{}];
  hidden.ownerDocument = { defaultView: { getComputedStyle: () => ({ visibility: 'hidden' }) } };
  assert.equal(resolve(page('https://vimeo.com/1234', { ...options, players: [video, hidden] })).url, playlist);
});

test('Vimeo uses matching observed config after the master has expired from resource timings', () => {
  const video = media('blob:https://vimeo.com/active');
  const high = 'https://vod.vimeocdn.com/clip/1080.mp4';
  const low = 'https://vod.vimeocdn.com/clip/360.mp4';
  const hls = 'https://vod-adaptive-ak.vimeocdn.com/clip/playlist.m3u8';
  const files = { progressive: [{ url: low, height: 360 }, { url: high, height: 1080 }],
    hls: { default_cdn: 'first', cdns: { first: { url: hls } } } };
  const options = { video, players: [video, media('')], singleVideo: false,
    configs: [{ configs: [configFor(9999, files), configFor(1234, files)] }],
    entries: Array.from({ length: 251 }, (_, index) => ({ name: `https://vod.vimeocdn.com/clip/segment-${index}.m4s`, initiatorType: 'fetch' })) };
  assert.equal(resolve(page('https://vimeo.com/1234', options)).url, high);
  assert.equal(resolve(page('https://vimeo.com/1234', options)).playback, 'file');
  const hlsOptions = { ...options, configs: [{ config: configFor(1234, { hls: files.hls }) }] };
  assert.equal(resolve(page('https://vimeo.com/1234', hlsOptions)).url, hls);
  assert.equal(resolve(page('https://vimeo.com/1234', hlsOptions)).playback, 'hls');
  assert.ok(resolve(page('https://vimeo.com/1234', { ...options, configs: [configFor(9999, files)] })).error);
  assert.ok(resolve(page('https://vimeo.com/1234', { ...options, configs: [configFor(1234, {
    dash: { default_cdn: 'first', cdns: { first: { url: 'https://vod.vimeocdn.com/clip/master.json' } } }
  })] })).error);
});

test('Vimeo does not use config marked as live or DRM protected', () => {
  const files = { progressive: [{ url: 'https://vod.vimeocdn.com/clip/1080.mp4', height: 1080 }] };
  const video = media('blob:https://player.vimeo.com/active');
  for (const flag of ['is_live', 'is_drm_protected']) {
    const config = configFor(1234, files); config.video[flag] = true;
    assert.match(resolve(page('https://player.vimeo.com/video/1234', { video, players: [video], configs: [config] })).error, /直播|受保护/);
  }
});

test('Vimeo can read only the embed URL declared by matching main-page metadata', async () => {
  const video = media('blob:https://vimeo.com/active');
  video.isConnected = true;
  video.controlsList = { contains: name => name === 'nodownload' };
  const config = configFor(1234, { hls: { default_cdn: 'first', cdns: {
    first: { url: 'https://vod-adaptive-ak.vimeocdn.com/clip/playlist.m3u8' }
  } } });
  const input = page('https://vimeo.com/1234?autoplay=1', { video, players: [video], nextData: mainData(),
    embedScripts: [{ textContent: `window.playerConfig = ${JSON.stringify(config)}; window.extra = true;` }] });
  let called = 0;
  ctx.fetch = async (url, options) => {
    called++;
    assert.equal(url, 'https://player.vimeo.com/video/1234?h=matching');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return { status: 200, redirected: false, url, headers: new Headers({ 'content-type': 'text/html' }),
      body: new Response('<html></html>').body };
  };
  assert.equal((await resolve.resolveAsync(input)).playback, 'hls');
  assert.equal(called, 1);
  const wrong = page('https://vimeo.com/1234', { video, players: [video], nextData: mainData('9999'), embedScripts: [] });
  assert.ok((await resolve.resolveAsync(wrong)).error);
  assert.equal(called, 1);
  delete ctx.fetch;
});

test('a visible Vimeo picture remains selectable inside the real aria-hidden video wrapper', () => {
  const video = media('blob:https://vimeo.com/active');
  video.closest = selector => selector.includes('aria-hidden') ? {} : null;
  video.getClientRects = () => [{}];
  const config = configFor(1234, { progressive: [{ url: 'https://vod.vimeocdn.com/clip/video.mp4' }] });
  const input = page('https://vimeo.com/1234', { video, players: [video, media('')], configs: [config], nextData: mainData() });
  assert.equal(resolve(input).url, 'https://vod.vimeocdn.com/clip/video.mp4');
  video.getClientRects = () => [];
  assert.ok(resolve(input).error);
});

test('Vimeo keeps the selected ended player when an end-screen recommendation covers it', () => {
  const video = { ...media('blob:https://vimeo.com/ended'), ended: true, readyState: 4,
    duration: 15.893333, videoWidth: 1280, videoHeight: 720, getClientRects: () => [{}] };
  const poster = { tagName: 'IMG', getAttribute: name => name === 'src' ? 'https://i.vimeocdn.com/video/next.jpg' : null };
  const recommended = link('https://vimeo.com/9999');
  const source = 'https://vod.vimeocdn.com/selected/video.mp4';
  const input = page('https://vimeo.com/798860', { video, players: [video, media('')], singleVideo: false,
    path: [poster, recommended], configs: [configFor(798860, { progressive: [{ url: source }] })] });
  const result = resolve(input);
  assert.equal(result.url, source);
  assert.equal(result.playback, 'file');
  assert.equal(resolve({ ...input, video: null }), null, 'An overlay without a selected player must not select a page video');
});

test('Vimeo main-page JSON-LD graph selects only the matching VideoObject embed URL', async () => {
  const video = media('blob:https://vimeo.com/active'); video.isConnected = true;
  const data = mainData();
  data.props.pageProps.clipMetadata.jsonLd = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'Organization', url: 'https://vimeo.com/1234', embedUrl: 'https://player.vimeo.com/video/9999' },
    { '@type': 'VideoObject', url: 'https://vimeo.com/9999', embedUrl: 'https://player.vimeo.com/video/1234?h=wrong' },
    { '@type': 'VideoObject', url: 'https://vimeo.com/1234', embedUrl: 'https://player.vimeo.com/video/1234?h=selected' }
  ] };
  const config = configFor(1234, { progressive: [{ url: 'https://vod.vimeocdn.com/clip/video.mp4' }] });
  const input = page('https://vimeo.com/1234', { video, players: [video], nextData: data,
    embedScripts: [{ textContent: `window.playerConfig = ${JSON.stringify(config)};` }] });
  let called = 0;
  ctx.fetch = async url => {
    called++; assert.equal(url, 'https://player.vimeo.com/video/1234?h=selected');
    return { status: 200, redirected: false, url, headers: new Headers({ 'content-type': 'text/html' }), body: new Response('<html></html>').body };
  };
  assert.equal((await resolve.resolveAsync(input)).url, 'https://vod.vimeocdn.com/clip/video.mp4');
  assert.equal(called, 1);
  delete ctx.fetch;
});

test('Vimeo async config lookup cannot erase an explicit live or DRM restriction', async () => {
  const video = media('blob:https://vimeo.com/active');
  const config = configFor(); config.video.is_drm_protected = true;
  const input = page('https://vimeo.com/1234', { video, players: [video], configs: [config], nextData: mainData(), embedScripts: [] });
  ctx.fetch = () => assert.fail('Must not fetch around a declared restriction');
  assert.match((await resolve.resolveAsync(input)).error, /受保护/);
  delete ctx.fetch;
});

test('Vimeo async lookup rejects another config ID, redirects, bad content and changed selection', async () => {
  const video = media('blob:https://vimeo.com/active'); video.isConnected = true;
  const config = configFor(9999, { progressive: [{ url: 'https://vod.vimeocdn.com/other/clip.mp4' }] });
  const input = page('https://vimeo.com/1234', { video, players: [video], nextData: mainData(),
    embedScripts: [{ textContent: `window.playerConfig = ${JSON.stringify(config)};` }] });
  const response = options => ({ status: 200, redirected: false, url: 'https://player.vimeo.com/video/1234?h=matching',
    headers: new Headers({ 'content-type': 'text/html' }), body: new Response('<html></html>').body, ...options });
  for (const options of [{}, { redirected: true }, { status: 403 }, { url: 'https://player.vimeo.com/video/9999' },
    { headers: new Headers({ 'content-type': 'application/json' }) }]) {
    ctx.fetch = async () => response(options);
    assert.ok((await resolve.resolveAsync(input)).error);
  }
  ctx.fetch = async () => { video.currentSrc = 'blob:https://vimeo.com/another'; return response(); };
  assert.match((await resolve.resolveAsync(input)).error, /已切换/);
  delete ctx.fetch;
});
