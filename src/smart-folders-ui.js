(function (root, factory) {
  const api = factory(root.ShituSmartFolders, root.ShituColorLabels);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituSmartFoldersUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SmartFolders, ColorLabels) {
  'use strict';
  function create({ save, remove, onApplied, onError, onClose, getContext } = {}) {
    if (typeof save !== 'function') throw new Error('智能文件夹保存接口不可用');
    const doc = document;
    const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const button = (text, className, id) => { const node = el('button', className, text); node.type = 'button'; if (id) node.id = id; return node; };
    const input = (id, type = 'text') => { const node = el('input', 'sf-input'); node.id = id; node.type = type; return node; };
    const select = (id, options) => { const node = el('select', 'sf-input'); node.id = id; options.forEach(([value, label]) => { const option = el('option', '', label); option.value = value; node.append(option); }); return node; };
    const field = (label, node, className = '') => { const box = el('label', `sf-field ${className}`.trim()); box.htmlFor = node.id; box.append(el('span', 'sf-label', label), node); return box; };
    const overlay = el('div', 'sf-overlay modal-overlay hidden'); overlay.id = 'smartFolderEditor';
    const form = el('form', 'sf-dialog'); form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-labelledby', 'smartFolderEditorTitle'); form.setAttribute('aria-describedby', 'smartFolderEditorDescription');
    const heading = el('div', 'sf-heading'), headingText = el('div');
    const title = el('h2', '', '新建智能文件夹'); title.id = 'smartFolderEditorTitle';
    headingText.append(el('span', 'sf-eyebrow', '智能文件夹'), title);
    const closeButton = button('×', 'sf-close', 'smartFolderClose'); closeButton.setAttribute('aria-label', '关闭智能文件夹设置');
    heading.append(headingText, closeButton);
    const description = el('p', 'sf-description', '自动汇总符合全部条件的素材。新导入或修改素材后，列表会随规则更新；原文件不会移动。'); description.id = 'smartFolderEditorDescription';
    const name = input('smartFolderName'); name.maxLength = SmartFolders.NAME_LIMIT; name.autocomplete = 'off'; name.required = true; name.placeholder = '例如：红色标记的视频';
    const type = select('smartFolderType', [['all', '所有素材'], ['image', '图片'], ['video', '视频'], ['audio', '音乐'], ['font', '字体'], ['model', '3D 模型'], ['project', 'AE 工程'], ['document', '文档']]);
    const color = select('smartFolderColor', [['all', '不限颜色'], ...ColorLabels.palette.map(item => [item.id, item.name]), ['custom', '自定义颜色…']]);
    const colorFields = el('div', 'sf-custom-color hidden'); colorFields.id = 'smartFolderCustomColor';
    const colorPicker = input('smartFolderColorPicker', 'color'); colorPicker.value = '#789fe8'; colorPicker.setAttribute('aria-label', '选择筛选颜色');
    const colorHex = input('smartFolderColorHex'); colorHex.value = '#789FE8'; colorHex.maxLength = 7; colorHex.spellcheck = false; colorHex.autocomplete = 'off'; colorHex.setAttribute('aria-label', '筛选颜色十六进制值'); colorFields.append(colorPicker, colorHex);
    const colorBox = field('颜色标记', color); colorBox.append(colorFields);
    const recent = select('smartFolderRecent', [['0', '不限导入时间'], ['1', '最近 1 天'], ['7', '最近 7 天'], ['30', '最近 30 天'], ['90', '最近 90 天'], ['custom', '自定义天数…']]);
    const days = input('smartFolderDays', 'number'); days.value = '7'; days.min = '1'; days.max = '3650'; days.step = '1'; days.setAttribute('aria-label', '最近导入天数');
    const daysBox = el('div', 'sf-custom-days hidden'); daysBox.append(days, el('span', '', '天内导入'));
    const recentBox = field('导入时间', recent); recentBox.append(daysBox);
    const favorite = input('smartFolderFavorite', 'checkbox'); const favoriteBox = el('label', 'sf-check'); favoriteBox.append(favorite, el('span', '', '仅显示已收藏的素材'));
    const search = input('smartFolderSearch'); search.maxLength = 500; search.autocomplete = 'off'; search.placeholder = '名称、字体名、标签、备注或来源关键词';
    const grid = el('div', 'sf-grid'); grid.append(field('素材类型', type), colorBox, recentBox, favoriteBox);
    const summary = el('p', 'sf-summary'); summary.id = 'smartFolderRuleSummary'; summary.setAttribute('aria-live', 'polite');
    const error = el('p', 'sf-error hidden'); error.id = 'smartFolderError'; error.setAttribute('role', 'alert');
    const footer = el('div', 'sf-actions'), deleteButton = button('删除规则', 'sf-delete', 'smartFolderDelete'), cancel = button('取消', 'secondary-button', 'smartFolderCancel'), submit = button('保存智能文件夹', 'primary-button', 'smartFolderSave'); submit.type = 'submit';
    footer.append(deleteButton, el('span', 'sf-spacer'), cancel, submit);
    form.append(heading, description, field('名称', name), grid, field('包含关键词', search), summary, error, footer); overlay.append(form); doc.body.append(overlay);
    let active = null, serial = 0, previousFocus = null, pending = false, confirmingDelete = false;
    function setPending(value) { pending = value; for (const node of form.querySelectorAll('input,select,button')) node.disabled = value; submit.textContent = value ? '正在保存…' : '保存智能文件夹'; }
    function displayError(value) { error.textContent = value; error.classList.toggle('hidden', !value); }
    function ruleFromForm() {
      return SmartFolders.validateRule({ mediaType: type.value, colorLabel: color.value === 'all' ? null : color.value === 'custom' ? colorHex.value.trim() : color.value,
        recentDays: recent.value === 'custom' ? Number(days.value) : Number(recent.value), search: search.value, favorite: favorite.checked });
    }
    function refresh() {
      colorFields.classList.toggle('hidden', color.value !== 'custom'); daysBox.classList.toggle('hidden', recent.value !== 'custom');
      confirmingDelete = false; deleteButton.textContent = '删除规则';
      try { summary.textContent = `当前条件：${SmartFolders.describe(ruleFromForm())}`; } catch { summary.textContent = '请完善筛选条件后保存。'; }
    }
    function close() {
      if (!active) return;
      active = null; serial++; overlay.classList.add('hidden'); setPending(false); displayError('');
      if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
      previousFocus = null; onClose?.();
    }
    function contextCurrent(expectedRoot) {
      if (typeof getContext !== 'function') return true;
      const context = getContext(), currentRoot = typeof context === 'string' ? context : context?.root ?? context?.library?.root;
      return currentRoot === undefined || currentRoot === expectedRoot;
    }
    async function execute(operation) {
      if (!active || pending) return;
      const current = active, token = serial;
      if (!contextCurrent(current.root)) { close(); onError?.(new Error('素材库已切换，请重新打开智能文件夹设置')); return; }
      setPending(true); displayError('');
      try {
        const snapshot = await operation(current);
        if (active !== current || token !== serial) return;
        if (!contextCurrent(current.root)) { close(); return; }
        close(); onApplied?.(snapshot);
      } catch (problem) {
        if (active !== current || token !== serial) return;
        displayError(problem?.message || String(problem)); onError?.(problem);
      } finally { if (active === current && serial === token) setPending(false); }
    }
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!active || pending) return;
      let rule, cleanName;
      try { rule = ruleFromForm(); cleanName = SmartFolders.validateName(name.value); } catch (problem) { displayError(problem.message); return; }
      void execute(current => save({ ...(current.id ? { id: current.id } : {}), name: cleanName, rule }, current.root));
    });
    deleteButton.addEventListener('click', () => {
      if (!active?.id || pending || typeof remove !== 'function') return;
      if (!confirmingDelete) { confirmingDelete = true; deleteButton.textContent = '确认删除规则'; displayError('只删除这条筛选规则，素材和原文件会完整保留。'); return; }
      void execute(current => remove(current.id, current.root));
    });
    closeButton.addEventListener('click', () => { if (!pending) close(); }); cancel.addEventListener('click', () => { if (!pending) close(); });
    overlay.addEventListener('click', event => { if (event.target === overlay && !pending) close(); });
    overlay.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); if (!pending) close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...form.querySelectorAll('input:not(:disabled),select:not(:disabled),button:not(:disabled)')].filter(node => !node.closest('.hidden'));
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    for (const control of [name, type, color, recent, days, favorite, search]) {
      control.addEventListener('input', refresh); control.addEventListener('change', refresh);
    }
    colorPicker.addEventListener('input', () => { colorHex.value = colorPicker.value.toUpperCase(); refresh(); });
    colorHex.addEventListener('input', () => { try { const normalized = ColorLabels.normalize(colorHex.value.trim()); if (normalized?.startsWith('#')) colorPicker.value = normalized; } catch {} refresh(); });
    function open(item, expectedRoot, prefillRule) {
      if (typeof expectedRoot !== 'string' || !expectedRoot) throw new Error('请先打开素材库');
      const rule = SmartFolders.validateRule(item?.rule || prefillRule || SmartFolders.DEFAULT_RULE);
      if (active) close();
      previousFocus = doc.activeElement; active = { id: item?.id || null, root: expectedRoot }; serial++; setPending(false); displayError('');
      title.textContent = item?.id ? '编辑智能文件夹' : '新建智能文件夹';
      name.value = item?.name || ''; type.value = rule.mediaType; search.value = rule.search; favorite.checked = rule.favorite;
      color.value = rule.colorLabel === null ? 'all' : rule.colorLabel.startsWith('#') ? 'custom' : rule.colorLabel;
      const custom = rule.colorLabel?.startsWith('#') ? rule.colorLabel : '#789fe8'; colorPicker.value = custom; colorHex.value = custom.toUpperCase();
      recent.value = ['0', '1', '7', '30', '90'].includes(String(rule.recentDays)) ? String(rule.recentDays) : 'custom'; days.value = String(rule.recentDays || 7);
      deleteButton.classList.toggle('hidden', !item?.id || typeof remove !== 'function');
      refresh(); overlay.classList.remove('hidden'); name.focus(); name.select();
    }
    return Object.freeze({ open, close, isOpen: () => Boolean(active) });
  }
  return Object.freeze({ create });
});
