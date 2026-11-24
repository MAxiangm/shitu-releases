/* Folder-bound reimbursement workspace and reusable applicant settings. */
(() => {
  'use strict';
  const api = window.shitu;
  const fields = [['applicant', '申请人'], ['companyName', '公司名称'], ['accountName', '开户名称'], ['bankName', '开户行'], ['accountNumber', '账号']];
  const state = { open: false, mode: 'workspace', folderId: null, libraryRoot: null, workspace: null, profile: {}, loading: false, working: false, request: 0, previousFocus: null, returnToWorkspace: false, categoryDraft: [], categoryNewName: '', categoryNewType: 'normal', invoiceMergePages: null, supplementMergePages: null, mergingInvoices: false, mergingScope: null, amountDrafts: new Map(), cancelling: false, deleteConfirmation: null, deleteOperation: null, libraryRefreshPending: false, libraryRefreshOperation: null, exportingAll: null };
  let root, libraryRefreshTimer;
  const $ = id => root.querySelector(`#${id}`);
  const node = (tag, cls, value) => { const result = document.createElement(tag); if (cls) result.className = cls; if (value !== undefined) result.textContent = String(value ?? ''); return result; };
  const button = (label, cls, click) => { const result = node('button', cls, label); result.type = 'button'; if (click) result.addEventListener('click', click); return result; };
  const busy = () => state.loading || state.working;
  const report = (message, error = false) => { $('rb-notice').textContent = message || ''; $('rb-notice').hidden = !message; $('rb-notice').classList.toggle('rb-error', error); };
  function build() {
    if (root) return;
    root = node('section', 'rb-overlay'); root.id = 'reimbursementCenter'; root.hidden = true; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'rb-title');
    root.innerHTML = '<section class="rb-window"><header class="rb-header"><div><span class="rb-kicker">REIMBURSEMENT</span><h2 id="rb-title"></h2><p id="rb-subtitle"></p></div><button type="button" id="rb-close" class="rb-close" aria-label="关闭报销模块">×</button></header><div id="rb-notice" class="rb-notice" role="status" hidden></div><main id="rb-content" class="rb-content"></main></section>';
    document.body.append(root); $('rb-close').addEventListener('click', close);
    root.addEventListener('pointerdown', event => { if (event.target === root) close(); });
    for (const kind of ['dragenter', 'dragover', 'dragleave', 'drop']) root.addEventListener(kind, handleDrop, true);
    document.addEventListener('keydown', event => {
      if (!state.open) return;
      if (window.MosaicReimbursementPreview?.isOpen()) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusable = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(item => item.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
      event.stopImmediatePropagation();
    }, true);
    api.onReimbursementEvent?.(event => {
      if (!state.open || event?.folderId !== state.folderId || event?.libraryRoot !== state.libraryRoot) return;
      if (state.workspace) { state.workspace.state = event.state; state.workspace.message = event.message || ''; }
      if (state.mode !== 'workspace') return;
      renderWorkspace();
      if (!state.working) void loadWorkspace(false, false);
    });
    api.onLibraryChanged?.(() => {
      if (!state.open || !state.folderId) return;
      state.libraryRefreshPending = true; queueLibraryRefresh();
    });
  }
  function show(mode) {
    build(); if (!state.open) state.previousFocus = document.activeElement;
    state.open = true; state.mode = mode; root.hidden = false; root.classList.toggle('rb-settings-mode', mode === 'settings'); root.classList.toggle('rb-categories-mode', mode === 'categories'); document.body.classList.add('is-reimbursement-open');
  }
  function close() {
    if (state.working) return;
    if (state.mode === 'categories') { cancelCategories(); return; }
    window.MosaicReimbursementPreview?.close();
    state.open = false; state.request++; clearLibraryRefresh(); root.hidden = true; document.body.classList.remove('is-reimbursement-open'); state.previousFocus?.focus?.();
  }
  async function open({ folderId, libraryRoot } = {}) {
    window.MosaicReimbursementPreview?.close();
    resetFileRemoval(); clearLibraryRefresh();
    show('workspace'); state.returnToWorkspace = false; state.folderId = folderId; state.libraryRoot = libraryRoot;
    state.workspace = null; state.invoiceMergePages = null; state.supplementMergePages = null; state.amountDrafts.clear(); report(''); renderWorkspace(); await loadWorkspace(false);
    $('rb-close').focus();
  }
  async function openSettings() {
    window.MosaicReimbursementPreview?.close();
    resetFileRemoval();
    state.returnToWorkspace = state.open && state.mode === 'workspace' && Boolean(state.folderId);
    show('settings'); state.loading = true; report(''); renderSettings();
    const revision = ++state.request;
    try { const profile = await api.reimbursementGetProfile(); if (revision !== state.request) return; state.profile = profile || {}; }
    catch (error) { if (revision === state.request) report(error.message || String(error), true); }
    finally { if (revision === state.request) { state.loading = false; renderSettings(); $('rb-profile-applicant')?.focus(); } }
  }
  function context() { return { folderId: state.folderId, libraryRoot: state.libraryRoot }; }
  function clearLibraryRefresh() {
    clearTimeout(libraryRefreshTimer); libraryRefreshTimer = null;
    state.libraryRefreshPending = false; state.libraryRefreshOperation = null;
  }
  function queueLibraryRefresh() {
    if (libraryRefreshTimer || state.libraryRefreshOperation || !state.libraryRefreshPending || !state.open || state.mode !== 'workspace' || busy()) return;
    const target = context();
    libraryRefreshTimer = setTimeout(async () => {
      libraryRefreshTimer = null;
      const sameContext = () => state.open && target.folderId === state.folderId && target.libraryRoot === state.libraryRoot;
      if (!sameContext() || state.mode !== 'workspace' || busy()) return;
      const operation = {};
      state.libraryRefreshOperation = operation; state.libraryRefreshPending = false;
      const canApply = () => state.libraryRefreshOperation === operation && sameContext() && state.mode === 'workspace' && !busy();
      try { await loadWorkspace(false, false, canApply); }
      finally {
        if (state.libraryRefreshOperation !== operation) return;
        if (!canApply() && sameContext()) state.libraryRefreshPending = true;
        state.libraryRefreshOperation = null; queueLibraryRefresh();
      }
    }, 80);
  }
  async function loadWorkspace(regenerate = false, showLoading = true, canApply = () => true) {
    const revision = ++state.request, target = context();
    if (showLoading) { state.loading = true; if (state.mode === 'workspace') renderWorkspace(); }
    try {
      const workspace = await (regenerate ? api.reimbursementRefresh(target) : api.reimbursementGet(target));
      if (revision !== state.request || target.folderId !== state.folderId || target.libraryRoot !== state.libraryRoot || !state.open || !canApply()) return;
      state.workspace = workspace; state.profile = workspace.profile || state.profile;
      const preview = window.MosaicReimbursementPreview?.currentRequest?.();
      if (preview && ![...workspace.categories.flatMap(category => category.items || []), ...(workspace.itinerary?.items || []), ...Object.values(workspace.artifacts || {}).filter(item => item?.ready).map(item => ({ id: item.assetId }))].some(item => item.id === preview.assetId)) window.MosaicReimbursementPreview.close();
      const pending = state.deleteConfirmation;
      if (pending && !hasFile(workspace, pending)) state.deleteConfirmation = null;
      if (state.invoiceMergePages === null) state.invoiceMergePages = workspace.invoiceMerge?.imagesPerPage || 2;
      if (state.supplementMergePages === null) state.supplementMergePages = workspace.supplementInvoiceMerge?.imagesPerPage || 2;
    } catch (error) { if (revision === state.request && state.open && canApply()) report(error.message || String(error), true); }
    finally { if (revision === state.request) { state.loading = false; if (state.open && state.mode === 'workspace') renderWorkspace(); } }
  }
  function renderSettings() {
    if (!root || state.mode !== 'settings') return;
    $('rb-title').textContent = '设置 · 报销资料'; $('rb-subtitle').textContent = '保存公司名称、申请人和收款信息，供报销申请表填写。';
    const content = $('rb-content'); content.replaceChildren();
    const form = node('form', 'rb-profile-form'); form.id = 'rb-profile-form'; form.autocomplete = 'off';
    for (const [key, label] of fields) {
      const field = node('label', 'rb-field'); field.append(node('span', '', label));
      const input = node('input', 'rb-input'); input.id = `rb-profile-${key}`; input.name = key; input.type = 'text'; input.maxLength = { applicant: 80, companyName: 180, accountName: 120, bankName: 180, accountNumber: 80 }[key]; input.value = String(state.profile[key] || ''); input.disabled = busy();
      if (key === 'accountNumber') input.inputMode = 'numeric'; field.append(input); form.append(field);
    }
    form.append(node('p', 'rb-help', '资料保存在本机。账号按文本保存，保留开头的 0。'));
    const actions = node('div', 'rb-actions');
    const cancel = button(state.returnToWorkspace ? '返回资料夹' : '取消', 'rb-secondary', () => { if (busy()) return; if (state.returnToWorkspace) { show('workspace'); renderWorkspace(); } else close(); }); cancel.disabled = busy();
    const save = button(state.working ? '正在保存…' : '保存资料', 'rb-primary'); save.type = 'submit'; save.disabled = busy(); actions.append(cancel, save); form.append(actions);
    form.addEventListener('submit', saveProfile); content.append(form);
    $('rb-close').disabled = state.working;
  }
  async function saveProfile(event) {
    event.preventDefault(); if (busy()) return;
    const profile = Object.fromEntries(fields.map(([key]) => [key, $(`rb-profile-${key}`).value]));
    state.profile = profile; state.working = true; report(''); renderSettings();
    try {
      state.profile = await api.reimbursementSaveProfile(profile); report('报销资料已保存。');
      if (state.returnToWorkspace) { state.working = false; show('workspace'); renderWorkspace(); await loadWorkspace(true); }
    } catch (error) { report(error.message || String(error), true); }
    finally { state.working = false; if (state.mode === 'settings') renderSettings(); }
  }
  function openCategories() {
    if (busy() || !state.workspace) return;
    state.deleteConfirmation = null;
    state.categoryDraft = state.workspace.categories.map(({ key, name }) => ({ key, name }));
    state.categoryNewName = ''; state.categoryNewType = 'normal'; show('categories'); report(''); renderCategoryEditor();
    $('rb-new-category-name').focus();
  }
  function cancelCategories() {
    if (state.working) return;
    state.categoryDraft = []; state.categoryNewName = ''; show('workspace'); report(''); renderWorkspace(); $('rb-manage-categories')?.focus();
  }
  function categoryError() {
    if (state.categoryDraft.length > 30) return '最多可设置 30 个分类。';
    const names = state.categoryDraft.map(item => item.name.trim());
    if (names.some(name => !name)) return '每个分类都需要填写名称。';
    if (names.some(name => name.length > 100 || /[\x00-\x1f\x7f]/.test(name))) return '分类名称最多 100 个字，不能包含控制字符。';
    if (new Set(names).size !== names.length) return '分类名称不能重复。';
    return '';
  }
  function updateCategoryActions() {
    const error = categoryError(), full = state.categoryDraft.length >= 30, hasSupplement = state.categoryDraft.some(item => item.key === 'supplement');
    $('rb-category-count').textContent = `${state.categoryDraft.length} / 30 个分类`;
    $('rb-category-error').textContent = error; $('rb-category-error').hidden = !error;
    $('rb-save-categories').disabled = busy() || Boolean(error); $('rb-cancel-categories').disabled = busy();
    const type = $('rb-new-category-type'); type.querySelector('[value="supplement"]').disabled = hasSupplement;
    if (hasSupplement && state.categoryNewType === 'supplement') { state.categoryNewType = 'normal'; type.value = 'normal'; }
    $('rb-add-category').disabled = busy() || full || !state.categoryNewName.trim() || (state.categoryNewType === 'supplement' && hasSupplement);
    type.disabled = busy() || full; $('rb-new-category-name').disabled = busy() || full;
    $('rb-category-list').querySelectorAll('input,button').forEach(control => {
      control.disabled = busy();
      if (control.dataset.categoryMove) { const index = state.categoryDraft.findIndex(item => item.key === control.closest('[data-category-key]').dataset.categoryKey), target = index + Number(control.dataset.categoryMove); control.disabled ||= target < 0 || target >= state.categoryDraft.length; }
    });
    const removed = (state.workspace?.categories || []).filter(item => !state.categoryDraft.some(draft => draft.key === item.key));
    const count = removed.reduce((sum, item) => sum + Number(item.count || 0), 0);
    $('rb-category-removal-note').textContent = removed.length ? `保存后将删除 ${removed.length} 个分类，里面的 ${count} 个文件会移到报销根目录保留。${removed.some(item => item.key === 'supplement') ? '删除补票专区后，不再生成补票发票和购买截图 PDF。' : ''}` : '删除分类时，其中的文件会移到报销根目录保留；点击保存后才会生效。';
    $('rb-close').disabled = state.working;
  }
  function renderCategoryEditor() {
    if (state.mode !== 'categories') return;
    $('rb-title').textContent = '管理报销分类'; $('rb-subtitle').textContent = '新增、重命名和调整顺序，保存后统一应用到当前资料夹。';
    const content = $('rb-content'); content.replaceChildren();
    const editor = node('div', 'rb-category-editor'); editor.id = 'rb-category-editor';
    const heading = node('div', 'rb-category-editor-heading'); heading.append(node('span', '', '分类与顺序'));
    const count = node('span'); count.id = 'rb-category-count'; heading.append(count); editor.append(heading);
    const list = node('div', 'rb-category-list'); list.id = 'rb-category-list';
    if (!state.categoryDraft.length) list.append(node('p', 'rb-help', '尚未设置分类，可在下方添加。'));
    state.categoryDraft.forEach((item, index) => {
      const row = node('div', 'rb-category-editor-row'); row.dataset.categoryKey = item.key;
      row.append(node('span', 'rb-category-position', index + 1));
      const field = node('label', 'rb-category-name-field');
      const label = node('span', 'rb-help', item.key === 'supplement' ? '补票专区 · 发票与购买截图' : '普通凭证');
      const input = node('input', 'rb-input'); input.type = 'text'; input.maxLength = 100; input.value = item.name; input.setAttribute('aria-label', `第 ${index + 1} 个分类名称`);
      input.addEventListener('input', () => { item.name = input.value; updateCategoryActions(); }); field.append(label, input); row.append(field);
      const actions = node('div', 'rb-category-row-actions');
      for (const [offset, label] of [[-1, '上移'], [1, '下移']]) {
        const move = button(label, 'rb-text-button', () => { const target = index + offset; if (busy() || target < 0 || target >= state.categoryDraft.length) return; [state.categoryDraft[index], state.categoryDraft[target]] = [state.categoryDraft[target], state.categoryDraft[index]]; renderCategoryEditor(); }); move.dataset.categoryMove = offset; actions.append(move);
      }
      const remove = button('删除', 'rb-text-button', () => { if (busy()) return; state.categoryDraft.splice(index, 1); renderCategoryEditor(); }); remove.dataset.categoryRemove = item.key; actions.append(remove); row.append(actions); list.append(row);
    });
    editor.append(list);
    const add = node('div', 'rb-category-add');
    const type = node('select', 'rb-input'); type.id = 'rb-new-category-type'; type.setAttribute('aria-label', '新分类类型');
    for (const [value, label] of [['normal', '普通凭证'], ['supplement', '补票专区（发票/截图）']]) { const option = node('option', '', label); option.value = value; type.append(option); }
    type.value = state.categoryNewType; type.addEventListener('change', () => { state.categoryNewType = type.value; updateCategoryActions(); });
    const name = node('input', 'rb-input'); name.type = 'text'; name.id = 'rb-new-category-name'; name.maxLength = 100; name.placeholder = '新分类名称'; name.setAttribute('aria-label', '新分类名称'); name.value = state.categoryNewName; name.addEventListener('input', () => { state.categoryNewName = name.value; updateCategoryActions(); });
    const addButton = button('添加分类', 'rb-secondary', () => {
      if ($('rb-add-category').disabled) return;
      state.categoryDraft.push({ key: state.categoryNewType === 'supplement' ? 'supplement' : `custom-${crypto.randomUUID()}`, name: state.categoryNewName.trim() }); state.categoryNewName = ''; state.categoryNewType = 'normal'; renderCategoryEditor(); $('rb-new-category-name').focus();
    }); addButton.id = 'rb-add-category'; add.append(type, name, addButton); editor.append(add);
    const error = node('p', 'rb-help rb-error'); error.id = 'rb-category-error'; error.setAttribute('role', 'status'); editor.append(error);
    const note = node('p', 'rb-help'); note.id = 'rb-category-removal-note'; editor.append(note);
    const actions = node('div', 'rb-actions'); const cancel = button('取消', 'rb-secondary', cancelCategories); cancel.id = 'rb-cancel-categories';
    const save = button(state.working ? '正在保存…' : '保存分类', 'rb-primary', saveCategories); save.id = 'rb-save-categories'; actions.append(cancel, save); editor.append(actions); content.append(editor); updateCategoryActions();
  }
  async function saveCategories() {
    if (busy() || categoryError()) return;
    const request = { ...context(), categories: state.categoryDraft.map(item => ({ key: item.key, name: item.name.trim() })) };
    state.working = true; report(''); updateCategoryActions(); $('rb-save-categories').textContent = '正在保存…';
    try {
      const result = await api.reimbursementSaveCategories(request);
      if (request.folderId !== state.folderId || request.libraryRoot !== state.libraryRoot) return;
      if (result?.workspace) { state.workspace = result.workspace; state.profile = result.workspace.profile || state.profile; }
      else await loadWorkspace(false, false);
      state.working = false; show('workspace'); report('分类已保存。'); renderWorkspace();
    } catch (error) {
      // Category changes can commit before generated files fail. Refresh only
      // the saved workspace, keeping the editable draft for an explicit retry.
      if (request.folderId === state.folderId && request.libraryRoot === state.libraryRoot && state.open) await loadWorkspace(false, false);
      report(error.message || String(error), true);
    }
    finally { state.working = false; if (state.mode === 'categories') renderCategoryEditor(); }
  }
  function renderWorkspace() {
    if (!root || state.mode !== 'workspace') return;
    const workspace = state.workspace, content = $('rb-content'); content.replaceChildren();
    $('rb-title').textContent = workspace?.name || '报销资料夹'; $('rb-subtitle').textContent = workspace ? `${workspace.date || ''} · 按分类归档发票与附件` : '正在读取报销资料夹…';
    const bar = node('div', 'rb-workspace-bar');
    const heading = node('div'); heading.append(node('h3', '', '报销资料'), node('p', 'rb-help', fields.map(([key, label]) => `${label}：${workspace?.profile?.[key] || '未填写'}`).join('　')));
    const settings = button('编辑报销资料', 'rb-secondary', openSettings); settings.disabled = busy();
    const categoryActions = node('div', 'rb-workspace-actions'), manage = button('管理分类', 'rb-secondary', openCategories); manage.id = 'rb-manage-categories'; manage.disabled = busy() || !workspace; categoryActions.append(settings, manage); bar.append(heading, categoryActions); content.append(bar);
    if (workspace?.amounts) {
      const totals = node('div', 'rb-amount-total'); totals.id = 'rb-amount-total';
      const pending = Number(workspace.amounts.pendingCount) || 0;
      totals.append(node('strong', '', `${pending ? '已识别小计' : '报销总额'} ¥${workspace.amounts.totalAmount || '0.00'}`));
      totals.append(node('span', pending ? 'rb-amount-pending' : 'rb-help', pending ? `待核对 ${pending} 页，核对完成后写入完整总额。` : '发票金额按分类汇总，购买截图不计入。'));
      content.append(totals);
    }
    const categories = node('div', 'rb-categories');
    for (const category of workspace?.categories || []) {
      const card = node('section', 'rb-category'); card.dataset.category = category.key; card.dataset.folderId = category.folderId; card.dataset.reimbursementCategory = category.key;
      const top = node('div', 'rb-category-title'); top.append(node('h3', '', category.name), node('span', 'rb-count', `${category.count ?? category.items?.length ?? 0} 个文件`));
      const isSupplement = category.key === 'supplement';
      card.append(top);
      if (category.invoiceCount !== undefined) card.append(node('p', 'rb-category-amount', `${category.invoiceCount} 页发票 · ${category.pendingCount ? '已识别小计' : '合计'} ¥${category.amount || '0.00'}${category.pendingCount ? ` · 待核对 ${category.pendingCount}` : ''}`));
      if (isSupplement) {
        card.classList.add('rb-supplement-card');
        card.append(fileZone(category, 'invoice', '补票发票', '图片或 PDF，识别金额并计入报销', category.invoiceItems || []), fileZone(category, 'evidence', '购买截图', '仅图片，识别金额供参考，不计入报销，生成说明 PDF', category.evidenceItems || [], workspace.evidenceAmounts));
      } else {
        card.append(node('p', 'rb-help', '拖入发票、图片或文档附件'));
        appendFileList(card, category.items || [], category);
        const add = button('添加文件…', 'rb-text-button', () => importCategory(category.key, undefined, 'invoice')); add.disabled = busy(); card.append(add);
      }
      categories.append(card);
    }
    if (!workspace) categories.append(node('p', 'rb-help', state.loading ? '正在读取分类…' : '资料夹暂不可用，请重试。'));
    else if (!workspace.categories.length) { const empty = node('div', 'rb-category-empty'); empty.append(node('p', 'rb-help', '还没有分类，可以按报销需要添加。')); empty.append(button('添加分类', 'rb-secondary', openCategories)); categories.append(empty); }
    content.append(categories);
    if (workspace) {
      const itinerary = node('section', 'rb-itinerary rb-drop-zone'); itinerary.id = 'rb-itinerary'; itinerary.dataset.purpose = 'itinerary';
      const heading = node('div', 'rb-category-title'), items = workspace.itinerary?.items || [];
      heading.append(node('h3', '', '打车行程单'), node('span', 'rb-count', `${workspace.itinerary?.count ?? items.length} 个文件`));
      itinerary.append(heading, node('p', 'rb-help', '拖入行程单图片或 PDF，自动合并为独立 PDF；不识别金额，不计入报销总额。'));
      appendFileList(itinerary, items, { key: 'itinerary', purpose: 'itinerary' });
      const add = button('添加行程单…', 'rb-text-button', () => importCategory(undefined, undefined, 'itinerary')); add.id = 'rb-add-itinerary'; add.disabled = busy() || workspace.state === 'generating'; itinerary.append(add); content.append(itinerary);
    }
    if (workspace?.amounts) content.append(amountReview(workspace));
    if (workspace?.evidenceAmounts?.items?.length) content.append(amountReview(workspace, 'evidence'));
    const outputs = node('section', 'rb-outputs');
    const outputHeading = node('div', 'rb-outputs-heading'); outputHeading.append(node('h3', '', '自动生成文件'));
    const exportAll = button(state.exportingAll ? '正在导出…' : '一键导出全部', 'rb-primary', exportAllArtifacts); exportAll.id = 'rb-export-all'; exportAll.title = '准备申请表与全部 PDF，导出到独立文件夹'; exportAll.disabled = busy() || !workspace?.artifacts?.form?.ready || workspace?.state === 'generating'; outputHeading.append(exportAll); outputs.append(outputHeading);
    const grid = node('div', 'rb-output-grid');
    const supplement = workspace?.categories.find(item => item.key === 'supplement');
    for (const [kind, title, description] of [['form', '报销申请表', '自动填写日期、资料和按分类核对的发票金额。空分类不写入。'], ['supplementPdf', '购买截图说明 PDF', supplement ? `仅合并“${supplement.name}”内的购买截图，不计报销金额。` : '添加补票分类后，可导入购买截图生成说明 PDF。'], ['itineraryPdf', '打车行程单 PDF', '仅合并独立行程单区的图片和 PDF，不识别金额，不计入报销总额。']]) {
      const artifact = workspace?.artifacts?.[kind], card = node('section', 'rb-output-card'); card.dataset.artifact = kind;
      card.append(node('h4', '', title), node('p', 'rb-help', description));
      const stale = kind === 'itineraryPdf' && workspace?.itinerary?.stale;
      const ready = artifact?.ready === true && !stale && workspace?.state !== 'generating' && (kind !== 'supplementPdf' || Boolean(supplement));
      card.append(ready ? previewName(artifact.name, artifact.assetId, 1, `artifact:${kind}`, 'rb-output-status') : node('p', 'rb-output-status', workspace?.state === 'generating' ? '正在更新生成文件…' : stale ? workspace.itinerary.message || '行程单已变化，请刷新生成文件。' : kind === 'supplementPdf' ? supplement ? '待添加购买截图' : '未设置补票专区' : kind === 'itineraryPdf' ? '待添加打车行程单' : '申请表尚未生成'));
      const actions = node('div', 'rb-output-actions');
      for (const [label, method] of [[kind === 'form' ? '打开申请表' : '打开预览', 'open'], ['导出…', 'export']]) { const action = button(label, 'rb-secondary', () => artifactAction(kind, method)); action.disabled = busy() || !ready; actions.append(action); }
      card.append(actions); grid.append(card);
    }
    grid.append(invoiceMergeCard(workspace));
    grid.append(invoiceMergeCard(workspace, 'supplement'));
    outputs.append(grid); content.append(outputs);
    const footer = node('div', 'rb-workspace-footer');
    const message = node('p', workspace?.state === 'error' ? 'rb-help rb-error' : 'rb-help', workspace?.message || '文件导入后会更新申请表与补票截图 PDF。'); message.setAttribute('role', 'status');
    const refresh = button(state.loading ? '正在刷新…' : workspace?.amounts?.pendingCount || workspace?.evidenceAmounts?.pendingCount ? '重试识别并更新' : '刷新生成文件', 'rb-secondary', () => { report(''); void loadWorkspace(true); }); refresh.id = 'rb-refresh-workspace'; refresh.disabled = busy() || !workspace || workspace.state === 'generating';
    const actions = node('div', 'rb-workspace-actions'); actions.append(refresh);
    if (workspace?.state === 'generating') { const cancel = button(state.cancelling ? '正在取消…' : '取消当前处理', 'rb-secondary', cancelProcessing); cancel.id = 'rb-cancel-processing'; cancel.disabled = state.cancelling; actions.append(cancel); }
    footer.append(message, actions); content.append(footer);
    $('rb-close').disabled = state.working;
    queueLibraryRefresh();
  }
  function resetFileRemoval() {
    state.deleteConfirmation = null;
    if (state.deleteOperation) { state.deleteOperation = null; state.working = false; }
  }
  function hasFile(workspace, reference) {
    return reference.purpose === 'itinerary' ? workspace?.itinerary?.items?.some(item => item.id === reference.assetId)
      : workspace?.categories?.some(category => category.key === reference.category && category.items?.some(item => item.id === reference.assetId));
  }
  function appendFileList(container, items, category) {
    const list = node('ul', 'rb-file-list');
    for (const item of items) {
      const row = node('li', 'rb-file-row'); row.dataset.fileId = item.id;
      const name = previewName(item.name, item.id, 1, `file:${item.id}`, 'rb-file-name');
      const remove = button('删除', 'rb-file-remove', () => {
        if (busy() || state.workspace?.state === 'generating') return;
        state.deleteConfirmation = { ...context(), category: category.key, assetId: item.id, ...(category.purpose === 'itinerary' ? { purpose: 'itinerary' } : {}) };
        renderWorkspace(); root.querySelector(`[data-confirm-remove-file="${CSS.escape(item.id)}"]`)?.focus();
      });
      remove.dataset.removeFile = item.id; remove.title = `删除 ${item.name}`; remove.setAttribute('aria-label', `删除 ${item.name}`);
      remove.disabled = busy() || state.workspace?.state === 'generating';
      row.append(name, node('small', '', String(item.ext || '').toUpperCase()), remove);
      const pending = state.deleteConfirmation;
      if (pending?.assetId === item.id && pending.category === category.key && pending.folderId === state.folderId && pending.libraryRoot === state.libraryRoot) {
        const confirmation = node('div', 'rb-file-confirmation');
        confirmation.append(node('p', '', '移到回收站，可恢复。'));
        const actions = node('div', 'rb-file-confirm-actions');
        const confirm = button(state.deleteOperation?.assetId === item.id ? '正在删除…' : '确认删除', 'rb-file-remove', () => removeFile(category, item));
        confirm.dataset.confirmRemoveFile = item.id; confirm.setAttribute('aria-label', `确认删除 ${item.name}`); confirm.disabled = remove.disabled;
        const cancel = button('取消', 'rb-text-button', () => {
          if (busy()) return;
          state.deleteConfirmation = null; renderWorkspace(); root.querySelector(`[data-remove-file="${CSS.escape(item.id)}"]`)?.focus();
        });
        cancel.dataset.cancelRemoveFile = item.id; cancel.setAttribute('aria-label', `取消删除 ${item.name}`); cancel.disabled = busy();
        actions.append(confirm, cancel); confirmation.append(actions); row.append(confirmation);
      }
      list.append(row);
    }
    if (items.length) container.append(list);
    else container.append(node('div', 'rb-drop-hint', '将文件拖到这里'));
  }
  async function removeFile(category, item) {
    if (busy() || state.workspace?.state === 'generating') return;
    const pending = state.deleteConfirmation;
    if (pending?.assetId !== item.id || pending.category !== category.key || pending.folderId !== state.folderId || pending.libraryRoot !== state.libraryRoot) return;
    if (!hasFile(state.workspace, pending)) return;
    const operation = { ...context(), category: category.key, assetId: item.id, ...(category.purpose === 'itinerary' ? { purpose: 'itinerary' } : {}) };
    state.deleteOperation = operation; state.working = true; report(''); renderWorkspace();
    const active = () => state.deleteOperation === operation && state.open && operation.folderId === state.folderId && operation.libraryRoot === state.libraryRoot;
    try {
      const result = await api.reimbursementRemoveFile(operation);
      if (!active()) return;
      if (!result?.removed) throw new Error('文件未删除，请重试。');
      if (result.workspace) { state.workspace = result.workspace; state.profile = result.workspace.profile || state.profile; }
      else await loadWorkspace(false, false);
      if (!active()) return;
      state.deleteConfirmation = null;
      for (const key of state.amountDrafts.keys()) if (['invoice', 'evidence'].some(purpose => key.startsWith(`${purpose}:${item.id}:`))) state.amountDrafts.delete(key);
      const syncError = result.syncError?.message || result.syncError;
      report(syncError ? `“${item.name}”已移到回收站，但报销表同步失败：${syncError}` : `“${item.name}”已移到回收站，可在回收站恢复。`, Boolean(syncError));
    } catch (error) { if (active()) report(error.message || String(error), true); }
    finally {
      if (state.deleteOperation === operation) { state.deleteOperation = null; state.working = false; if (state.open && state.mode === 'workspace') renderWorkspace(); }
    }
  }
  function fileZone(category, purpose, title, hint, items, evidenceAmounts) {
    const zone = node('section', 'rb-drop-zone'); zone.dataset.purpose = purpose;
    zone.append(node('h4', '', title), node('p', 'rb-help', hint));
    if (purpose === 'evidence' && items.length) {
      const pending = Number(category.evidencePendingCount ?? evidenceAmounts?.pendingCount) || 0;
      const invoicePending = Number(category.pendingCount) || 0;
      const cents = category.evidenceAmountCents ?? evidenceAmounts?.totalCents, invoiceCents = category.amountCents;
      const missingAmount = !Number.isSafeInteger(cents) || !Number.isSafeInteger(invoiceCents);
      const remaining = pending || invoicePending || missingAmount ? '待核对后计算' : `${window.MosaicInvoiceAmounts.formatAmount(Math.max(0, cents - invoiceCents))} 元`;
      const totals = node('div', 'rb-evidence-totals'); totals.dataset.evidenceTotals = category.key;
      totals.append(node('p', 'rb-evidence-subtotal', `${pending ? '截图已识别小计' : '截图参考合计'}：${category.evidenceAmount ?? evidenceAmounts?.totalAmount ?? '0.00'} 元${pending ? ` · 待核对 ${pending} 张` : ''}`),
        node('p', 'rb-evidence-subtotal', `${invoicePending ? '补票发票已识别小计' : '已有补票发票合计'}：${category.amount || '0.00'} 元${invoicePending ? ` · 待核对 ${invoicePending} 页` : ''}`));
      const difference = node('p', 'rb-evidence-difference', `还需补票参考金额：${remaining}`); difference.dataset.evidenceDifference = category.key; totals.append(difference, node('p', 'rb-evidence-subtotal', '仅作补票整理参考，不计入正式报销总额。')); zone.append(totals);
    }
    appendFileList(zone, items, category);
    const add = button(purpose === 'evidence' ? '添加购买截图…' : '添加补票发票…', 'rb-text-button', () => importCategory(category.key, undefined, purpose)); add.disabled = busy(); zone.append(add); return zone;
  }
  const amountDraftKey = (item, purpose) => `${purpose}:${item.assetId}:${item.pageNumber || 1}`;
  function previewName(label, assetId, pageNumber, key, className = '') {
    const name = button(label, `rb-preview-name ${className}`, event => {
      if (!assetId || busy()) return;
      window.MosaicReimbursementPreview.open({ request: { ...context(), assetId, pageNumber }, name: label, returnFocus: event.currentTarget });
    });
    name.dataset.previewKey = key; name.title = `单击预览：${label}`; name.setAttribute('aria-label', `预览 ${label}`); name.disabled = busy() || !assetId;
    return name;
  }
  function amountReview(workspace, purpose = 'invoice') {
    const evidence = purpose === 'evidence', amounts = evidence ? workspace.evidenceAmounts : workspace.amounts;
    const section = node('section', `rb-amount-review${evidence ? ' rb-evidence-review' : ''}`); section.id = evidence ? 'rb-evidence-amount-review' : 'rb-amount-review';
    section.append(node('h3', '', evidence ? '购买截图金额（不计入报销）' : '发票金额核对'), node('p', 'rb-help', evidence ? '自动识别的金额仅供参考，可手动核对或忽略，不写入报销总额。' : '按发票页核对金额，保存后自动汇总到所属分类；不计报销的页可排除。购买截图不计入报销。'));
    if (evidence) {
      const summary = node('p', 'rb-evidence-subtotal'); summary.id = 'rb-evidence-amount-total';
      summary.textContent = `截图识别小计：${amounts?.totalAmount || '0.00'} 元（仅供参考）${amounts?.pendingCount ? ` · 待核对 ${amounts.pendingCount} 张` : ''}`; section.append(summary);
    }
    const items = amounts?.items || [];
    if (!items.length) { section.append(node('p', 'rb-help', '导入发票图片或 PDF 后，将在这里显示每页金额。')); return section; }
    const categories = new Map(workspace.categories.map(category => [category.key, category.name]));
    const rows = node('div', 'rb-amount-rows');
    for (const item of items) {
      const pageNumber = item.pageNumber || 1, key = amountDraftKey(item, purpose);
      const excluded = item.status === 'excluded', pending = item.status === 'pending';
      const known = !excluded && !pending && Number.isSafeInteger(item.amountCents) && item.amountCents >= 0;
      const row = node('div', 'rb-amount-row'); row.dataset.amountAsset = item.assetId; row.dataset.amountPage = pageNumber; row.dataset.amountPurpose = purpose;
      const wholeDocument = String(item.reason || '').includes('整份文件');
      const info = node('div', 'rb-amount-info'); info.append(previewName(`${item.name || (evidence ? '购买截图' : '发票')} · ${wholeDocument ? '整份文件' : `第 ${pageNumber} 页`}`, item.assetId, wholeDocument ? 1 : pageNumber, `amount:${key}`), node('span', '', categories.get(item.categoryKey) || '未分类'));
      const status = { recognized: '自动识别', manual: '手动确认', pending: '待核对', excluded: evidence ? '已忽略参考金额' : '已排除，不计金额' }[item.status] || '待核对';
      info.append(node('small', pending ? 'rb-amount-pending' : '', `${status}${item.reason ? ` · ${String(item.reason).slice(0, 200)}` : ''}`));
      if (!known && item.detectedAmount) info.append(node('small', '', `识别参考：${item.detectedAmount} 元`));
      const field = node('label', 'rb-amount-field'); field.append(node('span', '', '金额（元）'));
      const input = node('input', 'rb-input'); input.type = 'text'; input.inputMode = 'decimal'; input.maxLength = 80; input.placeholder = excluded ? evidence ? '填写后恢复参考金额' : '填写后恢复计入' : '待核对'; input.dataset.amountInput = key;
      input.value = state.amountDrafts.get(key) ?? (known ? item.amount || window.MosaicInvoiceAmounts?.formatAmount(item.amountCents) || '' : item.detectedAmount ?? '');
      input.setAttribute('aria-label', `${item.name || (evidence ? '购买截图' : '发票')}第${pageNumber}页${evidence ? '参考' : ''}金额（元）`); input.disabled = busy() || workspace.state === 'generating';
      field.append(input);
      const actions = node('div', 'rb-amount-actions');
      const save = button(excluded ? evidence ? '恢复参考金额' : '恢复计入' : known ? '保存修改' : evidence ? '确认参考金额' : '确认金额', 'rb-secondary', () => saveAmount(item, input.value, false, purpose)); save.dataset.amountSave = key;
      const update = () => {
        const cents = window.MosaicInvoiceAmounts?.parseAmount(input.value) ?? null;
        save.disabled = busy() || workspace.state === 'generating' || cents === null || (known && cents === item.amountCents);
        input.setAttribute('aria-invalid', String(input.value.trim() !== '' && cents === null));
      };
      input.addEventListener('input', () => { state.amountDrafts.set(key, input.value); update(); }); update();
      const exclude = button(excluded ? evidence ? '已忽略' : '已排除' : evidence ? '忽略参考金额' : '排除此页', 'rb-text-button', () => saveAmount(item, null, true, purpose)); exclude.dataset.amountExclude = key; exclude.disabled = excluded || busy() || workspace.state === 'generating';
      actions.append(save, exclude); row.append(info, field, actions); rows.append(row);
    }
    section.append(rows); return section;
  }
  async function saveAmount(item, value, excluded, purpose = 'invoice') {
    if (busy() || state.workspace?.state === 'generating') return;
    const cents = excluded ? null : window.MosaicInvoiceAmounts?.parseAmount(value) ?? null;
    if (!excluded && cents === null) { report('请输入有效金额，最多两位小数。', true); return; }
    const evidence = purpose === 'evidence';
    const request = { ...context(), assetId: item.assetId, pageNumber: item.pageNumber || 1, amount: excluded ? null : window.MosaicInvoiceAmounts.formatAmount(cents), excluded, ...(evidence ? { purpose } : {}) };
    state.working = true; report(''); renderWorkspace();
    try {
      const result = await api.reimbursementSetAmount(request);
      if (request.folderId !== state.folderId || request.libraryRoot !== state.libraryRoot) return;
      if (result?.workspace) state.workspace = result.workspace; else await loadWorkspace(false, false);
      state.amountDrafts.delete(amountDraftKey(item, purpose));
      report(evidence ? excluded ? '已忽略此截图的参考金额，报销总额保持不变。' : '截图参考金额已保存，不计入报销总额。' : excluded ? '此页已排除，不计报销金额。' : '金额已保存，报销表会自动更新。');
    } catch (error) { report(error.message || String(error), true); }
    finally { state.working = false; if (state.mode === 'workspace') renderWorkspace(); }
  }
  async function cancelProcessing() {
    if (state.cancelling) return;
    const request = context(); state.cancelling = true; renderWorkspace();
    try { await api.reimbursementCancel(request); await loadWorkspace(false, false); report('已请求取消当前处理。'); }
    catch (error) { report(error.message || String(error), true); }
    finally { state.cancelling = false; if (state.mode === 'workspace') renderWorkspace(); }
  }
  function invoiceMergeCard(workspace, scope = 'normal') {
    const supplementary = scope === 'supplement', kind = supplementary ? 'supplementInvoicePdf' : 'invoicePdf';
    const artifact = workspace?.artifacts?.[kind], merge = (supplementary ? workspace?.supplementInvoiceMerge : workspace?.invoiceMerge) || {};
    const sourceCount = Number(merge.sourceCount) || 0, unsupportedCount = Number(merge.unsupportedCount) || 0;
    const pages = (supplementary ? state.supplementMergePages : state.invoiceMergePages) ?? merge.imagesPerPage ?? 2;
    const layoutChanged = artifact?.ready && pages !== (merge.imagesPerPage || 2);
    const stale = merge.stale === true || layoutChanged;
    const blocked = busy() || workspace?.state === 'generating';
    const ready = artifact?.ready === true && !stale && !blocked;
    const card = node('section', 'rb-output-card rb-invoice-merge'); card.dataset.artifact = kind;
    card.append(node('h4', '', supplementary ? '补票发票合并 PDF' : '合并发票 PDF'), node('p', 'rb-help', supplementary ? '仅合并补票发票中的图片和 PDF，购买截图不包含在内。' : '合并普通分类中的图片和 PDF，补票分类不包含在内。'));
    card.append(node('p', 'rb-invoice-source-count', `${sourceCount} 个可合并来源 · A4 纸张`));
    if (unsupportedCount) card.append(node('p', 'rb-help rb-invoice-unsupported', `${unsupportedCount} 个其他格式文档未合并。`));
    const label = node('label', 'rb-invoice-layout'); label.append(node('span', '', '每页张数'));
    const select = node('select', 'rb-input'); select.id = supplementary ? 'rb-supplement-invoice-per-page' : 'rb-invoice-per-page'; select.disabled = blocked;
    for (const value of [1, 2, 3, 4, 6, 8, 9]) { const option = node('option', '', `每页 ${value} 张`); option.value = value; select.append(option); }
    select.value = String(pages); select.addEventListener('change', () => { if (supplementary) state.supplementMergePages = Number(select.value); else state.invoiceMergePages = Number(select.value); renderWorkspace(); }); label.append(select); card.append(label);
    const merging = state.mergingInvoices && state.mergingScope === scope;
    const status = workspace?.state === 'generating' ? workspace.message || '正在生成文件…' : merging ? '正在合并发票…' : stale ? layoutChanged ? '排版已更改，请重新合并。' : merge.message || '来源已变化，请重新合并。' : artifact?.ready ? artifact.name : sourceCount ? '选择每页张数后即可合并。' : '暂无可合并的图片或 PDF。';
    card.append(ready ? previewName(artifact.name, artifact.assetId, 1, `artifact:${kind}`, 'rb-output-status') : node('p', 'rb-output-status', status));
    const mergeButton = button(merging ? '正在合并…' : artifact?.ready ? '重新合并' : '一键合并', 'rb-secondary', () => mergeInvoices(scope)); mergeButton.id = supplementary ? 'rb-merge-supplement-invoices' : 'rb-merge-invoices'; mergeButton.disabled = blocked || !sourceCount;
    const actions = node('div', 'rb-output-actions'); actions.append(mergeButton);
    for (const [text, method] of [['打开预览', 'open'], ['导出…', 'export']]) { const action = button(text, 'rb-secondary', () => artifactAction(kind, method)); if (supplementary) action.dataset.supplementInvoiceAction = method; else action.dataset.invoiceAction = method; action.disabled = !ready; actions.append(action); }
    card.append(actions); return card;
  }
  async function mergeInvoices(scope = 'normal') {
    const supplementary = scope === 'supplement';
    if ($(supplementary ? 'rb-merge-supplement-invoices' : 'rb-merge-invoices')?.disabled || busy()) return;
    const request = { ...context(), ...(supplementary ? { scope } : {}), imagesPerPage: Number($(supplementary ? 'rb-supplement-invoice-per-page' : 'rb-invoice-per-page').value) };
    state.working = true; state.mergingInvoices = true; state.mergingScope = scope; report(''); renderWorkspace();
    try {
      const result = await api.reimbursementMergeInvoices(request);
      if (request.folderId !== state.folderId || request.libraryRoot !== state.libraryRoot) return;
      if (result?.workspace) { state.workspace = result.workspace; if (supplementary) state.supplementMergePages = result.workspace.supplementInvoiceMerge?.imagesPerPage || request.imagesPerPage; else state.invoiceMergePages = result.workspace.invoiceMerge?.imagesPerPage || request.imagesPerPage; }
      else await loadWorkspace(false, false);
      report(supplementary ? '补票发票合并 PDF 已生成。' : '合并发票 PDF 已生成。');
    } catch (error) {
      if (request.folderId === state.folderId && request.libraryRoot === state.libraryRoot && state.open) await loadWorkspace(false, false);
      report(error.message || String(error), true);
    } finally { state.working = false; state.mergingInvoices = false; state.mergingScope = null; if (state.mode === 'workspace') renderWorkspace(); }
  }
  async function importCategory(category, paths, purpose = 'invoice') {
    if (busy() || !state.workspace) return;
    if (purpose === 'itinerary' && state.workspace.state === 'generating') return;
    const target = { ...context(), ...(category ? { category } : {}), purpose }; state.working = true; report('正在导入文件…'); renderWorkspace();
    try {
      const result = await (paths ? api.reimbursementImport({ ...target, paths }) : api.reimbursementChooseImport(target));
      if (result?.cancelled) { report('已取消添加。'); return; }
      if (target.folderId !== state.folderId || target.libraryRoot !== state.libraryRoot) return;
      if (result?.workspace) { state.workspace = result.workspace; state.profile = result.workspace.profile || state.profile; }
      else await loadWorkspace(false, false);
      const imported = Number(result?.report?.imported || 0), restored = Number(result?.report?.restored || 0), duplicates = Number(result?.report?.duplicates || 0);
      const errors = Array.isArray(result?.report?.errors) ? result.report.errors : [];
      const lines = [];
      if (imported) lines.push(`${imported} 个已导入。`);
      if (restored) lines.push(`已恢复 ${restored} 个文件到${purpose === 'itinerary' ? '行程单区' : '当前分类'}。`);
      if (imported || restored) lines.push('生成文件会自动更新。');
      else lines.push('本次没有新增或恢复文件。');
      if (duplicates) lines.push(`${duplicates} 个文件已在素材库中，本次未重复添加。`);
      for (const error of errors.slice(0, 3)) lines.push(typeof error === 'string' ? error : `${error.path || error.name || '文件'}：${error.message || error.error || '导入失败'}`);
      report(lines.join('\n'), errors.length > 0);
    } catch (error) { report(error.message || String(error), true); }
    finally { state.working = false; if (state.mode === 'workspace') renderWorkspace(); }
  }
  async function artifactAction(kind, method) {
    if (busy()) return;
    if (method === 'open' && kind !== 'form') {
      const artifact = state.workspace?.artifacts?.[kind];
      if (artifact?.ready) window.MosaicReimbursementPreview.open({ request: { ...context(), assetId: artifact.assetId, pageNumber: 1 }, name: artifact.name, returnFocus: document.activeElement });
      return;
    }
    state.working = true; renderWorkspace();
    try {
      const request = { ...context(), kind };
      if (method === 'open') await api.reimbursementOpenArtifact(request);
      else { const result = await api.reimbursementExport(request); if (result?.saved) report(`已导出：${result.path || ''}`); else if (result?.cancelled) report('已取消导出。'); }
    } catch (error) { report(error.message || String(error), true); }
    finally { state.working = false; renderWorkspace(); }
  }
  async function exportAllArtifacts() {
    if (busy() || !state.workspace?.artifacts?.form?.ready || state.workspace.state === 'generating') return;
    const request = context(); state.exportingAll = request; state.working = true; report('正在准备并导出全部文件…'); renderWorkspace();
    const active = () => state.exportingAll === request && state.open && request.folderId === state.folderId && request.libraryRoot === state.libraryRoot;
    try {
      const result = await api.reimbursementExportAll(request);
      if (!active()) return;
      if (result?.saved) { await loadWorkspace(false, false); if (active()) report(`已导出 ${Number(result.count) || 0} 个文件：${result.path || ''}`); }
      else if (result?.cancelled) report('已取消导出。');
    } catch (error) { if (active()) report(error.message || String(error), true); }
    finally { if (state.exportingAll === request) { state.exportingAll = null; state.working = false; if (state.open && state.mode === 'workspace') renderWorkspace(); } }
  }
  function handleDrop(event) {
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length && ![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const card = event.target.closest?.('.rb-category'), itinerary = event.target.closest?.('#rb-itinerary'), zone = event.target.closest?.('.rb-drop-zone') || card;
    if (event.type === 'dragleave') { if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('is-drop-target'); return; }
    const validTarget = itinerary ? state.workspace?.state !== 'generating' : card && (card.dataset.category !== 'supplement' || zone?.dataset.purpose);
    if (event.type === 'dragenter' || event.type === 'dragover') { if (event.dataTransfer) event.dataTransfer.dropEffect = validTarget && !busy() ? 'copy' : 'none'; if (validTarget && !busy()) zone.classList.add('is-drop-target'); return; }
    root.querySelectorAll('.is-drop-target').forEach(item => item.classList.remove('is-drop-target'));
    if (state.mode !== 'workspace' || busy()) return;
    if (!card && !itinerary) { report('请将文件拖到对应的分类或行程单区。'); return; }
    if (!validTarget) { report(itinerary ? '正在处理文件，请稍候再添加行程单。' : '请拖到“补票发票”或“购买截图”区域。'); return; }
    try { const paths = files.map(file => api.getFilePath(file)).filter(Boolean); if (paths.length) void importCategory(itinerary ? undefined : card.dataset.category, paths, itinerary ? 'itinerary' : zone.dataset.purpose || 'invoice'); }
    catch (error) { report(error.message || String(error), true); }
  }
  window.shituReimbursements = Object.freeze({ open, openSettings, isOpen: () => state.open });
})();
