/* Independent invoice workspace. Files and recognition run in the main process. */
(() => {
  'use strict';
  const api = window.shitu;
  const state = { open: false, assets: [], selectedLibrary: new Set(), libraryRoot: null, items: [], amounts: new Map(), confirmed: false, imagesPerPage: 2, orientation: 'portrait', language: null, previewId: null, previewUrl: null, previewGeneration: 0, previewError: '', previewZoomed: false, importing: false, removing: false, runtime: {}, job: null, previousFocus: null };
  let root;
  const $ = id => root.querySelector(`#${id}`);
  const text = (target, value) => { target.textContent = value == null ? '' : String(value); };
  const node = (tag, cls, value) => { const result = document.createElement(tag); if (cls) result.className = cls; if (value !== undefined) text(result, value); return result; };
  const button = (label, cls, click) => { const result = node('button', cls, label); result.type = 'button'; if (click) result.addEventListener('click', click); return result; };
  const busy = () => state.importing || state.removing || Boolean(state.job && !['complete', 'error', 'cancelled'].includes(state.job.status));
  const parse = value => window.MosaicInvoiceAmounts?.parseAmount(value) ?? null;
  const report = (message, error = false) => { text($('iv-notice'), message); $('iv-notice').hidden = !message; $('iv-notice').classList.toggle('iv-error', error); };
  function build() {
    if (root) return;
    root = node('section', 'iv-overlay'); root.id = 'invoiceCenter'; root.hidden = true; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'iv-title');
    root.innerHTML = '<div class="iv-window"><header class="iv-header"><div><span class="iv-kicker">INVOICE WORKSPACE</span><h2 id="iv-title">发票整合</h2><p>核对金额、调整顺序，将发票整合为 PDF。</p></div><button id="iv-close" type="button" class="iv-close" aria-label="关闭发票整合">×</button></header><div id="iv-notice" class="iv-notice" role="status" hidden></div><div class="iv-body"><main class="iv-main"><div class="iv-toolbar"><button type="button" id="iv-add" class="iv-secondary">添加发票图片 / PDF…</button><button type="button" id="iv-recognize" class="iv-secondary">识别发票金额</button><span id="iv-count"></span></div><details id="iv-library" class="iv-library"><summary>从素材库选择图片或 PDF</summary><div id="iv-library-items" class="iv-library-items"></div><button type="button" id="iv-add-library" class="iv-secondary">添加所选素材</button></details><div id="iv-items" class="iv-items" aria-label="发票顺序和金额"></div></main><aside class="iv-settings"><h3>排版与合计</h3><label class="iv-field"><span>每页发票数量</span><select id="iv-per-page" class="iv-input"></select></label><label class="iv-field"><span>页面方向</span><select id="iv-orientation" class="iv-input"><option value="portrait">纵向 A4</option><option value="landscape">横向 A4</option></select></label><div id="iv-summary" class="iv-summary" aria-live="polite"></div><label class="iv-confirm"><input type="checkbox" id="iv-confirm"><span>已核对每张发票金额</span></label><p class="iv-note">PDF 的每一页按一张发票计数。可直接修改金额，点击缩略图查看原图。</p><p id="iv-runtime" class="iv-note"></p></aside></div><footer class="iv-footer"><div class="iv-progress-content"><strong id="iv-job-title">核对金额后整合发票</strong><p id="iv-job-message">文件名自动包含发票数量和金额合计。</p><div id="iv-result" class="iv-result" hidden></div><progress id="iv-progress" max="100" value="0" hidden></progress></div><button type="button" id="iv-cancel" class="iv-secondary" hidden>取消任务</button><button type="button" id="iv-export" class="iv-primary">整合导出 PDF</button></footer></div>';
    document.body.append(root);
    const languageField = node('label', 'iv-field'); languageField.append(node('span', '', '识别语言'));
    const language = node('select', 'iv-input'); language.id = 'iv-language'; languageField.append(language);
    $('iv-per-page').closest('label').before(languageField);
    language.addEventListener('change', () => { state.language = language.value; });
    const clear = button('清空', 'iv-text-button', () => removeItems(state.items.map(item => item.id))); clear.id = 'iv-clear'; $('iv-count').before(clear);
    for (const value of [1, 2, 3, 4, 6, 8, 9]) { const option = node('option', '', `每页 ${value} 张`); option.value = value; $('iv-per-page').append(option); }
    $('iv-per-page').value = String(state.imagesPerPage);
    $('iv-per-page').addEventListener('change', () => { state.imagesPerPage = Number($('iv-per-page').value); });
    $('iv-orientation').addEventListener('change', () => { state.orientation = $('iv-orientation').value; });
    $('iv-confirm').addEventListener('change', () => { state.confirmed = $('iv-confirm').checked; updateControls(); });
    $('iv-add').addEventListener('click', () => addFiles());
    $('iv-add-library').addEventListener('click', () => addFiles([...state.selectedLibrary]));
    $('iv-recognize').addEventListener('click', () => run('recognize'));
    $('iv-export').addEventListener('click', () => run('export'));
    $('iv-cancel').addEventListener('click', cancel);
    $('iv-close').addEventListener('click', close);
    root.addEventListener('pointerdown', event => { if (event.target === root) close(); });
    document.addEventListener('keydown', event => {
      if (!state.open) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusable = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(item => item.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
      event.stopImmediatePropagation();
    }, true);
    api.onInvoiceEvent?.(handleEvent);
  }
  async function refresh() {
    try { state.runtime = await api.invoiceStatus(); }
    catch (error) { state.runtime = { ocrReady: false, error: error.message || String(error) }; }
    if (root) { updateLanguages(); updateControls(); }
  }
  function updateLanguages() {
    const languages = state.runtime?.languages || [];
    const input = $('iv-language'); input.replaceChildren();
    for (const [tag, name] of [['auto', '跟随系统'], ...languages.map(language => [language.tag, language.name || language.tag])]) {
      const option = node('option', '', name); option.value = tag; input.append(option);
    }
    if (state.language === null) state.language = languages.find(language => /^zh(?:-|$)/i.test(language.tag))?.tag || 'auto';
    if (![...input.options].some(option => option.value === state.language)) state.language = 'auto';
    input.value = state.language;
  }
  async function open({ assets = [], selectedIds = [], libraryRoot } = {}) {
    build(); state.previousFocus = document.activeElement;
    state.libraryRoot = libraryRoot || null;
    state.assets = assets.filter(item => item?.id && !item.trashedAt && (item.mediaType === 'image' || String(item.ext || '').toLowerCase() === 'pdf'));
    state.selectedLibrary = new Set(selectedIds.filter(id => state.assets.some(item => item.id === id)));
    state.open = true; root.hidden = false; document.body.classList.add('is-invoice-center-open');
    renderLibrary(); renderItems(); renderJob(); await refresh();
    if (state.selectedLibrary.size && !busy()) await addFiles([...state.selectedLibrary]);
    $('iv-close').focus();
  }
  function close() {
    if (!root) return;
    state.open = false; root.hidden = true; state.previewId = null; state.previewUrl = null; state.previewGeneration++; document.body.classList.remove('is-invoice-center-open'); state.previousFocus?.focus?.();
  }
  function renderLibrary() {
    const list = $('iv-library-items'); list.replaceChildren();
    if (!state.assets.length) list.append(node('p', 'iv-note', '素材库中暂无图片或 PDF，可直接添加本地文件。'));
    for (const asset of state.assets) {
      const label = node('label', 'iv-library-item');
      const input = node('input'); input.type = 'checkbox'; input.checked = state.selectedLibrary.has(asset.id); input.dataset.libraryId = asset.id;
      input.addEventListener('change', () => { if (input.checked) state.selectedLibrary.add(asset.id); else state.selectedLibrary.delete(asset.id); updateControls(); });
      label.append(input, node('span', '', asset.name), node('small', '', String(asset.ext || '').toUpperCase())); list.append(label);
    }
    updateControls();
  }
  function summary() {
    const totals = window.MosaicInvoiceAmounts?.totalAmounts(state.items.map(item => state.amounts.get(item.id)?.amount || ''));
    const invalid = totals?.invalidIndices.length ?? state.items.length;
    return { invalid, valid: state.items.length > 0 && invalid === 0 && totals?.cents != null, amount: totals?.amount || '0.00' };
  }
  function reasonFor(result, valid) {
    const reasons = { 'no-text': '未识别到文字，请手动填写', 'text-too-large': '识别文字过多，请手动填写', 'no-total-label': '未找到合计金额，请手动填写', 'ambiguous-totals': '发现多个不同合计，请手动填写', 'unreadable-total': '合计金额无法读清，请手动填写', 'too-many-totals': '发现过多合计字段，请手动填写', 'labelled-total': '已识别合计金额，请核对', 'repeated-total': '重复合计金额一致，请核对' };
    const reason = reasons[result.reason] || result.reason || (valid ? '识别结果，请核对' : '未找到明确金额，请手动填写');
    return result.confidence === 'low' && valid ? `${reason}（可信度较低）` : reason;
  }
  function renderItems() {
    const list = $('iv-items'); list.replaceChildren();
    if (!state.items.length) list.append(node('p', 'iv-empty', '添加发票图片或 PDF，开始整理。'));
    state.items.forEach((item, index) => {
      const value = state.amounts.get(item.id), row = node('section', 'iv-item'); row.dataset.invoiceId = item.id;
      const line = node('div', 'iv-line');
      const thumbnail = button('', 'iv-thumbnail', () => togglePreview(item.id)); thumbnail.setAttribute('aria-label', `查看 ${item.name}`);
      const image = node('img'); image.src = item.previewUrl; image.alt = ''; thumbnail.append(image);
      const info = node('div', 'iv-information'); info.append(node('h4', '', `${index + 1}. ${item.name}`));
      if (item.sourceType === 'pdf') info.append(node('small', '', `PDF · 第 ${item.pageNumber || 1} 页`));
      const reason = node('p', 'iv-reason', value.reason || '请核对金额'); reason.classList.toggle('iv-error', Boolean(value.error)); info.append(reason);
      const input = node('input', 'iv-input'); input.type = 'text'; input.inputMode = 'decimal'; input.maxLength = 80; input.value = value.amount; input.placeholder = '待填写'; input.dataset.invoiceAmount = item.id; input.setAttribute('aria-label', `${item.name}金额（元）`);
      input.addEventListener('input', () => {
        value.amount = input.value; value.error = parse(input.value) === null; value.reason = value.error ? '请输入有效金额，最多两位小数' : '手动填写，请核对'; text(reason, value.reason); reason.classList.toggle('iv-error', value.error); state.confirmed = false; updateControls();
      });
      const amount = node('label', 'iv-field iv-amount'); amount.append(node('span', '', '金额（元）'), input);
      const moves = node('div', 'iv-moves');
      for (const [offset, label] of [[-1, '上移'], [1, '下移']]) {
        const move = button(label, 'iv-text-button', () => {
          const target = index + offset; if (busy() || target < 0 || target >= state.items.length) return;
          [state.items[index], state.items[target]] = [state.items[target], state.items[index]]; state.confirmed = false; renderItems();
        }); move.dataset.invoiceMove = offset; moves.append(move);
      }
      const remove = button('移除', 'iv-text-button', () => removeItems([item.id])); remove.dataset.invoiceRemove = item.id; moves.append(remove);
      line.append(thumbnail, info, amount, moves); row.append(line);
      if (state.previewId === item.id) {
        if (state.previewUrl) {
          const zoom = button(state.previewZoomed ? '缩小预览' : '放大查看', 'iv-text-button', () => { state.previewZoomed = !state.previewZoomed; renderItems(); }); row.append(zoom);
          const frame = node('div', 'iv-full-preview'), preview = node('img', `iv-full-image${state.previewZoomed ? ' is-zoomed' : ''}`); preview.src = state.previewUrl; preview.alt = item.name; frame.append(preview); row.append(frame);
        } else row.append(node('p', state.previewError ? 'iv-note iv-error' : 'iv-note', state.previewError || '正在读取清晰预览…'));
      }
      if (value.text) { const details = node('details', 'iv-text'); details.append(node('summary', '', '查看识别文字'), node('pre', '', value.text)); row.append(details); }
      list.append(row);
    });
    updateControls();
  }
  function updateControls() {
    if (!root) return;
    const blocked = busy(), totals = summary();
    text($('iv-count'), `${state.items.length} 张发票`);
    const sum = $('iv-summary'); sum.replaceChildren(node('strong', '', `${state.items.length} 张 · ${totals.valid ? '合计' : '已填金额'} ${totals.amount} 元`));
    sum.append(node('small', '', totals.valid ? `${state.items.length}张_合计${totals.amount}元.pdf` : totals.invalid ? `还有 ${totals.invalid} 张发票需要填写有效金额` : '添加发票并填写金额后生成文件名'));
    $('iv-confirm').checked = state.confirmed; $('iv-confirm').disabled = blocked || !totals.valid;
    $('iv-add').disabled = blocked; $('iv-add-library').disabled = blocked || !state.selectedLibrary.size; $('iv-clear').disabled = blocked || !state.items.length;
    $('iv-per-page').disabled = blocked; $('iv-orientation').disabled = blocked; $('iv-language').disabled = blocked;
    $('iv-recognize').disabled = blocked || !state.items.length;
    text($('iv-recognize'), blocked && state.job?.mode === 'recognize' ? '正在识别…' : '识别发票金额');
    text($('iv-runtime'), state.runtime?.ocrReady === true ? '可先识别金额，再逐张核对；也可直接手动填写。' : '系统 OCR 不可用，PDF 文字层仍可读取，也可手动填写金额。');
    $('iv-export').disabled = blocked || !totals.valid || !state.confirmed;
    text($('iv-export'), state.importing ? '正在读取文件…' : state.removing ? '正在移除…' : blocked ? '正在处理…' : `整合导出 PDF${state.items.length ? `（${state.items.length} 张）` : ''}`);
    $('iv-library-items').querySelectorAll('input').forEach(input => { input.disabled = blocked; });
    $('iv-items').querySelectorAll('input,button').forEach(control => {
      control.disabled = blocked;
      if (control.dataset.invoiceMove) { const index = state.items.findIndex(item => item.id === control.closest('[data-invoice-id]').dataset.invoiceId); const target = index + Number(control.dataset.invoiceMove); control.disabled ||= target < 0 || target >= state.items.length; }
      if (control.dataset.invoiceAmount) control.setAttribute('aria-invalid', String(parse(control.value) === null));
    });
  }
  async function togglePreview(id) {
    if (busy()) return;
    const generation = ++state.previewGeneration;
    state.previewId = state.previewId === id ? null : id; state.previewUrl = null; state.previewError = ''; state.previewZoomed = false; renderItems();
    if (!state.previewId) return;
    try {
      const result = await api.invoicePreview(id);
      if (!state.open || generation !== state.previewGeneration || state.previewId !== id || !state.items.some(item => item.id === id)) return;
      if (!/^data:image\/(?:png|jpeg);base64,/.test(result?.url || '')) throw new Error('无法读取发票预览');
      state.previewUrl = result.url;
    } catch (error) {
      if (generation !== state.previewGeneration || state.previewId !== id) return;
      state.previewError = error.message || String(error);
    }
    renderItems();
  }
  async function removeItems(ids) {
    if (busy() || !ids.length) return;
    state.removing = true; updateControls();
    try {
      const result = await api.invoiceRemoveItems(ids);
      if (result?.removed !== true) throw new Error('未能移除发票，请重试');
      const removed = new Set(ids); state.items = state.items.filter(item => !removed.has(item.id));
      for (const id of ids) state.amounts.delete(id);
      if (removed.has(state.previewId)) { state.previewGeneration++; state.previewId = null; state.previewUrl = null; }
      state.confirmed = false; report(`已移除 ${ids.length} 张发票。`);
    } catch (error) { report(error.message || String(error), true); }
    finally { state.removing = false; renderItems(); }
  }
  async function addFiles(assetIds) {
    if (busy()) return;
    state.importing = true; report('正在读取发票文件…'); updateControls();
    try {
      const result = assetIds ? await api.invoiceAddAssets({ assetIds, libraryRoot: state.libraryRoot }) : await api.invoiceChooseFiles();
      if (result?.cancelled) { report('已取消添加。'); return; }
      let added = 0;
      for (const item of result?.items || []) {
        if (!item?.id || state.items.some(existing => existing.id === item.id)) continue;
        state.items.push(item); state.amounts.set(item.id, { amount: '', text: '', reason: '待填写或识别金额' }); added++;
      }
      if (added) state.confirmed = false;
      if (assetIds) { state.selectedLibrary.clear(); renderLibrary(); }
      const errors = (result?.errors || []).map(error => typeof error === 'string' ? error : `${error.name || '文件'}：${error.error || error.message || '读取失败'}`);
      report([added ? `已添加 ${added} 张发票。` : '没有添加新的发票。', ...errors.slice(0, 5)].join('\n'), errors.length > 0);
    } catch (error) { report(error.message || String(error), true); }
    finally { state.importing = false; renderItems(); updateControls(); }
  }
  async function run(mode) {
    if (mode === 'recognize' ? $('iv-recognize').disabled : $('iv-export').disabled) return;
    report(''); if (mode === 'recognize') state.confirmed = false;
    const itemIds = state.items.map(item => item.id);
    const options = mode === 'export' ? { imagesPerPage: state.imagesPerPage, orientation: state.orientation, items: state.items.map(item => ({ id: item.id, amount: window.MosaicInvoiceAmounts.formatAmount(parse(state.amounts.get(item.id)?.amount)) })), confirmed: state.confirmed } : { language: state.language || 'auto' };
    state.job = { status: 'starting', mode, progress: 0, message: mode === 'recognize' ? '正在识别发票金额…' : '正在准备 PDF…' }; renderJob(); updateControls();
    try {
      const result = await api.invoiceRun({ mode, itemIds, options });
      if (result?.cancelled) { state.job = { status: 'cancelled', mode, message: '已取消保存，未生成 PDF 文件。' }; renderJob(); updateControls(); return; }
      if (state.job && !state.job.jobId) state.job.jobId = typeof result === 'string' ? result : result.jobId;
      if (state.job?.status === 'starting') state.job.status = 'running'; renderJob(); updateControls();
    } catch (error) { state.job = { ...state.job, status: 'error', message: error.message || String(error) }; renderJob(); updateControls(); }
  }
  async function cancel() {
    if (!state.job?.jobId || !busy()) return;
    try { await api.invoiceCancel(state.job.jobId); if (busy()) { state.job.message = '正在取消…'; renderJob(); } }
    catch (error) { report(error.message || String(error), true); }
  }
  function handleEvent(event) {
    if (!event || !state.job || !['progress', 'complete', 'error', 'cancelled'].includes(event.type)) return;
    if (state.job.jobId && event.jobId && state.job.jobId !== event.jobId) return;
    const mode = event.mode || state.job.mode;
    if (event.type !== 'progress' && mode === 'recognize') {
      for (const result of event.results || []) {
        if (!state.amounts.has(result.sourceId)) continue;
        const cents = parse(result.amount); state.amounts.set(result.sourceId, { amount: cents === null ? '' : window.MosaicInvoiceAmounts.formatAmount(cents), text: result.text || '', reason: reasonFor(result, cents !== null), error: cents === null });
      }
      for (const error of event.errors || []) if (state.amounts.has(error.sourceId)) state.amounts.set(error.sourceId, { amount: '', text: '', reason: error.error || error.message || '识别失败，请手动填写', error: true });
      state.confirmed = false;
    }
    const result = event.results?.[0];
    const completed = mode === 'recognize' ? `已识别 ${event.results?.length || 0} 张发票，请核对每张金额。` : `已整合 ${result?.invoiceCount || 0} 张发票，合计 ${result?.totalAmount || '0.00'} 元。`;
    state.job = { ...state.job, ...event, mode, status: event.cancelled || event.type === 'cancelled' ? 'cancelled' : event.type === 'complete' ? 'complete' : event.type === 'error' ? 'error' : 'running', message: event.message || (event.cancelled || event.type === 'cancelled' ? '任务已取消，已完成的识别结果保留。' : event.type === 'complete' ? completed : event.error?.message || event.error || '正在处理…') };
    if (state.open) { renderJob(); if (!busy()) renderItems(); updateControls(); }
  }
  function renderJob() {
    if (!root) return;
    const job = state.job, result = $('iv-result'); result.replaceChildren(); result.hidden = true;
    text($('iv-job-title'), !job ? '核对金额后整合发票' : job.status === 'complete' ? '处理完成' : job.status === 'error' ? '处理失败' : job.status === 'cancelled' ? '已取消' : job.mode === 'recognize' ? '识别发票金额' : '生成 PDF');
    text($('iv-job-message'), job?.message || '文件名自动包含发票数量和金额合计。'); $('iv-job-message').classList.toggle('iv-error', job?.status === 'error');
    const working = Boolean(job && !['complete', 'error', 'cancelled'].includes(job.status));
    $('iv-progress').hidden = !working; const progress = Number(job?.progress || 0); $('iv-progress').value = progress <= 1 ? progress * 100 : progress;
    $('iv-cancel').hidden = !working; $('iv-cancel').disabled = !job?.jobId;
    if (job?.status === 'complete' && job.mode === 'export' && job.results?.[0]?.path) {
      result.append(node('span', '', job.results[0].path)); result.append(button('在文件夹中显示', 'iv-text-button', async () => { try { await api.invoiceRevealResult(job.jobId); } catch (error) { report(error.message || String(error), true); } })); result.hidden = false;
    }
  }
  window.shituInvoices = Object.freeze({ open, close, refresh, isOpen: () => state.open, isBusy: busy });
})();
