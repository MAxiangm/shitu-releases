(function (root, factory) {
  const api = factory(root.ShituFolderIcons, root.ShituFolderIconView, root.ShituColorLabels);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituFolderIconsUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (FolderIcons, IconView, ColorLabels) {
  'use strict';
  function create({ setIcon, setColor, chooseImage, onApplied, getContext, onClose } = {}) {
    const doc = document;
    const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const button = (text, className, id) => { const node = el('button', className, text); node.type = 'button'; if (id) node.id = id; return node; };
    const overlay = el('div', 'modal-overlay hidden'); overlay.id = 'folderIconEditor';
    const form = el('form', 'folder-icon-dialog'); form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-labelledby', 'folderIconTitle'); form.setAttribute('aria-describedby', 'folderIconDescription');
    const heading = el('div', 'folder-icon-heading'), title = el('h2', '', '设置文件夹图标'); title.id = 'folderIconTitle';
    const closeButton = button('×', 'folder-icon-close', 'folderIconClose'); closeButton.setAttribute('aria-label', '关闭图标设置'); heading.append(title, closeButton);
    const description = el('p', 'folder-icon-description', '图标和预设色自动保存；自定义色号预览后点击应用。图片完整显示，GIF 保留动画。'); description.id = 'folderIconDescription';
    const previewRow = el('div', 'folder-icon-preview-row'), preview = el('div', 'folder-icon-preview'); preview.id = 'folderIconPreview';
    const identity = el('div', 'folder-icon-identity'), folderName = el('strong'), status = el('span', '', ''); status.setAttribute('aria-live', 'polite'); identity.append(folderName, status); previewRow.append(preview, identity);
    const sectionTitle = text => el('h3', 'folder-icon-section-title', text);
    const choices = el('div', 'folder-icon-choices'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', '内置图标');
    const iconButtons = new Map();
    for (const definition of IconView.definitions) {
      const choice = button('', 'folder-icon-choice'); choice.dataset.folderIcon = definition.id;
      choice.setAttribute('aria-label', definition.name); choice.title = definition.name;
      choice.append(IconView.builtin(definition.id), el('span', '', definition.name));
      choice.addEventListener('click', () => { void execute(current => setIcon(current.id, definition.id === 'folder' ? null : definition.id, current.root)); });
      choices.append(choice); iconButtons.set(definition.id, choice);
    }
    const customRow = el('div', 'folder-icon-custom-row'), choose = button('选择图片或 GIF…', 'secondary-button', 'folderIconChoose');
    const reset = button('恢复默认图标', 'folder-icon-reset', 'folderIconReset'); customRow.append(choose, reset);
    const colorsSection = el('div', 'folder-icon-colors-section'), colors = el('div', 'folder-icon-colors'); colors.setAttribute('role', 'group'); colors.setAttribute('aria-label', '内置图标颜色');
    const colorButtons = new Map();
    for (const color of [{ color: null, name: '跟随颜色标记' }, ...ColorLabels.palette]) {
      const choice = button('', 'folder-icon-color'); choice.title = color.name; choice.setAttribute('aria-label', color.name);
      if (color.color) choice.style.setProperty('--folder-icon-color', color.color); else choice.classList.add('folder-icon-color-default');
      choice.addEventListener('click', () => { draftColor = color.color; renderPreview(); void execute(current => setColor(current.id, color.color, current.root)); });
      colors.append(choice); colorButtons.set(color.color, choice);
    }
    const customColor = el('div', 'folder-icon-custom-color');
    const picker = el('input'); picker.type = 'color'; picker.id = 'folderIconColorPicker'; picker.setAttribute('aria-label', '自定义图标颜色');
    const hex = el('input'); hex.type = 'text'; hex.id = 'folderIconColorHex'; hex.maxLength = 7; hex.autocomplete = 'off'; hex.spellcheck = false; hex.placeholder = '#789FE8'; hex.setAttribute('aria-label', '图标颜色 HEX 色号');
    const applyColor = button('应用色号', 'secondary-button', 'folderIconApplyColor'); customColor.append(picker, hex, applyColor);
    colorsSection.append(sectionTitle('图标颜色'), colors, customColor);
    const error = el('p', 'folder-icon-error hidden'); error.id = 'folderIconError'; error.setAttribute('role', 'alert');
    const footer = el('div', 'folder-icon-actions'), done = button('完成', 'primary-button', 'folderIconDone'); footer.append(done);
    form.append(heading, description, previewRow, sectionTitle('内置图标'), choices, customRow, colorsSection, error, footer); overlay.append(form); doc.body.append(overlay);
    let active = null, previousFocus = null, pending = false, serial = 0, draftColor = null;
    function displayError(value) { error.textContent = value; error.classList.toggle('hidden', !value); }
    function currentContext(current) { const context = getContext?.(); return !context || context.root === current.root && (!context.folders || context.folders.some(folder => folder.id === current.id)); }
    function renderPreview() {
      if (!active) return;
      const folder = { ...active.folder, iconColor: draftColor };
      preview.replaceChildren(IconView.create(folder, { imageUrl: FolderIcons.iconUrl, fallbackColor: ColorLabels.get(folder.colorLabel)?.color }));
      for (const [color, node] of colorButtons) node.setAttribute('aria-pressed', String(color === draftColor));
      const color = draftColor || ColorLabels.get(folder.colorLabel)?.color || '#a6a6a6';
      for (const node of iconButtons.values()) node.querySelector('.folder-icon').style.color = color;
    }
    function render() {
      if (!active) return;
      const image = active.folder.icon?.type === 'image';
      folderName.textContent = active.folder.name;
      status.textContent = pending ? '正在保存…' : image ? active.folder.icon.animated ? '自定义图片 · 动画' : '自定义图片' : '内置图标';
      for (const [id, node] of iconButtons) node.setAttribute('aria-pressed', String(!image && (active.folder.icon?.name || 'folder') === id));
      colorsSection.classList.toggle('hidden', image);
      for (const node of form.querySelectorAll('button,input')) node.disabled = pending;
      renderPreview();
    }
    function syncColorInputs() { const color = draftColor || ColorLabels.get(active?.folder.colorLabel)?.color || '#a6a6a6'; picker.value = color; hex.value = color.toUpperCase(); hex.removeAttribute('aria-invalid'); }
    function close(force = false) {
      if (!active || pending && !force) return;
      const id = active.id; active = null; serial++; pending = false; overlay.classList.add('hidden'); displayError('');
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); else onClose?.(id);
      previousFocus = null;
    }
    async function execute(operation) {
      if (!active || pending) return;
      const current = active, token = serial;
      if (!currentContext(current)) { close(true); return; }
      pending = true; displayError(''); render();
      try {
        const snapshot = await operation(current);
        if (active !== current || serial !== token) return;
        if (!currentContext(current)) { close(true); return; }
        if (snapshot) {
          const folder = snapshot.folders?.find(item => item.id === current.id);
          if (!folder || snapshot.root !== current.root) { close(true); return; }
          current.folder = folder; draftColor = folder.iconColor || null; syncColorInputs(); onApplied?.(snapshot);
        }
      } catch (problem) { if (active === current && serial === token) displayError(problem?.message || String(problem)); }
      finally { if (active === current && serial === token) { pending = false; render(); } }
    }
    function commitColor() {
      let color;
      try { color = FolderIcons.normalizeColor(hex.value.trim()); if (!color) throw new Error('请输入 #RGB 或 #RRGGBB 色号'); }
      catch (problem) { hex.setAttribute('aria-invalid', 'true'); displayError(problem.message); return; }
      draftColor = color; syncColorInputs(); renderPreview(); void execute(current => setColor(current.id, color, current.root));
    }
    picker.addEventListener('input', () => { draftColor = picker.value; hex.value = picker.value.toUpperCase(); displayError(''); renderPreview(); });
    picker.addEventListener('change', commitColor);
    hex.addEventListener('input', () => { try { const color = FolderIcons.normalizeColor(hex.value.trim()); if (color) { draftColor = color; picker.value = color; hex.removeAttribute('aria-invalid'); renderPreview(); } } catch {} });
    hex.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); commitColor(); } });
    form.addEventListener('submit', event => { event.preventDefault(); commitColor(); });
    applyColor.addEventListener('click', commitColor);
    choose.addEventListener('click', () => { void execute(current => chooseImage(current.id, current.root)); });
    reset.addEventListener('click', () => { void execute(current => setIcon(current.id, null, current.root)); });
    for (const node of [done, closeButton]) node.addEventListener('click', () => close());
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...form.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(node => !node.closest('.hidden'));
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    choices.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const buttons = [...iconButtons.values()], index = buttons.indexOf(doc.activeElement);
      const columns = getComputedStyle(choices).gridTemplateColumns.split(/\s+/).length;
      const delta = event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : event.key === 'ArrowRight' ? 1 : -1;
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + delta + buttons.length) % buttons.length]?.focus();
    });
    function open(folder, root) {
      close(true); previousFocus = doc.activeElement; active = { id: folder.id, root, folder }; serial++;
      draftColor = folder.iconColor || null; syncColorInputs(); render(); overlay.classList.remove('hidden');
      (folder.icon?.type === 'image' ? choose : iconButtons.get(folder.icon?.name || 'folder')).focus();
    }
    return Object.freeze({ open, close, isOpen: () => Boolean(active) });
  }
  return Object.freeze({ create });
});
