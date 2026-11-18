'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const View = require('../src/folder-icon-view.js');
const Icons = require('../src/folder-icons.js');

function documentFixture() {
  function element(tag, namespace) {
    return { tagName: tag, namespaceURI: namespace, attributes: {}, style: {}, children: [], listeners: {},
      setAttribute(key, value) { this.attributes[key] = value; }, append(...nodes) { this.children.push(...nodes); },
      addEventListener(name, callback, options) { this.listeners[name] = { callback, options }; },
      replaceWith(node) { this.replacement = node; } };
  }
  return { createElement: tag => element(tag, null), createElementNS: (namespace, tag) => element(tag, namespace) };
}
const image = (ext = 'gif') => ({ id: 'folder-1', icon: { type: 'image', hash: 'a'.repeat(64), ext,
  width: 120, height: 80, size: 1024, animated: ext === 'gif' } });

test('every persisted built-in folder icon has an accessible matching vector definition', () => {
  assert.deepEqual(View.definitions.map(item => item.id), Icons.BUILTINS);
  const doc = documentFixture();
  for (const definition of View.definitions) {
    const node = View.create({ icon: { type: 'builtin', name: definition.id } }, { document: doc });
    assert.equal(node.tagName, 'svg'); assert.equal(node.attributes.viewBox, '0 0 24 24');
    assert.equal(node.attributes['aria-hidden'], 'true');
    assert.ok(node.children.length > 0);
    assert.ok(node.children.every(shape => ['path', 'rect', 'circle', 'ellipse'].includes(shape.tagName)));
  }
});

test('folder icon color is independent of label color and can fall back to it', () => {
  const doc = documentFixture();
  const label = '#e06b70';
  assert.equal(View.create({}, { document: doc, fallbackColor: label }).style.color, label);
  assert.equal(View.create({ iconColor: '#abcdef' }, { document: doc, fallbackColor: label }).style.color, '#abcdef');
  assert.equal(View.builtin('folder', 'url(https://example.test)', doc).style.color, undefined);
});

test('custom images use their original protocol URL without thumbnails or rasterization', () => {
  const doc = documentFixture();
  for (const ext of ['gif', 'png', 'jpg', 'webp']) {
    const folder = image(ext), unchanged = structuredClone(folder);
    const node = View.create(folder, { document: doc, imageUrl: Icons.iconUrl });
    assert.equal(node.tagName, 'img'); assert.equal(node.src, `shitu://folder-icon/folder-1?v=${'a'.repeat(64)}`);
    assert.equal(node.draggable, false); assert.equal(node.alt, '');
    assert.deepEqual(folder, unchanged);
    assert.match(node.className, /folder-custom-icon/);
  }
});

test('a missing custom image falls back once without retrying a broken URL', () => {
  const doc = documentFixture();
  const node = View.create(image(), { document: doc, imageUrl: Icons.iconUrl, fallbackColor: '#789fe8' });
  assert.equal(node.listeners.error.options.once, true);
  node.listeners.error.callback();
  assert.equal(node.replacement.tagName, 'svg');
  assert.equal(node.replacement.style.color, '#789fe8');
  assert.equal(node.replacement.listeners.error, undefined);
});

test('the view module loads without a DOM and renders after a document is supplied', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/folder-icon-view.js'), 'utf8'), context);
  assert.equal(typeof context.ShituFolderIconView.create, 'function');
  assert.equal(context.ShituFolderIconView.builtin('unknown', null, documentFixture()).children.length, 1);
});
