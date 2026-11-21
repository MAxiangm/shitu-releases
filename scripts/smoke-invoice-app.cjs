'use strict';

// Full production main/preload/renderer smoke using only a disposable profile.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');

async function runProduction(options) {
  const { app, BrowserWindow, dialog, session } = require('electron');
  const checks = [], errors = [], dialogs = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let window;
  const js = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const resultPath = path.join(options.directory, 'result.json');
  const persist = result => fs.writeFile(resultPath, JSON.stringify({ ...result, checks, errors, dialogs }, null, 2));
  async function waitFor(test, message, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await test()) return; await pause(60); }
    throw new Error(message);
  }
  async function capture(name) {
    window.showInactive(); await pause(180);
    await fs.writeFile(path.join(options.directory, name), (await window.webContents.capturePage()).toPNG());
    window.hide();
  }
  app.setPath('userData', path.join(options.directory, 'profile'));
  app.setPath('sessionData', path.join(options.directory, 'session'));
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  dialog.showErrorBox = (title, content) => errors.push(`${title}: ${content}`);
  dialog.showOpenDialog = async (...args) => { throw new Error(`Unexpected open dialog: ${args.at(-1)?.title}`); };
  dialog.showMessageBox = async (...args) => { throw new Error(`Unexpected message dialog: ${args.at(-1)?.message}`); };
  dialog.showSaveDialog = async (...args) => {
    const settings = args.at(-1);
    dialogs.push({ title: settings.title, defaultPath: settings.defaultPath });
    assert(settings.filters?.[0]?.extensions?.includes('pdf'), 'Unexpected save dialog format');
    return { canceled: false, filePath: path.join(options.directory, '3张_合计379.49元.pdf') };
  };
  app.on('browser-window-created', (_event, candidate) => {
    candidate.setSkipTaskbar(true);
    candidate.webContents.on('did-finish-load', () => {
      if (candidate.webContents.getURL().endsWith('/src/index.html')) window = candidate;
    });
    candidate.webContents.on('console-message', event => {
      if (event.level === 'error' || event.level === 3) errors.push(event.message);
    });
    candidate.webContents.on('preload-error', (_event, filename, error) => errors.push(`Preload ${filename}: ${error.message}`));
    candidate.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${JSON.stringify(details)}`));
  });
  process.on('uncaughtException', error => errors.push(error.stack || String(error)));
  process.on('unhandledRejection', error => errors.push(error?.stack || String(error)));
  try {
    require(path.join(options.root, 'src/main.cjs'));
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
    await waitFor(() => window && !window.isDestroyed() && js(() => window.shitu?.invoiceRun && typeof state === 'object' && Boolean(state.library.root)).catch(() => false), 'Production main/preload/library failed to initialize');
    assert(app.getPath('userData') === path.join(options.directory, 'profile'), 'Smoke did not retain isolated user profile');
    checks.push('production main/index/preload loaded with isolated userData, sessionData, library and plugin root');
    const imported = await js(async filenames => { const result = await window.shitu.importPaths(filenames, null); applyLibrary(result.snapshot); return result; }, options.files);
    assert(imported.report.imported === 4 && imported.report.errors.length === 0, `Import failed: ${JSON.stringify(imported.report)}`);
    const snapshot = imported.snapshot;
    assert(snapshot.assets.filter(asset => asset.mediaType === 'document').length === 3, 'PDF/Word/TXT were not document assets');
    assert(snapshot.assets.filter(asset => asset.mediaType === 'image').length === 1, 'PNG was not an image asset');
    const pdf = snapshot.assets.find(asset => asset.ext === 'pdf'), png = snapshot.assets.find(asset => asset.ext === 'png');
    await waitFor(() => js(() => state.library.assets.length === 4), 'Renderer did not refresh imported assets');
    await js(() => { document.querySelector('#formatFilter').value = 'document'; document.querySelector('#formatFilter').dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => js(() => document.querySelectorAll('.asset-card').length === 3), 'Document filter did not show three cards');
    assert(await js(() => [...document.querySelectorAll('.asset-card')].every(card => card.textContent.includes('文档'))), 'Document badges did not render');
    await capture('documents-main.png');
    await js(id => openPreview(id), pdf.id);
    await waitFor(() => js(() => document.querySelector('#previewImage').src.includes('kind=thumbnail') && document.querySelector('#previewHelp').textContent.includes('文档封面')), 'Document preview attempted a raw image decode');
    await capture('document-preview.png');
    await js(() => { closePreview(); state.selected.clear(); document.querySelector('#invoiceCenterButton').click(); });
    await waitFor(() => js(() => window.shituInvoices?.isOpen() && document.querySelector('#iv-add')?.disabled === false), 'Independent invoice workspace did not open');
    assert(await js(async () => (await window.shitu.pluginsList()).plugins.every(plugin => !plugin.installed)), 'Fresh profile unexpectedly installed image plugins');
    assert(await js(() => !window.shituPlugins.isOpen()), 'Invoice workspace depended on plugin center');
    checks.push('real IPC imported PDF/DOCX/TXT/PNG; document filter/cards and safe system-app preview work');
    checks.push('invoice workspace opens independently with zero installed image plugins');
    await js(ids => {
      for (const id of ids) {
        const input = document.querySelector(`[data-library-id="${id}"]`); if (!input) throw new Error('Missing invoice source checkbox');
        input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('#iv-add-library').click();
    }, [pdf.id, png.id]);
    await waitFor(() => js(() => document.querySelectorAll('.iv-item').length === 3 && document.querySelector('#iv-add').disabled === false), 'Real PDF reader did not prepare two PDF pages and one PNG', 90000);
    assert(await js(() => document.querySelector('#iv-notice').textContent.includes('已添加 3')), 'Invoice staging reported a preparation error');
    checks.push('library PDF rendered two pages using the real sandboxed PDF reader; PNG prepared through real image pipeline');
    await js(() => {
      const amounts = ['113.00', '226.50', '39.99'];
      [...document.querySelectorAll('[data-invoice-amount]')].forEach((input, index) => { input.value = amounts[index]; input.dispatchEvent(new Event('input', { bubbles: true })); });
      const confirm = document.querySelector('#iv-confirm'); confirm.checked = true; confirm.dispatchEvent(new Event('change', { bubbles: true }));
      if (document.querySelector('#iv-export').disabled) throw new Error('Verified invoice export stayed disabled');
    });
    assert(await js(() => document.querySelector('#iv-summary').textContent.includes('379.49')), 'Invoice sum or filename lost integer cents');
    await capture('invoice-workspace.png');
    await js(() => document.querySelector('#iv-export').click());
    await waitFor(() => js(() => document.querySelector('#iv-result').textContent.includes('3张_合计379.49元.pdf') && document.querySelector('#iv-job-title').textContent === '处理完成'), 'Invoice export did not complete');
    const outputPath = path.join(options.directory, '3张_合计379.49元.pdf');
    const bytes = await fs.readFile(outputPath);
    assert(bytes.subarray(0, 5).toString() === '%PDF-', 'Export result is not a PDF');
    assert((bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length === 2, 'Two-per-page invoice layout did not produce two PDF pages');
    checks.push(`real invoice writer exported 3 invoices across 2 pages with exact total 379.49 (${bytes.length} bytes)`);
    await capture('invoice-exported.png');
    assert(errors.length === 0, `Runtime errors: ${errors.join('\n')}`);
    await persist({ ok: true, outputPath, screenshots: ['documents-main.png', 'document-preview.png', 'invoice-workspace.png', 'invoice-exported.png'] });
    app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) await capture('failure.png').catch(() => {});
    await persist({ ok: false, error: error.stack || String(error) });
    app.exit(1);
  }
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, contents] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(contents), checksum = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes); centrals.push(central, filename); offset += local.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function main() {
  const sharp = require('sharp');
  const { Library } = require('../src/library.cjs');
  const { writeImagePdf } = require('../src/image-pdf.cjs');
  const parent = path.join(root, '.recovery', 'tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'invoice-app-'));
  for (const name of ['profile', 'session', 'fixture-app']) await fs.mkdir(path.join(directory, name));
  const library = path.join(directory, 'library'); await new Library({ root: library }).init();
  const png = path.join(directory, '发票图片.png');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><rect width="1000" height="500" fill="#fff"/><rect x="15" y="15" width="970" height="470" fill="none" stroke="#8a4c29" stroke-width="3"/><text x="60" y="130" font-size="46" font-family="Arial" fill="#673821">MOSAIC INVOICE</text><text x="60" y="240" font-size="34" fill="#222">Invoice amount: 113.00</text><path d="M50 280H950M50 350H950" stroke="#995a44"/></svg>')).png().toFile(png);
  const pdf = path.join(directory, '双页发票.pdf'); await writeImagePdf({ inputPaths: [png, png], outputPath: pdf, options: { pageSize: 'a4', orientation: 'portrait', imagesPerPage: 1 } });
  const docx = path.join(directory, '合同.docx');
  await fs.writeFile(docx, zip({ '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mosaic document storage smoke</w:t></w:r></w:p></w:body></w:document>' }));
  const txt = path.join(directory, '说明.txt'); await fs.writeFile(txt, '文档管理真实应用测试\nUTF-8 text storage');
  const options = { root, directory, library, files: [pdf, docx, txt, png] };
  await fs.writeFile(path.join(directory, 'options.json'), JSON.stringify(options));
  await fs.writeFile(path.join(directory, 'fixture-app', 'package.json'), JSON.stringify({ name: 'mosaic-invoice-app-smoke', version: require('../package.json').version, main: 'main.cjs' }));
  await fs.writeFile(path.join(directory, 'fixture-app', 'main.cjs'), `require(${JSON.stringify(__filename)}).runProduction(require(${JSON.stringify(path.join(directory, 'options.json'))}));`);
  const log = [];
  const env = { ...process.env, SHITU_LIBRARY: library, SHITU_PLUGIN_ROOT: path.join(directory, 'plugin-root') };
  for (const name of Object.keys(env)) if (name === 'ELECTRON_RUN_AS_NODE' || /SMOKE/.test(name)) delete env[name];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [path.join(directory, 'fixture-app'), '--background'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Invoice app smoke timed out: ${directory}`)); }, 150000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => log.push(chunk.toString()));
    child.on('error', reject); child.on('close', status => { clearTimeout(timeout); resolve(status); });
  });
  await fs.writeFile(path.join(directory, 'electron.log'), log.join(''));
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
  if (code || !result.ok) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { runProduction };
