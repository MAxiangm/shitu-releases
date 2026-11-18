require('./process-stdio.cjs').installProcessStdioGuards();
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, nativeImage, nativeTheme, Menu, clipboard, ClipboardItem, net } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { LibraryManager } = require('./library-manager.cjs');
const { createCollector } = require('./collector.cjs');
const { mediaResponse } = require('./media-response.cjs');
const { resolveAssetFiles, createDragIcon } = require('./asset-actions.cjs');
const { assetMenuTemplate } = require('./asset-menu.cjs');
const sharp = require('sharp');
const { createImagePlugins } = require('./image-plugins.cjs');
const { createAppUpdater } = require('./app-updater.cjs');
const { createUpdateTransport } = require('./update-transport.cjs');
const { createUpdateScheduler, updateIntervalMs } = require('./update-scheduler.cjs');
const { createVideoEngine } = require('./video-engine.cjs');
const { createVideoTranscoder } = require('./video-transcode.cjs');
const { createVideoTranscodeService } = require('./video-transcode-service.cjs');
const { createTranscodeDeviceManager } = require('./transcode-devices.cjs');
const { createTranscodeSettings, executionPlan } = require('./transcode-settings.cjs');
const { createUiRecovery } = require('./ui-recovery.cjs');
const { createVideoPreviewRequests } = require('./video-preview-requests.cjs');
const { createModelService } = require('./model-service.cjs');
const { createFontService } = require('./font-service.cjs');
const { createAEProjectCollector } = require('./ae-projects.cjs');
const { createAEPreviewEngine } = require('./ae-preview.cjs');
const { createAEPreviewService } = require('./ae-preview-service.cjs');
const { VIDEO, MODEL, PROJECT, FONT, SUPPORTED } = require('./media-formats.cjs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const updateConfig = require('../update-config.json');

app.setName('拾图');
nativeTheme.themeSource = 'dark';
app.setAppUserModelId('local.shitu.desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'shitu', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let mainWindow;
let library;
let importing = false;
let closing = false;
let mayClose = false;
let collector;
let collectorError;
let libraryManager;
let switchingLibrary=false;
let draggingAssets=false;
let movingAssets=0;
let imagePlugins;
let videoEngine;
let videoTranscoder;
let videoTranscodeService;
let transcodeDevices;
let transcodeSettings;
let uiRecovery;
let uiDiagnosticWrite = Promise.resolve();
let modelService;
let fontService;
let aeProjects;
let aePreviewService;
const videoPreviews = new Map();
const videoRequests = createVideoPreviewRequests();
let appUpdater;
let updateDiagnosticWrite = Promise.resolve();
let updateScheduler;
let installingUpdate = false;
let activeOperations = 0;
let historyBusy = false;
const metadataSaves = new Set();
const indexPage = pathToFileURL(path.join(__dirname, 'index.html')).href;
const overrideRoot = process.env.SHITU_LIBRARY;
const legacyRoot = path.join(app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(), 'library');
const extensionPath = app.isPackaged ? path.join(path.dirname(process.execPath), 'Chrome扩展') : path.join(app.getAppPath(), 'extension');

function requireLibrary() {
  if(switchingLibrary)throw new Error('正在切换素材库，请稍候');
  if(!library)throw new Error('请先选择素材库位置');
  return library;
}
function historyState(current = library) {
  return { root: current?.root || null, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null,
    undoId: null, redoId: null, undoCount: 0, redoCount: 0, warning: null, ...current?.historyState(), busy: historyBusy };
}
function withHistory(snapshot, current = library) { return { ...snapshot, history: historyState(current) }; }
function sendHistory() { sendActionEvent('history', historyState()); }
function librarySnapshot() {
  if(library)return withHistory(library.snapshot());
  const status=libraryManager.status();
  return {root:null,assets:[],folders:[],tags:[],history:historyState(),stats:{total:0,active:0,trashed:0,untagged:0,unfiled:0,bytes:0},needsLibrary:true,libraryError:status.error,legacyRoot:status.legacyRoot};
}
async function saveUserMetadata(method, args, { recordHistory = false, expectedRoot } = {}) {
  const current = requireLibrary();
  if (closing || historyBusy) throw new Error('正在保存撤销或重做，请稍后再修改');
  if (expectedRoot !== undefined && (typeof expectedRoot !== 'string' || expectedRoot !== current.root)) throw new Error('素材库已切换，请重新选择素材');
  const save = Promise.resolve().then(() => current[method](...args, ...(recordHistory ? [{ recordHistory: true }] : [])));
  metadataSaves.add(save);
  try {
    const snapshot = await save;
    if (library !== current) throw new Error('素材库已切换，请重新选择素材');
    return withHistory(snapshot, current);
  } finally { metadataSaves.delete(save); sendHistory(); }
}
function ensureHistoryAvailable() {
  if (closing || switchingLibrary || importing || draggingAssets || installingUpdate || videoTranscodeService?.busy() || imagePlugins?.busy() || collector?.activeCount())
    throw new Error('请等待当前导入、转码、处理或拖放完成后再撤销或重做');
}
async function replayHistory(direction, expectedRoot, expectedId) {
  const current = requireLibrary();
  if (typeof expectedRoot !== 'string' || expectedRoot !== current.root) throw new Error('素材库已切换，请重新选择素材');
  if (expectedId !== undefined && (typeof expectedId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(expectedId))) throw new Error('操作历史标识无效');
  if (historyBusy) throw new Error('正在撤销或重做，请稍候');
  ensureHistoryAvailable();
  historyBusy = true; sendHistory();
  try {
    // User edits may still be saving when Ctrl+Z arrives. Keep their ordering,
    // then replay only the requested top entry against the latest index.
    await Promise.allSettled([...metadataSaves]);
    await current.flush();
    ensureHistoryAvailable();
    if (library !== current) throw new Error('素材库已切换，请重新选择素材');
    const snapshot = await current[direction]({ expectedId });
    historyBusy = false;
    sendActionEvent('library-changed');
    return withHistory(snapshot, current);
  } finally { historyBusy = false; sendHistory(); }
}

async function prepareVideo(id, expectedRoot, requestToken, profile = 'full', requestSerial) {
  if (!['full', 'hover', 'quick'].includes(profile) || (profile === 'hover' && typeof requestToken !== 'string')) throw new Error('视频预览请求无效');
  if (requestSerial !== undefined && (!Number.isSafeInteger(requestSerial) || requestSerial < 0)) throw new Error('视频预览请求序号无效');
  const current = requireLibrary();
  if (current.root !== expectedRoot) throw new Error('素材库已切换，请重新选择视频');
  let asset = current.snapshot().assets.find(item => item.id === id);
  if (!asset || asset.mediaType !== 'video') throw new Error('请选择有效的视频素材');
  const source = current.getAssetPath(id, 'original');
  const owner = { id, current, profile, requestSerial };
  return videoRequests.prepare({ library: current, id, source, hash: asset.hash, profile }, requestToken, async (signal, onProgress) => {
    if (profile === 'full' && (!asset.thumbnail || !asset.codec)) {
      const result = await current.refreshVideoMetadata([id], { signal });
      if (result.updated) {
        asset = result.snapshot.assets.find(item => item.id === id);
        if (library === current) sendActionEvent('library-changed');
      }
    }
    signal.throwIfAborted();
    const engineProfile = profile === 'full' ? 'full' : 'hover';
    const ready = profile === 'quick' ? await videoEngine.getReadyPreview(source, { key: asset.hash, signal }) : null;
    const result = ready || (engineProfile === 'hover'
      ? await videoEngine.hoverPreview(source, { key: asset.hash, signal, metadata: asset })
      : await videoEngine.preview(source, { key: asset.hash, signal, metadata: asset, onProgress }));
    signal.throwIfAborted();
    if (library !== current || current.getAssetPath(id, 'original') !== source) throw new Error('素材库已切换，请重新选择视频');
    const previewStat = await fs.stat(result.path);
    const key = crypto.createHash('sha256').update(`${current.root}\0${id}\0${asset.hash}\0${profile}\0${previewStat.size}:${previewStat.mtimeMs}:${previewStat.ctimeMs}`).digest('hex');
    videoPreviews.set(key, { id, root: current.root, source, path: result.path });
    return { url: `shitu://asset/${encodeURIComponent(id)}?kind=preview&key=${key}`, width: result.width,
      height: result.height, duration: result.duration, sourceDuration: result.sourceDuration || result.duration,
      profile, previewOnly: profile === 'quick' && !ready && !result.direct,
      codec: result.sourceCodec || asset.codec || result.codec, mimeType: result.mimeType };
  }, event => forwardVideoProgress(event, owner));
}
function forwardVideoProgress(event, owner) {
  if (!owner || owner.current !== library) return;
  sendActionEvent('video-preview', { id: owner.id, root: owner.current.root, profile: owner.profile, requestSerial: owner.requestSerial,
    state: event.state, progress: Number.isFinite(event.progress) ? Math.max(0, Math.min(100, event.progress)) : undefined });
}
async function switchLibrary(mode) {
  if(switchingLibrary || importing || draggingAssets || movingAssets || historyBusy || metadataSaves.size || videoTranscodeService?.busy() || imagePlugins?.busy() || collector?.activeCount())throw new Error('请等待当前导入、采集、转码、图片处理或保存完成后再切换素材库');
  if(mode==='migrate')requireLibrary();
  switchingLibrary=true;
  try {
  let selected;
  if(mode==='legacy') {
    selected=libraryManager.status().legacyRoot;
    if(!selected)throw new Error('没有找到旧素材库，请使用打开已有库');
  } else {
    const title={create:'选择素材库存放位置（将在里面新建独立素材库文件夹）',open:'选择已有素材库文件夹（包含 index.json）',migrate:'选择迁移保存位置（复制完整素材库，原库保留）'}[mode];
    const result=await dialog.showOpenDialog(mainWindow,{title,defaultPath:library?.root || app.getPath('documents'),properties:['openDirectory','createDirectory']});
    if(result.canceled)return {cancelled:true,snapshot:librarySnapshot()};
    selected=result.filePaths[0];
  }
    videoRequests.abortAll();
    videoPreviews.clear();
    modelService?.invalidate();
    fontService?.invalidate();
    aePreviewService?.invalidate();
    library=mode==='create'?await libraryManager.create(selected):mode==='migrate'?await libraryManager.migrate(selected):await libraryManager.open(selected);
    const snapshot=librarySnapshot();
    aePreviewService?.scheduleLibrary(library);
    mainWindow.webContents.send('shitu:library-changed');
    sendHistory();
    return {snapshot};
  } finally {switchingLibrary=false;}
}

async function createThumbnail(source, destination, options) {
  if (PROJECT.has(path.extname(source).slice(1).toLowerCase())) return {};
  if (MODEL.has(path.extname(source).slice(1).toLowerCase())) return modelService.thumbnail(source, destination, options);
  if (FONT.has(path.extname(source).slice(1).toLowerCase())) return fontService.thumbnail(source, destination, options);
  if (VIDEO.has(path.extname(source).slice(1).toLowerCase())) return videoEngine.thumbnail(source, destination, options);
  try {
    const metadata = await sharp(source, { limitInputPixels: 80_000_000 }).metadata();
    const oriented = metadata.autoOrient || metadata;
    await sharp(source, { limitInputPixels: 80_000_000 }).rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#111111' }).jpeg({ quality: 86 }).toFile(destination);
    return { width: oriented.width, height: oriented.height };
  } catch { /* Keep Chromium's decoder as a fallback for other supported files. */ }
  // Chromium's image decoder handles common raster formats without external tools.
  const image = nativeImage.createFromPath(source);
  if (image.isEmpty()) return { width: 0, height: 0 };
  const { width, height } = image.getSize();
  const scale = Math.min(1, 640 / Math.max(width, height));
  const thumb = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' });
  await fs.writeFile(destination, thumb.toJPEG(86));
  return { width, height };
}

function assertTrustedSender(event) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!contents || contents.isDestroyed() || event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== indexPage) throw new Error('不允许的请求来源');
}

function checkedHandler(channel, handler) {
  ipcMain.handle(`shitu:${channel}`, async (event, ...args) => {
    assertTrustedSender(event);
    if (installingUpdate && channel !== 'update-state') throw new Error('正在安装更新，请稍候');
    if (channel.startsWith('update-') || ['prepare-video', 'cancel-video', 'release-video-viewer', 'prepare-model', 'prepare-font', 'prepare-project-preview', 'project-preview-state'].includes(channel)) return handler(...args);
    activeOperations++;
    try { return await handler(...args); }
    finally { activeOperations--; }
  });
}

function ensureUpdateCanInstall() {
  if (!app.isPackaged || process.platform !== 'win32') throw new Error('开发模式不安装更新，请使用正式安装版');
  if (installingUpdate || closing || activeOperations || switchingLibrary || importing || draggingAssets || videoTranscodeService?.busy() || imagePlugins?.busy() || collector?.activeCount()) {
    throw new Error('请等待导入、采集、图片处理和保存完成后再安装更新');
  }
}

async function installDownloadedUpdate({ filePath }) {
  ensureUpdateCanInstall();
  installingUpdate = true;
  try {
    await library?.flush();
    await new Promise((resolve, reject) => {
      const child = spawn(filePath, ['/S', '/SHITUUPDATE'], {
        detached: true, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, SHITU_UPDATE_PID: String(process.pid), SHITU_UPDATE_INSTALL_DIR: path.dirname(process.execPath) }
      });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    await Promise.allSettled([imagePlugins?.shutdown(), collector?.close(), videoEngine?.shutdown(), modelService?.shutdown(), fontService?.shutdown(), aeProjects?.shutdown(), aePreviewService?.shutdown()]);
    setTimeout(() => { mayClose = true; app.quit(); }, 150);
  } catch (error) {
    installingUpdate = false;
    throw error;
  }
}

async function checkForApplicationUpdate() {
  const state = await appUpdater.check();
  if (updateConfig.autoDownload !== false && state.status === 'available') return appUpdater.download();
  return state;
}

function recordUpdateDiagnostic(detail = {}) {
  const entry = { time: new Date().toISOString() };
  for (const key of ['phase', 'event', 'code']) if (typeof detail[key] === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(detail[key])) entry[key] = detail[key];
  if (['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(detail.host)) entry.host = detail.host;
  if (Number.isInteger(detail.status)) entry.status = detail.status;
  // Diagnostics contain codes and service names, never headers, signed URLs or proxy addresses.
  updateDiagnosticWrite = updateDiagnosticWrite.catch(() => {}).then(async () => {
    const directory = path.join(app.getPath('userData'), 'updates');
    const filename = path.join(directory, 'network.log');
    await fs.mkdir(directory, { recursive: true });
    const info = await fs.stat(filename).catch(() => null);
    if (info?.size > 128 * 1024) await fs.writeFile(filename, '');
    await fs.appendFile(filename, JSON.stringify(entry) + '\n');
  }).catch(() => {});
}

function initializeAppUpdater() {
  appUpdater = createAppUpdater({
    currentVersion: app.getVersion(), repository: updateConfig.repository,
    cacheDir: path.join(app.getPath('userData'), 'updates'),
    enabled: app.isPackaged && process.platform === 'win32' && process.arch === 'x64',
    fetchImpl: createUpdateTransport({ net, onDiagnostic: recordUpdateDiagnostic }),
    onDiagnostic: recordUpdateDiagnostic,
    onEvent: state => sendActionEvent('update-state', state),
    install: installDownloadedUpdate
  });
  updateScheduler = createUpdateScheduler({
    enabled: app.isPackaged && process.platform === 'win32' && process.arch === 'x64' && Boolean(updateConfig.repository),
    check: checkForApplicationUpdate, getState: () => appUpdater.state(),
    isOnline: () => net.isOnline(), canCheck: () => !closing && !installingUpdate,
    intervalMs: updateIntervalMs(updateConfig)
  });
}

function sendActionEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(`shitu:${channel}`, payload);
  if (channel === 'library-changed') sendHistory();
}

function recordUiDiagnostic(detail = {}) {
  const entry = { time: new Date().toISOString(), version: app.getVersion() };
  for (const key of ['event', 'source', 'reason']) if (typeof detail[key] === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(detail[key])) entry[key] = detail[key];
  if (Number.isInteger(detail.exitCode)) entry.exitCode = detail.exitCode;
  uiDiagnosticWrite = uiDiagnosticWrite.catch(() => {}).then(async () => {
    const directory = path.join(app.getPath('userData'), 'diagnostics');
    const filename = path.join(directory, 'ui-health.log');
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.stat(filename).catch(() => null))?.size > 128 * 1024) await fs.writeFile(filename, '');
    await fs.appendFile(filename, JSON.stringify(entry) + '\n');
  }).catch(() => {});
}

function startAssetDrag(ids, expectedRoot) {
  if (draggingAssets) return;
  try {
    if (historyBusy || closing) throw new Error('正在保存撤销或重做，请稍后再拖放');
    if (typeof expectedRoot !== 'string') throw new Error('素材库信息已失效，请重新选择素材');
    const current = requireLibrary();
    const { assets, files } = resolveAssetFiles(current, ids, expectedRoot);
    const icon = createDragIcon(current, assets[0], nativeImage, path.join(__dirname, '..', 'assets', 'icon.png'));
    draggingAssets = true;
    // Electron 45.1.0's Windows path only offers COPY | LINK (no MOVE).
    // StartDragAndDrop calls synchronous OLE DoDragDrop; return means the drop
    // completed or was cancelled. Never rename/delete library originals here.
    mainWindow.webContents.startDrag({ file: files[0], files, icon });
  } catch (error) { sendActionEvent('action-error', error.message); }
  finally {
    draggingAssets = false;
    sendActionEvent('drag-ended');
  }
}

async function moveAssetsToFolder(ids, folderId, expectedRoot) {
  if (typeof expectedRoot !== 'string') throw new Error('素材库已切换，请重新选择素材');
  movingAssets++;
  try {
    return await saveUserMetadata('moveAssetsToFolder', [ids, folderId], { expectedRoot, recordHistory: true });
  } finally { movingAssets--; }
}

async function copyAssetImage(id, expectedRoot) {
  const { assets, files } = resolveAssetFiles(requireLibrary(), [id], expectedRoot);
  if (assets[0].mediaType !== 'image') throw new Error('请选择图片复制为位图，视频、模型、字体和工程可拖出或导出原文件');
  const bitmap = nativeImage.createFromPath(files[0]);
  if (bitmap.isEmpty()) throw new Error('此图片格式暂不支持复制位图，请拖出或导出原文件');
  const png = bitmap.toPNG();
  if (!png.length) throw new Error('无法生成剪贴板图片，请拖出或导出原文件');
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
  return { copied: 1 };
}

async function copyAssetPaths(ids, expectedRoot) {
  const { files } = resolveAssetFiles(requireLibrary(), ids, expectedRoot);
  await clipboard.writeText(files.join('\r\n'));
  return { copied: files.length };
}

async function importPaths(paths, folderId = null) {
  requireLibrary();
  if (historyBusy || closing) throw new Error('正在保存撤销或重做，请稍后再导入');
  if (importing) throw new Error('正在导入素材，请等待当前任务完成');
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('无效的导入路径');
  importing = true;
  try {
    const report = await library.importPaths(paths, { folderId: folderId || null, onProgress: progress => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('shitu:import-progress', progress);
    } });
    aePreviewService?.scheduleLibrary(library);
    return { snapshot: library.snapshot(), report };
  } finally { importing = false; }
}

function bindHandlers() {
  checkedHandler('get-history-state', () => historyState());
  checkedHandler('undo-history', (expectedRoot, expectedId) => replayHistory('undo', expectedRoot, expectedId));
  checkedHandler('redo-history', (expectedRoot, expectedId) => replayHistory('redo', expectedRoot, expectedId));
  checkedHandler('transcode-devices', refresh => {
    if (refresh !== undefined && typeof refresh !== 'boolean') throw new Error('设备检测参数无效');
    return transcodeDevices.discover({ refresh: refresh === true });
  });
  checkedHandler('transcode-settings', () => transcodeSettings.get());
  checkedHandler('transcode-settings-save', async settings => {
    if (closing) throw new Error('软件正在关闭，请稍后再保存设置');
    if (settings?.mode === 'gpu' || settings?.mode === 'hybrid') {
      executionPlan(settings, await transcodeDevices.discover(), { format: 'mp4', total: 2 });
    }
    if (closing) throw new Error('软件正在关闭，请稍后再保存设置');
    return transcodeSettings.save(settings);
  });
  checkedHandler('video-transcode-state', () => videoTranscodeService.state());
  checkedHandler('video-transcode-start', async request => {
    if (closing || switchingLibrary || importing || draggingAssets || historyBusy || imagePlugins?.busy()) throw new Error('请等待当前素材操作完成后再转码');
    const settings = await transcodeSettings.get();
    const devices = request?.format === 'dxv' || settings.mode === 'cpu'
      ? { cpu: { name: os.cpus()[0]?.model || 'CPU', logicalProcessors: Math.max(1, Math.min(128, os.availableParallelism?.() || os.cpus().length || 1)) }, gpus: [] }
      : await transcodeDevices.discover();
    if (closing || switchingLibrary || importing || draggingAssets || historyBusy || imagePlugins?.busy()) throw new Error('当前无法开始转码，请稍后重试');
    const plan = executionPlan(settings, devices, { format: request?.format, total: request?.ids?.length || 0 });
    return videoTranscodeService.start({ ...request, executionPlan: plan });
  });
  checkedHandler('video-transcode-cancel', id => videoTranscodeService.cancel(id));
  checkedHandler('prepare-video', prepareVideo);
  checkedHandler('cancel-video', (id, expectedRoot, requestToken) => videoRequests.cancel(id, expectedRoot, requestToken));
  checkedHandler('release-video-viewer', (id, expectedRoot) => videoRequests.releaseViewer(id, expectedRoot));
  checkedHandler('prepare-model', (id, expectedRoot) => modelService.prepare(requireLibrary(), id, expectedRoot));
  checkedHandler('prepare-font', (id, expectedRoot, faceIndex = 0) => fontService.prepare(requireLibrary(), id, expectedRoot, faceIndex));
  checkedHandler('prepare-project-preview', (id, expectedRoot, compositionId) => aePreviewService.prepare(requireLibrary(), id, { expectedRoot, compositionId }));
  checkedHandler('project-preview-state', id => aePreviewService.state(requireLibrary(), id));
  checkedHandler('update-state', () => appUpdater.state());
  checkedHandler('update-open-release', async () => {
    const repository = updateConfig.repository;
    if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) || ['.', '..'].includes(repository.split('/')[1])) throw new Error('尚未配置官方下载页');
    await shell.openExternal(`https://github.com/${repository}/releases/latest`);
    return { opened: true };
  });
  checkedHandler('update-check', () => { updateScheduler?.recordManualCheck(); return checkForApplicationUpdate(); });
  checkedHandler('update-download', () => appUpdater.download());
  checkedHandler('update-install', () => { ensureUpdateCanInstall(); return appUpdater.install(); });
  checkedHandler('plugins-list', () => imagePlugins.list());
  checkedHandler('plugin-install', id => imagePlugins.install(id));
  checkedHandler('plugin-set-enabled', (id, enabled) => imagePlugins.setEnabled(id, enabled));
  checkedHandler('plugin-uninstall', id => imagePlugins.uninstall(id));
  checkedHandler('plugin-run', request => {
    if (historyBusy || closing) throw new Error('正在保存撤销或重做，请稍后再处理素材');
    return imagePlugins.run(request);
  });
  checkedHandler('plugin-cancel', id => imagePlugins.cancel(id));
  ipcMain.on('shitu:start-drag', (event, ids, expectedRoot) => {
    try { assertTrustedSender(event); } catch { return; }
    if (installingUpdate) return;
    startAssetDrag(ids, expectedRoot);
  });
  checkedHandler('copy-asset-image', copyAssetImage);
  checkedHandler('copy-asset-paths', copyAssetPaths);
  checkedHandler('asset-menu', (ids, expectedRoot) => {
    const current = requireLibrary();
    if (typeof expectedRoot !== 'string' || expectedRoot !== current.root) throw new Error('素材库已切换，请重新选择素材');
    if (!Array.isArray(ids) || !ids.length || ids.length > 256 || ids.some(id => typeof id !== 'string')) throw new Error('请选择有效素材');
    const assetIds = [...new Set(ids)];
    const snapshot = current.snapshot();
    const assets = assetIds.map(id => snapshot.assets.find(asset => asset.id === id));
    if (assets.some(asset => !asset)) throw new Error('所选素材不存在，请重新选择');
    return new Promise(resolve => {
      const choose = (action, extra = {}) => {
        if (library !== current || library.root !== expectedRoot) return resolve(null);
        resolve({ action, assetIds, libraryRoot: expectedRoot, ...extra });
      };
      const menu = Menu.buildFromTemplate(assetMenuTemplate(assets, snapshot.folders, choose));
      menu.popup({ window: mainWindow, callback: () => resolve(null) });
    });
  });
  checkedHandler('get-library', librarySnapshot);
  checkedHandler('create-library',()=>switchLibrary('create'));
  checkedHandler('open-library',()=>switchLibrary('open'));
  checkedHandler('migrate-library',()=>switchLibrary('migrate'));
  checkedHandler('use-legacy-library',()=>switchLibrary('legacy'));
  checkedHandler('request-close', () => mainWindow.close());
  checkedHandler('collector-info', () => ({ enabled:collector?.info().enabled||false, baseUrl:collector?.info().baseUrl, ready:Boolean(library)&&!switchingLibrary, error:collectorError || collector?.info().error, lastCapture:collector?.info().lastCapture, appVersion:app.getVersion(), extensionPath }));
  checkedHandler('open-extension-folder', async () => {
    const error=await shell.openPath(extensionPath); if(error)throw new Error(error);
  });
  checkedHandler('open-source', async id => {
    const asset=requireLibrary().snapshot().assets.find(a=>a.id===id);
    const source=asset?.pageUrl || asset?.sourceUrl;
    if(!source)throw new Error('没有来源地址');
    const url=new URL(source);
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw new Error('来源地址不安全');
    await shell.openExternal(url.href);
  });
  checkedHandler('import-files', async folderId => {
    requireLibrary();
    if (historyBusy || closing) throw new Error('正在保存撤销或重做，请稍后再导入');
    const result = await dialog.showOpenDialog(mainWindow, { title: '导入图片、视频、模型、字体或 AE 工程', properties: ['openFile', 'multiSelections'], filters: [{ name: '支持的素材', extensions: [...SUPPORTED] }, { name: '字体', extensions: [...FONT] }, { name: 'AE 工程', extensions: [...PROJECT] }, { name: '3D 模型', extensions: [...MODEL] }] });
    return result.canceled ? { snapshot: library.snapshot(), cancelled: true } : importPaths(result.filePaths, folderId);
  });
  checkedHandler('import-folder', async folderId => {
    requireLibrary();
    if (historyBusy || closing) throw new Error('正在保存撤销或重做，请稍后再导入');
    const result = await dialog.showOpenDialog(mainWindow, { title: '导入文件夹中的素材（包含子文件夹）', properties: ['openDirectory'] });
    return result.canceled ? { snapshot: library.snapshot(), cancelled: true } : importPaths(result.filePaths, folderId);
  });
  checkedHandler('import-paths', importPaths);
  checkedHandler('update-assets', (ids, patch) => saveUserMetadata('updateAssets', [ids, patch], { recordHistory: true }));
  checkedHandler('batch-rename-assets', (changes, expectedRoot) => {
    if (typeof expectedRoot !== 'string') throw new Error('请选择有效的素材库');
    return saveUserMetadata('batchRenameAssets', [changes], { recordHistory: true, expectedRoot });
  });
  checkedHandler('save-smart-folder', (value, expectedRoot) => {
    if (typeof expectedRoot !== 'string') throw new Error('请选择有效的素材库');
    return saveUserMetadata('saveSmartFolder', [value], { expectedRoot });
  });
  checkedHandler('delete-smart-folder', (id, expectedRoot) => {
    if (typeof expectedRoot !== 'string') throw new Error('请选择有效的素材库');
    return saveUserMetadata('deleteSmartFolder', [id], { expectedRoot });
  });
  checkedHandler('move-assets-to-folder', moveAssetsToFolder);
  checkedHandler('set-trash', (ids, trashed) => saveUserMetadata('setTrash', [ids, trashed]));
  checkedHandler('delete-permanently', (ids, expectedRoot) => {
    const current = requireLibrary();
    if (typeof expectedRoot !== 'string' || expectedRoot !== current.root) throw new Error('素材库已切换，请重新选择素材');
    return saveUserMetadata('deletePermanently', [ids], { expectedRoot });
  });
  checkedHandler('create-folder', (name, parentId = null) => saveUserMetadata('createFolder', [name, parentId]));
  checkedHandler('move-folder', (id, parentId = null) => saveUserMetadata('moveFolder', [id, parentId], { recordHistory: true }));
  checkedHandler('rename-folder', (id, name) => saveUserMetadata('renameFolder', [id, name], { recordHistory: true }));
  checkedHandler('set-folder-color', (id, colorLabel) => saveUserMetadata('setFolderColor', [id, colorLabel], { recordHistory: true }));
  checkedHandler('delete-folder', id => saveUserMetadata('deleteFolder', [id]));
  checkedHandler('export-assets', async ids => {
    requireLibrary();
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择导出文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return { cancelled: true };
    const exported = await library.exportAssets(ids, result.filePaths[0]);
    return { cancelled: false, count: exported.exported, path: result.filePaths[0] };
  });
  checkedHandler('backup', async () => {
    requireLibrary();
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择备份保存位置', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return { cancelled: true };
    const backup = await library.backupTo(result.filePaths[0]);
    return { cancelled: false, path: backup.path };
  });
  checkedHandler('reveal-asset', id => {
    const file = requireLibrary().getAssetPath(id, 'original');
    if (!file) throw new Error('找不到图片');
    shell.showItemInFolder(file);
  });
  checkedHandler('open-asset', async id => {
    const file = requireLibrary().getAssetPath(id, 'original');
    if (!file) throw new Error('找不到图片');
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  });
  checkedHandler('reveal-library', async () => {
    const error = await shell.openPath(requireLibrary().root);
    if (error) throw new Error(error);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460, height: 920, minWidth: 1080, minHeight: 700,
    title: '', backgroundColor: '#0a0a0a',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== indexPage) event.preventDefault(); });
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  uiRecovery = createUiRecovery({ app, window: mainWindow,
    canRecover: () => !closing && !installingUpdate && !draggingAssets,
    onDiagnostic: recordUiDiagnostic,
    onExhausted: async () => {
      if (closing || mainWindow.isDestroyed()) return;
      const result = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '界面显示异常',
        message: '界面连续出现显示异常，可以重新载入界面。已保存的素材库不受影响。',
        buttons: ['重新载入界面', '稍后处理'], defaultId: 0, cancelId: 1 });
      if (result.response === 0 && !closing && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    }
  });
  const sendVisibility = visible => {
    if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('shitu:window-visibility', visible);
  };
  for (const event of ['minimize', 'hide']) mainWindow.on(event, () => sendVisibility(false));
  for (const event of ['restore', 'show', 'focus']) mainWindow.on(event, () => sendVisibility(true));
  for (const event of ['restore', 'focus']) mainWindow.on(event, () => updateScheduler?.trigger(event));
  mainWindow.on('close', event => {
    if (mayClose) { mayClose=false; closing=false; return; }
    event.preventDefault();
    if (switchingLibrary || importing || draggingAssets || historyBusy || metadataSaves.size || imagePlugins?.busy() || collector?.activeCount()) {
      dialog.showMessageBox(mainWindow, { type: 'info', title: '素材操作进行中', message: '请等待素材操作完成后再关闭拾图。图片处理任务可在插件中心取消。', buttons: ['知道了'] });
      return;
    }
    if (closing) return;
    closing = true;
    Promise.resolve(videoTranscodeService?.shutdown()).then(() => transcodeSettings?.flush()).then(() => library?.flush()).then(() => Promise.allSettled([transcodeDevices?.shutdown?.(), videoTranscoder?.shutdown(), modelService?.shutdown(), fontService?.shutdown(), aeProjects?.shutdown(), aePreviewService?.shutdown()])).then(() => { mayClose = true; mainWindow.close(); }).catch(error => {
      closing = false;
      dialog.showErrorBox('保存未完成', error.message);
    });
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    videoEngine = createVideoEngine({ runtimeDir: path.join(__dirname, '..', 'video-runtime'), cacheDir: path.join(app.getPath('userData'), 'video-previews') });
    transcodeDevices = createTranscodeDeviceManager({ runtimeDir: path.join(__dirname, '..', 'video-runtime') });
    videoTranscoder = createVideoTranscoder({ runtimeDir: path.join(__dirname, '..', 'video-runtime'), deviceManager: transcodeDevices });
    transcodeSettings = createTranscodeSettings({ filePath: path.join(app.getPath('userData'), 'transcode-settings.json') });
    videoTranscodeService = createVideoTranscodeService({ engine: videoTranscoder, getLibrary: () => library,
      workDir: path.join(app.getPath('userData'), 'video-transcodes'),
      onEvent: state => sendActionEvent('video-transcode', state),
      onChanged: owner => { if (owner === library) sendActionEvent('library-changed'); }
    });
    modelService = createModelService({ BrowserWindow, cacheDir: path.join(app.getPath('userData'), 'model-previews'), getLibrary: () => library });
    fontService = createFontService({ BrowserWindow, cacheDir: path.join(app.getPath('userData'), 'font-previews'), getLibrary: () => library });
    aeProjects = createAEProjectCollector({ cacheDir: path.join(app.getPath('userData'), 'ae-projects') });
    libraryManager=new LibraryManager({configPath:path.join(app.getPath('userData'),'library-location.json'),legacyRoot,createThumbnail,
      prepareProjectBundle:(source, options)=>{
        sendActionEvent('import-progress', { current: 0, total: 1, name: `正在收集 AE 工程与素材：${path.basename(source)}` });
        return aeProjects.prepareProjectBundle(source, options);
      },overrideRoot});
    await libraryManager.init();
    library=libraryManager.current();
    const aePreviewEngine = createAEPreviewEngine({
      cacheDir: path.join(app.getPath('userData'), 'ae-previews'),
      onProgress: detail => aePreviewService?.progress(detail)
    });
    aePreviewService = createAEPreviewService({
      engine: aePreviewEngine,
      getLibrary: () => library,
      onChanged: owner => { if (owner === library) sendActionEvent('library-changed'); },
      onProgress: (owner, detail) => { if (owner === library) sendActionEvent('project-preview', detail); }
    });
    imagePlugins=createImagePlugins({
      rootDir:path.join(process.env.SHITU_PLUGIN_ROOT || app.getPath('userData'),'plugins'),
      getLibrary:requireLibrary,
      onEvent:event=>{
        sendActionEvent('plugin-event', event);
        if(event.type==='complete' || (event.type==='error' && event.results?.length)) sendActionEvent('library-changed');
      }
    });
    collector=createCollector({library:{snapshot:()=>requireLibrary().snapshot(),importPaths:(...args)=>{
      if (installingUpdate) throw new Error('正在安装更新，暂时无法采集');
      if (historyBusy || closing) throw new Error('正在保存撤销或重做，暂时无法采集');
      return requireLibrary().importPaths(...args);
    }},appVersion:app.getVersion(),isReady:()=>Boolean(library)&&!switchingLibrary&&!installingUpdate&&!historyBusy&&!closing,configPath:path.join(app.getPath('userData'),'collector.json'),allowPrivate:!app.isPackaged && process.env.SHITU_TEST_ALLOW_PRIVATE==='1',onImported:result=>{
      if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('shitu:library-changed');
      sendHistory();
      sendActionEvent('web-capture', result);
    }});
    try {await collector.start();} catch(error) {collectorError=error.message;}
    protocol.handle('shitu', async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname === 'model') return modelService.response(request);
        if (url.hostname === 'font') return fontService.response(request);
        if (url.hostname === 'project-preview') return aePreviewService.response(request);
        if (request.method !== 'GET' || url.hostname !== 'asset') return new Response(null, { status: 404 });
        const id = decodeURIComponent(url.pathname.slice(1));
        const kind = url.searchParams.get('kind') === 'original' ? 'original' : 'thumbnail';
        if(!library)return new Response(null,{status:404});
        if (url.searchParams.get('kind') === 'preview') {
          const preview = videoPreviews.get(url.searchParams.get('key'));
          if (!preview || preview.id !== id || preview.root !== library.root ||
              library.getAssetPath(id, 'original') !== preview.source) return new Response(null, { status: 404 });
          return mediaResponse(preview.path, request);
        }
        if(url.searchParams.get('kind') === 'editing') {
          const asset = library.snapshot().assets.find(item => item.id === id);
          if (!asset || asset.mediaType !== 'image') return new Response(null, { status: 404 });
          const source = library.getAssetPath(id, 'original');
          if(!source)return new Response(null,{status:404});
          const image = await sharp(source, { limitInputPixels: 100_000_000 }).rotate().png().toBuffer();
          return new Response(new Uint8Array(image), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
        let file = library.getAssetPath(id, kind);
        if (!file && kind === 'thumbnail') file = library.getAssetPath(id, 'original');
        if (!file) return new Response(null, { status: 404 });
        return mediaResponse(file,request);
      } catch { return new Response(null, { status: 404 }); }
    });
    Menu.setApplicationMenu(null);
    initializeAppUpdater();
    bindHandlers();
    await createWindow();
    updateScheduler.start();
    aePreviewService.scheduleLibrary(library);
  }).catch(error => {
    dialog.showErrorBox('拾图无法启动', `${error.message}\n\n请保留库内文件，检查权限或使用备份恢复。`);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    uiRecovery?.dispose();
    updateScheduler?.dispose(); appUpdater?.dispose();
    videoRequests.abortAll();
    videoTranscodeService?.shutdown().catch(()=>{}); videoTranscoder?.shutdown().catch(()=>{});
    Promise.resolve(transcodeDevices?.shutdown?.()).catch(()=>{});
    imagePlugins?.shutdown().catch(()=>{}); collector?.close().catch(()=>{}); videoEngine?.shutdown().catch(()=>{}); modelService?.shutdown().catch(()=>{}); fontService?.shutdown().catch(()=>{}); aeProjects?.shutdown().catch(()=>{}); aePreviewService?.shutdown().catch(()=>{});
  });
}
