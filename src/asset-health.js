(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituAssetHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function summary(asset) {
    const items = (asset?.projectBundle || asset?.modelBundle)?.missing;
    if (!Array.isArray(items) || !items.length) return null;
    return {
      items,
      label: asset.projectBundle ? '缺少引用素材' : '缺少模型资源',
      count: items.length
    };
  }

  function cardBadge(health) {
    const badge = document.createElement('span');
    badge.className = 'asset-health-badge';
    badge.textContent = `${health.label} ${health.count.toLocaleString()}`;
    badge.setAttribute('aria-hidden', 'true');
    const sample = health.items.slice(0, 3).map(item => item.slice(0, 220));
    badge.title = [`${health.label}（${health.count.toLocaleString()} 个）`, ...sample,
      ...(health.count > sample.length ? ['在详情中查看全部缺失引用'] : [])].join('\n');
    return badge;
  }

  function details(health) {
    const section = document.createElement('details');
    section.className = 'asset-health-details';
    const heading = document.createElement('summary');
    heading.textContent = `${health.label}（${health.count.toLocaleString()} 个）`;
    const note = document.createElement('p');
    note.textContent = '以下引用在导入打包时未收集到。';
    const list = document.createElement('ul');
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'text-button asset-health-more hidden';
    more.textContent = '显示更多引用';
    let shown = 0;
    function appendItems() {
      const batch = health.items.slice(shown, shown + 40);
      const fragment = document.createDocumentFragment();
      for (const path of batch) {
        const item = document.createElement('li');
        item.textContent = path;
        fragment.append(item);
      }
      list.append(fragment);
      shown += batch.length;
      more.classList.toggle('hidden', shown === health.count);
      if (shown === health.count && document.activeElement === more) heading.focus();
    }
    section.addEventListener('toggle', () => { if (section.open && shown === 0) appendItems(); });
    more.addEventListener('click', appendItems);
    section.append(heading, note, list, more);
    return section;
  }

  function renderFilter(button, assets, enabled) {
    const count = enabled ? assets.length : assets.reduce((total, asset) => total + Number(Boolean(summary(asset))), 0);
    button.classList.toggle('hidden', !enabled && count === 0);
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = `缺失资源 ${count.toLocaleString()}`;
    button.title = enabled ? '取消缺失资源筛选' : '只显示打包时记录了缺失引用的素材';
  }

  return Object.freeze({ summary, cardBadge, details, renderFilter });
});
