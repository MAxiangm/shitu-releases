const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const manifest = require('./ai-runtime-manifest.json');

const toolIds = new Set(['ai-upscale', 'ai-cutout']);
const cutoutBytes = manifest.python.size + manifest.vclibs.size + manifest.u2net.size + manifest.wheels.reduce((sum, item) => sum + item.size, 0);
const abortError = () => Object.assign(new Error('操作已取消'), { code: 'ABORT_ERR' });
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
function run(file, args, { cwd, signal, onOutput, maxBytes = 2 * 1024 * 1024 } = {}) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (type, chunk) => {
      const data = chunk.toString('utf8');
      if (type === 'stdout') stdout = (stdout + data).slice(-maxBytes);
      else stderr = (stderr + data).slice(-maxBytes);
      onOutput?.(type, data);
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(abortError());
      if (code !== 0) return reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `处理程序退出：${code}`), { stdout, stderr, exitCode: code }));
      resolve({ stdout, stderr });
    });
  });
}
async function extract(archive, destination, signal) {
  await fs.mkdir(destination, { recursive: true });
  // Parameters are environment values, never interpolated PowerShell source.
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory([System.Environment]::GetEnvironmentVariable('SHITU_ARCHIVE'), [System.Environment]::GetEnvironmentVariable('SHITU_DESTINATION'))`;
  checkAbort(signal);
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, SHITU_ARCHIVE: archive, SHITU_DESTINATION: destination }
    });
    let errors = '';
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', data => { errors += data.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(abortError());
      code === 0 ? resolve() : reject(new Error(`解压 AI 组件失败：${errors.trim()}`));
    });
  });
}

function createAiEngine({ rootDir, onProgress: globalProgress, bundledRoot = path.join(__dirname, '..', 'ai-runtime') } = {}) {
  if (!rootDir || !path.isAbsolute(rootDir)) throw new Error('AI 资源目录必须是绝对路径');
  const root = path.resolve(rootDir);
  const bundled = bundledRoot ? path.resolve(bundledRoot) : null;
  const cacheDir = path.join(root, 'downloads');
  const locks = new Map();
  const emit = (callback, value) => { globalProgress?.(value); if (callback !== globalProgress) callback?.(value); };
  const home = id => path.join(root, id === 'ai-upscale' ? 'upscale' : 'cutout');
  const bundleHome = id => bundled && path.join(bundled, id === 'ai-upscale' ? 'upscale' : 'cutout');
  const marker = id => path.join(home(id), 'installed.json');
  const python = () => path.join(home('ai-cutout'), 'python', 'python.exe');
  function validateId(id) { if (!toolIds.has(id)) throw new Error('未知 AI 插件'); }

  async function download(asset, { signal, onProgress, base, weight, toolId }) {
    checkAbort(signal);
    await fs.mkdir(cacheDir, { recursive: true });
    const target = path.join(cacheDir, asset.filename);
    if (await exists(target) && (await fs.stat(target)).size === asset.size && await hashFile(target) === asset.sha256) return target;
    const partial = target + '.part';
    await fs.rm(partial, { force: true });
    let pending = false;
    const ticker = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const loaded = (await fs.stat(partial)).size;
        emit(onProgress, { toolId, phase: 'download', progress: base + Math.min(1, loaded / asset.size) * weight,
          loadedBytes: loaded, totalBytes: asset.size, message: `正在下载 ${asset.filename}` });
      } catch {} finally { pending = false; }
    }, 350);
    try {
      // Windows 10+ ships curl. It observes normal proxy environment settings.
      await run('curl.exe', ['--silent', '--show-error', '--location', '--fail', '--retry', '2', '--connect-timeout', '30', '--max-time', '1200', '--output', partial, asset.url], { signal });
      checkAbort(signal);
      const size = (await fs.stat(partial)).size;
      if (size !== asset.size || await hashFile(partial) !== asset.sha256) throw new Error(`AI 组件完整性校验失败：${asset.filename}，请重试安装`);
      await fs.rm(target, { force: true });
      await fs.rename(partial, target);
      return target;
    } catch (error) {
      await fs.rm(partial, { force: true }).catch(() => {});
      if (error.code === 'ABORT_ERR') throw error;
      throw new Error(`下载 ${asset.filename} 失败。请检查网络后重试。${error.message.slice(0, 240)}`);
    } finally { clearInterval(ticker); }
  }

  async function runPython(request, { signal, onProgress, executable = python() } = {}) {
    const workDir = request.workDir || path.join(root, 'jobs', crypto.randomUUID());
    await fs.mkdir(workDir, { recursive: true });
    const requestPath = path.join(workDir, 'request.json');
    await fs.writeFile(requestPath, JSON.stringify({ ...request, workDir }), 'utf8');
    let buffer = '', result, pythonError;
    try {
      await run(executable, [path.join(__dirname, 'ai-cutout-worker.py'), requestPath], {
        signal, onOutput(type, chunk) {
          if (type !== 'stdout') return;
          buffer += chunk;
          const lines = buffer.split(/\r?\n/); buffer = lines.pop();
          for (const line of lines) {
            let value; try { value = JSON.parse(line); } catch { continue; }
            if (value.type === 'result') result = value.result;
            if (value.type === 'error') pythonError = value.message;
            if (value.type === 'progress') emit(onProgress, { toolId: 'ai-cutout', ...value });
          }
        }
      });
      if (!result) throw new Error(pythonError || 'AI 处理未返回结果');
      return result;
    } catch (error) {
      if (error.code === 'ABORT_ERR') throw error;
      throw new Error(pythonError || error.message);
    } finally {
      // workDir is always generated internally; no user files live here.
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function validResources(directory, id, { hashes = false, signal } = {}) {
    for (const resource of manifest.installed[id]) {
      checkAbort(signal);
      const file = path.join(directory, resource.path);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile() || stat.size !== resource.size) return false;
      if (hashes && await hashFile(file) !== resource.sha256) return false;
    }
    return true;
  }
  async function readMarker(id, directory = home(id), options = {}) {
    try {
      if (!directory) return null;
      const data = JSON.parse(await fs.readFile(path.join(directory, 'installed.json'), 'utf8'));
      if (data.version !== manifest.version) return null;
      return await validResources(directory, id, options) ? data : null;
    } catch (error) { if (error.code === 'ABORT_ERR') throw error; return null; }
  }
  async function status() {
    const upscale = await readMarker('ai-upscale'), cutout = await readMarker('ai-cutout');
    const bundledUpscale = Boolean(await readMarker('ai-upscale', bundleHome('ai-upscale')));
    const bundledCutout = Boolean(await readMarker('ai-cutout', bundleHome('ai-cutout')));
    return { tools: {
      'ai-upscale': { ready: Boolean(upscale), engine: 'Real-ESRGAN / NCNN', provider: 'Vulkan', gpuRequired: true,
        bundled: bundledUpscale, downloadBytes: bundledUpscale ? 0 : manifest.upscale.size, devices: upscale?.devices || [] },
      'ai-cutout': { ready: Boolean(cutout), engine: 'U²-Net / ONNX Runtime', provider: 'DirectML / CPU', gpuRequired: false,
        bundled: bundledCutout, downloadBytes: bundledCutout ? 0 : cutoutBytes, devices: cutout?.devices || [], providers: cutout?.providers || [] }
    }, devices: cutout?.devices?.length ? cutout.devices : upscale?.devices || [] };
  }
  async function copyBundle(source, destination, id, { signal, onProgress }) {
    const files = [];
    async function visit(directory, relative = '') {
      checkAbort(signal);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name === '__pycache__' || entry.name === 'installed.json') continue;
        const name = path.join(relative, entry.name);
        if (entry.isSymbolicLink()) throw new Error('内置 AI 组件包含不支持的符号链接');
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
        else if (entry.isFile()) files.push({ name, size: (await fs.stat(path.join(directory, entry.name))).size });
      }
    }
    await visit(source);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let copied = 0, count = 0;
    for (const file of files) {
      checkAbort(signal);
      const target = path.join(destination, file.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(source, file.name), target);
      copied += file.size;
      if (++count % 40 === 0 || file.size > 1024 * 1024 || copied === total) {
        emit(onProgress, { toolId: id, phase: 'install', progress: 0.05 + (copied / Math.max(1, total)) * 0.8,
          loadedBytes: copied, totalBytes: total, message: '正在安装内置 AI 组件，无需下载' });
      }
    }
    checkAbort(signal);
  }
  async function finishInstall(staging, id, options, source) {
    const { signal, onProgress } = options;
    checkAbort(signal);
    if (!await validResources(staging, id, { hashes: true, signal })) throw new Error('AI 组件完整性校验失败，请重新安装');
    await fs.copyFile(path.join(__dirname, 'AI_THIRD_PARTY_NOTICES.md'), path.join(staging, 'AI_THIRD_PARTY_NOTICES.md'));
    await fs.cp(path.join(__dirname, 'ai-licenses'), path.join(staging, 'ai-licenses'), { recursive: true });
    checkAbort(signal);
    let extra = {};
    if (id === 'ai-cutout') {
      emit(onProgress, { toolId: id, phase: 'install', progress: 0.93, message: '正在检测本机计算设备' });
      extra = await runPython({ action: 'probe' }, { ...options, executable: path.join(staging, 'python', 'python.exe') });
    }
    checkAbort(signal);
    // Write a new marker only after this computer has validated/probed the copy.
    await fs.writeFile(path.join(staging, 'installed.json'), JSON.stringify({ version: manifest.version,
      installedAt: new Date().toISOString(), source, ...extra }, null, 2));
    await fs.rm(home(id), { recursive: true, force: true });
    await fs.rename(staging, home(id));
    emit(onProgress, { toolId: id, phase: 'ready', progress: 1, message: '安装完成' });
    return (await status()).tools[id];
  }
  async function install(id, options) {
    const { signal, onProgress } = options;
    checkAbort(signal);
    if (await readMarker(id)) return (await status()).tools[id];
    await fs.mkdir(root, { recursive: true });
    const staging = path.join(root, `.install-${id}-${crypto.randomUUID()}`);
    const assets = id === 'ai-upscale' ? [manifest.upscale] : [manifest.python, ...manifest.wheels, manifest.vclibs, manifest.u2net];
    const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
    let completeBytes = 0;
    const files = [];
    try {
      if (bundled && bundled !== root && await readMarker(id, bundleHome(id), { hashes: true, signal })) {
        await copyBundle(bundleHome(id), staging, id, options);
        return await finishInstall(staging, id, options, 'bundled');
      }
      for (const asset of assets) {
        files.push(await download(asset, { ...options, toolId: id, base: completeBytes / totalBytes * 0.85, weight: asset.size / totalBytes * 0.85 }));
        completeBytes += asset.size;
      }
      emit(onProgress, { toolId: id, phase: 'install', progress: 0.86, message: '正在安装本地 AI 组件' });
      if (id === 'ai-upscale') {
        await extract(files[0], staging, signal);
      } else {
        await fs.mkdir(staging, { recursive: true });
        const pythonDir = path.join(staging, 'python');
        await extract(files[0], pythonDir, signal);
        const siteDir = path.join(pythonDir, 'Lib', 'site-packages');
        await fs.mkdir(siteDir, { recursive: true });
        // Wheel archives are zip files. Separate extraction avoids untrusted pip execution.
        for (let index = 0; index < manifest.wheels.length; index++) await extract(files[index + 1], siteDir, signal);
        const vcDir = path.join(staging, 'vc-runtime');
        await extract(files.at(-2), vcDir, signal);
        for (const name of await fs.readdir(vcDir)) {
          if (/^(msvcp140.*|vcruntime140.*|concrt140)\.dll$/i.test(name)) await fs.copyFile(path.join(vcDir, name), path.join(pythonDir, name));
        }
        await fs.writeFile(path.join(pythonDir, 'python312._pth'), 'python312.zip\n.\nLib\\site-packages\nimport site\n');
        await fs.copyFile(files.at(-1), path.join(staging, 'u2net.onnx'));
      }
      return await finishInstall(staging, id, options, 'download');
    } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }
  async function ensureReady(id, options = {}) {
    validateId(id);
    if (locks.has(id)) return locks.get(id);
    const operation = install(id, options).finally(() => locks.delete(id));
    locks.set(id, operation);
    return operation;
  }
  async function processImage({ toolId, inputPath, outputPath, options = {}, signal, onProgress }) {
    validateId(toolId);
    checkAbort(signal);
    if (!path.isAbsolute(inputPath) || !path.isAbsolute(outputPath)) throw new Error('图片路径必须是绝对路径');
    if (path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase()) throw new Error('AI 结果不能覆盖原图');
    if (await exists(outputPath)) throw new Error('结果文件已经存在，请选择另一个路径');
    const device = options.device || options.accelerator || 'auto';
    if (!['auto', 'gpu', 'cpu'].includes(device)) throw new Error('未知计算设备');
    if (toolId === 'ai-upscale' && device === 'cpu') throw new Error('AI 放大使用 Vulkan GPU 引擎，不支持 CPU 模式；请选择自动或 GPU');
    await ensureReady(toolId, { signal, onProgress });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    try {
      if (toolId === 'ai-cutout') {
        return await runPython({ action: 'cutout', inputPath, outputPath, device, modelPath: path.join(home(toolId), 'u2net.onnx') }, { signal, onProgress });
      }
      const requestedScale = Number(options.scale ?? 2);
      if (![2, 4].includes(requestedScale)) throw new Error('AI 放大仅支持 2 倍或 4 倍');
      const start = Date.now();
      const result = await run(path.join(home(toolId), 'realesrgan-ncnn-vulkan.exe'),
        ['-i', inputPath, '-o', outputPath, '-n', 'realesrgan-x4plus', '-s', '4', '-t', '128', '-m', path.join(home(toolId), 'models'), '-j', '1:1:1'], {
          signal, onOutput(type, chunk) {
            if (type !== 'stderr') return;
            const values = [...chunk.matchAll(/(\d+(?:\.\d+)?)%/g)];
            if (values.length) emit(onProgress, { toolId, phase: 'process', progress: Number(values.at(-1)[1]) / 100, message: 'GPU 正在放大图片' });
          }
        });
      const bytes = await fs.readFile(outputPath);
      if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error('AI 放大未生成有效图片');
      const deviceNames = [...result.stderr.matchAll(/\[\d+ ([^\]]+)\]/g)].map(match => match[1]);
      if (!deviceNames.length) throw new Error('未确认 Vulkan GPU，AI 放大失败');
      const installed = await readMarker(toolId);
      if (installed) {
        installed.devices = [...new Set(deviceNames)].map((name, id) => ({ id, name, provider: 'Vulkan', software: false }));
        await fs.writeFile(marker(toolId), JSON.stringify(installed, null, 2));
      }
      return { outputPath, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
        actualScale: 4, requestedScale, engine: 'Real-ESRGAN / NCNN', provider: 'Vulkan', accelerator: 'gpu',
        device: [...new Set(deviceNames)].join(', '), elapsedMs: Date.now() - start,
        diagnostics: { gpuLog: result.stderr.slice(0, 2000) } };
    } catch (error) {
      await fs.rm(outputPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  async function uninstall(id) {
    validateId(id);
    if (locks.has(id)) throw new Error('插件正在安装，请稍后重试');
    await fs.rm(home(id), { recursive: true, force: true });
    const assets = id === 'ai-upscale' ? [manifest.upscale] : [manifest.python, ...manifest.wheels, manifest.vclibs, manifest.u2net];
    for (const asset of assets) await fs.rm(path.join(cacheDir, asset.filename), { force: true });
  }
  return { status, ensureReady, process: processImage, uninstall };
}

module.exports = { createAiEngine, manifest };
