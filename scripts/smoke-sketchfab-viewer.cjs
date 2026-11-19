'use strict';

// Default: a fully offline, real WebGL capture/export/preview check.
// --live additionally loads two public, downloadable Sketchfab examples.
// All windows stay hidden and use disposable profiles and an isolated library.
// --diagnostic-redraw is deliberately excluded from the normal acceptance run.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const FIXTURE_ID = '0123456789abcdef0123456789abcdef';
const PUBLIC_MODELS = ['fe4283c1a3704665964b5c8e5654ca1b', '49d97ca2fbf34f85b6c88ae8ebc7514f'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) { if (!value) throw new Error(message); }
async function deadline(task, ms, label) {
  let timer;
  try { return await Promise.race([task, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}

function preload() {
  const { ipcRenderer } = require('electron');
  const path = require('node:path');
  const config = require(path.join(__dirname, 'config.json'));
  const { installSketchfabViewerRecorder } = require(path.join(config.root, 'extension/sketchfab-viewer-recorder.js'));
  const recorder = installSketchfabViewerRecorder(window);
  ipcRenderer.on('smoke-snapshot', async (_event, message) => {
    try {
      if (!recorder) throw new Error('Recorder was not installed');
      const snapshot = await recorder.snapshot(message.modelId, { waitMs: 800 });
      ipcRenderer.send('smoke-snapshot-result', { requestId: message.requestId, ok: true, snapshot });
    } catch (error) { ipcRenderer.send('smoke-snapshot-result', { requestId: message.requestId, ok: false, code: error.code || 'SMOKE_CAPTURE_FAILED' }); }
  });
}

function fixturePage(png) {
  return `<!doctype html><meta charset="utf-8"><title>Offline textured triangle</title><canvas id="fixture" width="640" height="640"></canvas><script>
  const canvas = document.getElementById('fixture');
  const gl = canvas.getContext('webgl', {alpha:true, antialias:false});
  if (!gl) throw new Error('WebGL unavailable');
  function shader(type, source) { const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error('Shader failed');return s; }
  const program=gl.createProgram();
  gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec3 Vertex;attribute vec3 Normal;attribute vec2 TexCoord0;uniform mat4 uModelMatrix;uniform mat4 uModelViewMatrix;uniform mat4 uProjectionMatrix;varying vec2 vUv;varying vec3 vNormal;void main(){vUv=TexCoord0;vNormal=Normal;gl_Position=uProjectionMatrix*uModelViewMatrix*uModelMatrix*vec4(Vertex,1.0);}'));
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'precision mediump float;uniform sampler2D Texture0;varying vec2 vUv;varying vec3 vNormal;void main(){vec4 albedo=texture2D(Texture0,vUv);gl_FragColor=vec4(albedo.rgb*(0.9+0.1*abs(vNormal.z)),albedo.a);}'));
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Program failed');gl.useProgram(program);
  function attribute(name,size,values){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);const i=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,size,gl.FLOAT,false,0,0);}
  attribute('Vertex',3,[-0.8,-0.8,0,0.8,-0.8,0,0,0.8,0]);attribute('Normal',3,[0,0,1,0,0,1,0,0,1]);attribute('TexCoord0',2,[0,0,1,0,0.5,1]);
  const indices=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2]),gl.STATIC_DRAW);
  const identity=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);for(const name of ['uModelMatrix','uModelViewMatrix','uProjectionMatrix'])gl.uniformMatrix4fv(gl.getUniformLocation(program,name),false,identity);
  const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform1i(gl.getUniformLocation(program,'Texture0'),0);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  const image=new Image();image.onload=()=>{gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);window.fixtureReady=true;function draw(){gl.viewport(0,0,640,640);gl.clearColor(0.05,0.05,0.05,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawElements(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0);requestAnimationFrame(draw);}draw();};image.src=${JSON.stringify('data:image/png;base64,' + png)};
  </script>`;
}

function glbParts(bytes) {
  check(bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2, 'Export is not GLB 2');
  check(bytes.readUInt32LE(8) === bytes.length, 'GLB length differs');
  const length = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + length));
  return { json, binary: bytes.subarray(28 + length) };
}
function bounds(snapshot) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of snapshot.meshes) for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]); max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  return { min, max };
}
function expectedPreviewBounds(snapshot) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  // The renderer transforms each geometry's local bounding-box corners, rather
  // than recomputing a tight box from every transformed vertex.
  for (const mesh of snapshot.meshes) {
    const box = bounds({ meshes: [mesh] }), m = mesh.matrix;
    for (let corner = 0; corner < 8; corner++) {
      const p = [0, 1, 2].map(axis => Math.fround(box[corner & (1 << axis) ? 'max' : 'min'][axis]));
      const world = m ? [0, 1, 2].map(axis => m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + m[12 + axis]) : p;
      const converted = [world[0], world[2], -world[1]];
      for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], converted[axis]); max[axis] = Math.max(max[axis], converted[axis]); }
    }
  }
  return max.map((value, axis) => value - min[axis]);
}

async function childMain(config) {
  const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
  const base = config.base;
  app.setName('Mosaic isolated Sketchfab viewer smoke');
  app.setPath('userData', path.join(base, 'profile')); app.setPath('sessionData', path.join(base, 'sessions'));
  protocol.registerSchemesAsPrivileged([{ scheme: 'shitu', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
  app.on('window-all-closed', () => {});
  const report = { ok: false, live: config.live, isolated: true, startedAt: new Date().toISOString(), cases: [], externalRequests: 0 };
  let service, library; const windows = new Set();
  const flush = () => fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  try {
    await app.whenReady();
    const sharp = require('sharp');
    const { Library } = require('../src/library.cjs');
    const { createModelService } = require('../src/model-service.cjs');
    const { exportSketchfabViewer } = require('../src/sketchfab-viewer-export.cjs');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
    library = new Library({ root: path.join(base, 'library'), createThumbnail: (...args) => service.thumbnail(...args) }); await library.init();
    service = createModelService({ BrowserWindow, cacheDir: path.join(base, 'model-cache'), getLibrary: () => library, thumbnailTimeoutMs: 45000 });
    protocol.handle('shitu', request => service.response(request));
    const pixels = Buffer.from([255,0,0,0, 0,220,60,255, 0,220,60,255, 0,220,60,255]);
    const png = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
    async function snapshot(window, modelId) {
      const requestId = crypto.randomBytes(16).toString('hex');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Snapshot response timed out')), 20000);
        const listener = (event, value) => {
          if (event.sender !== window.webContents || value?.requestId !== requestId) return;
          finish(value.ok ? null : new Error(value.code || 'Snapshot failed'), value.snapshot);
        };
        function finish(error, value) { clearTimeout(timer); ipcMain.removeListener('smoke-snapshot-result', listener); error ? reject(error) : resolve(value); }
        ipcMain.on('smoke-snapshot-result', listener); window.webContents.send('smoke-snapshot', { requestId, modelId });
      });
    }
    async function runCase(name, modelId, live) {
      const directory = path.join(base, name); await fs.mkdir(directory);
      const result = { name, modelId, live, ok: false, phase: 'loading',
        recorderHash: crypto.createHash('sha256').update(await fs.readFile(path.join(ROOT, 'extension/sketchfab-viewer-recorder.js'))).digest('hex') };
      report.cases.push(result); await flush();
      let captureWindow, preview;
      try {
        const url = `https://sketchfab.com/models/${modelId}/embed?autostart=1&ui_infos=0&ui_controls=0&ui_stop=0`;
        const captureSession = session.fromPartition('smoke-' + crypto.randomUUID());
        if (!live) captureSession.protocol.handle('https', request => request.url === url ? new Response(fixturePage(png.toString('base64')), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response(null, { status: 404 }));
        captureSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) => {
          const allowed = live || details.url === url;
          if (live) report.externalRequests++; else if (!allowed) result.blockedRequests = (result.blockedRequests || 0) + 1;
          done({ cancel: !allowed });
        });
        captureWindow = new BrowserWindow({ width: 1000, height: 700, show: false, skipTaskbar: true,
          webPreferences: { session: captureSession, preload: path.join(base, 'preload.cjs'), nodeIntegration: false,
            contextIsolation: false, sandbox: false, offscreen: true, backgroundThrottling: false } });
        windows.add(captureWindow); captureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        captureSession.on('will-download', event => event.preventDefault());
        await deadline(captureWindow.loadURL(url), 45000, 'Page load timed out');
        result.phase = 'drawing'; await flush();
        if (live) await wait(15000);
        else {
          for (let i = 0; i < 80; i++) { if (await captureWindow.webContents.executeJavaScript('window.fixtureReady === true')) break; await wait(100); }
          check(await captureWindow.webContents.executeJavaScript('window.fixtureReady === true'), 'Offline fixture did not draw');
        }
        result.phase = 'capturing'; await flush();
        const capture = snapshot(captureWindow, modelId);
        if (live && config.diagnosticRedraw) {
          result.captureStimulus = 'One-pixel resize of this isolated hidden window to request a fresh frame';
          captureWindow.setContentSize(1001, 700);
        }
        const value = JSON.parse(JSON.stringify(await capture));
        await fs.writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(value));
        check(value.coordinateSystem === 'sketchfab-z-up', 'Recorder coordinate system is missing');
        result.coordinateSystem = value.coordinateSystem; result.expectedPreviewBounds = expectedPreviewBounds(value);
        result.bounds = bounds(value); result.snapshot = { meshes: value.meshes.length, images: value.images.length, warnings: value.warnings || [] };
        const exported = exportSketchfabViewer(value); result.export = exported.stats;
        const glb = path.join(directory, 'captured.glb'); await fs.writeFile(glb, exported.glb);
        const parsed = glbParts(exported.glb);
        result.materials = parsed.json.materials.map(m => ({ factor: m.pbrMetallicRoughness.baseColorFactor, textured: !!m.pbrMetallicRoughness.baseColorTexture, alphaMode: m.alphaMode }));
        if (!live) {
          check(exported.stats.vertexCount === 3 && exported.stats.triangleCount === 1 && exported.stats.imageCount === 1, 'Offline geometry or texture count differs');
          check(value.meshes[0].normals?.length === 9 && value.meshes[0].texcoords?.length === 6, 'Offline normals or UVs missing');
          check(parsed.json.materials[0].alphaMode === 'BLEND', 'PNG transparency was lost');
          const image = parsed.json.images[0], view = parsed.json.bufferViews[image.bufferView];
          const decoded = await sharp(parsed.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)).ensureAlpha().raw().toBuffer();
          const alpha = [...decoded].filter((_, index) => index % 4 === 3); result.alpha = { min: Math.min(...alpha), max: Math.max(...alpha) };
          check(result.alpha.min === 0 && result.alpha.max === 255, 'PNG alpha pixels differ');
        } else if (modelId === PUBLIC_MODELS[0]) {
          const expected = { min: [-0.2574459910392761,-0.5000010132789612,-0.25744500756263733], max: [0.2574459910392761,0.5000010132789612,0.25744500756263733] };
          result.reference = { expectedVertices: 19691, expectedTriangles: 28284, bounds: expected };
          result.boundsError = Math.max(...['min','max'].flatMap(key => expected[key].map((v,i) => Math.abs(v - result.bounds[key][i]))));
          const factors = [[0.21901517958561373,0.21901517958561373,0.21901517958561373], [0.04914507424694404,0.04961086989947625,0.05014128169569836]];
          result.colorErrors = factors.map(expected => Math.min(...result.materials.filter(m => m.factor).map(m => Math.max(...expected.map((v,i) => Math.abs(v-m.factor[i]))))));
          // The public viewer stores these linear colors in an 8-bit palette,
          // then multiplies by the observed scalar. Allow half a palette step.
          result.colorTolerances = [0.5475379228591919, 0.06767109781503677].map(scalar => scalar / 510 + 0.000001);
          check(result.boundsError < 0.0002, 'Public sample local bounds differ');
          check(exported.stats.vertexCount === 19691 && exported.stats.triangleCount === 28284, 'Public sample geometry counts differ');
          check(result.colorErrors.every((error, index) => error <= result.colorTolerances[index]), 'Palette linear color differs from official glTF');
        } else check(exported.stats.imageCount > 0, 'Textured public sample lost its texture');
        result.phase = 'previewing'; await flush();
        const imported = await deadline(library.importPaths([glb]), 50000, 'GLB import/thumbnail timed out'); check(imported.imported === 1 && !imported.errors.length, 'GLB did not import');
        const asset = library.snapshot().assets.find(a => a.hash && a.name === 'captured' && a.id === imported.assetIds?.[0]) || library.snapshot().assets.at(-1);
        const options = await service.prepare(library, asset.id, library.root);
        preview = new BrowserWindow({ width: 640, height: 640, show: false, skipTaskbar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } }); windows.add(preview);
        preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        await preview.loadFile(path.join(ROOT, 'src/model-viewer.html'));
        const rendered = await preview.webContents.executeJavaScript(`window.renderModelThumbnail(${JSON.stringify(options)})`);
        result.preview = rendered.metadata;
        check(rendered.metadata.vertices > 0 && rendered.metadata.triangles > 0, 'Preview geometry missing');
        result.previewBoundsError = Math.max(...result.expectedPreviewBounds.map((value, index) => Math.abs(value - rendered.metadata.bounds[index])));
        check(result.previewBoundsError < 0.0001, 'Preview did not apply the Z-up to Y-up coordinate conversion');
        const imageBytes = Buffer.from(rendered.dataUrl.split(',')[1], 'base64'); await fs.writeFile(path.join(directory, 'preview.jpg'), imageBytes);
        if (!live) {
          const rgba = await sharp(imageBytes).ensureAlpha().raw().toBuffer(); let green = 0;
          for (let i = 0; i < rgba.length; i += 4) if (rgba[i+1] > rgba[i] + 20 && rgba[i+1] > rgba[i+2] + 20 && rgba[i+1] > 60) green++;
          result.previewGreenPixels = green; check(green > 1000, 'PNG texture was not visible in actual preview');
        }
        result.ok = true; result.phase = 'complete';
      } catch (error) { result.error = error.message; if (error.code) result.errorCode = error.code; }
      finally { for (const window of [captureWindow, preview]) if (window && !window.isDestroyed()) { window.destroy(); windows.delete(window); } await flush(); }
    }
    await runCase('offline', FIXTURE_ID, false);
    if (config.live) for (const [i, modelId] of PUBLIC_MODELS.entries()) await runCase('live-' + (i + 1), modelId, true);
    report.ok = report.cases.every(c => c.ok); check(config.live || report.externalRequests === 0, 'Offline smoke attempted external access');
  } catch (error) { report.error = error.message; }
  finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await service?.shutdown(); report.finishedAt = new Date().toISOString(); await flush(); app.exit(report.ok ? 0 : 1);
  }
}

async function parentMain() {
  const live = process.argv.includes('--live'), base = await fs.mkdtemp(path.join(ROOT, 'tmp', 'sketchfab-viewer-smoke-'));
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'mosaic-sketchfab-viewer-smoke', main: __filename }));
  await fs.writeFile(path.join(base, 'config.json'), JSON.stringify({ root: ROOT, base, live, diagnosticRedraw: process.argv.includes('--diagnostic-redraw') }));
  await fs.writeFile(path.join(base, 'preload.cjs'), `(${preload.toString()})();`);
  const env = {};
  for (const key of ['SystemRoot','WINDIR','PATH','PATHEXT','COMSPEC','SYSTEMDRIVE','PROGRAMFILES','PROGRAMFILES(X86)','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE']) if (process.env[key]) env[key] = process.env[key];
  env.MOSAIC_SKETCHFAB_VIEWER_SMOKE = path.join(base, 'config.json');
  env.TEMP = env.TMP = path.join(base, 'temp'); env.APPDATA = path.join(base, 'appdata'); env.LOCALAPPDATA = path.join(base, 'localappdata');
  for (const directory of [env.TEMP, env.APPDATA, env.LOCALAPPDATA]) await fs.mkdir(directory);
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(require('./runtime.cjs').electronPath(), [base], { cwd: ROOT, env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Smoke timed out: ' + base)); }, live ? 240000 : 100000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(path.join(base, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ ok: report.ok, live, reportDirectory: base, cases: report.cases.map(c => ({ name: c.name, ok: c.ok, error: c.error, export: c.export })) }, null, 2));
  if (exit !== 0 || !report.ok) process.exitCode = 1;
}

if (process.env.MOSAIC_SKETCHFAB_VIEWER_SMOKE && process.versions.electron) childMain(require(process.env.MOSAIC_SKETCHFAB_VIEWER_SMOKE)).catch(() => process.exit(1));
else parentMain().catch(error => { console.error(error.message); process.exitCode = 1; });
