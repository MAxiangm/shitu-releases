'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ColorLabels = require('../src/color-labels.js');

test('shared color labels use eight named safe colors and load in the browser without Node', () => {
  assert.deepEqual(ColorLabels.palette.map(item => item.id), ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']);
  assert.equal(new Set(ColorLabels.palette.map(item => item.color)).size, 8);
  for (const item of ColorLabels.palette) {
    assert.match(item.color, /^#[a-f0-9]{6}$/);
    assert.equal(ColorLabels.get(item.id), item);
    assert.equal(ColorLabels.name(item.id), item.name);
    assert.ok(Object.isFrozen(item));
  }
  assert.ok(Object.isFrozen(ColorLabels.palette));
  assert.ok(Object.isFrozen(ColorLabels));
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/color-labels.js'), 'utf8'), context);
  assert.equal(context.ShituColorLabels.get('red').name, '红色');
  assert.equal(context.ShituColorLabels.get(null), null);
  assert.equal(context.ShituColorLabels.get('#AbC').color, '#aabbcc');
});

test('labels normalize only absent or explicit clear values and reject arbitrary CSS or objects', () => {
  assert.equal(ColorLabels.normalize(undefined), null);
  assert.equal(ColorLabels.normalize(null), null);
  assert.equal(ColorLabels.name(null), '无颜色');
  for (const value of ['', 'RED', '#abcd', '#ffffffff', '#12g', ' #abc', '#abc\n', '#abcdef\r\n', 'rgb(1,2,3)', 'url(https://example.test)', 'toString', '__proto__', 0, false, [], {}]) {
    assert.throws(() => ColorLabels.normalize(value), /颜色标记无效/);
    assert.throws(() => ColorLabels.get(value), /颜色标记无效/);
  }
});

test('custom RGB labels normalize to six lowercase digits without altering the fixed palette', () => {
  const before = JSON.stringify(ColorLabels.palette);
  for (const [input, expected] of [['#ABC', '#aabbcc'], ['#aBcDeF', '#abcdef'], ['#000', '#000000'], ['#fff', '#ffffff'], ['#123456', '#123456']]) {
    assert.equal(ColorLabels.normalize(input), expected);
    const label = ColorLabels.get(input);
    assert.deepEqual(label, { id: expected, name: '自定义 ' + expected.toUpperCase(), color: expected, custom: true });
    assert.ok(Object.isFrozen(label));
    assert.equal(ColorLabels.name(input), label.name);
  }
  assert.equal(JSON.stringify(ColorLabels.palette), before);
  assert.equal(ColorLabels.palette.length, 8);
  assert.equal(ColorLabels.normalize('blue'), 'blue');
});
