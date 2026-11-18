'use strict';
module.exports = function configureTranscodeSmoke({ root, base }) {
  const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
  const assert = require('node:assert/strict');
  const { spawnSync } = require('node:child_process');
  const { app, dialog, session, shell, Menu } = require('electron');
  const fixture = require(path.join(base, 'transcode-smoke-fixture.json'));
  const { createVideoEngine } = require(path.join(root, 'src', 'video-engine.cjs'));
  const deviceModule = require(path.join(root, 'src', 'transcode-devices.cjs'));
  const mockDevices = { cpu: { id: 'cpu', name: 'Smoke CPU · 16 logical processors', logicalProcessors: 16 }, gpus: [
    { id: 'nvenc:0', name: 'Smoke working GPU', encoder: 'h264_nvenc', index: 0, available: true },
    { id: 'qsv:1', name: 'Smoke unavailable GPU', encoder: 'h264_qsv', index: 1, available: false, error: 'Fixture driver unavailable' }
  ], formats: { mp4: { cpu: true, gpu: true }, dxv: { cpu: true, gpu: false } } };
  let deviceDetections = 0;
  deviceModule.createTranscodeDeviceManager = () => ({
    discover: async () => { deviceDetections++; await new Promise(resolve => setTimeout(resolve, 40)); return structuredClone(mockDevices); },
    shutdown: async () => {}
  });
  const transcoderModule = require(path.join(root, 'src', 'video-transcode.cjs'));
  const originalCreate = transcoderModule.createVideoTranscoder;
  let engine, enteredGate = false, hold = false, finished = false, launchPresetName;
  const calls = [], network = [], failures = [], menuLabels = [];
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows'); app.commandLine.appendSwitch('disable-renderer-backgrounding');
  require(path.join(root, 'src', 'collector.cjs')).createCollector = () => ({ start: async () => ({}), info: () => ({ enabled: false }), activeCount: () => 0, close: async () => {} });
  dialog.showErrorBox = (title, message) => failures.push(`${title}: ${message}`);
  dialog.showOpenDialog = async () => { throw new Error('Transcode smoke must not open a file picker'); };
  shell.openPath = shell.openExternal = async () => { throw new Error('Transcode smoke must not launch another application'); };
  Menu.buildFromTemplate = template => ({ popup(options) {
    const item = template.find(item => item.id === 'video-transcode');
    menuLabels.push({ label: item?.label, enabled: item?.enabled });
    if (launchPresetName) {
      const preset = template.find(entry => entry.id === 'video-transcode-presets')?.submenu.find(entry => entry.label === `${launchPresetName}…`);
      launchPresetName = null;
      preset?.click();
    } else if (item?.enabled) item.click();
    options.callback?.();
  } });
  transcoderModule.createVideoTranscoder = options => {
    engine = originalCreate(options); const transcode = engine.transcode;
    engine.transcode = async (source, destination, settings) => {
      calls.push({ format: settings.format, bitrateMbps: settings.bitrateMbps, alpha: settings.alpha, device: settings.device });
      if (hold) {
        enteredGate = true;
        await new Promise((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('Cancelled fixture gate'), { name: 'AbortError' }));
          if (settings.signal.aborted) abort(); else settings.signal.addEventListener('abort', abort, { once: true });
        });
      }
      // Device selection and scheduling remain real; only the hardware boundary
      // uses CPU encoding so this UI smoke also runs on machines without a GPU.
      return transcode(source, destination, { ...settings, device: { type: 'cpu', threads: settings.device?.threads || 2 } });
    };
    return engine;
  };
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); }));
  const wait = async (predicate, message, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  app.on('browser-window-created', (_event, window) => {
    window.show = () => {}; window.setSkipTaskbar(true); window.setOpacity(0); window.showInactive(); window.webContents.setBackgroundThrottling(false);
    const js = code => window.webContents.executeJavaScript(code);
    const capture = async filename => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { window.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 100)); const screenshot = await window.webContents.capturePage(); if (!screenshot.isEmpty()) { await fs.writeFile(path.join(base, filename), screenshot.toPNG()); return true; } } catch {}
      }
      return false;
    };
    window.webContents.once('did-finish-load', async () => {
      if (!window.webContents.getURL().endsWith('/src/index.html')) return;
      try {
        const setup = await js(`(async()=>{
          const check=(value,message)=>{if(!value)throw new Error(message)};
          const files=${JSON.stringify(fixture.files)}, initial=await api.getLibrary();check(initial.stats.total===0,'Test library is not empty');
          const folder=(await api.createFolder('转码素材')).folders[0].id;
          const imported=await api.importPaths(files.map(file=>file.filename),folder);check(imported.report.imported===files.length,'Video fixture import failed');
          const assets=Object.fromEntries(files.map(file=>[file.kind,imported.snapshot.assets.find(asset=>asset.hash===file.sha256)]));
          await api.updateAssets([assets.avi.id],{tags:['保留标签'],rating:4,colorLabel:'#3479ab',notes:'原始备注'});
          applyLibrary(await api.getLibrary(),false);
          window.__transcodeSmoke={check,assets,folder};return {ids:Object.fromEntries(Object.entries(assets).map(([k,a])=>[k,a.id])),root:initial.root};
        })()`);
        await js(`document.getElementById('settingsButton').click()`);
        await wait(() => js(`!transcodeSettingsUi.loading && !document.getElementById('transcodeSettingsSave').disabled`), 'Device settings did not load');
        await js(`(()=>{
          const check=__transcodeSmoke.check, get=id=>document.getElementById(id);
          check(get('transcodeSettingsCpuName').textContent.includes('Smoke CPU'),'CPU name missing');
          check(get('transcodeSettingsCpuThreads').max==='16','CPU thread limit missing');
          check(get('transcodeSettingsGpu').querySelector('option[value="qsv:1"]').disabled,'Unavailable GPU can be selected');
          const threads=get('transcodeSettingsCpuThreads');threads.value='0';threads.dispatchEvent(new Event('input'));check(get('transcodeSettingsSave').disabled,'Zero CPU threads allowed');
          threads.value='17';threads.dispatchEvent(new Event('input'));check(get('transcodeSettingsSave').disabled,'Excess CPU threads allowed');
          threads.value='3';threads.dispatchEvent(new Event('input'));
          get('transcodeSettingsMode').value='hybrid';get('transcodeSettingsMode').dispatchEvent(new Event('change'));
          get('transcodeSettingsGpu').value='nvenc:0';get('transcodeSettingsGpu').dispatchEvent(new Event('change'));
          check(!get('transcodeSettingsSave').disabled,'Valid settings rejected');
        })()`);
        const settingsScreenshot = await capture('transcode-settings.png');
        await js(`document.getElementById('transcodeSettingsForm').requestSubmit()`);
        await wait(() => js(`document.getElementById('transcodeSettingsOverlay').classList.contains('hidden')`), 'Device settings did not save');
        assert.deepEqual(await js('api.getTranscodeSettings()'), { mode: 'hybrid', cpuThreads: 3, gpuId: 'nvenc:0' });
        const persistedSettings = JSON.parse(await fs.readFile(path.join(base, 'profile', 'transcode-settings.json'), 'utf8'));
        assert.equal(persistedSettings.settings.gpuId, 'nvenc:0');
        await js(`document.getElementById('settingsButton').click()`);
        await wait(() => js(`!transcodeSettingsUi.loading`), 'Saved settings did not reopen');
        await js(`__transcodeSmoke.check(document.getElementById('transcodeSettingsMode').value==='hybrid'&&document.getElementById('transcodeSettingsCpuThreads').value==='3'&&document.getElementById('transcodeSettingsGpu').value==='nvenc:0','Saved settings were not restored')`);
        const priorDetections = deviceDetections;
        await js(`document.getElementById('transcodeSettingsRefresh').click()`);
        await wait(() => deviceDetections > priorDetections, 'Refresh did not detect devices');
        await wait(() => js(`!transcodeSettingsUi.loading`), 'Refresh did not finish');
        await js(`document.getElementById('transcodeSettingsCancel').click()`);
        const setForm = async (ids, format, bitrate = 2, alpha = false) => js(`(async()=>{
          state.selected=new Set(${JSON.stringify(ids)});await showAssetContextMenu(${JSON.stringify(ids[0])});
          __transcodeSmoke.check(!document.getElementById('videoTranscodeOverlay').classList.contains('hidden'),'Video menu did not open dialog');
          document.getElementById('videoTranscodeFormat').value=${JSON.stringify(format)};document.getElementById('videoTranscodeFormat').dispatchEvent(new Event('change'));
          document.getElementById('videoTranscodeBitrate').value=${bitrate};document.getElementById('videoTranscodeBitrate').dispatchEvent(new Event('input'));
          document.getElementById('videoTranscodeAlpha').checked=${alpha};
        })()`);
        const start = async () => {
          const previousId = await js(`(async()=>(await api.videoTranscodeState()).id)()`);
          await js(`document.getElementById('videoTranscodeForm').requestSubmit()`);
          await wait(() => js(`(async()=>{const state=await api.videoTranscodeState();return state.id&&state.id!==${JSON.stringify(previousId)}})()`), 'New transcode job did not start');
        };
        const done = async () => {
          await wait(() => js(`(async()=>{const s=await api.videoTranscodeState();return s.id&&!['running','cancelling'].includes(s.status)})()`), 'Transcode did not finish');
          const state = await js('api.videoTranscodeState()');
          assert.equal(state.status, 'completed', JSON.stringify(state)); assert.equal(state.failed, 0, JSON.stringify(state)); return state;
        };
        await js(`api.assetContextMenu(['${setup.ids.avi}','${setup.ids.image}'],${JSON.stringify(setup.root)})`);
        assert.equal(menuLabels.at(-1).enabled, false, 'Mixed image/video selection must disable transcoding');
        await setForm([setup.ids.dxv], 'mp4', 2.5);
        await js(`document.getElementById('videoTranscodeSettings').click()`);
        await wait(() => js(`!transcodeSettingsUi.loading`), 'Transcode device settings link did not load');
        await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));__transcodeSmoke.check(!document.getElementById('videoTranscodeOverlay').classList.contains('hidden'),'Closing device settings did not restore transcode dialog')`);
        await js(`document.getElementById('videoTranscodeBitrate').value='0';document.getElementById('videoTranscodeBitrate').dispatchEvent(new Event('input'));__transcodeSmoke.check(document.getElementById('videoTranscodeStart').disabled,'Invalid bitrate allowed');document.getElementById('videoTranscodeBitrate').value='2.5';document.getElementById('videoTranscodeBitrate').dispatchEvent(new Event('input'))`);
        await js(`document.getElementById('transcodePresetAdd').click();const presetName=document.getElementById('transcodePresetName');presetName.value='审片自定义';presetName.dispatchEvent(new Event('input'));document.getElementById('transcodePresetSave').click()`);
        await wait(() => js('Boolean(transcodeUi.presetId) && !transcodeUi.presetPending'), 'Custom MP4 preset not saved');
        const [mp4Preset] = JSON.parse(await fs.readFile(path.join(base, 'profile', 'transcode-presets.json'), 'utf8')).presets;
        assert.equal(mp4Preset.bitrateMbps, 2.5);
        const optionsScreenshot = await capture('transcode-options.png');
        await start(); const single = await done(); assert.equal(single.imported, 1); assert.equal(calls[0].bitrateMbps, 2.5);
        await setForm([setup.ids.avi, setup.ids.dxv], 'mp4', 4); await start(); const batch = await done(); assert.equal(batch.imported + batch.duplicates, 2); assert.equal(batch.total, 2);
        assert.equal(batch.executionMode, 'hybrid'); assert.equal(batch.lanes.length, 2); assert.deepEqual(new Set(batch.results.map(item => item.deviceType)), new Set(['cpu', 'gpu']));
        const copiedMetadata = await js(`(async()=>{const lib=await api.getLibrary(),s=await api.videoTranscodeState(),a=lib.assets.find(a=>a.id===s.results.find(r=>r.id==='${setup.ids.avi}').assetIds[0]);return {folderId:a.folderId,tags:a.tags,rating:a.rating,colorLabel:a.colorLabel,notes:a.notes};})()`);
        assert.deepEqual(copiedMetadata, { folderId: await js('__transcodeSmoke.folder'), tags: ['保留标签'], rating: 4, colorLabel: '#3479ab', notes: '原始备注' });
        await setForm([setup.ids.avi], 'dxv');
        await js(`__transcodeSmoke.check(document.getElementById('videoTranscodeDeviceSummary').textContent.includes('DXV 使用 CPU'),'DXV CPU limitation missing')`);
        await start(); const dxv = await done(); assert.equal(dxv.imported, 1); assert.equal(dxv.executionMode, 'cpu');
        await setForm([setup.ids.alpha], 'dxv', 2, true);
        await js(`document.getElementById('transcodePresetAdd').click();presetName.value='DXV 带通道';presetName.dispatchEvent(new Event('input'));document.getElementById('transcodePresetSave').click()`);
        await wait(() => js('Boolean(transcodeUi.presetId) && !transcodeUi.presetPending'), 'DXV alpha preset not saved');
        const storedPresets = await js('api.listTranscodePresets()');
        assert.deepEqual(storedPresets[1], { id: storedPresets[1].id, name: 'DXV 带通道', format: 'dxv', alpha: true });
        await js(`document.getElementById('videoTranscodeBackground').click();document.getElementById('videoTranscodeAlpha').checked=false`);
        launchPresetName = 'DXV 带通道';
        await js(`(async()=>{state.selected=new Set(['${setup.ids.alpha}']);await showAssetContextMenu('${setup.ids.alpha}')})()`);
        assert.equal(await js(`$('videoTranscodeFormat').value==='dxv' && $('videoTranscodeAlpha').checked`), true, 'Native menu preset did not restore alpha');
        await start(); const alpha = await done(); assert.equal(alpha.imported, 1);
        const alphaAsset = await js(`(async()=>{const lib=await api.getLibrary();return lib.assets.find(a=>a.id==='${alpha.results[0].assetIds[0]}')})()`);
        assert.equal(alphaAsset.hasAlpha, true, 'DXV alpha was not retained');
        hold = true; enteredGate = false;
        await setForm([setup.ids.avi, setup.ids.dxv], 'mp4', 6); await start(); await wait(() => enteredGate, 'Cancel gate not reached');
        await wait(() => js(`document.querySelectorAll('#videoTranscodeWorkers .video-transcode-worker').length===2`), 'CPU and GPU lane progress missing');
        await js(`document.getElementById('toastStack').replaceChildren()`);
        const progressScreenshot = await capture('transcode-progress.png');
        await js(`document.getElementById('videoTranscodeSettings').click()`);
        await wait(() => js(`!transcodeSettingsUi.loading`), 'Settings did not open during running job');
        await js(`document.getElementById('transcodeSettingsMode').value='cpu';document.getElementById('transcodeSettingsMode').dispatchEvent(new Event('change'));document.getElementById('transcodeSettingsForm').requestSubmit()`);
        await wait(() => js(`document.getElementById('transcodeSettingsOverlay').classList.contains('hidden')`), 'Settings could not save for next job');
        assert.equal((await js('api.getTranscodeSettings()')).mode, 'cpu');
        assert.equal((await js('api.videoTranscodeState()')).executionMode, 'hybrid', 'Changing settings modified an active job');
        await js(`document.getElementById('videoTranscodeBackground').click();__transcodeSmoke.check(document.getElementById('videoTranscodeOverlay').classList.contains('hidden'),'Background button did not close dialog');document.getElementById('videoTranscodeButton').click();__transcodeSmoke.check(!document.getElementById('videoTranscodeOverlay').classList.contains('hidden'),'Header button did not reopen job')`);
        await js(`(async()=>{let rejected=false;try{await api.openLibrary()}catch{rejected=true}__transcodeSmoke.check(rejected,'Library switch was allowed during transcode');})()`);
        const beforeCancel = calls.length; await js(`document.getElementById('videoTranscodeCancel').click()`);
        await wait(() => js(`(async()=>{const s=await api.videoTranscodeState();return s.status==='cancelled'})()`), 'Cancellation did not finish');
        hold = false; assert.equal(calls.length, beforeCancel, 'Cancellation started another item');
        await js(`(async()=>{let rejected=false;try{await api.startVideoTranscode({ids:['${setup.ids.avi}'],expectedRoot:'wrong-root',format:'mp4',bitrateMbps:2})}catch{rejected=true}__transcodeSmoke.check(rejected,'Wrong library accepted');})()`);
        const library = await js('api.getLibrary()');
        for (const file of fixture.files) {
          const asset = library.assets.find(item => item.hash === file.sha256);
          assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(library.root, asset.filename))).digest('hex'), file.sha256);
        }
        const probe = createVideoEngine({ runtimeDir: path.join(root, 'video-runtime'), cacheDir: path.join(base, 'probe-cache') });
        const formats = [];
        for (const [job, codec] of [[single, 'h264'], [dxv, 'dxv'], [alpha, 'dxv']]) {
          const asset = library.assets.find(item => item.id === job.results[0].assetIds[0]);
          const filename = path.join(library.root, asset.filename), info = await probe.probe(filename); assert.equal(info.codec, codec);
          const decoded = spawnSync(path.join(root, 'video-runtime', 'ffmpeg.exe'), ['-v', 'error', '-i', filename, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
          assert.equal(decoded.status, 0, decoded.stderr?.toString()); assert.ok(decoded.stdout.length > 0);
          const alphas = []; for (let offset = 3; offset < decoded.stdout.length; offset += 4) alphas.push(decoded.stdout[offset]);
          const alphaMin = Math.min(...alphas), alphaMax = Math.max(...alphas);
          if (job === alpha) assert.ok(alphaMin > 0 && alphaMin < 254, 'DXV alpha channel was not preserved');
          else assert.equal(alphaMin, 255, 'Opaque output contains transparent pixels');
          formats.push({ codec: info.codec, width: info.width, height: info.height, alphaMin, alphaMax });
        }
        await probe.shutdown(); assert.deepEqual(network, []); assert.deepEqual(failures, []);
        await wait(async () => !(await fs.readdir(path.join(base, 'profile', 'video-transcodes'))).length, 'Temporary outputs not cleaned');
        finished = true;
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: true, electron: process.versions.electron, singleMp4: true, batchMp4: true, dxvNormal: true, dxvAlpha: true, customBitrate: true, invalidBitrateRejected: true, originalsPreserved: true, metadataInherited: true, cancellation: true, backgroundReopen: true, librarySwitchBlocked: true, deviceSettingsSaved: true, settingsRestored: true, cpuThreadValidation: true, unavailableGpuDisabled: true, deviceRefresh: true, settingsApplyToNextJob: true, hybridBatch: true, dualLaneProgress: true, dxvCpuOnly: true, nativeMenuBoundaryMocked: true, hardwareEncoderBoundaryMocked: true, menuLabels, formats, settingsScreenshot, optionsScreenshot, progressScreenshot, browserNetworkRequests: 0 }, null, 2));
        window.destroy(); app.quit();
      } catch (error) {
        if (finished) return; finished = true;
        try { await capture('failure.png'); } catch {}
        await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: error.stack || String(error), calls, failures }, null, 2));
        await engine?.shutdown(); app.exit(1);
      }
    });
  });
  setTimeout(async () => { if (!finished) { await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ ok: false, error: 'Transcode smoke timed out' })); app.exit(1); } }, 140000).unref();
};
