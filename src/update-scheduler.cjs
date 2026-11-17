'use strict';

const MINUTE = 60_000;
const BUSY = new Set(['disabled', 'checking', 'downloading', 'installing']);

function updateIntervalMs(config = {}) {
  const minutes = Number(config.checkIntervalMinutes);
  const legacyHours = Number(config.checkIntervalHours);
  const selected = Number.isFinite(minutes) && minutes > 0 ? minutes
    : Number.isFinite(legacyHours) && legacyHours > 0 ? legacyHours * 60 : 5;
  // GitHub's unauthenticated API is shared by clients on the same public IP.
  return Math.min(24 * 60, Math.max(5, selected)) * MINUTE;
}

function createUpdateScheduler({ check, getState = () => ({}), isOnline = () => true,
  canCheck = () => true, enabled = true, intervalMs = 5 * MINUTE,
  startupDelayMs = 2000, minimumIntervalMs = MINUTE, networkPollMs = 10_000,
  now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  if (typeof check !== 'function') throw new TypeError('An update check callback is required');
  let started = false, disposed = false, pending = null, lastAttempt = -Infinity;
  let startupTimer, intervalTimer, networkTimer, previousOnline;
  const online = () => { try { return Boolean(isOnline()); } catch { return false; } };
  const unref = timer => { timer?.unref?.(); return timer; };

  function trigger(reason = 'activity') {
    if (!enabled || !started || disposed) return Promise.resolve(null);
    if (pending) return pending;
    if (!canCheck() || BUSY.has(getState()?.status) || !online() || now() - lastAttempt < minimumIntervalMs) return Promise.resolve(null);
    lastAttempt = now();
    pending = Promise.resolve().then(() => check(reason)).catch(() => null).finally(() => { pending = null; });
    return pending;
  }
  function recordManualCheck() {
    // The explicit button calls the updater directly and is never throttled.
    // Its request should still suppress a redundant automatic check moments later.
    lastAttempt = now();
  }
  function start() {
    if (!enabled || started || disposed) return;
    started = true; previousOnline = online();
    startupTimer = unref(setTimeoutImpl(() => trigger('startup'), startupDelayMs));
    intervalTimer = unref(setIntervalImpl(() => trigger('interval'), intervalMs));
    // A local connectivity sample sends no request to GitHub. Only the transition
    // back online asks for a check, using the same throttle and pending operation.
    networkTimer = unref(setIntervalImpl(() => {
      const currentOnline = online(), restored = previousOnline === false && currentOnline;
      previousOnline = currentOnline;
      if (restored) trigger('online');
    }, networkPollMs));
  }
  function dispose() {
    disposed = true;
    clearTimeoutImpl(startupTimer); clearIntervalImpl(intervalTimer); clearIntervalImpl(networkTimer);
  }
  return { start, trigger, recordManualCheck, dispose };
}

module.exports = { createUpdateScheduler, updateIntervalMs };
