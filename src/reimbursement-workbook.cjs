'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readZip, writeZip, MAX_BYTES } = require('./xlsx-zip.cjs');
const { applyCategoryRows } = require('./reimbursement-rows.cjs');

const DEFAULT_TEMPLATE = path.join(__dirname, '../assets/reimbursement-template.xlsx');
const escapeXml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function field(value, name, maximum) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value) || [...value].some(character => { const code = character.codePointAt(0); return code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff; })) throw new Error(`${name}格式无效或过长`);
  return value.trim();
}
function dateValues(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('报销日期必须使用 YYYY-MM-DD 格式');
  const [year, month, day] = value.split('-').map(Number), stamp = Date.UTC(year, month - 1, day);
  if (year < 1900 || year > 9999 || new Date(stamp).toISOString().slice(0, 10) !== value) throw new Error('报销日期无效');
  const serial = (stamp - Date.UTC(1899, 11, 31)) / 86400000 + (stamp >= Date.UTC(1900, 2, 1) ? 1 : 0);
  return { serial, iso: value, chinese: `${year}年${month}月${day}日` };
}
function patchCells(xml, replacements) {
  const found = new Set();
  const result = xml.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, original => {
    const opening = /^<c\b([^>]*)>/.exec(original);
    if (!opening) return original;
    const reference = /\br\s*=\s*(['"])(.*?)\1/.exec(opening[1])?.[2];
    if (!Object.hasOwn(replacements, reference)) return original;
    if (found.has(reference)) throw new Error(`报销模板包含重复单元格 ${reference}`);
    found.add(reference);
    const replacement = replacements[reference];
    let attributes = opening[1].replace(/\/\s*$/, '').replace(/\s+t\s*=\s*(['"])[\s\S]*?\1/, '');
    const content = replacement.type === 'number' ? `<v>${replacement.value}</v>` : `<is><t xml:space="preserve">${escapeXml(replacement.value)}</t></is>`;
    return `<c${attributes}${replacement.type === 'number' ? '' : ' t="inlineStr"'}>${content}</c>`;
  });
  for (const reference of Object.keys(replacements)) if (!found.has(reference)) throw new Error(`报销模板缺少单元格 ${reference}`);
  return result;
}
function readTemplate(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('报销模板路径无效');
  const handle = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size < 22 || stat.size > MAX_BYTES) throw new Error('报销模板必须是 16 MB 以内的 XLSX 文件');
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0, count;
    while ((count = fs.readSync(handle, bytes, offset, bytes.length - offset, null))) { offset += count; if (offset === bytes.length) throw new Error('报销模板在读取时发生变化'); }
    if (offset !== stat.size) throw new Error('报销模板在读取时发生变化');
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(handle); }
}
function createReimbursementWorkbook({ templatePath = DEFAULT_TEMPLATE, profile = {}, date, categories } = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('报销人信息无效');
  const applicant = field(profile.applicant, '申请人', 80), accountName = field(profile.accountName, '开户名称', 120), bankName = field(profile.bankName, '开户行', 180), accountNumber = field(profile.accountNumber, '账号', 100);
  const companyName = profile.companyName === undefined ? undefined : field(profile.companyName, '公司名称', 180);
  const chosenDate = dateValues(date), archive = readZip(readTemplate(templatePath));
  const byName = new Map(archive.entries.map(entry => [entry.name, entry]));
  for (const name of ['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']) if (!byName.has(name)) throw new Error('请选择兼容的北京正月报销模板');
  const workbook = byName.get('xl/workbook.xml').data.toString('utf8');
  if (!workbook.includes('name="费用申请表"') || !workbook.includes('name="附表-凭证粘贴用纸"') || /\bdate1904\s*=\s*["'](?:1|true)["']/.test(workbook)) throw new Error('报销模板工作表或日期系统不兼容');
  const text = value => ({ type: 'text', value }), number = value => ({ type: 'number', value: String(value) });
  const main = byName.get('xl/worksheets/sheet1.xml');
  let mainXml = main.data.toString('utf8');
  // Repair only the confirmed wrong blank-cell comparison. Leave the existing
  // uppercase formula and its Excel recalculation behavior otherwise intact.
  mainXml = mainXml.replace(/(<c\b[^>]*\br="B18"[^>]*>[\s\S]*?<f\b[^>]*>)([\s\S]*?)(<\/f>)/, (_all, begin, formula, end) => `${begin}${formula.replace('TRUNC(G18)=C6', 'TRUNC(G18)=G18')}${end}`);
  mainXml = applyCategoryRows({ archive, mainXml, categories, applicant, date: chosenDate.iso, fallbackUppercaseFormula: () => {
    const template = readZip(readTemplate(DEFAULT_TEMPLATE)).entries.find(entry => entry.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
    const formula = /<c\b[^>]*\br="B18"[^>]*>[\s\S]*?<f\b[^>]*>([\s\S]*?)<\/f>/.exec(template)?.[1];
    return formula?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace('TRUNC(G18)=C6', 'TRUNC(G18)=G18');
  } });
  mainXml = patchCells(mainXml, {
    ...(companyName === undefined ? {} : { A1: text(companyName) }),
    B4: text(applicant), C24: text(accountName), C25: text(bankName), C26: text(accountNumber),
    G5: number(chosenDate.serial), A28: text(`申请人：${applicant}\n\n日期：${chosenDate.chinese}`),
    ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`B${index + 8}`, text(chosenDate.iso)]))
  });
  main.data = Buffer.from(mainXml);
  const attachment = byName.get('xl/worksheets/sheet2.xml');
  attachment.data = Buffer.from(patchCells(attachment.data.toString('utf8'), { H2: text(applicant), H3: number(chosenDate.serial) }));
  // Recalculate on open, including when the recipient later enters expenses.
  byName.get('xl/workbook.xml').data = Buffer.from(byName.get('xl/workbook.xml').data.toString('utf8').replace(/<calcPr\b([^>]*?)\/>/, (_all, attrs) => `<calcPr${attrs.replace(/\s+(?:fullCalcOnLoad|forceFullCalc|calcMode)="[^"]*"/g, '')} fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/>`));
  return writeZip(archive);
}
module.exports = { createReimbursementWorkbook, DEFAULT_TEMPLATE, dateValues, patchCells };
