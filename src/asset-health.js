(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituAssetHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  let activeRepair;

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

  function repairControls(repair) {
    const panel = document.createElement('div');
    panel.className = 'asset-repair';
    const choose = document.createElement('button');
    choose.type = 'button'; choose.className = 'secondary-button'; choose.textContent = '查找缺失文件';
    const apply = document.createElement('button');
    apply.type = 'button'; apply.className = 'primary-button hidden'; apply.textContent = '确认并重新打包';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const results = document.createElement('ul');
    results.className = 'asset-repair-results hidden';
    results.setAttribute('aria-label', '匹配结果');
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'text-button hidden'; more.textContent = '显示更多匹配结果';
    const descriptions = { missing: '未找到', ambiguous: '发现多个同名文件，请选择更具体的目录', unsupported: '请在原软件中处理此引用' };
    let plan = null, shown = 0;
    function appendResults() {
      const fragment = document.createDocumentFragment();
      for (const row of plan.rows.slice(shown, shown + 40)) {
        const item = document.createElement('li');
        item.textContent = row.status === 'matched' ? `${row.reference} → ${row.file}` : `${row.reference} · ${descriptions[row.status]}`;
        item.dataset.match = row.status;
        fragment.append(item);
      }
      results.append(fragment);
      shown += 40;
      more.classList.toggle('hidden', shown >= plan.rows.length);
    }
    more.addEventListener('click', () => { if (plan) appendResults(); });
    choose.addEventListener('click', async () => {
      choose.disabled = apply.disabled = true;
      try {
        const selected = await repair.choose();
        if (!selected) return;
        if (plan) await repair.cancel(plan.token);
        if (!panel.isConnected) { await repair.cancel(selected.token); return; }
        plan = selected;
        shown = 0;
        results.replaceChildren();
        appendResults();
        results.classList.toggle('hidden', !selected.rows.length);
        status.textContent = selected.matches ? `找到 ${selected.matches} 项，核对对应文件后可重新打包。` : '这个目录里没有可确认的匹配文件。';
        apply.classList.toggle('hidden', !selected.matches);
        choose.textContent = '选择其他文件夹';
      } catch (error) { status.textContent = repair.message(error); }
      finally { choose.disabled = false; apply.disabled = !plan?.matches; }
    });
    apply.addEventListener('click', async () => {
      if (!plan?.matches) return;
      choose.disabled = apply.disabled = true;
      status.textContent = '正在重建素材包…';
      const token = plan.token;
      plan = null;
      more.classList.add('hidden');
      try { await repair.apply(token); }
      catch (error) {
        status.textContent = repair.message(error);
        choose.disabled = false;
        apply.classList.add('hidden');
      }
    });
    panel.append(choose, apply, status, results, more);
    return panel;
  }

  function details(health, repair) {
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
    if (repair) {
      if (activeRepair?.key !== repair.key || !activeRepair?.panel) activeRepair = { key: repair.key, panel: repairControls(repair) };
      section.open = Boolean(activeRepair.panel.parentElement?.open);
      section.append(activeRepair.panel);
    }
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
