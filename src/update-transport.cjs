'use strict';

const { Readable } = require('node:stream');

const ignoreLateError = () => {};
const NULL_BODY_STATUS = new Set([204, 205, 304]);
function cancellation(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('网络请求已取消', 'AbortError');
}
function responseHeaders(values) {
  const headers = new Headers();
  if (Array.isArray(values)) {
    for (let index = 0; index + 1 < values.length; index += 2) headers.append(String(values[index]), String(values[index + 1]));
  } else {
    for (const [name, valuesForName] of Object.entries(values || {})) {
      for (const value of Array.isArray(valuesForName) ? valuesForName : [valuesForName]) headers.append(name, String(value));
    }
  }
  return headers;
}

// Electron's net.fetch forwards redirect:'manual' to ClientRequest, but does
// not expose its redirect event as a 3xx Response. The native request instead
// fails with "Redirect was cancelled". Return that response ourselves so the
// updater continues to validate every Location before issuing its next request.
function createUpdateTransport({ net, onDiagnostic = () => {} } = {}) {
  if (typeof net?.request !== 'function') throw new TypeError('Electron net.request is required');
  return function updateFetch(input, options = {}) {
    return new Promise((resolve, reject) => {
      let address, request, sourceReader, bodyController;
      let settled = false, finished = false;
      const signal = options.signal;
      const diagnostic = (event, { status, error } = {}) => {
        const code = error ? String(error.code || String(error.message || '').match(/(?:net::)?(ERR_[A-Z0-9_]+)/)?.[1] || error.name || 'NETWORK_ERROR').slice(0, 100) : undefined;
        try { onDiagnostic({ phase: 'transport', event, host: address?.hostname || '', ...(status ? { status } : {}), ...(code ? { code } : {}) }); } catch {}
      };
      function cleanup() {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        if (request) {
          request.removeListener('response', onResponse);
          request.removeListener('redirect', onRedirect);
          request.removeListener('error', onError);
          // ClientRequest may report a final native error after cancellation.
          // Keep only a shared, closure-free guard instead of per-call handlers.
          request.on('error', ignoreLateError);
        }
      }
      function stopNative(reason) {
        try { request?.abort(); } catch {}
        sourceReader?.cancel(reason).catch(() => {});
      }
      function fail(error, event = 'error') {
        if (finished) return;
        diagnostic(event, { error });
        cleanup();
        if (!settled) { settled = true; reject(error); }
        else { try { bodyController?.error(error); } catch {} }
        stopNative(error);
      }
      function onAbort() { fail(cancellation(signal), 'aborted'); }
      function onError(error) { fail(error); }
      function onRedirect(status, _method, location, headers) {
        if (finished) return;
        try {
          const values = responseHeaders(headers);
          values.set('Location', location);
          const response = new Response(null, { status, headers: values });
          diagnostic('redirect', { status });
          cleanup();
          settled = true;
          // Abort synchronously inside this event; otherwise Electron's manual
          // redirect policy emits an error after returning from the listener.
          stopNative();
          resolve(response);
        } catch (error) { fail(error); }
      }
      function onResponse(message) {
        if (finished) { message.destroy(); return; }
        try {
          const status = message.statusCode;
          const headers = responseHeaders(message.rawHeaders || message.headers);
          diagnostic('headers', { status });
          if (options.method?.toUpperCase() === 'HEAD' || NULL_BODY_STATUS.has(status)) {
            const response = new Response(null, { status, headers });
            cleanup(); settled = true; stopNative(); resolve(response); return;
          }
          sourceReader = Readable.toWeb(message, { strategy: {
            highWaterMark: 64 * 1024, size: chunk => chunk.byteLength
          } }).getReader();
          const body = new ReadableStream({
            start(controller) { bodyController = controller; },
            async pull(controller) {
              if (finished) return;
              try {
                const next = await sourceReader.read();
                if (finished) return;
                if (next.done) {
                  diagnostic('complete', { status }); cleanup(); controller.close();
                } else controller.enqueue(next.value);
              } catch (error) { fail(error); }
            },
            cancel(reason) {
              if (finished) return;
              diagnostic('cancelled'); cleanup(); stopNative(reason);
            }
          });
          const response = new Response(body, { status, headers });
          settled = true; resolve(response);
        } catch (error) { fail(error); }
      }
      try {
        if (signal?.aborted) { settled = true; reject(cancellation(signal)); return; }
        address = new URL(String(input));
        if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password) throw new TypeError('Invalid update request URL');
        const method = (options.method || 'GET').toUpperCase();
        if (!['GET', 'HEAD'].includes(method) || options.body != null) throw new TypeError('Update transport only supports GET and HEAD requests');
        const headers = Object.fromEntries(new Headers(options.headers));
        request = net.request({ url: address.href, method, headers, redirect: 'manual', cache: options.cache || 'default',
          credentials: 'omit', useSessionCookies: false });
        request.on('response', onResponse);
        request.on('redirect', onRedirect);
        request.on('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        diagnostic('request');
        request.end();
      } catch (error) { fail(error); }
    });
  };
}

module.exports = { createUpdateTransport };
