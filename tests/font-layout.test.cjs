'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, PRESETS, applyPreset, normalizeSettings, normalizeText, layoutText, renderCanvas } = require('../src/font-layout.js');

function context() {
  return {
    draws: [], clears: [], fills: [],
    measureText(text) { return { width: Array.from(text).filter(char => !/\p{Mark}/u.test(char)).length * 10, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }; },
    fillText(...args) { this.draws.push(args); },
    clearRect(...args) { this.clears.push(args); },
    fillRect(...args) { this.fills.push(args); }
  };
}
const base = { width: 120, height: 100, fontSize: 10, lineHeight: 2, paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 };

test('font layout normalizes bounded artboard settings and rejects unsafe colors', () => {
  assert.deepEqual(normalizeSettings(), DEFAULTS);
  const value = normalizeSettings({ width: 1, height: 99999, fontSize: 900, letterSpacing: -99, lineHeight: 0, paddingTop: Infinity, paddingLeft: 1000, align: 'justify', verticalAlign: 'middle', textColor: 'url(x)', backgroundColor: '#AABBCC', transparent: 'false' });
  assert.equal(value.width, 64); assert.equal(value.height, 4096); assert.equal(value.fontSize, 600);
  assert.equal(value.letterSpacing, -20); assert.equal(value.lineHeight, 0.6); assert.equal(value.paddingLeft, 31);
  assert.equal(value.paddingTop, 64); assert.equal(value.align, 'left'); assert.equal(value.verticalAlign, 'top');
  assert.equal(value.textColor, '#191919'); assert.equal(value.backgroundColor, '#aabbcc'); assert.equal(value.transparent, true);
  assert.equal(normalizeSettings({ fontSize: NaN }).fontSize, 72);
  assert.equal(normalizeSettings(null).width, 1920);
});

test('text normalizes newlines and tabs and truncates without splitting Unicode graphemes', () => {
  assert.equal(normalizeText('a\r\nb\rc\td'), 'a\nb\nc    d');
  assert.equal(normalizeText('a'.repeat(1999) + '👩‍👩‍👧‍👦'), 'a'.repeat(1999));
  assert.equal(normalizeText('a'.repeat(1999) + 'e\u0301'), 'a'.repeat(1999));
  assert.equal(normalizeText({}), '');
});

test('line wrapping preserves explicit newlines, trailing blanks and spaces', () => {
  const layout = layoutText(context(), 'one two three\n\nend\n', base, 'Test');
  assert.deepEqual(layout.lines.map(line => line.text), ['one two ', 'three', '', 'end', '']);
  assert.equal(layout.lines.map(line => line.text).slice(0, 2).join(''), 'one two three');
  assert.equal(layout.overflow, true);
  assert.deepEqual(layoutText(context(), '          x', base, 'Test').lines.map(line => line.text), ['          ', 'x']);
});

test('wrapping retains combined marks and emoji as indivisible units', () => {
  const layout = layoutText(context(), 'e\u0301👨‍👩‍👧‍👦x', { ...base, width: 64, paddingLeft: 20, paddingRight: 20 }, 'Test');
  assert.deepEqual(layout.lines.map(line => line.text), ['e\u0301', '👨‍👩‍👧‍👦', 'x']);
  assert.equal(layout.overflow, true);
});

test('alignment uses the content rectangle and overflowing blocks keep their first line visible', () => {
  const middle = layoutText(context(), 'abcd\nx', { ...base, align: 'center', verticalAlign: 'center' }, 'Test');
  assert.deepEqual(middle.lines.map(({ x, y }) => ({ x, y })), [{ x: 40, y: 30 }, { x: 55, y: 50 }]);
  assert.equal(middle.overflow, false);
  const right = layoutText(context(), 'abcd', { ...base, align: 'right', verticalAlign: 'bottom' }, 'Test');
  assert.equal(right.lines[0].x, 70); assert.equal(right.lines[0].y, 70);
  const tall = layoutText(context(), 'a\nb\nc\nd\ne', { ...base, verticalAlign: 'bottom' }, 'Test');
  assert.equal(tall.lines[0].y, 10); assert.equal(tall.overflow, true);
});

test('letter spacing participates in wrapping and the renderer writes transparent or solid artboards', () => {
  const spaced = layoutText(context(), 'abcdefghij', { ...base, letterSpacing: 5 }, 'Test');
  assert.deepEqual(spaced.lines.map(line => line.text), ['abcdef', 'ghij']);
  const ctx = context(), canvas = { getContext: () => ctx };
  const layout = renderCanvas(canvas, 'ab', base, 'Test');
  assert.equal(canvas.width, 120); assert.equal(canvas.height, 100); assert.equal(ctx.fills.length, 0);
  assert.deepEqual(ctx.clears, [[0, 0, 120, 100]]); assert.deepEqual(ctx.draws, [['ab', 10, 23]]);
  assert.equal(ctx.font, '10px Test'); assert.equal(layout.lines[0].width, 20);
  renderCanvas(canvas, 'ab', { ...base, transparent: false, backgroundColor: '#123456' }, 'Test');
  assert.equal(ctx.fills.length, 1);
});

test('native canvas letter spacing is configured and is not counted twice', () => {
  const ctx = context(); ctx.letterSpacing = '0px';
  ctx.measureText = function (text) { return { width: text.length * (10 + parseFloat(this.letterSpacing)), actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }; };
  const layout = layoutText(ctx, 'abcd', { ...base, letterSpacing: 2 }, 'Test');
  assert.equal(ctx.letterSpacing, '2px'); assert.equal(layout.lines[0].width, 48);
});

test('vertical text wraps top-to-bottom into right-to-left or left-to-right columns', () => {
  const options = { ...base, width: 120, height: 64, fontSize: 20, lineHeight: 1.5, letterSpacing: 4, writingMode: 'vertical-rl' };
  const rtl = layoutText(context(), '天地玄黄宇宙', options, 'Test');
  assert.deepEqual(rtl.columns.map(column => column.text), ['天地', '玄黄', '宇宙']);
  assert.deepEqual(rtl.columns.map(column => column.x), [70, 40, 10]);
  assert.deepEqual(rtl.columns[0].glyphs.map(glyph => glyph.y), [10, 34]);
  assert.equal(rtl.overflow, false);
  const ltr = layoutText(context(), '天地玄黄宇宙', { ...options, writingMode: 'vertical-lr' }, 'Test');
  assert.deepEqual(ltr.columns.map(column => column.x), [10, 40, 70]);
  assert.deepEqual(ltr.columns.map(column => column.text), rtl.columns.map(column => column.text));
  assert.equal(normalizeSettings({ writingMode: 'sideways-rl' }).writingMode, 'horizontal-tb');
});

test('vertical columns preserve newlines and graphemes and align their blocks independently', () => {
  const options = { ...base, fontSize: 20, lineHeight: 1.5, writingMode: 'vertical-rl', align: 'right', verticalAlign: 'bottom' };
  const layout = layoutText(context(), '天\n\ne\u0301👩‍👩‍👧‍👦\n', options, 'Test');
  assert.deepEqual(layout.columns.map(column => column.text), ['天', '', 'e\u0301👩‍👩‍👧‍👦', '']);
  assert.equal(layout.glyphs.length, 3); assert.equal(layout.glyphs[2].text, '👩‍👩‍👧‍👦');
  assert.deepEqual(layout.columns.map(column => column.y), [70, 90, 50, 90]);
  assert.equal(layout.overflow, true, 'Four column cells exceed the available content width');
  const aligned = layoutText(context(), '天\n地', { ...options, align: 'center', verticalAlign: 'center' }, 'Test');
  assert.deepEqual(aligned.columns.map(column => column.x), [65, 35]);
  assert.deepEqual(aligned.columns.map(column => column.y), [40, 40]);
});

test('vertical glyphs render upright with tracking only on the vertical axis', () => {
  const ctx = context(); ctx.letterSpacing = '4px';
  const canvas = { getContext: () => ctx };
  const layout = renderCanvas(canvas, '中A1', { ...base, fontSize: 20, letterSpacing: 5, writingMode: 'vertical-lr' }, 'Test');
  assert.equal(ctx.letterSpacing, '0px');
  assert.deepEqual(ctx.draws.map(draw => draw[0]), ['中', 'A', '1']);
  assert.deepEqual(ctx.draws.map(draw => draw[1]), [15, 15, 15]);
  assert.deepEqual(ctx.draws.map(draw => draw[2]), [23, 48, 73]);
  assert.equal(layout.overflow, false);
  const tooTall = layoutText(context(), '天', { ...base, height: 64, fontSize: 60, writingMode: 'vertical-rl' }, 'Test');
  assert.equal(tooTall.overflow, true);
  const overlap = layoutText(context(), '天地玄', { ...base, fontSize: 8, letterSpacing: -20, writingMode: 'vertical-lr' }, 'Test');
  assert.deepEqual(overlap.glyphs.map(glyph => glyph.y), [10, 11, 12]);
});

test('changing vertical tracking does not shift glyphs horizontally on native canvas', () => {
  function render(letterSpacing) {
    const ctx = context(); ctx.letterSpacing = '0px';
    ctx.measureText = function (text) { return {
      width: text.length * (10 + parseFloat(this.letterSpacing)),
      fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2
    }; };
    renderCanvas({ getContext: () => ctx }, '中A1', { ...base, fontSize: 20, letterSpacing, writingMode: 'vertical-lr' }, 'Test');
    return ctx.draws;
  }
  const compact = render(0), spaced = render(8);
  assert.deepEqual(compact.map(draw => draw[1]), [15, 15, 15]);
  assert.deepEqual(spaced.map(draw => draw[1]), compact.map(draw => draw[1]));
  assert.equal(spaced[1][2] - spaced[0][2], 28);
  assert.equal(compact[1][2] - compact[0][2], 20);
});

test('layout presets scale to the artboard while preserving size, colors and alpha choice', () => {
  assert.equal(PRESETS.length, 5); assert.equal(new Set(PRESETS.map(preset => preset.id)).size, 5);
  assert.deepEqual(PRESETS.map(preset => preset.name), ['居中标题', '左对齐正文', '疏朗海报', '竖排题字', '竖排正文']);
  const input = { width: 960, height: 540, textColor: '#123456', backgroundColor: '#abcdef', transparent: false };
  for (const preset of PRESETS) {
    const settings = applyPreset(preset.id, input);
    assert.equal(settings.width, 960); assert.equal(settings.height, 540);
    assert.equal(settings.textColor, '#123456'); assert.equal(settings.backgroundColor, '#abcdef'); assert.equal(settings.transparent, false);
    assert.equal(settings.fontSize, Math.round(preset.settings.fontSize / 2));
    assert.equal(settings.paddingLeft, Math.round(preset.settings.paddingLeft / 2));
    assert.equal(settings.paddingTop, Math.round(preset.settings.paddingTop / 2));
  }
  assert.equal(applyPreset('vertical-title', input).writingMode, 'vertical-rl');
  assert.equal(applyPreset('left-body', { ...input, writingMode: 'vertical-lr' }).writingMode, 'horizontal-tb');
  assert.throws(() => applyPreset('missing', input), /未找到/);
});
