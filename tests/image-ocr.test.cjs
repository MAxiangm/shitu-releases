'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createOcrEngine } = require('../src/image-ocr.cjs');

function mockProcess(onStart = () => {}) {
  const calls = [];
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kills = 0; child.kill = () => { child.kills++; };
    calls.push({ file, args, options, child });
    queueMicrotask(() => onStart(child, calls.at(-1)));
    return child;
  };
  return { calls, spawnProcess };
}
function output(child, value, code = 0) {
  child.stdout.emit('data', Buffer.from(JSON.stringify(value)));
  child.emit('close', code);
}

test('OCR passes paths as environment values and preserves UTF-8 over byte boundaries', async () => {
  const mock = mockProcess(child => {
    const data = Buffer.from(JSON.stringify({ ok: true, text: '提 取 文 字\r\nHello world', language: 'zh-Hans-CN', width: 100, height: 50, scaled: false }));
    for (let i = 0; i < data.length; i += 2) child.stdout.emit('data', data.subarray(i, i + 2));
    child.emit('close', 0);
  });
  const engine = createOcrEngine({ ...mock, platform: 'win32' });
  const inputPath = path.resolve("quoted'名字 $(never).png");
  const result = await engine.recognize({ inputPath, language: 'zh-Hans-CN' });
  assert.equal(result.text, '提取文字\nHello world');
  assert.equal(result.language, 'zh-Hans-CN');
  assert.equal(result.engine, 'Windows OCR');
  assert.equal(mock.calls[0].file, 'powershell.exe');
  assert.equal(mock.calls[0].options.shell, false);
  assert.equal(mock.calls[0].options.windowsHide, true);
  assert.equal(mock.calls[0].options.env.SHITU_OCR_IMAGE, inputPath);
  assert.equal(mock.calls[0].options.env.SHITU_OCR_LANGUAGE, 'zh-Hans-CN');
  assert.ok(!mock.calls[0].args.some(value => value.includes("quoted'")));
});

test('OCR status reports available languages and returns independent cached values', async () => {
  const mock = mockProcess(child => output(child, { ok: true, languages: [{ tag: 'en-GB', name: 'English' }], maxImageDimension: 10000 }));
  const engine = createOcrEngine({ ...mock, platform: 'win32' });
  const first = await engine.status(); first.languages[0].name = 'changed';
  const second = await engine.status();
  assert.deepEqual(second, { ready: true, languages: [{ tag: 'en-GB', name: 'English' }], engine: 'Windows OCR', maxImageDimension: 10000 });
  assert.equal(mock.calls.length, 1);
  await engine.status({ refresh: true });
  assert.equal(mock.calls.length, 2);
});

test('missing language components give actionable status and recognition errors', async () => {
  const empty = mockProcess(child => output(child, { ok: true, languages: [] }));
  const status = await createOcrEngine({ ...empty, platform: 'win32' }).status();
  assert.equal(status.ready, false); assert.match(status.error, /光学字符识别/);
  for (const code of ['NO_LANGUAGE', 'UNSUPPORTED_LANGUAGE']) {
    const mock = mockProcess(child => output(child, { ok: false, code }, 1));
    await assert.rejects(createOcrEngine({ ...mock, platform: 'win32' }).recognize({ inputPath: path.resolve('sample.png') }), /安装|添加/);
  }
});

test('invalid input and unsupported platform never start a child process', async () => {
  const mock = mockProcess();
  const engine = createOcrEngine({ ...mock, platform: 'win32' });
  await assert.rejects(engine.recognize({ inputPath: 'relative.png' }), /路径无效/);
  await assert.rejects(engine.recognize({ inputPath: path.resolve('a.png'), language: 'en;exit' }), /语言无效/);
  const unavailable = await createOcrEngine({ ...mock, platform: 'linux' }).status();
  assert.equal(unavailable.ready, false); assert.match(unavailable.error, /Windows/);
  assert.equal(mock.calls.length, 0);
});

test('abort kills the OCR child and rejects with AbortError', async () => {
  const mock = mockProcess();
  const controller = new AbortController();
  const promise = createOcrEngine({ ...mock, platform: 'win32' }).recognize({ inputPath: path.resolve('a.png'), signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.equal(mock.calls[0].child.kills, 1);
  await assert.rejects(createOcrEngine({ ...mock, platform: 'win32' }).recognize({ inputPath: path.resolve('a.png'), signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(mock.calls.length, 1);
});

test('timeout and excessive process output stop the worker', async () => {
  const slow = mockProcess();
  await assert.rejects(createOcrEngine({ ...slow, platform: 'win32', timeoutMs: 10 }).recognize({ inputPath: path.resolve('a.png') }), /超时/);
  assert.equal(slow.calls[0].child.kills, 1);
  const large = mockProcess(child => child.stdout.emit('data', Buffer.alloc(100)));
  await assert.rejects(createOcrEngine({ ...large, platform: 'win32', maxOutputBytes: 50 }).recognize({ inputPath: path.resolve('a.png') }), /结果过大/);
  assert.equal(large.calls[0].child.kills, 1);
});

test('malformed worker output is rejected instead of shown as recognized text', async () => {
  const mock = mockProcess(child => { child.stdout.emit('data', Buffer.from('Not JSON')); child.emit('close', 0); });
  await assert.rejects(createOcrEngine({ ...mock, platform: 'win32' }).recognize({ inputPath: path.resolve('a.png') }), /有效结果/);
});

test('Windows OCR recognizes a real local PNG without network access', { skip: process.platform !== 'win32' }, async t => {
  const engine = createOcrEngine();
  const status = await engine.status();
  if (!status.ready) { t.skip(status.error); return; }
  const language = status.languages.find(item => item.tag.startsWith('en'))?.tag;
  if (!language) { t.skip('English OCR language component is not installed'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mosaic-ocr-中文'"));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith("mosaic-ocr-中文'") && !relative.includes(path.sep));
    return fs.rm(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'fixture.png');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="160"><rect width="900" height="160" fill="white"/><text x="40" y="105" font-family="Arial" font-size="64" fill="black">MOSAIC OCR 123</text></svg>')).png().toFile(filename);
  const result = await engine.recognize({ inputPath: filename, language });
  assert.match(result.text, /MOSAIC OCR 123/);
  assert.equal(result.width, 900); assert.equal(result.height, 160);
  const wideFilename = path.join(directory, 'scaled.png');
  const wideWidth = status.maxImageDimension + 1;
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${wideWidth}" height="160"><rect width="${wideWidth}" height="160" fill="white"/><text x="40" y="105" font-family="Arial" font-size="64" fill="black">SCALED IMAGE</text></svg>`)).png().toFile(wideFilename);
  const scaledResult = await engine.recognize({ inputPath: wideFilename, language });
  assert.equal(scaledResult.scaled, true);
  assert.equal(typeof scaledResult.text, 'string');
  assert.equal(scaledResult.width, wideWidth);
});
