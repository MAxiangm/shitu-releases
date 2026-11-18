'use strict';
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg', 'avif']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'qt', 'webm', 'ogv', 'ogg', 'mkv', 'avi', 'wmv', 'asf',
  'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'mts', 'm2ts', 'ts', 'm2t', 'vob', 'flv', 'f4v', 'mxf',
  '3gp', '3g2', 'divx', 'dxv', 'rm', 'rmvb', 'dv']);
// Ogg is a container: keep legacy video support and identify audio-only Ogg
// during import instead of reclassifying existing video assets by extension.
const AUDIO = new Set(['mp3', 'mp2', 'wav', 'wave', 'flac', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus',
  'aif', 'aiff', 'aifc', 'ape', 'wma', 'alac', 'amr', 'ac3', 'eac3', 'dts', 'mka', 'au', 'snd',
  'wv', 'tta', 'dsf', 'dff', 'caf', 'w64']);
const MODEL_NATIVE = new Set(['blend', 'c4d', 'max']);
const MODEL = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', ...MODEL_NATIVE]);
const PROJECT = new Set(['aep', 'aepx']);
const FONT = new Set(['ttf', 'otf', 'woff', 'woff2', 'ttc', 'otc']);
const SUPPORTED = new Set([...IMAGE, ...VIDEO, ...AUDIO, ...MODEL, ...PROJECT, ...FONT]);
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime',
  webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', divx: 'video/x-msvideo', wmv: 'video/x-ms-wmv', asf: 'video/x-ms-asf',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', mpe: 'video/mpeg', m1v: 'video/mpeg', m2v: 'video/mpeg',
  mts: 'video/mp2t', m2ts: 'video/mp2t', ts: 'video/mp2t', m2t: 'video/mp2t', vob: 'video/mpeg',
  flv: 'video/x-flv', f4v: 'video/mp4', mxf: 'application/mxf', '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2', dxv: 'video/quicktime', rm: 'application/vnd.rn-realmedia',
  rmvb: 'application/vnd.rn-realmedia-vbr', dv: 'video/dv',
  mp3: 'audio/mpeg', mp2: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', flac: 'audio/flac',
  m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', oga: 'audio/ogg', opus: 'audio/ogg',
  aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff', ape: 'audio/x-ape', wma: 'audio/x-ms-wma',
  alac: 'audio/mp4', amr: 'audio/amr', ac3: 'audio/ac3', eac3: 'audio/eac3', dts: 'audio/vnd.dts',
  mka: 'audio/x-matroska', au: 'audio/basic', snd: 'audio/basic', wv: 'audio/wavpack', tta: 'audio/x-tta',
  dsf: 'audio/x-dsf', dff: 'audio/x-dff', caf: 'audio/x-caf', w64: 'audio/wav',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain',
  fbx: 'application/octet-stream', stl: 'model/stl', ply: 'application/octet-stream',
  blend: 'application/octet-stream', c4d: 'application/octet-stream', max: 'application/octet-stream',
  mtl: 'text/plain', bin: 'application/octet-stream', ktx2: 'image/ktx2',
  dds: 'image/vnd-ms.dds', tga: 'image/x-tga', aep: 'application/octet-stream', aepx: 'application/xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  ttc: 'font/collection', otc: 'font/collection'
};
module.exports = { IMAGE, VIDEO, AUDIO, MODEL, MODEL_NATIVE, PROJECT, FONT, SUPPORTED, MIME };
