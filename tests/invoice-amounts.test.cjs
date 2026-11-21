'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Amounts = require('../src/invoice-amounts.js');

test('money parsing preserves decimal cents exactly and accepts well-formed currency/grouping', () => {
  for (const [input, cents] of [['0', 0], ['0.1', 10], ['0.29', 29], ['1234.56', 123456], ['￥1,234.56', 123456], [' ¥ 1,234 ', 123400], ['１，２３４．５６', 123456], ['12元', 1200], ['0001.05', 105], ['9,999,999,999.99', Amounts.MAX_AMOUNT_CENTS]]) {
    assert.equal(Amounts.parseAmount(input), cents, input);
    assert.equal(Amounts.parseAmount(Amounts.formatAmount(cents)), cents);
  }
});

test('invalid amounts never silently round, remove signs or accept exponent notation', () => {
  for (const input of ['', ' ', null, 1.2, {}, '1e3', '1E3', '-1.00', '−1.00', '+1.00', '(12.00)', '1.234', '1.', '.5', '1,23.00', '12,3456', '1 234.56', '1,234,56', 'NaN', 'Infinity', '10,000,000,000.00', '9007199254740993', '￥-1', '1.00abc']) {
    assert.equal(Amounts.parseAmount(input), null, String(input));
  }
  for (const cents of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100']) assert.equal(Amounts.formatAmount(cents), '');
  assert.equal(Amounts.formatAmount(Number.MAX_SAFE_INTEGER), '90071992547409.91');
});

test('totals use integer cents and explicitly identify invalid rows', () => {
  assert.deepEqual(Amounts.totalAmounts(['0.10', '0.20', 29, 'bad', '', -1, 1.5]), { cents: 59, amount: '0.59', validCount: 3, invalidIndices: [3, 4, 5, 6] });
  assert.deepEqual(Amounts.totalAmounts([]), { cents: 0, amount: '0.00', validCount: 0, invalidIndices: [] });
  assert.equal(Amounts.totalAmounts([Amounts.MAX_AMOUNT_CENTS, Amounts.MAX_AMOUNT_CENTS]).amount, '19999999999.98');
  const overflow = Amounts.totalAmounts(Array(10000).fill(Amounts.MAX_AMOUNT_CENTS));
  assert.equal(overflow.cents, null); assert.equal(overflow.amount, null); assert.equal(overflow.reason, 'overflow');
});

test('VAT small amount wins over net amount, tax and other lower-priority totals', () => {
  const result = Amounts.extractInvoiceAmount('发票号码：24312000000012345678\n金额 税率 税额\n1000.00 13% 130.00\n合计 ￥1000.00 ￥130.00\n金额合计：1000.00\n价税合计（大写）壹仟壹佰叁拾元整 （小写）￥1,130.00\n开票人：张三');
  assert.equal(result.amount, '1130.00'); assert.equal(result.cents, 113000); assert.equal(result.confidence, 'high');
  assert.equal(result.label, '价税合计（小写）');
  assert.deepEqual(result.candidates.map(item => item.amount), ['1130.00', '1000.00']);
});

test('VAT labels tolerate Chinese OCR spaces, fullwidth digits and line breaks', () => {
  const result = Amounts.extractInvoiceAmount('价 税 合 计 （ 大 写 ）\n壹佰零玖元整\n（ 小 写 ）\n￥１０９．００\n备注：电子发票');
  assert.equal(result.amount, '109.00'); assert.equal(result.label, '价税合计（小写）');
  assert.equal(result.candidates[0].line, 4);
  assert.equal(Amounts.extractInvoiceAmount('价税合计\n人民币 ￥109.00').amount, '109.00');
  assert.equal(Amounts.extractInvoiceAmount('价税合计\n109.00').candidates[0].line, 2);
});

test('VAT labels can break across lines without consuming the bounded field body', () => {
  const cases = [
    ['价\n税\n合\n计（大写）玖佰玖拾捌圆整（小\n写）¥998.00', '998.00'],
    ['价税合计\n（大写）\n叁拾玖圆整\n（小\n写）\n¥39.00', '39.00'],
    ['价税合计\n\n  \n（大写）\n玖佰玖拾捌圆整\n（小写）\n¥998.00', '998.00']
  ];
  for (const [text, amount] of cases) {
    const result = Amounts.extractInvoiceAmount(text);
    assert.equal(result.amount, amount, text); assert.equal(result.confidence, 'high', text);
    assert.equal(result.label, '价税合计（小写）');
  }
  const positioned = Amounts.extractInvoiceAmount('价税合计\n（大写）\n叁拾玖圆整\n（小写）\n¥39.00');
  assert.equal(positioned.candidates[0].line, 5, 'candidate locations retain source line numbers');
});

test('coordinate-ordered synthetic VAT lines remain high confidence beside net and tax amounts', () => {
  for (const [words, amount] of [['玖佰玖拾捌圆整', '998.00'], ['叁拾玖圆整', '39.00']]) {
    const result = Amounts.extractInvoiceAmount(`金额 税额\n100.00 13.00\n价税合计（大写）${words}（小写）¥${amount}\n备注：合成测试`);
    assert.equal(result.amount, amount); assert.equal(result.confidence, 'high');
    assert.equal(result.candidates.length, 1);
  }
});

test('fragmented decimal and grouping separators cannot turn trailing digits into confident amounts', () => {
  for (const value of ['¥113.\n45', '¥113. 45', '¥1, 130.00', '¥113 \n.45', '¥1 , 130.00', '￥１１３．\n４５', '¥113.\n45\n100.00']) {
    const result = Amounts.extractInvoiceAmount(`价税合计（小写）${value}`);
    assert.equal(result.amount, null, value); assert.equal(result.cents, null, value);
    assert.equal(result.confidence, 'none', value); assert.equal(result.candidates.length, 0, value);
  }
  for (const value of ['113.45', '1,130.00']) assert.equal(Amounts.extractInvoiceAmount(`价税合计（小写）¥${value}`).confidence, 'high');
});

test('broken-label support does not scan arbitrary prior columns or extend the body window', () => {
  assert.equal(Amounts.extractInvoiceAmount('¥998.00\n价\n税\n合\n计（小\n写）').amount, null);
  assert.equal(Amounts.extractInvoiceAmount('价税合计\n（大写）\n玖佰玖拾捌圆整\n（小写）\n内容缺失\n¥998.00').amount, null);
  const ambiguous = Amounts.extractInvoiceAmount('价\n税\n合\n计（小\n写）\n998.00\n100.00\n13.00');
  assert.equal(ambiguous.amount, null); assert.equal(ambiguous.reason, 'ambiguous-totals');
  const stopped = Amounts.extractInvoiceAmount('价税合计（小\n写）\n¥39.00\n税额 2.00');
  assert.equal(stopped.amount, '39.00'); assert.equal(stopped.candidates.length, 1);
});

test('generic total labels are available with lower confidence', () => {
  for (const input of ['总金额：￥2,599.00', '含税金额：2599.00', 'Total Amount: CNY 2,599.00', 'Grand Total\n2599.00', 'Amount Due: 2599.00', 'Invoice Total: 2599.00']) {
    const result = Amounts.extractInvoiceAmount(input);
    assert.equal(result.amount, '2599.00', input); assert.equal(result.confidence, 'low', input);
  }
});

test('ambiguous invoices stay blank and report all conflicting strongest candidates', () => {
  const result = Amounts.extractInvoiceAmount('价税合计（小写）￥109.00\n价税合计（小写）￥219.00');
  assert.equal(result.amount, null); assert.equal(result.cents, null); assert.equal(result.confidence, 'none');
  assert.equal(result.reason, 'ambiguous-totals'); assert.equal(result.candidates.length, 2);
  const sameField = Amounts.extractInvoiceAmount('价税合计：100.00 200.00');
  assert.equal(sameField.amount, null);
});

test('repeated totals retain duplicate evidence without summing them', () => {
  const result = Amounts.extractInvoiceAmount('价税合计（小写）￥109.00\n价税合计（小写）￥109.00');
  assert.equal(result.amount, '109.00'); assert.equal(result.reason, 'repeated-total'); assert.equal(result.duplicateCount, 1);
  assert.equal(result.candidates.length, 2); assert.equal(result.candidates[0].occurrences, 2);
});

test('net, tax and subtotal rows and long invoice IDs never become totals', () => {
  for (const input of ['合计 ￥1000.00 ￥130.00', '税额合计：130.00', '未税总金额：1000.00', '不含税金额：1000.00', 'Net Total: 1000.00', 'Tax Total: 130.00', 'Subtotal: 1000.00', 'Total Amount excluding tax: 1000.00', '总金额：\n发票号码：12345678', '价税合计（大写）壹仟元整\n发票号码：12345678', '总金额：12345678901234567890', '总金额：2026年11月21日']) {
    assert.equal(Amounts.extractInvoiceAmount(input).amount, null, input);
  }
});

test('negative, malformed and overprecision OCR amounts are not salvaged into positive amounts', () => {
  for (const input of ['价税合计：-100.00', '价税合计：¥-100.00', '价税合计：- ¥100.00', '价税合计：(100.00)', '价税合计：1.234', '价税合计：1,23.45', '价税合计：1e3', '总金额：10,000,000,000.00']) assert.equal(Amounts.extractInvoiceAmount(input).amount, null, input);
});

test('Unicode and trailing minus signs cannot be stripped from a negative invoice total', () => {
  for (const minus of ['-', '−', '‐', '‑', '‒', '–', '—', '﹘', '﹣', '－']) {
    for (const amount of [`${minus}100.00`, `${minus} ¥100.00`, `¥${minus}100.00`, `100.00${minus}`, `¥100.00 ${minus}`]) {
      assert.equal(Amounts.parseAmount(amount), null, amount);
      const result = Amounts.extractInvoiceAmount(`价税合计（小写）${amount}`);
      assert.equal(result.cents, null, amount); assert.equal(result.confidence, 'none', amount);
    }
  }
  assert.equal(Amounts.extractInvoiceAmount('价税合计（小写）￥100.00').cents, 10000);
});

test('unreadable stronger totals stay blank instead of falling back to weaker amounts or invoice IDs', () => {
  for (const input of ['金额合计：1000.00\n价税合计（小写）无法辨认', '价税合计：100.00\n价税合计：无法辨认', '总金额：\n电话 12345678', 'Total Amount\nInvoice number 12345678']) {
    const result = Amounts.extractInvoiceAmount(input);
    assert.equal(result.amount, null, input); assert.equal(result.reason, 'unreadable-total', input);
  }
});

test('unlabelled amounts are never guessed or summed', () => {
  assert.equal(Amounts.extractInvoiceAmount('商品A 100.00\n商品B 200.00\n税额 39.00').amount, null);
  assert.equal(Amounts.extractInvoiceAmount('').reason, 'no-text');
  assert.equal(Amounts.extractInvoiceAmount(null).reason, 'no-text');
  const many = Amounts.extractInvoiceAmount(Array(300).fill('价税合计：100.00').join('\n'));
  assert.equal(many.amount, null); assert.equal(many.reason, 'too-many-totals');
});

test('shared amount helpers run in a browser without Node globals', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/invoice-amounts.js'), 'utf8'), context);
  assert.equal(context.MosaicInvoiceAmounts.parseAmount('￥1,234.56'), 123456);
  assert.equal(context.MosaicInvoiceAmounts.extractInvoiceAmount('价税合计（小写）￥113.00').amount, '113.00');
  assert.ok(Object.isFrozen(context.MosaicInvoiceAmounts));
});
