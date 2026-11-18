(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShituFontCompare = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const MAX_ASSETS = 16;
  const FONT_FORMATS = new Set(['ttf', 'otf', 'woff', 'woff2', 'ttc', 'otc']);
  const DEFAULT_TEXT = '拾图 · 字体对比\nThe quick brown fox\n0123456789';
  let familySerial = 0;
  const clamp = (value, low, high, fallback) => Number.isFinite(Number(value)) ? Math.min(high, Math.max(low, Number(value))) : fallback;
  function normalizeAssets(assets) {
    if (!Array.isArray(assets)) throw new Error('请选择字体进行对比');
    const unique = new Map();
    for (const asset of assets) {
      if (!asset || typeof asset.id !== 'string' || !asset.id || asset.trashedAt ||
          !(asset.mediaType === 'font' || FONT_FORMATS.has(String(asset.ext || '').toLowerCase()))) throw new Error('字体对比仅支持未删除的字体素材');
      unique.set(asset.id, asset);
    }
    if (unique.size < 2) throw new Error('请至少选择 2 个字体进行对比');
    if (unique.size > MAX_ASSETS) throw new Error(`一次最多对比 ${MAX_ASSETS} 个字体，请减少选择`);
    return [...unique.values()];
  }
  function foreground(background) {
    const rgb = /^#[0-9a-f]{6}$/i.test(background) ? background.slice(1).match(/../g).map(value => parseInt(value, 16) / 255) : [1, 1, 1];
    const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 > 0.179 ? '#161616' : '#f4f4f4';
  }
  function normalizeSettings(value = {}) {
    const background = /^#[0-9a-f]{6}$/i.test(value.background) ? value.background.toLowerCase() : '#eae8e2';
    return { text: typeof value.text === 'string' ? value.text.slice(0, 2000) : DEFAULT_TEXT,
      size: Math.round(clamp(value.size, 16, 160, 48)), lineHeight: Math.round(clamp(value.lineHeight, 1, 2.4, 1.5) * 100) / 100,
      background, foreground: foreground(background) };
  }
  function fontUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'shitu:' || url.hostname !== 'font' || url.port || url.username || url.password || url.search || url.hash ||
        !/^\/[0-9a-f-]{36}\/preview\.(ttf|otf|woff|woff2)$/.test(url.pathname)) throw new Error('字体预览地址无效');
    return url.href;
  }
  function createFaceController({ prepare, fontSet, FontFaceCtor, timeoutMs = 15000 }) {
    let request = 0, face = null, disposed = false;
    return {
      async load(id, libraryRoot, index = 0) {
        if (disposed) return null;
        const serial = ++request;
        const current = () => !disposed && serial === request;
        let timer;
        try {
          const prepared = await prepare(id, libraryRoot, index);
          if (!current()) return null;
          const candidate = new FontFaceCtor(`shitu-compare-${++familySerial}`, `url(${JSON.stringify(fontUrl(prepared.url))})`);
          await Promise.race([candidate.load(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('字体加载超时，请重试')), timeoutMs); })]);
          if (!current()) return null;
          if (candidate.status !== 'loaded') throw new Error('此字体暂时无法解码');
          fontSet.add(candidate);
          if (face) fontSet.delete(face);
          face = candidate;
          return { prepared, face };
        } catch (error) { if (current()) throw error; return null; }
        finally { clearTimeout(timer); }
      },
      dispose() { disposed = true; request++; if (face) fontSet.delete(face); face = null; }
    };
  }
  function create({ prepare, onError, onClose } = {}) {
    if (typeof prepare !== 'function') throw new Error('缺少字体预览服务');
    const document = globalThis.document;
    if (!document) throw new Error('字体对比需要浏览器窗口');
    const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
    const button = (label, className, action) => { const item = node('button', className, label); item.type = 'button'; item.addEventListener('click', action); return item; };
    const overlay = node('div', 'font-compare-overlay'); overlay.id = 'fontCompareOverlay'; overlay.hidden = true;
    const dialog = node('section', 'font-compare-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'fontCompareTitle');
    const heading = node('header', 'font-compare-heading'), title = node('h2', '', '字体对比'); title.id = 'fontCompareTitle';
    const summary = node('span', 'font-compare-summary'); summary.id = 'fontCompareSummary'; summary.setAttribute('role', 'status');
    const closeButton = button('关闭', 'secondary-button', close); closeButton.id = 'fontCompareClose'; closeButton.setAttribute('aria-label', '关闭字体对比');
    heading.append(title, summary, closeButton);
    const controls = node('div', 'font-compare-controls');
    const textLabel = node('label', 'font-compare-text-label', '统一预览文字'); textLabel.htmlFor = 'fontCompareText';
    const textInput = node('textarea'); textInput.id = 'fontCompareText'; textInput.maxLength = 2000; textInput.spellcheck = false; textInput.rows = 3; textLabel.append(textInput);
    const settingsPanel = node('div', 'font-compare-settings');
    function slider(id, label, min, max, step) {
      const wrap = node('label'), line = node('span', 'font-compare-setting-title', label), output = node('output'), input = node('input');
      wrap.htmlFor = id; input.id = id; input.type = 'range'; input.min = min; input.max = max; input.step = step; output.htmlFor = id; output.id = `${id}Value`; line.append(output); wrap.append(line, input); settingsPanel.append(wrap); return { input, output };
    }
    const sizeControl = slider('fontCompareSize', '字号', '16', '160', '1'), lineControl = slider('fontCompareLineHeight', '行距', '1', '2.4', '.05');
    const colorRow = node('div', 'font-compare-color-row'), colorLabel = node('label', '', '背景'); colorLabel.htmlFor = 'fontCompareBackground';
    const colorInput = node('input'); colorInput.type = 'color'; colorInput.id = 'fontCompareBackground'; colorInput.setAttribute('aria-label', '对比背景色'); colorLabel.append(colorInput); colorRow.append(colorLabel);
    const lightButton = button('浅色', 'font-compare-preset', () => update({ background: '#eae8e2' }));
    const darkButton = button('深色', 'font-compare-preset', () => update({ background: '#202124' }));
    lightButton.id = 'fontCompareLight'; darkButton.id = 'fontCompareDark'; colorRow.append(lightButton, darkButton); settingsPanel.append(colorRow);
    controls.append(textLabel, settingsPanel);
    const grid = node('div', 'font-compare-grid'); grid.id = 'fontCompareGrid';
    const note = node('p', 'font-compare-note', '统一文字、字号、行距与背景；每张卡片可切换合集字型。缺字可能由系统字体补全，原字体文件保持不变。');
    dialog.append(heading, controls, grid, note); overlay.append(dialog); document.body.append(overlay);
    let opened = false, generation = 0, cards = [], previousFocus, settings = normalizeSettings();
    function update(patch = {}) {
      settings = normalizeSettings({ ...settings, ...patch });
      textInput.value = settings.text; sizeControl.input.value = settings.size; sizeControl.output.value = `${settings.size} px`;
      lineControl.input.value = settings.lineHeight; lineControl.output.value = `${settings.lineHeight.toFixed(2)} 倍`;
      colorInput.value = settings.background;
      grid.style.setProperty('--font-compare-size', `${settings.size}px`); grid.style.setProperty('--font-compare-line-height', settings.lineHeight);
      grid.style.setProperty('--font-compare-background', settings.background); grid.style.setProperty('--font-compare-foreground', settings.foreground);
      lightButton.setAttribute('aria-pressed', String(settings.background === '#eae8e2')); darkButton.setAttribute('aria-pressed', String(settings.background === '#202124'));
      for (const card of cards) card.sample.textContent = settings.text;
    }
    textInput.addEventListener('input', () => update({ text: textInput.value }));
    sizeControl.input.addEventListener('input', () => update({ size: sizeControl.input.value }));
    lineControl.input.addEventListener('input', () => update({ lineHeight: lineControl.input.value }));
    colorInput.addEventListener('input', () => update({ background: colorInput.value }));
    function renderSummary() {
      const ready = cards.filter(card => card.element.dataset.status === 'ready').length, failed = cards.filter(card => card.element.dataset.status === 'error').length;
      summary.textContent = `${cards.length} 个字体 · 已载入 ${ready}${failed ? ` · ${failed} 个暂不可预览` : ''}`;
    }
    async function loadCard(card, index = 0) {
      const session = generation, serial = ++card.request;
      card.element.dataset.status = 'loading'; card.element.setAttribute('aria-busy', 'true'); card.status.hidden = false; card.status.textContent = '正在载入字体…'; card.sample.hidden = true; card.retry.hidden = true; renderSummary();
      try {
        const result = await card.controller.load(card.asset.id, card.root, index);
        if (!opened || session !== generation || serial !== card.request || !result) return;
        const { prepared, face } = result;
        const faces = Array.isArray(prepared.faces) ? prepared.faces.slice(0, 128) : [];
        card.family.textContent = prepared.family || card.asset.name;
        card.metadata.textContent = `${String(card.asset.ext || prepared.format || '').toUpperCase()} · ${prepared.style || 'Regular'}`;
        card.select.replaceChildren(...faces.map((item, number) => { const option = node('option', '', `${item.family || prepared.family || '字体'} · ${item.style || item.fullName || `字型 ${number + 1}`}`); option.value = String(item.index ?? number); return option; }));
        card.select.value = String(prepared.faceIndex ?? index); card.faceLabel.hidden = faces.length < 2; card.select.disabled = faces.length < 2;
        card.sample.style.fontFamily = `"${face.family}", sans-serif`;
        card.sample.textContent = settings.text; card.sample.hidden = false; card.status.hidden = true;
        card.element.dataset.status = 'ready'; card.element.dataset.faceIndex = String(prepared.faceIndex ?? index); card.element.setAttribute('aria-busy', 'false'); renderSummary();
      } catch (error) {
        if (!opened || session !== generation || serial !== card.request) return;
        card.element.dataset.status = 'error'; card.element.setAttribute('aria-busy', 'false'); card.status.textContent = `暂时无法预览：${String(error?.message || error).slice(0, 350)}`; card.status.hidden = false; card.retry.hidden = false; renderSummary();
      }
    }
    function makeCard(asset, libraryRoot) {
      const element = node('article', 'font-compare-card'); element.dataset.fontId = asset.id; element.dataset.status = 'loading';
      const header = node('header', 'font-compare-card-heading'), family = node('h3', '', asset.font?.family || asset.name), metadata = node('span', 'font-compare-card-meta', String(asset.ext || '').toUpperCase());
      const assetName = node('p', 'font-compare-asset-name', asset.name); assetName.title = asset.name;
      const faceLabel = node('label', 'font-compare-face', '字型'); faceLabel.hidden = true;
      const select = node('select'); select.setAttribute('aria-label', `${asset.name} 的字型`); faceLabel.append(select);
      header.append(family, metadata, assetName, faceLabel);
      const body = node('div', 'font-compare-card-body'), sample = node('div', 'font-compare-sample'), status = node('p', 'font-compare-card-status', '正在载入字体…');
      sample.dataset.fontSample = asset.id; sample.hidden = true; sample.setAttribute('aria-label', `${asset.name} 字体效果`); status.setAttribute('role', 'status');
      const card = { asset, root: libraryRoot, element, family, metadata, select, faceLabel, body, sample, status, request: 0,
        controller: createFaceController({ prepare, fontSet: document.fonts, FontFaceCtor: globalThis.FontFace }) };
      const retry = button('重试', 'font-compare-retry', () => void loadCard(card, Number(select.value) || 0)); card.retry = retry; retry.hidden = true;
      select.addEventListener('change', () => void loadCard(card, Number(select.value)));
      body.append(status, sample, retry); element.append(header, body); return card;
    }
    function close() {
      if (!opened) return;
      opened = false; generation++;
      for (const card of cards) card.controller.dispose();
      cards = []; grid.replaceChildren(); overlay.hidden = true; overlay.dataset.open = 'false';
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      onClose?.();
    }
    function open(assets, libraryRoot) {
      let checked;
      try { checked = normalizeAssets(assets); if (typeof libraryRoot !== 'string' || !libraryRoot) throw new Error('素材库已切换，请重新选择字体'); }
      catch (error) { onError?.(error); return false; }
      if (opened) close();
      opened = true; const session = ++generation; previousFocus = document.activeElement;
      cards = checked.map(asset => makeCard(asset, libraryRoot)); grid.replaceChildren(...cards.map(card => card.element)); update(); renderSummary();
      overlay.hidden = false; overlay.dataset.open = 'true'; closeButton.focus();
      // Limit decoding concurrency when comparing large CJK collections.
      const queue = [...cards];
      for (let worker = 0; worker < Math.min(3, queue.length); worker++) void (async () => {
        while (opened && generation === session && queue.length) await loadCard(queue.shift());
      })();
      return true;
    }
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', event => {
      if (!opened) return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const targets = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')].filter(item => !item.hidden && !item.closest('[hidden]'));
      const first = targets[0], last = targets.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !targets.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !targets.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    });
    return { open, close, isOpen: () => opened };
  }
  return { create, normalizeAssets, normalizeSettings, foreground, fontUrl, createFaceController, MAX_ASSETS };
});
