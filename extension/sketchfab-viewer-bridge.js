(function (scope) {
  'use strict';
  const MAX_JSON_BYTES = 48 * 1024 * 1024;
  const ID = /^[a-f0-9]{32}$/;
  const failure = code => Object.assign(new Error(code), { code });
  function capture({ modelId, target = scope, origin = scope.location?.origin, timeout = 12000, isCurrent = () => true } = {}) {
    if (!ID.test(modelId || '') || !/^https:\/\/(?:www\.)?sketchfab\.com$/.test(origin || '') ||
        typeof target?.postMessage !== 'function' || !isCurrent()) return Promise.reject(failure('SKETCHFAB_SOURCE_CHANGED'));
    const random = new Uint8Array(16); scope.crypto.getRandomValues(random);
    const requestId = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true; clearTimeout(deadline); clearInterval(currentTimer);
        scope.removeEventListener('message', receive);
        error ? reject(error) : resolve(value);
      };
      const receive = event => {
        const message = event.data;
        if (event.source !== target || event.origin !== origin || message?.type !== 'mosaic:sketchfab-viewer-response' ||
            message.requestId !== requestId || message.modelId !== modelId) return;
        if (!isCurrent()) return finish(failure('SKETCHFAB_SOURCE_CHANGED'));
        if (!message.ok) return finish(failure(/^SKETCHFAB_VIEWER_[A-Z_]+$/.test(message.code || '') ? message.code : 'SKETCHFAB_VIEWER_UNAVAILABLE'));
        const snapshot = message.snapshot;
        if (!snapshot || snapshot.version !== 1 || snapshot.modelId !== modelId || !Array.isArray(snapshot.meshes) ||
            !snapshot.meshes.length || snapshot.meshes.length > 512 || !Array.isArray(snapshot.images) || snapshot.images.length > 128) {
          return finish(failure('SKETCHFAB_VIEWER_INVALID'));
        }
        try {
          if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_JSON_BYTES) return finish(failure('SKETCHFAB_VIEWER_TOO_LARGE'));
        } catch { return finish(failure('SKETCHFAB_VIEWER_INVALID')); }
        finish(null, snapshot);
      };
      const deadline = setTimeout(() => finish(failure('SKETCHFAB_VIEWER_UNAVAILABLE')), Math.min(20000, Math.max(1, timeout)));
      const currentTimer = setInterval(() => { if (!isCurrent()) finish(failure('SKETCHFAB_SOURCE_CHANGED')); }, 100);
      scope.addEventListener('message', receive);
      try { target.postMessage({ type: 'mosaic:sketchfab-viewer-request', requestId, modelId }, origin); }
      catch { finish(failure('SKETCHFAB_VIEWER_UNAVAILABLE')); }
    });
  }
  scope.MosaicSketchfabViewerBridge = { capture, MAX_JSON_BYTES };
  if (typeof module === 'object' && module.exports) module.exports = scope.MosaicSketchfabViewerBridge;
})(typeof globalThis === 'object' ? globalThis : this);
