'use strict';

module.exports = function configureWindowHeaderSmoke({ root, base }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const { execFile } = require('node:child_process');
  const { app, dialog, screen, session, shell } = require('electron');
  const fixture = require(path.join(base, 'window-header-smoke-fixture.json'));
  const skins = ['default', 'famicom', 'psp', 'gameboy', 'switch', 'win97', 'win98', 'winxp', 'mac'];
  const nativeProbeEnabled = process.env.SHITU_TEST_WINDOW_HIT_TEST === '1';
  const expectedCorners = {
    default: [8, 8, 8, 8], famicom: [6, 6, 6, 6], psp: [20, 20, 20, 20],
    gameboy: [6, 6, 20, 6], switch: [12, 12, 12, 12], mac: [14, 14, 14, 14],
    win97: [0, 0, 0, 0], win98: [0, 0, 0, 0], winxp: [10, 10, 6, 6]
  };
  const actions = ['#skinButton', '#collectorButton', '#toggleDetails', '#headerMoreButton'];
  const captionButtons = ['#windowMinimize', '#windowMaximize', '#windowClose'];
  const failures = [];
  const network = [];
  const screenshots = [];
  const closeAttempts = [];
  const nativeMessages = [];
  let window;
  let collectorBusy = false;
  let finishing = false;

  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({
    start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => Number(collectorBusy), close: async () => {}
  });
  require(path.join(root, 'src', 'transcode-devices.cjs')).createTranscodeDeviceManager = () => ({
    discover: async () => ({ cpu: { name: 'Test CPU', logicalProcessors: 4 }, gpus: [] }), shutdown: async () => {}
  });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showMessageBox = async (_window, options) => { nativeMessages.push(options.title); return { response: 0 }; };
  dialog.showOpenDialog = async () => { throw new Error('Window header smoke must not open a native file picker'); };
  shell.openPath = shell.openExternal = async () => { throw new Error('Window header smoke must not launch external apps'); };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, respond) => {
    network.push(details.url);
    respond({ cancel: true });
  }));

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait(condition, description, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (!await condition()) {
      if (Date.now() > deadline) throw new Error(description);
      await sleep(40);
    }
  }
  function js(source) { return window.webContents.executeJavaScript(source); }
  function visible(selector) {
    return js(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node?.getBoundingClientRect().height && getComputedStyle(node).visibility === 'visible'); })()`);
  }
  function maximizeGlyph(expanded) {
    const icon = expanded ? 'restore' : 'maximize';
    const other = expanded ? 'maximize' : 'restore';
    return js(`getComputedStyle(document.querySelector('#windowMaximize .window-${icon}-icon')).display !== 'none' &&
      getComputedStyle(document.querySelector('#windowMaximize .window-${other}-icon')).display === 'none'`);
  }
  async function click(selector) {
    const point = await js(`(async () => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing ' + ${JSON.stringify(selector)});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = node.getBoundingClientRect();
      const x = Math.round((rect.left + rect.right) / 2), y = Math.round((rect.top + rect.bottom) / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Covered or invisible ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }
  async function press(keyCode) {
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }
  async function capture(filename) {
    await sleep(100);
    const image = await window.webContents.capturePage();
    assert.ok(!image.isEmpty(), `No image captured for ${filename}`);
    fs.writeFileSync(path.join(base, filename), image.toPNG());
    screenshots.push(filename);
  }
  async function fail(error) {
    if (finishing) return;
    finishing = true;
    let diagnostic;
    if (window && !window.isDestroyed()) {
      try {
        diagnostic = await js(`({skin:document.documentElement.dataset.skin,width:innerWidth,height:innerHeight,controls:document.querySelector('#windowControls')?.outerHTML,header:document.querySelector('.app-header')?.outerHTML,menu:document.querySelector('#headerMenu')?.outerHTML})`);
        await capture('failure.png');
      } catch {}
    }
    fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), failures, network, diagnostic, screenshots, closeAttempts, nativeMessages }, null, 2));
    app.exit(1);
  }

  function layout() {
    return js(`(() => {
      const rectFor = selector => {
        const node = document.querySelector(selector);
        if (!node) throw new Error('Missing ' + selector);
        const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const x = Math.round(left + width / 2), y = Math.round(top + height / 2);
        return { selector, left, top, right, bottom, width, height, hits: node.contains(document.elementFromPoint(x,y)), drag: style.getPropertyValue('app-region') || style.getPropertyValue('-webkit-app-region') };
      };
      const selectors = ${JSON.stringify(['.app-header', '.header-identity', '.header-drag-space', '#windowControls', ...actions, ...captionButtons])};
      return { width:innerWidth, height:innerHeight, overflow:document.documentElement.scrollWidth - innerWidth, parts:Object.fromEntries(selectors.map(selector => [selector,rectFor(selector)])) };
    })()`);
  }
  function checkLayout(value) {
    const { width, height, overflow, parts } = value;
    const header = parts['.app-header'];
    assert.ok(header.height >= 32 && header.height <= 60, `Header is not compact (${header.height}px)`);
    assert.ok(header.left <= 1 && header.right >= width - 1, 'Header does not span the window');
    assert.ok(overflow <= 1, 'Window header caused horizontal overflow');
    const controls = parts['#windowControls'];
    const identity = parts['.header-identity'];
    const drag = parts['.header-drag-space'];
    assert.ok(identity.width >= 95 && identity.left < 36 && identity.right <= controls.left, 'Library identity is out of position');
    assert.ok(drag.width >= 20, 'Window has no meaningful free dragging area');
    assert.ok([drag.drag, header.drag].includes('drag'), 'Window header is missing an Electron drag region');
    for (const selector of [...actions, ...captionButtons]) {
      const part = parts[selector];
      assert.ok(part.width >= 20 && part.height >= 22 && part.left >= 0 && part.right <= width + 1 && part.top >= 0 && part.bottom <= Math.min(height, header.bottom + 1), `${selector} is outside the header`);
      assert.ok(part.hits, `${selector} is covered by the header`);
    }
    for (const selector of actions) assert.ok(parts[selector].right <= controls.left + 1, `${selector} overlaps caption controls`);
    for (let i = 1; i < captionButtons.length; i++) {
      assert.ok(parts[captionButtons[i - 1]].right <= parts[captionButtons[i]].left + 1, 'Caption buttons overlap');
    }
  }

  async function checkPinnedWorkspace(expectDetails) {
    const geometry = await js(`(() => {
      const rect = selector => {
        const node = document.querySelector(selector);
        const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
        const hit = node.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
        return { left, right, top, bottom, width, height, hit };
      };
      const padding = selector => {
        const node = document.querySelector(selector);
        const style = getComputedStyle(node);
        return [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)];
      };
      const sections = ['.collection-navigation', '.toolbar', '.search-box', '.folder-navigation', '#galleryScroller', '.workspace-footer'];
      const controls = ['#searchInput', '#formatFilter', '#sortSelect', '#sizeSlider', '#selectionModeButton', '#importFolder', '#importFiles', '#createFolderHere'];
      const active = '#mainNav .nav-item.active';
      const insetControls = controls.filter(selector => selector !== '#sizeSlider');
      return {
        skin: document.documentElement.dataset.skin, width: innerWidth, height: innerHeight,
        overflow: document.documentElement.scrollWidth - innerWidth,
        header: rect('.app-header'),
        sidebar: rect('#folderSidebar'), workspace: rect('.workspace'), details: rect('#detailsPanel'),
        sidebarRadius: getComputedStyle(document.querySelector('#folderPanel')).borderTopLeftRadius,
        active: rect(active), label: rect(active + ' .nav-name'), count: rect(active + ' .nav-count'),
        breadcrumb: rect('#folderBreadcrumbs'), back: rect('.folder-navigation-actions'),
        sections: Object.fromEntries(sections.map(selector => [selector, rect(selector)])),
        controls: Object.fromEntries(controls.map(selector => [selector, rect(selector)])),
        padding: Object.fromEntries(insetControls.map(selector => [selector, padding(selector)]))
      };
    })()`);
    const { skin, width, height, overflow, header, sidebar, workspace, details, active, label, count, sections, controls, padding, breadcrumb, back, sidebarRadius } = geometry;
    const inset = active.left - workspace.left;
    assert.equal(details.height > 0, expectDetails, 'Details panel visibility does not match the layout under test');
    const panes = [sidebar, workspace, ...(details.height ? [details] : [])];
    for (const pane of panes) {
      assert.ok(pane.height > 0 && pane.top >= header.bottom && pane.bottom <= height, 'A workspace pane is clipped by the window');
      assert.ok(Math.abs(workspace.top - pane.top) <= 1 && Math.abs(workspace.bottom - pane.bottom) <= 1, 'Workspace and sidebars have mismatched vertical edges');
    }
    if (skin === 'win97' || skin === 'win98') {
      assert.ok(parseFloat(sidebarRadius) <= 2, 'Classic folder panel has rounded corners');
    }
    assert.ok(inset >= 11 && inset <= 24, `Active navigation tab sits ${inset}px from the workspace edge`);
    assert.ok(workspace.left > sidebar.right && (!details.right || workspace.right < details.left), 'Pinned workspace overlaps a sidebar');
    assert.ok(overflow <= 1, 'Pinned workspace causes horizontal overflow');
    assert.ok(label.left - active.left >= 7 && active.right - count.right >= 7, 'Active navigation label or count touches the highlighted edge');
    assert.ok(label.right < count.left, 'Active navigation label overlaps the count');
    for (const [selector, bounds] of Object.entries(sections)) {
      assert.ok(Math.abs(bounds.left - active.left) <= 1, `${selector} does not share the navigation inset`);
      assert.ok(bounds.right <= workspace.right - inset + 1, `${selector} overflows the right workspace inset`);
    }
    for (const [selector, bounds] of Object.entries(controls)) {
      assert.ok(bounds.width > 0 && bounds.height > 0 && bounds.hit, `${selector} is covered or hidden`);
      assert.ok(bounds.left >= workspace.left + inset - 1 && bounds.right <= workspace.right - inset + 1,
        `${selector} sticks out of the toolbar`);
      assert.ok(bounds.top >= workspace.top && bounds.bottom <= height, `${selector} falls outside the visible workspace`);
    }
    for (const [selector, edges] of Object.entries(padding)) {
      assert.ok(edges.every(edge => edge >= 6), `${selector} has cramped horizontal padding (${edges.join(', ')}px)`);
    }
    if (width >= 1300) {
      const breadcrumbCenter = (breadcrumb.top + breadcrumb.bottom) / 2;
      const backCenter = (back.top + back.bottom) / 2;
      assert.ok(Math.abs(breadcrumbCenter - backCenter) <= 1 && breadcrumb.left > back.right, 'Wide folder navigation does not fit on one row');
    } else {
      assert.ok(breadcrumb.top >= back.bottom && Math.abs(breadcrumb.left - active.left) <= 1, 'Compact breadcrumbs do not align below the folder navigation buttons');
    }
    await click('#selectionModeButton');
    await wait(() => js(`document.querySelector('#selectionModeButton').getAttribute('aria-pressed') === 'true'`), 'Toolbar click did not enter selection mode');
    await click('#selectionModeButton');
    await wait(() => js(`document.querySelector('#selectionModeButton').getAttribute('aria-pressed') === 'false'`), 'Toolbar click did not restore browse mode');
    return { inset, labelInset: label.left - active.left, countInset: active.right - count.right, sidebarRadius, importFolderPadding: padding['#importFolder'] };
  }

  async function checkPinnedSkins(label, expectDetails) {
    const layouts = {};
    for (const skin of skins) {
      await js(`ShituSkins.apply(${JSON.stringify(skin)})`);
      try {
        layouts[skin] = await checkPinnedWorkspace(expectDetails);
        await capture(`header-${skin}-pinned-${label}.png`);
      } catch (error) {
        throw new Error(`Pinned ${label} layout for ${skin}: ${error.message}`, { cause: error });
      }
    }
    return layouts;
  }

  function contrastRatio(foreground, background) {
    const luminance = color => {
      const channels = color.match(/\d+(?:\.\d+)?/g).map(Number);
      assert.equal(channels.length, 3, `Expected an opaque sRGB color, got ${color}`);
      const linear = channels.map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  async function probeNativeWindow() {
    const { left, top, width, height } = (await layout()).parts['.header-drag-space'];
    const { x, y } = window.getContentBounds();
    const position = screen.dipToScreenPoint({ x: Math.round(x + left + width / 2), y: Math.round(y + top + height / 2) });
    const handleBytes = window.getNativeWindowHandle();
    const handle = handleBytes.length === 8 ? handleBytes.readBigUInt64LE() : handleBytes.readUInt32LE();
    const source = fs.readFileSync(path.join(root, 'scripts', 'probe-windows-window-shape.ps1'), 'utf8');
    const script = `& {\n${source}\n} -Handle ${handle} -DragX ${position.x} -DragY ${position.y}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const raw = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 8000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Native window probe failed: ${stderr || error.message}`));
        else resolve(stdout);
      });
    });
    return JSON.parse(raw.trim());
  }

  async function probeNativeDragging() {
    if (!nativeProbeEnabled) return undefined;
    const result = await probeNativeWindow();
    assert.equal(result.drag, 2, 'Windows did not recognize the header drag area');
    assert.equal(result.leftEdge, 10, 'Windows did not recognize the resize edge');
    assert.ok(result.clientEdgeInRegion, 'The rounded region clips the left client edge');
    assert.ok(result.leftResizePixels >= 2, 'The rounded region hides the resize edge');
    return { drag: result.drag, leftEdge: result.leftEdge, clientLeftEdge: result.clientLeftEdge, clientDiagonal: result.clientDiagonal, leftResizePixels: result.leftResizePixels };
  }

  async function checkNativeCorners(skin, label, expanded = false) {
    if (!nativeProbeEnabled) return undefined;
    const radii = expanded ? [0, 0, 0, 0] : expectedCorners[skin];
    const actual = await probeNativeWindow();
    const description = `${skin} ${label}`;
    if (actual.dwmCornerPreference !== null) {
      assert.equal(actual.dwmCornerPreference, 1, `${description} is affected by system corner rounding`);
    }
    if (!radii.some(Boolean)) {
      assert.equal(actual.shape, 0, `${description} has a custom clipping region`);
      return { dpi: actual.dpi, shape: actual.shape, dwmCornerPreference: actual.dwmCornerPreference };
    }

    assert.equal(actual.shape, 3, `${description} is missing a native rounded region`);
    const scale = actual.dpi / 96;
    const { Left, Top, Right, Bottom } = actual.regionBounds;
    assert.ok(Left <= actual.client.Left - actual.bounds.Left + 1, `${description} clips the left client edge`);
    assert.ok(Top <= actual.client.Top - actual.bounds.Top + 1, `${description} clips the top client edge`);
    assert.ok(Right >= actual.client.Right - actual.bounds.Left - 1, `${description} clips the right client edge`);
    assert.ok(Bottom >= actual.client.Bottom - actual.bounds.Top - 1, `${description} clips the bottom client edge`);
    for (const [corner, radius] of radii.entries()) {
      const insets = actual.cornerInsets[corner];
      const base = Math.max(...insets.slice(-3));
      const first = insets[0] - base;
      assert.ok(first > 0, `${description} corner ${corner + 1} is square`);
      for (let row = 0; row < insets.length; row++) {
        const level = Math.max(0, radius - (row + 0.5) / scale);
        const inset = (radius - Math.sqrt(radius ** 2 - level ** 2)) * scale;
        assert.ok(Math.abs(insets[row] - base - inset) <= scale * 2, `${description} corner ${corner + 1} differs from ${radius}px at row ${row}: ${insets.join(',')}`);
      }
    }
    return { dpi: actual.dpi, shape: actual.shape, dwmCornerPreference: actual.dwmCornerPreference, regionBounds: actual.regionBounds, cornerInsets: actual.cornerInsets.map(insets => insets.slice(0, insets.findLastIndex(Boolean) + 1)) };
  }

  app.on('browser-window-created', (_event, candidate) => candidate.webContents.once('did-finish-load', async () => {
    if (window || !candidate.webContents.getURL().endsWith('/src/index.html')) return;
    window = candidate;
    window.show = () => {};
    window.setSkipTaskbar(true);
    window.setOpacity(0);
    window.setContentSize(1080, 700);
    window.showInactive();
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('render-process-gone', (_event, detail) => failures.push(`Renderer exited: ${detail.reason}`));
    window.on('close', event => closeAttempts.push({ prevented: event.defaultPrevented }));

    try {
      assert.equal(app.getPath('userData'), path.join(base, 'profile'));
      const sample = await js(`(async () => {
        const before = await api.getLibrary();
        if (before.assets.length) throw new Error('Not isolated');
        const result = await api.importPaths([${JSON.stringify(fixture.sample)}]);
        applyLibrary(result.snapshot, false);
        toggleDetails(false);
        setThumbnailSize(200);
        return result.snapshot.assets[0];
      })()`);
      assert.ok(sample?.id, 'Sample import failed');
      await wait(() => visible('#windowControls'), 'Window controls did not load');
      assert.equal((await js('api.windowState()')).customControls, true);
      const libraryLabels = [
        ['D:\\工作\\拾图素材库', 'Mosaic 素材库'],
        ['D:\\工作\\拾图素材库 2\\', 'Mosaic 素材库 2'],
        ['D:\\工作\\拾图素材库 10000', 'Mosaic 素材库 10000'],
        ['D:\\工作\\拾图素材库 1', '拾图素材库 1'],
        ['D:\\工作\\拾图素材库项目', '拾图素材库项目'],
        ['D:\\工作\\客户素材库', '客户素材库'],
        ['D:\\工作\\Mosaic 素材库', 'Mosaic 素材库']
      ];
      const renderedLabels = await js(`(() => {
        const original = state.library.root;
        try {
          return ${JSON.stringify(libraryLabels.map(([root]) => root))}.map(root => {
            state.library.root = root;
            renderLibraryState();
            return {
              label: document.getElementById('libraryDisplayName').textContent,
              path: document.getElementById('managerLibraryPath').textContent,
              tooltip: document.getElementById('libraryInfo').title
            };
          });
        } finally {
          state.library.root = original;
          renderLibraryState();
        }
      })()`);
      assert.deepEqual(renderedLabels, libraryLabels.map(([root, label]) => ({ label, path: root, tooltip: `管理「${label}」\n${root}` })));

      const descriptors = [];
      const nativeCorners = {};
      for (const skin of skins) {
        await click('#skinButton');
        await wait(() => visible('#skinPickerOverlay'), 'Skin picker did not open');
        await click(`#skinPickerOverlay [data-skin-id="${skin}"]`);
        await wait(() => js(`document.documentElement.dataset.skin === ${JSON.stringify(skin)}`), `Skin ${skin} did not apply`);
        await click('#skinPickerClose');
        await wait(async () => !await visible('#skinPickerOverlay'), 'Skin picker did not close');
        const geometry = await layout();
        checkLayout(geometry);
        assert.ok(Math.abs(geometry.width - 1080) <= 3 && Math.abs(geometry.height - 700) <= 3, `Native DPI rounding changed the narrow viewport to ${geometry.width}×${geometry.height}`);
        const captionStyles = await js(`(() => ${JSON.stringify(captionButtons)}.map(selector => {
          const node = document.querySelector(selector);
          const css = getComputedStyle(node);
          return [css.color, css.backgroundColor, css.backgroundImage, css.borderRadius, css.boxShadow].join('|');
        }))()`);
        descriptors.push({ skin, captionStyles });
        if (skin === 'famicom') {
          const [icon, label] = await js(`['#libraryInfo .library-icon .icon', '#libraryDisplayName'].map(selector => getComputedStyle(document.querySelector(selector)).color)`);
          assert.equal(icon, label, 'Famicom library icon does not use the header text color');
        }
        await capture(`header-${skin}-1080x700.png`);
        nativeCorners[skin] = await checkNativeCorners(skin, 'at compact size');
      }
      assert.ok(new Set(descriptors.map(descriptor => descriptor.captionStyles.join())).size >= 8, 'Caption buttons do not distinguish the skin designs');

      await js(`(async () => {
        applyLibrary(await api.createFolder('参考素材'), false);
        setFolderPanelMode('sidebar');
        toggleDetails(true);
      })()`);
      const narrowPinnedSkins = await checkPinnedSkins('1080x700', true);
      window.setContentSize(1600, 900);
      await wait(() => js('innerWidth >= 1440 && innerHeight >= 800'), 'Wide pinned layout did not resize');
      await js('toggleDetails(false)');
      const widePinnedSkins = await checkPinnedSkins('wide', false);
      window.setContentSize(1080, 700);
      await wait(() => js('innerWidth <= 1083 && innerHeight <= 703'), 'Compact pinned layout did not resize back');

      await js(`setFolderPanelMode('dropdown'); toggleDetails(false); render();`);

      window.setContentSize(1600, 900);
      await wait(() => js('innerWidth >= 1440 && innerHeight >= 800'), 'Wide window layout did not resize');
      checkLayout(await layout());
      const nativeHitTest = await probeNativeDragging();
      nativeCorners.resized = await checkNativeCorners('mac', 'after widening');
      await click('#headerMoreButton');
      await wait(() => visible('#headerMenu'), 'More controls did not open');
      const menuBackground = await js(`getComputedStyle(document.querySelector('#headerMenu')).backgroundColor`);
      assert.match(menuBackground, /^rgb\(/, 'More tools menu background is translucent');
      for (const selector of ['#settingsButton', '#appUpdateButton', '#backupButton', '#pluginCenterButton', '#backgroundMotionButton']) {
        assert.ok(await visible(`#headerMenu ${selector}`), `Missing or hidden menu action: ${selector}`);
      }
      await capture('header-mac-menu-wide.png');
      await press('Escape');
      await wait(async () => !await visible('#headerMenu'), 'Escape did not dismiss the menu');
      await click('#headerMoreButton');
      await wait(() => visible('#headerMenu'), 'More controls did not reopen');
      await click('#settingsButton');
      await wait(() => visible('#transcodeSettingsOverlay'), 'More menu did not open device settings');
      await wait(() => js(`document.querySelector('#transcodeSettingsCpuName').textContent === 'Test CPU'`), 'Device settings did not read the isolated device information');
      assert.ok(!await visible('#headerMenu'), 'More menu remained open behind device settings');
      await press('Escape');
      await wait(async () => !await visible('#transcodeSettingsOverlay'), 'Device settings did not close');

      await js(`openPreview(${JSON.stringify(sample.id)})`);
      await wait(() => visible('#preview'), 'Sample preview did not open');
      for (const skin of ['winxp', 'mac']) {
        await js(`ShituSkins.apply(${JSON.stringify(skin)})`);
        const [title, surface] = await js(`[
          getComputedStyle(document.querySelector('#previewName')).color,
          getComputedStyle(document.querySelector('.preview-top')).backgroundColor
        ]`);
        assert.ok(contrastRatio(title, surface) >= 4.5, `${skin} preview title is hard to read`);
      }
      assert.ok(await visible('#windowControls'), 'Preview hides caption buttons');
      await click('#windowMaximize');
      await wait(() => window.isMaximized(), 'Caption did not maximize the native window');
      await wait(() => js(`document.querySelector('#windowMaximize').getAttribute('aria-label')?.includes('还原')`), 'Restore action not reflected in the caption button');
      assert.equal((await js('api.windowState()')).maximized, true);
      assert.ok(await maximizeGlyph(true), 'Maximized button still shows the maximize glyph');
      assert.ok(await visible('#preview'), 'Maximizing lost the active preview');
      nativeCorners.maximized = await checkNativeCorners('mac', 'maximized', true);
      await click('#windowMaximize');
      await wait(() => !window.isMaximized(), 'Caption did not restore the native window');
      await wait(() => js(`document.querySelector('#windowMaximize').getAttribute('aria-label')?.includes('最大化')`), 'Maximize action not reflected after restoring');
      assert.ok(await maximizeGlyph(false), 'Restored button still shows the restore glyph');
      nativeCorners.restored = await checkNativeCorners('mac', 'after restoring');
      await press('Escape');
      await wait(async () => !await visible('#preview'), 'Sample preview did not close');

      await click('#skinButton');
      await wait(() => visible('#skinPickerOverlay'), 'Skin picker did not reopen');
      await click('#windowMinimize');
      await wait(() => window.isMinimized(), 'Caption did not minimize the native window');
      window.restore();
      await wait(() => !window.isMinimized(), 'Native restore failed after caption minimization');
      assert.ok(await visible('#skinPickerOverlay'), 'Window minimization discarded the open modal');
      await click('#skinPickerClose');

      if (nativeProbeEnabled) {
        window.setFullScreen(true);
        await wait(() => window.isFullScreen(), 'The test window could not enter fullscreen');
        nativeCorners.fullscreen = await checkNativeCorners('mac', 'fullscreen', true);
        window.setFullScreen(false);
        await wait(() => !window.isFullScreen(), 'The test window could not exit fullscreen');
        nativeCorners.afterFullscreen = await checkNativeCorners('mac', 'after leaving fullscreen');

        const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
        window.webContents.reload();
        await reloaded;
        await wait(() => js(`document.documentElement.dataset.skin === 'mac'`), 'Reload did not restore the selected skin');
        nativeCorners.afterReload = await checkNativeCorners('mac', 'after reloading the renderer');
      }

      collectorBusy = true;
      await click('#windowClose');
      await wait(() => nativeMessages.length === 1, 'Closing during an asset task bypassed the existing close guard');
      assert.ok(!window.isDestroyed());
      collectorBusy = false;
      assert.deepEqual(failures, []);
      assert.deepEqual(network, []);
      window.once('closed', () => {
        finishing = true;
        const normalClose = closeAttempts.length === 3 && closeAttempts[0].prevented && closeAttempts[1].prevented && !closeAttempts[2].prevented;
        const result = { ok: normalClose, compactHeaderAtBothWidths: true, pinnedSidebarAndDetailsFit: true, captionStyles: descriptors, draggableHeader: true, nativeHitTest, nativeCorners, groupedMenuKeyboardDismissed: true, deviceSettingsOpensFromMenu: true,
          narrowPinnedSkins, widePinnedSkins,
          nativeMaximizeAndRestore: true, nativeMinimizeAndRestore: true, captionWorksInPreviewAndModal: true,
          existingCloseGuardHonored: normalClose, nativeMessages, networkRequests: network.length, screenshots };
        fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
        if (!normalClose) app.exit(1);
      });
      await click('#windowClose');
    } catch (error) {
      await fail(error);
    }
  }));
};
