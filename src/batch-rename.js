(function (scope, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.ShituBatchRename = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MAX_ASSETS = 10000, MAX_NAME = 240, MAX_NUMBER = 999999999;
  const defaults = Object.freeze({ prefix: '', suffix: '', find: '', replace: '', numbering: false, start: 1, digits: 3, separator: '_', numberMode: 'append' });
  function plan(assets, values = {}) {
    const rows = [], errors = [], changes = [], warnings = [];
    const result = () => ({ rows, changes, errors, warnings, changedCount: changes.length, valid: !errors.length });
    if (!Array.isArray(assets) || !assets.length || assets.length > MAX_ASSETS) { errors.push({ message: `请选择 1 至 ${MAX_ASSETS} 个素材` }); return result(); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) { errors.push({ message: '重命名规则无效' }); return result(); }
    const options = { ...defaults, ...values };
    for (const key of ['prefix', 'suffix', 'find', 'replace', 'separator']) {
      if (typeof options[key] !== 'string' || options[key].length > MAX_NAME || /[\x00-\x1f\x7f]/.test(options[key])) errors.push({ message: `${({ prefix: '前缀', suffix: '后缀', find: '查找内容', replace: '替换内容', separator: '分隔符' })[key]}无效或过长` });
    }
    if (typeof options.numbering !== 'boolean') errors.push({ message: '编号开关无效' });
    if (options.numbering) {
      if (!Number.isInteger(options.start) || options.start < 0 || options.start > MAX_NUMBER || options.start + assets.length - 1 > MAX_NUMBER) errors.push({ message: `起始编号及最后编号应在 0 至 ${MAX_NUMBER} 之间` });
      if (!Number.isInteger(options.digits) || options.digits < 1 || options.digits > 10) errors.push({ message: '编号位数应为 1 至 10' });
      if (!['append', 'replace'].includes(options.numberMode)) errors.push({ message: '编号方式无效' });
    }
    if (errors.length) return result();
    const ids = new Set(), names = new Map();
    assets.forEach((asset, index) => {
      if (!asset || typeof asset.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(asset.id) || ids.has(asset.id) || typeof asset.name !== 'string' || typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.hash)) {
        errors.push({ index, id: asset?.id, message: `第 ${index + 1} 个素材信息无效，请重新选择` }); return;
      }
      ids.add(asset.id);
      let name = options.find ? asset.name.split(options.find).join(options.replace) : asset.name;
      if (options.numbering) {
        const number = String(options.start + index).padStart(options.digits, '0');
        name = options.numberMode === 'replace' ? number : name + options.separator + number;
      }
      name = (options.prefix + name + options.suffix).trim();
      let error = '';
      if (!name) error = '名称不能为空';
      else if (name.length > MAX_NAME) error = `名称超过 ${MAX_NAME} 个字符`;
      else if (/[\x00-\x1f\x7f]/.test(name)) error = '名称不能包含换行或控制字符';
      const row = { id: asset.id, beforeName: asset.name, name, ext: typeof asset.ext === 'string' ? asset.ext : '', changed: name !== asset.name, error };
      rows.push(row);
      if (error) errors.push({ index, id: asset.id, message: `第 ${index + 1} 项：${error}` });
      else {
        const key = name.toLocaleLowerCase(); names.set(key, (names.get(key) || 0) + 1);
        if (row.changed) changes.push({ id: asset.id, beforeName: asset.name, name, hash: asset.hash });
      }
    });
    const duplicates = [...names.values()].filter(count => count > 1).reduce((sum, count) => sum + count, 0);
    if (duplicates) warnings.push(`${duplicates} 个素材将使用相同名称，允许重名，请确认预览结果。`);
    if (errors.length) changes.length = 0;
    return result();
  }
  function create({ apply, onApplied = () => {}, onError = () => {}, onClose = () => {} } = {}) {
    if (typeof apply !== 'function') throw new Error('批量重命名需要保存方法');
    let host = null, current = null, pending = false, previousFocus = null, serial = 0;
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    function close(force = false) {
      if (!host || pending && force !== true) return false;
      const old = host; host = null; current = null; serial++;
      old.remove(); pending = false;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      previousFocus = null; onClose(); return true;
    }
    function open(assets, root) {
      if (pending) return false;
      const initial = plan(assets);
      if (!initial.valid || typeof root !== 'string' || !root) { onError(new Error(initial.errors[0]?.message || '素材库无效')); return false; }
      close(); previousFocus = document.activeElement;
      current = { assets: assets.map(asset => ({ id: asset.id, name: asset.name, hash: asset.hash, ext: asset.ext })), root, options: { ...defaults }, plan: initial };
      const token = ++serial;
      host = node('div', 'batch-rename-overlay'); host.id = 'batchRenameOverlay';
      const form = node('form', 'batch-rename-dialog'); form.id = 'batchRenameDialog'; form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-labelledby', 'batchRenameTitle'); form.tabIndex = -1;
      const header = node('header', 'batch-rename-header'), heading = node('div');
      const title = node('h2', '', '批量重命名'); title.id = 'batchRenameTitle';
      heading.append(title, node('p', '', '按当前列表顺序编号，仅更改素材名称；原文件保持不变。完成后可使用 Ctrl＋Z 撤销。'));
      const dismiss = node('button', 'batch-rename-close', '×'); dismiss.type = 'button'; dismiss.id = 'batchRenameClose'; dismiss.setAttribute('aria-label', '关闭批量重命名'); dismiss.addEventListener('click', () => close()); header.append(heading, dismiss);
      const body = node('div', 'batch-rename-body'), rules = node('div', 'batch-rename-rules');
      const controls = {};
      function field(key, label, { type = 'text', min, max, hint } = {}) {
        const wrap = node('label', 'batch-rename-field'), caption = node('span', '', label), input = node('input');
        input.type = type; input.id = `batchRename${key[0].toUpperCase()}${key.slice(1)}`;
        input.name = key; input.value = String(current.options[key]);
        if (type === 'text') { input.maxLength = MAX_NAME; input.autocomplete = 'off'; input.spellcheck = false; }
        if (min !== undefined) input.min = String(min); if (max !== undefined) input.max = String(max);
        input.addEventListener('input', () => { if (!current || pending) return; current.options[key] = type === 'number' ? input.value === '' ? NaN : Number(input.value) : input.value; refresh(); });
        wrap.append(caption, input); if (hint) wrap.append(node('small', '', hint)); controls[key] = input; return wrap;
      }
      const textRules = node('div', 'batch-rename-text-rules');
      textRules.append(field('prefix', '统一前缀'), field('suffix', '统一后缀'), field('find', '查找文字', { hint: '区分大小写，按普通文字查找' }), field('replace', '替换为', { hint: '留空表示删除匹配文字' }));
      const numbering = node('label', 'batch-rename-check'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'batchRenameNumbering'; checkbox.name = 'numbering'; checkbox.addEventListener('change', () => { if (!current || pending) return; current.options.numbering = checkbox.checked; refresh(); }); controls.numbering = checkbox; numbering.append(checkbox, node('span', '', '添加连续编号'));
      const numbers = node('div', 'batch-rename-number-rules');
      const modeLabel = node('label', 'batch-rename-field'), mode = node('select'); mode.id = 'batchRenameNumberMode'; mode.name = 'numberMode';
      for (const [value, label] of [['append', '保留原名称，末尾加编号'], ['replace', '仅使用编号']]) { const option = node('option', '', label); option.value = value; mode.append(option); }
      mode.addEventListener('change', () => { if (!current || pending) return; current.options.numberMode = mode.value; refresh(); }); controls.numberMode = mode; modeLabel.append(node('span', '', '编号方式'), mode);
      numbers.append(modeLabel, field('start', '起始编号', { type: 'number', min: 0, max: MAX_NUMBER }), field('digits', '最少位数', { type: 'number', min: 1, max: 10 }), field('separator', '编号前分隔符'));
      rules.append(textRules, numbering, numbers);
      const preview = node('section', 'batch-rename-preview'), previewHeading = node('div', 'batch-rename-preview-heading'); previewHeading.append(node('h3', '', '名称预览'));
      const count = node('span'); count.id = 'batchRenameCount'; previewHeading.append(count);
      const tableWrap = node('div', 'batch-rename-table-scroll'), table = node('table'), thead = node('thead'), headRow = node('tr');
      for (const label of ['原名称', '新名称']) headRow.append(node('th', '', label)); thead.append(headRow); const tbody = node('tbody'); tbody.id = 'batchRenameRows'; table.append(thead, tbody); tableWrap.append(table);
      const extra = node('p', 'batch-rename-extra'), status = node('p', 'batch-rename-status'); status.id = 'batchRenameStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      preview.append(previewHeading, tableWrap, extra, status); body.append(rules, preview);
      const footer = node('footer', 'batch-rename-footer'), cancel = node('button', 'secondary-button', '取消'), submit = node('button', 'primary-button', '保存名称'); cancel.type = 'button'; cancel.id = 'batchRenameCancel'; cancel.addEventListener('click', () => close()); submit.type = 'submit'; submit.id = 'batchRenameApply'; footer.append(cancel, submit); form.append(header, body, footer); host.append(form); document.body.append(host);
      const allControls = [...Object.values(controls), dismiss, cancel, submit];
      function refresh() {
        if (!current || !host) return;
        const result = current.plan = plan(current.assets, current.options);
        const numbered = current.options.numbering, onlyNumber = numbered && current.options.numberMode === 'replace';
        for (const input of allControls) input.disabled = pending;
        for (const key of ['start', 'digits', 'separator', 'numberMode']) controls[key].disabled = pending || !numbered || key === 'separator' && onlyNumber;
        controls.find.disabled = controls.replace.disabled = pending || onlyNumber;
        numbers.classList.toggle('is-disabled', !numbered);
        tbody.replaceChildren(...result.rows.slice(0, 100).map(row => {
          const tr = node('tr', row.error ? 'is-error' : row.changed ? 'is-changed' : ''), before = node('td', '', row.beforeName), after = node('td', '', row.error || row.name);
          before.title = row.beforeName; after.title = row.error || row.name; tr.append(before, after); return tr;
        }));
        count.textContent = `${result.changedCount} / ${current.assets.length} 个将更名`;
        extra.textContent = current.assets.length > 100 ? `仅展示前 100 项，保存将应用于全部 ${current.assets.length} 个素材。` : '';
        status.classList.toggle('is-error', result.errors.length > 0);
        status.textContent = pending ? '正在保存名称…' : result.errors[0]?.message || result.warnings[0] || (result.changedCount ? '确认新名称后保存，整批操作可一次撤销。' : '修改上方规则后，这里会显示新名称。');
        submit.disabled = pending || !result.valid || !result.changedCount;
      }
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (pending || !current || token !== serial) return;
        const result = plan(current.assets, current.options);
        if (!result.valid || !result.changedCount) { refresh(); return; }
        pending = true; refresh(); const savedRoot = current.root;
        try {
          const snapshot = await apply(result.changes, savedRoot);
          if (token !== serial || !host) return;
          pending = false; close(); onApplied(snapshot, { changedCount: result.changedCount, root: savedRoot });
        } catch (error) {
          if (token !== serial || !host) return;
          pending = false; refresh(); status.textContent = error?.message || String(error); status.classList.add('is-error'); onError(error);
        }
      });
      host.addEventListener('click', event => { if (event.target === host) close(); });
      host.addEventListener('keydown', event => {
        // Keep native input undo and all dialog keys away from library shortcuts.
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        if (event.key === 'Tab') {
          const focusable = [...form.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
          const first = focusable[0], last = focusable.at(-1);
          if (!first) { event.preventDefault(); form.focus(); }
          else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
        }
      });
      refresh(); controls.prefix.focus({ preventScroll: true }); return true;
    }
    return { open, close, isOpen: () => Boolean(host) };
  }
  return { plan, create, defaults, MAX_NAME, MAX_ASSETS };
});
