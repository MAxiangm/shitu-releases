'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createAuthenticatedVideoDownload } = require('../src/authenticated-video-download.cjs');
const { downloadYouTube } = require('../src/youtube-download.cjs');

const session = () => ({ capturedAt: Date.now(), cookies: [{ domain: '.youtube.com', path: '/', name: 'SID', value: 'fixed-test-only', secure: true, httpOnly: true, hostOnly: false, session: true }] });
const bilibiliSession = () => ({ capturedAt: Date.now(), cookies: [{ domain: '.bilibili.com', path: '/', name: 'SESSDATA', value: 'fixed-bilibili-test-only', secure: true, httpOnly: true, hostOnly: false, session: true }] });
function fixture(download, overrides = {}) {
  const sessions = [], prompts = [], sessionOptions = [];
  const auth = {
    withBrowserSession: async (value, callback, options) => { sessions.push(value); sessionOptions.push(options); return callback('transient-current-chrome.txt'); },
    withSession: async () => { throw new Error('Old saved accounts must never be used'); },
    state: async () => { throw new Error('Old saved accounts must never be inspected'); },
    connect: async () => { prompts.push(true); throw new Error('A login browser must never open'); },
    ...overrides
  };
  return { service: createAuthenticatedVideoDownload({ auth, downloadYouTube: download, downloadSiteVideo: download }), sessions, prompts, sessionOptions };
}

test('current Chrome session is scoped to one selected download, without forwarding its body to the downloader', async () => {
  const calls = [], supplied = session();
  const { service, sessions, prompts } = fixture(async options => { calls.push(options); return { filePath: 'verified.mp4' }; });
  const options = { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', directory: 'staging', browserSession: supplied, cookieFile: 'untrusted-old-account.txt' };
  assert.deepEqual(await service.downloadYouTube(options), { filePath: 'verified.mp4' });
  assert.deepEqual(sessions, [supplied]); assert.deepEqual(prompts, []);
  assert.equal(calls.length, 1); assert.equal(calls[0].cookieFile, 'transient-current-chrome.txt');
  assert.equal(calls[0].url, options.url); assert.equal(calls[0].directory, options.directory);
  assert.equal(Object.hasOwn(calls[0], 'browserSession'), false);
  assert.equal(options.cookieFile, 'untrusted-old-account.txt');
});

test('anonymous public videos do not inspect old accounts or create a session', async () => {
  const { service, sessions, prompts } = fixture(async options => options);
  const result = await service.downloadYouTube({ url: 'public-video', cookieFile: 'old.txt' });
  assert.equal(result.url, 'public-video'); assert.equal(result.cookieFile, undefined);
  assert.deepEqual(sessions, []); assert.deepEqual(prompts, []);
});

test('anonymous login refusals ask for extension permission once and never open a browser', async () => {
  for (const code of ['AUTH_REQUIRED', 'YOUTUBE_AUTH_REQUIRED', 'VIDEO_AUTH_REQUIRED', 'VIDEO_AUTH_EXPIRED']) {
    let attempts = 0;
    const { service, sessions, prompts } = fixture(async () => { attempts++; throw Object.assign(new Error('refused'), { code }); });
    await assert.rejects(service.downloadYouTube({ url: 'selected' }), error => error.code === 'VIDEO_BROWSER_PERMISSION_REQUIRED' && /采集助手/.test(error.message));
    assert.equal(attempts, 1); assert.deepEqual(sessions, []); assert.deepEqual(prompts, []);
  }
});

test('a rejected current account does not fall back to another saved or anonymous account', async () => {
  let attempts = 0;
  const { service, prompts } = fixture(async () => { attempts++; throw Object.assign(new Error('refused'), { code: 'YOUTUBE_AUTH_REQUIRED' }); });
  await assert.rejects(service.downloadYouTube({ url: 'selected', browserSession: session() }), { code: 'VIDEO_BROWSER_LOGIN_REQUIRED' });
  assert.equal(attempts, 1); assert.deepEqual(prompts, []);
});

test('invalid, expired and absent current sessions preserve fixed errors without a fallback', async () => {
  for (const code of ['VIDEO_BROWSER_SESSION_INVALID', 'VIDEO_BROWSER_SESSION_EXPIRED', 'VIDEO_BROWSER_LOGIN_REQUIRED']) {
    let downloads = 0;
    const failure = Object.assign(new Error('Fixed safe message'), { code });
    const { service, prompts } = fixture(async () => { downloads++; }, { withBrowserSession: async () => { throw failure; } });
    await assert.rejects(service.downloadYouTube({ url: 'selected', browserSession: session() }), error => error === failure);
    assert.equal(downloads, 0); assert.deepEqual(prompts, []);
  }
});

test('network and output errors remain intact and do not cause a login prompt', async () => {
  for (const code of ['NETWORK_ERROR', 'VIDEO_INCOMPLETE', 'ABORT_ERR']) {
    const error = Object.assign(new Error(code), { code });
    const { service, prompts } = fixture(async () => { throw error; });
    await assert.rejects(service.downloadYouTube({ url: 'selected' }), value => value === error);
    assert.deepEqual(prompts, []);
  }
});

test('aborted gestures cannot read a browser session or begin a download', async () => {
  let attempts = 0;
  const { service, sessions } = fixture(async () => { attempts++; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.downloadYouTube({ url: 'selected', browserSession: session(), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(attempts, 0); assert.deepEqual(sessions, []);
});

test('the current session lifetime cancellation reaches the downloader', async () => {
  const lifetime = new AbortController();
  const { service } = fixture(async options => options.signal, {
    withBrowserSession: async (_session, callback) => callback('current.tmp', { signal: lifetime.signal })
  });
  assert.equal(await service.downloadYouTube({ url: 'selected', browserSession: session() }), lifetime.signal);
  lifetime.abort();
  await assert.rejects(service.downloadYouTube({ url: 'selected', browserSession: session() }), { name: 'AbortError' });
});

test('Bilibili scopes current Chrome credentials and cancellation to the selected download', async () => {
  const supplied = bilibiliSession(), controller = new AbortController();
  const { service, sessions, sessionOptions, prompts } = fixture(async options => options);
  const input = { site: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2',
    browserSession: supplied, cookieFile: 'untrusted-old-account.txt', signal: controller.signal };
  const result = await service.downloadSiteVideo(input);
  assert.equal(result.site, 'bilibili'); assert.equal(result.url, input.url);
  assert.equal(result.cookieFile, 'transient-current-chrome.txt'); assert.equal(Object.hasOwn(result, 'browserSession'), false);
  assert.deepEqual(sessions, [supplied]); assert.deepEqual(sessionOptions, [{ site: 'bilibili', signal: controller.signal }]);
  assert.equal(input.cookieFile, 'untrusted-old-account.txt'); assert.deepEqual(prompts, []);
});

test('Bilibili anonymous and current-account refusals have distinct guidance and never switch accounts', async () => {
  for (const browserSession of [undefined, bilibiliSession()]) {
    let attempts = 0;
    const { service, sessions, prompts } = fixture(async () => {
      attempts++; throw Object.assign(new Error('Bilibili requires login'), { code: 'BILIBILI_AUTH_REQUIRED' });
    });
    await assert.rejects(service.downloadSiteVideo({ site: 'bilibili', url: 'selected', ...(browserSession ? { browserSession } : {}) }),
      error => error.code === (browserSession ? 'VIDEO_BROWSER_LOGIN_REQUIRED' : 'VIDEO_BROWSER_PERMISSION_REQUIRED') &&
        /Bilibili/.test(error.message) && (Boolean(browserSession) || /采集助手/.test(error.message)));
    assert.equal(attempts, 1); assert.equal(sessions.length, browserSession ? 1 : 0); assert.deepEqual(prompts, []);
  }
});

test('Bilibili public downloads stay anonymous and session validation failures do not retry', async () => {
  const { service, sessions } = fixture(async options => options);
  assert.equal((await service.downloadSiteVideo({ site: 'bilibili', url: 'selected', cookieFile: 'old.txt' })).cookieFile, undefined);
  assert.deepEqual(sessions, []);
  for (const code of ['VIDEO_BROWSER_SESSION_INVALID', 'VIDEO_BROWSER_SESSION_EXPIRED', 'VIDEO_BROWSER_LOGIN_REQUIRED']) {
    let downloads = 0;
    const error = Object.assign(new Error('fixed Bilibili error'), { code });
    const setup = fixture(async () => { downloads++; }, { withBrowserSession: async () => { throw error; } });
    await assert.rejects(setup.service.downloadSiteVideo({ site: 'bilibili', url: 'selected', browserSession: bilibiliSession() }), value => value === error);
    assert.equal(downloads, 0); assert.deepEqual(setup.prompts, []);
  }
});

test('other supported sites never receive current-browser credentials', async () => {
  const { service, sessions, prompts } = fixture(async options => options);
  for (const site of ['vimeo', 'x', 'pinterest', 'instagram']) {
    const options = { site, url: 'selected', cookieFile: 'untrusted.txt' };
    assert.equal((await service.downloadSiteVideo(options)).cookieFile, undefined);
    await assert.rejects(service.downloadSiteVideo({ ...options, browserSession: session() }), { code: 'VIDEO_BROWSER_SESSION_INVALID' });
  }
  assert.deepEqual(sessions, []); assert.deepEqual(prompts, []);
});

test('real downloader login errors and cookie arguments follow the current-account contract', async t => {
  const parent = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'current-chrome-downloader-'));
  t.after(async () => { assert.equal(path.dirname(directory), parent); await fs.rm(directory, { recursive: true, force: true }); });
  const runtimeDir = path.join(directory, 'runtime'); await fs.mkdir(runtimeDir);
  await Promise.all(['yt-dlp.exe', 'deno.exe', 'ffmpeg.exe'].map(name => fs.writeFile(path.join(runtimeDir, name), 'fixture')));
  const cookieFile = path.join(directory, 'dummy-session.txt'); await fs.writeFile(cookieFile, '# Fixed test-only session\n');
  const calls = [], url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw', output = path.join(directory, 'capture.mp4');
  let refuse = true;
  const spawnProcess = (_executable, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.emit('close', 1); return true; }; calls.push(args);
    setImmediate(async () => {
      if (refuse) { child.stderr.end("ERROR: Sign in to confirm you're not a bot\n"); child.stdout.end(); child.emit('close', 1); return; }
      try {
        await fs.writeFile(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]));
        child.stdout.end(`MOSAIC_META:${JSON.stringify({ id: 'jNQXAC9IVRw', vcodec: 'h264', acodec: 'aac' })}\nMOSAIC_FILE:${JSON.stringify(output)}\n`);
        child.stderr.end(); child.emit('close', 0);
      } catch (error) { child.emit('error', error); }
    }); return child;
  };
  const { service, prompts } = fixture(downloadYouTube, { withBrowserSession: async (_session, callback) => callback(cookieFile) });
  const options = { url, directory, runtimeDir, ffmpegPath: path.join(runtimeDir, 'ffmpeg.exe'), spawnProcess };
  await assert.rejects(service.downloadYouTube(options), { code: 'VIDEO_BROWSER_PERMISSION_REQUIRED' });
  assert.equal(calls.length, 1); assert.equal(calls[0].includes('--cookies'), false);
  refuse = false;
  assert.equal((await service.downloadYouTube({ ...options, browserSession: session() })).filePath, output);
  assert.equal(calls.length, 2); assert.equal(calls[1][calls[1].indexOf('--cookies') + 1], cookieFile);
  assert.ok(calls.every(args => args.at(-1) === url)); assert.deepEqual(prompts, []);
});
