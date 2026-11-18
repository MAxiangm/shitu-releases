'use strict';

// Verify the saved original, rather than a poster, first frame, or preview proxy.
// Usage: node scripts/verify-captured-video.cjs <video-file> [--report <report.json>]
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { verifyVideoRuntime } = require('./prepare-video-runtime.cjs');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'video-runtime');
const containers = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,ogg,mpeg,mpegts,flv';

async function digest(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function run(name, args, timeout = 10 * 60 * 1000) {
  const filename = path.join(runtime, name + (process.platform === 'win32' ? '.exe' : ''));
  return new Promise((resolve, reject) => {
    const child = spawn(filename, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let outputBytes = 0, errorBytes = 0, failure;
    const timer = setTimeout(() => {
      failure = new Error(`${name} did not finish within ${timeout / 1000} seconds.`);
      child.kill();
    }, timeout);
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes <= 4 * 1024 * 1024) stdout.push(chunk);
      else { failure = new Error(`${name} produced too much diagnostic output.`); child.kill(); }
    });
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length;
      if (errorBytes <= 128 * 1024) stderr.push(chunk);
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      if (failure || code !== 0) {
        reject(failure || new Error(`${name} failed (${code ?? signal}): ${errorText}`));
      } else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: errorText, exitCode: code });
    });
  });
}

async function verifyCapturedVideo(input) {
  const file = path.resolve(input);
  const initial = await fs.stat(file);
  if (!initial.isFile() || !initial.size) throw new Error('The saved video must be a non-empty local file.');
  await verifyVideoRuntime(runtime);
  const sha256 = await digest(file);
  const options = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', containers];
  const inspected = await run('ffprobe', ['-v', 'error', ...options, '-show_streams', '-show_format', '-of', 'json', file], 30000);
  const metadata = JSON.parse(inspected.stdout);
  const picture = metadata.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!picture || !(picture.width > 0 && picture.height > 0)) throw new Error('The saved file has no decodable video stream.');
  const audio = metadata.streams.filter(stream => stream.codec_type === 'audio');
  const started = Date.now();
  const decoded = await run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-xerror',
    '-err_detect', 'explode', '-threads', '2', ...options, '-i', file,
    '-map', `0:${picture.index}`, '-map', '0:a?', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-']);
  const progress = Object.fromEntries(decoded.stdout.trim().split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const equals = line.indexOf('='); return [line.slice(0, equals), line.slice(equals + 1).trim()];
  }));
  const final = await fs.stat(file);
  const unchanged = initial.size === final.size && initial.mtimeMs === final.mtimeMs && sha256 === await digest(file);
  const frames = Number(progress.frame);
  const decodedSeconds = Number(progress.out_time_us) / 1e6;
  const durationSeconds = Number(metadata.format?.duration) || Number(picture.duration) || null;
  const durationCovered = durationSeconds === null ? null : decodedSeconds >= durationSeconds - Math.max(1, durationSeconds * 0.01);
  const fullDecode = decoded.exitCode === 0 && progress.progress === 'end' && frames > 0 && durationCovered !== false;
  const report = {
    ok: Boolean(unchanged && fullDecode), checkedAt: new Date().toISOString(), file,
    bytes: initial.size, sha256, sourceUnchanged: unchanged,
    format: metadata.format?.format_name, durationSeconds,
    video: { codec: picture.codec_name, width: picture.width, height: picture.height, frameRate: picture.avg_frame_rate },
    audio: audio.map(stream => ({ codec: stream.codec_name, channels: stream.channels, sampleRate: Number(stream.sample_rate) })),
    decode: { complete: fullDecode, sampled: false, exitCode: decoded.exitCode,
      videoFrames: frames, decodedSeconds, durationCovered, elapsedMs: Date.now() - started }
  };
  return report;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (![1, 3].includes(args.length) || args.length === 3 && args[1] !== '--report') {
      throw new Error('Usage: node scripts/verify-captured-video.cjs <video-file> [--report <report.json>]');
    }
    const report = await verifyCapturedVideo(args[0]);
    const json = JSON.stringify(report, null, 2) + '\n';
    if (args[2]) {
      const reportPath = path.resolve(args[2]);
      if (reportPath === path.resolve(args[0])) throw new Error('The report must not overwrite the source video.');
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, json, { flag: 'wx' });
    }
    process.stdout.write(json);
    if (!report.ok) process.exitCode = 1;
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { verifyCapturedVideo };
