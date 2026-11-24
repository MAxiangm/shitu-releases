'use strict';

const { formatAmount } = require('./invoice-amounts.js');

const TITLES = Object.freeze({
  invoicePdf: '报销发票汇总',
  supplementInvoicePdf: '补票发票汇总',
  supplementPdf: '购买截图说明',
  itineraryPdf: '打车行程单'
});

function reimbursementBundleName(profile, date) {
  const applicant = profile?.applicant ?? '';
  if (typeof applicant !== 'string' || applicant.length > 80) throw new Error('报销申请人姓名无效，最多 80 个字符');
  const name = applicant.normalize('NFC').replace(/[<>:"\\/|?*\p{Cc}]/gu, '_').trim().replace(/[. ]+$/, '') || '未填写申请人';
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('报销日期必须使用 YYYY-MM-DD 格式');
  const timestamp = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString().slice(0, 10) !== date) throw new Error('报销日期无效');
  return `${name}_${date.slice(0, 4)}年${Number(date.slice(5, 7))}月`;
}

function reimbursementPdfName(profile, date, kind, details = {}) {
  if (!Object.prototype.hasOwnProperty.call(TITLES, kind)) throw new Error('报销 PDF 类型无效');
  if (!details || typeof details !== 'object' || Array.isArray(details)) throw new Error('报销 PDF 命名参数无效');
  const parts = [reimbursementBundleName(profile, date), TITLES[kind]];
  if (Number.isSafeInteger(details.count) && details.count >= 0) parts.push(`${details.count}${kind === 'itineraryPdf' ? '页' : '张'}`);
  if (kind === 'invoicePdf' || kind === 'supplementInvoicePdf') {
    if (Number.isFinite(details.pendingCount) && details.pendingCount > 0) parts.push('金额待核对');
    else {
      const amount = formatAmount(details.totalCents);
      if (amount) parts.push(`合计${amount}元`);
    }
  }
  return parts.join('_');
}

module.exports = { reimbursementPdfName, reimbursementBundleName };
