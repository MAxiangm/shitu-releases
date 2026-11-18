(() => {
  'use strict';

  function create({ find, cancel, assetUrl, lookupAsset, onLocate } = {}) {
    const make = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    function button(text, className, action) {
      const node = make('button', className, text);
      node.type = 'button';
      node.addEventListener('click', action);
      return node;
    }

    const overlay = make('div', 'similar-images-overlay');
    overlay.id = 'similarImagesOverlay';
    overlay.hidden = true;
    const dialog = make('section', 'similar-images-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'similarImagesTitle');
    const heading = make('header', 'similar-images-heading');
    const title = make('h2', '', '查找相似图片');
    title.id = 'similarImagesTitle';
    const status = make('p', 'similar-images-status');
    status.id = 'similarImagesStatus';
    status.setAttribute('role', 'status');
    const closeButton = button('关闭', 'secondary-button', () => close());
    heading.append(title, status, closeButton);

    const comparison = make('div', 'similar-images-comparison');
    const results = make('div', 'similar-images-results');
    results.id = 'similarImagesResults';
    results.setAttribute('aria-label', '相似图片结果');
    results.hidden = true;
    const footer = make('footer', 'similar-images-footer');
    const progress = make('progress', 'similar-images-progress');
    progress.setAttribute('aria-label', '相似图片查找进度');
    const stopButton = button('停止查找', 'secondary-button', stopSearch);
    footer.append(progress, stopButton);
    dialog.append(heading, comparison, results, footer);
    overlay.append(dialog);
    document.body.append(overlay);

    let session, previousFocus, sequence = 0;
    function isOpen() { return !overlay.hidden; }
    function cancelSession(current) {
      if (!current?.searching) return;
      current.searching = false;
      void Promise.resolve().then(() => cancel(current.root, current.token)).catch(() => {});
    }
    function hideProgress() {
      if (footer.contains(document.activeElement)) closeButton.focus({ preventScroll: true });
      footer.hidden = true;
    }
    function stopSearch() {
      cancelSession(session);
      hideProgress();
      status.textContent = '已停止查找';
    }
    function close() {
      if (!isOpen()) return;
      cancelSession(session);
      session = null;
      overlay.hidden = true;
      comparison.replaceChildren();
      results.replaceChildren();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      previousFocus = null;
    }
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('button:not(:disabled)')].filter(node => node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    function image(asset, alt) {
      const img = make('img', 'similar-images-image');
      img.alt = alt;
      img.draggable = false;
      img.decoding = 'async';
      img.src = assetUrl(asset.id, 'thumbnail');
      return img;
    }
    function metadata(asset) {
      const details = [];
      if (asset.width && asset.height) details.push(`${asset.width} × ${asset.height}`);
      if (asset.ext) details.push(asset.ext.toUpperCase());
      if (Number.isFinite(asset.size) && asset.size >= 0) {
        if (asset.size >= 1048576) details.push(`${(asset.size / 1048576).toFixed(1)} MB`);
        else if (asset.size >= 1024) details.push(`${(asset.size / 1024).toFixed(1)} KB`);
        else details.push(`${asset.size} B`);
      }
      return details.join(' · ');
    }
    function comparisonCard(asset, label, current) {
      const card = make('article', 'similar-images-card');
      if (!asset) {
        card.classList.add('similar-images-empty');
        card.append(make('p', '', label));
        return card;
      }
      card.dataset.assetId = asset.id;
      const media = make('div', 'similar-images-media');
      const preview = image(asset, asset.name);
      preview.addEventListener('error', () => media.replaceChildren(make('span', '', '图片暂不可预览')), { once: true });
      media.append(preview);
      const info = make('div', 'similar-images-card-info');
      const name = make('h3', '', asset.name);
      name.title = asset.name;
      info.append(make('span', 'similar-images-match-label', label), name, make('p', '', metadata(asset)));
      if (onLocate) {
        const locate = button('在素材库中查看', 'secondary-button similar-images-locate', () => {
          close();
          onLocate(asset.id, current.root);
        });
        info.append(locate);
      }
      card.append(media, info);
      return card;
    }
    function showComparison(current, match) {
      const label = match?.kind === 'crop' ? '可能是裁剪版本' : '相似构图';
      comparison.replaceChildren(comparisonCard(current.reference, '参考图片', current),
        comparisonCard(match?.asset, match ? label : '选择结果进行对比', current));
      for (const option of results.querySelectorAll('button')) {
        option.setAttribute('aria-pressed', String(option.dataset.assetId === match?.asset.id));
      }
    }
    function updateProgress(detail) {
      if (!session?.searching || detail?.token !== session.token || detail.root !== session.root) return;
      const total = Number(detail.total) || 0;
      status.textContent = `正在查找 · 已检查 ${detail.current} / ${total} 张图片`;
      if (total > 0) { progress.max = total; progress.value = detail.current; }
    }
    async function search(current) {
      try {
        const result = await find(current.reference.id, current.root, current.token);
        if (session !== current || !current.searching) return;
        current.searching = false;
        hideProgress();
        const matches = result.matches.flatMap(match => {
          const asset = lookupAsset(match.id);
          return asset && !asset.trashedAt ? [{ ...match, asset }] : [];
        });
        const missing = result.skipped ? ` · ${result.skipped} 张图片暂不可读取` : '';
        const limited = result.matched > result.matches.length ? ` · 显示前 ${result.matches.length} 张` : '';
        status.textContent = matches.length ? `找到 ${result.matched} 张相似图片${limited}${missing}` : `未找到相似图片${missing}`;
        results.replaceChildren(...matches.map(match => {
          const option = button('', 'similar-images-option', () => showComparison(current, match));
          option.dataset.assetId = match.asset.id;
          option.title = match.asset.name;
          const thumbnail = image(match.asset, '');
          thumbnail.loading = 'lazy';
          option.append(thumbnail, make('span', '', match.asset.name));
          return option;
        }));
        results.hidden = matches.length === 0;
        if (matches.length) showComparison(current, matches[0]);
        else comparison.replaceChildren(comparisonCard(current.reference, '参考图片', current),
          comparisonCard(null, '未找到可对比的图片', current));
      } catch (error) {
        if (session !== current || !current.searching) return;
        current.searching = false;
        hideProgress();
        status.textContent = String(error?.message || '暂时无法查找相似图片')
          .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
      }
    }
    function open(reference, root) {
      if (!root || !reference?.id || reference.trashedAt) return;
      close();
      previousFocus = document.activeElement;
      const current = { reference, root, token: `similar_${Date.now().toString(36)}_${(++sequence).toString(36)}`, searching: true };
      session = current;
      showComparison(current);
      status.textContent = '正在查找相似图片…';
      progress.removeAttribute('value');
      progress.removeAttribute('max');
      results.hidden = true;
      footer.hidden = false;
      overlay.hidden = false;
      closeButton.focus({ preventScroll: true });
      void search(current);
    }

    return Object.freeze({ open, close, isOpen, updateProgress });
  }

  window.ShituSimilarImages = Object.freeze({ create });
})();
