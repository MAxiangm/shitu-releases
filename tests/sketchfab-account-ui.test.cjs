'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const start = source.indexOf('let refreshingCollector = false;');
  const end = source.indexOf('function refreshYouTubeConnection()', start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { textContent: '', value: '', disabled: false, focus() {}, replaceChildren() {},
        classList: { add: name => classes.add(name), contains: name => classes.has(name),
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } });
    }
    return nodes.get(id);
  };
  const service = { connected: false, reads: 0, stateError: null };
  const api = {
    async getSketchfabAccountState() {
      service.reads++;
      if (service.stateError) throw service.stateError;
      return { connected: service.connected };
    },
    async connectSketchfabAccount() { service.connected = true; return { connected: true }; },
    async disconnectSketchfabAccount() { service.connected = false; return { connected: false }; },
    async getCollectorInfo() { return { enabled: true, ready: true }; }
  };
  const context = vm.createContext({ $, api, hasLibrary: () => true, refreshYouTubeConnection: () => {} });
  vm.runInContext(source.slice(start, end), context);
  return { context, $, api, service };
}

test('quiet collector polling reflects a server-side Sketchfab disconnect', async () => {
  const f = fixture();
  f.service.connected = true;
  await f.context.refreshCollector(true);
  assert.equal(f.$('sketchfabTokenEntry').classList.contains('hidden'), true);
  assert.match(f.$('sketchfabConnectionStatus').textContent, /^已连接 Sketchfab/);
  f.service.connected = false;
  await f.context.refreshCollector(true);
  assert.equal(f.service.reads, 2);
  assert.equal(f.$('sketchfabTokenEntry').classList.contains('hidden'), false);
  assert.equal(f.$('sketchfabDisconnect').classList.contains('hidden'), true);
  assert.match(f.$('sketchfabConnectionStatus').textContent, /^尚未连接 Sketchfab/);
});

test('unchanged quiet polling preserves the latest connection error and success message', async () => {
  const f = fixture();
  f.api.connectSketchfabAccount = async () => { throw new Error('连接验证失败，请检查 Token。'); };
  f.$('sketchfabToken').value = 'synthetic-token';
  await f.context.connectSketchfabAccount({ preventDefault() {} });
  const errorMessage = f.$('sketchfabConnectionStatus').textContent;
  assert.equal(errorMessage, '连接验证失败，请检查 Token。');
  await f.context.refreshCollector(true);
  assert.equal(f.$('sketchfabConnectionStatus').textContent, errorMessage);
  f.service.connected = true;
  f.context.renderSketchfabConnection({ connected: true }, '连接已验证并安全保存。');
  await f.context.refreshCollector(true);
  assert.equal(f.$('sketchfabConnectionStatus').textContent, '连接已验证并安全保存。');
  f.service.stateError = new Error('暂时无法读取状态');
  await f.context.refreshCollector(true);
  assert.equal(f.$('sketchfabConnectionStatus').textContent, '连接已验证并安全保存。');
});

test('quiet polling skips connection and disconnection operations in progress', async () => {
  const f = fixture();
  let finish;
  f.api.connectSketchfabAccount = () => new Promise(resolve => { finish = () => { f.service.connected = true; resolve({ connected: true }); }; });
  f.$('sketchfabToken').value = 'synthetic-token';
  const connect = f.context.connectSketchfabAccount({ preventDefault() {} });
  await f.context.refreshCollector(true);
  assert.equal(f.service.reads, 0);
  assert.equal(f.$('sketchfabConnectionStatus').textContent, '正在验证 Sketchfab 连接…');
  finish(); await connect;
  f.api.disconnectSketchfabAccount = () => new Promise(resolve => { finish = () => { f.service.connected = false; resolve({ connected: false }); }; });
  const disconnect = f.context.disconnectSketchfabAccount();
  await f.context.refreshCollector(true);
  assert.equal(f.service.reads, 0);
  assert.equal(f.$('sketchfabConnectionStatus').textContent, '正在断开 Sketchfab 连接…');
  finish(); await disconnect;
  await f.context.refreshCollector(true);
  assert.equal(f.service.reads, 1);
});

test('a stale state response cannot overwrite a newer successful connection', async () => {
  const f = fixture();
  let finish;
  f.api.getSketchfabAccountState = () => new Promise(resolve => { finish = () => resolve({ connected: false }); });
  const refresh = f.context.refreshSketchfabConnection(true);
  f.$('sketchfabToken').value = 'synthetic-token';
  await f.context.connectSketchfabAccount({ preventDefault() {} });
  finish(); await refresh;
  assert.equal(f.$('sketchfabTokenEntry').classList.contains('hidden'), true);
  assert.match(f.$('sketchfabConnectionStatus').textContent, /^已连接 Sketchfab/);
});
