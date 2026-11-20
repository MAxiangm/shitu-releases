(() => {
  'use strict';

  const names = { color: '彩色原图', displacement: '置换贴图', normal: '法线贴图', roughness: '粗糙度图', specular: '高光度图' };
  const toolNames = { brush: '笔刷', eraser: '橡皮擦', clone: '仿制图章', pen: '钢笔', rect: '矩形选框', ellipse: '椭圆选框', lasso: '自由套索' };
  const canvas = (width = 1, height = 1) => { const node = document.createElement('canvas'); node.width = width; node.height = height; return node; };
  const context = node => node.getContext('2d', { willReadFrequently: true });
  const copy = source => { const result = canvas(source.width, source.height); context(result).drawImage(source, 0, 0); return result; };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function create({ api, onSaved = () => {} } = {}) {
    const root = document.createElement('section');
    root.id = 'imageEditorOverlay'; root.className = 'ie-overlay'; root.hidden = true;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'imageEditorTitle');
    root.innerHTML = `<div class="ie-window">
      <header class="ie-header"><div><span class="ie-kicker">IMAGE STUDIO</span><h2 id="imageEditorTitle">图片编辑与贴图</h2></div><span id="imageEditorMeta" class="ie-meta"></span><button type="button" data-action="close" class="ie-close" aria-label="关闭图片编辑器">×</button></header>
      <div class="ie-nav"><div class="ie-tabs"><button type="button" data-mode="edit">图片编辑</button><button type="button" data-mode="maps">材质贴图 / 无缝</button></div><div class="ie-history"><button type="button" data-action="undo" title="Ctrl+Z">撤销</button><button type="button" data-action="redo" title="Ctrl+Shift+Z / Ctrl+Y">重做</button></div></div>
      <div class="ie-discard" hidden><span>当前更改尚未保存，是否放弃并关闭？</span><button type="button" data-action="continue">继续编辑</button><button type="button" data-action="discard">放弃更改并关闭</button></div>
      <div class="ie-body"><aside class="ie-sidebar">
        <div class="ie-edit-controls">
          <h3>绘画与选区</h3><div class="ie-tools">${Object.entries(toolNames).map(([value, text]) => `<button type="button" data-tool="${value}">${text}</button>`).join('')}</div>
          <section class="ie-control-section"><h3>笔刷设置</h3><label class="ie-field"><span>笔刷预设</span><select data-param="preset"><option value="round">圆形</option><option value="square">方形</option><option value="spray">喷点</option><option value="star">星形</option><option value="custom" disabled>自定义图案</option></select></label><label class="ie-upload">导入笔刷图案<input type="file" id="imageEditorBrushFile" accept="image/*"></label><p class="ie-help">透明图片作为笔尖；不透明图案按明暗提取形状。</p>
          <label class="ie-field"><span>颜色</span><input type="color" data-param="color" value="#ffffff"></label>
          <label class="ie-field"><span>大小 <output data-value="size"></output> px</span><input type="range" data-param="size" min="1" max="1000" step="1" value="48"></label>
          <label class="ie-field"><span>不透明度 <output data-value="opacity"></output>%</span><input type="range" data-param="opacity" min="0" max="100" step="1" value="100"></label>
          <label class="ie-field"><span>硬度 <output data-value="hardness"></output>%</span><input type="range" data-param="hardness" min="0" max="100" step="1" value="80"></label>
          <label class="ie-field"><span>间距 <output data-value="spacing"></output>%</span><input type="range" data-param="spacing" min="1" max="100" step="1" value="15"></label></section>
          <section class="ie-control-section ie-pen-controls"><h3>钢笔路径</h3><p class="ie-help">单击加节点，拖动拉出贝塞尔手柄。点击起点闭合；Backspace 删除末点。</p><div class="ie-button-grid"><button type="button" data-action="pen-close">闭合路径</button><button type="button" data-action="pen-stroke">描边</button><button type="button" data-action="pen-fill">填充</button><button type="button" data-action="pen-select">路径转选区</button><button type="button" data-action="pen-clear">清除路径</button></div></section>
          <section class="ie-control-section"><h3>选区设置</h3><label class="ie-field"><span>选择方式</span><select data-param="selectionMode"><option value="replace">新选区</option><option value="add">加选（Shift）</option><option value="subtract">减选（Alt）</option></select></label><label class="ie-field"><span>羽化半径</span><input type="number" data-param="feather" min="0" max="200" step="1" value="0"><span>px</span></label><p class="ie-help">羽化用于下一次新建的选区，笔刷、图章、橡皮与钢笔均受选区限制。</p><div class="ie-button-grid"><button type="button" data-action="select-all">全选</button><button type="button" data-action="clear-selection">取消选区</button><button type="button" data-action="invert-selection">反选</button><button type="button" data-action="clear-pixels">清除所选像素</button><button type="button" data-action="content-aware-fill" title="大图以最长边 768 像素分析纹理，填充结果仍保持原尺寸">智能填充</button><button type="button" data-action="cancel-fill" hidden>取消填充</button></div><p class="ie-help">智能填充根据周围纹理修补选区，适合去除小物体和补齐背景。</p></section>
        </div>
        <div class="ie-map-controls" hidden><h3>生成材质贴图</h3><label class="ie-field"><span>输出类型</span><select data-param="type">${Object.entries(names).map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></label><p class="ie-help">从当前编辑图像估算材质信息；参数变化实时预览，输出保持原始像素尺寸。</p>
          <label class="ie-field"><span>亮度 <output data-value="brightness"></output></span><input type="range" data-param="brightness" min="-1" max="1" step="0.01" value="0"></label>
          <label class="ie-field"><span>对比度 <output data-value="contrast"></output></span><input type="range" data-param="contrast" min="0.1" max="4" step="0.05" value="1"></label>
          <label class="ie-field"><span>伽马 <output data-value="gamma"></output></span><input type="range" data-param="gamma" min="0.1" max="4" step="0.05" value="1"></label>
          <label class="ie-field"><span>平滑 <output data-value="blur"></output> px</span><input type="range" data-param="blur" min="0" max="20" step="1" value="0"></label>
          <label class="ie-check"><input type="checkbox" data-param="invert">反转高度 / 灰度</label>
          <label class="ie-field ie-normal-param"><span>法线强度 <output data-value="strength"></output></span><input type="range" data-param="strength" min="0.1" max="20" step="0.1" value="3"></label>
          <label class="ie-check ie-normal-param"><input type="checkbox" data-param="flipY">翻转法线 Y（DirectX）</label>
          <section class="ie-control-section"><h3>四方连续</h3><label class="ie-check"><input type="checkbox" data-param="seamless">生成无缝平铺图像</label><label class="ie-field"><span>边缘融合 <output data-value="seamWidth"></output></span><input type="range" data-param="seamWidth" min="0.02" max="0.5" step="0.01" value="0.15"></label><p class="ie-help">融合四边使相邻边缘连续。用九宫格预览检查接缝与重复图案。</p></section>
          <button type="button" data-action="apply-map" class="ie-wide">将当前结果应用到编辑图像</button><p class="ie-help">应用后可继续局部修图，并支持撤销。</p>
        </div>
      </aside><main class="ie-main"><div class="ie-view-toolbar"><label class="ie-check"><input type="checkbox" data-view="original">原始参考</label><label class="ie-check"><input type="checkbox" data-view="tiled">3 × 3 平铺预览</label><button type="button" data-action="material-preview" hidden>材质球预览</button><select data-view="shape" aria-label="材质预览形状" hidden><option value="sphere">球体</option><option value="plane">平面</option></select><label class="ie-zoom">缩放 <select data-view="zoom"><option value="fit">适应</option><option value="0.25">25%</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option><option value="4">400%</option></select></label></div><div class="ie-stage" id="imageEditorStage"><div class="ie-canvas-wrap"><canvas id="imageEditorCanvas"></canvas><canvas id="imageEditorOverlayCanvas"></canvas><div class="ie-brush-cursor" hidden></div></div><div id="imageEditorMaterialPreview" class="ie-material-host" hidden></div><div class="ie-loading">正在读取图片…</div></div><div class="ie-status" id="imageEditorStatus" role="status" aria-live="polite"></div></main></div>
      <footer class="ie-footer"><span class="ie-hint">原图保留 · PNG 支持透明通道</span><button type="button" data-action="reset-map">重置贴图参数</button><button type="button" data-action="export">导出 PNG…</button><button type="button" data-action="save" class="ie-primary">保存副本到素材库</button></footer>
    </div>`;
    document.body.append(root);
    const $ = selector => root.querySelector(selector);
    const $$ = selector => [...root.querySelectorAll(selector)];
    const view = $('#imageEditorCanvas'), overlay = $('#imageEditorOverlayCanvas');
    const stage = $('#imageEditorStage'), wrap = $('.ie-canvas-wrap'), cursor = $('.ie-brush-cursor');
    const status = $('#imageEditorStatus'), loading = $('.ie-loading');
    const defaultParams = { size: 48, opacity: 100, hardness: 80, spacing: 15, color: '#ffffff', preset: 'round', selectionMode: 'replace', feather: 0, type: 'color', brightness: 0, contrast: 1, gamma: 1, blur: 0, strength: 3, invert: false, flipY: false, seamless: false, seamWidth: 0.15 };
    let params = { ...defaultParams }, session = null, generation = 0, previousFocus = null;
    let source = canvas(), original = canvas(), selection = null, selectionSnapshot = null, selectionHasPixels = false;
    let mode = 'edit', tool = 'brush', dirty = false, saving = false, history = [], future = [];
    let gesture = null, pen = [], penClosed = false, cloneAnchor = null, cloneOffset = null, cloneSource = null;
    let customBrush = null, stampCache = null, stampKey = '', previewCache = null, previewVersion = 0, documentVersion = 0;
    let updateTimer = 0, renderFrame = 0, fillController = null;
    let materialActive = false, materialViewer = null, materialPending = null, materialKey = '', materialSequence = 0;

    function message(value, error = false) { status.textContent = value; status.classList.toggle('ie-error', error); }
    function ready() { return Boolean(session?.ready && !saving); }
    function mapOptions() { return Object.fromEntries(['type', 'brightness', 'contrast', 'gamma', 'blur', 'strength', 'invert', 'flipY', 'seamless', 'seamWidth'].map(key => [key, params[key]])); }
    function controls() {
      $$('[data-mode]').forEach(node => { const active = node.dataset.mode === mode; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
      $$('[data-tool]').forEach(node => { const active = node.dataset.tool === tool; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
      $('.ie-edit-controls').hidden = mode !== 'edit'; $('.ie-map-controls').hidden = mode !== 'maps';
      $('.ie-pen-controls').hidden = tool !== 'pen';
      $$('.ie-normal-param').forEach(node => { node.hidden = params.type !== 'normal'; });
      $('[data-action="reset-map"]').hidden = mode !== 'maps';
      $('[data-action="material-preview"]').hidden = mode !== 'maps';
      $('[data-action="material-preview"]').disabled = !ready();
      $('[data-action="material-preview"]').textContent = materialActive ? '返回二维预览' : '材质球预览';
      $('[data-view="shape"]').hidden = !materialActive;
      $('[data-action="undo"]').disabled = !ready() || !history.length;
      $('[data-action="redo"]').disabled = !ready() || !future.length;
      $$('[data-action="save"], [data-action="export"], [data-action="apply-map"]').forEach(node => { node.disabled = !ready(); });
      $$('[data-param]').forEach(node => { const key = node.dataset.param; if (node.type === 'checkbox') node.checked = Boolean(params[key]); else node.value = String(params[key]); node.disabled = !ready(); });
      $$('[data-value]').forEach(node => { const value = params[node.dataset.value]; node.value = String(typeof value === 'number' ? Number(value.toFixed(2)) : value); });
      $$('[data-tool], [data-view]').forEach(node => { node.disabled = !ready() || (materialActive && node.dataset.view && node.dataset.view !== 'shape'); });
      $('[data-action="pen-close"]').disabled = !ready() || pen.length < 3;
      $('[data-action="pen-stroke"]').disabled = !ready() || pen.length < 2;
      $('[data-action="pen-fill"]').disabled = !ready() || pen.length < 3;
      $('[data-action="pen-select"]').disabled = !ready() || pen.length < 3;
      $('[data-action="content-aware-fill"]').disabled = !ready() || !selection || !selectionHasPixels;
      $('[data-action="cancel-fill"]').hidden = !fillController;
      cursor.hidden = true;
      root.classList.toggle('ie-busy', saving);
    }
    function disposeMaterial() {
      materialSequence += 1; materialActive = false; materialViewer?.dispose(); materialViewer = null; materialPending = null; materialKey = '';
      $('#imageEditorMaterialPreview').hidden = true; $('#imageEditorMaterialPreview').replaceChildren();
      wrap.hidden = !session?.ready;
    }
    async function renderMaterial() {
      if (!materialActive || mode !== 'maps' || !session?.ready) return;
      const token = materialSequence, current = session;
      try {
        if (!materialViewer) {
          if (materialPending) return;
          if (!window.ShituMaterialPreview?.create) throw new Error('材质预览组件不可用，请使用二维预览');
          materialPending = window.ShituMaterialPreview.create($('#imageEditorMaterialPreview'));
          const viewer = await materialPending;
          if (token !== materialSequence || current !== session || !materialActive) { viewer.dispose(); return; }
          materialPending = null; materialViewer = viewer;
        }
        const key = `${documentVersion}:${JSON.stringify(mapOptions())}`;
        materialViewer.setShape($('[data-view="shape"]').value);
        if (materialKey !== key) {
          const base = createPreviewBase();
          const options = mapOptions(), scale = base.width / source.width;
          options.blur *= scale; options.strength *= scale;
          await materialViewer.update(context(base).getImageData(0, 0, base.width, base.height), options);
          if (token !== materialSequence || current !== session || !materialActive) return;
          materialKey = key;
        }
        message('拖动旋转材质，滚轮缩放；切换平面可检查置换与平铺效果');
      } catch (error) {
        if (token !== materialSequence || current !== session) return;
        disposeMaterial(); controls(); scheduleRender(); message(error.message || String(error), true);
      }
    }
    function invalidate() { documentVersion += 1; previewCache = null; previewVersion += 1; scheduleRender(); }
    function markChanged() { dirty = true; invalidate(); controls(); }
    function snapshot() { return { image: context(source).getImageData(0, 0, source.width, source.height), mask: selectionSnapshot, dirty }; }
    function historyLimit() { return clamp(Math.floor(128 * 1024 * 1024 / (source.width * source.height * 8)), 1, 24); }
    function remember() { history.push(snapshot()); if (history.length > historyLimit()) history.shift(); future = []; }
    function setMask(data) {
      selectionSnapshot = data;
      selectionHasPixels = false;
      if (!data) { selection = null; return; }
      for (let at = 3; at < data.data.length; at += 4) if (data.data[at]) { selectionHasPixels = true; break; }
      selection = canvas(source.width, source.height); context(selection).putImageData(data, 0, 0);
    }
    function restore(item) { context(source).putImageData(item.image, 0, 0); setMask(item.mask); dirty = item.dirty; pen = []; penClosed = false; cloneOffset = null; invalidate(); controls(); }
    function undo() { if (!ready() || gesture || !history.length) return; future.push(snapshot()); restore(history.pop()); message('已撤销'); }
    function redo() { if (!ready() || gesture || !future.length) return; history.push(snapshot()); restore(future.pop()); message('已重做'); }
    function createPreviewBase() {
      const ratio = Math.min(1, 1024 / Math.max(source.width, source.height));
      const result = canvas(Math.max(1, Math.round(source.width * ratio)), Math.max(1, Math.round(source.height * ratio)));
      context(result).drawImage(source, 0, 0, result.width, result.height); return result;
    }
    function generated(full = false) {
      if (mode !== 'maps') return full ? source : createPreviewBase();
      const key = `${documentVersion}:${JSON.stringify(mapOptions())}`;
      if (!full && previewCache?.key === key) return previewCache.canvas;
      const base = full ? source : createPreviewBase(), options = mapOptions();
      // Blur is specified in source pixels, independent of the preview scale.
      if (!full) { options.blur *= base.width / source.width; options.strength *= base.width / source.width; }
      const result = window.ShituTextureMaps.generate(context(base).getImageData(0, 0, base.width, base.height), options);
      const output = canvas(result.width, result.height);
      context(output).putImageData(new ImageData(new Uint8ClampedArray(result.data), result.width, result.height), 0, 0);
      if (!full) previewCache = { key, canvas: output };
      return output;
    }
    function scheduleRender() { if (renderFrame || root.hidden) return; renderFrame = requestAnimationFrame(() => { renderFrame = 0; render(); }); }
    function render() {
      if (!session?.ready || root.hidden) return;
      if (materialActive) { void renderMaterial(); return; }
      try {
        let displayed = $('[data-view="original"]').checked ? original : generated();
        const tiled = $('[data-view="tiled"]').checked;
        const scale = Math.min(1, (tiled ? 512 : 1024) / Math.max(displayed.width, displayed.height));
        const w = Math.max(1, Math.round(displayed.width * scale)), h = Math.max(1, Math.round(displayed.height * scale));
        const width = w * (tiled ? 3 : 1), height = h * (tiled ? 3 : 1);
        if (view.width !== width || view.height !== height) { view.width = overlay.width = width; view.height = overlay.height = height; }
        const ctx = context(view); ctx.clearRect(0, 0, width, height);
        for (let y = 0; y < (tiled ? 3 : 1); y++) for (let x = 0; x < (tiled ? 3 : 1); x++) ctx.drawImage(displayed, x * w, y * h, w, h);
        const zoom = $('[data-view="zoom"]').value;
        const physicalWidth = source.width * (tiled ? 3 : 1), physicalHeight = source.height * (tiled ? 3 : 1);
        const fitting = Math.min((stage.clientWidth - 60) / physicalWidth, (stage.clientHeight - 60) / physicalHeight, 1);
        const factor = zoom === 'fit' ? Math.max(0.005, fitting) : Number(zoom);
        wrap.style.width = `${Math.max(1, physicalWidth * factor)}px`; wrap.style.height = `${Math.max(1, physicalHeight * factor)}px`;
        wrap.style.setProperty('--ie-grid', `${Math.max(4, 12 * factor)}px`);
        paintOverlay();
      } catch (error) { message(error.message || String(error), true); }
    }
    function editable() { return ready() && mode === 'edit' && !$('[data-view="original"]').checked && !$('[data-view="tiled"]').checked; }
    function point(event) { const bounds = overlay.getBoundingClientRect(); return { x: (event.clientX - bounds.left) * source.width / bounds.width, y: (event.clientY - bounds.top) * source.height / bounds.height }; }
    function tracePath(ctx, nodes = pen, closed = penClosed) {
      if (!nodes.length) return;
      ctx.moveTo(nodes[0].x, nodes[0].y);
      for (let index = 1; index < nodes.length + Number(closed); index++) {
        const previous = nodes[(index - 1) % nodes.length], next = nodes[index % nodes.length];
        ctx.bezierCurveTo(previous.x + previous.ox, previous.y + previous.oy, next.x + next.ix, next.y + next.iy, next.x, next.y);
      }
      if (closed) ctx.closePath();
    }
    function drawShape(ctx, current) {
      const p = current.start, q = current.last;
      ctx.beginPath();
      if (current.tool === 'rect') ctx.rect(Math.min(p.x, q.x), Math.min(p.y, q.y), Math.abs(p.x - q.x), Math.abs(p.y - q.y));
      else if (current.tool === 'ellipse') ctx.ellipse((p.x + q.x) / 2, (p.y + q.y) / 2, Math.abs(p.x - q.x) / 2, Math.abs(p.y - q.y) / 2, 0, 0, Math.PI * 2);
      else { ctx.moveTo(p.x, p.y); for (const next of current.points) ctx.lineTo(next.x, next.y); ctx.closePath(); }
    }
    function paintOverlay() {
      const ctx = context(overlay); ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (mode !== 'edit' || $('[data-view="original"]').checked || $('[data-view="tiled"]').checked) return;
      const scale = overlay.width / source.width;
      if (selection) {
        const temp = canvas(overlay.width, overlay.height), maskCtx = context(temp);
        maskCtx.drawImage(selection, 0, 0, temp.width, temp.height);
        maskCtx.globalCompositeOperation = 'source-in'; maskCtx.fillStyle = '#6ba7ff'; maskCtx.fillRect(0, 0, temp.width, temp.height);
        ctx.globalAlpha = 0.2; ctx.drawImage(temp, 0, 0); ctx.globalAlpha = 1;
        const pixels = maskCtx.getImageData(0, 0, temp.width, temp.height), out = ctx.createImageData(temp.width, temp.height);
        for (let y = 0; y < temp.height; y++) for (let x = 0; x < temp.width; x++) {
          const at = (y * temp.width + x) * 4, inside = pixels.data[at + 3] >= 128;
          if (inside && (x === 0 || y === 0 || x === temp.width - 1 || y === temp.height - 1 || pixels.data[at - 1] < 128 || pixels.data[at + 7] < 128 || pixels.data[at - temp.width * 4 + 3] < 128 || pixels.data[at + temp.width * 4 + 3] < 128)) {
            const color = (x + y) % 8 < 4 ? 255 : 20; out.data[at] = out.data[at + 1] = out.data[at + 2] = color; out.data[at + 3] = 255;
          }
        }
        const outline = canvas(temp.width, temp.height); context(outline).putImageData(out, 0, 0); ctx.drawImage(outline, 0, 0);
      }
      ctx.save(); ctx.scale(scale, scale); ctx.lineWidth = 1.5 / scale;
      if (gesture && ['rect', 'ellipse', 'lasso'].includes(gesture.tool)) {
        drawShape(ctx, gesture); ctx.strokeStyle = '#fff'; ctx.setLineDash([5 / scale, 5 / scale]); ctx.stroke(); ctx.lineDashOffset = 5 / scale; ctx.strokeStyle = '#111'; ctx.stroke(); ctx.setLineDash([]);
      }
      if (pen.length) {
        ctx.beginPath(); tracePath(ctx); ctx.strokeStyle = '#69a5ff'; ctx.stroke();
        for (const node of pen) {
          ctx.strokeStyle = '#a9ccff'; ctx.beginPath(); ctx.moveTo(node.x + node.ix, node.y + node.iy); ctx.lineTo(node.x, node.y); ctx.lineTo(node.x + node.ox, node.y + node.oy); ctx.stroke();
          for (const p of [{ x: node.x, y: node.y }, { x: node.x + node.ox, y: node.y + node.oy }, { x: node.x + node.ix, y: node.y + node.iy }]) { ctx.beginPath(); ctx.arc(p.x, p.y, 3 / scale, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#3672cc'; ctx.stroke(); }
        }
      }
      if (cloneAnchor) { ctx.strokeStyle = '#ffe078'; ctx.beginPath(); ctx.arc(cloneAnchor.x, cloneAnchor.y, 6 / scale, 0, Math.PI * 2); ctx.moveTo(cloneAnchor.x - 10 / scale, cloneAnchor.y); ctx.lineTo(cloneAnchor.x + 10 / scale, cloneAnchor.y); ctx.moveTo(cloneAnchor.x, cloneAnchor.y - 10 / scale); ctx.lineTo(cloneAnchor.x, cloneAnchor.y + 10 / scale); ctx.stroke(); }
      ctx.restore();
    }
    function makeStamp() {
      const key = `${params.size}:${params.color}:${params.opacity}:${params.hardness}:${params.preset}`;
      if (stampCache && stampKey === key) return stampCache;
      const size = Math.max(1, Math.ceil(params.size)), result = canvas(size, size), ctx = context(result), half = size / 2;
      ctx.fillStyle = params.color;
      if (params.preset === 'custom' && customBrush) ctx.drawImage(customBrush, 0, 0, size, size);
      else if (params.preset === 'square') ctx.fillRect(0, 0, size, size);
      else if (params.preset === 'spray') {
        let seed = 91827;
        const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
        for (let i = 0; i < 80; i++) { const angle = random() * Math.PI * 2, radius = Math.sqrt(random()) * half; ctx.beginPath(); ctx.arc(half + Math.cos(angle) * radius, half + Math.sin(angle) * radius, Math.max(0.55, size / 55), 0, Math.PI * 2); ctx.fill(); }
      } else if (params.preset === 'star') {
        ctx.beginPath(); for (let i = 0; i < 10; i++) { const angle = i * Math.PI / 5 - Math.PI / 2, radius = half * (i % 2 ? 0.43 : 1); const x = half + Math.cos(angle) * radius, y = half + Math.sin(angle) * radius; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } ctx.closePath(); ctx.fill();
      } else { ctx.beginPath(); ctx.arc(half, half, half, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = params.color; ctx.fillRect(0, 0, size, size);
      if (params.hardness < 100) {
        const fade = canvas(size, size), fadeCtx = context(fade), radial = fadeCtx.createRadialGradient(half, half, half * params.hardness / 100, half, half, half);
        radial.addColorStop(0, 'rgba(0,0,0,1)'); radial.addColorStop(1, 'rgba(0,0,0,0)'); fadeCtx.fillStyle = radial; fadeCtx.fillRect(0, 0, size, size);
        ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(fade, 0, 0);
      }
      ctx.globalCompositeOperation = 'destination-in'; ctx.fillStyle = `rgba(0,0,0,${params.opacity / 100})`; ctx.fillRect(0, 0, size, size);
      stampKey = key; stampCache = result; return result;
    }
    function stamp(p, paintingTool = tool) {
      const tip = makeStamp(), left = Math.round(p.x - tip.width / 2), top = Math.round(p.y - tip.height / 2);
      let patch = tip;
      if (selection || paintingTool === 'clone') {
        patch = canvas(tip.width, tip.height); const ctx = context(patch);
        if (paintingTool === 'clone') {
          if (!cloneSource || !cloneOffset) return;
          ctx.drawImage(cloneSource, cloneOffset.x - left, cloneOffset.y - top);
          ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(tip, 0, 0);
        } else ctx.drawImage(tip, 0, 0);
        if (selection) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selection, -left, -top); }
      }
      const ctx = context(source); ctx.save(); if (paintingTool === 'eraser') ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(patch, left, top); ctx.restore();
    }
    function paintLine(from, to, paintingTool = tool, phase = 0) {
      const distance = Math.hypot(to.x - from.x, to.y - from.y), step = Math.max(0.5, params.size * params.spacing / 100);
      if (!distance) return phase;
      let along = step - phase;
      for (; along <= distance; along += step) stamp({ x: from.x + (to.x - from.x) * along / distance, y: from.y + (to.y - from.y) * along / distance }, paintingTool);
      return (phase + distance) % step;
    }
    function combineSelection(shape, operation) {
      const feather = clamp(Number(params.feather) || 0, 0, 200);
      if (feather) { const blurred = canvas(source.width, source.height); const ctx = context(blurred); ctx.filter = `blur(${feather}px)`; ctx.drawImage(shape, 0, 0); shape = blurred; }
      const incoming = context(shape).getImageData(0, 0, source.width, source.height), previous = selectionSnapshot;
      for (let at = 0; at < incoming.data.length; at += 4) {
        const old = previous ? previous.data[at + 3] : operation === 'subtract' ? 255 : 0;
        const added = incoming.data[at + 3];
        incoming.data[at] = incoming.data[at + 1] = incoming.data[at + 2] = 255;
        incoming.data[at + 3] = operation === 'add' ? Math.max(old, added) : operation === 'subtract' ? Math.round(old * (1 - added / 255)) : added;
      }
      remember(); setMask(incoming); controls(); paintOverlay(); message('选区已更新；绘画仅作用于选区内');
    }
    function endGesture(event, cancelled = false) {
      if (!gesture) return;
      const current = gesture; gesture = null;
      try { if (overlay.hasPointerCapture(current.id)) overlay.releasePointerCapture(current.id); } catch {}
      if (['rect', 'ellipse', 'lasso'].includes(current.tool)) {
        if (!cancelled && (Math.hypot(current.last.x - current.start.x, current.last.y - current.start.y) > 1 || current.points.length > 2)) {
          const shape = canvas(source.width, source.height), ctx = context(shape); drawShape(ctx, current); ctx.fillStyle = '#fff'; ctx.fill(); combineSelection(shape, current.operation);
        }
      } else if (current.tool === 'pen') { controls(); }
      else {
        if (cancelled && history.length) { restore(history.pop()); future = []; }
        else markChanged();
        cloneSource = null;
      }
      paintOverlay();
    }
    overlay.addEventListener('pointerdown', event => {
      if (!editable() || event.button !== 0 || gesture) return;
      event.preventDefault(); overlay.focus(); const p = point(event);
      if (tool === 'clone' && event.altKey) { cloneAnchor = p; cloneOffset = null; message('已设置取样点。松开 Alt 后在目标位置涂抹'); paintOverlay(); return; }
      const current = { id: event.pointerId, tool, start: p, last: p, points: [p], phase: 0 };
      if (['rect', 'ellipse', 'lasso'].includes(tool)) current.operation = event.altKey ? 'subtract' : event.shiftKey ? 'add' : params.selectionMode;
      else if (tool === 'pen') {
        const scale = overlay.getBoundingClientRect().width / source.width;
        if (pen.length >= 3 && Math.hypot(p.x - pen[0].x, p.y - pen[0].y) * scale < 10) { penClosed = true; controls(); paintOverlay(); message('路径已闭合，可描边、填充或转选区'); return; }
        if (penClosed) { pen = []; penClosed = false; }
        pen.push({ ...p, ix: 0, iy: 0, ox: 0, oy: 0 }); current.node = pen.at(-1);
      } else {
        if (tool === 'clone') {
          if (!cloneAnchor) { message('先按住 Alt 单击图片，设置仿制取样点'); return; }
          if (!cloneOffset) cloneOffset = { x: p.x - cloneAnchor.x, y: p.y - cloneAnchor.y };
          cloneSource = copy(source);
        }
        remember(); stamp(p); markChanged();
      }
      gesture = current; overlay.setPointerCapture(event.pointerId); paintOverlay();
    });
    overlay.addEventListener('pointermove', event => {
      if (editable() && ['brush', 'eraser', 'clone'].includes(tool)) {
        const bounds = overlay.getBoundingClientRect(), size = params.size * bounds.width / source.width;
        cursor.hidden = false; cursor.style.width = cursor.style.height = `${size}px`; cursor.style.left = `${event.clientX - bounds.left}px`; cursor.style.top = `${event.clientY - bounds.top}px`;
      } else cursor.hidden = true;
      if (!gesture || gesture.id !== event.pointerId) return;
      const p = point(event), current = gesture;
      if (current.tool === 'pen') { current.node.ox = p.x - current.node.x; current.node.oy = p.y - current.node.y; current.node.ix = -current.node.ox; current.node.iy = -current.node.oy; }
      else if (['rect', 'ellipse', 'lasso'].includes(current.tool)) { current.last = p; if (current.tool === 'lasso') current.points.push(p); }
      else { current.phase = paintLine(current.last, p, current.tool, current.phase); current.last = p; invalidate(); }
      if (['rect', 'ellipse', 'lasso', 'pen'].includes(current.tool)) paintOverlay();
    });
    overlay.addEventListener('pointerup', event => { if (gesture?.id === event.pointerId) endGesture(event); });
    overlay.addEventListener('pointercancel', event => { if (gesture?.id === event.pointerId) endGesture(event, true); });
    overlay.addEventListener('lostpointercapture', event => { if (gesture?.id === event.pointerId) endGesture(event, true); });
    overlay.addEventListener('pointerleave', () => { cursor.hidden = true; });
    overlay.tabIndex = 0;
    overlay.addEventListener('contextmenu', event => event.preventDefault());

    function selectOperation(action) {
      if (!ready() || gesture) return;
      if (action === 'clear-pixels') {
        remember(); const ctx = context(source);
        if (selection) { ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(selection, 0, 0); ctx.restore(); }
        else ctx.clearRect(0, 0, source.width, source.height);
        markChanged(); message('已清除所选像素'); return;
      }
      remember();
      if (action === 'clear-selection') setMask(null);
      else {
        const data = context(source).createImageData(source.width, source.height);
        for (let at = 0; at < data.data.length; at += 4) { data.data[at] = data.data[at + 1] = data.data[at + 2] = 255; data.data[at + 3] = action === 'select-all' ? 255 : 255 - (selectionSnapshot?.data[at + 3] ?? 255); }
        setMask(data);
      }
      controls(); paintOverlay(); message(action === 'clear-selection' ? '已取消选区' : action === 'select-all' ? '已选择全部像素' : '已反选');
    }
    function penAction(action) {
      if (!ready() || gesture) return;
      if (action === 'pen-clear') { pen = []; penClosed = false; controls(); paintOverlay(); return; }
      if (action === 'pen-close') { if (pen.length >= 3) penClosed = true; controls(); paintOverlay(); return; }
      if (pen.length < (action === 'pen-stroke' ? 2 : 3)) return;
      if (action === 'pen-select') {
        const shape = canvas(source.width, source.height), ctx = context(shape); ctx.beginPath(); tracePath(ctx, pen, true); ctx.fillStyle = '#fff'; ctx.fill(); combineSelection(shape, params.selectionMode); return;
      }
      remember();
      if (action === 'pen-fill') {
        const layer = canvas(source.width, source.height), ctx = context(layer); ctx.beginPath(); tracePath(ctx, pen, true); ctx.fillStyle = params.color; ctx.globalAlpha = params.opacity / 100; ctx.fill(); ctx.globalAlpha = 1;
        if (selection) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selection, 0, 0); }
        context(source).drawImage(layer, 0, 0);
      } else {
        let phase = 0;
        for (let i = 1; i < pen.length + Number(penClosed); i++) {
          const a = pen[(i - 1) % pen.length], b = pen[i % pen.length];
          let previous = { x: a.x, y: a.y }; if (i === 1) stamp(previous, 'brush');
          const length = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(a.ox, a.oy) + Math.hypot(b.ix, b.iy), steps = clamp(Math.ceil(length / 2), 16, 8192);
          for (let j = 1; j <= steps; j++) { const t = j / steps, u = 1 - t; const p = { x: u ** 3 * a.x + 3 * u ** 2 * t * (a.x + a.ox) + 3 * u * t ** 2 * (b.x + b.ix) + t ** 3 * b.x, y: u ** 3 * a.y + 3 * u ** 2 * t * (a.y + a.oy) + 3 * u * t ** 2 * (b.y + b.iy) + t ** 3 * b.y }; phase = paintLine(previous, p, 'brush', phase); previous = p; }
        }
      }
      pen = []; penClosed = false; markChanged(); message(action === 'pen-fill' ? '已填充路径' : '已描边路径');
    }
    function setMode(value) {
      if (!ready() || gesture) return;
      if (value !== 'maps') disposeMaterial();
      mode = value; $('.ie-discard').hidden = true; controls(); scheduleRender();
      message(value === 'maps' ? '调节参数预览贴图；勾选九宫格检查四边连续效果' : tool === 'clone' ? 'Alt + 单击设置取样点，然后涂抹' : '选择工具后在图片上操作');
    }
    function resetMaps() { for (const key of Object.keys(mapOptions())) params[key] = defaultParams[key]; previewCache = null; controls(); scheduleRender(); }
    async function blobBytes(output) { const blob = await new Promise((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('PNG 编码失败')), 'image/png')); return new Uint8Array(await blob.arrayBuffer()); }
    async function save(exporting) {
      if (!ready() || gesture) return;
      const current = session, token = generation;
      saving = true; controls(); message('正在生成全尺寸 PNG…');
      try {
        // Let the busy label paint before full-resolution processing.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (session !== current || generation !== token) return;
        const bytes = await blobBytes(generated(true));
        const suffix = mode === 'maps' ? `${params.seamless ? '无缝 · ' : ''}${names[params.type]}` : '编辑';
        const request = { assetId: current.asset.id, libraryRoot: current.root, bytes, suffix };
        const result = exporting ? await api.exportEditedImage(request) : await api.saveEditedImage(request);
        if (session !== current || generation !== token) return;
        if (result?.canceled || result?.cancelled) { message('已取消导出'); return; }
        dirty = false;
        $('.ie-discard').hidden = true;
        if (!exporting) await onSaved(result);
        message(exporting ? 'PNG 已导出' : result?.duplicate ? '相同内容已存在于素材库' : '副本已保存到素材库');
      } catch (error) { if (session === current && generation === token) message(error.message || String(error), true); }
      finally { if (session === current && generation === token) { saving = false; controls(); } }
    }
    async function applyMap() {
      if (!ready() || gesture) return;
      saving = true; controls(); message('正在应用全尺寸结果…');
      const current = session, token = generation;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      try {
        if (session !== current || generation !== token) return;
        const output = generated(true); remember(); context(source).clearRect(0, 0, source.width, source.height); context(source).drawImage(output, 0, 0);
        resetMaps(); disposeMaterial(); mode = 'edit'; markChanged(); message('结果已应用，可继续绘画；Ctrl+Z 撤销');
      } catch (error) { message(error.message || String(error), true); }
      finally { if (session === current && generation === token) { saving = false; controls(); scheduleRender(); } }
    }
    async function contentAwareFill() {
      if (!ready() || !selection || !selectionHasPixels || gesture) return;
      const current = session, token = generation, controller = new AbortController();
      fillController = controller; saving = true; controls(); message('正在根据周围纹理填充…');
      try {
        const input = context(source).getImageData(0, 0, source.width, source.height), mask = new Uint8Array(source.width * source.height);
        for (let i = 0; i < mask.length; i++) mask[i] = selectionSnapshot.data[i * 4 + 3];
        const result = await window.ShituContentAwareFill.fill(input, mask, {
          signal: controller.signal,
          onProgress: progress => { if (session === current && generation === token) message(`正在根据周围纹理填充… ${Math.round(progress * 100)}%`); }
        });
        if (session !== current || generation !== token || controller.signal.aborted) return;
        remember(); context(source).putImageData(new ImageData(new Uint8ClampedArray(result.data), result.width, result.height), 0, 0);
        markChanged(); message('智能填充完成；可继续修图或撤销');
      } catch (error) {
        if (session === current && generation === token) message(controller.signal.aborted ? '已取消智能填充，图像未改变' : error.message || String(error), !controller.signal.aborted);
      } finally {
        if (session === current && generation === token) { fillController = null; saving = false; controls(); scheduleRender(); }
      }
    }
    async function readImage(bytes) {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      try { const image = new Image(); image.src = url; await image.decode(); return image; }
      finally { URL.revokeObjectURL(url); }
    }
    async function open(asset, libraryRoot, initialTab = 'edit') {
      if (!root.hidden) { if (dirty) { $('.ie-discard').hidden = false; message('请先保存或放弃当前图片的更改'); return false; } if (saving) return false; }
      generation += 1; const token = generation;
      disposeMaterial();
      clearTimeout(updateTimer); cancelAnimationFrame(renderFrame); renderFrame = 0;
      if (root.hidden) previousFocus = document.activeElement;
      session = { asset, root: libraryRoot, ready: false }; const current = session;
      params = { ...defaultParams }; mode = initialTab === 'maps' ? 'maps' : 'edit'; tool = 'brush'; dirty = false; saving = false;
      history = []; future = []; gesture = null; pen = []; penClosed = false; selection = selectionSnapshot = null; selectionHasPixels = false; cloneAnchor = cloneOffset = cloneSource = null;
      source = canvas(); original = canvas(); previewCache = null; documentVersion = 0; stampCache = null;
      customBrush = null; const customOption = $('[data-param="preset"] option[value="custom"]'); customOption.disabled = true;
      $('[data-view="original"]').checked = false; $('[data-view="tiled"]').checked = false; $('[data-view="zoom"]').value = 'fit';
      $('.ie-discard').hidden = true; root.hidden = false; loading.hidden = false; wrap.hidden = true;
      $('#imageEditorMeta').textContent = asset.name || '未命名图片'; message('正在读取图片…'); controls(); $('[data-action="close"]').focus();
      try {
        const result = await api.readImageForEditor(asset.id, libraryRoot);
        const image = await readImage(result.bytes);
        if (session !== current || generation !== token) return false;
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16_777_216) throw new Error('图片超过编辑器 1677 万像素上限，请先缩小图片');
        source = canvas(image.naturalWidth, image.naturalHeight); context(source).drawImage(image, 0, 0); original = copy(source);
        current.ready = true; wrap.hidden = false; loading.hidden = true;
        $('#imageEditorMeta').textContent = `${asset.name || '未命名图片'} · ${source.width} × ${source.height}`;
        controls(); scheduleRender(); message(mode === 'maps' ? '选择贴图类型并调节参数，可预览后保存副本' : '选择工具开始编辑；仿制图章使用 Alt + 单击取样'); return true;
      } catch (error) {
        if (session !== current || generation !== token) return false;
        loading.hidden = true; message(error.message || String(error), true); controls(); return false;
      }
    }
    function close(force = false) {
      if (root.hidden) return true;
      if (saving && !force) { message(fillController ? '正在智能填充，可先取消填充' : '正在保存，请稍候'); return false; }
      if (dirty && !force) { $('.ie-discard').hidden = false; $('[data-action="continue"]').focus(); return false; }
      if (gesture) endGesture(null, true);
      fillController?.abort(); fillController = null; saving = false;
      disposeMaterial();
      generation += 1; session = null; root.hidden = true; clearTimeout(updateTimer); cancelAnimationFrame(renderFrame); renderFrame = 0;
      history = []; future = []; source = canvas(); original = canvas(); selection = selectionSnapshot = null; selectionHasPixels = false; previewCache = stampCache = customBrush = cloneSource = null;
      view.width = view.height = overlay.width = overlay.height = 1;
      previousFocus?.isConnected && previousFocus.focus({ preventScroll: true }); previousFocus = null; return true;
    }
    function canCloseApp() {
      if (root.hidden || (!dirty && !saving)) return true;
      if (dirty && !saving) $('.ie-discard').hidden = false;
      message(saving ? '请等待保存完成，或取消智能填充后再关闭应用' : '请先保存或放弃更改，再关闭应用');
      return false;
    }
    root.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.mode) { setMode(button.dataset.mode); return; }
      if (button.dataset.tool) { if (gesture) endGesture(null, true); tool = button.dataset.tool; controls(); paintOverlay(); message(tool === 'clone' ? 'Alt + 单击设置取样点，然后涂抹；再次取样可改变源位置' : tool === 'pen' ? '单击建立路径节点，按住拖动拉出曲线手柄' : toolNames[tool]); return; }
      const action = button.dataset.action;
      if (action?.startsWith('pen-')) { penAction(action); return; }
      if (['select-all', 'clear-selection', 'invert-selection', 'clear-pixels'].includes(action)) { selectOperation(action); return; }
      if (action === 'undo') undo(); else if (action === 'redo') redo(); else if (action === 'close') close();
      else if (action === 'discard') close(true); else if (action === 'continue') $('.ie-discard').hidden = true;
      else if (action === 'save') void save(false); else if (action === 'export') void save(true); else if (action === 'apply-map') void applyMap();
      else if (action === 'content-aware-fill') void contentAwareFill(); else if (action === 'cancel-fill') fillController?.abort();
      else if (action === 'material-preview') {
        if (!ready()) return;
        if (materialActive) disposeMaterial();
        else { materialActive = true; wrap.hidden = true; $('#imageEditorMaterialPreview').hidden = false; }
        controls(); scheduleRender();
      }
      else if (action === 'reset-map') { resetMaps(); dirty = true; message('已重置贴图参数'); }
    });
    root.addEventListener('input', event => {
      const key = event.target.dataset.param; if (!key || !ready()) return;
      params[key] = event.target.type === 'checkbox' ? event.target.checked : ['color', 'preset', 'type', 'selectionMode'].includes(key) ? event.target.value : Number(event.target.value);
      if (key === 'feather') params.feather = clamp(params.feather, 0, 200);
      if (key in mapOptions()) { dirty = true; previewCache = null; clearTimeout(updateTimer); updateTimer = setTimeout(scheduleRender, 75); }
      controls();
    });
    $$('[data-view]').forEach(node => node.addEventListener('change', () => { cursor.hidden = true; scheduleRender(); }));
    $('#imageEditorBrushFile').addEventListener('change', async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file || !ready()) return;
      if (file.size > 20 * 1024 * 1024) { message('笔刷图片不应超过 20 MB', true); return; }
      const current = session, token = generation;
      try {
        const image = await readImage(await file.arrayBuffer()); if (session !== current || token !== generation) return;
        const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight)), bitmap = canvas(Math.max(1, Math.round(image.naturalWidth * scale)), Math.max(1, Math.round(image.naturalHeight * scale)));
        context(bitmap).drawImage(image, 0, 0, bitmap.width, bitmap.height);
        const data = context(bitmap).getImageData(0, 0, bitmap.width, bitmap.height); let transparency = false;
        for (let at = 3; at < data.data.length; at += 4) if (data.data[at] < 250) { transparency = true; break; }
        if (!transparency) {
          for (let at = 0; at < data.data.length; at += 4) data.data[at + 3] = 255 - Math.round(data.data[at] * 0.2126 + data.data[at + 1] * 0.7152 + data.data[at + 2] * 0.0722);
          context(bitmap).putImageData(data, 0, 0);
        }
        const side = Math.max(bitmap.width, bitmap.height); customBrush = canvas(side, side); context(customBrush).drawImage(bitmap, (side - bitmap.width) / 2, (side - bitmap.height) / 2);
        $('[data-param="preset"] option[value="custom"]').disabled = false; params.preset = 'custom'; stampCache = null; controls(); message(`已载入自定义笔刷：${file.name}`);
      } catch (error) { if (session === current && token === generation) message(error.message || '无法读取笔刷图片', true); }
    });
    const resizeObserver = new ResizeObserver(scheduleRender); resizeObserver.observe(stage);
    window.addEventListener('beforeunload', event => {
      if (canCloseApp()) return;
      event.preventDefault(); event.returnValue = false;
    });
    document.addEventListener('keydown', event => {
      if (root.hidden) return;
      if (event.key === 'Tab') {
        const focusable = $$('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]').filter(node => node.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
      const typing = event.target.matches('input:not([type="range"]):not([type="checkbox"]):not([type="color"]), textarea, select');
      if (event.key === 'Escape') { event.preventDefault(); if (gesture) endGesture(null, true); else if (pen.length) { pen = []; penClosed = false; controls(); paintOverlay(); } else close(); }
      else if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
      else if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selectOperation('select-all'); }
      else if (!typing && event.key === 'Backspace' && tool === 'pen' && pen.length) { event.preventDefault(); pen.pop(); penClosed = false; controls(); paintOverlay(); }
      else if (!typing && event.key === 'Delete' && editable()) { event.preventDefault(); selectOperation('clear-pixels'); }
      else if (!typing && ['b', 'e', 's', 'p', 'm', 'l'].includes(event.key.toLowerCase()) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        tool = { b: 'brush', e: 'eraser', s: 'clone', p: 'pen', m: 'rect', l: 'lasso' }[event.key.toLowerCase()]; controls(); paintOverlay();
      }
      // Isolate editor shortcuts from the library underneath this dialog.
      event.stopImmediatePropagation();
    }, true);
    return { open, close, canCloseApp, isOpen: () => !root.hidden };
  }
  window.ShituImageEditor = Object.freeze({ create });
})();
