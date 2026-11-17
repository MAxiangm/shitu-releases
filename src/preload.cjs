const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = (channel, ...args) => ipcRenderer.invoke(`shitu:${channel}`, ...args);
contextBridge.exposeInMainWorld('shitu', Object.freeze({
  updateState: () => call('update-state'),
  checkUpdate: () => call('update-check'),
  downloadUpdate: () => call('update-download'),
  installUpdate: () => call('update-install'),
  onUpdateState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('shitu:update-state', listener);
    return () => ipcRenderer.removeListener('shitu:update-state', listener);
  },
  pluginsList: () => call('plugins-list'),
  pluginInstall: id => call('plugin-install', id),
  pluginSetEnabled: (id, enabled) => call('plugin-set-enabled', id, enabled),
  pluginUninstall: id => call('plugin-uninstall', id),
  pluginRun: request => call('plugin-run', request),
  pluginCancel: id => call('plugin-cancel', id),
  onPluginEvent: callback => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on('shitu:plugin-event', listener);
    return () => ipcRenderer.removeListener('shitu:plugin-event', listener);
  },
  getLibrary: () => call('get-library'),
  prepareVideo: (id, expectedRoot) => call('prepare-video', id, expectedRoot),
  prepareModel: (id, expectedRoot) => call('prepare-model', id, expectedRoot),
  prepareProjectPreview: (id, expectedRoot, compositionId) => call('prepare-project-preview', id, expectedRoot, compositionId),
  projectPreviewState: id => call('project-preview-state', id),
  onProjectPreview: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('shitu:project-preview', listener);
    return () => ipcRenderer.removeListener('shitu:project-preview', listener);
  },
  startAssetDrag: (ids, expectedRoot) => ipcRenderer.send('shitu:start-drag', ids, expectedRoot),
  copyAssetImage: (id, expectedRoot) => call('copy-asset-image', id, expectedRoot),
  copyAssetPaths: (ids, expectedRoot) => call('copy-asset-paths', ids, expectedRoot),
  assetContextMenu: (ids, expectedRoot) => call('asset-menu', ids, expectedRoot),
  createLibrary:()=>call('create-library'),
  openLibrary:()=>call('open-library'),
  migrateLibrary:()=>call('migrate-library'),
  useLegacyLibrary:()=>call('use-legacy-library'),
  importFiles: folderId => call('import-files', folderId),
  importFolder: folderId => call('import-folder', folderId),
  importPaths: (paths, folderId) => call('import-paths', paths, folderId),
  updateAssets: (ids, patch) => call('update-assets', ids, patch),
  setTrash: (ids, trashed) => call('set-trash', ids, trashed),
  deletePermanently: (ids, expectedRoot) => call('delete-permanently', ids, expectedRoot),
  createFolder: name => call('create-folder', name),
  renameFolder: (id, name) => call('rename-folder', id, name),
  deleteFolder: id => call('delete-folder', id),
  exportAssets: ids => call('export-assets', ids),
  backup: () => call('backup'),
  revealAsset: id => call('reveal-asset', id),
  openAsset: id => call('open-asset', id),
  revealLibrary: () => call('reveal-library'),
  requestClose: () => call('request-close'),
  getCollectorInfo: () => call('collector-info'),
  onWebCapture: callback => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('shitu:web-capture', listener);
    return () => ipcRenderer.removeListener('shitu:web-capture', listener);
  },
  openExtensionFolder: () => call('open-extension-folder'),
  openSource: id => call('open-source',id),
  getFilePath: file => webUtils.getPathForFile(file),
  assetUrl: (id, kind = 'thumb') => `shitu://asset/${encodeURIComponent(id)}?kind=${encodeURIComponent(kind)}`,
  onWindowVisibility: callback => {
    const listener = (_event, visible) => callback(visible === true);
    ipcRenderer.on('shitu:window-visibility', listener);
    return () => ipcRenderer.removeListener('shitu:window-visibility', listener);
  },
  onActionError: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('shitu:action-error', listener);
    return () => ipcRenderer.removeListener('shitu:action-error', listener);
  },
  onAssetDragEnd: callback => {
    const listener = () => callback();
    ipcRenderer.on('shitu:drag-ended', listener);
    return () => ipcRenderer.removeListener('shitu:drag-ended', listener);
  },
  onImportProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('shitu:import-progress', listener);
    return () => ipcRenderer.removeListener('shitu:import-progress', listener);
  },
  onLibraryChanged: callback => {
    const listener=()=>callback();
    ipcRenderer.on('shitu:library-changed',listener);
    return ()=>ipcRenderer.removeListener('shitu:library-changed',listener);
  }
}));
