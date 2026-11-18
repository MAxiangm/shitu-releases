'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MANIFEST_LIMIT = 512 * 1024;
const INIT_LIMIT = 4 * 1024 * 1024;
const SEGMENT_LIMIT = 64 * 1024 * 1024;
const MAX_SEGMENTS = 4096;
const AUDIO_CODECS = /^(?:aac|ac-3|ac-4|ec-3|mp4a|opus|vorbis|flac|alac)(?:\.|$)/i;

function vimeoPlaybackUrl(value, base) {
  const text = value instanceof URL ? value.href : value;
  const invalid = () => new Error('Vimeo 播放源或分段的地址无效。');
  if (typeof text !== 'string' || !text || text.length > 8192 || /[\x00-\x20\x7f\\]/.test(text) || text.includes('{$')) throw invalid();
  let url;
  try { url = new URL(text, base); } catch { throw invalid(); }
  const cdn = url.hostname.endsWith('.vimeocdn.com');
  const player = url.hostname === 'player.vimeo.com' && /^\/progressive_redirect\/playback\//.test(url.pathname);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || (!cdn && !player)) throw invalid();
  return url;
}

function malformed() { return new Error('Vimeo 播放列表不完整或格式无效。'); }

function attributes(value) {
  const result = Object.create(null);
  const field = /([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^",\r\n]+))(?:,|$)/gy;
  let length = 0;
  for (const match of value.matchAll(field)) {
    if (Object.hasOwn(result, match[1])) throw malformed();
    result[match[1]] = match[2] ?? match[3];
    length += match[0].length;
  }
  if (!length || length !== value.length || value.endsWith(',')) throw malformed();
  return result;
}

async function manifest(read, url, signal) {
  signal?.throwIfAborted();
  const response = await read(url, { limit: MANIFEST_LIMIT });
  const body = Buffer.isBuffer(response) ? response : response?.body;
  if (!Buffer.isBuffer(body) || !body.length || body.length > MANIFEST_LIMIT) throw malformed();
  const base = response?.url ? vimeoPlaybackUrl(response.url) : url;
  let lines;
  try { lines = new TextDecoder('utf-8', { fatal: true }).decode(body).split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
  catch { throw malformed(); }
  if (lines[0] !== '#EXTM3U') throw malformed();
  for (const line of lines) {
    if (line.startsWith('#EXT-X-SESSION-KEY:') ||
        (line.startsWith('#EXT-X-KEY:') && line !== '#EXT-X-KEY:METHOD=NONE')) {
      throw new Error('该 Vimeo 播放流包含加密内容。');
    }
    if (/^#EXT-X-(?:GAP|SKIP|PART|PRELOAD-HINT|I-FRAMES-ONLY)(?::|$)/.test(line)) throw malformed();
  }
  return { lines, base };
}

function representativeVariant({ lines, base }) {
  const variants = [];
  const audio = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const track = attributes(line.slice(13));
      if (track.TYPE === 'AUDIO') audio.push(track);
    }
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const fields = attributes(line.slice(18));
    const address = lines[++index];
    if (!address || address.startsWith('#')) throw malformed();
    const codecs = fields.CODECS?.split(',').map(codec => codec.trim()) || [];
    const dimensions = /^(\d+)x(\d+)$/i.exec(fields.RESOLUTION);
    if (!dimensions && codecs.length && codecs.every(codec => AUDIO_CODECS.test(codec))) continue;
    const pixels = dimensions ? Number(dimensions[1]) * Number(dimensions[2]) : 0;
    const bandwidth = Number(fields['AVERAGE-BANDWIDTH'] || fields.BANDWIDTH);
    if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bandwidth) || bandwidth <= 0) throw malformed();
    variants.push({ address, fields, pixels, bandwidth, codecs });
  }
  const best = variants.sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth)[0];
  if (!best) throw malformed();
  const group = best.fields.AUDIO;
  const matchingAudio = audio.filter(track => track['GROUP-ID'] === group);
  const selected = group && (matchingAudio.find(track => track.DEFAULT === 'YES') || matchingAudio.find(track => track.AUTOSELECT === 'YES') || matchingAudio[0]);
  if (group && !selected) throw malformed();
  return { url: vimeoPlaybackUrl(best.address, base), audio: selected?.URI ? vimeoPlaybackUrl(selected.URI, base) : null,
    expectsAudio: Boolean(group || best.codecs.some(codec => AUDIO_CODECS.test(codec))) };
}

function byteRange(value, previous, url) {
  if (value === undefined) return undefined;
  const spec = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!spec) throw malformed();
  const length = Number(spec[1]);
  const start = spec[2] === undefined ? previous?.url.href === url.href && previous.range ? previous.range.end + 1 : NaN : Number(spec[2]);
  const end = start + length - 1;
  if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw malformed();
  return { start, end };
}

function mediaTrack({ lines, base }, maxSegments) {
  const segments = [];
  let init, previousMap, duration, range, discontinuity = false, ended = false;
  let mediaSequence = 0;
  for (const line of lines.slice(1)) {
    if (line === '#EXT-X-ENDLIST') { ended = true; continue; }
    if (line === '#EXT-X-DISCONTINUITY') { discontinuity = true; continue; }
    if (line.startsWith('#EXT-X-STREAM-INF:')) throw malformed();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = line.slice(22);
      mediaSequence = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(mediaSequence)) throw malformed();
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const fields = attributes(line.slice(11));
      const url = vimeoPlaybackUrl(fields.URI, base);
      init = { url, range: byteRange(fields.BYTERANGE, previousMap, url) };
      previousMap = init;
    }
    if (line.startsWith('#EXTINF:')) {
      const value = line.slice(8).split(',', 1)[0];
      if (duration !== undefined || !/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 86400) throw malformed();
      duration = value;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (range !== undefined) throw malformed();
      range = line.slice(17);
    }
    if (line.startsWith('#')) continue;
    if (ended || duration === undefined || segments.length >= maxSegments) throw malformed();
    const url = vimeoPlaybackUrl(line, base);
    segments.push({ url, duration, init, range: byteRange(range, segments.at(-1), url), discontinuity });
    duration = undefined;
    range = undefined;
    discontinuity = false;
  }
  if (!ended) throw new Error('当前 Vimeo 播放列表尚未完整发布。');
  const seconds = segments.reduce((total, segment) => total + Number(segment.duration), 0);
  if (!segments.length || seconds <= 0 || duration !== undefined || range !== undefined) throw malformed();
  return { segments, duration: seconds, mediaSequence };
}

function isoMedia(head, size, types) {
  return head.length >= 8 && types.includes(head.toString('latin1', 4, 8)) &&
    head.readUInt32BE(0) >= 8 && head.readUInt32BE(0) <= size;
}

async function segmentExtension(file, fragmented) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(576);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, bytesRead);
    if (fragmented && isoMedia(head, (await handle.stat()).size, ['styp', 'sidx', 'moof', 'emsg', 'prft', 'free', 'ftyp'])) return 'm4s';
    if (!fragmented && head.length >= 377 && head[0] === 0x47 && head[188] === 0x47 && head[376] === 0x47) return 'ts';
    if (!fragmented && head.length >= 7 && head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return 'aac';
    throw new Error('Vimeo 返回的分段不是可识别的视频或音频。');
  } finally { await handle.close(); }
}

function checkInitialization(bytes) {
  if (!isoMedia(bytes, bytes.length, ['ftyp', 'moov', 'free'])) throw new Error('Vimeo 返回的分段初始化文件无效。');
  for (const marker of ['pssh', 'tenc', 'senc', 'encv', 'enca']) {
    let at = bytes.indexOf(marker, 4, 'ascii');
    while (at !== -1) {
      const size = bytes.readUInt32BE(at - 4);
      if (size >= 8 && size <= bytes.length - at + 4) throw new Error('该 Vimeo 播放流包含加密内容。');
      at = bytes.indexOf(marker, at + 4, 'ascii');
    }
  }
}

async function stageTrack(track, name, directory, read, signal) {
  const { segments, mediaSequence } = track;
  const longest = segments.reduce((max, segment) => Math.max(max, Number(segment.duration)), 1);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(longest)}`, `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`];
  const initializations = new Map();
  let currentInit;
  for (const [index, segment] of segments.entries()) {
    signal?.throwIfAborted();
    if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (segment.init !== currentInit) {
      currentInit = segment.init;
      const { url, range } = currentInit;
      const key = JSON.stringify([url.href, range]);
      if (!initializations.has(key)) {
        const destination = `${name}-init-${initializations.size}.mp4`;
        const file = path.join(directory, destination);
        await read(url, { destination: file, limit: INIT_LIMIT, range });
        checkInitialization(await fs.readFile(file));
        initializations.set(key, destination);
      }
      lines.push(`#EXT-X-MAP:URI="${initializations.get(key)}"`);
    }
    const localName = `${name}-segment-${index}`;
    const partial = path.join(directory, `${localName}.part`);
    await read(segment.url, { destination: partial, limit: SEGMENT_LIMIT, range: segment.range });
    const extension = await segmentExtension(partial, Boolean(currentInit));
    await fs.rename(partial, path.join(directory, `${localName}.${extension}`));
    lines.push(`#EXTINF:${segment.duration},`, `${localName}.${extension}`);
  }
  const output = path.join(directory, `${name}.m3u8`);
  await fs.writeFile(output, `${lines.concat('#EXT-X-ENDLIST', '').join('\n')}`, { flag: 'wx' });
  return output;
}

async function stageVimeoHls({ url, directory, read, signal }) {
  const first = await manifest(read, vimeoPlaybackUrl(url), signal);
  const selected = first.lines.some(line => line.startsWith('#EXT-X-STREAM-INF:')) ? representativeVariant(first) : null;
  const video = mediaTrack(selected ? await manifest(read, selected.url, signal) : first, MAX_SEGMENTS);
  const audio = selected?.audio ? mediaTrack(await manifest(read, selected.audio, signal), MAX_SEGMENTS - video.segments.length) : null;
  const input = await stageTrack(video, 'playback', directory, read, signal);
  const audioPath = audio ? await stageTrack(audio, 'audio', directory, read, signal) : null;
  return { input, ...(audioPath ? { audio: audioPath } : {}), duration: Math.max(video.duration, audio?.duration || 0), expectsAudio: Boolean(selected?.expectsAudio) };
}

module.exports = { vimeoPlaybackUrl, stageVimeoHls, stageVimeoTrack: stageTrack };
