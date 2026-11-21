'use strict';

const { contextBridge, ipcRenderer } = require('electron');
let subscribed = false;
contextBridge.exposeInMainWorld('invoicePdf', Object.freeze({
  onRequest(callback) {
    if (subscribed || typeof callback !== 'function') return;
    subscribed = true;
    ipcRenderer.on('shitu:invoice-pdf-request', (_event, request) => callback(request));
  },
  respond(id, result) {
    if (Number.isSafeInteger(id) && id >= 0) ipcRenderer.send('shitu:invoice-pdf-response', { id, ok: true, result });
  },
  reject(id, error) {
    if (Number.isSafeInteger(id) && id >= 0) ipcRenderer.send('shitu:invoice-pdf-response', { id, ok: false, error: String(error).slice(0, 500) });
  }
}));
