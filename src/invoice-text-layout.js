(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MosaicInvoiceTextLayout = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_MAX_TEXT_CHARS = 100000;
  const validMatrix = value => Array.isArray(value) && value.length === 6 && value.every(Number.isFinite);
  const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

  function separator(left, right) {
    const gap = right.x - left.end, height = Math.min(left.height, right.height);
    // Adjacent monetary columns must stay separate even when their bounding
    // boxes nearly touch. A split decimal ("998", ".", "00") still rejoins.
    if (/\d[.,]\d{2}$/.test(left.text) && /^\d+[.,]\d{2}(?:\D|$)/.test(right.text)) return ' ';
    if (gap <= height * 0.1) return '';
    if (gap <= height * 0.4 && (/[\d.,￥¥]$/.test(left.text) && /^[\d.,￥¥]/.test(right.text) ||
        /\p{Script=Han}$/u.test(left.text) && /^\p{Script=Han}/u.test(right.text))) return '';
    if (gap <= height * 0.5 && (/[（(]$/.test(left.text) || /^[）),，。:：]/.test(right.text))) return '';
    return ' ';
  }

  function layoutTextItems(items, { viewport, maxTextChars = DEFAULT_MAX_TEXT_CHARS } = {}) {
    if (!Array.isArray(items) || !Number.isSafeInteger(maxTextChars) || maxTextChars < 1) throw new Error('PDF 文字布局参数无效');
    const view = validMatrix(viewport?.transform) ? viewport.transform : [1, 0, 0, -1, 0, 0];
    const fragments = [], unpositioned = [], weights = [0, 0, 0, 0];
    let length = 0;
    for (const [index, item] of items.entries()) {
      if (typeof item?.str !== 'string') continue;
      length += item.str.length + 1;
      if (length > maxTextChars) throw new Error('PDF 页面文字超过处理上限');
      const text = item.str.replace(/\s+/gu, ' ').trim();
      if (!text) continue;
      if (!validMatrix(item.transform)) { unpositioned.push(text); continue; }
      const matrix = multiply(view, item.transform), baseline = Math.hypot(matrix[0], matrix[1]);
      if (!matrix.every(Number.isFinite) || !baseline) { unpositioned.push(text); continue; }
      const angle = Math.atan2(matrix[1], matrix[0]);
      const quadrant = (Math.round(angle / (Math.PI / 2)) + 4) % 4;
      weights[quadrant] += text.length;
      const originalBaseline = Math.hypot(item.transform[0], item.transform[1]);
      const width = Number.isFinite(item.width) && item.width >= 0 && originalBaseline
        ? item.width * baseline / originalBaseline : text.length * baseline * 0.5;
      const height = Math.max(0.5, Math.hypot(matrix[2], matrix[3]) ||
        (Number.isFinite(item.height) ? Math.abs(item.height) * Math.hypot(view[2], view[3]) : 0) || baseline);
      fragments.push({ text, index, matrix, angle, width, height });
    }
    // Deskew the dominant orthogonal text direction after applying PDF.js's
    // viewport rotation. This also covers pages carrying /Rotate 90/180/270.
    const quadrant = weights.indexOf(Math.max(...weights)), rotation = quadrant * Math.PI / 2;
    const cosine = Math.cos(rotation), sine = Math.sin(rotation);
    for (const fragment of fragments) {
      const { matrix, angle, width } = fragment;
      const start = matrix[4] * cosine + matrix[5] * sine;
      const advance = width * Math.cos(angle - rotation);
      fragment.x = Math.min(start, start + advance);
      fragment.end = Math.max(start, start + advance);
      fragment.y = -matrix[4] * sine + matrix[5] * cosine;
    }
    fragments.sort((left, right) => left.y - right.y || left.x - right.x || left.index - right.index);
    const lines = [];
    for (const fragment of fragments) {
      let line, distance = Infinity;
      for (let index = lines.length - 1; index >= Math.max(0, lines.length - 8); index--) {
        const candidate = lines[index], delta = Math.abs(candidate.y - fragment.y);
        const tolerance = Math.max(1, Math.min(candidate.height, fragment.height) * 0.4);
        if (delta <= tolerance && delta < distance) { line = candidate; distance = delta; }
      }
      if (line) line.fragments.push(fragment);
      else lines.push({ y: fragment.y, height: fragment.height, fragments: [fragment] });
    }
    lines.sort((left, right) => left.y - right.y);
    const text = [...lines.map(line => {
      line.fragments.sort((left, right) => left.x - right.x || left.index - right.index);
      return line.fragments.map((fragment, index, row) => (index ? separator(row[index - 1], fragment) : '') + fragment.text).join('');
    }), ...unpositioned].join('\n').trim();
    if (text.length > maxTextChars) throw new Error('PDF 页面文字超过处理上限');
    return text;
  }

  return Object.freeze({ layoutTextItems, DEFAULT_MAX_TEXT_CHARS });
});
