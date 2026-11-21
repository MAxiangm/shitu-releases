'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const ENGINE = 'Windows OCR';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const abortError = () => Object.assign(new Error('文字提取已取消'), { name: 'AbortError', code: 'ABORT_ERR' });

function createOcrEngine({ spawnProcess = spawn, platform = process.platform, timeoutMs = 90_000, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
  let statusPromise;
  let statusTime = 0;

  function invoke(mode, { inputPath, language = 'auto', signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (platform !== 'win32') return Promise.reject(new Error('本地文字提取需要 Windows 10 或更新版本'));
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let settled = false;
      let byteCount = 0;
      const stdout = [];
      const stderr = [];
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const stop = error => { try { child?.kill(); } catch {} finish(error); };
      const abort = () => stop(abortError());
      try {
        // Parameters are environment values, never PowerShell source or shell arguments.
        child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native', 'image-ocr.ps1')], {
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, SHITU_OCR_MODE: mode, SHITU_OCR_IMAGE: inputPath || '', SHITU_OCR_LANGUAGE: language }
        });
      } catch (error) { finish(new Error(`无法启动本地文字提取：${error.message}`)); return; }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => stop(new Error('文字提取超时，请缩小图片后重试')), timeoutMs);
      const collect = (target, chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += buffer.length;
        if (byteCount > maxOutputBytes) { stop(new Error('文字提取结果过大，请分批或裁切图片后重试')); return; }
        target.push(buffer);
      };
      child.stdout.on('data', chunk => collect(stdout, chunk));
      child.stderr.on('data', chunk => collect(stderr, chunk));
      child.once('error', error => finish(new Error(`无法启动本地文字提取：${error.message}`)));
      child.once('close', code => {
        if (settled) return;
        if (signal?.aborted) { finish(abortError()); return; }
        const output = Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '').trim();
        let result;
        try { result = JSON.parse(output); }
        catch { finish(new Error(`本地文字提取未返回有效结果${code === 0 ? '' : '，请检查 Windows 文字识别组件'}`)); return; }
        if (code !== 0 || result?.ok !== true) {
          const errors = {
            NO_LANGUAGE: 'Windows 尚未安装文字识别语言，请在系统“语言和区域”中安装所需语言的“光学字符识别”组件后重试',
            UNSUPPORTED_LANGUAGE: '所选识别语言尚未安装，请选择可用语言或在 Windows 语言设置中添加',
            IMAGE_TOO_LARGE: '图片超过 1 亿像素，请缩小或裁切后提取文字',
            INVALID_IMAGE: '无法读取用于文字提取的图片，请重新选择静态图片'
          };
          finish(new Error(errors[result?.code] || `本地文字提取失败：${String(result?.error || 'Windows 文字识别组件不可用').slice(0, 500)}`));
          return;
        }
        finish(null, result);
      });
    });
  }

  async function status({ refresh = false } = {}) {
    if (!statusPromise || refresh || Date.now() - statusTime > 30_000) {
      statusTime = Date.now();
      statusPromise = invoke('status').then(result => ({
        ready: Array.isArray(result.languages) && result.languages.length > 0,
        languages: Array.isArray(result.languages) ? result.languages.filter(item => typeof item?.tag === 'string').map(item => ({ tag: item.tag, name: String(item.name || item.tag) })) : [],
        engine: ENGINE,
        maxImageDimension: result.maxImageDimension,
        ...(!result.languages?.length ? { error: 'Windows 尚未安装文字识别语言，请在系统“语言和区域”中添加光学字符识别组件' } : {})
      })).catch(error => ({ ready: false, languages: [], engine: ENGINE, error: error.message }));
    }
    return structuredClone(await statusPromise);
  }

  async function recognize({ inputPath, language = 'auto', signal } = {}) {
    if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath) || inputPath.includes('\0')) throw new Error('文字提取图片路径无效');
    if (typeof language !== 'string' || !/^(?:auto|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)$/.test(language)) throw new Error('文字提取语言无效');
    const started = Date.now();
    const result = await invoke('recognize', { inputPath: path.resolve(inputPath), language, signal });
    if (typeof result.text !== 'string' || typeof result.language !== 'string') throw new Error('本地文字提取返回的数据不完整');
    // Windows emits spaces between individual CJK words. Keep Latin word spacing,
    // while making contiguous Chinese text directly usable when copied.
    const text = result.text.replace(/\r\n?/g, '\n').replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '');
    return { text, language: result.language, engine: ENGINE, width: result.width, height: result.height, scaled: result.scaled === true, elapsedMs: Date.now() - started };
  }

  return { status, recognize };
}

module.exports = { createOcrEngine };
