(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituBundleDetails = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PAGE_SIZE = 40;
  const kinds = Object.freeze({ model: '模型', texture: '贴图', material: '材质', buffer: '缓冲数据' });
  const storageLabels = Object.freeze({ file: '包内文件', embedded: '内嵌', missing: '缺失' });
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const text = value => typeof value === 'string' ? value : '';
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function checkedTime(value) {
    if (typeof value !== 'string') return '';
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp);
  }
  function render(asset, { onRecheck, pending = false } = {}) {
    const project = Boolean(asset?.projectBundle), bundle = project ? asset.projectBundle : asset?.modelBundle;
    if (!bundle) return null;
    const resources = bundle.resources, diagnostics = bundle.diagnostics;
    const stale = Boolean(diagnostics?.sourceHash && bundle.hash && diagnostics.sourceHash !== bundle.hash);
    const known = !stale && resources?.version === 1 && typeof resources.complete === 'boolean' &&
      ['models', 'embeddedTextures', 'externalTextures', 'missingTextures'].every(key => count(resources[key])) && Array.isArray(resources.entries);
    const entries = known ? resources.entries.filter(entry => entry && typeof entry === 'object') : [];
    const section = element('section', 'bundle-details');
    section.setAttribute('aria-label', '资源包清单');
    const heading = element('div', 'bundle-details-heading');
    heading.append(element('h4', 'bundle-details-title', '资源包清单'));
    const checked = Boolean(diagnostics || resources);
    const label = checked ? '重新检查资源包' : '检查资源包';
    const button = element('button', 'bundle-details-recheck', label);
    button.type = 'button';
    heading.append(button);
    section.append(heading);

    const summary = element('p', 'bundle-details-summary', known
      ? `${project ? 'AE 工程 · ' : ''}模型 ${resources.models} 个 · 内嵌贴图 ${resources.embeddedTextures} 张 · 外置贴图 ${resources.externalTextures} 张`
      : `${project ? 'AE 工程 · ' : ''}${stale ? '资源包已变化，资源数量待重新检查。' : '尚未检查资源包，资源数量待确认。'}`);
    section.append(summary);

    const missing = known ? Math.max(resources.missingTextures, entries.filter(entry => entry.storage === 'missing').length,
      Array.isArray(bundle.missing) ? new Set(bundle.missing).size : 0) : null;
    const message = !known ? '检查后可查看包内文件、内嵌贴图和缺失资源。' : missing > 0
      ? `有 ${missing} 项缺失资源，请核对资源清单。`
      : resources.complete ? '已核对资源清单。' : '仅统计已识别资源，部分内部引用需在原软件核对。';
    const status = element('p', 'bundle-details-status', message);
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    section.append(status);
    if (known && resources.missingTextures > 0) section.append(element('p', 'bundle-details-missing', `缺失贴图 ${resources.missingTextures} 张`));
    if (project) section.append(element('p', 'bundle-details-scope', '字体、第三方插件及表达式动态引用不在本次资源清单的检查范围内。'));
    else if (known && resources.embeddedTextures > 0) section.append(element('p', 'bundle-details-scope', '内嵌贴图保存在模型文件中，无需单独的外置贴图文件夹。'));
    const time = checkedTime(diagnostics?.checkedAt);
    if (time) section.append(element('p', 'bundle-details-checked', `上次检查：${time}`));
    for (const [key, label] of [['warnings', '需核对的事项'], ['notes', '格式与导出说明']]) {
      const messages = Array.isArray(bundle[key]) ? bundle[key].filter(value => typeof value === 'string' && value) : [];
      if (!messages.length) continue;
      const information = element('details', 'bundle-details-inventory');
      information.append(element('summary', '', `${label}（${messages.length} 项）`));
      const list = element('ul', 'bundle-details-list');
      const more = element('button', 'bundle-details-more', '显示更多说明'); more.type = 'button';
      let shown = 0;
      const appendMessages = () => {
        for (const message of messages.slice(shown, shown + PAGE_SIZE)) list.append(element('li', 'bundle-details-entry', message));
        shown = Math.min(shown + PAGE_SIZE, messages.length); more.hidden = shown >= messages.length;
      };
      more.addEventListener('click', appendMessages); appendMessages();
      information.append(list, more); section.append(information);
    }

    if (known && entries.length) {
      const details = element('details', 'bundle-details-inventory');
      details.append(element('summary', '', `查看资源清单（${entries.length} 项）`));
      const list = element('ul', 'bundle-details-list');
      const footer = element('div', 'bundle-details-pagination');
      const progress = element('span', 'bundle-details-page-status'); progress.setAttribute('aria-live', 'polite');
      const more = element('button', 'bundle-details-more'); more.type = 'button';
      let shown = 0;
      const appendPage = () => {
        const end = Math.min(shown + PAGE_SIZE, entries.length);
        for (; shown < end; shown++) {
          const entry = entries[shown], row = element('li', 'bundle-details-entry');
          const labels = element('div', 'bundle-details-entry-labels');
          labels.append(element('span', 'bundle-details-kind', kinds[entry.kind] || '资源'),
            element('span', `bundle-details-storage${entry.storage === 'missing' ? ' is-missing' : ''}`, storageLabels[entry.storage] || '待确认'));
          row.append(labels, element('span', 'bundle-details-path', text(entry.path) || text(entry.reference) || text(entry.container) || '未命名资源'));
          if (text(entry.container) && entry.container !== entry.path && entry.container !== entry.reference)
            row.append(element('span', 'bundle-details-container', `所在文件：${entry.container}`));
          list.append(row);
        }
        progress.textContent = `已显示 ${shown} / ${entries.length} 项`;
        more.hidden = shown >= entries.length;
        more.textContent = `显示更多（${Math.min(PAGE_SIZE, entries.length - shown)} 项）`;
      };
      more.addEventListener('click', appendPage);
      footer.append(progress, more); details.append(list, footer); section.append(details); appendPage();
    } else if (known) section.append(element('p', 'bundle-details-empty', '未识别到可展开的资源条目。'));

    let checking = false;
    function setPending(value) {
      checking = value;
      section.setAttribute('aria-busy', String(value));
      button.disabled = value || typeof onRecheck !== 'function';
      button.textContent = value ? '正在检查…' : label;
      status.textContent = value ? '正在检查资源包…' : message;
    }
    button.addEventListener('click', async () => {
      if (checking || typeof onRecheck !== 'function') return;
      setPending(true);
      try { await onRecheck(asset); setPending(false); }
      catch { setPending(false); status.textContent = '资源包检查未完成，请重试。'; }
    });
    setPending(Boolean(pending));
    return section;
  }

  return Object.freeze({ PAGE_SIZE, render });
});
