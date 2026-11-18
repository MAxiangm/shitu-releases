'use strict';
module.exports = function configureSkinsSmoke({ root, base }) {
  const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
  const sharp = require('sharp'), assert = require('node:assert/strict');
  const { app, dialog, session, shell } = require('electron');
  const fixture = require(path.join(base, 'skins-smoke-fixture.json'));
  const expectedSkins = ['default', 'famicom', 'psp', 'gameboy', 'switch', 'win97', 'win98', 'winxp', 'mac'];
  const failures = [], network = [], screenshots = [], contrastWarnings = [];
  let started = false, finished = false, window;
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows'); app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, text) => failures.push(`${title}: ${text}`);
  dialog.showOpenDialog = async () => { throw new Error('Skin smoke must not open native file pickers'); };
  shell.openPath = shell.openExternal = async () => { throw new Error('Skin smoke must not launch external apps'); };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); }));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (predicate, label, timeout = 20000) => { const deadline = Date.now() + timeout; while (!await predicate()) { if (Date.now() > deadline) throw new Error(label); await sleep(25); } };
  const fail = async error => {
    if (finished) return; finished = true;
    let diagnostic;
    try { diagnostic = await window.webContents.executeJavaScript(`({skin:document.documentElement.dataset.skin,stored:localStorage.getItem('shitu-skin'),picker:document.getElementById('skinPickerOverlay')?.outerHTML,body:document.body.textContent.slice(-1500)})`); } catch {}
    try { await fs.writeFile(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {}
    await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), failures, network, diagnostic, screenshots, contrastWarnings }, null, 2)); app.exit(1);
  };
  app.on('browser-window-created', (_event, candidate) => candidate.webContents.once('did-finish-load', async () => {
    if (started || !candidate.webContents.getURL().endsWith('/src/index.html')) return; started = true; window = candidate;
    window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.setContentSize(1080, 700); window.showInactive(); window.webContents.setBackgroundThrottling(false);
    window.webContents.on('render-process-gone', (_event, detail) => failures.push(`Renderer exited: ${detail.reason}`));
    const js = async code => { try { return await window.webContents.executeJavaScript(code); } catch (error) { throw new Error(`${error.message}\nRenderer: ${code.slice(0, 400)}`); } };
    const visible = id => js(`(()=>{const n=document.getElementById(${JSON.stringify(id)});return Boolean(n&&!n.hidden&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden');})()`);
    const point = selector => js(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),left=Math.max(0,b.left),right=Math.min(innerWidth,b.right),top=Math.max(0,b.top),bottom=Math.min(innerHeight,b.bottom);if(right<=left||bottom<=top)throw Error('Invisible '+${JSON.stringify(selector)});for(const fy of [.5,.15,.85])for(const fx of [.5,.15,.85]){const x=Math.round(left+(right-left)*fx),y=Math.round(top+(bottom-top)*fy),hit=document.elementFromPoint(x,y);if(hit&&n.contains(hit))return{x,y};}throw Error('Covered '+${JSON.stringify(selector)});})()`);
    const click = async (selector, modifiers = []) => { const location = await point(selector); window.webContents.sendInputEvent({ type: 'mouseMove', ...location }); window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, modifiers, ...location }); window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, modifiers, ...location }); await sleep(70); };
    const key = async keyCode => { window.webContents.focus(); window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(70); };
    const capture = async filename => { window.webContents.invalidate(); await sleep(100); const image = await window.webContents.capturePage(); assert.equal(image.isEmpty(), false); await fs.writeFile(path.join(base, filename), image.toPNG()); screenshots.push(filename); return image; };
    const setSkin = async skin => {
      await click('#skinButton'); await wait(() => visible('skinPickerOverlay'), 'Skin picker did not open');
      await click(`#skinPickerOverlay [data-skin-id="${skin}"]`);
      await wait(() => js(`(document.documentElement.dataset.skin||'default')===${JSON.stringify(skin)}`), `Skin ${skin} did not apply`);
      assert.equal(await js("localStorage.getItem('shitu-skin')"), skin);
      if (await visible('skinPickerOverlay')) await click('#skinPickerClose');
      await wait(async () => !await visible('skinPickerOverlay'), 'Skin picker did not close'); await sleep(100);
    };
    const contrast = selector => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const rgba=s=>{const a=s.match(/[\\d.]+/g)?.map(Number)||[0,0,0];return[a[0],a[1],a[2],a[3]??1]};let bg=[0,0,0,1],chain=[],gradientApproximate=false;for(let p=n;p;p=p.parentElement)chain.unshift(p);for(const p of chain){const st=getComputedStyle(p),c=rgba(st.backgroundColor);if(c[3]===1)gradientApproximate=false;if(st.backgroundImage!=='none')gradientApproximate=true;bg=[0,1,2].map(i=>Math.round(c[i]*c[3]+bg[i]*(1-c[3]))).concat(1)}const fg=rgba(getComputedStyle(n).color),rgb=[0,1,2].map(i=>fg[i]*fg[3]+bg[i]*(1-fg[3]));const l=a=>a.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);const x=l(rgb),y=l(bg);return {selector:${JSON.stringify(selector)},text:getComputedStyle(n).color,background:bg.slice(0,3),ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05),gradientApproximate};})()`);
    try {
      assert.equal(app.getPath('userData'), path.join(base, 'profile'));
      const initial = await js(`(async()=>{const before=await api.getLibrary();if(before.assets.length)throw Error('Not isolated');const r=await api.importPaths(${JSON.stringify(fixture.samples.map(sample => sample.filename))});applyLibrary(r.snapshot,false);toggleDetails(false);setThumbnailSize(170);render();return{root:state.library.root,assets:state.library.assets};})()`);
      assert.equal(initial.assets.length, 4);
      const images = initial.assets.filter(asset => asset.ext === 'png'), fonts = initial.assets.filter(asset => asset.mediaType === 'font');
      const skins = [];
      for (const skin of expectedSkins) {
        await setSkin(skin);
        const geometry = await js(`(()=>{const n=document.getElementById('skinButton'),b=n.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth};})()`);
        assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height, `${skin}: skin button outside window`);
        assert.ok(geometry.scroll <= geometry.width, `${skin}: horizontal window overflow`);
        const style = await js("(()=>{const n=getComputedStyle(document.documentElement),h=getComputedStyle(document.querySelector('.app-header'));return{background:n.getPropertyValue('--skin-bg').trim()||n.getPropertyValue('--bg').trim(),text:n.getPropertyValue('--skin-text').trim()||n.getPropertyValue('--text').trim(),header:h.backgroundImage,border:h.borderStyle,font:getComputedStyle(document.body).fontFamily};})()");
        for (const selector of ['#skinButton', '#libraryInfo .library-icon', '#toggleDetails', '#mainNav .nav-item.active']) { const result = await contrast(selector); if (result && result.ratio < 3) contrastWarnings.push({ skin, ...result }); }
        if (skin !== 'default') {
          assert.equal(await js("document.getElementById('ambientParticles').dataset.status"), 'skin-paused', `${skin}: particle animation did not stop`);
          const beforeFrame = await js("document.getElementById('ambientParticles').dataset.frame"); await sleep(130);
          assert.equal(await js("document.getElementById('ambientParticles').dataset.frame"), beforeFrame, `${skin}: particle frames kept drawing`);
        }
        const filters = await js("[...document.querySelectorAll('.asset-thumb img')].map(n=>({filter:getComputedStyle(n).filter,mix:getComputedStyle(n).mixBlendMode,opacity:getComputedStyle(n).opacity}))");
        assert.ok(filters.every(value => value.filter === 'none' && value.mix === 'normal' && Number(value.opacity) === 1), `${skin}: thumbnail colors were altered`);
        await capture(`skin-${skin}-1080x700.png`); skins.push({ id: skin, ...style });
      }
      assert.ok(new Set(skins.slice(1).map(skin => JSON.stringify(skin))).size >= 7, 'Skin appearances are insufficiently distinct');
      await click('#skinButton'); await wait(() => visible('skinPickerOverlay'), 'Picker absent for screenshot'); await capture('skin-picker-1080x700.png'); await key('Escape');
      assert.equal(await visible('skinPickerOverlay'), false, 'Escape did not close skin picker');
      const reload = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.webContents.reload(); await reload;
      await wait(() => js("state.library.assets.length===4&&(document.documentElement.dataset.skin||'default')==='mac'"), 'Skin selection did not survive reload');
      assert.equal(await js("localStorage.getItem('shitu-skin')"), 'mac');
      await js(`state.selected=new Set(${JSON.stringify(images.map(asset => asset.id))});renderSelection();`);
      for (const skin of ['win98', 'gameboy', 'switch', 'mac']) {
        await setSkin(skin); await click('#batchRenameSelection'); await wait(() => visible('batchRenameOverlay'), 'Batch rename did not open');
        await click('#batchRenamePrefix');
        const field = await contrast('#batchRenamePrefix'); if (field?.ratio < 4.5) contrastWarnings.push({ skin, dialog: 'batchRename', ...field });
        const header = await contrast('#batchRenameOverlay h2'); if (header?.ratio < 3) contrastWarnings.push({ skin, dialog: 'batchRename', ...header });
        await capture(`skin-${skin}-batch-1080x700.png`); await key('Escape'); assert.equal(await js('batchRenameUi.isOpen()'), false);
        if (!await js("document.getElementById('folderBrowser').open||folderPanelMode==='sidebar'")) await click('#folderBrowserToggle');
        await click('#newSmartFolder'); await wait(() => js('smartFoldersUi.isOpen()'), 'Smart folder editor did not open');
        await click('#smartFolderSearch');
        const smartField = await contrast('#smartFolderSearch'); if (smartField?.ratio < 4.5) contrastWarnings.push({ skin, dialog: 'smartFolder', ...smartField });
        await capture(`skin-${skin}-smart-1080x700.png`); await key('Escape'); assert.equal(await js('smartFoldersUi.isOpen()'), false);
        await js("document.getElementById('folderBrowser').open=false");
      }
      const red = images.find(asset => asset.name === 'Skin_red'); assert.ok(red);
      const mediaPixels = [];
      for (const skin of ['gameboy', 'mac']) {
        await setSkin(skin); await js(`openPreview(${JSON.stringify(red.id)});cylinderPreview.enterSingle(${JSON.stringify(red.id)});`);
        await wait(() => js("document.getElementById('previewImage').naturalWidth===300&&!document.getElementById('previewImage').classList.contains('hidden')"), 'Original image did not load');
        await sleep(200);
        const info = await js("(()=>{const n=document.getElementById('previewImage'),b=n.getBoundingClientRect(),filters=[];for(let p=n;p;p=p.parentElement){const s=getComputedStyle(p);filters.push({filter:s.filter,mix:s.mixBlendMode})}return{x:b.left+b.width/2,y:b.top+b.height/2,width:innerWidth,height:innerHeight,filters};})()");
        assert.ok(info.filters.every(value => value.filter === 'none' && value.mix === 'normal'), `${skin}: preview ancestor changes media colors`);
        const captureImage = await capture(`skin-${skin}-media-1080x700.png`), png = captureImage.toPNG();
        const dimensions = await sharp(png).metadata(), scale = dimensions.width / info.width;
        const pixel = [...await sharp(png).extract({ left: Math.floor(info.x * scale), top: Math.floor(info.y * scale), width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
        assert.ok(pixel.slice(0, 3).every((channel, index) => Math.abs(channel - [232, 65, 55][index]) <= 8), `${skin}: screenshot original color differs: ${pixel}`);
        mediaPixels.push({ skin, pixel }); await js('closePreview()');
        await js(`state.selected=new Set(${JSON.stringify(fonts.map(asset => asset.id))});renderSelection();`); await click('#compareFontsSelection');
        await wait(() => js("document.querySelectorAll('#fontCompareGrid [data-status=ready]').length===2"), 'Font comparison did not load');
        assert.ok(await js("[...document.querySelectorAll('#fontCompareGrid [data-font-sample]')].every(n=>getComputedStyle(n).fontFamily.includes('shitu-compare-'))"), `${skin}: skin replaced actual preview fonts`);
        await capture(`skin-${skin}-font-compare-1080x700.png`); await key('Escape');
      }
      await setSkin('default');
      await click('#backgroundMotionButton');
      assert.equal(await js("localStorage.getItem('shitu-background-motion')"), 'off');
      await setSkin('psp'); await setSkin('default');
      assert.equal(await js("localStorage.getItem('shitu-background-motion')"), 'off', 'Skin switching changed the saved motion preference');
      assert.equal(await js("document.getElementById('backgroundMotionButton').getAttribute('aria-pressed')"), 'false');
      assert.equal(await js("document.getElementById('ambientParticles').dataset.status"), 'paused');
      for (const asset of initial.assets) assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(initial.root, asset.filename))).digest('hex'), asset.hash);
      assert.deepEqual(failures, []); assert.deepEqual(network, []);
      const result = { ok: true, skins, pickerKeyboardClose: true, selectionSurvivesReload: true, skinControlsRemainClickable: true,
        dialogsClickable: true, fontPreviewTypefaceRetained: true, mediaColorsUnchanged: true, mediaPixels, staticSkinsStopDrawingParticles: true,
        returningToDefaultPreservesMotionPreference: true, managedOriginalHashesMatch: true, networkRequests: 0, screenshots, contrastWarnings };
      await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2)); finished = true; window.destroy(); app.quit();
    } catch (error) { await fail(error); }
  }));
};
