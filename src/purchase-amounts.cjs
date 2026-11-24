'use strict';

const { parseAmount, formatAmount } = require('./invoice-amounts.js');

const spaced = value => [...value].join('[ \\t\\n]*');
const actualLabels = ['实付金额', '实付款', '实际支付金额', '实际付款金额', '实际支付', '实际付款', '实付'];
const paymentLabels = ['支付金额', '付款金额', '已支付金额', '已付款金额', '已支付', '已付款'];
const estimatedLabels = ['应付金额', '应付款', '待支付金额', '待付款', '订单总额', '订单金额', '合计金额', '合计', '总计', '总价'];
const labelSource = [...actualLabels, ...paymentLabels, ...estimatedLabels].map(spaced).join('|');
const componentSource = ['优惠', '折扣', '减免', '运费', '邮费', '配送费', '余额', '红包', '抵扣', '积分', '返现', '退款', '礼品卡', '储值卡', '钱包', '账户', '银行卡', '订单号', '订单编号', '交易号', '交易单号', '商户单号', '付款方式', '支付方式', '支付时间', '付款时间', '创建时间', '收货', '地址', '电话'].map(spaced).join('|');
const stopPattern = new RegExp(`${labelSource}|${componentSource}`, 'i');
const componentPrefix = /(?:优惠|折扣|减免|运费|邮费|配送费|余额|红包|抵扣|积分|返现|退款|礼品卡|储值卡|钱包|账户|银行卡)[ \t:：()]*$/;
const foreignCurrency = /[$€£₩₹₽฿₫₱₺]|\b(?:USD|EUR|GBP|JPY|HKD|MOP|TWD|KRW|AUD|CAD|SGD|NZD|CHF|RUB|THB|VND|MYR|INR|PHP|IDR|BRL|dollars?|euros?|yen)\b|美元|美金|港[币元]|澳门[币元]|澳[币元]|台[币幣]|新台币|日[币元]|韩[币元]|欧元|英镑|新加坡[币元]|加[币元]/i;
const normalize = value => value.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[−‐‑‒–—﹘﹣]/g, '-').replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '');
const empty = (reason, candidates = []) => ({ amount: null, cents: null, confidence: 'none', reason, candidates, duplicateCount: 0 });
const receiptNumber = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)[ \\t]*[.·][ \\t]*\\d{2}';

function receiptCents(value) {
  return parseAmount(value.replace(/[ \t]*[.·][ \t]*/, '.'));
}

function paymentReceiptCandidates(text) {
  const lines = text.split('\n').map(line => line.trim()), candidates = [], unreadable = [];
  const add = (cents, label, index) => candidates.push({ amount: formatAmount(cents), cents, label, priority: 4, line: index + 1, raw: lines[index] });
  // An outgoing WeChat transfer says “已被接收”. Receiving money instead says
  // “已收款/收款成功”; neither a chat quotation nor that incoming state is proof
  // of an outgoing payment. Require the currency line inside the small card.
  const cardAmount = new RegExp(`^[¥￥][ \\t]*(${receiptNumber})[ \\t]*(?:元)?$`);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== '已被接收') continue;
    const nearby = lines.slice(Math.max(0, index - 2), index + 3);
    if (!nearby.some(line => /^(?:微信)?转账$/.test(line))) continue;
    if (nearby.some(line => /退款|退回|退还|已收款|收款成功/.test(line))) { unreadable.push(4); continue; }
    const amounts = [];
    for (let at = Math.max(0, index - 2); at < index; at++) {
      const match = cardAmount.exec(lines[at]);
      if (match) { const cents = receiptCents(match[1]); if (cents !== null) amounts.push({ cents, at }); }
    }
    if (amounts.length === 1) add(amounts[0].cents, '已被接收的转账', amounts[0].at);
    else unreadable.push(4);
  }
  // Some bill screenshots OCR as label and value columns. A completed debit,
  // one standalone negative entry and the explicitly yuan-denominated order
  // amount must all agree. The foreign-currency annotation is never converted.
  if (/账单详情/.test(text) && /收入|已收款|收款成功|退款|退回|退还/.test(text)) unreadable.push(4);
  else if (/账单详情/.test(text) && /(?:自动扣款成功|扣款成功)/.test(text) && /订单金额/.test(text)) {
    const debitPattern = new RegExp(`^(?:[-一][ \\t]*[¥￥]?|[¥￥][ \\t]*-)[ \\t]*(${receiptNumber})[ \\t]*(?:元)?$`);
    const orderPattern = new RegExp(`^(?:订单金额[ \\t:：]*)?(?:人民币|CNY|RMB|[¥￥])?[ \\t]*(${receiptNumber})[ \\t]*(?:元|人民币)(?:[ \\t]*\\([ \\t]*${receiptNumber}[ \\t]*(?:美元|美金|欧元|英镑|港元|港币|日元|USD|EUR|GBP|HKD|JPY)[ \\t]*\\))?$`, 'i');
    const debits = [], orders = [];
    for (const [index, line] of lines.entries()) {
      const debit = debitPattern.exec(line), order = orderPattern.exec(line);
      if (debit) { const cents = receiptCents(debit[1]); if (cents !== null) debits.push({ cents, index }); }
      if (order) { const cents = receiptCents(order[1]); if (cents !== null) orders.push({ cents, index }); }
    }
    if (debits.length === 1 && orders.length === 1 && debits[0].cents === orders[0].cents && debits[0].cents > 0) add(orders[0].cents, '已扣款的人民币订单金额', orders[0].index);
    else unreadable.push(4);
  }
  return { candidates, unreadable };
}

function moneyTokens(value, strongPaidLabel = false) {
  if (/[+\-*/=×÷%]/.test(value)) return [];
  // Windows OCR can split a single integer into "¥ 1 28". Only repair an
  // entire one-line currency field under a paid label, with a one-digit first
  // fragment and short remaining fragments. Do not merge normal independent
  // amounts such as "¥ 100 200", decimals, signs or multiple currency marks.
  const integerFragments = strongPaidLabel && /^[¥￥][ \t]*(\d(?:[ \t]+\d{1,2})+)[ \t]*(?:元)?$/.exec(value.trim());
  if (integerFragments) {
    const cents = parseAmount(`¥${integerFragments[1].replace(/[ \t]/g, '')}`);
    if (cents !== null) return [{ raw: value.trim(), cents }];
  }
  if (/[¥￥][ \t]*\d+[ \t]+\d/.test(value)) return [];
  // Broken decimals/grouping, accounting negatives and malformed precision
  // remain unresolved; never salvage a later fragment as the paid amount.
  if (/\d[.,][ \t\n]+\d|\d[ \t\n]+[.,][ \t\n]*\d/.test(value)) return [];
  const tokens = [];
  const pattern = /(?<![A-Za-z0-9_.,+\-])(?:[¥￥]\s*)?[+\-]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[ \t]*元)?(?![A-Za-z0-9_.,+\-])/g;
  for (const match of value.matchAll(pattern)) {
    const raw = match[0].trim(), before = value.slice(0, match.index), after = value.slice(match.index + match[0].length);
    if (/^[ \t]*(?:%|年|月|日|号|张|件|个)/.test(after)) continue;
    if (/[+\-][ \t\n]*$/.test(before) || /^[ \t\n]*[+\-]/.test(after) || (/\([ \t\n]*$/.test(before) && /^[ \t\n]*\)/.test(after))) continue;
    if (!/[¥￥.,]/.test(raw) && raw.replace(/\D/g, '').length > 8) continue;
    const cents = parseAmount(raw);
    if (cents !== null) tokens.push({ raw, cents });
  }
  return tokens;
}

function extractPurchaseAmount(input) {
  if (typeof input !== 'string' || !input.trim()) return empty('no-text');
  if (input.length > 1_000_000) return empty('text-too-large');
  const text = normalize(input), receipts = paymentReceiptCandidates(text);
  const candidates = receipts.candidates, unreadable = receipts.unreadable, foreign = [];
  let fields = 0;
  for (const match of text.matchAll(new RegExp(labelSource, 'g'))) {
    if (++fields > 256) return empty('too-many-totals', candidates);
    const label = match[0].replace(/\s/g, '');
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    const prefix = text.slice(lineStart, match.index);
    const priorContext = text.slice(Math.max(0, match.index - 32), match.index).replace(/[ \t\n]/g, '');
    if (componentPrefix.test(priorContext) || /(?:价税|税额|税费|小)$/.test(priorContext)) continue;
    let priority = actualLabels.includes(label) ? 4 : paymentLabels.includes(label) ? 3 : 1;
    // A checkout estimate is not proof that money was paid.
    if (/(?:待|应|预计|预估|需)$/.test(priorContext)) priority = 1;
    const start = match.index + match[0].length;
    let value = text.slice(start, start + 240).replace(/^[ \t\n:：]*/, '');
    const stop = value.search(stopPattern);
    if (stop >= 0) value = value.slice(0, stop);
    value = value.split('\n').slice(0, 2).join('\n');
    // Currency symbols/codes are semantic: an explicit foreign amount must
    // remain unconfirmed rather than silently being relabelled as yuan.
    const previousLine = text.slice(0, Math.max(0, lineStart - 1)).split('\n').at(-1) || '';
    if (foreignCurrency.test(value) || foreignCurrency.test(prefix) || (/^(?:支付)?币种[ \t:：]/.test(previousLine.trim()) && foreignCurrency.test(previousLine))) {
      foreign.push(priority); continue;
    }
    const tokens = moneyTokens(value, priority >= 3);
    if (!tokens.length) unreadable.push(priority);
    for (const token of tokens) candidates.push({ amount: formatAmount(token.cents), cents: token.cents, label, priority,
      line: text.slice(0, match.index).split('\n').length, raw: token.raw });
  }
  if (!candidates.length) return empty(foreign.length ? 'unsupported-currency' : unreadable.length ? 'unreadable-total' : 'no-paid-label');
  if (candidates.length > 256) return empty('too-many-totals', candidates.slice(0, 256));
  const priority = Math.max(...candidates.map(candidate => candidate.priority));
  const preferred = candidates.filter(candidate => candidate.priority === priority);
  const counts = new Map();
  for (const candidate of candidates) counts.set(candidate.cents, (counts.get(candidate.cents) || 0) + 1);
  for (const candidate of candidates) candidate.occurrences = counts.get(candidate.cents);
  const duplicateCount = [...counts.values()].reduce((sum, count) => sum + count - 1, 0);
  if (foreign.some(value => value >= priority)) return { ...empty('unsupported-currency', candidates), duplicateCount };
  if (unreadable.some(value => value >= priority)) return { ...empty('unreadable-total', candidates), duplicateCount };
  if (new Set(preferred.map(candidate => candidate.cents)).size !== 1) return { ...empty('ambiguous-totals', candidates), duplicateCount };
  const chosen = preferred[0];
  return { amount: chosen.amount, cents: chosen.cents, confidence: priority >= 3 ? 'high' : 'low', label: chosen.label,
    reason: preferred.length > 1 ? 'repeated-total' : 'labelled-total', candidates, duplicateCount };
}

module.exports = { extractPurchaseAmount };
