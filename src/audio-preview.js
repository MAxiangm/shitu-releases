(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituAudioPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function duration(value) {
    if (!Number.isFinite(value) || value < 0) return '';
    const seconds = Math.floor(value), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function metadata(value = {}) {
    return [duration(value.duration), value.audioCodec || value.codec ? String(value.audioCodec || value.codec).toUpperCase() : '',
      Number.isFinite(value.sampleRate) && value.sampleRate > 0 ? `${Number((value.sampleRate / 1000).toFixed(1))} kHz` : '',
      Number.isFinite(value.channels) && value.channels > 0 ? value.channels === 1 ? '单声道' : value.channels === 2 ? '立体声' : `${value.channels} 声道` : '',
      Number.isFinite(value.bitrate) && value.bitrate > 0 ? `${Math.round(value.bitrate / 1000)} kbps` : ''].filter(Boolean).join(' · ');
  }
  function playbackUrl(value, id) {
    const url = new URL(value);
    if (url.protocol !== 'shitu:' || url.hostname !== 'audio' || decodeURIComponent(url.pathname.slice(1)) !== id || url.username || url.password || url.hash || !url.searchParams.get('key')) {
      throw new Error('音乐预览地址无效，请重新打开素材');
    }
    return url.href;
  }
  function adjacent(items, id, direction) {
    if (!Array.isArray(items) || !items.length || ![1, -1].includes(direction)) return null;
    const index = items.findIndex(item => item?.id === id);
    return index < 0 ? null : items[(index + direction + items.length) % items.length];
  }
  function create({ panel, audio, title, artist, album, details, status, retry, artwork, placeholder, loop,
    prepare, cancel = () => {}, assetUrl, current = () => true, onMetadata = () => {} }) {
    let session = null, serial = 0;
    function valid(value) { return session === value && current(value.asset, value.root); }
    function message(text, failed = false) {
      status.textContent = text;
      status.classList.toggle('is-error', failed);
      retry.classList.toggle('hidden', !failed);
    }
    function describe(asset, prepared = {}) {
      const tags = { ...asset.audio, ...prepared.audio };
      title.textContent = tags.title || asset.name;
      artist.textContent = tags.artist || '音乐素材';
      album.textContent = tags.album || '';
      album.classList.toggle('hidden', !tags.album);
      details.textContent = metadata({ ...asset, ...prepared });
    }
    function reset() {
      const previous = session;
      session = null;
      if (previous) Promise.resolve(cancel(previous.token)).catch(() => {});
      audio.pause(); audio.removeAttribute('src'); audio.load(); audio.classList.add('hidden');
      artwork.removeAttribute('src'); artwork.classList.add('hidden'); placeholder.classList.remove('hidden');
      panel.classList.add('hidden'); delete panel.dataset.ready; delete audio.dataset.previewToken;
      retry.classList.add('hidden');
    }
    async function show(asset, root) {
      reset();
      const item = { asset, root, token: `audio-viewer-${Date.now()}-${++serial}` };
      session = item;
      panel.classList.remove('hidden');
      describe(asset);
      message('正在准备音乐播放…');
      if (asset.thumbnail && assetUrl) {
        artwork.src = assetUrl(asset.id, 'thumbnail');
        artwork.classList.remove('hidden'); placeholder.classList.add('hidden');
      }
      try {
        const result = await prepare(asset.id, root, item.token);
        if (!valid(item)) return;
        const source = playbackUrl(result?.url, asset.id);
        item.prepared = result;
        describe(asset, result);
        audio.dataset.previewToken = item.token;
        audio.src = source; audio.classList.remove('hidden'); audio.load();
        panel.dataset.ready = 'true';
        message(result.transcoded ? '已准备兼容播放，原始音乐文件保持不变。' : '已准备播放');
        onMetadata(asset, result);
        try { await audio.play(); } catch { if (valid(item) && !audio.error) message('点击播放按钮试听'); }
      } catch (error) {
        if (!valid(item)) return;
        audio.classList.add('hidden');
        message(`音乐暂时无法预览：${String(error?.message || error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')}。可使用右上角按钮在系统播放器中打开。`, true);
      }
    }
    audio.addEventListener('error', () => {
      if (!session || audio.dataset.previewToken !== session.token || !audio.hasAttribute('src')) return;
      delete panel.dataset.ready;
      message('此音乐暂时无法播放，可重试或使用右上角按钮在系统播放器中打开。', true);
    });
    artwork.addEventListener('error', () => { artwork.classList.add('hidden'); placeholder.classList.remove('hidden'); });
    retry.addEventListener('click', () => { if (session) void show(session.asset, session.root); });
    loop?.addEventListener('change', () => { audio.loop = loop.checked; });
    return Object.freeze({ show, reset, metadata, toggle() {
      if (!session || !panel.dataset.ready) return;
      if (audio.paused) void audio.play().catch(() => message('点击播放按钮试听'));
      else audio.pause();
    } });
  }
  return Object.freeze({ create, duration, metadata, playbackUrl, adjacent });
});
