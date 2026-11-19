'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createVideoSiteAuth } = require('../src/video-site-auth.cjs');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-auth-test-'));
  const directory = path.join(root, 'state'), sources = path.join(root, 'source');
  await fs.mkdir(sources); await fs.mkdir(directory);
  await fs.writeFile(path.join(sources, 'Auth.cs'), 'class Auth {}');
  const compilerPath = path.join(root, 'csc.exe'); await fs.writeFile(compilerPath, 'fixture');
  const events = [], calls = [], exported = [], controls = { waiting: false, exportError: null, sessionInputs: [], ...options };
  const spawnProcess = (executable, args, processOptions) => {
    assert.equal(processOptions.shell, false); assert.equal(processOptions.windowsHide, true);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    const close = (value, code = 0) => {
      if (closed) return; closed = true;
      if (value) child.stdout.write(JSON.stringify(value)); child.stdout.end(); child.stderr.end();
      child.emit('close', code);
    };
    let input = '';
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      input += String(chunk);
      if (String(chunk).trim() === 'cancel') close({ ok: false, code: 'AUTH_CANCELLED' }, 1);
      done();
    } });
    child.kill = () => { close(null, 1); return true; };
    calls.push({ executable, args });
    queueMicrotask(async () => {
      try {
        if (path.basename(executable) === 'csc.exe') {
          await fs.writeFile(args.find(arg => arg.startsWith('/out:')).slice(5), 'compiled-fixture'); close(); return;
        }
        const mode = args[0], stateDirectory = args[args.indexOf('--state-dir') + 1], site = args[args.indexOf('--site') + 1];
        if (mode === '--connect') {
          if (controls.connectError) { close({ ok: false, code: controls.connectError, error: 'private path and cookie value must not escape' }, 1); return; }
          controls.finishConnect = async () => { await fs.writeFile(path.join(stateDirectory, 'youtube-session.dpapi'), 'encrypted fixture'); close({ ok: true, connected: true }); };
          if (!controls.waiting) await controls.finishConnect();
        } else if (mode === '--export' || mode === '--export-browser-session') {
          if (mode === '--export-browser-session') controls.sessionInputs.push(JSON.parse(input));
          if (controls.exportError) { close({ ok: false, code: controls.exportError, error: 'private path and cookie value must not escape' }, 1); return; }
          const output = args[args.indexOf('--output') + 1]; exported.push(output);
          await fs.mkdir(path.dirname(output), { recursive: true });
          await fs.writeFile(output, '# Netscape HTTP Cookie File\n' +
            (site === 'bilibili' ? '.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\t' : '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t') +
            (mode === '--export-browser-session' ? 'transient-dummy-session' : 'dummy-session') + '\n');
          if (controls.afterExportFailure === 'json') { close({ ok: false, code: 'AUTH_STORAGE' }, 1); return; }
          if (controls.afterExportFailure === 'exit') { close(null, 1); return; }
          close({ ok: true });
        } else if (mode === '--disconnect') {
          await fs.rm(path.join(stateDirectory, 'youtube-session.dpapi'), { force: true }); close({ ok: true, connected: false });
        } else assert.fail(`Unexpected mode ${mode}`);
      } catch (error) { close({ ok: false, code: 'AUTH_STORAGE' }, 1); }
    });
    return child;
  };
  const auth = createVideoSiteAuth({ directory, nativeSourceDir: sources, compilerPath, spawnProcess, onState: value => events.push(value) });
  t.after(async () => { await auth.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { auth, directory, calls, exported, events, controls };
}
async function until(read) {
  for (let i = 0; i < 200; i++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected asynchronous operation');
}

const transientSession = () => ({ capturedAt: Date.now(), cookies: [{ domain: '.youtube.com', path: '/', name: 'SID',
  value: 'transient-dummy-session', secure: true, httpOnly: true, hostOnly: false, session: true }] });
const transientBilibiliSession = () => ({ capturedAt: Date.now(), cookies: [{ domain: '.bilibili.com', path: '/', name: 'SESSDATA',
  value: 'transient-dummy-session', secure: true, httpOnly: true, hostOnly: false, session: true }] });

test('Bilibili transient sessions pass an explicit site and retain YouTube-only legacy operations', async t => {
  const { auth, directory, calls, exported, controls } = await fixture(t);
  await fs.writeFile(path.join(directory, 'youtube-session.dpapi'), 'previous YouTube account unchanged');
  const session = transientBilibiliSession();
  assert.equal(await auth.withBrowserSession(session, async file => {
    assert.match(await fs.readFile(file, 'utf8'), /\.bilibili\.com\t.*SESSDATA/);
    return 'Bilibili saved';
  }, { site: 'bilibili' }), 'Bilibili saved');
  assert.deepEqual(controls.sessionInputs, [session]);
  const run = calls.find(call => call.args[0] === '--export-browser-session');
  assert.equal(run.args[run.args.indexOf('--site') + 1], 'bilibili');
  await assert.rejects(fs.access(exported[0]), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(directory, 'youtube-session.dpapi'), 'utf8'), 'previous YouTube account unchanged');
  await assert.rejects(auth.state('bilibili'), { code: 'VIDEO_AUTH_UNAVAILABLE' });
  assert.throws(() => auth.connect('bilibili'), { code: 'VIDEO_AUTH_UNAVAILABLE' });
  assert.throws(() => auth.withSession('bilibili', () => {}), { code: 'VIDEO_AUTH_UNAVAILABLE' });
  assert.equal(calls.some(call => call.args[0] === '--connect' || call.args[0] === '--export'), false);
});

test('Bilibili transient session validation and native failures use Bilibili guidance', async t => {
  const { auth, controls } = await fixture(t);
  await assert.rejects(auth.withBrowserSession(null, () => assert.fail(), { site: 'bilibili' }),
    error => error.code === 'VIDEO_BROWSER_SESSION_INVALID' && /Bilibili/.test(error.message));
  await assert.rejects(auth.withBrowserSession({ ...transientBilibiliSession(), capturedAt: Date.now() - 121000 }, () => assert.fail(), { site: 'bilibili' }),
    error => error.code === 'VIDEO_BROWSER_SESSION_EXPIRED' && /Bilibili/.test(error.message));
  for (const [nativeCode, code] of [['AUTH_BROWSER_SESSION_INVALID', 'VIDEO_BROWSER_SESSION_INVALID'], ['AUTH_BROWSER_LOGIN_REQUIRED', 'VIDEO_BROWSER_LOGIN_REQUIRED']]) {
    controls.exportError = nativeCode;
    await assert.rejects(auth.withBrowserSession(transientBilibiliSession(), () => assert.fail(), { site: 'bilibili' }),
      error => error.code === code && /Bilibili/.test(error.message) && !error.message.includes('YouTube'));
  }
});

test('browser sessions send fresh credentials only on stdin and clean each one-shot export', async t => {
  const { auth, directory, calls, exported, controls, events } = await fixture(t);
  await fs.writeFile(path.join(directory, 'youtube-session.dpapi'), 'previous account unchanged');
  const session = transientSession();
  assert.equal(await auth.withBrowserSession(session, async (file, { signal }) => {
    assert.equal(signal.aborted, false);
    assert.match(await fs.readFile(file, 'utf8'), /transient-dummy-session/);
    return 'saved';
  }), 'saved');
  await assert.rejects(auth.withBrowserSession(session, async () => { throw new Error('fixture download failure'); }), /fixture download failure/);
  assert.deepEqual(controls.sessionInputs, [session, session]);
  assert.ok(calls.filter(call => path.basename(call.executable) !== 'csc.exe').every(call => call.args[0] === '--export-browser-session'));
  assert.ok(calls.every(call => !JSON.stringify(call.args).includes('transient-dummy-session')));
  assert.equal(new Set(exported).size, 2);
  for (const file of exported) {
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.dirname(file)), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(path.join(directory, 'youtube-session.dpapi'), 'utf8'), 'previous account unchanged');
  assert.deepEqual(events, []);
});

test('invalid, oversized, unserializable and stale browser sessions fail before launching helpers', async t => {
  const { auth, calls } = await fixture(t);
  const cyclic = transientSession(); cyclic.cookies.push(cyclic);
  const bigint = transientSession(); bigint.cookies[0].value = 1n;
  for (const input of [null, {}, [], { ...transientSession(), extra: true }, { ...transientSession(), capturedAt: 'now' },
    { ...transientSession(), cookies: Array(513).fill({}) }, { ...transientSession(), cookies: [{ value: 'x'.repeat(512 * 1024) }] }, cyclic, bigint]) {
    await assert.rejects(auth.withBrowserSession(input, () => assert.fail()), { code: 'VIDEO_BROWSER_SESSION_INVALID' });
  }
  for (const capturedAt of [Date.now() - 121000, Date.now() + 60000]) {
    await assert.rejects(auth.withBrowserSession({ ...transientSession(), capturedAt }, () => assert.fail()), { code: 'VIDEO_BROWSER_SESSION_EXPIRED' });
  }
  assert.equal(calls.length, 0);
});

test('browser-session exports are removed when the helper fails after writing credentials', async t => {
  for (const [afterExportFailure, code] of [['json', 'VIDEO_AUTH_STORAGE'], ['exit', 'VIDEO_AUTH_FAILED']]) {
    await t.test(afterExportFailure, async t => {
      const { auth, directory, calls, exported } = await fixture(t, { afterExportFailure });
      const oldSession = path.join(directory, 'youtube-session.dpapi');
      await fs.writeFile(oldSession, 'previous account unchanged');
      let callbacks = 0;
      await assert.rejects(auth.withBrowserSession(transientSession(), () => { callbacks++; }), { code });
      assert.equal(callbacks, 0);
      assert.equal(exported.length, 1);
      await assert.rejects(fs.access(exported[0]), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.dirname(exported[0])), { code: 'ENOENT' });
      assert.equal(await fs.readFile(oldSession, 'utf8'), 'previous account unchanged');
      assert.ok(calls.filter(call => path.basename(call.executable) !== 'csc.exe')
        .every(call => call.args[0] === '--export-browser-session'));
    });
  }
});

test('native browser session failures retain dedicated codes and never expose native diagnostics', async t => {
  for (const [nativeCode, code] of [
    ['AUTH_BROWSER_SESSION_INVALID', 'VIDEO_BROWSER_SESSION_INVALID'],
    ['AUTH_BROWSER_SESSION_EXPIRED', 'VIDEO_BROWSER_SESSION_EXPIRED'],
    ['AUTH_BROWSER_LOGIN_REQUIRED', 'VIDEO_BROWSER_LOGIN_REQUIRED'],
    ['AUTH_STORAGE', 'VIDEO_AUTH_STORAGE'],
    ['UNEXPECTED_ERROR', 'VIDEO_AUTH_FAILED']
  ]) await t.test(nativeCode, async t => {
    const { auth, events, calls } = await fixture(t, { exportError: nativeCode });
    const error = await auth.withBrowserSession(transientSession(), () => assert.fail()).catch(value => value);
    assert.equal(error.code, code);
    assert.equal(error.message.includes('private'), false);
    assert.equal(error.message.includes('cookie'), false);
    assert.deepEqual(events, []);
    assert.equal(calls.filter(call => call.args[0] === '--connect' || call.args[0] === '--export').length, 0);
  });
});

test('shutdown cancels browser-session callbacks and removes credentials without changing saved accounts', async t => {
  const { auth, directory, exported } = await fixture(t);
  await fs.writeFile(path.join(directory, 'youtube-session.dpapi'), 'previous account unchanged');
  let entered = false;
  const pending = auth.withBrowserSession(transientSession(), async (_file, { signal }) => {
    entered = true;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  pending.catch(() => {});
  await until(() => entered); await auth.shutdown();
  await assert.rejects(pending, { code: 'VIDEO_AUTH_CANCELLED' });
  await assert.rejects(fs.access(exported[0]), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(directory, 'youtube-session.dpapi'), 'utf8'), 'previous account unchanged');
});

test('reading connection state never launches a browser or compiles a helper', async t => {
  const { auth, calls } = await fixture(t);
  assert.deepEqual(await auth.state('youtube'), { site: 'youtube', connected: false, connecting: false });
  assert.equal(calls.length, 0);
  await assert.rejects(auth.withSession('youtube', () => assert.fail()), { code: 'VIDEO_AUTH_REQUIRED' });
  assert.equal(calls.length, 0);
  assert.throws(() => auth.connect('other'), { code: 'VIDEO_AUTH_UNAVAILABLE' });
});

test('explicit connect compiles once and shares a single native login request', async t => {
  const { auth, calls, controls, events } = await fixture(t, { waiting: true });
  const first = auth.connect('youtube', { url: 'https://youtu.be/jNQXAC9IVRw' });
  const second = auth.connect('youtube', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  assert.equal(first, second);
  await until(() => controls.finishConnect);
  assert.equal((await auth.state('youtube')).connecting, true);
  await controls.finishConnect();
  assert.deepEqual(await first, { site: 'youtube', connected: true, connecting: false });
  assert.equal(calls.filter(call => call.args[0] === '--connect').length, 1);
  const connect = calls.find(call => call.args[0] === '--connect');
  assert.equal(connect.args.at(-1), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  await auth.withSession('youtube', async () => {});
  assert.equal(calls.filter(call => path.basename(call.executable) === 'csc.exe').length, 1);
  assert.ok(events.some(value => value.connecting)); assert.ok(events.some(value => value.connected && !value.connecting));
  assert.ok(events.every(value => !JSON.stringify(value).includes('dummy-session')));
});

test('native login refusal and missing browser remain actionable after refreshing connection state', async t => {
  for (const [nativeCode, code, message] of [
    ['AUTH_REJECTED', 'VIDEO_AUTH_REJECTED', 'Google 拒绝了此次登录，请保持账号安全设置并稍后重试。'],
    ['AUTH_BROWSER_MISSING', 'VIDEO_AUTH_BROWSER_MISSING', '未找到用于连接 YouTube 的浏览器，请安装 Chrome 后重试。']
  ]) await t.test(nativeCode, async t => {
    const { auth, calls, controls, events } = await fixture(t, { connectError: nativeCode });
    await assert.rejects(auth.connect('youtube'), error => error.code === code && error.message === message);
    assert.deepEqual(await auth.state('youtube'), { site: 'youtube', connected: false, connecting: false, errorCode: code });
    assert.deepEqual(await auth.state('youtube'), { site: 'youtube', connected: false, connecting: false, errorCode: code });
    assert.equal(calls.filter(call => call.args[0] === '--connect').length, 1);
    assert.ok(events.some(value => value.errorCode === code && !value.connecting));
    assert.ok(events.every(value => !JSON.stringify(value).includes('private')));
    controls.connectError = null;
    assert.deepEqual(await auth.connect('youtube'), { site: 'youtube', connected: true, connecting: false });
  });
});

test('a refused reconnection preserves the previous session while exposing the latest error', async t => {
  const { auth, controls } = await fixture(t);
  await auth.connect('youtube');
  controls.connectError = 'AUTH_REJECTED';
  await assert.rejects(auth.connect('youtube'), { code: 'VIDEO_AUTH_REJECTED' });
  assert.deepEqual(await auth.state('youtube'), { site: 'youtube', connected: true, connecting: false, errorCode: 'VIDEO_AUTH_REJECTED' });
});

test('unknown native connection errors remain generic and never expose helper diagnostics', async t => {
  const { auth } = await fixture(t, { connectError: 'UNRECOGNIZED_NATIVE_ERROR' });
  await assert.rejects(auth.connect('youtube'), { code: 'VIDEO_AUTH_FAILED', message: '无法建立 YouTube 连接，请重试。' });
  assert.equal((await auth.state('youtube')).errorCode, 'VIDEO_AUTH_FAILED');
});

test('each download receives a fresh cookie file that is removed after success or failure', async t => {
  const { auth, exported } = await fixture(t);
  await auth.connect('youtube');
  assert.equal(await auth.withSession('youtube', async (filename, { signal }) => {
    assert.equal(signal.aborted, false);
    assert.match(await fs.readFile(filename, 'utf8'), /dummy-session/);
    return 'download complete';
  }), 'download complete');
  await assert.rejects(auth.withSession('youtube', async filename => {
    assert.match(await fs.readFile(filename, 'utf8'), /dummy-session/); throw new Error('download failed');
  }), /download failed/);
  assert.equal(new Set(exported).size, 2);
  for (const filename of exported) {
    await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.dirname(filename)), { code: 'ENOENT' });
  }
});

test('native expiry errors are sanitized and mark the saved connection unavailable', async t => {
  const { auth, controls, events } = await fixture(t);
  await auth.connect('youtube'); controls.exportError = 'AUTH_EXPIRED';
  const error = await auth.withSession('youtube', () => assert.fail()).catch(value => value);
  assert.equal(error.code, 'VIDEO_AUTH_EXPIRED'); assert.equal(error.message.includes('private'), false);
  assert.equal((await auth.state('youtube')).connected, false);
  assert.ok(events.some(value => value.errorCode === 'VIDEO_AUTH_EXPIRED'));
});

test('cancelling an explicit login stops only its helper and exposes no saved connection', async t => {
  const { auth, controls, calls } = await fixture(t, { waiting: true });
  const controller = new AbortController();
  const pending = auth.connect('youtube', { signal: controller.signal });
  await until(() => controls.finishConnect); controller.abort();
  await assert.rejects(pending, { code: 'VIDEO_AUTH_CANCELLED' });
  assert.equal((await auth.state('youtube')).connected, false);
  assert.equal(calls.filter(call => call.args[0] === '--connect').length, 1);
});

test('shutdown aborts active session callbacks and removes temporary cookies while retaining saved auth', async t => {
  const { auth, directory, exported } = await fixture(t);
  await auth.connect('youtube');
  let callbackEntered = false;
  const pending = auth.withSession('youtube', async (_filename, { signal }) => {
    callbackEntered = true;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  pending.catch(() => {});
  await until(() => callbackEntered); await auth.shutdown();
  await assert.rejects(pending, { code: 'VIDEO_AUTH_CANCELLED' });
  await fs.access(path.join(directory, 'youtube-session.dpapi'));
  await assert.rejects(fs.stat(exported[0]), { code: 'ENOENT' });
  assert.throws(() => auth.connect('youtube'), { code: 'VIDEO_AUTH_CANCELLED' });
});

test('disconnect waits for session cleanup then forgets the saved connection', async t => {
  const { auth, exported } = await fixture(t);
  await auth.connect('youtube');
  let entered = false;
  const pending = auth.withSession('youtube', async (_filename, { signal }) => {
    entered = true;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  pending.catch(() => {});
  await until(() => entered);
  assert.deepEqual(await auth.disconnect('youtube'), { site: 'youtube', connected: false, connecting: false });
  await assert.rejects(pending, { code: 'VIDEO_AUTH_CANCELLED' });
  await assert.rejects(fs.stat(exported[0]), { code: 'ENOENT' });
});
