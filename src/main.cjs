const { app, BrowserWindow, protocol, ipcMain, dialog, shell, nativeImage, nativeTheme, Menu, clipboard, ClipboardItem, net } = require('electron');
const path = require('node:path');
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
const { createVideoEngine } = require('./video-engine.cjs');
const { VIDEO, SUPPORTED } = require('./media-formats.cjs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const updateConfig = require('../update-config.json');

app.setName('拾图');
nativeTheme.themeSource = 'dark';
app.setAppUserModelId('local.shitu.desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'shitu', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
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
let imagePlugins;
let videoEngine;
const videoPreviews = new Map();
const videoRequests = new Set();
let appUpdater;
let updateTimer;
let updateInterval;
let installingUpdate = false;
let activeOperations = 0;
const indexPage = pathToFileURL(path.join(__dirname, 'index.html')).href;
const overrideRoot = process.env.SHITU_LIBRARY;
const legacyRoot = path.join(app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(), 'library');
const extensionPath = app.isPackaged ? path.join(path.dirname(process.execPath), 'Chrome扩展') : path.join(app.getAppPath(), 'extension');

function requireLibrary() {
  if(switchingLibrary)throw new Error('正在切换素材库，请稍候');
  if(!library)throw new Error('请先选择素材库位置');
  return library;
}
function librarySnapshot() {
  if(library)return library.snapshot();
  const status=libraryManager.status();
  return {root:null,assets:[],folders:[],tags:[],stats:{total:0,active:0,trashed:0,untagged:0,unfiled:0,bytes:0},needsLibrary:true,libraryError:status.error,legacyRoot:status.legacyRoot};
}

async function prepareVideo(id, expectedRoot) {
  const current = requireLibrary();
  if (current.root !== expectedRoot) throw new Error('素材库已切换，请重新选择视频');
  let asset = current.snapshot().assets.find(item => item.id === id);
  if (!asset || asset.mediaType !== 'video') throw new Error('请选择有效的视频素材');
  const source = current.getAssetPath(id, 'original');
  // A single viewer is active; switching clips should stop its previous conversion.
  for (const previous of videoRequests) previous.abort();
  const controller = new AbortController();
  videoRequests.add(controller);
  try {
    if (!asset.thumbnail || !asset.codec) {
      const result = await current.refreshVideoMetadata([id], { signal: controller.signal });
      if (result.updated) {
        asset = result.snapshot.assets.find(item => item.id === id);
        if (library === current) sendActionEvent('library-changed');
      }
    }
    controller.signal.throwIfAborted();
    const result = await videoEngine.preview(source, { key: asset.hash, signal: controller.signal });
    controller.signal.throwIfAborted();
    if (library !== current || current.getAssetPath(id, 'original') !== source) throw new Error('素材库已切换，请重新选择视频');
    const key = crypto.createHash('sha256').update(`${current.root}\0${id}\0${asset.hash}`).digest('hex');
    videoPreviews.set(key, { id, root: current.root, source, path: result.path });
    return { url: `shitu://asset/${encodeURIComponent(id)}?kind=preview&key=${key}`, width: result.width,
      height: result.height, duration: result.duration, codec: result.sourceCodec || asset.codec || result.codec, mimeType: result.mimeType };
  } finally { videoRequests.delete(controller); }
}
async function switchLibrary(mode) {
  if(switchingLibrary || importing || draggingAssets || imagePlugins?.busy() || collector?.activeCount())throw new Error('请等待当前导入、采集、图片处理或拖放完成后再切换素材库');
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
    for (const controller of videoRequests) controller.abort();
    videoPreviews.clear();
    library=mode==='create'?await libraryManager.create(selected):mode==='migrate'?await libraryManager.migrate(selected):await libraryManager.open(selected);
    const snapshot=librarySnapshot();
    mainWindow.webContents.send('shitu:library-changed');
    return {snapshot};
  } finally {switchingLibrary=false;}
}

async function createThumbnail(source, destination, options) {
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
    if (channel.startsWith('update-') || channel === 'prepare-video') return handler(...args);
    activeOperations++;
    try { return await handler(...args); }
    finally { activeOperations--; }
  });
}

function ensureUpdateCanInstall() {
  if (!app.isPackaged || process.platform !== 'win32') throw new Error('开发模式不安装更新，请使用正式安装版');
  if (installingUpdate || closing || activeOperations || switchingLibrary || importing || draggingAssets || imagePlugins?.busy() || collector?.activeCount()) {
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
    await Promise.allSettled([imagePlugins?.shutdown(), collector?.close(), videoEngine?.shutdown()]);
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

function initializeAppUpdater() {
  appUpdater = createAppUpdater({
    currentVersion: app.getVersion(), repository: updateConfig.repository,
    cacheDir: path.join(app.getPath('userData'), 'updates'),
    enabled: app.isPackaged && process.platform === 'win32' && process.arch === 'x64',
    fetchImpl: (url, options) => net.fetch(url, options),
    onEvent: state => sendActionEvent('update-state', state),
    install: installDownloadedUpdate
  });
  if (app.isPackaged && updateConfig.repository) {
    updateTimer = setTimeout(() => checkForApplicationUpdate().catch(() => {}), 15000);
    updateTimer.unref();
    const hours = Math.min(24, Math.max(1, Number(updateConfig.checkIntervalHours) || 6));
    updateInterval = setInterval(() => checkForApplicationUpdate().catch(() => {}), hours * 3600000);
    updateInterval.unref();
  }
}

function sendActionEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(`shitu:${channel}`, payload);
}

function startAssetDrag(ids, expectedRoot) {
  if (draggingAssets) return;
  try {
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

async function copyAssetImage(id, expectedRoot) {
  const { assets, files } = resolveAssetFiles(requireLibrary(), [id], expectedRoot);
  if (assets[0].mediaType === 'video') throw new Error('视频不能作为位图复制，请拖出或导出原文件');
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
  if (importing) throw new Error('正在导入图片，请等待当前任务完成');
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('无效的导入路径');
  importing = true;
  try {
    const report = await library.importPaths(paths, { folderId: folderId || null, onProgress: progress => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('shitu:import-progress', progress);
    } });
    return { snapshot: library.snapshot(), report };
  } finally { importing = false; }
}

function bindHandlers() {
  checkedHandler('prepare-video', prepareVideo);
  checkedHandler('update-state', () => appUpdater.state());
  checkedHandler('update-check', () => checkForApplicationUpdate());
  checkedHandler('update-download', () => appUpdater.download());
  checkedHandler('update-install', () => { ensureUpdateCanInstall(); return appUpdater.install(); });
  checkedHandler('plugins-list', () => imagePlugins.list());
  checkedHandler('plugin-install', id => imagePlugins.install(id));
  checkedHandler('plugin-set-enabled', (id, enabled) => imagePlugins.setEnabled(id, enabled));
  checkedHandler('plugin-uninstall', id => imagePlugins.uninstall(id));
  checkedHandler('plugin-run', request => imagePlugins.run(request));
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
  checkedHandler('collector-info', () => ({ enabled:collector?.info().enabled||false, baseUrl:collector?.info().baseUrl, ready:Boolean(library)&&!switchingLibrary, error:collectorError || collector?.info().error, extensionPath }));
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
    const result = await dialog.showOpenDialog(mainWindow, { title: '导入图片或视频', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片和视频', extensions: [...SUPPORTED] }] });
    return result.canceled ? { snapshot: library.snapshot(), cancelled: true } : importPaths(result.filePaths, folderId);
  });
  checkedHandler('import-folder', async folderId => {
    requireLibrary();
    const result = await dialog.showOpenDialog(mainWindow, { title: '导入文件夹中的素材（包含子文件夹）', properties: ['openDirectory'] });
    return result.canceled ? { snapshot: library.snapshot(), cancelled: true } : importPaths(result.filePaths, folderId);
  });
  checkedHandler('import-paths', importPaths);
  checkedHandler('update-assets', (ids, patch) => requireLibrary().updateAssets(ids, patch));
  checkedHandler('set-trash', (ids, trashed) => requireLibrary().setTrash(ids, trashed));
  checkedHandler('delete-permanently', (ids, expectedRoot) => {
    const current = requireLibrary();
    if (typeof expectedRoot !== 'string' || expectedRoot !== current.root) throw new Error('素材库已切换，请重新选择素材');
    return current.deletePermanently(ids);
  });
  checkedHandler('create-folder', name => requireLibrary().createFolder(name));
  checkedHandler('rename-folder', (id, name) => requireLibrary().renameFolder(id, name));
  checkedHandler('delete-folder', id => requireLibrary().deleteFolder(id));
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
  const sendVisibility = visible => {
    if (!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('shitu:window-visibility', visible);
  };
  for (const event of ['minimize', 'hide']) mainWindow.on(event, () => sendVisibility(false));
  for (const event of ['restore', 'show', 'focus']) mainWindow.on(event, () => sendVisibility(true));
  mainWindow.on('close', event => {
    if (mayClose) { mayClose=false; closing=false; return; }
    event.preventDefault();
    if (switchingLibrary || importing || draggingAssets || imagePlugins?.busy() || collector?.activeCount()) {
      dialog.showMessageBox(mainWindow, { type: 'info', title: '素材操作进行中', message: '请等待素材操作完成后再关闭拾图。图片处理任务可在插件中心取消。', buttons: ['知道了'] });
      return;
    }
    if (closing) return;
    closing = true;
    Promise.resolve(library?.flush()).then(() => { mayClose = true; mainWindow.close(); }).catch(error => {
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
    libraryManager=new LibraryManager({configPath:path.join(app.getPath('userData'),'library-location.json'),legacyRoot,createThumbnail,overrideRoot});
    await libraryManager.init();
    library=libraryManager.current();
    imagePlugins=createImagePlugins({
      rootDir:path.join(process.env.SHITU_PLUGIN_ROOT || app.getPath('userData'),'plugins'),
      getLibrary:requireLibrary,
      onEvent:event=>{
        sendActionEvent('plugin-event', event);
        if(event.type==='complete' || (event.type==='error' && event.results?.length)) sendActionEvent('library-changed');
      }
    });
    collector=createCollector({library:{importPaths:(...args)=>{
      if (installingUpdate) throw new Error('正在安装更新，暂时无法采集');
      return requireLibrary().importPaths(...args);
    }},isReady:()=>Boolean(library)&&!switchingLibrary&&!installingUpdate,configPath:path.join(app.getPath('userData'),'collector.json'),allowPrivate:!app.isPackaged && process.env.SHITU_TEST_ALLOW_PRIVATE==='1',onImported:()=>{
      if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('shitu:library-changed');
    }});
    try {await collector.start();} catch(error) {collectorError=error.message;}
    protocol.handle('shitu', async request => {
      try {
        const url = new URL(request.url);
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
  }).catch(error => {
    dialog.showErrorBox('拾图无法启动', `${error.message}\n\n请保留库内文件，检查权限或使用备份恢复。`);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    clearTimeout(updateTimer); clearInterval(updateInterval); appUpdater?.dispose();
    for (const controller of videoRequests) controller.abort();
    imagePlugins?.shutdown().catch(()=>{}); collector?.close().catch(()=>{}); videoEngine?.shutdown().catch(()=>{});
  });
}
