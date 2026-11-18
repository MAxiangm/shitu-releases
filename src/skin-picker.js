(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituSkinPicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function create({ skins, onClose = () => {} } = {}) {
    if (!skins?.catalog || typeof skins.apply !== 'function') throw new Error('皮肤设置不可用');
    const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    let opened = false, previousFocus = null;
    const overlay = make('div', 'skin-picker-overlay'); overlay.id = 'skinPickerOverlay'; overlay.hidden = true;
    const dialog = make('section', 'skin-picker-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'skinPickerTitle');
    const heading = make('div', 'skin-picker-heading'), titleBox = make('div');
    const eyebrow = make('span', 'skin-picker-eyebrow', 'PERSONALIZE'), title = make('h2', '', '选择你的皮肤'); title.id = 'skinPickerTitle';
    titleBox.append(eyebrow, title, make('p', '', '从掌机、游戏机和经典桌面中，找到喜欢的界面风格。'));
    const closeButton = make('button', 'skin-picker-close', '×'); closeButton.id = 'skinPickerClose'; closeButton.type = 'button'; closeButton.setAttribute('aria-label', '关闭皮肤选择'); closeButton.addEventListener('click', close);
    heading.append(titleBox, closeButton);
    const grid = make('div', 'skin-picker-grid'); grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-label', '界面皮肤');
    const buttons = skins.catalog.map(skin => {
      const button = make('button', `skin-choice skin-choice-${skin.family}`); button.type = 'button'; button.dataset.skinId = skin.id;
      button.setAttribute('role', 'radio'); button.setAttribute('aria-label', `${skin.name}，${skin.description}`);
      const miniature = make('div', `skin-miniature skin-miniature-${skin.id}`); miniature.setAttribute('aria-hidden', 'true');
      miniature.style.setProperty('--mini-base', skin.base); miniature.style.setProperty('--mini-surface', skin.surface);
      miniature.style.setProperty('--mini-accent', skin.accent); miniature.style.setProperty('--mini-ink', skin.ink);
      const miniHead = make('div', 'skin-mini-head'); miniHead.append(make('i'), make('i'), make('i'));
      const miniBody = make('div', 'skin-mini-body'), miniSide = make('div', 'skin-mini-side'); miniSide.append(make('b'), make('b'), make('b'));
      const miniCards = make('div', 'skin-mini-cards'); for (let i = 0; i < 4; i++) miniCards.append(make('i'));
      miniBody.append(miniSide, miniCards); miniature.append(miniHead, miniBody);
      const label = make('span', 'skin-choice-name', skin.name), checked = make('span', 'skin-choice-check', '✓'); checked.setAttribute('aria-hidden', 'true');
      button.append(miniature, label, make('span', 'skin-choice-description', skin.description), checked);
      button.addEventListener('click', () => { skins.apply(skin.id); update(); }); grid.append(button); return button;
    });
    const foot = make('div', 'skin-picker-footer'), status = make('span', 'skin-picker-status'); status.id = 'skinPickerStatus'; status.setAttribute('role', 'status');
    foot.append(status, make('span', '', '自动保存，下次打开继续使用。')); dialog.append(heading, grid, foot); overlay.append(dialog); document.body.append(overlay);
    function update() {
      const id = skins.current().id;
      for (const button of buttons) {
        const selected = button.dataset.skinId === id; button.classList.toggle('is-selected', selected); button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1;
      }
      status.textContent = `当前皮肤：${skins.current().name}`;
    }
    function open() { previousFocus = document.activeElement; opened = true; overlay.hidden = false; update(); buttons.find(button => button.dataset.skinId === skins.current().id)?.focus(); }
    function close() { if (!opened) return; opened = false; overlay.hidden = true; if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); onClose(); }
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      const current = buttons.indexOf(document.activeElement);
      if (current >= 0 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + delta + buttons.length) % buttons.length;
        buttons[index].click(); buttons[index].focus(); return;
      }
      if (event.key === 'Tab') {
        const controls = [closeButton, ...buttons.filter(button => button.tabIndex === 0)], index = controls.indexOf(document.activeElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1).focus(); }
        else if (!event.shiftKey && (index === controls.length - 1 || index < 0)) { event.preventDefault(); controls[0].focus(); }
      }
    });
    window.addEventListener('shitu-skin-change', () => { if (opened) update(); });
    update();
    return Object.freeze({ open, close, isOpen: () => opened });
  }
  return Object.freeze({ create });
});
