'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createVideoSiteAuth } = require('../src/video-site-auth.cjs');

function browserSession(overrides = {}) {
  return { capturedAt: Date.now(), cookies: [{ domain: '.youtube.com', path: '/', name: 'SID',
    value: 'fixed-dummy-transient-not-real-login', secure: true, httpOnly: true, hostOnly: false, session: true }], ...overrides };
}
function bilibiliSession(overrides = {}) {
  return browserSession({ cookies: [{ domain: '.bilibili.com', path: '/', name: 'SESSDATA',
    value: 'fixed-dummy-bilibili-not-real-login', secure: true, httpOnly: true, hostOnly: false, session: true }], ...overrides });
}

test('transient Chrome sessions use private native exports without opening a browser or reading saved accounts', { timeout: 90000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows private browser-session export test'); return; }
  const parent = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'native-browser-session-'));
  const modes = [];
  const auth = createVideoSiteAuth({ directory, spawnProcess: (file, args, options) => {
    modes.push(args[0]); return spawn(file, args, options);
  } });
  t.after(async () => {
    await auth.shutdown(); assert.equal(path.dirname(path.resolve(directory)), parent);
    await fs.rm(directory, { recursive: true, force: true });
  });
  let exported;
  assert.equal(await auth.withBrowserSession(browserSession(), async file => {
    exported = file;
    assert.match(await fs.readFile(file, 'utf8'), /#HttpOnly_\.youtube\.com\tTRUE\t\/\tTRUE\t0\tSID\tfixed-dummy-transient-not-real-login/);
    assert.deepEqual(await auth.state('youtube'), { site: 'youtube', connected: false, connecting: false });
    return 'download complete';
  }), 'download complete');
  await assert.rejects(fs.access(exported), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.dirname(exported)), { code: 'ENOENT' });
  const saved = path.join(directory, 'youtube-session.dpapi');
  await fs.writeFile(saved, 'invalid old account; transient operation must not read or replace this');
  await assert.rejects(auth.withBrowserSession(browserSession(), async file => {
    exported = file; throw new Error('download fixture failed');
  }), /download fixture failed/);
  await assert.rejects(fs.access(exported), { code: 'ENOENT' });
  assert.equal(await fs.readFile(saved, 'utf8'), 'invalid old account; transient operation must not read or replace this');
  assert.equal(await auth.withBrowserSession(bilibiliSession(), async file => {
    exported = file;
    const data = await fs.readFile(file, 'utf8');
    assert.match(data, /#HttpOnly_\.bilibili\.com\tTRUE\t\/\tTRUE\t0\tSESSDATA\tfixed-dummy-bilibili-not-real-login/);
    assert.equal(data.includes('youtube'), false);
    return 'Bilibili complete';
  }, { site: 'bilibili' }), 'Bilibili complete');
  await assert.rejects(fs.access(exported), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(directory, 'bilibili-session.dpapi')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(saved, 'utf8'), 'invalid old account; transient operation must not read or replace this');
  assert.ok(!modes.includes('--connect') && !modes.includes('--export') && !modes.includes('--disconnect'));
  assert.equal((await fs.readdir(directory)).some(name => name.includes('profile')), false);

  const builds = await fs.readdir(path.join(directory, 'native-cache'));
  const executable = path.join(directory, 'native-cache', builds[0], 'MosaicVideoAuth.exe');
  const run = async (payload, output, site = 'youtube') => new Promise((resolve, reject) => {
    const child = spawn(executable, ['--export-browser-session', '--site', site, '--state-dir', directory, '--output', output],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Transient native fixture timed out')); }, 10000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        assert.equal(stderr, ''); assert.equal(stdout.includes('fixed-dummy'), false);
        resolve({ code, result: JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) });
      } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  const cookie = browserSession().cookies[0];
  const biliCookie = bilibiliSession().cookies[0];
  const invalidCases = [
    [browserSession({ capturedAt: Date.now() - 121000 }), 'AUTH_BROWSER_SESSION_EXPIRED'],
    [browserSession({ capturedAt: Date.now() + 60000 }), 'AUTH_BROWSER_SESSION_EXPIRED'],
    [browserSession({ cookies: [{ ...cookie, domain: '.google.com' }] }), 'AUTH_BROWSER_SESSION_INVALID'],
    [browserSession({ cookies: [{ ...cookie, domain: '.youtube.com.evil.invalid' }] }), 'AUTH_BROWSER_SESSION_INVALID'],
    [browserSession({ cookies: [{ ...cookie, partitionKey: { topLevelSite: 'https://youtube.com' } }] }), 'AUTH_BROWSER_SESSION_INVALID'],
    [browserSession({ cookies: [{ ...cookie, value: 'fixed-dummy\nforged' }] }), 'AUTH_BROWSER_SESSION_INVALID'],
    [browserSession({ cookies: [{ ...cookie, name: 'LOGIN_INFO\tbad' }] }), 'AUTH_BROWSER_SESSION_INVALID'],
    [browserSession({ cookies: [{ ...cookie, secure: 'true' }] }), 'AUTH_BROWSER_SESSION_INVALID'],
    [browserSession({ cookies: [{ ...cookie, hostOnly: true }] }), 'AUTH_BROWSER_SESSION_INVALID'],
    [browserSession({ cookies: Array(513).fill(cookie) }), 'AUTH_BROWSER_SESSION_INVALID'],
    [browserSession({ cookies: [] }), 'AUTH_BROWSER_LOGIN_REQUIRED'],
    [browserSession({ cookies: [{ ...cookie, name: 'PREF' }] }), 'AUTH_BROWSER_LOGIN_REQUIRED'],
    [browserSession({ cookies: [{ ...cookie, session: false, expirationDate: Date.now() / 1000 - 60 }] }), 'AUTH_BROWSER_LOGIN_REQUIRED'],
    [browserSession({ surprise: 'fixed-dummy' }), 'AUTH_BROWSER_SESSION_INVALID'],
    [' '.repeat(512 * 1024 + 1), 'AUTH_BROWSER_SESSION_INVALID'],
    ['{"capturedAt":', 'AUTH_BROWSER_SESSION_INVALID'],
    [bilibiliSession(), 'AUTH_BROWSER_SESSION_INVALID', 'youtube'],
    [browserSession(), 'AUTH_BROWSER_SESSION_INVALID', 'bilibili'],
    [bilibiliSession({ cookies: [biliCookie, cookie] }), 'AUTH_BROWSER_SESSION_INVALID', 'bilibili'],
    [browserSession({ cookies: [cookie, biliCookie] }), 'AUTH_BROWSER_SESSION_INVALID', 'youtube'],
    [bilibiliSession({ cookies: [{ ...biliCookie, domain: '.bilibili.com.evil.invalid' }] }), 'AUTH_BROWSER_SESSION_INVALID', 'bilibili'],
    [bilibiliSession({ cookies: [{ ...biliCookie, domain: '.bilivideo.com' }] }), 'AUTH_BROWSER_SESSION_INVALID', 'bilibili'],
    [bilibiliSession({ cookies: [{ ...biliCookie, name: 'bili_jct' }] }), 'AUTH_BROWSER_LOGIN_REQUIRED', 'bilibili'],
    [bilibiliSession({ cookies: [{ ...biliCookie, value: '' }] }), 'AUTH_BROWSER_LOGIN_REQUIRED', 'bilibili'],
    [bilibiliSession({ cookies: [{ ...biliCookie, session: false, expirationDate: Date.now() / 1000 - 60 }] }), 'AUTH_BROWSER_LOGIN_REQUIRED', 'bilibili']
  ];
  for (let index = 0; index < invalidCases.length; index++) {
    const [payload, expectedCode, site = 'youtube'] = invalidCases[index];
    const output = path.join(directory, 'exports', require('node:crypto').randomUUID().replaceAll('-', ''), 'cookies.txt');
    const response = await run(payload, output, site);
    assert.equal(response.code, 1, String(index)); assert.equal(response.result.ok, false, String(index));
    assert.equal(response.result.code, expectedCode, String(index));
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
  }
  const existing = path.join(directory, 'exports', require('node:crypto').randomUUID().replaceAll('-', ''), 'cookies.txt');
  await fs.mkdir(path.dirname(existing), { recursive: true }); await fs.writeFile(existing, 'must not overwrite');
  assert.equal((await run(browserSession(), existing)).result.ok, false);
  assert.equal(await fs.readFile(existing, 'utf8'), 'must not overwrite');
  assert.equal(await fs.readFile(saved, 'utf8'), 'invalid old account; transient operation must not read or replace this');
});

test('native helper compiles, rejects invalid DPAPI data, and passes dummy-only DPAPI self-test without a browser', { timeout: 90000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows CurrentUser DPAPI test'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-native-auth-test-'));
  const auth = createVideoSiteAuth({ directory });
  t.after(async () => { await auth.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  await auth.disconnect('youtube'); // Initialize only the dedicated test marker; no browser is launched.
  await fs.writeFile(path.join(directory, 'youtube-session.dpapi'), 'fixed dummy invalid ciphertext; never a real session');
  await assert.rejects(auth.withSession('youtube', () => assert.fail('invalid DPAPI must never reach a downloader')), { code: 'VIDEO_AUTH_EXPIRED' });
  const builds = await fs.readdir(path.join(directory, 'native-cache'));
  assert.equal(builds.length, 1);
  const executable = path.join(directory, 'native-cache', builds[0], 'MosaicVideoAuth.exe');
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 16384) child.kill(); });
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', code => {
      try { const result = JSON.parse(output.trim().replace(/^\uFEFF/, '')); assert.equal(code, 0); resolve(result); }
      catch (error) { reject(error); }
    });
  });
  const result = await run(['--self-test', '--site', 'youtube', '--state-dir', directory]);
  assert.equal(result.ok, true);
  assert.equal(result.selfTest, true);
  assert.equal(result.dpapi, true);
  assert.equal(result.privateExport, true);
  assert.equal(JSON.stringify(result).includes('dummy-session'), false);
  assert.equal((await fs.readFile(path.join(directory, 'youtube-session.dpapi'), 'utf8')).startsWith('fixed dummy'), true,
    'self-test cannot replace even a dummy saved session in its parent directory');
  const exports = await fs.readdir(path.join(directory, 'exports')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.equal(exports.length, 0);
  assert.equal((await fs.readdir(directory)).some(name => name.toLowerCase().includes('profile')), false);
});

test('native browser selection prefers Chrome, isolates profiles, and disconnect checks every owned profile', { timeout: 90000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows native browser selection test'); return; }
  const parent = path.resolve(__dirname, '..', '.recovery', 'tests');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'native-browser-selection-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const harness = path.join(directory, 'BrowserSelectionTest.cs');
  await fs.writeFile(harness, String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
internal static class BrowserSelectionTest {
 static void Check(bool value, string message) { if (!value) throw new Exception(message); }
 [STAThread]
 static void Main(string[] args) {
  string root = args[0];
  Func<Environment.SpecialFolder,string> folder = kind => Path.Combine(root, kind.ToString());
  var installed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  string chrome = Path.Combine(folder(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe");
  string edge = Path.Combine(folder(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe");
  installed.Add(chrome); installed.Add(edge);
  var choice = YouTubeConnection.SelectBrowser(installed.Contains, folder);
  Check(choice.Executable == chrome && choice.Name == "Google Chrome", "Per-user Chrome must take precedence over machine Edge");
  Check(choice.ProfileDirectory(root) == Path.Combine(root, "youtube-profile-chrome"), "Chrome must use its own application profile");
  installed.Remove(chrome);
  var fallback = YouTubeConnection.SelectBrowser(installed.Contains, folder);
  Check(fallback.Executable == edge && fallback.Name == "Microsoft Edge", "Missing Chrome must fall back to installed Edge");
  Check(fallback.ProfileDirectory(root) == Path.Combine(root, "youtube-profile-edge"), "Edge must use a separate application profile");
  Check(choice.ProfileDirectory(root) != fallback.ProfileDirectory(root), "Browsers must never reuse one another's profile");
  installed.Clear();
  FileNotFoundException missing = null;
  try { YouTubeConnection.SelectBrowser(installed.Contains, folder); } catch (FileNotFoundException error) { missing = error; }
  Check(missing != null && missing.Message.Contains("Google Chrome") && missing.Message.Contains("Microsoft Edge"), "Missing browser error must name the supported browsers");
  var output = new StringWriter(); var stdout = Console.Out;
  try { Console.SetOut(output); typeof(Program).GetMethod("WriteError", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { missing, "--connect" }); }
  finally { Console.SetOut(stdout); }
  var errorResult = new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(output.ToString());
  Check((string)errorResult["code"] == "AUTH_BROWSER_MISSING" && ((string)errorResult["error"]).Contains("Google Chrome"), "Helper error must preserve browser-specific guidance");

  string stateRoot = Path.Combine(root, "owned-state");
  var state = new NativeState(stateRoot);
  string[] profiles = { "youtube-profile", "youtube-profile-chrome", "youtube-profile-edge" };
  foreach (string name in profiles) { Directory.CreateDirectory(Path.Combine(stateRoot, name)); File.WriteAllText(Path.Combine(stateRoot, name, "fixture.txt"), "dummy"); }
  string untouched = Path.Combine(root, "unrelated-profile"); Directory.CreateDirectory(untouched); File.WriteAllText(Path.Combine(untouched, "fixture.txt"), "leave");
  string running = Path.Combine(stateRoot, "youtube-profile-edge");
  NativeState.RecordBrowser(running, Process.GetCurrentProcess());
  bool busy = false;
  try { state.Disconnect(CancellationToken.None); } catch (NativeFailure error) { busy = error.Code == "AUTH_BUSY"; }
  Check(busy, "Disconnect must refuse an active browser profile");
  foreach (string name in profiles) Check(Directory.Exists(Path.Combine(stateRoot, name)), "Busy disconnect must leave every profile intact");
  File.Delete(Path.Combine(running, ".mosaic-browser-owner.json"));
  state.Disconnect(CancellationToken.None);
  foreach (string name in profiles) Check(!Directory.Exists(Path.Combine(stateRoot, name)), "Disconnect must remove old and browser-specific owned profiles");
  Check(File.ReadAllText(Path.Combine(untouched, "fixture.txt")) == "leave", "Disconnect must not touch another profile");
  Console.WriteLine("Chrome priority, Edge fallback, browser guidance, profile isolation and guarded disconnect passed; no browser launched.");
 }
}`);
  const frameworkRoot = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET');
  let compiler;
  for (const arch of ['Framework64', 'Framework']) {
    const candidate = path.join(frameworkRoot, arch, 'v4.0.30319', 'csc.exe');
    if (await fs.access(candidate).then(() => true, () => false)) { compiler = candidate; break; }
  }
  assert.ok(compiler, '.NET Framework compiler required');
  const framework = path.dirname(compiler);
  const references = ['System.dll', 'System.Core.dll', 'System.Security.dll', 'System.Net.Http.dll', 'System.Web.Extensions.dll',
    'WPF/WindowsBase.dll', 'System.Xaml.dll', 'WPF/PresentationCore.dll', 'WPF/PresentationFramework.dll'];
  const native = path.resolve(__dirname, '..', 'src', 'video-auth-native');
  const executable = path.join(directory, 'BrowserSelectionTest.exe');
  const run = (file, args) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native browser selection test timed out')); }, 60000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
  });
  await run(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/main:BrowserSelectionTest', `/out:${executable}`,
    ...references.map(name => `/reference:${path.join(framework, name)}`), path.join(native, 'Program.cs'), path.join(native, 'YouTubeConnection.cs'), harness]);
  assert.match(await run(executable, [directory]), /Chrome priority, Edge fallback.*no browser launched/);
});
