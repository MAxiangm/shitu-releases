'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Library } = require('../src/library.cjs');
const ReimbursementFolders = require('../src/reimbursement-folders.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'reimbursement-library-'));
  t.after(async () => {
    const relative = path.relative(parent, directory);
    assert.ok(relative.startsWith('reimbursement-library-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  let thumbnailCalls = 0;
  const library = new Library({ root: path.join(directory, 'library'), createThumbnail: async (_source, destination) => {
    thumbnailCalls++;
    await sharp({ create: { width: 64, height: 80, channels: 3, background: '#345678' } }).jpeg().toFile(destination);
    return { width: 64, height: 80 };
  } });
  await library.init();
  const source = async (name, bytes) => { const filename = path.join(directory, name); await fs.writeFile(filename, bytes); return filename; };
  const form = (label = 'initial') => Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.from(`test spreadsheet ${label}`)]);
  const pdf = (label = 'initial') => Buffer.from(`%PDF-1.4\n${label}\n%%EOF\n`);
  return { directory, library, source, form, pdf, get thumbnailCalls() { return thumbnailCalls; } };
}
const rootOf = (snapshot, id) => snapshot.folders.find(folder => folder.id === id);
const assetOf = (snapshot, id) => snapshot.assets.find(asset => asset.id === id);
const pending = async library => (await fs.readdir(library.root)).filter(name => name.startsWith('.pending-reimbursement-'));

test('creates a typed root and five default categories in one atomic save and reloads metadata', async t => {
  const { library } = await fixture(t);
  const parent = (await library.createFolder('项目')).folders[0];
  const persist = library._persist.bind(library); let calls = 0;
  library._persist = async data => { calls++; return persist(data); };
  const { snapshot, folderId } = await library.createReimbursementFolder('11月报销', parent.id);
  assert.equal(calls, 1);
  const folder = rootOf(snapshot, folderId);
  assert.equal(folder.kind, 'reimbursement'); assert.equal(folder.parentId, parent.id);
  assert.deepEqual(Object.keys(folder.reimbursement), ['version', 'categoryIds', 'formAssetId', 'supplementPdfAssetId', 'invoicePdfAssetId', 'supplementInvoicePdfAssetId', 'itineraryFolderId', 'itineraryPdfAssetId']);
  assert.equal(folder.reimbursement.formAssetId, null); assert.equal(folder.reimbursement.supplementPdfAssetId, null);
  assert.equal(folder.reimbursement.invoicePdfAssetId, null);
  assert.equal(folder.reimbursement.supplementInvoicePdfAssetId, null);
  assert.deepEqual(ReimbursementFolders.invoicePdfOptions(folder.reimbursement.invoicePdfOptions), { imagesPerPage: 2 });
  const children = snapshot.folders.filter(child => child.parentId === folderId);
  assert.deepEqual(children.map(child => child.name), ['出行', '设备', '会员', '其他', '补票']);
  assert.deepEqual(children.map(child => child.sortOrder), [0, 1, 2, 3, 4]);
  for (const child of children) {
    assert.equal(folder.reimbursement.categoryIds[child.reimbursementCategory], child.id);
    assert.equal(child.reimbursementRootId, folderId);
    assert.equal(ReimbursementFolders.findRoot(snapshot.folders, child.id).id, folderId);
    assert.equal(ReimbursementFolders.categoryForFolder(snapshot.folders, child.id), child.reimbursementCategory);
  }
  const reopened = new Library({ root: library.root });
  assert.deepEqual((await reopened.init()).folders, snapshot.folders);
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  library._persist = async () => { throw new Error('save denied'); };
  await assert.rejects(library.createReimbursementFolder('失败'), /save denied/);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
});

test('categories support native rename and ordering while external moves and direct deletion stay protected', async t => {
  const { library } = await fixture(t);
  const { folderId } = await library.createReimbursementFolder('报销');
  const root = rootOf(library.snapshot(), folderId), ids = root.reimbursement.categoryIds;
  const before = library.snapshot();
  await assert.rejects(library.moveFolder(ids.travel, null), /不能移出/);
  await assert.rejects(library.deleteFolder(ids.travel), /不能单独删除/);
  assert.deepEqual(library.snapshot(), before);
  await library.renameFolder(ids.travel, '交通', { recordHistory: true });
  assert.equal(rootOf(library.snapshot(), ids.travel).name, '交通');
  assert.equal(rootOf(library.snapshot(), folderId).reimbursement.categoryIds.travel, ids.travel);
  assert.equal(ReimbursementFolders.listCategories(library.snapshot().folders, rootOf(library.snapshot(), folderId))[0].name, '交通');
  await library.undo();
  assert.equal(rootOf(library.snapshot(), ids.travel).name, '出行');
  await library.moveFolder(ids.supplement, folderId, { beforeId: ids.travel, recordHistory: true });
  assert.equal(ReimbursementFolders.listCategories(library.snapshot().folders, folderId)[0].key, 'supplement');
  await library.undo();
  assert.equal(ReimbursementFolders.listCategories(library.snapshot().folders, folderId)[0].key, 'travel');
  assert.equal(ReimbursementFolders.categoryForFolder(library.snapshot().folders, ids.supplement), 'supplement');
  await library.renameFolder(folderId, '已改名', { recordHistory: true });
  await library.undo(); assert.equal(rootOf(library.snapshot(), folderId).name, '报销');
  const elsewhere = (await library.createFolder('归档')).folders.at(-1);
  await library.moveFolder(folderId, elsewhere.id, { recordHistory: true });
  assert.equal(rootOf(library.snapshot(), folderId).parentId, elsewhere.id);
  await library.undo(); assert.equal(rootOf(library.snapshot(), folderId).parentId, null);
});

test('supplement subtrees accept images and PDF through imports and moves but reject other documents', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const ids = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  const nested = (await library.createFolder('截图', ids.supplement)).folders.at(-1);
  const imageBytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  const image = await f.source('receipt.png', imageBytes), invoice = await f.source('invoice.pdf', f.pdf()), document = await f.source('notes.docx', f.form());
  const result = await library.importPaths([image, invoice, document], { folderId: nested.id });
  assert.equal(result.imported, 2); assert.equal(result.errors.length, 1); assert.match(result.errors[0].message, /只接受图片或 PDF/);
  const invoiceId = result.assetIds.find(id => assetOf(library.snapshot(), id).ext === 'pdf');
  await library.moveAssetsToFolder([invoiceId], ids.other);
  await library.updateAssets([invoiceId], { folderId: ids.supplement });
  assert.equal(assetOf(library.snapshot(), invoiceId).folderId, ids.supplement);
  const { assetIds: [docId] } = await library.importPaths([document], { folderId: ids.other });
  await assert.rejects(library.moveAssetsToFolder([docId], ids.supplement), /只接受图片或 PDF/);
  await assert.rejects(library.updateAssets([docId], { folderId: nested.id }), /只接受图片或 PDF/);
  const ordinary = (await library.createFolder('普通')).folders.at(-1);
  await library.moveAssetsToFolder([docId], ordinary.id);
  await assert.rejects(library.moveFolder(ordinary.id, ids.supplement), /只接受图片或 PDF/);
});

test('generated documents keep stable IDs, reuse covers and do not deduplicate into other originals or roots', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销一');
  const { folderId: otherRoot } = await library.createReimbursementFolder('报销二');
  const firstBytes = f.form('first'), changedBytes = f.form('updated');
  const source = await f.source('form.xlsx', firstBytes), changed = await f.source('changed.xlsx', changedBytes);
  const { assetIds: [normalId] } = await library.importPaths([source]);
  const unrelatedBefore = await fs.readFile(library.getAssetPath(normalId));
  const created = await library.upsertReimbursementDocument(folderId, 'form', source, '报销申请表');
  const id = created.assetId;
  assert.notEqual(id, normalId);
  assert.equal(rootOf(created.snapshot, folderId).reimbursement.formAssetId, id);
  assert.deepEqual(assetOf(created.snapshot, id).reimbursementGenerated, { rootId: folderId, kind: 'form' });
  const first = assetOf(created.snapshot, id), cover = await fs.readFile(library.getAssetPath(id, 'thumbnail')), calls = f.thumbnailCalls;
  await library.updateAssets([id], { tags: ['报销'], notes: '保留备注', rating: 3 });
  const updated = await library.upsertReimbursementDocument(folderId, 'form', changed, '新的申请表');
  assert.equal(updated.assetId, id); assert.equal(f.thumbnailCalls, calls);
  const asset = assetOf(updated.snapshot, id);
  assert.equal(asset.name, '新的申请表'); assert.equal(asset.hash, hash(changedBytes)); assert.equal(asset.size, changedBytes.length);
  assert.equal(asset.createdAt, first.createdAt); assert.deepEqual(asset.tags, ['报销']); assert.equal(asset.notes, '保留备注'); assert.equal(asset.rating, 3);
  assert.deepEqual(await fs.readFile(library.getAssetPath(id)), changedBytes);
  assert.deepEqual(await fs.readFile(library.getAssetPath(id, 'thumbnail')), cover);
  const second = await library.upsertReimbursementDocument(otherRoot, 'form', changed, '另一个报销表');
  assert.notEqual(second.assetId, id);
  assert.deepEqual(await fs.readFile(library.getAssetPath(normalId)), unrelatedBefore);
  assert.deepEqual(await fs.readFile(source), firstBytes);
  assert.deepEqual(await pending(library), []);
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.deepEqual(reopened.snapshot().folders, library.snapshot().folders);
  assert.deepEqual(reopened.snapshot().assets, library.snapshot().assets);
  const exported = await library.exportFolder(folderId, path.join(f.directory, 'exports'));
  assert.equal(exported.exported, 1); assert.deepEqual(await fs.readFile(exported.files[0]), changedBytes);
});

test('new and regenerated documents roll back original bytes, covers, pointers and index on persistence failures', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const source = await f.source('first.xlsx', f.form('first')), changed = await f.source('changed.xlsx', f.form('second'));
  const persist = library._persist.bind(library), before = library.snapshot(), index = await fs.readFile(library.indexPath);
  library._persist = async () => { throw new Error('disk denied'); };
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'form', source, '申请表'), /disk denied/);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  assert.deepEqual(await fs.readdir(path.join(library.root, 'originals')), []);
  assert.deepEqual(await fs.readdir(path.join(library.root, 'thumbnails')), []);
  assert.deepEqual(await pending(library), []);
  library._persist = persist;
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'form', source, '申请表');
  const original = await fs.readFile(library.getAssetPath(assetId)), cover = await fs.readFile(library.getAssetPath(assetId, 'thumbnail'));
  const snapshot = library.snapshot(), saved = await fs.readFile(library.indexPath);
  library._persist = async () => { throw new Error('disk denied'); };
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'form', changed, '修改'), /disk denied/);
  assert.deepEqual(library.snapshot(), snapshot); assert.deepEqual(await fs.readFile(library.indexPath), saved);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId)), original);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId, 'thumbnail')), cover);
  await assert.rejects(library.clearReimbursementDocument(folderId, 'form'), /disk denied/);
  assert.deepEqual(library.snapshot(), snapshot);
  assert.deepEqual(await pending(library), []);
});

test('clear only trashes the generated document, regeneration restores its ID, and root deletion preserves originals', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const file = await f.source('supplement.pdf', f.pdf('screenshots'));
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'supplementPdf', file, '补票截图');
  const original = await fs.readFile(library.getAssetPath(assetId));
  const cleared = await library.clearReimbursementDocument(folderId, 'supplementPdf');
  assert.equal(rootOf(cleared, folderId).reimbursement.supplementPdfAssetId, null);
  assert.ok(assetOf(cleared, assetId).trashedAt);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId)), original);
  assert.equal((await library.upsertReimbursementDocument(folderId, 'supplementPdf', file, '新补票截图')).assetId, assetId);
  assert.equal(assetOf(library.snapshot(), assetId).trashedAt, null);
  await library.deleteFolder(folderId);
  assert.equal(assetOf(library.snapshot(), assetId).folderId, null);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId)), original);
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.equal(assetOf(reopened.snapshot(), assetId).reimbursementGenerated.rootId, folderId);
});

test('a permanently deleted generated document pointer can be regenerated without taking over other assets', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const file = await f.source('form.xlsx', f.form());
  const first = await library.upsertReimbursementDocument(folderId, 'form', file, '申请表');
  await library.setTrash([first.assetId], true); await library.deletePermanently([first.assetId]);
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.equal(rootOf(reopened.snapshot(), folderId).reimbursement.formAssetId, first.assetId);
  const next = await reopened.upsertReimbursementDocument(folderId, 'form', file, '申请表');
  assert.notEqual(next.assetId, first.assetId); assert.equal(next.snapshot.assets.length, 1);
});

test('reopening recovers interrupted replacement and completes cleanup of an already committed document', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const first = await f.source('first.xlsx', f.form('old')), next = await f.source('next.xlsx', f.form('new'));
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'form', first, '旧表');
  const oldBytes = await fs.readFile(library.getAssetPath(assetId));
  library._persist = async () => { throw new Error('interrupted before index'); };
  library._recoverReimbursementDocument = async () => { throw new Error('simulated process stop'); };
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'form', next, '新表'), /interrupted before index/);
  assert.equal((await pending(library)).length, 1);
  const recovered = new Library({ root: library.root }); await recovered.init();
  assert.deepEqual(await fs.readFile(recovered.getAssetPath(assetId)), oldBytes); assert.deepEqual(await pending(recovered), []);
  recovered._recoverReimbursementDocument = async () => { throw new Error('cleanup interrupted'); };
  const saved = await recovered.upsertReimbursementDocument(folderId, 'form', next, '新表');
  assert.match(saved.warning, /暂存文件/); assert.equal((await pending(recovered)).length, 1);
  const committed = new Library({ root: recovered.root }); await committed.init();
  assert.equal(assetOf(committed.snapshot(), assetId).name, '新表');
  assert.deepEqual(await fs.readFile(committed.getAssetPath(assetId)), f.form('new'));
  assert.deepEqual(await pending(committed), []);
});

test('corrupt typed metadata and externally changed originals are rejected without overwriting user files', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const source = await f.source('form.xlsx', f.form());
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'form', source, '表');
  const changed = Buffer.from('user edited this original'); await fs.writeFile(library.getAssetPath(assetId), changed);
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'form', source, '表'), /原文档已变化/);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId)), changed);
  const data = structuredClone(library.data);
  data.folders.find(folder => folder.id === folderId).reimbursement.categoryIds.travel = 'unknown';
  await fs.writeFile(library.indexPath, JSON.stringify(data));
  const bytes = await fs.readFile(library.indexPath);
  await assert.rejects(new Library({ root: library.root }).init(), /报销分类/);
  assert.deepEqual(await fs.readFile(library.indexPath), bytes);
});

test('explicit expected hash safely updates an externally edited workbook and preserves those bytes on rollback', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const old = await f.source('original.xlsx', f.form('original')), next = await f.source('next.xlsx', f.form('next'));
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'form', old, '申请表');
  const originalPath = library.getAssetPath(assetId), edited = f.form('user-entered expense rows');
  await fs.writeFile(originalPath, edited);
  const before = library.snapshot(), index = await fs.readFile(library.indexPath), persist = library._persist.bind(library);
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'form', next, '申请表', { expectedExistingHash: hash(f.form('original')) }), /原文档已变化/);
  assert.deepEqual(await fs.readFile(originalPath), edited);
  library._persist = async () => { throw new Error('save failed after reading workbook'); };
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'form', next, '申请表', { expectedExistingHash: hash(edited) }), /save failed/);
  assert.deepEqual(await fs.readFile(originalPath), edited);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  assert.deepEqual(await pending(library), []);
  library._persist = persist;
  const updated = await library.upsertReimbursementDocument(folderId, 'form', next, '申请表', { expectedExistingHash: hash(edited) });
  assert.equal(updated.assetId, assetId);
  assert.equal(assetOf(updated.snapshot, assetId).hash, hash(f.form('next')));
  assert.deepEqual(await fs.readFile(originalPath), f.form('next'));
});

test('restarting restores externally edited workbook bytes after an interrupted expected-hash update', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const first = await f.source('first.xlsx', f.form('first')), next = await f.source('next.xlsx', f.form('next'));
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'form', first, '申请表');
  const edited = f.form('edited in Excel'); await fs.writeFile(library.getAssetPath(assetId), edited);
  library._persist = async () => { throw new Error('interrupted save'); };
  library._recoverReimbursementDocument = async () => { throw new Error('simulated process stop'); };
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'form', next, '申请表', { expectedExistingHash: hash(edited) }), /interrupted save/);
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.deepEqual(await fs.readFile(reopened.getAssetPath(assetId)), edited);
  assert.equal(assetOf(reopened.snapshot(), assetId).hash, hash(f.form('first')));
  assert.deepEqual(await pending(reopened), []);
});

test('typed metadata rejects malformed category maps, pointers and generated-document ownership', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'form', await f.source('form.xlsx', f.form('generated')), '表');
  const { assetIds: [ordinaryId] } = await library.importPaths([await f.source('ordinary.xlsx', f.form('ordinary'))]);
  const cases = [
    data => { rootOf(data, folderId).reimbursement.version = 2; },
    data => { rootOf(data, folderId).reimbursement.formAssetId = 12; },
    data => { rootOf(data, folderId).reimbursement.formAssetId = ordinaryId; },
    data => { rootOf(data, folderId).reimbursement.categoryIds.bad = 'extra'; },
    data => { delete rootOf(data, folderId).reimbursement.categoryIds.travel; },
    data => { rootOf(data, rootOf(data, folderId).reimbursement.categoryIds.travel).reimbursementCategory = 'other'; },
    data => { assetOf(data, assetId).reimbursementGenerated.kind = 'unknown'; },
    data => { assetOf(data, assetId).reimbursementGenerated.unexpected = true; }
  ];
  for (const mutate of cases) {
    const data = structuredClone(library.data); mutate(data);
    assert.throws(() => library._validate(data), /报销/);
  }
  const root = rootOf(library.snapshot(), folderId);
  const nested = (await library.createFolder('明细截图', root.reimbursement.categoryIds.supplement)).folders.at(-1);
  const categories = ReimbursementFolders.categoryMap(library.snapshot().folders);
  assert.equal(categories.get(folderId), null); assert.equal(categories.get(nested.id), 'supplement');
});

test('updating categories preserves existing IDs, creates custom categories and promotes removed contents without changing files', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const oldIds = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  const directFile = await f.source('equipment.pdf', f.pdf('equipment receipt'));
  const { assetIds: [directId] } = await library.importPaths([directFile], { folderId: oldIds.equipment });
  await library.setTrash([directId], true);
  const child = (await library.createFolder('附属目录', oldIds.other)).folders.at(-1);
  const grandchild = (await library.createFolder('下层', child.id)).folders.at(-1);
  const nestedFile = await f.source('nested.pdf', f.pdf('nested receipt'));
  const { assetIds: [nestedId] } = await library.importPaths([nestedFile], { folderId: grandchild.id });
  const originals = new Map(await Promise.all([directId, nestedId].map(async id => [id, await fs.readFile(library.getAssetPath(id))])));
  const desired = [{ key: 'membership', name: '软件服务' }, { key: 'travel', name: '交通' }, { key: 'books', name: '书籍' }, { key: 'supplement', name: '缺票截图' }];
  const changed = await library.updateReimbursementCategories(folderId, desired);
  const root = rootOf(changed, folderId), ids = root.reimbursement.categoryIds;
  assert.equal(ids.membership, oldIds.membership); assert.equal(ids.travel, oldIds.travel); assert.equal(ids.supplement, oldIds.supplement);
  assert.ok(ids.books && !Object.values(oldIds).includes(ids.books));
  assert.deepEqual(Object.keys(ids), desired.map(category => category.key));
  assert.deepEqual(ReimbursementFolders.listCategories(changed.folders, root).map(({ key, name }) => ({ key, name })), desired);
  assert.deepEqual(desired.map(category => rootOf(changed, ids[category.key]).sortOrder), [0, 1, 2, 3]);
  assert.equal(rootOf(changed, oldIds.equipment), undefined); assert.equal(rootOf(changed, oldIds.other), undefined);
  assert.equal(assetOf(changed, directId).folderId, folderId); assert.ok(assetOf(changed, directId).trashedAt);
  assert.equal(rootOf(changed, child.id).parentId, folderId); assert.equal(rootOf(changed, grandchild.id).parentId, child.id);
  assert.equal(assetOf(changed, nestedId).folderId, grandchild.id);
  for (const [id, bytes] of originals) assert.deepEqual(await fs.readFile(library.getAssetPath(id)), bytes);
  const reopened = new Library({ root: library.root });
  assert.deepEqual((await reopened.init()).folders, changed.folders);
  const emptied = await reopened.updateReimbursementCategories(folderId, []);
  assert.deepEqual(rootOf(emptied, folderId).reimbursement.categoryIds, {});
  assert.deepEqual(ReimbursementFolders.listCategories(emptied.folders, folderId), []);
  assert.equal(rootOf(emptied, child.id).parentId, folderId);
  for (const [id, bytes] of originals) assert.deepEqual(await fs.readFile(reopened.getAssetPath(id)), bytes);
  const noCategories = new Library({ root: library.root });
  assert.deepEqual(rootOf(await noCategories.init(), folderId).reimbursement.categoryIds, {});
});

test('supplement is a stable optional role independent of its display name and can be removed and recreated', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const originalId = rootOf(library.snapshot(), folderId).reimbursement.categoryIds.supplement;
  await library.updateReimbursementCategories(folderId, [{ key: 'supplement', name: '购物凭据截图' }, { key: 'evidence', name: '补票' }]);
  let ids = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  assert.equal(ids.supplement, originalId);
  assert.equal(ReimbursementFolders.categoryForFolder(library.snapshot().folders, ids.supplement), 'supplement');
  const file = await f.source('receipt.docx', f.form('ordinary custom category'));
  assert.equal((await library.importPaths([file], { folderId: ids.evidence })).imported, 1);
  const rejected = await library.importPaths([file], { folderId: ids.supplement });
  assert.equal(rejected.errors.length, 1); assert.match(rejected.errors[0].message, /只接受图片或 PDF/);
  await library.updateReimbursementCategories(folderId, [{ key: 'evidence', name: '补票' }]);
  assert.equal(rootOf(library.snapshot(), originalId), undefined);
  await library.updateReimbursementCategories(folderId, [{ key: 'supplement', name: '新截图' }, { key: 'evidence', name: '凭证' }]);
  ids = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  assert.notEqual(ids.supplement, originalId);
  assert.equal(ReimbursementFolders.categoryForFolder(library.snapshot().folders, ids.evidence), 'evidence');
  assert.equal(ReimbursementFolders.categoryForFolder(library.snapshot().folders, ids.supplement), 'supplement');
});

test('custom category updates reject collisions, invalid keys and failed writes atomically', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const ids = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  const child = (await library.createFolder('冲突', ids.other)).folders.at(-1);
  const receiptBytes = f.pdf('keep on failed category save'), receipt = await f.source('retained.pdf', receiptBytes);
  const { assetIds: [receiptId] } = await library.importPaths([receipt], { folderId: ids.other });
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  const invalid = [null, [{ key: 'Bad', name: '大写' }], [{ key: 'a/b', name: '路径' }], [{ key: '', name: '空' }],
    [{ key: 'a'.repeat(65), name: '过长' }], [{ key: '__proto__', name: '原型' }], [{ key: 'x', name: ' ' }],
    [{ key: 'x', name: 'a'.repeat(101) }], [{ key: 'x', name: '同名' }, { key: 'y', name: '同名' }],
    [{ key: 'x', name: '甲' }, { key: 'x', name: '乙' }], Array.from({ length: 31 }, (_, i) => ({ key: `k${i}`, name: `类${i}` }))];
  for (const value of invalid) {
    await assert.rejects(library.updateReimbursementCategories(folderId, value));
    assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  }
  await assert.rejects(library.updateReimbursementCategories(folderId, [{ key: 'new', name: '冲突' }]), /同级文件夹/);
  assert.equal(rootOf(library.snapshot(), child.id).parentId, ids.other);
  const persist = library._persist.bind(library);
  library._persist = async () => { throw new Error('category save denied'); };
  await assert.rejects(library.updateReimbursementCategories(folderId, [{ key: 'custom', name: '自定义' }]), /category save denied/);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  assert.equal(assetOf(library.snapshot(), receiptId).folderId, ids.other);
  assert.deepEqual(await fs.readFile(library.getAssetPath(receiptId)), receiptBytes);
  library._persist = persist;
  const maximum = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, name: `类${i}` }));
  await library.updateReimbursementCategories(folderId, maximum);
  assert.equal(ReimbursementFolders.listCategories(library.snapshot().folders, folderId).length, 30);
  await library.updateReimbursementCategories(folderId, []);
  assert.equal(ReimbursementFolders.listCategories(library.snapshot().folders, folderId).length, 0);
});

test('custom category names can swap, no-op updates preserve the index, and list order uses mapping order for ties', async t => {
  const { library } = await fixture(t), { folderId } = await library.createReimbursementFolder('报销');
  const ids = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  const initial = ReimbursementFolders.listCategories(library.snapshot().folders, folderId).map(({ key, name }) => ({ key, name }));
  const index = await fs.readFile(library.indexPath);
  await library.updateReimbursementCategories(folderId, initial);
  assert.deepEqual(await fs.readFile(library.indexPath), index);
  const swapped = await library.updateReimbursementCategories(folderId, [{ key: 'travel', name: '设备' }, { key: 'equipment', name: '出行' }]);
  assert.equal(rootOf(swapped, ids.travel).name, '设备'); assert.equal(rootOf(swapped, ids.equipment).name, '出行');
  const tied = structuredClone(swapped.folders);
  tied.find(folder => folder.id === ids.travel).sortOrder = 0;
  tied.find(folder => folder.id === ids.equipment).sortOrder = 0;
  assert.deepEqual(ReimbursementFolders.listCategories(tied, folderId).map(category => category.key), ['travel', 'equipment']);
});

test('category names reject non-XML characters through management, native rename and persisted validation', async t => {
  const { library } = await fixture(t), { folderId } = await library.createReimbursementFolder('报销');
  const categoryId = rootOf(library.snapshot(), folderId).reimbursement.categoryIds.travel;
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  for (const name of ['出\0行', '出\n行', '\t出行', '出行\r', '出\x7f行', '出\ud800行', '出\udfff行', '出\ufffe行', '出\uffff行']) {
    await assert.rejects(library.updateReimbursementCategories(folderId, [{ key: 'travel', name }]), /分类名称包含无效字符/);
    await assert.rejects(library.renameFolder(categoryId, name), /分类名称包含无效字符/);
    const corrupted = structuredClone(library.data); rootOf(corrupted, categoryId).name = name;
    assert.throws(() => library._validate(corrupted), /分类名称包含无效字符/);
    assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  }
  await library.renameFolder(categoryId, '出行 🚄');
  assert.equal(rootOf(library.snapshot(), categoryId).name, '出行 🚄');
  const ordinary = (await library.createFolder('普通')).folders.at(-1);
  await library.renameFolder(ordinary.id, '原有\n普通规则');
  assert.equal(rootOf(library.snapshot(), ordinary.id).name, '原有\n普通规则');
});

test('unchanged generated workbook refreshes metadata under a rename lock while changed contents fail without loss', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const bytes = f.form('unchanged'), source = await f.source('same.xlsx', bytes), changed = await f.source('changed.xlsx', f.form('different'));
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'form', source, '申请表');
  const originalPath = library.getAssetPath(assetId), rename = fs.rename;
  let originalRenameCalls = 0;
  fs.rename = async (from, to) => {
    if (from === originalPath) {
      originalRenameCalls++;
      throw Object.assign(new Error('workbook is locked'), { code: 'EBUSY' });
    }
    return rename(from, to);
  };
  try {
    const renamed = await library.upsertReimbursementDocument(folderId, 'form', source, '申请表新名称');
    assert.equal(renamed.assetId, assetId); assert.equal(assetOf(renamed.snapshot, assetId).name, '申请表新名称');
    assert.equal(originalRenameCalls, 0); assert.deepEqual(await fs.readFile(originalPath), bytes);
    const index = await fs.readFile(library.indexPath);
    await library.upsertReimbursementDocument(folderId, 'form', source, '申请表新名称');
    assert.deepEqual(await fs.readFile(library.indexPath), index, 'unchanged metadata should not rewrite the index');
    await library.clearReimbursementDocument(folderId, 'form');
    const restored = await library.upsertReimbursementDocument(folderId, 'form', source, '申请表新名称');
    assert.equal(restored.assetId, assetId); assert.equal(assetOf(restored.snapshot, assetId).trashedAt, null);
    assert.equal(rootOf(restored.snapshot, folderId).reimbursement.formAssetId, assetId);
    assert.equal(originalRenameCalls, 0);
    const before = library.snapshot(), saved = await fs.readFile(library.indexPath);
    await assert.rejects(library.upsertReimbursementDocument(folderId, 'form', changed, '不同内容'), { code: 'EBUSY' });
    assert.equal(originalRenameCalls, 1);
    assert.deepEqual(await fs.readFile(originalPath), bytes);
    assert.deepEqual(await fs.readFile(library.indexPath), saved); assert.deepEqual(library.snapshot(), before);
    assert.deepEqual(await pending(library), []);
  } finally { fs.rename = rename; }
});

test('unchanged-byte metadata failure does not touch originals and explicit accepted edits update the index without renaming', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId } = await library.createReimbursementFolder('报销');
  const bytes = f.form('first'), source = await f.source('same.xlsx', bytes);
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'form', source, '申请表');
  const originalPath = library.getAssetPath(assetId), before = library.snapshot(), index = await fs.readFile(library.indexPath), persist = library._persist.bind(library);
  library._persist = async () => { throw new Error('metadata save denied'); };
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'form', source, '更名'), /metadata save denied/);
  assert.deepEqual(await fs.readFile(originalPath), bytes); assert.deepEqual(await fs.readFile(library.indexPath), index); assert.deepEqual(library.snapshot(), before);
  library._persist = persist;
  const edited = f.form('edited outside'), editedSource = await f.source('edited.xlsx', edited);
  await fs.writeFile(originalPath, edited);
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (from === originalPath) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return rename(from, to); };
  try {
    const result = await library.upsertReimbursementDocument(folderId, 'form', editedSource, '申请表', { expectedExistingHash: hash(edited) });
    assert.equal(result.assetId, assetId); assert.equal(assetOf(result.snapshot, assetId).hash, hash(edited));
    assert.deepEqual(await fs.readFile(originalPath), edited);
    assert.equal(JSON.parse(await fs.readFile(path.join(library.root, 'index.backup.json'), 'utf8')).assets.find(asset => asset.id === assetId).hash, hash(edited));
  } finally { fs.rename = rename; }
});

test('old reimbursement roots without invoice fields load unchanged and default to two images per page', async t => {
  const { library } = await fixture(t), { folderId } = await library.createReimbursementFolder('旧版报销');
  const data = structuredClone(library.data);
  delete rootOf(data, folderId).reimbursement.invoicePdfAssetId;
  delete rootOf(data, folderId).reimbursement.supplementInvoicePdfAssetId;
  await fs.writeFile(library.indexPath, JSON.stringify(data, null, 2));
  const before = await fs.readFile(library.indexPath), reopened = new Library({ root: library.root });
  const snapshot = await reopened.init(), configuration = rootOf(snapshot, folderId).reimbursement;
  assert.equal(Object.hasOwn(configuration, 'invoicePdfAssetId'), false);
  assert.equal(Object.hasOwn(configuration, 'invoicePdfOptions'), false);
  assert.equal(Object.hasOwn(configuration, 'invoicePdfSignature'), false);
  assert.equal(Object.hasOwn(configuration, 'supplementInvoicePdfAssetId'), false);
  assert.deepEqual(ReimbursementFolders.invoicePdfOptions(configuration.invoicePdfOptions), { imagesPerPage: 2 });
  assert.deepEqual(await fs.readFile(library.indexPath), before);
  await reopened.clearReimbursementDocument(folderId, 'invoicePdf');
  await reopened.setReimbursementInvoiceSignature(folderId, null);
  await reopened.clearReimbursementDocument(folderId, 'supplementInvoicePdf');
  await reopened.setReimbursementInvoiceSignature(folderId, null, 'supplement');
  assert.deepEqual(await fs.readFile(library.indexPath), before, 'empty clear does not migrate a legacy root');
});

test('invoice layout options persist all supported values without changing other root metadata or assets', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('发票排版');
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'form', await f.source('form.xlsx', f.form()), '申请表');
  const baseline = library.snapshot(), beforeRoot = structuredClone(rootOf(baseline, folderId));
  assert.deepEqual(ReimbursementFolders.INVOICE_IMAGES_PER_PAGE, [1, 2, 3, 4, 6, 8, 9]);
  for (const imagesPerPage of ReimbursementFolders.INVOICE_IMAGES_PER_PAGE) {
    const snapshot = await library.setReimbursementInvoiceOptions(folderId, { imagesPerPage });
    const root = rootOf(snapshot, folderId);
    assert.deepEqual(root.reimbursement.invoicePdfOptions, { imagesPerPage });
    assert.equal(root.reimbursement.formAssetId, assetId);
    assert.deepEqual(root.reimbursement.categoryIds, beforeRoot.reimbursement.categoryIds);
    assert.equal(root.name, beforeRoot.name); assert.equal(root.parentId, beforeRoot.parentId);
    assert.deepEqual(snapshot.assets, baseline.assets);
    const bytes = await fs.readFile(library.indexPath);
    await library.setReimbursementInvoiceOptions(folderId, { imagesPerPage });
    assert.deepEqual(await fs.readFile(library.indexPath), bytes, 'same setting does not rewrite the index');
  }
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.deepEqual(rootOf(reopened.snapshot(), folderId).reimbursement.invoicePdfOptions, { imagesPerPage: 9 });
});

test('invoice options reject malformed values and failed saves leave every field unchanged', async t => {
  const { library } = await fixture(t), { folderId } = await library.createReimbursementFolder('发票');
  const ordinaryId = (await library.createFolder('普通')).folders.at(-1).id;
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  for (const value of [undefined, null, [], {}, 2, '2', { imagesPerPage: '2' }, { imagesPerPage: 0 }, { imagesPerPage: 5 }, { imagesPerPage: 2.5 }, { imagesPerPage: NaN }, { imagesPerPage: Infinity }, { imagesPerPage: 2, extra: true }]) {
    await assert.rejects(library.setReimbursementInvoiceOptions(folderId, value), /排版参数无效/);
    assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  }
  for (const id of ['missing', ordinaryId]) await assert.rejects(library.setReimbursementInvoiceOptions(id, { imagesPerPage: 2 }), /报销文件夹/);
  library._persist = async () => { throw new Error('invoice options save denied'); };
  await assert.rejects(library.setReimbursementInvoiceOptions(folderId, { imagesPerPage: 4 }), /save denied/);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
});

test('invoice signatures accept only lowercase SHA256 or null and persist independently from layout and document pointers', async t => {
  const { library } = await fixture(t), { folderId } = await library.createReimbursementFolder('签名');
  await library.setReimbursementInvoiceOptions(folderId, { imagesPerPage: 3 });
  const signature = hash(Buffer.from('ordered invoice inputs'));
  const saved = await library.setReimbursementInvoiceSignature(folderId, signature);
  assert.equal(rootOf(saved, folderId).reimbursement.invoicePdfSignature, signature);
  assert.deepEqual(rootOf(saved, folderId).reimbursement.invoicePdfOptions, { imagesPerPage: 3 });
  assert.equal(rootOf(saved, folderId).reimbursement.invoicePdfAssetId, null);
  const index = await fs.readFile(library.indexPath), before = library.snapshot();
  await library.setReimbursementInvoiceSignature(folderId, signature);
  assert.deepEqual(await fs.readFile(library.indexPath), index);
  for (const value of [undefined, '', [], {}, 3, signature.toUpperCase(), 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64)]) {
    await assert.rejects(library.setReimbursementInvoiceSignature(folderId, value), /签名无效/);
    assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  }
  const ordinary = (await library.createFolder('普通')).folders.at(-1);
  await assert.rejects(library.setReimbursementInvoiceSignature(ordinary.id, signature), /报销文件夹/);
  const persisted = new Library({ root: library.root }); await persisted.init();
  assert.equal(rootOf(persisted.snapshot(), folderId).reimbursement.invoicePdfSignature, signature);
  const persist = library._persist.bind(library), beforeFailure = library.snapshot(), beforeIndex = await fs.readFile(library.indexPath);
  library._persist = async () => { throw new Error('signature save denied'); };
  await assert.rejects(library.setReimbursementInvoiceSignature(folderId, null), /save denied/);
  assert.deepEqual(library.snapshot(), beforeFailure); assert.deepEqual(await fs.readFile(library.indexPath), beforeIndex);
  library._persist = persist;
  const cleared = await library.setReimbursementInvoiceSignature(folderId, null);
  assert.equal(rootOf(cleared, folderId).reimbursement.invoicePdfSignature, null);
  assert.deepEqual(rootOf(cleared, folderId).reimbursement.invoicePdfOptions, { imagesPerPage: 3 });
});

test('invoice PDFs use an independent stable generated asset and can clear, restore and regenerate after permanent deletion', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('发票汇总');
  const source = await f.source('invoice.pdf', f.pdf('identical bytes'));
  const { assetIds: [ordinaryId] } = await library.importPaths([source]);
  const { assetId: supplementId } = await library.upsertReimbursementDocument(folderId, 'supplementPdf', source, '补票');
  const first = await library.upsertReimbursementDocument(folderId, 'invoicePdf', source, '发票合并');
  const id = first.assetId;
  assert.notEqual(id, ordinaryId); assert.notEqual(id, supplementId);
  assert.equal(rootOf(first.snapshot, folderId).reimbursement.invoicePdfAssetId, id);
  assert.deepEqual(assetOf(first.snapshot, id).reimbursementGenerated, { rootId: folderId, kind: 'invoicePdf' });
  await library.updateAssets([id], { notes: '生成文件备注', tags: ['报销'], rating: 4 });
  const signature = hash(Buffer.from('same inputs')); await library.setReimbursementInvoiceSignature(folderId, signature);
  await library.setReimbursementInvoiceOptions(folderId, { imagesPerPage: 6 });
  const pathBefore = library.getAssetPath(id), index = await fs.readFile(library.indexPath);
  assert.equal((await library.upsertReimbursementDocument(folderId, 'invoicePdf', source, '发票合并')).assetId, id);
  assert.deepEqual(await fs.readFile(library.indexPath), index);
  const cleared = await library.clearReimbursementDocument(folderId, 'invoicePdf');
  assert.equal(rootOf(cleared, folderId).reimbursement.invoicePdfAssetId, null);
  assert.ok(assetOf(cleared, id).trashedAt);
  assert.equal(assetOf(cleared, supplementId).trashedAt, null);
  assert.equal(assetOf(cleared, ordinaryId).trashedAt, null);
  assert.equal(rootOf(cleared, folderId).reimbursement.invoicePdfSignature, signature);
  const restored = await library.upsertReimbursementDocument(folderId, 'invoicePdf', source, '发票合并');
  assert.equal(restored.assetId, id); assert.equal(assetOf(restored.snapshot, id).trashedAt, null);
  assert.equal(assetOf(restored.snapshot, id).notes, '生成文件备注');
  assert.deepEqual(assetOf(restored.snapshot, id).tags, ['报销']);
  assert.equal(library.getAssetPath(id), pathBefore);
  await library.clearReimbursementDocument(folderId, 'invoicePdf'); await library.deletePermanently([id]);
  const regenerated = await library.upsertReimbursementDocument(folderId, 'invoicePdf', source, '重新生成');
  assert.ok(regenerated.assetId); assert.notEqual(regenerated.assetId, ordinaryId); assert.notEqual(regenerated.assetId, supplementId);
  assert.deepEqual(rootOf(regenerated.snapshot, folderId).reimbursement.invoicePdfOptions, { imagesPerPage: 6 });
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.equal(rootOf(reopened.snapshot(), folderId).reimbursement.invoicePdfAssetId, regenerated.assetId);
});

test('invoice PDF content update rolls back on save failure and does not alter the previous signature', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('发票事务');
  const first = await f.source('first.pdf', f.pdf('first')), next = await f.source('next.pdf', f.pdf('next'));
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'invoicePdf', first, '发票');
  const signature = hash(Buffer.from('original sources')); await library.setReimbursementInvoiceSignature(folderId, signature);
  const before = library.snapshot(), index = await fs.readFile(library.indexPath), persist = library._persist.bind(library);
  library._persist = async () => { throw new Error('invoice save denied'); };
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'invoicePdf', next, '更新发票'), /save denied/);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId)), f.pdf('first'));
  assert.deepEqual(await pending(library), []);
  library._persist = persist;
  const updated = await library.upsertReimbursementDocument(folderId, 'invoicePdf', next, '更新发票');
  assert.equal(updated.assetId, assetId);
  assert.deepEqual(await fs.readFile(library.getAssetPath(assetId)), f.pdf('next'));
  assert.equal(rootOf(updated.snapshot, folderId).reimbursement.invoicePdfSignature, signature, 'the service commits the new signature separately after successful output');
});

test('persisted invoice fields strictly validate layout, signature and generated ownership', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('配置校验');
  const source = await f.source('invoice.pdf', f.pdf());
  const { assetIds: [ordinaryId] } = await library.importPaths([source]);
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'invoicePdf', source, '合并');
  for (const mutate of [
    root => { root.invoicePdfAssetId = 1; },
    root => { root.invoicePdfAssetId = ordinaryId; },
    root => { root.invoicePdfOptions = { imagesPerPage: 5 }; },
    root => { root.invoicePdfOptions = { imagesPerPage: 2, unknown: true }; },
    root => { root.invoicePdfOptions = null; },
    root => { root.invoicePdfOptions = undefined; },
    root => { root.invoicePdfSignature = 'bad'; },
    root => { root.invoicePdfSignature = undefined; }
  ]) {
    const data = structuredClone(library.data); mutate(rootOf(data, folderId).reimbursement);
    assert.throws(() => library._validate(data), /报销|发票/);
  }
  const wrongKind = structuredClone(library.data);
  assetOf(wrongKind, assetId).reimbursementGenerated.kind = 'supplementPdf';
  assert.throws(() => library._validate(wrongKind), /引用了其他素材/);
});

test('supplement invoice marks are atomic, preserve image bytes and cannot make PDF evidence', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('补票分类');
  const categories = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  const nested = (await library.createFolder('原始凭证', categories.supplement)).folders.at(-1);
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const image = await f.source('invoice.png', bytes), pdf = await f.source('invoice.pdf', f.pdf());
  const { assetIds: [imageId, pdfId] } = await library.importPaths([image, pdf], { folderId: nested.id });
  const document = await f.source('notes.docx', f.form());
  const { assetIds: [documentId] } = await library.importPaths([document], { folderId: categories.other });
  assert.equal(ReimbursementFolders.isSupplementInvoice(assetOf(library.snapshot(), imageId)), false);
  assert.equal(ReimbursementFolders.isSupplementInvoice(assetOf(library.snapshot(), pdfId)), true);
  const marked = await library.setReimbursementSupplementInvoice([imageId, pdfId], true);
  assert.equal(ReimbursementFolders.isSupplementInvoice(assetOf(marked, imageId)), true);
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  await library.setReimbursementSupplementInvoice([imageId, pdfId], true);
  assert.deepEqual(await fs.readFile(library.indexPath), index, 'unchanged roles are not saved again');
  for (const [ids, value] of [[[imageId, pdfId], false], [[imageId, documentId], true], [[imageId], 'yes'], [[], true], [['missing'], true]]) {
    await assert.rejects(library.setReimbursementSupplementInvoice(ids, value));
    assert.deepEqual(library.snapshot(), before);
  }
  const unmarked = await library.setReimbursementSupplementInvoice([imageId], false);
  assert.equal(Object.hasOwn(assetOf(unmarked, imageId), 'reimbursementSupplementInvoice'), false);
  assert.deepEqual(await fs.readFile(library.getAssetPath(imageId)), bytes);
  assert.deepEqual(await fs.readFile(library.getAssetPath(pdfId)), f.pdf());
  await library.setReimbursementSupplementInvoice([imageId], true);
  await library.moveAssetsToFolder([imageId], categories.other);
  await assert.rejects(library.setReimbursementSupplementInvoice([imageId], false), /只能修改补票分类/);
  assert.equal(assetOf(await new Library({ root: library.root }).init(), imageId).reimbursementSupplementInvoice, true);
});

const amountPage = (overrides = {}) => ({ pageNumber: 1, amountCents: 12345, detectedCents: 12345, status: 'recognized', confidence: 'high', reason: '', ...overrides });

test('amount summaries persist exact cents, ordered pages and invoice hashes without changing original or asset hash', async t => {
  const f = await fixture(t), { library } = f, bytes = f.pdf('amounts');
  const source = await f.source('invoice.pdf', bytes), { assetIds: [id] } = await library.importPaths([source]);
  const summary = { version: 1, sourceHash: hash(bytes), pages: [
    amountPage({ pageNumber: 4, amountCents: null, detectedCents: null, status: 'pending', confidence: 'none', reason: '未识别' }),
    amountPage({ pageNumber: 2, amountCents: ReimbursementFolders.MAX_AMOUNT_CENTS, status: 'manual', invoiceKey: hash(Buffer.from('invoice number')) }),
    amountPage(), amountPage({ pageNumber: 3, amountCents: 0, detectedCents: 0, status: 'excluded', confidence: 'low' })
  ] };
  const saved = await library.setReimbursementAmounts(id, summary), asset = assetOf(saved, id);
  assert.deepEqual(asset.reimbursementAmounts.pages.map(page => page.pageNumber), [1, 2, 3, 4]);
  assert.equal(asset.reimbursementAmounts.pages[1].amountCents, 999999999999);
  assert.equal(asset.reimbursementAmounts.pages[1].invoiceKey, summary.pages[1].invoiceKey);
  assert.equal(asset.hash, hash(bytes));
  assert.deepEqual(await fs.readFile(library.getAssetPath(id)), bytes);
  const index = await fs.readFile(library.indexPath);
  await library.setReimbursementAmounts(id, { ...summary, pages: summary.pages.toReversed() });
  assert.deepEqual(await fs.readFile(library.indexPath), index, 'normalized unchanged data does not persist');
  const externallyChanged = f.pdf('edited outside the library');
  await fs.writeFile(library.getAssetPath(id), externallyChanged);
  await assert.rejects(library.setReimbursementAmounts(id, summary), /原件已变化/);
  assert.deepEqual(await fs.readFile(library.indexPath), index, 'even no-op must verify the actual original');
  const replacement = { ...summary, sourceHash: hash(externallyChanged) };
  const refreshed = await library.setReimbursementAmounts(id, replacement);
  assert.equal(assetOf(refreshed, id).hash, hash(bytes), 'recognition never rewrites the import hash');
  assert.equal(assetOf(refreshed, id).reimbursementAmounts.sourceHash, hash(externallyChanged));
  assert.deepEqual(await fs.readFile(library.getAssetPath(id)), externallyChanged);
  assert.deepEqual(assetOf(await new Library({ root: library.root }).init(), id).reimbursementAmounts, assetOf(refreshed, id).reimbursementAmounts);
});

test('legacy amount summaries remain readable and an engine upgrade persists without changing manual decisions', async t => {
  const f = await fixture(t), { library } = f, bytes = f.pdf('legacy cache');
  const source = await f.source('invoice.pdf', bytes), { assetIds: [id] } = await library.importPaths([source]);
  const legacy = { version: 1, sourceHash: hash(bytes), pages: [amountPage({ amountCents: 0, status: 'manual', reason: '已手动核对整份文件合计' })] };
  await library.setReimbursementAmounts(id, legacy);
  assert.deepEqual(assetOf(await new Library({ root: library.root }).init(), id).reimbursementAmounts, legacy);
  const upgraded = { ...legacy, engineVersion: 2 };
  await library.setReimbursementAmounts(id, upgraded);
  const reopened = await new Library({ root: library.root }).init();
  assert.deepEqual(assetOf(reopened, id).reimbursementAmounts, upgraded);
  const index = await fs.readFile(library.indexPath);
  await library.setReimbursementAmounts(id, upgraded);
  assert.deepEqual(await fs.readFile(library.indexPath), index, 'same engine version is a no-op');
  assert.deepEqual(await fs.readFile(library.getAssetPath(id)), bytes);
});

test('amount summaries reject malformed or private text fields, invalid money and page identities atomically', async t => {
  const f = await fixture(t), { library } = f, bytes = f.pdf('strict summary');
  const source = await f.source('invoice.pdf', bytes), { assetIds: [id] } = await library.importPaths([source]);
  const valid = { version: 1, sourceHash: hash(bytes), pages: [amountPage()] };
  await library.setReimbursementAmounts(id, valid);
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  const invalid = [null, {}, { ...valid, version: 2 }, ...[undefined, null, 0, -1, 1.5, '2', Infinity, Number.MAX_SAFE_INTEGER + 1].map(engineVersion => ({ ...valid, engineVersion })),
    { ...valid, sourceHash: 'a'.repeat(63) }, { ...valid, text: 'full OCR text' },
    { ...valid, pages: [] }, { ...valid, pages: Array(2) }, { ...valid, pages: Array.from({ length: 101 }, (_, i) => amountPage({ pageNumber: i + 1 })) },
    { ...valid, pages: [amountPage(), amountPage()] }];
  for (const patch of [{ pageNumber: 0 }, { pageNumber: 101 }, { pageNumber: 1.5 }, { amountCents: -1 }, { amountCents: 0.1 },
    { amountCents: 1000000000000 }, { detectedCents: NaN }, { detectedCents: '10' }, { amountCents: undefined },
    { status: 'ready' }, { confidence: 'sure' }, { reason: 'x'.repeat(101) }, { reason: null },
    { invoiceKey: null }, { invoiceKey: 'F'.repeat(64) }, { invoiceKey: undefined }, { text: 'private OCR text' }]) invalid.push({ ...valid, pages: [amountPage(patch)] });
  for (const value of invalid) {
    await assert.rejects(library.setReimbursementAmounts(id, value), /金额/);
    assert.deepEqual(library.snapshot(), before);
  }
  assert.deepEqual(await fs.readFile(library.indexPath), index);
  const document = await f.source('notes.docx', f.form()), { assetIds: [docId] } = await library.importPaths([document]);
  await assert.rejects(library.setReimbursementAmounts(docId, valid), /只能记录图片或 PDF/);
  for (const mutate of [asset => { asset.reimbursementAmounts = { ...valid, pages: [amountPage({ amountCents: -1 })] }; },
    asset => { asset.reimbursementSupplementInvoice = 'true'; }]) {
    const corrupt = structuredClone(library.data); mutate(assetOf(corrupt, id));
    assert.throws(() => library._validate(corrupt), /报销|补票/);
  }
  const corrupt = structuredClone(library.data); assetOf(corrupt, docId).reimbursementAmounts = valid;
  assert.throws(() => library._validate(corrupt), /素材类型/);
});

test('role and amount save failures preserve index and original bytes', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('失败回滚');
  const supplementId = rootOf(library.snapshot(), folderId).reimbursement.categoryIds.supplement;
  const bytes = await sharp({ create: { width: 4, height: 7, channels: 3, background: '#123456' } }).png().toBuffer();
  const source = await f.source('invoice.png', bytes), { assetIds: [id] } = await library.importPaths([source], { folderId: supplementId });
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  library._persist = async () => { throw new Error('summary save denied'); };
  await assert.rejects(library.setReimbursementSupplementInvoice([id], true), /summary save denied/);
  await assert.rejects(library.setReimbursementAmounts(id, { version: 1, sourceHash: hash(bytes), pages: [amountPage()] }), /summary save denied/);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  assert.deepEqual(await fs.readFile(library.getAssetPath(id)), bytes);
});

test('supplement invoice PDF options, signatures and stable document IDs are independent from other generated PDFs', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('独立发票合并');
  const source = await f.source('combined.pdf', f.pdf('same content'));
  const regular = await library.upsertReimbursementDocument(folderId, 'invoicePdf', source, '普通发票');
  const evidence = await library.upsertReimbursementDocument(folderId, 'supplementPdf', source, '说明截图');
  const supplement = await library.upsertReimbursementDocument(folderId, 'supplementInvoicePdf', source, '补票发票');
  assert.equal(new Set([regular.assetId, evidence.assetId, supplement.assetId]).size, 3);
  await library.setReimbursementInvoiceOptions(folderId, { imagesPerPage: 3 });
  await library.setReimbursementInvoiceSignature(folderId, hash(Buffer.from('regular')));
  for (const imagesPerPage of ReimbursementFolders.INVOICE_IMAGES_PER_PAGE) await library.setReimbursementInvoiceOptions(folderId, { imagesPerPage }, 'supplement');
  await library.setReimbursementInvoiceSignature(folderId, hash(Buffer.from('supplement')), 'supplement');
  const configuration = rootOf(library.snapshot(), folderId).reimbursement;
  assert.deepEqual(configuration.invoicePdfOptions, { imagesPerPage: 3 });
  assert.deepEqual(configuration.supplementInvoicePdfOptions, { imagesPerPage: 9 });
  assert.equal(configuration.invoicePdfSignature, hash(Buffer.from('regular')));
  assert.equal(configuration.supplementInvoicePdfSignature, hash(Buffer.from('supplement')));
  assert.equal(configuration.supplementInvoicePdfAssetId, supplement.assetId);
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  await assert.rejects(library.setReimbursementInvoiceOptions(folderId, { imagesPerPage: 2 }, 'other'), /范围无效/);
  await assert.rejects(library.setReimbursementInvoiceSignature(folderId, null, 'other'), /范围无效/);
  assert.deepEqual(library.snapshot(), before);
  assert.deepEqual(await fs.readFile(library.indexPath), index);
  for (const patch of [{ supplementInvoicePdfOptions: { imagesPerPage: 5 } }, { supplementInvoicePdfOptions: undefined },
    { supplementInvoicePdfSignature: 'invalid' }, { supplementInvoicePdfSignature: undefined },
    { supplementInvoicePdfAssetId: regular.assetId }]) {
    const corrupt = structuredClone(library.data); Object.assign(rootOf(corrupt, folderId).reimbursement, patch);
    assert.throws(() => library._validate(corrupt), /发票|报销/);
  }
  const cleared = await library.clearReimbursementDocument(folderId, 'supplementInvoicePdf');
  assert.ok(assetOf(cleared, supplement.assetId).trashedAt);
  assert.equal(assetOf(cleared, evidence.assetId).trashedAt, null);
  assert.equal(assetOf(cleared, regular.assetId).trashedAt, null);
  assert.equal((await library.upsertReimbursementDocument(folderId, 'supplementInvoicePdf', source, '重新生成补票发票')).assetId, supplement.assetId);
  const updated = await f.source('changed.pdf', f.pdf('changed'));
  const saved = library.snapshot(), savedIndex = await fs.readFile(library.indexPath);
  library._persist = async () => { throw new Error('supplement invoice save denied'); };
  await assert.rejects(library.upsertReimbursementDocument(folderId, 'supplementInvoicePdf', updated, '更新'), /save denied/);
  assert.deepEqual(library.snapshot(), saved); assert.deepEqual(await fs.readFile(library.indexPath), savedIndex);
  assert.deepEqual(await fs.readFile(library.getAssetPath(supplement.assetId)), f.pdf('same content'));
  assert.deepEqual(await pending(library), []);
  const reopened = await new Library({ root: library.root }).init();
  assert.deepEqual(rootOf(reopened, folderId).reimbursement, rootOf(saved, folderId).reimbursement);
});

test('explicit reimbursement re-import restores original IDs and metadata and counts batch duplicates once', async t => {
  const f = await fixture(t), { library } = f;
  const { folderId: firstRoot } = await library.createReimbursementFolder('原报销'), { folderId: targetRoot } = await library.createReimbursementFolder('新报销');
  const firstCategories = rootOf(library.snapshot(), firstRoot).reimbursement.categoryIds;
  const targetCategories = rootOf(library.snapshot(), targetRoot).reimbursement.categoryIds;
  const target = (await library.createFolder('嵌套分类', targetCategories.equipment)).folders.at(-1).id;
  const pdfBytes = f.pdf('restorable'), imageBytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#aabbcc' } }).png().toBuffer();
  const pdf = await f.source('first.pdf', pdfBytes), image = await f.source('first.png', imageBytes), document = await f.source('notes.docx', f.form('restorable'));
  const { assetIds: [pdfId, documentId] } = await library.importPaths([pdf, document], { folderId: firstCategories.other });
  const { assetIds: [imageId] } = await library.importPaths([image], { folderId: firstCategories.supplement });
  await library.setReimbursementSupplementInvoice([imageId], true);
  await library.setReimbursementAmounts(pdfId, { version: 1, sourceHash: hash(pdfBytes), pages: [amountPage({ status: 'manual' })] });
  await library.updateAssets([pdfId, documentId, imageId], { name: '保留原名称', tags: ['手动标签'], notes: '保留原备注', rating: 4 });
  const ids = [pdfId, documentId, imageId], before = library.snapshot();
  const originalBytes = new Map(await Promise.all(ids.map(async id => [id, await fs.readFile(library.getAssetPath(id))])));
  await library.setTrash(ids, true);
  const renamed = await f.source('new-filename.pdf', pdfBytes);
  const added = await f.source('new.png', await sharp({ create: { width: 7, height: 5, channels: 3, background: '#aa0022' } }).png().toBuffer());
  const progress = [];
  const report = await library.importPaths([pdf, pdf, renamed, image, document, added], { folderId: target, restoreTrashed: true,
    metadata: { sourceUrl: 'https://example.com/incoming' }, onProgress: event => progress.push(event) });
  assert.equal(report.imported, 1); assert.equal(report.restored, 3); assert.equal(report.duplicates, 2);
  assert.deepEqual(report.errors, []); assert.deepEqual(new Set(report.restoredAssetIds), new Set(ids));
  assert.equal(report.assetIds.length, 1); assert.ok(!ids.includes(report.assetIds[0]));
  assert.equal(progress.at(-1).restored, 3);
  const restored = library.snapshot();
  for (const id of ids) {
    const previous = assetOf(before, id), current = assetOf(restored, id);
    assert.equal(current.folderId, target); assert.equal(current.trashedAt, null);
    const ignoreState = ({ folderId, updatedAt, trashedAt, ...metadata }) => metadata;
    assert.deepEqual(ignoreState(current), ignoreState(previous));
    assert.deepEqual(await fs.readFile(library.getAssetPath(id)), originalBytes.get(id));
  }
  assert.deepEqual((await new Library({ root: library.root }).init()).assets, restored.assets);
});

test('ordinary import keeps trashed duplicates untouched and restore mode requires a valid reimbursement category', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('报销');
  const target = rootOf(library.snapshot(), folderId).reimbursement.categoryIds.travel;
  const source = await f.source('restore.pdf', f.pdf('restore option'));
  const { assetIds: [id] } = await library.importPaths([source]); await library.setTrash([id], true);
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  for (const options of [{ folderId: target }, { folderId: target, restoreTrashed: false }, {}]) {
    const report = await library.importPaths([source], options);
    assert.equal(report.duplicates, 1); assert.equal(report.restored, 0); assert.deepEqual(report.restoredAssetIds, []);
    assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  }
  const ordinary = (await library.createFolder('普通文件夹')).folders.at(-1).id;
  for (const invalidFolder of [null, folderId, ordinary]) await assert.rejects(library.importPaths([source], { folderId: invalidFolder, restoreTrashed: true }), /有效的报销分类/);
  for (const value of [null, 'true', 1, {}]) await assert.rejects(library.importPaths([source], { folderId: target, restoreTrashed: value }), /恢复选项无效/);
  const categories = ReimbursementFolders.listCategories(library.snapshot().folders, folderId).filter(category => category.key !== 'travel');
  const child = (await library.createFolder('原分类子目录', target)).folders.at(-1).id;
  await library.updateReimbursementCategories(folderId, categories.map(({ key, name }) => ({ key, name })));
  await assert.rejects(library.importPaths([source], { folderId: child, restoreTrashed: true }), /有效的报销分类/);
});

test('re-import never moves active duplicates or restores another trashed record when any active match exists', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('重复记录');
  const categories = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  const source = await f.source('same.pdf', f.pdf('multiple matching records'));
  const { assetIds: [originalId] } = await library.importPaths([source], { folderId: categories.other });
  await library.setTrash([originalId], true);
  const cloneRecord = async folderId => {
    const data = structuredClone(library.data), original = data.assets.find(asset => asset.id === originalId), id = crypto.randomUUID();
    const asset = { ...original, id, folderId, trashedAt: null, thumbnail: null, filename: `originals/${id}.pdf` };
    await fs.copyFile(library.getAssetPath(originalId), path.join(library.root, asset.filename));
    data.assets.push(asset); await library._persist(data); return id;
  };
  const elsewhereId = await cloneRecord(categories.equipment), targetId = await cloneRecord(categories.travel);
  for (const activeIds of [[elsewhereId, targetId], [elsewhereId]]) {
    const before = library.snapshot(), index = await fs.readFile(library.indexPath);
    const report = await library.importPaths([source], { folderId: categories.travel, restoreTrashed: true });
    assert.equal(report.restored, 0); assert.equal(report.duplicates, 1);
    assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
    if (activeIds.length === 2) await library.setTrash([targetId], true);
  }
  await library.setTrash([elsewhereId], true);
  const report = await library.importPaths([source], { folderId: categories.travel, restoreTrashed: true });
  assert.equal(report.restored, 1); assert.deepEqual(report.restoredAssetIds, [originalId]);
  assert.ok(assetOf(library.snapshot(), elsewhereId).trashedAt); assert.ok(assetOf(library.snapshot(), targetId).trashedAt);
});

test('a trashed generated document is never restored through a reimbursement file import', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('生成文件保护');
  const target = rootOf(library.snapshot(), folderId).reimbursement.categoryIds.travel;
  const source = await f.source('generated.pdf', f.pdf('generated only'));
  const { assetId } = await library.upsertReimbursementDocument(folderId, 'invoicePdf', source, '合并发票');
  await library.clearReimbursementDocument(folderId, 'invoicePdf');
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  const report = await library.importPaths([source], { folderId: target, restoreTrashed: true });
  assert.equal(report.restored, 0); assert.equal(report.duplicates, 1); assert.deepEqual(report.restoredAssetIds, []);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  assert.ok(assetOf(library.snapshot(), assetId).trashedAt);
});

test('restoration rejects missing, changed or non-file originals without reviving bad records', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('原件校验');
  const target = rootOf(library.snapshot(), folderId).reimbursement.categoryIds.travel;
  for (const mode of ['missing', 'changed', 'directory']) {
    const source = await f.source(`${mode}.pdf`, f.pdf(mode));
    const { assetIds: [id] } = await library.importPaths([source]); await library.setTrash([id], true);
    const original = library.getAssetPath(id);
    if (mode === 'changed') await fs.writeFile(original, f.pdf('changed bytes'));
    else { await fs.unlink(original); if (mode === 'directory') await fs.mkdir(original); }
    const before = library.snapshot(), index = await fs.readFile(library.indexPath);
    const report = await library.importPaths([source], { folderId: target, restoreTrashed: true });
    assert.equal(report.restored, 0); assert.equal(report.imported, 0); assert.equal(report.duplicates, 0);
    assert.equal(report.errors.length, 1); assert.match(report.errors[0].message, /回收站原件缺失或已变化/);
    assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  }
});

test('failed restoration commits keep old trash state and remove only newly imported files', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('恢复回滚');
  const target = rootOf(library.snapshot(), folderId).reimbursement.categoryIds.travel;
  const source = await f.source('restorable.pdf', f.pdf('restore rollback'));
  const added = await f.source('new.pdf', f.pdf('new bytes'));
  const { assetIds: [id] } = await library.importPaths([source]); await library.setTrash([id], true);
  const before = library.snapshot(), index = await fs.readFile(library.indexPath), original = await fs.readFile(library.getAssetPath(id));
  const originals = (await fs.readdir(path.join(library.root, 'originals'))).sort(), covers = (await fs.readdir(path.join(library.root, 'thumbnails'))).sort();
  library._persist = async () => { throw new Error('restore commit failed'); };
  for (const paths of [[source], [source, added]]) {
    await assert.rejects(library.importPaths(paths, { folderId: target, restoreTrashed: true }), /restore commit failed/);
    assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
    assert.deepEqual(await fs.readFile(library.getAssetPath(id)), original);
    assert.deepEqual((await fs.readdir(path.join(library.root, 'originals'))).sort(), originals);
    assert.deepEqual((await fs.readdir(path.join(library.root, 'thumbnails'))).sort(), covers);
  }
});

test('evidence display amounts remain independent through purpose switches, moves, restoration and reload', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('购买截图');
  const categories = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  const nested = (await library.createFolder('支付说明', categories.supplement)).folders.at(-1).id;
  const bytes = await sharp({ create: { width: 12, height: 9, channels: 3, background: '#cceeff' } }).png().toBuffer();
  const source = await f.source('purchase.png', bytes), { assetIds: [id] } = await library.importPaths([source], { folderId: nested });
  const invoice = { version: 1, engineVersion: 3, sourceHash: hash(bytes), pages: [amountPage({ amountCents: 1234, detectedCents: 1234 })] };
  const evidence = { version: 1, engineVersion: 3, sourceHash: hash(bytes), pages: [amountPage({ amountCents: 7890, detectedCents: null, status: 'manual' })] };
  await library.setReimbursementAmounts(id, invoice);
  let saved = await library.setReimbursementEvidenceAmounts(id, evidence);
  assert.deepEqual(assetOf(saved, id).reimbursementEvidenceAmounts, evidence);
  assert.deepEqual(assetOf(saved, id).reimbursementAmounts, invoice);
  await library.setReimbursementSupplementInvoice([id], true);
  const invoicePurpose = library.snapshot();
  await assert.rejects(library.setReimbursementEvidenceAmounts(id, evidence), /购买截图/);
  assert.deepEqual(library.snapshot(), invoicePurpose);
  assert.deepEqual(assetOf(invoicePurpose, id).reimbursementEvidenceAmounts, evidence);
  await library.setReimbursementAmounts(id, { ...invoice, pages: [amountPage({ amountCents: 4321 })] });
  await library.setReimbursementSupplementInvoice([id], false);
  saved = library.snapshot();
  assert.equal(assetOf(saved, id).reimbursementAmounts.pages[0].amountCents, 4321);
  assert.equal(assetOf(saved, id).reimbursementEvidenceAmounts.pages[0].amountCents, 7890);
  await library.moveAssetsToFolder([id], categories.other);
  await assert.rejects(library.setReimbursementEvidenceAmounts(id, evidence), /购买截图/);
  assert.deepEqual(assetOf(library.snapshot(), id).reimbursementEvidenceAmounts, evidence, 'moving the image must retain its evidence record');
  await library.setTrash([id], true);
  const restored = await library.importPaths([source], { folderId: nested, restoreTrashed: true });
  assert.deepEqual(restored.restoredAssetIds, [id]);
  await library.updateAssets([id], { notes: '仅显示金额，不计报销' });
  const reopened = await new Library({ root: library.root }).init(), asset = assetOf(reopened, id);
  assert.deepEqual(asset.reimbursementEvidenceAmounts, evidence);
  assert.equal(asset.reimbursementAmounts.pages[0].amountCents, 4321);
  assert.equal(asset.notes, '仅显示金额，不计报销');
  assert.equal(asset.hash, hash(bytes)); assert.deepEqual(await fs.readFile(library.getAssetPath(id)), bytes);
});

test('evidence amount writes require a current supplement evidence image and strictly validate the persisted field', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('截图金额校验');
  const categories = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  const imageBytes = await sharp({ create: { width: 7, height: 5, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const image = await f.source('evidence.png', imageBytes), pdf = await f.source('invoice.pdf', f.pdf('evidence validation'));
  const { assetIds: [imageId, pdfId] } = await library.importPaths([image, pdf], { folderId: categories.supplement });
  const summary = { version: 1, sourceHash: hash(imageBytes), pages: [amountPage()] };
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  for (const [id, value] of [[pdfId, summary], ['missing', summary], [imageId, null],
    [imageId, { ...summary, pages: [amountPage({ amountCents: -1 })] }], [imageId, { ...summary, text: 'full OCR text' }]]) {
    await assert.rejects(library.setReimbursementEvidenceAmounts(id, value));
    assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  }
  const outside = structuredClone(library.data);
  outside.folders = []; outside.assets = outside.assets.filter(asset => asset.id === imageId);
  outside.assets[0].folderId = null; outside.assets[0].reimbursementEvidenceAmounts = { ...summary, pages: [amountPage({ status: 'invalid' })] };
  assert.throws(() => library._validate(outside), /金额/);
  const wrongType = structuredClone(library.data);
  assetOf(wrongType, pdfId).reimbursementEvidenceAmounts = summary;
  assert.throws(() => library._validate(wrongType), /购买截图金额素材类型/);
  // Role changes are serialized before validating a following amount write.
  const queued = await Promise.allSettled([library.setReimbursementSupplementInvoice([imageId], true), library.setReimbursementEvidenceAmounts(imageId, summary)]);
  assert.equal(queued[0].status, 'fulfilled'); assert.equal(queued[1].status, 'rejected');
  assert.equal(Object.hasOwn(assetOf(library.snapshot(), imageId), 'reimbursementEvidenceAmounts'), false);
});

test('evidence amount hash checks, no-op saves and failed commits preserve original bytes and invoice records', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('截图保存');
  const folder = rootOf(library.snapshot(), folderId).reimbursement.categoryIds.supplement;
  const bytes = await sharp({ create: { width: 9, height: 6, channels: 3, background: '#345678' } }).png().toBuffer();
  const source = await f.source('purchase.png', bytes), { assetIds: [id] } = await library.importPaths([source], { folderId: folder });
  const summary = { version: 1, sourceHash: hash(bytes), pages: [amountPage({ status: 'manual' })] };
  await library.setReimbursementAmounts(id, summary);
  const persist = library._persist.bind(library); let saves = 0;
  library._persist = async data => { saves++; return persist(data); };
  await library.setReimbursementEvidenceAmounts(id, summary);
  const firstIndex = await fs.readFile(library.indexPath);
  await library.setReimbursementEvidenceAmounts(id, structuredClone(summary));
  assert.equal(saves, 1); assert.deepEqual(await fs.readFile(library.indexPath), firstIndex);
  const edited = await sharp({ create: { width: 9, height: 6, channels: 3, background: '#112233' } }).png().toBuffer();
  await fs.writeFile(library.getAssetPath(id), edited);
  await assert.rejects(library.setReimbursementEvidenceAmounts(id, summary), /截图原件已变化/);
  assert.equal(saves, 1, 'a cached no-op must still verify the actual original');
  const changed = { ...summary, sourceHash: hash(edited), pages: [amountPage({ amountCents: 8888, status: 'manual' })] };
  await library.setReimbursementEvidenceAmounts(id, changed);
  assert.equal(assetOf(library.snapshot(), id).hash, hash(bytes));
  assert.deepEqual(assetOf(library.snapshot(), id).reimbursementAmounts, summary);
  const before = library.snapshot(), index = await fs.readFile(library.indexPath);
  library._persist = async () => { throw new Error('evidence commit failed'); };
  await assert.rejects(library.setReimbursementEvidenceAmounts(id, { ...changed, pages: [amountPage({ amountCents: 9999 })] }), /evidence commit failed/);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  assert.deepEqual(await fs.readFile(library.getAssetPath(id)), edited);
});

test('itinerary folders are lazy, independent of categories, name-safe and idempotent after rename and reload', async t => {
  const { library } = await fixture(t), { folderId } = await library.createReimbursementFolder('行程单');
  const before = library.snapshot(), categories = rootOf(before, folderId).reimbursement.categoryIds;
  assert.equal(before.folders.length, 6); assert.equal(rootOf(before, folderId).reimbursement.itineraryFolderId, null);
  const ordinary = (await library.createFolder('打车行程单', folderId)).folders.at(-1);
  const persist = library._persist.bind(library); let saves = 0;
  library._persist = async data => { saves++; return persist(data); };
  const ensured = await library.ensureReimbursementItinerary(folderId), id = ensured.folderId;
  assert.notEqual(id, ordinary.id); assert.equal(rootOf(ensured.snapshot, id).name, '打车行程单 2');
  assert.equal(rootOf(ensured.snapshot, id).parentId, folderId);
  assert.equal(ReimbursementFolders.isCategory(rootOf(ensured.snapshot, id)), false);
  assert.deepEqual(rootOf(ensured.snapshot, folderId).reimbursement.categoryIds, categories);
  assert.equal(rootOf(ensured.snapshot, folderId).reimbursement.itineraryFolderId, id);
  assert.equal(saves, 1);
  const index = await fs.readFile(library.indexPath);
  assert.equal((await library.ensureReimbursementItinerary(folderId)).folderId, id);
  assert.equal(saves, 1); assert.deepEqual(await fs.readFile(library.indexPath), index);
  await library.renameFolder(id, '自定义行程名称');
  assert.equal((await library.ensureReimbursementItinerary(folderId)).folderId, id);
  const reopened = new Library({ root: library.root }); await reopened.init();
  assert.equal((await reopened.ensureReimbursementItinerary(folderId)).folderId, id);
  const saved = reopened.snapshot();
  await assert.rejects(reopened.moveFolder(id, null), /行程单文件夹引用无效/);
  assert.deepEqual(reopened.snapshot(), saved);
  await assert.rejects(reopened.ensureReimbursementItinerary(ordinary.id), /报销文件夹已不存在/);
});

test('itinerary creation is atomic and legacy reimbursement roots need no migration write', async t => {
  const { library } = await fixture(t), { folderId } = await library.createReimbursementFolder('旧报销');
  const old = structuredClone(library.data);
  for (const key of ['itineraryFolderId', 'itineraryPdfAssetId', 'itineraryPdfSignature']) delete rootOf(old, folderId).reimbursement[key];
  await fs.writeFile(library.indexPath, JSON.stringify(old));
  const index = await fs.readFile(library.indexPath), reopened = new Library({ root: library.root }); await reopened.init();
  await reopened.clearReimbursementDocument(folderId, 'itineraryPdf');
  await reopened.setReimbursementItinerarySignature(folderId, null);
  assert.deepEqual(await fs.readFile(library.indexPath), index);
  const before = reopened.snapshot(), persist = reopened._persist.bind(reopened);
  reopened._persist = async () => { throw new Error('itinerary save denied'); };
  await assert.rejects(reopened.ensureReimbursementItinerary(folderId), /itinerary save denied/);
  assert.deepEqual(reopened.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  reopened._persist = persist;
  const ensured = await reopened.ensureReimbursementItinerary(folderId);
  assert.equal(rootOf(ensured.snapshot, ensured.folderId).parentId, folderId);
  assert.equal(ReimbursementFolders.listCategories(ensured.snapshot.folders, folderId).length, 5);
});

test('itinerary pointers reject missing, nested, foreign and reimbursement-classified folders', async t => {
  const { library } = await fixture(t), { folderId } = await library.createReimbursementFolder('所属报销');
  const { folderId: otherRoot } = await library.createReimbursementFolder('其他报销');
  const direct = (await library.createFolder('普通', folderId)).folders.at(-1).id;
  const nested = (await library.createFolder('嵌套', direct)).folders.at(-1).id;
  const foreign = (await library.createFolder('其他子目录', otherRoot)).folders.at(-1).id;
  const inner = await library.createReimbursementFolder('独立子报销', folderId);
  const categories = rootOf(library.snapshot(), folderId).reimbursement.categoryIds;
  for (const pointer of [123, 'bad/id', crypto.randomUUID(), folderId, otherRoot, categories.travel, nested, foreign, inner.folderId]) {
    const data = structuredClone(library.data); rootOf(data, folderId).reimbursement.itineraryFolderId = pointer;
    assert.throws(() => library._validate(data), /行程单文件夹引用无效/);
  }
  const valid = structuredClone(library.data); rootOf(valid, folderId).reimbursement.itineraryFolderId = direct;
  assert.doesNotThrow(() => library._validate(valid));
});

test('deleting an itinerary folder clears its pointer and signature atomically while retaining all original files', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('删除行程目录');
  const itinerary = await library.ensureReimbursementItinerary(folderId);
  const nested = (await library.createFolder('旧行程', itinerary.folderId)).folders.at(-1).id;
  const source = await f.source('trip.pdf', f.pdf('original trip'));
  const { assetIds: [sourceId] } = await library.importPaths([source], { folderId: nested });
  const generated = await library.upsertReimbursementDocument(folderId, 'itineraryPdf', source, '行程单合并');
  await library.setReimbursementItinerarySignature(folderId, hash(Buffer.from('itinerary signature')));
  const before = library.snapshot(), index = await fs.readFile(library.indexPath), persist = library._persist.bind(library);
  library._persist = async () => { throw new Error('delete itinerary denied'); };
  await assert.rejects(library.deleteFolder(itinerary.folderId), /delete itinerary denied/);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  library._persist = persist;
  const deleted = await library.deleteFolder(itinerary.folderId);
  assert.equal(rootOf(deleted, folderId).reimbursement.itineraryFolderId, null);
  assert.equal(rootOf(deleted, folderId).reimbursement.itineraryPdfSignature, null);
  assert.equal(assetOf(deleted, sourceId).folderId, null); assert.equal(assetOf(deleted, sourceId).trashedAt, null);
  assert.equal(assetOf(deleted, generated.assetId).trashedAt, null, 'the service is responsible for retiring its generated PDF');
  for (const id of [sourceId, generated.assetId]) assert.deepEqual(await fs.readFile(library.getAssetPath(id)), f.pdf('original trip'));
  const replacement = await library.ensureReimbursementItinerary(folderId);
  assert.notEqual(replacement.folderId, itinerary.folderId);
  assert.equal(assetOf(replacement.snapshot, sourceId).folderId, null);
  assert.equal(ReimbursementFolders.listCategories(replacement.snapshot.folders, folderId).length, 5);
});

test('itinerary generated PDFs and signatures remain independent and clear together', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('行程签名');
  const source = await f.source('shared.pdf', f.pdf('shared bytes'));
  const ordinary = await library.upsertReimbursementDocument(folderId, 'invoicePdf', source, '普通发票');
  const itinerary = await library.upsertReimbursementDocument(folderId, 'itineraryPdf', source, '打车行程单');
  assert.notEqual(itinerary.assetId, ordinary.assetId);
  assert.equal(rootOf(itinerary.snapshot, folderId).reimbursement.itineraryPdfAssetId, itinerary.assetId);
  const signature = hash(Buffer.from('trip sources'));
  await library.setReimbursementItinerarySignature(folderId, signature);
  const index = await fs.readFile(library.indexPath);
  await library.setReimbursementItinerarySignature(folderId, signature);
  assert.deepEqual(await fs.readFile(library.indexPath), index);
  for (const bad of [undefined, '', 'bad', 'A'.repeat(64), 123, {}]) await assert.rejects(library.setReimbursementItinerarySignature(folderId, bad), /签名无效/);
  const invalid = structuredClone(library.data); rootOf(invalid, folderId).reimbursement.itineraryPdfAssetId = ordinary.assetId;
  assert.throws(() => library._validate(invalid), /引用了其他素材/);
  const badSignature = structuredClone(library.data); rootOf(badSignature, folderId).reimbursement.itineraryPdfSignature = 'invalid';
  assert.throws(() => library._validate(badSignature), /签名无效/);
  const cleared = await library.clearReimbursementDocument(folderId, 'itineraryPdf');
  assert.equal(rootOf(cleared, folderId).reimbursement.itineraryPdfSignature, null);
  assert.equal(rootOf(cleared, folderId).reimbursement.itineraryPdfAssetId, null);
  assert.ok(assetOf(cleared, itinerary.assetId).trashedAt); assert.equal(assetOf(cleared, ordinary.assetId).trashedAt, null);
  assert.equal((await library.upsertReimbursementDocument(folderId, 'itineraryPdf', source, '重新生成')).assetId, itinerary.assetId);
  const loaded = await new Library({ root: library.root }).init();
  assert.equal(rootOf(loaded, folderId).reimbursement.itineraryPdfAssetId, itinerary.assetId);
});

test('itinerary imports restore matching deleted originals and reject other formats through native import and move paths', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('行程导入');
  const itinerary = await library.ensureReimbursementItinerary(folderId);
  const nested = (await library.createFolder('往期', itinerary.folderId)).folders.at(-1).id;
  const source = await f.source('trip.pdf', f.pdf('trip restored'));
  const { assetIds: [id] } = await library.importPaths([source], { folderId: nested, restoreTrashed: true });
  await library.updateAssets([id], { name: '保留行程名称', notes: '保留备注' });
  await library.setTrash([id], true);
  const restored = await library.importPaths([source], { folderId: itinerary.folderId, restoreTrashed: true });
  assert.equal(restored.restored, 1); assert.deepEqual(restored.restoredAssetIds, [id]); assert.deepEqual(restored.assetIds, []);
  assert.equal(assetOf(library.snapshot(), id).name, '保留行程名称'); assert.equal(assetOf(library.snapshot(), id).notes, '保留备注');
  assert.deepEqual(await fs.readFile(library.getAssetPath(id)), f.pdf('trip restored'));
  assert.equal(ReimbursementFolders.itineraryRootForFolder(library.snapshot().folders, nested).id, folderId);
  const word = await f.source('notes.docx', f.form('wrong itinerary format'));
  const rejected = await library.importPaths([word], { folderId: nested, restoreTrashed: true });
  assert.equal(rejected.imported, 0); assert.equal(rejected.errors.length, 1); assert.match(rejected.errors[0].message, /行程单只接受图片或 PDF/);
  const outside = (await library.createFolder('普通位置')).folders.at(-1).id;
  const document = await library.importPaths([word], { folderId: outside });
  const before = library.snapshot();
  await assert.rejects(library.moveAssetsToFolder(document.assetIds, nested), /行程单只接受图片或 PDF/);
  await assert.rejects(library.updateAssets(document.assetIds, { folderId: itinerary.folderId }), /行程单只接受图片或 PDF/);
  await assert.rejects(library.moveFolder(outside, itinerary.folderId), /行程单只接受图片或 PDF/);
  assert.deepEqual(library.snapshot(), before);
});

test('itinerary authority and format restrictions stop at a nested reimbursement workspace', async t => {
  const f = await fixture(t), { library } = f, { folderId } = await library.createReimbursementFolder('外层');
  const itinerary = await library.ensureReimbursementItinerary(folderId);
  const inner = await library.createReimbursementFolder('独立子报销', itinerary.folderId);
  const innerRoot = rootOf(library.snapshot(), inner.folderId), ordinary = (await library.createFolder('未分类材料', inner.folderId)).folders.at(-1).id;
  assert.equal(ReimbursementFolders.itineraryRootForFolder(library.snapshot().folders, inner.folderId), null);
  assert.equal(ReimbursementFolders.itineraryRootForFolder(library.snapshot().folders, ordinary), null);
  assert.equal(ReimbursementFolders.itineraryRootForFolder(library.snapshot().folders, innerRoot.reimbursement.categoryIds.travel), null);
  const source = await f.source('inner.docx', f.form('inner document'));
  assert.equal((await library.importPaths([source], { folderId: innerRoot.reimbursement.categoryIds.travel, restoreTrashed: true })).imported, 1);
  await assert.rejects(library.importPaths([source], { folderId: inner.folderId, restoreTrashed: true }), /有效的报销分类/);
  await assert.rejects(library.importPaths([source], { folderId: ordinary, restoreTrashed: true }), /有效的报销分类/);
  assert.equal(ReimbursementFolders.listCategories(library.snapshot().folders, folderId).length, 5);
});

test('itinerary signature writes roll back on failure and clearing an absent PDF still clears its signature', async t => {
  const { library } = await fixture(t), { folderId } = await library.createReimbursementFolder('空行程签名');
  await library.setReimbursementItinerarySignature(folderId, hash(Buffer.from('previous itinerary')));
  const before = library.snapshot(), index = await fs.readFile(library.indexPath), persist = library._persist.bind(library);
  library._persist = async () => { throw new Error('signature save denied'); };
  await assert.rejects(library.setReimbursementItinerarySignature(folderId, null), /signature save denied/);
  await assert.rejects(library.clearReimbursementDocument(folderId, 'itineraryPdf'), /signature save denied/);
  assert.deepEqual(library.snapshot(), before); assert.deepEqual(await fs.readFile(library.indexPath), index);
  library._persist = persist;
  const cleared = await library.clearReimbursementDocument(folderId, 'itineraryPdf');
  assert.equal(rootOf(cleared, folderId).reimbursement.itineraryPdfSignature, null);
  assert.equal(rootOf(cleared, folderId).reimbursement.itineraryPdfAssetId, null);
});
