'use strict';

// A bounded cylinder window keeps its DOM independent of library size.
// Column density changes the visible arc; original-image zoom is single-view only.
class ShituCylinderPreview {
  constructor({ viewport, ring, parking, media, createThumbnail, onSelect, onModeChange }) {
    Object.assign(this, { viewport, ring, parking, media, createThumbnail, onSelect, onModeChange });
    this.cards = new Map();
    this.items = [];
    this.step = 36;
    this.position = 0;
    this.targetColumn = 0;
    this.activeRow = 0;
    this.frame = 0;
    this.lastFrameDraw = 0;
    this.appVisible = true;
    this.pageActive = true;
    this.suspendedVideos = new Map();
    this.rotation = null;
    const savedRows = Number(localStorage.getItem('shitu-preview-rows'));
    this.preferredRows = Number.isInteger(savedRows) && savedRows >= 1 && savedRows <= 5 ? savedRows : null;
    const savedColumns = Number(localStorage.getItem('shitu-preview-columns'));
    this.preferredColumns = Number.isInteger(savedColumns) && savedColumns >= 1 && savedColumns <= 9 ? savedColumns : 3;
    this.displayColumns = this.preferredColumns;
    this.rowWheelRemainder = 0;
    this.wheelRemainder = 0;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.panDrag = null;
    this.lastPointer = null;
    this.focus = document.getElementById('previewFocus');
    this.focusContent = document.getElementById('previewFocusContent');
    this.zoomButton = document.getElementById('previewZoomReset');
    this.opened = false;
    this.activeId = null;
    this.singleMode = false;
    this.firstClick = null;
    this.updateMode();
    // This is an explicit preview effect, independent of OS transition settings.
    this.ambientMotion = localStorage.getItem('shitu-preview-motion') !== 'off';
    this.motionButton = document.getElementById('previewMotion');
    document.getElementById('previewDensity')?.addEventListener('click', () => this.setRows(this.rows >= this.maxRows() ? 1 : this.rows + 1));
    this.motionButton?.addEventListener('click', () => {
      this.ambientMotion = !this.ambientMotion;
      localStorage.setItem('shitu-preview-motion', this.ambientMotion ? 'on' : 'off');
      this.updateMotionButton();
      this.draw();
      this.ensureFrame();
    });
    this.updateMotionButton();
    this.zoomButton?.addEventListener('click', () => this.singleMode ? this.resetZoom() : this.setDisplayColumns(this.displayColumns >= this.maxColumns() ? 1 : this.displayColumns + 1));
    this.updateZoom();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(viewport);
    this.reducedMotion.addEventListener('change', () => {
      if (this.opened && this.reducedMotion.matches) this.finish();
      else this.ensureFrame();
    });
    document.addEventListener('visibilitychange', () => this.syncVisibility());
    window.shitu?.onWindowVisibility?.(visible => { this.appVisible = visible; this.syncVisibility(); });
    window.addEventListener('pagehide', () => { this.pageActive = false; this.syncVisibility(); });
    window.addEventListener('pageshow', () => { this.pageActive = true; this.syncVisibility(); });
    viewport.addEventListener('wheel', event => this.onWheel(event), { passive: false });
    viewport.addEventListener('pointerdown', event => this.trackDoubleClick(event), true);
    viewport.addEventListener('dblclick', event => {
      if (!this.opened || this.singleMode) return;
      const card = event.target.closest('.cylinder-card[data-asset-id]');
      const focused = event.target.closest('#previewFocusContent');
      if (card || focused) { event.preventDefault(); this.enterSingle(card?.dataset.assetId || this.activeId); }
    });
    viewport.addEventListener('pointerdown', event => this.beginPan(event), true);
    viewport.addEventListener('pointermove', event => this.movePan(event), true);
    for (const type of ['pointerup', 'pointercancel']) viewport.addEventListener(type, () => this.endPan(), true);
    viewport.addEventListener('lostpointercapture', event => { if (event.target === viewport && event.pointerId === this.panDrag?.pointerId) this.endPan(); });
    viewport.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
    for (const item of media) {
      for (const type of ['load', 'loadedmetadata', 'loadeddata', 'resize']) item.addEventListener(type, () => { if (this.opened) this.updateZoom(); });
      item.addEventListener('error', () => { if (this.opened) this.resetZoom(); });
    }
  }
  updateMode() {
    this.viewport.classList.toggle('is-single', this.singleMode);
    this.viewport.dataset.mode = this.singleMode ? 'single' : 'cylinder';
    this.ring.parentElement.setAttribute('aria-hidden', String(this.singleMode));
    this.onModeChange?.(this.singleMode);
  }
  trackDoubleClick(event) {
    if (!this.opened || this.singleMode || event.button !== 0) { this.firstClick = null; return; }
    const first = this.firstClick;
    if (first && event.timeStamp - first.time < 500 && Math.hypot(event.clientX - first.x, event.clientY - first.y) < 8) {
      // A side card may rotate away between the two presses. Keep the image
      // under the first press as the target instead of the new hit surface.
      this.firstClick = null;
      event.preventDefault(); event.stopPropagation();
      this.enterSingle(first.id);
      return;
    }
    const card = event.target.closest('.cylinder-card[data-asset-id]');
    const focused = event.target.closest('#previewFocusContent');
    const id = card?.dataset.assetId || (focused ? this.activeId : null);
    this.firstClick = id ? { id, time: event.timeStamp, x: event.clientX, y: event.clientY } : null;
  }
  enterSingle(id = this.activeId) {
    if (!this.opened || this.singleMode) return;
    const index = this.items.findIndex(item => item.id === id);
    if (index < 0) return;
    this.singleMode = true;
    this.firstClick = null;
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.rotation = null;
    this.targetColumn = Math.floor(index / this.rows);
    this.activeRow = index % this.rows;
    this.position = this.targetColumn;
    this.ring.dataset.animating = 'false';
    this.resetZoom(false);
    this.notifySelection();
    this.updateMode();
    this.draw();
  }
  exitSingle() {
    if (!this.singleMode) return;
    this.singleMode = false;
    this.firstClick = null;
    this.resetZoom(false);
    this.position = this.targetColumn;
    this.updateMode();
    this.measure(); this.draw(); this.ensureFrame();
  }
  moveSingle(direction) {
    if (!this.opened || !this.singleMode || this.items.length <= 1) return;
    const current = this.items.findIndex(item => item.id === this.activeId);
    const index = this.modulo(current + direction, this.items.length);
    this.targetColumn = Math.floor(index / this.rows);
    this.activeRow = index % this.rows;
    this.position = this.targetColumn;
    this.notifySelection(); this.draw();
  }
  updateMotionButton() {
    if (!this.motionButton) return;
    this.motionButton.textContent = this.ambientMotion ? '浮动：开' : '浮动：关';
    this.motionButton.setAttribute('aria-pressed', String(this.ambientMotion));
  }
  modulo(value, length) { return ((value % length) + length) % length; }
  open(items, id) {
    this.close();
    this.opened = true;
    this.items = [...items];
    this.rows = Math.min(this.preferredRows || (items.length >= 9 ? 3 : items.length >= 6 ? 2 : 1), this.maxRows());
    this.columns = Math.max(1, Math.ceil(items.length / this.rows));
    const index = Math.max(0, items.findIndex(item => item.id === id));
    this.targetColumn = Math.floor(index / this.rows);
    this.activeRow = index % this.rows;
    this.position = this.targetColumn;
    this.measure();
    this.draw();
    this.notifySelection();
    this.ensureFrame();
  }
  maxRows() {
    const height = this.viewport.getBoundingClientRect().height;
    let maximum = 1;
    // A centered active row needs equal room on either side, including even layouts.
    for (let rows = 1; rows <= Math.min(5, this.items.length); rows++) {
      const slots = 2 * Math.floor(rows / 2) + 1;
      if (slots * 90 + (slots - 1) * 18 + 34 <= height) maximum = rows;
    }
    return maximum;
  }
  measure() {
    const rect = this.viewport.getBoundingClientRect();
    const gap = 18;
    const slots = 2 * Math.floor(this.rows / 2) + 1;
    this.displayColumns = Math.max(1, Math.min(this.preferredColumns, this.maxColumns()));
    this.step = 180 / (this.displayColumns + 2);
    const perspective = Math.max(850, rect.width * 1.12);
    const heightLimit = Math.max(80, (rect.height - 64 - gap * (slots - 1)) / slots);
    // Fit the projected outer card edges, not merely their unrotated widths.
    // Extra columns can occupy unused width before their cards need to shrink.
    const extent = width => {
      const radius = (width + 24) / (2 * Math.tan(this.step * Math.PI / 360));
      let edge = 0;
      for (let offset = -Math.ceil((this.displayColumns - 1) / 2); offset <= Math.ceil((this.displayColumns - 1) / 2); offset++) {
        const angle = offset * this.step * Math.PI / 180;
        for (const corner of [-width / 2, width / 2]) {
          const x = radius * Math.sin(angle) + corner * Math.cos(angle);
          const z = radius * (Math.cos(angle) - 1) - corner * Math.sin(angle);
          edge = Math.max(edge, Math.abs(x * perspective / (perspective - z)));
        }
      }
      return edge * 2;
    };
    let low = 40, high = Math.min(rect.width - 96, heightLimit * 1.42);
    for (let iteration = 0; iteration < 24; iteration++) {
      const width = (low + high) / 2;
      if (extent(width) <= rect.width - 112) low = width; else high = width;
    }
    this.cardWidth = Math.max(40, low);
    this.cardHeight = Math.min(heightLimit, this.cardWidth / .68);
    this.radius = (this.cardWidth + 24) / (2 * Math.tan(this.step * Math.PI / 360));
    this.viewport.style.setProperty('--cylinder-card-width', `${this.cardWidth}px`);
    this.viewport.style.setProperty('--cylinder-card-height', `${this.cardHeight}px`);
    this.viewport.style.setProperty('--cylinder-radius', `${this.radius}px`);
    this.viewport.style.setProperty('--cylinder-perspective', `${perspective}px`);
    this.viewport.dataset.rows = String(this.rows);
    this.viewport.dataset.maxRows = String(this.maxRows());
    this.viewport.dataset.displayColumns = String(this.displayColumns);
    this.viewport.dataset.preferredColumns = String(this.preferredColumns);
    this.viewport.dataset.totalColumns = String(this.columns);
    this.viewport.dataset.maxColumns = String(this.maxColumns());
    const density = document.getElementById('previewDensity');
    if (density) density.textContent = `${this.rows} 行`;
  }
  maxColumns() { return Math.max(1, Math.min(9, this.columns || 1)); }
  setDisplayColumns(value, remember = true) {
    if (!this.opened || this.singleMode) return;
    const next = Math.max(1, Math.min(this.maxColumns(), Math.round(value)));
    if (next === this.displayColumns) return;
    if (remember) {
      this.preferredColumns = next;
      localStorage.setItem('shitu-preview-columns', String(next));
    }
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.rotation = null;
    this.position = this.targetColumn;
    this.ring.dataset.animating = 'false';
    this.measure(); this.draw(); this.ensureFrame();
  }
  resize() {
    if (!this.opened) return;
    if (this.singleMode) { this.updateZoom(); return; }
    const wanted = Math.min(this.preferredRows || this.rows, this.maxRows());
    if (wanted !== this.rows) this.setRows(wanted, false);
    else { this.measure(); this.draw(); }
  }
  assetAt(column, row) {
    const index = this.modulo(column, this.columns) * this.rows + row;
    return { asset: this.items[index], index };
  }
  createCard(column, row, asset, index) {
    const card = document.createElement('article');
    card.className = 'cylinder-card';
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', asset.name);
    card.dataset.column = String(column);
    card.dataset.row = String(row);
    card.dataset.assetId = asset.id;
    card.dataset.assetIndex = String(index);
    const content = document.createElement('div');
    content.className = 'cylinder-media';
    content.append(this.createThumbnail(asset));
    const surface = document.createElement('div');
    surface.className = 'cylinder-card-surface';
    const caption = document.createElement('div');
    caption.className = 'cylinder-caption';
    caption.textContent = asset.name;
    surface.append(content, caption);
    card.append(surface);
    const choose = () => { if (!this.singleMode) this.select(column, row); };
    card.addEventListener('click', choose);
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); choose(); }
    });
    this.ring.append(card);
    return card;
  }
  draw(time = performance.now()) {
    if (!this.opened) return;
    const center = Math.round(this.position);
    const desired = new Set();
    const visibleColumns = new Map();
    const span = Math.max(5, this.displayColumns);
    const candidates = [];
    for (let column = center - span; column <= center + span; column++) candidates.push(column);
    candidates.sort((a, b) => Math.abs(a - this.position) - Math.abs(b - this.position) || a - b);
    // Each logical column is presented only once, even in very small libraries.
    for (const column of candidates) {
      const wrapped = this.modulo(column, this.columns);
      if (!visibleColumns.has(wrapped)) visibleColumns.set(wrapped, { column });
      if (visibleColumns.size >= this.displayColumns) break;
    }
    for (let column = center - span; column <= center + span; column++) {
      const relativeAngle = (column - this.position) * this.step;
      const visible = visibleColumns.get(this.modulo(column, this.columns))?.column === column;
      for (let row = 0; row < this.rows; row++) {
        const { asset, index } = this.assetAt(column, row);
        if (!asset) continue;
        const key = `${column}:${row}`;
        desired.add(key);
        let card = this.cards.get(key);
        if (!card) { card = this.createCard(column, row, asset, index); this.cards.set(key, card); }
        const active = column === this.targetColumn && row === this.activeRow;
        const relativeRow = this.modulo(row - this.activeRow + Math.floor(this.rows / 2), this.rows) - Math.floor(this.rows / 2);
        card.style.transform = `translateY(${relativeRow * (this.cardHeight + 18)}px) rotateY(${column * this.step}deg) translateZ(${this.radius}px)`;
        const bob = active || !visible || !this.ambientMotion ? 0 : Math.sin(time * Math.PI * 2 / (4800 + index % 5 * 300) + index * 1.27) * (10 + Math.min(4, Math.abs(relativeAngle) / this.step * 2));
        card.style.setProperty('--cylinder-bob', `${bob.toFixed(3)}px`);
        card.style.setProperty('--cylinder-blur', `${active ? 0 : Math.min(1.7, .7 + Math.abs(relativeAngle) / 75).toFixed(2)}px`);
        card.style.opacity = visible ? String(active ? 1 : Math.max(.3, .92 - Math.abs(relativeAngle) / 140)) : '0';
        card.style.pointerEvents = visible ? 'auto' : 'none';
        card.tabIndex = visible ? 0 : -1;
        card.setAttribute('aria-hidden', String(!visible));
        card.classList.toggle('is-active', active);
        card.classList.toggle('is-zoomed', active && this.zoom > 1);
        card.setAttribute('aria-current', String(active));
      }
    }
    for (const [key, card] of this.cards) if (!desired.has(key)) {
      if (this.media.some(item => card.contains(item))) this.parkMedia();
      card.remove(); this.cards.delete(key);
    }
    this.ring.style.transform = `translateZ(${-this.radius}px) rotateY(${-this.position * this.step}deg)`;
    this.ring.dataset.position = this.position.toFixed(6);
    this.ring.dataset.targetColumn = String(this.targetColumn);
    this.attachMedia();
  }
  parkMedia() { for (const item of this.media) this.parking.append(item); }
  attachMedia() {
    const card = this.cards.get(`${this.targetColumn}:${this.activeRow}`);
    const target = this.singleMode || this.zoom > 1 ? this.focusContent : card?.querySelector('.cylinder-media') || this.parking;
    for (const item of this.media) if (item.parentElement !== target) target.append(item);
    this.updateZoom();
  }
  notifySelection() {
    const { asset, index } = this.assetAt(this.targetColumn, this.activeRow);
    if (!asset || this.activeId === asset.id) return;
    this.resetZoom(false);
    this.activeId = asset.id;
    this.onSelect(asset, index, this.items.length);
  }
  select(column, row) {
    if (!this.opened || !this.assetAt(column, row).asset) return;
    if (column === this.targetColumn && row === this.activeRow) return;
    this.targetColumn = column;
    this.activeRow = row;
    this.notifySelection();
    this.animate();
  }
  turn(direction) {
    this.firstClick = null;
    if (this.singleMode) return this.moveSingle(direction);
    if (!this.opened || this.columns <= 1) return;
    this.targetColumn += direction;
    while (!this.assetAt(this.targetColumn, this.activeRow).asset && this.activeRow > 0) this.activeRow--;
    this.notifySelection();
    this.animate();
  }
  moveRow(direction) {
    this.firstClick = null;
    if (this.singleMode) return;
    if (!this.opened) return;
    for (let offset = 1; offset <= this.rows; offset++) {
      const row = this.modulo(this.activeRow + direction * offset, this.rows);
      if (this.assetAt(this.targetColumn, row).asset) { this.activeRow = row; break; }
    }
    this.notifySelection();
    this.draw();
  }
  onWheel(event) {
    if (!this.opened) return;
    this.firstClick = null;
    event.preventDefault();
    const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1);
    if (!delta) return;
    if (this.singleMode) {
      this.zoomAt(delta, event.clientX, event.clientY);
    } else if (event.ctrlKey) {
      this.wheelRemainder = 0;
      this.rowWheelRemainder += delta;
      const steps = Math.trunc(this.rowWheelRemainder / 80);
      if (!steps) return;
      this.rowWheelRemainder -= steps * 80;
      this.setRows(this.rows + steps);
      if (this.rows === 1 || this.rows === this.maxRows()) this.rowWheelRemainder = 0;
    } else {
      this.rowWheelRemainder = 0;
      this.wheelRemainder += delta;
      const steps = Math.trunc(this.wheelRemainder / 80);
      if (!steps) return;
      this.wheelRemainder -= steps * 80;
      this.turn(Math.max(-3, Math.min(3, steps)));
    }
  }
  zoomAt(delta, clientX, clientY) {
    if (!this.singleMode) return;
    if (!this.media.some(item => /^(IMG|VIDEO)$/.test(item.tagName) && !item.classList.contains('hidden'))) return;
    if (this.rotation) this.finish();
    const rect = this.viewport.getBoundingClientRect();
    const before = this.zoom;
    this.zoom = Math.max(this.singleMode ? .1 : 1, Math.min(8, before * Math.exp(-Math.max(-1200, Math.min(1200, delta)) * .002)));
    if (!this.singleMode && this.zoom < 1.001) this.zoom = 1;
    const ratio = this.zoom / before;
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2 + (this.singleMode ? 0 : 15);
    this.panX = x - (x - this.panX) * ratio;
    this.panY = y - (y - this.panY) * ratio;
    if (!this.singleMode && this.zoom === 1) { this.panX = 0; this.panY = 0; this.endPan(); }
    this.draw();
  }
  focusSize() {
    const item = this.media.find(node => /^(IMG|VIDEO)$/.test(node.tagName) && !node.classList.contains('hidden'));
    const asset = this.items.find(item => item.id === this.activeId);
    const width = item?.naturalWidth || item?.videoWidth || asset?.width || 1;
    const height = item?.naturalHeight || item?.videoHeight || asset?.height || 1;
    const scale = this.singleMode
      ? Math.min((this.viewport.clientWidth - 64) / width, (this.viewport.clientHeight - 48) / height)
      : Math.min((this.cardWidth - 2) / width, (this.cardHeight - 32) / height);
    return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
  }
  updateZoom() {
    this.viewport.dataset.zoom = String(this.zoom);
    this.viewport.dataset.panX = String(this.panX);
    this.viewport.dataset.panY = String(this.panY);
    this.viewport.classList.toggle('is-zoomed', this.zoom > 1);
    this.focus?.classList.toggle('hidden', !this.singleMode && this.zoom <= 1);
    if (this.zoomButton) {
      this.zoomButton.textContent = this.singleMode ? `${Math.round(this.zoom * 100)}%` : `${this.displayColumns} 列`;
      this.zoomButton.disabled = this.singleMode ? this.zoom === 1 && this.panX === 0 && this.panY === 0 : this.maxColumns() <= 1;
      this.zoomButton.title = this.singleMode ? '恢复默认显示尺寸' : '点击增加横向列数';
      this.zoomButton.setAttribute('aria-label', this.singleMode ? '重置当前图片缩放' : '显示列数，点击切换');
    }
    if ((!this.singleMode && this.zoom <= 1) || !this.focusContent) return;
    const size = this.focusSize();
    // Keep a visible strip of the picture within reach after free panning.
    const maxX = Math.max(0, (this.viewport.clientWidth + size.width * this.zoom) / 2 - 64);
    const maxY = Math.max(0, (this.viewport.clientHeight + size.height * this.zoom) / 2 - 64);
    this.panX = Math.max(-maxX, Math.min(maxX, this.panX));
    this.panY = Math.max(-maxY, Math.min(maxY, this.panY));
    this.viewport.dataset.panX = String(this.panX);
    this.viewport.dataset.panY = String(this.panY);
    this.focusContent.style.width = `${size.width}px`;
    this.focusContent.style.height = `${size.height}px`;
    this.focusContent.style.transform = `translate(-50%, -50%) translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }
  beginPan(event) {
    if (!this.opened || event.button !== 1) return;
    event.preventDefault();
    if (!this.singleMode && this.zoom <= 1) return;
    event.stopPropagation();
    this.startPan(event);
  }
  startPan(event, origin = event) {
    this.endPan();
    this.panDrag = { pointerId: event.pointerId, x: origin.clientX, y: origin.clientY, panX: this.panX, panY: this.panY };
    this.viewport.setPointerCapture(event.pointerId);
    this.viewport.classList.add('is-panning');
  }
  movePan(event) {
    if (!this.opened) return;
    // Native video controls can consume the press/release events, while still
    // exposing pointer movement and its buttons mask. Recover that same drag.
    if (!(event.buttons & 4)) this.endPan();
    else if (!this.panDrag && (this.singleMode || this.zoom > 1)) this.startPan(event, this.lastPointer?.pointerId === event.pointerId ? this.lastPointer : event);
    this.lastPointer = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    if (!this.panDrag || event.pointerId !== this.panDrag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.panX = this.panDrag.panX + event.clientX - this.panDrag.x;
    this.panY = this.panDrag.panY + event.clientY - this.panDrag.y;
    this.updateZoom();
  }
  endPan() {
    const drag = this.panDrag;
    this.panDrag = null;
    if (drag && this.viewport.hasPointerCapture(drag.pointerId)) this.viewport.releasePointerCapture(drag.pointerId);
    this.viewport.classList.remove('is-panning');
  }
  resetZoom(redraw = true) {
    this.endPan();
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.updateZoom();
    if (redraw && this.opened) this.draw();
  }
  setRows(value, remember = true) {
    if (!this.opened) return;
    const next = Math.max(1, Math.min(this.maxRows(), Math.round(value)));
    if (remember) {
      this.preferredRows = next;
      localStorage.setItem('shitu-preview-rows', String(next));
    }
    if (next === this.rows) return;
    this.resetZoom(false);
    const index = Math.max(0, this.items.findIndex(asset => asset.id === this.activeId));
    this.rotation = null;
    this.parkMedia();
    this.ring.replaceChildren(); this.cards.clear();
    this.rows = next;
    this.columns = Math.max(1, Math.ceil(this.items.length / this.rows));
    this.targetColumn = Math.floor(index / this.rows);
    this.activeRow = index % this.rows;
    this.position = this.targetColumn;
    this.ring.dataset.animating = 'false';
    this.measure(); this.draw(); this.notifySelection(); this.ensureFrame();
  }
  animate() {
    if (this.reducedMotion.matches) return this.finish();
    this.rotation = { from: this.position, to: this.targetColumn, start: performance.now(), duration: Math.min(650, 360 + Math.abs(this.targetColumn - this.position) * 35) };
    this.ring.dataset.animating = 'true';
    this.draw();
    this.ensureFrame();
  }
  visible() { return !document.hidden && this.appVisible && this.pageActive; }
  syncVisibility() {
    cancelAnimationFrame(this.frame); this.frame = 0; this.lastFrameDraw = 0;
    if (!this.visible()) {
      this.endPan();
      this.rotation = null;
      this.position = this.targetColumn;
      this.ring.dataset.animating = 'false';
      for (const item of this.media) if (item.tagName === 'VIDEO' && !item.paused) {
        this.suspendedVideos.set(item, item.currentSrc || item.src);
        item.pause();
      }
      return;
    }
    if (!this.opened) { this.suspendedVideos.clear(); return; }
    this.resize();
    for (const [item, source] of this.suspendedVideos) {
      if ((item.currentSrc || item.src) === source && source) item.play().catch(() => {});
    }
    this.suspendedVideos.clear();
    this.ensureFrame();
  }
  ensureFrame() {
    if (!this.opened || !this.visible() || this.singleMode || this.frame || (!this.ambientMotion && !this.rotation)) return;
    const tick = time => {
      this.frame = 0;
      if (!this.opened || !this.visible()) return;
      const rotating = Boolean(this.rotation);
      if (this.rotation) {
        const { from, to, start, duration } = this.rotation;
        const progress = Math.min(1, (time - start) / duration);
        this.position = from + (to - from) * (1 - Math.pow(1 - progress, 3));
        if (progress === 1) { this.rotation = null; this.ring.dataset.animating = 'false'; }
      }
      if (rotating || !this.lastFrameDraw || time - this.lastFrameDraw >= 1000 / 30) {
        this.draw(time); this.lastFrameDraw = time;
      }
      this.ensureFrame();
    };
    this.frame = requestAnimationFrame(tick);
  }
  finish() {
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.rotation = null;
    this.position = this.targetColumn;
    this.ring.dataset.animating = 'false';
    this.draw();
    this.ensureFrame();
  }
  close() {
    for (const item of this.media) if (item.tagName === 'VIDEO') item.pause();
    this.suspendedVideos.clear();
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.rotation = null;
    this.wheelRemainder = 0;
    this.rowWheelRemainder = 0;
    this.singleMode = false;
    this.firstClick = null;
    this.updateMode();
    this.resetZoom(false);
    this.lastPointer = null;
    this.opened = false;
    this.parkMedia();
    this.ring.replaceChildren();
    this.cards.clear();
    this.activeId = null;
    this.ring.dataset.animating = 'false';
  }
}
window.ShituCylinderPreview = ShituCylinderPreview;
