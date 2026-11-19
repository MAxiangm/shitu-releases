(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituFontLayout = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    width: 1920, height: 1080, fontSize: 72, letterSpacing: 0, lineHeight: 1.55,
    align: 'left', verticalAlign: 'top', writingMode: 'horizontal-tb', paddingTop: 64, paddingRight: 64,
    paddingBottom: 64, paddingLeft: 64, textColor: '#191919',
    backgroundColor: '#eae8e2', transparent: true
  });
  const PRESETS = Object.freeze([
    { id: 'centered-title', name: '居中标题', description: '横排居中，适合标题和主题文字。', settings: { fontSize: 144, letterSpacing: 2, lineHeight: 1.3, align: 'center', verticalAlign: 'center', writingMode: 'horizontal-tb', paddingTop: 108, paddingRight: 192, paddingBottom: 108, paddingLeft: 192 } },
    { id: 'left-body', name: '左对齐正文', description: '舒适的字号和行距，适合多行正文。', settings: { fontSize: 64, letterSpacing: 0, lineHeight: 1.7, align: 'left', verticalAlign: 'top', writingMode: 'horizontal-tb', paddingTop: 108, paddingRight: 160, paddingBottom: 108, paddingLeft: 160 } },
    { id: 'spaced-poster', name: '疏朗海报', description: '大字号和宽字距，适合简短海报文案。', settings: { fontSize: 180, letterSpacing: 20, lineHeight: 1.45, align: 'center', verticalAlign: 'center', writingMode: 'horizontal-tb', paddingTop: 140, paddingRight: 192, paddingBottom: 140, paddingLeft: 192 } },
    { id: 'vertical-title', name: '竖排题字', description: '文字直立竖排，列从右向左，整体居中。', settings: { fontSize: 150, letterSpacing: 14, lineHeight: 1.6, align: 'center', verticalAlign: 'center', writingMode: 'vertical-rl', paddingTop: 108, paddingRight: 192, paddingBottom: 108, paddingLeft: 192 } },
    { id: 'vertical-body', name: '竖排正文', description: '从右向左分列，适合诗句和多列正文。', settings: { fontSize: 72, letterSpacing: 6, lineHeight: 1.8, align: 'right', verticalAlign: 'top', writingMode: 'vertical-rl', paddingTop: 108, paddingRight: 160, paddingBottom: 108, paddingLeft: 160 } }
  ].map(preset => Object.freeze({ ...preset, settings: Object.freeze(preset.settings) })));
  const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  function graphemes(text) {
    if (segmenter) return Array.from(segmenter.segment(text), entry => entry.segment);
    // Array.from keeps surrogate pairs intact; include marks and joined emoji in
    // the preceding cluster on engines without Intl.Segmenter.
    const result = [];
    for (const point of Array.from(text)) {
      if (result.length && (/\p{Mark}|\uFE0F|\u200D/u.test(point) || result[result.length - 1].endsWith('\u200D'))) result[result.length - 1] += point;
      else result.push(point);
    }
    return result;
  }
  function bounded(value, min, max, fallback) {
    const number = value === null || value === '' || typeof value === 'boolean' ? NaN : Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }
  function color(value, fallback) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback; }
  function normalizeSettings(value = {}) {
    if (!value || typeof value !== 'object') value = {};
    const width = Math.round(bounded(value.width, 64, 4096, DEFAULTS.width));
    const height = Math.round(bounded(value.height, 64, 4096, DEFAULTS.height));
    const verticalLimit = Math.floor((height - 1) / 2), horizontalLimit = Math.floor((width - 1) / 2);
    return {
      width, height,
      fontSize: bounded(value.fontSize, 8, 600, DEFAULTS.fontSize),
      letterSpacing: bounded(value.letterSpacing, -20, 100, DEFAULTS.letterSpacing),
      lineHeight: bounded(value.lineHeight, 0.6, 4, DEFAULTS.lineHeight),
      align: ['left', 'center', 'right'].includes(value.align) ? value.align : DEFAULTS.align,
      verticalAlign: ['top', 'center', 'bottom'].includes(value.verticalAlign) ? value.verticalAlign : DEFAULTS.verticalAlign,
      writingMode: ['horizontal-tb', 'vertical-rl', 'vertical-lr'].includes(value.writingMode) ? value.writingMode : DEFAULTS.writingMode,
      paddingTop: bounded(value.paddingTop, 0, verticalLimit, Math.min(DEFAULTS.paddingTop, verticalLimit)),
      paddingRight: bounded(value.paddingRight, 0, horizontalLimit, Math.min(DEFAULTS.paddingRight, horizontalLimit)),
      paddingBottom: bounded(value.paddingBottom, 0, verticalLimit, Math.min(DEFAULTS.paddingBottom, verticalLimit)),
      paddingLeft: bounded(value.paddingLeft, 0, horizontalLimit, Math.min(DEFAULTS.paddingLeft, horizontalLimit)),
      textColor: color(value.textColor, DEFAULTS.textColor),
      backgroundColor: color(value.backgroundColor, DEFAULTS.backgroundColor),
      transparent: typeof value.transparent === 'boolean' ? value.transparent : DEFAULTS.transparent
    };
  }
  function applyPreset(id, input) {
    const preset = PRESETS.find(item => item.id === id);
    if (!preset) throw new Error('未找到排版预设');
    const current = normalizeSettings(input), horizontalScale = current.width / DEFAULTS.width, verticalScale = current.height / DEFAULTS.height;
    const textScale = Math.min(horizontalScale, verticalScale), settings = preset.settings;
    return normalizeSettings({
      ...current, ...settings,
      fontSize: Math.round(settings.fontSize * textScale),
      letterSpacing: Math.round(settings.letterSpacing * textScale * 10) / 10,
      paddingTop: Math.round(settings.paddingTop * verticalScale), paddingBottom: Math.round(settings.paddingBottom * verticalScale),
      paddingLeft: Math.round(settings.paddingLeft * horizontalScale), paddingRight: Math.round(settings.paddingRight * horizontalScale)
    });
  }
  function normalizeText(value) {
    const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/\t/g, '    ') : '';
    let result = '';
    for (const cluster of graphemes(text)) {
      if (result.length + cluster.length > 2000) break;
      result += cluster;
    }
    return result;
  }
  function configureContext(context, settings, fontFamily) {
    context.font = `${settings.fontSize}px ${typeof fontFamily === 'string' && fontFamily.trim() ? fontFamily : 'sans-serif'}`;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.direction = 'ltr';
    if ('fontKerning' in context) context.fontKerning = 'normal';
    if ('letterSpacing' in context) context.letterSpacing = `${settings.writingMode === 'horizontal-tb' ? settings.letterSpacing : 0}px`;
  }
  function measure(context, text, settings) {
    if (!text) return 0;
    const width = context.measureText(text).width;
    const spacing = 'letterSpacing' in context ? 0 : graphemes(text).length * settings.letterSpacing;
    return Math.max(0, width + spacing);
  }
  function wrapParagraph(context, paragraph, settings, width) {
    if (!paragraph) return [''];
    const units = graphemes(paragraph), lines = [];
    let start = 0;
    while (start < units.length) {
      let end = start, lastBreak = -1;
      while (end < units.length) {
        const candidate = units.slice(start, end + 1).join('');
        if (measure(context, candidate, settings) > width && end > start) break;
        end++;
        if (/\s/u.test(units[end - 1])) lastBreak = end;
        if (measure(context, candidate, settings) > width) break;
      }
      if (end < units.length && lastBreak > start) end = lastBreak;
      lines.push(units.slice(start, end).join(''));
      start = end;
    }
    return lines;
  }
  function layoutText(context, text, input, fontFamily) {
    if (!context || typeof context.measureText !== 'function') throw new Error('缺少可用的文字绘制环境');
    const settings = normalizeSettings(input);
    configureContext(context, settings, fontFamily);
    const contentWidth = settings.width - settings.paddingLeft - settings.paddingRight;
    const contentHeight = settings.height - settings.paddingTop - settings.paddingBottom;
    const lineHeight = settings.fontSize * settings.lineHeight;
    if (settings.writingMode !== 'horizontal-tb') return layoutVertical(context, text, settings, contentWidth, contentHeight, lineHeight);
    const wrapped = normalizeText(text).split('\n').flatMap(paragraph => wrapParagraph(context, paragraph, settings, contentWidth));
    const blockHeight = wrapped.length * lineHeight;
    const freeHeight = Math.max(0, contentHeight - blockHeight);
    const offsetY = settings.verticalAlign === 'center' ? freeHeight / 2 : settings.verticalAlign === 'bottom' ? freeHeight : 0;
    const lines = wrapped.map((line, index) => {
      const lineWidth = measure(context, line, settings);
      const offsetX = settings.align === 'center' ? (contentWidth - lineWidth) / 2 : settings.align === 'right' ? contentWidth - lineWidth : 0;
      return { text: line, x: settings.paddingLeft + offsetX, y: settings.paddingTop + offsetY + index * lineHeight, width: lineWidth };
    });
    return { settings, writingMode: settings.writingMode, lines, lineHeight, contentWidth, contentHeight, overflow: blockHeight > contentHeight + 0.01 || lines.some(line => line.width > contentWidth + 0.01) };
  }
  function layoutVertical(context, text, settings, contentWidth, contentHeight, lineHeight) {
    // A cell holds one complete Unicode grapheme. Latin letters and digits remain
    // upright too; tracking is vertical and the line-height multiplier is column spacing.
    const advance = Math.max(1, settings.fontSize + settings.letterSpacing);
    const capacity = Math.max(1, Math.floor((contentHeight - settings.fontSize) / advance) + 1);
    const wrapped = normalizeText(text).split('\n').flatMap(paragraph => {
      const units = graphemes(paragraph), columns = [];
      if (!units.length) return [[]];
      for (let index = 0; index < units.length; index += capacity) columns.push(units.slice(index, index + capacity));
      return columns;
    });
    const blockWidth = (wrapped.length - 1) * lineHeight + settings.fontSize;
    const freeWidth = Math.max(0, contentWidth - blockWidth);
    // When too many columns overflow, keep the first reading column visible;
    // extra right-to-left columns extend to the left instead of hiding the start.
    const offsetX = blockWidth > contentWidth && settings.writingMode === 'vertical-rl' ? contentWidth - blockWidth :
      settings.align === 'center' ? freeWidth / 2 : settings.align === 'right' ? freeWidth : 0;
    const blockLeft = settings.paddingLeft + offsetX;
    const columns = wrapped.map((units, index) => {
      const height = units.length ? settings.fontSize + (units.length - 1) * advance : 0;
      const freeHeight = Math.max(0, contentHeight - height);
      const offsetY = settings.verticalAlign === 'center' ? freeHeight / 2 : settings.verticalAlign === 'bottom' ? freeHeight : 0;
      const x = settings.writingMode === 'vertical-rl' ? blockLeft + blockWidth - settings.fontSize - index * lineHeight : blockLeft + index * lineHeight;
      const y = settings.paddingTop + offsetY;
      const glyphs = units.map((unit, glyphIndex) => ({ text: unit, x, y: y + glyphIndex * advance, width: settings.fontSize, height: settings.fontSize }));
      return { text: units.join(''), x, y, width: settings.fontSize, height, glyphs };
    });
    const glyphs = columns.flatMap(column => column.glyphs);
    return {
      settings, writingMode: settings.writingMode, lines: columns, columns, glyphs,
      lineHeight, contentWidth, contentHeight,
      overflow: blockWidth > contentWidth + 0.01 || columns.some(column => column.height > contentHeight + 0.01)
    };
  }
  function drawLine(context, line, baseline, settings) {
    if ('letterSpacing' in context || settings.letterSpacing === 0) {
      context.fillText(line.text, line.x, baseline);
      return;
    }
    let prefix = '', count = 0;
    for (const cluster of graphemes(line.text)) {
      const x = line.x + context.measureText(prefix).width + count * settings.letterSpacing;
      context.fillText(cluster, x, baseline);
      prefix += cluster; count++;
    }
  }
  function renderCanvas(canvas, text, input, fontFamily) {
    const settings = normalizeSettings(input);
    canvas.width = settings.width; canvas.height = settings.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建文字画布');
    context.clearRect(0, 0, settings.width, settings.height);
    if (!settings.transparent) {
      context.fillStyle = settings.backgroundColor;
      context.fillRect(0, 0, settings.width, settings.height);
    }
    const layout = layoutText(context, text, settings, fontFamily);
    context.fillStyle = settings.textColor;
    const metrics = context.measureText('Mg国');
    const ascent = Number.isFinite(metrics.fontBoundingBoxAscent) ? metrics.fontBoundingBoxAscent : Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : settings.fontSize * 0.8;
    const descent = Number.isFinite(metrics.fontBoundingBoxDescent) ? metrics.fontBoundingBoxDescent : Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : settings.fontSize * 0.2;
    if (settings.writingMode === 'horizontal-tb') {
      const baselineOffset = (layout.lineHeight - ascent - descent) / 2 + ascent;
      for (const line of layout.lines) drawLine(context, line, line.y + baselineOffset, settings);
    } else {
      const baselineOffset = (settings.fontSize - ascent - descent) / 2 + ascent;
      for (const glyph of layout.glyphs) {
        const measured = context.measureText(glyph.text);
        const x = glyph.x + (settings.fontSize - measured.width) / 2;
        context.fillText(glyph.text, x, glyph.y + baselineOffset);
      }
    }
    return layout;
  }
  function applyPreview(sample, text, input, fontFamily) {
    const canvas = sample.ownerDocument.createElement('canvas'), context = canvas.getContext('2d');
    const layout = layoutText(context, text, input, fontFamily), settings = layout.settings;
    const top = layout.lines[0]?.y ?? settings.paddingTop;
    Object.assign(sample.style, {
      width: `${settings.width}px`, height: `${settings.height}px`, boxSizing: 'border-box',
      padding: `${top}px ${settings.paddingRight}px ${settings.paddingBottom}px ${settings.paddingLeft}px`,
      fontFamily: fontFamily || 'sans-serif', fontSize: `${settings.fontSize}px`,
      lineHeight: `${layout.lineHeight}px`, letterSpacing: `${settings.letterSpacing}px`,
      textAlign: settings.align, whiteSpace: 'pre', overflow: 'hidden', fontSynthesis: 'none',
      writingMode: settings.writingMode, textOrientation: 'upright',
      color: settings.textColor, backgroundColor: settings.transparent ? 'transparent' : settings.backgroundColor
    });
    sample.textContent = layout.lines.map(line => line.text).join('\n');
    return layout;
  }
  return { DEFAULTS, PRESETS, applyPreset, normalizeSettings, normalizeText, layoutText, renderCanvas, applyPreview };
});
