'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reimbursementPdfName, reimbursementBundleName } = require('../src/reimbursement-names.cjs');

test('PDF names use Chinese kinds, applicant, month and appropriate page or image counts', () => {
  const profile = { applicant: '张三' }, date = '2026-11-24';
  assert.equal(reimbursementPdfName(profile, date, 'invoicePdf', { count: 3 }), '张三_2026年11月_报销发票汇总_3张');
  assert.equal(reimbursementPdfName(profile, date, 'supplementInvoicePdf', { count: 2 }), '张三_2026年11月_补票发票汇总_2张');
  assert.equal(reimbursementPdfName(profile, date, 'supplementPdf', { count: 5 }), '张三_2026年11月_购买截图说明_5张');
  assert.equal(reimbursementPdfName(profile, date, 'itineraryPdf', { count: 4 }), '张三_2026年11月_打车行程单_4页');
  assert.equal(reimbursementPdfName(profile, '2026-01-01', 'itineraryPdf'), '张三_2026年1月_打车行程单');
  assert.equal(reimbursementBundleName(profile, date), '张三_2026年11月');
});

test('invoice totals use exact cents and pending amounts suppress even a valid total', () => {
  const profile = { applicant: '李四' }, date = '2024-02-29';
  for (const kind of ['invoicePdf', 'supplementInvoicePdf']) {
    const title = kind === 'invoicePdf' ? '报销发票汇总' : '补票发票汇总';
    assert.equal(reimbursementPdfName(profile, date, kind, { count: 4, totalCents: 12345 }), `李四_2024年2月_${title}_4张_合计123.45元`);
    assert.equal(reimbursementPdfName(profile, date, kind, { count: 4, totalCents: 12345, pendingCount: 1 }), `李四_2024年2月_${title}_4张_金额待核对`);
    assert.equal(reimbursementPdfName(profile, date, kind, { totalCents: 0 }), `李四_2024年2月_${title}_合计0.00元`);
    assert.equal(reimbursementPdfName(profile, date, kind, { totalCents: Number.MAX_SAFE_INTEGER }), `李四_2024年2月_${title}_合计90071992547409.91元`);
    for (const totalCents of [-1, 1.5, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER + 1]) assert.equal(reimbursementPdfName(profile, date, kind, { totalCents }), `李四_2024年2月_${title}`);
  }
  assert.equal(reimbursementPdfName(profile, date, 'supplementPdf', { totalCents: 12345, pendingCount: 1 }), '李四_2024年2月_购买截图说明');
  assert.equal(reimbursementPdfName(profile, date, 'itineraryPdf', { totalCents: 12345, pendingCount: 1 }), '李四_2024年2月_打车行程单');
});

test('applicant names are safe Windows filename components with a clear empty-name fallback', () => {
  const date = '2026-11-24';
  assert.equal(reimbursementBundleName({ applicant: '张/三' }, date), '张_三_2026年11月');
  const sanitized = reimbursementBundleName({ applicant: '张<三>:"\\/|?*\n\t\u0085.  ' }, date);
  assert.match(sanitized, /^张_三_+2026年11月$/);
  assert.ok(!/[<>:"\\/|?*\p{Cc}]/u.test(sanitized));
  for (const applicant of ['', '  ', '.', '...   ']) assert.equal(reimbursementBundleName({ applicant }, date), '未填写申请人_2026年11月');
  assert.equal(reimbursementBundleName(undefined, date), '未填写申请人_2026年11月');
  const full = reimbursementPdfName({ applicant: '名'.repeat(80) }, date, 'invoicePdf', { count: 4, totalCents: 12345 });
  assert.ok(full.startsWith('名'.repeat(80))); assert.ok(!/[<>:"\\/|?*\p{Cc}]/u.test(full)); assert.ok(!/[. ]$/.test(full)); assert.ok(!/\.pdf$/i.test(full));
  assert.throws(() => reimbursementBundleName({ applicant: '名'.repeat(81) }, date), /80/);
  assert.throws(() => reimbursementBundleName({ applicant: 123 }, date), /姓名/);
});

test('date and kind validation prevent malformed names and dates do not depend on local timezone', () => {
  for (const date of ['2026-02-29', '2024-02-30', '2026-13-01', '2026-00-01', '2026-1-01', '2026-11-24T23:00:00Z', null, '2026/11/24']) assert.throws(() => reimbursementBundleName({ applicant: '张三' }, date), /日期/);
  assert.equal(reimbursementBundleName({ applicant: '张三' }, '2026-12-31'), '张三_2026年12月');
  for (const kind of ['', 'pdf', '__proto__', null]) assert.throws(() => reimbursementPdfName({}, '2026-11-24', kind), /类型/);
  assert.throws(() => reimbursementPdfName({}, '2026-11-24', 'invoicePdf', null), /参数/);
  for (const count of [undefined, -1, 1.5, Infinity, '4']) assert.equal(reimbursementPdfName({}, '2026-11-24', 'itineraryPdf', { count }), '未填写申请人_2026年11月_打车行程单');
});
