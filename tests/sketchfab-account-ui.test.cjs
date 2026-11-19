'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function fixture() {
  const source = read('src/renderer.js');
  const start = source.indexOf('let refreshingCollector = false;');
  const end = source.indexOf('function refreshYouTubeConnection()', start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map();
  const $ = id => {
    if (/sketchfabToken|sketchfabAccountForm|sketchfabConnect|sketchfabDisconnect/.test(id)) throw new Error('The old token form must not be required');
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { textContent: '', value: '', disabled: false, focus() {}, replaceChildren() {},
        classList: { add: name => classes.add(name), contains: name => classes.has(name),
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } });
    }
    return nodes.get(id);
  };
  let collectorReads = 0;
  const api = {
    async getCollectorInfo() { collectorReads++; return { enabled: true, ready: true }; },
    getSketchfabAccountState() { throw new Error('Default collection must not read legacy credentials'); },
    connectSketchfabAccount() { throw new Error('Default collection must not require a token'); }
  };
  const context = vm.createContext({ $, api, hasLibrary: () => true, refreshYouTubeConnection: () => {} });
  vm.runInContext(source.slice(start, end), context);
  return { context, $, collectorReads: () => collectorReads };
}

test('collection settings describe current Chrome Sketchfab login and have no token form', () => {
  const html = read('src/index.html');
  const start = html.indexOf('<h3>Sketchfab 模型下载</h3>');
  const section = html.slice(start, html.indexOf('</section>', start));
  assert.ok(start >= 0);
  assert.match(section, /使用当前 Chrome 的 Sketchfab 网页登录/);
  assert.match(section, /无需输入 API Token/);
  assert.match(section, /原来的 Sketchfab 页面完成登录/);
  assert.match(section, /不会自动打开新的登录窗口/);
  assert.match(section, /Alt＋右键/);
  assert.doesNotMatch(section, /<input|<form|sketchfabToken|sketchfabAccountForm/);
});

test('normal and quiet collector refreshes do not read or require token state', async () => {
  const f = fixture();
  await f.context.refreshCollector();
  await f.context.refreshCollector(true);
  assert.equal(f.collectorReads(), 2);
  assert.match(f.$('collectorStatus').textContent, /本地接收服务已就绪/);
});

test('renderer has no listeners or DOM dependencies on the removed token form', () => {
  const renderer = read('src/renderer.js');
  assert.doesNotMatch(renderer, /sketchfabToken|sketchfabAccountForm|connectSketchfabAccount|disconnectSketchfabAccount|getSketchfabAccountState/);
});

test('main routes default Sketchfab captures to anonymous browser verification', () => {
  const main = read('src/main.cjs');
  assert.match(main, /resolveSketchfabModel\s*:\s*options\s*=>\s*sketchfabAccount\.resolveBrowserModel\(options\)/);
  assert.match(main, /sketchfabBrowserDownload\s*:\s*true/);
  assert.doesNotMatch(main, /resolveSketchfabModel\s*:\s*options\s*=>\s*sketchfabAccount\.resolveModel\(options\)/);
});
