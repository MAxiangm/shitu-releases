(() => {
  'use strict';

  const names = { color: '彩色原图', displacement: '置换贴图', normal: '法线贴图', roughness: '粗糙度图', specular: '高光度图' };
  const toolNames = { move: '移动图层', crop: '裁剪', rect: '矩形选框', ellipse: '椭圆选框', lasso: '自由套索', brush: '笔刷', eraser: '橡皮擦', clone: '仿制图章', pen: '钢笔', text: '文字', shape: '形状', eyedropper: '吸管取色', hand: '抓手', zoom: '缩放' };
  const toolKeys = { move: 'V', crop: 'C', rect: 'M', ellipse: 'Shift+M', lasso: 'L', brush: 'B', eraser: 'E', clone: 'S', pen: 'P', text: 'T', shape: 'U', eyedropper: 'I', hand: 'H', zoom: 'Z' };
  const iconPaths = {
    crop: '<path d="M6 2v16h16M2 6h16v16M9 6h9v9"/>',
    text: '<path d="M4 6V3h16v3M12 3v18M8 21h8"/>',
    shape: '<rect x="3" y="3" width="13" height="13" rx="1"/><circle cx="16" cy="16" r="6"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
    swap: '<path d="M4 7h16l-4-4m4 14H4l4 4"/>',
    move: '<path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    hidden: '<path d="m3 3 18 18M9 5c7-2 13 7 13 7s-1 2-3 4M6 7c-3 2-4 5-4 5s4 7 10 7c2 0 3-.5 4-1M10 10a3 3 0 0 0 4 4"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0M12 14v3"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    duplicate: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    up: '<path d="m5 14 7-7 7 7"/>', down: '<path d="m5 10 7 7 7-7"/>',
    rect: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 3"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8" ry="7" stroke-dasharray="3 3"/>',
    lasso: '<path d="M8 17c-4-1-5-3-5-6 0-4 4-7 9-7s9 3 9 7-4 7-9 7c-3 0-5-1-5-3s3-3 4-1c2 4-1 7-4 7"/>',
    brush: '<path d="m9 14 9-11 3 3-11 9M9 14c-3-1-5 1-5 3 0 2-2 3-2 3s6 2 8-2c1-2 0-3-1-4Z"/>',
    eraser: '<path d="m4 13 9-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-9 9H8l-4-4a2 2 0 0 1 0-3Zm4-4 9 8M12 20h9"/>',
    clone: '<path d="M5 17h14l1 4H4l1-4Zm3-3h8v3H8zM10 14V9a4 4 0 1 1 4 0v5"/>',
    pen: '<path d="m3 21 5-15 9-3 4 4-3 9L3 21Zm0 0 9-9M8 6l10 10"/><circle cx="13" cy="11" r="2"/>',
    eyedropper: '<path d="m14 4 6 6M16 6l3-3a2 2 0 0 1 3 3l-3 3M16 7 4 19l-1 3 3-1L18 9M7 16l3 3"/>',
    hand: '<path d="M8 12V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v10c0 5-3 7-7 7-3 0-5-2-7-5l-3-4c-1-2 1-4 3-2l2 2"/>',
    zoom: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6M10 7v6"/>',
    undo: '<path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12"/>',
    redo: '<path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
    maps: '<path d="m12 2 10 6-10 6L2 8l10-6Zm-10 10 10 6 10-6M2 16l10 6 10-6"/>',
    minus: '<path d="M5 12h14"/>', plus: '<path d="M5 12h14M12 5v14"/>',
    fit: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
    reset: '<path d="M5 8a8 8 0 1 1-1 7M3 3v6h6"/>',
    export: '<path d="M12 15V3m-4 4 4-4 4 4M4 14v7h16v-7"/>',
    save: '<path d="M4 3h13l4 4v14H3V3h1Zm3 0v7h10V3M7 21v-7h10v7"/>'
  };
  const icon = name => `<svg class="ie-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.image}</svg>`;
  const toolButton = value => `<button type="button" class="ie-tool-button" data-tool="${value}" aria-label="${toolNames[value]}（${toolKeys[value]}）" title="${toolNames[value]}（${toolKeys[value]}）" data-tooltip="${toolNames[value]} · ${toolKeys[value]}">${icon(value)}</button>`;
  const canvas = (width = 1, height = 1) => { const node = document.createElement('canvas'); node.width = width; node.height = height; return node; };
  const context = node => node.getContext('2d', { willReadFrequently: true });
  const copy = source => { const result = canvas(source.width, source.height); context(result).drawImage(source, 0, 0); return result; };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const shortcutGroups = [
    ['基础编辑', [['裁剪 / 文字 / 形状', 'C / T / U'], ['切换形状类型', 'Shift+U'], ['确认 / 取消裁剪', 'Enter / Esc'], ['导出分层 PSD', 'Ctrl+Alt+Shift+S']]],
    ['工具与视图', [['移动 / 选框 / 套索', 'V / M / L'], ['笔刷 / 橡皮 / 图章 / 钢笔', 'B / E / S / P'], ['取色 / 抓手 / 缩放', 'I / H / Z'], ['循环矩形与椭圆选框', 'Shift+M'], ['临时抓手 / 笔刷临时取色', '空格 / Alt+单击'], ['放大 / 缩小', 'Ctrl++ / Ctrl+-'], ['适应 / 实际大小', 'Ctrl+0 / Ctrl+1'], ['显示 / 隐藏工具面板', 'Tab（画布中）'], ['显示 / 隐藏图层面板', 'F7']]],
    ['选区与编辑', [['全选 / 取消选区', 'Ctrl+A / Ctrl+D'], ['重新选择 / 反选', 'Ctrl+Shift+D / Ctrl+Shift+I'], ['撤销 / 重做', 'Ctrl+Z / Ctrl+Shift+Z'], ['连续向后撤销', 'Ctrl+Alt+Z'], ['删除所选像素', 'Delete / Backspace'], ['钢笔路径转为选区', 'Ctrl+Enter'], ['保存副本 / 导出 PNG', 'Ctrl+S / Ctrl+Shift+S'], ['关闭编辑器', 'Ctrl+W']]],
    ['图层', [['新建透明图层并命名', 'Ctrl+Shift+N'], ['直接新建透明图层', 'Ctrl+Alt+Shift+N'], ['选区复制 / 整层复制', 'Ctrl+J'], ['选区剪切到新图层', 'Ctrl+Shift+J'], ['图层上移 / 下移', 'Ctrl+] / Ctrl+['], ['置顶 / 置底', 'Ctrl+Shift+] / Ctrl+Shift+['], ['选择上层 / 下层', 'Alt+] / Alt+['], ['移动图层 / 大步移动', '方向键 / Shift+方向键（V）'], ['打开图层变换', 'Ctrl+T']]],
    ['颜色与笔刷', [['前景黑色、背景白色 / 互换', 'D / X'], ['前景填充 / 背景填充', 'Alt+Backspace / Ctrl+Backspace'], ['减小 / 增大笔刷', '[ / ]'], ['减小 / 增大硬度', 'Shift+[ / Shift+]'], ['不透明度 10%–90% / 100%', '1–9 / 0'], ['精确不透明度', '快速输入两位数字'], ['查看快捷键', '? / Ctrl+Alt+Shift+K']]]
  ];

  function create({ api, onSaved = () => {} } = {}) {
    const root = document.createElement('section');
    root.id = 'imageEditorOverlay'; root.className = 'ie-overlay'; root.hidden = true;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'imageEditorTitle');
    root.innerHTML = `<div class="ie-window">
      <header class="ie-header"><div><span class="ie-kicker">IMAGE STUDIO</span><h2 id="imageEditorTitle">图片编辑与贴图</h2></div><span id="imageEditorMeta" class="ie-meta"></span><button type="button" data-action="close" class="ie-close" aria-label="关闭图片编辑器">${icon('close')}</button></header>
      <div class="ie-nav"><div class="ie-tabs"><button type="button" data-mode="edit">${icon('image')}<span>图片编辑</span></button><button type="button" data-mode="maps">${icon('maps')}<span>材质贴图 / 无缝</span></button></div><div class="ie-history"><button type="button" class="ie-shortcut-trigger" data-action="shortcuts" title="快捷键 · ?">${icon('keyboard')}<span>快捷键</span></button><button type="button" class="ie-icon-button" data-action="undo" title="撤销 · Ctrl+Z / Ctrl+Alt+Z" aria-label="撤销（Ctrl+Z）">${icon('undo')}</button><button type="button" class="ie-icon-button" data-action="redo" title="重做 · Ctrl+Shift+Z" aria-label="重做（Ctrl+Shift+Z）">${icon('redo')}</button></div></div>
      <div class="ie-options" role="region" aria-label="当前工具选项">
        <div class="ie-active-tool"><span class="ie-active-tool-icon">${icon('brush')}</span><span class="ie-active-tool-name">笔刷</span></div>
        <div class="ie-option-group" data-options="paint"><label>大小 <input type="number" aria-label="笔刷大小" data-param="size" min="1" max="1000" value="48"> px</label><label>不透明度 <input type="number" aria-label="笔刷不透明度" data-param="opacity" min="0" max="100" value="100"> %</label><label>硬度 <input type="number" aria-label="笔刷硬度" data-param="hardness" min="0" max="100" value="80"> %</label></div>
        <div class="ie-option-group" data-options="selection" hidden><label>模式 <select data-param="selectionMode" aria-label="选区模式"><option value="replace">新选区</option><option value="add">加选（Shift）</option><option value="subtract">减选（Alt）</option></select></label><label>羽化 <input type="number" aria-label="选区羽化" data-param="feather" min="0" max="200" value="0"> px</label><span class="ie-option-tip">单击选区外取消</span></div>
        <div class="ie-option-group" data-options="navigation" hidden><span class="ie-option-tip">拖动平移画布 · 单击放大，Alt + 单击缩小</span></div>
        <div class="ie-option-group" data-options="eyedropper" hidden><span class="ie-option-tip">单击图像采集前景色，再按 B 使用笔刷</span></div>
        <div class="ie-option-group" data-options="move" hidden><span class="ie-option-tip">拖动当前图层 · Shift 约束方向 · 右侧可调整缩放和旋转</span></div>
        <div class="ie-option-group" data-options="crop" hidden><span class="ie-option-tip">拖出裁剪范围，Enter 确认，Esc 取消</span><button type="button" data-action="crop-apply">应用裁剪</button><button type="button" data-action="crop-cancel">取消</button></div>
        <div class="ie-option-group" data-options="text" hidden><span class="ie-option-tip">在右侧输入文字，单击画布放置为独立图层</span></div>
        <div class="ie-option-group" data-options="shape" hidden><span class="ie-option-tip">拖动绘制形状 · Shift 约束比例或方向</span></div>
        <div class="ie-option-group" data-options="maps" hidden><span class="ie-option-tip">调整右侧属性，实时预览材质与无缝平铺</span></div>
        <span class="ie-options-shortcut">空格：抓手 · [ / ]：笔刷大小</span>
      </div>
      <div class="ie-discard" hidden><span>当前更改尚未保存，是否放弃并关闭？</span><button type="button" data-action="continue">继续编辑</button><button type="button" data-action="discard">放弃更改并关闭</button></div>
      <div class="ie-body"><nav class="ie-toolrail" aria-label="图片编辑工具">
        ${[['move', 'crop', 'rect', 'ellipse', 'lasso'], ['brush', 'eraser', 'clone'], ['pen', 'text', 'shape', 'eyedropper'], ['hand', 'zoom']].map(group => `<div class="ie-tool-group">${group.map(toolButton).join('')}</div>`).join('')}
        <div class="ie-rail-color"><div class="ie-color-pair"><input type="color" data-param="color" value="#ffffff" aria-label="前景色" title="前景色"><input type="color" data-background-color value="#000000" aria-label="背景色" title="背景色"></div><div class="ie-color-actions"><button type="button" class="ie-icon-button" data-action="reset-color" aria-label="默认前景色和背景色（D）" title="默认黑白色 · D">${icon('reset')}</button><button type="button" class="ie-icon-button" data-action="color-swap" aria-label="互换前景色和背景色（X）" title="互换前景色和背景色 · X">${icon('swap')}</button></div></div>
      </nav><aside class="ie-sidebar">
        <div class="ie-panel-heading"><span class="ie-inspector-icon">${icon('brush')}</span><span class="ie-inspector-name">笔刷</span><small>属性</small></div>
        <div class="ie-document-info"><span data-info="dimensions">—</span><span data-info="zoom">适应画布</span></div>
        <details class="ie-basic-tools"><summary>基础编辑</summary><div class="ie-basic-actions"><button type="button" data-action="crop-selection">按选区裁剪</button><button type="button" data-action="rotate-left">左转 90°</button><button type="button" data-action="rotate-right">右转 90°</button><button type="button" data-action="flip-horizontal">水平翻转</button><button type="button" data-action="flip-vertical">垂直翻转</button></div>
          <section class="ie-resize-controls"><h3>图像尺寸</h3><label class="ie-field"><span>宽度</span><input type="number" data-basic-param="width" min="1" max="16384" aria-label="图像宽度"><span>px</span></label><label class="ie-field"><span>高度</span><input type="number" data-basic-param="height" min="1" max="16384" aria-label="图像高度"><span>px</span></label><label class="ie-check"><input type="checkbox" data-basic-param="lockRatio" checked>保持宽高比例</label><button type="button" data-action="resize-apply">应用尺寸</button></section>
          <section class="ie-adjust-controls"><h3>当前图层调色</h3>${[['brightness','亮度'],['contrast','对比度'],['saturation','饱和度']].map(([key,label]) => `<label class="ie-field"><span>${label} <output data-adjust-value="${key}">0</output></span><input type="range" data-adjust-param="${key}" min="-100" max="100" value="0" aria-label="${label}"></label>`).join('')}<div class="ie-basic-actions"><button type="button" data-action="adjust-apply">应用调色</button><button type="button" data-action="grayscale">黑白</button><button type="button" data-action="invert-image">反相</button></div><p class="ie-help">调色作用于当前图层及选区，点击应用生效，可撤销。</p></section>
        </details>
        <div class="ie-edit-controls">
          <section class="ie-control-section ie-text-controls" hidden><h3>文字与水印</h3><textarea data-text-param="text" aria-label="文字内容" rows="3">输入文字</textarea><label class="ie-field"><span>字体</span><select data-text-param="fontFamily"><option value="Microsoft YaHei">微软雅黑</option><option value="Arial">Arial</option><option value="SimSun">宋体</option><option value="Georgia">Georgia</option></select></label><label class="ie-field"><span>字号</span><input type="number" data-text-param="fontSize" min="1" max="4096" value="48" aria-label="文字字号"><span>px</span></label><label class="ie-check"><input type="checkbox" data-text-param="bold">粗体</label><label class="ie-field"><span>对齐</span><select data-text-param="align"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label><div class="ie-basic-actions"><button type="button" data-action="text-update">更新当前文字</button><button type="button" data-action="watermark">添加右下角水印</button></div><p class="ie-help">使用前景色；在画布单击放置文字。绘画或调色会将文字转为像素图层。</p></section>
          <section class="ie-control-section ie-shape-controls" hidden><h3>形状</h3><label class="ie-field"><span>类型</span><select data-shape-param="type"><option value="rect">矩形</option><option value="ellipse">椭圆</option><option value="line">直线</option></select></label><label class="ie-field"><span>描边宽度</span><input type="number" data-shape-param="strokeWidth" min="1" max="200" value="2"><span>px</span></label><label class="ie-check"><input type="checkbox" data-shape-param="filled" checked>填充形状</label><p class="ie-help">填充使用前景色，边框使用背景色；直线使用前景色。</p></section>
          <section class="ie-control-section ie-brush-controls"><h3>笔尖</h3><label class="ie-field"><span>笔刷预设</span><select data-param="preset"><option value="round">圆形</option><option value="square">方形</option><option value="spray">喷点</option><option value="star">星形</option><option value="custom" disabled>自定义图案</option></select></label><label class="ie-upload" tabindex="0" role="button">导入笔刷图案<input type="file" id="imageEditorBrushFile" accept="image/*" tabindex="-1"></label><p class="ie-help">透明图片作为笔尖；不透明图案按明暗提取形状。</p>
          <div class="ie-quick-colors" aria-label="常用前景色">${['#000000', '#ffffff', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7'].map(color => `<button type="button" data-color="${color}" aria-label="前景色 ${color}" title="${color}"></button>`).join('')}<span data-info="color">#FFFFFF</span></div>
          <label class="ie-field"><span>大小 <output data-value="size"></output> px</span><input type="range" data-param="size" min="1" max="1000" step="1" value="48"></label>
          <label class="ie-field"><span>不透明度 <output data-value="opacity"></output>%</span><input type="range" data-param="opacity" min="0" max="100" step="1" value="100"></label>
          <label class="ie-field"><span>硬度 <output data-value="hardness"></output>%</span><input type="range" data-param="hardness" min="0" max="100" step="1" value="80"></label>
          <label class="ie-field"><span>间距 <output data-value="spacing"></output>%</span><input type="range" data-param="spacing" min="1" max="100" step="1" value="15"></label></section>
          <section class="ie-control-section ie-pen-controls"><h3>钢笔路径</h3><p class="ie-help">单击加节点，拖动拉出贝塞尔手柄。点击起点闭合；Backspace 删除末点。</p><div class="ie-button-grid"><button type="button" data-action="pen-close">闭合路径</button><button type="button" data-action="pen-stroke">描边</button><button type="button" data-action="pen-fill">填充</button><button type="button" data-action="pen-select">路径转选区</button><button type="button" data-action="pen-clear">清除路径</button></div></section>
          <section class="ie-control-section ie-selection-controls"><h3>选区</h3><div class="ie-selection-settings"><label class="ie-field"><span>选择方式</span><select data-param="selectionMode"><option value="replace">新选区</option><option value="add">加选（Shift）</option><option value="subtract">减选（Alt）</option></select></label><label class="ie-field"><span>羽化半径</span><input type="number" data-param="feather" min="0" max="200" step="1" value="0"><span>px</span></label><p class="ie-help">羽化用于下一次新建的选区，绘画与填充遵循选区边界。</p></div><div class="ie-button-grid"><button type="button" data-action="select-all">全选</button><button type="button" data-action="clear-selection">取消选区</button><button type="button" data-action="invert-selection">反选</button><button type="button" data-action="clear-pixels">清除所选像素</button><button type="button" data-action="content-aware-fill" title="大图以最长边 768 像素分析纹理，填充结果仍保持原尺寸">智能填充</button><button type="button" data-action="cancel-fill" hidden>取消填充</button></div><p class="ie-help">智能填充根据周围纹理修补选区，适合去除小物体和补齐背景。</p></section>
          <section class="ie-control-section ie-navigation-controls" hidden><h3>画布视图</h3><div class="ie-button-grid"><button type="button" data-action="zoom-fit">适应画布</button><button type="button" data-action="zoom-actual">实际大小</button></div><p class="ie-help">H 切换抓手，拖动画布平移。Z 切换缩放，按住 Alt 单击缩小。使用任何工具时，按住空格可临时平移。</p></section>
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
          <button type="button" data-action="apply-map" class="ie-wide">合并图层并应用当前结果</button><p class="ie-help">应用后可继续局部修图；撤销可恢复图层。</p>
        </div>
      </aside><main class="ie-main"><div class="ie-view-toolbar"><label class="ie-check"><input type="checkbox" data-view="original">原始参考</label><label class="ie-check"><input type="checkbox" data-view="tiled">3 × 3 平铺</label><button type="button" data-action="material-preview" hidden>材质球预览</button><select data-view="shape" aria-label="材质预览形状" hidden><option value="sphere">球体</option><option value="plane">平面</option></select><div class="ie-zoom"><button type="button" class="ie-icon-button" data-action="zoom-out" aria-label="缩小（Ctrl+-）" title="缩小 · Ctrl+-">${icon('minus')}</button><select data-view="zoom" aria-label="画布缩放"><option value="fit">适应</option><option value="0.125">12.5%</option><option value="0.25">25%</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option><option value="4">400%</option><option value="8">800%</option></select><button type="button" class="ie-icon-button" data-action="zoom-in" aria-label="放大（Ctrl++）" title="放大 · Ctrl++">${icon('plus')}</button><button type="button" class="ie-icon-button" data-action="zoom-fit" aria-label="适应画布（Ctrl+0）" title="适应画布 · Ctrl+0">${icon('fit')}</button></div></div><div class="ie-stage" id="imageEditorStage"><div class="ie-canvas-wrap"><canvas id="imageEditorCanvas"></canvas><canvas id="imageEditorOverlayCanvas" aria-label="图像编辑画布"></canvas><div class="ie-brush-cursor" hidden></div></div><div id="imageEditorMaterialPreview" class="ie-material-host" hidden></div><div class="ie-loading">正在读取图片…</div></div><div class="ie-status" id="imageEditorStatus" role="status" aria-live="polite"></div></main></div>
      <footer class="ie-footer"><span class="ie-hint">原图保留 · PSD 保留独立图层</span><button type="button" data-action="reset-map">重置贴图参数</button><button type="button" data-action="export-psd">${icon('maps')}<span>导出 PSD…</span></button><button type="button" data-action="export">${icon('export')}<span>导出 PNG…</span></button><button type="button" data-action="save" class="ie-primary">${icon('save')}<span>保存副本到素材库</span></button></footer>
      <div class="ie-shortcuts" hidden><section class="ie-shortcuts-card" role="dialog" aria-modal="true" aria-labelledby="imageEditorShortcutTitle"><header><h3 id="imageEditorShortcutTitle">图片编辑快捷键</h3><button type="button" data-action="close-shortcuts" aria-label="关闭快捷键说明">${icon('close')}</button></header><p>按 Photoshop 的常用习惯操作。输入文字、数值或使用中文输入法时，保留输入框本身的快捷键。</p><div class="ie-shortcut-grid">${shortcutGroups.map(([name, rows]) => `<section><h4>${name}</h4><dl>${rows.map(([label, keys]) => `<dt>${label}</dt><dd><kbd>${keys}</kbd></dd>`).join('')}</dl></section>`).join('')}</div><footer>数字键在绘画工具下调整笔刷不透明度，其他工具下调整当前图层不透明度。PNG 保存合成图像；Esc 返回。</footer></section></div>
    </div>`;
    const sidebar = root.querySelector('.ie-sidebar'), properties = document.createElement('div');
    properties.className = 'ie-properties'; properties.append(...sidebar.childNodes); sidebar.append(properties);
    sidebar.insertAdjacentHTML('beforeend', `<section class="ie-layers-panel" aria-label="图层">
      <div class="ie-layer-heading"><h3>图层</h3><span data-layer-count>0</span><button type="button" data-action="layer-import">${icon('image')}<span>添加图片</span></button></div>
      <input type="file" id="imageEditorLayerFile" accept="image/*" multiple hidden>
      <div class="ie-layer-compositing"><select data-layer-param="blend" aria-label="图层混合模式">${Object.entries(window.ShituImageLayers.BLENDS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select><label>不透明度 <input type="number" data-layer-param="opacity" aria-label="图层不透明度" min="0" max="100" value="100">%</label></div>
      <div class="ie-layer-list" role="list" aria-label="图层列表，顶部图层在最上方"></div>
      <div class="ie-layer-actions">${[['layer-add','plus','新建透明图层'],['layer-duplicate','duplicate','复制图层'],['layer-up','up','上移图层'],['layer-down','down','下移图层'],['layer-delete','trash','删除图层'],['layer-flatten','maps','拼合图像（隐藏图层将移除，可撤销）']].map(([action, glyph, title]) => `<button type="button" class="ie-icon-button" data-action="${action}" aria-label="${title}" title="${title}">${icon(glyph)}</button>`).join('')}</div>
      <details class="ie-layer-details"><summary>名称与变换</summary><label class="ie-layer-name">名称 <input type="text" data-layer-param="name" aria-label="图层名称" maxlength="160"></label><div class="ie-layer-transform">${[['x','X','px',-100000,100000,1],['y','Y','px',-100000,100000,1],['scale','缩放','%',1,10000,1],['rotation','旋转','°',-360,360,1]].map(([key,label,unit,min,max,step]) => `<label>${label}<input type="number" data-layer-param="${key}" aria-label="图层${label}" min="${min}" max="${max}" step="${step}">${unit}</label>`).join('')}</div></details>
      <p class="ie-layer-hint">绘画作用于当前图层 · PNG 保存合成图像</p>
    </section>`);
    root.querySelector('.ie-body').append(sidebar);
    document.body.append(root);
    const $ = selector => root.querySelector(selector);
    const $$ = selector => [...root.querySelectorAll(selector)];
    const actionTips = { save: '保存副本 · Ctrl+S', export: '导出 PNG · Ctrl+Shift+S', 'select-all': '全选 · Ctrl+A', 'clear-selection': '取消选区 · Ctrl+D', 'invert-selection': '反选 · Ctrl+Shift+I', 'layer-add': '新建透明图层 · Ctrl+Shift+N', 'layer-duplicate': '复制图层 · Ctrl+J', 'layer-up': '上移图层 · Ctrl+]', 'layer-down': '下移图层 · Ctrl+[', 'pen-select': '路径转选区 · Ctrl+Enter' };
    actionTips['export-psd'] = '导出分层 PSD（像素图层） · Ctrl+Alt+Shift+S';
    for (const [action, title] of Object.entries(actionTips)) $(`[data-action="${action}"]`).title = title;
    $$('[data-color]').forEach(node => node.style.setProperty('--swatch', node.dataset.color));
    const view = $('#imageEditorCanvas'), overlay = $('#imageEditorOverlayCanvas');
    const stage = $('#imageEditorStage'), wrap = $('.ie-canvas-wrap'), cursor = $('.ie-brush-cursor');
    const status = $('#imageEditorStatus'), loading = $('.ie-loading');
    const defaultParams = { size: 48, opacity: 100, hardness: 80, spacing: 15, color: '#ffffff', preset: 'round', selectionMode: 'replace', feather: 0, type: 'color', brightness: 0, contrast: 1, gamma: 1, blur: 0, strength: 3, invert: false, flipY: false, seamless: false, seamWidth: 0.15 };
    let params = { ...defaultParams }, session = null, generation = 0, previousFocus = null;
    let source = canvas(), original = canvas(), selection = null, selectionSnapshot = null, selectionHasPixels = false;
    let layerDoc = null, compositeDirty = false, layerListVersion = -1, layerEdit = null;
    let mode = 'edit', tool = 'brush', dirty = false, saving = false, history = [], future = [];
    let gesture = null, pen = [], penClosed = false, cloneAnchor = null, cloneOffset = null, cloneSource = null;
    let panGesture = null, spacePan = false, blankSelectionClick = null;
    let backgroundColor = '#000000', lastSelection = null, shortcutFocus = null, opacityKeys = null, nudgeKey = null, marqueeTool = 'rect';
    let cropRect = null, resizeParams = { width: 1, height: 1, lockRatio: true }, adjustParams = { brightness: 0, contrast: 0, saturation: 0 };
    let textParams = { text: '输入文字', fontFamily: 'Microsoft YaHei', fontSize: 48, bold: false, align: 'left', lineHeight: 1.2 }, shapeParams = { type: 'rect', strokeWidth: 2, filled: true };
    let customBrush = null, stampCache = null, stampKey = '', previewCache = null, previewVersion = 0, documentVersion = 0;
    let updateTimer = 0, renderFrame = 0, fillController = null;
    let materialActive = false, materialViewer = null, materialPending = null, materialKey = '', materialSequence = 0;

    function message(value, error = false) { status.textContent = value; status.classList.toggle('ie-error', error); }
    function ready() { return Boolean(session?.ready && !saving); }
    function activeLayer() { return layerDoc?.active(); }
    function layerWritable(announce = false) {
      const layer = activeLayer(), allowed = Boolean(layer && !layer.locked && layer.visible);
      if (!allowed && announce) message(layer?.locked ? '当前图层已锁定，请先解锁' : '当前图层已隐藏，请先显示图层');
      return allowed;
    }
    function syncSource() { if (layerDoc && compositeDirty) { layerDoc.composite(source); compositeDirty = false; } return source; }
    function drawOnLayer(image, x = 0, y = 0, operation = 'source-over') {
      const layer = activeLayer(); if (!layer) return;
      delete layer.text;
      const ctx = context(layer.canvas); ctx.save();
      layerDoc.applyTransform(ctx, layer, true); ctx.globalCompositeOperation = operation; ctx.drawImage(image, x, y); ctx.restore();
    }
    function renderLayers() {
      const layer = activeLayer(), interactive = ready() && mode === 'edit' && !gesture && !materialActive;
      const layers = layerDoc?.layers || [], index = layers.indexOf(layer);
      const capacity = layers.length < window.ShituImageLayers.MAX_LAYERS && (layers.length + 1) * source.width * source.height <= window.ShituImageLayers.MAX_PIXELS;
      const signature = `${documentVersion}:${layerDoc?.activeId}:${layers.map(item => `${item.id}:${item.name}:${item.visible}:${item.locked}:${item.opacity}:${item.blend}`).join('|')}`;
      if (layerListVersion !== signature) {
        layerListVersion = signature;
        const list = $('.ie-layer-list'); list.replaceChildren();
        for (const item of [...layers].reverse()) {
          const row = document.createElement('div'); row.className = `ie-layer-row${item === layer ? ' is-active' : ''}${item.visible ? '' : ' is-hidden'}`; row.dataset.layerId = item.id; row.setAttribute('role', 'listitem');
          const visibility = document.createElement('button'); visibility.type = 'button'; visibility.className = 'ie-layer-visibility'; visibility.dataset.layerAction = 'visible'; visibility.setAttribute('aria-label', `${item.visible ? '隐藏' : '显示'}图层 ${item.name}`); visibility.title = item.visible ? '隐藏图层' : '显示图层'; visibility.setAttribute('aria-pressed', String(item.visible)); visibility.innerHTML = icon(item.visible ? 'eye' : 'hidden');
          const select = document.createElement('button'); select.type = 'button'; select.className = 'ie-layer-select'; select.dataset.layerSelect = item.id; select.setAttribute('aria-pressed', String(item === layer)); select.title = item.name;
          const thumb = canvas(40, 30); thumb.className = 'ie-layer-thumb'; const scale = Math.min(40 / source.width, 30 / source.height); context(thumb).drawImage(item.canvas, (40 - source.width * scale) / 2, (30 - source.height * scale) / 2, source.width * scale, source.height * scale);
          const title = document.createElement('span'); title.className = 'ie-layer-title'; title.textContent = item.name; select.append(thumb, title);
          const lock = document.createElement('button'); lock.type = 'button'; lock.className = 'ie-layer-lock'; lock.dataset.layerAction = 'locked'; lock.setAttribute('aria-label', `${item.locked ? '解锁' : '锁定'}图层 ${item.name}`); lock.title = item.locked ? '解锁图层' : '锁定图层'; lock.setAttribute('aria-pressed', String(item.locked)); lock.innerHTML = icon(item.locked ? 'lock' : 'unlock');
          row.append(visibility, select, lock); list.append(row);
        }
      }
      $('[data-layer-count]').textContent = String(layers.length);
      $$('[data-layer-param]').forEach(node => {
        const key = node.dataset.layerParam;
        if (node !== document.activeElement) node.value = String(layer?.[key] ?? '');
        node.disabled = !interactive || !layer || (layer.locked && key !== 'name');
      });
      $$('[data-layer-select], [data-layer-action]').forEach(node => { node.disabled = !interactive; });
      $$('[data-action^="layer-"]').forEach(node => { node.disabled = !interactive; });
      for (const action of ['layer-add', 'layer-import', 'layer-duplicate']) $('[data-action="' + action + '"]').disabled ||= !capacity;
      $('[data-action="layer-delete"]').disabled ||= layers.length <= 1 || Boolean(layer?.locked);
      $('[data-action="layer-up"]').disabled ||= index < 0 || index >= layers.length - 1 || Boolean(layer?.locked);
      $('[data-action="layer-down"]').disabled ||= index <= 0 || Boolean(layer?.locked);
      $('[data-action="layer-flatten"]').disabled ||= layers.length <= 1 || layers.some(item => item.locked);
      $('#imageEditorLayerFile').disabled = !interactive || !capacity;
    }
    function selectLayer(id) {
      if (!ready() || mode !== 'edit' || gesture || materialActive) return;
      layerDoc.activeId = id; layerEdit = null; pen = []; penClosed = false; cloneAnchor = cloneOffset = cloneSource = null;
      if (activeLayer().text) { textParams = { ...activeLayer().text }; params.color = textParams.color; }
      controls(); paintOverlay(); message(`当前图层：${activeLayer().name}`);
    }
    function layerAction(action) {
      if (!ready() || mode !== 'edit' || gesture || materialActive || !layerDoc) return;
      if (action === 'layer-import') { $('#imageEditorLayerFile').click(); return; }
      const layer = activeLayer();
      if (layer.locked && ['layer-delete', 'layer-up', 'layer-down'].includes(action)) { message('当前图层已锁定，请先解锁'); return; }
      if (action === 'layer-flatten' && layerDoc.layers.some(item => item.locked)) { message('请先解锁图层再合并'); return; }
      try {
        remember();
        if (action === 'layer-add') layerDoc.add(`图层 ${layerDoc.layers.length + 1}`);
        else if (action === 'layer-duplicate') layerDoc.duplicate().locked = false;
        else if (action === 'layer-delete') layerDoc.remove();
        else if (action === 'layer-up') layerDoc.move(layer.id, 1);
        else if (action === 'layer-down') layerDoc.move(layer.id, -1);
        else if (action === 'layer-flatten') layerDoc.flatten();
        layerEdit = null; pen = []; penClosed = false; cloneAnchor = cloneOffset = cloneSource = null;
        markChanged(); message(action === 'layer-flatten' ? '已合并图层；Ctrl+Z 可恢复' : `当前图层：${activeLayer().name}`);
      } catch (error) { message(error.message || String(error), true); }
    }
    function editingReady() { return ready() && mode === 'edit' && !gesture && !panGesture && !materialActive; }
    function showShortcuts(show) {
      const panel = $('.ie-shortcuts');
      if (show && panel.hidden) shortcutFocus = document.activeElement;
      panel.hidden = !show;
      if (show) $('[data-action="close-shortcuts"]').focus();
      else { shortcutFocus?.isConnected && shortcutFocus.focus({ preventScroll: true }); shortcutFocus = null; }
    }
    function showLayerField(key) {
      if (!editingReady()) return;
      root.classList.remove('ie-panels-hidden', 'ie-layers-hidden');
      $('.ie-layer-details').open = true;
      if (key !== 'name') setTool('move');
      const field = $(`[data-layer-param="${key}"]`);
      if (!field.disabled) { field.focus(); field.select(); }
    }
    function selectedLayerMask(layer) {
      const mask = canvas(source.width, source.height), ctx = context(mask);
      layerDoc.applyTransform(ctx, layer, true); ctx.drawImage(selection, 0, 0); return mask;
    }
    function copySelectedLayer(cut = false) {
      if (!editingReady() || $('[data-action="layer-duplicate"]').disabled) return;
      if (!selection) { if (!cut) layerAction('layer-duplicate'); else message('请先选择要剪切的区域'); return; }
      if (!selectionHasPixels || (cut && !layerWritable(true))) return;
      try {
        const previous = activeLayer(), mask = selectedLayerMask(previous);
        remember();
        const next = layerDoc.duplicate(previous.id); next.locked = false;
        delete next.text;
        const ctx = context(next.canvas); ctx.save(); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0); ctx.restore();
        if (cut) { delete previous.text; const originalContext = context(previous.canvas); originalContext.save(); originalContext.globalCompositeOperation = 'destination-out'; originalContext.drawImage(mask, 0, 0); originalContext.restore(); }
        markChanged(); message(cut ? '已将选区剪切到新图层' : '已将选区复制到新图层');
      } catch (error) { message(error.message || String(error), true); }
    }
    function moveLayerInStack(direction, edge = false) {
      if (!editingReady() || activeLayer().locked) return;
      const layer = activeLayer(), index = layerDoc.layers.indexOf(layer);
      const destination = edge ? direction > 0 ? layerDoc.layers.length - 1 : 0 : clamp(index + direction, 0, layerDoc.layers.length - 1);
      if (destination === index) return;
      remember(); layerDoc.move(layer.id, destination - index); markChanged(); message('已调整图层顺序');
    }
    function selectAdjacentLayer(direction) {
      if (!editingReady()) return;
      const index = layerDoc.layers.indexOf(activeLayer());
      const next = layerDoc.layers[index + direction]; if (next) selectLayer(next.id);
    }
    function nudgeLayer(key, amount) {
      if (!editingReady() || activeLayer().locked) return;
      const group = `${layerDoc.activeId}:${key}`;
      if (nudgeKey !== group) { remember(); nudgeKey = group; }
      const layer = activeLayer();
      if (key === 'ArrowLeft') layer.x -= amount; else if (key === 'ArrowRight') layer.x += amount;
      else if (key === 'ArrowUp') layer.y -= amount; else layer.y += amount;
      markChanged();
    }
    function keyboardOpacity(digit) {
      if (!editingReady()) return;
      const painting = ['brush', 'eraser', 'clone', 'pen'].includes(tool), target = painting ? 'brush' : layerDoc.activeId, now = performance.now();
      if (!painting && activeLayer().locked) { message('当前图层已锁定，请先解锁'); return; }
      const continuing = opacityKeys && opacityKeys.target === target && now - opacityKeys.time < 650 && opacityKeys.digits.length === 1 && (painting || opacityKeys.version === documentVersion);
      const digits = continuing ? opacityKeys.digits + digit : digit;
      const value = digits.length === 1 ? digit === '0' ? 100 : Number(digit) * 10 : Number(digits);
      if (painting) { params.opacity = value; controls(); }
      else if (!activeLayer().locked) { if (!continuing) remember(); activeLayer().opacity = value; markChanged(); }
      opacityKeys = { target, time: now, digits, version: documentVersion };
      message(`${painting ? '笔刷' : '图层'}不透明度 ${value}%`);
    }
    function fillWithColor(color) {
      if (!editingReady() || !layerWritable(true)) return;
      const fill = canvas(source.width, source.height), ctx = context(fill); ctx.fillStyle = color; ctx.fillRect(0, 0, fill.width, fill.height);
      if (selection) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selection, 0, 0); }
      remember(); drawOnLayer(fill); markChanged(); message(`已填充 ${color.toUpperCase()}`);
    }
    function resetColors() { params.color = '#000000'; backgroundColor = '#ffffff'; controls(); }
    function swapColors() { [params.color, backgroundColor] = [backgroundColor, params.color]; controls(); }
    function pickForeground(p) {
      syncSource();
      const sample = context(source).getImageData(clamp(Math.floor(p.x), 0, source.width - 1), clamp(Math.floor(p.y), 0, source.height - 1), 1, 1).data;
      if (!sample[3]) { message('该像素完全透明，请在有颜色的位置取样'); return; }
      params.color = `#${[...sample.slice(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
      controls(); message(`已采集前景色 ${params.color.toUpperCase()}`);
    }
    function rectangleBetween(p, q) {
      const left = clamp(Math.floor(Math.min(p.x, q.x)), 0, source.width), top = clamp(Math.floor(Math.min(p.y, q.y)), 0, source.height);
      const right = clamp(Math.ceil(Math.max(p.x, q.x)), 0, source.width), bottom = clamp(Math.ceil(Math.max(p.y, q.y)), 0, source.height);
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
    function transformDocument(width, height, matrix, label) {
      if (!editingReady()) return;
      try {
        const next = layerDoc.remap(width, height, matrix);
        const reference = window.ShituImageBasics.transformCanvas(original, width, height, matrix);
        remember(); layerDoc = next; original = reference; source = canvas(width, height);
        selection = selectionSnapshot = lastSelection = null; selectionHasPixels = false; cropRect = null;
        pen = []; penClosed = false; cloneAnchor = cloneOffset = cloneSource = null;
        resizeParams.width = width; resizeParams.height = height; $('[data-view="zoom"]').value = 'fit';
        markChanged(); message(`${label}完成；Ctrl+Z 可恢复`);
      } catch (error) { message(error.message || String(error), true); }
    }
    function applyCrop(rect = cropRect) {
      if (!rect || rect.width < 1 || rect.height < 1) { message('请先拖出裁剪范围'); return; }
      transformDocument(rect.width, rect.height, { a: 1, b: 0, c: 0, d: 1, e: -rect.x, f: -rect.y }, '裁剪');
    }
    function cropToSelection() {
      if (!selectionHasPixels) { message('请先建立选区'); return; }
      let left = source.width, top = source.height, right = 0, bottom = 0;
      for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) if (selectionSnapshot.data[(y * source.width + x) * 4 + 3]) { left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1); }
      applyCrop({ x: left, y: top, width: right - left, height: bottom - top });
    }
    function applyAdjustment(extra = {}) {
      if (!editingReady() || !layerWritable(true)) return;
      try {
        const layer = activeLayer(), output = window.ShituImageBasics.adjust(layer.canvas, { ...adjustParams, ...extra }, selection ? selectedLayerMask(layer) : null);
        remember(); layer.canvas = output; delete layer.text;
        adjustParams = { brightness: 0, contrast: 0, saturation: 0 }; markChanged(); message('已调整当前图层；Ctrl+Z 可撤销');
      } catch (error) { message(error.message || String(error), true); }
    }
    function placeText(point, watermark = false, updating = false) {
      if (!editingReady() || !String(textParams.text).trim()) { message('请先输入文字内容'); return; }
      if (!updating && $('[data-action="layer-add"]').disabled) { message('已达到图层数量或像素上限'); return; }
      if (updating && (!activeLayer().text || !layerWritable(true))) return;
      const spec = { ...textParams, color: params.color, x: point.x, y: point.y };
      if (watermark) { spec.align = 'right'; spec.x = source.width - Math.max(8, source.width * .03); spec.y = source.height - spec.fontSize * 1.4 - Math.max(8, source.height * .03); }
      try {
        remember(); const layer = updating ? activeLayer() : layerDoc.add(`文字 · ${spec.text.slice(0, 24)}`);
        window.ShituImageBasics.drawText(layer.canvas, spec); layer.text = { ...spec };
        if (watermark) layer.opacity = 35;
        markChanged(); message(watermark ? '已添加独立水印图层' : updating ? '已更新文字图层' : '已添加独立文字图层');
      } catch (error) { message(error.message || String(error), true); }
    }
    function traceBasicShape(ctx, start, end, type = shapeParams.type) {
      ctx.beginPath();
      if (type === 'line') { ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); }
      else if (type === 'ellipse') ctx.ellipse((start.x + end.x) / 2, (start.y + end.y) / 2, Math.abs(start.x - end.x) / 2, Math.abs(start.y - end.y) / 2, 0, 0, Math.PI * 2);
      else ctx.rect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(start.x - end.x), Math.abs(start.y - end.y));
    }
    function addShape(current) {
      if ($('[data-action="layer-add"]').disabled) { message('已达到图层数量或像素上限'); return; }
      remember(); const layer = layerDoc.add({ rect: '矩形', ellipse: '椭圆', line: '直线' }[shapeParams.type]); const ctx = context(layer.canvas);
      traceBasicShape(ctx, current.start, current.last); ctx.lineWidth = shapeParams.strokeWidth; ctx.lineJoin = 'round';
      if (shapeParams.filled && shapeParams.type !== 'line') { ctx.fillStyle = params.color; ctx.fill(); }
      ctx.strokeStyle = shapeParams.type === 'line' ? params.color : backgroundColor; ctx.stroke(); markChanged(); message('已创建独立形状图层');
    }
    async function exportPsd() {
      if (!editingReady() || typeof api.exportEditedPsd !== 'function') return;
      const current = session, token = generation;
      saving = true; controls(); message('正在生成分层 PSD…');
      try {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (session !== current || generation !== token) return;
        let totalPixels = 0;
        const bounds = layerDoc.layers.map(layer => {
          const rect = layerDoc.bounds(layer), left = Math.floor(rect.left + 1e-6), top = Math.floor(rect.top + 1e-6), width = Math.ceil(rect.right - 1e-6) - left, height = Math.ceil(rect.bottom - 1e-6) - top;
          totalPixels += width * height;
          if (width < 1 || height < 1 || width > 30000 || height > 30000 || totalPixels > window.ShituImageLayers.MAX_PIXELS) throw new Error('变换后的 PSD 图层过大，请减小图层缩放或合并部分图层后再导出');
          return { layer, left, top, width, height };
        });
        const layers = bounds.map(({ layer, left, top, width, height }) => {
          const bitmap = canvas(width, height), ctx = context(bitmap); ctx.translate(-left, -top); layerDoc.applyTransform(ctx, layer); ctx.drawImage(layer.canvas, 0, 0);
          const pixels = context(bitmap).getImageData(0, 0, bitmap.width, bitmap.height);
          return { name: layer.name, visible: layer.visible, locked: layer.locked, opacity: layer.opacity, blend: layer.blend, left, top, imageData: { width: pixels.width, height: pixels.height, data: pixels.data } };
        });
        const pixels = context(syncSource()).getImageData(0, 0, source.width, source.height);
        const result = await api.exportEditedPsd({ assetId: current.asset.id, libraryRoot: current.root, width: source.width, height: source.height, layers, imageData: { width: pixels.width, height: pixels.height, data: pixels.data } });
        if (session !== current || generation !== token) return;
        if (result?.canceled || result?.cancelled) { message('已取消 PSD 导出'); return; }
        dirty = false; $('.ie-discard').hidden = true; message('分层 PSD 已导出，可在 Photoshop 中继续编辑');
      } catch (error) { if (session === current && generation === token) message(error.message || String(error), true); }
      finally { if (session === current && generation === token) { saving = false; controls(); } }
    }
    function mapOptions() { return Object.fromEntries(['type', 'brightness', 'contrast', 'gamma', 'blur', 'strength', 'invert', 'flipY', 'seamless', 'seamWidth'].map(key => [key, params[key]])); }
    function controls() {
      $$('[data-mode]').forEach(node => { const active = node.dataset.mode === mode; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
      $$('[data-tool]').forEach(node => { const active = node.dataset.tool === tool && (mode === 'edit' || ['hand', 'zoom'].includes(tool)); node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
      const painting = ['brush', 'eraser', 'clone', 'pen'].includes(tool), selecting = ['rect', 'ellipse', 'lasso'].includes(tool);
      const activeName = mode === 'maps' ? '材质贴图' : toolNames[tool], activeIcon = mode === 'maps' ? 'maps' : tool;
      $('.ie-active-tool-name').textContent = $('.ie-inspector-name').textContent = activeName;
      $('.ie-active-tool-icon').innerHTML = $('.ie-inspector-icon').innerHTML = icon(activeIcon);
      $$('[data-options]').forEach(node => { node.hidden = node.dataset.options !== (mode === 'maps' ? 'maps' : painting ? 'paint' : selecting ? 'selection' : ['crop', 'text', 'shape', 'move', 'eyedropper'].includes(tool) ? tool : 'navigation'); });
      $('.ie-edit-controls').hidden = mode !== 'edit'; $('.ie-map-controls').hidden = mode !== 'maps';
      $('.ie-brush-controls').hidden = !painting;
      $('.ie-pen-controls').hidden = tool !== 'pen';
      $('.ie-selection-settings').hidden = !selecting;
      $('.ie-navigation-controls').hidden = !['hand', 'zoom'].includes(tool);
      $('.ie-basic-tools').hidden = mode !== 'edit'; $('.ie-text-controls').hidden = tool !== 'text'; $('.ie-shape-controls').hidden = tool !== 'shape';
      $$('[data-info="color"]').forEach(node => { node.textContent = params.color.toUpperCase(); });
      stage.dataset.tool = tool;
      stage.classList.toggle('ie-space-pan', spacePan);
      $('[data-info="dimensions"]').textContent = session?.ready ? `${source.width} × ${source.height} px` : '正在读取图像';
      $$('.ie-normal-param').forEach(node => { node.hidden = params.type !== 'normal'; });
      $('[data-action="reset-map"]').hidden = mode !== 'maps';
      $('[data-action="material-preview"]').hidden = mode !== 'maps';
      $('[data-action="material-preview"]').disabled = !ready();
      $('[data-action="material-preview"]').textContent = materialActive ? '返回二维预览' : '材质球预览';
      $('[data-view="shape"]').hidden = !materialActive;
      $('[data-action="undo"]').disabled = !ready() || !history.length;
      $('[data-action="redo"]').disabled = !ready() || !future.length;
      $$('[data-action="save"], [data-action="export"], [data-action="apply-map"]').forEach(node => { node.disabled = !ready(); });
      $('[data-action="apply-map"]').disabled ||= layerDoc?.layers.some(item => item.locked);
      $$('[data-param]').forEach(node => { const key = node.dataset.param; if (node.type === 'checkbox') node.checked = Boolean(params[key]); else node.value = String(params[key]); node.disabled = !ready(); });
      $('[data-background-color]').value = backgroundColor; $('[data-background-color]').disabled = !ready();
      $$('[data-value]').forEach(node => { const value = params[node.dataset.value]; node.value = String(typeof value === 'number' ? Number(value.toFixed(2)) : value); });
      $$('[data-tool], [data-view]').forEach(node => { node.disabled = !ready() || (materialActive && (node.dataset.tool || node.dataset.view !== 'shape')); });
      $$('[data-action^="zoom-"]').forEach(node => { node.disabled = !ready() || materialActive; });
      $$('[data-color], [data-action="reset-color"], [data-action="color-swap"]').forEach(node => { node.disabled = !ready(); });
      $('.ie-upload').setAttribute('aria-disabled', String(!ready()));
      $('#imageEditorBrushFile').disabled = !ready();
      $('[data-action="pen-close"]').disabled = !ready() || pen.length < 3;
      $('[data-action="pen-stroke"]').disabled = !ready() || !layerWritable() || pen.length < 2;
      $('[data-action="pen-fill"]').disabled = !ready() || !layerWritable() || pen.length < 3;
      $('[data-action="pen-select"]').disabled = !ready() || pen.length < 3;
      $('[data-action="content-aware-fill"]').disabled = !ready() || !layerWritable() || !selection || !selectionHasPixels;
      $$('[data-action="clear-selection"], [data-action="invert-selection"], [data-action="clear-pixels"], [data-action="select-all"]').forEach(node => { node.disabled = !ready() || mode !== 'edit'; });
      $('[data-action="cancel-fill"]').hidden = !fillController;
      $('[data-action="clear-pixels"]').disabled ||= !layerWritable();
      $$('[data-basic-param]').forEach(node => { const key = node.dataset.basicParam; if (node !== document.activeElement) { if (node.type === 'checkbox') node.checked = resizeParams[key]; else node.value = resizeParams[key]; } node.disabled = !editingReady(); });
      $$('[data-adjust-param]').forEach(node => { node.value = adjustParams[node.dataset.adjustParam]; node.disabled = !editingReady() || !layerWritable(); });
      $$('[data-adjust-value]').forEach(node => { node.value = adjustParams[node.dataset.adjustValue]; });
      for (const [attribute, values] of [['textParam', textParams], ['shapeParam', shapeParams]]) $$(`[data-${attribute === 'textParam' ? 'text' : 'shape'}-param]`).forEach(node => { const key = node.dataset[attribute]; if (node !== document.activeElement) { if (node.type === 'checkbox') node.checked = Boolean(values[key]); else node.value = values[key]; } node.disabled = !editingReady(); });
      $$('[data-action="rotate-left"], [data-action="rotate-right"], [data-action^="flip-"], [data-action="resize-apply"], [data-action="crop-selection"], [data-action="watermark"]').forEach(node => { node.disabled = !editingReady(); });
      $$('[data-action="adjust-apply"], [data-action="grayscale"], [data-action="invert-image"]').forEach(node => { node.disabled = !editingReady() || !layerWritable(); });
      $('[data-action="text-update"]').disabled = !editingReady() || !activeLayer()?.text || !layerWritable();
      $('[data-action="crop-apply"]').disabled = !editingReady() || !cropRect;
      $('[data-action="crop-cancel"]').disabled = !cropRect;
      $('[data-action="export-psd"]').disabled = !editingReady() || typeof api.exportEditedPsd !== 'function';
      renderLayers();
      cursor.hidden = true;
      root.classList.toggle('ie-busy', saving);
    }
    function setTool(value) {
      if (!ready() || !toolNames[value] || materialActive) return;
      if (gesture) endGesture(null, true);
      stopPan();
      if (mode === 'maps' && !['hand', 'zoom'].includes(value)) setMode('edit');
      tool = value; controls(); paintOverlay();
      if (['rect', 'ellipse'].includes(value)) marqueeTool = value;
      const hints = {
        move: '拖动移动当前图层；Shift 约束方向，右侧可调整缩放和旋转',
        clone: 'Alt + 单击设置取样点，然后涂抹；再次取样可改变源位置',
        pen: '单击建立路径节点，按住拖动拉出曲线手柄',
        eyedropper: '单击图像采集前景色，再按 B 使用笔刷',
        hand: '拖动画布平移视图；Ctrl+0 适应画布',
        zoom: '单击放大，Alt + 单击缩小；Ctrl+0 适应画布'
      };
      message(hints[tool] || `${toolNames[tool]} · ${toolKeys[tool]}；按住空格可平移画布`);
    }
    function setZoom(value, anchor = null) {
      if (!ready() || materialActive || gesture) return;
      const bounds = wrap.getBoundingClientRect(), area = stage.getBoundingClientRect();
      const target = anchor || { x: area.left + stage.clientWidth / 2, y: area.top + stage.clientHeight / 2 };
      const position = { x: (target.x - bounds.left) / bounds.width, y: (target.y - bounds.top) / bounds.height };
      $('[data-view="zoom"]').value = String(value);
      render();
      if (value === 'fit') { stage.scrollLeft = 0; stage.scrollTop = 0; }
      else {
        const next = wrap.getBoundingClientRect();
        stage.scrollLeft += next.left + position.x * next.width - target.x;
        stage.scrollTop += next.top + position.y * next.height - target.y;
      }
      cursor.hidden = true;
    }
    function zoomBy(direction, anchor = null) {
      const factor = wrap.getBoundingClientRect().width / (source.width * ($('[data-view="tiled"]').checked ? 3 : 1));
      const levels = [0.125, 0.25, 0.5, 1, 2, 4, 8];
      const next = direction > 0 ? levels.find(value => value > factor + 0.001) : levels.findLast(value => value < factor - 0.001);
      if (next !== undefined) setZoom(next, anchor);
    }
    function stopPan() {
      const current = panGesture; panGesture = null;
      if (current && stage.hasPointerCapture(current.id)) stage.releasePointerCapture(current.id);
      stage.classList.remove('ie-panning');
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
    function invalidate() { documentVersion += 1; compositeDirty = true; previewCache = null; previewVersion += 1; scheduleRender(); }
    function markChanged() { dirty = true; invalidate(); controls(); }
    function snapshot() { return { layers: layerDoc.snapshot(), original, mask: selectionSnapshot, lastSelection, dirty, bytes: layerDoc.estimateBytes() + original.width * original.height * 4 + (selectionSnapshot?.data.byteLength || 0) + (lastSelection !== selectionSnapshot ? lastSelection?.data.byteLength || 0 : 0) }; }
    function trimHistory() {
      let bytes = [...history, ...future].reduce((total, item) => total + item.bytes, 0);
      while (history.length > 1 && (history.length > 24 || bytes > 128 * 1024 * 1024)) bytes -= history.shift().bytes;
      while (future.length > 1 && (future.length > 24 || bytes > 128 * 1024 * 1024)) bytes -= future.shift().bytes;
      if (history.length + future.length > 1 && bytes > 128 * 1024 * 1024) history.shift();
    }
    function remember() { history.push(snapshot()); future = []; layerEdit = null; trimHistory(); }
    function setMask(data) {
      selectionSnapshot = data;
      selectionHasPixels = false;
      if (!data) { selection = null; return; }
      for (let at = 3; at < data.data.length; at += 4) if (data.data[at]) { selectionHasPixels = true; break; }
      selection = canvas(source.width, source.height); context(selection).putImageData(data, 0, 0);
    }
    function restore(item) {
      if (source.width !== item.layers.width || source.height !== item.layers.height) { layerDoc = window.ShituImageLayers.create(item.layers.width, item.layers.height); source = canvas(item.layers.width, item.layers.height); }
      layerDoc.restore(item.layers); original = item.original; setMask(item.mask); lastSelection = item.lastSelection;
      resizeParams.width = source.width; resizeParams.height = source.height; dirty = item.dirty; cropRect = null;
      if (activeLayer().text) { textParams = { ...activeLayer().text }; params.color = textParams.color; }
      layerEdit = null; pen = []; penClosed = false; cloneAnchor = cloneOffset = cloneSource = null; invalidate(); controls();
    }
    function undo() { if (!ready() || gesture || !history.length) return; future.push(snapshot()); restore(history.pop()); trimHistory(); message('已撤销'); }
    function redo() { if (!ready() || gesture || !future.length) return; history.push(snapshot()); restore(future.pop()); trimHistory(); message('已重做'); }
    function createPreviewBase() {
      syncSource();
      const ratio = Math.min(1, 1024 / Math.max(source.width, source.height));
      const result = canvas(Math.max(1, Math.round(source.width * ratio)), Math.max(1, Math.round(source.height * ratio)));
      context(result).drawImage(source, 0, 0, result.width, result.height); return result;
    }
    function generated(full = false) {
      syncSource();
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
        $('[data-info="zoom"]').textContent = `${Number((factor * 100).toFixed(1))}%`;
        paintOverlay();
      } catch (error) { message(error.message || String(error), true); }
    }
    function editable() { return ready() && !materialActive && !spacePan && !panGesture && mode === 'edit' && !$('[data-view="original"]').checked && !$('[data-view="tiled"]').checked; }
    function point(event) { const bounds = overlay.getBoundingClientRect(); return { x: (event.clientX - bounds.left) * source.width / bounds.width, y: (event.clientY - bounds.top) * source.height / bounds.height }; }
    function selectionContains(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      return Boolean(selectionSnapshot && x >= 0 && y >= 0 && x < source.width && y < source.height && selectionSnapshot.data[(y * source.width + x) * 4 + 3]);
    }
    function plainSelectionClick(event) { return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey; }
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
      if (gesture?.tool === 'shape') { traceBasicShape(ctx, gesture.start, gesture.last); ctx.strokeStyle = params.color; ctx.lineWidth = 2 / scale; ctx.stroke(); }
      const crop = gesture?.tool === 'crop' ? rectangleBetween(gesture.start, gesture.last) : tool === 'crop' ? cropRect : null;
      if (crop) { ctx.beginPath(); ctx.rect(0, 0, source.width, source.height); ctx.rect(crop.x, crop.y, crop.width, crop.height); ctx.fillStyle = '#0008'; ctx.fill('evenodd'); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / scale; ctx.strokeRect(crop.x, crop.y, crop.width, crop.height); }
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
      drawOnLayer(patch, left, top, paintingTool === 'eraser' ? 'destination-out' : 'source-over');
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
        if (event && Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) > 3) current.moved = true;
        if (!cancelled && current.moved && (Math.hypot(current.last.x - current.start.x, current.last.y - current.start.y) > 1 || current.points.length > 2)) {
          const shape = canvas(source.width, source.height), ctx = context(shape); drawShape(ctx, current); ctx.fillStyle = '#fff'; ctx.fill(); combineSelection(shape, current.operation);
        } else if (!cancelled && !current.moved && current.plainClick && current.operation === 'replace' && (!event || plainSelectionClick(event)) && selection && !selectionContains(current.start)) {
          selectOperation('clear-selection');
        }
      } else if (current.tool === 'crop') { if (!cancelled && current.moved) cropRect = rectangleBetween(current.start, current.last); controls(); }
      else if (current.tool === 'shape') { if (!cancelled && current.moved) addShape(current); }
      else if (current.tool === 'pen') { controls(); }
      else {
        if (cancelled && history.length) { restore(history.pop()); future = []; }
        else markChanged();
        cloneSource = null;
      }
      paintOverlay();
    }
    stage.addEventListener('pointerdown', event => {
      if (!ready() || materialActive || gesture || panGesture || blankSelectionClick) return;
      if (event.button === 1 || (event.button === 0 && (tool === 'hand' || spacePan))) {
        event.preventDefault(); event.stopPropagation(); overlay.focus({ preventScroll: true });
        panGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
        stage.setPointerCapture(event.pointerId); stage.classList.add('ie-panning'); cursor.hidden = true;
      } else if (event.button === 0 && tool === 'zoom') {
        event.preventDefault(); event.stopPropagation(); overlay.focus({ preventScroll: true });
        zoomBy(event.altKey ? -1 : 1, { x: event.clientX, y: event.clientY });
      } else if (event.button === 0 && event.target === stage && editable() && ['rect', 'ellipse', 'lasso'].includes(tool) && params.selectionMode === 'replace' && plainSelectionClick(event) && selection) {
        const bounds = stage.getBoundingClientRect();
        if (event.clientX >= bounds.left + stage.clientWidth || event.clientY >= bounds.top + stage.clientHeight) return;
        event.preventDefault(); overlay.focus({ preventScroll: true });
        blankSelectionClick = { id: event.pointerId, tool, clientX: event.clientX, clientY: event.clientY, moved: false };
        stage.setPointerCapture(event.pointerId);
      }
    }, true);
    stage.addEventListener('pointermove', event => {
      if (blankSelectionClick?.id === event.pointerId && Math.hypot(event.clientX - blankSelectionClick.clientX, event.clientY - blankSelectionClick.clientY) > 3) blankSelectionClick.moved = true;
      if (!panGesture || panGesture.id !== event.pointerId) return;
      stage.scrollLeft = panGesture.left - (event.clientX - panGesture.x);
      stage.scrollTop = panGesture.top - (event.clientY - panGesture.y);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(name, event => {
      if (panGesture?.id === event.pointerId) stopPan();
      if (blankSelectionClick?.id !== event.pointerId) return;
      const current = blankSelectionClick; blankSelectionClick = null;
      if (stage.hasPointerCapture(current.id)) stage.releasePointerCapture(current.id);
      if (name === 'pointerup' && tool === current.tool && params.selectionMode === 'replace' && !current.moved && Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) <= 3 && plainSelectionClick(event) && editable()) selectOperation('clear-selection');
    });
    stage.addEventListener('wheel', event => {
      if (!event.ctrlKey || !ready() || materialActive) return;
      event.preventDefault(); zoomBy(event.deltaY < 0 ? 1 : -1, { x: event.clientX, y: event.clientY });
    }, { passive: false });
    overlay.addEventListener('pointerdown', event => {
      if (!editable() || event.button !== 0 || gesture) return;
      event.preventDefault(); overlay.focus({ preventScroll: true }); const p = point(event);
      if (tool === 'eyedropper' || (tool === 'brush' && event.altKey)) { pickForeground(p); return; }
      if (['hand', 'zoom'].includes(tool)) return;
      if (tool === 'text') { placeText(p); return; }
      if (['brush', 'eraser', 'clone', 'pen', 'move'].includes(tool) && !layerWritable(true)) return;
      if (tool === 'clone' && event.altKey) { cloneAnchor = p; cloneOffset = null; message('已设置取样点。松开 Alt 后在目标位置涂抹'); paintOverlay(); return; }
      const current = { id: event.pointerId, tool, start: p, last: p, points: [p], phase: 0, clientX: event.clientX, clientY: event.clientY, moved: false, plainClick: plainSelectionClick(event) };
      if (['rect', 'ellipse', 'lasso'].includes(tool)) current.operation = event.altKey ? 'subtract' : event.shiftKey ? 'add' : params.selectionMode;
      else if (['crop', 'shape'].includes(tool)) { /* Preview first; commit only after drawing finishes. */ }
      else if (tool === 'move') { remember(); current.layer = activeLayer(); current.origin = { x: current.layer.x, y: current.layer.y }; }
      else if (tool === 'pen') {
        const scale = overlay.getBoundingClientRect().width / source.width;
        if (pen.length >= 3 && Math.hypot(p.x - pen[0].x, p.y - pen[0].y) * scale < 10) { penClosed = true; controls(); paintOverlay(); message('路径已闭合，可描边、填充或转选区'); return; }
        if (penClosed) { pen = []; penClosed = false; }
        pen.push({ ...p, ix: 0, iy: 0, ox: 0, oy: 0 }); current.node = pen.at(-1);
      } else {
        if (tool === 'clone') {
          if (!cloneAnchor) { message('先按住 Alt 单击图片，设置仿制取样点'); return; }
          if (!cloneOffset) cloneOffset = { x: p.x - cloneAnchor.x, y: p.y - cloneAnchor.y };
          cloneSource = copy(syncSource());
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
      if (Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) > 3) current.moved = true;
      if (current.tool === 'move') {
        let x = p.x - current.start.x, y = p.y - current.start.y;
        if (event.shiftKey) { if (Math.abs(x) >= Math.abs(y)) y = 0; else x = 0; }
        current.layer.x = Math.round(current.origin.x + x); current.layer.y = Math.round(current.origin.y + y); invalidate();
      }
      else if (current.tool === 'pen') { current.node.ox = p.x - current.node.x; current.node.oy = p.y - current.node.y; current.node.ix = -current.node.ox; current.node.iy = -current.node.oy; }
      else if (['crop', 'shape'].includes(current.tool)) {
        current.last = p;
        if (event.shiftKey) {
          const dx = p.x - current.start.x, dy = p.y - current.start.y;
          if (current.tool === 'shape' && shapeParams.type === 'line') { const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, length = Math.hypot(dx, dy); current.last = { x: current.start.x + Math.cos(angle) * length, y: current.start.y + Math.sin(angle) * length }; }
          else { const length = Math.max(Math.abs(dx), Math.abs(dy)); current.last = { x: current.start.x + Math.sign(dx || 1) * length, y: current.start.y + Math.sign(dy || 1) * length }; }
        }
      }
      else if (['rect', 'ellipse', 'lasso'].includes(current.tool)) { current.last = p; if (current.tool === 'lasso') current.points.push(p); }
      else { current.phase = paintLine(current.last, p, current.tool, current.phase); current.last = p; invalidate(); }
      if (['rect', 'ellipse', 'lasso', 'pen', 'crop', 'shape'].includes(current.tool)) paintOverlay();
    });
    overlay.addEventListener('pointerup', event => { if (gesture?.id === event.pointerId) endGesture(event); });
    overlay.addEventListener('pointercancel', event => { if (gesture?.id === event.pointerId) endGesture(event, true); });
    overlay.addEventListener('lostpointercapture', event => { if (gesture?.id === event.pointerId) endGesture(event, true); });
    overlay.addEventListener('pointerleave', () => { cursor.hidden = true; });
    overlay.tabIndex = 0;
    overlay.addEventListener('contextmenu', event => event.preventDefault());

    function selectOperation(action) {
      if (!ready() || gesture) return;
      if (action === 'clear-selection' && !selection) return;
      if (action === 'reselect' && !lastSelection) { message('没有可重新选择的选区'); return; }
      if (action === 'clear-pixels') {
        if (!layerWritable(true)) return;
        remember();
        if (selection) drawOnLayer(selection, 0, 0, 'destination-out');
        else { delete activeLayer().text; context(activeLayer().canvas).clearRect(0, 0, source.width, source.height); }
        markChanged(); message('已清除所选像素'); return;
      }
      remember();
      if (action === 'clear-selection') { lastSelection = selectionSnapshot; setMask(null); }
      else if (action === 'reselect') setMask(lastSelection);
      else {
        const data = context(source).createImageData(source.width, source.height);
        for (let at = 0; at < data.data.length; at += 4) { data.data[at] = data.data[at + 1] = data.data[at + 2] = 255; data.data[at + 3] = action === 'select-all' ? 255 : 255 - (selectionSnapshot?.data[at + 3] ?? 255); }
        setMask(data);
      }
      controls(); paintOverlay(); message(action === 'clear-selection' ? '已取消选区' : action === 'reselect' ? '已重新选择' : action === 'select-all' ? '已选择全部像素' : '已反选');
    }
    function penAction(action) {
      if (!ready() || gesture) return;
      if (action === 'pen-clear') { pen = []; penClosed = false; controls(); paintOverlay(); return; }
      if (action === 'pen-close') { if (pen.length >= 3) penClosed = true; controls(); paintOverlay(); return; }
      if (pen.length < (action === 'pen-stroke' ? 2 : 3)) return;
      if (action === 'pen-select') {
        const shape = canvas(source.width, source.height), ctx = context(shape); ctx.beginPath(); tracePath(ctx, pen, true); ctx.fillStyle = '#fff'; ctx.fill(); combineSelection(shape, params.selectionMode); return;
      }
      if (!layerWritable(true)) return;
      remember();
      if (action === 'pen-fill') {
        const layer = canvas(source.width, source.height), ctx = context(layer); ctx.beginPath(); tracePath(ctx, pen, true); ctx.fillStyle = params.color; ctx.globalAlpha = params.opacity / 100; ctx.fill(); ctx.globalAlpha = 1;
        if (selection) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selection, 0, 0); }
        drawOnLayer(layer);
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
      if (layerDoc.layers.some(item => item.locked)) { message('请先解锁图层再合并应用贴图'); return; }
      saving = true; controls(); message('正在应用全尺寸结果…');
      const current = session, token = generation;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      try {
        if (session !== current || generation !== token) return;
        const output = copy(generated(true)); remember(); const merged = layerDoc.flatten('贴图结果'); context(merged.canvas).clearRect(0, 0, source.width, source.height); context(merged.canvas).drawImage(output, 0, 0);
        resetMaps(); disposeMaterial(); mode = 'edit'; markChanged(); message('结果已应用，可继续绘画；Ctrl+Z 撤销');
      } catch (error) { message(error.message || String(error), true); }
      finally { if (session === current && generation === token) { saving = false; controls(); scheduleRender(); } }
    }
    async function contentAwareFill() {
      if (!ready() || !layerWritable(true) || !selection || !selectionHasPixels || gesture) return;
      const current = session, token = generation, controller = new AbortController();
      fillController = controller; saving = true; controls(); message('正在根据周围纹理填充…');
      try {
        const target = activeLayer(), localMask = canvas(source.width, source.height), maskContext = context(localMask);
        layerDoc.applyTransform(maskContext, target, true); maskContext.drawImage(selection, 0, 0);
        const localMaskData = maskContext.getImageData(0, 0, source.width, source.height);
        const input = context(target.canvas).getImageData(0, 0, source.width, source.height), mask = new Uint8Array(source.width * source.height);
        for (let i = 0; i < mask.length; i++) mask[i] = localMaskData.data[i * 4 + 3];
        const result = await window.ShituContentAwareFill.fill(input, mask, {
          signal: controller.signal,
          onProgress: progress => { if (session === current && generation === token) message(`正在根据周围纹理填充… ${Math.round(progress * 100)}%`); }
        });
        if (session !== current || generation !== token || controller.signal.aborted) return;
        remember(); delete target.text; context(target.canvas).putImageData(new ImageData(new Uint8ClampedArray(result.data), result.width, result.height), 0, 0);
        markChanged(); message('智能填充完成；可继续修图或撤销');
      } catch (error) {
        if (session === current && generation === token) message(controller.signal.aborted ? '已取消智能填充，图像未改变' : error.message || String(error), !controller.signal.aborted);
      } finally {
        if (session === current && generation === token) { fillController = null; saving = false; controls(); scheduleRender(); }
      }
    }
    async function readImage(bytes, type = 'image/png') {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      try { const image = new Image(); image.src = url; await image.decode(); return image; }
      finally { URL.revokeObjectURL(url); }
    }
    async function importLayers(files) {
      if (!ready() || gesture || materialActive || !files.length) return;
      if (mode !== 'edit') setMode('edit');
      const current = session, token = generation;
      saving = true; controls(); message('正在添加图片图层…');
      let added = 0; const failures = [];
      try {
        for (const file of files) {
          if (session !== current || generation !== token) return;
          if (layerDoc.layers.length >= window.ShituImageLayers.MAX_LAYERS || (layerDoc.layers.length + 1) * source.width * source.height > window.ShituImageLayers.MAX_PIXELS) { failures.push('已达到图层或总像素上限'); break; }
          try {
            if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB');
            if (!file.type?.startsWith('image/') && !/\.(png|jpe?g|webp|bmp|gif|avif|svg)$/i.test(file.name || '')) throw new Error('请选择图片文件');
            const image = await readImage(await file.arrayBuffer(), file.type || 'image/png');
            if (session !== current || generation !== token) return;
            if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16_777_216) throw new Error('图片超过 1677 万像素，请先缩小');
            if (!added) remember();
            layerDoc.add(file.name?.replace(/\.[^.]+$/, '') || '粘贴的图片', image);
            added += 1;
          } catch (error) { if (session !== current || generation !== token) return; failures.push(`${file.name || '图片'}：${error.message || '读取失败'}`); }
        }
        if (session !== current || generation !== token) return;
        if (added) { tool = 'move'; pen = []; penClosed = false; cloneAnchor = cloneOffset = cloneSource = null; markChanged(); }
        message(`${added ? `已添加 ${added} 个图片图层，可拖动调整位置` : '未添加图层'}${failures.length ? `；${failures.join('；')}` : ''}`, !added && failures.length > 0);
      } finally { if (session === current && generation === token) { saving = false; controls(); scheduleRender(); } }
    }
    async function open(asset, libraryRoot, initialTab = 'edit') {
      if (!root.hidden) { if (dirty) { $('.ie-discard').hidden = false; message('请先保存或放弃当前图片的更改'); return false; } if (saving) return false; }
      generation += 1; const token = generation;
      disposeMaterial();
      stopPan(); spacePan = false; blankSelectionClick = null;
      clearTimeout(updateTimer); cancelAnimationFrame(renderFrame); renderFrame = 0;
      if (root.hidden) previousFocus = document.activeElement;
      session = { asset, root: libraryRoot, ready: false }; const current = session;
      params = { ...defaultParams }; mode = initialTab === 'maps' ? 'maps' : 'edit'; tool = 'brush'; dirty = false; saving = false;
      cropRect = null; resizeParams = { width: 1, height: 1, lockRatio: true }; adjustParams = { brightness: 0, contrast: 0, saturation: 0 };
      textParams = { text: '输入文字', fontFamily: 'Microsoft YaHei', fontSize: 48, bold: false, align: 'left', lineHeight: 1.2 }; shapeParams = { type: 'rect', strokeWidth: 2, filled: true };
      backgroundColor = '#000000'; lastSelection = null; opacityKeys = null; nudgeKey = null; marqueeTool = 'rect';
      $('.ie-shortcuts').hidden = true; shortcutFocus = null; root.classList.remove('ie-panels-hidden', 'ie-layers-hidden');
      history = []; future = []; gesture = null; pen = []; penClosed = false; selection = selectionSnapshot = null; selectionHasPixels = false; cloneAnchor = cloneOffset = cloneSource = null;
      source = canvas(); original = canvas(); layerDoc = null; compositeDirty = false; layerEdit = null; layerListVersion = -1; previewCache = null; documentVersion = 0; stampCache = null;
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
        layerDoc = window.ShituImageLayers.create(source.width, source.height, source, asset.name || '背景');
        resizeParams.width = source.width; resizeParams.height = source.height;
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
      stopPan(); spacePan = false; blankSelectionClick = null;
      fillController?.abort(); fillController = null; saving = false;
      disposeMaterial();
      generation += 1; session = null; root.hidden = true; clearTimeout(updateTimer); cancelAnimationFrame(renderFrame); renderFrame = 0;
      lastSelection = null; opacityKeys = null; nudgeKey = null; shortcutFocus = null; $('.ie-shortcuts').hidden = true;
      cropRect = null;
      history = []; future = []; layerDoc = null; layerEdit = null; compositeDirty = false; source = canvas(); original = canvas(); selection = selectionSnapshot = null; selectionHasPixels = false; previewCache = stampCache = customBrush = cloneSource = null;
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
      if (button.dataset.action === 'shortcuts') { showShortcuts(true); return; }
      if (button.dataset.action === 'close-shortcuts') { showShortcuts(false); return; }
      if (button.dataset.layerSelect) { selectLayer(button.dataset.layerSelect); return; }
      if (button.dataset.layerAction) {
        if (!ready() || gesture || mode !== 'edit') return;
        const layer = layerDoc.layers.find(item => item.id === button.closest('[data-layer-id]').dataset.layerId);
        const key = button.dataset.layerAction;
        remember(); layer[key] = !layer[key]; markChanged(); return;
      }
      if (button.dataset.mode) { setMode(button.dataset.mode); return; }
      if (button.dataset.tool) { setTool(button.dataset.tool); return; }
      if (button.dataset.color) { if (ready()) { params.color = button.dataset.color; controls(); } return; }
      const action = button.dataset.action;
      if (action === 'export-psd') { void exportPsd(); return; }
      if (action === 'crop-apply') { applyCrop(); return; }
      if (action === 'crop-cancel') { cropRect = null; controls(); paintOverlay(); return; }
      if (action === 'crop-selection') { cropToSelection(); return; }
      if (action === 'resize-apply') {
        const width = Math.round(resizeParams.width), height = Math.round(resizeParams.height);
        transformDocument(width, height, { a: width / source.width, b: 0, c: 0, d: height / source.height, e: 0, f: 0 }, '尺寸调整'); return;
      }
      if (action === 'rotate-left') { transformDocument(source.height, source.width, { a: 0, b: -1, c: 1, d: 0, e: 0, f: source.width }, '左转'); return; }
      if (action === 'rotate-right') { transformDocument(source.height, source.width, { a: 0, b: 1, c: -1, d: 0, e: source.height, f: 0 }, '右转'); return; }
      if (action === 'flip-horizontal') { transformDocument(source.width, source.height, { a: -1, b: 0, c: 0, d: 1, e: source.width, f: 0 }, '水平翻转'); return; }
      if (action === 'flip-vertical') { transformDocument(source.width, source.height, { a: 1, b: 0, c: 0, d: -1, e: 0, f: source.height }, '垂直翻转'); return; }
      if (action === 'adjust-apply') { applyAdjustment(); return; }
      if (action === 'grayscale') { applyAdjustment({ grayscale: true }); return; }
      if (action === 'invert-image') { applyAdjustment({ invert: true }); return; }
      if (action === 'text-update') { const layer = activeLayer(); if (layer?.text) placeText({ x: layer.text.x, y: layer.text.y }, false, true); return; }
      if (action === 'watermark') { placeText({ x: 0, y: 0 }, true); return; }
      if (action?.startsWith('layer-')) { layerAction(action); return; }
      if (action?.startsWith('zoom-')) {
        if (action === 'zoom-fit') setZoom('fit'); else if (action === 'zoom-actual') setZoom(1); else zoomBy(action === 'zoom-in' ? 1 : -1);
        return;
      }
      if (action === 'reset-color') { if (ready()) resetColors(); return; }
      if (action === 'color-swap') { if (ready()) swapColors(); return; }
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
      opacityKeys = null; nudgeKey = null;
      if (event.target.hasAttribute('data-background-color') && ready()) { backgroundColor = event.target.value; return; }
      const basicKey = event.target.dataset.basicParam, adjustKey = event.target.dataset.adjustParam, textKey = event.target.dataset.textParam, shapeKey = event.target.dataset.shapeParam;
      if (basicKey && ready()) {
        if (basicKey === 'lockRatio') resizeParams.lockRatio = event.target.checked;
        else if (event.target.value && Number.isFinite(Number(event.target.value))) {
          resizeParams[basicKey] = clamp(Math.round(Number(event.target.value)), 1, 16384);
          if (resizeParams.lockRatio) { if (basicKey === 'width') resizeParams.height = Math.max(1, Math.round(resizeParams.width * source.height / source.width)); else resizeParams.width = Math.max(1, Math.round(resizeParams.height * source.width / source.height)); }
        }
        controls(); return;
      }
      if (adjustKey && ready()) { adjustParams[adjustKey] = clamp(Number(event.target.value) || 0, -100, 100); controls(); return; }
      if (textKey && ready()) { textParams[textKey] = event.target.type === 'checkbox' ? event.target.checked : textKey === 'fontSize' ? clamp(Number(event.target.value) || 1, 1, 4096) : event.target.value; controls(); return; }
      if (shapeKey && ready()) { shapeParams[shapeKey] = event.target.type === 'checkbox' ? event.target.checked : shapeKey === 'strokeWidth' ? clamp(Number(event.target.value) || 1, 1, 200) : event.target.value; controls(); return; }
      const layerKey = event.target.dataset.layerParam;
      if (layerKey) {
        if (!ready() || gesture || mode !== 'edit' || materialActive) return;
        const layer = activeLayer(); if (!layer) return;
        if (layer.locked && layerKey !== 'name') return;
        const limits = { x: [-100000, 100000], y: [-100000, 100000], scale: [1, 10000], rotation: [-360, 360], opacity: [0, 100] };
        let value;
        if (layerKey === 'name') value = event.target.value.slice(0, 160);
        else if (layerKey === 'blend') { if (!Object.hasOwn(window.ShituImageLayers.BLENDS, event.target.value)) return; value = event.target.value; }
        else { if (!(layerKey in limits) || event.target.value === '' || !Number.isFinite(Number(event.target.value))) return; value = clamp(Number(event.target.value), ...limits[layerKey]); }
        if (layer[layerKey] === value) return;
        const editKey = `${layer.id}:${layerKey}`;
        if (layerEdit !== editKey) { remember(); layerEdit = editKey; }
        layer[layerKey] = value; markChanged(); return;
      }
      const key = event.target.dataset.param; if (!key || !ready()) return;
      params[key] = event.target.type === 'checkbox' ? event.target.checked : ['color', 'preset', 'type', 'selectionMode'].includes(key) ? event.target.value : Number(event.target.value);
      const limits = { size: [1, 1000], opacity: [0, 100], hardness: [0, 100], spacing: [1, 100], feather: [0, 200] };
      if (key in limits) params[key] = clamp(Number(params[key]) || 0, ...limits[key]);
      if (key in mapOptions()) { dirty = true; previewCache = null; clearTimeout(updateTimer); updateTimer = setTimeout(scheduleRender, 75); }
      controls();
    });
    root.addEventListener('change', event => { if (event.target.dataset.layerParam) layerEdit = null; });
    root.addEventListener('pointerdown', () => { opacityKeys = null; nudgeKey = null; }, true);
    $('#imageEditorLayerFile').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; void importLayers(files); });
    for (const eventName of ['dragenter', 'dragleave']) root.addEventListener(eventName, event => { event.preventDefault(); event.stopPropagation(); });
    root.addEventListener('dragover', event => {
      event.preventDefault(); event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = ready() && !gesture && !materialActive ? 'copy' : 'none';
    });
    root.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer?.files?.length) void importLayers([...event.dataTransfer.files]); });
    root.addEventListener('paste', event => {
      if (event.target.closest('input, textarea, [contenteditable="true"]')) return;
      const files = [...(event.clipboardData?.items || [])].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); event.stopPropagation(); void importLayers(files); }
    });
    $$('[data-view]').forEach(node => node.addEventListener('change', () => { cursor.hidden = true; if (node.dataset.view === 'zoom') setZoom(node.value); else scheduleRender(); }));
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
      if (event.isComposing || event.keyCode === 229 || event.key === 'Process') return;
      const key = event.key.toLowerCase(), primary = event.ctrlKey || event.metaKey;
      if (!/^\d$/.test(key) || primary || event.altKey) opacityKeys = null;
      if (!key.startsWith('arrow')) nudgeKey = null;
      const typing = Boolean(event.target.closest('input, textarea, select') || event.target.isContentEditable);
      const interactive = Boolean(event.target.closest('button, input, select, textarea, a, summary, [role="button"], [contenteditable]'));
      const bracket = event.code === 'BracketLeft' || ['[', '{'].includes(event.key) ? -1 : event.code === 'BracketRight' || [']', '}'].includes(event.key) ? 1 : 0;
      const tabWithin = scope => {
        const focusable = [...scope.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(node => node.tabIndex >= 0 && node.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      };
      if (!$('.ie-shortcuts').hidden) {
        if (key === 'escape') { event.preventDefault(); showShortcuts(false); }
        else if (key === 'tab') tabWithin($('.ie-shortcuts'));
        event.stopImmediatePropagation(); return;
      }
      if ((!typing && key === '?' && !primary && !event.altKey) || key === 'f1' || (primary && event.altKey && event.shiftKey && key === 'k')) {
        event.preventDefault(); if (!event.repeat) showShortcuts(true); event.stopImmediatePropagation(); return;
      }
      if (key === 'f7' && !primary && !event.altKey) {
        event.preventDefault(); if (!event.repeat) { root.classList.toggle('ie-layers-hidden'); overlay.focus({ preventScroll: true }); scheduleRender(); } event.stopImmediatePropagation(); return;
      }
      if (primary && key === 's' && !event.altKey) {
        event.preventDefault(); if (!event.repeat) void save(event.shiftKey); event.stopImmediatePropagation(); return;
      }
      if (primary && event.altKey && event.shiftKey && key === 's') { event.preventDefault(); if (!event.repeat) void exportPsd(); event.stopImmediatePropagation(); return; }
      // Let native input editing and IME finish without interpreting their keys as canvas commands.
      if (typing) {
        if (key === 'escape' || (key === 'enter' && !event.target.closest('textarea,[contenteditable]'))) {
          event.preventDefault(); event.target.blur(); overlay.focus({ preventScroll: true }); event.stopImmediatePropagation();
        }
        return;
      }
      if (key === 'tab') {
        if (!interactive && !event.shiftKey) { event.preventDefault(); root.classList.toggle('ie-panels-hidden'); scheduleRender(); }
        else tabWithin(root);
      }
      else if (event.target === $('.ie-upload') && ['enter', ' '].includes(key) && ready()) { event.preventDefault(); $('#imageEditorBrushFile').click(); }
      else if (key === 'escape') {
        event.preventDefault();
        if (panGesture) stopPan(); else if (gesture) endGesture(null, true);
        else if (tool === 'crop') { cropRect = null; setTool('move'); controls(); paintOverlay(); }
        else if (pen.length) { pen = []; penClosed = false; controls(); paintOverlay(); }
        else if (selection && mode === 'edit') selectOperation('clear-selection'); else close();
      }
      else if (event.code === 'Space' && ready() && !interactive) { event.preventDefault(); if (!spacePan && !gesture) { spacePan = true; controls(); } }
      else if (primary && key === 'z') { event.preventDefault(); event.shiftKey && !event.altKey ? redo() : undo(); }
      else if (primary && key === 'a' && !event.altKey && mode === 'edit') { event.preventDefault(); selectOperation('select-all'); }
      else if (primary && key === 'd' && !event.altKey && mode === 'edit') { event.preventDefault(); selectOperation(event.shiftKey ? 'reselect' : 'clear-selection'); }
      else if (primary && event.shiftKey && key === 'i' && !event.altKey && mode === 'edit') { event.preventDefault(); selectOperation('invert-selection'); }
      else if (primary && key === 'j' && !event.altKey) { event.preventDefault(); if (!event.repeat) copySelectedLayer(event.shiftKey); }
      else if (primary && event.shiftKey && key === 'n') {
        event.preventDefault();
        if (!event.repeat && editingReady() && !$('[data-action="layer-add"]').disabled) { layerAction('layer-add'); if (!event.altKey) showLayerField('name'); }
      }
      else if (primary && bracket && !event.altKey) { event.preventDefault(); moveLayerInStack(bracket, event.shiftKey); }
      else if (event.altKey && bracket && !primary && !event.shiftKey) { event.preventDefault(); selectAdjacentLayer(bracket); }
      else if (primary && key === 't' && !event.altKey && !event.shiftKey) { event.preventDefault(); if (!event.repeat) showLayerField('scale'); }
      else if (primary && key === 'w' && !event.altKey) { event.preventDefault(); if (!event.repeat) close(); }
      else if (primary && key === 'enter' && tool === 'pen' && mode === 'edit') { event.preventDefault(); penAction('pen-select'); }
      else if (key === 'enter' && tool === 'crop' && mode === 'edit') { event.preventDefault(); applyCrop(); }
      else if ((primary || event.altKey) && key === 'backspace' && !event.shiftKey) { event.preventDefault(); if (!event.repeat) fillWithColor(event.altKey ? params.color : backgroundColor); }
      else if (primary && !event.altKey && ['+', '=', '-', '_', '0', '1', '2'].includes(key)) {
        event.preventDefault();
        if (key === '0') setZoom('fit'); else if (key === '1') setZoom(1); else if (key === '2') setZoom(2); else zoomBy(['+', '='].includes(key) ? 1 : -1);
      }
      else if (!primary && !event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && tool === 'move') { event.preventDefault(); nudgeLayer(event.key, event.shiftKey ? 10 : 1); }
      else if (!primary && !event.altKey && key === 'backspace' && tool === 'pen' && pen.length) { event.preventDefault(); pen.pop(); penClosed = false; controls(); paintOverlay(); }
      else if (!primary && !event.altKey && ['delete', 'backspace'].includes(key) && editingReady()) {
        event.preventDefault();
        if (selection) selectOperation('clear-pixels');
        else if (!$('[data-action="layer-delete"]').disabled) layerAction('layer-delete');
        else message('请先建立选区；至少保留一个图层');
      }
      else if (bracket && !primary && !event.altKey && ready() && ['brush', 'eraser', 'clone', 'pen'].includes(tool)) {
        event.preventDefault();
        if (event.shiftKey) params.hardness = clamp(params.hardness + bracket * 25, 0, 100);
        else params.size = clamp(params.size + bracket * (params.size >= 100 ? 10 : params.size >= 10 ? 5 : 1), 1, 1000);
        controls();
      }
      else if (/^\d$/.test(key) && !primary && !event.altKey && !event.shiftKey) { event.preventDefault(); if (!event.repeat) keyboardOpacity(key); }
      else if (key === 'd' && !primary && !event.altKey && ready()) { event.preventDefault(); resetColors(); }
      else if (key === 'x' && !primary && !event.altKey && ready()) { event.preventDefault(); swapColors(); }
      else if (['v', 'c', 't', 'u', 'b', 'e', 's', 'p', 'm', 'l', 'i', 'h', 'z'].includes(key) && !primary && !event.altKey) {
        event.preventDefault();
        if (!event.repeat) { if (key === 'u' && event.shiftKey) shapeParams.type = ['rect', 'ellipse', 'line'][(['rect', 'ellipse', 'line'].indexOf(shapeParams.type) + 1) % 3]; setTool({ v: 'move', c: 'crop', t: 'text', u: 'shape', b: 'brush', e: 'eraser', s: 'clone', p: 'pen', m: event.shiftKey ? marqueeTool === 'rect' ? 'ellipse' : 'rect' : marqueeTool, l: 'lasso', i: 'eyedropper', h: 'hand', z: 'zoom' }[key]); }
      }
      // Isolate editor shortcuts from the library underneath this dialog.
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener('keyup', event => {
      if (root.hidden) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key.startsWith('Arrow')) nudgeKey = null;
      if (event.code === 'Space' && spacePan) { spacePan = false; controls(); event.preventDefault(); }
      if (!event.target.closest('input, textarea, select, [contenteditable]')) event.stopImmediatePropagation();
    }, true);
    window.addEventListener('blur', () => { spacePan = false; opacityKeys = null; nudgeKey = null; stopPan(); blankSelectionClick = null; if (!root.hidden) controls(); });
    return { open, close, canCloseApp, isOpen: () => !root.hidden };
  }
  window.ShituImageEditor = Object.freeze({ create });
})();
