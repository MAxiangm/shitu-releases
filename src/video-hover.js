(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituVideoHover = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  let sequence = 0;
  function previewUrl(prepared, id) {
    const url = new URL(prepared?.url);
    if (url.protocol !== 'shitu:' || url.hostname !== 'asset' || url.username || url.password || url.port ||
        url.hash || decodeURIComponent(url.pathname.slice(1)) !== id || url.searchParams.get('kind') !== 'preview' ||
        !/^[a-f0-9]{64}$/i.test(url.searchParams.get('key') || ''))
      throw new Error('Invalid video preview address');
    return url.href;
  }
  function create({ prepare, cancel, allowed = () => true, current = () => true,
    delay = 200, schedule = setTimeout, unschedule = clearTimeout,
    makeVideo = () => document.createElement('video') }) {
    let active = null;
    const attached = new Set();
    const valid = session => active === session && session.thumb.isConnected && allowed() && current(session.asset, session.root);
    function cancelPreparation(session) {
      if (!session.requested || !cancel) return;
      try { Promise.resolve(cancel(session.asset.id, session.root, session.token)).catch(() => {}); } catch {}
    }
    function releaseVideo(session) {
      if (!session.video) return;
      const video = session.video;
      session.video = null;
      video.removeEventListener('playing', session.playing);
      video.removeEventListener('error', session.error);
      try { video.pause(); } catch {}
      video.removeAttribute('src');
      try { video.load(); } catch {}
      video.remove();
    }
    function stop({ deferCancel = false } = {}) {
      const session = active;
      if (!session) return;
      active = null;
      if (session.timer !== null) unschedule(session.timer);
      releaseVideo(session);
      delete session.thumb.dataset.videoHoverState;
      // The foreground viewer queues its adoption in this turn's microtasks.
      // Give it that chance before releasing the outgoing hover lease.
      if (deferCancel && session.requested) schedule(() => cancelPreparation(session), 0);
      else cancelPreparation(session);
    }
    function fail(session) {
      if (!valid(session)) { if (active === session) stop(); return; }
      releaseVideo(session);
      session.thumb.dataset.videoHoverState = 'error';
      cancelPreparation(session);
      session.requested = false;
    }
    async function start(session) {
      session.timer = null;
      if (!valid(session)) { if (active === session) stop(); return; }
      session.thumb.dataset.videoHoverState = 'preparing';
      session.requested = true;
      try {
        const prepared = await prepare(session.asset.id, session.root, session.token);
        if (!valid(session)) { if (active === session) stop(); return; }
        const url = previewUrl(prepared, session.asset.id);
        const video = makeVideo();
        session.video = video;
        video.className = 'asset-hover-video';
        video.setAttribute('aria-hidden', 'true');
        video.tabIndex = -1;
        video.draggable = false;
        video.muted = true;
        video.defaultMuted = true;
        video.loop = true;
        video.playsInline = true;
        video.controls = false;
        video.preload = 'auto';
        session.playing = () => {
          if (valid(session)) session.thumb.dataset.videoHoverState = 'playing';
          else if (active === session) stop();
        };
        session.error = () => fail(session);
        video.addEventListener('playing', session.playing);
        video.addEventListener('error', session.error);
        session.thumb.prepend(video);
        video.src = url;
        await video.play();
        if (!valid(session) && active === session) stop();
      } catch { fail(session); }
    }
    function attach(thumb, asset, root) {
      const enter = event => {
        if (event.pointerType && event.pointerType !== 'mouse') return;
        if (!thumb.isConnected || !allowed() || !current(asset, root)) return;
        stop();
        const token = `hover_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
        const session = { thumb, asset, root, token, timer: null, video: null, requested: false };
        active = session;
        thumb.dataset.videoHoverState = 'pending';
        session.timer = schedule(() => { void start(session); }, delay);
      };
      const leave = () => { if (active?.thumb === thumb) stop(); };
      thumb.addEventListener('pointerenter', enter);
      thumb.addEventListener('pointerleave', leave);
      const detach = () => {
        leave();
        thumb.removeEventListener('pointerenter', enter);
        thumb.removeEventListener('pointerleave', leave);
        attached.delete(detach);
      };
      attached.add(detach);
      return detach;
    }
    function clear() { stop(); for (const detach of [...attached]) detach(); }
    return Object.freeze({ attach, stop, clear, destroy: clear });
  }
  return Object.freeze({ create, previewUrl });
});
