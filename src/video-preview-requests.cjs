'use strict';

// A thumbnail hover owns a cancellable lease. Only requests for the same
// profile share work; the full viewer must never receive a short hover clip.
const VIEWER = Symbol('video viewer');
function hoverToken(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[^a-zA-Z0-9_-]/.test(value))
    throw new TypeError('视频预览请求标识无效');
  return value;
}
function cancelled() { return new DOMException('视频预览已取消', 'AbortError'); }

function createVideoPreviewRequests() {
  let active = null;
  const pending = new Set();
  function prepare(identity, requestToken, operation) {
    const consumer = requestToken == null ? VIEWER : hoverToken(requestToken);
    const same = active && active.library === identity.library && active.id === identity.id &&
      active.source === identity.source && active.hash === identity.hash &&
      (active.profile || 'full') === (identity.profile || 'full') && !active.controller.signal.aborted;
    if (same) {
      active.consumers.add(consumer);
      return active.promise;
    }
    // Background thumbnail work must not interrupt a foreground video viewer.
    if (consumer !== VIEWER && active?.consumers.has(VIEWER) && !active.controller.signal.aborted)
      return Promise.reject(cancelled());
    for (const previous of pending) previous.controller.abort();
    const request = { ...identity, controller: new AbortController(), consumers: new Set([consumer]), promise: null };
    pending.add(request);
    active = request;
    request.promise = Promise.resolve().then(async () => {
      request.controller.signal.throwIfAborted();
      const result = await operation(request.controller.signal);
      request.controller.signal.throwIfAborted();
      return result;
    }).finally(() => {
      pending.delete(request);
      if (active === request) active = null;
    });
    return request.promise;
  }
  function cancel(id, expectedRoot, requestToken) {
    const consumer = hoverToken(requestToken);
    if (!active || active.id !== id || active.library.root !== expectedRoot ||
        !active.consumers.delete(consumer)) return false;
    if (!active.consumers.size) active.controller.abort();
    return true;
  }
  function releaseViewer(id, expectedRoot) {
    if (!active || active.id !== id || active.library.root !== expectedRoot) return false;
    // Keep useful conversion work warm for a quick reopen. It no longer has
    // foreground priority, so another thumbnail may now replace it.
    return active.consumers.delete(VIEWER);
  }
  function abortAll() {
    for (const request of pending) request.controller.abort();
    active = null;
  }
  return { prepare, cancel, releaseViewer, abortAll };
}

module.exports = { createVideoPreviewRequests };
