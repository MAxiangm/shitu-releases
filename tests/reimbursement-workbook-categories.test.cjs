'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createReimbursementWorkbook, DEFAULT_TEMPLATE } = require('../src/reimbursement-workbook.cjs');
const { readZip, writeZip } = require('../src/xlsx-zip.cjs');
const { readMetadata, DETAILS, HISTORY, DETAIL_NAME, HISTORY_NAME } = require('../src/reimbursement-rows.cjs');
const profile = { applicant: '合成测试用户', accountName: '合成测试账户', bankName: '测试银行北京支行', accountNumber: '00001234567890123456' };
const MAIN = 'xl/worksheets/sheet1.xml';
const CATEGORIES = Array.from({ length: 30 }, (_, index) => ({ key: `category-${index + 1}`, name: `测试分类${index + 1}`, count: 1 }));
const parts = bytes => new Map(readZip(bytes).entries.map(entry => [entry.name, entry]));
const xml = (bytes, name = MAIN) => parts(bytes).get(name)?.data.toString('utf8');
const cells = text => new Map([...text.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)].map(match => [/\br="([^"]+)"/.exec(match[0])[1], match[0]]));
const metadata = bytes => readMetadata(parts(bytes));
function editCells(bytes, changes, name = MAIN) {
  const archive = readZip(bytes), entry = archive.entries.find(part => part.name === name);
  entry.data = Buffer.from(entry.data.toString().replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, cell => {
    const reference = /\br="([^"]+)"/.exec(cell)[1];
    if (!Object.hasOwn(changes, reference)) return cell;
    const attrs = /^<c\b([^>]*)>/.exec(cell)[1].replace(/\/\s*$/, '').replace(/\s+t="[^"]*"/, '');
    return `<c${attrs}${changes[reference].startsWith('<is>') ? ' t="inlineStr"' : ''}>${changes[reference]}</c>`;
  }));
  return writeZip(archive);
}
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reimbursement-categories-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return (bytes, categories, date = '2026-11-21') => {
    const filename = path.join(directory, 'working.xlsx'); fs.writeFileSync(filename, bytes);
    return createReimbursementWorkbook({ templatePath: filename, profile, date, ...(categories === undefined ? {} : { categories }) });
  };
}
const generate = categories => createReimbursementWorkbook({ profile, date: '2026-11-21', categories });

test('only active ordinary categories appear, with literal names and blank amounts', () => {
  const bytes = generate([{ key: 'empty', name: '无票分类', count: 0 }, { key: 'supplement', name: '购买凭证', count: 9 }, { key: 'travel', name: '=差旅 & <交通>', count: 2 }]);
  const main = cells(xml(bytes));
  assert.match(main.get('C8'), /t="inlineStr".*=差旅 &amp; &lt;交通&gt;/);
  assert.doesNotMatch(main.get('C8'), /<f>/);
  assert.doesNotMatch(xml(bytes), /无票分类|购买凭证/);
  assert.doesNotMatch(main.get('G8'), /<v>|<f>/);
  assert.doesNotMatch(main.get('G18'), /<v>/);
  assert.doesNotMatch(main.get('B18'), /<v>/);
  assert.deepEqual(metadata(bytes).rows.map(item => item.key), ['travel']);
  assert.equal(parts(bytes).has(DETAILS), false);
});

test('reorder and rename keep numeric amounts, custom descriptions and formulas with their category keys', t => {
  const rebuild = setup(t), categories = CATEGORIES.slice(0, 3);
  let bytes = generate(categories);
  bytes = editCells(bytes, { G8: '<v>123.45</v>', G9: '<f>100+LEN(C9)</f><v>105</v>', C10: '<is><t>手工填写的具体用途</t></is>', G10: '<v>78.90</v>' });
  bytes = rebuild(bytes, [{ ...categories[2], name: '改名第三类' }, { ...categories[0], name: '改名第一类' }, categories[1], CATEGORIES[3]]);
  const main = cells(xml(bytes));
  assert.match(main.get('C8'), /手工填写的具体用途/);
  assert.match(main.get('G8'), /78.90/);
  assert.match(main.get('C9'), /改名第一类/);
  assert.match(main.get('G9'), /123.45/);
  assert.match(main.get('G10'), /<f>100\+LEN\(C10\)<\/f>/);
  assert.doesNotMatch(main.get('G10'), /<v>/);
  assert.doesNotMatch(main.get('G11'), /<v>|<f>/);
  assert.deepEqual(metadata(bytes).rows.map(item => item.key), ['category-3', 'category-1', 'category-2', 'category-4']);
});

test('adding new rows cannot overwrite old row positions used by formulas', t => {
  const rebuild = setup(t);
  let bytes = editCells(generate(CATEGORIES.slice(0, 2)), { G8: '<v>20</v>', G9: '<f>G8*2</f><v>40</v>' });
  bytes = rebuild(bytes, [CATEGORIES[2], CATEGORIES[1], CATEGORIES[0], CATEGORIES[3]]);
  assert.match(cells(xml(bytes)).get('G9'), /<f>G10\*2<\/f>/);
  assert.match(cells(xml(bytes)).get('G10'), /<v>20<\/v>/);
});

test('removed or empty categories are archived without being totaled, then restored once by key', t => {
  const rebuild = setup(t), categories = CATEGORIES.slice(0, 2);
  let bytes = editCells(generate(categories), { G8: '<f>100+LEN(C8)</f><v>105</v>', G9: '<v>88.25</v>' });
  bytes = rebuild(bytes, [{ ...categories[0], count: 0 }, categories[1]]);
  let main = cells(xml(bytes)), history = cells(xml(bytes, HISTORY));
  assert.match(main.get('G8'), /88.25/);
  assert.doesNotMatch(main.get('G18'), /历史|<v>/);
  assert.doesNotMatch(main.get('G9'), /<v>|<f>/);
  assert.match(history.get('C5'), /测试分类1/);
  assert.doesNotMatch(history.get('G5'), /<f>/);
  assert.match(metadata(bytes).history[0].formulaCells.G, /LEN\(C5\)/);
  assert.match(xml(bytes, 'xl/workbook.xml'), new RegExp(`name="${HISTORY_NAME}"[^>]*state="hidden"`));
  bytes = rebuild(bytes, [{ ...categories[0], name: '恢复第一类' }, categories[1]]);
  main = cells(xml(bytes));
  assert.match(main.get('G8'), /<f>100\+LEN\(C8\)<\/f>/);
  assert.match(main.get('C8'), /恢复第一类/);
  assert.equal(metadata(bytes).history.length, 0);
  assert.equal((xml(bytes).match(/<v>88.25<\/v>/g) || []).length, 1);
  for (let repeat = 0; repeat < 3; repeat++) bytes = rebuild(bytes, categories);
  assert.equal(metadata(bytes).rows.length, 2);
  assert.equal(metadata(bytes).history.length, 0);
  assert.equal((xml(bytes).match(/<v>88.25<\/v>/g) || []).length, 1);
});

test('legacy handwritten expense rows survive managed categories and an explicitly empty category list', t => {
  const rebuild = setup(t);
  const original = editCells(fs.readFileSync(DEFAULT_TEMPLATE), { C8: '<is><t>旧表手工差旅费</t></is>', G8: '<v>198.76</v>', G10: '<f>50+LEN(C10)</f><v>50</v>' });
  let bytes = rebuild(original, CATEGORIES.slice(0, 1));
  assert.match(cells(xml(bytes)).get('C9'), /旧表手工差旅费/);
  assert.match(cells(xml(bytes)).get('G9'), /198.76/);
  assert.match(cells(xml(bytes)).get('G10'), /<f>50\+LEN\(C10\)<\/f>/);
  assert.equal(metadata(bytes).rows.filter(item => !item.managed).length, 2);
  bytes = rebuild(bytes, []);
  assert.match(cells(xml(bytes)).get('C8'), /旧表手工差旅费/);
  assert.match(cells(xml(bytes)).get('G8'), /198.76/);
  assert.equal(metadata(bytes).rows.length, 2);
  assert.equal(metadata(bytes).history.length, 1);
  assert.doesNotMatch(xml(bytes), /测试分类1/);
  bytes = rebuild(bytes, undefined, '2026-11-22');
  assert.equal(metadata(bytes).rows.length, 2);
  assert.match(cells(xml(bytes)).get('G8'), /198.76/);
});

test('all thirty active categories print across the main form and continuation without changing bank layout', () => {
  const bytes = generate(CATEGORIES), original = xml(fs.readFileSync(DEFAULT_TEMPLATE)), main = xml(bytes), continuation = xml(bytes, DETAILS);
  const mainCells = cells(main), detailCells = cells(continuation);
  assert.equal(metadata(bytes).rows.length, 30);
  for (let index = 0; index < 30; index++) assert.match((index < 10 ? mainCells : detailCells).get(`C${index < 10 ? index + 8 : index - 10 + 5}`), new RegExp(`测试分类${index + 1}<`));
  assert.match(mainCells.get('G18'), /SUM\(G8:G17,&apos;报销明细续表&apos;!G5:G24\)/);
  assert.match(detailCells.get('G25'), /<f>SUM\(G5:G24\)<\/f>/);
  assert.doesNotMatch(mainCells.get('G18') + detailCells.get('G25'), /<v>/);
  assert.match(xml(bytes, 'xl/workbook.xml'), new RegExp(`name="${DETAIL_NAME}"[^>]*r:id="rIdMosaicReimbursementDetails"/`));
  assert.equal(/<mergeCells[\s\S]*?<\/mergeCells>/.exec(main)[0], /<mergeCells[\s\S]*?<\/mergeCells>/.exec(original)[0]);
  assert.equal(/<pageMargins[^>]*>/.exec(main)[0], /<pageMargins[^>]*>/.exec(original)[0]);
  assert.equal(/<pageSetup[^>]*>/.exec(main)[0], /<pageSetup[^>]*>/.exec(original)[0]);
  assert.match(continuation, /<pageSetUpPr fitToPage="1"/);
  assert.match(continuation, /<pageSetup[^>]*orientation="landscape"/);
  for (const ref of ['B19', 'D19', 'B21', 'D21', 'A23', 'B24', 'B25', 'B26', 'D28']) assert.equal(mainCells.get(ref), cells(original).get(ref), ref);
});

test('formula amounts survive main-to-continuation moves, archive and restore', t => {
  const rebuild = setup(t);
  let bytes = editCells(generate(CATEGORIES.slice(0, 12)), { G8: '<f>100+LEN(C8)+IF("C8"="C8",0,1)</f><v>105</v>' });
  bytes = rebuild(bytes, [...CATEGORIES.slice(1, 12), CATEGORIES[0]]);
  assert.match(cells(xml(bytes, DETAILS)).get('G6'), /<f>100\+LEN\(C6\)\+IF\(&quot;C8&quot;=&quot;C8&quot;,0,1\)<\/f>/);
  bytes = rebuild(bytes, CATEGORIES.slice(1, 12));
  assert.equal(metadata(bytes).history.length, 1);
  bytes = rebuild(bytes, CATEGORIES.slice(0, 12));
  assert.match(cells(xml(bytes)).get('G8'), /<f>100\+LEN\(C8\)\+IF\(&quot;C8&quot;=&quot;C8&quot;,0,1\)<\/f>/);
  assert.equal(metadata(bytes).history.length, 0);
  bytes = rebuild(bytes, CATEGORIES.slice(0, 1));
  assert.match(cells(xml(bytes, DETAILS)).get('G5'), /<f>0<\/f>/);
  assert.match(xml(bytes, 'xl/workbook.xml'), new RegExp(`name="${DETAIL_NAME}"[^>]*state="hidden"`));
  assert.doesNotMatch(cells(xml(bytes)).get('G18'), /续表/);
});

test('same-row ranges and consecutive cross-row ranges move without invalid sheet qualifiers', t => {
  const rebuild = setup(t);
  let bytes = editCells(generate(CATEGORIES.slice(0, 12)), { G8: '<f>SUM(C8:F8)+SUM(C8:C9)</f><v>0</v>' });
  bytes = rebuild(bytes, [...CATEGORIES.slice(2, 12), ...CATEGORIES.slice(0, 2)]);
  assert.match(cells(xml(bytes, DETAILS)).get('G5'), /<f>SUM\(C5:F5\)\+SUM\(C5:C6\)<\/f>/);
  bytes = rebuild(bytes, CATEGORIES.slice(0, 12));
  assert.match(cells(xml(bytes)).get('G8'), /<f>SUM\(C8:F8\)\+SUM\(C8:C9\)<\/f>/);
});

test('non-contiguous cross-row, shared and array formulas protect the existing workbook with an explicit error', t => {
  const rebuild = setup(t), initial = generate(CATEGORIES.slice(0, 3));
  const range = editCells(initial, { G8: '<f>SUM(C8:C9)</f><v>0</v>' });
  assert.throws(() => rebuild(range, [CATEGORIES[0], CATEGORIES[2], CATEGORIES[1]]), /不再是连续区域/);
  for (const type of ['shared', 'array']) {
    const input = editCells(initial, { G8: `<f t="${type}" ref="G8:G9" si="0">SUM(C8:F8)</f><v>0</v>` });
    assert.throws(() => rebuild(input, CATEGORIES.slice(0, 3)), /共享或数组公式/);
  }
  assert.match(cells(xml(range)).get('G8'), /SUM\(C8:C9\)/);
});

test('archival preserves the original entry date while active rows receive the current date', t => {
  const rebuild = setup(t);
  let bytes = generate(CATEGORIES.slice(0, 2));
  bytes = rebuild(bytes, [CATEGORIES[1]], '2026-12-03');
  assert.match(cells(xml(bytes)).get('B8'), /2026-12-03/);
  assert.match(cells(xml(bytes, HISTORY)).get('B5'), /2026-11-21/);
});

test('worksheet part and relationship renumbering by Excel remains compatible', t => {
  const rebuild = setup(t);
  let bytes = editCells(generate(CATEGORIES.slice(0, 12)), { G5: '<v>27.31</v>' }, DETAILS);
  const archive = readZip(bytes);
  archive.entries.find(entry => entry.name === DETAILS).name = 'xl/worksheets/sheet4.xml';
  for (const name of ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
    const entry = archive.entries.find(part => part.name === name);
    entry.data = Buffer.from(entry.data.toString().replaceAll('rIdMosaicReimbursementDetails', 'rId17').replaceAll('worksheets/mosaic-reimbursement-details.xml', 'worksheets/sheet4.xml'));
  }
  bytes = rebuild(writeZip(archive), CATEGORIES.slice(0, 12));
  assert.match(cells(xml(bytes, 'xl/worksheets/sheet4.xml')).get('G5'), /27.31/);
  assert.equal(parts(bytes).has(DETAILS), false);
  assert.equal(metadata(bytes).rows.length, 12);
});

test('invalid or excessive categories fail before producing a misleading form', () => {
  for (const categories of [CATEGORIES.concat({ key: 'extra', name: '超限', count: 1 }), [{ key: 'same', name: '甲' }, { key: 'same', name: '乙' }], [{ key: 'bad!', name: '非法' }], [{ key: 'a', name: '无效\0名称' }]]) assert.throws(() => generate(categories), /最多|无效/);
});

test('metadata survives the desktop Excel 255-character property limit and rejects damaged chunks', t => {
  const rebuild = setup(t), bytes = generate(CATEGORIES);
  const custom = xml(bytes, 'docProps/custom.xml');
  const properties = [...custom.matchAll(/<property\b[^>]*name="MosaicReimbursementLayout(?:\.\d{4})?"[^>]*>([\s\S]*?)<\/property>/g)];
  assert.ok(properties.length > 2);
  for (const [property] of properties) {
    const value = /<vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>/.exec(property)[1];
    assert.ok(value.length <= 240, value.length);
  }
  const modified = readZip(bytes), entry = modified.entries.find(item => item.name === 'docProps/custom.xml');
  entry.data = Buffer.from(custom.replace(/(name="MosaicReimbursementLayout\.0000"[^>]*><vt:lpwstr>)[A-Za-z]/, '$1!'));
  assert.throws(() => rebuild(writeZip(modified), CATEGORIES), /映射信息损坏/);
  // Migrate a pre-chunking generated workbook without losing its identity map.
  const legacy = readZip(bytes), legacyEntry = legacy.entries.find(item => item.name === 'docProps/custom.xml');
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  legacyEntry.data = Buffer.from(custom.replace(/<property\b[^>]*name="MosaicReimbursementLayout(?:\.\d{4})?"[^>]*>[\s\S]*?<\/property>/g, '').replace('</Properties>', `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="999" name="MosaicReimbursementLayout"><vt:lpwstr>${escape(JSON.stringify(metadata(bytes)))}</vt:lpwstr></property></Properties>`));
  const migrated = rebuild(writeZip(legacy), CATEGORIES);
  assert.deepEqual(metadata(migrated), metadata(bytes));
  assert.match(xml(migrated, 'docProps/custom.xml'), /<vt:lpwstr>v2:/);
});

test('recognized integer-cent totals fill each category including genuine supplement invoices', () => {
  const categories = [
    { key: 'travel', name: '出行', count: 2, amountCents: 12345, pendingCount: 0 },
    { key: 'other', name: '其他', count: 1, amountCents: 0, pendingCount: 0 },
    { key: 'supplement', name: '补票发票', count: 1, amountCents: 4567, pendingCount: 0 },
    { key: 'empty', name: '无发票', count: 0, amountCents: 0, pendingCount: 0 }
  ];
  const bytes = generate(categories), main = cells(xml(bytes));
  assert.match(main.get('G8'), /<v>123.45<\/v>/);
  assert.match(main.get('G9'), /<v>0.00<\/v>/);
  assert.match(main.get('G10'), /<v>45.67<\/v>/);
  assert.match(main.get('C10'), /补票发票/);
  assert.doesNotMatch(xml(bytes), /无发票/);
  assert.match(main.get('G18'), /<f>SUM\(G8:G17\)<\/f>/);
  assert.match(main.get('B18'), /TRUNC\(G18\)=G18/);
  assert.doesNotMatch(main.get('G18') + main.get('B18'), /待核对|<v>/);
  assert.equal(metadata(bytes).rows[0].amountCents, 12345);
});

test('automatic category amounts replace old manual formulas while descriptions and legacy amounts survive', t => {
  const rebuild = setup(t), categories = CATEGORIES.slice(0, 2);
  let bytes = editCells(generate(categories), { C8: '<is><t>保留手工备注</t></is>', D8: '<v>17</v>', G8: '<f t="shared" si="0" ref="G8:G8">999</f><v>999</v>', G9: '<v>80.25</v>' });
  bytes = rebuild(bytes, [{ ...categories[0], amountCents: 1234, pendingCount: 0 }, categories[1]]);
  const main = cells(xml(bytes));
  assert.match(main.get('G8'), /<v>12.34<\/v>/); assert.doesNotMatch(main.get('G8'), /<f/);
  assert.match(main.get('C8'), /保留手工备注/); assert.match(main.get('D8'), /<v>17<\/v>/);
  assert.match(main.get('G9'), /<v>80.25<\/v>/);
  bytes = rebuild(bytes, [{ ...categories[0], amountCents: 0, pendingCount: 0 }, categories[1]]);
  assert.match(cells(xml(bytes)).get('G8'), /<v>0.00<\/v>/);
});

test('pending invoices clear incomplete category values and block both final amount displays', () => {
  const bytes = generate([
    { key: 'travel', name: '出行', count: 5, amountCents: 12345, pendingCount: 2 },
    { key: 'supplement', name: '补票发票', count: 3, amountCents: null, pendingCount: 0 },
    { key: 'other', name: '其他', count: 1, amountCents: 999, pendingCount: 0 }
  ]), main = cells(xml(bytes));
  assert.doesNotMatch(main.get('G8') + main.get('G9'), /<f|<v>/);
  assert.match(main.get('G10'), /<v>9.99<\/v>/);
  for (const ref of ['G18', 'B18']) { assert.match(main.get(ref), /待核对（5张）/); assert.doesNotMatch(main.get(ref), /<f|<v>/); }
  assert.match(metadata(bytes).uppercaseFormula, /TRUNC\(G18\)=G18/);
});

test('pending status survives profile-only regeneration and resolved amounts restore total and uppercase formulas repeatedly', t => {
  const rebuild = setup(t), pending = [{ key: 'travel', name: '出行', count: 1, amountCents: null, pendingCount: 1 }];
  let bytes = generate(pending);
  bytes = rebuild(bytes, undefined, '2026-12-03');
  assert.match(cells(xml(bytes)).get('G18'), /待核对（1张）/);
  assert.doesNotMatch(cells(xml(bytes)).get('G8'), /<v>/);
  const complete = [{ ...pending[0], amountCents: 10010, pendingCount: 0 }];
  const expectedFormula = /<f[^>]*>([\s\S]*?)<\/f>/.exec(cells(xml(generate(CATEGORIES.slice(0, 1)))).get('B18'))[1];
  for (let repeat = 0; repeat < 3; repeat++) {
    bytes = rebuild(bytes, complete);
    const main = cells(xml(bytes));
    assert.match(main.get('G8'), /<v>100.10<\/v>/);
    assert.match(main.get('G18'), /<f>SUM\(G8:G17\)<\/f>/);
    assert.equal(/<f[^>]*>([\s\S]*?)<\/f>/.exec(main.get('B18'))[1], expectedFormula);
    assert.doesNotMatch(main.get('B18') + main.get('G18'), /待核对|<v>/);
    bytes = rebuild(bytes, pending);
  }
});

test('continuation categories receive recognized amounts and share the unresolved-total guard', t => {
  const rebuild = setup(t), categories = CATEGORIES.slice(0, 12).map((item, i) => ({ ...item, amountCents: (i + 1) * 123, pendingCount: 0 }));
  let bytes = generate(categories), main = cells(xml(bytes)), detail = cells(xml(bytes, DETAILS));
  assert.match(main.get('G17'), /<v>12.30<\/v>/);
  assert.match(detail.get('G5'), /<v>13.53<\/v>/);
  assert.match(detail.get('G6'), /<v>14.76<\/v>/);
  bytes = rebuild(bytes, categories.map((item, i) => i === 11 ? { ...item, count: 3, amountCents: null, pendingCount: 3 } : item));
  for (const [part, ref] of [[MAIN, 'G18'], [MAIN, 'B18'], [DETAILS, 'G7']]) assert.match(cells(xml(bytes, part)).get(ref), /待核对（3张）/);
  assert.doesNotMatch(cells(xml(bytes, DETAILS)).get('G6'), /<v>/);
  bytes = rebuild(bytes, [...categories].reverse());
  main = cells(xml(bytes)); detail = cells(xml(bytes, DETAILS));
  assert.match(main.get('G8'), /<v>14.76<\/v>/);
  assert.match(detail.get('G6'), /<v>1.23<\/v>/);
  assert.match(detail.get('G7'), /<f>SUM\(G5:G6\)<\/f>/);
  assert.match(main.get('G18'), /SUM\(G8:G17,&apos;报销明细续表&apos;!G5:G6\)/);
});

test('legacy untracked amounts remain in the active total and archived automatic amounts never count twice', t => {
  const rebuild = setup(t);
  const source = editCells(fs.readFileSync(DEFAULT_TEMPLATE), { C8: '<is><t>旧表手工费用</t></is>', G8: '<v>42.50</v>' });
  const first = { key: 'travel', name: '出行', count: 1, amountCents: 1010, pendingCount: 0 };
  let bytes = rebuild(source, [first]);
  assert.match(cells(xml(bytes)).get('G8'), /<v>10.10<\/v>/);
  assert.match(cells(xml(bytes)).get('G9'), /<v>42.50<\/v>/);
  bytes = rebuild(bytes, []);
  assert.match(cells(xml(bytes)).get('G8'), /<v>42.50<\/v>/);
  assert.match(cells(xml(bytes, HISTORY)).get('G5'), /<v>10.10<\/v>/);
  assert.doesNotMatch(cells(xml(bytes)).get('G18'), /历史/);
  bytes = rebuild(bytes, [{ ...first, amountCents: 2020 }]);
  assert.match(cells(xml(bytes)).get('G8'), /<v>20.20<\/v>/);
  assert.match(cells(xml(bytes)).get('G9'), /<v>42.50<\/v>/);
  assert.equal(metadata(bytes).history.length, 0);
});

test('amount and pending-count validation rejects rounding or unsafe total arithmetic', () => {
  const base = { key: 'travel', name: '出行', count: 1, amountCents: 123, pendingCount: 0 };
  for (const amountCents of [-1, 1.5, '123', undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => generate([{ ...base, amountCents }]), /金额信息无效/);
  for (const pendingCount of [-1, 1.5, '1', NaN, Infinity]) assert.throws(() => generate([{ ...base, pendingCount }]), /金额信息无效/);
  const max = generate([{ ...base, amountCents: Number.MAX_SAFE_INTEGER }]);
  assert.match(cells(xml(max)).get('G8'), /<v>90071992547409.91<\/v>/);
  assert.throws(() => generate([{ ...base, amountCents: Number.MAX_SAFE_INTEGER }, { ...base, key: 'other', amountCents: 1 }]), /超过安全范围/);
});
