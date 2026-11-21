'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { root, electronPath } = require('./runtime.cjs');
const { writeImagePdf } = require('../src/image-pdf.cjs');

function textPdf(count, pageWidth = 300, pageHeight = 200) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let index = 0; index < count; index++) {
    const text = `BT /F1 20 Tf 25 ${pageHeight - 40} Td (Invoice ${index + 1}) Tj 0 -30 Td (Total CNY ${(index + 1) * 100}.00) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${4 + index * 2} 0 R >>`);
  }
  let output = '%PDF-1.4\n', offsets = [0];
  for (let id = 1; id < objects.length; id++) { offsets.push(Buffer.byteLength(output)); output += `${id} 0 obj\n${objects[id]}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return output;
}

function unorderedTextPdf(rotation = 0) {
  const fragments = [
    ['Grand Total', 20, 140], ['Notes below the total', 20, 70], ['Invoice layout', 20, 180],
    ['CNY', 150, 140], ['0', 208.35, 141], ['9', 191.67, 141], ['.', 205.01, 141],
    ['9', 185, 141], ['0', 215.02, 141], ['8', 198.34, 141],
    ['Net and tax', 20, 110], ['1000.00', 150, 110], ['130.00', 220, 110]
  ];
  // A small font-size change keeps each positioned chunk a separate PDF.js
  // text item; otherwise its text combiner can join out-of-order glyph draws.
  const stream = fragments.map(([text, x, y], index) => `BT /F1 ${index % 2 ? 12.01 : 12} Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`).join('\n');
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [5 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Page /Parent 2 0 R /Rotate ${rotation} /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  for (let index = 1; index < objects.length; index++) { offsets.push(Buffer.byteLength(output)); output += `${index} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  return output + `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function runElectron(electron, options) {
  const { app, BrowserWindow, ipcMain } = electron;
  const assert = require('node:assert/strict');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { createInvoicePdfReader } = require(path.join(options.root, 'src/invoice-pdf-reader.cjs'));
  const sharp = require(path.join(options.root, 'node_modules/sharp'));
  const checks = [], securityProbes = [], windows = [];
  let reader;
  try {
    await app.whenReady();
    function TrackingWindow(config) {
      assert.equal(config.show, false);
      assert.equal(config.webPreferences.sandbox, true);
      assert.equal(config.webPreferences.contextIsolation, true);
      assert.equal(config.webPreferences.nodeIntegration, false);
      const window = new BrowserWindow(config);
      windows.push(window);
      window.webContents.once('did-finish-load', () => {
        securityProbes.push(window.webContents.executeJavaScript(`(async()=>({ noNode:typeof require==='undefined', noPaths:!window.invoicePdf.readFile, blocked:await fetch('https://example.com/').then(()=>false,()=>true) }))()`));
      });
      return window;
    }
    reader = createInvoicePdfReader({ BrowserWindow: TrackingWindow, ipcMain, timeoutMs: 90000, requestTimeoutMs: 25000 });
    const output = path.join(options.directory, 'output');
    const pages = await reader.convert({ inputPath: path.join(options.directory, 'text.pdf'), outputDir: output });
    assert.equal(pages.length, 2);
    assert.match(pages[0].text, /Invoice 1/); assert.match(pages[0].text, /Total CNY 100.00/);
    assert.match(pages[1].text, /Invoice 2/); assert.match(pages[1].text, /Total CNY 200.00/);
    assert.deepEqual(pages.map(page => page.pageNumber), [1, 2]);
    for (const page of pages) { const info = await sharp(page.path).metadata(); assert.equal(info.width, page.width); assert.equal(info.height, page.height); }
    checks.push('text PDF: two pages, text, page ordering and valid PNG dimensions');
    for (const rotation of [0, 90, 180, 270]) {
      const [layout] = await reader.convert({ inputPath: path.join(options.directory, `layout-${rotation}.pdf`), outputDir: output });
      assert.match(layout.text, /^Invoice layout\nGrand Total CNY 998\.00\nNet and tax 1000\.00 130\.00\nNotes below the total$/);
    }
    checks.push('visual text rows reorder late-painted split decimals and retain net/tax columns at all four page rotations');
    const scanned = await reader.convert({ inputPath: path.join(options.directory, 'scan.pdf'), outputDir: output });
    assert.equal(scanned.length, 1); assert.equal(scanned[0].text, '');
    const scanPixels = await sharp(scanned[0].path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...scanPixels.data.subarray(0, 3)], [35, 101, 151]);
    checks.push('scanned PDF: image renders with expected source colour and no invented text');
    const large = await reader.convert({ inputPath: path.join(options.directory, 'large.pdf'), outputDir: output });
    assert.ok(large[0].width * large[0].height <= 8000000);
    checks.push('oversized page is proportionally capped at eight million pixels');
    const beforeFailures = (await fs.readdir(output)).sort();
    for (const [name, pattern] of [['bad.pdf', /PDF|Invalid/i], ['encrypted.pdf', /加密|密码/], ['too-many.pdf', /100 页/]]) {
      await assert.rejects(reader.convert({ inputPath: path.join(options.directory, name), outputDir: output }), pattern);
      assert.deepEqual((await fs.readdir(output)).sort(), beforeFailures);
    }
    checks.push('invalid, encrypted and over-100-page PDFs fail without partial output');
    const controller = new AbortController();
    await assert.rejects(reader.convert({ inputPath: path.join(options.directory, 'text.pdf'), outputDir: output, signal: controller.signal,
      onProgress: event => { if (event.progress > 0) controller.abort(); } }), { name: 'AbortError' });
    assert.deepEqual((await fs.readdir(output)).sort(), beforeFailures);
    checks.push('cancellation after first saved page removes all pages from the cancelled file');
    const timedReader = createInvoicePdfReader({ BrowserWindow: TrackingWindow, ipcMain, timeoutMs: 1, requestTimeoutMs: 1 });
    await assert.rejects(timedReader.convert({ inputPath: path.join(options.directory, 'text.pdf'), outputDir: output }), /超时/);
    assert.deepEqual((await fs.readdir(output)).sort(), beforeFailures);
    assert.equal(timedReader.busy(), false);
    checks.push('timeout closes the renderer and leaves no partial page files');
    const probes = await Promise.all(securityProbes);
    assert.ok(probes.length >= 6 && probes.every(probe => probe.noNode && probe.noPaths && probe.blocked));
    assert.ok(windows.every(window => window.isDestroyed()));
    assert.equal(ipcMain.listenerCount('shitu:invoice-pdf-response'), 0);
    assert.equal(reader.busy(), false);
    checks.push('all renderer windows hidden/sandboxed, external fetch blocked, IPC and windows cleaned up');
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: true, checks, pages, scanned, large, securityProbes: probes.length }, null, 2));
    await reader.shutdown();
    app.exit(0);
  } catch (error) {
    await reader?.shutdown().catch(() => {});
    await fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ok: false, checks, error: error.stack || String(error) }, null, 2));
    app.exit(1);
  }
}

async function main() {
  const parent = path.join(root, '.recovery', 'tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'invoice-pdf-reader-'));
  await fs.writeFile(path.join(directory, 'text.pdf'), textPdf(2));
  for (const rotation of [0, 90, 180, 270]) await fs.writeFile(path.join(directory, `layout-${rotation}.pdf`), unorderedTextPdf(rotation));
  await fs.writeFile(path.join(directory, 'large.pdf'), textPdf(1, 8000, 8000));
  await fs.writeFile(path.join(directory, 'too-many.pdf'), textPdf(101));
  await fs.writeFile(path.join(directory, 'bad.pdf'), '%PDF-1.7\nbroken\n%%EOF');
  const encrypted = 'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGUwNWYwY2RiN2Y+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAzMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8YTgxN2MwMzIxY2ViOTJjMDQ3MDkyMDc2MTA0NjJkZjViZWIwMzJjYzBhYTQ4YTY3MGY5YWVmNTM3NTk2MzdkNj4KL1UgPDdjMTYwZjkwOWE2NDA0YTU0MzlkYTY5YmVjMzIxN2ZiMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDMzMzYzMDY0MzAzNzM0NjUzMjM3MzYzMDMzMzEzMTM2MzA2MzYzMzU2MTYxMzAzNzY0NjUzNzM0Mzc2MjYzNjU+IDwzMzM2MzA2NDMwMzczNDY1MzIzNzM2MzAzMzMxMzEzNjMwNjM2MzM1NjE2MTMwMzc2NDY1MzczNDM3NjI2MzY1PiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK';
  await fs.writeFile(path.join(directory, 'encrypted.pdf'), Buffer.from(encrypted, 'base64'));
  const scan = path.join(directory, 'scan.png'); await sharp({ create: { width: 120, height: 80, channels: 3, background: '#236597' } }).png().toFile(scan);
  await writeImagePdf({ inputPaths: [scan], outputPath: path.join(directory, 'scan.pdf') });
  const options = { root, directory };
  await fs.writeFile(path.join(directory, 'main.cjs'), `'use strict';const electron=require('electron');const path=require('node:path');electron.app.setName('Mosaic isolated PDF reader smoke');electron.app.setPath('userData',path.join(__dirname,'profile'));electron.app.setPath('sessionData',path.join(__dirname,'sessions'));electron.app.on('window-all-closed',()=>{});(${runElectron.toString()})(electron,${JSON.stringify(options)});setTimeout(()=>electron.app.exit(2),180000).unref();`);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'mosaic-pdf-reader-smoke', main: 'main.cjs' }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [directory], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`PDF reader smoke timed out: ${directory}`)); }, 190000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  console.log(JSON.stringify({ ...result, directory }, null, 2));
  if (exitCode !== 0 || !result.ok) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
module.exports = { textPdf, unorderedTextPdf };
