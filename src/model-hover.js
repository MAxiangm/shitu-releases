(() => {
  'use strict';

  function create({ prepare, cancel, allowed, current }) {
    let active = null;
    let sequence = 0;
    const attached = new Set();
    const valid = session => active === session && session.thumb.isConnected && allowed() && current(session.asset, session.root);

    function stop() {
      const session = active;
      if (!session) return;
      active = null;
      clearTimeout(session.timer);
      session.image?.removeAttribute('src');
      session.image?.remove();
      delete session.thumb.dataset.modelHoverState;
      if (session.requested) void cancel(session.asset.id, session.root, session.token).catch(() => {});
    }

    async function start(session) {
      if (!valid(session)) { if (active === session) stop(); return; }
      session.thumb.dataset.modelHoverState = 'preparing';
      session.requested = true;
      try {
        const prepared = await prepare(session.asset.id, session.root, session.token);
        if (!valid(session)) { if (active === session) stop(); return; }
        const url = new URL(prepared?.url);
        if (url.protocol !== 'shitu:' || url.hostname !== 'model-hover' || url.username || url.password ||
            url.port || url.search || url.hash || !/^\/[a-f0-9]{64}$/.test(url.pathname)) throw new Error('模型悬停地址无效');
        const image = document.createElement('img');
        session.image = image;
        image.className = 'asset-hover-model';
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        image.draggable = false;
        image.addEventListener('load', () => {
          if (valid(session)) session.thumb.dataset.modelHoverState = 'playing';
          else if (active === session) stop();
        }, { once: true });
        image.addEventListener('error', () => { if (active === session) stop(); }, { once: true });
        session.thumb.prepend(image);
        image.src = url.href;
      } catch { if (active === session) stop(); }
    }

    function attach(thumb, asset, root) {
      const enter = event => {
        if (event.pointerType && event.pointerType !== 'mouse') return;
        if (!thumb.isConnected || !allowed() || !current(asset, root)) return;
        stop();
        const token = `hover_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
        const session = { thumb, asset, root, token, timer: null, image: null, requested: false };
        active = session;
        session.timer = setTimeout(() => void start(session), 150);
      };
      const leave = () => { if (active?.thumb === thumb) stop(); };
      thumb.addEventListener('pointerenter', enter);
      thumb.addEventListener('pointerleave', leave);
      attached.add(() => {
        thumb.removeEventListener('pointerenter', enter);
        thumb.removeEventListener('pointerleave', leave);
      });
    }

    function clear() {
      stop();
      for (const detach of attached) detach();
      attached.clear();
    }
    return Object.freeze({ attach, stop, clear });
  }

  window.ShituModelHover = Object.freeze({ create });
})();
