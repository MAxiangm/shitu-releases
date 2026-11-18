'use strict';
const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage(message);
const RELOAD_KEY = 'shituWorkerReload';
function status(text, state) { $('status').textContent = text; $('statusDot').className = `dot ${state || ''}`; }
let checking = false;
let workerVerified = false;
let reloading = false;
let upgraded = false;
let folderState = null;
let folderListKey = '';
let folderChange = 0;
let savingFolder = false;
let recentRequestId = null;
let locating = false;

async function ensureWorkerVersion() {
  if (workerVerified) return true;
  // Unpacked extensions can keep an old worker alive after their files change.
  // Read the on-disk version, then compare it with the worker serving messages.
  const manifest = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then(response => response.json());
  const info = await send({ type: 'shitu:extension-info' });
  const stored = await chrome.storage.local.get(RELOAD_KEY);
  if (info?.ok && info.protocol === 1 && info.version === manifest.version && info.build === manifest.version) {
    workerVerified = true;
    upgraded = Boolean(stored[RELOAD_KEY]);
    if (upgraded) await chrome.storage.local.remove(RELOAD_KEY);
    return true;
  }
  const previous = stored[RELOAD_KEY];
  if (previous?.version === manifest.version && Date.now() - previous.at < 60000) {
    status('扩展更新尚未完成', 'offline');
    $('feedback').textContent = '请在 Chrome 扩展管理中重新加载 Mosaic 采集助手，再刷新素材网页。';
    return false;
  }
  status('正在更新采集助手…');
  $('feedback').textContent = '检测到旧版后台，正在自动重新加载。随后刷新素材网页即可采集。';
  await chrome.storage.local.set({ [RELOAD_KEY]: { version: manifest.version, at: Date.now() } });
  reloading = true;
  chrome.runtime.reload();
  return false;
}

function note(id, text) {
  const item = $(id);
  item.hidden = !text;
  item.textContent = text;
}

function folderOptions(folders) {
  const names = new Map(folders.map(folder => [folder.id, folder]));
  return folders.map(folder => {
    const parts = [folder.name];
    const seen = new Set([folder.id]);
    let parent = names.get(folder.parentId);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      parts.unshift(parent.name);
      parent = names.get(parent.parentId);
    }
    return [folder.id, parts.join(' / ')];
  }).sort((left, right) => left[1].localeCompare(right[1], 'zh-CN', { numeric: true }));
}

function renderFolders(state, unavailable = '打开 Mosaic 中的素材库后可选择文件夹。') {
  const control = $('captureFolder');
  folderState = state?.supported && state.libraryId && Array.isArray(state.folders) ? state : null;
  if (!folderState) {
    control.disabled = true;
    note('folderNote', unavailable);
    return;
  }
  const missing = folderState.folderId !== null && !folderState.folders.some(folder => folder.id === folderState.folderId);
  const folders = folderOptions(folderState.folders);
  const key = JSON.stringify([folderState.libraryId, missing, folders]);
  if (key !== folderListKey) {
    const options = [['', '未分类'], ...folders];
    if (missing) options.unshift(['@missing', '请选择新的保存位置']);
    control.replaceChildren(...options.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.disabled = value === '@missing';
      return option;
    }));
    folderListKey = key;
  }
  const value = missing ? '@missing' : folderState.folderId || '';
  if (control.value !== value) control.value = value;
  control.disabled = false;
  note('folderNote', missing ? '上次选择的文件夹已不存在。' : '');
}

async function refreshFolders(result, sequence) {
  if (savingFolder || sequence !== folderChange) return;
  if (!result?.ready || !result.libraryId) {
    renderFolders(null, result?.ready ? '更新桌面版后可选择保存文件夹。' : undefined);
    return;
  }
  let state;
  try { state = await send({ type: 'shitu:folders' }); }
  catch { state = { ok: false, error: '暂时无法读取文件夹。' }; }
  if (savingFolder || sequence !== folderChange) return;
  renderFolders(state?.ok ? state : null, state?.error || '暂时无法读取文件夹。');
}

async function showRecent() {
  const { shituLastCapture: recent } = await chrome.storage.local.get('shituLastCapture');
  $('recent').hidden = !recent;
  if (recentRequestId !== (recent?.requestId || null)) {
    recentRequestId = recent?.requestId || null;
    note('locateNote', '');
  }
  const canLocate = !!(recent?.ok && recentRequestId && recent.location?.libraryId && recent.location.assetId);
  $('locateRecent').hidden = !canLocate;
  $('locateRecent').disabled = locating;
  const progressBar = $('recentProgress');
  progressBar.hidden = true;
  if (!recent) return;
  let message;
  const pending = recent.pending || recent.status === 'working';
  const stale = pending && Date.now() - Number(recent.at || 0) > 300000;
  const bytes = recent.progress;
  if (pending && !stale && bytes?.phase === 'downloading' && Number.isSafeInteger(bytes.receivedBytes) && bytes.receivedBytes >= 0 &&
      Number.isSafeInteger(bytes.totalBytes) && bytes.totalBytes > 0 && bytes.receivedBytes <= bytes.totalBytes) {
    progressBar.max = bytes.totalBytes;
    progressBar.value = bytes.receivedBytes;
    progressBar.hidden = false;
  }
  if (pending) message = stale ? '上次采集未收到最终确认，请在桌面“最近导入”或“浏览器采集”状态中核对。'
    : recent.message || '正在采集，尚未收到素材库保存确认。';
  else if (recent.ok && recent.imported > 0) message = recent.message || '已保存到素材库，可在“全部素材”或“最近导入”查看。';
  else if (recent.ok && recent.duplicates > 0) message = recent.message || (recent.existingAssets?.some(asset => asset.trashedAt)
    ? '这份素材已在回收站，请到桌面 Mosaic 恢复后查看。' : '素材库中已有这份文件，可清除搜索和格式筛选后查看。');
  else message = recent.error ? `未收到保存确认 · ${recent.error}` : '上次采集未收到保存确认，请到桌面 Mosaic 核对。';
  $('recentLabel').textContent = pending && !stale ? '正在采集 · 尚未保存' : '上次采集结果';
  const confirmed = recent.ok && ((Number.isSafeInteger(recent.imported) && recent.imported > 0) || (Number.isSafeInteger(recent.duplicates) && recent.duplicates > 0));
  $('recent').setAttribute('data-state', pending ? stale ? 'unconfirmed' : 'working' : confirmed ? 'success' : recent.error ? 'error' : 'unconfirmed');
  const lines = [recent.name, message];
  if (pending && recent.lastNotice?.error) lines.push(`操作提示：${recent.lastNotice.error}`);
  if (recent.libraryRoot) lines.push(`目标素材库：${recent.libraryRoot}`);
  $('recentText').textContent = lines.filter(Boolean).join('\n');
}

async function checkConnection(force = false) {
  if (checking || reloading) return;
  checking = true;
  const sequence = folderChange;
  $('check').disabled = true;
  status('正在查找 Mosaic…');
  try {
    if (!await ensureWorkerVersion()) return false;
    const result = await send({ type: force ? 'shitu:reconnect' : 'shitu:ping' });
    if (result?.ok) {
      status(result.ready ? `已连接 · ${result.version}` : '已连接 · 请先选择素材库', result.ready ? 'online' : '');
      $('feedback').textContent = result.ready
        ? upgraded ? '采集助手已更新。请刷新已打开的素材网页，再按住 Alt 并右键采集。' : '已准备好。回到网页，按住 Alt 并右键点击素材即可保存。'
        : '请先在桌面 Mosaic 中选择或新建素材库，之后自动开始接收素材。';
      await Promise.all([showRecent(), refreshFolders(result, sequence)]);
      return true;
    }
    status('等待桌面 Mosaic', 'offline');
    $('feedback').textContent = result?.error || '请先打开桌面 Mosaic。';
    await Promise.all([showRecent(), refreshFolders(result, sequence)]);
    return false;
  } catch {
    status('连接检查失败', 'offline');
    $('feedback').textContent = '扩展可能正在更新，请关闭此窗口后重新打开。';
    if (!savingFolder && sequence === folderChange) renderFolders(null);
    return false;
  }
  finally { checking = false; $('check').disabled = reloading; }
}
$('check').addEventListener('click', () => checkConnection(true));
$('captureFolder').addEventListener('change', async event => {
  if (!event.isTrusted || !folderState || savingFolder) return;
  const state = folderState;
  const folderId = $('captureFolder').value || null;
  folderChange++;
  savingFolder = true;
  $('captureFolder').disabled = true;
  let error = '';
  try {
    const reply = await send({ type: 'shitu:set-folder', libraryId: state.libraryId, folderId });
    if (reply?.ok) folderState = { ...state, folderId: reply.folderId };
    else error = reply?.error || '无法保存文件夹设置。';
  } catch { error = '无法保存文件夹设置。'; }
  finally {
    savingFolder = false;
    renderFolders(folderState);
    if (error) note('folderNote', error);
  }
});
$('locateRecent').addEventListener('click', async event => {
  if (!event.isTrusted || locating || !recentRequestId) return;
  const requestId = recentRequestId;
  locating = true;
  $('locateRecent').disabled = true;
  try {
    const result = await send({ type: 'shitu:locate-recent', requestId });
    if (recentRequestId === requestId) note('locateNote', result?.ok ? '已在 Mosaic 中定位。' : result?.error || '暂时无法定位素材。');
  } catch {
    if (recentRequestId === requestId) note('locateNote', '暂时无法定位素材。');
  } finally {
    locating = false;
    $('locateRecent').disabled = false;
  }
});
$('recentClear').addEventListener('click', async () => {
  await chrome.storage.local.remove('shituLastCapture');
  await showRecent();
});
checkConnection();
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && Object.hasOwn(changes, 'shituLastCapture')) void showRecent().catch(() => {});
});
const refresh = setInterval(() => checkConnection(), 3000);
window.addEventListener('unload', () => clearInterval(refresh));
