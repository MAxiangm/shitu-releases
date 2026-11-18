'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../src/batch-rename.js');
const asset = (name, index = 1) => ({ id: `asset-${index}`, name, ext: 'png', hash: String(index).padStart(64, '0') });
test('batch rename produces literal replacements and affixes without altering extensions or source data', () => {
  const input = [asset('image.image'), asset('image$&', 2)], before = structuredClone(input);
  const result = plan(input, { find: 'image', replace: '$&[new]', prefix: '项目_', suffix: '_成品' });
  assert.equal(result.valid, true);
  assert.deepEqual(result.changes.map(item => item.name), ['项目_$&[new].$&[new]_成品', '项目_$&[new]$&_成品']);
  assert.equal(result.rows[0].ext, 'png'); assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(result.changes[0]).sort(), ['beforeName', 'hash', 'id', 'name']);
});
test('numbering follows selection order and supports appended and number-only names', () => {
  const input = [asset('Z'), asset('A', 2), asset('C', 3)];
  assert.deepEqual(plan(input, { numbering: true, start: 8, digits: 3 }).changes.map(item => item.name), ['Z_008', 'A_009', 'C_010']);
  assert.deepEqual(plan(input, { prefix: '镜头-', suffix: '-最终', numbering: true, start: 99, digits: 2, numberMode: 'replace' }).changes.map(item => item.name), ['镜头-99-最终', '镜头-100-最终', '镜头-101-最终']);
});
test('no-op plans cannot silently rename and empty find does not insert replacements', () => {
  const input = [asset('Original')];
  assert.equal(plan(input).changedCount, 0);
  assert.equal(plan(input, { find: '', replace: 'BAD' }).changedCount, 0);
  assert.equal(plan(input, { find: 'original', replace: 'x' }).changedCount, 0);
});
test('invalid names invalidate the entire plan instead of saving a partial batch', () => {
  for (const options of [{ find: 'A', replace: '' }, { prefix: 'x'.repeat(240) }, { suffix: '\nBAD' }]) {
    const result = plan([asset('A'), asset('B', 2)], options);
    assert.equal(result.valid, false); assert.equal(result.changes.length, 0); assert.ok(result.errors.length);
  }
  assert.equal(plan([asset('x'.repeat(240))], { find: 'missing' }).valid, true);
});
test('numbering rejects invalid ranges and never truncates overflowing digit width', () => {
  for (const options of [{ start: -1 }, { start: NaN }, { start: 1.5 }, { start: 999999999 }, { digits: 0 }, { digits: 11 }, { numberMode: 'bad' }]) {
    assert.equal(plan([asset('A'), asset('B', 2)], { numbering: true, ...options }).valid, false);
  }
  assert.equal(plan([asset('A')], { numbering: true, start: 0, digits: 2 }).changes[0].name, 'A_00');
});
test('duplicate names warn without blocking a supported metadata rename', () => {
  const result = plan([asset('A'), asset('B', 2)], { numbering: true, numberMode: 'replace', start: 1 });
  assert.equal(result.warnings.length, 0);
  const same = plan([asset('A'), asset('B', 2)], { find: 'B', replace: 'A' });
  assert.equal(same.valid, true); assert.equal(same.changedCount, 1); assert.equal(same.warnings.length, 1);
});
test('malformed assets and rule values fail without partial or executable output', () => {
  for (const input of [[], [asset('A'), asset('B')], [{ ...asset('A'), hash: 'bad' }], [{ ...asset('A'), id: '../../x' }]]) assert.equal(plan(input).valid, false);
  assert.equal(plan([asset('A')], { prefix: 1 }).valid, false);
  assert.equal(plan([asset('A')], { numbering: 'true' }).valid, false);
  const literal = plan([asset('<img src=x onerror=alert(1)>')], { prefix: '<b>' });
  assert.equal(literal.changes[0].name, '<b><img src=x onerror=alert(1)>');
});
