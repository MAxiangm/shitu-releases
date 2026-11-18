(() => {
  'use strict';

  function create({ viewport, allowed, prepare, cancel, delay = 1800, limit = 3 }) {
    let cards = [];
    let remaining = limit;
    let timer = null;
    let active = null;
    let sequence = 0;
    const tried = new Set();

    function pause() {
      clearTimeout(timer);
      timer = null;
      if (!active) return;
      const { asset, root, token } = active;
      active = null;
      void cancel(asset.id, root, token).catch(() => {});
    }

    function visibleCard(bounds) {
      return cards.find(card => {
        if (tried.has(card.asset.hash) || !card.thumb.isConnected) return false;
        const rect = card.thumb.getBoundingClientRect();
        const width = Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left);
        const height = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top);
        return width > 0 && height > 0 && width * height >= rect.width * rect.height / 4;
      });
    }

    async function run() {
      timer = null;
      if (active || !remaining || !allowed()) return;
      const card = visibleCard(viewport.getBoundingClientRect());
      if (!card) return;
      const record = active = { ...card, token: `hover_warm_${Date.now().toString(36)}_${(++sequence).toString(36)}` };
      let attempted = false;
      try { attempted = await prepare(record.asset.id, record.root, record.token); }
      catch { attempted = true; }
      if (active !== record) return;
      active = null;
      if (!attempted) return;
      tried.add(record.asset.hash);
      remaining--;
      schedule();
    }

    function schedule() {
      clearTimeout(timer);
      if (!active && cards.length && remaining) timer = setTimeout(() => void run(), delay);
    }

    function viewportChanged() {
      pause();
      remaining = limit;
      schedule();
    }

    function setCards(nextCards) {
      cards = nextCards;
      tried.clear();
      viewportChanged();
    }

    return Object.freeze({ schedule, pause, viewportChanged, setCards });
  }

  window.ShituModelWarmup = Object.freeze({ create });
})();
