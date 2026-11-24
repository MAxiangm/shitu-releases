'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');
const { readZip, writeZip } = require('../src/xlsx-zip.cjs');

async function runProduction(options) {
  const { app, dialog, session, BrowserWindow } = require('electron');
  const checks = [], errors = [], dialogs = [];
  let window, openingTest;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const js = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const persist = result => fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ...result, checks, errors, dialogs }, null, 2));
  const checkpoint = async value => { checks.push(value); await persist({ running: true }); };
  const xml = async filename => new Map(readZip(await fs.readFile(filename)).entries.map(entry => [entry.name, entry.data.toString('utf8')]));
  const workbookIncludes = async (filename, value) => {
    try { return (await xml(filename)).get('xl/worksheets/sheet1.xml')?.includes(value) || false; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const cellXml = (sheet, address) => [...sheet.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)].map(match => match[0]).find(cell => new RegExp(`\\br="${address}"`).test(cell)) || '';
  const numericCell = (sheet, address) => Number(/<v>([^<]+)<\/v>/.exec(cellXml(sheet, address))?.[1]);
  async function makeInvoiceFixtures() {
    const printer = new BrowserWindow({ show: false, width: 1400, height: 850, backgroundColor: '#ffffff', webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    const html = amounts => `<!doctype html><meta charset="UTF-8"><style>@page{size:A4;margin:15mm}body{margin:0;background:white;color:#111;font-family:'Microsoft YaHei',sans-serif}section{padding:45px;page-break-after:always}section:last-child{page-break-after:auto}h1{font-size:42px;font-weight:500}p{font-size:42px;line-height:2.2}</style>${amounts.map(amount => `<section><h1>增值税电子普通发票</h1><p>价税合计（小写）￥${amount}</p><p>测试凭证，仅用于本机验证</p></section>`).join('')}`;
    try {
      // A whole-yuan image keeps this end-to-end engine check deterministic;
      // decimal precision is exercised separately by real PDF text and edits.
      await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(['8']))}`);
      await printer.webContents.executeJavaScript('document.fonts.ready.then(() => true)'); await pause(150);
      await fs.writeFile(options.autoImageInvoice, (await printer.webContents.capturePage()).toPNG());
      await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(['113.00']))}`);
      await printer.webContents.executeJavaScript('document.fonts.ready.then(() => true)'); await pause(150);
      await fs.writeFile(options.ambiguousOcrInvoice, (await printer.webContents.capturePage()).toPNG());
      for (const [filename, amounts] of [[options.textInvoice, ['67.89']], [options.supplementInvoice, ['25.50', '4.50']], [options.nativeSyncInvoice, ['17.25']]]) {
        await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(amounts))}`);
        await printer.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
        await fs.writeFile(filename, await printer.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
      }
      const receipt = `<!doctype html><meta charset="UTF-8"><style>body{padding:50px;background:white;color:black;font-family:'Microsoft YaHei',sans-serif}h1,p{font-size:42px;line-height:1.8}</style><h1>订单详情</h1><p>商品金额 ￥164</p><p>优惠 ￥36</p><p>实付款 ￥128</p><p>订单编号 202611240001234567</p>`;
      await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(receipt)}`);
      await printer.webContents.executeJavaScript('document.fonts.ready.then(() => true)'); await pause(150);
      await fs.writeFile(options.purchaseScreenshot, (await printer.webContents.capturePage()).toPNG());
      const trip = number => `<!doctype html><meta charset="UTF-8"><style>@page{size:A4;margin:20mm}body{font-family:'Microsoft YaHei',sans-serif;color:#111}section{page-break-after:always;padding:40px}section:last-child{page-break-after:auto}h1{font-size:38px}p{font-size:28px}</style>${Array.from({ length: number }, (_, index) => `<section><h1>打车行程单 第${index + 1}页</h1><p>本机测试行程资料</p><p>起点：示例地址甲</p><p>终点：示例地址乙</p><p>费用合计 ￥999</p></section>`).join('')}`;
      await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(trip(1))}`);
      await printer.webContents.executeJavaScript('document.fonts.ready.then(() => true)'); await pause(150);
      await fs.writeFile(options.tripImage, (await printer.webContents.capturePage()).toPNG());
      await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(trip(2))}`);
      await printer.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      await fs.writeFile(options.tripPdf, await printer.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
    } finally { printer.destroy(); }
  }
  async function waitFor(test, message, timeout = 40000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await test()) return; await pause(70); }
    throw new Error(message);
  }
  async function capture(name) {
    window.showInactive(); await pause(180);
    await fs.writeFile(path.join(options.directory, name), (await window.webContents.capturePage()).toPNG());
    window.hide();
  }
  async function dropFiles(selector, filenames) {
    await js(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'reimbursement-smoke-native-file'; input.hidden = true; document.body.append(input); });
    const debugging = window.webContents.debugger, attached = debugging.isAttached();
    try {
      if (!attached) debugging.attach('1.3');
      const documentRoot = await debugging.sendCommand('DOM.getDocument');
      const input = await debugging.sendCommand('DOM.querySelector', { nodeId: documentRoot.root.nodeId, selector: '#reimbursement-smoke-native-file' });
      await debugging.sendCommand('DOM.setFileInputFiles', { nodeId: input.nodeId, files: filenames });
      const actualPaths = await js(target => {
        const input = document.querySelector('#reimbursement-smoke-native-file'), dataTransfer = new DataTransfer();
        for (const file of input.files) dataTransfer.items.add(file);
        const paths = [...dataTransfer.files].map(file => window.shitu.getFilePath(file));
        const destination = document.querySelector(target);
        if (!destination) throw new Error('Missing reimbursement drop target');
        destination.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
        input.remove(); return paths;
      }, selector);
      assert(JSON.stringify(actualPaths.map(file => path.resolve(file))) === JSON.stringify(filenames.map(file => path.resolve(file))), 'Drop fixture did not retain native file paths');
    } finally {
      if (!attached && debugging.isAttached()) debugging.detach();
      await js(() => document.querySelector('#reimbursement-smoke-native-file')?.remove());
    }
  }
  app.setPath('userData', path.join(options.directory, 'profile'));
  app.setPath('sessionData', path.join(options.directory, 'session'));
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  dialog.showErrorBox = (title, content) => errors.push(`${title}: ${content}`);
  dialog.showOpenDialog = async (...args) => {
    if (openingTest) return openingTest(args.at(-1));
    throw new Error(`Unexpected file picker: ${args.at(-1)?.title}`);
  };
  dialog.showMessageBox = async (...args) => { throw new Error(`Unexpected message: ${args.at(-1)?.message}`); };
  dialog.showSaveDialog = async (...args) => {
    const settings = args.at(-1), extension = settings.filters?.[0]?.extensions?.[0];
    assert(['xlsx', 'pdf'].includes(extension), 'Unexpected reimbursement export extension');
    dialogs.push({ title: settings.title, defaultPath: settings.defaultPath, extension });
    const outputName = String(settings.defaultPath).includes('补票发票') ? 'export-supplement-invoices.pdf' : String(settings.defaultPath).includes('报销发票汇总') ? 'export-invoices.pdf' : `export.${extension}`;
    return { canceled: false, filePath: path.join(options.directory, outputName) };
  };
  app.on('browser-window-created', (_event, candidate) => {
    candidate.setSkipTaskbar(true);
    candidate.webContents.on('did-finish-load', () => { if (candidate.webContents.getURL().endsWith('/src/index.html')) window = candidate; });
    candidate.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) errors.push(event.message); });
    candidate.webContents.on('preload-error', (_event, file, error) => errors.push(`${file}: ${error.message}`));
    candidate.webContents.on('render-process-gone', (_event, detail) => errors.push(`Renderer exited: ${JSON.stringify(detail)}`));
  });
  process.on('uncaughtException', error => errors.push(error.stack || String(error)));
  process.on('unhandledRejection', error => errors.push(error?.stack || String(error)));
  try {
    require(path.join(options.root, 'src/main.cjs'));
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_detail, done) => done({ cancel: true }));
    await waitFor(() => window && !window.isDestroyed() && js(() => window.shitu?.reimbursementCreate && typeof state === 'object' && Boolean(state.library.root)).catch(() => false), 'Real main/preload/library did not boot');
    assert(app.getPath('userData') === path.join(options.directory, 'profile'), 'Profile isolation lost');
    await makeInvoiceFixtures();
    await checkpoint('actual main/index/preload booted with isolated profile, sessionData and library');

    await js(() => document.querySelector('#reimbursementSettingsButton').click());
    await waitFor(() => js(() => document.querySelector('#rb-profile-applicant')?.disabled === false), 'Reimbursement settings did not become ready');
    await js(profile => {
      for (const [key, value] of Object.entries(profile)) document.querySelector(`#rb-profile-${key}`).value = value;
      document.querySelector('#rb-profile-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }, options.profile);
    await waitFor(() => js(async account => (await window.shitu.reimbursementGetProfile()).accountNumber === account && document.querySelector('#rb-profile-applicant')?.disabled === false, options.profile.accountNumber), 'Real settings-save IPC did not persist text account');
    await capture('reimbursement-settings.png');
    await checkpoint('five reimbursement profile fields including company name saved through production UI/IPC with leading-zero account intact');
    await js(() => document.querySelector('#rb-close').click());

    await js(() => document.querySelector('#newFolder').click());
    await waitFor(() => js(() => !document.querySelector('#modalOverlay').classList.contains('hidden')), 'Folder creation modal unavailable');
    assert(await js(() => document.querySelector('#modalFolderType').value === 'normal' && !!document.querySelector('#modalFolderType option[value="reimbursement"]')), 'Folder modal did not default to normal or offer reimbursement');
    await js(() => {
      document.querySelector('#modalFolderType').value = 'reimbursement';
      document.querySelector('#modalInput').value = '集成测试报销夹';
      document.querySelector('#modalConfirm').click();
    });
    await waitFor(() => js(() => window.shituReimbursements?.isOpen() && document.querySelectorAll('.rb-category').length === 5 && document.querySelector('[data-artifact="form"] .rb-output-actions button')?.disabled === false), 'Reimbursement folder/form/workspace did not become ready');
    let snapshot = await js(() => window.shitu.getLibrary());
    const folder = snapshot.folders.find(item => item.kind === 'reimbursement'), folderId = folder?.id;
    assert(folder && snapshot.folders.filter(item => item.parentId === folderId).length === 5, 'Reimbursement root did not own exactly five categories');
    const request = { folderId, libraryRoot: options.library };
    let formAsset = snapshot.assets.find(item => item.id === folder.reimbursement.formAssetId);
    assert(formAsset?.ext === 'xlsx' && formAsset.mediaType === 'document', 'Generated XLSX was not a document asset');
    const formId = formAsset.id, formPath = path.join(options.library, formAsset.filename);
    const firstXml = (await xml(formPath)).get('xl/worksheets/sheet1.xml');
    assert(firstXml.includes(options.profile.applicant) && firstXml.includes(options.profile.accountNumber) && firstXml.includes(options.profile.companyName), 'Generated workbook profile or company name is missing');
    assert(firstXml.includes(`日期：${options.dateChinese}`) && firstXml.includes(options.date), 'Generated workbook date was not current Shanghai date');
    assert(/<c r="C26"[^>]*t="inlineStr"/.test(firstXml), 'Account number was not kept as literal text');
    assert(/<c r="G8"[^>]*\/>/.test(firstXml), 'Expense amount was automatically filled');
    await capture('reimbursement-workspace-empty.png');
    await checkpoint('normal/reimbursement folder type UI created root + five categories + generated XLSX with current dates, profile, blank expenses');

    let imported = await js(async (request, file) => window.shitu.reimbursementImport({ ...request, category: 'travel', paths: [file] }), request, options.travelPdf);
    const syntheticTravelId = imported.report.assetIds[0];
    assert(imported.report.imported === 1 && !imported.workspace.artifacts.supplementPdf.ready, 'Travel invoice incorrectly created the supplement PDF');
    assert(imported.workspace.categories.find(item => item.key === 'travel').count === 1, 'Travel invoice was not categorized');
    assert(imported.workspace.amounts.pendingCount === 1 && imported.workspace.amounts.items[0].status === 'pending', 'Synthetic PDF without a total was incorrectly recognized as money');
    const categorizedXml = (await xml(formPath)).get('xl/worksheets/sheet1.xml');
    assert(/<c\b[^>]*r="C8"[^>]*>[\s\S]*?出行[\s\S]*?<\/c>/.test(categorizedXml), 'Populated travel category did not enter the reimbursement table');
    assert(!['设备', '会员', '其他', '补票'].some(name => categorizedXml.includes(`>${name}</t>`)), 'Empty or supplement category entered the reimbursement table');
    assert(!/<v>/.test(cellXml(categorizedXml, 'G8')) && cellXml(categorizedXml, 'G18').includes('待核对'), 'Pending invoice produced an invented expense or numeric final total');
    imported = await js(async (request, files) => window.shitu.reimbursementImport({ ...request, category: 'supplement', purpose: 'evidence', paths: files }), request, options.screenshots.slice(0, 3));
    assert(imported.report.imported === 3 && imported.workspace.artifacts.supplementPdf.ready, 'Supplement screenshots did not create printable PDF');
    assert(imported.workspace.amounts.items.length === 1 && imported.workspace.categories.find(item => item.key === 'supplement').invoiceCount === 0, 'Purchase screenshots entered invoice totals');
    const supplementId = imported.workspace.artifacts.supplementPdf.assetId;
    snapshot = await js(() => window.shitu.getLibrary());
    let pdfAsset = snapshot.assets.find(item => item.id === supplementId), pdfBytes = await fs.readFile(path.join(options.library, pdfAsset.filename));
    assert(pdfBytes.subarray(0, 5).toString() === '%PDF-' && (pdfBytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length === 2, 'Three supplement screenshots did not yield two PDF pages');
    const refreshed = await js(request => window.shitu.reimbursementRefresh(request), request);
    assert(refreshed.artifacts.form.assetId === formId && refreshed.artifacts.supplementPdf.assetId === supplementId, 'Regeneration changed stable document IDs');
    await checkpoint('travel PDF remains a source document; only three supplement screenshots generated a two-page PDF with stable document IDs');

    // Exercise the complete invoice merge path, including sandboxed PDF page
    // decoding, through the real renderer/preload/main service. Three ordinary
    // images + a two-page PDF + the existing travel PDF become six invoices.
    const invoiceImport = await js((request, files) => window.shitu.reimbursementImport({ ...request, category: 'travel', paths: files }), request, [...options.invoiceImages.slice(0, 3), options.multiPageInvoice, options.invoiceUnsupported]);
    assert(invoiceImport.report.imported === 5, 'Invoice fixtures were not imported into the ordinary category');
    assert(invoiceImport.workspace.invoiceMerge.sourceCount === 5 && invoiceImport.workspace.invoiceMerge.unsupportedCount === 1, 'Invoice merge did not filter supplementary/generated/unsupported sources');
    const originalSources = (await js(() => window.shitu.getLibrary())).assets
      .filter(item => item.folderId === folder.reimbursement.categoryIds.travel && !item.reimbursementGenerated)
      .map(item => ({ id: item.id, filename: item.filename, hash: item.hash }));
    const invoicePages = async (expected, label) => {
      const view = await js(request => window.shitu.reimbursementGet(request), request);
      assert(view.artifacts.invoicePdf.ready && !view.invoiceMerge.stale, `${label}: invoice PDF was missing or stale`);
      const current = await js(() => window.shitu.getLibrary());
      const asset = current.assets.find(item => item.id === view.artifacts.invoicePdf.assetId);
      const bytes = await fs.readFile(path.join(options.library, asset.filename)), text = bytes.toString('latin1');
      const pages = (text.match(/\/Type\s*\/Page\b/g) || []).length;
      const sizes = [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)];
      assert(pages === expected, `${label}: expected ${expected} pages, got ${pages}`);
      assert(sizes.length === expected && sizes.every(match => Math.abs(Number(match[1]) - 595.2756) < .05 && Math.abs(Number(match[2]) - 841.8898) < .05), `${label}: merged pages were not portrait A4`);
      return { assetId: asset.id, bytes };
    };
    await js(request => window.shituReimbursements.open(request), request);
    await waitFor(() => js(() => document.querySelector('#rb-merge-invoices')?.disabled === false), 'Invoice merge UI did not become ready');
    assert(await js(() => document.querySelector('#rb-invoice-per-page').value === '2'), 'Invoice merge did not default to two invoices per page');
    await js(() => document.querySelector('#rb-merge-invoices').click());
    await waitFor(() => js(async request => { const view = await window.shitu.reimbursementGet(request); return view.artifacts.invoicePdf.ready && !view.invoiceMerge.stale && view.state === 'idle'; }, request), 'UI invoice merge did not complete', 65000);
    const firstInvoicePdf = await invoicePages(3, 'Two-per-page merge');
    const invoicePdfId = firstInvoicePdf.assetId;
    await waitFor(() => js(() => document.querySelector('#rb-invoice-per-page')?.disabled === false && document.querySelector('[data-invoice-action="export"]')?.disabled === false), 'Invoice merge UI did not display its finished output');
    await js(() => { const select = document.querySelector('#rb-invoice-per-page'); select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert(await js(() => document.querySelector('[data-invoice-action="export"]').disabled), 'Changing the local page layout did not disable the outdated export');
    await js(() => document.querySelector('#rb-merge-invoices').click());
    await waitFor(() => js(async request => { const view = await window.shitu.reimbursementGet(request); return view.invoiceMerge.imagesPerPage === 1 && !view.invoiceMerge.stale && view.state === 'idle'; }, request), 'One-per-page invoice merge did not complete', 65000);
    assert((await invoicePages(6, 'One-per-page merge')).assetId === invoicePdfId, 'Changing invoice layout replaced the stable PDF identity');
    const sourceChanged = await js((request, file) => window.shitu.reimbursementImport({ ...request, category: 'travel', paths: [file] }), request, options.invoiceImages[3]);
    assert(sourceChanged.report.imported === 1 && sourceChanged.workspace.invoiceMerge.sourceCount === 6 && sourceChanged.workspace.invoiceMerge.stale, 'Adding an invoice did not mark the merged PDF stale');
    await js(request => window.shituReimbursements.open(request), request);
    await waitFor(() => js(() => document.querySelector('[data-invoice-action="export"]')?.disabled === true && document.querySelector('#rb-merge-invoices')?.disabled === false), 'Stale invoice output did not disable export in the UI');
    const dialogCount = dialogs.length;
    const rejectedExport = await js(async request => {
      try { await window.shitu.reimbursementExport({ ...request, kind: 'invoicePdf' }); return null; }
      catch (error) { return error.message; }
    }, request);
    assert(rejectedExport && /先一键合并/.test(rejectedExport) && dialogs.length === dialogCount, 'A stale invoice PDF was offered for export');
    await js(() => document.querySelector('[data-artifact="invoicePdf"]').scrollIntoView({ block: 'center' }));
    await capture('reimbursement-invoices-stale.png');
    await js(() => { const select = document.querySelector('#rb-invoice-per-page'); select.value = '2'; select.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#rb-merge-invoices').click(); });
    await waitFor(() => js(async request => { const view = await window.shitu.reimbursementGet(request); return view.invoiceMerge.imagesPerPage === 2 && view.invoiceMerge.sourceCount === 6 && !view.invoiceMerge.stale && view.state === 'idle'; }, request), 'Changed invoice sources did not remerge', 65000);
    const finalInvoicePdf = await invoicePages(4, 'Changed-source two-per-page merge');
    assert(finalInvoicePdf.assetId === invoicePdfId, 'Source refresh replaced the stable invoice PDF identity');
    await waitFor(() => js(() => document.querySelector('[data-invoice-action="export"]')?.disabled === false), 'Regenerated invoice output remained disabled');
    await js(() => document.querySelector('[data-invoice-action="export"]').click());
    const invoiceExportPath = path.join(options.directory, 'export-invoices.pdf');
    await waitFor(() => fs.stat(invoiceExportPath).then(info => info.size > 0, () => false), 'Invoice PDF UI export did not save a file');
    assert(hash(await fs.readFile(invoiceExportPath)) === hash(finalInvoicePdf.bytes), 'Invoice PDF UI export differed from the generated original');
    for (const source of originalSources) assert(hash(await fs.readFile(path.join(options.library, source.filename))) === source.hash, 'Invoice merging modified a managed source file');
    for (const [filename, expectedHash] of options.invoiceSourceHashes) assert(hash(await fs.readFile(filename)) === expectedHash, 'Invoice merging modified an external PDF or image source');
    const invoiceRoot = (await js(() => window.shitu.getLibrary())).folders.find(item => item.id === folderId).reimbursement;
    assert(invoiceRoot.invoicePdfOptions.imagesPerPage === 2 && /^[a-f0-9]{64}$/.test(invoiceRoot.invoicePdfSignature), 'Invoice layout or source signature was not persisted');
    await js(() => document.querySelector('[data-artifact="invoicePdf"]').scrollIntoView({ block: 'center' }));
    await capture('reimbursement-invoices-merged.png');
    await js(() => document.querySelector('.rb-summary')?.scrollIntoView({ block: 'start' }));
    await checkpoint('real PDF pages and ordinary category images merge into portrait A4; two-per-page, one-per-page, stale-output blocking and UI export preserve source bytes and stable identity');

    const nativeAmountImport = await js((request, files) => window.shitu.reimbursementImport({ ...request, category: 'equipment', purpose: 'invoice', paths: files }), request, [options.autoImageInvoice, options.textInvoice]);
    assert(nativeAmountImport.report.imported === 2, 'Real OCR/text-layer invoice fixtures failed to import');
    snapshot = await js(() => window.shitu.getLibrary());
    const autoImageId = nativeAmountImport.report.assetIds.find(id => snapshot.assets.find(asset => asset.id === id)?.ext === 'png');
    const textInvoiceId = nativeAmountImport.report.assetIds.find(id => snapshot.assets.find(asset => asset.id === id)?.ext === 'pdf');
    let amountView = nativeAmountImport.workspace;
    assert(amountView.amounts.items.find(item => item.assetId === autoImageId)?.amountCents === 800 && amountView.amounts.items.find(item => item.assetId === autoImageId)?.status === 'recognized', 'Windows OCR did not automatically recognize the image invoice total');
    assert(amountView.amounts.items.find(item => item.assetId === textInvoiceId)?.amountCents === 6789 && amountView.amounts.items.find(item => item.assetId === textInvoiceId)?.status === 'recognized', 'PDF text layer did not automatically recognize the invoice total');
    const ambiguousImport = await js((request, file) => window.shitu.reimbursementImport({ ...request, category: 'equipment', purpose: 'invoice', paths: [file] }), request, options.ambiguousOcrInvoice);
    const ambiguousId = ambiguousImport.report.assetIds[0], ambiguousAmount = ambiguousImport.workspace.amounts.items.find(item => item.assetId === ambiguousId);
    assert(ambiguousAmount?.status === 'pending' && ambiguousAmount.amountCents === null, 'OCR decimal punctuation ambiguity was incorrectly entered as a numeric amount');
    await js(request => window.shitu.reimbursementSetAmount(request), { ...request, assetId: ambiguousId, pageNumber: 1, amount: null, excluded: true });
    const supplementInvoices = await js((request, file) => window.shitu.reimbursementImport({ ...request, category: 'supplement', purpose: 'invoice', paths: [file] }), request, options.supplementInvoice);
    const supplementInvoiceId = supplementInvoices.report.assetIds[0]; amountView = supplementInvoices.workspace;
    const supplementPages = amountView.amounts.items.filter(item => item.assetId === supplementInvoiceId);
    assert(supplementPages.length === 2 && supplementPages[0].amountCents === 2550 && supplementPages[1].amountCents === 450, 'Supplement invoice PDF pages were not recognized separately');
    const supplementCategory = amountView.categories.find(item => item.key === 'supplement');
    assert(supplementCategory.invoiceItems.length === 1 && supplementCategory.evidenceItems.length === 3 && supplementCategory.amountCents === 3000, 'Supplement invoice/evidence purposes were mixed');
    for (const item of amountView.amounts.items.filter(item => item.categoryKey === 'travel')) {
      await js(request => window.shitu.reimbursementSetAmount(request), { ...request, assetId: item.assetId, pageNumber: item.pageNumber, amount: item.assetId === syntheticTravelId ? '42.50' : '0.00', excluded: false });
    }
    amountView = await js(request => window.shitu.reimbursementGet(request), request);
    assert(amountView.amounts.pendingCount === 0 && amountView.amounts.totalCents === 14839, 'Per-page manual review did not clear pending amounts or total correctly');
    await js(request => window.shituReimbursements.open(request), request);
    await waitFor(() => js(id => !!document.querySelector(`[data-amount-asset="${id}"] [data-amount-save]`), textInvoiceId), 'Production per-page amount controls unavailable');
    await js(id => { const row = document.querySelector(`[data-amount-asset="${id}"][data-amount-page="1"]`); row.querySelector('input').value = '70.10'; row.querySelector('input').dispatchEvent(new Event('input', { bubbles: true })); row.querySelector('[data-amount-save]').click(); }, textInvoiceId);
    await waitFor(() => js(async (request, id) => { const view = await window.shitu.reimbursementGet(request); return view.amounts.items.find(item => item.assetId === id)?.amountCents === 7010 && view.state === 'idle'; }, request, textInvoiceId), 'Production amount-edit UI failed to save through IPC');
    await js(id => document.querySelector(`[data-amount-asset="${id}"][data-amount-page="2"] [data-amount-exclude]`).click(), supplementInvoiceId);
    await waitFor(() => js(async (request, id) => { const view = await window.shitu.reimbursementGet(request); return view.amounts.items.find(item => item.assetId === id && item.pageNumber === 2)?.status === 'excluded' && view.state === 'idle'; }, request, supplementInvoiceId), 'Production per-page exclusion UI failed');
    amountView = (await js(request => window.shitu.reimbursementSetAmount(request), { ...request, assetId: supplementInvoiceId, pageNumber: 2, amount: '0.00', excluded: false })).workspace;
    assert(amountView.amounts.items.find(item => item.assetId === supplementInvoiceId && item.pageNumber === 2)?.status === 'manual' && amountView.amounts.totalCents === 14610, 'Explicit zero failed to restore excluded page without changing total');
    assert(amountView.categories.find(item => item.key === 'travel').amountCents === 4250 && amountView.categories.find(item => item.key === 'equipment').amountCents === 7810 && amountView.categories.find(item => item.key === 'supplement').amountCents === 2550, 'Category amount summaries differ from page values');
    let amountXml = (await xml(formPath)).get('xl/worksheets/sheet1.xml');
    assert(numericCell(amountXml, 'G8') === 42.5 && numericCell(amountXml, 'G9') === 78.1 && numericCell(amountXml, 'G10') === 25.5 && cellXml(amountXml, 'G18').includes('SUM(G8:G17'), 'Workbook category G amounts or automatic total formula are wrong');
    await waitFor(() => js(() => document.querySelector('#rb-merge-supplement-invoices')?.disabled === false), 'Supplement invoice merge action unavailable');
    await js(() => { const select = document.querySelector('#rb-supplement-invoice-per-page'); select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#rb-merge-supplement-invoices').click(); });
    await waitFor(() => js(async request => { const view = await window.shitu.reimbursementGet(request); return view.artifacts.supplementInvoicePdf.ready && !view.supplementInvoiceMerge.stale && view.supplementInvoiceMerge.imagesPerPage === 1 && view.state === 'idle'; }, request), 'Independent supplement invoice merge did not complete', 65000);
    amountView = await js(request => window.shitu.reimbursementGet(request), request); snapshot = await js(() => window.shitu.getLibrary());
    const supplementInvoicePdfId = amountView.artifacts.supplementInvoicePdf.assetId;
    const separatePdf = await fs.readFile(path.join(options.library, snapshot.assets.find(item => item.id === supplementInvoicePdfId).filename));
    assert((separatePdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length === 2 && [...separatePdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].every(match => Math.abs(Number(match[1]) - 595.2756) < .05 && Math.abs(Number(match[2]) - 841.8898) < .05), 'Supplement invoice merge is not two independent A4 pages');
    assert(amountView.invoiceMerge.imagesPerPage === 2 && amountView.invoiceMerge.sourceCount === 9 && amountView.supplementInvoiceMerge.sourceCount === 1, 'Supplement merge changed regular invoice layout or source partition');
    const stillEvidence = await fs.readFile(path.join(options.library, snapshot.assets.find(item => item.id === supplementId).filename));
    assert((stillEvidence.toString('latin1').match(/\/Subtype \/Image/g) || []).length === 3, 'Supplement invoice pages leaked into the purchase-evidence PDF');
    const separateExport = await js(request => window.shitu.reimbursementExport(request), { ...request, kind: 'supplementInvoicePdf' });
    assert(separateExport.saved && hash(await fs.readFile(separateExport.path)) === hash(separatePdf), 'Supplement invoice export IPC did not preserve generated PDF bytes');
    await js(() => document.querySelector('#rb-amount-review').scrollIntoView({ block: 'start' })); await capture('reimbursement-amounts.png');
    await checkpoint('real Windows OCR and PDF text amounts auto-populate categories; UI edits/exclusion/zero restore update G cells and total; supplement invoices and evidence have independent A4 outputs');

    const currentArchive = readZip(await fs.readFile(formPath));
    const firstSheet = currentArchive.entries.find(entry => entry.name === 'xl/worksheets/sheet1.xml');
    firstSheet.data = Buffer.from(firstSheet.data.toString()
      .replace(/<c\b[^>]*\br="C8"[^>]*\/>|<c\b[^>]*\br="C8"[^>]*>[\s\S]*?<\/c>/, '<c r="C8" s="69" t="inlineStr"><is><t>手工填写的交通费</t></is></c>'));
    await fs.writeFile(formPath, writeZip(currentArchive));
    const updatedProfile = { ...options.profile, applicant: '测试申请人乙', companyName: '更新后的测试公司' };
    await js(profile => window.shitu.reimbursementSaveProfile(profile), updatedProfile);
    await waitFor(() => workbookIncludes(formPath, updatedProfile.companyName), 'Company-name setting did not automatically update the existing workbook');
    await js(request => window.shitu.reimbursementRefresh(request), request);
    const preservedXml = (await xml(formPath)).get('xl/worksheets/sheet1.xml');
    assert(preservedXml.includes('手工填写的交通费') && preservedXml.includes('<v>42.50</v>') && preservedXml.includes('测试申请人乙') && preservedXml.includes(updatedProfile.companyName), 'Profile sync discarded external expense edits or failed to update the company name');
    const expectedFormName = `财务报销申请表（${updatedProfile.companyName}）${options.date.slice(0, 4)}年${Number(options.date.slice(5, 7))}月`;
    assert((await js(request => window.shitu.reimbursementGet(request), request)).artifacts.form.name === expectedFormName, 'Workbook filename did not follow company and current month');
    await checkpoint('company and applicant setting changes update the workbook while preserving edited description and the native amount setter value');

    const rootCategory = folder.reimbursement.categoryIds;
    const extra = await js(async (file, category) => { const result = await window.shitu.importPaths([file], category); applyLibrary(result.snapshot); return result; }, options.screenshots[3], rootCategory.other);
    await js(async (id, category, libraryRoot) => { const result = await window.shitu.moveAssetsToFolder([id], category, libraryRoot); applyLibrary(result); }, extra.report.assetIds[0], rootCategory.supplement, options.library);
    await waitFor(() => js(async request => { const view = await window.shitu.reimbursementGet(request); return view.categories.find(item => item.key === 'supplement').evidenceItems.length === 4 && view.artifacts.supplementPdf.name.includes('_4张') && view.state === 'idle'; }, request), 'Native library move did not trigger automatic supplement rebuild');
    await checkpoint('ordinary library import then move into supplement category triggered the index watcher and rebuilt the same PDF');

    await js(async request => { applyLibrary(await window.shitu.getLibrary()); await window.shituReimbursements.open(request); }, request);
    await waitFor(() => js(() => document.querySelectorAll('.rb-category').length === 5 && document.querySelector('[data-category="supplement"] [data-purpose="evidence"] .rb-file-list')?.children.length === 4), 'Final workspace did not show four supplement screenshots');
    await capture('reimbursement-workspace.png');
    for (const kind of ['form', 'supplementPdf']) {
      const exported = await js(request => window.shitu.reimbursementExport(request), { ...request, kind });
      assert(exported.saved && path.dirname(exported.path) === options.directory, 'Real reimbursement export IPC did not write expected external path');
      const exportedBytes = await fs.readFile(exported.path);
      assert(kind === 'form' ? exportedBytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) : exportedBytes.subarray(0, 5).toString() === '%PDF-', 'Exported artifact signature invalid');
    }
    assert(dialogs.some(item => item.extension === 'xlsx' && item.defaultPath === `${expectedFormName}.xlsx`), 'Export filename did not include company and current year/month');
    await pause(700);
    openingTest = async settings => {
      assert(settings.title.includes('已有素材库'), 'Unexpected switch dialog');
      await js(profile => window.shitu.reimbursementSaveProfile(profile), { ...updatedProfile, applicant: '切库恢复测试' });
      await pause(750);
      assert(!(await xml(formPath)).get('xl/worksheets/sheet1.xml').includes('切库恢复测试'), 'Background generation continued while library switching was pending');
      return { canceled: true, filePaths: [] };
    };
    const cancelledSwitch = await js(() => window.shitu.openLibrary());
    openingTest = null;
    assert(cancelledSwitch.cancelled, 'Library switching did not cancel');
    await waitFor(() => workbookIncludes(formPath, '切库恢复测试'), 'Background generation did not resume after cancelling library switching');
    await checkpoint('background reimbursement generation pauses during library switching and resumes after cancellation');

    // Customize categories through the actual management UI, with files and a
    // nested folder in the removed category to exercise preservation end-to-end.
    const nested = await js(async (parentId, libraryRoot) => {
      const result = await window.shitu.createFolder('分类中的子文件夹', parentId);
      applyLibrary(result);
      return result.folders.find(item => item.parentId === parentId && item.name === '分类中的子文件夹').id;
    }, rootCategory.travel, options.library);
    const retainedFile = path.join(options.directory, '子文件夹保留说明.txt');
    await fs.writeFile(retainedFile, 'Synthetic category-removal preservation fixture.');
    const retained = await js(async (file, folderId) => {
      const result = await window.shitu.importPaths([file], folderId); applyLibrary(result.snapshot); return result.report.assetIds[0];
    }, retainedFile, nested);
    await js(request => window.shitu.reimbursementRefresh(request), request);
    const beforeCustomization = await js(() => window.shitu.getLibrary());
    const retainedHash = beforeCustomization.assets.find(item => item.id === retained).hash;
    const travelId = beforeCustomization.assets.find(item => item.ext === 'pdf' && item.folderId === rootCategory.travel && !item.reimbursementGenerated).id;
    await js(async request => { applyLibrary(await window.shitu.getLibrary()); await window.shituReimbursements.open(request); }, request);
    await waitFor(() => js(() => document.querySelector('#rb-manage-categories')?.disabled === false), 'Category management entry unavailable');
    await js(() => document.querySelector('#rb-manage-categories').click());
    await waitFor(() => js(() => !!document.querySelector('#rb-category-editor')), 'Category editor did not open');
    await js(() => {
      for (const [key, name] of [['membership', '订阅'], ['supplement', '购买凭证']]) {
        const input = document.querySelector(`[data-category-key="${key}"] input`);
        input.value = name; input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('[data-category-key="travel"] [data-category-remove]').click();
      document.querySelector('#rb-new-category-type').value = 'normal';
      document.querySelector('#rb-new-category-type').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#rb-new-category-name').value = '餐饮';
      document.querySelector('#rb-new-category-name').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#rb-add-category').click();
    });
    await js(() => {
      let row = [...document.querySelectorAll('#rb-category-editor [data-category-key]')].find(item => item.querySelector('input')?.value === '餐饮');
      if (!row) throw new Error('New custom category row missing');
      const key = row.dataset.categoryKey;
      for (let index = 0; index < 8; index++) {
        row = document.querySelector(`[data-category-key="${key}"]`);
        const move = row.querySelector('[data-category-move="-1"]');
        if (!move || move.disabled) break;
        move.click();
      }
      document.querySelector('#rb-save-categories').click();
    });
    await waitFor(() => js(() => !document.querySelector('#rb-category-editor') && document.querySelectorAll('.rb-category').length === 5 && document.querySelector('.rb-category h3')?.textContent === '餐饮'), 'UI category edit did not save new order');
    let customView = await js(request => window.shitu.reimbursementGet(request), request);
    assert(customView.categories[0].name === '餐饮' && customView.categories[0].key.startsWith('custom-'), 'New category was not persisted in first position');
    assert(customView.categories.find(item => item.key === 'membership')?.name === '订阅', 'Category rename did not persist');
    assert(customView.categories.find(item => item.key === 'supplement')?.name === '购买凭证', 'Supplement role was lost while renaming');
    assert(!customView.categories.some(item => item.key === 'travel'), 'Removed category still appears');
    assert(customView.artifacts.supplementPdf.assetId === supplementId && customView.artifacts.supplementPdf.ready, 'Renaming supplement changed its generated PDF identity');
    snapshot = await js(() => window.shitu.getLibrary());
    assert(!snapshot.folders.some(item => item.id === rootCategory.travel), 'Deleted category folder remained');
    assert(snapshot.folders.find(item => item.id === nested)?.parentId === folderId, 'Deleting category did not preserve and reparent its child folder');
    assert(snapshot.assets.find(item => item.id === travelId)?.folderId === folderId, 'Deleting category did not retain its direct PDF in reimbursement root');
    assert(snapshot.assets.find(item => item.id === retained)?.folderId === nested && snapshot.assets.find(item => item.id === retained)?.hash === retainedHash, 'Nested file identity or placement changed');
    const afterDeleteXml = await xml(formPath);
    assert(!afterDeleteXml.get('xl/worksheets/sheet1.xml').includes('手工填写的交通费'), 'Deleted category still appears in the reimbursement table');
    assert([...afterDeleteXml].some(([name, data]) => name.startsWith('xl/worksheets/') && name !== 'xl/worksheets/sheet1.xml' && data.includes('手工填写的交通费') && data.includes('42.50')), 'Removed category lost its previously entered expense');
    const foodCategory = customView.categories.find(item => item.name === '餐饮');
    await js(async (id, target, libraryRoot) => { const result = await window.shitu.moveAssetsToFolder([id], target, libraryRoot); applyLibrary(result); }, travelId, foodCategory.folderId, options.library);
    await js(request => window.shitu.reimbursementRefresh(request), request);
    const foodXml = (await xml(formPath)).get('xl/worksheets/sheet1.xml');
    assert(/<c\b[^>]*r="C8"[^>]*>[\s\S]*?餐饮[\s\S]*?<\/c>/.test(foodXml), 'New category with an invoice did not enter the reimbursement table');
    assert(numericCell(foodXml, 'G8') === 42.5 && !['订阅', '其他'].some(name => foodXml.includes(`>${name}</t>`)) && foodXml.includes('购买凭证'), 'Amounts did not follow the moved invoice or empty category was printed');
    await checkpoint('reimbursement table lists populated invoice categories including supplement invoices, excludes empty categories, and preserves amounts when an invoice changes category');
    await capture('reimbursement-custom-categories.png');
    await checkpoint('category UI added and reordered a custom category, renamed categories, and removed an occupied category while preserving its files and nested folder');

    // Supplement behavior belongs to its stable key, not its display name.
    const fifthScreenshot = path.join(options.directory, '额外购买截图.png');
    const sharp = require('sharp');
    await sharp({ create: { width: 420, height: 280, channels: 3, background: '#ffe066' } }).png().toFile(fifthScreenshot);
    const fifth = await js((request, file) => window.shitu.reimbursementImport({ ...request, category: 'supplement', purpose: 'evidence', paths: [file] }), request, fifthScreenshot);
    assert(fifth.report.imported === 1 && fifth.workspace.categories.find(item => item.key === 'supplement').evidenceItems.length === 5, 'Renamed supplement category could not import another screenshot');
    assert(fifth.workspace.artifacts.supplementPdf.assetId === supplementId, 'Renamed supplement did not retain its PDF role');
    snapshot = await js(() => window.shitu.getLibrary());
    pdfAsset = snapshot.assets.find(item => item.id === supplementId);
    pdfBytes = await fs.readFile(path.join(options.library, pdfAsset.filename));
    assert((pdfBytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length === 3, 'Five screenshots did not regenerate three PDF pages after role rename');
    const supplementSources = snapshot.assets.filter(item => item.folderId === rootCategory.supplement && !item.reimbursementGenerated).map(item => ({ id: item.id, hash: item.hash }));
    const withoutSupplement = fifth.workspace.categories.filter(item => item.key !== 'supplement').map(({ key, name }) => ({ key, name }));
    const removedRole = await js((request, categories) => window.shitu.reimbursementSaveCategories({ ...request, categories }), request, withoutSupplement);
    assert(!removedRole.workspace.artifacts.supplementPdf.ready, 'Removing supplement role left its PDF active');
    snapshot = await js(() => window.shitu.getLibrary());
    for (const source of supplementSources) {
      const actual = snapshot.assets.find(item => item.id === source.id);
      assert(actual && !actual.trashedAt && actual.folderId === folderId && actual.hash === source.hash, 'Removing supplement lost or trashed a source screenshot');
    }
    const recreatedRole = await js((request, categories) => window.shitu.reimbursementSaveCategories({ ...request, categories: [...categories, { key: 'supplement', name: '补票恢复' }] }), request, withoutSupplement);
    const recreatedSupplement = recreatedRole.workspace.categories.find(item => item.key === 'supplement');
    assert(recreatedSupplement?.name === '补票恢复' && !recreatedRole.workspace.artifacts.supplementPdf.ready, 'Recreated empty supplement role unexpectedly claimed a PDF');
    await js(async (ids, category, libraryRoot) => { const result = await window.shitu.moveAssetsToFolder(ids, category, libraryRoot); applyLibrary(result); }, supplementSources.map(item => item.id), recreatedSupplement.folderId, options.library);
    await waitFor(() => js(async request => { const view = await window.shitu.reimbursementGet(request); return view.categories.find(item => item.key === 'supplement')?.evidenceItems.length === 5 && view.artifacts.supplementPdf.ready && view.state === 'idle'; }, request), 'Recreated supplement role did not resume automatic PDF generation');
    await js(request => window.shituReimbursements.open(request), request);
    await capture('reimbursement-restored-supplement.png');
    await checkpoint('renamed supplement kept automatic PDF generation; removing it preserved every source and cleared PDF; re-adding the role and moving screenshots back restored generation');

    // The new deletion action only recycles sources in this isolated library.
    // Verify UI cancellation first, then totals, worksheet rows and restoration.
    await js(request => window.shitu.reimbursementMergeInvoices({ ...request, imagesPerPage: 2 }), request);
    await js(request => window.shituReimbursements.open(request), request);
    const beforeFileRemoval = await js(request => window.shitu.reimbursementGet(request), request);
    const foodBefore = beforeFileRemoval.categories.find(item => item.key === foodCategory.key);
    const beforeTotal = beforeFileRemoval.amounts.totalCents;
    const beforeSourceAsset = (await js(() => window.shitu.getLibrary())).assets.find(item => item.id === travelId);
    const beforeSourcePath = path.join(options.library, beforeSourceAsset.filename), beforeSourceBytes = await fs.readFile(beforeSourcePath);
    assert(!beforeFileRemoval.invoiceMerge.stale && foodBefore.amountCents === 4250, 'Deletion fixture needs a current merged PDF and a known category amount');
    await waitFor(() => js(id => document.querySelector(`[data-remove-file="${id}"]`)?.disabled === false, travelId), 'File-row removal action unavailable');
    await js(id => document.querySelector(`[data-remove-file="${id}"]`).click(), travelId);
    await waitFor(() => js(id => !!document.querySelector(`[data-confirm-remove-file="${id}"]`), travelId), 'Inline removal confirmation did not open');
    await js(id => document.querySelector(`[data-cancel-remove-file="${id}"]`).click(), travelId);
    assert(await js(id => !document.querySelector(`[data-confirm-remove-file="${id}"]`) && !!document.querySelector(`.rb-file-row[data-file-id="${id}"]`), travelId), 'Cancelling removal changed the file row');
    assert(!(await js(() => window.shitu.getLibrary())).assets.find(item => item.id === travelId).trashedAt, 'Cancelling removal recycled the source');
    assert((await js(request => window.shitu.reimbursementGet(request), request)).amounts.totalCents === beforeTotal, 'Cancelling removal changed the total');
    await js(id => document.querySelector(`[data-remove-file="${id}"]`).click(), travelId);
    await waitFor(() => js(id => !!document.querySelector(`[data-confirm-remove-file="${id}"]`), travelId), 'Second inline removal confirmation did not open');
    await js(id => document.querySelector(`[data-confirm-remove-file="${id}"]`).click(), travelId);
    await waitFor(() => js(async (request, id, expected) => {
      const view = await window.shitu.reimbursementGet(request);
      return !view.amounts.items.some(item => item.assetId === id) && view.amounts.totalCents === expected && view.state === 'idle' &&
        !document.querySelector(`.rb-file-row[data-file-id="${id}"]`);
    }, request, travelId, beforeTotal - foodBefore.amountCents), 'Confirmed removal did not update file list and invoice totals', 65000);
    const removedFileView = await js(request => window.shitu.reimbursementGet(request), request);
    const removedFileAsset = (await js(() => window.shitu.getLibrary())).assets.find(item => item.id === travelId);
    assert(removedFileAsset.trashedAt && removedFileView.invoiceMerge.stale, 'Confirmed removal did not recycle the asset or mark its merged PDF stale');
    const removedFileSheet = (await xml(formPath)).get('xl/worksheets/sheet1.xml');
    assert(!removedFileSheet.includes('>餐饮</t>'), 'An empty category remained in the active worksheet after deleting its final invoice');
    assert(hash(await fs.readFile(beforeSourcePath)) === hash(beforeSourceBytes), 'Recycling an invoice removed or changed its original bytes');
    await js(() => document.querySelector('[data-artifact="invoicePdf"]').scrollIntoView({ block: 'center' }));
    await capture('reimbursement-file-removed.png');
    await dropFiles('[data-category="equipment"]', [options.travelPdf]);
    await waitFor(() => js(async (request, id, expected) => {
      const view = await window.shitu.reimbursementGet(request), library = await window.shitu.getLibrary();
      return view.amounts.totalCents === expected && view.state === 'idle' && view.amounts.items.some(item => item.assetId === id) &&
        library.assets.find(item => item.id === id)?.folderId === view.categories.find(item => item.key === 'equipment').folderId &&
        /已恢复\s*1\s*个文件/.test(document.querySelector('#rb-notice').textContent);
    }, request, travelId, beforeTotal), 'Dragging the deleted invoice did not restore it into the chosen category with a recovery report', 65000);
    const restoredFileView = await js(request => window.shitu.reimbursementGet(request), request);
    assert(restoredFileView.amounts.totalCents === beforeTotal && restoredFileView.amounts.items.some(item => item.assetId === travelId && item.categoryKey === 'equipment'), 'Drag restoration did not restore the invoice amount in the chosen category');
    assert(!((await js(() => window.shitu.getLibrary())).assets.find(item => item.id === travelId).trashedAt), 'Restored invoice remained in the recycle bin');
    assert(hash(await fs.readFile(beforeSourcePath)) === hash(beforeSourceBytes), 'Drag restoration changed original source bytes');
    const restoredFileSheet = (await xml(formPath)).get('xl/worksheets/sheet1.xml');
    assert(!restoredFileSheet.includes('>餐饮</t>') && numericCell(restoredFileSheet, 'G8') === 120.6, 'Restored invoice worksheet amount did not move into the chosen category');
    await capture('reimbursement-drag-restored.png');
    const activeDuplicate = await js((request, category, file) => window.shitu.reimbursementImport({ ...request, category, paths: [file] }), request, foodCategory.key, options.travelPdf);
    assert(activeDuplicate.report.restored === 0 && activeDuplicate.report.duplicates === 1, 'Active duplicate import was reported as a restoration');
    assert(activeDuplicate.snapshot.assets.find(item => item.id === travelId).folderId === restoredFileView.categories.find(item => item.key === 'equipment').folderId && activeDuplicate.workspace.amounts.totalCents === beforeTotal, 'Active duplicate moved categories or counted the amount twice');
    await checkpoint('file-row removal can be cancelled; a native File drop restores the deleted source with the same ID into a new category and reports one restoration; active duplicates neither move nor count twice');

    const beforeSupplementRemoval = await js(request => window.shitu.reimbursementGet(request), request);
    const supplementInvoiceAmount = beforeSupplementRemoval.amounts.items.filter(item => item.assetId === supplementInvoiceId && item.status !== 'excluded').reduce((sum, item) => sum + (item.amountCents || 0), 0);
    const removedSupplementInvoice = await js((request, assetId) => window.shitu.reimbursementRemoveFile({ ...request, category: 'supplement', assetId }), request, supplementInvoiceId);
    assert(removedSupplementInvoice.removed === true && !removedSupplementInvoice.syncError, 'Supplement invoice deletion did not finish syncing');
    assert(!removedSupplementInvoice.workspace.amounts.items.some(item => item.assetId === supplementInvoiceId) && removedSupplementInvoice.workspace.amounts.totalCents === beforeSupplementRemoval.amounts.totalCents - supplementInvoiceAmount, 'Deleting a supplement invoice left its pages in the amount total');
    assert(removedSupplementInvoice.workspace.categories.find(item => item.key === 'supplement').evidenceItems.length === 5, 'Deleting a supplement invoice removed purchase-evidence screenshots');
    const restoredInvoiceImport = await js((request, file) => window.shitu.reimbursementImport({ ...request, category: 'supplement', purpose: 'invoice', paths: [file] }), request, options.supplementInvoice);
    assert(restoredInvoiceImport.report.restored === 1 && restoredInvoiceImport.report.restoredAssetIds.includes(supplementInvoiceId), 'Reimport did not restore the original supplement invoice ID');
    const restoredSupplementView = await js(request => window.shitu.reimbursementGet(request), request);
    assert(restoredSupplementView.amounts.totalCents === beforeTotal, 'Restoring the supplement invoice lost manual page values');
    const evidenceId = restoredSupplementView.categories.find(item => item.key === 'supplement').evidenceItems[0].id;
    const evidenceAsset = (await js(() => window.shitu.getLibrary())).assets.find(item => item.id === evidenceId);
    const evidencePath = path.join(options.library, evidenceAsset.filename), evidenceHash = hash(await fs.readFile(evidencePath));
    const removedEvidence = await js((request, assetId) => window.shitu.reimbursementRemoveFile({ ...request, category: 'supplement', assetId }), request, evidenceId);
    assert(removedEvidence.removed === true && !removedEvidence.syncError && removedEvidence.workspace.amounts.totalCents === beforeTotal, 'Removing purchase evidence changed invoice totals');
    assert(removedEvidence.workspace.categories.find(item => item.key === 'supplement').evidenceItems.length === 4, 'Removed purchase evidence stayed in its file list');
    snapshot = await js(() => window.shitu.getLibrary());
    const updatedEvidencePdf = snapshot.assets.find(item => item.id === removedEvidence.workspace.artifacts.supplementPdf.assetId);
    const updatedEvidenceBytes = await fs.readFile(path.join(options.library, updatedEvidencePdf.filename));
    assert((updatedEvidenceBytes.toString('latin1').match(/\/Subtype\s*\/Image\b/g) || []).length === 4, 'Deleting a screenshot did not rebuild the purchase-evidence PDF');
    assert(hash(await fs.readFile(evidencePath)) === evidenceHash, 'Screenshot original was removed from disk');
    let evidenceSourcePath;
    for (const candidate of [...options.screenshots, fifthScreenshot]) if (hash(await fs.readFile(candidate)) === evidenceHash) { evidenceSourcePath = candidate; break; }
    assert(evidenceSourcePath, 'Original evidence fixture unavailable');
    const restoredEvidenceImport = await js((request, file) => window.shitu.reimbursementImport({ ...request, category: 'supplement', purpose: 'evidence', paths: [file] }), request, evidenceSourcePath);
    assert(restoredEvidenceImport.report.restored === 1 && restoredEvidenceImport.report.restoredAssetIds.includes(evidenceId), 'Reimport did not restore the original evidence ID');
    const restoredAllView = await js(request => window.shitu.reimbursementGet(request), request);
    assert(restoredAllView.amounts.totalCents === beforeTotal && restoredAllView.categories.find(item => item.key === 'supplement').evidenceItems.length === 5, 'Purchase evidence restoration did not restore its list without changing totals');
    await js(request => window.shituReimbursements.open(request), request);
    await capture('reimbursement-files-restored.png');
    await checkpoint('supplement invoice and purchase evidence can be deleted then reimported with the same IDs and chosen purpose; invoice totals and screenshot PDFs update independently');

    // Keep the workspace open throughout: these are native-library entry
    // points, with no applyLibrary/open/refresh call hiding a missed broadcast.
    const beforeNativeView = await js(request => window.shitu.reimbursementGet(request), request);
    const nativeBaseTotal = beforeNativeView.amounts.totalCents, nativeTotal = nativeBaseTotal + 1725;
    const nativeParent = beforeNativeView.categories.find(item => item.key === 'equipment').folderId;
    const nativeChild = await js(async parentId => {
      const result = await window.shitu.createFolder('普通入口同步子目录', parentId);
      return result.folders.find(item => item.parentId === parentId && item.name === '普通入口同步子目录').id;
    }, nativeParent);
    const nativeImported = await js((file, target) => window.shitu.importPaths([file], target), options.nativeSyncInvoice, nativeChild);
    const nativeId = nativeImported.report.assetIds[0];
    assert(nativeImported.report.imported === 1 && nativeId, 'Native library entry did not import the synchronization fixture');
    const waitNativeState = async (present, total, categoryKey) => waitFor(() => js(async (request, id, present, total, categoryKey) => {
      const view = await window.shitu.reimbursementGet(request);
      const row = document.querySelector(`.rb-file-row[data-file-id="${id}"]`);
      const amount = document.querySelector(`[data-amount-asset="${id}"] input`);
      return view.state === 'idle' && view.amounts.totalCents === total && (present ? Boolean(row && amount && amount.value === '17.25' && row.closest('[data-category]')?.dataset.category === categoryKey) : !row && !amount);
    }, request, nativeId, present, total, categoryKey), 'Open workspace did not automatically follow the native library mutation', 65000);
    await waitNativeState(true, nativeTotal, 'equipment');
    assert((await js(() => window.shitu.getLibrary())).assets.find(item => item.id === nativeId).folderId === nativeChild, 'Native import lost the requested category subfolder');
    await js(id => window.shitu.setTrash([id], true), nativeId);
    await waitNativeState(false, nativeBaseTotal, 'equipment');
    await js(id => window.shitu.setTrash([id], false), nativeId);
    await waitNativeState(true, nativeTotal, 'equipment');
    await js(id => window.shitu.setTrash([id], true), nativeId);
    await waitNativeState(false, nativeBaseTotal, 'equipment');
    const nativeReimport = await js((file, target) => window.shitu.importPaths([file], target), options.nativeSyncInvoice, foodCategory.folderId);
    assert(nativeReimport.report.restored === 1 && nativeReimport.report.restoredAssetIds.includes(nativeId), 'Native category reimport did not restore the deleted file identity');
    await waitNativeState(true, nativeTotal, foodCategory.key);
    await js(id => document.querySelector(`.rb-file-row[data-file-id="${id}"]`).scrollIntoView({ block: 'center' }), nativeId);
    await capture('reimbursement-native-library-sync.png');
    await js(id => document.querySelector(`[data-remove-file="${id}"]`).click(), nativeId);
    await waitFor(() => js(id => !!document.querySelector(`[data-confirm-remove-file="${id}"]`), nativeId), 'Workspace removal confirmation was unavailable for the native import');
    await js(id => document.querySelector(`[data-confirm-remove-file="${id}"]`).click(), nativeId);
    await waitNativeState(false, nativeBaseTotal, foodCategory.key);
    const nativeDeleted = (await js(() => window.shitu.getLibrary())).assets.find(item => item.id === nativeId);
    assert(nativeDeleted.trashedAt && nativeDeleted.folderId === foodCategory.folderId, 'Workspace removal did not update the native library category snapshot');
    await waitFor(() => js(id => Boolean(state.library.assets.find(item => item.id === id)?.trashedAt), nativeId), 'Workspace removal did not synchronize the main library renderer');
    assert(hash(await fs.readFile(path.join(options.library, nativeDeleted.filename))) === hash(await fs.readFile(options.nativeSyncInvoice)), 'Bidirectional synchronization changed original invoice bytes');
    await checkpoint('an open workspace follows native-library imports into category subfolders, trash and restore without manual refresh; native reimport restores identity into another category and workspace deletion updates the main library');
    const invoiceTotalBeforeReference = (await js(request => window.shitu.reimbursementGet(request), request)).amounts.totalCents;
    let reference = await js((request, file) => window.shitu.reimbursementImport({ ...request, category: 'supplement', purpose: 'evidence', paths: [file] }), request, options.purchaseScreenshot);
    const referenceId = reference.report.assetIds[0];
    assert(referenceId && reference.workspace.evidenceAmounts.items.find(item => item.assetId === referenceId)?.amountCents === 12800, 'Real Windows OCR did not read the purchase screenshot payment amount');
    assert(reference.workspace.amounts.totalCents === invoiceTotalBeforeReference, 'Purchase screenshot changed the invoice total');
    for (const item of reference.workspace.evidenceAmounts.items.filter(item => item.assetId !== referenceId)) {
      await js(request => window.shitu.reimbursementSetAmount(request), { ...request, purpose: 'evidence', assetId: item.assetId, pageNumber: item.pageNumber, excluded: true });
    }
    const formBeforeReferenceEdit = hash(await fs.readFile(formPath));
    await js(request => window.shituReimbursements.open(request), request);
    await waitFor(() => js(id => !!document.querySelector(`[data-amount-purpose="evidence"][data-amount-asset="${id}"] input:not(:disabled)`), referenceId), 'Purchase reference amount controls unavailable');
    await js(id => {
      const row = document.querySelector(`[data-amount-purpose="evidence"][data-amount-asset="${id}"]`), input = row.querySelector('input');
      input.value = '150.50'; input.dispatchEvent(new Event('input', { bubbles: true })); row.querySelector('[data-amount-save]').click();
    }, referenceId);
    await waitFor(() => js(async (request, id) => {
      const view = await window.shitu.reimbursementGet(request);
      return view.state === 'idle' && view.evidenceAmounts.items.find(item => item.assetId === id)?.amountCents === 15050;
    }, request, referenceId), 'Purchase reference amount UI failed to save');
    reference = await js(request => window.shitu.reimbursementGet(request), request);
    const supplementAmount = reference.categories.find(item => item.key === 'supplement').amountCents;
    const difference = (Math.max(0, 15050 - supplementAmount) / 100).toFixed(2);
    await waitFor(() => js(value => document.querySelector('[data-evidence-difference="supplement"]')?.textContent.includes(value), difference), 'Remaining supplement reference amount did not update');
    assert(reference.amounts.totalCents === invoiceTotalBeforeReference && reference.evidenceAmounts.pendingCount === 0, 'Reference amount editing affected reimbursement totals or left ignored references pending');
    assert(hash(await fs.readFile(formPath)) === formBeforeReferenceEdit, 'Reference amount editing changed the actual reimbursement workbook');
    await js(() => document.querySelector('[data-evidence-totals="supplement"]').scrollIntoView({ block: 'center' }));
    await capture('reimbursement-evidence-totals.png');
    await js(id => document.querySelector(`[data-amount-purpose="evidence"][data-amount-asset="${id}"]`).scrollIntoView({ block: 'center' }), referenceId);
    await capture('reimbursement-evidence-amount.png');
    await checkpoint('real purchase screenshot OCR, independent reference editing and remaining supplement amount work without changing invoice totals or XLSX bytes');
    const beforeTrip = await js(request => window.shitu.reimbursementGet(request), request);
    const tripResult = await js((request, paths) => window.shitu.reimbursementImport({ ...request, purpose: 'itinerary', paths }), request, [options.tripImage, options.tripPdf]);
    assert(tripResult.report.imported === 2 && tripResult.workspace.itinerary.count === 2 && tripResult.workspace.artifacts.itineraryPdf.ready, 'Itinerary image and PDF did not create their own output');
    assert(tripResult.workspace.amounts.totalCents === beforeTrip.amounts.totalCents && tripResult.workspace.evidenceAmounts.totalCents === beforeTrip.evidenceAmounts.totalCents, 'Itinerary entered the reimbursement or purchase reference amounts');
    const tripSnapshot = await js(() => window.shitu.getLibrary()), tripAsset = tripSnapshot.assets.find(asset => asset.id === tripResult.workspace.artifacts.itineraryPdf.assetId);
    assert((await fs.readFile(path.join(options.library, tripAsset.filename))).toString('latin1').match(/\/Type\s*\/Page\b/g)?.length === 3, 'Itinerary image and two PDF pages did not become three A4 pages');
    await js(request => window.shituReimbursements.open(request), request);
    await waitFor(() => js(() => document.querySelector('#rb-itinerary .rb-file-list')?.children.length === 2 && !document.querySelector('[data-artifact="itineraryPdf"] button')?.disabled), 'Itinerary UI did not reflect the real imported files');
    await js(() => document.querySelector('#rb-itinerary').scrollIntoView({ block: 'center' }));
    await capture('reimbursement-itinerary.png');

    const tripSourcePdfId = tripResult.report.assetIds.find(id => tripSnapshot.assets.find(asset => asset.id === id)?.ext === 'pdf');
    const pdfPreview = await js(request => window.shitu.reimbursementPreview(request), { ...request, assetId: tripSourcePdfId, pageNumber: 2 });
    assert(pdfPreview.type === 'image' && /^data:image\/jpeg;base64,/.test(pdfPreview.url) && pdfPreview.pageNumber === 2 && pdfPreview.pageCount === 2, 'Real preview IPC did not render the original PDF second page as JPEG');
    await js(() => window.shitu.reimbursementPreviewCancel());
    const waitPreview = async (assetId, pageNumber, pageCount) => waitFor(() => js((assetId, pageNumber, pageCount) => {
      const current = window.MosaicReimbursementPreview?.currentRequest(), image = document.querySelector('#rb-preview-image');
      return current?.assetId === assetId && current.pageNumber === pageNumber && image && !image.hidden && image.complete && image.naturalWidth > 0 &&
        /^data:image\/jpeg;base64,/.test(image.getAttribute('src') || '') && document.querySelector('#rb-preview-page')?.textContent === `${pageNumber} / ${pageCount}`;
    }, assetId, pageNumber, pageCount), 'Preview did not show the expected original image or PDF page', 65000);
    const clickPreviewName = async key => {
      await waitFor(() => js(key => Boolean([...document.querySelectorAll('button[data-preview-key]')].find(button => button.dataset.previewKey === key && !button.disabled)), key), `File name was not previewable: ${key}`);
      await js(key => { const button = [...document.querySelectorAll('button[data-preview-key]')].find(button => button.dataset.previewKey === key); button.scrollIntoView({ block: 'center' }); button.click(); }, key);
    };
    const closePreview = async () => {
      await js(() => document.querySelector('#rb-preview-close').click());
      await waitFor(() => js(() => !window.MosaicReimbursementPreview.isOpen() && !document.querySelector('#reimbursementCenter').inert), 'Preview close did not restore the reimbursement workspace');
    };
    await js(id => { const input = document.querySelector(`[data-amount-purpose="evidence"][data-amount-asset="${id}"] input`); input.value = '151.01'; input.dispatchEvent(new Event('input', { bubbles: true })); }, referenceId);
    await clickPreviewName(`file:${referenceId}`);
    await waitPreview(referenceId, 1, 1);
    assert(await js(() => document.querySelector('#reimbursementCenter').inert && document.querySelector('#rb-preview-next').disabled), 'Image preview did not isolate the underlying workspace or allowed nonexistent pages');
    await js(() => document.querySelector('#rb-preview-zoom').click());
    assert(await js(() => document.querySelector('#rb-preview-zoom').getAttribute('aria-pressed') === 'true'), 'Preview original-size zoom did not toggle');
    await capture('reimbursement-preview-image.png');
    const previousPreviewUrl = await js(() => document.querySelector('#rb-preview-image').getAttribute('src'));
    const switchingPreview = await js((request, name) => {
      void window.MosaicReimbursementPreview.open({ request, name });
      return !document.querySelector('#rb-preview-image').hasAttribute('src') && document.querySelector('#rb-preview-image').hidden;
    }, { ...request, assetId: autoImageId, pageNumber: 1 }, '合成发票图片');
    assert(switchingPreview, 'Changing preview sources left the earlier image visible while loading');
    await waitPreview(autoImageId, 1, 1);
    assert(await js(old => document.querySelector('#rb-preview-image').getAttribute('src') !== old, previousPreviewUrl), 'Changing files reused the old preview image');
    await closePreview();
    await clickPreviewName(`file:${autoImageId}`); await waitPreview(autoImageId, 1, 1); await closePreview();
    await clickPreviewName(`amount:evidence:${referenceId}:1`); await waitPreview(referenceId, 1, 1); await closePreview();
    assert(await js(id => document.querySelector(`[data-amount-purpose="evidence"][data-amount-asset="${id}"] input`).value === '151.01', referenceId), 'Opening and closing previews lost an unsaved amount draft');
    assert((await js(request => window.shitu.reimbursementGet(request), request)).evidenceAmounts.items.find(item => item.assetId === referenceId).amountCents === 15050, 'Preview silently saved the amount draft');
    await js(id => { const input = document.querySelector(`[data-amount-purpose="evidence"][data-amount-asset="${id}"] input`); input.value = '150.50'; input.dispatchEvent(new Event('input', { bubbles: true })); }, referenceId);
    await checkpoint('file names in categories and screenshot amount rows open safe JPEG previews; zoom, source replacement and close preserve unsaved amount drafts');

    await clickPreviewName(`amount:invoice:${supplementInvoiceId}:2`); await waitPreview(supplementInvoiceId, 2, 2);
    assert(await js(() => document.querySelector('#rb-preview-next').disabled && !document.querySelector('#rb-preview-previous').disabled), 'PDF amount-row preview did not open the corresponding second page');
    await capture('reimbursement-preview-pdf-page2.png');
    await js(() => document.querySelector('#rb-preview-previous').click()); await waitPreview(supplementInvoiceId, 1, 2);
    await js(() => document.querySelector('#rb-preview-next').click()); await waitPreview(supplementInvoiceId, 2, 2); await closePreview();
    await clickPreviewName(`file:${tripSourcePdfId}`); await waitPreview(tripSourcePdfId, 1, 2);
    await js(() => document.querySelector('#rb-preview-next').click()); await waitPreview(tripSourcePdfId, 2, 2); await closePreview();
    await clickPreviewName('artifact:itineraryPdf'); await waitPreview(tripAsset.id, 1, 3); await closePreview();
    await clickPreviewName('artifact:form');
    await waitFor(() => js(() => window.MosaicReimbursementPreview.isOpen() && document.querySelector('#rb-preview-status')?.textContent.includes('默认软件') && document.querySelector('#rb-preview-image').hidden), 'XLSX file name did not open the safe external-format preview state');
    assert(await js(() => !document.querySelector('#rb-preview-open-source').disabled), 'External-format preview did not offer an explicit open-source action');
    await capture('reimbursement-preview-form.png'); await closePreview();
    await checkpoint('real main/preload previews original PDF page 2, per-page amount names, itinerary sources and generated PDF names; XLSX stays in a safe preview layer without launching Excel');

    const exportRoot = path.join(options.directory, '完整报销导出'); await fs.mkdir(exportRoot);
    openingTest = async settings => {
      assert(settings.properties.includes('openDirectory'), 'Export-all did not choose a directory');
      return { canceled: false, filePaths: [exportRoot] };
    };
    await js(() => document.querySelector('#rb-export-all').click());
    await waitFor(async () => {
      const folders = await fs.readdir(exportRoot);
      if (folders.length !== 1) return false;
      const files = await fs.readdir(path.join(exportRoot, folders[0]));
      return files.filter(name => name.endsWith('.pdf')).length === 4 && files.filter(name => name.endsWith('.xlsx')).length === 1 && await js(() => !document.querySelector('#rb-export-all').disabled);
    }, 'Export-all did not finish the complete folder', 65000);
    openingTest = null;
    const [exportFolder] = await fs.readdir(exportRoot), exportedNames = await fs.readdir(path.join(exportRoot, exportFolder));
    const savedProfile = await js(() => window.shitu.reimbursementGetProfile());
    const prefix = require(path.join(options.root, 'src/reimbursement-names.cjs')).reimbursementBundleName(savedProfile, options.date);
    assert(exportFolder === `${prefix}_报销资料` && exportedNames.filter(name => name.endsWith('.pdf')).every(name => name.startsWith(`${prefix}_`)), 'Export folder or PDF names omitted applicant/year/month');
    const exportedView = await js(request => window.shitu.reimbursementGet(request), request), exportedSnapshot = await js(() => window.shitu.getLibrary());
    for (const artifact of Object.values(exportedView.artifacts)) if (artifact.ready) {
      const asset = exportedSnapshot.assets.find(item => item.id === artifact.assetId), filename = `${asset.name}.${asset.ext}`;
      assert(exportedNames.includes(filename) && hash(await fs.readFile(path.join(exportRoot, exportFolder, filename))) === asset.hash, 'Complete export did not preserve exact generated bytes');
    }
    assert(exportedView.amounts.totalCents === beforeTrip.amounts.totalCents, 'Export-all changed reimbursement totals');
    await capture('reimbursement-export-all.png');
    await checkpoint('itinerary images and PDF pages auto-merge without amounts; one UI export creates a Chinese applicant/month folder with the exact XLSX and all four PDFs');
    assert(hash(await fs.readFile(path.join(options.root, 'assets/reimbursement-template.xlsx'))) === options.templateHash, 'Bundled template was modified');
    assert(errors.length === 0, `Production runtime errors: ${errors.join('\n')}`);
    await checkpoint('production export IPC wrote valid XLSX/PDF; bundled template unchanged; no renderer/preload/main errors');
    await persist({ ok: true, library: options.library, folderId, formAssetId: formId, supplementPdfAssetId: supplementId, invoicePdfAssetId: invoicePdfId, supplementInvoicePdfAssetId: supplementInvoicePdfId, restorations: { nativeDrop: 1, supplementInvoice: restoredInvoiceImport.report.restored, evidence: restoredEvidenceImport.report.restored, nativeLibraryReimport: nativeReimport.report.restored }, screenshots: ['reimbursement-settings.png', 'reimbursement-workspace-empty.png', 'reimbursement-workspace.png', 'reimbursement-custom-categories.png', 'reimbursement-restored-supplement.png', 'reimbursement-invoices-stale.png', 'reimbursement-invoices-merged.png', 'reimbursement-amounts.png', 'reimbursement-file-removed.png', 'reimbursement-files-restored.png', 'reimbursement-drag-restored.png', 'reimbursement-native-library-sync.png', 'reimbursement-preview-image.png', 'reimbursement-preview-pdf-page2.png', 'reimbursement-preview-form.png'], exports: ['export.xlsx', 'export.pdf', 'export-invoices.pdf', 'export-supplement-invoices.pdf'] });
    app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) await capture('failure.png').catch(() => {});
    await persist({ ok: false, error: error.stack || String(error) }); app.exit(1);
  }
}
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
async function main() {
  const sharp = require('sharp'), { Library } = require('../src/library.cjs'), { writeImagePdf } = require('../src/image-pdf.cjs');
  const appRoot = path.resolve(process.env.SHITU_REIMBURSEMENT_APP_ROOT || root);
  const parent = path.join(root, '.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'reimbursement-app-'));
  for (const name of ['profile', 'session', 'fixture-app']) await fs.mkdir(path.join(directory, name));
  const library = path.join(directory, 'library'); await new Library({ root: library }).init();
  const screenshots = [];
  for (let index = 0; index < 4; index++) {
    const file = path.join(directory, `购买截图-${index + 1}.png`);
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520"><rect width="800" height="520" fill="${['#edf3ff', '#fff1e5', '#eaf9f1', '#f6edff'][index]}"/><text x="45" y="110" font-family="Arial" font-size="38" fill="#26334f">Purchase screenshot ${index + 1}</text><text x="45" y="205" font-family="Arial" font-size="28" fill="#26334f">Item ${index + 1} / payment confirmed</text><path d="M45 260H755M45 310H755M45 360H520" stroke="#75839e" stroke-width="3"/></svg>`)).png().toFile(file);
    screenshots.push(file);
  }
  const travelPdf = path.join(directory, '出行发票.pdf'); await writeImagePdf({ inputPaths: [screenshots[0]], outputPath: travelPdf, options: { pageSize: 'a4' } });
  const invoiceImages = [];
  for (let index = 0; index < 4; index++) {
    const filename = path.join(directory, `正式发票-${index + 1}.png`);
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="760" height="430"><rect width="760" height="430" fill="${['#f9fff2', '#f2f9ff', '#fff9ed', '#fff3f9'][index]}"/><text x="45" y="100" font-family="Arial" font-size="35" fill="#25374b">Invoice ${index + 1}</text><text x="45" y="190" font-family="Arial" font-size="27" fill="#25374b">Synthetic ordinary expense / ID ${index + 101}</text><path d="M45 250H700M45 300H700M45 350H480" stroke="#7b8f9d" stroke-width="3"/></svg>`)).png().toFile(filename);
    invoiceImages.push(filename);
  }
  const multiPageInvoice = path.join(directory, '两页正式发票.pdf');
  await writeImagePdf({ inputPaths: invoiceImages.slice(0, 2), outputPath: multiPageInvoice, options: { pageSize: 'a4', imagesPerPage: 1 } });
  const invoiceUnsupported = path.join(directory, '不参与合并的说明.txt'); await fs.writeFile(invoiceUnsupported, 'Synthetic attachment excluded from invoice PDF.');
  const invoiceSourceHashes = await Promise.all([travelPdf, multiPageInvoice, ...invoiceImages].map(async filename => [filename, hash(await fs.readFile(filename))]));
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = date.split('-').map(Number);
  const options = { root: appRoot, directory, library, screenshots, travelPdf, invoiceImages, multiPageInvoice, invoiceUnsupported, invoiceSourceHashes, autoImageInvoice: path.join(directory, 'OCR金额发票.png'), ambiguousOcrInvoice: path.join(directory, 'OCR小数点不确定发票.png'), textInvoice: path.join(directory, '文字层金额发票.pdf'), supplementInvoice: path.join(directory, '两页补票发票.pdf'), nativeSyncInvoice: path.join(directory, '普通入口同步发票.pdf'), date, dateChinese: `${y}年${m}月${d}日`, profile: { companyName: '示例公司', applicant: '测试申请人甲', accountName: '测试收款人', bankName: '测试银行北京支行', accountNumber: '00123456789012345678' }, templateHash: hash(await fs.readFile(path.join(appRoot, 'assets/reimbursement-template.xlsx'))) };
  options.purchaseScreenshot = path.join(directory, '实付款购买截图.png');
  options.tripImage = path.join(directory, '打车图片行程单.png'); options.tripPdf = path.join(directory, '两页打车行程单.pdf');
  await fs.writeFile(path.join(directory, 'options.json'), JSON.stringify(options));
  await fs.writeFile(path.join(directory, 'fixture-app/package.json'), JSON.stringify({ name: 'mosaic-reimbursement-smoke', version: require('../package.json').version, main: 'main.cjs' }));
  await fs.writeFile(path.join(directory, 'fixture-app/main.cjs'), `require(${JSON.stringify(__filename)}).runProduction(require(${JSON.stringify(path.join(directory, 'options.json'))}));`);
  const env = { ...process.env, SHITU_LIBRARY: library, SHITU_PLUGIN_ROOT: path.join(directory, 'plugin-root') };
  for (const name of Object.keys(env)) if (name === 'ELECTRON_RUN_AS_NODE' || /SMOKE/.test(name)) delete env[name];
  const logs = [];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [path.join(directory, 'fixture-app'), '--background'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Reimbursement smoke timed out: ${directory}`)); }, 480000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => logs.push(chunk.toString()));
    child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', status => { clearTimeout(timer); resolve(status); });
  });
  await fs.writeFile(path.join(directory, 'electron.log'), logs.join(''));
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  console.log(JSON.stringify({ directory, ...result }, null, 2)); if (code || !result.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { runProduction };
