'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { collectModelBundle, copyModelBundle } = require('./model-bundle.cjs');

const MAX_SEARCH_ENTRIES = 100000;
const MAX_PLANS = 8;
const manifestOf = asset => asset?.projectBundle || asset?.modelBundle;
const pathKey = value => value.normalize('NFC').toLowerCase();

function referenceParts(reference, project) {
  // A nested model reference in an AE package has no owning project FileSource.
  if (!reference || /^模型依赖：|^(?![a-z]:[\\/])[a-z][a-z0-9+.-]*:/i.test(reference)) return [];
  let name = reference;
  if (!project) { try { name = decodeURIComponent(name); } catch {} }
  return name.replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..');
}

function matchScore(reference, candidate) {
  let score = 0;
  while (score < reference.length && score < candidate.length &&
      pathKey(reference[reference.length - 1 - score]) === pathKey(candidate[candidate.length - 1 - score])) score++;
  return score;
}

async function indexMatches(root, wanted) {
  const files = new Map();
  const stack = [{ directory: root, parts: [] }];
  let entries = 0;
  while (stack.length) {
    const { directory, parts } = stack.pop();
    for await (const entry of await fs.opendir(directory)) {
      if (++entries > MAX_SEARCH_ENTRIES) throw new Error('搜索目录中的文件太多，请选择更具体的素材文件夹');
      const filename = path.join(directory, entry.name);
      const next = [...parts, entry.name];
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push({ directory: filename, parts: next });
      else if (entry.isFile() && wanted.has(pathKey(entry.name))) {
        const key = pathKey(entry.name);
        const matches = files.get(key) || [];
        matches.push({ filename, parts: next });
        files.set(key, matches);
      }
    }
  }
  return files;
}

async function fingerprint(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || pathKey(await fs.realpath(filename)) !== pathKey(filename)) throw new Error('匹配文件已变化或不可读取，请重新查找');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return { size: info.size, hash: hash.digest('hex') };
}

async function planMatches(asset, directory) {
  const root = path.resolve(directory);
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || pathKey(await fs.realpath(root)) !== pathKey(root)) throw new Error('请选择可读取的普通文件夹');
  const references = manifestOf(asset).missing.map(reference => ({ reference, parts: referenceParts(reference, Boolean(asset.projectBundle)) }));
  const wanted = new Set(references.filter(item => item.parts.length).map(item => pathKey(item.parts.at(-1))));
  const files = wanted.size ? await indexMatches(root, wanted) : new Map();
  const replacements = new Map(), candidates = new Map(), rows = [];
  for (const item of references) {
    if (!item.parts.length) { rows.push({ reference: item.reference, status: 'unsupported' }); continue; }
    const possible = files.get(pathKey(item.parts.at(-1))) || [];
    let bestScore = 0, best = [];
    for (const candidate of possible) {
      const score = matchScore(item.parts, candidate.parts);
      if (score > bestScore) { bestScore = score; best = [candidate]; }
      else if (score === bestScore) best.push(candidate);
    }
    if (best.length !== 1) { rows.push({ reference: item.reference, status: best.length ? 'ambiguous' : 'missing' }); continue; }
    const candidate = best[0];
    if (!candidates.has(candidate.filename)) candidates.set(candidate.filename, await fingerprint(candidate.filename));
    replacements.set(item.reference, { ...candidates.get(candidate.filename), filename: candidate.filename });
    rows.push({ reference: item.reference, status: 'matched', file: candidate.parts.join('/') });
  }
  return { rows, replacements };
}

async function stageModel(owner, asset, replacements, stage) {
  const original = owner.getModelBundleDirectory(asset.id);
  const destination = path.join(stage, '原有模型');
  const bundle = asset.modelBundle;
  const files = [];
  for (const file of bundle.files) {
    const source = path.join(original, ...file.path.split('/'));
    if (pathKey(await fs.realpath(source)) !== pathKey(source)) throw new Error('模型包包含无效的资源路径');
    files.push({ ...file, relative: file.path, source });
  }
  await copyModelBundle({ ...bundle, files }, destination);
  return collectModelBundle(path.join(destination, ...bundle.entry.split('/')), {
    allowedRoots: [stage], repair: { root: stage, replacements }
  });
}

function createBundleRepair({ cacheDir, prepareProject, currentLibrary }) {
  const plans = new Map();
  function readAsset(owner, id) {
    const asset = owner.snapshot().assets.find(item => item.id === id);
    if (!asset || asset.trashedAt || !manifestOf(asset)?.missing?.length) throw new Error('当前素材没有可补齐的缺失资源');
    return asset;
  }
  async function plan(owner, id, directory) {
    if (owner !== currentLibrary()) throw new Error('素材库已切换，请重新查找');
    const asset = readAsset(owner, id);
    const { rows, replacements } = await planMatches(asset, directory);
    if (owner !== currentLibrary()) throw new Error('素材库已切换，请重新查找');
    const token = randomUUID();
    plans.set(token, { owner, id, hash: asset.hash, replacements });
    if (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value);
    return { token, rows, matches: replacements.size };
  }
  async function apply(owner, id, token) {
    const selected = plans.get(token);
    if (!selected || selected.owner !== owner || selected.id !== id || owner !== currentLibrary()) throw new Error('匹配结果已失效，请重新查找');
    if (!selected.replacements.size) throw new Error('当前目录中没有可补入的资源');
    const asset = readAsset(owner, id);
    if (asset.hash !== selected.hash) throw new Error('素材包已变化，请重新查找');
    plans.delete(token);
    for (const match of selected.replacements.values()) {
      const current = await fingerprint(match.filename);
      if (current.hash !== match.hash || current.size !== match.size) throw new Error('匹配文件已变化，请重新查找');
    }
    let work, projectPlan;
    try {
      let prepared;
      if (asset.projectBundle) {
        projectPlan = await prepareProject(owner.getAssetPath(id), selected.replacements);
        prepared = { projectPlan };
      } else {
        await fs.mkdir(cacheDir, { recursive: true });
        work = await fs.mkdtemp(path.join(cacheDir, 'repair-'));
        prepared = { modelPlan: await stageModel(owner, asset, selected.replacements, work) };
      }
      const missing = new Set(prepared.projectPlan?.manifest.missing || prepared.modelPlan.missing).size;
      const next = new Set((prepared.projectPlan?.manifest || prepared.modelPlan).missing.map(pathKey));
      const repaired = [...selected.replacements.keys()].filter(reference => !next.has(pathKey(reference))).length;
      if (!repaired) throw new Error('未能补入已匹配的资源，请在原软件中核对引用');
      if (owner !== currentLibrary()) throw new Error('素材库已切换，补齐结果未保存');
      const snapshot = await owner.repairBundle(id, { expectedHash: selected.hash, ...prepared });
      return { snapshot, repaired, missing };
    } finally {
      if (projectPlan) await projectPlan.cleanup().catch(() => {});
      if (work && path.dirname(work) === cacheDir) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { plan, apply, cancel: token => plans.delete(token) };
}

module.exports = { createBundleRepair, planMatches };
