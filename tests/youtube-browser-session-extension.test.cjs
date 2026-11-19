'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';
const videoId = 'BaW_jenozKc';
const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
const permission = { permissions: ['cookies'], origins: ['https://*.youtube.com/*'] };
const bilibiliPermission = { permissions: ['cookies'], origins: ['https://*.bilibili.com/*'] };
const bilibiliPage = 'https://www.bilibili.com/video/BV1bK411W797/?p=2';
const bilibiliMedia = extra => ({ kind: 'video', sourceType: 'site-video', site: 'bilibili', videoId: 'BV1bK411W797:p2',
  url: bilibiliPage, pageUrl: bilibiliPage, name: 'Selected Bilibili part', ...extra });
const bilibiliSender = { id: extensionId, url: bilibiliPage, tab: { id: 7, url: bilibiliPage }, frameId: 0 };
const media = extra => ({ kind: 'video', sourceType: 'youtube', videoId, url: pageUrl, pageUrl, name: 'Selected video', ...extra });
const cookie = extra => ({ domain: '.youtube.com', path: '/', name: 'SAPISID', value: 'fixture-secret',
  secure: true, httpOnly: true, hostOnly: false, session: false, expirationDate: Date.now() / 1000 + 3600, ...extra });

async function worker(options = {}) {
  const controls = { granted: true, capability: true, bilibiliCapability: true, stores: [{ id: 'other', tabIds: [8] }, { id: 'selected', tabIds: [7] }],
    cookieBatches: [[cookie()]], ...options };
  const storage = { shituConnection: { port: 38475, token: 'a'.repeat(64) } };
  const requests = [], deliveries = [], permissionCalls = [], cookieCalls = [];
  let listener, cookieReads = 0;
  const chrome = {
    runtime: { id: extensionId, getURL: filename => `chrome-extension://${extensionId}/${filename}`,
      getPlatformInfo: async () => ({}), onMessage: { addListener: fn => { listener = fn; } },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: storage[key] }),
      set: async value => Object.assign(storage, structuredClone(value)) } },
    permissions: { contains: async value => { permissionCalls.push(structuredClone(value));
      return controls.granted && (!controls.origins || value.origins.every(origin => controls.origins.includes(origin))); } },
    cookies: {
      getAllCookieStores: async () => { cookieCalls.push({ method: 'stores' }); return controls.stores; },
      getAll: async value => {
        cookieCalls.push({ method: 'getAll', ...structuredClone(value) });
        if (controls.cookieError) throw controls.cookieError;
        return controls.cookieBatches[Math.min(cookieReads++, controls.cookieBatches.length - 1)];
      }
    },
    contextMenus: { removeAll: fn => fn(), create: (_item, fn) => fn?.(), onClicked: { addListener() {} } },
    tabs: { sendMessage: async (tabId, message) => { deliveries.push({ tabId, message: structuredClone(message) }); } }
  };
  const source = await fs.readFile(path.join(root, 'extension/video-page-source.js'), 'utf8') + '\n' +
    await fs.readFile(path.join(root, 'extension/background.js'), 'utf8');
  vm.runInNewContext(source, { chrome, URL, AbortController, AbortSignal, TextEncoder, setTimeout, clearTimeout, clearInterval,
    setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; },
    fetch: async (url, request) => {
      const route = new URL(url).pathname, body = JSON.parse(request.body);
      const call = { route, body }; requests.push(call);
      if (route === '/v1/capture') {
        const custom = controls.captureResponse?.(call, requests.filter(item => item.route === route).length);
        if (custom) return custom;
        return Response.json({ ok: true, imported: 1, duplicates: 0, assetIds: ['saved-video'] });
      }
      return Response.json({ ok: true, app: '拾图', version: '0.29.24', ready: true, youtubeDownload: true, siteVideoDownload: true,
        ...(controls.capability ? { youtubeBrowserSession: true } : {}),
        ...(controls.bilibiliCapability ? { bilibiliBrowserSession: true } : {}),
        ...(route === '/v1/connect' ? { connection: storage.shituConnection } : {}) });
    }
  }, { filename: 'extension/background.js' });
  const sender = { id: extensionId, url: pageUrl, tab: { id: 7, url: pageUrl }, frameId: 0 };
  return { controls, storage, requests, deliveries, permissionCalls, cookieCalls, sender,
    send: (input = media(), from = sender) => new Promise(resolve => listener({ type: 'shitu:capture', media: input }, from, resolve)) };
}

test('current YouTube session is read from the selected tab store and sent only to the desktop capture', async () => {
  const instance = await worker({ cookieBatches: [[cookie({ storeId: 'selected', unwanted: 'must-not-export' })]] });
  const result = await instance.send();
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(instance.permissionCalls, [permission]);
  assert.deepEqual(instance.cookieCalls, [{ method: 'stores' }, { method: 'getAll', domain: 'youtube.com', storeId: 'selected' }]);
  const capture = instance.requests.find(call => call.route === '/v1/capture');
  assert.ok(Math.abs(Date.now() - capture.body.youtubeSession.capturedAt) < 3000);
  assert.equal(capture.body.youtubeSession.cookies[0].value, 'fixture-secret');
  assert.deepEqual(Object.keys(capture.body.youtubeSession.cookies[0]).sort(),
    ['domain', 'path', 'name', 'value', 'secure', 'httpOnly', 'hostOnly', 'session', 'expirationDate'].sort());
  assert.equal(JSON.stringify([instance.storage, instance.deliveries, result]).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(instance.requests.filter(call => call.route !== '/v1/capture')).includes('fixture-secret'), false);
});

test('without optional authorization the download remains anonymous and never reads cookies', async () => {
  const instance = await worker({ granted: false });
  assert.equal((await instance.send()).ok, true);
  assert.deepEqual(instance.cookieCalls, []);
  assert.equal(Object.hasOwn(instance.requests.find(call => call.route === '/v1/capture').body, 'youtubeSession'), false);
});

test('old desktops are rejected before permission lookup even for anonymous downloads', async t => {
  for (const granted of [true, false]) await t.test(`permission ${granted}`, async () => {
    const instance = await worker({ capability: false, granted });
    const result = await instance.send();
    assert.equal(result.ok, false); assert.equal(result.code, 'INCOMPATIBLE_APP');
    assert.match(result.error, /更新桌面/);
    assert.deepEqual(instance.permissionCalls, []);
    assert.deepEqual(instance.cookieCalls, []);
    assert.equal(instance.requests.some(call => call.route === '/v1/capture'), false);
  });
});

test('a page-supplied session is rejected without inspecting it or reading browser cookies', async () => {
  const instance = await worker();
  const input = media();
  Object.defineProperty(input, 'youtubeSession', { enumerable: true, get() { assert.fail('page session must never be read'); } });
  const result = await instance.send(input);
  assert.equal(result.code, 'VIDEO_BROWSER_SESSION_INVALID');
  assert.deepEqual(instance.cookieCalls, []);
  assert.equal(instance.requests.some(call => call.route === '/v1/capture'), false);
});

test('unrelated image captures do not read or attach YouTube credentials', async () => {
  const instance = await worker();
  const result = await instance.send({ kind: 'image', url: 'https://images.example/test.png' },
    { ...instance.sender, url: 'https://images.example/page', tab: { id: 8 } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(instance.cookieCalls, []);
  assert.equal(Object.hasOwn(instance.requests.find(call => call.route === '/v1/capture').body, 'youtubeSession'), false);
});

test('missing or ambiguous stores and incognito tabs cannot export a session', async t => {
  for (const stores of [[], [{ id: 'wrong', tabIds: [8] }], [{ id: 'a', tabIds: [7] }, { id: 'b', tabIds: [7] }]]) {
    await t.test(JSON.stringify(stores), async () => {
      const instance = await worker({ stores });
      const result = await instance.send();
      assert.equal(result.code, 'VIDEO_BROWSER_SESSION_INVALID');
      assert.equal(instance.cookieCalls.some(call => call.method === 'getAll'), false);
      assert.equal(instance.requests.some(call => call.route === '/v1/capture'), false);
    });
  }
  const instance = await worker();
  const result = await instance.send(media(), { ...instance.sender, tab: { id: 7, incognito: true } });
  assert.equal(result.code, 'VIDEO_BROWSER_SESSION_INVALID'); assert.deepEqual(instance.cookieCalls, []);
});

test('only valid unpartitioned YouTube cookies are exported and cookie API diagnostics are private', async () => {
  const instance = await worker({ cookieBatches: [[cookie(), cookie({ domain: '.google.com' }), cookie({ domain: 'youtube.com.evil.test' }),
    cookie({ partitionKey: { topLevelSite: 'https://youtube.com' } }), cookie({ expirationDate: 1 }),
    cookie({ partitionKeyOpaque: true }), cookie({ session: true, name: 'session-fixture' }),
    cookie({ value: 'line\nbreak' }), cookie({ path: 'invalid' }), cookie({ secure: undefined })]] });
  assert.equal((await instance.send()).ok, true);
  const exported = instance.requests.find(call => call.route === '/v1/capture').body.youtubeSession.cookies;
  assert.equal(exported.length, 2);
  assert.equal(Object.hasOwn(exported.find(value => value.session), 'expirationDate'), false);
  const failed = await worker({ cookieError: new Error('private fixture-secret cookie diagnostic') });
  const result = await failed.send();
  assert.equal(result.code, 'VIDEO_BROWSER_SESSION_INVALID');
  assert.equal(JSON.stringify([failed.storage, failed.deliveries, result]).includes('fixture-secret'), false);
});

test('cookie count and serialized UTF-8 byte limits fail before submitting any session', async t => {
  for (const values of [Array.from({ length: 513 }, (_, index) => cookie({ name: `name-${index}` })), [cookie({ value: '界'.repeat(180000) })]]) {
    await t.test(values.length === 513 ? 'count limit' : 'byte limit', async () => {
      const instance = await worker({ cookieBatches: [values] });
      const result = await instance.send();
      assert.equal(result.code, 'VIDEO_BROWSER_SESSION_INVALID');
      assert.equal(instance.requests.some(call => call.route === '/v1/capture'), false);
    });
  }
});

test('a safe reconnect obtains fresh cookies instead of retaining the first payload', async () => {
  const instance = await worker({ cookieBatches: [[cookie({ value: 'first-fixture-secret' })], [cookie({ value: 'second-fixture-secret' })]],
    captureResponse: (_call, count) => count === 1 ? Response.json({ ok: false }, { status: 401 }) : null });
  const result = await instance.send();
  assert.equal(result.ok, true, result.error);
  const captures = instance.requests.filter(call => call.route === '/v1/capture');
  assert.equal(captures.length, 2);
  assert.equal(captures[0].body.youtubeSession.cookies[0].value, 'first-fixture-secret');
  assert.equal(captures[1].body.youtubeSession.cookies[0].value, 'second-fixture-secret');
  assert.equal(captures[0].body.requestId, captures[1].body.requestId);
  assert.equal(JSON.stringify([instance.storage, instance.deliveries, result]).includes('fixture-secret'), false);
});

test('desktop session errors are preserved without retries or cookie disclosure', async t => {
  for (const code of ['VIDEO_BROWSER_SESSION_INVALID', 'VIDEO_BROWSER_SESSION_EXPIRED', 'VIDEO_BROWSER_LOGIN_REQUIRED', 'VIDEO_BROWSER_PERMISSION_REQUIRED']) {
    await t.test(code, async () => {
      const instance = await worker({ captureResponse: () => Response.json({ ok: false, code, error: '请在当前 Chrome 检查 YouTube 登录。' }, { status: 400 }) });
      const result = await instance.send();
      assert.equal(result.code, code);
      assert.equal(instance.requests.filter(call => call.route === '/v1/capture').length, 1);
      assert.equal(JSON.stringify([instance.storage, instance.deliveries, result]).includes('fixture-secret'), false);
    });
  }
});

test('Bilibili reads the selected store and sends only Bilibili cookies for the exact part', async () => {
  const instance = await worker({ origins: [...permission.origins, ...bilibiliPermission.origins], cookieBatches: [[
    cookie(), cookie({ domain: '.bilibili.com', name: 'SESSDATA', value: 'bilibili-fixture-secret' }),
    cookie({ domain: 'www.bilibili.com', name: 'bili_jct', value: 'bilibili-csrf-fixture', session: true }),
    cookie({ domain: '.bilibili.com', expirationDate: 1 }),
    cookie({ domain: '.bilibili.com', partitionKeyOpaque: true }),
    cookie({ domain: 'bilibili.com.evil.test' })
  ]] });
  const result = await instance.send(bilibiliMedia(), bilibiliSender);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(instance.permissionCalls, [bilibiliPermission]);
  assert.deepEqual(instance.cookieCalls, [{ method: 'stores' }, { method: 'getAll', domain: 'bilibili.com', storeId: 'selected' }]);
  const body = instance.requests.find(call => call.route === '/v1/capture').body;
  assert.equal(body.videoId, 'BV1bK411W797:p2');
  assert.equal(body.url, bilibiliPage);
  assert.equal(Object.hasOwn(body, 'youtubeSession'), false);
  assert.deepEqual(body.bilibiliSession.cookies.map(value => value.name), ['SESSDATA', 'bili_jct']);
  assert.equal(Object.hasOwn(body.bilibiliSession.cookies[1], 'expirationDate'), false);
  assert.equal(JSON.stringify([instance.storage, instance.deliveries, result]).includes('bilibili-fixture-secret'), false);
});

test('Bilibili authorization is independent from YouTube and unauthorized Bilibili stays anonymous', async () => {
  const instance = await worker({ origins: permission.origins });
  assert.equal((await instance.send(bilibiliMedia(), bilibiliSender)).ok, true);
  assert.deepEqual(instance.permissionCalls, [bilibiliPermission]);
  assert.deepEqual(instance.cookieCalls, []);
  const body = instance.requests.find(call => call.route === '/v1/capture').body;
  assert.equal(Object.hasOwn(body, 'bilibiliSession'), false);
  assert.equal(Object.hasOwn(body, 'youtubeSession'), false);
});

test('old desktops cannot receive Bilibili requests regardless of cookie authorization', async t => {
  for (const granted of [true, false]) await t.test(`permission ${granted}`, async () => {
    const instance = await worker({ bilibiliCapability: false, granted });
    const result = await instance.send(bilibiliMedia(), bilibiliSender);
    assert.equal(result.code, 'INCOMPATIBLE_APP');
    assert.deepEqual(instance.permissionCalls, []);
    assert.deepEqual(instance.cookieCalls, []);
    assert.equal(instance.requests.some(call => call.route === '/v1/capture'), false);
  });
});

test('Bilibili session injection and cross-site identity changes are rejected before cookie access', async () => {
  for (const field of ['youtubeSession', 'bilibiliSession']) {
    const instance = await worker();
    const input = bilibiliMedia();
    Object.defineProperty(input, field, { enumerable: true, get() { assert.fail('page-supplied credentials must not be read'); } });
    const result = await instance.send(input, bilibiliSender);
    assert.equal(result.code, 'VIDEO_BROWSER_SESSION_INVALID');
    assert.deepEqual(instance.cookieCalls, []);
  }
  const mismatch = await worker();
  assert.equal((await mismatch.send(bilibiliMedia({ site: 'youtube' }), bilibiliSender)).ok, false);
  assert.deepEqual(mismatch.cookieCalls, []);
});

test('Bilibili safe reconnect refreshes only the Bilibili session', async () => {
  const instance = await worker({ cookieBatches: [
    [cookie({ domain: '.bilibili.com', value: 'first-bilibili-fixture' })],
    [cookie({ domain: '.bilibili.com', value: 'second-bilibili-fixture' })]
  ], captureResponse: (_call, count) => count === 1 ? Response.json({ ok: false }, { status: 401 }) : null });
  assert.equal((await instance.send(bilibiliMedia(), bilibiliSender)).ok, true);
  const bodies = instance.requests.filter(call => call.route === '/v1/capture').map(call => call.body);
  assert.deepEqual(bodies.map(body => body.bilibiliSession.cookies[0].value), ['first-bilibili-fixture', 'second-bilibili-fixture']);
  assert.ok(bodies.every(body => !Object.hasOwn(body, 'youtubeSession')));
  assert.ok(instance.cookieCalls.filter(call => call.method === 'getAll').every(call => call.domain === 'bilibili.com'));
});

test('other site-video submissions never inherit either browser session', async () => {
  const instance = await worker();
  const url = 'https://vimeo.com/123456789';
  const result = await instance.send({ kind: 'video', sourceType: 'site-video', site: 'vimeo', videoId: '123456789', url, pageUrl: url },
    { ...bilibiliSender, url, tab: { id: 7, url } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(instance.cookieCalls, []);
  const body = instance.requests.find(call => call.route === '/v1/capture').body;
  assert.equal(Object.hasOwn(body, 'youtubeSession'), false);
  assert.equal(Object.hasOwn(body, 'bilibiliSession'), false);
});

test('session authorization is optional and the extension version agrees across surfaces', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
  const source = await fs.readFile(path.join(root, 'extension/background.js'), 'utf8');
  const popup = await fs.readFile(path.join(root, 'extension/popup.html'), 'utf8');
  assert.deepEqual(manifest.optional_permissions, ['cookies']);
  assert.deepEqual(manifest.optional_host_permissions, [...permission.origins, ...bilibiliPermission.origins]);
  assert.equal(manifest.permissions.includes('cookies'), false);
  assert.match(source, new RegExp(`WORKER_VERSION = '${manifest.version.replaceAll('.', '\\.')}'`));
  assert.ok(popup.includes(`采集助手 ${manifest.version}`));
});

async function popup({ capability = true, bilibiliCapability = true, grantRequest = true, initialOrigins = [] } = {}) {
  const elements = new Map(), permissionCalls = [];
  const origins = new Set(initialOrigins);
  let cookiesGranted = initialOrigins.length > 0, inGesture = false;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', listeners: new Map(),
      addEventListener(type, fn) { this.listeners.set(type, fn); }, setAttribute() {} });
    return elements.get(id);
  };
  const chrome = {
    runtime: { getURL: filename => `chrome-extension://${extensionId}/${filename}`,
      sendMessage: async message => message.type === 'shitu:extension-info'
        ? { ok: true, protocol: 1, version: '0.11.27', build: '0.11.27' }
        : { ok: true, ready: true, version: '0.29.24', youtubeBrowserSession: capability, bilibiliBrowserSession: bilibiliCapability } },
    storage: { local: { get: async () => ({}) } },
    permissions: {
      contains: async value => (!value.permissions?.includes('cookies') || cookiesGranted) &&
        (!value.origins || value.origins.every(origin => origins.has(origin))),
      request(value) { assert.equal(inGesture, true, 'permission request must run synchronously inside the click');
        permissionCalls.push({ type: 'request', value: structuredClone(value) });
        if (grantRequest) { cookiesGranted = true; for (const origin of value.origins || []) origins.add(origin); }
        return Promise.resolve(grantRequest); },
      remove(value) { permissionCalls.push({ type: 'remove', value: structuredClone(value) });
        for (const origin of value.origins || []) origins.delete(origin);
        if (value.permissions?.includes('cookies')) cookiesGranted = false;
        return Promise.resolve(true); },
      onAdded: { addListener() {} }, onRemoved: { addListener() {} }
    }
  };
  Object.defineProperty(chrome, 'cookies', { get() { assert.fail('popup must never access browser cookies'); } });
  vm.runInNewContext(await fs.readFile(path.join(root, 'extension/popup.js'), 'utf8'), {
    chrome, document: { getElementById: element }, window: { addEventListener() {} },
    setInterval: () => 1, clearInterval() {}, fetch: async () => Response.json({ version: '0.11.27' })
  }, { filename: 'extension/popup.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, permissionCalls, click: async (isTrusted, site = 'youtube') => {
    inGesture = isTrusted;
    const result = element(`${site}SessionToggle`).listeners.get('click')({ isTrusted });
    inGesture = false;
    await result;
  } };
}

test('popup requests only YouTube cookie access during a trusted click and can revoke it', async () => {
  const instance = await popup();
  assert.equal(instance.elements.get('youtubeSessionToggle').disabled, false);
  await instance.click(false);
  assert.deepEqual(instance.permissionCalls, []);
  await instance.click(true);
  assert.deepEqual(instance.permissionCalls, [{ type: 'request', value: permission }]);
  assert.match(instance.elements.get('youtubeSessionStatus').textContent, /^已开启/);
  assert.match(instance.elements.get('youtubeSessionToggle').textContent, /停用/);
  await instance.click(true);
  assert.deepEqual(instance.permissionCalls.slice(-2), [{ type: 'remove', value: { origins: permission.origins } },
    { type: 'remove', value: { permissions: ['cookies'] } }]);
  assert.match(instance.elements.get('youtubeSessionStatus').textContent, /^未开启/);
});

test('popup leaves denied authorization off and does not request access for an old desktop', async () => {
  const denied = await popup({ grantRequest: false });
  await denied.click(true);
  assert.match(denied.elements.get('youtubeSessionStatus').textContent, /^未开启/);
  const old = await popup({ capability: false });
  assert.equal(old.elements.get('youtubeSessionToggle').disabled, true);
  await old.click(true);
  assert.deepEqual(old.permissionCalls, []);
});

test('popup requests each site separately and disabling one preserves the other login', async () => {
  const instance = await popup();
  await instance.click(false, 'bilibili');
  assert.deepEqual(instance.permissionCalls, []);
  await instance.click(true, 'youtube');
  await instance.click(true, 'bilibili');
  assert.deepEqual(instance.permissionCalls, [{ type: 'request', value: permission }, { type: 'request', value: bilibiliPermission }]);
  await instance.click(true, 'bilibili');
  assert.deepEqual(instance.permissionCalls.at(-1), { type: 'remove', value: { origins: bilibiliPermission.origins } });
  assert.match(instance.elements.get('youtubeSessionStatus').textContent, /^已开启/);
  assert.match(instance.elements.get('bilibiliSessionStatus').textContent, /^未开启/);
  await instance.click(true, 'bilibili');
  await instance.click(true, 'youtube');
  assert.deepEqual(instance.permissionCalls.at(-1), { type: 'remove', value: { origins: permission.origins } });
  assert.match(instance.elements.get('bilibiliSessionStatus').textContent, /^已开启/);
  assert.match(instance.elements.get('youtubeSessionStatus').textContent, /^未开启/);
  assert.equal(instance.permissionCalls.some(call => call.type === 'remove' && call.value.permissions), false);
  await instance.click(true, 'bilibili');
  assert.deepEqual(instance.permissionCalls.at(-1), { type: 'remove', value: { permissions: ['cookies'] } });
});

test('popup gates Bilibili authorization on its own desktop capability', async () => {
  const instance = await popup({ bilibiliCapability: false });
  assert.equal(instance.elements.get('youtubeSessionToggle').disabled, false);
  assert.equal(instance.elements.get('bilibiliSessionToggle').disabled, true);
  await instance.click(true, 'bilibili');
  assert.deepEqual(instance.permissionCalls, []);
});
