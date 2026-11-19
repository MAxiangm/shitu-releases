'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { exportSketchfabViewer } = require('./sketchfab-viewer-export.cjs');
const { collectModelBundle } = require('./model-bundle.cjs');
const { checkedSketchfabPage } = require('./sketchfab-download.cjs');

function invalid() {
  return Object.assign(new Error('网页模型数据无效，请刷新模型页后重新采集。'), { code: 'SKETCHFAB_VIEWER_INVALID' });
}

async function stageSketchfabViewerModel({ modelId, pageUrl, snapshot, title, directory, signal, onProgress = () => {} } = {}) {
  pageUrl = checkedSketchfabPage(modelId, pageUrl);
  if (!snapshot || snapshot.modelId !== modelId || typeof directory !== 'string' || !path.isAbsolute(directory)) throw invalid();
  directory = path.resolve(directory);
  for (let current = directory, previous; current !== previous; previous = current, current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  }
  signal?.throwIfAborted();
  onProgress({ phase: 'verifying' });
  const converted = exportSketchfabViewer(snapshot);
  signal?.throwIfAborted();
  const root = await fs.mkdtemp(path.join(directory, 'viewer-'));
  const entryPath = path.join(root, 'model.glb');
  const name = typeof title === 'string' ? title.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 240) : '';
  const attribution = { version: 1, provider: 'Sketchfab', modelId, pageUrl, captureMethod: 'viewer', ...(name ? { title: name } : {}) };
  try {
    await fs.writeFile(entryPath, converted.glb, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(root, 'sketchfab-attribution.json'), JSON.stringify(attribution, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(root, 'capture-details.json'), JSON.stringify({ version: 1, captureMethod: 'viewer',
      modelId, pageUrl, stats: converted.stats, warnings: converted.warnings }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    signal?.throwIfAborted();
    const plan = await collectModelBundle(entryPath, { allowedRoots: [root], signal });
    if (plan.missing.length) throw invalid();
    return { root, entryPath, files: ['capture-details.json', 'model.glb', 'sketchfab-attribution.json'],
      attribution, warnings: converted.warnings, stats: converted.stats };
  } catch (error) {
    if (path.dirname(root) === directory && path.basename(root).startsWith('viewer-')) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { stageSketchfabViewerModel };
