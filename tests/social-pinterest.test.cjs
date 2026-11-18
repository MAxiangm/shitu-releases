'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ctx = { URL, Response, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/social-pinterest.js'), 'utf8'), ctx);
const resolve = ctx.MosaicPinterestVideo;
const pinId = '701224604474154183';
const otherId = '701224604474154184';
const key = 'abcdef12345678901234567890123456';
const other = '01234512345678901234567890123456';
const source = 'https://v1.pinimg.com/videos/mc/720p/ab/cd/ef/' + key + '.mp4';
const hevc = 'https://v1.pinimg.com/videos/iht/hevcMp4V2/ab/cd/ef/' + key + '_t4.mp4';
const hls = 'https://v1.pinimg.com/videos/iht/hls/ab/cd/ef/' + key + '.m3u8';
const poster = 'https://i.pinimg.com/videos/thumbnails/originals/ab/cd/ef/' + key + '.0000000.jpg';
const pinUrl = `https://ca.pinterest.com/pin/${pinId}/`;

function relay(pin = {}, { requestId = pinId, encodedResponse = false } = {}) {
  const request = { queryID: 'pInterestRelayQuery', variables: { pinId: requestId } };
  const response = { data: { v3GetPinQueryv2: { data: { __typename: 'Pin', entityId: pinId, title: 'Video title',
    videos: { videoList: { vHLSV4: { url: hls }, v720P: { url: source } }, videoUrls: [hevc, hls, source] }, ...pin } } } };
  if (encodedResponse) {
    return { textContent: `window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__(${JSON.stringify(encodeURIComponent(JSON.stringify({ ...request, ...response })))});` };
  }
  return { textContent: `window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__(${JSON.stringify(encodeURIComponent(JSON.stringify(request)))}, ${JSON.stringify(response)});` };
}

function page({ href = pinUrl + '?utm_source=ignored', scripts = [relay()], video = { currentSrc: 'blob:https://ca.pinterest.com/fixture' },
  singleVideo = true, nodes = [] } = {}) {
  return { page: new URL(href), video, singleVideo, path: nodes,
    document: { title: 'Default title', querySelectorAll(selector) {
      assert.equal(selector, 'script[data-relay-completed-request="true"]');
      return scripts;
    } } };
}

test('Pinterest regional Pin resolves its declared progressive MP4 from the actual two-argument Relay shape', () => {
  const result = resolve(page({ scripts: [relay({ videos: { videoUrls: [hevc, hls] } }), relay()] }));
  assert.equal(result.url, source);
  assert.equal(result.pageUrl, pinUrl);
  assert.equal(result.name, 'Video title');
  assert.equal(resolve(page({ scripts: [relay({}, { encodedResponse: true })] })).url, source);
});

test('Pinterest matches both route and Pin record IDs and never runs an executable script', () => {
  const unexpected = relay();
  unexpected.textContent += '\nthrow new Error("not data");';
  const limited = relay({ videos: { videoUrls: [source], downloadable: false } });
  assert.equal(resolve(page({ scripts: [relay({ entityId: otherId }), relay({}, { requestId: otherId }), unexpected] })), null);
  assert.equal(resolve(page({ scripts: [relay(), limited] })), null);
  for (const href of [pinUrl.replace('https:', 'http:'), pinUrl.replace('pinterest.com', 'pinterest.com.example'),
    pinUrl.replace(`/pin/${pinId}`, '/explore/videos'), pinUrl + 'extra/']) assert.equal(resolve(page({ href })), null);
});

test('Pinterest requires a chosen matching video identity if the page has multiple players', () => {
  assert.equal(resolve(page({ singleVideo: false })), null);
  assert.equal(resolve(page({ singleVideo: false, video: { currentSrc: 'blob:https://ca.pinterest.com/fixture', poster } })).url, source);
  assert.equal(resolve(page({ singleVideo: false, video: { currentSrc: hls } })).url, source);
  assert.equal(resolve(page({ video: { currentSrc: hls.replace(key, other) } })), null);
  assert.equal(resolve(page({ nodes: [{ getAttribute: name => name === 'data-pin-id' ? otherId : null }] })), null);
  assert.equal(resolve(page({ video: { currentSrc: 'blob:https://unrelated.example/fixture' } })), null);
  assert.equal(resolve(page({ video: { currentSrc: source, mediaKeys: {} } })), null);
  assert.equal(resolve(page({ video: null })), null);
});

test('Pinterest uses only the clicked primary image when a video Pin initially renders a still cover', () => {
  const cover = 'https://i.pinimg.com/736x/01/23/45/' + other + '.jpg';
  const metadata = relay({ isVideo: false, imageSignature: other, images_orig: { url: cover.replace('/736x/', '/originals/') } });
  const image = { tagName: 'IMG', currentSrc: cover };
  const options = { video: null, singleVideo: false, nodes: [image], scripts: [metadata] };
  assert.equal(resolve(page(options)).url, source);
  assert.equal(resolve(page({ ...options, nodes: [{ ...image, currentSrc: poster }] })).url, source);
  const unrelated = cover.replace(other, '012345abcdabcdabcdabcdabcdabcdab');
  assert.equal(resolve(page({ ...options, nodes: [{ ...image, currentSrc: unrelated }] })), null);
  assert.equal(resolve(page({ ...options, nodes: [{ ...image, currentSrc: cover.replace('i.pinimg.com', 'i.pinimg.com.example') }] })), null);
  assert.equal(resolve(page({ ...options, nodes: [{ ...image, closest: () => ({ getAttribute: () => otherId }) }] })), null);
});

test('Pinterest only accepts declared official CDN MP4s and refuses unrelated or ambiguous media', () => {
  assert.equal(resolve(page({ scripts: [relay({ videos: { videoUrls: [hls, hevc] } })] })).url, hevc);
  const spoof = source.replace('v1.pinimg.com', 'v1.pinimg.com.example');
  const secondMovie = source.replace('ab/cd/ef/' + key, '01/23/45/' + other);
  const invalid = [hls, spoof, source.replace('https:', 'http:'), source.replace('/ab/cd/ef', '/de/ad/be'), source + '?unexpected=1'];
  assert.equal(resolve(page({ scripts: [relay({ videos: { videoUrls: invalid } })] })), null);
  const ambiguous = { scripts: [relay({ videos: { videoUrls: [source, secondMovie] } })] };
  assert.equal(resolve(page(ambiguous)), null);
  assert.equal(resolve(page({ ...ambiguous, video: { currentSrc: hls } })).url, source);
});

test('Pinterest accepts declared expMp4 and HEVC V3 files used by the blackhole Pin', () => {
  const modern = 'https://v1.pinimg.com/videos/iht/expMp4/6f/4f/f7/6f4ff726b4ac050ce695d4d9769bc044_720w.mp4';
  const hevcV3 = modern.replace('/expMp4/', '/hevcMp4V3/');
  const variants = { videos: { videoList: { v720P: { url: modern } }, videoUrls: [hevcV3, modern] } };
  const result = resolve(page({ scripts: [relay(variants)] }));
  assert.equal(result.url, modern);
  assert.equal(resolve(page({ scripts: [relay({ videos: { videoUrls: [hevcV3] } })] })).url, hevcV3);
  assert.equal(resolve(page({ scripts: [relay(variants)], video: { currentSrc: modern } })).url, modern);
  assert.equal(resolve(page({ scripts: [relay(variants)], video: { currentSrc: modern.replace('6f4ff726b4ac050ce695d4d9769bc044', key) } })), null);
});

const liveCover = 'https://i.pinimg.com/736x/a5/92/c2/a592c2b77d7b30abfc03836b148d2dab.jpg';
const livePin = () => relay({ images_orig: { url: liveCover.replace('/736x/', '/originals/') } });
const htmlFor = (...scripts) => '<!doctype html><html><body>' + scripts.map(script =>
  `<script data-relay-completed-request="true">${script.textContent}</script>`).join('') + '</body></html>';

function asyncPage({ scripts = [], video = {}, ...options } = {}) {
  const input = page({ ...options, scripts, video: { tagName: 'VIDEO', isConnected: true,
    currentSrc: 'blob:https://ca.pinterest.com/fixture', poster: liveCover, ...video } });
  const location = { href: input.page.href };
  input.document.defaultView = { location };
  input.document.location = location;
  input.document.createElement = tag => {
    assert.equal(tag, 'template');
    let text = '';
    return {
      set innerHTML(value) { text = value; },
      content: { querySelectorAll(selector) {
        assert.equal(selector, 'script[data-relay-completed-request="true"]');
        return [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
          .filter(match => /data-relay-completed-request\s*=\s*["']true["']/i.test(match[1]))
          .map(match => ({ textContent: match[2], src: /\bsrc\s*=/i.test(match[1]) ? 'external.js' : '' }));
      } }
    };
  };
  return input;
}

function htmlResponse(body = htmlFor(livePin()), { url = pinUrl, redirected = false, status = 200,
  contentType = 'text/html; charset=utf-8', headers = {} } = {}) {
  const response = new Response(body, { status, headers: { 'Content-Type': contentType, ...headers } });
  Object.defineProperties(response, { url: { value: url }, redirected: { value: redirected } });
  return response;
}

async function readAsync(input, fetchImpl) {
  ctx.location = input.document.defaultView.location;
  ctx.fetch = fetchImpl;
  try { return await resolve.resolveAsync(input); }
  finally { delete ctx.fetch; delete ctx.location; }
}

function assertSourceError(result) {
  assert.equal(result?.url, undefined);
  assert.equal(typeof result?.error, 'string');
  assert.match(result.error, /[\u4e00-\u9fff]/);
}

test('Pinterest SPA navigation retrieves only the canonical same-origin Pin HTML and binds the clicked cover', async () => {
  const input = asyncPage();
  let requests = 0;
  const result = await readAsync(input, async (url, options) => {
    requests++;
    assert.equal(String(url), pinUrl);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return htmlResponse();
  });
  assert.equal(requests, 1);
  assert.equal(result.url, source);
  assert.equal(result.name, 'Video title');
  assert.equal(result.pageUrl, pinUrl);
});

test('Pinterest async resolution uses existing matching Relay records without a network request', async () => {
  const result = await readAsync(asyncPage({ scripts: [livePin()] }), () => {
    assert.fail('A current matching Pin record must not trigger a fetch');
  });
  assert.equal(result.url, source);
});

test('Pinterest async resolution cannot fetch around an explicit restriction or mismatched target', async t => {
  const cases = [
    ['download restriction', { scripts: [relay({ images_orig: { url: liveCover }, isEligibleForVideoDownload: false })] }],
    ['video restriction', { scripts: [relay({ images_orig: { url: liveCover }, videos: { downloadable: false } })] }],
    ['protected source', { scripts: [relay({ images_orig: { url: liveCover }, videos: { isProtected: true } })] }],
    ['mismatched current cover', { scripts: [relay()] }],
    ['unrelated active media', { video: { currentSrc: hls.replace(key, other) }, scripts: [livePin()] }],
    ['unrelated owner', { nodes: [{ getAttribute: name => name === 'data-pin-id' ? otherId : null }] }],
    ['missing stable video identity', { video: { poster: '' } }],
    ['DRM player', { video: { mediaKeys: {} } }]
  ];
  for (const [name, options] of cases) await t.test(name, async () => {
    let requests = 0;
    const result = await readAsync(asyncPage(options), () => { requests++; return htmlResponse(); });
    assert.equal(requests, 0);
    assert.equal(result?.url, undefined);
  });
});

test('Pinterest fetched HTML must contain the same Pin and the same clicked cover', async t => {
  const cases = [
    ['another Pin', htmlFor(relay({ entityId: otherId, images_orig: { url: liveCover } }))],
    ['another request ID', htmlFor(relay({ images_orig: { url: liveCover } }, { requestId: otherId }))],
    ['another cover', htmlFor(relay())],
    ['login HTML', '<html><title>Log in</title></html>'],
    ['download disabled', htmlFor(relay({ images_orig: { url: liveCover }, videos: { downloadable: false } }))],
    ['executable script suffix', htmlFor({ textContent: livePin().textContent + '\nthrow new Error("not data");' })]
  ];
  for (const [name, html] of cases) await t.test(name, async () => {
    assertSourceError(await readAsync(asyncPage(), async () => htmlResponse(html)));
  });
});

test('Pinterest async source lookup rejects redirects, invalid responses, and network failures', async t => {
  const cases = [
    ['redirected response', async () => htmlResponse(undefined, { redirected: true })],
    ['cross-origin response', async () => htmlResponse(undefined, { url: pinUrl.replace('ca.', 'www.') })],
    ['another Pin response', async () => htmlResponse(undefined, { url: pinUrl.replace(pinId, otherId) })],
    ['partial response', async () => htmlResponse(undefined, { status: 206 })],
    ['HTTP failure', async () => htmlResponse(undefined, { status: 403 })],
    ['JSON response', async () => htmlResponse(undefined, { contentType: 'application/json' })],
    ['declared oversized response', async () => htmlResponse(undefined, { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } })],
    ['network failure', async () => { throw new TypeError('Failed to fetch'); }]
  ];
  for (const [name, fetchImpl] of cases) await t.test(name, async () => {
    assertSourceError(await readAsync(asyncPage(), fetchImpl));
  });
});

test('Pinterest source lookup bounds the received HTML stream and cancels oversized bodies', async () => {
  let cancelled = false;
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      sent++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  const result = await readAsync(asyncPage(), async () => htmlResponse(body));
  assertSourceError(result);
  assert.ok(sent <= 9, `Read ${sent} MiB before enforcing the 8 MiB limit`);
  assert.equal(cancelled, true);
});

test('Pinterest ignores a source response after the selected video or page has changed', async t => {
  const cases = [
    ['disconnected element', input => { input.video.isConnected = false; }],
    ['changed current source', input => { input.video.currentSrc = 'blob:https://ca.pinterest.com/replaced'; }],
    ['changed cover', input => { input.video.poster = poster; }],
    ['new protected state', input => { input.video.mediaKeys = {}; }],
    ['page navigation', input => { input.document.defaultView.location.href = pinUrl.replace(pinId, otherId); }]
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const input = asyncPage();
    const result = await readAsync(input, async () => { mutate(input); return htmlResponse(); });
    assertSourceError(result);
  });
});

test('Pinterest aborts a stalled source request after eight seconds', async () => {
  let timeout, cleared = false, signal;
  const originalSetTimeout = ctx.setTimeout;
  const originalClearTimeout = ctx.clearTimeout;
  ctx.setTimeout = (callback, delay) => { assert.equal(delay, 8000); timeout = callback; return 7; };
  ctx.clearTimeout = id => { assert.equal(id, 7); cleared = true; };
  try {
    const resultPromise = readAsync(asyncPage(), async (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason || new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    assert.equal(typeof timeout, 'function');
    timeout();
    assertSourceError(await resultPromise);
    assert.equal(signal.aborted, true);
    assert.equal(cleared, true);
  } finally {
    ctx.setTimeout = originalSetTimeout;
    ctx.clearTimeout = originalClearTimeout;
  }
});
