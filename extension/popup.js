'use strict';
const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage(message);
const RELOAD_KEY = 'shituWorkerReload';
function status(text, state) { $('status').textContent = text; $('statusDot').className = `dot ${state || ''}`; }
let checking = false;
let workerVerified = false;
let reloading = false;
let upgraded = false;

async function ensureWorkerVersion() {
  if (workerVerified) return true;
  // Unpacked extensions can keep an old worker alive after their files change.
  // Read the on-disk version, then compare it with the worker serving messages.
  const manifest = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then(response => response.json());
  const info = await send({ type: 'shitu:extension-info' });
  const stored = await chrome.storage.local.get(RELOAD_KEY);
  if (info?.ok && info.protocol === 1 && info.version === manifest.version) {
    workerVerified = true;
    upgraded = Boolean(stored[RELOAD_KEY]);
    if (upgraded) await chrome.storage.local.remove(RELOAD_KEY);
    return true;
  }
  const previous = stored[RELOAD_KEY];
  if (previous?.version === manifest.version && Date.now() - previous.at < 60000) {
    status('扩展更新尚未完成', 'offline');
    $('feedback').textContent = '请在 Chrome 扩展管理中重新加载拾图采集助手，再刷新素材网页。';
    return false;
  }
  status('正在更新采集助手…');
  $('feedback').textContent = '检测到旧版后台，正在自动重新加载。随后刷新素材网页即可采集。';
  await chrome.storage.local.set({ [RELOAD_KEY]: { version: manifest.version, at: Date.now() } });
  reloading = true;
  chrome.runtime.reload();
  return false;
}

async function showRecent(connected = false) {
  const { shituLastCapture: recent } = await chrome.storage.local.get('shituLastCapture');
  if (connected && recent && !recent.ok && /^(?:连接已失效|本机连接|未知请求|尚未找到本机拾图|扩展已更新)/.test(recent.error || '')) {
    await chrome.storage.local.remove('shituLastCapture');
    $('recent').hidden = true;
    return;
  }
  $('recent').hidden = !recent;
  if (recent) $('recentText').textContent = recent.ok ? `${recent.duplicates ? '已跳过重复素材' : '已保存'} · ${recent.name}` : `未保存 · ${recent.error}`;
}

async function checkConnection(force = false) {
  if (checking || reloading) return;
  checking = true;
  $('check').disabled = true;
  status('正在自动查找拾图…');
  try {
    if (!await ensureWorkerVersion()) return false;
    const result = await send({ type: force ? 'shitu:reconnect' : 'shitu:ping' });
    if (result?.ok) {
      status(result.ready ? '已自动连接桌面拾图' : '已连接 · 请先选择素材库', result.ready ? 'online' : '');
      $('feedback').textContent = result.ready
        ? upgraded ? '采集助手已更新。请刷新已打开的素材网页，再按住 Alt 并右键采集。' : '已准备好。回到网页，按住 Alt 并右键点击素材即可保存。'
        : '请先在桌面拾图中选择或新建素材库，之后自动开始接收素材。';
      await showRecent(true);
      return true;
    }
    status('等待桌面拾图', 'offline');
    $('feedback').textContent = result?.error || '请先打开桌面拾图。';
    await showRecent();
    return false;
  } catch { status('连接检查失败', 'offline'); $('feedback').textContent = '扩展可能正在更新，请关闭此窗口后重新打开。'; return false; }
  finally { checking = false; $('check').disabled = reloading; }
}
$('check').addEventListener('click', () => checkConnection(true));
checkConnection();
const refresh = setInterval(() => checkConnection(), 3000);
window.addEventListener('unload', () => clearInterval(refresh));
