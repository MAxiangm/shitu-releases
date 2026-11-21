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
    assert(await js(() => document.querySelectorAll('.rb-output-card').length === 4 && document.querySelector('#rb-merge-invoices').disabled && document.querySelector('#rb-merge-supplement-invoices').disabled), 'Empty merged-invoice PDF card missing or enabled');
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
    await click('[data-artifact="form"] button');
    await click('[data-artifact="supplementPdf"] button');
    assert(await js(() => window.openRequests.map(x => x.kind).join(',') === 'form,supplementPdf'), 'Wrong artifact open requests');
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
    await click('[data-invoice-action="open"]'); await click('[data-invoice-action="export"]');
    assert(await js(() => window.openRequests.at(-1).kind === 'invoicePdf' && window.exportRequests.at(-1).kind === 'invoicePdf'), 'Merged invoice preview/export use wrong artifact kind');
    await js(() => { const select = document.querySelector('#rb-invoice-per-page'); select.value = '2'; select.dispatchEvent(new Event('change')); });
    assert(await js(() => document.querySelector('[data-invoice-action="open"]').disabled && document.querySelector('[data-artifact="invoicePdf"]').textContent.includes('排版已更改')), 'Changed page density left old PDF enabled');
    await js(() => { window.delayInvoiceMerge = false; window.failInvoiceMerge = true; }); await click('#rb-merge-invoices');
    assert(await js(() => document.querySelector('#rb-notice').classList.contains('rb-error') && document.querySelector('#rb-notice').textContent.includes('合并失败')), 'Merge failure not shown');
    await click('#rb-merge-invoices');
    await js(() => window.markInvoiceStale()); await pause();
    assert(await js(() => document.querySelector('[data-invoice-action="open"]').disabled && document.querySelector('[data-invoice-action="export"]').disabled && document.querySelector('[data-artifact="invoicePdf"]').textContent.includes('发票已变化')), 'Backend stale state left old PDF enabled');
    await screenshot('merged-invoices');
    checks.push('Merged invoice PDF excludes supplement, reports unsupported files, guards layout/stale state and handles merge failures');
    assert(await js(() => document.querySelectorAll('[data-amount-asset]').length === 1 && document.querySelector('#rb-amount-total').textContent.includes('10.00')), 'Purchase screenshots were included in invoice amount rows or total');
    await js(() => { window.nextPending = true; window.nextPageCount = 2; });
    await click('[data-category="supplement"] [data-purpose="invoice"] .rb-text-button');
    assert(await js(() => {
      window.pendingAsset = window.lastAddedId;
      const total = document.querySelector('#rb-amount-total').textContent;
      return window.chooseRequests.at(-1).purpose === 'invoice' && total.includes('已识别小计') && total.includes('待核对 2') && !total.includes('报销总额') && document.querySelectorAll('[data-amount-asset]').length === 3;
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
    await click('[data-supplement-invoice-action="open"]'); await click('[data-supplement-invoice-action="export"]');
    assert(await js(() => window.mergeRequests.at(-1).scope === 'supplement' && window.mergeRequests.at(-1).imagesPerPage === 6 && window.openRequests.at(-1).kind === 'supplementInvoicePdf' && window.exportRequests.at(-1).kind === 'supplementInvoicePdf' && document.querySelector('#rb-invoice-per-page').value === '2'), 'Supplement invoice merge scope or independent layout/artifact wrong');
    assert(await js(() => new Set([...document.querySelectorAll('[id]')].map(item => item.id)).size === document.querySelectorAll('[id]').length), 'Invoice and supplement cards have duplicate IDs');
    await js(() => document.querySelector('#rb-amount-review').scrollIntoView({ block: 'start' })); await screenshot('amount-review');
    await js(() => { document.querySelector('#rb-content').scrollTop = 0; });
    checks.push('Pending subtotals, per-page amount review/exclusion/zero and independent supplement invoice merge');

    await js(() => window.emitState('generating', '正在更新补票截图')); await pause();
    assert(await js(() => [...document.querySelectorAll('.rb-output-card button,[data-remove-file]')].every(button => button.disabled) && document.querySelector('#rb-refresh-workspace').disabled), 'Stale artifacts, deletion or retry enabled during generation');
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
    checks.push('Profile edits regenerate workbook and small layout keeps categories accessible');

    await js(() => { window.nextFileName = '这是一份用于检查窄窗口文件名不会挤出删除按钮的非常非常长的发票附件_<img src=x onerror=alert(1)>.pdf'; });
    await click('[data-category="travel"] > .rb-text-button');
    assert(await js(() => {
      window.removalAsset = window.lastAddedId;
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
    assert(await js(() => window.removeRequests.length === 0 && !document.querySelector('[data-confirm-remove-file]') && document.querySelector(`[data-file-id="${window.removalAsset}"]`)), 'Cancel called removal API or removed file');
    await js(() => { document.querySelector(`[data-remove-file="${window.removalAsset}"]`).click(); window.failRemove = true; document.querySelector(`[data-confirm-remove-file="${window.removalAsset}"]`).click(); }); await pause();
    assert(await js(() => document.querySelector(`[data-file-id="${window.removalAsset}"]`) && document.querySelector('#rb-notice').classList.contains('rb-error') && document.querySelector('#rb-notice').textContent.includes('文件删除失败')), 'Failed removal hid the existing file or did not show the error');
    await js(() => { window.delayRemove = true; const confirm = document.querySelector(`[data-confirm-remove-file="${window.removalAsset}"]`); confirm.click(); confirm.click(); }); await pause();
    assert(await js(() => window.removeRequests.length === 2 && [...document.querySelectorAll('[data-remove-file],[data-confirm-remove-file],[data-cancel-remove-file]')].every(button => button.disabled)), 'Pending deletion allowed duplicate calls or another file action');
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
    assert(await js(() => !document.querySelector(`[data-file-id="${window.evidenceAsset}"]`) && document.querySelector('[data-artifact="supplementPdf"] button').disabled && document.querySelector('[data-artifact="supplementPdf"]').textContent.includes('待添加购买截图')), 'Evidence removal did not clear screenshot PDF');
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
  const amountRecords = new Map(), removedFiles = new Map(); let nextAsset = 1;
  window.savedProfiles = []; window.chooseRequests = []; window.dropRequests = []; window.openRequests = []; window.exportRequests = []; window.refreshRequests = []; window.categoryRequests = []; window.mergeRequests = []; window.amountRequests = []; window.cancelRequests = []; window.removeRequests = []; window.getCount = 0; window.globalDrops = 0;
  const format = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  const snapshot = () => {
    const allAmounts = [];
    for (const category of workspace.categories) {
      category.invoiceItems = category.items.filter(item => item.purpose !== 'evidence'); category.evidenceItems = category.items.filter(item => item.purpose === 'evidence');
      const records = category.invoiceItems.flatMap(item => Array.from({ length: item.pageCount || 1 }, (_, index) => amountRecords.get(`${item.id}:${index + 1}`)).filter(Boolean)).map(item => ({ ...item, categoryKey: category.key }));
      category.invoiceCount = records.length; category.pendingCount = records.filter(item => item.status === 'pending').length;
      category.amountCents = records.reduce((sum, item) => sum + (item.status !== 'excluded' && item.status !== 'pending' ? item.amountCents || 0 : 0), 0); category.amount = format(category.amountCents); allAmounts.push(...records);
    }
    for (const [key, selected] of [['invoiceMerge', workspace.categories.filter(category => category.key !== 'supplement').flatMap(category => category.items)], ['supplementInvoiceMerge', workspace.categories.find(category => category.key === 'supplement')?.invoiceItems || []]]) {
      workspace[key].sourceCount = selected.filter(item => ['png', 'jpg', 'pdf'].includes(item.ext)).length; workspace[key].unsupportedCount = selected.length - workspace[key].sourceCount;
    }
    const totalCents = workspace.categories.reduce((sum, category) => sum + category.amountCents, 0);
    workspace.amounts = { totalCents, totalAmount: format(totalCents), pendingCount: allAmounts.filter(item => item.status === 'pending').length, items: allAmounts };
    return structuredClone({ ...workspace, profile });
  };
  const add = request => {
    if (window.partialFailure) { window.partialFailure = false; return { snapshot: {}, workspace: snapshot(), report: { imported: 0, duplicates: 1, errors: [{ path: 'C:\\fixtures\\损坏文件.pdf', message: '无法读取文件' }] } }; }
    if (window.duplicateOnly) { window.duplicateOnly = false; return { snapshot: {}, workspace: snapshot(), report: { imported: 0, restored: 0, duplicates: 1, errors: [] } }; }
    const category = workspace.categories.find(item => item.key === request.category), purpose = request.purpose || 'invoice';
    if (window.restoreRemovedAsset) {
      const id = window.restoreRemovedAsset, removed = removedFiles.get(id); window.restoreRemovedAsset = null;
      category.items.push(removed.item); category.count = category.items.length;
      for (const [key, record] of removed.amounts) amountRecords.set(key, record);
      removedFiles.delete(id); window.lastAddedId = id;
      return { snapshot: {}, workspace: snapshot(), report: { imported: 0, restored: 1, restoredAssetIds: [id], duplicates: 0, errors: [] } };
    }
    const ext = window.nextFileExt || (purpose === 'evidence' ? 'png' : 'pdf'); window.nextFileExt = '';
    const name = window.nextFileName || request.paths?.[0]?.split('\\').at(-1) || `${category.name}发票.${ext}`; window.nextFileName = '';
    const id = `asset-${nextAsset++}`, pageCount = window.nextPageCount || 1; window.nextPageCount = 0; window.lastAddedId = id;
    category.items.push({ id, name, ext, mediaType: ext === 'pdf' || ext === 'docx' ? 'document' : 'image', purpose, pageCount }); category.count++;
    if (purpose !== 'evidence' && ['png', 'jpg', 'pdf'].includes(ext)) for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) amountRecords.set(`${id}:${pageNumber}`, { assetId: id, pageNumber, name: `${name} · 第 ${pageNumber} 页`, status: window.nextPending ? 'pending' : 'recognized', amountCents: window.nextPending ? null : 1000, amount: window.nextPending ? null : '10.00', detectedAmount: window.nextPending ? '12.34' : '10.00', confidence: window.nextPending ? 'low' : 'high', reason: window.nextPending ? '识别结果待核对' : '价税合计' });
    window.nextPending = false;
    if (request.category === 'supplement' && purpose === 'evidence') { workspace.artifacts.supplementPdf.ready = true; workspace.artifacts.supplementPdf.assetId = 'pdf-1'; }
    return { snapshot: {}, workspace: snapshot(), report: { imported: 1, assetIds: [id], duplicates: 0, errors: [] } };
  };
  document.addEventListener('drop', () => { window.globalDrops++; });
  window.emitState = (state, message) => { workspace.state = state; workspace.message = message; listener({ folderId: 'case-1', libraryRoot: 'C:\\fixture-library', state, message }); };
  window.emitForeignEvent = () => listener({ folderId: 'other-case', libraryRoot: 'C:\\fixture-library', state: 'idle' });
  window.emitLibraryChanged = () => libraryListener?.();
  window.markInvoiceStale = () => { workspace.invoiceMerge.stale = true; workspace.invoiceMerge.message = '发票已变化，请重新合并。'; window.emitState('idle', ''); };
  window.shitu = {
    reimbursementGetProfile: async () => structuredClone(profile),
    reimbursementSaveProfile: async value => { window.savedProfiles.push(value); profile = structuredClone(value); return structuredClone(value); },
    reimbursementGet: async request => { window.getCount++; const value = snapshot(); const result = request.folderId === workspace.folderId ? value : { ...value, folderId: request.folderId, name: '另一个报销资料夹', categories: [], amounts: { totalCents: 0, totalAmount: '0.00', pendingCount: 0, items: [] } }; if (window.delayNextGet) { window.delayNextGet = false; return new Promise(resolve => { window.completeGet = () => resolve(result); }); } return result; },
    reimbursementRefresh: async request => { window.refreshRequests.push(request); return snapshot(); },
    reimbursementSetAmount: async request => { window.amountRequests.push(request); const record = amountRecords.get(`${request.assetId}:${request.pageNumber}`); Object.assign(record, request.excluded ? { status: 'excluded', amount: null, amountCents: null } : { status: 'manual', amount: request.amount, amountCents: window.MosaicInvoiceAmounts.parseAmount(request.amount) }); return { snapshot: {}, workspace: snapshot() }; },
    reimbursementCancel: async request => { window.cancelRequests.push(request); workspace.state = 'idle'; workspace.message = '处理已取消'; return { cancelled: true }; },
    reimbursementRemoveFile: async request => {
      window.removeRequests.push(structuredClone(request));
      const complete = () => {
        if (window.failRemove) { window.failRemove = false; throw new Error('文件删除失败，请重试'); }
        const category = workspace.categories.find(item => item.key === request.category);
        removedFiles.set(request.assetId, { category: category.key, item: category.items.find(item => item.id === request.assetId), amounts: [...amountRecords.entries()].filter(([key]) => key.startsWith(`${request.assetId}:`)) });
        category.items = category.items.filter(item => item.id !== request.assetId); category.count = category.items.length;
        for (const key of amountRecords.keys()) if (key.startsWith(`${request.assetId}:`)) amountRecords.delete(key);
        if (request.category === 'supplement') {
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
    reimbursementExport: async request => { window.exportRequests.push(request); return { saved: true, path: 'C:\\Exports\\补票截图.pdf' }; },
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
  await fs.writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${file('styles.css')}"><link rel="stylesheet" href="${file('reimbursement-center.css')}"></head><body><script>(${mockBridge.toString()})();</script><script src="${file('invoice-amounts.js')}"></script><script src="${file('reimbursement-center.js')}"></script></body></html>`);
  await fs.writeFile(path.join(directory, 'main.cjs'), `const electron=require('electron');const path=require('node:path');electron.app.setName('Mosaic reimbursement isolated smoke');electron.app.setPath('userData',path.join(__dirname,'profile'));electron.app.setPath('sessionData',path.join(__dirname,'sessions'));(${electronTest.toString()})(electron,${JSON.stringify({ directory, html })});setTimeout(()=>electron.app.exit(2),60000).unref();`);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'mosaic-reimbursement-smoke', main: 'main.cjs' }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => { const child = spawn(electronPath(), [directory], { cwd: root, env, windowsHide: true, stdio: 'ignore' }); const timer = setTimeout(() => { child.kill(); reject(new Error(`UI smoke timed out: ${directory}`)); }, 65000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8')); result.reportDirectory = directory; console.log(JSON.stringify(result, null, 2)); if (code !== 0 || !result.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
