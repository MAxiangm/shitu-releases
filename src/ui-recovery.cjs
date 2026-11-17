'use strict';

const WINDOW_MS = 5 * 60_000;
function createUiRecovery({ app, window, canRecover = () => true, onDiagnostic = () => {}, onExhausted = () => {},
  now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  unresponsiveDelayMs = 10_000, gpuDelayMs = 1000, retryDelayMs = 5000, reloadTimeoutMs = 30_000,
  maxReloads = 2, budgetWindowMs = WINDOW_MS } = {}) {
  const contents = window?.webContents;
  if (!app?.on || !window?.on || !contents?.on) throw new TypeError('UI recovery requires an app and BrowserWindow');
  let disposed = false, pending = null, timer = null, loadTimer = null, reloading = false, exhaustedAt = -Infinity;
  const attempts = [], listeners = [];
  const live = () => !disposed && !window.isDestroyed() && !contents.isDestroyed();
  const unref = value => { value?.unref?.(); return value; };
  const cleanReason = value => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : 'unknown';
  function diagnostic(event, detail = {}) {
    const entry = { event, source: cleanReason(detail.source || 'window') };
    if (detail.reason !== undefined) entry.reason = cleanReason(detail.reason);
    if (Number.isInteger(detail.exitCode)) entry.exitCode = detail.exitCode;
    try { onDiagnostic(entry); } catch {}
  }
  function clearPendingTimer() { if (timer !== null) clearTimeoutImpl(timer); timer = null; }
  function clearLoadTimer() { if (loadTimer !== null) clearTimeoutImpl(loadTimer); loadTimer = null; }
  function repaint(source) {
    if (!live()) return;
    try { contents.invalidate(); } catch { diagnostic('paint-failed', { source }); }
  }
  function allowed() { try { return Boolean(canRecover()); } catch { return false; } }
  function schedule() {
    clearPendingTimer();
    if (!live() || !pending || reloading) return;
    timer = unref(setTimeoutImpl(attempt, Math.max(0, pending.readyAt - now())));
  }
  function attempt() {
    timer = null;
    if (!live() || !pending || reloading) return;
    if (!allowed()) {
      if (!pending.deferred) { pending.deferred = true; diagnostic('deferred', pending); }
      timer = unref(setTimeoutImpl(attempt, retryDelayMs));
      return;
    }
    while (attempts.length && now() - attempts[0] >= budgetWindowMs) attempts.shift();
    const detail = pending; pending = null;
    if (attempts.length >= maxReloads) {
      diagnostic('budget-exhausted', detail);
      if (now() - exhaustedAt >= budgetWindowMs) {
        exhaustedAt = now();
        try { Promise.resolve(onExhausted({ source: detail.source, reason: detail.reason, exitCode: detail.exitCode })).catch(() => {}); } catch {}
      }
      return;
    }
    attempts.push(now()); reloading = true;
    diagnostic('reload', detail);
    try {
      contents.reload();
      loadTimer = unref(setTimeoutImpl(() => {
        loadTimer = null;
        if (!live() || !reloading) return;
        reloading = false;
        enqueue({ source: 'load-timeout', reason: 'timeout' }, 0);
      }, reloadTimeoutMs));
    } catch {
      reloading = false;
      diagnostic('reload-failed', detail);
      enqueue({ source: 'reload-failed', reason: 'exception' }, retryDelayMs);
    }
  }
  function enqueue(detail, delay) {
    if (!live()) return;
    if (detail.source === 'unresponsive' && pending && pending.source !== 'unresponsive') return;
    if (reloading && detail.source !== 'renderer') return;
    pending = { ...detail, readyAt: now() + delay, deferred: false };
    diagnostic('detected', detail);
    schedule();
  }
  function listen(emitter, event, callback) { emitter.on(event, callback); listeners.push([emitter, event, callback]); }
  listen(window, 'unresponsive', () => enqueue({ source: 'unresponsive', reason: 'unresponsive' }, unresponsiveDelayMs));
  listen(window, 'responsive', () => {
    if (pending?.source !== 'unresponsive') return;
    pending = null; clearPendingTimer(); diagnostic('responsive', { source: 'unresponsive' });
  });
  listen(contents, 'render-process-gone', (_event, details = {}) => {
    if (details.reason === 'clean-exit') return;
    reloading = false; clearLoadTimer();
    enqueue({ source: 'renderer', reason: details.reason, exitCode: details.exitCode }, 0);
  });
  listen(app, 'child-process-gone', (_event, details = {}) => {
    if (String(details.type).toUpperCase() !== 'GPU' || details.reason === 'clean-exit') return;
    enqueue({ source: 'gpu', reason: details.reason, exitCode: details.exitCode }, gpuDelayMs);
  });
  listen(contents, 'did-finish-load', () => {
    if (!live()) return;
    if (reloading) diagnostic('recovered', { source: 'renderer' });
    reloading = false; pending = null; clearPendingTimer(); clearLoadTimer(); repaint('load');
  });
  for (const event of ['restore', 'show', 'focus']) listen(window, event, () => { repaint(event); if (pending && !reloading) schedule(); });
  function dispose() {
    if (disposed) return;
    disposed = true; pending = null; clearPendingTimer(); clearLoadTimer();
    for (const [emitter, event, callback] of listeners.splice(0)) emitter.removeListener(event, callback);
  }
  listen(window, 'closed', dispose);
  return Object.freeze({ dispose });
}

module.exports = { createUiRecovery };
