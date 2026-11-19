'use strict';

const api = window.shitu;
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const folderTree = window.ShituFolders;
const folderNavigation = window.ShituFolderNavigation.create({ limit: 80 });
const colorLabels = window.ShituColorLabels;
const folderIcons = window.ShituFolderIcons;
const historyControls = window.ShituHistoryUi;
const assetHealth = window.ShituAssetHealth;
const bundleDetails = window.ShituBundleDetails;
const state = { library: { assets: [], folders: [], smartFolders: [], tags: [], stats: {}, root: null, needsLibrary: true }, view: 'all', folder: null, smartFolder: null, tag: null, selected: new Set(), selectionMode: false, anchor: null, search: '', format: 'all', missingResources: false, sort: 'newest', limit: 240, previewId: null, details: false, busy: false, libraryChanging: false };
let modalResolve = null;
let modalHasParent = false;
let modalHasColor = false;
let folderMenuAnchor = null;
const collapsedFolders = new Set();
let folderPanelMode = 'dropdown';
const folderPanelStorageKey = 'shitu-folder-panel-mode';
let metadataQueue = Promise.resolve(true);
const pendingSaves = new Set();
let closeReady = false;
let closing = false;
let libraryRefreshSerial = 0;
let draggingAssets = false;
let draggingFolders = false;
let folderMoveSaving = false;
let suppressFolderClickUntil = 0;
let folderDragPosition = null;
let folderDragPayload = null;
let folderDragScrollFrame = 0;
let folderDragExpandTimer = null;
let folderDragExpandId = null;
let folderDragTarget = null;
let nativeAssetDrag = false;
let dragTargetNode = null;
let dragPosition = null;
let dragScrollFrame = 0;
let dragOpenedMenu = false;
let suppressAssetClickUntil = 0;
let marquee = null;
let marqueeFrame = 0;
let suppressMarqueeClick = false;
let deletingAssets = false;
let activeExport = null;
let pendingBundleCheck = null;
let videoPreviewSerial = 0;
let videoPreviewRequestSerial = 0;
let videoPreviewSession = null;
let projectPreviewView;
let modelViewer;
let modelViewerModule;
let fontPreviewSession = null;
let fontPreviewText = null;
let fontPreviewSize = 72;
let fontPreviewLayout = window.ShituFontLayout.normalizeSettings();
let fontPreviewExporting = false;
const fontLayoutFields = {
  writingMode: 'fontPreviewWritingMode',
  width: 'fontPreviewWidth', height: 'fontPreviewHeight', align: 'fontPreviewAlign', verticalAlign: 'fontPreviewVerticalAlign',
  letterSpacing: 'fontPreviewLetterSpacing', lineHeight: 'fontPreviewLineHeight', paddingTop: 'fontPreviewPaddingTop',
  paddingRight: 'fontPreviewPaddingRight', paddingBottom: 'fontPreviewPaddingBottom', paddingLeft: 'fontPreviewPaddingLeft',
  textColor: 'fontPreviewTextColor', backgroundColor: 'fontPreviewBackgroundColor', transparent: 'fontPreviewTransparent'
};
const audioPreview = window.ShituAudioPreview.create({
  panel: $('previewAudio'), audio: $('previewAudioPlayer'), title: $('previewAudioTitle'),
  artist: $('previewAudioArtist'), album: $('previewAudioAlbum'), details: $('previewAudioMeta'),
  status: $('previewAudioStatus'), retry: $('previewAudioRetry'), artwork: $('previewAudioArtwork'),
  placeholder: $('previewAudioPlaceholder'), loop: $('previewAudioLoop'), assetUrl: api.assetUrl,
  prepare: (id, root, token) => api.prepareAudioPreview(id, root, token),
  cancel: token => api.cancelAudioPreview?.(token),
  current: (asset, root) => state.previewId === asset.id && state.library.root === root && !state.libraryChanging,
  onMetadata: (asset, prepared) => { $('previewMeta').textContent = [asset.ext.toUpperCase(), window.ShituAudioPreview.metadata({ ...asset, ...prepared }), size(asset.size)].filter(Boolean).join('  ·  '); }
});
const galleryPreviewGuards = {
  allowed: () => !state.selectionMode && !state.previewId && !state.busy && !state.libraryChanging &&
    !draggingAssets && !draggingFolders && !folderMoveSaving && !deletingAssets && !closing && !document.hidden && !featureDialogOpen() &&
    !document.querySelector('.modal-overlay:not(.hidden),.preview:not(.hidden),.sp-overlay:not([hidden])') &&
    $('folderContextMenu').classList.contains('hidden'),
  current: (asset, root) => state.library.root === root && state.library.assets.some(item => item.id === asset.id && item.hash === asset.hash)
};
const videoHover = window.ShituVideoHover.create({
  ...galleryPreviewGuards,
  prepare: (id, root, token) => api.prepareVideo(id, root, token, 'hover'),
  cancel: (id, root, token) => api.cancelVideo(id, root, token)
});
const modelHover = window.ShituModelHover.create({
  ...galleryPreviewGuards,
  prepare: api.prepareModelHover,
  cancel: api.cancelModelHover
});
const modelWarmup = window.ShituModelWarmup.create({
  viewport: $('galleryScroller'),
  allowed: () => document.hasFocus() && galleryPreviewGuards.allowed() && !transcodeActive() &&
    !assetFolderDrag.pending && !document.querySelector('.asset-thumb[data-video-hover-state], .asset-thumb[data-model-hover-state]'),
  prepare: api.warmModelHover,
  cancel: api.cancelModelWarmup
});
function stopGalleryPreviews(options) {
  videoHover.stop(options);
  modelHover.stop();
}
const assetFolderDrag = window.ShituAssetFolderDrag.create({
  prepare: prepareAssetFolderDrag,
  current: assetDragIsCurrent,
  targetAt: assetDropTarget,
  outside: event => event.clientX <= 0 || event.clientY <= 0 || event.clientX >= innerWidth - 1 || event.clientY >= innerHeight - 1,
  start: startPointerAssetDrag,
  move: positionPointerAssetDrag,
  target: highlightAssetDropTarget,
  finish: finishPointerAssetDrag,
  drop: (payload, destination) => { void run(() => moveDraggedAssets(payload, destination)); },
  external: startExternalAssetDrag,
  error: messageError
});
const folderTreeDrag = window.ShituFolderTreeDrag.create({
  prepare: prepareFolderTreeDrag,
  current: folderTreeDragIsCurrent,
  targetAt: folderTreeDropTarget,
  start: startFolderTreeDrag,
  move: positionFolderTreeDrag,
  target: highlightFolderTreeTarget,
  finish: finishFolderTreeDrag,
  drop: (payload, destination) => { void run(() => moveDraggedFolder(payload, destination)); },
  error: messageError
});
const updateUi = {
  snapshot: { status: 'idle', currentVersion: '', latestVersion: '', progress: 0 },
  pending: false, preparingInstall: false, previousFocus: null, notices: new Set(), revision: 0
};
const transcodeUi = { snapshot: null, ids: [], root: null, pending: false, error: '', previousFocus: null, notified: new Set(),
  presets: [], presetId: '', presetEditing: false, presetPending: false };
const transcodeSettingsUi = { settings: { mode: 'auto', cpuThreads: 1, gpuId: 'auto' }, draft: null, devices: null, loading: false, saving: false, error: '', previousFocus: null, returnToTranscode: false, revision: 0 };
const historyUi = { snapshot: null, pending: false, revision: 0, seen: new Set(), warning: '' };
const skinPickerUi = window.ShituSkinPicker.create({ skins: window.ShituSkins });
const smartFolders = window.ShituSmartFolders;
const batchRenameUi = window.ShituBatchRename.create({
  apply: (changes, root) => api.batchRenameAssets(changes, root),
  onApplied: (snapshot, detail) => { if (snapshot.root === state.library.root) { applyLibrary(snapshot); toast(`已重命名 ${detail.changedCount} 个素材，可撤销`); } },
  onError: messageError
});
const fontCompareUi = window.ShituFontCompare.create({ prepare: (id, root, face) => api.prepareFont(id, root, face), onError: messageError });
const smartFoldersUi = window.ShituSmartFoldersUi.create({
  save: (value, root) => api.saveSmartFolder(value, root),
  remove: (id, root) => api.deleteSmartFolder(id, root),
  onApplied: snapshot => { if (snapshot.root === state.library.root) applyLibrary(snapshot); }, onError: messageError,
  getContext: () => ({ root: state.library.root })
});
const folderIconsUi = window.ShituFolderIconsUi.create({
  setIcon: (id, name, root) => saveFolderAppearance(root, () => api.setFolderIcon(id, name, root)),
  setColor: (id, color, root) => saveFolderAppearance(root, () => api.setFolderIconColor(id, color, root)),
  chooseImage: (id, root) => saveFolderAppearance(root, () => api.chooseFolderIcon(id, root)),
  getContext: () => ({ root: state.library.root, folders: state.library.folders }),
  onClose: id => $('folderNav').querySelector(`.nav-item[data-folder-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
});
const similarImagesUi = window.ShituSimilarImages.create({
  find: api.findSimilarImages, cancel: api.cancelSimilarImages, assetUrl: api.assetUrl,
  lookupAsset: id => state.library.assets.find(asset => asset.id === id && !asset.trashedAt),
  onLocate: id => run(async () => {
    const root = state.library.root;
    if (!await waitForMetadata() || root !== state.library.root) return;
    const asset = state.library.assets.find(item => item.id === id && !item.trashedAt);
    if (asset) showAssetInOverview(asset, state.library);
  })
});
function featureDialogOpen() { return skinPickerUi.isOpen() || batchRenameUi.isOpen() || fontCompareUi.isOpen() || smartFoldersUi.isOpen() || folderIconsUi.isOpen() || similarImagesUi.isOpen(); }
function activeSmartFolder() { return (state.library.smartFolders || []).find(folder => folder.id === state.smartFolder) || null; }
async function openBatchRename(ids = [...state.selected]) {
  const root = state.library.root;
  if (!await waitForMetadata() || root !== state.library.root) return;
  const wanted = new Set(ids), assets = filteredAssets().filter(asset => wanted.has(asset.id) && !asset.trashedAt);
  if (!assets.length) return;
  closePreview(); stopGalleryPreviews(); batchRenameUi.open(assets, root);
}
async function openFontCompare(ids = [...state.selected]) {
  const root = state.library.root;
  if (!await waitForMetadata() || root !== state.library.root) return;
  const wanted = new Set(ids), assets = filteredAssets().filter(asset => wanted.has(asset.id) && !asset.trashedAt && isFont(asset));
  if (assets.length < 2) { toast('请选择至少两份字体进行对比'); return; }
  closePreview(); stopGalleryPreviews(); fontCompareUi.open(assets, root);
}
async function openSmartFolderEditor(item = null) {
  if (activeExport) return;
  const root = state.library.root;
  if (!await waitForMetadata() || root !== state.library.root) return;
  closePreview(); stopGalleryPreviews();
  const mediaType = state.format === 'images' ? 'image' : ['video', 'audio', 'font', 'model', 'project'].includes(state.format) ? state.format : 'all';
  smartFoldersUi.open(item, root, { mediaType, colorLabel: null, recentDays: state.view === 'recent' ? 7 : 0, search: state.search, favorite: state.view === 'favorites' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const node = document.createElementNS(SVG, 'svg');
  node.setAttribute('class', 'icon');
  node.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  node.append(use);
  return node;
}
function folderIcon(folder) {
  return window.ShituFolderIconView.create(folder, { imageUrl: folderIcons.iconUrl, fallbackColor: colorLabels.get(folder?.colorLabel)?.color });
}
async function saveFolderAppearance(root, operation) {
  flushDetailDrafts();
  let snapshot = null, failure = null;
  await saveMetadata(async () => {
    try {
      if (state.library.root !== root || state.libraryChanging) throw new Error('素材库已切换，请重新设置图标');
      snapshot = await operation();
      return state.library.root === root ? snapshot : null;
    } catch (error) { failure = error; throw error; }
  });
  if (failure) throw failure;
  return state.library.root === root ? snapshot : null;
}
async function openFolderIconEditor(folder) {
  if (activeExport) return;
  folderTreeDrag.cancel(); assetFolderDrag.cancel(); closeFolderMenu(); stopGalleryPreviews();
  const root = state.library.root;
  if (!await waitForMetadata() || state.library.root !== root || state.libraryChanging) return;
  const current = state.library.folders.find(item => item.id === folder.id);
  if (current) folderIconsUi.open(current, root);
}
function action(label, className, handler, glyph) {
  const node = el('button', className);
  node.type = 'button';
  if (glyph) node.append(icon(glyph));
  node.append(document.createTextNode(label));
  if (handler) node.addEventListener('click', handler);
  return node;
}
function colorMarker(value, className = '') {
  const color = colorLabels.get(value);
  if (!color) return null;
  const marker = el('span', `color-label-mark ${className}`.trim());
  marker.dataset.colorLabel = color.id;
  marker.style.setProperty('--label-color', color.color);
  marker.title = `颜色标记：${color.name}`;
  marker.setAttribute('role', 'img');
  marker.setAttribute('aria-label', marker.title);
  return marker;
}
function colorPicker({ id, value = null, mixed = false, onChange }) {
  const picker = el('div', 'color-label-picker');
  picker.id = id;
  picker.dataset.colorMixed = String(mixed);
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', '颜色标记');
  const colors = el('div', 'color-label-options');
  const options = [{ id: null, name: '无颜色', color: null }, ...colorLabels.palette];
  for (const option of options) {
    const selected = !mixed && (value || null) === option.id;
    const button = action('', `color-label-swatch${option.id ? '' : ' color-label-clear'}`, () => onChange(option.id), option.id ? null : 'close');
    button.id = `${id}-${option.id || 'none'}`;
    button.dataset.colorLabel = option.id || '';
    button.dataset.colorSelected = String(selected);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', option.id ? `标记为${option.name}` : '清除颜色标记');
    button.title = option.id ? option.name : '清除颜色标记';
    if (option.color) button.style.setProperty('--label-color', option.color);
    colors.append(button);
  }
  colors.addEventListener('keydown', event => {
    if ([' ', 'Enter'].includes(event.key)) { event.stopPropagation(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...colors.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  });
  const chosen = colorLabels.get(value);
  const custom = action('', 'color-label-custom', () => run(async () => {
    const selected = await chooseCustomColor(!mixed ? value : null);
    if (selected !== null) await onChange(selected);
  }));
  custom.id = `${id}-custom`;
  custom.dataset.colorAction = 'custom';
  custom.dataset.colorSelected = String(!mixed && Boolean(chosen?.custom));
  custom.setAttribute('aria-haspopup', 'dialog');
  custom.setAttribute('aria-pressed', String(!mixed && Boolean(chosen?.custom)));
  custom.setAttribute('aria-label', '自定义颜色');
  if (!mixed && chosen?.custom) {
    custom.append(colorMarker(chosen.id), document.createTextNode(chosen.name));
  } else custom.append(document.createTextNode('自定义颜色…'));
  custom.addEventListener('keydown', event => {
    if ([' ', 'Enter'].includes(event.key)) event.stopPropagation();
  });
  const caption = el('span', 'color-label-caption', mixed ? '多种颜色' : chosen?.custom ? '点击色号调整颜色' : chosen?.name || '无颜色');
  caption.setAttribute('aria-live', 'polite');
  picker.append(colors, custom, caption);
  return picker;
}
function chooseCustomColor(value) {
  const initial = colorLabels.get(value)?.color || '#789fe8';
  return modal({ title: '自定义标记颜色', description: '点击色块选择颜色，或输入 #RGB / #RRGGBB 色号。', input: false, confirm: '应用颜色', colorValue: initial });
}
function readCustomColor(showError = false) {
  const text = $('modalColorHex').value.trim();
  const valid = /^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(text);
  if (!valid) {
    if (showError) {
      $('modalColorHex').setAttribute('aria-invalid', 'true');
      $('modalColorError').textContent = '请输入有效的颜色，例如 #5AF 或 #55AAFF。';
      $('modalColorError').classList.remove('hidden');
    }
    return null;
  }
  const normalized = colorLabels.normalize(text);
  $('modalColorPicker').value = normalized;
  $('modalColorHex').removeAttribute('aria-invalid');
  $('modalColorError').classList.add('hidden');
  return normalized;
}
function saveAssetColor(ids, value, root = state.library.root) {
  const colorLabel = colorLabels.normalize(value);
  return saveMetadata(() => {
    if (state.library.root !== root || state.libraryChanging) throw new Error('素材库已切换，请重新选择素材');
    return api.updateAssets(ids, { colorLabel });
  });
}
async function saveFolderColor(id, value, root) {
  closeFolderMenu();
  const colorLabel = colorLabels.normalize(value);
  if (!await waitForMetadata() || state.library.root !== root || state.libraryChanging) return;
  const saved = await saveMetadata(() => {
    if (state.library.root !== root || state.libraryChanging) throw new Error('素材库已切换，请重新选择文件夹');
    return api.setFolderColor(id, colorLabel);
  });
  if (saved) toast(colorLabel ? `文件夹已标记为${colorLabels.get(colorLabel).name}` : '已清除文件夹颜色标记');
}
function size(bytes) {
  if (!Number.isFinite(Number(bytes))) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
function date(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function dimensions(a) { return isAudio(a) ? (videoDuration(a.duration) || '音乐素材') : isFont(a) ? (a.font?.style || '字体') : isProject(a) ? 'AE 工程' : isModel(a) ? '3D 模型' : a.width && a.height ? `${a.width} × ${a.height}` : '尺寸未知'; }
function videoDuration(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '';
  const seconds = Math.round(Number(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
function transcodeActive(snapshot = transcodeUi.snapshot) { return ['running', 'cancelling'].includes(snapshot?.status); }
function transcodeMessage(error) {
  return String(error?.message || error || '视频转码失败，请重试').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}
function transcodeBitrate() {
  const value = Number($('videoTranscodeBitrate').value);
  return Number.isFinite(value) && value >= 0.5 && value <= 200 ? value : null;
}
function transcodeModeName(mode) { return ({ auto: '自动选择', cpu: 'CPU', gpu: 'GPU', hybrid: 'CPU + GPU 双线' })[mode] || '自动选择'; }
function transcodeSettingsError() {
  const draft = transcodeSettingsUi.draft || transcodeSettingsUi.settings;
  const maximum = Math.min(64, Number(transcodeSettingsUi.devices?.cpu?.logicalProcessors) || 1);
  if (!Number.isInteger(Number(draft.cpuThreads)) || Number(draft.cpuThreads) < 1 || Number(draft.cpuThreads) > maximum) return `CPU 线程数需为 1–${maximum} 之间的整数。`;
  const available = (transcodeSettingsUi.devices?.gpus || []).filter(gpu => gpu.available);
  if (['gpu', 'hybrid'].includes(draft.mode) && !available.length) return '未检测到可用的 GPU 编码器，请选择 CPU 或自动选择。';
  if (draft.mode !== 'cpu' && draft.gpuId !== 'auto' && !available.some(gpu => gpu.id === draft.gpuId)) return '所选 GPU 当前不可用，请重新选择设备。';
  return '';
}
function renderTranscodeSettings() {
  const ui = transcodeSettingsUi, draft = ui.draft || ui.settings, busy = ui.loading || ui.saving;
  const maximum = Math.min(64, Number(ui.devices?.cpu?.logicalProcessors) || 1);
  $('transcodeSettingsOptions').disabled = busy || !ui.devices;
  $('transcodeSettingsMode').value = draft.mode;
  $('transcodeSettingsCpuName').textContent = ui.devices?.cpu?.name || (ui.loading ? '正在检测 CPU…' : '尚未检测');
  $('transcodeSettingsCpuThreads').max = String(maximum);
  $('transcodeSettingsCpuThreads').value = String(draft.cpuThreads);
  $('transcodeSettingsCpuHint').textContent = ui.devices ? `${ui.devices.cpu.logicalProcessors} 个逻辑处理器，最多使用 ${maximum} 个线程；线程数越多，CPU 占用通常越高。` : '检测后可选择使用的 CPU 线程数。';
  const gpuSelect = $('transcodeSettingsGpu'), automatic = el('option', '', '自动选择可用 GPU');
  automatic.value = 'auto';
  const options = (ui.devices?.gpus || []).map(gpu => {
    const option = el('option', '', `${gpu.name}${gpu.available ? '' : '（不可用）'}`);
    option.value = gpu.id; option.disabled = !gpu.available; return option;
  });
  if (draft.gpuId !== 'auto' && !options.some(option => option.value === draft.gpuId)) {
    const missing = el('option', '', '之前选择的 GPU（当前不可用）'); missing.value = draft.gpuId; missing.disabled = true; options.push(missing);
  }
  gpuSelect.replaceChildren(automatic, ...options); gpuSelect.value = draft.gpuId;
  gpuSelect.disabled = busy || !ui.devices || draft.mode === 'cpu';
  const unavailable = (ui.devices?.gpus || []).filter(gpu => !gpu.available);
  $('transcodeSettingsDeviceNotes').replaceChildren(...unavailable.map(gpu => el('li', '', `${gpu.name}：${gpu.error || '硬件编码检测未通过。'}`)));
  $('transcodeSettingsDeviceNotes').classList.toggle('hidden', !unavailable.length);
  const availableCount = (ui.devices?.gpus || []).filter(gpu => gpu.available).length;
  $('transcodeSettingsGpuHint').textContent = ui.loading ? '正在检测硬件编码能力，首次检测可能需要几秒…' : !ui.devices ? '点击重新检测读取设备。' : availableCount ? `检测到 ${availableCount} 个可用 GPU 编码器。` : '未检测到可用 GPU 编码器；自动模式会使用 CPU。';
  $('transcodeSettingsModeHint').textContent = draft.mode === 'hybrid' ? '批量 MP4 同时运行一个 CPU 任务和一个 GPU 任务；单个视频使用 GPU 编码、CPU 处理。' : draft.mode === 'auto' ? 'MP4 优先使用可用 GPU，硬件编码不可用时回退 CPU。' : draft.mode === 'gpu' ? 'MP4 使用所选 GPU 编码，CPU 负责其余处理。' : 'MP4 使用 CPU 编码，可调整线程数。';
  const error = ui.error || (!ui.loading && ui.devices ? transcodeSettingsError() : '');
  $('transcodeSettingsStatus').textContent = error || (ui.loading ? '正在检测设备…' : ui.saving ? '正在保存…' : '保存后用于下一次转码；正在运行的任务保持原设置。');
  $('transcodeSettingsStatus').classList.toggle('is-error', Boolean(error));
  $('transcodeSettingsRefresh').disabled = busy;
  $('transcodeSettingsSave').disabled = busy || !ui.devices || Boolean(error);
  $('transcodeSettingsSave').textContent = ui.saving ? '正在保存…' : '保存设置';
}
async function loadTranscodeSettings(refresh = false) {
  const ui = transcodeSettingsUi, revision = ++ui.revision;
  ui.loading = true; ui.error = ''; renderTranscodeSettings();
  try {
    if (!api.getTranscodeDevices || !api.getTranscodeSettings) throw new Error('当前版本暂不支持转码设备设置。');
    const [devices, settings] = await Promise.all([api.getTranscodeDevices(refresh), api.getTranscodeSettings()]);
    if (revision !== ui.revision) return;
    ui.devices = devices; ui.settings = settings;
    if (!refresh || !ui.draft) ui.draft = { ...settings };
  } catch (error) { if (revision === ui.revision) ui.error = transcodeMessage(error); }
  finally { if (revision === ui.revision) { ui.loading = false; renderTranscodeSettings(); renderVideoTranscode(); } }
}
function openTranscodeSettings() {
  const ui = transcodeSettingsUi;
  folderTreeDrag.cancel(); assetFolderDrag.cancel(); stopGalleryPreviews(); closeFolderMenu();
  if (state.previewId) closePreview();
  ui.previousFocus = document.activeElement;
  ui.returnToTranscode = !$('videoTranscodeOverlay').classList.contains('hidden');
  if (ui.returnToTranscode) $('videoTranscodeOverlay').classList.add('hidden');
  ui.draft = { ...ui.settings }; ui.error = '';
  $('transcodeSettingsOverlay').classList.remove('hidden'); renderTranscodeSettings();
  $('transcodeSettingsDialog').focus(); void loadTranscodeSettings();
}
function closeTranscodeSettings() {
  const ui = transcodeSettingsUi;
  if (ui.saving) return;
  $('transcodeSettingsOverlay').classList.add('hidden');
  if (ui.returnToTranscode) { $('videoTranscodeOverlay').classList.remove('hidden'); renderVideoTranscode(); }
  ui.returnToTranscode = false;
  if (ui.previousFocus?.isConnected) ui.previousFocus.focus();
}
async function saveTranscodeSettings() {
  const ui = transcodeSettingsUi;
  if (ui.loading || ui.saving || !ui.devices) return;
  ui.error = transcodeSettingsError(); if (ui.error) { renderTranscodeSettings(); return; }
  ui.saving = true; renderTranscodeSettings();
  try {
    ui.settings = await api.saveTranscodeSettings({ mode: ui.draft.mode, cpuThreads: Number(ui.draft.cpuThreads), gpuId: ui.draft.gpuId });
    ui.draft = { ...ui.settings }; ui.saving = false; closeTranscodeSettings(); renderVideoTranscode(); toast('转码设备设置已保存。');
  } catch (error) { ui.error = transcodeMessage(error); }
  finally { ui.saving = false; renderTranscodeSettings(); }
}
function transcodeDraft() {
  const format = $('videoTranscodeFormat').value;
  if (format === 'dxv') return { format, alpha: $('videoTranscodeAlpha').checked };
  const bitrateMbps = transcodeBitrate();
  return format === 'mp4' && bitrateMbps !== null ? { format, bitrateMbps } : null;
}
function renderTranscodePresetOptions() {
  const select = $('transcodePreset');
  select.replaceChildren(new Option('自定义参数', ''));
  for (const preset of transcodeUi.presets) select.add(new Option(preset.name, preset.id));
  select.value = transcodeUi.presetId;
}
function applyTranscodePreset(preset) {
  transcodeUi.presetId = preset?.id || '';
  if (!preset) return;
  $('videoTranscodeFormat').value = preset.format;
  $('videoTranscodeAlpha').checked = Boolean(preset.alpha);
  if (preset.format === 'mp4') {
    const value = String(preset.bitrateMbps);
    $('videoTranscodeBitrate').value = value;
    $('videoTranscodeBitratePreset').value = ['5', '10', '20', '40', '80'].includes(value) ? value : 'custom';
  }
}
async function changeTranscodePreset(operation) {
  if (transcodeUi.presetPending || transcodeUi.pending || transcodeUi.snapshot?.id) return;
  const preset = transcodeDraft(), name = $('transcodePresetName').value.trim();
  if (operation === 'save' && (!preset || !name)) return;
  transcodeUi.presetPending = true;
  transcodeUi.error = '';
  renderVideoTranscode();
  try {
    transcodeUi.presets = operation === 'save'
      ? await api.saveTranscodePreset({ name, ...preset })
      : await api.removeTranscodePreset(transcodeUi.presetId);
    transcodeUi.presetId = operation === 'save' ? transcodeUi.presets.at(-1).id : '';
    transcodeUi.presetEditing = false;
    renderTranscodePresetOptions();
    toast(operation === 'save' ? '转码预设已保存' : '转码预设已删除');
  } catch (error) { transcodeUi.error = transcodeMessage(error); }
  finally { transcodeUi.presetPending = false; renderVideoTranscode(); }
}
function renderVideoTranscode() {
  const job = transcodeUi.snapshot, active = transcodeActive(job), hasJob = Boolean(job?.id);
  const format = hasJob ? job.format : $('videoTranscodeFormat').value;
  const total = hasJob ? Number(job.total) || 0 : transcodeUi.ids.length;
  $('videoTranscodeTitle').textContent = total > 1 ? '批量视频转码' : '视频转码';
  $('videoTranscodeSummary').textContent = hasJob ? `${total} 个视频 · ${job.format === 'dxv' ? `DXV Normal${job.alpha ? ' · 保留透明通道' : ''} · MOV` : `MP4 · ${job.bitrateMbps} Mbps`}` : `已选择 ${total} 个视频，转码结果保存为新素材。`;
  $('videoTranscodeDeviceSummary').textContent = format === 'dxv' ? 'DXV 使用 CPU；GPU 与双线编码适用于 MP4。' : `转码设备：${transcodeModeName(hasJob ? job.executionMode || 'cpu' : transcodeSettingsUi.settings.mode)}`;
  $('videoTranscodeExecutionNotice').textContent = job?.executionNotice || (!hasJob && format === 'mp4' && transcodeSettingsUi.settings.mode === 'hybrid' ? '批量视频由 CPU 与 GPU 同时处理；单个视频使用 GPU 编码。' : '');
  $('videoTranscodeSettings').disabled = transcodeUi.pending;
  if (hasJob) { $('videoTranscodeFormat').value = job.format; $('videoTranscodeAlpha').checked = Boolean(job.alpha); if (job.format === 'mp4') $('videoTranscodeBitrate').value = String(job.bitrateMbps); }
  $('videoTranscodeOptions').disabled = transcodeUi.pending || transcodeUi.presetPending || hasJob;
  $('transcodePreset').value = transcodeUi.presetId;
  $('transcodePresetAdd').disabled = transcodeUi.presetEditing || !transcodeDraft();
  $('transcodePresetRemove').classList.toggle('hidden', !transcodeUi.presetId || transcodeUi.presetEditing);
  $('transcodePresetEditor').classList.toggle('hidden', !transcodeUi.presetEditing || hasJob);
  $('transcodePresetSave').disabled = !$('transcodePresetName').value.trim() || !transcodeDraft();
  $('videoTranscodeBitrateField').classList.toggle('hidden', format !== 'mp4');
  $('videoTranscodeAlphaField').classList.toggle('hidden', format !== 'dxv');
  $('videoTranscodeBitrate').required = format === 'mp4';
  $('videoTranscodeStart').classList.toggle('hidden', hasJob);
  $('videoTranscodeStart').disabled = transcodeUi.pending || transcodeUi.presetPending || transcodeUi.presetEditing || !total || !transcodeDraft();
  $('videoTranscodeStart').textContent = transcodeUi.pending ? '正在开始…' : '开始转码';
  $('videoTranscodeCancel').classList.toggle('hidden', !active);
  $('videoTranscodeCancel').disabled = transcodeUi.pending || job?.status === 'cancelling';
  $('videoTranscodeCancel').textContent = job?.status === 'cancelling' ? '正在取消…' : '取消任务';
  $('videoTranscodeBackground').textContent = active ? '后台运行' : '关闭';
  $('videoTranscodeStatus').classList.toggle('is-error', Boolean(transcodeUi.error) || job?.status === 'error' || Number(job?.failed) > 0);
  if (active) {
    $('videoTranscodeStatus').textContent = job.status === 'cancelling' ? '正在停止转码，已完成的结果会保留…' : `已处理 ${job.completed || 0} / ${total} 个视频`;
  } else if (hasJob) {
    const prefix = job.status === 'cancelled' ? '任务已取消' : job.status === 'error' ? '转码未完成' : '转码完成';
    $('videoTranscodeStatus').textContent = `${prefix}：新增 ${job.imported || 0} 个素材${job.duplicates ? `，${job.duplicates} 个结果已存在` : ''}${job.failed ? `，失败 ${job.failed} 个` : ''}。`;
  } else $('videoTranscodeStatus').textContent = transcodeUi.error || (format === 'mp4' && transcodeBitrate() === null ? '请输入 0.5–200 之间的视频码率。' : '');
  $('videoTranscodeProgressArea').classList.toggle('hidden', !hasJob);
  $('videoTranscodeProgress').value = Math.max(0, Math.min(100, Number(job?.progress) || 0));
  $('videoTranscodeCurrent').textContent = job?.current ? `${job.current.index || 1} / ${total} · ${job.current.name || '正在处理'}${Number.isFinite(job.current.progress) ? ` · ${Math.round(job.current.progress)}%` : ''}` : `${Math.round(Number(job?.progress) || 0)}%`;
  const lanes = Array.isArray(job?.lanes) ? job.lanes : [];
  const runningItems = Array.isArray(job?.runningItems) ? job.runningItems : [];
  const workers = lanes.length ? lanes : runningItems.map(item => ({ id: item.laneId, label: item.deviceLabel, current: item, status: 'running' }));
  $('videoTranscodeWorkers').replaceChildren(...workers.map(worker => {
    const row = el('li', 'video-transcode-worker'), current = worker.current;
    row.append(el('strong', '', worker.label || current?.deviceLabel || (worker.device?.type === 'gpu' ? 'GPU' : 'CPU')));
    row.append(el('span', '', current ? `${current.name || '正在处理'} · ${Math.round(Number(current.progress) || 0)}%` : ({ completed: '已完成', cancelled: '已取消', error: '未完成' })[worker.status] || '等待任务'));
    if (current) { const progress = el('progress'); progress.max = 100; progress.value = Math.max(0, Math.min(100, Number(current.progress) || 0)); progress.setAttribute('aria-label', `${worker.label || '转码任务'}进度`); row.append(progress); }
    return row;
  }));
  $('videoTranscodeWorkers').classList.toggle('hidden', !workers.length);
  const errors = Array.isArray(job?.errors) ? job.errors : [];
  $('videoTranscodeErrors').replaceChildren(...errors.map(item => el('li', '', `${item.name || '视频'}：${transcodeMessage(item.error)}`)));
  $('videoTranscodeErrors').classList.toggle('hidden', !errors.length);
  $('videoTranscodeButton').classList.toggle('hidden', !hasJob);
  $('videoTranscodeLabel').textContent = active ? `转码 ${Math.round(Number(job.progress) || 0)}%` : '转码结果';
}
function receiveVideoTranscode(snapshot, notify = true) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const previous = transcodeUi.snapshot;
  if (snapshot.id && previous?.id === snapshot.id && !transcodeActive(previous) && transcodeActive(snapshot)) return;
  transcodeUi.snapshot = snapshot.id ? snapshot : null;
  renderVideoTranscode();
  if (notify && snapshot.id && !transcodeActive(snapshot) && !transcodeUi.notified.has(snapshot.id)) {
    transcodeUi.notified.add(snapshot.id);
    toast(snapshot.status === 'cancelled' ? '视频转码已取消，已完成的结果保留。' : `${snapshot.status === 'error' ? '视频转码未完成' : '视频转码完成'}，新增 ${snapshot.imported || 0} 个素材${snapshot.failed ? `，失败 ${snapshot.failed} 个` : ''}。`, snapshot.status === 'error' || snapshot.failed > 0, 9000, { text: '查看', run: () => openVideoTranscode() });
  }
}
function openVideoTranscode(ids, preset) {
  folderTreeDrag.cancel(); assetFolderDrag.cancel(); stopGalleryPreviews(); closeFolderMenu();
  if (state.previewId) closePreview();
  if (ids && !transcodeActive() && !transcodeUi.pending) {
    const assets = ids.map(id => state.library.assets.find(asset => asset.id === id));
    if (!assets.length || assets.some(asset => !asset || !isVideo(asset) || asset.trashedAt)) { toast('请选择有效的视频素材。', true); return; }
    transcodeUi.ids = [...new Set(ids)]; transcodeUi.root = state.library.root; transcodeUi.snapshot = null; transcodeUi.error = '';
    transcodeUi.presetEditing = false;
    applyTranscodePreset(preset);
    if (preset && !transcodeUi.presets.some(item => item.id === preset.id)) transcodeUi.presets.push(preset);
    renderTranscodePresetOptions();
    void api.listTranscodePresets().then(presets => {
      transcodeUi.presets = presets;
      if (!presets.some(item => item.id === transcodeUi.presetId)) transcodeUi.presetId = '';
      renderTranscodePresetOptions();
      renderVideoTranscode();
    }, error => {
      transcodeUi.error = transcodeMessage(error);
      renderVideoTranscode();
    });
  }
  transcodeUi.previousFocus = document.activeElement;
  renderVideoTranscode();
  $('videoTranscodeOverlay').classList.remove('hidden');
  (transcodeUi.snapshot?.id ? $('videoTranscodeDialog') : $('videoTranscodeFormat')).focus();
}
function closeVideoTranscode() {
  $('videoTranscodeOverlay').classList.add('hidden');
  if (transcodeUi.previousFocus?.isConnected) transcodeUi.previousFocus.focus();
}
async function startVideoTranscode() {
  if (transcodeUi.pending || transcodeUi.presetPending || transcodeUi.presetEditing || transcodeUi.snapshot?.id || !transcodeUi.ids.length) return;
  const options = transcodeDraft();
  if (!options) { renderVideoTranscode(); return; }
  const ids = [...transcodeUi.ids], expectedRoot = transcodeUi.root;
  transcodeUi.pending = true; transcodeUi.error = ''; renderVideoTranscode();
  try {
    if (!await waitForMetadata() || state.library.root !== expectedRoot || state.libraryChanging) throw new Error('素材库已切换，请重新选择视频');
    const snapshot = await api.startVideoTranscode({ ids, expectedRoot, ...options });
    receiveVideoTranscode(snapshot, false);
  } catch (error) { transcodeUi.error = transcodeMessage(error); toast(transcodeUi.error, true); }
  finally { transcodeUi.pending = false; renderVideoTranscode(); }
}
async function cancelVideoTranscode() {
  if (transcodeUi.pending || !transcodeActive()) return;
  transcodeUi.pending = true; renderVideoTranscode();
  try { receiveVideoTranscode(await api.cancelVideoTranscode(transcodeUi.snapshot.id), false); }
  catch (error) { toast(transcodeMessage(error), true); }
  finally { transcodeUi.pending = false; renderVideoTranscode(); }
}
const videoExtensions = new Set(['mp4', 'm4v', 'mov', 'qt', 'webm', 'ogv', 'ogg', 'mkv', 'avi', 'wmv', 'asf', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'mts', 'm2ts', 'ts', 'm2t', 'vob', 'flv', 'f4v', 'mxf', '3gp', '3g2', 'divx', 'dxv', 'rm', 'rmvb', 'dv']);
const audioExtensions = new Set(['mp3', 'mp2', 'wav', 'wave', 'flac', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'aifc', 'ape', 'wma', 'alac', 'amr', 'ac3', 'eac3', 'dts', 'mka', 'au', 'snd', 'wv', 'tta', 'dsf', 'dff', 'caf', 'w64']);
function isAudio(asset) { const ext = (asset.ext || '').replace(/^\./, '').toLowerCase(); return asset.mediaType === 'audio' || (!asset.mediaType && ext !== 'ogg' && audioExtensions.has(ext)); }
function isVideo(asset) { return asset.mediaType === 'video' || (!asset.mediaType && videoExtensions.has((asset.ext || '').replace(/^\./, '').toLowerCase())); }
const modelExtensions = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'blend', 'c4d', 'max']);
function isModel(asset) { return asset.mediaType === 'model' || modelExtensions.has((asset.ext || '').replace(/^\./, '').toLowerCase()); }
function isProject(asset) { return asset.mediaType === 'project' || ['aep', 'aepx'].includes((asset.ext || '').replace(/^\./, '').toLowerCase()); }
function isFont(asset) { return asset.mediaType === 'font' || ['ttf', 'otf', 'woff', 'woff2', 'ttc', 'otc'].includes((asset.ext || '').replace(/^\./, '').toLowerCase()); }
function mimeType(asset) {
  if (isAudio(asset)) return ({ mp3: 'audio/mpeg', mp2: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', w64: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff', wma: 'audio/x-ms-wma', ape: 'audio/x-ape', amr: 'audio/amr', ac3: 'audio/ac3', eac3: 'audio/eac3', dts: 'audio/vnd.dts', mka: 'audio/x-matroska', alac: 'audio/mp4', au: 'audio/basic', snd: 'audio/basic', wv: 'audio/wavpack', tta: 'audio/x-tta', dsf: 'audio/x-dsf', dff: 'audio/x-dff', caf: 'audio/x-caf' })[asset.ext?.toLowerCase()] || asset.mimeType || 'audio/mpeg';
  if (isFont(asset)) return ({ ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', ttc: 'font/collection', otc: 'font/collection' })[asset.ext.toLowerCase()] || 'font/ttf';
  return asset.mimeType || ({ mp4: 'video/mp4', m4v: 'video/mp4', f4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', qt: 'video/quicktime', dxv: 'video/quicktime', ogv: 'video/ogg', ogg: 'video/ogg', avi: 'video/x-msvideo', divx: 'video/x-msvideo', mkv: 'video/x-matroska', mpg: 'video/mpeg', mpeg: 'video/mpeg', mpe: 'video/mpeg', m1v: 'video/mpeg', m2v: 'video/mpeg', mts: 'video/mp2t', m2ts: 'video/mp2t', m2t: 'video/mp2t', ts: 'video/mp2t', vob: 'video/mpeg', wmv: 'video/x-ms-wmv', asf: 'video/x-ms-asf', flv: 'video/x-flv', mxf: 'application/mxf', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', rm: 'application/vnd.rn-realmedia', rmvb: 'application/vnd.rn-realmedia-vbr', dv: 'video/dv', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif' })[(asset.ext || '').toLowerCase()] || '—';
}
function selectedAssets() { return state.library.assets.filter((a) => state.selected.has(a.id)); }
function currentFolder() { return state.folder || null; }
function hasLibrary() { return Boolean(state.library.root) && !state.library.needsLibrary; }
function viewName() {
  if (activeSmartFolder()) return activeSmartFolder().name;
  if (state.folder) return state.library.folders.find((f) => f.id === state.folder)?.name || '文件夹';
  return { all: '全部素材', recent: '最近导入', favorites: '收藏', unfiled: '未分类', trash: '回收站' }[state.view] || '全部素材';
}
function toast(message, error = false, duration = 4500, link) {
  const item = el('div', `toast${error ? ' error' : ''}`, message);
  item.setAttribute('role', error ? 'alert' : 'status');
  if (link) item.append(action(link.text, 'toast-action', () => run(link.run)));
  const stack = $('toastStack');
  stack.append(item);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => item.remove(), duration);
  return item;
}
function messageError(error) { toast(error?.message || String(error), true, 8000); }
async function run(fn) { try { return await fn(); } catch (error) { messageError(error); return null; } }
async function recheckAssetBundle(id, expectedRoot = state.library.root) {
  if (!hasLibrary() || state.libraryChanging || closing || expectedRoot !== state.library.root) return;
  if (state.busy || activeExport || pendingBundleCheck || folderMoveSaving || deletingAssets || historyUi.pending) { toast('请等待当前素材操作完成'); return; }
  if (!await waitForMetadata() || expectedRoot !== state.library.root || state.libraryChanging || state.busy || closing) return;
  pendingBundleCheck = { id, root: expectedRoot }; state.busy = true;
  stopGalleryPreviews(); modelWarmup.pause(); renderDetails();
  let showMissing = false;
  try {
    const result = await api.recheckBundles([id], expectedRoot);
    if (state.library.root !== expectedRoot || state.libraryChanging) return;
    if (result.snapshot?.root === expectedRoot) applyLibrary(result.snapshot);
    const failure = result.errors?.find(item => item.id === id);
    if (failure) throw new Error(failure.message);
    const asset = state.library.assets.find(item => item.id === id);
    const bundle = asset?.modelBundle || asset?.projectBundle;
    const missing = bundle?.missing?.length || 0;
    showMissing = missing > 0;
    const needsReview = (bundle?.warnings?.length || 0) > 0 || bundle?.resources?.complete === false;
    toast(missing ? `检查完成，缺少 ${missing} 项资源，可在详情中查找补齐`
      : needsReview ? '资源清单已更新，部分引用仍需核对，见资源包详情' : '检查完成，未发现缺失资源');
  } catch (error) { messageError(error); }
  finally {
    pendingBundleCheck = null; state.busy = false; render(); modelWarmup.schedule();
    if (showMissing && state.library.root === expectedRoot && state.selected.has(id)) {
      const details = $('detailsContent').querySelector('.asset-health-details');
      if (details) details.open = true;
    }
  }
}
function updateExportProgress(detail) {
  if (!activeExport || state.library.root !== activeExport.root || (detail?.root && detail.root !== activeExport.root)) return;
  const current = Number.isSafeInteger(detail?.current) && detail.current >= 0 ? detail.current : null;
  const total = Number.isSafeInteger(detail?.total) && detail.total > 0 ? detail.total : null;
  const count = current !== null && total !== null ? ` · ${Math.min(current, total)} / ${total}` : '';
  const phase = detail?.phase === 'preparing' ? '正在准备导出缩略图' : '正在导出文件';
  const name = typeof detail?.name === 'string' ? detail.name.slice(0, 220) : '';
  activeExport.label.textContent = `${phase}${count}${name ? `\n${name}` : ''}`;
  activeExport.progress.hidden = current === null || total === null;
  if (!activeExport.progress.hidden) { activeExport.progress.max = total; activeExport.progress.value = Math.min(current, total); }
}
function renderExportControls() {
  renderHeader(filteredAssets()); renderLibraryState(); renderSelection(); renderHistory();
  for (const button of document.querySelectorAll('[data-export-command]')) button.disabled = Boolean(activeExport || state.busy || state.libraryChanging);
}
async function exportLibraryItems(kind, value, expectedRoot = state.library.root) {
  if (!hasLibrary() || state.libraryChanging || closing || expectedRoot !== state.library.root) return null;
  if (state.busy || activeExport || folderMoveSaving || deletingAssets || historyUi.pending) { toast('当前操作正在进行，请稍候再导出'); return null; }
  const folder = kind === 'folder' ? state.library.folders.find(item => item.id === value) : null;
  const ids = kind === 'assets' ? [...value] : null;
  if ((kind === 'folder' && !folder) || (kind === 'assets' && !ids.length)) return null;
  if (!await waitForMetadata() || expectedRoot !== state.library.root || state.libraryChanging || state.busy || closing) return null;
  folderTreeDrag.cancel(); assetFolderDrag.cancel(); closeFolderMenu(); stopGalleryPreviews(); modelWarmup.pause();
  const notice = el('div', 'toast export-notice'); notice.setAttribute('role', 'status');
  const label = el('span', '', '请选择导出位置…');
  const progress = el('progress', 'export-progress'); progress.setAttribute('aria-label', '导出进度'); progress.hidden = true;
  notice.append(label, progress); $('toastStack').append(notice);
  const session = { root: expectedRoot, notice, label, progress };
  activeExport = session; state.busy = true; renderExportControls();
  try {
    const result = kind === 'folder' ? await api.exportFolder(folder.id, expectedRoot) : await api.exportAssets(ids, expectedRoot);
    if (!result || result.cancelled || state.library.root !== expectedRoot) return result;
    if (result.snapshot?.root === expectedRoot) applyLibrary(result.snapshot);
    const count = Number.isSafeInteger(result.count) ? result.count : Number.isSafeInteger(result.exported) ? result.exported : 0;
    const folders = Number.isSafeInteger(result.folders) ? result.folders : Number.isSafeInteger(result.folderCount) ? result.folderCount : null;
    const title = kind === 'folder' ? `已按层级导出「${folder.name}」` : '素材导出完成';
    toast(`${title}\n${count} 个素材${kind === 'folder' && folders !== null ? ` · ${folders} 个分类文件夹` : ''}${result.path ? `\n${result.path}` : ''}`, false, 10000);
    const warnings = Array.isArray(result.warnings) ? result.warnings.map(item => typeof item === 'string' ? item : item?.message).filter(Boolean) : [];
    if (warnings.length) {
      const reportName = typeof result.reportPath === 'string' ? result.reportPath.split(/[\\/]/).pop() : '';
      toast(reportName ? `导出已完成，${warnings.length} 项需核对。\n完整内容见导出目录中的「${reportName}」` : `导出提醒：${warnings.join('；')}`, result.missingDependencies > 0, 14000);
    }
    return result;
  } catch (error) { messageError(error); return null; }
  finally {
    notice.remove();
    if (activeExport === session) activeExport = null;
    state.busy = false; renderExportControls(); modelWarmup.schedule();
  }
}
function saveMetadata(operation) {
  const task = metadataQueue.then(async () => {
    try {
      const snapshot = await operation();
      if (!snapshot) return false;
      applyLibrary(snapshot);
      return true;
    } catch (error) {
      messageError(error);
      return false;
    }
  });
  metadataQueue = task;
  pendingSaves.add(task);
  renderHistory();
  task.then(() => { pendingSaves.delete(task); renderHistory(); });
  return task;
}
function selectionKey() { return [...state.selected].sort().join('|'); }
function captureDetailDrafts(box, key) {
  if (box.dataset.selectionKey !== key) return null;
  const focused = box.contains(document.activeElement) ? document.activeElement : null;
  return {
    focused: focused?.id,
    start: focused?.selectionStart,
    end: focused?.selectionEnd,
    scrollTop: box.scrollTop,
    fields: [...box.querySelectorAll('input[data-saved-value],textarea[data-saved-value]')]
      .filter((input) => !input.disabled && input.value !== input.dataset.savedValue)
      .map((input) => ({ id: input.id, value: input.value, pendingValue: input.dataset.pendingValue })),
  };
}
function restoreDetailDrafts(box, draft) {
  if (!draft) return;
  for (const item of draft.fields) {
    const input = $(item.id);
    if (input && !input.disabled) {
      input.value = item.value;
      if (item.pendingValue !== undefined && item.value !== input.dataset.savedValue) input.dataset.pendingValue = item.pendingValue;
    }
  }
  const focused = $(draft.focused);
  if (focused && !focused.disabled) {
    focused.focus({ preventScroll: true });
    if (draft.start !== null && draft.start !== undefined && focused.setSelectionRange) focused.setSelectionRange(draft.start, draft.end);
  }
  box.scrollTop = draft.scrollTop;
}
function saveTextInput(input, property, normalize = (value) => value) {
  const value = normalize(input.value);
  if ((property === 'name' && !value) || value === input.dataset.savedValue || value === input.dataset.pendingValue) return;
  input.value = value;
  input.dataset.pendingValue = value;
  updateSelected({ [property]: value }).then((ok) => {
    if (!ok) {
      const current = $(input.id);
      if (current?.dataset.pendingValue === value) delete current.dataset.pendingValue;
      delete input.dataset.pendingValue;
    }
  });
}
function flushDetailDrafts() {
  for (const input of $('detailsContent').querySelectorAll('input[data-saved-value],textarea[data-saved-value]')) {
    if (!input.disabled && input.value !== input.dataset.savedValue && input.value !== input.dataset.pendingValue) input.dispatchEvent(new Event('change'));
  }
}
async function waitForMetadata() {
  flushDetailDrafts();
  while (pendingSaves.size) {
    const results = await Promise.all([...pendingSaves]);
    if (results.some((ok) => !ok)) return false;
    flushDetailDrafts();
  }
  return true;
}
function historyBlocked() {
  return !hasLibrary() || state.libraryChanging || state.busy || draggingAssets || draggingFolders || folderMoveSaving || folderTreeDrag.pending || nativeAssetDrag || assetFolderDrag.pending || deletingAssets || closing ||
    Boolean(state.previewId || modalResolve || featureDialogOpen() || window.shituPlugins?.isOpen() || document.querySelector('.modal-overlay:not(.hidden),.preview:not(.hidden),.sp-overlay:not([hidden]),#dropOverlay:not(.hidden)'));
}
function hasHistoryDrafts() {
  return pendingSaves.size > 0 || [...$('detailsContent').querySelectorAll('input[data-saved-value],textarea[data-saved-value]')].some(input => !input.disabled && input.value !== input.dataset.savedValue);
}
function renderHistory() {
  const snapshot = historyUi.snapshot;
  const draft = hasHistoryDrafts();
  for (const direction of ['undo', 'redo']) {
    const button = $(direction === 'undo' ? 'undoHistoryButton' : 'redoHistoryButton');
    const command = historyControls.command(snapshot, direction);
    const label = direction === 'undo' ? '撤销' : '重做', shortcut = direction === 'undo' ? 'Ctrl＋Z' : 'Ctrl＋Shift＋Z';
    button.disabled = historyUi.pending || historyBlocked() || (direction === 'undo' ? !command && !draft : !command || draft) || !api[direction === 'undo' ? 'undoHistory' : 'redoHistory'];
    button.title = `${label}${direction === 'undo' && draft ? '：当前编辑' : command ? `：${command.label}` : `：暂无可${label}操作`}（${shortcut}）${snapshot?.warning ? `；${snapshot.warning}` : ''}`;
    button.setAttribute('aria-label', command ? `${label}：${command.label}` : label);
  }
  for (const button of $('toastStack').querySelectorAll('[data-history-undo-id],[data-history-redo-id]')) {
    const direction = button.hasAttribute('data-history-undo-id') ? 'undo' : 'redo';
    button.disabled = historyUi.pending || historyBlocked() || button.dataset.historyRoot !== state.library.root || !historyControls.command(snapshot, direction, button.dataset[direction === 'undo' ? 'historyUndoId' : 'historyRedoId']);
  }
}
function historyToast(message, direction, entry, root) {
  for (const previous of $('toastStack').querySelectorAll('.history-toast')) previous.remove();
  const item = toast(message, false, 6500);
  item.classList.add('history-toast');
  if (!entry?.id) return item;
  const button = action(direction === 'undo' ? '撤销' : '重做', 'toast-action', () => { void performHistory(direction, entry.id, root); });
  button.dataset[direction === 'undo' ? 'historyUndoId' : 'historyRedoId'] = entry.id;
  button.dataset.historyRoot = root;
  button.title = `${direction === 'undo' ? '撤销' : '重做'}：${entry.label}`;
  item.append(button); renderHistory(); return item;
}
function receiveHistory(snapshot, notify = true) {
  if (!snapshot || snapshot.root !== state.library.root) return;
  const previous = historyUi.snapshot, changedRoot = previous?.root !== snapshot.root;
  historyUi.revision++;
  if (changedRoot) { historyUi.seen.clear(); historyUi.warning = ''; }
  historyUi.snapshot = { ...snapshot };
  const undo = historyControls.command(snapshot, 'undo');
  const unseen = undo && !historyUi.seen.has(undo.id);
  if (undo) historyUi.seen.add(undo.id);
  if (historyUi.seen.size > 250) historyUi.seen.delete(historyUi.seen.values().next().value);
  if (notify && !changedRoot && !historyUi.pending && unseen && Number(snapshot.undoCount) >= Number(previous?.undoCount || 0)) {
    historyToast(`已完成：${undo.label}`, 'undo', undo, snapshot.root);
  }
  if (notify && snapshot.warning && snapshot.warning !== historyUi.warning) toast(snapshot.warning, false, 8000);
  historyUi.warning = snapshot.warning || '';
  renderHistory();
}
async function refreshHistory(notify = false) {
  if (!api.historyState || !hasLibrary()) return;
  const revision = historyUi.revision, root = state.library.root;
  const snapshot = await api.historyState();
  if (root === state.library.root && revision === historyUi.revision) receiveHistory(snapshot, notify);
}
async function performHistory(direction, expectedId, expectedRoot = state.library.root) {
  if (historyUi.pending || historyBlocked()) return;
  if (expectedRoot !== state.library.root) { toast('素材库已切换，这条操作无法撤销。', true); return; }
  historyUi.pending = true; renderHistory(); stopGalleryPreviews();
  try {
    if (!await waitForMetadata()) return;
    if (expectedRoot !== state.library.root || historyBlocked()) throw new Error('当前素材库状态已变化，请稍后重试。');
    await refreshHistory(false);
    const command = historyControls.command(historyUi.snapshot, direction, expectedId);
    if (!command) {
      if (expectedId) throw new Error('这条操作已不是当前可撤销或重做的一步，请使用工具栏按钮。');
      return;
    }
    const snapshot = await api[direction === 'undo' ? 'undoHistory' : 'redoHistory'](expectedRoot, command.id);
    if (expectedRoot !== state.library.root) return;
    applyLibrary(snapshot);
    const opposite = direction === 'undo' ? 'redo' : 'undo';
    historyToast(`已${direction === 'undo' ? '撤销' : '重做'}：${command.label}`, opposite, historyControls.command(historyUi.snapshot, opposite), expectedRoot);
  } catch (error) {
    toast(String(error?.message || error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''), true, 8000);
    await refreshHistory(false).catch(() => {});
  } finally { historyUi.pending = false; renderHistory(); }
}

function updateStatusText(snapshot) {
  const messages = {
    disabled: '当前环境尚未启用自动更新。',
    idle: '启动后会自动检查更新，也可以手动检查。',
    checking: '正在检查新版本…',
    available: '发现新版本，可以下载更新。',
    downloading: '正在后台下载更新，你可以继续整理素材。',
    downloaded: '更新已准备好，重启即可安装。',
    installing: '正在保存并准备安装更新…',
    error: '更新未完成，请稍后重试。'
  };
  if (updateUi.preparingInstall) return '正在保存当前修改，请稍候…';
  return snapshot.error || snapshot.message || messages[snapshot.status] || messages.idle;
}

function renderAppUpdate() {
  const snapshot = updateUi.snapshot;
  const status = snapshot.status;
  const percent = Math.max(0, Math.min(100, Number(snapshot.progress) || 0));
  const busy = updateUi.pending || ['checking', 'downloading', 'installing'].includes(status);
  const latest = snapshot.latestVersion ? `v${snapshot.latestVersion}` : '';
  const label = status === 'downloading' ? `${Math.round(percent)}%` :
    status === 'downloaded' ? '重启更新' : status === 'available' ? latest || '有更新' :
    status === 'checking' ? '检查中' : status === 'installing' ? '更新中' : status === 'error' ? '更新重试' : '更新';
  $('appUpdateLabel').textContent = label;
  $('appUpdateButton').title = status === 'available' ? `发现新版本 ${latest}` : updateStatusText(snapshot);
  const hasUpdate = ['available', 'downloaded'].includes(status);
  $('appUpdateButton').classList.toggle('has-update', hasUpdate);
  $('headerMoreButton').classList.toggle('has-update', hasUpdate);
  const moreLabel = hasUpdate ? '更多工具，有软件更新' : '更多工具';
  $('headerMoreButton').setAttribute('aria-label', moreLabel);
  $('headerMoreButton').title = moreLabel;
  $('appUpdateButton').disabled = status === 'installing' || updateUi.preparingInstall;
  $('appUpdateCurrent').textContent = snapshot.currentVersion ? `v${snapshot.currentVersion}` : '—';
  $('appUpdateLatest').textContent = latest || '尚未检查';
  $('appUpdateStatus').textContent = updateStatusText(snapshot);
  $('appUpdateStatus').classList.toggle('is-error', Boolean(snapshot.error) || status === 'error');
  const showProgress = status === 'downloading';
  $('appUpdateProgressArea').classList.toggle('hidden', !showProgress);
  $('appUpdateProgress').value = percent;
  $('appUpdateTransfer').textContent = `${Math.round(percent)}% · ${size(snapshot.downloadedBytes || 0)} / ${size(snapshot.totalBytes || 0)}`;
  const notes = typeof snapshot.releaseNotes === 'string' ? snapshot.releaseNotes.trim() : '';
  $('appUpdateNotes').textContent = notes;
  $('appUpdateNotesArea').classList.toggle('hidden', !notes);
  $('appUpdateCheck').disabled = busy || status === 'disabled';
  $('appUpdateCheck').textContent = status === 'error' ? '重新检查' : '检查更新';
  $('appUpdateOpenRelease').classList.toggle('hidden', !snapshot.error && status !== 'error');
  $('appUpdateOpenRelease').disabled = status === 'installing' || updateUi.preparingInstall;
  $('appUpdateDownload').classList.toggle('hidden', !(['available', 'downloading'].includes(status) || (status === 'error' && latest)));
  $('appUpdateDownload').disabled = busy;
  $('appUpdateDownload').textContent = status === 'downloading' ? '正在下载…' : status === 'error' ? '重试下载' : '下载更新';
  $('appUpdateInstall').classList.toggle('hidden', !['downloaded', 'installing'].includes(status));
  $('appUpdateInstall').disabled = busy;
  $('appUpdateClose').disabled = status === 'installing' || updateUi.preparingInstall;
  $('appUpdateDialog').setAttribute('aria-busy', String(busy));
}

function receiveUpdateState(snapshot, notify = true) {
  if (!snapshot || typeof snapshot.status !== 'string') return;
  updateUi.snapshot = { ...snapshot };
  renderAppUpdate();
  const latest = snapshot.latestVersion;
  if (!notify || !latest || !['available', 'downloaded'].includes(snapshot.status)) return;
  const notice = `${snapshot.status}:${latest}`;
  if (updateUi.notices.has(notice)) return;
  updateUi.notices.add(notice);
  if (!$('appUpdateOverlay').classList.contains('hidden')) return;
  toast(snapshot.status === 'downloaded' ? `新版本 v${latest} 已下载，点击右上角「重启更新」安装` : `发现新版本 v${latest}，可在右上角查看更新`, false, 6500);
}

function showAppUpdate() {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  stopGalleryPreviews();
  updateUi.previousFocus = document.activeElement;
  renderAppUpdate();
  $('appUpdateOverlay').classList.remove('hidden');
  $('appUpdateClose').focus();
}

function closeAppUpdate() {
  if (updateUi.preparingInstall || updateUi.snapshot.status === 'installing') return;
  $('appUpdateOverlay').classList.add('hidden');
  const target = updateUi.previousFocus;
  if (target?.isConnected && !target.closest('[inert]') && !target.disabled) target.focus();
}

function updateErrorMessage(error) {
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  // Electron wraps rejected main-process calls. Keep the public reason, without
  // exposing the IPC channel or replacing a newer update-state error event.
  return message.replace(/^Error invoking remote method ['"]shitu:update-(?:check|download|install|state|open-release)['"]:\s*(?:Error:\s*)?/, '').trim()
    || '更新未完成，请稍后重试。';
}

async function runUpdateAction(action) {
  if (updateUi.pending) return;
  const revision = updateUi.revision;
  updateUi.pending = true;
  renderAppUpdate();
  try {
    const result = await action();
    if (result?.status) receiveUpdateState(result);
  } catch (error) {
    const message = updateErrorMessage(updateUi.revision !== revision && updateUi.snapshot.error ? updateUi.snapshot.error : error);
    updateUi.snapshot = {
      ...updateUi.snapshot,
      status: ['available', 'downloaded', 'disabled'].includes(updateUi.snapshot.status) ? updateUi.snapshot.status : 'error',
      error: message
    };
    toast(message, true, 8000);
  } finally {
    updateUi.pending = false;
    updateUi.preparingInstall = false;
    renderAppUpdate();
  }
}

async function installAppUpdate() {
  if (updateUi.pending || updateUi.snapshot.status !== 'downloaded') return;
  if (state.busy || state.libraryChanging || draggingAssets || draggingFolders || folderMoveSaving || deletingAssets) {
    toast('请等待当前素材操作完成后再更新。', true);
    return;
  }
  updateUi.preparingInstall = true;
  await runUpdateAction(async () => {
    if (!await waitForMetadata()) throw new Error('有修改尚未保存，请重试保存后再更新。');
    return api.installUpdate();
  });
}

function applyLibrary(library, preserveSelection = true) {
  if (!library || !Array.isArray(library.assets)) return;
  libraryRefreshSerial += 1;
  const rootChanged = (state.library.root || '').toLowerCase() !== (library.root || '').toLowerCase();
  if (folderTreeDrag.pending && (rootChanged || window.ShituFolderTreeDrag.fingerprint(state.library.folders) !== window.ShituFolderTreeDrag.fingerprint(library.folders))) folderTreeDrag.cancel();
  if (!rootChanged && state.previewId) {
    const previous = state.library.assets.find(item => item.id === state.previewId);
    const current = library.assets.find(item => item.id === state.previewId);
    if (previous && isAudio(previous) && (!current || current.trashedAt || current.hash !== previous.hash || current.ext !== previous.ext)) closePreview();
  }
  if (rootChanged) {
    setHeaderMenuOpen(false);
    similarImagesUi.close();
    batchRenameUi.close(true); fontCompareUi.close(); smartFoldersUi.close(); folderIconsUi.close(true); skinPickerUi.close();
    closeFolderMenu();
    collapsedFolders.clear();
    closePreview();
    state.selectionMode = false;
    state.view = 'all';
    state.folder = null;
    state.smartFolder = null;
    state.tag = null;
    state.search = '';
    state.format = 'all';
    state.missingResources = false;
    state.sort = 'newest';
    state.limit = 240;
    state.anchor = null;
    state.selected.clear();
    $('searchInput').value = '';
    $('formatFilter').value = 'all';
    $('sortSelect').value = 'newest';
    $('galleryScroller').scrollTop = 0;
    $('detailsContent').dataset.selectionKey = '';
  }
  state.library = library;
  if (state.smartFolder && !activeSmartFolder()) state.smartFolder = null;
  if (library.history) receiveHistory({ ...library.history, root: library.root });
  else if (rootChanged) { historyUi.snapshot = null; historyUi.seen.clear(); historyUi.warning = ''; historyUi.revision++; }
  if (state.folder && !library.folders.some((f) => f.id === state.folder)) state.folder = null;
  if (!preserveSelection) state.selected.clear();
  else {
    const visible = new Set(filteredAssets().map((a) => a.id));
    state.selected = new Set([...state.selected].filter((id) => visible.has(id)));
  }
  render();
  if (!library.history && api.historyState) void refreshHistory(false).catch(() => {});
}
function filteredAssets() {
  const terms = state.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const smart = activeSmartFolder();
  const matchSmart = smart ? smartFolders.compile(smart.rule, Date.now()) : null;
  const list = state.library.assets.filter((a) => {
    if (matchSmart && !matchSmart(a)) return false;
    if (state.view === 'trash' ? !a.trashedAt : Boolean(a.trashedAt)) return false;
    if (state.missingResources && !assetHealth.summary(a)) return false;
    if (state.folder && a.folderId !== state.folder) return false;
    if (!state.folder && state.view === 'recent' && new Date(a.createdAt).getTime() < weekAgo) return false;
    if (!state.folder && state.view === 'favorites' && (a.rating || 0) < 4) return false;
    if (!state.folder && state.view === 'unfiled' && a.folderId) return false;
    if (state.tag && !(a.tags || []).includes(state.tag)) return false;
    const ext = (a.ext || '').replace(/^\./, '').toLowerCase();
    if (state.format !== 'all') {
      if (state.format === 'audio') { if (!isAudio(a)) return false; }
      else if (state.format === 'video') { if (!isVideo(a)) return false; }
      else if (state.format === 'model') { if (!isModel(a)) return false; }
      else if (state.format === 'project') { if (!isProject(a)) return false; }
      else if (state.format === 'font') { if (!isFont(a)) return false; }
      else if (state.format === 'aiff') { if (!['aif', 'aiff', 'aifc'].includes(ext)) return false; }
      else if (state.format === 'm4a') { if (!['m4a', 'alac'].includes(ext)) return false; }
      else if (state.format === 'images') { if (isAudio(a) || isVideo(a) || isModel(a) || isProject(a) || isFont(a)) return false; }
      else if (state.format === 'jpg' ? !['jpg', 'jpeg'].includes(ext) : state.format === 'other' ? ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext) || isAudio(a) || isVideo(a) || isModel(a) || isProject(a) || isFont(a) : ext !== state.format) return false;
    }
    if (terms.length) {
      const haystack = `${a.name} ${a.font?.family || ''} ${a.font?.fullName || ''} ${a.font?.style || ''} ${a.audio?.title || ''} ${a.audio?.artist || ''} ${a.audio?.album || ''} ${(a.tags || []).join(' ')} ${a.notes || ''} ${a.sourceUrl || ''} ${a.pageUrl || ''}`.toLocaleLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    return true;
  });
  const comparators = {
    newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    name: (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0) || new Date(b.createdAt) - new Date(a.createdAt),
    size: (a, b) => b.size - a.size,
  };
  return list.sort(comparators[state.sort]);
}
function changeView(view, folder = null, tag = null, smartFolder = null) {
  if (draggingFolders || folderMoveSaving) return;
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  similarImagesUi.close();
  flushDetailDrafts();
  stopGalleryPreviews();
  closeFolderMenu();
  state.view = view;
  state.folder = folder;
  state.smartFolder = smartFolder;
  if (folder) {
    const folders = new Map(state.library.folders.map(item => [item.id, item]));
    for (let current = folders.get(folder), visited = new Set(); current && !visited.has(current.id); current = folders.get(folderTree.parentId(current))) {
      visited.add(current.id); collapsedFolders.delete(current.id);
    }
  }
  state.tag = tag;
  state.selected.clear();
  state.anchor = null;
  state.limit = 240;
  $('galleryScroller').scrollTop = 0;
  render();
}
function folderLocation() { return { view: state.view, folder: state.folder, tag: state.tag, ...(state.smartFolder ? { smartFolder: state.smartFolder } : {}) }; }
function setFolderPanelMode(mode, { persist = true, open = false, focus = false } = {}) {
  if (!['dropdown', 'sidebar'].includes(mode) || draggingAssets || assetFolderDrag.active || folderTreeDrag.pending || folderMoveSaving) return false;
  const panel = $('folderPanel'), browser = $('folderBrowser'), sidebar = $('folderSidebar');
  const scrollTop = (folderPanelMode === 'sidebar' ? $('folderNav') : panel).scrollTop, active = document.activeElement;
  stopGalleryPreviews(); closeFolderMenu();
  folderPanelMode = mode;
  browser.open = false;
  if (mode === 'sidebar') sidebar.append(panel);
  else browser.append(panel);
  document.querySelector('.app-shell').classList.toggle('folder-panel-pinned', mode === 'sidebar');
  sidebar.classList.toggle('hidden', mode !== 'sidebar' || !hasLibrary());
  panel.dataset.mode = mode;
  const pinned = mode === 'sidebar';
  $('folderPanelPin').setAttribute('aria-pressed', String(pinned));
  $('folderPanelPin').setAttribute('aria-label', pinned ? '取消固定，恢复文件夹下拉列表' : '将文件夹列表固定到左侧');
  $('folderPanelPin').title = pinned ? '取消固定，恢复下拉列表' : '固定到左侧';
  $('folderPanelPinLabel').textContent = pinned ? '取消固定' : '固定';
  $('folderBrowserToggle').setAttribute('aria-expanded', String(pinned || open));
  $('folderBrowserToggle').title = pinned ? '文件夹已固定在左侧，点击恢复下拉列表' : `${open ? '收起' : '展开'}文件夹列表`;
  if (!pinned) browser.open = open;
  if (persist) { try { localStorage.setItem(folderPanelStorageKey, mode); } catch {} }
  requestAnimationFrame(() => {
    if (folderPanelMode !== mode) return;
    (mode === 'sidebar' ? $('folderNav') : panel).scrollTop = scrollTop;
    if (focus) (panel.contains(active) && active.isConnected ? active : $('folderPanelPin')).focus({ preventScroll: true });
  });
  return true;
}
function directChildFolders() {
  if (!hasLibrary() || state.view !== 'all' || state.tag || state.smartFolder) return [];
  return folderTree.children(state.library.folders, currentFolder());
}
function canNavigateFolders() { return hasLibrary() && !state.libraryChanging && !state.busy && !draggingAssets && !draggingFolders && !folderMoveSaving && !deletingAssets && !closing && !featureDialogOpen(); }
function navigateFolderHistory(direction) {
  if (!canNavigateFolders()) return;
  const destination = folderNavigation.travel(direction, state.library.root, state.library.folders, state.library.smartFolders || []);
  if (destination) changeView(destination.view, destination.folder, destination.tag, destination.smartFolder || null);
}
function navigateFolderUp() {
  if (!canNavigateFolders()) return;
  const destination = window.ShituFolderNavigation.parent(folderLocation(), state.library.folders);
  if (destination) changeView(destination.view, destination.folder, destination.tag);
}
function renderFolderNavigation() {
  const ready = hasLibrary(), enabled = canNavigateFolders();
  folderNavigation.record(ready ? state.library.root : null, folderLocation(), state.library.folders, state.library.smartFolders || []);
  const history = folderNavigation.state(ready ? state.library.root : null, state.library.folders, state.library.smartFolders || []);
  const parent = window.ShituFolderNavigation.parent(folderLocation(), state.library.folders);
  $('folderBack').disabled = !enabled || !history.canBack;
  $('folderForward').disabled = !enabled || !history.canForward;
  $('folderUp').disabled = !enabled || !parent;
  $('createFolderHere').disabled = !enabled || Boolean(state.smartFolder);
  $('createFolderHere').title = state.folder ? `在「${viewName()}」中新建子文件夹` : '在素材库中新建文件夹';
  const breadcrumbs = $('folderBreadcrumbs');
  breadcrumbs.replaceChildren();
  if (!ready) { breadcrumbs.append(el('span', 'folder-path-placeholder', '尚未打开素材库')); return; }
  const addCrumb = (name, folder, current = false, glyph) => {
    if (breadcrumbs.childNodes.length) { const separator = el('span', 'folder-breadcrumb-separator'); separator.setAttribute('aria-hidden', 'true'); separator.append(icon('chevron')); breadcrumbs.append(separator); }
    const button = action('', 'folder-breadcrumb', () => changeView('all', folder), glyph);
    if (folder) button.prepend(folderIcon(state.library.folders.find(item => item.id === folder)));
    button.append(el('span', '', name));
    button.dataset.folderId = folder || '';
    button.title = name;
    button.disabled = !enabled || (current && !state.tag);
    if (current) button.setAttribute('aria-current', 'page');
    breadcrumbs.append(button);
  };
  const currentIsRoot = !state.folder && state.view === 'all' && !state.smartFolder;
  addCrumb('全部素材', null, currentIsRoot, 'folder');
  if (state.folder) {
    const folders = new Map(state.library.folders.map(folder => [folder.id, folder]));
    const chain = [], visited = new Set();
    for (let current = folders.get(state.folder); current && !visited.has(current.id); current = folders.get(folderTree.parentId(current))) { visited.add(current.id); chain.unshift(current); }
    chain.forEach(folder => addCrumb(folder.name, folder.id, folder.id === state.folder));
    breadcrumbs.title = `全部素材 / ${chain.map(folder => folder.name).join(' / ')}`;
  } else if (!currentIsRoot) {
    const separator = el('span', 'folder-breadcrumb-separator'); separator.setAttribute('aria-hidden', 'true'); separator.append(icon('chevron'));
    const current = el('span', 'folder-breadcrumb', viewName()); current.setAttribute('aria-current', 'page');
    breadcrumbs.append(separator, current); breadcrumbs.title = viewName();
  } else breadcrumbs.title = '全部素材';
  breadcrumbs.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function renderNavigation() {
  const active = state.library.assets.filter((a) => !a.trashedAt);
  const weekAgo = Date.now() - 7 * 86400000;
  const rows = [
    ['all', 'grid', '全部素材', active.length],
    ['recent', 'clock', '最近导入', active.filter((a) => new Date(a.createdAt).getTime() >= weekAgo).length],
    ['favorites', 'star', '收藏', active.filter((a) => a.rating >= 4).length],
    ['unfiled', 'folder', '未分类', active.filter((a) => !a.folderId).length],
    ['trash', 'trash', '回收站', state.library.assets.length - active.length],
  ];
  $('mainNav').replaceChildren(...rows.map(([key, glyph, label, count]) => {
    const item = action('', `nav-item${!state.folder && !state.smartFolder && state.view === key ? ' active' : ''}`, () => changeView(key), glyph);
    item.dataset.view = key;
    item.append(el('span', 'nav-name', label), el('span', 'nav-count', count.toLocaleString()));
    if (!state.folder && !state.smartFolder && state.view === key) item.setAttribute('aria-current', 'page');
    return item;
  }));
  const counts = new Map();
  active.forEach((a) => counts.set(a.folderId, (counts.get(a.folderId) || 0) + 1));
  const folders = folderTree.flatten(state.library.folders);
  const parents = new Set(folders.map(folder => folder.parentId).filter(id => id !== null));
  for (let index = folders.length - 1; index >= 0; index--) {
    const folder = folders[index];
    if (folder.parentId !== null) counts.set(folder.parentId, (counts.get(folder.parentId) || 0) + (counts.get(folder.id) || 0));
  }
  let collapsedDepth = null;
  const folderRows = [];
  for (const folder of folders) {
    if (collapsedDepth !== null && folder.depth > collapsedDepth) continue;
    collapsedDepth = null;
    const row = el('div', 'folder-row');
    row.dataset.folderId = folder.id;
    row.draggable = false;
    row.addEventListener('dragstart', event => event.preventDefault());
    if (folder.colorLabel) row.dataset.colorLabel = folder.colorLabel;
    row.dataset.depth = String(folder.depth);
    row.style.setProperty('--folder-depth', String(folder.depth));
    const children = parents.has(folder.id), expanded = !collapsedFolders.has(folder.id);
    if (children) {
      const toggle = action('', 'folder-toggle', event => {
        event.stopPropagation();
        if (collapsedFolders.has(folder.id)) collapsedFolders.delete(folder.id); else collapsedFolders.add(folder.id);
        renderNavigation();
        $('folderNav').querySelector(`[data-folder-toggle="${CSS.escape(folder.id)}"]`)?.focus();
      }, 'chevron');
      toggle.dataset.folderToggle = folder.id;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}「${folder.name}」的子文件夹`);
      row.append(toggle);
    } else row.append(el('span', 'folder-toggle-spacer'));
    const item = action('', `nav-item${state.folder === folder.id ? ' active' : ''}`, () => {
      changeView('all', folder.id);
      if (folderPanelMode === 'sidebar') $('folderNav').querySelector(`.nav-item[data-folder-id="${CSS.escape(folder.id)}"]`)?.focus({ preventScroll: true });
    }, 'folder');
    item.dataset.folderId = folder.id;
    const folderColor = colorLabels.get(folder.colorLabel);
    item.querySelector('.icon').replaceWith(folderIcon(folder));
    item.append(el('span', 'nav-name', folder.name));
    const folderMark = colorMarker(folder.colorLabel, 'folder-color-mark');
    if (folderMark) item.append(folderMark);
    item.append(el('span', 'nav-count', String(counts.get(folder.id) || 0)));
    item.title = `${folder.path} · ${counts.get(folder.id) || 0} 个素材（含子文件夹）${folderColor ? ` · ${folderColor.name}标记` : ''}`;
    if (state.folder === folder.id) item.setAttribute('aria-current', 'page');
    item.addEventListener('keydown', event => {
      if (!event.altKey && (event.key === 'ArrowRight' && children && collapsedFolders.has(folder.id) || event.key === 'ArrowLeft' && children && !collapsedFolders.has(folder.id))) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'ArrowRight') collapsedFolders.delete(folder.id); else collapsedFolders.add(folder.id);
        renderNavigation(); $('folderNav').querySelector(`.nav-item[data-folder-id="${CSS.escape(folder.id)}"]`)?.focus();
      }
    });
    const more = action('', 'folder-more', event => { event.stopPropagation(); showFolderMenu(folder, event.currentTarget); }, 'more');
    more.title = `管理文件夹「${folder.name}」`;
    more.setAttribute('aria-label', more.title);
    more.setAttribute('aria-haspopup', 'menu');
    row.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); showFolderMenu(folder, more, { x: event.clientX, y: event.clientY }); });
    row.append(item, more);
    folderRows.push(row);
    if (children && !expanded) collapsedDepth = folder.depth;
  }
  $('folderNav').replaceChildren(...folderRows);
  if (draggingFolders) refreshFolderTreeDragRows();
  $('smartFolderNav').replaceChildren(...(state.library.smartFolders || []).map(folder => {
    const row = el('div', 'smart-folder-row');
    const item = action('', `nav-item${state.smartFolder === folder.id ? ' active' : ''}`, () => {
      state.search = ''; state.format = 'all'; state.missingResources = false; $('searchInput').value = ''; $('formatFilter').value = 'all';
      changeView('all', null, null, folder.id);
      if (folderPanelMode === 'dropdown') $('folderBrowser').open = false;
    }, 'search');
    item.dataset.smartFolderId = folder.id; item.title = smartFolders.describe(folder.rule);
    if (state.smartFolder === folder.id) item.setAttribute('aria-current', 'page');
    const matches = smartFolders.compile(folder.rule, Date.now());
    item.append(el('span', 'nav-name', folder.name), el('span', 'nav-count', state.library.assets.filter(matches).length.toLocaleString()));
    const edit = action('···', 'smart-folder-edit', () => run(() => openSmartFolderEditor(folder)));
    edit.title = `编辑智能文件夹：${folder.name}`; edit.setAttribute('aria-label', edit.title);
    row.append(item, edit); return row;
  }));
  $('smartFolderHint').classList.toggle('hidden', Boolean(state.library.smartFolders?.length));
  $('folderBrowserLabel').textContent = state.folder || state.smartFolder ? viewName() : '文件夹';
  const currentFolderIcon = $('folderBrowserToggle').querySelector(':scope > .folder-icon, :scope > .icon');
  currentFolderIcon?.replaceWith(state.folder ? folderIcon(state.library.folders.find(item => item.id === state.folder)) : icon('folder'));
  $('folderBrowserLabel').title = state.folder ? folderTree.path(state.library.folders, state.folder) : '文件夹';
  $('folderHint').classList.toggle('hidden', state.library.folders.length > 0);
  const tags = state.library.tags.map((tag) => typeof tag === 'string' ? { name: tag } : tag);
  $('tagCount').textContent = tags.length;
  $('tagNav').replaceChildren(...tags.map((tag) => {
    const item = action(tag.name, `tag-pill${state.tag === tag.name ? ' active' : ''}`, () => {
      state.tag = state.tag === tag.name ? null : tag.name;
      state.limit = 240;
      state.selected.clear();
      render();
    });
    item.title = `${tag.name}${tag.count !== undefined ? ` · ${tag.count} 个素材` : ''}`;
    return item;
  }));
  $('tagHint').classList.toggle('hidden', tags.length > 0);
  $('storageLabel').textContent = `${active.length.toLocaleString()} 个素材 · ${size(active.reduce((n, a) => n + a.size, 0))}`;
}
function renderHeader(list) {
  renderFolderNavigation();
  renderHistory();
  const name = viewName();
  const folderPath = state.folder ? folderTree.path(state.library.folders, state.folder) : name;
  $('breadcrumbCurrent').textContent = folderPath;
  $('breadcrumbCurrent').title = folderPath;
  $('pageTitle').replaceChildren(document.createTextNode(name), el('span', 'title-dot', '.'));
  $('pageSubtitle').textContent = activeSmartFolder() ? smartFolders.describe(activeSmartFolder().rule) : state.folder ? '把相关的灵感放在一起。' : { all: '收集值得留下的灵感。', recent: '过去 7 天，为灵感留个位置。', favorites: '四星及以上的素材，值得再次回看。', unfiled: '为散落的灵感，找到一个位置。', trash: '暂时放下的素材，随时可以恢复。' }[state.view];
  const childCount = directChildFolders().length;
  $('resultCount').textContent = `${childCount ? `${childCount} 个文件夹 · ` : ''}${list.length.toLocaleString()} 个素材${state.search || state.format !== 'all' || state.tag || state.missingResources ? ' · 素材筛选结果' : ''}`;
  assetHealth.renderFilter($('missingResourcesFilter'), list, state.missingResources);
  $('importFiles').disabled = state.busy || state.libraryChanging || !hasLibrary();
  $('importFolder').disabled = state.busy || state.libraryChanging || !hasLibrary();
  $('activeFilter').replaceChildren();
  $('activeFilter').classList.toggle('hidden', !state.tag);
  if (state.tag) {
    const clear = action('', '', () => { state.tag = null; state.selected.clear(); render(); });
    clear.append(document.createTextNode(`# ${state.tag}`), icon('close'));
    $('activeFilter').append(document.createTextNode('标签筛选'), clear);
  }
}
function imageFor(asset, kind, className = '', videoThumbnail = false) {
  const img = el('img', className);
  img.draggable = false;
  img.src = api.assetUrl(asset.id, kind);
  if (isProject(asset) && asset.projectPreview?.generatedAt) img.src += `&v=${encodeURIComponent(asset.projectPreview.generatedAt)}`;
  if (kind !== 'original' && asset.videoThumbnailRevision) img.src += `&v=${encodeURIComponent(asset.videoThumbnailRevision)}`;
  img.alt = asset.name;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    img.classList.add('hidden');
    const fallback = el('div', 'asset-fallback');
    fallback.append(icon(isAudio(asset) ? 'music' : videoThumbnail ? 'video' : 'image'), el('span', '', `${(asset.ext || (videoThumbnail ? '视频' : '图像')).toUpperCase()} · 暂无缩略图`));
    img.parentElement?.append(fallback);
  }, { once: true });
  return img;
}
function audioPlaceholder(asset, className = '') {
  const fallback = el('div', 'asset-fallback asset-audio-placeholder ' + className);
  fallback.append(icon('music'), el('span', '', (asset.ext || '音频').toUpperCase() + ' · 音乐'));
  return fallback;
}
function mediaFor(asset, kind) {
  if (isAudio(asset)) return asset.thumbnail ? imageFor(asset, 'thumbnail') : audioPlaceholder(asset);
  if (isFont(asset)) {
    if (asset.thumbnail) return imageFor(asset, 'thumbnail');
    const fallback = el('div', 'asset-fallback asset-font-placeholder');
    fallback.append(el('span', 'font-placeholder-glyph', 'Aa'), el('span', '', `${asset.ext.toUpperCase()} · 字体`));
    return fallback;
  }
  if (isProject(asset)) {
    if (asset.thumbnail) return imageFor(asset, 'thumbnail');
    const fallback = el('div', 'asset-fallback asset-project-placeholder');
    fallback.append(el('span', 'project-ae-glyph', 'Ae'), el('span', '', `${asset.ext.toUpperCase()} · 已打包工程`));
    return fallback;
  }
  if (isModel(asset)) {
    if (asset.thumbnail) return imageFor(asset, 'thumbnail');
    const fallback = el('div', 'asset-fallback asset-model-placeholder');
    fallback.append(el('span', 'model-cube-glyph', '⬡'), el('span', '', `${asset.ext.toUpperCase()} · 3D 模型`));
    return fallback;
  }
  if (!isVideo(asset)) return imageFor(asset, kind);
  if (asset.thumbnail) return imageFor(asset, 'thumbnail', '', true);
  const fallback = el('div', 'asset-fallback');
  fallback.append(icon('video'), el('span', '', `${(asset.ext || '视频').toUpperCase()} · 视频素材`));
  return fallback;
}
function renderFolderChildren() {
  const children = directChildFolders();
  const counts = new Map(), childCounts = new Map();
  state.library.assets.filter(asset => !asset.trashedAt).forEach(asset => counts.set(asset.folderId, (counts.get(asset.folderId) || 0) + 1));
  state.library.folders.forEach(folder => { const parentId = folderTree.parentId(folder); childCounts.set(parentId, (childCounts.get(parentId) || 0) + 1); });
  $('folderChildrenTitle').textContent = state.folder ? '子文件夹' : '文件夹';
  $('folderChildren').classList.toggle('hidden', !children.length);
  $('folderGallery').replaceChildren(...children.map(folder => {
    const card = el('article', 'folder-card'); card.dataset.folderId = folder.id; card.setAttribute('role', 'listitem'); card.draggable = false;
    const open = action('', 'folder-card-open', event => {
      event.stopPropagation();
      if (performance.now() < suppressAssetClickUntil) return;
      suppressAssetClickUntil = performance.now() + 300;
      changeView('all', folder.id);
    }, 'folder');
    open.draggable = false; open.setAttribute('aria-label', `打开文件夹「${folder.name}」`); open.title = `打开文件夹：${folder.name}`;
    const color = colorLabels.get(folder.colorLabel);
    if (color) card.dataset.colorLabel = color.id;
    open.querySelector('.icon').replaceWith(folderIcon(folder));
    const text = el('span', 'folder-card-text'), name = el('span', 'folder-card-name');
    const mark = colorMarker(folder.colorLabel, 'folder-color-mark'); if (mark) name.append(mark);
    name.append(el('span', '', folder.name));
    const subfolders = childCounts.get(folder.id) || 0, assets = counts.get(folder.id) || 0;
    text.append(name, el('span', 'folder-card-meta', `${subfolders} 个子文件夹 · ${assets} 个素材`)); open.append(text);
    const more = action('', 'folder-card-more', event => { event.stopPropagation(); showFolderMenu(folder, event.currentTarget); }, 'more');
    more.title = `管理文件夹「${folder.name}」`; more.setAttribute('aria-label', more.title); more.setAttribute('aria-haspopup', 'menu');
    card.addEventListener('keydown', event => { if ([' ', 'Enter', 'Delete', 'Backspace'].includes(event.key)) event.stopPropagation(); });
    card.addEventListener('dragstart', event => event.preventDefault());
    card.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); showFolderMenu(folder, more, { x: event.clientX, y: event.clientY }); });
    card.append(open, more); return card;
  }));
  return children;
}
function renderGallery(list) {
  assetFolderDrag.cancel();
  videoHover.clear();
  modelHover.clear();
  const warmupCards = [];
  stopMarquee();
  const childFolders = renderFolderChildren();
  $('assetSectionTitle').classList.toggle('hidden', !childFolders.length || !list.length);
  $('assetSectionTitle').textContent = state.smartFolder ? '匹配素材' : state.folder ? '当前文件夹素材' : '全部素材';
  const frag = document.createDocumentFragment();
  list.slice(0, state.limit).forEach((asset) => {
    const card = el('article', `asset-card${state.selected.has(asset.id) ? ' selected' : ''}`);
    card.setAttribute('role', 'listitem');
    card.tabIndex = 0;
    card.dataset.assetId = asset.id;
    const assetColor = colorLabels.get(asset.colorLabel);
    const health = assetHealth.summary(asset);
    card.setAttribute('aria-label', `${asset.name}${assetColor ? `，颜色标记：${assetColor.name}` : ''}${health ? `，${health.label} ${health.count} 个` : ''}`);
    if (assetColor) card.dataset.colorLabel = assetColor.id;
    card.setAttribute('aria-selected', String(state.selected.has(asset.id)));
    card.draggable = false;
    card.dataset.trashed = String(Boolean(asset.trashedAt));
    const thumb = el('div', 'asset-thumb');
    const check = el('span', 'asset-check');
    check.setAttribute('aria-hidden', 'true');
    check.append(icon('check'));
    thumb.append(mediaFor(asset, 'thumb'), check, el('span', 'asset-format', (asset.ext || '').toUpperCase()));
    if (isVideo(asset)) {
      thumb.title = '悬停快速预览 · 双击完整播放';
      videoHover.attach(thumb, asset, state.library.root);
    }
    if (isModel(asset) && asset.modelBundle && !asset.trashedAt &&
        (!['blend', 'c4d', 'max'].includes(asset.ext) || asset.modelBundle.previewEntry)) {
      thumb.title = '悬停旋转 · 双击交互预览';
      modelHover.attach(thumb, asset, state.library.root);
      warmupCards.push({ thumb, asset, root: state.library.root });
    }
    if (isAudio(asset) || isVideo(asset) || isModel(asset) || isProject(asset) || isFont(asset)) {
      const badge = el('span', 'asset-video-badge');
      if (!isFont(asset)) badge.append(icon(isAudio(asset) ? 'music' : isProject(asset) ? 'folder' : isModel(asset) ? 'grid' : 'video'));
      badge.append(document.createTextNode(isAudio(asset) ? '音乐' : isFont(asset) ? '字体' : isProject(asset) ? 'AE 工程' : isModel(asset) ? '3D 模型' : '视频'));
      thumb.append(badge);
    }
    if (health) thumb.append(assetHealth.cardBadge(health));
    const info = el('div', 'asset-card-info');
    const name = el('div', 'asset-name', asset.name);
    name.title = asset.name;
    const nameRow = el('div', 'asset-name-row');
    const mark = colorMarker(asset.colorLabel, 'asset-color-mark');
    if (mark) nameRow.append(mark);
    nameRow.append(name);
    const subline = el('div', 'asset-subline');
    subline.append(el('span', '', isAudio(asset) ? [videoDuration(asset.duration), asset.audio?.artist].filter(Boolean).join(' · ') || '音乐素材' : isFont(asset) ? (asset.font?.family || '字体素材') : asset.width && asset.height ? dimensions(asset) : isVideo(asset) ? '视频素材' : '尺寸未知'));
    if (asset.rating) subline.append(el('span', 'asset-stars', '★'.repeat(asset.rating)));
    else subline.append(el('span', '', size(asset.size)));
    info.append(nameRow, subline);
    if (asset.tags?.length) {
      const tags = el('div', 'asset-tags');
      asset.tags.slice(0, 3).forEach((tag) => tags.append(el('span', '', tag)));
      info.append(tags);
    }
    card.append(thumb, info);
    card.addEventListener('click', (event) => { if (performance.now() >= suppressAssetClickUntil) selectCard(asset.id, event, list); });
    card.addEventListener('dblclick', () => { if (!state.selectionMode && performance.now() >= suppressAssetClickUntil) openPreview(asset.id); });
    card.addEventListener('pointerdown', event => beginAssetDrag(event, asset));
    card.addEventListener('dragstart', event => event.preventDefault());
    card.addEventListener('contextmenu', event => assetContextMenuEvent(event, asset.id));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || (state.selectionMode && event.key === ' ')) {
        event.preventDefault(); event.stopPropagation(); selectCard(asset.id, event, list);
        if (!state.selectionMode) openPreview(asset.id);
      }
    });
    frag.append(card);
  });
  $('gallery').replaceChildren(frag);
  modelWarmup.setCards(warmupCards);
  renderSelectionMode();
  $('loadMore').classList.toggle('hidden', list.length <= state.limit);
  $('loadMore').textContent = `加载更多 · 还有 ${Math.max(0, list.length - state.limit).toLocaleString()} 个`;
  $('emptyState').classList.toggle('hidden', list.length > 0 || childFolders.length > 0);
  if (!list.length && !childFolders.length) renderEmpty();
}
function selectForAssetAction(id) {
  if (state.selected.has(id)) return;
  flushDetailDrafts();
  state.selected = new Set([id]);
  state.anchor = id;
  updateSelectionClasses();
  renderSelection();
  renderDetails();
}
function assetContextMenuEvent(event, id) {
  if (!id) return;
  event.preventDefault();
  event.stopPropagation();
  run(() => showAssetContextMenu(id));
}
function finishAssetDrag() {
  nativeAssetDrag = false;
  assetFolderDrag.cancel();
  if (!draggingAssets) return;
  draggingAssets = false;
  suppressAssetClickUntil = performance.now() + 250;
  document.body.classList.remove('dragging-assets');
  $('dropOverlay').classList.add('hidden');
}
function beginAssetDrag(event, asset) {
  if (event.button !== 0 || event.target.closest('button,input,textarea,select,a,.asset-check') ||
      asset.trashedAt || !canStartAssetFolderDrag()) return;
  // Preserve normal click and Ctrl-click selection until an actual drag begins.
  if (!assetFolderDrag.begin(event, asset.id)) return;
  event.stopPropagation();
}
function canStartFolderTreeDrag() {
  return hasLibrary() && !state.busy && !state.libraryChanging && !state.previewId && !draggingAssets && !assetFolderDrag.pending &&
    !folderMoveSaving && !closing && !deletingAssets && !historyUi.pending && !modalResolve && !featureDialogOpen() &&
    !document.querySelector('.modal-overlay:not(.hidden),.preview:not(.hidden),.sp-overlay:not([hidden])');
}
function prepareFolderTreeDrag(id) {
  if (!canStartFolderTreeDrag()) return null;
  const folder = state.library.folders.find(item => item.id === id);
  if (!folder) return null;
  flushDetailDrafts();
  return { id, name: folder.name, root: state.library.root,
    fingerprint: window.ShituFolderTreeDrag.fingerprint(state.library.folders),
    descendants: window.ShituFolderTreeDrag.descendants(state.library.folders, id) };
}
function folderTreeDragIsCurrent(payload) {
  return state.library.root === payload.root && !state.libraryChanging && !state.busy && !state.previewId && !closing && !deletingAssets &&
    window.ShituFolderTreeDrag.fingerprint(state.library.folders) === payload.fingerprint;
}
function startFolderTreeDrag(gesture, event) {
  stopGalleryPreviews(); stopMarquee(); closeFolderMenu();
  draggingFolders = true;
  folderDragPayload = gesture.payload;
  suppressFolderClickUntil = performance.now() + 350;
  suppressAssetClickUntil = performance.now() + 350;
  document.body.classList.add('dragging-folder-tree');
  $('dropOverlay').classList.add('hidden');
  $('folderRootDropTarget').classList.remove('hidden');
  $('folderRootDropTarget').setAttribute('aria-hidden', 'false');
  $('folderDragGhost').classList.remove('hidden');
  try { document.body.setPointerCapture(gesture.pointerId); } catch {}
  refreshFolderTreeDragRows(gesture.payload);
  positionFolderTreeDrag(event);
  folderDragScrollFrame = requestAnimationFrame(scrollFolderTreeDrag);
}
function refreshFolderTreeDragRows(payload) {
  const source = (payload || folderDragPayload)?.descendants || new Set();
  for (const row of $('folderNav').querySelectorAll('.folder-row')) row.classList.toggle('folder-drag-source', source.has(row.dataset.folderId));
}
function positionFolderTreeDrag(event) {
  folderDragPosition = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  $('folderDragGhost').style.left = `${Math.max(8, Math.min(innerWidth - 285, event.clientX + 16))}px`;
  $('folderDragGhost').style.top = `${Math.max(8, Math.min(innerHeight - 55, event.clientY + 18))}px`;
}
function folderTreeDropTarget(event, payload) {
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const row = hit?.closest('#folderNav .folder-row[data-folder-id]');
  if (row) {
    const bounds = row.getBoundingClientRect(), ratio = (event.clientY - bounds.top) / Math.max(bounds.height, 1);
    const mode = ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside';
    return { ...window.ShituFolderTreeDrag.plan(state.library.folders, payload.id, row.dataset.folderId, mode), node: row };
  }
  const rootTarget = hit?.closest('#folderRootDropTarget,#folderPanel>.section-heading:not(.smart-folder-heading),#folderNav');
  if (!rootTarget) return null;
  return { ...window.ShituFolderTreeDrag.plan(state.library.folders, payload.id, null, 'root'), node: $('folderRootDropTarget') };
}
function highlightFolderTreeTarget(destination, gesture) {
  if (folderDragTarget?.node !== destination?.node || folderDragTarget?.mode !== destination?.mode || folderDragTarget?.valid !== destination?.valid) {
    if (folderDragTarget?.node) delete folderDragTarget.node.dataset.folderTreeDrop;
    if (destination?.node) destination.node.dataset.folderTreeDrop = destination.valid ? destination.mode : 'invalid';
  }
  folderDragTarget = destination;
  const expandId = destination?.valid && destination.mode === 'inside' && collapsedFolders.has(destination.targetId) ? destination.targetId : null;
  if (expandId !== folderDragExpandId) {
    clearTimeout(folderDragExpandTimer); folderDragExpandTimer = null;
    folderDragExpandId = expandId;
    if (expandId) folderDragExpandTimer = setTimeout(() => {
      folderDragExpandTimer = null;
      if (!folderTreeDrag.active || folderDragTarget?.targetId !== expandId || !folderDragTarget.valid) return;
      collapsedFolders.delete(expandId);
      renderNavigation();
      if (folderDragPosition) folderTreeDrag.move({ pointerId: folderDragPosition.pointerId, clientX: folderDragPosition.x, clientY: folderDragPosition.y, buttons: 1 });
    }, 650);
  }
  if (gesture?.payload) {
    const count = gesture.payload.descendants.size - 1;
    const suffix = count ? `（含 ${count} 个子文件夹）` : '';
    $('folderDragGhost').textContent = destination?.valid ? `移动「${gesture.payload.name}」${suffix}到${destination.name}` :
      destination ? destination.reason : `「${gesture.payload.name}」${suffix} · 拖入文件夹或移至最外层`;
    $('folderDragGhost').classList.toggle('is-invalid', Boolean(destination && !destination.valid));
  }
}
function scrollFolderTreeDrag() {
  folderDragScrollFrame = 0;
  if (!folderTreeDrag.active || !folderDragPosition) return;
  const scroller = folderPanelMode === 'sidebar' ? $('folderNav') : $('folderPanel');
  const rect = scroller.getBoundingClientRect(), edge = 34;
  if (folderDragPosition.x >= rect.left && folderDragPosition.x <= rect.right) {
    const speed = folderDragPosition.y < rect.top + edge && folderDragPosition.y >= rect.top - edge ? -10 :
      folderDragPosition.y > rect.bottom - edge && folderDragPosition.y <= rect.bottom + edge ? 10 : 0;
    if (speed) {
      scroller.scrollTop += speed;
      folderTreeDrag.move({ pointerId: folderDragPosition.pointerId, clientX: folderDragPosition.x, clientY: folderDragPosition.y, buttons: 1 });
    }
  }
  if (folderTreeDrag.active) folderDragScrollFrame = requestAnimationFrame(scrollFolderTreeDrag);
}
function finishFolderTreeDrag(_reason, gesture) {
  cancelAnimationFrame(folderDragScrollFrame); folderDragScrollFrame = 0; folderDragPosition = null;
  folderDragPayload = null;
  clearTimeout(folderDragExpandTimer); folderDragExpandTimer = null; folderDragExpandId = null;
  try { if (document.body.hasPointerCapture(gesture.pointerId)) document.body.releasePointerCapture(gesture.pointerId); } catch {}
  for (const row of $('folderNav').querySelectorAll('.folder-drag-source')) row.classList.remove('folder-drag-source');
  if (folderDragTarget?.node) delete folderDragTarget.node.dataset.folderTreeDrop;
  folderDragTarget = null;
  $('folderDragGhost').classList.add('hidden'); $('folderDragGhost').classList.remove('is-invalid');
  $('folderRootDropTarget').classList.add('hidden'); $('folderRootDropTarget').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('dragging-folder-tree'); draggingFolders = false;
  suppressFolderClickUntil = performance.now() + 350; suppressAssetClickUntil = performance.now() + 350;
}
async function moveDraggedFolder(payload, destination) {
  if (!folderTreeDragIsCurrent(payload) || folderMoveSaving) return;
  folderMoveSaving = true;
  try {
    if (!await waitForMetadata() || !folderTreeDragIsCurrent(payload)) return;
    const check = window.ShituFolderTreeDrag.plan(state.library.folders, payload.id, destination.targetId, destination.mode);
    if (!check.valid) return;
    const saved = await saveMetadata(() => {
      if (!folderTreeDragIsCurrent(payload)) throw new Error('文件夹层级已变化，请重新拖动');
      return api.moveFolder(payload.id, check.parentId, check.placement, payload.root);
    });
    if (saved) {
      const byId = new Map(state.library.folders.map(folder => [folder.id, folder]));
      for (let id = check.parentId; id != null && byId.has(id); id = folderTree.parentId(byId.get(id))) collapsedFolders.delete(id);
      renderNavigation();
      toast(`已移动「${payload.name}」，子文件夹与素材保持原有层级，可撤销`);
    }
  } finally { folderMoveSaving = false; renderHistory(); }
}
function canStartAssetFolderDrag() {
  return hasLibrary() && !state.busy && !state.libraryChanging && !state.previewId && !draggingAssets && !folderTreeDrag.pending && !folderMoveSaving && !closing && !deletingAssets && !featureDialogOpen() &&
    !document.querySelector('.modal-overlay:not(.hidden),.preview:not(.hidden),.sp-overlay:not([hidden])');
}
function prepareAssetFolderDrag(id) {
  if (!canStartAssetFolderDrag()) return null;
  const asset = state.library.assets.find(item => item.id === id && !item.trashedAt);
  if (!asset) return null;
  flushDetailDrafts();
  selectForAssetAction(id);
  const assets = [...state.selected].map(assetId => state.library.assets.find(item => item.id === assetId));
  if (!assets.length || assets.some(item => !item || item.trashedAt)) return null;
  return { root: state.library.root, ids: assets.map(item => item.id), hashes: assets.map(item => item.hash) };
}
function assetDragIsCurrent(payload) {
  return state.library.root === payload.root && !state.libraryChanging && !state.busy && !state.previewId && !closing && !deletingAssets &&
    payload.ids.every((id, index) => state.library.assets.some(asset => asset.id === id && !asset.trashedAt && asset.hash === payload.hashes[index]));
}
function startPointerAssetDrag(gesture, event) {
  stopGalleryPreviews(); stopMarquee();
  draggingAssets = true;
  nativeAssetDrag = false;
  suppressAssetClickUntil = performance.now() + 250;
  document.body.classList.add('dragging-assets');
  $('dropOverlay').classList.add('hidden');
  try { document.body.setPointerCapture(gesture.pointerId); } catch {}
  $('assetDragGhost').textContent = `${gesture.payload.ids.length} 个素材 · 拖入文件夹`;
  $('assetDragGhost').classList.remove('hidden');
  positionPointerAssetDrag(event, gesture);
  dragScrollFrame = requestAnimationFrame(scrollAssetFolderDrag);
}
function positionPointerAssetDrag(event) {
  dragPosition = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  $('assetDragGhost').style.left = `${Math.max(8, Math.min(innerWidth - 220, event.clientX + 16))}px`;
  $('assetDragGhost').style.top = `${Math.max(8, Math.min(innerHeight - 50, event.clientY + 18))}px`;
}
function assetDropTarget(event, payload) {
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const summary = hit?.closest('.folder-browser > summary');
  if (summary && folderPanelMode !== 'sidebar' && !summary.parentElement.open) { summary.parentElement.open = true; dragOpenedMenu = true; }
  const node = hit?.closest('.folder-card[data-folder-id],.folder-row[data-folder-id],.folder-breadcrumb[data-folder-id]');
  if (!node) return null;
  const folderId = node.dataset.folderId || null;
  const folder = folderId ? state.library.folders.find(item => item.id === folderId) : null;
  if (folderId && !folder) return null;
  if (payload.ids.every(id => state.library.assets.find(asset => asset.id === id)?.folderId === folderId)) return null;
  return { node, folderId, name: folder?.name || '素材库根目录' };
}
function highlightAssetDropTarget(destination, gesture) {
  if (dragTargetNode !== destination?.node) {
    dragTargetNode?.classList.remove('asset-drop-target');
    if (dragTargetNode) delete dragTargetNode.dataset.folderDropState;
    dragTargetNode = destination?.node || null;
    dragTargetNode?.classList.add('asset-drop-target');
    if (dragTargetNode) dragTargetNode.dataset.folderDropState = 'ready';
  }
  if (gesture) $('assetDragGhost').textContent = destination ? `移动 ${gesture.payload.ids.length} 个素材到「${destination.name}」` : `${gesture.payload.ids.length} 个素材 · 拖入文件夹`;
}
function scrollAssetFolderDrag() {
  dragScrollFrame = 0;
  if (!assetFolderDrag.active || !dragPosition) return;
  const surfaces = [$('galleryScroller')];
  if (folderPanelMode === 'sidebar') surfaces.push($('folderNav'));
  else if ($('folderBrowser').open) surfaces.push($('folderPanel'));
  for (const scroller of surfaces) {
    const rect = scroller.getBoundingClientRect(), edge = 34;
    if (dragPosition.x < rect.left || dragPosition.x > rect.right) continue;
    const speed = dragPosition.y < rect.top + edge && dragPosition.y >= rect.top - edge ? -12 :
      dragPosition.y > rect.bottom - edge && dragPosition.y <= rect.bottom + edge ? 12 : 0;
    if (speed) {
      scroller.scrollTop += speed;
      assetFolderDrag.move({ pointerId: dragPosition.pointerId, clientX: dragPosition.x, clientY: dragPosition.y, buttons: 1 });
    }
  }
  if (assetFolderDrag.active) dragScrollFrame = requestAnimationFrame(scrollAssetFolderDrag);
}
function finishPointerAssetDrag(reason, gesture) {
  cancelAnimationFrame(dragScrollFrame); dragScrollFrame = 0; dragPosition = null;
  try { if (document.body.hasPointerCapture(gesture.pointerId)) document.body.releasePointerCapture(gesture.pointerId); } catch {}
  $('assetDragGhost').classList.add('hidden');
  highlightAssetDropTarget(null);
  if (dragOpenedMenu) { if (folderPanelMode !== 'sidebar') $('folderBrowser').open = false; dragOpenedMenu = false; }
  suppressAssetClickUntil = performance.now() + 350;
  if (reason !== 'external') { draggingAssets = false; document.body.classList.remove('dragging-assets'); }
}
function startExternalAssetDrag(payload) {
  if (!assetDragIsCurrent(payload)) { finishAssetDrag(); return; }
  nativeAssetDrag = true;
  try { api.startAssetDrag(payload.ids, payload.root); }
  catch (error) { finishAssetDrag(); messageError(error); }
}
async function moveDraggedAssets(payload, destination) {
  if (!assetDragIsCurrent(payload)) return;
  const changed = payload.ids.filter(id => state.library.assets.find(asset => asset.id === id)?.folderId !== destination.folderId);
  if (!changed.length) return;
  const saved = await saveMetadata(() => {
    if (!assetDragIsCurrent(payload)) throw new Error('素材库或所选素材已变化，请重新拖动');
    return api.moveAssetsToFolder(payload.ids, destination.folderId, payload.root);
  });
  if (saved) toast(`已将 ${changed.length} 个素材移入「${destination.name}」`);
}
async function showAssetContextMenu(id) {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  stopGalleryPreviews();
  if (!hasLibrary() || state.libraryChanging || state.busy || draggingAssets) return;
  const root = state.library.root;
  if (!await waitForMetadata()) return;
  if (state.library.root !== root) throw new Error('素材库已切换，请重新选择素材');
  selectForAssetAction(id);
  const ids = [...state.selected];
  const result = await api.assetContextMenu(ids, root);
  if (!result) return;
  if (state.library.root !== root || result.libraryRoot !== root) throw new Error('素材库已切换，请重新选择素材');
  const assets = ids.map(assetId => state.library.assets.find(asset => asset.id === assetId));
  if (assets.some(asset => !asset)) throw new Error('所选素材已变更，请重新选择');
  const first = assets[0];
  const checkRoot = () => { if (state.library.root !== root) throw new Error('素材库已切换，请重新选择素材'); };
  // Metadata and filtering actions must remain visible and must not leave a
  // stale preview pointing at an item that moved out of the current view.
  if (state.previewId && ['rename', 'batch-rename', 'font-compare', 'tags', 'folder', 'favorite', 'unfavorite', 'trash', 'restore'].includes(result.action)) closePreview();
  switch (result.action) {
    case 'batch-rename': await openBatchRename(ids); break;
    case 'font-compare': await openFontCompare(ids); break;
    case 'similar-images': closePreview(); similarImagesUi.open(first, root); break;
    case 'video-transcode': openVideoTranscode(ids, result.preset); break;
    case 'plugin': await openPluginCenter(result.pluginId, ids); break;
    case 'preview': openPreview(first.id); break;
    case 'open': await api.openAsset(first.id); break;
    case 'reveal': await api.revealAsset(first.id); break;
    case 'source': await api.openSource(first.id); break;
    case 'copy-image': await api.copyAssetImage(first.id, root); toast('图片已复制'); break;
    case 'copy-paths': await api.copyAssetPaths(ids, root); toast('文件路径已复制'); break;
    case 'rename': {
      const value = await modal({ title: '重命名素材', value: first.name, confirm: '保存名称' });
      if (!value?.trim()) return;
      await saveMetadata(() => { checkRoot(); return api.updateAssets(ids, { name: value.trim() }); });
      break;
    }
    case 'tags':
      state.selected = new Set(ids); toggleDetails(true); $('detailTags').focus(); break;
    case 'folder':
      await saveMetadata(() => { checkRoot(); return api.updateAssets(ids, { folderId: result.folderId || null }); }); break;
    case 'color-label':
      await saveAssetColor(ids, result.colorLabel, root); break;
    case 'custom-color-label': {
      const shared = assets.every(asset => (asset.colorLabel || null) === (first.colorLabel || null));
      const selected = await chooseCustomColor(shared ? first.colorLabel : null);
      if (selected !== null) await saveAssetColor(ids, selected, root);
      break;
    }
    case 'favorite':
    case 'unfavorite':
      await saveMetadata(async () => {
        checkRoot();
        return api.updateAssets(ids, result.action === 'favorite' ? { minRating: 4 } : { rating: 0 });
      }); break;
    case 'export': {
      await exportLibraryItems('assets', ids, root);
      break;
    }
    case 'trash':
    case 'restore': {
      const snapshot = await api.setTrash(ids, result.action === 'trash');
      state.selected.clear(); applyLibrary(snapshot);
      toast(result.action === 'trash' ? `${ids.length} 个素材已移入回收站，可随时恢复` : `已恢复 ${ids.length} 个素材`);
      break;
    }
    case 'delete-permanently': await deletePermanently(ids); break;
  }
}
async function openPluginCenter(pluginId, ids = [...state.selected]) {
  if (!await waitForMetadata()) return;
  if (state.previewId) closePreview();
  window.shituPlugins.open({
    assets: state.library.assets.filter(asset => !asset.trashedAt && !isAudio(asset) && !isVideo(asset) && !isModel(asset) && !isProject(asset) && !isFont(asset)),
    selectedIds: ids, libraryRoot: state.library.root, pluginId
  });
}
function renderEmpty() {
  const box = $('emptyState');
  const isNew = state.library.assets.length === 0;
  box.replaceChildren();
  if (activeSmartFolder()) {
    const glyph = el('div', 'empty-small-icon'); glyph.append(icon('search'));
    box.append(glyph, el('h2', '', '暂时没有符合条件的素材'), el('p', '', '导入新素材或修改素材信息后，这里会自动更新。'),
      action('编辑筛选条件', 'secondary-button', () => run(() => openSmartFolderEditor(activeSmartFolder()))));
    return;
  }
  if (isNew) {
    const art = el('div', 'empty-art');
    const back = el('div', 'empty-card back'); back.append(icon('image'));
    const front = el('div', 'empty-card front'); front.append(icon('image'));
    art.append(back, front);
    const button = action('导入第一份素材', 'primary-button', () => importImages(false), 'plus');
    const foot = el('div', 'empty-footnote');
    ['图片影音一起收集', '标签快速整理', '本地安心保存'].forEach((text, index) => { const item = el('span'); item.append(icon(['upload', 'tag', 'shield'][index]), document.createTextNode(text)); foot.append(item); });
    box.append(art, el('h2', '', '每一份灵感，都值得被拾起'), el('p', '', '拖入图片、音乐、视频或文件夹，建立你的私人素材库。\n从此，告别散落的文件与找不到的参考。'), button, foot);
  } else {
    const glyph = el('div', 'empty-small-icon');
    glyph.append(icon(state.view === 'trash' ? 'trash' : state.view === 'favorites' ? 'star' : state.folder ? 'folder' : 'search'));
    const filtered = state.search || state.tag || state.format !== 'all' || state.missingResources;
    box.append(glyph, el('h2', '', filtered ? '没有找到匹配的素材' : state.view === 'trash' ? '回收站是空的' : state.view === 'favorites' ? '收藏你偏爱的灵感' : state.folder ? '这个文件夹，等待灵感入住' : '这里暂时还没有素材'), el('p', '', filtered ? '试试其他关键词，或清除筛选条件。' : state.view === 'favorites' ? '为素材评 4 星或 5 星，即可在这里找到它。' : state.view === 'trash' ? '移入回收站的素材会保留，可随时恢复。' : '导入图片、音乐或视频，开始整理你的素材收藏。'));
    if (filtered) box.append(action('清除筛选', 'secondary-button', () => { state.search = ''; state.tag = null; state.format = 'all'; state.missingResources = false; $('searchInput').value = ''; $('formatFilter').value = 'all'; render(); }));
    else if (!['trash', 'favorites'].includes(state.view)) box.append(action('导入素材', 'primary-button', () => importImages(false), 'plus'));
  }
}
function selectCard(id, event, list) {
  flushDetailDrafts();
  if (event.shiftKey && state.anchor) {
    const from = list.findIndex((a) => a.id === state.anchor);
    const to = list.findIndex((a) => a.id === id);
    if (!event.ctrlKey && !event.metaKey) state.selected.clear();
    if (from !== -1) list.slice(Math.min(from, to), Math.max(from, to) + 1).forEach((a) => state.selected.add(a.id));
    else state.selected.add(id);
  } else if (state.selectionMode || event.ctrlKey || event.metaKey || event.target.closest('.asset-check')) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    state.anchor = id;
  } else {
    state.selected = new Set([id]);
    state.anchor = id;
  }
  updateSelectionClasses();
  renderSelection();
  if (!state.selectionMode && state.selected.size && !state.details) toggleDetails(true);
  else renderDetails();
}
function renderSelectionMode() {
  document.body.classList.toggle('selection-mode', state.selectionMode);
  $('selectionModeButton').setAttribute('aria-pressed', String(state.selectionMode));
  $('selectionModeButton').querySelector('span').textContent = state.selectionMode ? '完成' : '选择';
  $('selectionModeButton').title = state.selectionMode ? '退出选择模式，恢复浏览和文件拖出' : '进入选择模式：点选或拖动框选';
  $('selectionHint').textContent = state.selectionMode ? '点击选择 · 拖动框选 · Ctrl 追加 · Esc 退出' : 'Ctrl＋滚轮缩放 · 空格预览 · 悬停快速预览';
  $('galleryScroller').dataset.selectionMode = String(state.selectionMode);
  $('gallery').querySelectorAll('.asset-card').forEach(card => { card.draggable = false; });
}
function setSelectionMode(enabled) {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  stopGalleryPreviews();
  stopMarquee();
  state.selectionMode = enabled;
  renderSelectionMode();
}
function updateMarquee() {
  if (!marquee?.active) return;
  const scroller = $('galleryScroller');
  const viewport = scroller.getBoundingClientRect();
  const x = Math.max(0, Math.min(scroller.clientWidth, marquee.clientX - viewport.left)) + scroller.scrollLeft;
  const y = Math.max(0, Math.min(scroller.clientHeight, marquee.clientY - viewport.top)) + scroller.scrollTop;
  const box = { left: Math.min(marquee.x, x), top: Math.min(marquee.y, y), right: Math.max(marquee.x, x), bottom: Math.max(marquee.y, y) };
  const overlay = $('selectionMarquee');
  overlay.classList.remove('hidden');
  Object.assign(overlay.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
  const selected = new Set(marquee.additive ? marquee.before : []);
  $('gallery').querySelectorAll('.asset-card').forEach(card => {
    const rect = card.getBoundingClientRect();
    const left = rect.left - viewport.left + scroller.scrollLeft;
    const top = rect.top - viewport.top + scroller.scrollTop;
    if (left < box.right && left + rect.width > box.left && top < box.bottom && top + rect.height > box.top) selected.add(card.dataset.assetId);
  });
  state.selected = selected;
  updateSelectionClasses(); renderSelection();
}
function scrollMarquee() {
  marqueeFrame = 0;
  if (!marquee?.active) return;
  const scroller = $('galleryScroller'), rect = scroller.getBoundingClientRect();
  const edge = 28;
  const speed = marquee.clientY < rect.top + edge ? -Math.min(12, (rect.top + edge - marquee.clientY) * .4) : marquee.clientY > rect.bottom - edge ? Math.min(12, (marquee.clientY - rect.bottom + edge) * .4) : 0;
  if (speed) { const before = scroller.scrollTop; scroller.scrollTop = Math.max(0, Math.min(marquee.maxScrollTop, before + speed)); if (before !== scroller.scrollTop) updateMarquee(); }
  marqueeFrame = requestAnimationFrame(scrollMarquee);
}
function beginMarquee(event) {
  suppressMarqueeClick = false;
  if (!state.selectionMode || state.previewId || event.button !== 0 || state.libraryChanging || event.target.closest('button,input,select,textarea,a')) return;
  const scroller = $('galleryScroller'), rect = scroller.getBoundingClientRect();
  if (event.clientX >= rect.left + scroller.clientWidth) return;
  flushDetailDrafts();
  stopMarquee();
  marquee = { pointerId: event.pointerId, x: event.clientX - rect.left + scroller.scrollLeft, y: event.clientY - rect.top + scroller.scrollTop, startX: event.clientX, startY: event.clientY, clientX: event.clientX, clientY: event.clientY, before: new Set(state.selected), additive: event.ctrlKey || event.metaKey || event.shiftKey, maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight), active: false };
}
function moveMarquee(event) {
  if (!marquee || event.pointerId !== marquee.pointerId) return;
  marquee.clientX = event.clientX; marquee.clientY = event.clientY;
  if (!marquee.active && Math.hypot(event.clientX - marquee.startX, event.clientY - marquee.startY) < 5) return;
  if (!marquee.active) {
    marquee.active = true;
    $('galleryScroller').setPointerCapture(event.pointerId);
    marqueeFrame = requestAnimationFrame(scrollMarquee);
  }
  event.preventDefault();
  updateMarquee();
}
function stopMarquee(restore = false, refresh = false) {
  if (!marquee) return false;
  const previous = marquee; marquee = null;
  cancelAnimationFrame(marqueeFrame); marqueeFrame = 0;
  $('selectionMarquee').classList.add('hidden');
  if ($('galleryScroller').hasPointerCapture(previous.pointerId)) $('galleryScroller').releasePointerCapture(previous.pointerId);
  if (previous.active) suppressMarqueeClick = true;
  if (restore) state.selected = new Set(previous.before);
  if (refresh && previous.active) { updateSelectionClasses(); renderSelection(); renderDetails(); }
  return previous.active;
}
function updateSelectionClasses() {
  $('gallery').querySelectorAll('.asset-card').forEach((card) => { const selected = state.selected.has(card.dataset.assetId); card.classList.toggle('selected', selected); card.setAttribute('aria-selected', String(selected)); });
}
function renderSelection() {
  const count = state.selected.size;
  $('selectionBar').classList.toggle('hidden', !count);
  $('selectedCount').textContent = count.toLocaleString();
  $('exportSelection').disabled = !count || state.busy || state.libraryChanging || Boolean(activeExport);
  $('trashSelection').classList.toggle('hidden', state.view === 'trash');
  $('restoreSelection').classList.toggle('hidden', state.view !== 'trash');
  $('deleteSelection').classList.toggle('hidden', state.view !== 'trash');
  $('batchRenameSelection').classList.toggle('hidden', count < 2 || state.view === 'trash');
  const fonts = selectedAssets().filter(asset => isFont(asset) && !asset.trashedAt);
  $('compareFontsSelection').classList.toggle('hidden', fonts.length < 2);
  $('compareFontsSelection').textContent = `字体对比 (${fonts.length})`;
  requestAnimationFrame(positionSelectionNotices);
}
function positionSelectionNotices() {
  const bar = $('selectionBar'), stack = $('toastStack');
  if (!bar.classList.contains('hidden') && !state.previewId && !featureDialogOpen()) {
    stack.style.bottom = `${Math.max(25, innerHeight - bar.getBoundingClientRect().top + 12)}px`;
  } else stack.style.removeProperty('bottom');
}
function field(label, control, help) {
  const container = el('div', 'detail-field');
  const labelEl = el('label', 'detail-label', label);
  if (control.id) labelEl.htmlFor = control.id;
  container.append(labelEl, control);
  if (help) container.append(el('p', 'detail-tags-help', help));
  return container;
}
function updateSelected(patch) {
  const ids = [...state.selected];
  if (!ids.length) return Promise.resolve(false);
  return saveMetadata(() => api.updateAssets(ids, patch));
}
function renderDetails() {
  if (!state.details) return;
  const box = $('detailsContent');
  const assets = selectedAssets();
  const key = selectionKey();
  const draft = captureDetailDrafts(box, key);
  box.replaceChildren();
  box.dataset.selectionKey = key;
  if (!assets.length) {
    const placeholder = el('div', 'detail-placeholder');
    const glyph = el('div'); glyph.append(icon('image'));
    placeholder.append(glyph, el('p', '', '看看素材的细节'), el('span', '', '选择一份素材\n查看信息、添加标签与备注'));
    box.append(placeholder);
    return;
  }
  const one = assets.length === 1;
  const asset = assets[0];
  if (one) {
    const preview = el('div', 'detail-preview');
    preview.dataset.assetId = asset.id;
    preview.append(mediaFor(asset, 'thumb'));
    preview.addEventListener('click', () => openPreview(asset.id));
    preview.title = isAudio(asset) ? '点击播放音乐' : isFont(asset) ? '点击预览字体与自定义文字' : isProject(asset) ? '查看已打包的 AE 工程' : isModel(asset) ? '点击旋转预览 3D 模型' : isVideo(asset) ? '点击播放视频' : '点击预览原图';
    box.append(preview);
  } else {
    const preview = el('div', 'detail-preview multi-preview');
    preview.dataset.assetId = asset.id;
    preview.append(el('strong', '', assets.length), el('span', '', '个素材 · 批量整理'));
    box.append(preview);
  }
  const nameInput = el('input', 'detail-input');
  nameInput.id = 'detailName';
  nameInput.value = one ? asset.name : '多个素材';
  nameInput.dataset.savedValue = nameInput.value;
  nameInput.disabled = !one;
  nameInput.maxLength = 200;
  nameInput.addEventListener('change', () => { if (nameInput.value.trim()) saveTextInput(nameInput, 'name', (value) => value.trim()); else nameInput.value = asset.name; });
  box.append(field('名称', nameInput));
  const folder = el('select', 'detail-select');
  folder.id = 'detailFolder';
  const mixed = !assets.every((a) => a.folderId === asset.folderId);
  if (mixed) { const option = el('option', '', '多个文件夹'); option.value = '__mixed__'; option.disabled = true; folder.append(option); }
  const unfiled = el('option', '', '未分类'); unfiled.value = ''; folder.append(unfiled);
  folderTree.flatten(state.library.folders).forEach((item) => { const option = el('option', '', item.path); option.value = item.id; folder.append(option); });
  folder.value = mixed ? '__mixed__' : asset.folderId || '';
  folder.addEventListener('change', () => updateSelected({ folderId: folder.value || null }));
  box.append(field('所在文件夹', folder));
  const colorValues = assets.map(item => colorLabels.get(item.colorLabel)?.id || null);
  const mixedColors = colorValues.some(value => value !== colorValues[0]);
  const colorRoot = state.library.root, colorAssetIds = assets.map(item => item.id);
  const picker = colorPicker({ id: 'detailColorLabels', value: colorValues[0], mixed: mixedColors,
    onChange: value => saveAssetColor(colorAssetIds, value, colorRoot) });
  box.append(field('颜色标记', picker));
  const tagsContainer = el('div');
  const tags = el('div', 'detail-tags');
  const commonTags = (asset.tags || []).filter((tag) => assets.every((a) => (a.tags || []).includes(tag)));
  commonTags.forEach((tag) => {
    const chip = el('span', 'detail-tag');
    const remove = action('', '', () => {
      saveMetadata(() => api.updateAssets(assets.map(item => item.id), { removeTags: [tag] }));
    }, 'close');
    remove.setAttribute('aria-label', `移除标签 ${tag}`);
    chip.append(el('span', '', tag), remove);
    tags.append(chip);
  });
  const tagInput = el('input', 'detail-input');
  tagInput.id = 'detailTags';
  tagInput.dataset.savedValue = '';
  tagInput.placeholder = one ? '添加标签，按 Enter 确认' : '为所有选中素材添加标签';
  tagInput.maxLength = 500;
  let committingTags = false;
  const commitTags = async () => {
    if (committingTags) return;
    const added = [...new Set(tagInput.value.split(/[,，;；\n]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];
    if (!added.length) return;
    committingTags = true;
    tagInput.disabled = true;
    const ok = await saveMetadata(async () => {
      return api.updateAssets(assets.map(item => item.id), { addTags: added });
    });
    if (!ok) { tagInput.disabled = false; committingTags = false; }
  };
  tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitTags(); } });
  tagInput.addEventListener('change', commitTags);
  tagsContainer.append(tags, tagInput);
  box.append(field('标签', tagsContainer, one ? '多个标签可用逗号分隔' : '上方仅显示共有标签；新标签会添加至所有选中素材'));
  const rating = el('div', 'rating-control');
  const sharedRating = assets.every((a) => a.rating === asset.rating) ? asset.rating || 0 : 0;
  for (let i = 1; i <= 5; i += 1) {
    const star = action('', `rating-star${i <= sharedRating ? ' rated' : ''}`, () => updateSelected({ rating: i }), 'star');
    star.setAttribute('aria-label', `评 ${i} 星`);
    star.title = `${i} 星${i >= 4 ? ' · 加入收藏' : ''}`;
    rating.append(star);
  }
  rating.append(action('清除', 'rating-clear', () => updateSelected({ rating: 0 })));
  box.append(field('评分', rating));
  const notes = el('textarea', 'detail-textarea');
  notes.id = 'detailNotes';
  notes.value = one ? asset.notes || '' : '';
  notes.dataset.savedValue = notes.value;
  notes.placeholder = one ? '记录出处、想法或使用场景…' : '单独选择素材以编辑备注';
  notes.disabled = !one;
  notes.maxLength = 20000;
  notes.addEventListener('change', () => saveTextInput(notes, 'notes'));
  box.append(field('备注', notes), el('div', 'detail-save-note', '修改后自动保存到本地素材库。'), el('div', 'detail-separator'));
  const metadata = one ? [['类型', isAudio(asset) ? '音乐' : isFont(asset) ? '字体' : isProject(asset) ? 'AE 工程' : isModel(asset) ? '3D 模型' : isVideo(asset) ? '视频' : '图片'], ['格式', asset.ext.toUpperCase()], ['MIME', isProject(asset) ? '工程资源包' : isModel(asset) ? '模型资源包' : mimeType(asset)], [isAudio(asset) ? '时长' : isFont(asset) ? '字形样式' : isModel(asset) || isProject(asset) ? '包内文件' : '尺寸', isProject(asset) ? `${asset.projectBundle?.files?.length || 1} 个` : isModel(asset) ? `${asset.modelBundle?.files?.length || 1} 个` : dimensions(asset)], ['文件大小', size(asset.size)], ['导入时间', date(asset.createdAt)]] : [['已选素材', `${assets.length} 个`], ['总大小', size(assets.reduce((n, a) => n + a.size, 0))]];
  if (one && isFont(asset)) {
    if (asset.font?.family) metadata.push(['字体家族', asset.font.family]);
    if (asset.font?.fullName) metadata.push(['字体名称', asset.font.fullName]);
    if (asset.font?.faceCount > 1) metadata.push(['合集字体', `${asset.font.faceCount} 款`]);
  }
  if (one && isProject(asset)) {
    if (asset.projectPreview?.composition) metadata.push(['封面合成', asset.projectPreview.composition.name], ['合成尺寸', `${asset.projectPreview.width} × ${asset.projectPreview.height}`]);
    if (asset.projectBundle?.compositions?.length) metadata.push(['合成数量', `${asset.projectBundle.compositions.length} 个`]);
    if (asset.projectBundle?.collectedWithVersion) metadata.push(['收集引擎', `After Effects ${asset.projectBundle.collectedWithVersion}`]);
    metadata.push(['导出方式', '已链接工程与依赖素材的完整文件夹']);
  }
  if (one && isModel(asset)) {
    metadata.push(['打包方式', '模型、材质与贴图一起保存']);
  }
  if (one && isAudio(asset)) {
    for (const [label, value] of [['艺术家', asset.audio?.artist], ['专辑', asset.audio?.album], ['曲名', asset.audio?.title], ['流派', asset.audio?.genre], ['音频编码', asset.audioCodec || asset.codec], ['采样率', asset.sampleRate ? (asset.sampleRate / 1000) + ' kHz' : null], ['声道', asset.channels === 1 ? '单声道' : asset.channels === 2 ? '立体声' : asset.channels ? asset.channels + ' 声道' : null], ['码率', asset.bitrate ? Math.round(asset.bitrate / 1000) + ' kbps' : null], ['位深', asset.bitsPerSample ? asset.bitsPerSample + ' bit' : null]]) {
      if (value) metadata.push([label, value]);
    }
  }
  if (one && isVideo(asset)) {
    if (videoDuration(asset.duration)) metadata.splice(4, 0, ['时长', videoDuration(asset.duration)]);
    if (typeof asset.codec === 'string' && asset.codec) metadata.splice(4, 0, ['视频编码', asset.codec.toUpperCase()]);
  }
  metadata.forEach(([key, value]) => { const row = el('div', 'metadata-row'); row.append(el('span', '', key), el('span', '', value)); box.append(row); });
  if (one && (isModel(asset) || isProject(asset))) {
    const bundleRoot = state.library.root;
    const resourcePanel = bundleDetails.render(asset, {
      pending: pendingBundleCheck?.id === asset.id && pendingBundleCheck.root === bundleRoot,
      onRecheck: () => recheckAssetBundle(asset.id, bundleRoot)
    });
    if (resourcePanel) box.append(resourcePanel);
  }
  const health = one ? assetHealth.summary(asset) : null;
  if (health) {
    const root = state.library.root;
    const repair = asset.trashedAt ? null : {
      key: `${root}\0${asset.id}\0${asset.hash}\0${health.items.join('\0')}`,
      choose: () => api.planBundleRepair(asset.id, root),
      cancel: token => api.cancelBundleRepair(token),
      message: error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''),
      apply: async token => {
        stopGalleryPreviews();
        const result = await api.applyBundleRepair(asset.id, token);
        if (state.library.root !== root) return;
        applyLibrary(result.snapshot);
        toast(`已补齐 ${result.repaired} 项资源${result.missing ? `，仍缺 ${result.missing} 项` : ''}`);
        if (result.snapshot.repairWarning) messageError(result.snapshot.repairWarning);
      }
    };
    box.append(assetHealth.details(health, repair));
  }
  if (one && (asset.pageUrl || asset.sourceUrl)) {
    const sources = el('div', 'source-links');
    sources.append(el('span', 'detail-label', '网页来源'));
    const source = action('', 'source-link', () => run(() => api.openSource(asset.id)));
    source.title = asset.pageUrl || asset.sourceUrl;
    source.append(icon('external'), el('span', '', asset.pageUrl || asset.sourceUrl));
    sources.append(source);
    if (asset.pageUrl && asset.sourceUrl && asset.pageUrl !== asset.sourceUrl) {
      const fileUrl = el('div', 'detail-tags-help', `素材地址：${asset.sourceUrl}`);
      fileUrl.title = asset.sourceUrl;
      fileUrl.style.overflowWrap = 'anywhere';
      sources.append(fileUrl);
    }
    box.append(sources);
  }
  if (one) box.append(action('在资源管理器中显示', 'secondary-button details-open', () => run(() => api.revealAsset(asset.id)), 'folder'));
  restoreDetailDrafts(box, draft);
}
function render() {
  const list = filteredAssets();
  renderNavigation();
  renderHeader(list);
  renderGallery(list);
  renderSelection();
  renderDetails();
  renderLibraryState();
  renderHistory();
}
function libraryLabel(root) {
  const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const legacy = /^拾图素材库(?: ([1-9]\d*))?$/.exec(name);
  if (!legacy) return name;
  const number = legacy[1] ? Number(legacy[1]) : null;
  if (number !== null && (number < 2 || number > 10000)) return name;
  return name.replace('拾图素材库', 'Mosaic 素材库');
}
function renderLibraryState() {
  renderFolderNavigation();
  const ready = hasLibrary();
  $('folderSidebar').classList.toggle('hidden', folderPanelMode !== 'sidebar' || !ready);
  $('folderPanelPin').disabled = !ready || state.libraryChanging;
  $('libraryOnboarding').classList.toggle('hidden', ready);
  $('setupAppUpdate').classList.toggle('hidden', ready);
  document.querySelector('.app-shell').inert = !ready || state.libraryChanging;
  $('newFolder').disabled = !ready || state.libraryChanging || Boolean(activeExport);
  $('newSmartFolder').disabled = !ready || state.libraryChanging || Boolean(activeExport);
  $('backupButton').disabled = !ready || state.libraryChanging || Boolean(activeExport);
  $('collectorButton').disabled = !ready || state.libraryChanging;
  $('pluginCenterButton').disabled = !ready || state.libraryChanging;
  $('toggleDetails').disabled = !ready || state.libraryChanging;
  $('searchInput').disabled = !ready || state.libraryChanging;
  $('formatFilter').disabled = !ready || state.libraryChanging;
  $('sortSelect').disabled = !ready || state.libraryChanging;
  $('selectionModeButton').disabled = !ready || state.libraryChanging;
  const label = ready ? libraryLabel(state.library.root) : '选择素材库';
  $('libraryDisplayName').textContent = label;
  $('libraryDisplayStatus').textContent = ready ? '本地存储 · 随时灵感' : '由你决定保存位置';
  $('libraryInfo').title = ready ? `管理「${label}」\n${state.library.root}` : '选择素材库位置';
  if (!ready) $('storageLabel').textContent = '尚未选择素材库';
  const error = state.library.libraryError;
  $('setupError').textContent = error || '';
  $('setupError').classList.toggle('hidden', !error);
  $('setupLegacy').classList.toggle('hidden', !state.library.legacyRoot);
  $('setupLegacyPath').textContent = state.library.legacyRoot || '';
  $('managerLibraryPath').textContent = ready ? state.library.root : '尚未选择素材库位置';
  for (const id of ['setupCreateLibrary', 'setupOpenLibrary', 'setupUseLegacy', 'managerCreateLibrary', 'managerOpenLibrary']) $(id).disabled = state.libraryChanging || state.busy;
  $('managerMigrateLibrary').disabled = !ready || state.libraryChanging || state.busy;
  $('managerRevealLibrary').disabled = !ready || state.libraryChanging;
  $('managerCloseLibrary').disabled = state.libraryChanging;
}
function showLibraryManager() {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  stopGalleryPreviews();
  renderLibraryState();
  $('libraryManagerOverlay').classList.remove('hidden');
  $('managerCloseLibrary').focus();
}
function closeLibraryManager() {
  if (state.libraryChanging) return;
  $('libraryManagerOverlay').classList.add('hidden');
  if (hasLibrary()) $('libraryInfo').focus();
}
async function changeLibrary(kind) {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  if (state.libraryChanging || state.busy || folderMoveSaving) return;
  stopGalleryPreviews();
  state.libraryChanging = true;
  renderLibraryState();
  const text = kind === 'migrate' ? '请选择新位置。复制完成前请保持 Mosaic 打开…' : '正在准备素材库…';
  for (const id of ['setupOperationStatus', 'managerOperationStatus']) { $(id).textContent = '正在保存当前修改…'; $(id).classList.remove('hidden'); }
  try {
    if (!await waitForMetadata()) {
      toast('当前修改尚未保存，已保留此素材库。请重试保存后再切换。', true, 9000);
      return;
    }
    for (const id of ['setupOperationStatus', 'managerOperationStatus']) $(id).textContent = text;
    const methods = { create: 'createLibrary', open: 'openLibrary', migrate: 'migrateLibrary', legacy: 'useLegacyLibrary' };
    const result = await api[methods[kind]]();
    if (result?.cancelled) return;
    if (result?.snapshot) {
      applyLibrary(result.snapshot, false);
      $('libraryManagerOverlay').classList.add('hidden');
      $('collectorOverlay').classList.add('hidden');
      toast(kind === 'migrate' ? '素材库已复制并切换，原位置的素材库仍完整保留' : kind === 'create' ? '素材库已创建，可以开始导入素材' : '素材库已打开');
    }
  } catch (error) { messageError(error); }
  finally {
    state.libraryChanging = false;
    renderLibraryState();
    renderHeader(filteredAssets());
    for (const id of ['setupOperationStatus', 'managerOperationStatus']) $(id).classList.add('hidden');
  }
}
function modal({ title, description = '', value = '', input = true, confirm = '确定', cancel = '取消', destructive = false, parentOptions = null, parentId = null, colorValue }) {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  stopGalleryPreviews();
  closeFolderMenu();
  if (modalResolve) modalResolve(null);
  $('modalTitle').textContent = title;
  $('modalDescription').textContent = description;
  $('modalInput').value = value;
  $('modalInput').classList.toggle('hidden', !input);
  modalHasParent = Array.isArray(parentOptions);
  modalHasColor = colorValue !== undefined;
  $('modalColorField').classList.toggle('hidden', !modalHasColor);
  $('modalColorError').classList.add('hidden');
  $('modalColorHex').removeAttribute('aria-invalid');
  if (modalHasColor) {
    const initial = colorLabels.get(colorValue)?.color || '#789fe8';
    $('modalColorPicker').value = initial;
    $('modalColorHex').value = initial.toUpperCase();
  }
  $('modalParentField').classList.toggle('hidden', !modalHasParent);
  $('modalParent').replaceChildren();
  if (modalHasParent) {
    const rootOption = el('option', '', '素材库根目录'); rootOption.value = ''; $('modalParent').append(rootOption);
    for (const folder of parentOptions) { const option = el('option', '', folder.path); option.value = folder.id; $('modalParent').append(option); }
    $('modalParent').value = parentId || '';
  }
  $('modalConfirm').textContent = confirm;
  $('modalCancel').textContent = cancel;
  $('modalOverlay').querySelector('.modal-icon use').setAttribute('href', destructive ? '#i-trash' : '#i-folder');
  $('modalOverlay').classList.remove('hidden');
  setTimeout(() => { if (modalHasColor) { $('modalColorHex').focus(); $('modalColorHex').select(); } else if (input) { $('modalInput').focus(); $('modalInput').select(); } else if (modalHasParent) $('modalParent').focus(); else $(destructive ? 'modalCancel' : 'modalConfirm').focus(); }, 30);
  return new Promise((resolve) => { modalResolve = resolve; });
}
function resolveModal(value) {
  $('modalOverlay').classList.add('hidden');
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(value);
}
async function createFolder(parentId = currentFolder()) {
  if (!hasLibrary() || state.libraryChanging || state.busy) return;
  const root = state.library.root;
  const result = await modal({ title: parentId ? '新建子文件夹' : '新建文件夹', description: '选择上级文件夹，按项目、主题或使用场景收好素材。', parentOptions: folderTree.flatten(state.library.folders), parentId });
  if (!result?.name?.trim() || !await waitForMetadata() || state.library.root !== root || state.libraryChanging) return;
  const snapshot = await run(() => api.createFolder(result.name.trim(), result.parentId));
  if (snapshot) { applyLibrary(snapshot, false); const created = snapshot.folders[snapshot.folders.length - 1]; if (created) changeView('all', created.id); toast('文件夹已创建'); }
}
function closeFolderMenu(restoreFocus = false) {
  $('folderContextMenu')?.classList.add('hidden');
  if (restoreFocus && folderMenuAnchor?.isConnected) folderMenuAnchor.focus();
  folderMenuAnchor = null;
}
function showFolderMenu(folder, anchor, point) {
  folderTreeDrag.cancel();
  stopGalleryPreviews();
  closeFolderMenu();
  if (!hasLibrary() || state.libraryChanging || state.busy || folderMoveSaving) return;
  const root = state.library.root, menu = $('folderContextMenu');
  folderMenuAnchor = anchor;
  const items = [['create', '新建子文件夹', 'plus'], ['icon', '设置图标…', 'palette'], ['export', '按层级导出…', 'download'], ['rename', '重命名', 'folder'], ['move', '移动文件夹…', 'arrow'], ['delete', '删除文件夹…', 'trash']];
  menu.replaceChildren(...items.map(([kind, label, glyph]) => {
    const button = action(label, kind === 'delete' ? 'is-destructive' : '', () => {
      closeFolderMenu();
      const current = state.library.folders.find(item => item.id === folder.id);
      if (root !== state.library.root || !current) return;
      if (kind === 'create') createFolder(current.id); else if (kind === 'icon') void run(() => openFolderIconEditor(current)); else if (kind === 'export') void exportLibraryItems('folder', current.id, root); else manageFolder(current, kind);
    }, glyph);
    button.dataset.folderAction = kind; button.setAttribute('role', 'menuitem'); return button;
  }));
  const colorSection = el('div', 'folder-color-section');
  colorSection.append(el('span', 'folder-color-title', '标记颜色'), colorPicker({ id: 'folderColorLabels', value: folder.colorLabel,
    onChange: value => saveFolderColor(folder.id, value, root) }));
  menu.append(colorSection);
  menu.classList.remove('hidden');
  const bounds = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(point?.x ?? bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(point?.y ?? bounds.bottom + 5, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button')?.focus();
}
async function manageFolder(folder, kind = 'rename') {
  const root = state.library.root;
  if (kind === 'delete') {
    const descendants = folderTree.descendantIds(state.library.folders, folder.id);
    const children = descendants.size - 1;
    const count = state.library.assets.filter(asset => descendants.has(asset.folderId)).length;
    const sure = await modal({ title: `删除「${folder.name}」？`, description: `将删除此文件夹${children ? `及 ${children} 个子文件夹` : ''}。${count} 个素材会完整保留并回到「未分类」，原文件不会删除。`, input: false, destructive: true, confirm: '删除文件夹' });
    if (!sure || !await waitForMetadata() || state.library.root !== root || state.libraryChanging) return;
    const snapshot = await run(() => api.deleteFolder(folder.id));
    if (snapshot) { applyLibrary(snapshot); toast('文件夹已删除，素材已保留在未分类'); }
  } else if (kind === 'move') {
    const excluded = folderTree.descendantIds(state.library.folders, folder.id);
    const result = await modal({ title: `移动「${folder.name}」`, description: '子文件夹和其中的素材会一起保留在原有层级中。', input: false, parentOptions: folderTree.flatten(state.library.folders).filter(item => !excluded.has(item.id)), parentId: folderTree.parentId(folder), confirm: '移动文件夹' });
    if (!result || !await waitForMetadata() || state.library.root !== root || state.libraryChanging) return;
    const snapshot = await run(() => api.moveFolder(folder.id, result.parentId));
    if (snapshot) { applyLibrary(snapshot); changeView('all', folder.id); toast('文件夹已移动'); }
  } else {
    const name = await modal({ title: '重命名文件夹', description: folderTree.path(state.library.folders, folder.id), value: folder.name, confirm: '保存名称' });
    if (!name?.trim() || !await waitForMetadata() || state.library.root !== root || state.libraryChanging) return;
    const snapshot = await run(() => api.renameFolder(folder.id, name.trim()));
    if (snapshot) { applyLibrary(snapshot); toast('文件夹名称已保存'); }
  }
}
async function importImages(folder, paths) {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  if (!hasLibrary()) { toast('请先选择素材库位置'); return; }
  if (state.libraryChanging) return;
  if (state.busy) { toast('正在导入，请稍候'); return; }
  stopGalleryPreviews();
  modelWarmup.pause();
  state.busy = true;
  renderHeader(filteredAssets());
  try {
    const result = paths ? await api.importPaths(paths, currentFolder()) : folder ? await api.importFolder(currentFolder()) : await api.importFiles(currentFolder());
    if (result?.cancelled) return;
    if (result?.snapshot) {
      if (state.view === 'trash' || state.view === 'favorites') { state.view = 'all'; state.tag = null; }
      applyLibrary(result.snapshot, false);
      const r = result.report || {};
      const messages = [`已导入 ${r.imported || 0} 个素材`];
      if (r.duplicates) messages.push(`${r.duplicates} 个重复文件已跳过`);
      if (r.unsupported?.length) messages.push(`${r.unsupported.length} 个不支持的文件已跳过`);
      if (r.errors?.length) messages.push(`${r.errors.length} 个文件导入失败`);
      toast(messages.join('，'), Boolean(r.errors?.length), 6500);
      if (r.errors?.length) toast(`首个失败原因：${r.errors[0].message || r.errors[0]}`, true, 10000);
      if (r.warnings?.length) toast(`资源打包提醒：${r.warnings[0].message}`, false, 10000);
    }
  } catch (error) { messageError(error); }
  finally { state.busy = false; renderHeader(filteredAssets()); modelWarmup.schedule(); }
}
async function trashSelected(trashed, ids = [...state.selected]) {
  if (!ids.length || deletingAssets || state.libraryChanging || (trashed && state.view === 'trash')) return;
  const root = state.library.root;
  const order = filteredAssets().map(asset => asset.id);
  deletingAssets = true;
  try {
    if (!await waitForMetadata() || state.library.root !== root) return;
    const snapshot = await run(() => api.setTrash(ids, trashed));
    if (!snapshot || state.library.root !== root) return;
    const preview = state.previewId ? { id: state.previewId, single: cylinderPreview.singleMode } : null;
    state.selected.clear();
    applyLibrary(snapshot);
    if (preview) {
      const remaining = filteredAssets();
      const available = new Set(remaining.map(asset => asset.id));
      const index = order.indexOf(preview.id);
      const next = available.has(preview.id) ? preview.id
        : order.slice(index + 1).find(id => available.has(id))
          || order.slice(0, Math.max(0, index)).reverse().find(id => available.has(id))
          || remaining[0]?.id;
      if (next) {
        state.selected = new Set([next]);
        updateSelectionClasses(); renderSelection(); renderDetails();
        openPreview(next);
        if (preview.single) cylinderPreview.enterSingle(next);
      } else closePreview();
    }
    toast(trashed ? `${ids.length} 个素材已移入回收站，可随时恢复` : `已恢复 ${ids.length} 个素材`);
  } finally { deletingAssets = false; }
}
async function deletePermanently(ids = [...state.selected]) {
  if (!ids.length || deletingAssets || state.libraryChanging) return;
  ids = [...new Set(ids)];
  const root = state.library.root;
  const assets = ids.map(id => state.library.assets.find(asset => asset.id === id));
  if (assets.some(asset => !asset?.trashedAt)) throw new Error('只能永久删除回收站中的素材');
  deletingAssets = true;
  try {
    if (!await waitForMetadata() || state.library.root !== root) return;
    const confirmed = await modal({
      title: ids.length === 1 ? '永久删除这份素材？' : `永久删除 ${ids.length} 份素材？`,
      description: `${ids.length === 1 ? `「${assets[0].name}」` : '所选素材'}在此素材库中的原文件和缩略图将被彻底删除，此操作不可恢复。导入前的来源文件不受影响。`,
      input: false, confirm: '永久删除', destructive: true
    });
    if (confirmed === null) return;
    if (state.library.root !== root) throw new Error('素材库已切换，请重新选择素材');
    const snapshot = await api.deletePermanently(ids, root);
    if (state.library.root !== root) return;
    if (state.previewId && ids.includes(state.previewId)) closePreview();
    state.selected.clear();
    applyLibrary(snapshot);
    toast(snapshot.deletionWarning || `已永久删除 ${ids.length} 个素材`, Boolean(snapshot.deletionWarning), snapshot.deletionWarning ? 10000 : 4500);
  } finally { deletingAssets = false; }
}
const cylinderPreview = new window.ShituCylinderPreview({
  viewport: $('previewCylinder'), ring: $('previewCylinderRing'), parking: $('previewMediaParking'),
  media: [$('previewImage'), $('previewVideo'), $('previewFallback')],
  createThumbnail: asset => {
    if (isAudio(asset)) return asset.thumbnail ? imageFor(asset, 'thumbnail', 'cylinder-thumb') : audioPlaceholder(asset, 'cylinder-audio-placeholder');
    if (isFont(asset)) return asset.thumbnail ? imageFor(asset, 'thumbnail', 'cylinder-thumb') : el('div', 'cylinder-video-placeholder font-placeholder-glyph', 'Aa');
    if (isProject(asset)) return asset.thumbnail ? imageFor(asset, 'thumbnail', 'cylinder-thumb') : el('div', 'cylinder-video-placeholder project-ae-glyph', 'Ae');
    if (isModel(asset)) return asset.thumbnail ? imageFor(asset, 'thumbnail', 'cylinder-thumb') : el('div', 'cylinder-video-placeholder', `3D 模型 · ${asset.ext.toUpperCase()}`);
    if (isVideo(asset)) return asset.thumbnail ? imageFor(asset, 'thumbnail', 'cylinder-thumb', true) : el('div', 'cylinder-video-placeholder', `视频 · ${(asset.ext || '').toUpperCase()}`);
    return imageFor(asset, 'thumb', 'cylinder-thumb');
  },
  onSelect: displayPreviewAsset,
  onModeChange: single => {
    $('preview').setAttribute('aria-label', single ? '单图预览' : '圆柱素材预览');
    $('previewBack').classList.toggle('hidden', !single);
    $('previewDensity').classList.toggle('hidden', single);
    $('previewMotion').classList.toggle('hidden', single);
    $('previewPrev').setAttribute('aria-label', single ? '上一张图片' : '向左转动圆柱');
    $('previewNext').setAttribute('aria-label', single ? '下一张图片' : '向右转动圆柱');
    $('previewHelp').textContent = single ? '滚轮缩放 · 中键拖动 · ← → 切图 · Esc 返回阵列' : '双击单图查看 · 滚轮转动 · Ctrl＋滚轮调整行数';
    if (isModel(state.library.assets.find(asset => asset.id === state.previewId) || {})) $('previewHelp').textContent = '左键旋转 · 滚轮缩放 · 右键平移 · ← → 切换模型';
    if (isProject(state.library.assets.find(asset => asset.id === state.previewId) || {})) $('previewHelp').textContent = '工程与素材已打包 · 导出后保留完整文件夹';
    if (isAudio(state.library.assets.find(asset => asset.id === state.previewId) || {})) {
      $('preview').setAttribute('aria-label', '音乐预览');
      $('previewPrev').setAttribute('aria-label', '上一份素材'); $('previewNext').setAttribute('aria-label', '下一份素材');
      $('previewHelp').textContent = '空格播放或暂停 · 拖动进度条定位 · ← → 切换素材';
    }
    if (isFont(state.library.assets.find(asset => asset.id === state.previewId) || {})) {
      $('preview').setAttribute('aria-label', '字体预览');
      $('previewPrev').setAttribute('aria-label', '上一份素材');
      $('previewNext').setAttribute('aria-label', '下一份素材');
      $('previewHelp').textContent = '输入文字试排 · 调整字号 · ← → 切换素材';
    }
  },
});
function displayProjectPreview(asset) {
  const expectedRoot = state.library.root, serial = videoPreviewSerial, bundle = asset.projectBundle;
  const box = $('previewProject');
  box.classList.remove('hidden');
  const layout = el('div', 'project-preview-layout');
  const surface = el('div', 'project-preview-surface');
  const image = el('img', 'hidden'); image.id = 'projectCompositionPreview'; image.alt = `${asset.name} 合成预览`; image.draggable = false;
  const placeholder = el('span', 'project-ae-glyph', 'Ae');
  const status = el('p', 'project-preview-status', '正在生成合成缩略图…'); status.id = 'projectPreviewStatus'; status.setAttribute('role', 'status');
  surface.append(image, placeholder, status);
  const info = el('div', 'project-preview-summary');
  const label = el('label', 'project-composition-control', '合成');
  const select = el('select'); select.id = 'projectCompositionSelect'; select.setAttribute('aria-label', '选择 AE 合成'); select.disabled = true; label.append(select);
  const compositionMeta = el('p', 'project-composition-meta');
  const warnings = el('p', 'project-preview-notes hidden');
  const retry = action('重试生成预览', 'secondary-button hidden', () => request(view.compositionId), 'refresh'); retry.id = 'projectPreviewRetry';
  const actions = el('div', 'project-preview-actions');
  const exportButton = action('导出完整文件夹', 'secondary-button', () => exportLibraryItems('assets', [asset.id], expectedRoot), 'download');
  exportButton.dataset.exportCommand = 'assets'; exportButton.disabled = Boolean(activeExport || state.busy || state.libraryChanging);
  actions.append(action('使用 AE 打开', 'primary-button', () => run(() => api.openAsset(asset.id)), 'external'), exportButton, retry);
  info.append(el('h2', '', asset.name), label, compositionMeta,
    el('p', '', `${bundle?.files?.length || 1} 个文件 · ${size(asset.size)} · 工程已重新链接包内素材`), warnings, actions);
  layout.append(surface, info); box.replaceChildren(layout);
  const view = { id: asset.id, root: expectedRoot, compositionId: undefined, requestSerial: 0, pending: false, updateProgress };
  projectPreviewView = view;
  const stillCurrent = () => serial === videoPreviewSerial && state.previewId === asset.id && state.library.root === expectedRoot && projectPreviewView === view;
  function updateProgress(detail) {
    if (!stillCurrent() || !view.pending || detail.status === 'ready') return;
    if (view.compositionId !== undefined && detail.compositionId != null && detail.compositionId !== view.compositionId) return;
    const text = { queued: '已加入缩略图生成队列…', preparing: '正在读取 AE 合成…', rendering: '正在渲染合成静态预览…', encoding: '正在保存合成缩略图…' }[detail.status];
    if (text) status.textContent = text;
  }
  function populate(compositions, selectedId) {
    const list = (compositions || []).filter(item => Number.isSafeInteger(item.id));
    select.replaceChildren(...list.map((item, index) => {
      const duplicate = list.some(other => other !== item && other.name === item.name);
      const option = el('option', '', `${item.name}${duplicate ? `（合成 ${index + 1}）` : ''} · ${item.width} × ${item.height}`); option.value = String(item.id); return option;
    }));
    select.disabled = !list.length;
    if (selectedId != null) select.value = String(selectedId);
  }
  async function request(compositionId) {
    const revision = ++view.requestSerial; view.compositionId = compositionId; view.pending = true;
    if (compositionId !== undefined) { image.classList.add('hidden'); placeholder.classList.remove('hidden'); }
    retry.classList.add('hidden'); status.classList.remove('hidden'); status.textContent = '正在生成合成静态预览…';
    try {
      const prepared = await api.prepareProjectPreview(asset.id, expectedRoot, compositionId);
      if (!stillCurrent() || revision !== view.requestSerial) return;
      const url = new URL(prepared?.thumbnailUrl);
      if (url.protocol !== 'shitu:' || url.hostname !== 'project-preview' || !/^\/[a-z0-9-]+\/thumbnail\.jpg$/i.test(url.pathname)) throw new Error('合成预览地址无效，请重试');
      populate(prepared.compositions, prepared.composition.id);
      view.compositionId = prepared.composition.id;
      image.onload = () => { if (stillCurrent() && revision === view.requestSerial) { status.classList.add('hidden'); placeholder.classList.add('hidden'); } };
      image.onerror = () => { if (stillCurrent() && revision === view.requestSerial) { status.textContent = '合成预览图片无法读取，请重试'; status.classList.remove('hidden'); retry.classList.remove('hidden'); } };
      image.src = url.href; image.classList.remove('hidden');
      compositionMeta.textContent = `${prepared.composition.name} · ${prepared.width} × ${prepared.height} · ${prepared.frameRate} fps · ${videoDuration(prepared.duration)}`;
      const notes = [...(bundle?.missing?.length ? [`缺少 ${bundle.missing.length} 个素材，请在 AE 中检查。`] : []), ...(bundle?.warnings || []), ...(prepared.warnings || [])];
      warnings.textContent = [...new Set(notes)].slice(0, 5).join('\n'); warnings.classList.toggle('hidden', !warnings.textContent);
    } catch (error) {
      if (!stillCurrent() || revision !== view.requestSerial) return;
      status.textContent = `合成预览未生成：${error?.message || '请稍后重试'}。工程已收录，可使用 AE 打开。`;
      status.classList.remove('hidden'); retry.classList.remove('hidden');
    } finally { if (revision === view.requestSerial) view.pending = false; }
  }
  populate(bundle?.compositions || asset.projectPreview?.compositions, asset.projectPreview?.composition?.id);
  if (asset.thumbnail) { image.src = api.assetUrl(asset.id, 'thumbnail') + `&v=${encodeURIComponent(asset.projectPreview?.generatedAt || '')}`; image.classList.remove('hidden'); placeholder.classList.add('hidden'); }
  select.addEventListener('change', () => request(Number(select.value)));
  request(undefined);
}
function videoSessionCurrent(session) {
  return videoPreviewSession === session && session.serial === videoPreviewSerial && state.previewId === session.asset.id && state.library.root === session.root && !session.controller.signal.aborted;
}
function previewUrl(prepared, assetId) {
  const url = new URL(prepared?.url);
  if (url.protocol !== 'shitu:' || url.hostname !== 'asset' || decodeURIComponent(url.pathname.slice(1)) !== assetId || url.searchParams.get('kind') !== 'preview')
    throw new Error('视频预览地址无效，请重新打开素材');
  return url.href;
}
function renderVideoTools(session = videoPreviewSession) {
  const video = $('previewVideo'), prepared = session?.prepared;
  const usable = prepared && videoSessionCurrent(session) && !video.error && !video.classList.contains('hidden');
  const full = usable && !prepared.previewOnly && !session.switchingSource;
  const alpha = usable && prepared.hasAlpha === true;
  $('previewVideoTools').classList.toggle('hidden', !full && !alpha);
  $('previewVideoBackdrop').classList.toggle('hidden', !alpha);
  if (alpha) video.dataset.videoBackdrop = $('previewVideoBackdrop').value;
  else delete video.dataset.videoBackdrop;
  for (const id of ['previewFramePrevious', 'previewFrameNext', 'previewSaveVideoCover'])
    $(id).disabled = !full || session.inspectBusy || video.seeking || video.readyState < 2;
}
async function inspectVideoFrame(action) {
  const session = videoPreviewSession, video = $('previewVideo');
  if (!session?.prepared || session.prepared.previewOnly || session.switchingSource || session.inspectBusy ||
      !videoSessionCurrent(session) || video.readyState < 2 || video.seeking || video.error) return;
  const source = previewUrl(session.prepared, session.asset.id);
  if (video.currentSrc !== source) return;
  const key = new URL(source).searchParams.get('key');
  video.pause();
  session.inspectBusy = true;
  renderVideoTools(session);
  try { await action({ session, video, key }); }
  catch (error) { if (videoSessionCurrent(session)) toast(transcodeMessage(error), true); }
  finally {
    session.inspectBusy = false;
    if (videoSessionCurrent(session)) renderVideoTools(session);
  }
}
function stepVideoFrame(direction) {
  return inspectVideoFrame(async ({ session, video, key }) => {
    const time = video.currentTime;
    const frame = await api.findVideoFrame(session.asset.id, session.root, key, time, direction);
    if (!videoSessionCurrent(session) || video.seeking || !video.paused || Math.abs(video.currentTime - time) > .001) return;
    if (frame && Number.isFinite(frame.seek)) video.currentTime = frame.seek;
    else toast(direction < 0 ? '已在第一帧' : '已在最后一帧');
  });
}
async function videoCoverBytes(video) {
  if (!video.videoWidth || !video.videoHeight) throw new Error('当前画面尚未准备好');
  const canvas = el('canvas');
  const ratio = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
  canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
  const context = canvas.getContext('2d'), backdrop = video.dataset.videoBackdrop;
  context.fillStyle = backdrop === 'white' ? '#fff' : backdrop === 'checker' ? '#e7e7e7' : '#000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (backdrop === 'checker') {
    context.fillStyle = '#b6b6b6';
    for (let y = 0; y < canvas.height; y += 12)
      for (let x = y % 24; x < canvas.width; x += 24) context.fillRect(x, y, 12, 12);
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
  if (!blob) throw new Error('无法生成当前画面的封面');
  return new Uint8Array(await blob.arrayBuffer());
}
function videoPosterUrl(asset) {
  const revision = asset.videoThumbnailRevision;
  return asset.thumbnail ? api.assetUrl(asset.id, 'thumbnail') + (revision ? `&v=${encodeURIComponent(revision)}` : '') : '';
}
function setVideoCover() {
  return inspectVideoFrame(async ({ session, video, key }) => {
    const bytes = await videoCoverBytes(video);
    if (!videoSessionCurrent(session)) return;
    const snapshot = await api.saveVideoThumbnail(session.asset.id, session.root, key, bytes);
    if (snapshot.root !== state.library.root) return;
    applyLibrary(snapshot);
    if (videoSessionCurrent(session)) {
      session.asset = snapshot.assets.find(asset => asset.id === session.asset.id);
      video.poster = videoPosterUrl(session.asset);
    }
    toast('已将当前画面设为封面');
  });
}
function renderVideoPreviewStatus(session = videoPreviewSession) {
  const current = session && videoSessionCurrent(session), visible = current && session.phase !== 'full';
  $('previewVideoStatus').classList.toggle('hidden', !visible);
  if (!visible) return;
  const progress = Number.isFinite(session.progress) ? Math.round(session.progress) : null;
  const loading = session.fullPending || session.quickPending;
  $('previewVideoStatusText').textContent = session.error
    ? `${session.quickReady ? '完整预览准备失败，当前仍是前 2 秒快速预览。' : '视频预览准备失败。'}${session.error} 可重试，或使用右上角按钮在系统播放器中打开。`
    : session.quickReady ? `前 2 秒快速预览，正在准备完整视频…${progress === null ? '' : ` ${progress}%`}`
      : session.fullPending ? `正在准备完整视频…${progress === null ? '' : ` ${progress}%`}`
        : `正在准备前 2 秒快速预览…${progress === null ? '' : ` ${progress}%`}`;
  $('previewVideoStatus').classList.toggle('is-error', Boolean(session.error));
  $('previewVideoProgress').classList.toggle('hidden', !loading || progress === null);
  $('previewVideoProgress').value = progress || 0;
  $('previewVideoRetry').classList.toggle('hidden', !session.error || loading);
}
function videoReady(video, session) {
  const source = video.src, signal = session.controller.signal;
  if (signal.aborted) return Promise.reject(new DOMException('视频预览已关闭', 'AbortError'));
  if (video.readyState >= 2 && !video.error && video.currentSrc === source) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return; finished = true;
      clearTimeout(timer); video.removeEventListener('loadeddata', ready); video.removeEventListener('canplay', ready); video.removeEventListener('error', failed); signal.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const ready = () => { if (video.readyState >= 2 && !video.error && video.currentSrc === source) finish(); };
    const failed = () => { if (video.error && (!video.currentSrc || video.currentSrc === source)) finish(new Error('此视频的编码暂无法在窗口中播放')); };
    const aborted = () => finish(new DOMException('视频预览已关闭', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('视频载入超时，请重试')), 30000);
    video.addEventListener('loadeddata', ready); video.addEventListener('canplay', ready); video.addEventListener('error', failed); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else ready();
  });
}
function videoPreviewMetadata(session, prepared) {
  const asset = session.asset;
  const duration = videoDuration(prepared.sourceDuration || prepared.duration);
  const codec = typeof prepared.codec === 'string' && prepared.codec ? `视频编码 ${prepared.codec.toUpperCase()}` : '';
  const dimensionsText = prepared.width && prepared.height ? `${prepared.width} × ${prepared.height}` : dimensions(asset);
  $('previewMeta').textContent = [asset.ext.toUpperCase(), codec, dimensionsText, duration, size(asset.size)].filter(Boolean).join('  ·  ');
}
function freezeVideoFrame(video, session) {
  if (!session.quickReady || !video.videoWidth || !video.videoHeight || !video.parentElement) return null;
  try {
    const cover = el('canvas', 'preview-video-cover');
    if (video.dataset.videoBackdrop) cover.dataset.videoBackdrop = video.dataset.videoBackdrop;
    cover.width = video.videoWidth; cover.height = video.videoHeight;
    cover.getContext('2d').drawImage(video, 0, 0); video.parentElement.append(cover); session.cover = cover; return cover;
  } catch { return null; }
}
async function showCompleteVideo(session, prepared) {
  const video = $('previewVideo'), url = previewUrl(prepared, session.asset.id);
  const staging = el('video'); session.staging = staging;
  staging.preload = 'auto'; staging.muted = true; staging.playsInline = true; staging.src = url; staging.load();
  try {
    await videoReady(staging, session);
    if (!videoSessionCurrent(session)) return;
    const resume = !session.quickReady || !video.paused;
    const time = session.quickReady ? video.currentTime : 0;
    freezeVideoFrame(video, session);
    video.dataset.previewSerial = String(session.serial); video.dataset.previewProfile = 'full'; video.dataset.previewOnly = 'false';
    session.switchingSource = true;
    renderVideoTools(session);
    video.controls = true; video.src = url; video.load(); video.classList.remove('hidden');
    await videoReady(video, session);
    if (!videoSessionCurrent(session)) return;
    const targetTime = Number.isFinite(video.duration) ? Math.max(0, Math.min(time, video.duration - 0.05)) : 0;
    if (targetTime > 0.05 && Math.abs(targetTime - video.currentTime) > 0.05) video.currentTime = targetTime;
    // Chromium can remain seeking forever when looping a one-frame stream.
    video.loop = !Number.isFinite(video.duration) || video.duration > 0.1;
    session.phase = 'full'; session.error = ''; session.fullPending = false;
    session.prepared = prepared;
    videoPreviewMetadata(session, prepared); $('previewFallback').classList.add('hidden'); renderVideoPreviewStatus(session);
    if (resume) await video.play().catch(() => {});
  } catch (error) {
    if (videoSessionCurrent(session) && session.quickReady && session.quickPrepared) {
      video.controls = false; video.loop = true; video.dataset.previewProfile = 'quick'; video.dataset.previewOnly = 'true';
      video.src = previewUrl(session.quickPrepared, session.asset.id); video.load(); video.classList.remove('hidden');
      $('previewFallback').classList.add('hidden'); void video.play().catch(() => {});
    }
    throw error;
  } finally {
    session.switchingSource = false;
    staging.pause(); staging.removeAttribute('src'); staging.load();
    if (session.staging === staging) session.staging = null;
    session.cover?.remove(); session.cover = null;
    if (videoSessionCurrent(session)) renderVideoTools(session);
  }
}
async function requestCompleteVideo(session) {
  if (!videoSessionCurrent(session) || session.fullPending) return;
  session.fullPending = true; session.error = ''; session.progress = null;
  session.requests.full = ++videoPreviewRequestSerial; renderVideoPreviewStatus(session);
  try {
    const prepared = await api.prepareVideo(session.asset.id, session.root, undefined, 'full', session.requests.full);
    if (!videoSessionCurrent(session)) return;
    await showCompleteVideo(session, prepared);
  } catch (error) {
    if (!videoSessionCurrent(session)) return;
    session.error = transcodeMessage(error);
    if (!session.quickReady) { $('previewVideo').classList.add('hidden'); $('previewFallback').textContent = '视频暂时无法预览，可使用右上角按钮在系统播放器中打开。'; $('previewFallback').classList.remove('hidden'); }
  } finally { if (videoSessionCurrent(session)) { session.fullPending = false; renderVideoPreviewStatus(session); } }
}
async function startQuickVideoPreview(asset) {
  const video = $('previewVideo');
  const session = { asset, root: state.library.root, serial: videoPreviewSerial, controller: new AbortController(), requests: {}, phase: 'quick', quickReady: false, quickPending: true, fullPending: false, progress: null, error: '' };
  videoPreviewSession = session;
  video.setAttribute('aria-label', asset.name); video.controls = false; video.preload = 'auto'; video.playsInline = true; video.muted = true; video.loop = true;
  video.poster = videoPosterUrl(asset);
  $('previewFallback').textContent = '正在准备视频预览…'; $('previewFallback').classList.remove('hidden');
  session.requests.quick = ++videoPreviewRequestSerial; renderVideoPreviewStatus(session);
  try {
    const prepared = await api.prepareVideo(asset.id, session.root, undefined, 'quick', session.requests.quick);
    if (!videoSessionCurrent(session)) return;
    video.dataset.previewSerial = String(session.serial); video.dataset.previewProfile = prepared.previewOnly ? 'quick' : 'full'; video.dataset.previewOnly = String(Boolean(prepared.previewOnly));
    video.controls = !prepared.previewOnly; video.src = previewUrl(prepared, asset.id); video.load(); video.classList.remove('hidden');
    await videoReady(video, session);
    if (!videoSessionCurrent(session)) return;
    videoPreviewMetadata(session, prepared); $('previewFallback').classList.add('hidden');
    session.quickReady = Boolean(prepared.previewOnly); session.phase = prepared.previewOnly ? 'quick' : 'full';
    session.prepared = prepared;
    renderVideoTools(session);
    if (!session.quickReady) video.loop = !Number.isFinite(video.duration) || video.duration > 0.1;
    if (session.quickReady) session.quickPrepared = prepared;
    await video.play().catch(() => {});
  } catch (error) {
    if (!videoSessionCurrent(session)) return;
    // A failed fast proxy can still fall back to a complete preview.
    session.quickReady = false;
  } finally {
    if (videoSessionCurrent(session)) {
      session.quickPending = false; session.progress = null; renderVideoPreviewStatus(session);
      if (session.phase !== 'full') void requestCompleteVideo(session);
    }
  }
}
function fontSessionCurrent(session) {
  return session === fontPreviewSession && session.serial === videoPreviewSerial && state.previewId === session.asset.id && state.library.root === session.root;
}
function renderFontSample() {
  if (!fontPreviewSession) return;
  const sample = $('fontPreviewSample');
  sample.textContent = $('fontPreviewText').value;
  fontPreviewLayout = window.ShituFontLayout.normalizeSettings({ ...fontPreviewLayout, fontSize: fontPreviewSize });
  Object.assign(sample.style, { fontSize: `${fontPreviewSize}px`, textAlign: fontPreviewLayout.align,
    letterSpacing: `${fontPreviewLayout.letterSpacing}px`, lineHeight: `${fontPreviewSize * fontPreviewLayout.lineHeight}px`,
    width: `${fontPreviewLayout.width}px`, height: `${fontPreviewLayout.height}px` });
  $('fontPreviewSizeValue').textContent = `${fontPreviewSize} px`;
  $('fontPreviewBackgroundColor').disabled = fontPreviewLayout.transparent;
  updateFontExportButton();
  if (fontPreviewSession.face?.status !== 'loaded' || !fontPreviewSession.prepared) return;
  const layout = window.ShituFontLayout.renderCanvas($('fontPreviewCanvas'), sample.textContent, fontPreviewLayout, sample.style.fontFamily);
  $('fontPreviewLayoutStatus').classList.toggle('is-warning', layout.overflow);
  $('fontPreviewLayoutStatus').textContent = layout.overflow ? '文字超出画布，导出时会裁切。请调小字号、间距或增加画布尺寸。' : `${fontPreviewLayout.width} × ${fontPreviewLayout.height} px · ${fontPreviewLayout.transparent ? '透明背景' : '纯色背景'}`;
  fitFontPreview();
}
function fitFontPreview() {
  if (!fontPreviewSession) return;
  const stage = $('fontPreviewStage'), style = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const scale = Math.max(0.001, Math.min(width / fontPreviewLayout.width, height / fontPreviewLayout.height));
  $('fontPreviewPaper').style.width = `${fontPreviewLayout.width * scale}px`;
  $('fontPreviewPaper').style.height = `${fontPreviewLayout.height * scale}px`;
  $('fontPreviewSample').style.transform = `scale(${scale})`;
}
function syncFontLayoutControls() {
  for (const [key, id] of Object.entries(fontLayoutFields)) {
    if (key === 'transparent') $(id).checked = fontPreviewLayout[key];
    else $(id).value = String(fontPreviewLayout[key]);
  }
}
function updateFontExportButton() {
  $('fontPreviewExport').disabled = fontPreviewExporting || $('previewFont').dataset.ready !== 'true' || !$('fontPreviewText').value.trim();
  $('fontPreviewExport').textContent = fontPreviewExporting ? '正在导出…' : '导出 PNG';
}
async function exportFontPreview() {
  const session = fontPreviewSession;
  if (!session?.prepared || !fontSessionCurrent(session) || fontPreviewExporting || $('previewFont').dataset.ready !== 'true') return;
  fontPreviewExporting = true; updateFontExportButton();
  try {
    const result = await api.exportFontImage(session.asset.id, session.root, {
      text: $('fontPreviewText').value, faceIndex: session.prepared.faceIndex || 0, settings: { ...fontPreviewLayout }
    });
    if (!result.canceled) toast(`已导出文字 PNG · ${result.width} × ${result.height}${result.overflow ? '（超出画布部分已裁切）' : ''}`);
  } catch (error) { messageError(error); }
  finally { fontPreviewExporting = false; updateFontExportButton(); }
}
async function loadFontPreviewFace(faceIndex = 0) {
  const session = fontPreviewSession;
  if (!session) return;
  const request = ++session.request;
  $('fontPreviewStatus').textContent = '正在载入字体…';
  $('fontPreviewStatus').classList.remove('hidden');
  $('fontPreviewSample').classList.add('hidden');
  $('fontPreviewPaper').classList.add('hidden');
  delete $('previewFont').dataset.ready;
  updateFontExportButton();
  let loadedFace, timer;
  const current = () => fontSessionCurrent(session) && request === session.request;
  try {
    const prepared = await api.prepareFont(session.asset.id, session.root, faceIndex);
    if (!current()) return;
    const source = new URL(prepared.url);
    if (source.protocol !== 'shitu:' || source.hostname !== 'font' || source.username || source.password || source.port) throw new Error('字体预览地址无效');
    const family = `shitu-preview-${session.serial}-${request}`;
    loadedFace = new FontFace(family, `url(${JSON.stringify(source.href)})`);
    await Promise.race([loadedFace.load(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('字体加载超时，请重试')), 15000); })]);
    if (!current()) return;
    if (session.face) document.fonts.delete(session.face);
    document.fonts.add(loadedFace); session.face = loadedFace;
    session.prepared = prepared;
    $('fontPreviewSample').style.fontFamily = `"${family}", sans-serif`;
    const faces = prepared.faces || [];
    $('fontPreviewFace').replaceChildren(...faces.map((face, index) => {
      const option = el('option', '', `${face.family || prepared.family || '字体'} · ${face.style || face.fullName || `样式 ${index + 1}`}`);
      option.value = String(face.index ?? index); return option;
    }));
    $('fontPreviewFace').value = String(prepared.faceIndex ?? faceIndex);
    $('fontPreviewFace').disabled = faces.length < 2;
    $('fontPreviewFaceField').classList.toggle('hidden', faces.length < 2);
    $('fontPreviewText').value = fontPreviewText === null ? (prepared.sampleText || 'Aa Bb Cc\n0123456789') : fontPreviewText;
    $('fontPreviewSize').value = String(fontPreviewSize);
    renderFontSample();
    $('fontPreviewStatus').classList.add('hidden');
    $('fontPreviewSample').classList.remove('hidden');
    $('fontPreviewPaper').classList.remove('hidden');
    $('previewFont').dataset.ready = 'true';
    updateFontExportButton();
    fitFontPreview();
    $('previewFont').dataset.faceIndex = String(prepared.faceIndex ?? faceIndex);
    $('previewMeta').textContent = [session.asset.ext.toUpperCase(), prepared.fullName || prepared.family, prepared.style, faces.length > 1 ? `${faces.length} 款字体` : '', size(session.asset.size)].filter(Boolean).join('  ·  ');
  } catch (error) {
    if (!current()) return;
    $('fontPreviewStatus').textContent = `暂时无法预览：${transcodeMessage(error)}。原字体文件已保留，可导出或用系统应用打开。`;
    $('fontPreviewStatus').classList.remove('hidden');
  } finally { clearTimeout(timer); }
}
function displayFontPreview(asset) {
  fontPreviewSession = { asset, root: state.library.root, serial: videoPreviewSerial, request: 0, face: null, prepared: null };
  $('preview').classList.add('is-font-preview');
  $('previewFont').classList.remove('hidden');
  $('fontPreviewFaceField').classList.add('hidden');
  syncFontLayoutControls();
  $('previewHelp').textContent = '输入文字试排 · 调整对齐和间距 · 导出 PNG';
  void loadFontPreviewFace();
}
function displayPreviewAsset(asset, index, total) {
  resetPreviewMedia();
  state.previewId = asset.id;
  $('preview').dataset.activeId = asset.id;
  $('previewName').textContent = asset.name;
  $('previewMeta').textContent = `${asset.ext.toUpperCase()}  ·  ${dimensions(asset)}  ·  ${size(asset.size)}`;
  $('previewIndex').textContent = `${index + 1} / ${total}`;
  $('previewFallback').classList.add('hidden');
  if (isAudio(asset)) {
    $('preview').classList.add('is-audio-preview');
    $('previewHelp').textContent = '空格播放或暂停 · 拖动进度条定位 · ← → 切换素材';
    void audioPreview.show(asset, state.library.root);
  } else if (isFont(asset)) {
    displayFontPreview(asset);
  } else if (isProject(asset)) {
    $('preview').classList.add('is-project-preview');
    displayProjectPreview(asset);
    $('previewHelp').textContent = '合成静态预览 · ← → 切换素材 · 导出保留工程与素材文件夹';
  } else if (isModel(asset)) {
    const serial = videoPreviewSerial;
    const expectedRoot = state.library.root;
    const stillCurrent = () => serial === videoPreviewSerial && state.previewId === asset.id && state.library.root === expectedRoot;
    $('preview').classList.add('is-model-preview');
    $('previewModel').classList.remove('hidden');
    $('previewModelStatus').textContent = ['blend', 'c4d', 'max'].includes(asset.ext)
      ? '正在准备 3D 预览，首次打开原生工程需要本机软件转换…' : '正在载入模型与贴图…';
    $('previewModelStatus').classList.remove('hidden');
    $('previewModelSurface').classList.add('hidden');
    $('previewHelp').textContent = '左键旋转 · 滚轮缩放 · 右键平移 · ← → 切换模型';
    Promise.resolve().then(async () => {
      if (!stillCurrent()) return;
      const prepared = await api.prepareModel(asset.id, expectedRoot);
      if (!stillCurrent()) return;
      modelViewerModule ||= import('./model-viewer.js');
      const module = await modelViewerModule;
      if (!stillCurrent()) return;
      modelViewer ||= module.create($('previewModelSurface'));
      $('previewModelSurface').classList.remove('hidden');
      const metadata = await modelViewer.load(prepared);
      if (!stillCurrent()) return;
      $('previewModelStatus').classList.add('hidden');
      $('previewModel').dataset.ready = 'true';
      $('previewMeta').textContent = [asset.ext.toUpperCase(), `${metadata.meshes} 个网格`, `${metadata.triangles.toLocaleString()} 个三角面`, `${asset.modelBundle.files.length} 个文件`, size(asset.size)].join('  ·  ');
    }).catch(error => {
      if (!stillCurrent()) return;
      $('previewModelSurface').classList.add('hidden');
      $('previewModelStatus').textContent = `暂时无法预览：${error?.message || '请稍后重试'}。模型与贴图已保存在资源包中，可从右上角使用原软件打开。`;
      $('previewModelStatus').classList.remove('hidden');
    });
  } else if (isVideo(asset)) {
    void startQuickVideoPreview(asset);
  } else {
    $('previewImage').src = api.assetUrl(asset.id, 'original');
    $('previewImage').alt = asset.name;
  }
}
function openPreview(id) {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  stopGalleryPreviews({ deferCancel: true });
  modelWarmup.pause();
  const list = filteredAssets();
  if (!list.some(asset => asset.id === id)) return;
  $('preview').classList.remove('hidden');
  document.body.classList.add('is-preview-open');
  cylinderPreview.open(list, id);
  $('previewClose').focus();
}
function resetPreviewMedia() {
  audioPreview.reset();
  $('preview').classList.remove('is-audio-preview');
  if (fontPreviewSession?.face) document.fonts.delete(fontPreviewSession.face);
  fontPreviewSession = null;
  $('previewFont').classList.add('hidden');
  delete $('previewFont').dataset.ready;
  delete $('previewFont').dataset.faceIndex;
  $('fontPreviewSample').style.removeProperty('font-family');
  $('fontPreviewSample').textContent = '';
  $('fontPreviewPaper').classList.add('hidden');
  $('fontPreviewCanvas').width = 1;
  $('fontPreviewCanvas').height = 1;
  updateFontExportButton();
  $('preview').classList.remove('is-font-preview');
  const session = videoPreviewSession;
  if (session) {
    session.controller.abort(); session.cover?.remove();
    if (session.staging) { session.staging.pause(); session.staging.removeAttribute('src'); session.staging.load(); }
    Promise.resolve(api.releaseVideoViewer(session.asset.id, session.root)).catch(() => {});
  }
  videoPreviewSession = null; $('previewVideoStatus').classList.add('hidden');
  renderVideoTools();
  videoPreviewSerial++;
  projectPreviewView = null;
  $('previewProject').replaceChildren();
  modelViewer?.clear();
  $('preview').classList.remove('is-model-preview');
  $('preview').classList.remove('is-project-preview');
  $('previewProject').classList.add('hidden');
  $('previewModel').classList.add('hidden');
  delete $('previewModel').dataset.ready;
  $('previewVideo').pause();
  $('previewVideo').removeAttribute('src');
  $('previewVideo').removeAttribute('poster');
  delete $('previewVideo').dataset.previewSerial;
  delete $('previewVideo').dataset.previewProfile;
  delete $('previewVideo').dataset.previewOnly;
  $('previewVideo').load();
  $('previewVideo').classList.add('hidden');
  $('previewImage').removeAttribute('src');
  $('previewImage').classList.add('hidden');
}
function closePreview() { state.previewId = null; $('preview').classList.add('hidden'); document.body.classList.remove('is-preview-open'); resetPreviewMedia(); cylinderPreview.close(); delete $('preview').dataset.activeId; }
function movePreview(direction) {
  const current = state.library.assets.find(asset => asset.id === state.previewId);
  if (current && isAudio(current)) {
    const next = window.ShituAudioPreview.adjacent(filteredAssets(), current.id, direction);
    if (next) openPreview(next.id);
    return;
  }
  cylinderPreview.turn(direction);
}
function toggleDetails(show = !state.details) {
  state.details = show;
  document.querySelector('.app-shell').classList.toggle('details-hidden', !show);
  $('detailsPanel').classList.toggle('hidden', !show);
  $('toggleDetails').setAttribute('aria-pressed', String(show));
  if (show) renderDetails();
}
let refreshingCollector = false;
let collectorRefreshTimer;
async function showCapturedAssets(result) {
  if (!await waitForMetadata()) return;
  const snapshot = await api.getLibrary();
  if (result.libraryRoot && snapshot.root !== result.libraryRoot) throw new Error('素材库已切换，请回到采集时的素材库查看');
  if (state.library.root && snapshot.root !== state.library.root) return;
  if (!state.library.root) applyLibrary(snapshot, false);
  const ids = [...(result.assetIds || []), ...(result.existingAssets || []).map(asset => asset.id)];
  const asset = snapshot.assets.find(item => ids.includes(item.id));
  if (!asset) throw new Error('素材已不存在，无法定位');
  showAssetInOverview(asset, snapshot, { inFolder: true });
  if (!$('collectorOverlay').classList.contains('hidden')) closeCollector();
}
function showAssetInOverview(asset, snapshot, { inFolder = false } = {}) {
  closePreview();
  state.view = asset?.trashedAt ? 'trash' : 'all';
  state.folder = inFolder && !asset?.trashedAt ? asset?.folderId || null : null;
  state.smartFolder = null; state.tag = null; state.search = ''; state.format = 'all'; state.missingResources = false; state.sort = 'newest';
  $('searchInput').value = ''; $('formatFilter').value = 'all'; $('sortSelect').value = 'newest';
  applyLibrary(snapshot, false);
  if (asset) {
    state.selected = new Set([asset.id]);
    state.anchor = asset.id;
    state.limit = Math.max(240, filteredAssets().findIndex(item => item.id === asset.id) + 1);
    render();
    requestAnimationFrame(() => document.querySelector(`.asset-card[data-asset-id="${CSS.escape(asset.id)}"]`)?.scrollIntoView({ block: 'center' }));
  }
}
function renderCaptureResult(result) {
  const box = $('collectorLastCapture');
  box.replaceChildren(); box.classList.toggle('hidden', !result);
  if (!result) return;
  const messages = { reading: '正在解析 YouTube 视频…', receiving: '正在接收浏览器中的素材…', downloading: '正在下载网页素材，尚未入库…',
    muxing: '正在合并音视频，保留原画质和声音…', importing: '下载完成，正在写入素材库…' };
  let message = messages[result.status];
  if (result.status === 'error') message = `上次采集未保存：${result.error || '请重试'}`;
  if (result.status === 'complete') message = result.imported ? `已采集 ${result.imported} 个素材` : result.existingAssets?.some(asset => asset.trashedAt) ? '这份素材已在回收站中，可查看后恢复' : '素材库中已有这份文件';
  box.append(el('span', '', message || '采集处理中…'));
  if (result.status === 'complete') box.append(action('查看采集素材', 'text-button', () => run(() => showCapturedAssets(result))));
}
async function refreshCollector(quiet = false) {
  if (refreshingCollector) return;
  if (!hasLibrary()) {
    $('collectorStatus').classList.add('unavailable');
    $('collectorStatus').textContent = '请先选择素材库位置，再连接浏览器采集。采集的图片和视频会存入你选择的素材库。';
    return;
  }
  refreshingCollector = true;
  $('refreshCollector').disabled = true;
  if (!quiet) $('collectorStatus').textContent = '正在检查本地接收服务…';
  try {
    const info = await api.getCollectorInfo();
    const available = info.enabled && info.ready !== false;
    $('collectorStatus').classList.toggle('unavailable', !available);
    $('collectorStatus').textContent = info.ready === false ? '请先选择素材库位置，再使用浏览器采集。' : available ? '本地接收服务已就绪 · 采集时请保持 Mosaic 运行' : `本地接收服务暂不可用${info.error ? `：${info.error}` : '，请重启 Mosaic 后再试'}`;
    $('collectorPath').textContent = info.extensionPath ? `扩展目录：${info.extensionPath}` : '';
    $('openExtensionFolder').disabled = !info.extensionPath;
    renderCaptureResult(info.lastCapture);
  } catch (error) {
    $('collectorStatus').classList.add('unavailable');
    $('collectorStatus').textContent = `无法读取本地接收服务状态：${error.message || error}`;
  } finally { refreshingCollector = false; $('refreshCollector').disabled = false; }
}
function showCollector() {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  stopGalleryPreviews();
  $('collectorOverlay').classList.remove('hidden');
  $('collectorClose').focus();
  refreshCollector();
  clearInterval(collectorRefreshTimer);
  collectorRefreshTimer = setInterval(() => {
    if ($('collectorOverlay').classList.contains('hidden')) { clearInterval(collectorRefreshTimer); return; }
    refreshCollector(true);
  }, 1500);
}
function closeCollector() { clearInterval(collectorRefreshTimer); $('collectorOverlay').classList.add('hidden'); $('collectorButton').focus(); }

$('newFolder').addEventListener('click', () => createFolder());
$('createFolderHere').addEventListener('click', () => { if (canNavigateFolders()) createFolder(currentFolder()); });
$('undoHistoryButton').addEventListener('click', () => { void performHistory('undo'); });
$('redoHistoryButton').addEventListener('click', () => { void performHistory('redo'); });
$('detailsContent').addEventListener('input', renderHistory);
$('folderBack').addEventListener('click', () => navigateFolderHistory('back'));
$('folderForward').addEventListener('click', () => navigateFolderHistory('forward'));
$('folderUp').addEventListener('click', navigateFolderUp);
$('folderNavigation').addEventListener('keydown', event => {
  if ([' ', 'Enter', 'Delete', 'Backspace'].includes(event.key)) event.stopPropagation();
});
document.addEventListener('pointerdown', event => {
  if (!$('folderContextMenu').classList.contains('hidden') && !$('folderContextMenu').contains(event.target) && !event.target.closest('.folder-more')) closeFolderMenu();
});
$('folderNav').addEventListener('keydown', event => {
  // Keep a focused folder control's Space/Enter/Delete away from gallery shortcuts.
  if ([' ', 'Enter', 'Delete', 'Backspace'].includes(event.key)) event.stopPropagation();
});
$('folderNav').addEventListener('pointerdown', event => {
  const row = event.target.closest('.folder-row[data-folder-id]');
  if (!row || event.target.closest('.folder-toggle,.folder-more') || !canStartFolderTreeDrag()) return;
  folderTreeDrag.begin(event, row.dataset.folderId);
});
$('folderNav').addEventListener('click', event => {
  if (!draggingFolders && !folderMoveSaving && performance.now() >= suppressFolderClickUntil) return;
  event.preventDefault(); event.stopImmediatePropagation();
}, true);
$('folderPanel').addEventListener('keydown', event => {
  // Preserve native button activation without triggering gallery shortcuts.
  if (event.target.closest('button') && [' ', 'Enter', 'Delete', 'Backspace'].includes(event.key)) event.stopPropagation();
});
$('folderContextMenu').addEventListener('keydown', event => {
  event.stopPropagation();
  const buttons = [...$('folderContextMenu').querySelectorAll('button')];
  const index = buttons.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFolderMenu(true); }
  else if (event.key === 'Tab') closeFolderMenu();
});
window.addEventListener('resize', () => closeFolderMenu());
// Collection menus use native disclosure controls and keep the workspace clear.
const collectionMenus = [...document.querySelectorAll('.collection-menu')];
$('folderPanelPin').addEventListener('click', event => {
  event.preventDefault(); event.stopPropagation();
  setFolderPanelMode(folderPanelMode === 'sidebar' ? 'dropdown' : 'sidebar', { open: folderPanelMode === 'sidebar', focus: true });
});
$('folderBrowserToggle').addEventListener('click', event => {
  if (folderPanelMode !== 'sidebar') return;
  event.preventDefault();
  setFolderPanelMode('dropdown', { open: true, focus: true });
});
for (const menu of collectionMenus) {
  const summary = menu.querySelector('summary');
  summary.addEventListener('keydown', event => {
    // Keep native disclosure activation away from the gallery's Space preview.
    if ([' ', 'Enter', 'Delete', 'Backspace'].includes(event.key)) event.stopPropagation();
  });
  menu.addEventListener('toggle', () => {
    if (menu.id === 'folderBrowser' && folderPanelMode === 'sidebar') {
      if (menu.open) menu.open = false;
      summary.setAttribute('aria-expanded', 'true');
      summary.title = '文件夹已固定在左侧，点击恢复下拉列表';
      return;
    }
    summary.setAttribute('aria-expanded', String(menu.open));
    if (menu.classList.contains('folder-browser')) summary.title = `${menu.open ? '收起' : '展开'}文件夹列表`;
    if (menu.open) {
      stopGalleryPreviews();
      collectionMenus.filter(other => other !== menu).forEach(other => { other.open = false; });
    }
  });
}
document.addEventListener('click', event => {
  if (!event.target.closest('.collection-menu') || event.target.closest('.collection-menu .nav-item,.collection-menu .tag-pill,#newFolder')) {
    collectionMenus.forEach(menu => { menu.open = false; });
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') collectionMenus.forEach(menu => { menu.open = false; });
});
$('importFiles').addEventListener('click', () => importImages(false));
$('importFolder').addEventListener('click', () => importImages(true));
$('selectionModeButton').addEventListener('click', () => run(async () => {
  if (await waitForMetadata()) setSelectionMode(!state.selectionMode);
}));
$('galleryScroller').addEventListener('pointerdown', beginMarquee);
for (const type of ['click', 'dblclick']) $('galleryScroller').addEventListener(type, event => {
  if (suppressMarqueeClick) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
$('galleryScroller').addEventListener('scroll', () => { stopGalleryPreviews(); modelWarmup.viewportChanged(); if (marquee?.active) updateMarquee(); });
$('galleryScroller').addEventListener('lostpointercapture', event => { if (marquee?.pointerId === event.pointerId) stopMarquee(true, true); });
window.addEventListener('pointermove', moveMarquee, { passive: false });
window.addEventListener('pointermove', event => assetFolderDrag.move(event), { passive: false });
window.addEventListener('pointerup', event => assetFolderDrag.end(event));
window.addEventListener('pointercancel', () => assetFolderDrag.cancel());
document.body.addEventListener('lostpointercapture', () => { if (assetFolderDrag.active) assetFolderDrag.cancel(); });
window.addEventListener('pointermove', event => folderTreeDrag.move(event), { passive: false });
window.addEventListener('pointerup', event => folderTreeDrag.end(event));
window.addEventListener('pointercancel', () => folderTreeDrag.cancel());
document.body.addEventListener('lostpointercapture', event => {
  if (folderTreeDrag.active && event.target === document.body) folderTreeDrag.cancel();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && (assetFolderDrag.pending || folderTreeDrag.pending)) {
    folderTreeDrag.cancel(); assetFolderDrag.cancel(); event.preventDefault(); event.stopImmediatePropagation();
  } else if (folderTreeDrag.active || folderMoveSaving) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);
window.addEventListener('pointerup', event => { if (marquee?.pointerId === event.pointerId) stopMarquee(false, true); });
window.addEventListener('pointercancel', event => { if (marquee?.pointerId === event.pointerId) stopMarquee(true, true); });
window.addEventListener('blur', () => { folderTreeDrag.cancel(); assetFolderDrag.cancel(); stopGalleryPreviews(); modelWarmup.pause(); stopMarquee(true, true); });
window.addEventListener('resize', () => { stopGalleryPreviews(); modelWarmup.viewportChanged(); stopMarquee(true, true); });
window.addEventListener('focus', modelWarmup.schedule);
window.addEventListener('pointermove', modelWarmup.schedule, { passive: true });
window.addEventListener('keydown', modelWarmup.schedule);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { folderTreeDrag.cancel(); assetFolderDrag.cancel(); stopGalleryPreviews(); modelWarmup.pause(); }
  else modelWarmup.schedule();
});
api.onWindowVisibility?.(visible => {
  if (visible) modelWarmup.schedule();
  else { folderTreeDrag.cancel(); stopGalleryPreviews(); modelWarmup.pause(); }
});
$('searchInput').addEventListener('input', (e) => { state.search = e.target.value; state.limit = 240; state.selected.clear(); render(); });
$('formatFilter').addEventListener('change', (e) => { state.format = e.target.value; state.limit = 240; state.selected.clear(); render(); });
$('missingResourcesFilter').addEventListener('click', () => run(async () => {
  const root = state.library.root;
  if (!await waitForMetadata() || root !== state.library.root) return;
  state.missingResources = !state.missingResources;
  state.selected.clear(); state.anchor = null; state.limit = 240;
  $('galleryScroller').scrollTop = 0;
  render();
}));
$('sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; renderGallery(filteredAssets()); });
function setThumbnailSize(value) {
  const slider = $('sizeSlider');
  const next = Math.max(Number(slider.min), Math.min(Number(slider.max), Math.round(value)));
  slider.value = String(next);
  document.documentElement.style.setProperty('--card-size', `${next}px`);
}
$('sizeSlider').addEventListener('input', (e) => setThumbnailSize(Number(e.target.value)));
let thumbnailWheelRemainder = 0;
$('galleryScroller').addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  // Prevent Chromium's page zoom, including when the thumbnail size is at a limit.
  event.preventDefault();
  if (!event.deltaY) return;
  const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? event.currentTarget.clientHeight : 1);
  thumbnailWheelRemainder += Math.max(-40, Math.min(40, -pixels * 0.2));
  const step = Math.trunc(thumbnailWheelRemainder);
  if (!step) return;
  thumbnailWheelRemainder -= step;
  const before = Number($('sizeSlider').value);
  setThumbnailSize(before + step);
  if (Number($('sizeSlider').value) === before) thumbnailWheelRemainder = 0;
}, { passive: false });
$('clearSelection').addEventListener('click', () => { state.selected.clear(); updateSelectionClasses(); renderSelection(); renderDetails(); });
$('trashSelection').addEventListener('click', () => trashSelected(true));
$('restoreSelection').addEventListener('click', () => trashSelected(false));
$('deleteSelection').addEventListener('click', () => run(() => deletePermanently()));
$('loadMore').addEventListener('click', () => { state.limit += 240; renderGallery(filteredAssets()); });
$('toggleDetails').addEventListener('click', () => toggleDetails());
$('closeDetails').addEventListener('click', () => toggleDetails(false));
$('exportSelection').addEventListener('click', () => exportLibraryItems('assets', [...state.selected], state.library.root));
$('backupButton').addEventListener('click', () => run(async () => {
  if (!hasLibrary() || state.libraryChanging) return;
  const button = $('backupButton'); button.disabled = true;
  try { const result = await api.backup(); if (result && !result.cancelled) toast(`素材库备份完成\n${result.path}`, false, 8000); }
  finally { button.disabled = !hasLibrary() || state.libraryChanging; }
}));
$('collectorButton').addEventListener('click', showCollector);
$('pluginCenterButton').addEventListener('click', () => { stopGalleryPreviews(); run(() => openPluginCenter()); });
$('appUpdateButton').addEventListener('click', showAppUpdate);
$('setupAppUpdate').addEventListener('click', showAppUpdate);
$('appUpdateClose').addEventListener('click', closeAppUpdate);
$('appUpdateOverlay').addEventListener('click', event => { if (event.target === $('appUpdateOverlay')) closeAppUpdate(); });
$('videoTranscodeButton').addEventListener('click', () => openVideoTranscode());
$('settingsButton').addEventListener('click', openTranscodeSettings);
$('skinButton').addEventListener('click', () => { stopGalleryPreviews(); skinPickerUi.open(); });
function setHeaderMenuOpen(open, { focus = false } = {}) {
  $('headerMoreButton').setAttribute('aria-expanded', String(open));
  $('headerMenu').classList.toggle('hidden', !open);
  if (open) stopGalleryPreviews();
  if (focus) $('headerMoreButton').focus({ preventScroll: true });
}
$('headerMoreButton').addEventListener('click', () => setHeaderMenuOpen($('headerMenu').classList.contains('hidden')));
$('headerMenu').addEventListener('click', event => {
  if (event.target.closest('button:not(:disabled)')) setHeaderMenuOpen(false, { focus: true });
}, true);
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.header-more')) setHeaderMenuOpen(false);
});
document.addEventListener('focusin', event => {
  if (!event.target.closest('.header-more')) setHeaderMenuOpen(false);
});
document.querySelector('.header-more').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('headerMenu').classList.contains('hidden')) {
    event.preventDefault(); event.stopPropagation(); setHeaderMenuOpen(false, { focus: true });
  }
});
function renderWindowState(snapshot) {
  const custom = snapshot?.customControls === true;
  const expanded = snapshot?.maximized === true || snapshot?.fullScreen === true;
  document.documentElement.toggleAttribute('data-custom-window', custom);
  document.documentElement.toggleAttribute('data-window-maximized', custom && expanded);
  $('windowControls').hidden = !custom;
  const label = expanded ? '还原窗口' : '最大化窗口';
  $('windowMaximize').setAttribute('aria-label', label);
  $('windowMaximize').title = label;
}
if (api.windowState && api.windowCommand) {
  let stateRevision = 0;
  api.onWindowState?.(snapshot => { stateRevision++; renderWindowState(snapshot); });
  api.windowState().then(snapshot => { if (!stateRevision) renderWindowState(snapshot); }).catch(messageError);
  for (const [id, command] of [['windowMinimize', 'minimize'], ['windowMaximize', 'toggle-maximize'], ['windowClose', 'close']]) {
    $(id).addEventListener('click', () => { void run(() => api.windowCommand(command)); });
  }
}
if (api.setWindowSkin) {
  const syncWindowSkin = () => { void api.setWindowSkin(window.ShituSkins.current().id).catch(messageError); };
  window.addEventListener('shitu-skin-change', syncWindowSkin);
  syncWindowSkin();
}
for (const region of [document.querySelector('.app-header'), $('windowControls')]) {
  region.addEventListener('keydown', event => {
    if (event.target.closest('button') && [' ', 'Enter', 'Delete', 'Backspace'].includes(event.key)) event.stopPropagation();
  });
}
$('videoTranscodeSettings').addEventListener('click', openTranscodeSettings);
$('transcodeSettingsClose').addEventListener('click', closeTranscodeSettings);
$('transcodeSettingsCancel').addEventListener('click', closeTranscodeSettings);
$('transcodeSettingsOverlay').addEventListener('click', event => { if (event.target === $('transcodeSettingsOverlay')) closeTranscodeSettings(); });
$('transcodeSettingsForm').addEventListener('submit', event => { event.preventDefault(); void saveTranscodeSettings(); });
$('transcodeSettingsRefresh').addEventListener('click', () => { void loadTranscodeSettings(true); });
for (const [id, field] of [['transcodeSettingsMode', 'mode'], ['transcodeSettingsGpu', 'gpuId'], ['transcodeSettingsCpuThreads', 'cpuThreads']]) {
  $(id).addEventListener(field === 'cpuThreads' ? 'input' : 'change', event => {
    transcodeSettingsUi.draft[field] = event.target.value; transcodeSettingsUi.error = ''; renderTranscodeSettings();
  });
}
$('videoTranscodeClose').addEventListener('click', closeVideoTranscode);
$('videoTranscodeBackground').addEventListener('click', closeVideoTranscode);
$('videoTranscodeOverlay').addEventListener('click', event => { if (event.target === $('videoTranscodeOverlay')) closeVideoTranscode(); });
$('videoTranscodeCancel').addEventListener('click', () => { void cancelVideoTranscode(); });
$('videoTranscodeForm').addEventListener('submit', event => { event.preventDefault(); void startVideoTranscode(); });
function transcodeOptionsChanged() {
  transcodeUi.presetId = '';
  transcodeUi.error = '';
  renderVideoTranscode();
}
$('transcodePreset').addEventListener('change', event => {
  applyTranscodePreset(transcodeUi.presets.find(preset => preset.id === event.target.value));
  transcodeUi.error = '';
  renderVideoTranscode();
});
$('transcodePresetAdd').addEventListener('click', () => {
  transcodeUi.presetEditing = true;
  $('transcodePresetName').value = '';
  renderVideoTranscode();
  $('transcodePresetName').focus();
});
$('transcodePresetCancel').addEventListener('click', () => {
  transcodeUi.presetEditing = false;
  transcodeUi.error = '';
  renderVideoTranscode();
  $('transcodePresetAdd').focus();
});
$('transcodePresetName').addEventListener('input', renderVideoTranscode);
$('transcodePresetName').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  void changeTranscodePreset('save');
});
$('transcodePresetSave').addEventListener('click', () => { void changeTranscodePreset('save'); });
$('transcodePresetRemove').addEventListener('click', () => { void changeTranscodePreset('remove'); });
$('videoTranscodeFormat').addEventListener('change', transcodeOptionsChanged);
$('videoTranscodeAlpha').addEventListener('change', transcodeOptionsChanged);
$('videoTranscodeBitratePreset').addEventListener('change', event => {
  if (event.target.value !== 'custom') $('videoTranscodeBitrate').value = event.target.value;
  else $('videoTranscodeBitrate').focus();
  transcodeOptionsChanged();
});
$('videoTranscodeBitrate').addEventListener('input', () => {
  const value = $('videoTranscodeBitrate').value;
  $('videoTranscodeBitratePreset').value = ['5', '10', '20', '40', '80'].includes(value) ? value : 'custom';
  transcodeOptionsChanged();
});
$('appUpdateCheck').addEventListener('click', () => runUpdateAction(() => api.checkUpdate()));
$('appUpdateOpenRelease').addEventListener('click', async () => {
  try { await api.openUpdateRelease(); }
  catch (error) { toast(updateErrorMessage(error), true, 8000); }
});
$('appUpdateDownload').addEventListener('click', () => runUpdateAction(() => api.downloadUpdate()));
$('appUpdateInstall').addEventListener('click', installAppUpdate);
$('collectorClose').addEventListener('click', closeCollector);
$('collectorOverlay').addEventListener('click', (event) => { if (event.target === $('collectorOverlay')) closeCollector(); });
$('refreshCollector').addEventListener('click', refreshCollector);
$('openExtensionFolder').addEventListener('click', () => run(() => api.openExtensionFolder()));
$('libraryInfo').addEventListener('click', showLibraryManager);
$('setupCreateLibrary').addEventListener('click', () => changeLibrary('create'));
$('setupOpenLibrary').addEventListener('click', () => changeLibrary('open'));
$('setupUseLegacy').addEventListener('click', () => changeLibrary('legacy'));
$('managerCreateLibrary').addEventListener('click', () => changeLibrary('create'));
$('managerOpenLibrary').addEventListener('click', () => changeLibrary('open'));
$('managerMigrateLibrary').addEventListener('click', () => changeLibrary('migrate'));
$('managerRevealLibrary').addEventListener('click', () => run(() => api.revealLibrary()));
$('managerCloseLibrary').addEventListener('click', closeLibraryManager);
$('libraryManagerOverlay').addEventListener('click', (event) => { if (event.target === $('libraryManagerOverlay')) closeLibraryManager(); });
$('modalForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (modalHasColor) {
    const value = readCustomColor(true);
    if (value === null) { $('modalColorHex').focus(); return; }
    resolveModal(value);
    return;
  }
  const input = !$('modalInput').classList.contains('hidden'), name = $('modalInput').value.trim();
  if (input && !name) return;
  resolveModal(modalHasParent ? { name, parentId: $('modalParent').value || null } : input ? name : true);
});
const syncCustomColorPicker = () => {
  $('modalColorHex').value = $('modalColorPicker').value.toUpperCase();
  readCustomColor();
};
for (const event of ['input', 'change']) $('modalColorPicker').addEventListener(event, syncCustomColorPicker);
$('modalColorHex').addEventListener('input', () => readCustomColor());
$('modalColorHex').addEventListener('change', () => {
  const value = readCustomColor(true);
  if (value !== null) $('modalColorHex').value = value.toUpperCase();
});
$('modalCancel').addEventListener('click', () => resolveModal(null));
$('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) resolveModal(null); });
$('previewClose').addEventListener('click', closePreview);
$('previewBack').addEventListener('click', () => cylinderPreview.exitSingle());
$('previewPrev').addEventListener('click', () => movePreview(-1));
$('previewNext').addEventListener('click', () => movePreview(1));
$('previewOpen').addEventListener('click', () => run(() => api.openAsset(state.previewId)));
$('fontPreviewText').addEventListener('input', () => { fontPreviewText = $('fontPreviewText').value.slice(0, 2000); $('fontPreviewText').value = fontPreviewText; renderFontSample(); });
$('fontPreviewSize').addEventListener('input', () => { fontPreviewSize = Math.max(8, Math.min(600, Number($('fontPreviewSize').value) || 72)); $('fontPreviewPreset').value = 'custom'; renderFontSample(); });
function readFontLayoutControls() {
  const settings = { fontSize: fontPreviewSize };
  for (const [field, controlId] of Object.entries(fontLayoutFields)) settings[field] = field === 'transparent' ? $(controlId).checked : $(controlId).value;
  const next = window.ShituFontLayout.normalizeSettings(settings);
  if (JSON.stringify(next) !== JSON.stringify(fontPreviewLayout)) {
    fontPreviewLayout = next;
    $('fontPreviewPreset').value = 'custom';
    renderFontSample();
  }
}
for (const id of Object.values(fontLayoutFields)) {
  $(id).addEventListener('input', readFontLayoutControls);
  $(id).addEventListener('change', () => { readFontLayoutControls(); syncFontLayoutControls(); });
}
for (const preset of window.ShituFontLayout.PRESETS) {
  const option = el('option', '', preset.name); option.value = preset.id;
  $('fontPreviewPreset').append(option);
}
$('fontPreviewPreset').addEventListener('change', () => {
  if ($('fontPreviewPreset').value === 'custom') return;
  fontPreviewLayout = window.ShituFontLayout.applyPreset($('fontPreviewPreset').value, fontPreviewLayout);
  fontPreviewSize = fontPreviewLayout.fontSize;
  $('fontPreviewSize').value = String(fontPreviewSize);
  syncFontLayoutControls(); renderFontSample();
});
$('fontPreviewExport').addEventListener('click', () => { void exportFontPreview(); });
new ResizeObserver(fitFontPreview).observe($('fontPreviewStage'));
$('fontPreviewFace').addEventListener('change', () => { void loadFontPreviewFace(Number($('fontPreviewFace').value)); });
$('fontPreviewReset').addEventListener('click', () => {
  fontPreviewText = null;
  $('fontPreviewText').value = fontPreviewSession?.prepared?.sampleText || 'Aa Bb Cc\n0123456789';
  renderFontSample();
});
$('preview').addEventListener('contextmenu', event => {
  if (!state.previewId) return;
  const target = event.target instanceof Element ? event.target : event.target.parentElement;
  const card = target?.closest('.cylinder-card[data-asset-id]');
  const focusedImage = target?.closest('#previewFocusContent,#previewImage,#previewVideo,#previewFallback,#previewProject,#fontPreviewSample,#previewAudio');
  if (card || focusedImage) assetContextMenuEvent(event, card?.dataset.assetId || state.previewId);
}, true);
$('detailsContent').addEventListener('contextmenu', event => {
  const target = event.target instanceof Element ? event.target : event.target.parentElement;
  const preview = target?.closest('.detail-preview[data-asset-id]');
  if (preview) assetContextMenuEvent(event, preview.dataset.assetId);
}, true);
$('previewImage').addEventListener('error', () => {
  const asset = state.library.assets.find((item) => item.id === state.previewId);
  if (asset && !isAudio(asset) && !isVideo(asset) && !isModel(asset) && !isProject(asset) && !isFont(asset)) {
    $('previewImage').classList.add('hidden');
    $('previewFallback').textContent = '此图片格式无法在窗口中预览，可使用右上角按钮在系统应用中打开。';
    $('previewFallback').classList.remove('hidden');
  }
});
$('previewVideo').addEventListener('error', () => {
  if (videoPreviewSession?.switchingSource) return;
  const asset = state.library.assets.find((item) => item.id === state.previewId);
  if (asset && isVideo(asset) && $('previewVideo').hasAttribute('src') && $('previewVideo').dataset.previewSerial === String(videoPreviewSerial)) {
    $('previewVideo').classList.add('hidden');
    $('previewFallback').textContent = '此视频的编码暂无法在窗口中播放，可使用右上角按钮在系统播放器中打开。文件仍完整保留在素材库中。';
    $('previewFallback').classList.remove('hidden');
  }
});
$('previewImage').addEventListener('load', () => {
  const asset = state.library.assets.find((item) => item.id === state.previewId);
  if (asset && !isAudio(asset) && !isVideo(asset) && !isModel(asset) && !isProject(asset) && !isFont(asset)) { $('previewImage').classList.remove('hidden'); $('previewFallback').classList.add('hidden'); }
});
$('previewVideo').addEventListener('loadeddata', () => {
  const asset = state.library.assets.find((item) => item.id === state.previewId);
  if (asset && isVideo(asset) && $('previewVideo').dataset.previewSerial === String(videoPreviewSerial)) { $('previewVideo').classList.remove('hidden'); $('previewFallback').classList.add('hidden'); }
});
$('previewVideoRetry').addEventListener('click', () => { if (videoPreviewSession) void requestCompleteVideo(videoPreviewSession); });
$('previewFramePrevious').addEventListener('click', () => { void stepVideoFrame(-1); });
$('previewFrameNext').addEventListener('click', () => { void stepVideoFrame(1); });
$('previewVideoBackdrop').addEventListener('change', () => renderVideoTools());
$('previewSaveVideoCover').addEventListener('click', () => { void setVideoCover(); });
for (const event of ['seeking', 'seeked', 'loadeddata', 'error'])
  $('previewVideo').addEventListener(event, () => renderVideoTools());
window.addEventListener('pagehide', resetPreviewMedia);
window.addEventListener('pagehide', () => { batchRenameUi.close(true); fontCompareUi.close(); smartFoldersUi.close(); folderIconsUi.close(true); skinPickerUi.close(); });
$('batchRenameSelection').addEventListener('click', () => run(() => openBatchRename()));
$('compareFontsSelection').addEventListener('click', () => run(() => openFontCompare()));
$('newSmartFolder').addEventListener('click', () => run(() => openSmartFolderEditor()));
$('galleryScroller').addEventListener('click', (e) => { if (performance.now() >= suppressAssetClickUntil && (e.target === $('galleryScroller') || e.target === $('gallery'))) { flushDetailDrafts(); state.selected.clear(); updateSelectionClasses(); renderSelection(); renderDetails(); } });

document.addEventListener('keydown', (e) => {
  if (!$('transcodeSettingsOverlay').classList.contains('hidden')) {
    if (e.key === 'Escape') { e.preventDefault(); closeTranscodeSettings(); }
    if (e.key === 'Tab') {
      const controls = [...$('transcodeSettingsDialog').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(node => !node.closest('.hidden') && !node.matches(':disabled'));
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { e.preventDefault(); $('transcodeSettingsDialog').focus(); }
      else if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if (!$('videoTranscodeOverlay').classList.contains('hidden')) {
    if (e.key === 'Escape') { e.preventDefault(); closeVideoTranscode(); }
    if (e.key === 'Tab') {
      const controls = [...$('videoTranscodeDialog').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(node => !node.closest('.hidden'));
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { e.preventDefault(); $('videoTranscodeDialog').focus(); }
      else if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if (!$('appUpdateOverlay').classList.contains('hidden')) {
    if (e.key === 'Escape') { e.preventDefault(); closeAppUpdate(); }
    if (e.key === 'Tab') {
      const targets = [...$('appUpdateDialog').querySelectorAll('button:not(:disabled)')].filter(node => !node.closest('.hidden'));
      const first = targets[0], last = targets[targets.length - 1];
      if (!first) { e.preventDefault(); $('appUpdateDialog').focus(); }
      else if (e.shiftKey && (document.activeElement === first || !targets.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !targets.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if (window.shituPlugins?.isOpen() || featureDialogOpen()) return;
  const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (!$('libraryManagerOverlay').classList.contains('hidden')) { if (e.key === 'Escape') { e.preventDefault(); closeLibraryManager(); } return; }
  if (!$('collectorOverlay').classList.contains('hidden')) { if (e.key === 'Escape') { e.preventDefault(); closeCollector(); } return; }
  if (modalResolve) { if (e.key === 'Escape') { e.preventDefault(); resolveModal(null); } return; }
  if (!hasLibrary() || state.libraryChanging) return;
  const historyAction = historyControls.keyAction(e, { editing, blocked: historyUi.pending || historyBlocked() });
  if (historyAction) {
    if (historyControls.command(historyUi.snapshot, historyAction) || historyAction === 'undo' && hasHistoryDrafts()) { e.preventDefault(); void performHistory(historyAction); }
    return;
  }
  if (e.key === 'Delete') {
    if (editing) return;
    e.preventDefault();
    if (!e.repeat) {
      const ids = state.previewId ? [state.previewId] : [...state.selected];
      run(() => state.view === 'trash' ? deletePermanently(ids) : trashSelected(true, ids));
    }
    return;
  }
  if (e.key === 'Escape' && state.selectionMode && !state.previewId) {
    e.preventDefault();
    if (!stopMarquee(true, true)) setSelectionMode(false);
    return;
  }
  if (state.previewId) {
    if (editing && e.key !== 'Escape') return;
    if (e.target?.closest?.('#previewAudioPlayer') && e.key !== 'Escape') return;
    if ([' ', 'Enter'].includes(e.key) && document.activeElement?.closest('button')) return;
    if (e.key === 'Escape') { e.preventDefault(); if (cylinderPreview.singleMode && !$('preview').classList.contains('is-model-preview') && !$('preview').classList.contains('is-project-preview') && !$('preview').classList.contains('is-font-preview') && !$('preview').classList.contains('is-audio-preview')) cylinderPreview.exitSingle(); else closePreview(); return; }
    if (e.key === ' ') {
      e.preventDefault();
      const asset = state.library.assets.find((item) => item.id === state.previewId);
      if (asset && isAudio(asset)) audioPreview.toggle();
      else if (asset && isVideo(asset) && !$('previewVideo').classList.contains('hidden')) {
        if ($('previewVideo').paused) $('previewVideo').play().catch(messageError);
        else $('previewVideo').pause();
      } else if (!asset || (!isAudio(asset) && !isModel(asset) && !isProject(asset) && !isFont(asset))) closePreview();
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); movePreview(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); movePreview(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); cylinderPreview.moveRow(-1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); cylinderPreview.moveRow(1); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && ['k', 'f'].includes(e.key.toLowerCase())) { e.preventDefault(); $('searchInput').focus(); $('searchInput').select(); return; }
  if (editing) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(e.key)) {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'ArrowUp') navigateFolderUp(); else navigateFolderHistory(e.key === 'ArrowLeft' ? 'back' : 'forward');
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault(); state.selected = new Set(filteredAssets().map((a) => a.id)); updateSelectionClasses(); renderSelection(); renderDetails();
  } else if (e.key === ' ' && state.selected.size) {
    e.preventDefault(); openPreview([...state.selected][0]);
  } else if (e.key === 'Escape') {
    state.selected.clear(); updateSelectionClasses(); renderSelection(); renderDetails();
  }
});
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); if (!draggingAssets && !folderTreeDrag.pending && !folderMoveSaving && hasLibrary() && !state.libraryChanging && [...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth += 1; $('dropOverlay').classList.remove('hidden'); } });
document.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = draggingAssets || folderTreeDrag.pending || folderMoveSaving ? 'none' : 'copy'; });
document.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) $('dropOverlay').classList.add('hidden'); });
document.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('dropOverlay').classList.add('hidden');
  if (draggingAssets || folderTreeDrag.pending || folderMoveSaving) return;
  const paths = [...(e.dataTransfer?.files || [])].map((file) => api.getFilePath(file)).filter(Boolean);
  if (paths.length) importImages(false, paths);
});
api.onAssetDragEnd?.(finishAssetDrag);
api.onActionError?.(message => { finishAssetDrag(); messageError(new Error(message)); });
window.addEventListener('focus', () => { if (nativeAssetDrag) finishAssetDrag(); });
window.ShituTaskCenter.create({
  panel: $('progressPanel'), openButton: $('taskCenterButton'), api,
  onOpen: () => stopGalleryPreviews(), onError: messageError,
  openTranscode: { canOpen: id => transcodeUi.snapshot?.id === id, open: openVideoTranscode }
});
api.onWebCapture?.(result => {
  if (!result?.ok) return;
  const message = result.imported ? `浏览器已采集 ${result.imported} 个素材` : result.existingAssets?.some(asset => asset.trashedAt) ? '这份素材已在回收站中' : '素材库中已有这份文件';
  const notice = toast(message, false, 20000, { text: '查看', run: () => showCapturedAssets(result) });
  notice.dataset.webCapture = 'true';
  renderCaptureResult({ ...result, status: 'complete' });
});
api.onWebCaptureLocate?.(result => run(() => showCapturedAssets(result)));
api.onLibraryChanged?.(() => run(async () => {
  const serial = ++libraryRefreshSerial;
  const snapshot = await api.getLibrary();
  if (serial === libraryRefreshSerial) applyLibrary(snapshot);
}));
api.onHistory?.(snapshot => receiveHistory(snapshot));
api.onProjectPreview?.(detail => {
  if (detail?.id === projectPreviewView?.id && detail.root === projectPreviewView.root) projectPreviewView.updateProgress(detail);
});
api.onSimilarImageProgress?.(detail => similarImagesUi.updateProgress(detail));
api.onExportProgress?.(updateExportProgress);
window.addEventListener('beforeunload', (event) => {
  folderTreeDrag.cancel();
  assetFolderDrag.cancel();
  stopGalleryPreviews();
  modelWarmup.pause();
  similarImagesUi.close();
  if (closeReady) return;
  flushDetailDrafts();
  if (!pendingSaves.size) return;
  event.preventDefault();
  event.returnValue = false;
  if (closing) return;
  closing = true;
  const finishClosing = async () => {
    let succeeded = true;
    while (pendingSaves.size) {
      const results = await Promise.all([...pendingSaves]);
      if (results.some((ok) => !ok)) succeeded = false;
      if (!succeeded) break;
      flushDetailDrafts();
    }
    closing = false;
    if (succeeded) {
      closeReady = true;
      try { await api.requestClose(); } catch (error) { closeReady = false; messageError(error); }
    } else toast('有修改尚未保存，窗口已保留。请重试保存后再关闭。', true, 9000);
  };
  finishClosing();
});
try { if (localStorage.getItem(folderPanelStorageKey) === 'sidebar') folderPanelMode = 'sidebar'; } catch {}
setFolderPanelMode(folderPanelMode, { persist: false });
run(async () => { const library = await api.getLibrary(); applyLibrary(library); }).then((result) => {
  if (result === null) {
    state.library.libraryError = '暂时无法读取素材库设置，请重新打开 Mosaic 后再试。';
    render();
  }
});

if (api.onUpdateState && api.updateState) {
  api.onUpdateState(snapshot => {
    updateUi.revision += 1;
    receiveUpdateState(snapshot);
  });
  const revision = updateUi.revision;
  api.updateState().then(snapshot => {
    if (revision === updateUi.revision) receiveUpdateState(snapshot, false);
  }).catch(() => {
    if (revision === updateUi.revision) receiveUpdateState({ status: 'error', message: '暂时无法读取更新状态，请稍后重试。' }, false);
  });
} else receiveUpdateState({ status: 'disabled', message: '当前版本暂未启用自动更新。' }, false);

renderVideoTranscode();
renderHistory();
if (api.getTranscodeSettings) {
  api.getTranscodeSettings().then(settings => {
    if (!transcodeSettingsUi.draft && !transcodeSettingsUi.loading) { transcodeSettingsUi.settings = settings; renderVideoTranscode(); }
  }).catch(() => {});
}
if (api.onVideoTranscode && api.videoTranscodeState) {
  let transcodeRevision = 0;
  api.onVideoTranscode(snapshot => { transcodeRevision++; receiveVideoTranscode(snapshot); });
  const revision = transcodeRevision;
  api.videoTranscodeState().then(snapshot => { if (revision === transcodeRevision) receiveVideoTranscode(snapshot, false); }).catch(() => {});
}
if (api.onVideoPreview) api.onVideoPreview(event => {
  const session = videoPreviewSession;
  if (!session || !videoSessionCurrent(session) || event.id !== session.asset.id || event.root !== session.root ||
      !['quick', 'full'].includes(event.profile) || event.requestSerial !== session.requests[event.profile] ||
      (event.profile === 'full' ? !session.fullPending : !session.quickPending)) return;
  if (Number.isFinite(event.progress)) session.progress = Math.max(0, Math.min(100, event.progress));
  renderVideoPreviewStatus(session);
});
function refreshSmartFolderTime() {
  if (!activeSmartFolder()?.rule.recentDays || document.hidden || state.busy || state.libraryChanging || state.previewId ||
      featureDialogOpen() || pendingSaves.size || hasHistoryDrafts() || draggingAssets || folderTreeDrag.pending || folderMoveSaving || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const visible = new Set(filteredAssets().map(asset => asset.id));
  state.selected = new Set([...state.selected].filter(id => visible.has(id)));
  render();
}
const smartFolderRefresh = setInterval(refreshSmartFolderTime, 60000);
new ResizeObserver(positionSelectionNotices).observe($('selectionBar'));
window.addEventListener('resize', positionSelectionNotices);
window.addEventListener('focus', refreshSmartFolderTime);
window.addEventListener('pagehide', () => clearInterval(smartFolderRefresh), { once: true });
