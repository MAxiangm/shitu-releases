'use strict';
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { IMAGE, SUPPORTED } = require('./media-formats.cjs');
const FolderTree = require('./folder-tree.js');
const { writeImagePdf } = require('./image-pdf.cjs');
const { createReimbursementWorkbook } = require('./reimbursement-workbook.cjs');
const { CATEGORIES, listCategories, invoicePdfOptions, invoicePdfFields, isSupplementInvoice } = require('./reimbursement-folders.cjs');
const { createReimbursementInvoicePdf } = require('./reimbursement-invoice-pdf.cjs');
const { recognizeReimbursementInvoice } = require('./reimbursement-amounts.cjs');
const { createOcrEngine } = require('./image-ocr.cjs');
const { parseAmount, formatAmount } = require('./invoice-amounts.js');
const DEFAULT_COMPANY_NAME = '北京正月时空动漫科技有限公司';

function profileValue(value, fallbackCompanyName = DEFAULT_COMPANY_NAME) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('报销资料无效');
  const result = {};
  for (const field of ['companyName', 'applicant', 'accountName', 'bankName', 'accountNumber']) {
    const input = value[field] ?? (field === 'companyName' ? fallbackCompanyName : '');
    const maximum = { companyName: 180, applicant: 80, accountName: 120, bankName: 180, accountNumber: 80 }[field];
    if (typeof input !== 'string' || input.length > maximum || /[\x00-\x1f\x7f]/.test(input) || [...input].some(character => {
      const code = character.codePointAt(0); return code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff;
    })) throw new Error('报销资料包含无效文字或内容过长');
    result[field] = input.trim();
  }
  return result;
}
function currentDate(value = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
function reimbursementFormName(profile, date) {
  const company = String(profile.companyName || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  const [year, month] = date.split('-');
  return `财务报销申请表${company ? `（${company}）` : ''}${year}年${Number(month)}月`;
}
function generationError(error, artifact) {
  if (error?.code !== 'EBUSY') return error;
  const wrapped = new Error(`${artifact}正在被其他软件占用，暂时无法更新。请先在 WPS、Excel 或 PDF 阅读器中保存并关闭该文件，再点击“刷新生成文件”。`, { cause: error });
  wrapped.code = error.code;
  return wrapped;
}
function createReimbursementService({ rootDir, profilePath, getLibrary, chooseFiles, chooseSavePath, openFile, onChanged = () => {}, onEvent = () => {}, dateNow = () => new Date(), workbookBuilder = createReimbursementWorkbook, pdfWriter = writeImagePdf, pdfReader, ocrEngine = createOcrEngine(), invoicePdfBuilder = createReimbursementInvoicePdf, templatePath } = {}) {
  if (!path.isAbsolute(rootDir || '') || !path.isAbsolute(profilePath || '')) throw new Error('报销服务路径无效');
  let profile, profileQueue = Promise.resolve(), queue = Promise.resolve(), closed = false, watcher, watchedOwner, timer;
  const states = new Map(), signatures = new Map(), running = new Map(), operations = new Set(), invoiceControllers = new Map(), recognitionErrors = new Map();
  const check = signal => { if (signal?.aborted || closed) throw Object.assign(new Error('当前处理已取消'), { name: 'AbortError' }); };
  const scopeKind = scope => scope === 'supplement' ? 'supplementInvoicePdf' : 'invoicePdf';
  const pending = new Set();
  const ready = (async () => {
    await fs.mkdir(rootDir, { recursive: true });
    try { profile = profileValue(JSON.parse(await fs.readFile(profilePath, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; profile = profileValue({}); }
  })();
  ready.catch(() => {});
  const emit = (owner, folderId, state, message = '') => { states.set(folderId, { state, message }); try { onEvent({ libraryRoot: owner.root, folderId, state, message }); } catch {} };
  function ownerFor(request) {
    const owner = getLibrary();
    if (!owner || request?.libraryRoot !== owner.root) throw new Error('素材库已切换，请重新打开报销文件夹');
    const folder = owner.snapshot().folders.find(item => item.id === request.folderId && item.kind === 'reimbursement');
    if (!folder) throw new Error('报销文件夹不存在');
    return { owner, folder };
  }
  function category(owner, root, key) {
    const entry = listCategories(owner.snapshot().folders, root).find(item => item.key === key);
    if (!entry) throw new Error('报销分类不存在，请刷新后重试');
    const id = entry.folderId;
    const ids = FolderTree.descendantIds(owner.snapshot().folders, id);
    return { id, ids };
  }
  function inputSignature(owner, root) {
    const snapshot = owner.snapshot(), folderIds = FolderTree.descendantIds(snapshot.folders, root.id);
    const inputs = snapshot.assets.filter(asset => folderIds.has(asset.folderId) && !asset.reimbursementGenerated)
      .map(asset => [asset.id, asset.hash, asset.folderId, Boolean(asset.trashedAt), asset.reimbursementSupplementInvoice, asset.reimbursementAmounts]);
    return JSON.stringify([currentDate(dateNow()), profile, listCategories(snapshot.folders, root), inputs]);
  }
  function invoiceSelection(owner, folder, scope = 'regular') {
    const fields = invoicePdfFields(scope);
    const snapshot = owner.snapshot(), records = [];
    for (const entry of listCategories(snapshot.folders, folder).filter(item => scope === 'supplement' ? item.key === 'supplement' : item.key !== 'supplement')) {
      const ids = FolderTree.descendantIds(snapshot.folders, entry.folderId);
      records.push(...snapshot.assets.filter(asset => ids.has(asset.folderId) && !asset.trashedAt && !asset.reimbursementGenerated && (scope !== 'supplement' || isSupplementInvoice(asset))));
    }
    const sources = records.filter(asset => IMAGE.has(asset.ext) || asset.ext === 'pdf');
    return { sources, unsupportedCount: records.length - sources.length, ...invoicePdfOptions(folder.reimbursement[fields.options]) };
  }
  function allInvoiceSources(owner, folder) { return [...invoiceSelection(owner, folder).sources, ...invoiceSelection(owner, folder, 'supplement').sources]; }
  function sourceSignature(sources) { return JSON.stringify(sources.map(asset => [asset.id, asset.hash, asset.folderId, asset.reimbursementSupplementInvoice])); }
  async function invoiceInputs(owner, folder, scope = 'regular') {
    const selection = invoiceSelection(owner, folder, scope), details = [], inputPaths = [];
    for (const asset of selection.sources) {
      const filename = owner.getAssetPath(asset.id, 'original'), info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('部分发票原文件不可读取，请检查后重新合并');
      inputPaths.push(filename); details.push([asset.id, asset.hash, asset.folderId, info.size, info.mtimeMs, info.ctimeMs]);
    }
    return { ...selection, inputPaths, signature: crypto.createHash('sha256').update(JSON.stringify([selection.imagesPerPage, details])).digest('hex') };
  }
  async function invoiceView(owner, folder, scope = 'regular') {
    const fields = invoicePdfFields(scope), kind = scopeKind(scope);
    const selection = invoiceSelection(owner, folder, scope);
    const view = { imagesPerPage: selection.imagesPerPage, sourceCount: selection.sources.length, unsupportedCount: selection.unsupportedCount, stale: false };
    try {
      const inputs = await invoiceInputs(owner, folder, scope);
      view.stale = Boolean(folder.reimbursement[`${kind}AssetId`]) && inputs.signature !== folder.reimbursement[fields.signature];
      if (view.stale) view.message = '发票或排版设置已变化，请重新合并。';
    } catch {
      view.stale = true; view.message = '部分发票原文件不可读取，请检查后重新合并。';
    }
    return view;
  }
  function amountSummary(owner, folder) {
    const snapshot = owner.snapshot(), seen = new Set(), items = [];
    const errors = recognitionErrors.get(`${owner.root}:${folder.id}`) || new Map();
    const categories = listCategories(snapshot.folders, folder).map(entry => {
      const ids = FolderTree.descendantIds(snapshot.folders, entry.folderId);
      const assets = snapshot.assets.filter(asset => ids.has(asset.folderId) && !asset.trashedAt && !asset.reimbursementGenerated);
      const sources = assets.filter(asset => (IMAGE.has(asset.ext) || asset.ext === 'pdf') && (entry.key !== 'supplement' || isSupplementInvoice(asset)));
      const pageItems = [];
      for (const asset of sources) {
        const pages = errors.has(asset.id) ? null : asset.reimbursementAmounts?.pages;
        for (const page of pages || [{ pageNumber: 1, amountCents: null, detectedCents: null, status: 'pending', confidence: 'none', reason: errors.get(asset.id) || '等待识别金额' }]) {
          const item = { assetId: asset.id, pageNumber: page.pageNumber, name: asset.name, categoryKey: entry.key, amountCents: page.amountCents,
            amount: page.amountCents === null ? '' : formatAmount(page.amountCents), detectedAmount: page.detectedCents === null ? '' : formatAmount(page.detectedCents),
            status: page.status, confidence: page.confidence, reason: page.reason };
          if (page.status !== 'excluded' && page.invoiceKey) {
            if (seen.has(page.invoiceKey) && page.status !== 'manual') Object.assign(item, { amountCents: null, amount: '', status: 'pending', reason: '疑似重复发票，请核对后填写金额或排除' });
            seen.add(page.invoiceKey);
          }
          pageItems.push(item); items.push(item);
        }
      }
      const sum = pageItems.reduce((total, item) => total + BigInt(item.status === 'excluded' ? 0 : item.amountCents || 0), 0n);
      const amountCents = Number(sum), pendingCount = pageItems.filter(item => item.status === 'pending').length;
      if (!Number.isSafeInteger(amountCents)) throw new Error('分类金额超出可计算范围');
      const describe = asset => ({ id: asset.id, name: asset.name, ext: asset.ext, mediaType: asset.mediaType });
      return { ...entry, count: assets.length, items: assets.map(describe), invoiceCount: pageItems.filter(item => item.status !== 'excluded').length, pendingCount, amountCents, amount: formatAmount(amountCents),
        ...(entry.key === 'supplement' ? { invoiceItems: sources.map(describe), evidenceItems: assets.filter(asset => !isSupplementInvoice(asset)).map(describe) } : {}) };
    });
    const totalCents = categories.reduce((total, item) => total + item.amountCents, 0);
    if (!Number.isSafeInteger(totalCents)) throw new Error('总金额超出可计算范围');
    return { categories, amounts: { items, totalCents, totalAmount: formatAmount(totalCents), pendingCount: items.filter(item => item.status === 'pending').length } };
  }
  async function getProfile() { await ready; return { ...profile }; }
  async function saveProfile(value) {
    await ready; const next = profileValue(value, profile.companyName);
    profileQueue = profileQueue.catch(() => {}).then(async () => {
      const temp = `${profilePath}.${crypto.randomUUID()}.tmp`;
      try { await fs.mkdir(path.dirname(profilePath), { recursive: true }); await fs.writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx' }); await fs.rename(temp, profilePath); profile = next; }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    });
    await profileQueue; signatures.clear(); synchronizeLibrary(); scheduleAll(); return { ...profile };
  }
  async function get(request) {
    await ready; const { owner, folder } = ownerFor(request); synchronizeLibrary();
    const snapshot = owner.snapshot();
    const { categories, amounts } = amountSummary(owner, folder);
    const artifact = (pointer, fallback) => {
      const asset = snapshot.assets.find(item => item.id === pointer && !item.trashedAt);
      return { ready: Boolean(asset), assetId: asset?.id || null, name: asset?.name || fallback };
    };
    const [invoiceMerge, supplementInvoiceMerge] = await Promise.all([invoiceView(owner, folder), invoiceView(owner, folder, 'supplement')]);
    return { folderId: folder.id, name: folder.name, date: currentDate(dateNow()), profile: { ...profile }, categories, amounts, invoiceMerge, supplementInvoiceMerge,
      artifacts: { form: artifact(folder.reimbursement.formAssetId, '财务报销申请表'), supplementPdf: artifact(folder.reimbursement.supplementPdfAssetId, '补票说明拼合'), invoicePdf: artifact(folder.reimbursement.invoicePdfAssetId, '合并发票 PDF'), supplementInvoicePdf: artifact(folder.reimbursement.supplementInvoicePdfAssetId, '补票发票 PDF') },
      ...(states.get(folder.id) || { state: 'idle', message: '' }) };
  }
  async function build(owner, folderId, forceRecognition = false) {
    await ready;
    if (closed || getLibrary() !== owner) return;
    const folder = owner.snapshot().folders.find(item => item.id === folderId && item.kind === 'reimbursement');
    if (!folder) return;
    const key = `${owner.root}:${folderId}`, directory = path.join(rootDir, crypto.randomUUID());
    const controller = new AbortController(); invoiceControllers.set(controller, key);
    let generationProfile, generationDate;
    let artifact = '报销申请表', generatedSignature;
    emit(owner, folderId, 'generating', '正在同步报销表与补票 PDF…');
    try {
      await fs.mkdir(directory); check(controller.signal);
      const errors = new Map(); recognitionErrors.set(key, errors);
      const sources = allInvoiceSources(owner, folder), scannedSources = sourceSignature(sources);
      for (let index = 0; index < sources.length; index++) {
        check(controller.signal);
        const asset = sources[index];
        emit(owner, folderId, 'generating', `正在识别发票金额 ${index + 1} / ${sources.length}…`);
        try {
          const result = await recognizeReimbursementInvoice({ asset, inputPath: owner.getAssetPath(asset.id, 'original'), workRoot: directory,
            ocrEngine, pdfReader, signal: controller.signal, force: forceRecognition });
          if (getLibrary() !== owner) controller.abort();
          check(controller.signal);
          const latestAsset = owner.snapshot().assets.find(item => item.id === asset.id);
          if (!latestAsset || latestAsset.trashedAt) continue;
          // A confirmed edit must survive a recognition task started earlier.
          if (latestAsset.reimbursementAmounts?.sourceHash === result.sourceHash) result.pages = result.pages.map(page => {
            const manual = latestAsset.reimbursementAmounts.pages.find(item => item.pageNumber === page.pageNumber && ['manual', 'excluded'].includes(item.status));
            return manual || page;
          });
          await owner.setReimbursementAmounts(asset.id, result);
        } catch (error) { check(controller.signal); errors.set(asset.id, '无法读取或保存识别结果，请检查原文件并重新识别'); }
      }
      check(controller.signal);
      const existing = owner.snapshot().assets.find(asset => asset.id === folder.reimbursement.formAssetId && !asset.trashedAt);
      const existingPath = existing ? owner.getAssetPath(existing.id, 'original') : null;
      const existingHash = existingPath ? crypto.createHash('sha256').update(await fs.readFile(existingPath)).digest('hex') : undefined;
      const categories = amountSummary(owner, folder).categories.map(item => ({ key: item.key, name: item.name, count: item.invoiceCount, amountCents: item.amountCents, pendingCount: item.pendingCount })).filter(item => item.count > 0);
      generationProfile = { ...profile }; generationDate = currentDate(dateNow());
      generatedSignature = inputSignature(owner, folder);
      const form = await workbookBuilder({ templatePath: existingPath || templatePath, profile: generationProfile, date: generationDate, categories });
      if (existingHash && crypto.createHash('sha256').update(await fs.readFile(existingPath)).digest('hex') !== existingHash) throw new Error('报销表正在被其他软件修改，请保存后重试');
      const workbook = path.join(directory, '财务报销申请表.xlsx'); await fs.writeFile(workbook, form, { flag: 'wx' });
      check(controller.signal); if (getLibrary() !== owner) return;
      await owner.upsertReimbursementDocument(folderId, 'form', workbook, reimbursementFormName(generationProfile, generationDate), { expectedExistingHash: existingHash });
      const latest = owner.snapshot().folders.find(item => item.id === folderId);
      const supplementId = latest?.reimbursement.categoryIds.supplement;
      const ids = supplementId ? FolderTree.descendantIds(owner.snapshot().folders, supplementId) : new Set();
      const screenshots = owner.snapshot().assets.filter(asset => ids.has(asset.folderId) && !asset.trashedAt && !asset.reimbursementGenerated && IMAGE.has(asset.ext) && !isSupplementInvoice(asset));
      artifact = '补票 PDF';
      if (screenshots.length) {
        const pdf = path.join(directory, '补票说明拼合.pdf');
        await pdfWriter({ inputPaths: screenshots.map(asset => owner.getAssetPath(asset.id, 'original')), outputPath: pdf, options: { pageSize: 'a4', orientation: 'portrait', margin: 18, imagesPerPage: 2, gap: 12 }, signal: controller.signal });
        check(controller.signal); if (getLibrary() !== owner) return;
        await owner.upsertReimbursementDocument(folderId, 'supplementPdf', pdf, `${screenshots.length}张_补票说明拼合`);
      } else if (latest.reimbursement.supplementPdfAssetId) await owner.clearReimbursementDocument(folderId, 'supplementPdf');
      signatures.set(key, generatedSignature);
      const totals = amountSummary(owner, folder).amounts;
      emit(owner, folderId, 'idle', totals.pendingCount ? `报销表已同步，${totals.pendingCount} 张发票金额待核对` : `报销表已同步，发票合计 ¥${totals.totalAmount}${screenshots.length ? `，已生成 ${screenshots.length} 张购买截图的打印 PDF` : ''}`);
      onChanged(owner);
      if (scannedSources !== sourceSignature(allInvoiceSources(owner, folder))) signatures.delete(key);
      if (inputSignature(owner, folder) !== signatures.get(key)) scheduleAll();
    } catch (error) {
      signatures.set(key, inputSignature(owner, folder));
      if (error.name === 'AbortError') { emit(owner, folderId, 'idle', '已取消当前处理，未完成的金额可重新识别'); return; }
      const reported = generationError(error, artifact); emit(owner, folderId, 'error', reported.message); throw reported;
    } finally { invoiceControllers.delete(controller); await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
  }
  function enqueue(owner, folderId, force = false, forceRecognition = false) {
    if (closed || getLibrary() !== owner) return Promise.resolve();
    const key = `${owner.root}:${folderId}`;
    if (running.has(key)) return running.get(key).catch(() => {}).then(() => enqueue(owner, folderId, force, forceRecognition));
    const folder = owner.snapshot().folders.find(item => item.id === folderId);
    if (!folder || (!force && signatures.get(key) === inputSignature(owner, folder))) return Promise.resolve();
    const task = queue.catch(() => {}).then(() => build(owner, folderId, forceRecognition));
    running.set(key, task); queue = task.catch(() => {});
    task.finally(() => running.delete(key)).catch(() => {});
    return task;
  }
  function scheduleAll() {
    if (closed) return; clearTimeout(timer);
    timer = setTimeout(() => {
      pending.clear(); const owner = getLibrary(); if (!owner) return;
      for (const folder of owner.snapshot().folders.filter(item => item.kind === 'reimbursement')) void enqueue(owner, folder.id).catch(() => {});
    }, 400); timer.unref?.();
  }
  function synchronizeLibrary() {
    const owner = getLibrary();
    if (watchedOwner === owner) return;
    if (watchedOwner) for (const [controller, target] of invoiceControllers) if (target.startsWith(`${watchedOwner.root}:`)) controller.abort();
    watcher?.close(); watcher = null; watchedOwner = owner; signatures.clear();
    if (owner && !closed) { watcher = watch(owner.root, (_event, filename) => { if (String(filename) === 'index.json') scheduleAll(); }); scheduleAll(); }
  }
  let lastDay = currentDate(dateNow());
  const dayTimer = setInterval(() => { const today = currentDate(dateNow()); if (today !== lastDay) { lastDay = today; signatures.clear(); scheduleAll(); } }, 60000); dayTimer.unref?.();
  async function refresh(request) { await ready; const { owner, folder } = ownerFor(request); await enqueue(owner, folder.id, true, true); return get(request); }
  async function create(request) {
    await ready; const owner = getLibrary(); if (!owner || owner.root !== request.libraryRoot) throw new Error('请选择有效素材库');
    const result = await owner.createReimbursementFolder(request.name, request.parentId || null);
    synchronizeLibrary(); await enqueue(owner, result.folderId, true);
    return { snapshot: owner.snapshot(), folderId: result.folderId, workspace: await get({ folderId: result.folderId, libraryRoot: owner.root }) };
  }
  async function saveCategories(request) {
    await ready; const { owner, folder } = ownerFor(request);
    await owner.updateReimbursementCategories(folder.id, request.categories);
    onChanged(owner);
    await enqueue(owner, folder.id, true);
    return { snapshot: owner.snapshot(), workspace: await get({ folderId: folder.id, libraryRoot: owner.root }) };
  }
  async function mergeInvoices(request) {
    await ready; const { owner, folder } = ownerFor(request);
    const scope = request.scope || 'regular', fields = invoicePdfFields(scope), kind = scopeKind(scope);
    const options = invoicePdfOptions(request.imagesPerPage === undefined ? folder.reimbursement[fields.options] : { imagesPerPage: request.imagesPerPage });
    const task = queue.catch(() => {}).then(async () => {
      const controller = new AbortController(), directory = path.join(rootDir, crypto.randomUUID());
      invoiceControllers.set(controller, `${owner.root}:${folder.id}`);
      try {
        if (closed || getLibrary() !== owner) throw new Error('素材库已切换，请重新合并');
        await owner.setReimbursementInvoiceOptions(folder.id, options, scope);
        const current = owner.snapshot().folders.find(item => item.id === folder.id);
        if (!current) throw new Error('报销文件夹不存在');
        const inputs = await invoiceInputs(owner, current, scope);
        if (!inputs.inputPaths.length) throw new Error(scope === 'supplement' ? '请先添加补票发票' : '请先在补票以外的分类中添加图片或 PDF 发票');
        emit(owner, folder.id, 'generating', '正在合并发票 PDF…');
        await fs.mkdir(directory);
        const outputPath = path.join(directory, '合并发票.pdf');
        const result = await invoicePdfBuilder({ inputPaths: inputs.inputPaths, outputPath, imagesPerPage: options.imagesPerPage, pdfReader, pdfWriter, signal: controller.signal,
          onProgress: update => emit(owner, folder.id, 'generating', update?.message || '正在合并发票 PDF…') });
        if (closed || getLibrary() !== owner || controller.signal.aborted) throw new Error('发票合并已取消');
        const latest = owner.snapshot().folders.find(item => item.id === folder.id);
        if (!latest || (await invoiceInputs(owner, latest, scope)).signature !== inputs.signature) throw new Error('合并期间发票发生变化，请重新合并');
        await owner.upsertReimbursementDocument(folder.id, kind, outputPath, `${result.invoiceCount}张_${scope === 'supplement' ? '补票发票' : '合并发票'}`);
        await owner.setReimbursementInvoiceSignature(folder.id, inputs.signature, scope);
        emit(owner, folder.id, 'idle', `已将 ${result.invoiceCount} 张发票合并为 ${result.pages} 页 A4 PDF`);
        onChanged(owner);
        return { snapshot: owner.snapshot(), workspace: await get({ folderId: folder.id, libraryRoot: owner.root }) };
      } catch (error) {
        if (controller.signal.aborted) { emit(owner, folder.id, 'idle', '已取消发票合并'); return { cancelled: true, workspace: await get({ folderId: folder.id, libraryRoot: owner.root }) }; }
        const reported = generationError(error, '合并发票 PDF'); emit(owner, folder.id, 'error', reported.message); throw reported;
      }
      finally { invoiceControllers.delete(controller); await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
    });
    queue = task.catch(() => {});
    return task;
  }
  async function importFiles(request) {
    const { owner, folder } = ownerFor(request); const { id } = category(owner, folder, request.category);
    if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > 256) throw new Error('请选择 1 至 256 个文件');
    if (request.purpose !== undefined && !['invoice', 'evidence'].includes(request.purpose)) throw new Error('补票文件用途无效');
    const allowed = request.category === 'supplement' ? request.purpose === 'evidence' ? IMAGE : new Set([...IMAGE, 'pdf']) : SUPPORTED;
    if (request.paths.some(file => typeof file !== 'string' || !path.isAbsolute(file) || !allowed.has(path.extname(file).slice(1).toLowerCase()))) throw new Error(request.category === 'supplement' ? '补票发票支持图片和 PDF；购买截图仅支持图片' : '包含不支持的文件格式');
    const before = new Set(owner.snapshot().assets.map(asset => asset.id));
    const report = await owner.importPaths(request.paths, { folderId: id, restoreTrashed: true });
    if (request.category === 'supplement' && request.purpose) {
      const restored = new Set(report.restoredAssetIds || []);
      const imported = owner.snapshot().assets.filter(asset => (!before.has(asset.id) || restored.has(asset.id)) && asset.folderId === id && !asset.trashedAt).map(asset => asset.id);
      if (imported.length) await owner.setReimbursementSupplementInvoice(imported, request.purpose === 'invoice');
    }
    await enqueue(owner, folder.id, true); onChanged(owner);
    return { snapshot: owner.snapshot(), report, workspace: await get({ folderId: folder.id, libraryRoot: owner.root }) };
  }
  async function chooseImport(request) {
    const { owner, folder } = ownerFor(request); category(owner, folder, request.category);
    const evidence = request.category === 'supplement' && request.purpose === 'evidence';
    const selected = await chooseFiles({ title: evidence ? '选择购买说明截图' : '选择报销发票或凭证', properties: ['openFile', 'multiSelections'], filters: [{ name: evidence ? '购买说明图片' : '支持的凭证', extensions: [...(evidence ? IMAGE : request.category === 'supplement' ? new Set([...IMAGE, 'pdf']) : SUPPORTED)] }] });
    if (selected.canceled || !selected.filePaths?.length) return { cancelled: true };
    return importFiles({ ...request, paths: selected.filePaths });
  }
  async function removeFile(request) {
    await ready; const { owner, folder } = ownerFor(request);
    if (typeof request.assetId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(request.assetId)) throw new Error('请选择有效的报销文件');
    const task = queue.catch(() => {}).then(async () => {
      const current = ownerFor(request);
      if (current.owner !== owner) throw new Error('素材库已切换，请重新打开报销文件夹');
      const { ids } = category(owner, current.folder, request.category);
      const asset = owner.snapshot().assets.find(item => item.id === request.assetId);
      if (!asset || asset.trashedAt || asset.reimbursementGenerated || !ids.has(asset.folderId)) throw new Error('该文件已移动、删除或不属于当前报销分类，请刷新后重试');
      await owner.setTrash([asset.id], true);
      recognitionErrors.get(`${owner.root}:${folder.id}`)?.delete(asset.id);
      onChanged(owner);
    });
    queue = task.catch(() => {}); await task;
    let syncError;
    try { await enqueue(owner, folder.id, true); }
    catch (error) { syncError = error.message || '生成文件更新失败，请刷新重试'; }
    return { removed: true, snapshot: owner.snapshot(), workspace: await get(request), ...(syncError ? { syncError } : {}) };
  }
  async function setAmount(request) {
    await ready; const { owner, folder } = ownerFor(request);
    const amountCents = request.excluded === true ? 0 : parseAmount(request.amount);
    if (amountCents === null || !Number.isInteger(request.pageNumber) || request.pageNumber < 1 || request.pageNumber > 100) throw new Error('请输入有效金额，最多两位小数');
    const task = queue.catch(() => {}).then(async () => {
      const valid = [...invoiceSelection(owner, folder).sources, ...invoiceSelection(owner, folder, 'supplement').sources].find(asset => asset.id === request.assetId);
      if (!valid || getLibrary() !== owner) throw new Error('该发票已移动或删除，请刷新后重试');
      let record = valid.reimbursementAmounts;
      if (!record) {
        if (request.pageNumber !== 1) throw new Error('请先识别发票页数');
        record = { version: 1, sourceHash: crypto.createHash('sha256').update(await fs.readFile(owner.getAssetPath(valid.id, 'original'))).digest('hex'), pages: [{ pageNumber: 1, amountCents: null, detectedCents: null, status: 'pending', confidence: 'none', reason: '' }] };
      }
      if (!record.pages.some(page => page.pageNumber === request.pageNumber)) throw new Error('该发票页已变化，请刷新后重试');
      await owner.setReimbursementAmounts(valid.id, { ...record, pages: record.pages.map(page => page.pageNumber === request.pageNumber ? { ...page, amountCents, status: request.excluded === true ? 'excluded' : 'manual', reason: page.reason.includes('整份文件') ? request.excluded === true ? '整份文件不计入报销' : '已手动核对整份文件合计' : request.excluded === true ? '不计入报销' : '已手动核对' } : page) });
      recognitionErrors.get(`${owner.root}:${folder.id}`)?.delete(valid.id);
    });
    queue = task.catch(() => {}); await task;
    await enqueue(owner, folder.id, true); onChanged(owner);
    return { snapshot: owner.snapshot(), workspace: await get(request) };
  }
  async function cancel(request) {
    const { owner, folder } = ownerFor(request), key = `${owner.root}:${folder.id}`;
    for (const [controller, target] of invoiceControllers) if (target === key) controller.abort();
    return { cancelled: true };
  }
  async function artifactPath(request) {
    if (!['form', 'supplementPdf', 'invoicePdf', 'supplementInvoicePdf'].includes(request.kind)) throw new Error('报销文件类型无效');
    const { owner, folder } = ownerFor(request);
    const invoice = ['invoicePdf', 'supplementInvoicePdf'].includes(request.kind), scope = request.kind === 'supplementInvoicePdf' ? 'supplement' : 'regular';
    if (invoice) {
      const view = await invoiceView(owner, folder, scope);
      if (!view.sourceCount || view.stale || !folder.reimbursement[`${request.kind}AssetId`]) throw new Error('请先一键合并当前发票，再打开或导出 PDF');
    } else await enqueue(owner, folder.id, true);
    const current = owner.snapshot().folders.find(item => item.id === folder.id);
    const id = current.reimbursement[`${request.kind}AssetId`];
    const asset = owner.snapshot().assets.find(item => item.id === id && !item.trashedAt);
    if (!asset) throw new Error('请先添加补票截图，生成打印 PDF');
    return { owner, asset, filename: owner.getAssetPath(id, 'original'), invoiceSignature: invoice ? current.reimbursement[invoicePdfFields(scope).signature] : undefined };
  }
  async function openArtifact(request) { const { filename } = await artifactPath(request); const error = await openFile(filename); if (error) throw new Error(error); return { opened: true }; }
  async function exportArtifact(request) {
    const { owner, asset, filename, invoiceSignature } = await artifactPath(request);
    const checkInvoice = async () => {
      if (!['invoicePdf', 'supplementInvoicePdf'].includes(request.kind)) return;
      const scope = request.kind === 'supplementInvoicePdf' ? 'supplement' : 'regular', fields = invoicePdfFields(scope);
      const current = ownerFor(request);
      if (current.owner !== owner || current.folder.reimbursement[`${request.kind}AssetId`] !== asset.id ||
          current.folder.reimbursement[fields.signature] !== invoiceSignature ||
          (await invoiceInputs(owner, current.folder, scope)).signature !== invoiceSignature) throw new Error('发票或排版已变化，请重新合并后再导出');
    };
    const selected = await chooseSavePath({ title: '导出报销文件', defaultPath: `${asset.name}.${asset.ext}`, filters: [{ name: asset.ext.toUpperCase(), extensions: [asset.ext] }] });
    if (selected.canceled || !selected.filePath) return { saved: false, cancelled: true };
    await checkInvoice();
    let output = selected.filePath; if (!path.extname(output)) output += `.${asset.ext}`;
    if (!path.isAbsolute(output) || path.extname(output).toLowerCase() !== `.${asset.ext}`) throw new Error('请选择正确的文件扩展名');
    const parent = await fs.realpath(path.dirname(output)); output = path.join(parent, path.basename(output));
    const relative = path.relative(await fs.realpath(owner.root), output);
    if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('请导出到素材库之外');
    const existing = await fs.lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('保存目标不是普通文件');
    const temp = `${output}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.copyFile(filename, temp, require('node:fs').constants.COPYFILE_EXCL);
      if (['invoicePdf', 'supplementInvoicePdf'].includes(request.kind) && crypto.createHash('sha256').update(await fs.readFile(temp)).digest('hex') !== asset.hash) throw new Error('合并 PDF 已变化，请重新合并后再导出');
      await checkInvoice();
      await fs.rename(temp, output);
    }
    finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    return { saved: true, cancelled: false, path: output };
  }
  function tracked(task) {
    if (closed) return Promise.reject(new Error('报销服务已关闭'));
    const promise = Promise.resolve().then(task); operations.add(promise);
    promise.finally(() => operations.delete(promise)).catch(() => {}); return promise;
  }
  async function shutdown() { closed = true; clearTimeout(timer); clearInterval(dayTimer); watcher?.close(); for (const controller of invoiceControllers.keys()) controller.abort(); await Promise.allSettled([...operations]); await queue; await profileQueue; await pdfReader?.shutdown?.(); }
  return { getProfile, saveProfile: value => tracked(() => saveProfile(value)), get,
    saveCategories: request => tracked(() => saveCategories(request)),
    mergeInvoices: request => tracked(() => mergeInvoices(request)),
    setAmount: request => tracked(() => setAmount(request)), cancel,
    removeFile: request => tracked(() => removeFile(request)),
    refresh: request => tracked(() => refresh(request)), create: request => tracked(() => create(request)),
    importFiles: request => tracked(() => importFiles(request)), chooseImport: request => tracked(() => chooseImport(request)),
    openArtifact: request => tracked(() => openArtifact(request)), exportArtifact: request => tracked(() => exportArtifact(request)),
    synchronizeLibrary, busy: () => running.size > 0 || operations.size > 0, shutdown };
}

module.exports = { createReimbursementService, profileValue, currentDate, CATEGORIES, DEFAULT_COMPANY_NAME, reimbursementFormName };
