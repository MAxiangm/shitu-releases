'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const MAIN = 'xl/worksheets/sheet1.xml';
const DETAILS = 'xl/worksheets/mosaic-reimbursement-details.xml';
const HISTORY = 'xl/worksheets/mosaic-reimbursement-history.xml';
const DETAIL_NAME = '报销明细续表', HISTORY_NAME = '历史明细（不打印）';
const PROPERTY = 'MosaicReimbursementLayout';
const XMLNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const decode = value => String(value).replace(/&#x([\da-f]+);|&#(\d+);|&(lt|gt|quot|apos|amp);/gi, (_all, hex, decimal, named) => hex ? String.fromCodePoint(parseInt(hex, 16)) : decimal ? String.fromCodePoint(Number(decimal)) : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[named.toLowerCase()]);
const attr = (xml, name) => decode(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`).exec(xml)?.[1] || '');
const cellRegex = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
const rowRegex = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;

function cells(xml) {
  return new Map([...xml.matchAll(cellRegex)].map(match => [attr(match[0].split('>')[0], 'r'), match[0]]));
}
function rows(xml) {
  return new Map([...xml.matchAll(rowRegex)].map(match => [Number(attr(match[0].split('>')[0], 'r')), match[0]]));
}
function withRef(cell, reference) { return cell.replace(/\br=["'][^"']*["']/, `r="${reference}"`); }
function stringCell(base, reference, value) {
  const opening = /^<c\b([^>]*)>/.exec(base || `<c r="${reference}"/>`)[1].replace(/\/\s*$/, '').replace(/\s+t=["'][^"']*["']/, '');
  return `<c${opening} t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`.replace(/\br=["'][^"']*["']/, `r="${reference}"`);
}
function amountCell(base, reference, cents) {
  const opening = /^<c\b([^>]*)>/.exec(base || `<c r="${reference}" s="72"/>`)[1].replace(/\/\s*$/, '').replace(/\s+t=["'][^"']*["']/, '');
  // Build the decimal directly from integer cents; never round through binary
  // floating-point division before serializing the amount into the workbook.
  const value = cents === null ? '' : `<v>${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}</v>`;
  return `<c${opening}>${value}</c>`.replace(/\br=["'][^"']*["']/, `r="${reference}"`);
}
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const validCents = value => value === null || validCount(value);
function pendingInvoices(item) { return item.pendingCount || (Object.hasOwn(item, 'amountCents') && item.amountCents === null ? Math.max(1, item.count || 1) : 0); }
function valueOf(cell, shared) {
  if (!cell) return '';
  if (/\bt=["']inlineStr["']/.test(cell)) return [...cell.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match => decode(match[1])).join('');
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell)?.[1] || '';
  return /\bt=["']s["']/.test(cell) ? shared[Number(value)] || '' : decode(value);
}
function hasInput(record, shared) {
  return [...record.cells].some(([column, cell]) => !['A', 'B'].includes(column) && (/<f(?:\s|>)/.test(cell) || valueOf(cell, shared).trim()));
}
function readMetadata(entries) {
  const custom = entries.get('docProps/custom.xml')?.data.toString('utf8') || '';
  const properties = [...custom.matchAll(/<property\b[^>]*>[\s\S]*?<\/property>/g)].map(match => ({ name: attr(match[0].split('>')[0], 'name'), value: decode(/<(?:\w+:)?lpwstr\b[^>]*>([\s\S]*?)<\/(?:\w+:)?lpwstr>/.exec(match[0])?.[1] || '') }));
  const property = properties.find(item => item.name === PROPERTY);
  if (!property) return null;
  let raw = property.value;
  let metadata;
  try {
    if (raw.startsWith('v2:')) {
      const marker = /^v2:([1-9]\d{0,3}):([a-f0-9]{64})$/.exec(raw);
      if (!marker) throw new Error();
      const count = Number(marker[1]); let packed = '';
      for (let index = 0; index < count; index++) {
        const chunk = properties.filter(item => item.name === `${PROPERTY}.${String(index).padStart(4, '0')}`);
        if (chunk.length !== 1 || !/^[A-Za-z0-9+/=]{1,240}$/.test(chunk[0].value)) throw new Error();
        packed += chunk[0].value;
      }
      raw = inflateRawSync(Buffer.from(packed, 'base64'), { maxOutputLength: 2 * 1024 * 1024 }).toString('utf8');
      if (crypto.createHash('sha256').update(raw).digest('hex') !== marker[2]) throw new Error();
    }
    metadata = JSON.parse(raw);
  } catch { throw new Error('报销明细映射信息损坏，请保留原表后重新生成'); }
  if (metadata.version !== 1 || !Array.isArray(metadata.rows) || !Array.isArray(metadata.history) || metadata.rows.length > 256 || metadata.history.length > 1000) throw new Error('报销明细映射信息无效');
  if (metadata.uppercaseFormula !== undefined && (typeof metadata.uppercaseFormula !== 'string' || !metadata.uppercaseFormula || metadata.uppercaseFormula.length > 50000)) throw new Error('报销金额大写公式无效');
  const keys = new Set(), positions = new Set();
  for (const item of [...metadata.rows, ...metadata.history]) {
    if (!item || typeof item.key !== 'string' || item.key.length > 160 || keys.has(item.key) || typeof item.name !== 'string' || item.name.length > 200 || !Number.isInteger(item.row) || item.row < 1 || item.row > 2000 || !['main', 'details', 'history'].includes(item.kind)) throw new Error('报销明细映射行无效');
    if (item.formulaCells && (typeof item.formulaCells !== 'object' || Object.entries(item.formulaCells).some(([column, xml]) => !/^[A-Z]{1,3}$/.test(column) || typeof xml !== 'string' || xml.length > 50000))) throw new Error('历史明细公式无效');
    if (Object.hasOwn(item, 'amountCents') && !validCents(item.amountCents) || item.pendingCount !== undefined && !validCount(item.pendingCount) || item.count !== undefined && !validCount(item.count)) throw new Error('报销分类金额信息无效');
    if (positions.has(`${item.kind}:${item.row}`) || item.kind === 'main' && (item.row < 8 || item.row > 17) || item.kind !== 'main' && item.row < 5) throw new Error('报销明细映射位置无效');
    positions.add(`${item.kind}:${item.row}`);
    keys.add(item.key);
  }
  return metadata;
}
function putEntry(archive, name, data) {
  const existing = archive.entries.find(entry => entry.name === name);
  if (existing) existing.data = Buffer.from(data);
  else archive.entries.push({ name, data: Buffer.from(data), method: 8, flags: 0x800 });
}
function findSheet(archive, name) {
  const workbook = archive.entries.find(entry => entry.name === 'xl/workbook.xml').data.toString('utf8');
  const sheet = [...workbook.matchAll(/<sheet\b[^>]*\/>/g)].find(match => attr(match[0], 'name') === name)?.[0];
  if (!sheet) return null;
  const id = attr(sheet, 'r:id');
  const relationships = archive.entries.find(entry => entry.name === 'xl/_rels/workbook.xml.rels')?.data.toString('utf8') || '';
  const relationship = [...relationships.matchAll(/<Relationship\b[^>]*\/>/g)].find(match => attr(match[0], 'Id') === id)?.[0];
  if (!relationship || attr(relationship, 'TargetMode') === 'External' || !attr(relationship, 'Type').endsWith('/worksheet')) throw new Error('报销明细工作表关系无效');
  const target = attr(relationship, 'Target');
  const filename = path.posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  if (!filename.startsWith('xl/worksheets/') || !archive.entries.some(entry => entry.name === filename)) throw new Error('报销明细工作表文件缺失');
  return { sheet, id, filename };
}
function ensureRelationship(archive, filename, id, type, target) {
  let xml = archive.entries.find(entry => entry.name === filename)?.data.toString('utf8');
  if (!xml) xml = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const found = [...xml.matchAll(/<Relationship\b[^>]*\/>/g)].find(match => attr(match[0], 'Id') === id)?.[0];
  if (found && (attr(found, 'Type') !== type || attr(found, 'Target') !== target)) throw new Error('报销明细关系与现有工作簿冲突');
  if (!found) xml = xml.replace('</Relationships>', `<Relationship Id="${id}" Type="${type}" Target="${target}"/></Relationships>`);
  putEntry(archive, filename, xml);
}
function contentType(archive, name, type) {
  const entry = archive.entries.find(entry => entry.name === '[Content_Types].xml');
  let xml = entry.data.toString('utf8');
  const existing = [...xml.matchAll(/<Override\b[^>]*\/>/g)].find(match => attr(match[0], 'PartName') === `/${name}`)?.[0];
  if (existing && attr(existing, 'ContentType') !== type) throw new Error('报销明细文件类型冲突');
  if (!existing) xml = xml.replace('</Types>', `<Override PartName="/${name}" ContentType="${type}"/></Types>`);
  entry.data = Buffer.from(xml);
}
function ensureSheet(archive, name, filename, id, visible, alreadyManaged) {
  const workbook = archive.entries.find(entry => entry.name === 'xl/workbook.xml');
  let xml = workbook.data.toString('utf8');
  const matches = [...xml.matchAll(/<sheet\b[^>]*\/>/g)];
  const existing = matches.find(match => attr(match[0], 'name') === name)?.[0];
  if (existing && !alreadyManaged) throw new Error(`工作簿已有“${name}”，请先改名后再生成报销明细`);
  if (existing) {
    const resolved = findSheet(archive, name);
    filename = resolved.filename;
    id = resolved.id;
    const cleaned = existing.replace(/\s+state=["'][^"']*["']/, '');
    xml = xml.replace(existing, cleaned.replace('/>', visible ? '/>' : ' state="hidden"/>'));
  } else {
    const sheetId = Math.max(0, ...matches.map(match => Number(attr(match[0], 'sheetId')) || 0)) + 1;
    xml = xml.replace('</sheets>', `<sheet name="${escape(name)}" sheetId="${sheetId}" r:id="${id}"${visible ? '' : ' state="hidden"'}/></sheets>`);
  }
  workbook.data = Buffer.from(xml);
  if (!existing) ensureRelationship(archive, 'xl/_rels/workbook.xml.rels', id, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', filename.slice(3));
  contentType(archive, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
  return filename;
}
function saveMetadata(archive, metadata) {
  const name = 'docProps/custom.xml';
  let xml = archive.entries.find(entry => entry.name === name)?.data.toString('utf8') || '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>';
  const properties = [...xml.matchAll(/<property\b[^>]*>[\s\S]*?<\/property>/g)];
  const owned = name => name === PROPERTY || new RegExp(`^${PROPERTY}\\.\\d{4}$`).test(name);
  let pid = Math.max(1, ...properties.filter(match => !owned(attr(match[0].split('>')[0], 'name'))).map(match => Number(attr(match[0].split('>')[0], 'pid')) || 0)) + 1;
  for (const property of properties) if (owned(attr(property[0].split('>')[0], 'name'))) xml = xml.replace(property[0], '');
  const raw = JSON.stringify(metadata);
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('报销明细历史信息过多，请先备份整理历史明细');
  const packed = deflateRawSync(Buffer.from(raw)).toString('base64');
  const chunks = packed.match(/.{1,240}/g) || [''];
  if (chunks.length > 9999) throw new Error('报销明细历史信息过多，请先备份整理历史明细');
  // Desktop Excel trims each custom string property at 255 characters. Store
  // compressed metadata in short ASCII chunks, retaining old JSON on read.
  const values = [[PROPERTY, `v2:${chunks.length}:${crypto.createHash('sha256').update(raw).digest('hex')}`], ...chunks.map((chunk, index) => [`${PROPERTY}.${String(index).padStart(4, '0')}`, chunk])];
  const generated = values.map(([name, value]) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid++}" name="${name}"><vt:lpwstr>${escape(value)}</vt:lpwstr></property>`).join('');
  xml = xml.replace('</Properties>', `${generated}</Properties>`);
  putEntry(archive, name, xml);
  ensureRelationship(archive, '_rels/.rels', 'rIdMosaicReimbursementCustom', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties', name);
  // The supplied template already has its custom-property relationship. Do not
  // add a duplicate relationship for that same target.
  const relations = archive.entries.find(entry => entry.name === '_rels/.rels');
  const relXml = relations.data.toString('utf8'), targets = [...relXml.matchAll(/<Relationship\b[^>]*\/>/g)].filter(match => attr(match[0], 'Target') === name);
  if (targets.length > 1) relations.data = Buffer.from(relXml.replace(targets.find(match => attr(match[0], 'Id') === 'rIdMosaicReimbursementCustom')[0], ''));
  contentType(archive, name, 'application/vnd.openxmlformats-officedocument.custom-properties+xml');
}
function formula(cell, value) {
  const opening = /^<c\b([^>]*)>/.exec(cell)[1].replace(/\/\s*$/, '').replace(/\s+t=["'][^"']*["']/, '');
  return `<c${opening}><f>${escape(value)}</f></c>`;
}
function translateFormula(value, sourceKind, targetKind, locations) {
  const names = { main: '费用申请表', details: DETAIL_NAME, history: HISTORY_NAME };
  const kinds = new Map(Object.entries(names).map(([kind, name]) => [name, kind]));
  const reference = /(?<![\p{L}\p{N}_])(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?(\$?[A-Z]{1,3})(\$?)([1-9]\d{0,6})(?![\p{L}\p{N}_])/gu;
  const token = "(?:(?:'(?:[^']|'')+'|[\\p{L}_][\\p{L}\\p{N}_.]*)!)?\\$?[A-Z]{1,3}\\$?[1-9]\\d{0,6}";
  const range = new RegExp(`(?<![\\p{L}\\p{N}_])(${token})\\s*:\\s*(${token})(?![\\p{L}\\p{N}_])`, 'gu');
  const quote = kind => `'${names[kind].replace(/'/g, "''")}'!`;
  return value.split(/("(?:[^"]|"")*")/g).map((part, index) => {
    if (index % 2) return part;
    const ranges = [];
    part = part.replace(range, (all, first, last) => {
      const start = [...first.matchAll(reference)][0], end = [...last.matchAll(reference)][0];
      const firstName = start[1]?.replace(/''/g, "'") || start[2];
      const lastName = end[1]?.replace(/''/g, "'") || end[2] || firstName;
      const firstKind = firstName ? kinds.get(firstName) : sourceKind;
      const lastKind = lastName ? kinds.get(lastName) : sourceKind;
      let result = all;
      if (firstKind && lastKind) {
        const firstRow = Number(start[5]), lastRow = Number(end[5]);
        if (firstKind !== lastKind || Math.abs(firstRow - lastRow) > 2000) {
          // A large unchanged range is safe to retain; a range touching any moved
          // detail row requires a manual review rather than a misleading formula.
          const touched = [...locations].some(([key, target]) => key.startsWith(`${firstKind}:`) && Number(key.split(':')[1]) >= Math.min(firstRow, lastRow) && Number(key.split(':')[1]) <= Math.max(firstRow, lastRow) && (target.kind !== firstKind || target.row !== Number(key.split(':')[1])));
          if (firstKind !== lastKind || touched) throw new Error('跨行公式在分类重排后不再是连续区域，请先在 Excel 中调整该明细公式');
          if (!firstName && firstKind !== targetKind) result = quote(firstKind) + all;
        } else {
          const step = firstRow <= lastRow ? 1 : -1;
          const moved = [];
          for (let row = firstRow; ; row += step) { moved.push(locations.get(`${firstKind}:${row}`) || { kind: firstKind, row }); if (row === lastRow) break; }
          if (moved.some((target, i) => target.kind !== moved[0].kind || target.row !== moved[0].row + i * step)) throw new Error('跨行公式在分类重排后不再是连续区域，请先在 Excel 中调整该明细公式');
          result = `${firstName || moved[0].kind !== targetKind ? quote(moved[0].kind) : ''}${start[3]}${start[4]}${moved[0].row}:${end[3]}${end[4]}${moved.at(-1).row}`;
        }
      }
      const marker = `\x01${ranges.length}\x02`; ranges.push(result); return marker;
    });
    part = part.replace(reference, (all, quoted, unquoted, column, absolute, row, position) => {
    if (part[position + all.length] === '(') return all;
    const explicit = quoted?.replace(/''/g, "'") || unquoted;
    const kind = explicit ? kinds.get(explicit) : sourceKind;
    if (!kind) return all; // External/other-sheet references remain exactly intact.
    const moved = locations.get(`${kind}:${row}`);
    if (!moved) return !explicit && kind !== targetKind ? `'${names[kind].replace(/'/g, "''")}'!${column}${absolute}${row}` : all;
    return `${moved.kind === targetKind && !explicit ? '' : `'${names[moved.kind].replace(/'/g, "''")}'!`}${column}${absolute}${moved.row}`;
    });
    return part.replace(/\x01(\d+)\x02/g, (_all, number) => ranges[Number(number)]);
  }).join('');
}
function renderRecord(record, target, sequence, date, shared, locations, archiveMode = false) {
  const result = new Map(); const formulaCells = {};
  const automaticAmount = !archiveMode && record.managed && (Object.hasOwn(record, 'amountCents') || pendingInvoices(record) > 0);
  for (const [column, original] of record.cells) {
    if (column === 'G' && automaticAmount) { result.set(column, withRef(original, `G${target.row}`)); continue; }
    if (/<f\b[^>]*\bt=["'](?:shared|array|dataTable)["']/.test(original)) throw new Error('明细包含共享或数组公式，请先在 Excel 中转换为独立单元格公式后再调整分类');
    let cell = withRef(original, `${column}${target.row}`);
    cell = cell.replace(/(<f\b[^>]*>)([\s\S]*?)(<\/f>)/g, (_all, begin, text, end) => begin + escape(translateFormula(decode(text), record.source.kind, target.kind, locations)) + end);
    if (/<f(?:\s|>)/.test(cell)) {
      if (archiveMode) { formulaCells[column] = cell; cell = cell.replace(/<f\b[^>]*>[\s\S]*?<\/f>/g, ''); }
      else cell = cell.replace(/<v\b[^>]*>[\s\S]*?<\/v>/g, '');
    }
    result.set(column, cell);
  }
  result.set('A', formula(result.get('A') || `<c r="A${target.row}" s="67"/>`, String(sequence)).replace(`<f>${sequence}</f>`, `<v>${sequence}</v>`));
  if (!archiveMode) {
    result.set('B', stringCell(result.get('B') || `<c r="B${target.row}" s="68"/>`, `B${target.row}`, date));
    if (record.managed && !/<f(?:\s|>)/.test(result.get('C') || '') && ['', record.autoName || record.name].includes(valueOf(result.get('C'), shared))) result.set('C', stringCell(result.get('C') || `<c r="C${target.row}" s="69"/>`, `C${target.row}`, record.name));
    if (automaticAmount) result.set('G', amountCell(result.get('G'), `G${target.row}`, pendingInvoices(record) > 0 ? null : record.amountCents));
  }
  const attributes = record.attributes.replace(/\br=["'][^"']*["']/, `r="${target.row}"`).replace(/\/\s*$/, '');
  return { xml: `<row${attributes}>${[...result.values()].join('')}</row>`, formulaCells };
}
function makeSheet(title, detailRows, headerCells, cols, pageSetup, pageMargins, applicant, date, history = false, pendingMessage = '') {
  const header = [...headerCells].map(([column, cell]) => withRef(cell, `${column}4`)).join('');
  const last = detailRows.length + 4;
  const totalAmount = pendingMessage ? stringCell(`<c r="G${last + 1}" s="75"/>`, `G${last + 1}`, pendingMessage) : `<c r="G${last + 1}" s="75"><f>${detailRows.length ? `SUM(G5:G${last})` : '0'}</f></c>`;
  const totalRow = history ? '' : `<row r="${last + 1}" ht="24"><c r="A${last + 1}" s="74" t="inlineStr"><is><t>续表合计</t></is></c>${totalAmount}</row>`;
  const merges = ['A1:G1', 'A2:G2', 'C4:F4', ...detailRows.map((_row, index) => `C${index + 5}:F${index + 5}`), ...(history ? [] : [`A${last + 1}:F${last + 1}`])];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${XMLNS}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:G${last + (history ? 0 : 1)}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="27"/>${cols}<sheetData><row r="1" ht="28"><c r="A1" s="40" t="inlineStr"><is><t>${escape(title)}</t></is></c></row><row r="2" ht="24"><c r="A2" s="1" t="inlineStr"><is><t>${escape(history ? '无凭证或已删除分类的历史明细；不计入本次报销合计。' : `申请人：${applicant}　日期：${date}`)}</t></is></c></row><row r="4" ht="24">${header}</row>${detailRows.join('')}${totalRow}</sheetData><mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>${pageMargins}${pageSetup}<headerFooter/></worksheet>`;
}

function applyCategoryRows({ archive, mainXml, categories, applicant, date, fallbackUppercaseFormula }) {
  const entries = new Map(archive.entries.map(entry => [entry.name, entry]));
  const metadata = readMetadata(entries);
  if (categories === undefined && !metadata) return mainXml;
  if (categories === undefined) categories = metadata.rows.filter(item => item.managed).map(item => ({ key: item.key, name: item.name, count: item.count ?? 1, ...(Object.hasOwn(item, 'amountCents') ? { amountCents: item.amountCents } : {}), ...(item.pendingCount !== undefined ? { pendingCount: item.pendingCount } : {}) }));
  if (!Array.isArray(categories) || categories.length > 30) throw new Error('报销表最多支持 30 个有凭证的分类');
  const seen = new Set();
  const active = categories.filter(item => (item?.key !== 'supplement' || Object.hasOwn(item || {}, 'amountCents')) && item?.count !== 0).map(item => {
    if (!item || typeof item.key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.key) || seen.has(item.key) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || /[\x00-\x1f\x7f]/.test(item.name) || item.count !== undefined && (!Number.isInteger(item.count) || item.count < 0)) throw new Error('报销分类明细参数无效');
    if (Object.hasOwn(item, 'amountCents') && !validCents(item.amountCents) || item.pendingCount !== undefined && !validCount(item.pendingCount) || item.count !== undefined && !validCount(item.count)) throw new Error('报销分类金额信息无效');
    seen.add(item.key); return { key: item.key, name: item.name.trim(), ...(Object.hasOwn(item, 'amountCents') ? { amountCents: item.amountCents } : {}), ...(item.pendingCount !== undefined ? { pendingCount: item.pendingCount } : {}), ...(item.count !== undefined ? { count: item.count } : {}) };
  });
  let automaticTotal = 0, pendingCount = 0;
  for (const item of active) {
    automaticTotal += item.amountCents || 0; pendingCount += pendingInvoices(item);
    if (!Number.isSafeInteger(automaticTotal) || !Number.isSafeInteger(pendingCount)) throw new Error('报销分类金额或待核对数量超过安全范围');
  }
  const detailsSheet = metadata?.details ? findSheet(archive, DETAIL_NAME) : null;
  const historySheet = metadata?.archive ? findSheet(archive, HISTORY_NAME) : null;
  if (metadata?.details && !detailsSheet || metadata?.archive && !historySheet) throw new Error('报销明细工作表已删除或改名，请保留原表后检查');
  const xmls = { main: mainXml, details: entries.get(detailsSheet?.filename)?.data.toString('utf8'), history: entries.get(historySheet?.filename)?.data.toString('utf8') };
  const rowMaps = Object.fromEntries(Object.entries(xmls).map(([kind, value]) => [kind, rows(value || '')]));
  const shared = [...(entries.get('xl/sharedStrings.xml')?.data.toString('utf8') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(part => decode(part[1])).join(''));
  const defaultCells = new Map([...cells(rowMaps.main.get(8)).values()].map(cell => [attr(cell.split('>')[0], 'r').replace(/\d+$/, ''), cell.replace(/>[\s\S]*<\/c>$/, '/>').replace(/\s+t=["'][^"']*["']/, '')]));
  const readRecord = item => {
    const raw = rowMaps[item.kind].get(item.row);
    if (!raw) throw new Error('已保存的报销明细行缺失，请保留原表后检查');
    const recordCells = new Map([...cells(raw)].map(([reference, xml]) => [reference.replace(/\d+$/, ''), xml]));
    for (const [column, xml] of Object.entries(item.formulaCells || {})) recordCells.set(column, xml);
    return { ...item, cells: recordCells, source: { kind: item.kind, row: item.row }, attributes: /^<row\b([^>]*)>/.exec(raw)[1] };
  };
  const records = (metadata?.rows || []).map(readRecord), archived = (metadata?.history || []).map(readRecord);
  const managed = new Map(records.filter(item => item.managed).map(item => [item.key, item]));
  const archiveMap = new Map(archived.map(item => [item.key, item]));
  const occupied = new Set(records.map(item => `${item.source.kind}:${item.source.row}`));
  for (let row = 8; row <= 17; row++) if (!occupied.has(`main:${row}`)) {
    const item = readRecord({ key: `legacy-${crypto.randomUUID()}`, name: '', kind: 'main', row, managed: false });
    if (hasInput(item, shared)) records.push(item);
  }
  const printed = active.map(item => {
    const existing = managed.get(item.key) || archiveMap.get(item.key); archiveMap.delete(item.key);
    if (!existing) return { ...item, autoName: item.name, managed: true, cells: new Map(defaultCells), source: { kind: 'new', row: item.key }, attributes: ' r="8" ht="27" customHeight="1"' };
    const { amountCents, pendingCount, count, ...preserved } = existing;
    return { ...preserved, ...item };
  });
  for (const record of managed.values()) if (!seen.has(record.key)) archiveMap.set(record.key, record);
  printed.push(...records.filter(item => !item.managed && hasInput(item, shared)));
  if (printed.length > 256 || archiveMap.size > 1000) throw new Error('保留的报销明细过多，请先备份整理历史明细');
  const historical = [...archiveMap.values()], locations = new Map();
  const target = index => index < 10 ? { kind: 'main', row: index + 8 } : { kind: 'details', row: index - 10 + 5 };
  printed.forEach((record, index) => { if (record.source.kind !== 'new') locations.set(`${record.source.kind}:${record.source.row}`, target(index)); });
  historical.forEach((record, index) => locations.set(`${record.source.kind}:${record.source.row}`, { kind: 'history', row: index + 5 }));
  const outputRows = printed.map((record, index) => renderRecord(record, target(index), index + 1, date, shared, locations).xml);
  let index = 0;
  mainXml = mainXml.replace(rowRegex, row => {
    const number = Number(attr(row.split('>')[0], 'r'));
    if (number < 8 || number > 17) return row;
    if (index < Math.min(printed.length, 10)) return outputRows[index++];
    index++;
    const blank = { cells: new Map(defaultCells), source: { kind: 'main', row: 8 }, attributes: /^<row\b([^>]*)>/.exec(row)[1], managed: false };
    return renderRecord(blank, { kind: 'main', row: number }, number - 7, date, shared, new Map()).xml;
  });
  const overflow = outputRows.slice(10);
  const sum = `SUM(G8:G17${overflow.length ? `,'${DETAIL_NAME}'!G5:G${overflow.length + 4}` : ''})`;
  const uppercaseCell = cells(mainXml).get('B18');
  const currentUppercaseFormula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(uppercaseCell || '')?.[1];
  const needsAutomaticFormula = pendingCount > 0 || active.some(item => Object.hasOwn(item, 'amountCents')) || metadata?.uppercaseFormula;
  const uppercaseFormula = currentUppercaseFormula ? decode(currentUppercaseFormula) : metadata?.uppercaseFormula || (needsAutomaticFormula ? fallbackUppercaseFormula?.() : undefined);
  const pendingMessage = pendingCount ? `待核对（${pendingCount}张）` : '';
  mainXml = mainXml.replace(cellRegex, cell => {
    const reference = attr(cell.split('>')[0], 'r');
    if (reference === 'G18') return pendingMessage ? stringCell(cell, reference, pendingMessage) : formula(cell, sum);
    if (reference !== 'B18') return cell;
    if (pendingMessage) return stringCell(cell, reference, pendingMessage);
    return currentUppercaseFormula ? cell.replace(/<v\b[^>]*>[\s\S]*?<\/v>/g, '') : uppercaseFormula ? formula(cell, uppercaseFormula) : cell;
  });
  const cols = /<cols>[\s\S]*?<\/cols>/.exec(mainXml)?.[0] || '';
  const setup = /<pageSetup\b[^>]*\/>/.exec(mainXml)?.[0] || '<pageSetup paperSize="9" orientation="landscape"/>';
  const margins = /<pageMargins\b[^>]*\/>/.exec(mainXml)?.[0] || '';
  const header = new Map([...cells(rowMaps.main.get(7))].map(([ref, cell]) => [ref.replace(/\d+$/, ''), cell]));
  if (overflow.length || metadata?.details) {
    const filename = ensureSheet(archive, DETAIL_NAME, DETAILS, 'rIdMosaicReimbursementDetails', Boolean(overflow.length), metadata?.details === true);
    putEntry(archive, filename, makeSheet(DETAIL_NAME, overflow, header, cols, setup, margins, applicant, date, false, pendingMessage));
  }
  const historyRows = historical.map((record, index) => renderRecord(record, { kind: 'history', row: index + 5 }, index + 1, date, shared, locations, true));
  if (historyRows.length || metadata?.archive) {
    const filename = ensureSheet(archive, HISTORY_NAME, HISTORY, 'rIdMosaicReimbursementHistory', false, metadata?.archive === true);
    putEntry(archive, filename, makeSheet(HISTORY_NAME, historyRows.map(item => item.xml), header, cols, setup, margins, applicant, date, true));
  }
  const amountMetadata = item => ({ ...(Object.hasOwn(item, 'amountCents') ? { amountCents: item.amountCents } : {}), ...(item.pendingCount !== undefined ? { pendingCount: item.pendingCount } : {}), ...(item.count !== undefined ? { count: item.count } : {}) });
  saveMetadata(archive, { version: 1, details: Boolean(overflow.length || metadata?.details), archive: Boolean(historyRows.length || metadata?.archive), ...(pendingMessage || metadata?.uppercaseFormula ? { uppercaseFormula } : {}), rows: printed.map((item, index) => ({ key: item.key, name: item.name, autoName: item.managed ? item.name : '', managed: item.managed, ...target(index), ...amountMetadata(item) })), history: historical.map((item, index) => ({ key: item.key, name: item.name, autoName: item.autoName || item.name, managed: item.managed, kind: 'history', row: index + 5, ...amountMetadata(item), ...(Object.keys(historyRows[index].formulaCells).length ? { formulaCells: historyRows[index].formulaCells } : {}) })) });
  return mainXml;
}
module.exports = { applyCategoryRows, readMetadata, DETAIL_NAME, HISTORY_NAME, DETAILS, HISTORY };
