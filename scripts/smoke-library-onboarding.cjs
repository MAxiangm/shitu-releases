'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');

async function runProduction(options) {
  const { app, dialog, session } = require('electron');
  const checks = [], observations = [], screenshots = [], errors = [], dialogs = [];
  let window, nextPicker = null;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const js = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const persist = result => fs.writeFile(path.join(options.directory, 'result.json'), JSON.stringify({ ...result, scene: options.scene, checks, observations, screenshots, errors, dialogs }, null, 2));
  const exists = filename => fs.stat(filename).then(() => true, () => false);
  async function waitFor(predicate, message, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await pause(50); }
    throw new Error(message);
  }
  async function capture(name) {
    window.showInactive(); await pause(100);
    await fs.writeFile(path.join(options.directory, name), (await window.webContents.capturePage()).toPNG());
    screenshots.push(name); window.hide();
  }
  async function view() {
    return js(() => {
      const visible = element => {
        if (!element || !element.getClientRects().length) return false;
        for (let current = element; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
        }
        return true;
      };
      return { needsLibrary: state.library.needsLibrary === true, root: state.library.root,
        onboarding: visible(document.querySelector('#libraryOnboarding')), emptyState: visible(document.querySelector('#emptyState')),
        appShell: visible(document.querySelector('.app-shell')), emptyText: document.querySelector('#emptyState').textContent,
        errorVisible: visible(document.querySelector('#setupError')), errorText: document.querySelector('#setupError').textContent,
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio, skin: document.documentElement.dataset.skin,
        changing: state.libraryChanging, buttonsEnabled: !document.querySelector('#setupCreateLibrary').disabled && !document.querySelector('#setupOpenLibrary').disabled };
    });
  }
  async function assertOnboarding(label) {
    const state = await view(); observations.push({ label, ...state });
    assert(state.needsLibrary && state.root === null, `${label}: expected a genuinely unconfigured library`);
    assert(state.onboarding, `${label}: library selection page is hidden`);
    assert(!state.emptyState, `${label}: ordinary emptyState is visible under onboarding`);
    assert(!state.appShell, `${label}: ordinary application shell is visible under onboarding`);
    assert(state.buttonsEnabled, `${label}: library selection actions remained disabled`);
  }
  async function assertLayout(label) {
    await assertOnboarding(label);
    const layout = await js(() => {
      const host = document.querySelector('#libraryOnboarding'), title = document.querySelector('#setupTitle'), description = document.querySelector('.setup-description'), options = document.querySelector('.setup-options');
      host.scrollTop = 0; title.scrollIntoView({ block: 'start' });
      const box = element => { const b = element.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
      return { title: box(title), description: box(description), options: box(options), viewport: { width: innerWidth, height: innerHeight }, scrollHeight: host.scrollHeight, clientHeight: host.clientHeight };
    });
    assert(layout.title.top >= -1 && layout.title.bottom <= layout.viewport.height + 1, `${label}: title cannot be scrolled into view`);
    assert(layout.title.bottom <= layout.description.top + 1 && layout.description.bottom <= layout.options.top + 1, `${label}: onboarding title, description or choices overlap`);
    for (const id of ['setupCreateLibrary', 'setupOpenLibrary']) {
      const reachable = await js(id => {
        const button = document.getElementById(id); button.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = button.getBoundingClientRect(), x = rect.left + rect.width / 2, y = Math.min(innerHeight - 2, Math.max(2, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top < innerHeight && rect.bottom > 0 && button.contains(hit);
      }, id);
      assert(reachable, `${label}: ${id} is clipped or covered`);
    }
    await js(() => document.querySelector('#libraryOnboarding').scrollTo({ top: 0 }));
    observations.push({ label: `${label}-layout`, ...layout });
  }
  async function select(selector, response, expectedTitle) {
    assert(!nextPicker, 'A previous native picker response was not consumed');
    nextPicker = { response, expectedTitle };
    await js(selector => document.querySelector(selector).click(), selector);
    await waitFor(async () => !nextPicker && !(await view()).changing, `Picker action ${selector} did not finish`);
  }
  async function assertNormalEmpty(label, expectedRoot) {
    await waitFor(async () => { const result = await view(); return result.root === expectedRoot && !result.needsLibrary && !result.onboarding && result.emptyState && result.appShell; }, `${label}: normal empty library view did not replace onboarding`);
    const result = await view(); observations.push({ label, ...result });
    assert(result.emptyText.includes('导入第一份素材'), `${label}: wrong empty library prompt`);
    assert(await js(() => document.querySelectorAll('#emptyState .empty-art').length === 1), `${label}: duplicate empty prompts`);
    const config = JSON.parse(await fs.readFile(path.join(options.directory, 'profile/library-location.json'), 'utf8'));
    assert(config.libraryRoot === expectedRoot, `${label}: real library locator was not persisted`);
  }

  app.setPath('appData', path.join(options.directory, 'app-data'));
  app.setPath('userData', path.join(options.directory, 'profile'));
  app.setPath('sessionData', path.join(options.directory, 'session'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1.5');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  dialog.showErrorBox = (title, content) => errors.push(`${title}: ${content}`);
  dialog.showMessageBox = async (...args) => { throw new Error(`Unexpected message box: ${args.at(-1)?.message}`); };
  dialog.showOpenDialog = async (...args) => {
    const settings = args.at(-1), picker = nextPicker; nextPicker = null;
    if (!picker) throw new Error(`Unexpected folder picker: ${settings.title}`);
    assert(settings.title.includes(picker.expectedTitle), `Wrong folder picker: ${settings.title}`);
    dialogs.push({ title: settings.title, cancelled: Boolean(picker.response.canceled) });
    return picker.response;
  };
  app.on('browser-window-created', (_event, candidate) => {
    candidate.setSkipTaskbar(true);
    candidate.webContents.on('did-finish-load', () => { if (candidate.webContents.getURL().endsWith('/src/index.html')) window = candidate; });
    candidate.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) errors.push(event.message); });
    candidate.webContents.on('preload-error', (_event, file, error) => errors.push(`${file}: ${error.message}`));
    candidate.webContents.on('render-process-gone', (_event, detail) => errors.push(`Renderer exited: ${JSON.stringify(detail)}`));
  });
  process.on('uncaughtException', error => errors.push(error.stack || String(error)));
  process.on('unhandledRejection', error => errors.push(error?.stack || String(error)));
  try {
    assert(!process.env.SHITU_LIBRARY, 'The smoke must never preselect an override library');
    if (options.scene !== 'broken-locator') assert(!await exists(path.join(options.directory, 'profile/library-location.json')), 'The first-start profile already has a library locator');
    require(path.join(options.appRoot, 'src/main.cjs'));
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
    await waitFor(() => window && js(() => Boolean(window.shitu?.getLibrary && typeof state === 'object' && state.library.needsLibrary)).catch(() => false), 'Production app did not enter first-start onboarding');
    assert(app.getPath('userData') === path.join(options.directory, 'profile'), 'Production app escaped the isolated profile');
    assert(!(await js(() => window.shitu.getLibrary())).legacyRoot, 'The smoke unexpectedly discovered a real legacy library');
    window.setMinimumSize(400, 300);
    await capture('initial.png');
    await assertOnboarding('initial');
    checks.push(`real main/index/preload starts without SHITU_LIBRARY and ${options.scene === 'broken-locator' ? 'with an intentionally invalid isolated locator' : 'without a saved locator'}; ordinary emptyState and shell are not displayed`);
    const matrix = options.scene === 'create' ? [
      { width: 1280, height: 800, zoom: 1, skin: 'default' },
      { width: 900, height: 650, zoom: 1, skin: 'default' },
      { width: 900, height: 650, zoom: 1.25, skin: 'default' },
      { width: 1280, height: 800, zoom: 1, skin: 'mac' },
      { width: 900, height: 650, zoom: 1.25, skin: 'mac' },
      { width: 900, height: 650, zoom: 1, skin: 'psp' }
    ] : [{ width: 900, height: 650, zoom: 1.25, skin: options.scene === 'broken-locator' ? 'mac' : 'default' }];
    for (const layout of matrix) {
      window.showInactive();
      window.setContentSize(layout.width, layout.height);
      await js(id => window.ShituSkins.apply(id, { persist: false }), layout.skin);
      window.webContents.setZoomFactor(layout.zoom);
      await waitFor(() => js(layout => Math.abs(innerWidth - layout.width / layout.zoom) <= 2 && Math.abs(innerHeight - layout.height / layout.zoom) <= 2, layout), 'Viewport did not settle to the requested window size and zoom');
      const label = `${layout.width}x${layout.height}-z${layout.zoom}-${layout.skin}`;
      await assertLayout(label); await capture(`${label}.png`);
    }
    checks.push(`${matrix.length} window/zoom/skin configurations at 150% device scaling keep onboarding content separate and actions reachable`);
    if (options.scene === 'broken-locator') {
      const error = await view(); assert(error.errorVisible && error.errorText.length > 240, 'Long startup error was not displayed');
      checks.push('long invalid-locator error remains scrollable and both first-start actions are reachable');
    }
    window.showInactive(); window.setContentSize(1280, 800); window.webContents.setZoomFactor(1);
    await js(() => window.ShituSkins.apply('default', { persist: false }));
    await waitFor(() => js(() => innerWidth === 1280 && innerHeight === 800), 'Normal-size viewport did not settle');
    await select('#setupCreateLibrary', { canceled: true, filePaths: [] }, '存放位置'); await assertOnboarding('cancel-create');
    await select('#setupOpenLibrary', { canceled: true, filePaths: [] }, '已有素材库'); await assertOnboarding('cancel-open');
    checks.push('cancelling either real folder-picker path leaves onboarding usable without creating a library');
    await select('#setupOpenLibrary', { canceled: false, filePaths: [options.invalidLibrary] }, '已有素材库');
    await assertOnboarding('invalid-library');
    assert(await js(() => document.querySelector('.toast.error')?.textContent.includes('素材库')), 'Invalid-library error did not reach the UI');
    await capture('invalid-library.png');
    checks.push('opening an invalid library reports an error and leaves first-start actions usable');
    const { Library } = require(path.join(options.appRoot, 'src/library.cjs'));
    await new Library({ root: options.existingLibrary }).init();
    if (options.scene === 'create') {
      await select('#setupCreateLibrary', { canceled: false, filePaths: [options.createParent] }, '存放位置');
      const created = await js(() => window.shitu.getLibrary());
      assert(created.root && path.dirname(created.root) === options.createParent && !created.needsLibrary, 'Native create did not choose the isolated parent');
      await assertNormalEmpty('created-library', created.root); await capture('created-library.png');
      checks.push('successful first-start creation persists the real locator and displays only the ordinary empty library prompt');
      await js(() => document.querySelector('#libraryInfo').click());
      await select('#managerOpenLibrary', { canceled: false, filePaths: [options.existingLibrary] }, '已有素材库');
    } else await select('#setupOpenLibrary', { canceled: false, filePaths: [options.existingLibrary] }, '已有素材库');
    await assertNormalEmpty('opened-library', options.existingLibrary); await capture('opened-library.png');
    checks.push('opening an existing empty library removes onboarding and displays the correct normal empty-state prompt');
    assert(errors.length === 0, `Production runtime errors: ${errors.join('\n')}`);
    await persist({ ok: true, appRoot: options.appRoot }); app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) observations.push({ label: 'failure-state', ...await view().catch(() => ({})), contentSize: window.getContentSize(), zoomFactor: window.webContents.getZoomFactor() });
    if (window && !window.isDestroyed()) await capture('failure.png').catch(() => {});
    await persist({ ok: false, error: error.stack || String(error), appRoot: options.appRoot }); app.exit(1);
  }
}

async function main() {
  const appRoot = path.resolve(process.env.SHITU_ONBOARDING_APP_ROOT || root);
  const parent = path.join(root, '.recovery/tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'library-onboarding-'));
  const results = [];
  for (const scene of ['create', 'open', 'broken-locator']) {
    const caseRoot = path.join(directory, scene);
    for (const name of ['profile', 'session', 'app-data', 'fixture-app', 'create-parent', 'invalid-library']) await fs.mkdir(path.join(caseRoot, name), { recursive: true });
    const options = { scene, directory: caseRoot, appRoot, createParent: path.join(caseRoot, 'create-parent'), invalidLibrary: path.join(caseRoot, 'invalid-library'), existingLibrary: path.join(caseRoot, 'existing-library') };
    if (scene === 'broken-locator') {
      const missing = path.join(caseRoot, 'missing-library', ...Array.from({ length: 5 }, (_, index) => `${index}-${'long-path-'.repeat(8)}`));
      await fs.writeFile(path.join(caseRoot, 'profile/library-location.json'), JSON.stringify({ version: 1, libraryRoot: missing }));
    }
    await fs.writeFile(path.join(caseRoot, 'options.json'), JSON.stringify(options));
    await fs.writeFile(path.join(caseRoot, 'fixture-app/package.json'), JSON.stringify({ name: 'mosaic-onboarding-smoke', version: require(path.join(appRoot, 'package.json')).version, main: 'main.cjs' }));
    await fs.writeFile(path.join(caseRoot, 'fixture-app/main.cjs'), `require(${JSON.stringify(__filename)}).runProduction(require(${JSON.stringify(path.join(caseRoot, 'options.json'))}));`);
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name === 'ELECTRON_RUN_AS_NODE' || /^SHITU_|^MOSAIC_|SMOKE/.test(name)) delete env[name];
    env.SHITU_PLUGIN_ROOT = path.join(caseRoot, 'plugins');
    const logs = [];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(electronPath(), [path.join(caseRoot, 'fixture-app'), '--background'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Onboarding smoke timed out: ${caseRoot}`)); }, 120000);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => logs.push(bytes.toString()));
      child.on('error', error => { clearTimeout(timeout); reject(error); }); child.on('close', status => { clearTimeout(timeout); resolve(status); });
    });
    await fs.writeFile(path.join(caseRoot, 'electron.log'), logs.join(''));
    const result = JSON.parse(await fs.readFile(path.join(caseRoot, 'result.json'), 'utf8'));
    results.push({ directory: caseRoot, exitCode: code, ...result });
    if (code || !result.ok) break;
  }
  const result = { directory, appRoot, ok: results.length === 3 && results.every(item => item.ok), cases: results };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, appRoot, ok: result.ok, cases: results.map(item => ({ scene: item.scene, ok: item.ok, exitCode: item.exitCode, error: item.error, checks: item.checks.length, screenshots: item.screenshots.length })) }, null, 2)); if (!result.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { runProduction };
