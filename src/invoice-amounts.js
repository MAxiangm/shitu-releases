(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MosaicInvoiceAmounts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_AMOUNT_CENTS = 999999999999;
  const normalize = value => value.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/−/g, '-');

  // Strings are yuan; numeric values accepted by totalAmounts are already cents.
  // Never convert yuan through floating point, including while formatting totals.
  function parseAmount(value) {
    if (typeof value !== 'string' || value.length > 80) return null;
    const match = normalize(value).trim().match(/^(?:[¥￥]\s*)?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?(?:\s*元)?$/);
    if (!match) return null;
    const cents = BigInt(match[1].replace(/,/g, '')) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
    return cents <= BigInt(MAX_AMOUNT_CENTS) ? Number(cents) : null;
  }

  function formatAmount(cents) {
    if (!Number.isSafeInteger(cents) || cents < 0) return '';
    const value = BigInt(cents);
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  function totalAmounts(values) {
    if (!Array.isArray(values)) throw new TypeError('金额列表无效');
    let sum = 0n;
    let validCount = 0;
    const invalidIndices = [];
    values.forEach((value, index) => {
      const cents = typeof value === 'string' ? parseAmount(value) : Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT_CENTS ? value : null;
      if (cents === null) invalidIndices.push(index);
      else { sum += BigInt(cents); validCount++; }
    });
    if (sum > BigInt(Number.MAX_SAFE_INTEGER)) return { cents: null, amount: null, validCount, invalidIndices, reason: 'overflow' };
    const cents = Number(sum);
    return { cents, amount: formatAmount(cents), validCount, invalidIndices };
  }

  const vatLabelSource = '价[ \\t\\n]*税[ \\t\\n]*合[ \\t\\n]*计';
  const genericLabelSource = '(?:应付总额|实付总额|含税总额|含税金额|总计金额|总金额|合计金额|金额合计|总计|总额|\\btotal\\s*amount\\b|\\bgrand\\s*total\\b|\\bamount\\s*due\\b|\\binvoice\\s*total\\b|\\btotal\\b)';
  const stopLabelSource = `(?:${vatLabelSource}|${genericLabelSource}|发票号码|发票代码|票据号码|订单号|开票日期|购买方|销售方|开票人|收款人|复核人|校验码|纳税人识别号|账号|电话|地址|开户行|备注|税额|税率|净额|未税金额|不含税金额|小计|\\b(?:invoice|bill)\\s*(?:number|no\\.?|id)\\b|\\bdate\\b|\\baccount\\b|\\bsubtotal\\b|\\btax\\s*(?:amount|total)\\b|\\bnet\\s*(?:amount|total)\\b)`;

  function fieldWindow(text, start, maximumLines, vat = false) {
    let value = text.slice(start, start + 240);
    const stop = value.search(new RegExp(stopLabelSource, 'i'));
    if (stop >= 0) value = value.slice(0, stop);
    if (vat) {
      // Only line breaks inside known 大写/小写 labels are structural label
      // fragments. Keep all original offsets and the same body-line limit.
      const labelBreaks = new Set();
      for (const match of value.matchAll(/(?:\([ \t\n]*)?[大小][ \t\n]*写(?:[ \t\n]*\))?/g)) {
        for (let index = 0; index < match[0].length; index++) if (match[0][index] === '\n') labelBreaks.add(match.index + index);
      }
      let lines = 1;
      for (let index = 0; index < value.length; index++) if (value[index] === '\n' && !labelBreaks.has(index) && ++lines > maximumLines) return value.slice(0, index);
      return value;
    }
    return value.split('\n').slice(0, maximumLines).join('\n');
  }

  function moneyTokens(value) {
    const tokens = [];
    // Never salvage the tail of a number split around its decimal/grouping
    // separator (e.g. "113.\n45" or "1, 130.00"). Such a field needs review.
    if (/\d[.,][ \t\n]+\d|\d[ \t\n]+[.,][ \t\n]*\d/.test(value)) return tokens;
    // Consume malformed precision and signed numbers as a whole so a fragment
    // of "-100.00" or "1.234" cannot silently become a valid positive amount.
    const regex = /(?<![A-Za-z0-9_.,+\-])(?:[¥￥]\s*)?[+\-]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[ \t]*元)?(?![A-Za-z0-9_.,])/g;
    for (const match of value.matchAll(regex)) {
      const raw = match[0].trim();
      const preceding = value.slice(0, match.index);
      const following = value.slice(match.index + match[0].length);
      if (/^[ \t]*(?:%|年|月|日|号|张|个)/.test(following)) continue;
      if (/[+\-][ \t]*$/.test(preceding) || (/\([ \t]*$/.test(preceding) && /^[ \t]*\)/.test(following))) continue;
      // Long bare numbers are usually invoice IDs, account numbers or dates.
      if (!/[¥￥.,]/.test(raw) && raw.replace(/\D/g, '').length > 8) continue;
      const cents = parseAmount(raw);
      if (cents !== null) tokens.push({ raw, cents, offset: match.index + match[0].length - match[0].trimStart().length });
    }
    return tokens;
  }

  function empty(reason, candidates = []) {
    return { amount: null, cents: null, confidence: 'none', reason, candidates, duplicateCount: 0 };
  }

  function extractInvoiceAmount(input) {
    if (typeof input !== 'string' || !input.trim()) return empty('no-text');
    if (input.length > 1_000_000) return empty('text-too-large');
    // OCR often inserts spaces between Chinese characters, including the label.
    const text = normalize(input).replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '');
    const lineStarts = [0];
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lineStarts.push(index + 1);
    const lineNumber = position => {
      let low = 0, high = lineStarts.length;
      while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (lineStarts[middle] <= position) low = middle; else high = middle; }
      return low + 1;
    };
    const candidates = [];
    const unreadable = [];
    let tooManyCandidates = false;
    const add = (label, priority, start, value) => {
      const tokens = moneyTokens(value);
      if (!tokens.length) unreadable.push(priority);
      for (const token of tokens) {
        if (candidates.length >= 256) { tooManyCandidates = true; return; }
        const position = start + token.offset;
        candidates.push({ amount: formatAmount(token.cents), cents: token.cents, label, priority, line: lineNumber(position), raw: token.raw });
      }
    };

    for (const match of text.matchAll(new RegExp(vatLabelSource, 'g'))) {
      if (tooManyCandidates) break;
      let start = match.index + match[0].length;
      // Blank space before the field body does not consume its four lines.
      start += /^[ \t\n]*/.exec(text.slice(start))[0].length;
      const value = fieldWindow(text, start, 4, true);
      const small = /(?:\([ \t\n]*)?小[ \t\n]*写(?:[ \t\n]*\))?[ \t\n]*[:：]?/.exec(value);
      if (small) {
        const offset = small.index + small[0].length;
        add('价税合计（小写）', 4, start + offset, value.slice(offset));
      } else if (!/大[ \t\n]*写/.test(value)) add('价税合计', 3, start, value);
      else unreadable.push(3);
    }

    for (const match of text.matchAll(new RegExp(genericLabelSource, 'gi'))) {
      if (tooManyCandidates) break;
      const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
      const prefix = text.slice(Math.max(lineStart, match.index - 20), match.index);
      if (/(?:不含税|未税|税前|净额|净价|税额|税金|小计|sub|net|tax)[ \t:：]*$/i.test(prefix)) continue;
      if (/^含税/.test(match[0]) && /[不未][ \t]*$/.test(prefix)) continue;
      const start = match.index + match[0].length;
      const value = fieldWindow(text, start, 2);
      if (/^[ \t:：()]*?(?:不含税|未税|税前|without\s+tax|excluding\s+tax|before\s+tax|net\b|tax\b|vat\b)/i.test(value)) continue;
      add(match[0], 2, start, value);
    }

    if (tooManyCandidates) return empty('too-many-totals', candidates);
    if (!candidates.length) return empty(unreadable.length ? 'unreadable-total' : 'no-total-label');
    const highest = Math.max(...candidates.map(candidate => candidate.priority));
    const preferred = candidates.filter(candidate => candidate.priority === highest);
    const values = new Set(preferred.map(candidate => candidate.cents));
    const counts = new Map();
    for (const candidate of candidates) counts.set(candidate.cents, (counts.get(candidate.cents) || 0) + 1);
    for (const candidate of candidates) candidate.occurrences = counts.get(candidate.cents);
    const duplicateCount = [...counts.values()].reduce((sum, count) => sum + count - 1, 0);
    if (unreadable.some(priority => priority >= highest)) return { ...empty('unreadable-total', candidates), duplicateCount };
    if (values.size !== 1) return { ...empty('ambiguous-totals', candidates), duplicateCount };
    const chosen = preferred[0];
    return { amount: chosen.amount, cents: chosen.cents, confidence: highest >= 3 ? 'high' : 'low', label: chosen.label, reason: preferred.length > 1 ? 'repeated-total' : 'labelled-total', candidates, duplicateCount };
  }

  return Object.freeze({ MAX_AMOUNT_CENTS, parseAmount, formatAmount, totalAmounts, extractInvoiceAmount });
});
