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
  const sameSource = (request, identity) => request.library === identity.library && request.id === identity.id &&
    request.source === identity.source && request.hash === identity.hash && !request.controller.signal.aborted;
  function prepare(identity, requestToken, operation, onProgress) {
    const consumer = requestToken == null ? VIEWER : hoverToken(requestToken);
    const same = [...pending].find(request => sameSource(request, identity) &&
      (request.profile || 'full') === (identity.profile || 'full'));
    if (same) {
      same.consumers.add(consumer);
      if (typeof onProgress === 'function') same.progressListeners.add(onProgress);
      active = same;
      return same.promise;
    }
    // Background thumbnail work must not interrupt a foreground video viewer.
    if (consumer !== VIEWER && [...pending].some(request => request.consumers.has(VIEWER) && !request.controller.signal.aborted))
      return Promise.reject(cancelled());
    // Reopening a viewer can show its short cached clip without discarding a
    // same-source full conversion that is still useful in the background.
    const preserved = identity.profile === 'quick' ? [...pending].find(request =>
      sameSource(request, identity) && (request.profile || 'full') === 'full') : null;
    for (const previous of pending) if (previous !== preserved) previous.controller.abort();
    const request = { ...identity, controller: new AbortController(), consumers: new Set([consumer]),
      progressListeners: new Set(typeof onProgress === 'function' ? [onProgress] : []), promise: null };
    pending.add(request);
    active = request;
    request.promise = Promise.resolve().then(async () => {
      request.controller.signal.throwIfAborted();
      const result = await operation(request.controller.signal, event => {
        for (const listener of request.progressListeners) { try { listener(event); } catch {} }
      });
      request.controller.signal.throwIfAborted();
      return result;
    }).finally(() => {
      pending.delete(request);
      request.progressListeners.clear();
      if (active === request) active = null;
    });
    return request.promise;
  }
  function cancel(id, expectedRoot, requestToken) {
    const consumer = hoverToken(requestToken);
    const request = [...pending].find(item => !item.controller.signal.aborted && item.id === id && item.library.root === expectedRoot && item.consumers.has(consumer));
    if (!request || !request.consumers.delete(consumer)) return false;
    if (!request.consumers.size) request.controller.abort();
    return true;
  }
  function releaseViewer(id, expectedRoot) {
    // Keep useful conversion work warm for a quick reopen. It no longer has
    // foreground priority, so another thumbnail may now replace it.
    let released = false;
    for (const request of pending) if (request.id === id && request.library.root === expectedRoot)
      released = request.consumers.delete(VIEWER) || released;
    return released;
  }
  function abortAll() {
    for (const request of pending) request.controller.abort();
    active = null;
  }
  return { prepare, cancel, releaseViewer, abortAll };
}

module.exports = { createVideoPreviewRequests };
