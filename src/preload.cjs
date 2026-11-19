const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = (channel, ...args) => ipcRenderer.invoke(`shitu:${channel}`, ...args);
contextBridge.exposeInMainWorld('shitu', Object.freeze({
  windowState: () => call('window-state'),
  windowCommand: action => call('window-command', action),
  taskCenterState: () => call('task-center-state'),
  clearTasks: () => call('task-center-clear'),
  retryTask: id => call('task-center-retry', id),
  onTaskCenter: callback => {
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on('shitu:task-center', listener);
    return () => ipcRenderer.removeListener('shitu:task-center', listener);
  },
  setWindowSkin: id => call('window-skin', id),
  onWindowState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('shitu:window-state', listener);
    return () => ipcRenderer.removeListener('shitu:window-state', listener);
  },
  updateState: () => call('update-state'),
  checkUpdate: () => call('update-check'),
  openUpdateRelease: () => call('update-open-release'),
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
  historyState: () => call('get-history-state'),
  undoHistory: (expectedRoot, expectedId) => call('undo-history', expectedRoot, expectedId),
  redoHistory: (expectedRoot, expectedId) => call('redo-history', expectedRoot, expectedId),
  onHistory: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('shitu:history', listener);
    return () => ipcRenderer.removeListener('shitu:history', listener);
  },
  prepareVideo: (id, expectedRoot, requestToken, profile = 'full', requestSerial) => call('prepare-video', id, expectedRoot, requestToken, profile, requestSerial),
  prepareAudioPreview: (id, expectedRoot, requestToken) => call('prepare-audio', id, expectedRoot, requestToken),
  cancelAudioPreview: requestToken => call('cancel-audio', requestToken),
  findVideoFrame: (id, root, key, time, direction) => call('find-video-frame', id, root, key, time, direction),
  saveVideoThumbnail: (id, root, key, bytes) => call('save-video-thumbnail', id, root, key, bytes),
  onVideoPreview: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('shitu:video-preview', listener);
    return () => ipcRenderer.removeListener('shitu:video-preview', listener);
  },
  startVideoTranscode: request => call('video-transcode-start', request),
  listTranscodePresets: () => call('transcode-presets'),
  saveTranscodePreset: preset => call('transcode-preset-save', preset),
  removeTranscodePreset: id => call('transcode-preset-remove', id),
  getTranscodeDevices: refresh => call('transcode-devices', refresh),
  getTranscodeSettings: () => call('transcode-settings'),
  saveTranscodeSettings: settings => call('transcode-settings-save', settings),
  videoTranscodeState: () => call('video-transcode-state'),
  cancelVideoTranscode: id => call('video-transcode-cancel', id),
  onVideoTranscode: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('shitu:video-transcode', listener);
    return () => ipcRenderer.removeListener('shitu:video-transcode', listener);
  },
  cancelVideo: (id, expectedRoot, requestToken) => call('cancel-video', id, expectedRoot, requestToken),
  releaseVideoViewer: (id, expectedRoot) => call('release-video-viewer', id, expectedRoot),
  prepareModel: (id, expectedRoot) => call('prepare-model', id, expectedRoot),
  prepareModelHover: (id, expectedRoot, token) => call('prepare-model-hover', id, expectedRoot, token),
  cancelModelHover: (id, expectedRoot, token) => call('cancel-model-hover', id, expectedRoot, token),
  warmModelHover: (id, expectedRoot, token) => call('warm-model-hover', id, expectedRoot, token),
  cancelModelWarmup: (id, expectedRoot, token) => call('cancel-model-warmup', id, expectedRoot, token),
  findSimilarImages: (id, expectedRoot, token) => call('find-similar-images', id, expectedRoot, token),
  cancelSimilarImages: (expectedRoot, token) => call('cancel-similar-images', expectedRoot, token),
  onSimilarImageProgress: callback => {
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on('shitu:similar-image-progress', listener);
    return () => ipcRenderer.removeListener('shitu:similar-image-progress', listener);
  },
  prepareFont: (id, expectedRoot, faceIndex = 0) => call('prepare-font', id, expectedRoot, faceIndex),
  exportFontImage: (id, expectedRoot, options) => call('export-font-image', id, expectedRoot, options),
  prepareProjectPreview: (id, expectedRoot, compositionId) => call('prepare-project-preview', id, expectedRoot, compositionId),
  projectPreviewState: id => call('project-preview-state', id),
  recheckBundles: (ids, expectedRoot) => call('recheck-bundles', ids, expectedRoot),
  planBundleRepair: (id, expectedRoot) => call('plan-bundle-repair', id, expectedRoot),
  applyBundleRepair: (id, token) => call('apply-bundle-repair', id, token),
  cancelBundleRepair: token => call('cancel-bundle-repair', token),
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
  batchRenameAssets: (changes, expectedRoot) => call('batch-rename-assets', changes, expectedRoot),
  saveSmartFolder: (value, expectedRoot) => call('save-smart-folder', value, expectedRoot),
  deleteSmartFolder: (id, expectedRoot) => call('delete-smart-folder', id, expectedRoot),
  moveAssetsToFolder: (ids, folderId, expectedRoot) => call('move-assets-to-folder', ids, folderId, expectedRoot),
  setTrash: (ids, trashed) => call('set-trash', ids, trashed),
  deletePermanently: (ids, expectedRoot) => call('delete-permanently', ids, expectedRoot),
  createFolder: (name, parentId = null) => call('create-folder', name, parentId),
  moveFolder: (id, parentId = null, placement = {}, expectedRoot) => call('move-folder', id, parentId, placement, expectedRoot),
  renameFolder: (id, name) => call('rename-folder', id, name),
  setFolderColor: (id, colorLabel) => call('set-folder-color', id, colorLabel),
  setFolderIcon: (id, name, expectedRoot) => call('set-folder-icon', id, name, expectedRoot),
  setFolderIconColor: (id, color, expectedRoot) => call('set-folder-icon-color', id, color, expectedRoot),
  chooseFolderIcon: (id, expectedRoot) => call('choose-folder-icon', id, expectedRoot),
  deleteFolder: id => call('delete-folder', id),
  exportAssets: (ids, expectedRoot) => call('export-assets', ids, expectedRoot),
  exportFolder: (id, expectedRoot) => call('export-folder', id, expectedRoot),
  onExportProgress: callback => {
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on('shitu:export-progress', listener);
    return () => ipcRenderer.removeListener('shitu:export-progress', listener);
  },
  backup: () => call('backup'),
  revealAsset: id => call('reveal-asset', id),
  openAsset: id => call('open-asset', id),
  revealLibrary: () => call('reveal-library'),
  requestClose: () => call('request-close'),
  getCollectorInfo: () => call('collector-info'),
  getYouTubeAuthState: () => call('youtube-auth-state'),
  connectYouTube: () => call('youtube-auth-connect'),
  disconnectYouTube: () => call('youtube-auth-disconnect'),
  onWebCapture: callback => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('shitu:web-capture', listener);
    return () => ipcRenderer.removeListener('shitu:web-capture', listener);
  },
  onWebCaptureLocate: callback => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('shitu:web-capture-locate', listener);
    return () => ipcRenderer.removeListener('shitu:web-capture-locate', listener);
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
