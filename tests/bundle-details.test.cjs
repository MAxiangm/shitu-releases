'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { render, PAGE_SIZE } = require('../src/bundle-details.js');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.className = ''; this._text = ''; this.disabled = false; this.hidden = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, listener) { this.events[name] = listener; }
  async click() { if (!this.disabled) await this.events.click?.(); }
}
function byClass(node, className) {
  if (node.className.split(' ').includes(className)) return node;
  for (const child of node.children) { const found = byClass(child, className); if (found) return found; }
  return null;
}
function fixture(overrides = {}) {
  return { id: 'model', modelBundle: { hash: 'current-hash', missing: [], resources: { version: 1, complete: true,
    models: 1, embeddedTextures: 1, externalTextures: 2, missingTextures: 0, entries: [], ...overrides } } };
}
function withDOM(t) {
  const previous = global.document; global.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (previous === undefined) delete global.document; else global.document = previous; });
}

test('browser global and CommonJS expose the same render API', () => {
  const context = {}; vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/bundle-details.js'), 'utf8'), context);
  assert.equal(typeof context.ShituBundleDetails.render, 'function');
  assert.equal(context.ShituBundleDetails.PAGE_SIZE, 40); assert.equal(render({ ext: 'png' }), null);
});

test('legacy and stale packages show unknown counts instead of zero or complete', t => {
  withDOM(t);
  const legacy = render({ modelBundle: { files: [{}], missing: [] } }, { onRecheck() {} });
  assert.match(legacy.textContent, /尚未检查资源包/);
  assert.doesNotMatch(legacy.textContent, /模型 0|贴图 0|已核对资源清单/);
  assert.equal(byClass(legacy, 'bundle-details-recheck').textContent, '检查资源包');
  const asset = fixture(); asset.modelBundle.diagnostics = { sourceHash: 'old-hash' };
  const stale = render(asset, { onRecheck() {} });
  assert.match(stale.textContent, /资源包已变化/); assert.doesNotMatch(stale.textContent, /模型 1 个/);
});

test('known partial project inventory preserves counts and explains scope without claiming failure', t => {
  withDOM(t);
  const asset = fixture({ complete: false, models: 2, embeddedTextures: 3, externalTextures: 0 });
  asset.projectBundle = asset.modelBundle; delete asset.modelBundle;
  const section = render(asset, { onRecheck() {} });
  assert.match(section.textContent, /AE 工程 · 模型 2 个 · 内嵌贴图 3 张 · 外置贴图 0 张/);
  assert.match(section.textContent, /仅统计已识别资源/); assert.match(section.textContent, /字体、第三方插件及表达式动态引用/);
  assert.doesNotMatch(section.textContent, /检查未完成|已核对资源清单/);
});

test('resource inventory paginates forty entries without dropping names or rendering hostile HTML', async t => {
  withDOM(t);
  const hostile = '<img src=x onerror="throw 1">& malicious';
  const entries = Array.from({ length: 85 }, (_, index) => ({ kind: index === 0 ? 'model' : 'texture', storage: 'file', path: index === 0 ? hostile : `texture-${index}.png` }));
  const section = render(fixture({ entries }));
  const list = byClass(section, 'bundle-details-list'), more = byClass(section, 'bundle-details-more');
  assert.equal(PAGE_SIZE, 40); assert.equal(list.children.length, 40); assert.equal(more.hidden, false);
  assert.equal(byClass(list.children[0], 'bundle-details-path').textContent, hostile);
  await more.click(); assert.equal(list.children.length, 80);
  assert.equal(more.textContent, '显示更多（5 项）');
  await more.click(); assert.equal(list.children.length, 85); assert.equal(more.hidden, true);
  assert.match(byClass(section, 'bundle-details-page-status').textContent, /85 \/ 85/);
});

test('entry labels distinguish embedded media, external files, and missing resources', t => {
  withDOM(t);
  const section = render(fixture({ missingTextures: 1, entries: [
    { kind: 'texture', storage: 'embedded', reference: 'paint.png', container: 'model.fbx' },
    { kind: 'material', storage: 'file', path: 'paint.mtl' },
    { kind: 'buffer', storage: 'missing', reference: '../mesh.bin' }
  ] }));
  const list = byClass(section, 'bundle-details-list');
  assert.match(list.children[0].textContent, /贴图内嵌paint.png所在文件：model.fbx/);
  assert.match(list.children[1].textContent, /材质包内文件paint.mtl/);
  assert.match(list.children[2].textContent, /缓冲数据缺失\.\.\/mesh.bin/);
  assert.match(section.textContent, /缺失贴图 1 张/);
});

test('pending disables repeated checks and announces progress, while errors remain retryable', async t => {
  withDOM(t);
  let resolve, calls = 0;
  const asset = fixture(), section = render(asset, { onRecheck(value) { assert.equal(value, asset); calls++; return new Promise(done => { resolve = done; }); } });
  const button = byClass(section, 'bundle-details-recheck'), status = byClass(section, 'bundle-details-status');
  const checking = button.click(); assert.equal(button.disabled, true); assert.equal(section.getAttribute('aria-busy'), 'true');
  assert.equal(status.getAttribute('role'), 'status'); assert.match(status.textContent, /正在检查/);
  await button.click(); assert.equal(calls, 1); resolve(); await checking;
  assert.equal(button.disabled, false); assert.equal(button.textContent, '重新检查资源包');
  const failed = render(asset, { onRecheck: async () => { throw new Error('<unsafe>'); } });
  await byClass(failed, 'bundle-details-recheck').click();
  assert.equal(byClass(failed, 'bundle-details-recheck').disabled, false);
  assert.match(byClass(failed, 'bundle-details-status').textContent, /未完成，请重试/);
  const initiallyPending = render(asset, { onRecheck() {}, pending: true });
  assert.equal(byClass(initiallyPending, 'bundle-details-recheck').disabled, true);
  assert.equal(initiallyPending.getAttribute('aria-busy'), 'true');
});
