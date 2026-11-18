'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { mediaResponse } = require('./media-response.cjs');

function token(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('音乐预览请求标识无效');
  return value;
}
async function signature(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('音乐文件不可读取');
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
function createAudioPreviewService({ engine, getLibrary, onChanged = () => {} }) {
  const requests = new Map();
  const leases = new Map();
  function currentAsset(library, id, root) {
    if (!library || library !== getLibrary() || library.root !== root) throw new Error('素材库已切换，请重新选择音乐');
    const asset = library.snapshot().assets.find(item => item.id === id);
    if (!asset || asset.trashedAt || asset.mediaType !== 'audio') throw new Error('请选择有效的音乐素材');
    return asset;
  }
  function cancel(requestToken) {
    token(requestToken);
    let cancelled = false;
    const request = requests.get(requestToken);
    if (request) { request.controller.abort(); cancelled = true; }
    for (const [key, lease] of leases) if (lease.requestToken === requestToken) {
      leases.delete(key); cancelled = true;
    }
    return cancelled;
  }
  function invalidate() {
    for (const request of requests.values()) request.controller.abort();
    leases.clear();
  }
  async function prepare(id, expectedRoot, requestToken) {
    token(requestToken);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('音乐素材标识无效');
    const library = getLibrary();
    const asset = currentAsset(library, id, expectedRoot);
    const existing = requests.get(requestToken);
    if (existing) {
      if (existing.id !== id || existing.library !== library) throw new Error('音乐预览请求标识已被使用');
      return existing.promise;
    }
    // Only the selected music viewer owns playback. A late old request cannot
    // publish a new URL or cancel the newly selected track.
    invalidate();
    const controller = new AbortController();
    const request = { id, library, controller, promise: null };
    requests.set(requestToken, request);
    request.promise = (async () => {
      const source = library.getAssetPath(id, 'original');
      if (!source) throw new Error('音乐原文件不存在');
      const sourceSignature = await signature(source);
      controller.signal.throwIfAborted();
      const prepared = await engine.preview(source, { key: asset.hash, signal: controller.signal, metadata: asset });
      controller.signal.throwIfAborted();
      const latest = currentAsset(library, id, expectedRoot);
      if (latest.hash !== asset.hash || library.getAssetPath(id, 'original') !== source ||
          await signature(source) !== sourceSignature) throw new Error('音乐文件已变化，请重新打开预览');
      if (!prepared || typeof prepared.path !== 'string' || !/^audio\/[a-zA-Z0-9.+-]+$/.test(prepared.mimeType || '')) {
        throw new Error('音乐预览结果无效');
      }
      const metadataKeys = ['duration', 'codec', 'audioCodec', 'sampleRate', 'channels', 'bitrate', 'bitsPerSample', 'audio'];
      if (typeof library.setAudioMetadata === 'function' && metadataKeys.some(key =>
          prepared[key] !== undefined && JSON.stringify(prepared[key]) !== JSON.stringify(latest[key]))) {
        await library.setAudioMetadata(id, asset.hash, { ...prepared, mediaType: 'audio' });
        controller.signal.throwIfAborted();
        currentAsset(library, id, expectedRoot);
        try { onChanged(library); } catch {}
      }
      const previewSignature = await signature(prepared.path);
      controller.signal.throwIfAborted();
      const key = crypto.randomBytes(24).toString('hex');
      leases.set(key, { id, root: expectedRoot, library, requestToken, source, sourceSignature,
        hash: asset.hash, path: prepared.path, previewSignature, mimeType: prepared.mimeType });
      return { url: `shitu://audio/${encodeURIComponent(id)}?key=${key}`,
        duration: prepared.duration, codec: prepared.codec || prepared.audioCodec,
        audioCodec: prepared.audioCodec || prepared.codec, sampleRate: prepared.sampleRate,
        channels: prepared.channels, bitrate: prepared.bitrate, bitsPerSample: prepared.bitsPerSample,
        audio: prepared.audio, mimeType: prepared.mimeType, direct: prepared.direct === true,
        transcoded: prepared.transcoded === true, cached: prepared.cached === true };
    })().finally(() => { if (requests.get(requestToken) === request) requests.delete(requestToken); });
    return request.promise;
  }
  async function response(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'shitu:' || url.hostname !== 'audio') return new Response(null, { status: 404 });
      const key = url.searchParams.get('key');
      const lease = leases.get(key);
      if (!lease || decodeURIComponent(url.pathname.slice(1)) !== lease.id) return new Response(null, { status: 404 });
      const asset = currentAsset(lease.library, lease.id, lease.root);
      if (asset.hash !== lease.hash || lease.library.getAssetPath(lease.id, 'original') !== lease.source ||
          await signature(lease.source) !== lease.sourceSignature || await signature(lease.path) !== lease.previewSignature) {
        leases.delete(key);
        return new Response(null, { status: 404 });
      }
      const result = await mediaResponse(lease.path, request);
      result.headers.set('Content-Type', lease.mimeType);
      result.headers.set('Cache-Control', 'no-store');
      result.headers.set('Access-Control-Allow-Origin', '*');
      if (request.method === 'HEAD') {
        await result.body?.cancel();
        return new Response(null, { status: result.status, headers: result.headers });
      }
      return result;
    } catch { return new Response(null, { status: 404 }); }
  }
  return { prepare, cancel, invalidate, response };
}

module.exports = { createAudioPreviewService };
