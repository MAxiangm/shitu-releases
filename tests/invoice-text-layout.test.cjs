'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { layoutTextItems } = require('../src/invoice-text-layout.js');
const { extractInvoiceAmount } = require('../src/invoice-amounts.js');

const item = (str, x, y, width = str.length * 5, height = 10, hasEOL = false) => ({ str, width, height, transform: [height, 0, 0, height, x, y], hasEOL });

test('visual rows restore late-painted invoice totals before lower remarks regardless of hasEOL', () => {
  const items = [
    item('价税合计（大写）', 20, 100, 90, 9, true),
    item('备注：请核对票据', 20, 70, 120, 9, true),
    item('电子发票', 100, 180, 90, 16, true),
    item('玖佰玖拾捌元整', 120, 100, 90, 9, true),
    item('（小写）', 250, 100, 36, 9, true),
    item('¥', 290, 101.5, 6, 11), item('998.00', 296, 101.5, 33, 11)
  ];
  const text = layoutTextItems(items);
  assert.equal(text, '电子发票\n价税合计（大写） 玖佰玖拾捌元整 （小写） ¥998.00\n备注：请核对票据');
  assert.equal(extractInvoiceAmount(text).cents, 99800);
  assert.equal(layoutTextItems(items.toReversed()), text);
  const second = items.map(value => value.str === '998.00' ? { ...value, str: '39.00', width: 27.5 } : value);
  assert.equal(extractInvoiceAmount(layoutTextItems(second)).cents, 3900);
});

test('adjacent digits and decimal fragments rejoin while Latin word boundaries remain legible', () => {
  const values = [item('价税合计（小写）', 20, 100, 100), item('¥', 260, 101, 6),
    item('9', 266, 101, 5), item('9', 272, 101, 5), item('8', 278, 101, 5),
    item('.', 284, 101, 2), item('0', 287, 101, 5), item('0', 293, 101, 5),
    item('In', 20, 160, 8), item('voice', 28, 160, 23),
    item('Total', 60, 160, 25), item('Amount', 87, 160, 35)];
  const text = layoutTextItems([values[6], ...values.slice(0, 6), ...values.slice(7)]);
  assert.equal(text, 'Invoice Total Amount\n价税合计（小写） ¥998.00');
  assert.equal(extractInvoiceAmount(text).cents, 99800);
});

test('net amount and tax columns on one row remain separate monetary tokens', () => {
  const items = [item('1000.00', 120, 130, 35), item('130.00', 155, 130, 30), item('合计', 20, 130, 20),
    item('价税合计（小写）', 20, 100, 100), item('¥1130.00', 200, 101.2, 45),
    item('金额', 120, 150, 20), item('税额', 180, 150, 20)];
  const text = layoutTextItems(items);
  assert.match(text, /合计 1000\.00 130\.00/);
  assert.doesNotMatch(text, /1000\.00130/);
  assert.equal(extractInvoiceAmount(text).cents, 113000);
});

test('nearby physical rows remain distinct while font baseline differences within a row align', () => {
  const text = layoutTextItems([item('第三行', 20, 80, 35, 9), item('第二行', 20, 90, 35, 9),
    item('第一行', 20, 100, 35, 9), item('39.00', 200, 101.5, 30, 11)]);
  assert.equal(text, '第一行 39.00\n第二行\n第三行');
});

test('viewport rotations preserve invoice reading order and correctly scaled geometry', () => {
  const items = [item('Notes', 20, 40), item('39.00', 150, 100, 30), item('Invoice', 20, 180), item('Total', 20, 100)];
  const transforms = [[1, 0, 0, -1, 0, 200], [0, 1, 1, 0, 0, 0], [-1, 0, 0, 1, 300, 0], [0, -1, -1, 0, 200, 300], [2, 0, 0, -2, 50, 420]];
  for (const transform of transforms) assert.equal(layoutTextItems(items, { viewport: { transform } }), 'Invoice\nTotal 39.00\nNotes');
});

test('orthogonally rotated text matrices are normalized without dropping text', () => {
  const items = [item('Notes', 20, 40), item('39.00', 150, 100, 30), item('Invoice', 20, 180), item('Total', 20, 100)]
    .map(value => ({ ...value, transform: [0, 10, -10, 0, 200 - value.transform[5], value.transform[4]] }));
  assert.equal(layoutTextItems(items), 'Invoice\nTotal 39.00\nNotes');
});

test('browser UMD entry matches Node and ignores marked-content records', () => {
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/invoice-text-layout.js'), 'utf8'), browser);
  assert.equal(typeof browser.MosaicInvoiceTextLayout.layoutTextItems, 'function');
  const items = [{ type: 'beginMarkedContentProps', id: 'invoice' }, item('Total', 20, 100), item('39.00', 100, 100), { type: 'endMarkedContent' }];
  assert.equal(browser.MosaicInvoiceTextLayout.layoutTextItems(items), layoutTextItems(items));
  assert.ok(Object.isFrozen(browser.MosaicInvoiceTextLayout));
});

test('text limits reject oversized input and invalid geometry cannot inject invalid coordinates', () => {
  assert.throws(() => layoutTextItems(null), /参数/);
  assert.throws(() => layoutTextItems([], { maxTextChars: 0 }), /参数/);
  assert.throws(() => layoutTextItems([item('x'.repeat(100), 0, 0)], { maxTextChars: 100 }), /文字超过/);
  assert.equal(layoutTextItems([item('Invoice', 20, 100), { str: 'fallback', transform: [1, 0, 0, 1, NaN, 0] }]), 'Invoice\nfallback');
  assert.equal(layoutTextItems([{ str: ' ' }, { type: 'endMarkedContent' }]), '');
});
