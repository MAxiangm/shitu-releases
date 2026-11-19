'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createCollector } = require('../src/collector.cjs');

const root = path.resolve(__dirname, '..');
const testsRoot = path.join(root, '.recovery', 'tests');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';
const videoId = 'BaW_jenozKc';
const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
// Container recognition is the collector's boundary; playback validity is the
// downloader's responsibility. Keep this fixture independent of FFmpeg.
const videoBytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f326d703431', 'hex');
const media = extra => ({ kind: 'video', sourceType: 'youtube', videoId, url: pageUrl, pageUrl, name: 'Selected video', ...extra });

async function fixture(t, options = {}) {
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'youtube-integration-'));
  const imports = [];
  const folders = [{ id: 'videos', name: 'Video references', parentId: null }];
  const library = {
    root: path.join(directory, 'library'),
    listFolders: () => folders,
    snapshot: () => ({ root: library.root, folders, assets: [] }),
    hasAsset: id => id === 'saved-video',
    async importPaths(files, settings) {
      imports.push({ files: [...files], settings, bytes: await fs.readFile(files[0]) });
      return { imported: 1, duplicates: 0, assetIds: ['saved-video'], errors: [] };
    }
  };
  const collector = createCollector({ library, configPath: path.join(directory, 'collector.json'), port: 0, ...options });
  await collector.start();
  const token = collector.info().code.split('.')[2];
  const request = async (route, body = {}) => {
    const response = await fetch(collector.info().baseUrl + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shitu-Token': token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    await collector.close();
    const relative = path.relative(testsRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { library, collector, imports, request, capture: body => request('/v1/capture', body) };
}

async function stagedVideo(options, bytes = videoBytes) {
  const filePath = path.join(options.directory, 'capture.mp4');
  await fs.writeFile(filePath, bytes);
  return { filePath, title: 'Downloaded YouTube title', pageUrl };
}

test('YouTube collector advertises availability only when a downloader is supplied', async t => {
  const unavailable = await fixture(t);
  assert.notEqual((await unavailable.request('/v1/ping')).body.youtubeDownload, true);
  const rejected = await unavailable.capture(media());
  assert.equal(rejected.body.ok, false);
  assert.equal(unavailable.imports.length, 0);
  const available = await fixture(t, { downloadYouTube: stagedVideo });
  assert.equal((await available.request('/v1/ping')).body.youtubeDownload, true);
});

test('YouTube collector imports downloaded bytes into the selected folder and retains the public video source', async t => {
  const calls = [];
  const setup = await fixture(t, { downloadYouTube: async options => {
    calls.push(options);
    options.onProgress({ phase: 'downloading', receivedBytes: videoBytes.length, totalBytes: videoBytes.length });
    return stagedVideo(options);
  } });
  const { libraryId } = (await setup.request('/v1/ping')).body;
  const result = await setup.capture(media({ requestId: '1700000000000-1', destination: { libraryId, folderId: 'videos' } }));
  assert.equal(result.body.ok, true, result.body.error);
  assert.equal(result.body.imported, 1);
  assert.equal(result.body.folderName, 'Video references');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, pageUrl);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(calls[0].maxBytes, 512 * 1024 * 1024);
  assert.equal(setup.imports.length, 1);
  assert.deepEqual(setup.imports[0].bytes, videoBytes);
  assert.equal(setup.imports[0].settings.folderId, 'videos');
  assert.deepEqual(setup.imports[0].settings.metadata, {
    name: 'Downloaded YouTube title', sourceUrl: pageUrl, pageUrl
  });
  const progress = (await setup.request('/v1/capture-progress', { requestId: '1700000000000-1' })).body.progress;
  assert.equal(progress.phase, 'complete');
  assert.equal(progress.receivedBytes, videoBytes.length);
  await assert.rejects(fs.access(calls[0].directory), { code: 'ENOENT' });
});

test('YouTube collector rejects inconsistent source identities and conflicting transfer modes before downloading', async t => {
  let downloads = 0;
  const setup = await fixture(t, { downloadYouTube: async options => { downloads++; return stagedVideo(options); } });
  for (const invalid of [
    { videoId: 'AAAAAAAAAAA' },
    { pageUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' },
    { url: 'https://youtube.com.evil.invalid/watch?v=BaW_jenozKc' },
    { url: 'https://www.youtube.com/playlist?list=PL123' },
    { kind: 'image' },
    { dataBase64: videoBytes.toString('base64'), mimeType: 'video/mp4' },
    { playback: 'file' },
    { browserRead: true },
    { sourceType: 'unknown' }
  ]) {
    const result = await setup.capture(media(invalid));
    assert.equal(result.body.ok, false, JSON.stringify(invalid));
  }
  assert.equal(downloads, 0);
  assert.equal(setup.imports.length, 0);
});

test('YouTube capture publishes byte progress and merging while a download is active', async t => {
  let release, started;
  const hold = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  const setup = await fixture(t, { downloadYouTube: async options => {
    options.onProgress({ phase: 'downloading', receivedBytes: 8192, totalBytes: 16384 });
    options.onProgress({ phase: 'merging', receivedBytes: 8192 });
    started();
    await hold;
    return stagedVideo(options);
  } });
  t.after(release);
  const saving = setup.capture(media({ requestId: '1700000000000-2' }));
  await reading;
  const progress = (await setup.request('/v1/capture-progress', { requestId: '1700000000000-2' })).body.progress;
  assert.equal(progress.phase, 'muxing');
  assert.equal(progress.receivedBytes, 8192);
  assert.equal(progress.totalBytes, 16384);
  assert.equal(setup.imports.length, 0);
  release();
  assert.equal((await saving).body.ok, true);
});

test('YouTube download errors and non-video responses never create a library entry', async t => {
  const failed = await fixture(t, { downloadYouTube: async () => { throw new Error('YouTube video is unavailable'); } });
  const error = await failed.capture(media());
  assert.equal(error.body.ok, false);
  assert.match(error.body.error, /unavailable/);
  assert.equal(failed.imports.length, 0);
  let directory;
  const html = await fixture(t, { downloadYouTube: async options => {
    directory = options.directory;
    return stagedVideo(options, Buffer.from('<!doctype html><html>Sign in</html>'));
  } });
  const invalid = await html.capture(media());
  assert.equal(invalid.body.ok, false);
  assert.equal(html.imports.length, 0);
  await assert.rejects(fs.access(directory), { code: 'ENOENT' });
});

test('YouTube collector rechecks the destination after a download finishes', async t => {
  let setup;
  setup = await fixture(t, { downloadYouTube: async options => {
    const result = await stagedVideo(options);
    setup.library.root += '-changed';
    return result;
  } });
  const { libraryId } = (await setup.request('/v1/ping')).body;
  const result = await setup.capture(media({ destination: { libraryId, folderId: 'videos' } }));
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'CAPTURE_LIBRARY_CHANGED');
  assert.equal(setup.imports.length, 0);
});

async function worker({ available = true, resolveMedia = media() } = {}) {
  const storage = { shituConnection: { port: 38475, token: 'a'.repeat(64) } };
  const requests = [], tabMessages = [], menus = [];
  let messageListener, clickListener, installed;
  const chrome = {
    runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`,
      getManifest: () => ({ version: '0.11.21' }), getPlatformInfo: async () => ({}),
      onMessage: { addListener: fn => { messageListener = fn; } },
      onStartup: { addListener() {} }, onInstalled: { addListener: fn => { installed = fn; } } },
    storage: { local: { setAccessLevel: async () => {},
      get: async key => typeof key === 'string' ? { [key]: storage[key] } : storage,
      set: async data => Object.assign(storage, structuredClone(data)) } },
    contextMenus: { removeAll: callback => { menus.length = 0; callback(); },
      create: (item, callback) => { menus.push(item); callback?.(); },
      onClicked: { addListener: fn => { clickListener = fn; } } },
    tabs: { sendMessage: async (tabId, message, options) => {
      tabMessages.push({ tabId, message, options });
      if (message.type === 'shitu:resolve-youtube') return { ok: true, media: resolveMedia };
    } }
  };
  vm.runInNewContext(await fs.readFile(path.join(root, 'extension', 'background.js'), 'utf8'), {
    chrome, URL, AbortController, AbortSignal, setTimeout, clearTimeout, clearInterval,
    setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; },
    fetch: async (url, options) => {
      const route = new URL(url).pathname;
      const body = JSON.parse(options.body);
      requests.push({ route, body });
      return Response.json(route === '/v1/capture'
        ? { ok: true, imported: 1, duplicates: 0, assetIds: ['saved-video'] }
        : { ok: true, app: '拾图', version: '0.29.19', ready: true, youtubeDownload: available });
    }
  }, { filename: 'extension/background.js' });
  const sender = { id: extensionId, url: pageUrl, tab: { id: 7, url: pageUrl }, frameId: 0 };
  return { storage, requests, tabMessages, menus, sender,
    install: () => installed(), click: (info, tab = sender.tab) => clickListener(info, tab),
    send: (message, from = sender) => new Promise(resolve => messageListener(message, from, resolve)) };
}

test('YouTube extension forwards the canonical video identity and preserves the requested source', async () => {
  const instance = await worker();
  const result = await instance.send({ type: 'shitu:capture', media: media() });
  assert.equal(result.ok, true, result.error);
  const captures = instance.requests.filter(request => request.route === '/v1/capture');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].body.sourceType, 'youtube');
  assert.equal(captures[0].body.videoId, videoId);
  assert.equal(captures[0].body.url, pageUrl);
  assert.equal(captures[0].body.pageUrl, pageUrl);
});

test('YouTube extension reports missing desktop capability without submitting a download', async () => {
  const instance = await worker({ available: false });
  const result = await instance.send({ type: 'shitu:capture', media: media() });
  assert.equal(result.ok, false);
  assert.equal(instance.requests.filter(request => request.route === '/v1/capture').length, 0);
});

test('YouTube extension rejects forged hostnames, inconsistent IDs and inline video payloads', async () => {
  for (const scenario of [
    { input: media({ videoId: 'AAAAAAAAAAA' }) },
    { input: media(), url: 'https://youtube.com.evil.invalid/watch?v=BaW_jenozKc' },
    { input: media({ dataBase64: videoBytes.toString('base64'), mimeType: 'video/mp4' }) },
    { input: media({ playback: 'file' }) }
  ]) {
    const instance = await worker();
    const result = await instance.send({ type: 'shitu:capture', media: scenario.input }, {
      ...instance.sender, url: scenario.url || pageUrl
    });
    assert.equal(result.ok, false, JSON.stringify(scenario));
    assert.equal(instance.requests.filter(request => request.route === '/v1/capture').length, 0);
  }
});

test('YouTube native video and page/link menus resolve the selected video through its frame', async () => {
  const instance = await worker();
  instance.install();
  const youtubeMenu = instance.menus.find(item => item.id === 'shitu-save-youtube');
  assert.ok(youtubeMenu);
  assert.ok(youtubeMenu.contexts.includes('page') && youtubeMenu.contexts.includes('link'));
  assert.ok(youtubeMenu.documentUrlPatterns.every(pattern => /youtube|youtu\.be/.test(pattern)));
  for (const info of [
    { menuItemId: 'shitu-save-media', mediaType: 'video', srcUrl: 'blob:https://www.youtube.com/player', pageUrl },
    { menuItemId: 'shitu-save-youtube', pageUrl, linkUrl: pageUrl },
    { menuItemId: 'shitu-save-youtube', pageUrl, frameUrl: 'https://www.youtube-nocookie.com/embed/BaW_jenozKc', frameId: 3 }
  ]) await instance.click(info);
  const resolutions = instance.tabMessages.filter(item => item.message.type === 'shitu:resolve-youtube');
  assert.equal(resolutions.length, 3);
  assert.equal(resolutions[2].options.frameId, 3);
  const captures = instance.requests.filter(request => request.route === '/v1/capture');
  assert.equal(captures.length, 3);
  assert.ok(captures.every(request => request.body.url === pageUrl && request.body.sourceType === 'youtube'));
});
