'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ctx = { URL };
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
    video: options.video === false ? null : {},
    singleVideo: options.singleVideo !== false,
    document: { title: 'Example on Vimeo', querySelectorAll: () => options.links || [] },
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

test('Vimeo ignores playback paths and unrelated URLs and guides embedded users to the video page', () => {
  const playback = official().replace('/download/', '/playback/');
  const wrongHostname = official().replace('player.vimeo.com', 'player.vimeo.com.other.test');
  assert.match(resolve(page(undefined, { path: [link(playback), link(wrongHostname)] })).error, /打开「下载」/);
  const iframe = resolve(page('https://player.vimeo.com/video/1234?h=fixture&autoplay=1'));
  assert.equal(iframe.openUrl, 'https://vimeo.com/1234');
  assert.match(iframe.error, /作者开放/);
});

test('Vimeo only accepts a CDN download URL when the link is explicitly offered for download', () => {
  const source = 'https://download-video-ak.vimeocdn.com/fixture.mp4';
  assert.equal(resolve(page(undefined, { video: false, path: [link(source)] })), null);
  const result = resolve(page(undefined, { video: false, path: [link(source, { dialog: true, label: 'Download 1080p' })] }));
  assert.equal(result.url, source);
});
