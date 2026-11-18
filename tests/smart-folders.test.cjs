'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Smart = require('../src/smart-folders.js');
const now = Date.parse('2026-11-18T06:00:00.000Z');
const asset = patch => ({ name: '演出红色背景', ext: 'mov', mediaType: 'video', colorLabel: 'red', createdAt: '2026-11-17T06:00:00.000Z', tags: ['舞台'], notes: '', rating: 0, trashedAt: null, ...patch });

test('smart folder rules normalize supported fields without retaining input references', () => {
  assert.deepEqual(Smart.validateRule({}), Smart.DEFAULT_RULE);
  assert.deepEqual(Smart.validateRule({ colorLabel: '#AbC', search: '  字体\n  Bold  ' }), { ...Smart.DEFAULT_RULE, colorLabel: '#aabbcc', search: '字体 Bold' });
  const first = Smart.validateRule({}); first.mediaType = 'font'; assert.equal(Smart.DEFAULT_RULE.mediaType, 'all');
  for (const value of [null, [], 'font', 7, new Date(), { folderId: 'real-folder' }, { mediaType: 'audio' }, { colorLabel: undefined }, { colorLabel: 'rgb(0,0,0)' },
    { recentDays: -1 }, { recentDays: 1.5 }, { recentDays: '7' }, { recentDays: 3651 }, { search: null }, { search: 'x'.repeat(501) }, { favorite: 1 }]) assert.throws(() => Smart.validateRule(value), undefined, JSON.stringify(value));
  assert.equal(Smart.validateName('  常用字体  '), '常用字体');
  for (const value of ['', ' ', null, 'a'.repeat(101), 'a\nb']) assert.throws(() => Smart.validateName(value));
});

test('all smart folder predicates combine with AND and do not mutate assets', () => {
  const rule = { mediaType: 'video', colorLabel: 'red', recentDays: 7, search: '背景 舞台', favorite: true };
  const source = asset({ rating: 4 }), before = structuredClone(source);
  assert.equal(Smart.matches(source, rule, now), true);
  for (const change of [{ mediaType: 'font' }, { colorLabel: 'blue' }, { createdAt: '2026-01-01T00:00:00Z' }, { rating: 3 }, { tags: [] }, { trashedAt: '2026-11-18' }]) assert.equal(Smart.matches({ ...source, ...change }, rule, now), false);
  assert.deepEqual(source, before);
});

test('recent import rules use a rolling boundary and exclude invalid or future dates', () => {
  const predicate = Smart.compile({ recentDays: 1 }, now);
  assert.equal(predicate(asset({ createdAt: new Date(now - 86400000).toISOString() })), true);
  assert.equal(predicate(asset({ createdAt: new Date(now - 86400001).toISOString() })), false);
  for (const createdAt of [undefined, null, 0, 'invalid', new Date(now + 1).toISOString()]) assert.equal(predicate(asset({ createdAt })), false);
  assert.equal(Smart.matches(asset({ createdAt: 'invalid' }), { recentDays: 0 }, now), true);
  assert.throws(() => Smart.compile({}, NaN), /时间/);
});

test('smart folder media fallback covers fonts, DXV, native model projects and images', () => {
  for (const [ext, type] of [['WOFF2', 'font'], ['ttc', 'font'], ['otc', 'font'], ['dxv', 'video'], ['c4d', 'model'], ['aep', 'project'], ['jpeg', 'image']]) {
    assert.equal(Smart.matches(asset({ ext, mediaType: undefined }), { mediaType: type }, now), true);
  }
  assert.equal(Smart.matches(asset({ ext: 'unknown', mediaType: undefined }), { mediaType: 'image' }, now), false);
  assert.equal(Smart.matches(asset({ ext: 'unknown', mediaType: undefined }), {}, now), true);
});

test('dynamic predicates reflect newly imported, relabeled and restored assets', () => {
  const predicate = Smart.compile({ mediaType: 'font', recentDays: 30, colorLabel: '#ABC' }, now);
  const current = asset({ mediaType: 'font', ext: 'ttf', colorLabel: '#aabbcc' });
  assert.equal(predicate(current), true);
  current.colorLabel = 'red'; assert.equal(predicate(current), false);
  current.colorLabel = '#abc'; current.trashedAt = 'yesterday'; assert.equal(predicate(current), false);
  current.trashedAt = null; assert.equal(predicate(current), true);
  current.colorLabel = { malicious: true }; assert.equal(predicate(current), false);
});

test('keyword matching includes font names and requires every term literally', () => {
  const current = asset({ name: 'sample', mediaType: 'font', font: { family: 'Source Sans', fullName: 'Source Sans Bold' }, notes: 'A+B [demo]', tags: [] });
  assert.equal(Smart.matches(current, { search: 'SOURCE bold a+b [demo]' }, now), true);
  assert.equal(Smart.matches(current, { search: 'source absent' }, now), false);
  assert.equal(Smart.matches(current, { search: '.*' }, now), false);
  assert.equal(Smart.matches(asset({ trashedAt: 'now' }), {}, now), false);
  assert.equal(Smart.matches(null, {}, now), false);
});

test('smart folder core loads in browser and describes rules as plain text', () => {
  const context = vm.createContext({});
  for (const filename of ['color-labels.js', 'smart-folders.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8'), context);
  assert.equal(context.ShituSmartFolders.matches(asset({}), { mediaType: 'video', colorLabel: 'red' }, now), true);
  const description = Smart.describe({ mediaType: 'font', recentDays: 7, favorite: true, search: '<img onerror=evil>' });
  assert.match(description, /字体.*最近 7 天导入.*已收藏.*<img onerror=evil>/);
});
