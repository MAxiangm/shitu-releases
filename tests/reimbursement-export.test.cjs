'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Library } = require('../src/library.cjs');
const { exportReimbursementBundle } = require('../src/reimbursement-export.cjs');

async function fixture(t) {
  const fixtures = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(fixtures, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtures, 'reimbursement-export-'));
  const library = new Library({ root: path.join(directory, 'library') }); await library.init();
  const destination = path.join(directory, 'exports'); await fs.mkdir(destination);
  const originals = [['申请表.xlsx', Buffer.from('Synthetic spreadsheet bytes')], ['发票.pdf', Buffer.from('%PDF-synthetic invoices')], ['补票.pdf', Buffer.from('%PDF-synthetic evidence')]];
  const paths = [];
  for (const [name, bytes] of originals) { const filename = path.join(directory, name); await fs.writeFile(filename, bytes); paths.push(filename); }
  const report = await library.importPaths(paths); assert.equal(report.imported, 3);
  t.after(async () => {
    await library.flush(); assert.equal(path.dirname(directory), fixtures);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const request = { library, assetIds: report.assetIds, destination, name: '合成测试公司-十一月报销' };
  return { directory, library, destination, originals, request };
}

test('bundle exports byte-identical originals to unique sibling folders without overwriting prior files', async t => {
  const f = await fixture(t), existing = path.join(f.destination, 'keep.txt'); await fs.writeFile(existing, 'keep');
  let checks = 0;
  const first = await exportReimbursementBundle({ ...f.request, assertCurrent: () => { checks++; } });
  const second = await exportReimbursementBundle(f.request);
  assert.equal(first.count, 3); assert.notEqual(first.path, second.path); assert.equal(path.dirname(first.path), f.destination);
  assert.equal(path.basename(first.path), '合成测试公司-十一月报销_报销资料');
  assert.equal(path.basename(second.path), '合成测试公司-十一月报销_报销资料（2）'); assert.ok(checks >= 3);
  for (const result of [first, second]) for (const [name, bytes] of f.originals) assert.deepEqual(await fs.readFile(path.join(result.path, name)), bytes);
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep');
  for (const asset of f.library.snapshot().assets) await fs.access(f.library.getAssetPath(asset.id));
});

test('bundle validates inputs and rejects library destinations including directory aliases', async t => {
  const f = await fixture(t);
  for (const destination of [null, '', 'relative/path', f.library.root, path.join(f.library.root, 'originals')]) await assert.rejects(exportReimbursementBundle({ ...f.request, destination }));
  const alias = path.join(f.directory, 'linked-library'); await fs.symlink(f.library.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exportReimbursementBundle({ ...f.request, destination: alias }), /素材库以外/);
  for (const assetIds of [[], ['bad/path'], [f.request.assetIds[0], f.request.assetIds[0]]]) await assert.rejects(exportReimbursementBundle({ ...f.request, assetIds }), /报销文件/);
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('outside destination aliases resolve to their real location and unsafe names remain single directory names', async t => {
  const f = await fixture(t), alias = path.join(f.directory, 'linked-exports');
  await fs.symlink(f.destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await exportReimbursementBundle({ ...f.request, destination: alias, name: '../公司:一/二*' });
  assert.equal(path.dirname(result.path), f.destination); assert.match(path.basename(result.path), /_报销资料$/);
  assert.equal(result.count, 3);
});

test('stale before creation and stale before export leave no output directory', async t => {
  const f = await fixture(t);
  for (const threshold of [1, 2, 3]) {
    let checks = 0;
    await assert.rejects(exportReimbursementBundle({ ...f.request, assertCurrent: () => { if (++checks === threshold) throw new Error('stale fixture'); } }), /stale fixture/);
    assert.deepEqual(await fs.readdir(f.destination), []);
  }
});

test('a failed core export rolls back owned files and the helper removes only its empty child', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.library.getAssetPath(f.request.assetIds[1]), 'changed bytes');
  await assert.rejects(exportReimbursementBundle(f.request), /原件|变化|大小|校验/);
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('failure preserves unknown external files and does not recursively delete the export folder', async t => {
  const f = await fixture(t); let output;
  const library = { root: f.library.root, async exportAssets(_ids, directory) { output = directory; await fs.writeFile(path.join(directory, 'external.txt'), 'external'); throw new Error('fixture export failed'); } };
  await assert.rejects(exportReimbursementBundle({ ...f.request, library }), /fixture export failed/);
  assert.equal(await fs.readFile(path.join(output, 'external.txt'), 'utf8'), 'external');
});

test('late stale check removes only this export and its empty folder', async t => {
  const f = await fixture(t); let checks = 0;
  await assert.rejects(exportReimbursementBundle({ ...f.request, assertCurrent: () => { if (++checks === 4) throw new Error('late stale'); } }), /late stale/);
  assert.deepEqual(await fs.readdir(f.destination), []);
  for (const id of f.request.assetIds) await fs.access(f.library.getAssetPath(id));
});

test('cleanup refuses an export child replaced with a directory junction', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'safe');
  let output;
  const library = { root: f.library.root, async exportAssets(_ids, directory) {
    output = directory; await fs.rmdir(directory); await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir'); throw new Error('changed directory');
  } };
  await assert.rejects(exportReimbursementBundle({ ...f.request, library }), /changed directory/);
  assert.equal((await fs.lstat(output)).isSymbolicLink(), true); assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'safe');
});

test('cancellation is forwarded to the core exporter and removes only an empty new child', async t => {
  const f = await fixture(t), controller = new AbortController(); let forwarded;
  const library = { root: f.library.root, async exportAssets(_ids, _directory, options) { forwarded = options.signal; controller.abort(); options.signal.throwIfAborted(); } };
  await assert.rejects(exportReimbursementBundle({ ...f.request, library, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(forwarded, controller.signal); assert.deepEqual(await fs.readdir(f.destination), []);
  await assert.rejects(exportReimbursementBundle({ ...f.request, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('existing files and directories are preserved while numbering skips to the next available name', async t => {
  const f = await fixture(t), base = `${f.request.name}_报销资料`;
  await fs.mkdir(path.join(f.destination, base));
  await fs.writeFile(path.join(f.destination, base, 'keep.txt'), 'earlier export');
  await fs.writeFile(path.join(f.destination, `${base}（2）`), 'an unrelated file');
  const result = await exportReimbursementBundle(f.request);
  assert.equal(path.basename(result.path), `${base}（3）`);
  assert.equal(await fs.readFile(path.join(f.destination, base, 'keep.txt'), 'utf8'), 'earlier export');
  assert.equal(await fs.readFile(path.join(f.destination, `${base}（2）`), 'utf8'), 'an unrelated file');
});

test('concurrent requests reserve distinct readable folders atomically', async t => {
  const f = await fixture(t), base = `${f.request.name}_报销资料`;
  const results = await Promise.all([exportReimbursementBundle(f.request), exportReimbursementBundle(f.request)]);
  assert.deepEqual(new Set(results.map(result => path.basename(result.path))), new Set([base, `${base}（2）`]));
  for (const result of results) for (const [name, bytes] of f.originals) assert.deepEqual(await fs.readFile(path.join(result.path, name)), bytes);
});

test('cancellation after a completed export removes captured file identities and the empty child', async t => {
  const f = await fixture(t), controller = new AbortController(); let checks = 0;
  await assert.rejects(exportReimbursementBundle({ ...f.request, signal: controller.signal, assertCurrent: () => { if (++checks === 4) controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('late rollback preserves an external replacement and addition while removing unchanged exported files', async t => {
  const f = await fixture(t); let checks = 0, output;
  await assert.rejects(exportReimbursementBundle({ ...f.request, assertCurrent: async () => {
    if (++checks !== 4) return;
    output = path.join(f.destination, (await fs.readdir(f.destination))[0]);
    await fs.rename(path.join(output, f.originals[0][0]), path.join(f.directory, 'displaced-export.xlsx'));
    await fs.writeFile(path.join(output, f.originals[0][0]), 'external replacement');
    await fs.writeFile(path.join(output, 'new-user-file.txt'), 'external addition');
    throw new Error('late changed source');
  } }), /late changed source/);
  assert.deepEqual((await fs.readdir(output)).sort(), [f.originals[0][0], 'new-user-file.txt'].sort());
  assert.equal(await fs.readFile(path.join(output, f.originals[0][0]), 'utf8'), 'external replacement');
  assert.equal(await fs.readFile(path.join(output, 'new-user-file.txt'), 'utf8'), 'external addition');
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'displaced-export.xlsx')), f.originals[0][1]);
});

test('late rollback preserves externally edited files even when their filesystem identity remains unchanged', async t => {
  const f = await fixture(t); let checks = 0, output;
  await assert.rejects(exportReimbursementBundle({ ...f.request, assertCurrent: async () => {
    if (++checks !== 4) return;
    output = path.join(f.destination, (await fs.readdir(f.destination))[0]);
    await fs.appendFile(path.join(output, f.originals[0][0]), '\nexternal edit');
    throw new Error('late edit');
  } }), /late edit/);
  assert.deepEqual(await fs.readdir(output), [f.originals[0][0]]);
  assert.ok((await fs.readFile(path.join(output, f.originals[0][0]), 'utf8')).endsWith('external edit'));
});

test('late rollback never follows an export root replaced by a junction', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'external-directory'), displaced = path.join(f.directory, 'displaced-export');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, f.originals[0][0]), 'external protected');
  let checks = 0, output;
  await assert.rejects(exportReimbursementBundle({ ...f.request, assertCurrent: async () => {
    if (++checks !== 4) return;
    output = path.join(f.destination, (await fs.readdir(f.destination))[0]);
    await fs.rename(output, displaced);
    await fs.symlink(outside, output, process.platform === 'win32' ? 'junction' : 'dir');
    throw new Error('late junction');
  } }), /late junction/);
  assert.equal((await fs.lstat(output)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(outside, f.originals[0][0]), 'utf8'), 'external protected');
  for (const [name, bytes] of f.originals) assert.deepEqual(await fs.readFile(path.join(displaced, name)), bytes);
});

test('listed directory outputs are preserved without recursive traversal on a late failure', async t => {
  const f = await fixture(t); let checks = 0, output;
  const library = { root: f.library.root, async exportAssets(ids, directory) {
    output = directory; const bundled = path.join(directory, 'model-package'); await fs.mkdir(bundled);
    await fs.writeFile(path.join(bundled, 'unknown-original.obj'), 'retained bundle');
    return { exported: ids.length, files: [bundled] };
  } };
  await assert.rejects(exportReimbursementBundle({ ...f.request, library, assertCurrent: () => { if (++checks === 4) throw new Error('late bundle'); } }), /late bundle/);
  assert.equal(await fs.readFile(path.join(output, 'model-package', 'unknown-original.obj'), 'utf8'), 'retained bundle');
});
