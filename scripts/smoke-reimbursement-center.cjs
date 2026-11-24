'use strict';

// Isolated production UI check: native file operations and profile storage are mocked.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');

async function electronTest({ app, BrowserWindow }, options) {
  const fs = require('node:fs/promises'), path = require('node:path');
  const checks = [], errors = []; let window;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const js = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const click = async selector => { await js(selector => { const target = document.querySelector(selector); if (!target || target.disabled) throw new Error(`Unavailable ${selector}`); target.click(); }, selector); await pause(); };
  const screenshot = async name => { await new Promise(resolve => setTimeout(resolve, 250)); await fs.writeFile(path.join(options.directory, `${name}.png`), (await window.webContents.capturePage()).toPNG()); };
  try {
    await app.whenReady();
    window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await window.loadFile(options.html);
    await js(async () => window.shituReimbursements.openSettings());
    assert(await js(() => [...document.querySelectorAll('.rb-profile-form input')].every(input => input.value === '')), 'Settings inferred profile data instead of starting blank');
    assert(await js(() => [...document.querySelectorAll('.rb-profile-form input')].map(input => input.maxLength).join(',') === '80,180,120,180,80'), 'Profile field limits differ from service');
    await js(() => { for (const [key, value] of Object.entries({ applicant: '测试申请人', companyName: '测试公司名称', accountName: '测试开户名称', bankName: '测试开户行', accountNumber: '000012345678' })) document.querySelector(`#rb-profile-${key}`).value = value; document.querySelector('#rb-profile-form').requestSubmit(); }); await pause();
    assert(await js(() => window.savedProfiles[0].companyName === '测试公司名称' && document.querySelector('#rb-profile-companyName').value === '测试公司名称' && window.savedProfiles[0].accountNumber === '000012345678' && document.querySelector('#rb-profile-accountNumber').value === '000012345678' && document.querySelector('#rb-notice').textContent.includes('已保存')), 'Profile save did not preserve company name or account text');
    await screenshot('settings');
    await click('#rb-close');
    await js(async () => window.shituReimbursements.open({ folderId: 'case-1', libraryRoot: 'C:\\fixture-library' }));
    assert(await js(() => document.querySelectorAll('.rb-category').length === 5 && [...document.querySelectorAll('.rb-category h3')].map(x => x.textContent).join(',') === '出行,设备,会员,其他,补票'), 'Five reimbursement categories missing');
    assert(await js(() => document.querySelector('[data-artifact="form"] button').disabled === false && document.querySelector('[data-artifact="supplementPdf"] button').disabled === true), 'Initial output readiness incorrect');
    assert(await js(() => document.querySelectorAll('.rb-output-card').length === 5 && document.querySelector('#rb-merge-invoices').disabled && document.querySelector('#rb-merge-supplement-invoices').disabled && document.querySelector('[data-artifact="itineraryPdf"] button').disabled), 'Empty PDF cards missing or enabled');
    assert(await js(() => document.querySelector('#rb-itinerary') && !document.querySelector('#rb-itinerary').closest('.rb-category') && !document.querySelector('#rb-export-all').disabled), 'Independent itinerary area or empty-itinerary export-all action missing');
    await js(() => { window.nextExportAll = 'cancel'; }); await click('#rb-export-all');
    assert(await js(() => document.querySelector('#rb-notice').textContent === '已取消导出。' && !document.querySelector('#rb-export-all').disabled), 'Export-all cancellation left the workspace busy');
    await js(() => { window.nextExportAll = 'error'; }); await click('#rb-export-all');
    assert(await js(() => document.querySelector('#rb-notice').classList.contains('rb-error') && document.querySelector('#rb-notice').textContent.includes('导出目录不可写')), 'Export-all failure was not reported');
    await js(() => { window.nextExportAll = 'pending'; }); await click('#rb-export-all');
    assert(await js(() => document.querySelector('#rb-export-all').disabled && document.querySelector('#rb-notice').textContent.includes('正在准备并导出全部文件')), 'Export-all is not guarded while preparing');
    await js(() => { document.querySelector('#rb-export-all').click(); window.completeExportAll(); }); await pause();
    assert(await js(() => window.exportAllRequests.length === 3 && document.querySelector('#rb-notice').textContent.includes('已导出 1 个文件') && window.exportAllRequests.at(-1).folderId === 'case-1'), 'Empty optional itinerary blocked export-all or double click duplicated it');
    assert(await js(() => document.querySelector('.rb-workspace-bar').textContent.includes('公司名称：测试公司名称')), 'Saved company name missing from workspace summary');
    checks.push('Blank profile settings preserve company and four prior fields, including account leading zeros');

    await click('[data-category="travel"] .rb-text-button');
    assert(await js(() => window.chooseRequests[0].folderId === 'case-1' && window.chooseRequests[0].category === 'travel' && document.querySelector('[data-category="travel"]').textContent.includes('出行发票.pdf')), 'Category import routed incorrectly');
    assert(await js(() => document.querySelector('[data-artifact="supplementPdf"] button').disabled), 'Non-supplement import incorrectly generated screenshot PDF');
    await js(() => {
      const data = new DataTransfer(); data.items.add(new File(['fixture'], '购买截图.png', { type: 'image/png' }));
      const target = document.querySelector('[data-category="supplement"] [data-purpose="evidence"]');
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }); await pause();
    assert(await js(() => window.globalDrops === 0 && window.dropRequests[0].category === 'supplement' && window.dropRequests[0].purpose === 'evidence' && window.dropRequests[0].paths[0].endsWith('购买截图.png')), 'Native file drop bubbled into generic import or wrong category');
    assert(await js(() => !document.querySelector('[data-artifact="supplementPdf"] button').disabled && document.querySelector('[data-category="supplement"]').textContent.includes('购买截图.png')), 'Supplement screenshot import did not update PDF readiness');
    await click('[data-artifact="form"] .rb-output-actions button');
    await click('[data-artifact="supplementPdf"] button');
    assert(await js(() => window.openRequests.map(x => x.kind).join(',') === 'form' && window.previewRequests.at(-1).assetId === 'pdf-1'), 'Wrong artifact preview requests');
    await click('#rb-preview-close');
    await click('[data-artifact="supplementPdf"] button:last-child');
    assert(await js(() => window.exportRequests[0].kind === 'supplementPdf' && document.querySelector('#rb-notice').textContent.includes('补票截图.pdf')), 'PDF export not surfaced');
    await screenshot('workspace');
    checks.push('Category imports and stopped native drop generate PDF only from supplement screenshots');
    await js(() => { window.partialFailure = true; });
    await click('[data-category="equipment"] .rb-text-button');
    assert(await js(() => { const notice = document.querySelector('#rb-notice'); return notice.classList.contains('rb-error') && notice.textContent.includes('没有新增或恢复文件') && notice.textContent.includes('文件已在素材库中，本次未重复添加') && !notice.textContent.includes('保留原分类') && notice.textContent.includes('损坏文件.pdf') && notice.textContent.includes('无法读取'); }), 'Partial or zero import failures were reported as successful archive');
    await js(() => { window.duplicateOnly = true; }); await click('[data-category="equipment"] .rb-text-button');
    assert(await js(() => { const notice = document.querySelector('#rb-notice').textContent; return notice.includes('文件已在素材库中，本次未重复添加') && !notice.includes('已导入') && !notice.includes('已恢复') && document.querySelector('[data-category="equipment"] .rb-count').textContent === '0 个文件'; }), 'A plain duplicate was presented as a new or restored file');
    checks.push('Failed and duplicate imports report counts and individual errors');
    await js(() => { window.nextFileExt = 'docx'; }); await click('[data-category="membership"] .rb-text-button');
    assert(await js(() => { const card = document.querySelector('[data-artifact="invoicePdf"]'); return card.textContent.includes('1 个可合并来源') && card.textContent.includes('1 个其他格式文档未合并'); }), 'Invoice PDF sources include supplement or hide unsupported documents');
    await js(() => { const select = document.querySelector('#rb-invoice-per-page'); select.value = '4'; select.dispatchEvent(new Event('change')); window.delayInvoiceMerge = true; });
    await click('#rb-merge-invoices');
    assert(await js(() => window.mergeRequests[0].imagesPerPage === 4 && window.mergeRequests[0].folderId === 'case-1' && document.querySelector('#rb-merge-invoices').disabled && document.querySelector('#rb-invoice-per-page').disabled), 'Merge request settings or busy guards wrong');
    await js(() => window.completeInvoiceMerge()); await pause();
    assert(await js(() => !document.querySelector('[data-invoice-action="open"]').disabled && document.querySelector('#rb-merge-invoices').textContent === '重新合并'), 'Merged invoice output not ready');
    await click('[data-invoice-action="open"]'); await click('#rb-preview-close'); await click('[data-invoice-action="export"]');
    assert(await js(() => window.previewRequests.at(-1).assetId === 'invoice-merged' && window.exportRequests.at(-1).kind === 'invoicePdf'), 'Merged invoice preview/export use wrong artifact kind');
    await js(() => { const select = document.querySelector('#rb-invoice-per-page'); select.value = '2'; select.dispatchEvent(new Event('change')); });
    assert(await js(() => document.querySelector('[data-invoice-action="open"]').disabled && document.querySelector('[data-artifact="invoicePdf"]').textContent.includes('排版已更改')), 'Changed page density left old PDF enabled');
    await js(() => { window.delayInvoiceMerge = false; window.failInvoiceMerge = true; }); await click('#rb-merge-invoices');
    assert(await js(() => document.querySelector('#rb-notice').classList.contains('rb-error') && document.querySelector('#rb-notice').textContent.includes('合并失败')), 'Merge failure not shown');
    await click('#rb-merge-invoices');
    await js(() => window.markInvoiceStale()); await pause();
    assert(await js(() => document.querySelector('[data-invoice-action="open"]').disabled && document.querySelector('[data-invoice-action="export"]').disabled && document.querySelector('[data-artifact="invoicePdf"]').textContent.includes('发票已变化')), 'Backend stale state left old PDF enabled');
    await screenshot('merged-invoices');
    checks.push('Merged invoice PDF excludes supplement, reports unsupported files, guards layout/stale state and handles merge failures');
    assert(await js(() => document.querySelectorAll('#rb-amount-review [data-amount-asset]').length === 1 && document.querySelector('#rb-amount-total').textContent.includes('10.00')), 'Purchase screenshots were included in invoice amount rows or total');
    await js(() => { window.nextPending = true; window.nextPageCount = 2; });
    await click('[data-category="supplement"] [data-purpose="invoice"] .rb-text-button');
    assert(await js(() => {
      window.pendingAsset = window.lastAddedId;
      const total = document.querySelector('#rb-amount-total').textContent;
      return window.chooseRequests.at(-1).purpose === 'invoice' && total.includes('已识别小计') && total.includes('待核对 2') && !total.includes('报销总额') && document.querySelectorAll('#rb-amount-review [data-amount-asset]').length === 3;
    }), 'Supplement invoice pages not counted as pending or subtotal mislabeled as final total');
    assert(await js(() => document.querySelector('#rb-refresh-workspace').textContent.includes('重试识别')), 'Missing retry recognition action');
    await click('#rb-refresh-workspace');
    await js(() => { const input = document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="1"] input`); input.value = '1.234'; input.dispatchEvent(new Event('input')); });
    assert(await js(() => document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="1"] [data-amount-save]`).disabled && !window.amountRequests.length), 'Invalid amount precision was submitted');
    await js(() => { const input = document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="1"] input`); input.value = '12.34'; input.dispatchEvent(new Event('input')); document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="1"] [data-amount-save]`).click(); }); await pause();
    assert(await js(() => window.amountRequests.at(-1).amount === '12.34' && window.amountRequests.at(-1).pageNumber === 1 && window.amountRequests.at(-1).excluded === false && document.querySelector('#rb-amount-total').textContent.includes('待核对 1')), 'Manual amount did not update the exact page or pending count');
    await js(() => document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="2"] [data-amount-exclude]`).click()); await pause();
    assert(await js(() => window.amountRequests.at(-1).amount === null && window.amountRequests.at(-1).excluded === true && document.querySelector('#rb-amount-total').textContent.includes('报销总额 ¥22.34')), 'Exclusion did not preserve total or used a false zero');
    await js(() => { const input = document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="2"] input`); input.value = '0'; input.dispatchEvent(new Event('input')); document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="2"] [data-amount-save]`).click(); }); await pause();
    assert(await js(() => window.amountRequests.at(-1).amount === '0.00' && window.amountRequests.at(-1).excluded === false && document.querySelector('#rb-amount-total').textContent.includes('22.34')), 'Explicit zero failed to restore excluded invoice page');
    await js(() => { const select = document.querySelector('#rb-supplement-invoice-per-page'); select.value = '6'; select.dispatchEvent(new Event('change')); });
    await click('#rb-merge-supplement-invoices');
    await click('[data-supplement-invoice-action="open"]'); await click('#rb-preview-close'); await click('[data-supplement-invoice-action="export"]');
    assert(await js(() => window.mergeRequests.at(-1).scope === 'supplement' && window.mergeRequests.at(-1).imagesPerPage === 6 && window.previewRequests.at(-1).assetId === 'invoice-merged' && window.exportRequests.at(-1).kind === 'supplementInvoicePdf' && document.querySelector('#rb-invoice-per-page').value === '2'), 'Supplement invoice merge scope or independent layout/artifact wrong');
    assert(await js(() => new Set([...document.querySelectorAll('[id]')].map(item => item.id)).size === document.querySelectorAll('[id]').length), 'Invoice and supplement cards have duplicate IDs');
    await js(() => document.querySelector('#rb-amount-review').scrollIntoView({ block: 'start' })); await screenshot('amount-review');
    await js(() => { document.querySelector('#rb-content').scrollTop = 0; });
    checks.push('Pending subtotals, per-page amount review/exclusion/zero and independent supplement invoice merge');

    assert(await js(() => {
      window.evidenceAmountAsset = document.querySelector('#rb-evidence-amount-review [data-amount-asset]').dataset.amountAsset;
      return document.querySelector('#rb-evidence-amount-review h3').textContent === '购买截图金额（不计入报销）' && document.querySelectorAll('#rb-evidence-amount-review [data-amount-asset]').length === 1 && document.querySelector('#rb-evidence-amount-total').textContent.includes('10.00 元') && document.querySelector('[data-evidence-difference="supplement"]').textContent.includes('0.00 元');
    }), 'Screenshot reference amounts were missing, mixed with invoices, or produced a negative supplement difference');
    await js(() => { const input = document.querySelector('#rb-evidence-amount-review input'); input.value = '50'; input.dispatchEvent(new Event('input')); document.querySelector('#rb-evidence-amount-review [data-amount-save]').click(); }); await pause();
    assert(await js(() => window.amountRequests.at(-1).purpose === 'evidence' && window.amountRequests.at(-1).amount === '50.00' && document.querySelector('#rb-amount-total').textContent.includes('22.34') && document.querySelector('[data-evidence-totals="supplement"]').textContent.includes('已有补票发票合计：12.34 元') && document.querySelector('[data-evidence-difference="supplement"]').textContent.includes('37.66 元')), 'Manual screenshot amount changed reimbursement totals or supplement reference difference is wrong');
    await js(() => { window.markAmountPending(window.evidenceAmountAsset, 'evidence'); }); await pause(); await pause();
    assert(await js(() => document.querySelector('#rb-refresh-workspace').textContent.includes('重试识别') && document.querySelector('[data-evidence-difference="supplement"]').textContent.includes('待核对后计算') && document.querySelector('#rb-amount-total').textContent.includes('报销总额 ¥22.34')), 'Screenshot pending state hid retry or was mistaken for a final difference/reimbursement pending amount');
    await js(() => { const input = document.querySelector('#rb-evidence-amount-review input'); input.value = '40'; input.dispatchEvent(new Event('input')); document.querySelector('#rb-evidence-amount-review [data-amount-save]').click(); }); await pause();
    await js(() => window.markAmountPending(window.pendingAsset, 'invoice', 2)); await pause(); await pause();
    assert(await js(() => document.querySelector('[data-evidence-difference="supplement"]').textContent.includes('待核对后计算') && document.querySelector('#rb-amount-total').textContent.includes('待核对 1')), 'Unconfirmed supplement invoice amount produced a supposedly complete difference');
    await js(() => { const row = document.querySelector(`#rb-amount-review [data-amount-asset="${window.pendingAsset}"][data-amount-page="2"]`); row.querySelector('input').value = '0'; row.querySelector('input').dispatchEvent(new Event('input')); row.querySelector('[data-amount-save]').click(); }); await pause();
    await click('#rb-evidence-amount-review [data-amount-exclude]');
    assert(await js(() => window.amountRequests.at(-1).purpose === 'evidence' && window.amountRequests.at(-1).excluded === true && document.querySelector('#rb-evidence-amount-review [data-amount-save]').textContent === '恢复参考金额' && document.querySelector('#rb-evidence-amount-review [data-amount-exclude]').textContent === '已忽略' && document.querySelector('#rb-amount-total').textContent.includes('22.34') && document.querySelector('[data-evidence-difference="supplement"]').textContent.includes('0.00 元')), 'Ignoring a screenshot amount used invoice wording or changed reimbursement totals');
    await js(() => { const input = document.querySelector('#rb-evidence-amount-review input'); input.value = '0'; input.dispatchEvent(new Event('input')); document.querySelector('#rb-evidence-amount-review [data-amount-save]').click(); }); await pause();
    assert(await js(() => window.amountRequests.at(-1).purpose === 'evidence' && window.amountRequests.at(-1).amount === '0.00' && !window.amountRequests.at(-1).excluded && document.querySelector('#rb-evidence-amount-total').textContent.includes('0.00 元')), 'Zero screenshot reference could not be restored');
    await js(() => { const row = document.querySelector(`#rb-amount-review [data-amount-asset="${window.pendingAsset}"][data-amount-page="1"]`); row.querySelector('input').value = '88.88'; row.querySelector('input').dispatchEvent(new Event('input')); window.changeInvoicePurpose(window.pendingAsset, 'evidence'); }); await pause(); await pause();
    assert(await js(() => document.querySelector(`#rb-evidence-amount-review [data-amount-asset="${window.pendingAsset}"][data-amount-page="1"] input`).value !== '88.88'), 'An invoice draft leaked into screenshot reference amounts');
    await js(() => { const input = document.querySelector(`#rb-evidence-amount-review [data-amount-asset="${window.pendingAsset}"][data-amount-page="1"] input`); input.value = '99.99'; input.dispatchEvent(new Event('input')); window.changeInvoicePurpose(window.pendingAsset, 'invoice'); }); await pause(); await pause();
    assert(await js(() => document.querySelector(`#rb-amount-review [data-amount-asset="${window.pendingAsset}"][data-amount-page="1"] input`).value === '88.88'), 'Screenshot draft overwrote the invoice draft for the same asset and page');
    await js(() => { const input = document.querySelector(`#rb-amount-review [data-amount-asset="${window.pendingAsset}"][data-amount-page="1"] input`); input.value = '12.34'; input.dispatchEvent(new Event('input')); const evidenceInput = document.querySelector('#rb-evidence-amount-review input'); evidenceInput.value = '75'; evidenceInput.dispatchEvent(new Event('input')); window.failEvidenceAmount = true; document.querySelector('#rb-evidence-amount-review [data-amount-save]').click(); }); await pause();
    assert(await js(() => document.querySelector('#rb-notice').textContent.includes('参考金额保存失败') && document.querySelector('#rb-evidence-amount-review input').value === '75' && document.querySelector('#rb-amount-total').textContent.includes('22.34')), 'Reference save failure lost the draft or changed invoice total');
    await click('#rb-evidence-amount-review [data-amount-save]');
    assert(await js(() => document.querySelector('#rb-evidence-amount-total').textContent.includes('75.00 元') && document.querySelector('[data-evidence-difference="supplement"]').textContent.includes('62.66 元') && document.querySelector('#rb-notice').textContent.includes('不计入报销总额')), 'Reference amount retry or supplement shortfall calculation failed');
    await js(() => document.querySelector('#rb-evidence-amount-review').scrollIntoView({ block: 'start' })); await screenshot('evidence-amount-review');
    checks.push('Screenshot reference amounts stay separate from reimbursement totals, support pending/manual/ignore/zero, isolate drafts and calculate confirmed supplement shortfalls');

    await click('#rb-add-itinerary');
    assert(await js(() => { window.itineraryPdfId = window.lastAddedId; return window.chooseRequests.at(-1).purpose === 'itinerary' && !Object.hasOwn(window.chooseRequests.at(-1), 'category') && document.querySelector('#rb-itinerary [data-file-id]') && document.querySelector('#rb-amount-total').textContent.includes('22.34') && !document.querySelector(`[data-amount-asset="${window.itineraryPdfId}"]`); }), 'Itinerary PDF did not import independently or was included in amounts');
    await js(() => {
      window.nextFileExt = 'png'; const data = new DataTransfer(); data.items.add(new File(['fixture'], '打车行程截图.png', { type: 'image/png' }));
      document.querySelector('#rb-itinerary').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }); await pause();
    assert(await js(() => { window.itineraryImageId = window.lastAddedId; return window.globalDrops === 0 && window.dropRequests.at(-1).purpose === 'itinerary' && !Object.hasOwn(window.dropRequests.at(-1), 'category') && document.querySelectorAll('#rb-itinerary [data-file-id]').length === 2 && !document.querySelector('[data-artifact="itineraryPdf"] button').disabled && !document.querySelector(`[data-amount-asset="${window.itineraryImageId}"]`) && document.querySelector('#rb-evidence-amount-total').textContent.includes('75.00 元'); }), 'Itinerary image drop was routed twice, mixed with screenshots or did not enable automatic PDF');
    assert(await js(() => [...document.querySelectorAll('.rb-file-name,.rb-amount-info>.rb-preview-name')].every(item => item.tagName === 'BUTTON' && item.dataset.previewKey)), 'Not all reimbursement filenames are preview buttons');
    await js(() => {
      const row = document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="2"]`);
      row.querySelector('input').value = '66.66'; row.querySelector('input').dispatchEvent(new Event('input'));
      row.scrollIntoView({ block: 'center' }); window.previewScroll = document.querySelector('#rb-content').scrollTop;
      row.querySelector('.rb-preview-name').click();
    }); await pause();
    assert(await js(() => window.MosaicReimbursementPreview.isOpen() && window.previewRequests.at(-1).assetId === window.pendingAsset && window.previewRequests.at(-1).pageNumber === 2 && document.querySelector('#rb-preview-image').complete && document.querySelector('#rb-preview-image').naturalWidth > 0), 'Amount filename did not load the corresponding PDF page');
    await click('#rb-preview-previous');
    assert(await js(() => window.previewRequests.at(-1).pageNumber === 1), 'PDF previous page was not requested');
    await click('#rb-preview-next'); await click('#rb-preview-zoom');
    await screenshot('filename-pdf-preview');
    await js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert(await js(() => !window.MosaicReimbursementPreview.isOpen() && window.shituReimbursements.isOpen() && document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="2"] input`).value === '66.66' && Math.abs(document.querySelector('#rb-content').scrollTop - window.previewScroll) < 2 && document.activeElement.dataset.previewKey === `amount:invoice:${window.pendingAsset}:2`), 'Closing preview lost amount draft, scroll, focus or closed the entire workspace');
    await js(() => { const row = document.querySelector(`[data-amount-asset="${window.pendingAsset}"][data-amount-page="2"]`); row.querySelector('input').value = '0'; row.querySelector('input').dispatchEvent(new Event('input')); });
    await click('#rb-evidence-amount-review .rb-preview-name');
    assert(await js(() => window.previewRequests.at(-1).assetId === window.evidenceAmountAsset && window.previewRequests.at(-1).pageNumber === 1), 'Screenshot amount filename opened a different file');
    assert(await js(() => { const image = document.querySelector('#rb-preview-image').getBoundingClientRect(), stage = document.querySelector('.rb-preview-stage').getBoundingClientRect(); return image.width > 0 && image.height > 0 && image.left >= stage.left && image.right <= stage.right && image.top >= stage.top && image.bottom <= stage.bottom; }), 'Fit-to-window preview overflowed its viewport');
    await screenshot('filename-screenshot-preview'); await click('#rb-preview-close');
    await click('#rb-itinerary .rb-file-name');
    assert(await js(() => window.previewRequests.at(-1).assetId === window.itineraryPdfId), 'Itinerary filename opened a different file');
    await click('#rb-preview-close');
    await click('[data-category="membership"] .rb-file-name');
    assert(await js(() => window.MosaicReimbursementPreview.isOpen() && !window.sourceOpenRequests.length && !document.querySelector('#rb-preview-open-source').disabled), 'Office attachment opened externally without the explicit action');
    await click('#rb-preview-open-source');
    assert(await js(() => window.sourceOpenRequests.length === 1), 'Office preview did not expose the default-app action');
    await click('#rb-preview-close');
    await js(() => { window.failPreview = true; }); await click('#rb-itinerary .rb-file-name');
    assert(await js(() => document.querySelector('#rb-preview-status').textContent.includes('预览读取失败')), 'Preview read failure was not displayed');
    await click('#rb-preview-retry');
    assert(await js(() => document.querySelector('#rb-preview-image').naturalWidth > 0), 'Failed preview could not be retried');
    await click('#rb-preview-close');
    await js(() => { window.delayPreview = true; }); await click('#rb-itinerary .rb-file-name');
    await click('#rb-preview-close'); await js(() => window.completePreview()); await pause();
    assert(await js(() => !window.MosaicReimbursementPreview.isOpen() && !document.querySelector('#rb-preview-image').getAttribute('src')), 'Late preview response reopened a closed preview');
    checks.push('All filenames preview in-place; PDF page navigation, screenshot and itinerary previews, Office fallback, retry, late-response cancellation and draft/scroll/focus preservation');
    await click('[data-artifact="itineraryPdf"] button'); await click('#rb-preview-close'); await click('[data-artifact="itineraryPdf"] .rb-output-actions button:last-child');
    assert(await js(() => window.previewRequests.at(-1).assetId === 'itinerary-pdf' && window.exportRequests.at(-1).kind === 'itineraryPdf'), 'Itinerary preview/export uses another artifact');
    await js(() => window.markItineraryStale()); await pause();
    assert(await js(() => [...document.querySelectorAll('[data-artifact="itineraryPdf"] button')].every(button => button.disabled) && document.querySelector('[data-artifact="itineraryPdf"]').textContent.includes('行程单已变化') && !document.querySelector('#rb-export-all').disabled), 'Stale itinerary enabled old PDF actions or blocked automatic export-all');
    await click('#rb-export-all');
    assert(await js(() => document.querySelector('#rb-notice').textContent.includes('已导出 5 个文件') && document.querySelector('#rb-notice').textContent.includes('独立报销目录') && !document.querySelector('[data-artifact="itineraryPdf"] button').disabled && document.querySelector('#rb-amount-total').textContent.includes('22.34')), 'Export-all did not refresh generated artifacts or changed reimbursement amounts');
    window.setSize(1000, 720);
    await js(() => document.querySelector('#rb-itinerary').scrollIntoView({ block: 'center' })); await screenshot('itinerary-small');
    assert(await js(() => { const section = document.querySelector('#rb-itinerary').getBoundingClientRect(); return section.left >= 0 && section.right <= innerWidth && [...document.querySelectorAll('#rb-itinerary button')].every(button => button.getBoundingClientRect().right <= innerWidth); }), 'Itinerary controls overflow the small window');
    await js(() => document.querySelector('#rb-export-all').scrollIntoView({ block: 'center' })); await screenshot('export-all-small');
    window.setSize(1440, 900);
    await js(() => { document.querySelector(`[data-remove-file="${window.itineraryPdfId}"]`).click(); document.querySelector(`[data-cancel-remove-file="${window.itineraryPdfId}"]`).click(); }); await pause();
    assert(await js(() => document.querySelectorAll('#rb-itinerary [data-file-id]').length === 2), 'Cancelling itinerary deletion removed a file');
    await js(() => { document.querySelector(`[data-remove-file="${window.itineraryPdfId}"]`).click(); document.querySelector(`[data-confirm-remove-file="${window.itineraryPdfId}"]`).click(); }); await pause();
    assert(await js(() => window.removeRequests.at(-1).purpose === 'itinerary' && window.removeRequests.at(-1).category === 'itinerary' && document.querySelectorAll('#rb-itinerary [data-file-id]').length === 1), 'Itinerary removal used the invoice category path');
    await js(() => { document.querySelector(`[data-remove-file="${window.itineraryImageId}"]`).click(); document.querySelector(`[data-confirm-remove-file="${window.itineraryImageId}"]`).click(); }); await pause();
    assert(await js(() => !document.querySelector('#rb-itinerary [data-file-id]') && document.querySelector('[data-artifact="itineraryPdf"] button').disabled && document.querySelector('[data-artifact="itineraryPdf"]').textContent.includes('待添加打车行程单') && !document.querySelector('#rb-export-all').disabled), 'Empty itinerary did not clear its PDF or disabled export-all');
    checks.push('Independent image/PDF itinerary import, safe deletion and stale PDF handling; export-all supports empty optionals, cancellation, errors and refreshed five-artifact bundles');

    await js(() => window.emitState('generating', '正在更新补票截图')); await pause();
    assert(await js(() => [...document.querySelectorAll('.rb-output-card button,[data-remove-file],#rb-export-all,#rb-add-itinerary')].every(button => button.disabled) && document.querySelector('#rb-refresh-workspace').disabled), 'Stale artifacts, deletion, export-all or itinerary import enabled during generation');
    await click('#rb-cancel-processing');
    assert(await js(() => window.cancelRequests.at(-1).folderId === 'case-1'), 'Cancel current processing did not target workspace');
    await js(() => window.emitState('idle', '已更新生成文件')); await pause();
    assert(await js(() => !document.querySelector('[data-artifact="form"] button').disabled), 'Generation completion did not refresh ready artifacts');
    await js(() => { window.getCountBeforeForeign = window.getCount; window.emitForeignEvent(); }); await pause();
    assert(await js(() => window.getCount === window.getCountBeforeForeign), 'Unrelated folder event refreshed current workspace');
    checks.push('Generation states disable stale artifacts and ignore unrelated folder events');

    await js(() => { window.beforeProfileRefresh = window.refreshRequests.length; });
    await click('.rb-workspace-bar .rb-secondary');
    await js(() => { document.querySelector('#rb-profile-bankName').value = '更新后的测试开户行'; document.querySelector('#rb-profile-form').requestSubmit(); }); await pause();
    assert(await js(() => document.querySelector('.rb-workspace-bar').textContent.includes('更新后的测试开户行') && window.refreshRequests.length === window.beforeProfileRefresh + 1), 'Profile save did not refresh current application workbook');
    await click('.rb-workspace-footer button');
    assert(await js(() => window.refreshRequests.length === window.beforeProfileRefresh + 2), 'Manual refresh did not regenerate outputs');
    window.setSize(1000, 720); await screenshot('workspace-small');
    assert(await js(() => { const content = document.querySelector('#rb-content'); return content.getBoundingClientRect().right <= innerWidth && content.scrollHeight >= content.clientHeight && [...document.querySelectorAll('.rb-category')].every(card => card.getBoundingClientRect().right <= innerWidth); }), 'Small workspace cannot scroll to outputs');
    await js(() => { const content = document.querySelector('#rb-content'); content.scrollTop = content.scrollHeight; }); await screenshot('merged-invoices-small');
    assert(await js(() => { const card = document.querySelector('[data-artifact="invoicePdf"]').getBoundingClientRect(); return card.left >= 0 && card.right <= innerWidth && document.querySelector('#rb-merge-invoices').getBoundingClientRect().bottom <= innerHeight; }), 'Merged invoice controls inaccessible in small window');
    await js(() => document.querySelector('#rb-evidence-amount-review').scrollIntoView({ block: 'start' })); await screenshot('evidence-amount-review-small');
    assert(await js(() => { const section = document.querySelector('#rb-evidence-amount-review'), bounds = section.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth && [...section.querySelectorAll('input,button')].every(item => { const rect = item.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; }); }), 'Screenshot reference controls overflow the small window');
    await js(() => document.querySelector('[data-evidence-totals="supplement"]').scrollIntoView({ block: 'center' })); await screenshot('supplement-reference-small');
    checks.push('Profile edits regenerate workbook and small layout keeps categories accessible');

    await js(() => { window.nextFileName = '这是一份用于检查窄窗口文件名不会挤出删除按钮的非常非常长的发票附件_<img src=x onerror=alert(1)>.pdf'; });
    await click('[data-category="travel"] > .rb-text-button');
    assert(await js(() => {
      window.removalAsset = window.lastAddedId;
      window.beforeRemovalRequests = window.removeRequests.length;
      window.evidenceAsset = document.querySelector('[data-purpose="evidence"] .rb-file-row').dataset.fileId;
      const rows = [document.querySelector(`[data-file-id="${window.removalAsset}"]`), document.querySelector(`[data-file-id="${window.pendingAsset}"]`), document.querySelector(`[data-file-id="${window.evidenceAsset}"]`)];
      return rows.every(row => { const button = row.querySelector('[data-remove-file]'); return button && button.textContent === '删除' && !button.disabled && button.title.includes(row.querySelector('.rb-file-name').textContent) && button.getAttribute('aria-label') === button.title; }) && !document.querySelector('.rb-categories img');
    }), 'Ordinary invoices, supplement invoices or evidence lack always-visible safe named deletion buttons');
    await js(() => document.querySelector(`[data-remove-file="${window.removalAsset}"]`).click()); await pause();
    assert(await js(() => document.querySelector(`[data-file-id="${window.removalAsset}"]`).textContent.includes('移到回收站，可恢复')), 'Deletion confirmation omits recoverability');
    await js(() => {
      const row = document.querySelector(`[data-file-id="${window.removalAsset}"]`); row.scrollIntoView({ block: 'center' });
      const parent = row.closest('.rb-category').getBoundingClientRect();
      window.removalFits = [...row.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= parent.left && rect.right <= parent.right; });
    }); await screenshot('delete-confirm-small');
    assert(await js(() => window.removalFits), 'Long filename pushed deletion controls outside the small category card');
    await js(() => document.querySelector(`[data-cancel-remove-file="${window.removalAsset}"]`).click()); await pause();
    assert(await js(() => window.removeRequests.length === window.beforeRemovalRequests && !document.querySelector('[data-confirm-remove-file]') && document.querySelector(`[data-file-id="${window.removalAsset}"]`)), 'Cancel called removal API or removed file');
    await js(() => { document.querySelector(`[data-remove-file="${window.removalAsset}"]`).click(); window.failRemove = true; document.querySelector(`[data-confirm-remove-file="${window.removalAsset}"]`).click(); }); await pause();
    assert(await js(() => document.querySelector(`[data-file-id="${window.removalAsset}"]`) && document.querySelector('#rb-notice').classList.contains('rb-error') && document.querySelector('#rb-notice').textContent.includes('文件删除失败')), 'Failed removal hid the existing file or did not show the error');
    await js(() => { window.delayRemove = true; const confirm = document.querySelector(`[data-confirm-remove-file="${window.removalAsset}"]`); confirm.click(); confirm.click(); }); await pause();
    assert(await js(() => window.removeRequests.length === window.beforeRemovalRequests + 2 && [...document.querySelectorAll('[data-remove-file],[data-confirm-remove-file],[data-cancel-remove-file]')].every(button => button.disabled)), 'Pending deletion allowed duplicate calls or another file action');
    await js(() => { window.completeRemove(); window.delayRemove = false; }); await pause();
    assert(await js(() => {
      const request = window.removeRequests.at(-1);
      return request.assetId === window.removalAsset && request.category === 'travel' && request.folderId === 'case-1' && !document.querySelector(`[data-file-id="${window.removalAsset}"]`) && !document.querySelector(`[data-amount-asset="${window.removalAsset}"]`) && document.querySelector('[data-category="travel"] .rb-count').textContent === '1 个文件' && document.querySelector('#rb-amount-total').textContent.includes('22.34') && document.querySelector('[data-invoice-action="open"]').disabled && document.querySelector('#rb-notice').textContent.includes('已移到回收站');
    }), 'Successful removal did not synchronize file list, count, amount or PDF stale state');
    await js(() => { window.restoreRemovedAsset = window.removalAsset; });
    await click('[data-category="travel"] > .rb-text-button');
    assert(await js(() => {
      const notice = document.querySelector('#rb-notice');
      return !notice.classList.contains('rb-error') && notice.textContent.includes('已恢复 1 个文件到当前分类') && !notice.textContent.includes('0 个已导入') && document.querySelector(`[data-file-id="${window.removalAsset}"]`) && document.querySelector(`[data-amount-asset="${window.removalAsset}"]`) && document.querySelector('[data-category="travel"] .rb-count').textContent === '2 个文件' && document.querySelector('#rb-amount-total').textContent.includes('32.34');
    }), 'Reimported trash was not reported as restored or did not restore the file and its amount');
    await js(() => { document.querySelector(`[data-remove-file="${window.removalAsset}"]`).click(); document.querySelector(`[data-confirm-remove-file="${window.removalAsset}"]`).click(); }); await pause();
    checks.push('Reimported trash reports restoration and updates amounts, while ordinary duplicates remain explicit');
    await js(() => { window.removeSyncError = '申请表被占用，请重试更新'; document.querySelector(`[data-remove-file="${window.pendingAsset}"]`).click(); document.querySelector(`[data-confirm-remove-file="${window.pendingAsset}"]`).click(); }); await pause();
    assert(await js(() => !document.querySelector(`[data-file-id="${window.pendingAsset}"]`) && !document.querySelector(`[data-amount-asset="${window.pendingAsset}"]`) && document.querySelector('#rb-amount-total').textContent.includes('10.00') && document.querySelector('#rb-notice').classList.contains('rb-error') && document.querySelector('#rb-notice').textContent.includes('已移到回收站，但报销表同步失败') && document.querySelector('#rb-notice').textContent.includes('申请表被占用')), 'Partial sync failure incorrectly claimed deletion failed or left stale amounts');
    await js(() => { document.querySelector(`[data-remove-file="${window.evidenceAsset}"]`).click(); document.querySelector(`[data-confirm-remove-file="${window.evidenceAsset}"]`).click(); }); await pause();
    assert(await js(() => !document.querySelector(`[data-file-id="${window.evidenceAsset}"]`) && !document.querySelector('#rb-evidence-amount-review') && !document.querySelector('[data-evidence-totals]') && document.querySelector('[data-artifact="supplementPdf"] button').disabled && document.querySelector('[data-artifact="supplementPdf"]').textContent.includes('待添加购买截图')), 'Evidence removal did not clear its reference section, difference or screenshot PDF');
    checks.push('Recoverable deletion in all three file areas handles cancel, failure, double clicks, amount updates and partial sync failure');

    await click('[data-category="equipment"] > .rb-text-button');
    await js(() => { window.staleRemovalAsset = window.lastAddedId; window.delayRemove = true; document.querySelector(`[data-remove-file="${window.staleRemovalAsset}"]`).click(); document.querySelector(`[data-confirm-remove-file="${window.staleRemovalAsset}"]`).click(); }); await pause();
    await js(async () => window.shituReimbursements.open({ folderId: 'case-2', libraryRoot: 'C:\\other-library' }));
    await js(() => { window.completeRemove(); window.delayRemove = false; }); await pause();
    assert(await js(() => document.querySelector('#rb-title').textContent === '另一个报销资料夹' && document.querySelectorAll('.rb-file-row').length === 0 && document.querySelector('#rb-notice').hidden && !document.querySelector('#rb-manage-categories').disabled), 'Old deletion completion changed a newly opened folder or left it busy');
    await js(async () => window.shituReimbursements.open({ folderId: 'case-1', libraryRoot: 'C:\\fixture-library' }));
    assert(await js(() => !document.querySelector(`[data-file-id="${window.staleRemovalAsset}"]`) && document.querySelector('[data-category="travel"] .rb-count').textContent === '1 个文件'), 'Returning to original folder did not load completed deletion');
    checks.push('Delayed deletion cannot overwrite a different workspace');

    await js(async () => {
      window.draftAsset = document.querySelector('[data-category="travel"] [data-file-id]').dataset.fileId;
      const input = document.querySelector(`[data-amount-asset="${window.draftAsset}"] input`); input.value = '98.76'; input.dispatchEvent(new Event('input'));
      window.beforeExternalReads = window.getCount; window.beforeExternalWrites = [window.refreshRequests.length, window.amountRequests.length, window.chooseRequests.length, window.dropRequests.length].join(',');
      const imported = await window.shitu.importPaths(['C:\\fixtures\\外部分类文件夹发票.pdf'], { folderId: 'folder-equipment' }); window.externalAsset = imported.report.assetIds[0];
      for (let n = 0; n < 4; n++) window.emitLibraryChanged();
    }); await pause(); await pause();
    assert(await js(() => document.querySelector(`[data-file-id="${window.externalAsset}"]`)?.closest('[data-category]').dataset.category === 'equipment' && document.querySelector(`[data-amount-asset="${window.externalAsset}"]`) && document.querySelector('#rb-amount-total').textContent.includes('20.00') && document.querySelector(`[data-amount-asset="${window.draftAsset}"] input`).value === '98.76'), 'External folder import failed to refresh invoice rows and totals or erased an unsaved amount');
    assert(await js(() => window.getCount === window.beforeExternalReads + 1 && [window.refreshRequests.length, window.amountRequests.length, window.chooseRequests.length, window.dropRequests.length].join(',') === window.beforeExternalWrites), 'Library events did not debounce to a read-only refresh');
    await js(async () => { document.querySelector(`[data-remove-file="${window.externalAsset}"]`).click(); await window.shitu.setTrash([window.externalAsset], true); }); await pause(); await pause();
    assert(await js(() => !document.querySelector(`[data-file-id="${window.externalAsset}"]`) && !document.querySelector(`[data-amount-asset="${window.externalAsset}"]`) && !document.querySelector('[data-confirm-remove-file]') && document.querySelector('#rb-amount-total').textContent.includes('10.00')), 'External trash left stale file/amount rows or deletion confirmation');
    await js(async () => window.shitu.setTrash([window.externalAsset], false)); await pause(); await pause();
    assert(await js(() => document.querySelector(`[data-file-id="${window.externalAsset}"]`)?.closest('[data-category]').dataset.category === 'equipment' && document.querySelector(`[data-amount-asset="${window.externalAsset}"]`) && document.querySelector('#rb-amount-total').textContent.includes('20.00')), 'External restore did not restore the open workspace invoice');
    await js(async () => window.shitu.moveAssetsToFolder([window.externalAsset], 'folder-membership')); await pause(); await pause();
    assert(await js(() => document.querySelector(`[data-file-id="${window.externalAsset}"]`)?.closest('[data-category]').dataset.category === 'membership' && document.querySelector('[data-category="equipment"] .rb-count').textContent === '0 个文件' && document.querySelector(`[data-amount-asset="${window.draftAsset}"] input`).value === '98.76'), 'External category move failed to refresh or erased an unsaved amount');
    await js(() => { window.delayInvoiceMerge = true; }); await click('#rb-merge-invoices');
    await js(async () => { window.beforeBusyReads = window.getCount; const imported = await window.shitu.importPaths(['C:\\fixtures\\忙碌时外部发票.pdf'], { folderId: 'folder-equipment' }); window.busyExternalAsset = imported.report.assetIds[0]; }); await pause(); await pause();
    assert(await js(() => window.getCount === window.beforeBusyReads), 'Library change performed a background read during a workspace operation');
    await js(() => { window.completeInvoiceMerge(); window.delayInvoiceMerge = false; }); await pause(); await pause();
    assert(await js(() => window.getCount === window.beforeBusyReads + 1 && document.querySelector(`[data-file-id="${window.busyExternalAsset}"]`)), 'Busy library change was dropped instead of refreshing on idle');
    await click('#rb-manage-categories');
    await js(async () => { const input = document.querySelector('[data-category-key="equipment"] input'); input.value = '分类名称草稿'; input.dispatchEvent(new Event('input')); window.beforeEditorReads = window.getCount; const imported = await window.shitu.importPaths(['C:\\fixtures\\编辑分类时外部发票.pdf'], { folderId: 'folder-equipment' }); window.editorExternalAsset = imported.report.assetIds[0]; }); await pause(); await pause();
    assert(await js(() => window.getCount === window.beforeEditorReads && document.querySelector('[data-category-key="equipment"] input').value === '分类名称草稿'), 'Library event read over or replaced an active category draft');
    await click('#rb-cancel-categories'); await pause();
    assert(await js(() => window.getCount === window.beforeEditorReads + 1 && document.querySelector(`[data-file-id="${window.editorExternalAsset}"]`)), 'Returning from editor missed its pending library refresh');
    await js(async () => window.shitu.setTrash([window.externalAsset, window.busyExternalAsset, window.editorExternalAsset], true)); await pause(); await pause();
    assert(await js(() => document.querySelector('[data-category="travel"] .rb-count').textContent === '1 个文件' && document.querySelector('[data-category="equipment"] .rb-count').textContent === '0 个文件' && document.querySelector('#rb-amount-total').textContent.includes('10.00')), 'External invoice cleanup did not refresh totals');
    await js(() => { window.delayNextGet = true; window.emitLibraryChanged(); }); await pause();
    assert(await js(() => typeof window.completeGet === 'function'), 'Background read was not started');
    await js(async () => window.shituReimbursements.open({ folderId: 'case-2', libraryRoot: 'C:\\other-library' }));
    await js(() => window.completeGet()); await pause();
    assert(await js(() => document.querySelector('#rb-title').textContent === '另一个报销资料夹' && document.querySelectorAll('.rb-file-row').length === 0), 'Stale background response overwrote another workspace');
    await js(async () => window.shituReimbursements.open({ folderId: 'case-1', libraryRoot: 'C:\\fixture-library' }));
    checks.push('Library import, trash, restore and moves refresh in place without writes, preserve drafts and defer busy/editor events');
    await click('#rb-manage-categories');
    assert(await js(() => document.querySelector('#rb-new-category-type [value="supplement"]').disabled), 'Existing supplement role allowed a duplicate');
    await js(() => { const input = document.querySelector('[data-category-key="travel"] input'); input.value = '未保存名称'; input.dispatchEvent(new Event('input')); });
    await click('[data-category-key="travel"] [data-category-remove]');
    assert(await js(() => document.querySelector('#rb-category-removal-note').textContent.includes('1 个文件会移到报销根目录保留')), 'Deletion does not explain preservation of category files');
    await click('#rb-cancel-categories');
    assert(await js(() => window.categoryRequests.length === 0 && document.querySelector('[data-category="travel"] h3').textContent === '出行'), 'Cancel wrote changes or altered workspace');
    await click('#rb-manage-categories');
    await js(() => { const input = document.querySelector('[data-category-key="equipment"] input'); input.value = '器材'; input.dispatchEvent(new Event('input')); });
    await click('[data-category-key="equipment"] [data-category-move="-1"]');
    await click('[data-category-key="travel"] [data-category-remove]');
    await js(() => { const input = document.querySelector('[data-category-key="supplement"] input'); input.value = '购买截图'; input.dispatchEvent(new Event('input')); });
    for (const name of ['补票', '<img src=x onerror=alert(1)>']) {
      await js(name => { const input = document.querySelector('#rb-new-category-name'); input.value = name; input.dispatchEvent(new Event('input')); document.querySelector('#rb-add-category').click(); }, name);
    }
    assert(await js(() => !document.querySelector('#rb-category-editor img') && document.querySelectorAll('[data-category-key]').length === 6), 'Category text was interpreted as HTML or new rows missing');
    await screenshot('categories');
    await js(() => { window.delayCategorySave = true; });
    await click('#rb-save-categories');
    assert(await js(() => window.categoryRequests.length === 1 && document.querySelector('#rb-save-categories').disabled && document.querySelector('#rb-cancel-categories').disabled), 'Category save was not single and guarded while pending');
    await js(() => window.completeCategorySave()); await pause();
    assert(await js(() => {
      const categories = window.categoryRequests[0].categories;
      return categories.length === 6 && categories[0].key === 'equipment' && categories[0].name === '器材' && !categories.some(item => item.key === 'travel') && categories.filter(item => item.key === 'supplement').length === 1 && categories.filter(item => item.key.startsWith('custom-')).length === 2 && categories.every(item => Object.keys(item).length === 2);
    }), 'Saved full category array has wrong names, order, keys or fields');
    assert(await js(() => {
      const ordinary = [...document.querySelectorAll('.rb-category')].find(card => card.querySelector('h3').textContent === '补票');
      return ordinary.querySelector('button').textContent === '添加文件…' && document.querySelector('[data-category="supplement"] h3').textContent === '购买截图' && !document.querySelector('.rb-categories img');
    }), 'Supplement behavior used display name instead of stable role key, or XSS rendered');
    assert(await js(() => new Set([...document.querySelectorAll('[id]')].map(item => item.id)).size === document.querySelectorAll('[id]').length), 'Duplicate DOM ids after category editing');
    checks.push('Category add, rename, reorder, delete and cancel use one safe full-array save');
    await click('#rb-manage-categories');
    await js(() => { while (document.querySelector('[data-category-remove]')) document.querySelector('[data-category-remove]').click(); });
    await js(() => { window.delayCategorySave = false; }); await click('#rb-save-categories');
    assert(await js(() => window.categoryRequests.at(-1).categories.length === 0 && document.querySelector('.rb-category-empty button') && document.querySelector('[data-artifact="supplementPdf"]').textContent.includes('未设置补票专区')), 'Zero categories or deleted supplement state unsupported');
    assert(await js(() => document.querySelector('[data-artifact="invoicePdf"]') && document.querySelector('#rb-merge-invoices').disabled), 'Merged invoice card disappeared without supplement or sources');
    await click('.rb-category-empty button');
    await js(() => {
      for (let n = 1; n <= 30; n++) { const input = document.querySelector('#rb-new-category-name'); input.value = `分类 ${n}`; input.dispatchEvent(new Event('input')); document.querySelector('#rb-add-category').click(); }
    });
    assert(await js(() => document.querySelectorAll('[data-category-key]').length === 30 && document.querySelector('#rb-add-category').disabled && document.querySelector('#rb-new-category-name').disabled), '30-category limit not enforced');
    await js(() => { const inputs = document.querySelectorAll('[data-category-key] input'); inputs[1].value = inputs[0].value; inputs[1].dispatchEvent(new Event('input')); });
    assert(await js(() => document.querySelector('#rb-save-categories').disabled && document.querySelector('#rb-category-error').textContent.includes('不能重复')), 'Duplicate category names were accepted');
    await click('#rb-cancel-categories');
    assert(await js(() => window.categoryRequests.length === 2 && !document.querySelector('.rb-category')), 'Canceling 30-row draft changed zero-category workspace');
    checks.push('Zero categories, unique screenshot role, duplicate-name validation and 30-row limit');
    await click('#rb-manage-categories');
    await js(() => { const name = document.querySelector('#rb-new-category-name'); name.value = '已保存分类'; name.dispatchEvent(new Event('input')); document.querySelector('#rb-add-category').click(); window.failAfterCategoryCommit = true; window.beforeFailureGetCount = window.getCount; });
    await click('#rb-save-categories');
    assert(await js(() => document.querySelector('#rb-category-editor') && document.querySelector('[data-category-key] input').value === '已保存分类' && window.getCount > window.beforeFailureGetCount && document.querySelector('#rb-notice').textContent.includes('申请表生成失败')), 'Committed categories were not refreshed after generation failed or draft was discarded');
    await click('#rb-cancel-categories');
    assert(await js(() => document.querySelector('.rb-category h3').textContent === '已保存分类'), 'Cancel returned to stale categories after a committed save failed to generate workbook');
    checks.push('Generation failure refreshes committed categories while preserving editable draft');
    await click('#rb-close');
    assert(await js(() => !window.shituReimbursements.isOpen()), 'Workspace did not close');
    await js(() => { window.beforeClosedReads = window.getCount; window.emitLibraryChanged(); }); await pause(); await pause();
    assert(await js(() => window.getCount === window.beforeClosedReads), 'Closed workspace continued refreshing');
    assert(errors.length === 0, errors.join('\n'));
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: true, checks, errors }, null, 2)); window.destroy(); app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) await screenshot('failure').catch(() => {});
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: false, error: error.stack, checks, errors }, null, 2)); app.exit(1);
  }
}

function mockBridge() {
  let listener, libraryListener, profile = { applicant: '', companyName: '', accountName: '', bankName: '', accountNumber: '' };
  const workspace = { folderId: 'case-1', name: '11月报销', date: '2026-11-21', profile, state: 'idle', message: '', categories: [['travel', '出行'], ['equipment', '设备'], ['membership', '会员'], ['other', '其他'], ['supplement', '补票']].map(([key, name]) => ({ key, name, folderId: `folder-${key}`, count: 0, items: [] })), artifacts: { form: { assetId: 'form-1', name: '报销申请表.xlsx', ready: true }, supplementPdf: { assetId: null, name: '补票截图.pdf', ready: false }, invoicePdf: { assetId: null, name: '合并发票.pdf', ready: false }, supplementInvoicePdf: { assetId: null, name: '补票发票.pdf', ready: false } }, invoiceMerge: { imagesPerPage: 2, sourceCount: 0, unsupportedCount: 0, stale: false }, supplementInvoiceMerge: { imagesPerPage: 2, sourceCount: 0, unsupportedCount: 0, stale: false } };
  workspace.itinerary = { items: [], count: 0, stale: false, message: '' };
  workspace.artifacts.itineraryPdf = { assetId: null, name: '打车行程单.pdf', ready: false };
  const amountRecords = new Map(), removedFiles = new Map(); let nextAsset = 1;
  window.savedProfiles = []; window.chooseRequests = []; window.dropRequests = []; window.openRequests = []; window.exportRequests = []; window.exportAllRequests = []; window.refreshRequests = []; window.categoryRequests = []; window.mergeRequests = []; window.amountRequests = []; window.cancelRequests = []; window.removeRequests = []; window.getCount = 0; window.globalDrops = 0;
  window.previewRequests = []; window.previewCancelCount = 0; window.sourceOpenRequests = [];
  const format = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  const snapshot = () => {
    const allAmounts = [], allEvidenceAmounts = [];
    for (const category of workspace.categories) {
      category.invoiceItems = category.items.filter(item => item.purpose !== 'evidence'); category.evidenceItems = category.items.filter(item => item.purpose === 'evidence');
      const records = category.invoiceItems.flatMap(item => Array.from({ length: item.pageCount || 1 }, (_, index) => amountRecords.get(`${item.id}:${index + 1}`)).filter(Boolean)).map(item => ({ ...item, categoryKey: category.key }));
      const evidenceRecords = category.evidenceItems.flatMap(item => Array.from({ length: item.pageCount || 1 }, (_, index) => amountRecords.get(`evidence:${item.id}:${index + 1}`)).filter(Boolean)).map(item => ({ ...item, categoryKey: category.key, purpose: 'evidence' }));
      category.invoiceCount = records.length; category.pendingCount = records.filter(item => item.status === 'pending').length;
      category.amountCents = records.reduce((sum, item) => sum + (item.status !== 'excluded' && item.status !== 'pending' ? item.amountCents || 0 : 0), 0); category.amount = format(category.amountCents); allAmounts.push(...records);
      category.evidencePendingCount = evidenceRecords.filter(item => item.status === 'pending').length;
      category.evidenceAmountCents = evidenceRecords.reduce((sum, item) => sum + (item.status !== 'excluded' && item.status !== 'pending' ? item.amountCents || 0 : 0), 0); category.evidenceAmount = format(category.evidenceAmountCents); allEvidenceAmounts.push(...evidenceRecords);
    }
    for (const [key, selected] of [['invoiceMerge', workspace.categories.filter(category => category.key !== 'supplement').flatMap(category => category.items)], ['supplementInvoiceMerge', workspace.categories.find(category => category.key === 'supplement')?.invoiceItems || []]]) {
      workspace[key].sourceCount = selected.filter(item => ['png', 'jpg', 'pdf'].includes(item.ext)).length; workspace[key].unsupportedCount = selected.length - workspace[key].sourceCount;
    }
    const totalCents = workspace.categories.reduce((sum, category) => sum + category.amountCents, 0);
    workspace.amounts = { totalCents, totalAmount: format(totalCents), pendingCount: allAmounts.filter(item => item.status === 'pending').length, items: allAmounts };
    const evidenceCents = workspace.categories.reduce((sum, category) => sum + category.evidenceAmountCents, 0);
    workspace.evidenceAmounts = { totalCents: evidenceCents, totalAmount: format(evidenceCents), pendingCount: allEvidenceAmounts.filter(item => item.status === 'pending').length, items: allEvidenceAmounts };
    return structuredClone({ ...workspace, profile });
  };
  const add = request => {
    if (window.partialFailure) { window.partialFailure = false; return { snapshot: {}, workspace: snapshot(), report: { imported: 0, duplicates: 1, errors: [{ path: 'C:\\fixtures\\损坏文件.pdf', message: '无法读取文件' }] } }; }
    if (window.duplicateOnly) { window.duplicateOnly = false; return { snapshot: {}, workspace: snapshot(), report: { imported: 0, restored: 0, duplicates: 1, errors: [] } }; }
    const purpose = request.purpose || 'invoice', category = purpose === 'itinerary' ? workspace.itinerary : workspace.categories.find(item => item.key === request.category);
    if (window.restoreRemovedAsset) {
      const id = window.restoreRemovedAsset, removed = removedFiles.get(id); window.restoreRemovedAsset = null;
      category.items.push(removed.item); category.count = category.items.length;
      for (const [key, record] of removed.amounts) amountRecords.set(key, record);
      removedFiles.delete(id); window.lastAddedId = id;
      return { snapshot: {}, workspace: snapshot(), report: { imported: 0, restored: 1, restoredAssetIds: [id], duplicates: 0, errors: [] } };
    }
    const ext = window.nextFileExt || (purpose === 'evidence' ? 'png' : 'pdf'); window.nextFileExt = '';
    const name = window.nextFileName || request.paths?.[0]?.split('\\').at(-1) || `${purpose === 'itinerary' ? '打车行程单' : `${category.name}发票`}.${ext}`; window.nextFileName = '';
    const id = `asset-${nextAsset++}`, pageCount = window.nextPageCount || 1; window.nextPageCount = 0; window.lastAddedId = id;
    category.items.push({ id, name, ext, mediaType: ext === 'pdf' || ext === 'docx' ? 'document' : 'image', purpose, pageCount }); category.count++;
    if (purpose !== 'itinerary' && ['png', 'jpg', 'pdf'].includes(ext)) for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) amountRecords.set(`${purpose === 'evidence' ? 'evidence:' : ''}${id}:${pageNumber}`, { assetId: id, pageNumber, name, status: window.nextPending ? 'pending' : 'recognized', amountCents: window.nextPending ? null : 1000, amount: window.nextPending ? null : '10.00', detectedAmount: window.nextPending ? '12.34' : '10.00', confidence: window.nextPending ? 'low' : 'high', reason: window.nextPending ? '识别结果待核对' : purpose === 'evidence' ? '订单总额，仅供参考' : '价税合计', ...(purpose === 'evidence' ? { purpose } : {}) });
    window.nextPending = false;
    if (request.category === 'supplement' && purpose === 'evidence') { workspace.artifacts.supplementPdf.ready = true; workspace.artifacts.supplementPdf.assetId = 'pdf-1'; }
    if (purpose === 'itinerary') { workspace.artifacts.itineraryPdf.ready = true; workspace.artifacts.itineraryPdf.assetId = 'itinerary-pdf'; workspace.itinerary.stale = false; }
    return { snapshot: {}, workspace: snapshot(), report: { imported: 1, assetIds: [id], duplicates: 0, errors: [] } };
  };
  document.addEventListener('drop', () => { window.globalDrops++; });
  window.emitState = (state, message) => { workspace.state = state; workspace.message = message; listener({ folderId: 'case-1', libraryRoot: 'C:\\fixture-library', state, message }); };
  window.emitForeignEvent = () => listener({ folderId: 'other-case', libraryRoot: 'C:\\fixture-library', state: 'idle' });
  window.emitLibraryChanged = () => libraryListener?.();
  window.markAmountPending = (id, purpose, page = 1) => { Object.assign(amountRecords.get(`${purpose === 'evidence' ? 'evidence:' : ''}${id}:${page}`), { status: 'pending', amountCents: null, amount: null, reason: '识别结果待核对' }); window.emitLibraryChanged(); };
  window.changeInvoicePurpose = (id, purpose) => {
    const item = workspace.categories.flatMap(category => category.items).find(item => item.id === id); item.purpose = purpose;
    if (purpose === 'evidence') for (let page = 1; page <= (item.pageCount || 1); page++) amountRecords.set(`evidence:${id}:${page}`, { ...amountRecords.get(`${id}:${page}`), purpose });
    window.emitLibraryChanged();
  };
  window.markInvoiceStale = () => { workspace.invoiceMerge.stale = true; workspace.invoiceMerge.message = '发票已变化，请重新合并。'; window.emitState('idle', ''); };
  window.markItineraryStale = () => { workspace.itinerary.stale = true; workspace.itinerary.message = '行程单已变化，请刷新生成文件。'; window.emitState('idle', ''); };
  window.shitu = {
    reimbursementGetProfile: async () => structuredClone(profile),
    reimbursementSaveProfile: async value => { window.savedProfiles.push(value); profile = structuredClone(value); return structuredClone(value); },
    reimbursementGet: async request => { window.getCount++; const value = snapshot(); const result = request.folderId === workspace.folderId ? value : { ...value, folderId: request.folderId, name: '另一个报销资料夹', categories: [], amounts: { totalCents: 0, totalAmount: '0.00', pendingCount: 0, items: [] } }; if (window.delayNextGet) { window.delayNextGet = false; return new Promise(resolve => { window.completeGet = () => resolve(result); }); } return result; },
    reimbursementRefresh: async request => { window.refreshRequests.push(request); return snapshot(); },
    reimbursementSetAmount: async request => { window.amountRequests.push(request); if (request.purpose === 'evidence' && window.failEvidenceAmount) { window.failEvidenceAmount = false; throw new Error('参考金额保存失败，请重试'); } const record = amountRecords.get(`${request.purpose === 'evidence' ? 'evidence:' : ''}${request.assetId}:${request.pageNumber}`); Object.assign(record, request.excluded ? { status: 'excluded', amount: null, amountCents: null, reason: request.purpose === 'evidence' ? '已忽略参考金额' : '不计入报销' } : { status: 'manual', amount: request.amount, amountCents: window.MosaicInvoiceAmounts.parseAmount(request.amount), reason: request.purpose === 'evidence' ? '参考金额已核对' : '已手动核对' }); return { snapshot: {}, workspace: snapshot() }; },
    reimbursementCancel: async request => { window.cancelRequests.push(request); workspace.state = 'idle'; workspace.message = '处理已取消'; return { cancelled: true }; },
    reimbursementRemoveFile: async request => {
      window.removeRequests.push(structuredClone(request));
      const complete = () => {
        if (window.failRemove) { window.failRemove = false; throw new Error('文件删除失败，请重试'); }
        const category = request.purpose === 'itinerary' ? workspace.itinerary : workspace.categories.find(item => item.key === request.category);
        removedFiles.set(request.assetId, { category: request.purpose === 'itinerary' ? 'itinerary' : category.key, item: category.items.find(item => item.id === request.assetId), amounts: [...amountRecords.entries()].filter(([, record]) => record.assetId === request.assetId) });
        category.items = category.items.filter(item => item.id !== request.assetId); category.count = category.items.length;
        for (const [key, record] of amountRecords) if (record.assetId === request.assetId) amountRecords.delete(key);
        if (request.purpose === 'itinerary') { workspace.artifacts.itineraryPdf.ready = category.items.length > 0; workspace.itinerary.stale = false; workspace.itinerary.message = ''; }
        else if (request.category === 'supplement') {
          workspace.supplementInvoiceMerge.stale = true;
          workspace.artifacts.supplementPdf.ready = category.items.some(item => item.purpose === 'evidence');
        } else workspace.invoiceMerge.stale = true;
        const syncError = window.removeSyncError; window.removeSyncError = '';
        return { removed: true, snapshot: {}, workspace: snapshot(), ...(syncError ? { syncError } : {}) };
      };
      if (window.delayRemove) return new Promise((resolve, reject) => { window.completeRemove = () => { try { resolve(complete()); } catch (error) { reject(error); } }; });
      return complete();
    },
    reimbursementMergeInvoices: async request => { window.mergeRequests.push(request); if (window.failInvoiceMerge) { window.failInvoiceMerge = false; throw new Error('合并失败，请重试'); } const complete = () => { const kind = request.scope === 'supplement' ? 'supplementInvoicePdf' : 'invoicePdf', key = request.scope === 'supplement' ? 'supplementInvoiceMerge' : 'invoiceMerge'; workspace.artifacts[kind] = { assetId: 'invoice-merged', name: `${kind}.pdf`, ready: true }; workspace[key] = { ...workspace[key], imagesPerPage: request.imagesPerPage, stale: false, message: '' }; return { snapshot: {}, workspace: snapshot() }; }; if (window.delayInvoiceMerge) return new Promise(resolve => { window.completeInvoiceMerge = () => resolve(complete()); }); return complete(); },
    reimbursementSaveCategories: async request => {
      window.categoryRequests.push(structuredClone(request));
      const complete = () => { const prior = new Map(workspace.categories.map(item => [item.key, item])); workspace.categories = request.categories.map(item => ({ ...item, folderId: prior.get(item.key)?.folderId || `folder-${item.key}`, count: prior.get(item.key)?.count || 0, items: prior.get(item.key)?.items || [] })); if (!workspace.categories.some(item => item.key === 'supplement')) workspace.artifacts.supplementPdf.ready = false; return { snapshot: {}, workspace: snapshot() }; };
      if (window.delayCategorySave) return new Promise(resolve => { window.completeCategorySave = () => resolve(complete()); });
      const result = complete(); if (window.failAfterCategoryCommit) { window.failAfterCategoryCommit = false; throw new Error('申请表生成失败，请重试'); } return result;
    },
    reimbursementChooseImport: async request => { window.chooseRequests.push(request); return add(request); },
    reimbursementImport: async request => { window.dropRequests.push(request); return add(request); },
    reimbursementOpenArtifact: async request => { window.openRequests.push(request); return { opened: true }; },
    reimbursementPreview: async request => {
      window.previewRequests.push(structuredClone(request));
      const item = [...workspace.categories.flatMap(category => category.items), ...workspace.itinerary.items, ...Object.values(workspace.artifacts).map(artifact => ({ id: artifact.assetId, name: artifact.name, ext: artifact.name.endsWith('.xlsx') ? 'xlsx' : 'pdf', pageCount: 2 }))].find(item => item.id === request.assetId);
      if (!item) throw new Error('预览文件不存在');
      const result = { name: item.name, ext: item.ext, pageNumber: request.pageNumber || 1, pageCount: item.pageCount || 1 };
      if (window.failPreview) { window.failPreview = false; throw new Error('预览读取失败'); }
      if (window.delayPreview) { window.delayPreview = false; await new Promise(resolve => { window.completePreview = resolve; }); }
      if (['docx', 'xlsx'].includes(item.ext)) return { ...result, type: 'external' };
      const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 1300;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 900, 1300); ctx.fillStyle = '#222'; ctx.font = '32px sans-serif'; ctx.fillText('报销附件预览 · 本机测试', 65, 120); ctx.font = '25px sans-serif'; ctx.fillText(`第 ${result.pageNumber} 页 / 共 ${result.pageCount} 页`, 65, 200); ctx.fillText('金额与原始文件保持不变', 65, 275);
      return { ...result, type: 'image', url: canvas.toDataURL('image/png') };
    },
    reimbursementPreviewCancel: async () => { window.previewCancelCount++; return { cancelled: true }; },
    reimbursementOpenSource: async request => { window.sourceOpenRequests.push(structuredClone(request)); return { opened: true }; },
    reimbursementExport: async request => { window.exportRequests.push(request); return { saved: true, path: 'C:\\Exports\\补票截图.pdf' }; },
    reimbursementExportAll: async request => {
      window.exportAllRequests.push(request); const mode = window.nextExportAll; window.nextExportAll = '';
      if (mode === 'cancel') return { cancelled: true };
      if (mode === 'error') throw new Error('导出目录不可写，请重新选择');
      const complete = () => {
        for (const [key, kind] of [['invoiceMerge', 'invoicePdf'], ['supplementInvoiceMerge', 'supplementInvoicePdf']]) if (workspace[key].sourceCount) { workspace[key].stale = false; workspace.artifacts[kind].ready = true; }
        workspace.itinerary.stale = false; workspace.itinerary.message = '';
        return { saved: true, path: 'C:\\Exports\\独立报销目录', count: Object.values(workspace.artifacts).filter(item => item.ready).length };
      };
      if (mode === 'pending') return new Promise(resolve => { window.completeExportAll = () => resolve(complete()); });
      return complete();
    },
    importPaths: async (paths, options) => { const category = workspace.categories.find(item => item.folderId === options.folderId); const result = add({ paths, category: category.key }); window.emitLibraryChanged(); return result; },
    setTrash: async (ids, trashed) => { for (const id of ids) { if (trashed) { const category = workspace.categories.find(item => item.items.some(item => item.id === id)); await window.shitu.reimbursementRemoveFile({ folderId: workspace.folderId, category: category.key, assetId: id }); } else { const removed = removedFiles.get(id); window.restoreRemovedAsset = id; add({ category: removed.category }); } } window.emitLibraryChanged(); return snapshot(); },
    moveAssetsToFolder: async (ids, folderId) => { const destination = workspace.categories.find(item => item.folderId === folderId); for (const id of ids) { const source = workspace.categories.find(item => item.items.some(item => item.id === id)), item = source.items.find(item => item.id === id); source.items = source.items.filter(item => item.id !== id); source.count = source.items.length; destination.items.push(item); destination.count = destination.items.length; } window.emitLibraryChanged(); return snapshot(); },
    onReimbursementEvent: callback => { listener = callback; return () => {}; },
    onLibraryChanged: callback => { libraryListener = callback; return () => {}; },
    getFilePath: file => `C:\\fixtures\\${file.name}`
  };
}

async function main() {
  const tests = path.join(root, '.recovery', 'tests'); await fs.mkdir(tests, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tests, 'reimbursement-ui-')), html = path.join(directory, 'index.html');
  const file = name => pathToFileURL(path.join(root, 'src', name)).href;
  await fs.writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${file('styles.css')}"><link rel="stylesheet" href="${file('reimbursement-center.css')}"><link rel="stylesheet" href="${file('reimbursement-preview.css')}"></head><body><script>(${mockBridge.toString()})();</script><script src="${file('invoice-amounts.js')}"></script><script src="${file('reimbursement-center.js')}"></script><script src="${file('reimbursement-preview.js')}"></script></body></html>`);
  await fs.writeFile(path.join(directory, 'main.cjs'), `const electron=require('electron');const path=require('node:path');electron.app.setName('Mosaic reimbursement isolated smoke');electron.app.setPath('userData',path.join(__dirname,'profile'));electron.app.setPath('sessionData',path.join(__dirname,'sessions'));(${electronTest.toString()})(electron,${JSON.stringify({ directory, html })});setTimeout(()=>electron.app.exit(2),60000).unref();`);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'mosaic-reimbursement-smoke', main: 'main.cjs' }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => { const child = spawn(electronPath(), [directory], { cwd: root, env, windowsHide: true, stdio: 'ignore' }); const timer = setTimeout(() => { child.kill(); reject(new Error(`UI smoke timed out: ${directory}`)); }, 65000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8')); result.reportDirectory = directory; console.log(JSON.stringify(result, null, 2)); if (code !== 0 || !result.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
