'use strict';
const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { projectBundleHash, validateProjectBundle } = require('./project-bundle.cjs');
const { collectModelBundle, MODEL_EXTENSIONS, isSafeBundlePath } = require('./model-bundle.cjs');

const SCRIPT = path.join(__dirname, 'ae-scripts', 'collect.jsx');
const SEQUENCE_IMAGES = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'exr', 'dpx', 'cin', 'iff', 'pic', 'rla', 'rpf', 'sgi', 'tga', 'bmp', 'psd', 'ai', 'eps']);
const MAX_FILES = 100000;
function abortError() { return Object.assign(new Error('AE 工程收集已取消'), { name: 'AbortError', code: 'ABORT_ERR' }); }
function check(signal) { if (signal?.aborted) throw abortError(); }
function normalized(filename) { return path.resolve(filename).toLowerCase(); }
function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function digest(filename, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) { check(signal); hash.update(chunk); }
  return hash.digest('hex');
}
async function regular(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || normalized(await fs.realpath(filename)) !== normalized(filename)) throw new Error(`AE 素材路径不是普通文件：${path.basename(filename)}`);
  return info;
}
function safeFilename(filename) {
  let value = String(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  return value;
}
async function listAfterEffectsTools() {
  const parent = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Adobe');
  const tools = [];
  const supplied = process.env.SHITU_AFTERFX;
  if (supplied) {
    if (!path.isAbsolute(supplied)) throw new Error('SHITU_AFTERFX 必须是程序绝对路径');
    await regular(supplied);
    tools.push({ executable: supplied, year: Number(/After Effects (20\d{2})/i.exec(supplied)?.[1]) || 0, supplied: true });
  }
  for (const entry of await fs.readdir(parent, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    const year = Number(/^Adobe After Effects (20\d{2})/i.exec(entry.name)?.[1]);
    if (!year || !entry.isDirectory()) continue;
    const executable = path.join(parent, entry.name, 'Support Files', 'AfterFX.com');
    try { await regular(executable); } catch { continue; }
    if (!tools.some(tool => normalized(tool.executable) === normalized(executable))) tools.push({ executable, year });
  }
  return tools.sort((left, right) => Number(Boolean(right.supplied)) - Number(Boolean(left.supplied)) || left.year - right.year);
}
async function projectYear(source) {
  // AE stores XMP in both binary AEP and XML AEPX. Scan in bounded chunks rather
  // than loading a potentially large project into memory.
  const stream = createReadStream(source, { highWaterMark: 1024 * 1024 });
  let overlap = '';
  for await (const chunk of stream) {
    const text = overlap + chunk.toString('utf8');
    const match = /(?:CreatorTool>|softwareAgent>)[^<]*After Effects[^<]*?(20\d{2})/.exec(text);
    if (match) { stream.destroy(); return Number(match[1]); }
    overlap = text.slice(-512);
  }
  return null;
}
async function findAfterEffectsTool(source) {
  const tools = await listAfterEffectsTools();
  if (!tools.length) return null;
  if (tools[0].supplied) return tools[0];
  const year = await projectYear(source);
  return year ? tools.find(tool => tool.year === year) || tools.find(tool => tool.year >= year) || null : tools[0];
}
function launchAfterEffects(executable, args, { env, cwd, signal, timeoutMs = 180000 } = {}) {
  if (!args.includes('-m') || !args.includes('-noui') || !args.includes('-r')) throw new Error('AE 收集必须在独立后台实例中运行');
  check(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failure, stopped = false;
    const stop = error => {
      if (stopped || child.exitCode !== null) return;
      stopped = true; failure = error;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    const abort = () => stop(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error('AE 后台收集超时，请确认对应 AE 能正常启动并读取此工程')), timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const receive = chunk => { output = (output + chunk.toString('utf8')).slice(-32768); };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (failure) return reject(Object.assign(failure, { diagnostics: output }));
      if (signal?.aborted) return reject(abortError());
      // AE versions disagree about exitCode. The authenticated report project
      // and output files, rather than this numeric code, confirm completion.
      resolve({ code, output, pid: child.pid });
    });
  });
}
function decodeXML(value) {
  return value.replace(/&#x([0-9a-f]+);|&#(\d+);|&(lt|gt|quot|apos|amp);/gi, (_all, hex, number, named) => hex ? String.fromCodePoint(parseInt(hex, 16)) : number ? String.fromCodePoint(Number(number)) : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[named.toLowerCase()]);
}
function encodeXML(value) { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
async function readBridgeReport(filename, token) {
  const xml = await fs.readFile(filename, 'utf8');
  if (!xml.startsWith('<?xml') || !xml.includes('<AfterEffectsProject')) throw new Error('AE 未生成有效的工程收集报告');
  const prefix = `SHITU_AE_REPORT_V1:${token}:`, chunks = new Map(); let total;
  for (const match of xml.matchAll(/<(string|Comment)>([\s\S]*?)<\/\1>/g)) {
    const value = decodeXML(match[2]);
    if (!value.startsWith(prefix)) continue;
    const part = /^(\d+):(\d+):([\s\S]*)$/.exec(value.slice(prefix.length));
    if (!part || Number(part[2]) > 100000 || Number(part[1]) >= Number(part[2]) || total !== undefined && total !== Number(part[2]) || chunks.has(Number(part[1]))) throw new Error('AE 收集报告分块无效');
    total = Number(part[2]); chunks.set(Number(part[1]), part[3]);
  }
  if (!total || chunks.size !== total) throw new Error('AE 未返回完整收集报告，请确认脚本已在独立实例中执行');
  let report;
  try { report = JSON.parse(decodeURIComponent(Array.from({ length: total }, (_, index) => chunks.get(index)).join(''))); }
  catch { throw new Error('AE 收集报告无法读取'); }
  if (!report.ok) throw new Error(`AE 未完成工程收集：${String(report.error || '未知错误').slice(0, 1000)}`);
  return { xml, report };
}
async function sequenceFiles(record) {
  const filename = path.resolve(record.source), ext = path.extname(filename).slice(1).toLowerCase();
  if (record.isStill !== false || !SEQUENCE_IMAGES.has(ext)) return [filename];
  const basename = path.basename(filename, path.extname(filename)), numeric = /^(.*?)(\d+)([^\d]*)$/.exec(basename);
  const entries = await fs.readdir(path.dirname(filename), { withFileTypes: true });
  const selected = entries.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === path.extname(filename).toLowerCase() && (!numeric || (() => {
    const candidate = /^(.*?)(\d+)([^\d]*)$/.exec(path.basename(entry.name, path.extname(entry.name)));
    return candidate && candidate[1] === numeric[1] && candidate[2].length === numeric[2].length && candidate[3] === numeric[3];
  })())).map(entry => path.join(path.dirname(filename), entry.name));
  if (!selected.some(file => normalized(file) === normalized(filename))) selected.push(filename);
  return selected.sort();
}
async function scanFiles(directory, signal) {
  const result = [];
  async function walk(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      check(signal);
      if (entry.isSymbolicLink()) throw new Error('AE 工程包包含不允许的符号链接');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSafeBundlePath(name)) throw new Error('AE 工程包包含无效文件名');
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(filename, name);
      else if (entry.isFile()) { if (result.length >= MAX_FILES) throw new Error('AE 工程依赖文件数量超过上限'); result.push({ path: name, size: (await fs.stat(filename)).size, hash: await digest(filename, signal) }); }
    }
  }
  await walk(directory); return result;
}
async function safeRemove(parent, directory) {
  const absolute = path.resolve(directory);
  if (!inside(path.resolve(parent), absolute)) throw new Error('AE 临时目录范围无效');
  await fs.rm(absolute, { recursive: true, force: true });
}
function createAEProjectCollector({ cacheDir, timeoutMs = 180000, toolLocator = findAfterEffectsTool, launch = launchAfterEffects } = {}) {
  if (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir)) throw new Error('AE 工程缓存必须是绝对路径');
  cacheDir = path.resolve(cacheDir);
  const controllers = new Set(), tasks = new Set(); let closed = false;
  let queue = Promise.resolve();
  async function runBridge(tool, work, control, job, signal) {
    check(signal);
    const token = job.token;
    const script = path.join(control, 'collect.jsx'), jobPath = path.join(control, 'job.json');
    await fs.writeFile(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await fs.readFile(SCRIPT)]));
    await fs.writeFile(jobPath, JSON.stringify({ protocol: 1, ...job }));
    const env = { ...process.env, SHITU_AE_JOB: jobPath }; delete env.ELECTRON_RUN_AS_NODE;
    const executable = tool.executable || tool;
    const result = await launch(executable, ['-m', '-noui', '-r', script], { env, cwd: path.dirname(executable), signal, timeoutMs });
    check(signal);
    try { return await readBridgeReport(job.reportProject, token); }
    catch (error) {
      if (result?.output) await fs.writeFile(path.join(work, 'after-effects.log'), result.output);
      throw error;
    }
  }
  async function collect(source, signal, replacements) {
    check(signal);
    if (closed) throw new Error('AE 工程收集器已关闭');
    if (typeof source !== 'string' || !path.isAbsolute(source) || !['.aep', '.aepx'].includes(path.extname(source).toLowerCase())) throw new Error('请选择有效的 AE 工程绝对路径');
    source = path.resolve(source); await regular(source);
    const originalHash = await digest(source, signal), sourceYear = await projectYear(source), tool = await toolLocator(source);
    if (!tool) throw new Error('未找到可读取此工程版本的 After Effects，请安装对应 AE 后重试；源工程未改动');
    await fs.mkdir(cacheDir, { recursive: true });
    const work = await fs.mkdtemp(path.join(cacheDir, 'ae-collect-'));
    const control = await fs.mkdtemp(path.join(os.tmpdir(), 'shitu-ae-control-'));
    const directory = path.join(work, 'bundle'); await fs.mkdir(directory);
    const token = crypto.randomUUID();
    let handedOff = false;
    try {
      const scan = await runBridge(tool, work, control, { token, mode: 'scan', source, reportProject: path.join(work, 'scan-report.aepx') }, signal);
      if (!Array.isArray(scan.report.sources)) throw new Error('AE 工程资源清单无效');
      const missing = [], warnings = [], notes = ['字体、第三方插件、表达式动态引用及部分专用格式内部链接需在原软件中核对。'];
      if (sourceYear && tool.year && tool.year !== sourceYear) warnings.push(`源工程来自 AE ${sourceYear}，本包由 AE ${tool.year} 收集，导出需对应或更新版本打开。`);
      const sources = [source], relocations = new Map(), sequenceDirectories = new Map(), identity = [], copied = new Map();
      const sourceKey = (record, index) => `${record.itemId ?? record.itemIndex ?? index}\0${record.role}`;
      const restoredSources = new Set();
      for (const [index, record] of scan.report.sources.entries()) {
        check(signal);
        if (typeof record.source !== 'string' || !path.isAbsolute(record.source)) { missing.push(String(record.source || '未知素材')); continue; }
        const original = path.resolve(record.source);
        const replacement = record.missing ? replacements?.get(original) : null;
        if (record.missing && !replacement) { missing.push(original); continue; }
        const media = replacement?.filename || original;
        const folderHash = crypto.createHash('sha256').update(normalized(path.dirname(original))).digest('hex').slice(0, 16);
        const relativeFolder = `Footage/${folderHash}`;
        let dependentFiles;
        try { dependentFiles = await sequenceFiles({ ...record, source: media }); }
        catch (error) { if (error.code === 'ENOENT') { missing.push(original); continue; } throw error; }
        const modelExt = path.extname(original).slice(1).toLowerCase();
        if (MODEL_EXTENSIONS.has(modelExt)) {
          try {
            const modelPlan = await collectModelBundle(media);
            dependentFiles = modelPlan.files.map(file => file.source);
            for (const message of modelPlan.missing) missing.push(`模型依赖：${message}`);
            warnings.push(...modelPlan.warnings);
          } catch (error) { warnings.push(`模型内部依赖未完整解析：${path.basename(original)}`); }
        }
        for (const originalFile of dependentFiles) {
          const info = await regular(originalFile);
          const hash = await digest(originalFile, signal);
          if (replacement && normalized(originalFile) === normalized(media) &&
              (info.size !== replacement.size || hash !== replacement.hash)) throw new Error('匹配的 AE 素材在补齐期间发生变化');
          // Preserve model/sequence relative structure; never flatten two files
          // with identical basenames from different source directories.
          const childRelative = path.relative(path.dirname(media), originalFile).split(path.sep).join('/');
          if (!isSafeBundlePath(childRelative)) throw new Error(`工程引用超出可收集范围：${path.basename(originalFile)}`);
          const relative = `${relativeFolder}/${childRelative}`;
          const destination = path.join(directory, relative);
          if (copied.has(normalized(destination)) && copied.get(normalized(destination)) !== hash) throw new Error('AE 收集资源文件名冲突');
          if (!copied.has(normalized(destination))) {
            await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(originalFile, destination, constants.COPYFILE_EXCL);
            if (await digest(destination, signal) !== hash) throw new Error('AE 依赖在收集时发生变化，请重试');
            copied.set(normalized(destination), hash); sources.push(originalFile);
            identity.push({ source: normalized(originalFile), size: info.size, hash });
          }
          // A model may include the same image that AE also imports directly.
          // Model-relative texture copies must not steal the AE item's path.
          if (normalized(originalFile) === normalized(media)) {
            relocations.set(normalized(original), destination);
            if (replacement) restoredSources.add(sourceKey(record, index));
          }
          if (!relocations.has(normalized(originalFile))) relocations.set(normalized(originalFile), destination);
          if (record.isStill === false && SEQUENCE_IMAGES.has(modelExt) && normalized(originalFile) === normalized(media)) {
            // Only the AE sequence itself can authorize a folder relocation.
            // A model's one shared texture does not contain the other frames.
            sequenceDirectories.set(normalized(path.dirname(original)), path.dirname(destination));
          }
        }
        if (replacement && !restoredSources.has(sourceKey(record, index))) missing.push(original);
      }
      const entry = safeFilename(path.basename(source));
      const rewritten = scan.xml.replace(/<fileReference\b[^>]*>/g, tag => {
        const reference = /\bfullpath="([^"]*)"/.exec(tag);
        if (!reference) return tag;
        const original = decodeXML(reference[1]);
        if (!path.isAbsolute(original)) return tag;
        const mapping = /\btarget_is_folder="1"/.test(tag) ? sequenceDirectories : relocations;
        const destination = mapping.get(normalized(original));
        return destination ? tag.replace(reference[0], `fullpath="${encodeXML(destination)}"`) : tag;
      });
      const relinked = path.join(work, 'relinked.aepx'); await fs.writeFile(relinked, rewritten);
      const final = await runBridge(tool, work, control, { token, mode: 'collect', source: relinked, output: path.join(directory, entry), reportProject: path.join(work, 'collected-report.aepx') }, signal);
      if (!Array.isArray(final.report.sources) || final.report.sources.length !== scan.report.sources.length) throw new Error('AE 收集前后素材清单不一致');
      const originalSources = new Map(scan.report.sources.map((record, index) => [sourceKey(record, index), record]));
      const expected = new Set(copied.keys());
      for (const [index, record] of final.report.sources.entries()) {
        const originalRecord = originalSources.get(sourceKey(record, index));
        if (!originalRecord) throw new Error('AE 收集前后素材身份不一致');
        if (record.missing && (!originalRecord.missing || restoredSources.has(sourceKey(record, index)))) throw new Error(`AE 重定位后素材缺失：${path.basename(String(record.source || originalRecord.source))}`);
        if (!record.missing && (typeof record.source !== 'string' || !expected.has(normalized(record.source)))) throw new Error(`AE 工程素材未正确重定位：${path.basename(String(record.source))}`);
      }
      if (await digest(source, signal) !== originalHash) throw new Error('源 AE 工程在收集期间发生变化，请重试');
      const sourceIdentity = crypto.createHash('sha256').update(JSON.stringify({ source: originalHash, dependencies: identity.sort((a, b) => a.source.localeCompare(b.source)) })).digest('hex');
      const files = await scanFiles(directory, signal), manifest = { version: 1, entry, files, missing: [...new Set(missing)], warnings: [...new Set(warnings)], notes, sourceIdentity,
        compositions: final.report.compositions || [],
        collectedWithVersion: String(final.report.version || scan.report.version || tool.year || ''), size: files.reduce((sum, file) => sum + file.size, 0), hash: projectBundleHash(files, entry) };
      validateProjectBundle(manifest);
      handedOff = true;
      return { directory, manifest, sourceFiles: [...new Set(sources)], cleanup: () => safeRemove(cacheDir, work) };
    } finally {
      await safeRemove(os.tmpdir(), control).catch(() => {});
      if (!handedOff) await safeRemove(cacheDir, work).catch(() => {});
    }
  }
  function prepareProjectBundle(source, { signal, replacements } = {}) {
    if (closed) return Promise.reject(new Error('AE 工程收集器已关闭'));
    const controller = new AbortController(), cancel = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', cancel, { once: true });
    controllers.add(controller);
    const task = queue.then(() => collect(source, controller.signal, replacements)).finally(() => { controllers.delete(controller); signal?.removeEventListener('abort', cancel); tasks.delete(task); });
    queue = task.catch(() => {}); tasks.add(task); return task;
  }
  async function shutdown() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...tasks]); }
  return { prepareProjectBundle, shutdown };
}
module.exports = { createAEProjectCollector, listAfterEffectsTools, findAfterEffectsTool, projectYear, launchAfterEffects,
  readBridgeReport, sequenceFiles, scanFiles };
