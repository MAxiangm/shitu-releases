'use strict';
// Independent test app: never loads the production main process or user profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { root, base } = require('./fixture.json');
const extensionId = 'mdleapcbplpefdgchdklofdnpjgokdhh';
app.setName('Shitu isolated collector smoke');
app.setPath('userData', path.join(base, 'profile'));
app.setPath('sessionData', path.join(base, 'sessions'));
let collector, sourceServer, crossOriginServer, window, finishing = false;
const failures = [], consoleNotes = [];
const timer = setTimeout(() => finish({ ok: false, error: 'Collector smoke exceeded its time limit' }), 50000); timer.unref();
async function finish(result) {
  if (finishing) return; finishing = true; clearTimeout(timer);
  try {
    await collector?.close();
    for (const server of [sourceServer, crossOriginServer]) if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (window && !window.isDestroyed()) window.destroy();
    await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ...result, failures }, null, 2));
  } finally { app.exit(result.ok ? 0 : 1); }
}
app.whenReady().then(async () => {
  const { Library } = require(path.join(root, 'src', 'library.cjs'));
  const { createCollector } = require(path.join(root, 'src', 'collector.cjs'));
  const sharp = require(path.join(root, 'node_modules', 'sharp'));
  const firstImage = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#2f86c1' } }).png().toBuffer();
  const secondImage = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#35b96a' } }).png().toBuffer();
  const corsAllowedImage = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#d79b32' } }).png().toBuffer();
  const directVideo = await fs.readFile(path.join(base, 'direct-video.mp4'));
  const browserVideo = await fs.readFile(path.join(base, 'session-video.mp4'));
  const sourceRequests = [];
  const page = `<!doctype html><title>Isolated collector fixture</title>
    <style>
      #image {width:160px;height:120px;margin:20px}
      .players {display:flex;gap:30px;margin:0 20px}
      .player {position:relative;width:160px;height:120px}
      .player video,.player img {position:absolute;inset:0;width:100%;height:100%}
    </style>
    <img id="image" src="/image.png" alt="Selected collector fixture">
    <div class="players">
      <div class="player"><video src="/direct-video.mp4" preload="none"></video><img id="directPoster" src="/image.png" alt="Video poster"></div>
      <div class="player"><video src="/session-video.mp4" preload="none"></video><img id="sessionPoster" src="/image.png" alt="Video poster"></div>
    </div>`;
  const sourceHandler = (request, response) => {
    const browserSession = /(?:^|;\s*)collector-fixture=present(?:;|$)/.test(request.headers.cookie || '');
    const desktop = (request.headers['user-agent'] || '').includes('ShituCollector');
    sourceRequests.push({ path: request.url, browserSession, desktop });
    if (request.url === '/image.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(firstImage); }
    else if (request.url === '/cors.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(secondImage); }
    else if (request.url === '/allowed-cors.png') { response.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': request.headers.origin || '*' }); response.end(corsAllowedImage); }
    else if (request.url === '/forbidden.png') { response.writeHead(403, { 'Content-Type': 'text/html' }); response.end('Not permitted'); }
    else if (request.url === '/direct-video.mp4') { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(directVideo); }
    else if (request.url === '/session-video.mp4') {
      if (browserSession) { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(browserVideo); }
      else { response.writeHead(403, { 'Content-Type': 'text/html' }); response.end('Open the fixture page first'); }
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'collector-fixture=present; HttpOnly; SameSite=Strict; Path=/' });
      response.end(page);
    }
  };
  sourceServer = http.createServer(sourceHandler); crossOriginServer = http.createServer(sourceHandler);
  for (const server of [sourceServer, crossOriginServer]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sourceUrl = `http://127.0.0.1:${sourceServer.address().port}`;
  const crossOriginUrl = `http://127.0.0.1:${crossOriginServer.address().port}`;
  const library = new Library({ root: path.join(base, 'library'), createThumbnail: async (source, destination) => {
    const metadata = await sharp(source).metadata(); await sharp(source).resize(16).jpeg().toFile(destination); return { width: metadata.width, height: metadata.height };
  } });
  await library.init();
  // The private-address exception applies only to generated loopback fixtures.
  collector = createCollector({ library, configPath: path.join(base, 'collector.json'), allowPrivate: true });
  await collector.start();
  const pairing = collector.info().code.split('.');
  assert.ok(Number(pairing[1]) >= 38475 && Number(pairing[1]) <= 38484);
  const storage = { shituConnection: { port: Number(pairing[1]), token: pairing[2] } };
  const captured = [];
  let listener;
  const chrome = {
    runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`,
      getManifest: () => require(path.join(root, 'extension', 'manifest.json')), getPlatformInfo: async () => ({}),
      onMessage: { addListener: callback => { listener = callback; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, structuredClone(value)) } },
    contextMenus: { removeAll: callback => callback(), create: (_item, callback) => callback(), onClicked: { addListener() {} } },
    tabs: { sendMessage: async (_id, message) => message.type === 'shitu:resolve-media'
      ? window.webContents.executeJavaScript(`__shituSmokeChrome.resolveMedia(${JSON.stringify(message)})`)
      : window.webContents.send('smoke:tab-message', message) }
  };
  vm.runInNewContext(await fs.readFile(path.join(root, 'extension', 'background.js'), 'utf8'), { chrome, URL, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, fetch: async (url, options) => {
      // Even a discovery/reconnect bug cannot pair this test with the user's app.
      if (!String(url).startsWith(collector.info().baseUrl + '/')) throw new Error('Collector smoke refuses every other local service');
      if (new URL(url).pathname === '/v1/capture') captured.push(JSON.parse(options.body));
      return fetch(url, options);
    } }, { filename: 'extension/background.js' });
  ipcMain.handle('smoke:capture', (_event, message) => new Promise(resolve => listener(message,
    { id: extensionId, url: sourceUrl + '/', tab: { id: 1, url: 'https://top-frame.example.invalid/' } }, resolve)));
  window = new BrowserWindow({ width: 640, height: 480, show: false, skipTaskbar: true,
    webPreferences: { preload: path.join(base, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) consoleNotes.push(event.message); });
  await window.loadURL(sourceUrl + '/');
  await window.webContents.executeJavaScript(`window.__collectorGestureEvents=[];for(const type of ['pointerdown','contextmenu'])window.addEventListener(type,event=>window.__collectorGestureEvents.push({type,trusted:event.isTrusted,alt:event.altKey}),true)`);
  let content = await fs.readFile(path.join(root, 'extension', 'content.js'), 'utf8');
  // Electron reserves window.chrome. Only its API binding changes; the actual
  // capture function and every network/response branch run unchanged.
  content = content.replaceAll('chrome.runtime', '__shituSmokeChrome.runtime');
  const closing = content.lastIndexOf('})();'); assert.ok(closing > 0);
  content = content.slice(0, closing) + `
    globalThis.__collectorCaptureForTest = capture;
    globalThis.__collectorPointForTest = async (clientX, clientY) => {
      const composedPath = () => [document.elementFromPoint(clientX, clientY)];
      await capture(mediaAt({ clientX, clientY, composedPath }));
    };
  ` + content.slice(closing);
  await window.webContents.executeJavaScript(content);
  const toast = () => window.webContents.executeJavaScript(`(() => {const node=document.querySelector('[data-shitu-toast]');return node?{status:node.getAttribute('data-status'),message:node.getAttribute('aria-label')}:null})()`);
  let gestureNote;
  async function clickMedia(id) {
    const { x, y, hits } = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-shitu-toast]')?.remove();
      window.__collectorGestureEvents.length = 0;
      const bounds = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
      const x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2);
      return { x, y, hits: document.elementsFromPoint(x, y).map(node => node.tagName) };
    })()`);
    assert.equal(hits[0], 'IMG');
    if (id.endsWith('Poster')) assert.ok(hits.includes('VIDEO'), 'Fixture poster must cover a video');
    let trusted = false;
    try {
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 });
      for (const [type, buttons] of [['mousePressed', 2], ['mouseReleased', 0]])
        await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'right', buttons, modifiers: 1, clickCount: 1 });
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 0 });
      await new Promise(resolve => setTimeout(resolve, 150));
      trusted = await window.webContents.executeJavaScript(`window.__collectorGestureEvents.some(event=>event.type==='contextmenu'&&event.trusted&&event.alt)`);
      if (!trusted) gestureNote = 'This display environment did not deliver trusted mouse input; used the isolated hit-test bridge.';
    } catch (error) { gestureNote = `Trusted mouse input unavailable: ${error.message}`; }
    finally { if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach(); }
    if (!trusted) await window.webContents.executeJavaScript(`__collectorPointForTest(${x}, ${y})`);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = (await toast())?.status;
      if (status && status !== 'working') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return trusted;
  }
  const trustedGesture = await clickMedia('image');
  assert.equal((await toast())?.status, 'success'); assert.equal(library.snapshot().assets.length, 1);
  assert.ok(captured[0].dataBase64); assert.equal(captured[0].url, sourceUrl + '/image.png');
  const first = library.snapshot().assets[0];
  assert.equal(first.sourceUrl, sourceUrl + '/image.png'); assert.equal(first.pageUrl, sourceUrl + '/');
  assert.deepEqual(await fs.readFile(library.getAssetPath(first.id, 'original')), firstImage);
  await window.webContents.executeJavaScript(`__collectorCaptureForTest({url:${JSON.stringify(crossOriginUrl + '/cors.png')},kind:'image',name:'Direct URL fallback fixture'})`);
  assert.equal((await toast())?.status, 'success'); assert.equal(library.snapshot().assets.length, 2);
  assert.equal(captured[1].dataBase64, undefined);
  assert.deepEqual(await fs.readFile(library.getAssetPath(library.snapshot().assets[1].id, 'original')), secondImage);
  await window.webContents.executeJavaScript(`__collectorCaptureForTest({url:${JSON.stringify(crossOriginUrl + '/allowed-cors.png')},kind:'image',name:'Pinimg-like CORS fixture'})`);
  assert.equal((await toast())?.status, 'success'); assert.equal(library.snapshot().assets.length, 3);
  assert.ok(captured[2].dataBase64);
  assert.deepEqual(await fs.readFile(library.getAssetPath(library.snapshot().assets[2].id, 'original')), corsAllowedImage);
  await library.setTrash([first.id], true);
  await window.webContents.executeJavaScript(`__collectorCaptureForTest({url:${JSON.stringify(sourceUrl + '/image.png')},kind:'image',name:'Duplicate fixture'})`);
  const duplicateToast = await toast(); assert.equal(duplicateToast.status, 'warning'); assert.match(duplicateToast.message, /回收站/);
  assert.equal(library.snapshot().assets.length, 3);
  await window.webContents.executeJavaScript(`__collectorCaptureForTest({url:${JSON.stringify(sourceUrl + '/forbidden.png')},kind:'image',name:'Failure fixture'})`);
  const failedToast = await toast(); assert.equal(failedToast.status, 'error'); assert.match(failedToast.message, /403/);
  assert.equal(storage.shituLastCapture.ok, false); assert.equal(storage.shituLastCapture.status, 'error');
  assert.equal(collector.info().lastCapture.status, 'error'); assert.equal(collector.activeCount(), 0);
  const initialCaptures = captured.length;
  const trustedDirectVideo = await clickMedia('directPoster');
  assert.equal((await toast())?.status, 'success');
  assert.equal(captured.length, initialCaptures + 1);
  assert.equal(captured.at(-1).url, sourceUrl + '/direct-video.mp4');
  assert.equal(captured.at(-1).kind, 'video'); assert.equal(captured.at(-1).dataBase64, undefined);
  const trustedSessionVideo = await clickMedia('sessionPoster');
  assert.equal((await toast())?.status, 'success');
  assert.equal(captured.length, initialCaptures + 3);
  const [directAttempt, browserAttempt] = captured.slice(-2);
  for (const attempt of [directAttempt, browserAttempt]) {
    assert.equal(attempt.url, sourceUrl + '/session-video.mp4'); assert.equal(attempt.kind, 'video');
  }
  assert.equal(directAttempt.dataBase64, undefined);
  assert.equal(browserAttempt.mimeType, 'video/mp4'); assert.equal(browserAttempt.dataBase64, browserVideo.toString('base64'));
  const videos = library.snapshot().assets.filter(asset => asset.mediaType === 'video');
  assert.equal(videos.length, 2);
  for (const [route, expected] of [['/direct-video.mp4', directVideo], ['/session-video.mp4', browserVideo]]) {
    const asset = videos.find(asset => asset.sourceUrl === sourceUrl + route);
    assert.ok(asset, `Missing video for ${route}`);
    assert.equal(asset.ext, 'mp4'); assert.equal(asset.pageUrl, sourceUrl + '/');
    assert.deepEqual(await fs.readFile(library.getAssetPath(asset.id, 'original')), expected);
  }
  const sessionRequests = sourceRequests.filter(request => request.path === '/session-video.mp4');
  assert.ok(sessionRequests.some(request => request.desktop && !request.browserSession));
  assert.ok(sessionRequests.some(request => !request.desktop && request.browserSession));
  await finish({ ok: true, electron: process.versions.electron, trustedGesture, ChromeMV3: false, gestureNote,
    contentSourceExecuted: true, workerSourceExecuted: true, sourceBindingsIsolated: true, browserBytesImported: true,
    provenancePreserved: true, corsFallbackImported: true, corsAllowedBrowserBytesImported: true, duplicateInTrashExplained: true, finalErrorVisible: true,
    trustedDirectVideo, trustedSessionVideo, videosSelectedThroughPosters: true, directVideoImported: true, browserSessionVideoImported: true,
    libraryAssets: library.snapshot().assets.length, sourceRequests: sourceRequests.length, expectedBrowserErrors: consoleNotes.length,
    ownServicesClosed: true, userData: app.getPath('userData') });
}).catch(error => finish({ ok: false, error: error.stack || String(error), consoleNotes }));
