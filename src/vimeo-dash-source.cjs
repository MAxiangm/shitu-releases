'use strict';

const { stageVimeoTrack, vimeoPlaybackUrl } = require('./vimeo-playback-source.cjs');

const MANIFEST_LIMIT = 512 * 1024;
const SEGMENT_LIMIT = 4096;
const XML_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

function invalid() { return new Error('Vimeo DASH 清单不完整，或使用了暂不支持的分段方式。'); }

function xmlValue(text) {
  return text.replace(/&([a-z]+);|&/gi, (_, entity) => {
    if (!Object.hasOwn(XML_ENTITIES, entity || '')) throw invalid();
    return XML_ENTITIES[entity];
  });
}

// Read the XML subset used by finite MPDs. No DTD, processing instructions,
// external references or namespaces that require resolution are evaluated.
function parseMpd(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MANIFEST_LIMIT) throw invalid();
  let xml;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid(); }
  xml = xml.trim().replace(/^<\?xml\s+[^<>?]*\?>\s*/, '');
  const root = { children: [], text: '' };
  const stack = [root];
  const token = /<!--[^]*?-->|<\/(\w[\w:.\-]*)\s*>|<(\w[\w:.\-]*)((?:\s+[\w:.\-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)/gy;
  let position = 0;
  let count = 0;
  while (position < xml.length) {
    const part = token.exec(xml);
    if (!part || ++count > 16000) throw invalid();
    position = token.lastIndex;
    const [, close, name, attributes, selfClosing, value] = part;
    const parent = stack.at(-1);
    if (close) {
      if (parent.qualified !== close) throw invalid();
      stack.pop();
    } else if (name) {
      if (stack.length > 18) throw invalid();
      const local = name.split(':').at(-1);
      if (local === 'ContentProtection') throw new Error('该 Vimeo 播放流包含加密内容。');
      if (['SegmentBase', 'SegmentList', 'Location', 'PatchLocation'].includes(local)) throw invalid();
      const attrs = Object.create(null);
      for (const [, key, double, single] of attributes.matchAll(/([\w:.\-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g)) {
        if (Object.hasOwn(attrs, key) || /(?:^|:)href$|^xml:base$/i.test(key)) throw invalid();
        attrs[key] = xmlValue(double ?? single);
      }
      const node = { qualified: name, name: local, attrs, children: [], text: '' };
      parent.children.push(node);
      if (!selfClosing) stack.push(node);
    } else if (value?.trim()) {
      // The only XML text used as an address is BaseURL. Other text is inert.
      if (parent === root) throw invalid();
      if (parent.name === 'BaseURL') parent.text += xmlValue(value);
    }
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.children[0].name !== 'MPD') throw invalid();
  return root.children[0];
}

function children(node, name) { return node.children.filter(child => child.name === name); }
function one(node, name) {
  const matches = children(node, name);
  if (matches.length > 1) throw invalid();
  return matches[0];
}

function seconds(value) {
  if (value === undefined) return undefined;
  const match = /^PT(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  const time = match && (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
  if (!Number.isFinite(time) || time > 86400) throw invalid();
  return time;
}

function integer(value, minimum = 0) {
  const number = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) throw invalid();
  return number;
}

function templateUrl(template, fields, base) {
  if (!template) throw invalid();
  const address = template.replace(/\$([^$]*)\$|\$/g, (_, token) => {
    if (token === '') return '$';
    const match = /^(RepresentationID|Bandwidth|Number|Time)(?:%0([1-9]|1\d)d)?$/.exec(token || '');
    const field = match && fields[match[1]];
    if (field === undefined || field === null || !/^[\w.-]+$/.test(field) || (match[2] && !/^\d+$/.test(field))) throw invalid();
    return String(field).padStart(Number(match[2] || 0), '0');
  });
  return vimeoPlaybackUrl(address, base);
}

function plannedTrack(nodes, base, total, budget) {
  const attrs = Object.create(null);
  let timeline;
  for (const node of nodes) {
    const address = one(node, 'BaseURL');
    if (address) {
      if (address.children.length) throw invalid();
      base = vimeoPlaybackUrl(address.text.trim(), base);
    }
    const definition = one(node, 'SegmentTemplate');
    if (definition) {
      Object.assign(attrs, definition.attrs);
      timeline = one(definition, 'SegmentTimeline') ?? timeline;
    }
  }
  const representation = nodes.at(-1).attrs;
  const timescale = integer(attrs.timescale ?? '1', 1);
  const mediaSequence = integer(attrs.startNumber ?? '1');
  if (integer(attrs.presentationTimeOffset ?? '0') !== 0) throw invalid();
  const end = total * timescale;
  if (!Number.isFinite(end) || end > Number.MAX_SAFE_INTEGER) throw invalid();
  const fixedFields = { RepresentationID: representation.id, Bandwidth: representation.bandwidth };
  const init = { url: templateUrl(attrs.initialization, fixedFields, base) };
  const segments = [];
  let cursor = 0;
  function append(length, repeats) {
    if (!Number.isSafeInteger(repeats) || repeats < 1 || segments.length + repeats > budget) throw invalid();
    for (let index = 0; index < repeats; index++) {
      const duration = length / timescale;
      const number = mediaSequence + segments.length;
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(cursor + length) || duration < 0.000001) throw invalid();
      const url = templateUrl(attrs.media, { ...fixedFields, Number: number, Time: cursor }, base);
      segments.push({ url, duration, init });
      cursor += length;
    }
  }
  if (timeline) {
    if (attrs.duration !== undefined) throw invalid();
    const entries = children(timeline, 'S');
    if (entries.length !== timeline.children.length) throw invalid();
    for (const [index, entry] of entries.entries()) {
      const start = entry.attrs.t === undefined ? cursor : integer(entry.attrs.t);
      const length = integer(entry.attrs.d, 1);
      const repeat = integer(entry.attrs.r ?? '0', -1);
      if (start !== cursor) throw invalid();
      const next = entries[index + 1];
      const count = repeat < 0 ? (next ? (integer(next.attrs.t) - cursor) / length : Math.ceil((end - cursor) / length)) : repeat + 1;
      append(length, count);
    }
  } else {
    const length = integer(attrs.duration, 1);
    append(length, Math.ceil(end / length));
  }
  if (!segments.length || cursor / timescale < total - 0.25 || (cursor - segments.at(-1).duration * timescale) / timescale >= total) throw invalid();
  return { segments, mediaSequence };
}

function selectTracks(period) {
  const video = [];
  const audio = [];
  let containsAudio = false;
  for (const adaptation of children(period, 'AdaptationSet')) {
    const main = children(adaptation, 'Role').some(role => role.attrs.value === 'main');
    for (const representation of children(adaptation, 'Representation')) {
      const mime = representation.attrs.mimeType || adaptation.attrs.mimeType || '';
      const kind = representation.attrs.contentType || adaptation.attrs.contentType || mime.split('/')[0];
      if (kind === 'audio') containsAudio = true;
      if (mime !== `${kind}/mp4` || (kind !== 'audio' && kind !== 'video')) continue;
      const bandwidth = integer(representation.attrs.bandwidth ?? '0');
      const height = integer(representation.attrs.height || adaptation.attrs.height || '0');
      (kind === 'video' ? video : audio).push({ adaptation, representation, height, bandwidth, main });
    }
  }
  const bestVideo = video.sort((left, right) => right.height - left.height || right.bandwidth - left.bandwidth)[0];
  const bestAudio = audio.sort((left, right) => Number(right.main) - Number(left.main) || right.bandwidth - left.bandwidth)[0];
  if (!bestVideo || (containsAudio && !bestAudio)) throw invalid();
  return { bestVideo, bestAudio };
}

async function stageVimeoDash({ url, directory, read, signal }) {
  signal?.throwIfAborted();
  const address = vimeoPlaybackUrl(url);
  const response = await read(address, { limit: MANIFEST_LIMIT });
  const mpd = parseMpd(Buffer.isBuffer(response) ? response : response?.body);
  const base = response?.url ? vimeoPlaybackUrl(response.url) : address;
  if (mpd.attrs.type !== undefined && mpd.attrs.type !== 'static') throw new Error('只支持完整的 Vimeo DASH 点播视频。');
  const period = one(mpd, 'Period');
  if (!period || (seconds(period.attrs.start) ?? 0) !== 0) throw invalid();
  const duration = seconds(period.attrs.duration) ?? seconds(mpd.attrs.mediaPresentationDuration);
  if (!(duration > 0)) throw invalid();
  const { bestVideo, bestAudio } = selectTracks(period);
  const plan = (selected, budget) => plannedTrack([mpd, period, selected.adaptation, selected.representation], base, duration, budget);
  const video = plan(bestVideo, SEGMENT_LIMIT);
  const audio = bestAudio && plan(bestAudio, SEGMENT_LIMIT - video.segments.length);
  const input = await stageVimeoTrack(video, 'dash-video', directory, read, signal);
  const audioPath = audio && await stageVimeoTrack(audio, 'dash-audio', directory, read, signal);
  return { input, ...(audioPath ? { audio: audioPath } : {}), duration, expectsAudio: Boolean(audioPath) };
}

module.exports = { stageVimeoDash };
