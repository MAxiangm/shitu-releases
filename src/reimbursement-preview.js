/* Read-only source preview for reimbursement files. */
(() => {
  'use strict';
  const api = window.shitu;
  const state = { open: false, request: null, name: '', response: null, loading: false, loaded: false, zoomed: false, error: '', session: 0, generation: 0, openingSource: false, returnFocus: null, returnKey: '', onClose: null, background: null, previousInert: false };
  let root, title, meta, image, stage, status, retry, previous, next, pageLabel, zoom, openSource;
  let cancellation = Promise.resolve();
  const node = (tag, className, value) => { const element = document.createElement(tag); if (className) element.className = className; if (value !== undefined) element.textContent = String(value ?? ''); return element; };
  const button = (label, action, className = 'rb-preview-button') => { const element = node('button', className, label); element.type = 'button'; element.addEventListener('click', action); return element; };
  const cancelPending = () => {
    cancellation = cancellation.catch(() => {}).then(() => api.reimbursementPreviewCancel?.()).catch(() => {});
    return cancellation;
  };
  function build() {
    if (root) return;
    root = node('section', 'rb-preview-overlay'); root.id = 'reimbursementPreview'; root.hidden = true; root.tabIndex = -1;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'rb-preview-title');
    const panel = node('section', 'rb-preview-window'), header = node('header', 'rb-preview-header'), heading = node('div', 'rb-preview-heading');
    title = node('h2'); title.id = 'rb-preview-title'; meta = node('p', 'rb-preview-meta'); heading.append(title, meta);
    const closeButton = button('×', close, 'rb-preview-close'); closeButton.id = 'rb-preview-close'; closeButton.setAttribute('aria-label', '关闭文件预览'); closeButton.title = '关闭文件预览（Esc）';
    header.append(heading, closeButton);
    stage = node('div', 'rb-preview-stage'); stage.setAttribute('aria-label', '原文件预览');
    image = node('img', 'rb-preview-image'); image.id = 'rb-preview-image'; image.draggable = false; image.hidden = true;
    const message = node('div', 'rb-preview-message'); status = node('p'); status.id = 'rb-preview-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    retry = button('重新加载', () => { void loadPage(state.request?.pageNumber || 1); }); retry.id = 'rb-preview-retry'; retry.hidden = true; message.append(status, retry); stage.append(image, message);
    const toolbar = node('footer', 'rb-preview-toolbar'), pages = node('div', 'rb-preview-pages');
    previous = button('上一页', () => navigate(-1)); previous.id = 'rb-preview-previous'; previous.dataset.previewPage = 'previous';
    next = button('下一页', () => navigate(1)); next.id = 'rb-preview-next'; next.dataset.previewPage = 'next'; pageLabel = node('span', 'rb-preview-page-label'); pageLabel.id = 'rb-preview-page'; pageLabel.setAttribute('aria-live', 'polite'); pages.append(previous, pageLabel, next);
    const actions = node('div', 'rb-preview-actions'); zoom = button('查看原始尺寸', () => { if (!state.loaded) return; state.zoomed = !state.zoomed; render(); }); zoom.id = 'rb-preview-zoom'; zoom.dataset.previewZoom = '';
    openSource = button('用默认软件打开', () => { void openOriginal(); }); openSource.id = 'rb-preview-open-source'; openSource.dataset.previewOpenSource = ''; actions.append(zoom, openSource); toolbar.append(pages, actions);
    panel.append(header, stage, toolbar); root.append(panel); document.body.append(root);
    root.addEventListener('pointerdown', event => { if (event.target === root) { event.preventDefault(); event.stopImmediatePropagation(); close(); } });
    for (const name of ['dragenter', 'dragover', 'dragleave', 'drop']) root.addEventListener(name, event => { event.preventDefault(); event.stopImmediatePropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; }, true);
    document.addEventListener('keydown', event => {
      if (!state.open) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'Tab') {
        const controls = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(item => item.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); root.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && !event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) {
        event.preventDefault(); navigate(event.key === 'ArrowLeft' ? -1 : 1);
      }
      event.stopImmediatePropagation();
    }, true);
  }
  function render() {
    if (!root || !state.open) return;
    title.textContent = state.response?.name || state.name || '文件预览';
    const result = state.response, page = state.request?.pageNumber || 1, count = result?.pageCount || 1;
    meta.textContent = result ? [String(result.ext || '').toUpperCase(), result.type === 'image' ? `第 ${page} / ${count} 页` : '原文件', result.width && result.height ? `${result.width} × ${result.height}` : ''].filter(Boolean).join(' · ') : '';
    const external = result?.type === 'external';
    status.textContent = state.error || (state.loading ? '正在读取原文件…' : external ? '此文件格式请使用默认软件打开。' : '');
    status.classList.toggle('is-error', Boolean(state.error)); status.parentElement.hidden = state.loaded && !state.error;
    retry.hidden = !state.error || !state.request; retry.disabled = state.loading;
    image.hidden = !state.loaded || Boolean(state.error); image.alt = title.textContent;
    stage.classList.toggle('is-actual-size', state.zoomed); stage.setAttribute('aria-busy', String(state.loading));
    previous.disabled = state.loading || external || !result || page <= 1;
    next.disabled = state.loading || external || !result || page >= count;
    pageLabel.textContent = result?.type === 'image' ? `${page} / ${count}` : state.loading ? '读取中' : '—';
    zoom.textContent = state.zoomed ? '适应窗口' : '查看原始尺寸'; zoom.setAttribute('aria-pressed', String(state.zoomed)); zoom.disabled = !state.loaded || state.loading;
    openSource.disabled = !state.request || state.openingSource; openSource.textContent = state.openingSource ? '正在打开…' : '用默认软件打开';
  }
  async function loadPage(pageNumber) {
    if (!state.open || !state.request || !Number.isSafeInteger(pageNumber) || pageNumber < 1) return;
    const wasLoading = state.loading, generation = ++state.generation;
    state.request = { ...state.request, pageNumber }; state.response = null; state.loading = true; state.loaded = false; state.zoomed = false; state.error = '';
    image.onload = null; image.onerror = null; image.removeAttribute('src'); stage.scrollTop = 0; stage.scrollLeft = 0; render();
    if (wasLoading) cancelPending();
    await cancellation;
    const current = () => state.open && state.generation === generation;
    if (!current()) return;
    try {
      const response = await api.reimbursementPreview({ ...state.request });
      if (!current()) return;
      if (response?.type === 'external') { state.response = response; state.loading = false; render(); return; }
      if (response?.type !== 'image' || typeof response.url !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(response.url) ||
          !Number.isSafeInteger(response.pageCount) || response.pageCount < 1 || response.pageNumber !== pageNumber || response.pageNumber > response.pageCount) throw new Error('文件预览数据无效，请重试。');
      state.response = response;
      image.onload = () => { if (!current() || image.getAttribute('src') !== response.url) return; state.loading = false; state.loaded = true; render(); };
      image.onerror = () => { if (!current() || image.getAttribute('src') !== response.url) return; state.loading = false; state.loaded = false; state.error = '预览图片无法显示，请重试或用默认软件打开。'; render(); };
      image.src = response.url; render();
    } catch (error) {
      if (!current()) return;
      state.loading = false; state.loaded = false; state.error = error?.message || '无法读取原文件，请重试。'; render();
    }
  }
  function navigate(offset) {
    if (!state.open || state.loading || state.response?.type !== 'image') return;
    const target = state.request.pageNumber + offset;
    if (target < 1 || target > state.response.pageCount) return;
    void loadPage(target);
  }
  async function openOriginal() {
    if (!state.open || !state.request || state.openingSource) return;
    const session = state.session, request = { ...state.request }; state.openingSource = true; render();
    try { await api.reimbursementOpenSource(request); }
    catch (error) { if (state.open && state.session === session) { state.error = error?.message || '无法用默认软件打开此文件。'; render(); } }
    finally { if (state.session === session) { state.openingSource = false; render(); } }
  }
  async function open({ request, name, returnFocus, onClose } = {}) {
    build();
    if (state.open) cancelPending();
    state.session++; state.generation++; state.open = true; state.request = null; state.response = null; state.loading = false; state.loaded = false; state.zoomed = false; state.error = ''; state.openingSource = false;
    state.name = String(name || '文件预览'); state.returnFocus = typeof returnFocus === 'string' ? null : returnFocus || document.activeElement;
    state.returnKey = typeof returnFocus === 'string' ? returnFocus : returnFocus?.dataset?.previewKey || ''; state.onClose = typeof onClose === 'function' ? onClose : null;
    if (!state.background) { state.background = document.getElementById('reimbursementCenter'); state.previousInert = Boolean(state.background?.inert); }
    if (state.background) state.background.inert = true;
    root.hidden = false; render(); root.querySelector('.rb-preview-close').focus();
    if (!request || !['libraryRoot', 'folderId', 'assetId'].every(key => typeof request[key] === 'string' && request[key])) { state.error = '文件信息已失效，请关闭后重新选择。'; render(); return; }
    state.request = { libraryRoot: request.libraryRoot, folderId: request.folderId, assetId: request.assetId, pageNumber: request.pageNumber ?? 1 };
    if (!Number.isSafeInteger(state.request.pageNumber) || state.request.pageNumber < 1) { state.error = '文件页码无效，请关闭后重新选择。'; state.request = null; render(); return; }
    await loadPage(state.request.pageNumber);
  }
  function close() {
    if (!state.open) return;
    const callback = state.onClose, returnFocus = state.returnFocus, returnKey = state.returnKey;
    state.open = false; state.session++; state.generation++; state.request = null; state.response = null; state.loading = false; state.loaded = false; state.onClose = null; root.hidden = true;
    image.onload = null; image.onerror = null; image.removeAttribute('src'); cancelPending();
    if (state.background?.isConnected) state.background.inert = state.previousInert; state.background = null;
    try { callback?.(); } catch { /* Closing the preview must always restore keyboard access. */ }
    if (state.open) return;
    const keyed = returnKey ? [...document.querySelectorAll('[data-preview-key]')].find(element => element.dataset.previewKey === returnKey) : null;
    const focusable = element => element?.isConnected && !element.disabled && !element.closest('[inert],[hidden],.hidden') && element.getClientRects().length;
    const target = focusable(returnFocus) ? returnFocus : focusable(keyed) ? keyed : document.getElementById('rb-close');
    if (focusable(target)) target.focus({ preventScroll: true });
  }
  window.MosaicReimbursementPreview = Object.freeze({ open, close, isOpen: () => state.open, currentRequest: () => state.open && state.request ? { ...state.request } : null });
})();
