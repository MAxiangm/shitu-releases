'use strict';

// Consume a freshly observed browser gesture and independently verify the
// persisted original. This script never manufactures gesture/site evidence.
// Usage: node scripts/verify-web-video.cjs --evidence case.json --report result.json
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { verifyCapturedVideo } = require('./verify-captured-video.cjs');

const SITE_NAMES = new Map([
  ['youtube', 'YouTube'], ['vimeo', 'Vimeo'], ['pinterest', 'Pinterest'],
  ['instagram', 'Instagram'], ['x', 'X'], ['twitter', 'X']
]);

async function createVerificationServer({ directory, port = 38475, output = console.log } = {}) {
  // This sink exercises the real collector and current source without opening
  // Electron or modifying an installed application or the user's library.
  const { Library } = require('../src/library.cjs');
  const { createCollector } = require('../src/collector.cjs');
  const { createVideoEngine } = require('../src/video-engine.cjs');
  const { downloadYouTube, downloadSiteVideo } = require('../src/youtube-download.cjs');
  const projectRoot = path.resolve(__dirname, '..');
  const parent = path.join(projectRoot, '.recovery', 'tests');
  await fs.mkdir(parent, { recursive: true });
  const base = directory ? path.resolve(directory) : await fs.mkdtemp(path.join(parent, 'capture-live-'));
  await fs.mkdir(base, { recursive: true });
  const libraryRoot = path.join(base, 'library');
  const library = new Library({ root: libraryRoot });
  await library.init();
  const engine = createVideoEngine({ runtimeDir: path.join(projectRoot, 'video-runtime'), cacheDir: path.join(base, 'video-cache') });
  const captures = [];
  const reportPath = path.join(base, 'captures.json');
  let closing = false, queue = Promise.resolve(), writes = Promise.resolve();
  const decodeChildren = new Set();
  const writeReport = () => (writes = writes.then(() => fs.writeFile(reportPath, JSON.stringify({ libraryRoot, captures }, null, 2) + '\n')));
  const stopChild = child => {
    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill());
      killer.once('close', code => { if (code !== 0) child.kill(); });
    } else child.kill();
  };
  const decodeOriginal = file => new Promise((resolve, reject) => {
    if (closing) { reject(new Error('Verification server is shutting down.')); return; }
    const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'verify-captured-video.cjs'), file],
      { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    decodeChildren.add(child);
    let stdout = '', stderr = '', failure;
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    const timer = setTimeout(() => { failure = new Error('Full video verification timed out.'); stopChild(child); }, 11 * 60 * 1000);
    child.stdout.on('data', chunk => {
      stdout += outDecoder.write(chunk);
      if (stdout.length > 4 * 1024 * 1024) { failure = new Error('Video verification returned excessive output.'); stopChild(child); }
    });
    child.stdout.on('end', () => { stdout += outDecoder.end(); });
    child.stderr.on('data', chunk => { stderr = (stderr + errDecoder.write(chunk)).slice(-8000); });
    child.stderr.on('end', () => { stderr = (stderr + errDecoder.end()).slice(-8000); });
    child.once('error', error => { clearTimeout(timer); decodeChildren.delete(child); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); decodeChildren.delete(child);
      if (failure || code !== 0) { reject(failure || new Error(stderr.trim() || `Video verification exited with ${code}.`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Video verification returned invalid JSON.')); }
    });
  });
  const collector = createCollector({ library, port, configPath: path.join(base, 'collector.json'),
    appVersion: require('../package.json').version, muxVimeoPlayback: engine.muxVimeoPlayback,
    probeVideo: (file, options) => engine.probe(file, options),
    downloadYouTube: options => downloadYouTube({ ...options, ffmpegPath: path.join(projectRoot, 'video-runtime', 'ffmpeg.exe') }),
    ...(typeof downloadSiteVideo === 'function' ? {
      downloadSiteVideo: options => downloadSiteVideo({ ...options, ffmpegPath: path.join(projectRoot, 'video-runtime', 'ffmpeg.exe') })
    } : {}),
    onImported: async result => {
      const snapshot = library.snapshot();
      const ids = new Set(result.assetIds?.length ? result.assetIds : result.existingAssets?.map(asset => asset.id));
      const assets = snapshot.assets.filter(asset => ids.has(asset.id)).map(asset => ({
        id: asset.id, file: library.getAssetPath(asset.id, 'original'), bytes: asset.size, sha256: asset.hash,
        // Do not write ephemeral signed CDN URLs into human-readable reports.
        pageUrl: asset.pageUrl, name: asset.name
      }));
      const capture = { at: new Date().toISOString(), receipt: result, assets,
        status: 'downloaded_unverified', browserGestureVerified: false };
      captures.push(capture);
      await writeReport();
      output(JSON.stringify({ event: 'saved', libraryRoot, reportPath, at: capture.at,
        imported: result.imported, duplicates: result.duplicates, assetIds: assets.map(asset => asset.id) }));
      queue = queue.then(async () => {
        if (closing) return;
        for (const asset of assets) {
          if (closing) break;
          try {
            asset.decoded = await decodeOriginal(asset.file);
            asset.decodeReport = path.join(base, `decoded-${asset.id}.json`);
            await fs.writeFile(asset.decodeReport, JSON.stringify(asset.decoded, null, 2) + '\n');
            output(JSON.stringify({ event: 'decoded', assetId: asset.id, ok: asset.decoded.ok,
              durationSeconds: asset.decoded.durationSeconds, audioStreams: asset.decoded.audio?.length,
              report: asset.decodeReport }));
          } catch (error) {
            asset.decodeError = String(error.message || error).slice(0, 2000);
            output(JSON.stringify({ event: 'decode-failed', assetId: asset.id, error: asset.decodeError }));
          }
        }
        capture.status = assets.length && assets.every(asset => asset.decoded?.ok) ? 'decoded_unverified_gesture' : 'decode_failed';
        await writeReport();
      }).catch(error => output(JSON.stringify({ event: 'verification-error', error: error.message })));
    }
  });
  await collector.start();
  await fs.writeFile(reportPath, JSON.stringify({ libraryRoot, captures }, null, 2) + '\n');
  const session = { startedAt: new Date().toISOString(), base, libraryRoot, reportPath, baseUrl: collector.info().baseUrl };
  await fs.writeFile(path.join(base, 'session.json'), JSON.stringify(session, null, 2) + '\n');
  output(JSON.stringify({ event: 'ready', ...session }));
  return { ...session, collector, library, async close() {
    closing = true;
    await collector.close();
    for (const child of decodeChildren) stopChild(child);
    await queue;
    await writes;
    await engine.shutdown();
  } };
}

function videoIdentity(value, site) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const name = SITE_NAMES.get(String(site).toLowerCase());
  const host = url.hostname, pathname = url.pathname;
  let id;
  if (name === 'YouTube') {
    if (host === 'youtu.be') id = /^\/([\w-]{11})\/?$/.exec(pathname)?.[1];
    else if (/^(?:(?:www|m|music)\.)?youtube\.com$/.test(host)) {
      if (pathname === '/watch' && url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
      else id = /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(pathname)?.[1];
    } else if (/^(?:www\.)?youtube-nocookie\.com$/.test(host)) id = /^\/embed\/([\w-]{11})\/?$/.exec(pathname)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) return null;
  } else if (name === 'Vimeo') {
    if (host === 'player.vimeo.com') id = /^\/video\/(\d+)\/?$/.exec(pathname)?.[1];
    else if (/^(?:www\.)?vimeo\.com$/.test(host)) id = /^(?:\/(?:channels\/[^/]+|groups\/[^/]+\/videos))?\/(\d+)(?:\/[a-z0-9]+)?\/?$/i.exec(pathname)?.[1];
  } else if (name === 'Pinterest' && /^(?:[a-z0-9-]+\.)?pinterest\.com$/.test(host)) {
    id = /^\/pin\/(\d+)\/?$/.exec(pathname)?.[1];
  } else if (name === 'Instagram' && /^(?:www\.)?instagram\.com$/.test(host)) {
    id = /^\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]+)(?:\/embed(?:\/captioned)?)?\/?$/.exec(pathname)?.[1];
  } else if (name === 'X' && /^(?:(?:www|platform)\.)?(?:x|twitter)\.com$/.test(host)) {
    id = /^\/(?:[\w]+\/status|i\/(?:web\/)?status)\/(\d+)\/?$/.exec(pathname)?.[1];
  }
  return id ? `${name}:${id}` : null;
}

function safeChild(root, filename) {
  if (typeof filename !== 'string' || !filename || path.isAbsolute(filename)) throw new Error('Invalid managed video path.');
  const resolved = path.resolve(root, filename), relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Managed video path leaves the library.');
  return resolved;
}

async function verifyWebVideo(evidence, { verify = verifyCapturedVideo, now = Date.now(), maximumAgeMs = 2 * 60 * 60 * 1000 } = {}) {
  if (!evidence || typeof evidence !== 'object') throw new Error('A browser capture evidence object is required.');
  const site = SITE_NAMES.get(String(evidence.site).toLowerCase());
  const identity = videoIdentity(evidence.pageUrl, site);
  if (!site || !identity) throw new Error('The source must identify one supported public video page.');
  if (typeof evidence.libraryRoot !== 'string' || !path.isAbsolute(evidence.libraryRoot)) throw new Error('An absolute saved library path is required.');
  if (typeof evidence.assetId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(evidence.assetId)) throw new Error('A saved asset ID is required.');
  const libraryRoot = path.resolve(evidence.libraryRoot);
  const rootStat = await fs.lstat(libraryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The library must be an ordinary directory.');
  const index = JSON.parse(await fs.readFile(path.join(libraryRoot, 'index.json'), 'utf8'));
  const asset = index.assets?.find(item => item.id === evidence.assetId);
  if (!asset || asset.trashedAt) throw new Error('The confirmed asset is not present in the active library.');
  const file = safeChild(libraryRoot, asset.filename);
  const actualFile = await fs.realpath(file), actualRoot = await fs.realpath(libraryRoot);
  const relative = path.relative(actualRoot, actualFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || (await fs.lstat(file)).isSymbolicLink()) {
    throw new Error('The saved original resolves outside the library or through a file link.');
  }

  const problems = [], incomplete = [];
  const storedIdentity = videoIdentity(asset.pageUrl, site) || videoIdentity(asset.sourceUrl, site);
  if (storedIdentity !== identity) problems.push('The saved source page does not match the selected video.');
  const capturedAt = Date.parse(evidence.capturedAt);
  const fresh = Number.isFinite(capturedAt) && capturedAt <= now + 60_000 && now - capturedAt <= maximumAgeMs;
  if (!fresh) incomplete.push('Fresh capture time is missing or outside the verification window.');
  const actualGesture = evidence.gesture?.type === 'Alt+right' && evidence.gesture.trusted === true;
  if (!actualGesture) incomplete.push('No observed trusted Alt+right gesture was supplied.');
  const realSite = evidence.page?.realSite === true && evidence.page.fixture === false;
  if (!realSite) incomplete.push('This case is not identified as a real site rather than a fixture.');
  const receipt = evidence.receipt;
  const receiptAssetIds = [...(Array.isArray(receipt?.assetIds) ? receipt.assetIds : []),
    ...(Array.isArray(receipt?.existingAssets) ? receipt.existingAssets.map(item => item?.id) : []), receipt?.location?.assetId];
  const receiptConfirmed = receipt?.ok === true &&
    (Number.isSafeInteger(receipt.imported) && receipt.imported > 0 || Number.isSafeInteger(receipt.duplicates) && receipt.duplicates > 0) &&
    receiptAssetIds.includes(evidence.assetId);
  if (!receiptConfirmed) incomplete.push('No successful capture receipt identifies this saved asset.');
  const capturedDuration = evidence.source?.durationSeconds;
  const durationKnown = typeof capturedDuration === 'number' && Number.isFinite(capturedDuration) && capturedDuration > 0;
  if (!durationKnown) incomplete.push('The selected source duration was not observed.');
  const audioKnown = typeof evidence.source?.hasAudio === 'boolean';
  if (!audioKnown) incomplete.push('The selected source audio state was not observed.');

  const decoded = await verify(file);
  const hashMatches = typeof asset.hash === 'string' && asset.hash === decoded.sha256;
  if (!hashMatches) problems.push('The original file hash differs from the persisted asset.');
  if (!decoded.ok || !decoded.sourceUnchanged || !decoded.decode?.complete || decoded.decode.sampled !== false) {
    problems.push('The saved original did not pass a complete unchanged-file decode.');
  }
  let durationMatches = null;
  if (durationKnown) {
    const tolerance = Math.max(1, capturedDuration * 0.01);
    durationMatches = Number.isFinite(decoded.durationSeconds) && Math.abs(decoded.durationSeconds - capturedDuration) <= tolerance;
    if (!durationMatches) problems.push('The saved duration differs from the video selected in the browser.');
  }
  const audioPreserved = !audioKnown ? null : evidence.source.hasAudio ? decoded.audio?.length > 0 : true;
  if (audioPreserved === false) problems.push('The selected source has audio but the saved file has no audio stream.');
  return {
    ok: problems.length === 0 && incomplete.length === 0,
    status: problems.length ? 'failed' : incomplete.length ? 'incomplete' : 'passed',
    checkedAt: new Date(now).toISOString(), site, pageUrl: evidence.pageUrl, identity,
    capturedAt: evidence.capturedAt || null,
    evidence: { origin: 'operator-observed browser action', trustedAltRight: actualGesture, realSite, fresh,
      sourceDurationSeconds: durationKnown ? capturedDuration : null, sourceHasAudio: audioKnown ? evidence.source.hasAudio : null },
    asset: { id: asset.id, libraryRoot, file, storedPageUrl: asset.pageUrl || null, bytes: decoded.bytes, sha256: decoded.sha256 },
    checks: { persistedAsset: true, receiptConfirmed, sourceIdentityMatches: storedIdentity === identity, hashMatches,
      durationMatches, audioPreserved, fullDecode: decoded.decode?.complete === true && decoded.decode.sampled === false },
    problems, incomplete, decoded
  };
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] === '--serve') {
      if (args.length > 3 || args.length === 2 || args.length === 3 && args[1] !== '--port') throw new Error('Usage: node scripts/verify-web-video.cjs --serve [--port 38475]');
      const server = await createVerificationServer({ port: args[2] === undefined ? 38475 : Number(args[2]) });
      let closing = false;
      const close = async () => { if (closing) return; closing = true; await server.close(); process.exit(0); };
      process.on('SIGINT', close); process.on('SIGTERM', close);
      return;
    }
    if (args.length !== 4 || args[0] !== '--evidence' || args[2] !== '--report') throw new Error('Usage: node scripts/verify-web-video.cjs --evidence case.json --report result.json');
    const evidencePath = path.resolve(args[1]), reportPath = path.resolve(args[3]);
    if (evidencePath === reportPath) throw new Error('The report must not overwrite the capture evidence.');
    const report = await verifyWebVideo(JSON.parse(await fs.readFile(evidencePath, 'utf8')));
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, site: report.site, assetId: report.asset.id,
      checks: report.checks, problems: report.problems, incomplete: report.incomplete, report: reportPath }));
    if (!report.ok) process.exitCode = 1;
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { verifyWebVideo, videoIdentity, safeChild, createVerificationServer };
