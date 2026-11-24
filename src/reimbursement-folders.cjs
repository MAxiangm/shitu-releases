'use strict';

const { IMAGE } = require('./media-formats.cjs');

const CATEGORIES = Object.freeze([
  { key: 'travel', name: '出行' }, { key: 'equipment', name: '设备' },
  { key: 'membership', name: '会员' }, { key: 'other', name: '其他' },
  { key: 'supplement', name: '补票' }
].map(Object.freeze));
const DOCUMENT_KINDS = Object.freeze({
  form: Object.freeze({ extension: 'xlsx', pointer: 'formAssetId' }),
  supplementPdf: Object.freeze({ extension: 'pdf', pointer: 'supplementPdfAssetId' }),
  invoicePdf: Object.freeze({ extension: 'pdf', pointer: 'invoicePdfAssetId' }),
  supplementInvoicePdf: Object.freeze({ extension: 'pdf', pointer: 'supplementInvoicePdfAssetId' }),
  itineraryPdf: Object.freeze({ extension: 'pdf', pointer: 'itineraryPdfAssetId' })
});
const INVOICE_IMAGES_PER_PAGE = Object.freeze([1, 2, 3, 4, 6, 8, 9]);
const DEFAULT_INVOICE_PDF_OPTIONS = Object.freeze({ imagesPerPage: 2 });
const ID = /^[a-zA-Z0-9-]{1,128}$/;
const CATEGORY_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_CATEGORIES = 30;
const MAX_AMOUNT_CENTS = 999999999999;
const SHA256 = /^[a-f0-9]{64}$/;
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validId = value => typeof value === 'string' && ID.test(value);
const isRoot = folder => folder?.kind === 'reimbursement';
const isCategory = folder => typeof folder?.reimbursementRootId === 'string';
const isSupplementInvoice = asset => asset?.ext === 'pdf' || asset?.reimbursementSupplementInvoice === true;

function categoryName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('分类名称不能为空');
  if (/[\x00-\x1f\x7f]/.test(value) || [...value].some(character => {
    const code = character.codePointAt(0);
    return code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff;
  })) throw new Error('分类名称包含无效字符');
  const name = value.trim();
  if (name.length > 100) throw new Error('分类名称不能超过 100 个字符');
  return name;
}

function normalizeCategories(categories) {
  if (!Array.isArray(categories) || categories.length > MAX_CATEGORIES) throw new Error('报销分类最多可设置 30 项');
  const keys = new Set(), names = new Set();
  return categories.map(category => {
    if (!plain(category) || Object.keys(category).some(key => !['key', 'name'].includes(key)) ||
        typeof category.key !== 'string' || !CATEGORY_KEY.test(category.key) || keys.has(category.key)) throw new Error('报销分类标识无效或重复');
    const name = categoryName(category.name);
    if (names.has(name)) throw new Error('同级文件夹中已存在此名称');
    keys.add(category.key); names.add(name);
    return { key: category.key, name };
  });
}

function listCategories(folders, root) {
  if (typeof root === 'string') root = folders.find(folder => folder.id === root);
  if (!isRoot(root)) return [];
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  return Object.entries(root.reimbursement?.categoryIds || {}).map(([key, folderId], index) => {
    const folder = byId.get(folderId);
    return folder ? { key, name: folder.name, folderId, index, sortOrder: folder.sortOrder ?? index } : null;
  }).filter(Boolean).sort((left, right) => left.sortOrder - right.sortOrder || left.index - right.index)
    .map(({ key, name, folderId }) => ({ key, name, folderId }));
}

function findRoot(folders, id) {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const seen = new Set();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    if (isRoot(current)) return current;
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
  return null;
}

function categoryForFolder(folders, id) {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const seen = new Set();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    if (isCategory(current)) return current.reimbursementCategory;
    if (isRoot(current)) return null;
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
  return null;
}

function itineraryRootForFolder(folders, id) {
  const root = findRoot(folders, id), itineraryId = root?.reimbursement?.itineraryFolderId;
  if (!itineraryId) return null;
  const byId = new Map(folders.map(folder => [folder.id, folder])), seen = new Set();
  let current = byId.get(id);
  while (current && current.id !== root.id && !seen.has(current.id)) {
    if (current.id === itineraryId) return root;
    seen.add(current.id); current = byId.get(current.parentId);
  }
  return null;
}

function categoryMap(folders) {
  const byId = new Map(folders.map(folder => [folder.id, folder])), resolved = new Map();
  for (const folder of folders) {
    const chain = [], visiting = new Set();
    let current = folder, category = null;
    while (current && !visiting.has(current.id)) {
      if (resolved.has(current.id)) { category = resolved.get(current.id); break; }
      if (isCategory(current)) { category = current.reimbursementCategory; break; }
      if (isRoot(current)) break;
      visiting.add(current.id); chain.push(current.id); current = byId.get(current.parentId);
    }
    resolved.set(folder.id, category);
    for (const id of chain) resolved.set(id, category);
  }
  return resolved;
}

function documentKind(kind) {
  if (!Object.hasOwn(DOCUMENT_KINDS, kind)) throw new Error('报销文档类型无效');
  return DOCUMENT_KINDS[kind];
}

function invoicePdfOptions(value = DEFAULT_INVOICE_PDF_OPTIONS) {
  if (!plain(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'imagesPerPage') || !INVOICE_IMAGES_PER_PAGE.includes(value.imagesPerPage)) throw new Error('发票 PDF 排版参数无效');
  return { imagesPerPage: value.imagesPerPage };
}

function invoicePdfSignature(value) {
  if (value !== null && (typeof value !== 'string' || !SHA256.test(value))) throw new Error('发票 PDF 生成签名无效');
  return value;
}

function invoicePdfFields(scope = 'regular') {
  if (scope !== 'regular' && scope !== 'supplement') throw new Error('发票 PDF 范围无效');
  return scope === 'supplement'
    ? { options: 'supplementInvoicePdfOptions', signature: 'supplementInvoicePdfSignature' }
    : { options: 'invoicePdfOptions', signature: 'invoicePdfSignature' };
}

function reimbursementAmounts(value) {
  if (!plain(value) || !['version', 'sourceHash', 'pages'].every(key => Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !['version', 'engineVersion', 'sourceHash', 'pages'].includes(key)) ||
      value.version !== 1 || typeof value.sourceHash !== 'string' || !SHA256.test(value.sourceHash) ||
      Object.hasOwn(value, 'engineVersion') && (!Number.isSafeInteger(value.engineVersion) || value.engineVersion < 1) ||
      !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 100) throw new Error('报销金额摘要无效');
  const pageNumbers = new Set();
  const validCents = cents => cents === null || Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_AMOUNT_CENTS;
  const pages = Array.from(value.pages, page => {
    if (!plain(page) || !['pageNumber', 'amountCents', 'detectedCents', 'status', 'confidence', 'reason'].every(key => Object.hasOwn(page, key)) ||
        Object.keys(page).some(key => !['pageNumber', 'amountCents', 'detectedCents', 'status', 'confidence', 'reason', 'invoiceKey'].includes(key)) ||
        !Number.isInteger(page.pageNumber) || page.pageNumber < 1 || page.pageNumber > 100 || pageNumbers.has(page.pageNumber) ||
        !validCents(page.amountCents) || !validCents(page.detectedCents) ||
        !['recognized', 'manual', 'pending', 'excluded'].includes(page.status) || !['high', 'low', 'none'].includes(page.confidence) ||
        typeof page.reason !== 'string' || page.reason.length > 100 ||
        Object.hasOwn(page, 'invoiceKey') && (typeof page.invoiceKey !== 'string' || !SHA256.test(page.invoiceKey))) throw new Error('报销金额分页摘要无效');
    pageNumbers.add(page.pageNumber);
    return { pageNumber: page.pageNumber, amountCents: page.amountCents, detectedCents: page.detectedCents,
      status: page.status, confidence: page.confidence, reason: page.reason,
      ...(Object.hasOwn(page, 'invoiceKey') ? { invoiceKey: page.invoiceKey } : {}) };
  });
  pages.sort((left, right) => left.pageNumber - right.pageNumber);
  return { version: 1, ...(Object.hasOwn(value, 'engineVersion') ? { engineVersion: value.engineVersion } : {}), sourceHash: value.sourceHash, pages };
}

function validate(folders, assets) {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const assetsById = new Map(assets.map(asset => [asset.id, asset]));
  for (const folder of folders) {
    const hasCategory = Object.hasOwn(folder, 'reimbursementRootId') || Object.hasOwn(folder, 'reimbursementCategory');
    if (isRoot(folder)) {
      const value = folder.reimbursement;
      if (hasCategory || !validId(folder.id) || !plain(value) || value.version !== 1 ||
          Object.keys(value).some(key => !['version', 'categoryIds', 'formAssetId', 'supplementPdfAssetId', 'invoicePdfAssetId', 'invoicePdfOptions', 'invoicePdfSignature',
            'supplementInvoicePdfAssetId', 'supplementInvoicePdfOptions', 'supplementInvoicePdfSignature', 'itineraryFolderId', 'itineraryPdfAssetId', 'itineraryPdfSignature'].includes(key)) ||
          !plain(value.categoryIds) || Object.keys(value.categoryIds).length > MAX_CATEGORIES) throw new Error('报销文件夹配置无效');
      for (const scope of ['regular', 'supplement']) {
        const fields = invoicePdfFields(scope);
        if (Object.hasOwn(value, fields.options)) {
          if (value[fields.options] === undefined) throw new Error('发票 PDF 排版参数无效');
          invoicePdfOptions(value[fields.options]);
        }
        if (Object.hasOwn(value, fields.signature)) invoicePdfSignature(value[fields.signature]);
      }
      if (Object.hasOwn(value, 'itineraryPdfSignature')) invoicePdfSignature(value.itineraryPdfSignature);
      const ids = new Set();
      for (const [key, id] of Object.entries(value.categoryIds)) {
        const child = byId.get(id);
        if (!CATEGORY_KEY.test(key) || !validId(id) || ids.has(id) || !child || child.parentId !== folder.id ||
            child.reimbursementRootId !== folder.id || child.reimbursementCategory !== key || isRoot(child)) throw new Error('报销分类文件夹配置无效');
        categoryName(child.name);
        ids.add(id);
      }
      const itineraryId = value.itineraryFolderId === undefined ? null : value.itineraryFolderId;
      if (itineraryId !== null) {
        const itinerary = byId.get(itineraryId);
        if (!validId(itineraryId) || ids.has(itineraryId) || !itinerary || itinerary.parentId !== folder.id ||
            isRoot(itinerary) || isCategory(itinerary)) throw new Error('打车行程单文件夹引用无效');
      }
      for (const [kind, { pointer, extension }] of Object.entries(DOCUMENT_KINDS)) {
        // Existing v1 roots predate merged invoice PDFs. Reading them must not
        // mutate the index just to materialize a missing optional pointer.
        const id = ['invoicePdf', 'supplementInvoicePdf', 'itineraryPdf'].includes(kind) && value[pointer] === undefined ? null : value[pointer];
        if (id !== null && !validId(id)) throw new Error('报销文档引用无效');
        const asset = assetsById.get(id);
        // Deleted documents can be regenerated. A pointer may never take over
        // an unrelated document, even if its format happens to match.
        if (asset && (asset.ext !== extension || asset.reimbursementGenerated?.rootId !== folder.id || asset.reimbursementGenerated?.kind !== kind)) throw new Error('报销文档引用了其他素材');
      }
    } else if (Object.hasOwn(folder, 'reimbursement')) throw new Error('普通文件夹不能包含报销配置');
    if (hasCategory) {
      const root = byId.get(folder.reimbursementRootId);
      if (!validId(folder.reimbursementRootId) || typeof folder.reimbursementCategory !== 'string' || !CATEGORY_KEY.test(folder.reimbursementCategory) ||
          !isRoot(root) || !Object.hasOwn(root.reimbursement?.categoryIds || {}, folder.reimbursementCategory) || root.reimbursement.categoryIds[folder.reimbursementCategory] !== folder.id || folder.parentId !== root.id) throw new Error('报销分类归属无效');
    }
  }
  const generated = new Set();
  for (const asset of assets) {
    if (Object.hasOwn(asset, 'reimbursementSupplementInvoice') &&
        (typeof asset.reimbursementSupplementInvoice !== 'boolean' || !IMAGE.has(asset.ext) && asset.ext !== 'pdf')) throw new Error('补票发票标记无效');
    if (Object.hasOwn(asset, 'reimbursementAmounts')) {
      if (!IMAGE.has(asset.ext) && asset.ext !== 'pdf') throw new Error('报销金额素材类型无效');
      reimbursementAmounts(asset.reimbursementAmounts);
    }
    if (Object.hasOwn(asset, 'reimbursementEvidenceAmounts')) {
      if (!IMAGE.has(asset.ext)) throw new Error('购买截图金额素材类型无效');
      reimbursementAmounts(asset.reimbursementEvidenceAmounts);
    }
    if (!Object.hasOwn(asset, 'reimbursementGenerated')) continue;
    const value = asset.reimbursementGenerated;
    if (!plain(value) || Object.keys(value).length !== 2 || !validId(value.rootId) || !Object.hasOwn(DOCUMENT_KINDS, value.kind) || asset.ext !== DOCUMENT_KINDS[value.kind].extension) throw new Error('报销生成文档信息无效');
    const root = byId.get(value.rootId);
    // Removing a whole reimbursement folder keeps its original documents.
    if (root && !isRoot(root)) throw new Error('报销生成文档归属无效');
    const key = `${value.rootId}:${value.kind}`;
    if (generated.has(key)) throw new Error('同一报销文件夹存在重复生成文档');
    generated.add(key);
  }
  return true;
}

module.exports = { CATEGORIES, MAX_CATEGORIES, CATEGORY_KEY, DOCUMENT_KINDS, INVOICE_IMAGES_PER_PAGE, DEFAULT_INVOICE_PDF_OPTIONS, MAX_AMOUNT_CENTS,
  invoicePdfOptions, invoicePdfSignature, invoicePdfFields, reimbursementAmounts, isSupplementInvoice,
  categoryName, normalizeCategories, listCategories, isRoot, isCategory, findRoot, categoryForFolder, itineraryRootForFolder, categoryMap, documentKind, validate };
