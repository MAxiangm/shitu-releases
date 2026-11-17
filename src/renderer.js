'use strict';

const api = window.shitu;
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const state = { library: { assets: [], folders: [], tags: [], stats: {}, root: null, needsLibrary: true }, view: 'all', folder: null, tag: null, selected: new Set(), selectionMode: false, anchor: null, search: '', format: 'all', sort: 'newest', limit: 240, previewId: null, details: false, busy: false, libraryChanging: false };
let modalResolve = null;
let metadataQueue = Promise.resolve(true);
const pendingSaves = new Set();
let closeReady = false;
let closing = false;
let libraryRefreshSerial = 0;
let draggingAssets = false;
let suppressAssetClickUntil = 0;
let marquee = null;
let marqueeFrame = 0;
let suppressMarqueeClick = false;
let deletingAssets = false;
let videoPreviewSerial = 0;
let projectPreviewView;
let modelViewer;
let modelViewerModule;
const updateUi = {
  snapshot: { status: 'idle', currentVersion: '', latestVersion: '', progress: 0 },
  pending: false, preparingInstall: false, previousFocus: null, notices: new Set(), revision: 0
};

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
function action(label, className, handler, glyph) {
  const node = el('button', className);
  node.type = 'button';
  if (glyph) node.append(icon(glyph));
  node.append(document.createTextNode(label));
  if (handler) node.addEventListener('click', handler);
  return node;
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
function dimensions(a) { return isProject(a) ? 'AE 工程' : isModel(a) ? '3D 模型' : a.width && a.height ? `${a.width} × ${a.height}` : '尺寸未知'; }
function videoDuration(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '';
  const seconds = Math.round(Number(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
const videoExtensions = new Set(['mp4', 'm4v', 'mov', 'qt', 'webm', 'ogv', 'ogg', 'mkv', 'avi', 'wmv', 'asf', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'mts', 'm2ts', 'ts', 'm2t', 'vob', 'flv', 'f4v', 'mxf', '3gp', '3g2', 'divx', 'dxv', 'rm', 'rmvb', 'dv']);
function isVideo(asset) { return asset.mediaType === 'video' || videoExtensions.has((asset.ext || '').replace(/^\./, '').toLowerCase()); }
const modelExtensions = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'blend', 'c4d', 'max']);
function isModel(asset) { return asset.mediaType === 'model' || modelExtensions.has((asset.ext || '').replace(/^\./, '').toLowerCase()); }
function isProject(asset) { return asset.mediaType === 'project' || ['aep', 'aepx'].includes((asset.ext || '').replace(/^\./, '').toLowerCase()); }
function mimeType(asset) {
  return asset.mimeType || ({ mp4: 'video/mp4', m4v: 'video/mp4', f4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', qt: 'video/quicktime', dxv: 'video/quicktime', ogv: 'video/ogg', ogg: 'video/ogg', avi: 'video/x-msvideo', divx: 'video/x-msvideo', mkv: 'video/x-matroska', mpg: 'video/mpeg', mpeg: 'video/mpeg', mpe: 'video/mpeg', m1v: 'video/mpeg', m2v: 'video/mpeg', mts: 'video/mp2t', m2ts: 'video/mp2t', m2t: 'video/mp2t', ts: 'video/mp2t', vob: 'video/mpeg', wmv: 'video/x-ms-wmv', asf: 'video/x-ms-asf', flv: 'video/x-flv', mxf: 'application/mxf', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', rm: 'application/vnd.rn-realmedia', rmvb: 'application/vnd.rn-realmedia-vbr', dv: 'video/dv', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif' })[(asset.ext || '').toLowerCase()] || '—';
}
function selectedAssets() { return state.library.assets.filter((a) => state.selected.has(a.id)); }
function currentFolder() { return state.folder || null; }
function hasLibrary() { return Boolean(state.library.root) && !state.library.needsLibrary; }
function viewName() {
  if (state.folder) return state.library.folders.find((f) => f.id === state.folder)?.name || '文件夹';
  return { all: '全部素材', recent: '最近导入', favorites: '收藏', unfiled: '未分类', trash: '回收站' }[state.view] || '全部素材';
}
function toast(message, error = false, duration = 4500, link) {
  const item = el('div', `toast${error ? ' error' : ''}`, message);
  item.setAttribute('role', error ? 'alert' : 'status');
  if (link) item.append(action(link.text, 'toast-action', () => run(link.run)));
  $('toastStack').append(item);
  setTimeout(() => item.remove(), duration);
  return item;
}
function messageError(error) { toast(error?.message || String(error), true, 8000); }
async function run(fn) { try { return await fn(); } catch (error) { messageError(error); return null; } }
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
  task.then(() => pendingSaves.delete(task));
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
  $('appUpdateButton').classList.toggle('has-update', ['available', 'downloaded'].includes(status));
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

async function runUpdateAction(action) {
  if (updateUi.pending) return;
  updateUi.pending = true;
  renderAppUpdate();
  try {
    const result = await action();
    if (result?.status) receiveUpdateState(result);
  } catch (error) {
    updateUi.snapshot = {
      ...updateUi.snapshot,
      status: ['checking', 'downloading', 'installing'].includes(updateUi.snapshot.status) ? 'error' : updateUi.snapshot.status,
      error: error?.message || '更新未完成，请稍后重试。'
    };
    messageError(error);
  } finally {
    updateUi.pending = false;
    updateUi.preparingInstall = false;
    renderAppUpdate();
  }
}

async function installAppUpdate() {
  if (updateUi.pending || updateUi.snapshot.status !== 'downloaded') return;
  if (state.busy || state.libraryChanging || draggingAssets || deletingAssets) {
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
  if (rootChanged) {
    closePreview();
    state.selectionMode = false;
    state.view = 'all';
    state.folder = null;
    state.tag = null;
    state.search = '';
    state.format = 'all';
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
  if (state.folder && !library.folders.some((f) => f.id === state.folder)) state.folder = null;
  if (!preserveSelection) state.selected.clear();
  else {
    const visible = new Set(filteredAssets().map((a) => a.id));
    state.selected = new Set([...state.selected].filter((id) => visible.has(id)));
  }
  render();
}
function filteredAssets() {
  const terms = state.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const list = state.library.assets.filter((a) => {
    if (state.view === 'trash' ? !a.trashedAt : Boolean(a.trashedAt)) return false;
    if (state.folder && a.folderId !== state.folder) return false;
    if (!state.folder && state.view === 'recent' && new Date(a.createdAt).getTime() < weekAgo) return false;
    if (!state.folder && state.view === 'favorites' && (a.rating || 0) < 4) return false;
    if (!state.folder && state.view === 'unfiled' && a.folderId) return false;
    if (state.tag && !(a.tags || []).includes(state.tag)) return false;
    const ext = (a.ext || '').replace(/^\./, '').toLowerCase();
    if (state.format !== 'all') {
      if (state.format === 'video') { if (!isVideo(a)) return false; }
      else if (state.format === 'model') { if (!isModel(a)) return false; }
      else if (state.format === 'project') { if (!isProject(a)) return false; }
      else if (state.format === 'images') { if (isVideo(a) || isModel(a) || isProject(a)) return false; }
      else if (state.format === 'jpg' ? !['jpg', 'jpeg'].includes(ext) : state.format === 'other' ? ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext) || isVideo(a) || isModel(a) || isProject(a) : ext !== state.format) return false;
    }
    if (terms.length) {
      const haystack = `${a.name} ${(a.tags || []).join(' ')} ${a.notes || ''} ${a.sourceUrl || ''} ${a.pageUrl || ''}`.toLocaleLowerCase();
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
function changeView(view, folder = null) {
  state.view = view;
  state.folder = folder;
  state.tag = null;
  state.selected.clear();
  state.anchor = null;
  state.limit = 240;
  $('galleryScroller').scrollTop = 0;
  render();
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
    const item = action('', `nav-item${!state.folder && state.view === key ? ' active' : ''}`, () => changeView(key), glyph);
    item.dataset.view = key;
    item.append(el('span', 'nav-name', label), el('span', 'nav-count', count.toLocaleString()));
    if (!state.folder && state.view === key) item.setAttribute('aria-current', 'page');
    return item;
  }));
  const counts = new Map();
  active.forEach((a) => counts.set(a.folderId, (counts.get(a.folderId) || 0) + 1));
  $('folderNav').replaceChildren(...state.library.folders.map((folder) => {
    const row = el('div', 'folder-row');
    const item = action('', `nav-item${state.folder === folder.id ? ' active' : ''}`, () => changeView('all', folder.id), 'folder');
    item.dataset.folderId = folder.id;
    item.append(el('span', 'nav-name', folder.name), el('span', 'nav-count', String(counts.get(folder.id) || 0)));
    item.title = folder.name;
    const more = action('', 'folder-more', () => manageFolder(folder), 'more');
    more.title = `管理文件夹「${folder.name}」`;
    more.setAttribute('aria-label', more.title);
    row.append(item, more);
    return row;
  }));
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
  const name = viewName();
  $('breadcrumbCurrent').textContent = name;
  $('pageTitle').replaceChildren(document.createTextNode(name), el('span', 'title-dot', '.'));
  $('pageSubtitle').textContent = state.folder ? '把相关的灵感放在一起。' : { all: '收集值得留下的灵感。', recent: '过去 7 天，为灵感留个位置。', favorites: '四星及以上的素材，值得再次回看。', unfiled: '为散落的灵感，找到一个位置。', trash: '暂时放下的素材，随时可以恢复。' }[state.view];
  $('resultCount').textContent = `${list.length.toLocaleString()} 个素材${state.search || state.format !== 'all' || state.tag ? ' · 筛选结果' : ''}`;
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
  img.alt = asset.name;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    img.classList.add('hidden');
    const fallback = el('div', 'asset-fallback');
    fallback.append(icon(videoThumbnail ? 'video' : 'image'), el('span', '', `${(asset.ext || (videoThumbnail ? '视频' : '图像')).toUpperCase()} · 暂无缩略图`));
    img.parentElement?.append(fallback);
  }, { once: true });
  return img;
}
function mediaFor(asset, kind) {
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
function renderGallery(list) {
  stopMarquee();
  const frag = document.createDocumentFragment();
  list.slice(0, state.limit).forEach((asset) => {
    const card = el('article', `asset-card${state.selected.has(asset.id) ? ' selected' : ''}`);
    card.setAttribute('role', 'listitem');
    card.tabIndex = 0;
    card.dataset.assetId = asset.id;
    card.setAttribute('aria-label', asset.name);
    card.setAttribute('aria-selected', String(state.selected.has(asset.id)));
    card.draggable = !state.selectionMode && !asset.trashedAt;
    card.dataset.trashed = String(Boolean(asset.trashedAt));
    const thumb = el('div', 'asset-thumb');
    const check = el('span', 'asset-check');
    check.setAttribute('aria-hidden', 'true');
    check.append(icon('check'));
    thumb.append(mediaFor(asset, 'thumb'), check, el('span', 'asset-format', (asset.ext || '').toUpperCase()));
    if (isVideo(asset) || isModel(asset) || isProject(asset)) {
      const badge = el('span', 'asset-video-badge');
      badge.append(icon(isProject(asset) ? 'folder' : isModel(asset) ? 'grid' : 'video'), document.createTextNode(isProject(asset) ? 'AE 工程' : isModel(asset) ? '3D 模型' : '视频'));
      thumb.append(badge);
    }
    const info = el('div', 'asset-card-info');
    const name = el('div', 'asset-name', asset.name);
    name.title = asset.name;
    const subline = el('div', 'asset-subline');
    subline.append(el('span', '', asset.width && asset.height ? dimensions(asset) : isVideo(asset) ? '视频素材' : '尺寸未知'));
    if (asset.rating) subline.append(el('span', 'asset-stars', '★'.repeat(asset.rating)));
    else subline.append(el('span', '', size(asset.size)));
    info.append(name, subline);
    if (asset.tags?.length) {
      const tags = el('div', 'asset-tags');
      asset.tags.slice(0, 3).forEach((tag) => tags.append(el('span', '', tag)));
      info.append(tags);
    }
    card.append(thumb, info);
    card.addEventListener('click', (event) => { if (performance.now() >= suppressAssetClickUntil) selectCard(asset.id, event, list); });
    card.addEventListener('dblclick', () => { if (!state.selectionMode && performance.now() >= suppressAssetClickUntil) openPreview(asset.id); });
    card.addEventListener('dragstart', event => beginAssetDrag(event, asset));
    card.addEventListener('dragend', finishAssetDrag);
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
  renderSelectionMode();
  $('loadMore').classList.toggle('hidden', list.length <= state.limit);
  $('loadMore').textContent = `加载更多 · 还有 ${Math.max(0, list.length - state.limit).toLocaleString()} 个`;
  $('emptyState').classList.toggle('hidden', list.length > 0);
  if (!list.length) renderEmpty();
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
  if (!draggingAssets) return;
  draggingAssets = false;
  suppressAssetClickUntil = performance.now() + 250;
  document.body.classList.remove('dragging-assets');
  $('dropOverlay').classList.add('hidden');
}
function beginAssetDrag(event, asset) {
  event.preventDefault();
  event.stopPropagation();
  if (state.selectionMode || asset.trashedAt || state.busy || state.libraryChanging) return;
  selectForAssetAction(asset.id);
  draggingAssets = true;
  suppressAssetClickUntil = performance.now() + 250;
  document.body.classList.add('dragging-assets');
  $('dropOverlay').classList.add('hidden');
  try { api.startAssetDrag([...state.selected], state.library.root); }
  catch (error) { finishAssetDrag(); messageError(error); }
}
async function showAssetContextMenu(id) {
  if (!hasLibrary() || state.libraryChanging || draggingAssets) return;
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
  if (state.previewId && ['rename', 'tags', 'folder', 'favorite', 'unfavorite', 'trash', 'restore'].includes(result.action)) closePreview();
  switch (result.action) {
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
    case 'favorite':
    case 'unfavorite':
      await saveMetadata(async () => {
        checkRoot();
        let snapshot;
        for (const asset of assets) snapshot = await api.updateAssets([asset.id], { rating: result.action === 'favorite' ? Math.max(4, asset.rating || 0) : 0 });
        return snapshot;
      }); break;
    case 'export': {
      const exported = await api.exportAssets(ids);
      if (exported && !exported.cancelled) toast(`已导出 ${exported.count ?? ids.length} 个素材`);
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
    assets: state.library.assets.filter(asset => !asset.trashedAt && !isVideo(asset) && !isModel(asset) && !isProject(asset)),
    selectedIds: ids, libraryRoot: state.library.root, pluginId
  });
}
function renderEmpty() {
  const box = $('emptyState');
  const isNew = state.library.assets.length === 0;
  box.replaceChildren();
  if (isNew) {
    const art = el('div', 'empty-art');
    const back = el('div', 'empty-card back'); back.append(icon('image'));
    const front = el('div', 'empty-card front'); front.append(icon('image'));
    art.append(back, front);
    const button = action('导入第一份素材', 'primary-button', () => importImages(false), 'plus');
    const foot = el('div', 'empty-footnote');
    ['图片视频一起收集', '标签快速整理', '本地安心保存'].forEach((text, index) => { const item = el('span'); item.append(icon(['upload', 'tag', 'shield'][index]), document.createTextNode(text)); foot.append(item); });
    box.append(art, el('h2', '', '每一份灵感，都值得被拾起'), el('p', '', '拖入图片、视频或文件夹，建立你的私人素材库。\n从此，告别散落的文件与找不到的参考。'), button, foot);
  } else {
    const glyph = el('div', 'empty-small-icon');
    glyph.append(icon(state.view === 'trash' ? 'trash' : state.view === 'favorites' ? 'star' : state.folder ? 'folder' : 'search'));
    const filtered = state.search || state.tag || state.format !== 'all';
    box.append(glyph, el('h2', '', filtered ? '没有找到匹配的素材' : state.view === 'trash' ? '回收站是空的' : state.view === 'favorites' ? '收藏你偏爱的灵感' : state.folder ? '这个文件夹，等待灵感入住' : '这里暂时还没有素材'), el('p', '', filtered ? '试试其他关键词，或清除筛选条件。' : state.view === 'favorites' ? '为素材评 4 星或 5 星，即可在这里找到它。' : state.view === 'trash' ? '移入回收站的素材会保留，可随时恢复。' : '导入图片或视频，开始整理你的视觉收藏。'));
    if (filtered) box.append(action('清除筛选', 'secondary-button', () => { state.search = ''; state.tag = null; state.format = 'all'; $('searchInput').value = ''; $('formatFilter').value = 'all'; render(); }));
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
  $('selectionHint').textContent = state.selectionMode ? '点击选择 · 拖动框选 · Ctrl 追加 · Esc 退出' : 'Ctrl＋滚轮缩放 · 空格预览 · Ctrl 多选';
  $('galleryScroller').dataset.selectionMode = String(state.selectionMode);
  $('gallery').querySelectorAll('.asset-card').forEach(card => { card.draggable = !state.selectionMode && card.dataset.trashed !== 'true'; });
}
function setSelectionMode(enabled) {
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
  $('trashSelection').classList.toggle('hidden', state.view === 'trash');
  $('restoreSelection').classList.toggle('hidden', state.view !== 'trash');
  $('deleteSelection').classList.toggle('hidden', state.view !== 'trash');
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
    preview.title = isProject(asset) ? '查看已打包的 AE 工程' : isModel(asset) ? '点击旋转预览 3D 模型' : isVideo(asset) ? '点击播放视频' : '点击预览原图';
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
  state.library.folders.forEach((item) => { const option = el('option', '', item.name); option.value = item.id; folder.append(option); });
  folder.value = mixed ? '__mixed__' : asset.folderId || '';
  folder.addEventListener('change', () => updateSelected({ folderId: folder.value || null }));
  box.append(field('所在文件夹', folder));
  const tagsContainer = el('div');
  const tags = el('div', 'detail-tags');
  const commonTags = (asset.tags || []).filter((tag) => assets.every((a) => (a.tags || []).includes(tag)));
  commonTags.forEach((tag) => {
    const chip = el('span', 'detail-tag');
    const remove = action('', '', () => {
      saveMetadata(async () => {
        let next;
        for (const a of assets) {
          const current = state.library.assets.find((item) => item.id === a.id) || a;
          next = await api.updateAssets([a.id], { tags: current.tags.filter((item) => item !== tag) });
        }
        return next;
      });
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
      let next;
      for (const a of assets) {
        const current = state.library.assets.find((item) => item.id === a.id) || a;
        next = await api.updateAssets([a.id], { tags: [...new Set([...(current.tags || []), ...added])] });
      }
      return next;
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
  const metadata = one ? [['类型', isProject(asset) ? 'AE 工程' : isModel(asset) ? '3D 模型' : isVideo(asset) ? '视频' : '图片'], ['格式', asset.ext.toUpperCase()], ['MIME', isProject(asset) ? '工程资源包' : isModel(asset) ? '模型资源包' : mimeType(asset)], [isModel(asset) || isProject(asset) ? '包内文件' : '尺寸', isProject(asset) ? `${asset.projectBundle?.files?.length || 1} 个` : isModel(asset) ? `${asset.modelBundle?.files?.length || 1} 个` : dimensions(asset)], ['文件大小', size(asset.size)], ['导入时间', date(asset.createdAt)]] : [['已选素材', `${assets.length} 个`], ['总大小', size(assets.reduce((n, a) => n + a.size, 0))]];
  if (one && isProject(asset)) {
    if (asset.projectPreview?.composition) metadata.push(['封面合成', asset.projectPreview.composition.name], ['合成尺寸', `${asset.projectPreview.width} × ${asset.projectPreview.height}`]);
    if (asset.projectBundle?.compositions?.length) metadata.push(['合成数量', `${asset.projectBundle.compositions.length} 个`]);
    if (asset.projectBundle?.collectedWithVersion) metadata.push(['收集引擎', `After Effects ${asset.projectBundle.collectedWithVersion}`]);
    if (asset.projectBundle?.missing?.length) metadata.push(['缺失素材', `${asset.projectBundle.missing.length} 个`]);
    metadata.push(['导出方式', '已链接工程与依赖素材的完整文件夹']);
  }
  if (one && isModel(asset)) {
    const missing = asset.modelBundle?.missing || [];
    if (missing.length) metadata.push(['缺失资源', `${missing.length} 个（预览可能不完整）`]);
    metadata.push(['打包方式', '模型、材质与贴图一起保存']);
  }
  if (one && isVideo(asset)) {
    if (videoDuration(asset.duration)) metadata.splice(4, 0, ['时长', videoDuration(asset.duration)]);
    if (typeof asset.codec === 'string' && asset.codec) metadata.splice(4, 0, ['视频编码', asset.codec.toUpperCase()]);
  }
  metadata.forEach(([key, value]) => { const row = el('div', 'metadata-row'); row.append(el('span', '', key), el('span', '', value)); box.append(row); });
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
}
function renderLibraryState() {
  const ready = hasLibrary();
  $('libraryOnboarding').classList.toggle('hidden', ready);
  $('setupAppUpdate').classList.toggle('hidden', ready);
  document.querySelector('.app-shell').inert = !ready || state.libraryChanging;
  $('newFolder').disabled = !ready || state.libraryChanging;
  $('backupButton').disabled = !ready || state.libraryChanging;
  $('collectorButton').disabled = !ready || state.libraryChanging;
  $('pluginCenterButton').disabled = !ready || state.libraryChanging;
  $('searchInput').disabled = !ready || state.libraryChanging;
  $('formatFilter').disabled = !ready || state.libraryChanging;
  $('sortSelect').disabled = !ready || state.libraryChanging;
  $('selectionModeButton').disabled = !ready || state.libraryChanging;
  $('libraryDisplayName').textContent = ready ? state.library.root.replace(/[\\/]$/, '').split(/[\\/]/).pop() : '选择素材库';
  $('libraryDisplayStatus').textContent = ready ? '本地存储 · 随时灵感' : '由你决定保存位置';
  $('libraryInfo').title = ready ? `管理素材库：${state.library.root}` : '选择素材库位置';
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
  if (state.libraryChanging || state.busy) return;
  state.libraryChanging = true;
  renderLibraryState();
  const text = kind === 'migrate' ? '请选择新位置。复制完成前请保持拾图打开…' : '正在准备素材库…';
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
function modal({ title, description = '', value = '', input = true, confirm = '确定', cancel = '取消', destructive = false }) {
  if (modalResolve) modalResolve(null);
  $('modalTitle').textContent = title;
  $('modalDescription').textContent = description;
  $('modalInput').value = value;
  $('modalInput').classList.toggle('hidden', !input);
  $('modalConfirm').textContent = confirm;
  $('modalCancel').textContent = cancel;
  $('modalOverlay').querySelector('.modal-icon use').setAttribute('href', destructive ? '#i-trash' : '#i-folder');
  $('modalOverlay').classList.remove('hidden');
  setTimeout(() => { if (input) { $('modalInput').focus(); $('modalInput').select(); } else $(destructive ? 'modalCancel' : 'modalConfirm').focus(); }, 30);
  return new Promise((resolve) => { modalResolve = resolve; });
}
function resolveModal(value) {
  $('modalOverlay').classList.add('hidden');
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(value);
}
async function createFolder() {
  if (!hasLibrary() || state.libraryChanging) return;
  const name = await modal({ title: '新建文件夹', description: '按项目、主题或使用场景，把灵感收在一起。' });
  if (!name?.trim()) return;
  const snapshot = await run(() => api.createFolder(name.trim()));
  if (snapshot) { applyLibrary(snapshot, false); const created = snapshot.folders[snapshot.folders.length - 1]; if (created) changeView('all', created.id); toast('文件夹已创建'); }
}
async function manageFolder(folder) {
  const result = await modal({ title: '管理文件夹', description: '修改名称并保存。移除文件夹后，其中的素材会回到「未分类」。', value: folder.name, confirm: '保存名称', cancel: '移除文件夹' });
  if (result === null) return;
  if (result === false) {
    const sure = await modal({ title: `移除「${folder.name}」？`, description: '只移除这个分类，素材仍会完整保留在素材库中。', input: false, confirm: '移除文件夹' });
    if (!sure) return;
    const snapshot = await run(() => api.deleteFolder(folder.id));
    if (snapshot) { applyLibrary(snapshot); toast('文件夹已移除，素材已回到未分类'); }
  } else if (result.trim()) {
    const snapshot = await run(() => api.renameFolder(folder.id, result.trim()));
    if (snapshot) { applyLibrary(snapshot); toast('文件夹名称已保存'); }
  }
}
async function importImages(folder, paths) {
  if (!hasLibrary()) { toast('请先选择素材库位置'); return; }
  if (state.libraryChanging) return;
  if (state.busy) { toast('正在导入，请稍候'); return; }
  state.busy = true;
  renderHeader(filteredAssets());
  $('progressPanel').classList.remove('hidden');
  $('progressTitle').textContent = '正在导入素材';
  $('progressCount').textContent = '';
  $('progressFile').textContent = '正在准备…';
  $('progressFill').style.width = '0%';
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
  finally { state.busy = false; $('progressPanel').classList.add('hidden'); renderHeader(filteredAssets()); }
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
  actions.append(action('使用 AE 打开', 'primary-button', () => run(() => api.openAsset(asset.id)), 'external'),
    action('导出完整文件夹', 'secondary-button', () => run(async () => {
      const result = await api.exportAssets([asset.id]);
      if (result && !result.cancelled) toast('已导出 AE 工程与素材文件夹');
    }), 'download'), retry);
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
function displayPreviewAsset(asset, index, total) {
  resetPreviewMedia();
  state.previewId = asset.id;
  $('preview').dataset.activeId = asset.id;
  $('previewName').textContent = asset.name;
  $('previewMeta').textContent = `${asset.ext.toUpperCase()}  ·  ${dimensions(asset)}  ·  ${size(asset.size)}`;
  $('previewIndex').textContent = `${index + 1} / ${total}`;
  $('previewFallback').classList.add('hidden');
  if (isProject(asset)) {
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
    const serial = videoPreviewSerial;
    const expectedRoot = state.library.root;
    const video = $('previewVideo');
    video.setAttribute('aria-label', asset.name);
    video.controls = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.muted = true;
    video.loop = true;
    video.poster = asset.thumbnail ? api.assetUrl(asset.id, 'thumbnail') : '';
    $('previewFallback').textContent = '正在准备视频预览，首次打开可能需要一点时间…';
    $('previewFallback').classList.remove('hidden');
    const stillCurrent = () => serial === videoPreviewSerial && state.previewId === asset.id && state.library.root === expectedRoot;
    Promise.resolve().then(() => stillCurrent() ? api.prepareVideo(asset.id, expectedRoot) : null).then(prepared => {
      if (!stillCurrent()) return;
      const url = new URL(prepared?.url);
      if (url.protocol !== 'shitu:' || url.hostname !== 'asset' || decodeURIComponent(url.pathname.slice(1)) !== asset.id || url.searchParams.get('kind') !== 'preview')
        throw new Error('视频预览地址无效，请重新打开素材');
      video.dataset.previewSerial = String(serial);
      video.src = url.href;
      video.classList.remove('hidden');
      const duration = videoDuration(prepared.duration);
      const codec = typeof prepared.codec === 'string' && prepared.codec ? `视频编码 ${prepared.codec.toUpperCase()}` : '';
      const dimensionsText = prepared.width && prepared.height ? `${prepared.width} × ${prepared.height}` : dimensions(asset);
      $('previewMeta').textContent = [asset.ext.toUpperCase(), codec, dimensionsText, duration, size(asset.size)].filter(Boolean).join('  ·  ');
    }).catch(error => {
      if (!stillCurrent()) return;
      video.classList.add('hidden');
      $('previewFallback').textContent = `暂时无法预览此视频：${error?.message || '请稍后重试'}。可使用右上角按钮在系统播放器中打开，原文件仍完整保留。`;
      $('previewFallback').classList.remove('hidden');
    });
  } else {
    $('previewImage').src = api.assetUrl(asset.id, 'original');
    $('previewImage').alt = asset.name;
  }
}
function openPreview(id) {
  const list = filteredAssets();
  if (!list.some(asset => asset.id === id)) return;
  $('preview').classList.remove('hidden');
  document.body.classList.add('is-preview-open');
  cylinderPreview.open(list, id);
  $('previewClose').focus();
}
function resetPreviewMedia() {
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
  $('previewVideo').load();
  $('previewVideo').classList.add('hidden');
  $('previewImage').removeAttribute('src');
  $('previewImage').classList.add('hidden');
}
function closePreview() { state.previewId = null; $('preview').classList.add('hidden'); document.body.classList.remove('is-preview-open'); resetPreviewMedia(); cylinderPreview.close(); delete $('preview').dataset.activeId; }
function movePreview(direction) { cylinderPreview.turn(direction); }
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
  if (result.libraryRoot && state.library.root !== result.libraryRoot) throw new Error('采集保存到了其他素材库，请切换到采集时的素材库查看');
  const snapshot = await api.getLibrary();
  if (snapshot.root !== state.library.root) return;
  if (result.libraryRoot && snapshot.root !== result.libraryRoot) throw new Error('素材库已切换，请回到采集时的素材库查看');
  const ids = [...(result.assetIds || []), ...(result.existingAssets || []).map(asset => asset.id)];
  const asset = snapshot.assets.find(item => ids.includes(item.id));
  closePreview();
  state.view = asset?.trashedAt ? 'trash' : 'all';
  state.folder = null; state.tag = null; state.search = ''; state.format = 'all'; state.sort = 'newest';
  $('searchInput').value = ''; $('formatFilter').value = 'all'; $('sortSelect').value = 'newest';
  applyLibrary(snapshot, false);
  if (asset) {
    state.selected = new Set([asset.id]);
    state.limit = Math.max(240, filteredAssets().findIndex(item => item.id === asset.id) + 1);
    render();
    requestAnimationFrame(() => document.querySelector(`.asset-card[data-asset-id="${CSS.escape(asset.id)}"]`)?.scrollIntoView({ block: 'center' }));
  }
  if (!$('collectorOverlay').classList.contains('hidden')) closeCollector();
}
function renderCaptureResult(result) {
  const box = $('collectorLastCapture');
  box.replaceChildren(); box.classList.toggle('hidden', !result);
  if (!result) return;
  const messages = { receiving: '正在接收浏览器中的素材…', downloading: '正在下载网页素材，尚未入库…', importing: '下载完成，正在写入素材库…' };
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
    $('collectorStatus').textContent = info.ready === false ? '请先选择素材库位置，再使用浏览器采集。' : available ? '本地接收服务已就绪 · 采集时请保持拾图运行' : `本地接收服务暂不可用${info.error ? `：${info.error}` : '，请重启拾图后再试'}`;
    $('collectorPath').textContent = info.extensionPath ? `扩展目录：${info.extensionPath}` : '';
    $('openExtensionFolder').disabled = !info.extensionPath;
    renderCaptureResult(info.lastCapture);
  } catch (error) {
    $('collectorStatus').classList.add('unavailable');
    $('collectorStatus').textContent = `无法读取本地接收服务状态：${error.message || error}`;
  } finally { refreshingCollector = false; $('refreshCollector').disabled = false; }
}
function showCollector() {
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

$('newFolder').addEventListener('click', createFolder);
// Collection menus use native disclosure controls and keep the workspace clear.
const collectionMenus = [...document.querySelectorAll('.collection-menu')];
for (const menu of collectionMenus) menu.addEventListener('toggle', () => {
  if (menu.open) collectionMenus.filter(other => other !== menu).forEach(other => { other.open = false; });
});
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
$('galleryScroller').addEventListener('scroll', () => { if (marquee?.active) updateMarquee(); });
$('galleryScroller').addEventListener('lostpointercapture', event => { if (marquee?.pointerId === event.pointerId) stopMarquee(true, true); });
window.addEventListener('pointermove', moveMarquee, { passive: false });
window.addEventListener('pointerup', event => { if (marquee?.pointerId === event.pointerId) stopMarquee(false, true); });
window.addEventListener('pointercancel', event => { if (marquee?.pointerId === event.pointerId) stopMarquee(true, true); });
window.addEventListener('blur', () => stopMarquee(true, true));
window.addEventListener('resize', () => stopMarquee(true, true));
$('searchInput').addEventListener('input', (e) => { state.search = e.target.value; state.limit = 240; state.selected.clear(); render(); });
$('formatFilter').addEventListener('change', (e) => { state.format = e.target.value; state.limit = 240; state.selected.clear(); render(); });
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
$('exportSelection').addEventListener('click', () => run(async () => { const result = await api.exportAssets([...state.selected]); if (result && !result.cancelled) toast(`已导出 ${result.count ?? result.exported ?? state.selected.size} 个素材`); }));
$('backupButton').addEventListener('click', () => run(async () => {
  if (!hasLibrary() || state.libraryChanging) return;
  const button = $('backupButton'); button.disabled = true;
  try { const result = await api.backup(); if (result && !result.cancelled) toast(`素材库备份完成\n${result.path}`, false, 8000); }
  finally { button.disabled = !hasLibrary() || state.libraryChanging; }
}));
$('collectorButton').addEventListener('click', showCollector);
$('pluginCenterButton').addEventListener('click', () => run(() => openPluginCenter()));
$('appUpdateButton').addEventListener('click', showAppUpdate);
$('setupAppUpdate').addEventListener('click', showAppUpdate);
$('appUpdateClose').addEventListener('click', closeAppUpdate);
$('appUpdateOverlay').addEventListener('click', event => { if (event.target === $('appUpdateOverlay')) closeAppUpdate(); });
$('appUpdateCheck').addEventListener('click', () => runUpdateAction(() => api.checkUpdate()));
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
$('modalForm').addEventListener('submit', (e) => { e.preventDefault(); if ($('modalInput').classList.contains('hidden')) resolveModal(true); else if ($('modalInput').value.trim()) resolveModal($('modalInput').value.trim()); });
$('modalCancel').addEventListener('click', () => resolveModal($('modalCancel').textContent === '移除文件夹' ? false : null));
$('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) resolveModal(null); });
$('previewClose').addEventListener('click', closePreview);
$('previewBack').addEventListener('click', () => cylinderPreview.exitSingle());
$('previewPrev').addEventListener('click', () => movePreview(-1));
$('previewNext').addEventListener('click', () => movePreview(1));
$('previewOpen').addEventListener('click', () => run(() => api.openAsset(state.previewId)));
$('preview').addEventListener('contextmenu', event => {
  if (!state.previewId) return;
  const target = event.target instanceof Element ? event.target : event.target.parentElement;
  const card = target?.closest('.cylinder-card[data-asset-id]');
  const focusedImage = target?.closest('#previewFocusContent,#previewImage,#previewVideo,#previewFallback,#previewProject');
  if (card || focusedImage) assetContextMenuEvent(event, card?.dataset.assetId || state.previewId);
}, true);
$('detailsContent').addEventListener('contextmenu', event => {
  const target = event.target instanceof Element ? event.target : event.target.parentElement;
  const preview = target?.closest('.detail-preview[data-asset-id]');
  if (preview) assetContextMenuEvent(event, preview.dataset.assetId);
}, true);
$('previewImage').addEventListener('error', () => {
  const asset = state.library.assets.find((item) => item.id === state.previewId);
  if (asset && !isVideo(asset) && !isModel(asset) && !isProject(asset)) {
    $('previewImage').classList.add('hidden');
    $('previewFallback').textContent = '此图片格式无法在窗口中预览，可使用右上角按钮在系统应用中打开。';
    $('previewFallback').classList.remove('hidden');
  }
});
$('previewVideo').addEventListener('error', () => {
  const asset = state.library.assets.find((item) => item.id === state.previewId);
  if (asset && isVideo(asset) && $('previewVideo').hasAttribute('src') && $('previewVideo').dataset.previewSerial === String(videoPreviewSerial)) {
    $('previewVideo').classList.add('hidden');
    $('previewFallback').textContent = '此视频的编码暂无法在窗口中播放，可使用右上角按钮在系统播放器中打开。文件仍完整保留在素材库中。';
    $('previewFallback').classList.remove('hidden');
  }
});
$('previewImage').addEventListener('load', () => {
  const asset = state.library.assets.find((item) => item.id === state.previewId);
  if (asset && !isVideo(asset) && !isModel(asset) && !isProject(asset)) { $('previewImage').classList.remove('hidden'); $('previewFallback').classList.add('hidden'); }
});
$('previewVideo').addEventListener('loadeddata', () => {
  const asset = state.library.assets.find((item) => item.id === state.previewId);
  if (asset && isVideo(asset) && $('previewVideo').dataset.previewSerial === String(videoPreviewSerial)) { $('previewVideo').classList.remove('hidden'); $('previewFallback').classList.add('hidden'); }
});
window.addEventListener('pagehide', resetPreviewMedia);
$('galleryScroller').addEventListener('click', (e) => { if (performance.now() >= suppressAssetClickUntil && (e.target === $('galleryScroller') || e.target === $('gallery'))) { flushDetailDrafts(); state.selected.clear(); updateSelectionClasses(); renderSelection(); renderDetails(); } });

document.addEventListener('keydown', (e) => {
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
  if (window.shituPlugins?.isOpen()) return;
  const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (!$('libraryManagerOverlay').classList.contains('hidden')) { if (e.key === 'Escape') { e.preventDefault(); closeLibraryManager(); } return; }
  if (!$('collectorOverlay').classList.contains('hidden')) { if (e.key === 'Escape') { e.preventDefault(); closeCollector(); } return; }
  if (modalResolve) { if (e.key === 'Escape') { e.preventDefault(); resolveModal(null); } return; }
  if (!hasLibrary() || state.libraryChanging) return;
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
    if (e.key === 'Escape') { e.preventDefault(); if (cylinderPreview.singleMode && !$('preview').classList.contains('is-model-preview') && !$('preview').classList.contains('is-project-preview')) cylinderPreview.exitSingle(); else closePreview(); return; }
    if (e.key === ' ') {
      e.preventDefault();
      const asset = state.library.assets.find((item) => item.id === state.previewId);
      if (asset && isVideo(asset) && !$('previewVideo').classList.contains('hidden')) {
        if ($('previewVideo').paused) $('previewVideo').play().catch(messageError);
        else $('previewVideo').pause();
      } else if (!asset || (!isModel(asset) && !isProject(asset))) closePreview();
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); movePreview(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); movePreview(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); cylinderPreview.moveRow(-1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); cylinderPreview.moveRow(1); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && ['k', 'f'].includes(e.key.toLowerCase())) { e.preventDefault(); $('searchInput').focus(); $('searchInput').select(); return; }
  if (editing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault(); state.selected = new Set(filteredAssets().map((a) => a.id)); updateSelectionClasses(); renderSelection(); renderDetails();
  } else if (e.key === ' ' && state.selected.size) {
    e.preventDefault(); openPreview([...state.selected][0]);
  } else if (e.key === 'Escape') {
    state.selected.clear(); updateSelectionClasses(); renderSelection(); renderDetails();
  }
});
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); if (!draggingAssets && hasLibrary() && !state.libraryChanging && [...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth += 1; $('dropOverlay').classList.remove('hidden'); } });
document.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = draggingAssets ? 'none' : 'copy'; });
document.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) $('dropOverlay').classList.add('hidden'); });
document.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('dropOverlay').classList.add('hidden');
  if (draggingAssets) return;
  const paths = [...(e.dataTransfer?.files || [])].map((file) => api.getFilePath(file)).filter(Boolean);
  if (paths.length) importImages(false, paths);
});
api.onAssetDragEnd?.(finishAssetDrag);
api.onActionError?.(message => { finishAssetDrag(); messageError(new Error(message)); });
window.addEventListener('focus', finishAssetDrag);
api.onImportProgress?.((event) => {
  if (!event) return;
  const done = event.current ?? event.processed ?? event.completed ?? 0;
  const total = event.total || 0;
  $('progressCount').textContent = total ? `${done} / ${total}` : '';
  $('progressFill').style.width = total ? `${Math.min(100, done / total * 100)}%` : '8%';
  $('progressFile').textContent = event.name || event.file || event.path || '正在读取素材…';
});
api.onWebCapture?.(result => {
  if (!result?.ok) return;
  const message = result.imported ? `浏览器已采集 ${result.imported} 个素材` : result.existingAssets?.some(asset => asset.trashedAt) ? '这份素材已在回收站中' : '素材库中已有这份文件';
  const notice = toast(message, false, 20000, { text: '查看', run: () => showCapturedAssets(result) });
  notice.dataset.webCapture = 'true';
  renderCaptureResult({ ...result, status: 'complete' });
});
api.onLibraryChanged?.(() => run(async () => {
  const serial = ++libraryRefreshSerial;
  const snapshot = await api.getLibrary();
  if (serial === libraryRefreshSerial) applyLibrary(snapshot);
}));
api.onProjectPreview?.(detail => {
  if (detail?.id === projectPreviewView?.id && detail.root === projectPreviewView.root) projectPreviewView.updateProgress(detail);
});
window.addEventListener('beforeunload', (event) => {
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
run(async () => { const library = await api.getLibrary(); applyLibrary(library); }).then((result) => {
  if (result === null) {
    state.library.libraryError = '暂时无法读取素材库设置，请重新打开拾图后再试。';
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
