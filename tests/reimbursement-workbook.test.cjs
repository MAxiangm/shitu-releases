'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { deflateRawSync } = require('node:zlib');
const { createReimbursementWorkbook, DEFAULT_TEMPLATE, dateValues } = require('../src/reimbursement-workbook.cjs');
const { readZip, writeZip, crc32, MAX_BYTES } = require('../src/xlsx-zip.cjs');
const profile = { applicant: '张三', accountName: '张三', bankName: '中国工商银行北京分行', accountNumber: '00123456789012345678' };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const byName = bytes => new Map(readZip(bytes).entries.map(entry => [entry.name, entry.data]));
const cells = xml => new Map([...xml.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)].map(match => [/\br="([^"]+)"/.exec(match[0])[1], match[0]]));
const getXml = (buffer, name = 'xl/worksheets/sheet1.xml') => byName(buffer).get(name).toString('utf8');

test('bundled public reimbursement template has empty personal fields and generic company information', () => {
  const bytes = fs.readFileSync(DEFAULT_TEMPLATE), parts = byName(bytes);
  assert.equal(hash(bytes), '85392649a816682eba3aa0fc9dc14eda9463c00df1b338ef438521b2a0548147');
  const strings = [...parts.get('xl/sharedStrings.xml').toString().matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
    .map(match => [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(text => text[1]).join(''));
  const value = (sheet, ref) => {
    const cell = cells(parts.get(`xl/worksheets/${sheet}.xml`).toString()).get(ref) || '';
    if (/\bt="s"/.test(cell)) return strings[Number(/<v>(\d+)<\/v>/.exec(cell)?.[1])] || '';
    return [...cell.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => match[1]).join('');
  };
  for (const ref of ['B4', 'C24', 'C25', 'C26']) assert.equal(value('sheet1', ref), '', ref);
  assert.equal(value('sheet2', 'H2'), '');
  assert.equal(value('sheet3', 'B2'), '公司名称：\n纳税人识别号：\n地址：\n电话：\n开户行：\n账号：');
  for (const text of strings) assert.doesNotMatch(text, /\d{12,}/, 'shared strings cannot contain a retained account or tax number');
  assert.doesNotMatch(parts.get('docProps/core.xml').toString(), /<(?:dc:creator|cp:lastModifiedBy)[^>]*>\s*[^<\s]/);
  assert.doesNotMatch(parts.get('docProps/app.xml').toString(), /<(?:Company|Manager)[^>]*>\s*[^<\s]/);
  assert.doesNotMatch(parts.get('docProps/custom.xml').toString(), /\bname="ICV"/);
  const referenced = new Set();
  for (const [name, data] of parts) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
    for (const cell of cells(data.toString()).values()) if (/\bt="s"/.test(cell)) referenced.add(Number(/<v>(\d+)<\/v>/.exec(cell)?.[1]));
  }
  assert.equal(referenced.size, strings.length, 'no unreferenced shared-string values remain hidden in the template');
});

test('profile and dates fill existing cells without expense autofill or layout changes', () => {
  const original = fs.readFileSync(DEFAULT_TEMPLATE), output = createReimbursementWorkbook({ profile, date: '2026-11-21' });
  assert.ok(Buffer.isBuffer(output));
  const sourceParts = byName(original), parts = byName(output);
  assert.deepEqual([...parts.keys()], [...sourceParts.keys()]);
  for (const [name, contents] of sourceParts) if (!['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/workbook.xml'].includes(name)) assert.deepEqual(parts.get(name), contents, name);
  const before = cells(getXml(original)), after = cells(getXml(output));
  const changed = new Set(['B4', 'C24', 'C25', 'C26', 'G5', 'A28', 'B18', ...Array.from({ length: 10 }, (_, i) => `B${i + 8}`)]);
  for (const [ref, content] of before) if (!changed.has(ref)) assert.equal(after.get(ref), content, ref);
  for (const ref of changed) assert.equal(/\bs="(\d+)"/.exec(after.get(ref))[1], /\bs="(\d+)"/.exec(before.get(ref))[1], `${ref} style`);
  assert.match(after.get('B4'), /张三/); assert.match(after.get('C24'), /张三/);
  assert.match(after.get('C25'), /中国工商银行北京分行/);
  assert.match(after.get('C26'), /t="inlineStr".*00123456789012345678/);
  assert.match(after.get('G5'), /<v>46347<\/v>/); assert.doesNotMatch(after.get('G5'), /TODAY/);
  for (let row = 8; row <= 17; row++) assert.match(after.get(`B${row}`), /2026-11-21/);
  assert.match(after.get('A28'), /申请人：张三\n\n日期：2026年11月21日/);
  const normalized = xml => xml.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, match => changed.has(/\br="([^"]+)"/.exec(match)[1]) ? '' : match);
  assert.equal(normalized(getXml(output)), normalized(getXml(original)), 'non-cell sheet XML including merges/print settings is byte-preserved');
  const second = cells(getXml(output, 'xl/worksheets/sheet2.xml'));
  assert.match(second.get('H2'), /张三/); assert.match(second.get('H3'), /<v>46347<\/v>/);
  const sourceSecond = cells(getXml(original, 'xl/worksheets/sheet2.xml'));
  for (const [ref, content] of sourceSecond) if (!['H2', 'H3'].includes(ref)) assert.equal(second.get(ref), content, ref);
  assert.match(parts.get('xl/workbook.xml').toString(), /fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/);
  assert.deepEqual(fs.readFileSync(DEFAULT_TEMPLATE), original);
});

test('only the uppercase formula wrong blank-cell comparison is corrected', () => {
  const originalFormula = cells(getXml(fs.readFileSync(DEFAULT_TEMPLATE))).get('B18');
  const formula = cells(getXml(createReimbursementWorkbook({ profile, date: '2026-11-21' }))).get('B18');
  assert.equal(formula, originalFormula.replace('TRUNC(G18)=C6', 'TRUNC(G18)=G18'));
  assert.match(cells(getXml(createReimbursementWorkbook({ profile, date: '2026-11-21' }))).get('G18'), /SUM\(G8:G17\)/);
});

test('profile values remain escaped literal text and preserve account leading zeros', () => {
  const output = createReimbursementWorkbook({ profile: { applicant: '=HYPERLINK("bad")<&\'', accountName: '名称 & <账户>', bankName: '银行"支行"', accountNumber: '00000000000000000001' }, date: '2024-02-29' });
  const map = cells(getXml(output));
  assert.match(map.get('B4'), /t="inlineStr"/); assert.doesNotMatch(map.get('B4'), /<f>/);
  assert.match(map.get('B4'), /=HYPERLINK\(&quot;bad&quot;\)&lt;&amp;&apos;/);
  assert.match(map.get('C26'), /00000000000000000001/);
  assert.match(map.get('G5'), new RegExp(`<v>${dateValues('2024-02-29').serial}</v>`));
});

test('explicit company name updates only the main title while preserving its style and merged layout', () => {
  const original = fs.readFileSync(DEFAULT_TEMPLATE), baseline = createReimbursementWorkbook({ profile, date: '2026-11-21' });
  const output = createReimbursementWorkbook({ profile: { ...profile, companyName: '合成示例公司' }, date: '2026-11-21' });
  const before = cells(getXml(baseline)), after = cells(getXml(output));
  assert.match(after.get('A1'), /合成示例公司/);
  assert.equal(/\bs="(\d+)"/.exec(after.get('A1'))[1], /\bs="(\d+)"/.exec(before.get('A1'))[1]);
  for (const [ref, content] of before) if (ref !== 'A1') assert.equal(after.get(ref), content, ref);
  const layout = xml => xml.replace(/<c\b[^>]*\br="A1"[^>]*\/>|<c\b[^>]*\br="A1"[^>]*>[\s\S]*?<\/c>/g, '');
  assert.equal(layout(getXml(output)), layout(getXml(baseline)), 'title change preserves all non-title XML, merges and print settings');
  for (const [name, contents] of byName(baseline)) if (name !== 'xl/worksheets/sheet1.xml') assert.deepEqual(byName(output).get(name), contents, name);
  assert.equal(cells(getXml(baseline)).get('A1'), cells(getXml(original)).get('A1'), 'omitted company retains template title');
  const explicitUndefined = createReimbursementWorkbook({ profile: { ...profile, companyName: undefined }, date: '2026-11-21' });
  assert.equal(cells(getXml(explicitUndefined)).get('A1'), before.get('A1'));
  assert.deepEqual(fs.readFileSync(DEFAULT_TEMPLATE), original);
});

test('company title refresh preserves existing managed expense rows and source workbook', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'reimbursement-company-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const categories = [{ key: 'travel', name: '差旅费', count: 1 }];
  const initial = createReimbursementWorkbook({ profile: { ...profile, companyName: '原合成公司' }, date: '2026-11-21', categories });
  const archive = readZip(initial), entry = archive.entries.find(item => item.name === 'xl/worksheets/sheet1.xml');
  entry.data = Buffer.from(entry.data.toString().replace(/<c\b[^>]*\br="G8"[^>]*\/>/, '<c r="G8" s="72"><v>168.25</v></c>'));
  const source = writeZip(archive), templatePath = path.join(directory, 'working.xlsx'); await fsp.writeFile(templatePath, source);
  const refreshed = createReimbursementWorkbook({ templatePath, profile: { ...profile, companyName: '更新合成公司' }, date: '2026-11-21', categories });
  assert.match(cells(getXml(refreshed)).get('A1'), /更新合成公司/);
  assert.match(cells(getXml(refreshed)).get('C8'), /差旅费/);
  assert.match(cells(getXml(refreshed)).get('G8'), /<v>168.25<\/v>/);
  assert.equal(/\bs="(\d+)"/.exec(cells(getXml(refreshed)).get('A1'))[1], /\bs="(\d+)"/.exec(cells(getXml(source)).get('A1'))[1]);
  assert.deepEqual(byName(refreshed).get('xl/worksheets/sheet3.xml'), byName(source).get('xl/worksheets/sheet3.xml'), 'invoice company details remain untouched');
  assert.equal(hash(await fsp.readFile(templatePath)), hash(source));
  const unchanged = createReimbursementWorkbook({ templatePath, profile, date: '2026-11-21', categories });
  assert.equal(cells(getXml(unchanged)).get('A1'), cells(getXml(source)).get('A1'));
});

test('company name is literal escaped text, allows clearing and follows field length validation', () => {
  const literal = createReimbursementWorkbook({ profile: { ...profile, companyName: '=HYPERLINK("x") <合成>&\'' }, date: '2026-11-21' });
  const title = cells(getXml(literal)).get('A1');
  assert.match(title, /t="inlineStr"/); assert.doesNotMatch(title, /<f>/);
  assert.match(title, /=HYPERLINK\(&quot;x&quot;\) &lt;合成&gt;&amp;&apos;/);
  const blank = createReimbursementWorkbook({ profile: { ...profile, companyName: '' }, date: '2026-11-21' });
  assert.match(cells(getXml(blank)).get('A1'), /<t xml:space="preserve"><\/t>/);
  for (const companyName of [123, 'x'.repeat(181), '坏\0名称', '\ud800']) assert.throws(() => createReimbursementWorkbook({ profile: { ...profile, companyName }, date: '2026-11-21' }), /公司名称格式无效或过长/);
});

test('existing expense entries and non-target profile fields survive a compatible custom template', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'reimbursement-template-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const archive = readZip(fs.readFileSync(DEFAULT_TEMPLATE));
  const sheet = archive.entries.find(entry => entry.name === 'xl/worksheets/sheet1.xml');
  sheet.data = Buffer.from(sheet.data.toString().replace('<c r="G8" s="72"/>', '<c r="G8" s="72"><v>112.35</v></c>').replace('<c r="C8" s="69"/>', '<c r="C8" s="69" t="inlineStr"><is><t>原有差旅费</t></is></c>'));
  const templatePath = path.join(directory, 'template.xlsx'); await fsp.writeFile(templatePath, writeZip(archive));
  const output = createReimbursementWorkbook({ templatePath, profile, date: '2026-12-01' }), map = cells(getXml(output));
  assert.match(map.get('G8'), /112.35/); assert.match(map.get('C8'), /原有差旅费/);
  assert.match(map.get('B5'), /<v>7<\/v>/); // unchanged shared-string department
  assert.equal(hash(await fsp.readFile(templatePath)), hash(writeZip(archive)));
});

test('invalid dates, numeric accounts and XML control characters are rejected', () => {
  for (const date of ['2026-2-1', '2026-02-30', '1900-02-29', '1899-12-31', '2026-13-01', '2026-00-00', null]) assert.throws(() => createReimbursementWorkbook({ profile, date }), /日期/);
  for (const invalid of [{ accountNumber: 12345678901234567 }, { applicant: '恶意\0值' }, { bankName: '\ud800' }, { accountName: 'a'.repeat(121) }]) assert.throws(() => createReimbursementWorkbook({ profile: { ...profile, ...invalid }, date: '2026-11-21' }), /格式无效|过长/);
  assert.equal(dateValues('1900-01-01').serial, 1);
  assert.equal(dateValues('1900-03-01').serial, 61);
});

test('ZIP reader/writer preserves all entry data including directory entries', () => {
  const source = fs.readFileSync(DEFAULT_TEMPLATE), sourceParts = byName(source), resultParts = byName(writeZip(readZip(source)));
  assert.equal(resultParts.size, sourceParts.size);
  for (const [name, data] of sourceParts) assert.deepEqual(resultParts.get(name), data, name);
});

test('ZIP traversal, duplicate paths, tampering and declared zip bombs are rejected', () => {
  const archive = writeZip([{ name: 'safe/one.xml', data: Buffer.from('one') }, { name: 'safe/two.xml', data: Buffer.from('two') }]);
  const changeName = (bytes, before, after) => { const result = Buffer.from(bytes); for (let at = result.indexOf(before); at >= 0; at = result.indexOf(before, at + after.length)) result.write(after, at); return result; };
  assert.throws(() => readZip(changeName(archive, 'safe/one.xml', '../evilx.xml')), /不安全/);
  assert.throws(() => readZip(changeName(archive, 'safe/two.xml', 'safe/one.xml')), /重复/);
  const tampered = Buffer.from(archive); tampered[30 + Buffer.byteLength('safe/one.xml')] ^= 0xff;
  assert.throws(() => readZip(tampered), /解压失败|CRC/);
  const bomb = Buffer.from(archive), central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bomb.writeUInt32LE(MAX_BYTES + 1, central + 24);
  assert.throws(() => readZip(bomb), /超过 16 MB/);
  assert.throws(() => writeZip([{ name: '../outside', data: Buffer.alloc(0) }]), /路径/);
});

test('actual deflate output cannot exceed its declared bounded size', () => {
  const data = Buffer.alloc(MAX_BYTES + 1), packed = deflateRawSync(data), filename = Buffer.from('a.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(MAX_BYTES, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); local.copy(central, 8, 6, 26); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + packed.length, 16);
  assert.throws(() => readZip(Buffer.concat([local, filename, packed, central, filename, end])), /解压失败|超限/);
});
