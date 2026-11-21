'use strict';

// Isolated production-UI smoke: no user library, filesystem export or network.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { root, electronPath } = require('./runtime.cjs');

async function electronTest({ app, BrowserWindow }, options) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const checks = [], errors = [];
  let window;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const js = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const click = selector => js(selector => { const item = document.querySelector(selector); if (!item || item.disabled) throw new Error(`Unavailable ${selector}`); item.click(); }, selector);
  const settle = () => js(() => new Promise(resolve => setTimeout(resolve, 60)));
  try {
    await app.whenReady();
    window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await window.loadFile(options.html);
    await js(async () => window.shituPlugins.open({ assets: window.fixtureAssets, selectedIds: ['image-2', 'image-1'], libraryRoot: 'C:\\fixture-library', pluginId: 'extract-text' }));
    assert(await js(() => document.querySelectorAll('.sp-plugin-item').length >= 7), 'Missing plugin entries');
    assert(await js(() => document.querySelector('#sp-ocr-language option[value="zh-Hans"]').textContent === '中文（简体）'), 'Installed OCR language not shown');
    assert(await js(() => document.querySelector('#sp-job-message').textContent.includes('TXT')), 'OCR footer incorrectly describes asset import');
    await click('#sp-run'); await settle();
    assert(await js(() => window.requests[0].pluginId === 'extract-text' && window.requests[0].options.language === 'auto'), 'Wrong OCR request');
    assert(await js(() => window.requests[0].assetIds.join(',') === 'image-1,image-2'), 'Image order differs from gallery order');
    assert(await js(() => document.querySelectorAll('.sp-text-output').length === 2), 'Missing per-image OCR results');
    assert(await js(() => document.querySelector('.sp-text-output').value.includes('<img') && !document.querySelector('.sp-text-results img')), 'OCR text was interpreted as HTML');
    await js(() => [...document.querySelectorAll('#sp-result-links button')].find(button => button.textContent === '复制全部文字').click()); await settle();
    assert(await js(() => window.copied === 'job-1' && document.querySelector('#sp-notice').textContent.includes('已复制')), 'Copy result action failed');
    await js(() => [...document.querySelectorAll('#sp-result-links button')].find(button => button.textContent.includes('保存 TXT')).click()); await settle();
    assert(await js(() => window.saved === 'job-1' && document.querySelector('#sp-notice').textContent.includes('已保存')), 'Save text action failed');
    await new Promise(resolve => setTimeout(resolve, 250));
    await fs.writeFile(path.join(options.directory, 'ocr.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('OCR language selection, safe per-image text results, copy and TXT export');

    await click('[data-plugin-id="image-to-pdf"]');
    assert(await js(() => document.querySelectorAll('.sp-page-number').length === 2), 'PDF page order indicators missing');
    await js(() => { document.querySelector('#sp-pdf-page').value = 'a4'; document.querySelector('#sp-pdf-orientation').value = 'landscape'; document.querySelector('#sp-pdf-margin').value = '10'; window.nextResult = 'cancel'; });
    await click('#sp-run'); await settle();
    assert(await js(() => !document.querySelector('#sp-run').disabled && document.querySelector('#sp-job-message').textContent.includes('未生成')), 'Canceled PDF dialog left job busy or success shown');
    checks.push('PDF save dialog cancellation resets action');
    await click('#sp-run'); await settle();
    assert(await js(() => { const r = window.requests.at(-1); return r.options.pageSize === 'a4' && r.options.orientation === 'landscape' && r.options.margin === 10; }), 'PDF settings not sent');
    assert(await js(() => document.querySelector('#sp-job-message').textContent.includes('2 页') && document.querySelector('#sp-job-message').textContent.includes('document.pdf')), 'PDF completion omits page count or path');
    await js(() => [...document.querySelectorAll('#sp-result-links button')].find(button => button.textContent.includes('文件夹')).click()); await settle();
    assert(await js(() => window.revealed === 'job-3'), 'PDF reveal result action failed');
    await new Promise(resolve => setTimeout(resolve, 250));
    await fs.writeFile(path.join(options.directory, 'pdf.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('PDF page settings, gallery order, saved path and reveal result');

    window.setSize(1000, 720); await new Promise(resolve => setTimeout(resolve, 250));
    const fits = await js(() => {
      const run = document.querySelector('#sp-run').getBoundingClientRect();
      const settings = document.querySelector('#sp-settings').getBoundingClientRect();
      return run.bottom <= innerHeight && run.right <= innerWidth && settings.right <= innerWidth;
    });
    assert(fits, 'Small-window PDF controls overflow');
    await fs.writeFile(path.join(options.directory, 'pdf-small.png'), (await window.webContents.capturePage()).toPNG());

    await click('[data-plugin-id="extract-text"]');
    await click('#sp-run'); await settle(); await new Promise(resolve => setTimeout(resolve, 250));
    assert(await js(() => { const results = document.querySelector('#sp-text-results'); return results.scrollHeight >= results.clientHeight && results.getBoundingClientRect().bottom < innerHeight; }), 'OCR result panel overflows small window');
    await fs.writeFile(path.join(options.directory, 'ocr-small.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('Normal and 1000×720 layouts keep results and actions accessible');
    await js(async () => { window.ocrAvailable = false; await window.shituPlugins.refresh(); });
    assert(await js(() => document.querySelector('#sp-run').disabled && document.querySelector('#sp-ocr-info').textContent.includes('未安装')), 'Missing OCR runtime was not explained');
    await js(async () => { window.ocrAvailable = true; await window.shituPlugins.refresh(); window.nextResult = 'error'; });
    await click('#sp-run'); await settle();
    assert(await js(() => document.querySelector('#sp-job-message').textContent.includes('识别失败') && !document.querySelector('#sp-run').disabled), 'OCR error did not restore action');
    checks.push('Missing runtime and recognition error recovery');
    await js(() => window.shituPlugins.close());
    assert(await js(() => document.querySelector('#pluginCenter').hidden), 'Plugin center did not close');
    assert(errors.length === 0, errors.join('\n'));
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
    window.destroy(); app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) await fs.writeFile(path.join(options.directory, 'failure.png'), (await window.webContents.capturePage()).toPNG()).catch(() => {});
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: false, error: error.stack, checks, errors }, null, 2));
    app.exit(1);
  }
}

function mockBridge() {
  window.requests = []; window.ocrAvailable = true;
  const ids = ['ai-upscale', 'ai-cutout', 'crop', 'compress', 'convert', 'extract-text', 'image-to-pdf'];
  const canvas = document.createElement('canvas'); canvas.width = 540; canvas.height = 350;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f4f0e8'; ctx.fillRect(0, 0, 540, 350); ctx.fillStyle = '#35332e'; ctx.font = '32px sans-serif'; ctx.fillText('Mosaic 文字提取', 50, 125); ctx.font = '24px sans-serif'; ctx.fillText('A local image workflow.', 50, 175);
  const url = canvas.toDataURL();
  window.fixtureAssets = [1, 2].map(n => ({ id: `image-${n}`, name: `示例图片 ${n}`, mediaType: 'image', ext: 'png', originalUrl: url }));
  let listener;
  window.shitu = {
    pluginsList: async () => ({ plugins: ids.map(id => ({ id, installed: true, enabled: true, resourceReady: id !== 'extract-text' || window.ocrAvailable, runtime: id === 'extract-text' ? { languages: [{ tag: 'zh-Hans', name: '中文（简体）' }, { tag: 'en-US', name: 'English' }], error: window.ocrAvailable ? '' : '未安装识别语言，请在 Windows 设置中安装。' } : {} })) }),
    onPluginEvent: callback => { listener = callback; return () => {}; },
    pluginRun: async request => {
      window.requests.push(request); const jobId = `job-${window.requests.length}`;
      const next = window.nextResult; window.nextResult = '';
      if (next === 'cancel') return { cancelled: true };
      if (next === 'error') { listener({ type: 'error', pluginId: request.pluginId, jobId, error: '识别失败，请重试。' }); return { jobId }; }
      listener({ type: 'complete', pluginId: request.pluginId, jobId, results: request.pluginId === 'extract-text' ? [{ sourceId: 'image-1', name: '示例图片 1', text: 'Mosaic 文字提取\nA local image workflow.\n<img src=x onerror=alert(1)>', engine: 'Windows OCR' }, { sourceId: 'image-2', name: '示例图片 2', text: '第二张图片的文字', engine: 'Windows OCR' }] : [{ path: 'C:\\Exports\\document.pdf', name: 'document.pdf', pages: 2, engine: '本地 PDF' }] });
      return { jobId };
    },
    pluginCopyText: async id => { window.copied = id; return { copied: true }; },
    pluginSaveText: async id => { window.saved = id; return { saved: true, path: 'C:\\Exports\\text.txt' }; },
    pluginRevealResult: async id => { window.revealed = id; return { revealed: true }; }
  };
}

async function main() {
  const tests = path.join(root, '.recovery', 'tests'); await fs.mkdir(tests, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tests, 'document-plugins-'));
  const fileUrl = name => pathToFileURL(path.join(root, 'src', name)).href;
  const html = path.join(directory, 'index.html');
  await fs.writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${fileUrl('styles.css')}"></head><body><script>(${mockBridge.toString()})();</script><script src="${fileUrl('plugin-center.js')}"></script></body></html>`);
  const options = { directory, html };
  await fs.writeFile(path.join(directory, 'main.cjs'), `const electron=require('electron');const path=require('node:path');electron.app.setName('Mosaic document plugin smoke');electron.app.setPath('userData',path.join(__dirname,'profile'));electron.app.setPath('sessionData',path.join(__dirname,'sessions'));(${electronTest.toString()})(electron,${JSON.stringify(options)});setTimeout(()=>electron.app.exit(2),60000).unref();`);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'mosaic-document-plugins-smoke', main: 'main.cjs' }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [directory], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Smoke timed out: ${directory}`)); }, 65000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8')); result.reportDirectory = directory;
  console.log(JSON.stringify(result, null, 2)); if (code !== 0 || !result.ok) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
