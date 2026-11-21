'use strict';

// Standalone invoice UI smoke. Native staging/OCR/export are mocked; no user files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');

async function electronTest({ app, BrowserWindow }, options) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const checks = [], errors = [];
  let window;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const js = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const click = async selector => { await js(selector => { const target = document.querySelector(selector); if (!target || target.disabled) throw new Error(`Unavailable ${selector}`); target.click(); }, selector); await pause(); };
  const amount = async (id, value) => js((id, value) => { const input = document.querySelector(`[data-invoice-amount="${id}"]`); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, id, value);
  const screenshot = async name => { await new Promise(resolve => setTimeout(resolve, 250)); await fs.writeFile(path.join(options.directory, `${name}.png`), (await window.webContents.capturePage()).toPNG()); };
  try {
    await app.whenReady();
    window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await window.loadFile(options.html);
    await js(async () => window.shituInvoices.open({ assets: window.libraryAssets, selectedIds: ['library-image', 'library-pdf'], libraryRoot: 'C:\\fixture-library' }));
    assert(await js(() => window.libraryRequests.length === 1 && window.libraryRequests[0].assetIds.join(',') === 'library-image,library-pdf'), 'Initial library selection not staged');
    assert(await js(() => [...document.querySelectorAll('[data-invoice-id]')].map(row => row.dataset.invoiceId).join(',') === 'staged-image,staged-pdf-1,staged-pdf-2'), 'Rows do not use staged IDs or expand PDF pages');
    assert(await js(() => document.querySelectorAll('#iv-library-items input').length === 3), 'Library source picker includes unsupported documents');
    assert(await js(() => document.querySelector('#iv-export').disabled && !document.querySelector('#iv-recognize').disabled), 'Review gate or PDF-text recognition fallback incorrect');
    assert(await js(() => document.querySelector('#iv-language').value === 'zh-Hans' && window.previewRequests.length === 0), 'Chinese OCR language not selected by default or preview fetched eagerly');
    await js(() => { window.previewDelay = true; });
    await click('[data-invoice-id="staged-image"] .iv-thumbnail');
    await click('[data-invoice-id="staged-pdf-1"] .iv-thumbnail');
    await js(() => window.previewResolvers['staged-pdf-1']({ url: window.fullPreviewB })); await pause();
    await js(() => window.previewResolvers['staged-image']({ url: window.fullPreviewA })); await pause();
    assert(await js(() => document.querySelector('[data-invoice-id="staged-pdf-1"] .iv-full-image')?.src === window.fullPreviewB && !document.querySelector('[data-invoice-id="staged-image"] .iv-full-image')), 'Stale full-size preview replaced current invoice');
    await click('[data-invoice-id="staged-pdf-1"] .iv-thumbnail');
    checks.push('Installed Chinese language default and lazy full-size preview with stale-response guard');
    checks.push('Independent module stages library image/PDF into one row per page');

    await amount('staged-image', '0'); await amount('staged-pdf-1', '0.10'); await amount('staged-pdf-2', '0.20');
    assert(await js(() => document.querySelector('#iv-summary').textContent.includes('3张_合计0.30元.pdf')), 'Amount total suffers precision or zero bug');
    await click('#iv-confirm');
    assert(await js(() => !document.querySelector('#iv-export').disabled), 'Reviewed valid amounts cannot export');
    await amount('staged-image', '1.234');
    assert(await js(() => !document.querySelector('#iv-confirm').checked && document.querySelector('#iv-export').disabled), 'Invalid precision did not reset review');
    await amount('staged-image', '0');
    await click('#iv-recognize');
    assert(await js(() => window.requests[0].mode === 'recognize' && window.requests[0].options.language === 'zh-Hans' && window.requests[0].itemIds.join(',') === 'staged-image,staged-pdf-1,staged-pdf-2'), 'Recognition language or staged IDs wrong');
    assert(await js(() => document.querySelector('[data-invoice-amount="staged-image"]').value === '123.45' && document.querySelector('[data-invoice-amount="staged-pdf-1"]').value === '' && document.querySelector('[data-invoice-amount="staged-pdf-2"]').value === '0.00'), 'Recognition values do not preserve zero or blank ambiguous results');
    assert(await js(() => document.querySelector('[data-invoice-id="staged-pdf-1"]').textContent.includes('多个不同合计')), 'Recognition reason code not translated');
    assert(await js(() => document.querySelector('.iv-text pre').textContent.includes('<img') && !document.querySelector('.iv-text img')), 'OCR content interpreted as markup');
    assert(await js(() => !document.querySelector('#iv-confirm').checked), 'Recognition did not clear confirmation');
    await amount('staged-pdf-1', '0.10'); await click('#iv-confirm');
    await click('[data-invoice-id="staged-pdf-2"] [data-invoice-move="-1"]');
    assert(await js(() => !document.querySelector('#iv-confirm').checked && document.querySelector('#iv-export').disabled), 'Reorder did not clear confirmation');
    await click('#iv-confirm');
    await screenshot('invoice-review');
    checks.push('Exact cents, zero, invalid amounts, safe OCR, ambiguity and review reset');

    await js(() => { window.nextResult = 'cancel'; }); await click('#iv-export');
    assert(await js(() => document.querySelector('#iv-job-message').textContent.includes('未生成') && !document.querySelector('#iv-export').disabled), 'Canceled native save left busy state');
    await click('#iv-export');
    assert(await js(() => { const request = window.requests.at(-1); return request.mode === 'export' && request.itemIds.join(',') === 'staged-image,staged-pdf-2,staged-pdf-1' && request.options.items.map(item => item.id).join(',') === request.itemIds.join(',') && request.options.items.map(item => item.amount).join(',') === '123.45,0.00,0.10' && request.options.confirmed && request.options.imagesPerPage === 2; }), 'Export order, amount normalization or confirmation contract wrong');
    await click('#iv-result button');
    assert(await js(() => window.revealed === 'invoice-job-3' && document.querySelector('#iv-result').textContent.includes('3张_合计123.55元.pdf')), 'Saved PDF result not shown or reveal failed');
    checks.push('Confirmed ordered export, save cancellation and result reveal');

    await click('#iv-add');
    assert(await js(() => document.querySelectorAll('[data-invoice-id]').length === 5 && !document.querySelector('#iv-confirm').checked && document.querySelector('#iv-export').disabled), 'Local PDF pages not added or review not reset');
    await amount('staged-local-1', '5'); await amount('staged-local-2', '6');
    await click('#iv-confirm');
    await js(() => { window.nextRemoveFailure = true; }); await click('[data-invoice-remove="staged-local-2"]');
    assert(await js(() => document.querySelectorAll('[data-invoice-id]').length === 5 && document.querySelector('#iv-notice').textContent.includes('移除失败')), 'Failed cache removal incorrectly removed UI row');
    await click('[data-invoice-remove="staged-local-2"]');
    assert(await js(() => document.querySelectorAll('[data-invoice-id]').length === 4 && !document.querySelector('#iv-confirm').checked && window.removeRequests.at(-1).join(',') === 'staged-local-2'), 'Remove did not free staged items, update count or clear review');
    await js(() => { const details = document.querySelector('#iv-library'); details.open = true; const checkbox = document.querySelector('[data-library-id="library-extra"]'); checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); });
    await click('#iv-add-library');
    assert(await js(() => document.querySelector('[data-invoice-id="staged-extra"]') && window.libraryRequests.at(-1).assetIds[0] === 'library-extra'), 'Library source picker did not stage selected asset');
    await js(() => { document.querySelector('#iv-library').open = false; });
    window.setSize(1000, 720); await screenshot('invoice-small');
    assert(await js(() => { const footer = document.querySelector('#iv-export').getBoundingClientRect(); const items = document.querySelector('#iv-items').getBoundingClientRect(); return footer.bottom <= innerHeight && footer.right <= innerWidth && items.right <= innerWidth && items.bottom < footer.top; }), 'Small-window invoice UI overflows');
    checks.push('Local files, library picker, PDF page count, removal and 1000×720 layout');

    await js(() => { window.nextResult = 'hold'; }); await click('#iv-recognize');
    assert(await js(() => window.shituInvoices.isBusy() && document.querySelector('#iv-add').disabled), 'Running job left inputs enabled');
    await click('#iv-cancel');
    assert(await js(() => !window.shituInvoices.isBusy() && !document.querySelector('#iv-add').disabled), 'Job cancellation left controls busy');
    assert(await js(() => document.querySelector('[data-invoice-id="staged-image"]').textContent.includes('金额无法读清') && document.querySelector('[data-invoice-id="staged-pdf-1"]').textContent.includes('过多合计字段')), 'New recognition reason codes were not translated');
    await js(() => window.shituInvoices.close());
    assert(await js(() => document.querySelector('#invoiceCenter').hidden), 'Standalone invoice module did not close');
    await js(async () => window.shituInvoices.open({ assets: [], selectedIds: [] }));
    assert(await js(() => document.querySelectorAll('[data-invoice-id]').length === 5), 'Staged workspace was lost on reopen');
    checks.push('Running-job cancellation and workspace persistence');
    await js(() => { window.removeDelay = true; });
    await click('#iv-clear');
    assert(await js(() => document.querySelectorAll('[data-invoice-id]').length === 5 && window.shituInvoices.isBusy() && window.removeRequests.at(-1).length === 5), 'Clear removed UI before backend acknowledged staged cleanup');
    await js(() => window.removeResolver({ removed: true })); await pause();
    assert(await js(() => document.querySelectorAll('[data-invoice-id]').length === 0 && !window.shituInvoices.isBusy()), 'Clear did not finish after backend cleanup');
    checks.push('Asynchronous clear waits for backend cache cleanup');
    assert(errors.length === 0, errors.join('\n'));
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
    window.destroy(); app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) await screenshot('failure').catch(() => {});
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: false, error: error.stack, checks, errors }, null, 2)); app.exit(1);
  }
}

function mockBridge() {
  const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 380;
  const context = canvas.getContext('2d'); context.fillStyle = '#f5f3ee'; context.fillRect(0, 0, 600, 380); context.fillStyle = '#334'; context.font = '28px sans-serif'; context.fillText('电子发票（普通发票）', 150, 60); context.font = '20px sans-serif'; context.fillText('价税合计（小写） ¥123.45', 90, 270);
  const previewUrl = canvas.toDataURL();
  canvas.width = 1600; canvas.height = 1000; context.fillStyle = '#fff'; context.fillRect(0, 0, 1600, 1000); context.font = '70px sans-serif'; context.fillStyle = '#223'; context.fillText('Invoice A', 100, 100); window.fullPreviewA = canvas.toDataURL(); context.fillStyle = '#224'; context.fillText('Invoice B', 100, 210); window.fullPreviewB = canvas.toDataURL();
  const item = (id, name, sourceType = 'image', pageNumber) => ({ id, name, sourceType, pageNumber, previewUrl, width: 600, height: 380 });
  window.libraryAssets = [{ id: 'library-image', name: '餐饮发票', mediaType: 'image', ext: 'png' }, { id: 'library-pdf', name: '出行发票', mediaType: 'document', ext: 'pdf' }, { id: 'library-extra', name: '住宿发票', mediaType: 'image', ext: 'jpg' }, { id: 'library-word', name: '说明文档', mediaType: 'document', ext: 'docx' }];
  window.requests = []; window.libraryRequests = []; window.previewRequests = []; window.previewResolvers = {}; window.removeRequests = []; let listener;
  window.shitu = {
    invoiceStatus: async () => ({ ocrReady: false, languages: [{ tag: 'en-US', name: 'English' }, { tag: 'zh-Hans', name: '中文（简体）' }] }),
    invoicePreview: async id => { window.previewRequests.push(id); if (window.previewDelay) return new Promise(resolve => { window.previewResolvers[id] = resolve; }); return { url: window.fullPreviewA }; },
    invoiceRemoveItems: async ids => { window.removeRequests.push(ids); if (window.nextRemoveFailure) { window.nextRemoveFailure = false; throw new Error('移除失败，请重试'); } if (window.removeDelay) return new Promise(resolve => { window.removeResolver = resolve; }); return { removed: true }; },
    onInvoiceEvent: callback => { listener = callback; return () => {}; },
    invoiceAddAssets: async request => { window.libraryRequests.push(request); return { items: request.assetIds.flatMap(id => id === 'library-image' ? [item('staged-image', '餐饮发票')] : id === 'library-pdf' ? [item('staged-pdf-1', '出行发票', 'pdf', 1), item('staged-pdf-2', '出行发票', 'pdf', 2)] : [item('staged-extra', '住宿发票')]), errors: [] }; },
    invoiceChooseFiles: async () => ({ items: [item('staged-local-1', '本地电子发票', 'pdf', 1), item('staged-local-2', '本地电子发票', 'pdf', 2)], errors: [] }),
    invoiceRun: async request => {
      window.requests.push(request); const jobId = `invoice-job-${window.requests.length}`;
      const next = window.nextResult; window.nextResult = '';
      if (next === 'cancel') return { cancelled: true };
      if (next === 'hold') { window.heldJob = { jobId, mode: request.mode }; return { jobId }; }
      listener({ type: 'complete', mode: request.mode, jobId, results: request.mode === 'recognize' ? [{ sourceId: 'staged-image', amount: '123.45', text: '价税合计 ¥123.45\n<img src=x onerror=alert(1)>', confidence: 'high', reason: 'labelled-total' }, { sourceId: 'staged-pdf-1', amount: null, text: '合计 12.34\n合计 56.78', confidence: 'none', reason: 'ambiguous-totals' }, { sourceId: 'staged-pdf-2', amount: '0.00', text: '合计 0.00', confidence: 'high', reason: 'labelled-total' }] : [{ invoiceCount: 3, totalAmount: '123.55', pages: 2, path: 'C:\\Exports\\3张_合计123.55元.pdf' }] });
      return { jobId };
    },
    invoiceCancel: async jobId => { listener({ ...window.heldJob, jobId, type: 'cancelled', results: [{ sourceId: 'staged-image', amount: null, reason: 'unreadable-total' }, { sourceId: 'staged-pdf-1', amount: null, reason: 'too-many-totals' }] }); return { cancelled: true }; },
    invoiceRevealResult: async jobId => { window.revealed = jobId; return { revealed: true }; }
  };
}

async function main() {
  const tests = path.join(root, '.recovery', 'tests'); await fs.mkdir(tests, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tests, 'invoice-ui-'));
  const fileUrl = filename => pathToFileURL(path.join(root, 'src', filename)).href;
  const html = path.join(directory, 'index.html');
  await fs.writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${fileUrl('styles.css')}"></head><body><script>(${mockBridge.toString()})();</script><script src="${fileUrl('invoice-amounts.js')}"></script><script src="${fileUrl('invoice-center.js')}"></script></body></html>`);
  await fs.writeFile(path.join(directory, 'main.cjs'), `const electron=require('electron');const path=require('node:path');electron.app.setName('Mosaic invoice isolated smoke');electron.app.setPath('userData',path.join(__dirname,'profile'));electron.app.setPath('sessionData',path.join(__dirname,'sessions'));(${electronTest.toString()})(electron,${JSON.stringify({ directory, html })});setTimeout(()=>electron.app.exit(2),60000).unref();`);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'mosaic-invoice-smoke', main: 'main.cjs' }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [directory], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Invoice smoke timed out: ${directory}`)); }, 65000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8')); result.reportDirectory = directory; console.log(JSON.stringify(result, null, 2));
  if (code !== 0 || !result.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
