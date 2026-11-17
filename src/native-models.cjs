'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { validateModelBundle, modelBundleHash, isSafeBundlePath } = require('./model-bundle.cjs');

const TOOLS = {
  blend: { name: 'Blender', variable: 'SHITU_BLENDER', executable: 'blender.exe', script: 'blender.py', output: 'glb' },
  c4d: { name: 'Cinema 4D', variable: 'SHITU_C4DPY', executable: 'c4dpy.exe', script: 'c4d.py', output: 'fbx' },
  max: { name: '3ds Max', variable: 'SHITU_3DSMAXBATCH', executable: '3dsmaxbatch.exe', script: 'max.ms', output: 'fbx' }
};
const scripts = path.join(__dirname, 'native-model-scripts');
const aborted = () => Object.assign(new Error('模型转换已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
function check(signal) { if (signal?.aborted) throw aborted(); }
function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function digest(filename, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) { check(signal); hash.update(chunk); }
  return hash.digest('hex');
}
async function regular(filename) {
  try { const info = await fs.lstat(filename); return info.isFile() && !info.isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}
async function directories(parent, pattern) {
  try { return (await fs.readdir(parent, { withFileTypes: true })).filter(item => item.isDirectory() && pattern.test(item.name))
    .sort((a, b) => {
      const left = a.name.match(/\d+/g)?.map(Number) || [], right = b.name.match(/\d+/g)?.map(Number) || [];
      for (let index = 0; index < Math.max(left.length, right.length); index++) if ((left[index] || 0) !== (right[index] || 0)) return (right[index] || 0) - (left[index] || 0);
      return b.name.localeCompare(a.name);
    }).map(item => path.join(parent, item.name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function findNativeTool(format) {
  const config = TOOLS[format];
  if (!config) throw new Error('此格式不需要原生模型转换器');
  if (process.env[config.variable]) {
    const supplied = process.env[config.variable];
    if (!path.isAbsolute(supplied) || !await regular(supplied)) throw new Error(`${config.variable} 不是可用的程序绝对路径`);
    return supplied;
  }
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const roots = format === 'blend' ? await directories(path.join(programFiles, 'Blender Foundation'), /^Blender /i) :
    format === 'c4d' ? await directories(programFiles, /^Maxon Cinema 4D /i) : await directories(path.join(programFiles, 'Autodesk'), /^3ds Max /i);
  for (const root of roots) {
    const executable = path.join(root, config.executable);
    if (await regular(executable)) return executable;
  }
  return null;
}
async function detectNativeModelTools() {
  return Promise.all(Object.entries(TOOLS).map(async ([format, config]) => {
    try { const executable = await findNativeTool(format); return { format, name: config.name, available: Boolean(executable), executable }; }
    catch (error) { return { format, name: config.name, available: false, error: error.message }; }
  }));
}
function runNativeProcess(executable, args, { cwd, env, signal, timeoutMs = 180000 } = {}) {
  check(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failure, stopping = false;
    const stop = error => {
      if (stopping || child.exitCode !== null || child.signalCode !== null) return;
      stopping = true; failure = error;
      if (process.platform === 'win32' && child.pid) {
        // Only the process tree created for this exact conversion is stopped.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    const abort = () => stop(aborted());
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error('原生模型转换超时，请确认对应软件可在本机正常运行，或先导出 GLB/FBX 预览')), timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const receiveText = text => {
      output = (output + text.replace(/^\ufeff/, '')).slice(-16384);
      if (/(?:license error|no licen[cs]e (?:found|model defined)|error running authentication|enter the license method|could not obtain[^\r\n]*licen[cs]e|unable to acquire[^\r\n]*licen[cs]e|licen[cs]e[^\r\n]*(?:invalid|missing|unavailable))/i.test(output))
        stop(new Error('原软件许可证不可用，请先在原软件中处理许可证后重试，或导出 GLB/FBX 后导入'));
    };
    const receiver = () => {
      let decoder;
      return chunk => {
        if (!decoder) {
          const sample = chunk.subarray(0, 64);
          decoder = new StringDecoder((sample[0] === 0xff && sample[1] === 0xfe) || [...sample].filter(value => value === 0).length > sample.length / 4 ? 'utf16le' : 'utf8');
        }
        receiveText(decoder.write(chunk));
      };
    };
    child.stdout.on('data', receiver());
    child.stderr.on('data', receiver());
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (failure) {
        if (failure.name !== 'AbortError' && output.trim()) failure.diagnostics = output;
        return reject(failure);
      }
      if (signal?.aborted) return reject(aborted());
      if (code !== 0) return reject(Object.assign(new Error(`原软件未完成模型转换（退出码 ${code}）。请确认软件与许可证可用，或从原软件导出 GLB/FBX。`), { diagnostics: output }));
      resolve(output);
    });
  });
}
async function outputFiles(directory, signal) {
  const files = [];
  async function walk(current, relative = '') {
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      check(signal);
      if (item.isSymbolicLink()) throw new Error('转换输出包含不允许的符号链接');
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (!isSafeBundlePath(name)) throw new Error('转换输出文件名无效');
      const source = path.join(current, item.name);
      if (item.isDirectory()) await walk(source, name);
      else if (item.isFile()) {
        if (files.length >= 4096) throw new Error('转换输出文件过多');
        files.push({ path: name, source, size: (await fs.stat(source)).size, hash: await digest(source, signal) });
      }
    }
  }
  await walk(directory);
  return files;
}
async function renameOutput(source, destination, signal) {
  for (let attempt = 0; ; attempt++) {
    check(signal);
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function createNativeModelConverter({ cacheDir, timeoutMs = 180000, toolLocator = findNativeTool, launch = runNativeProcess } = {}) {
  if (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir)) throw new Error('原生模型缓存必须为绝对路径');
  cacheDir = path.resolve(cacheDir);
  let closed = false;
  const controllers = new Set(), tasks = new Set(), jobs = new Map();
  async function convert({ source, format, bundleDirectory, manifest }, signal) {
    const config = TOOLS[format];
    if (!config || typeof source !== 'string' || !path.isAbsolute(source) || typeof bundleDirectory !== 'string' || !path.isAbsolute(bundleDirectory)) throw new Error('原生模型转换请求无效');
    validateModelBundle(manifest);
    bundleDirectory = path.resolve(bundleDirectory); source = path.resolve(source);
    if (path.resolve(bundleDirectory, ...manifest.entry.split('/')) !== source || path.extname(source).slice(1).toLowerCase() !== format || !within(bundleDirectory, source)) throw new Error('原生模型入口不在资源包内');
    for (const file of manifest.files) {
      const filename = path.join(bundleDirectory, ...file.path.split('/'));
      if (!await regular(filename) || !within(await fs.realpath(bundleDirectory), await fs.realpath(filename)) || (await fs.stat(filename)).size !== file.size || await digest(filename, signal) !== file.hash) throw new Error('模型包文件已变化或缺失，请重新导入');
    }
    const executable = await toolLocator(format);
    if (!executable) throw new Error(`此 ${format.toUpperCase()} 工程需要本机安装并能正常运行的 ${config.name} 才能生成预览，也可将同名 GLB/FBX 与工程一起导入。原工程和已收集贴图已保留。`);
    check(signal);
    const toolInfo = await fs.stat(executable);
    const script = path.join(scripts, config.script);
    const scriptHash = await digest(script, signal);
    const additionalScriptHash = format === 'max' ? await digest(path.join(scripts, 'max.py'), signal) : '';
    const identity = crypto.createHash('sha256').update(JSON.stringify([1, format, manifest.hash || modelBundleHash(manifest.files, manifest.entry), executable, toolInfo.size, toolInfo.mtimeMs, scriptHash, additionalScriptHash])).digest('hex');
    const directory = path.join(cacheDir, `native-v1-${identity}`), recordPath = path.join(directory, 'shitu-native-cache.json');
    try {
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      if (record.version !== 1 || record.identity !== identity || record.format !== config.output || !isSafeBundlePath(record.entry) || !Array.isArray(record.files) || !record.files.length || record.files.length > 4096) throw new Error('Invalid native cache');
      const files = [];
      for (const file of record.files) {
        if (!isSafeBundlePath(file.path) || !/^[a-f0-9]{64}$/.test(file.hash || '')) throw new Error('Invalid native cache path');
        const filename = path.join(directory, 'out', ...file.path.split('/'));
        if (!await regular(filename) || !within(directory, await fs.realpath(filename)) || (await fs.stat(filename)).size !== file.size || await digest(filename, signal) !== file.hash) throw new Error('Invalid native cache bytes');
        files.push({ path: file.path, source: filename });
      }
      if (!files.some(file => file.path === record.entry) || !Array.isArray(record.warnings) || record.warnings.some(value => typeof value !== 'string')) throw new Error('Invalid native cache entry');
      return { entry: record.entry, format: record.format, files, warnings: record.warnings, cached: true };
    } catch (error) { check(signal); }
    await fs.mkdir(cacheDir, { recursive: true });
    const work = await fs.mkdtemp(path.join(cacheDir, '.native-task-'));
    try {
      const out = path.join(work, 'out'); await fs.mkdir(out);
      const output = path.join(out, `preview.${config.output}`), resultPath = path.join(work, 'script-result.json');
      const job = { version: 1, source, bundleDirectory, manifest, output, resultPath };
      const jobPath = path.join(work, 'job.json'); await fs.writeFile(jobPath, JSON.stringify(job));
      const env = { ...process.env, SHITU_MODEL_JOB: jobPath };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = format === 'blend' ? ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '6', '--python', script, '--', jobPath] :
        format === 'max' ? [script, '-safescene', 'ON'] : [script, jobPath];
      await launch(executable, args, { cwd: bundleDirectory, env, signal, timeoutMs });
      check(signal);
      const result = JSON.parse(await fs.readFile(resultPath, 'utf8').catch(() => '{"ok":false}'));
      if (!result.ok) throw Object.assign(new Error(`原软件未生成预览：${String(result.error || '请检查软件版本、许可证与工程是否完整').slice(0, 400)}`), { diagnostics: String(result.error || '') });
      if (!await regular(output) || (await fs.stat(output)).size < 20) throw new Error('原软件生成的模型预览无效');
      const files = await outputFiles(out, signal);
      const record = { version: 1, identity, entry: `preview.${config.output}`, format: config.output,
        files: files.map(({ path: filename, size, hash }) => ({ path: filename, size, hash })), warnings: (result.warnings || []).filter(value => typeof value === 'string').map(value => value.slice(0, 4096)).slice(0, 100) };
      await fs.writeFile(path.join(work, 'shitu-native-cache.json'), JSON.stringify(record));
      check(signal);
      // The stable key is produced only by this converter; replacement clears a
      // corrupt cached conversion and never touches model originals.
      await fs.rm(directory, { recursive: true, force: true });
      await renameOutput(work, directory, signal);
      return { entry: record.entry, format: record.format, files: files.map(file => ({ path: file.path, source: path.join(directory, 'out', ...file.path.split('/')) })), warnings: record.warnings, cached: false };
    } catch (error) {
      if (error.name !== 'AbortError' && error.diagnostics) {
        const logs = path.join(cacheDir, 'diagnostics');
        await fs.mkdir(logs, { recursive: true }).then(async () => {
          error.logPath = path.join(logs, `${format}-${crypto.randomUUID()}.log`);
          await fs.writeFile(error.logPath, `${error.message}\n\n${String(error.diagnostics).slice(-16384)}\n`);
        }).catch(() => {});
      }
      throw error;
    } finally { if (within(cacheDir, work) && work !== cacheDir) await fs.rm(work, { recursive: true, force: true }).catch(() => {}); }
  }
  function subscribe(job, signal) {
    const token = {}; job.consumers.add(token);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return; settled = true;
        signal?.removeEventListener('abort', cancel); job.consumers.delete(token);
        if (!job.settled && job.consumers.size === 0) job.controller.abort();
        handler(value);
      };
      const cancel = () => finish(reject, aborted());
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      job.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  function preview(request) {
    if (closed) return Promise.reject(new Error('原生模型转换器已关闭'));
    const signal = request?.signal;
    try { check(signal); } catch (error) { return Promise.reject(error); }
    const identity = `${request?.bundleDirectory}\0${request?.manifest?.hash}\0${request?.format}`;
    let job = jobs.get(identity);
    if (!job || job.controller.signal.aborted || job.settled) {
      const controller = new AbortController(); controllers.add(controller);
      job = { controller, consumers: new Set(), settled: false, promise: null };
      job.promise = Promise.resolve().then(() => convert(request, controller.signal)).finally(() => {
        job.settled = true; controllers.delete(controller); tasks.delete(job.promise);
        if (jobs.get(identity) === job) jobs.delete(identity);
      });
      jobs.set(identity, job); tasks.add(job.promise);
    }
    return subscribe(job, signal);
  }
  async function shutdown() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...tasks]); }
  return { preview, shutdown };
}

module.exports = { createNativeModelConverter, detectNativeModelTools, findNativeTool, runNativeProcess };
