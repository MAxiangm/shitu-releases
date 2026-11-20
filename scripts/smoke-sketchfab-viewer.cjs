'use strict';

// Default: a fully offline, real WebGL capture/export/preview check.
// --live additionally loads two public, downloadable Sketchfab examples.
// --models=<id>[,<id>] selects other public examples, including the PBR sample.
// --pose-reference=<json> compares an animated export with independently sampled
// viewer GPU palette vertices at the recorded clip time.
// All windows stay hidden and use disposable profiles and an isolated library.
// --diagnostic-redraw is deliberately excluded from the normal acceptance run.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const FIXTURE_ID = '0123456789abcdef0123456789abcdef';
const PUBLIC_MODELS = ['fe4283c1a3704665964b5c8e5654ca1b', '49d97ca2fbf34f85b6c88ae8ebc7514f'];
const PBR_MODEL = 'bfbbb481e98e4be38774b1d0204c192c';
const ANIMATED_MODEL = '371dea88d7e04a76af5763f2a36866bc';
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
  window.MosaicSketchfabGeometryTransfer = require(path.join(config.root, 'extension/sketchfab-geometry-transfer.js'));
  window.MosaicSketchfabTextureReadback = require(path.join(config.root, 'extension/sketchfab-texture-readback.js'));
  window.MosaicSketchfabSceneRecorder = require(path.join(config.root, 'extension/sketchfab-scene-recorder.js'));
  const { installSketchfabViewerRecorder } = require(path.join(config.root, 'extension/sketchfab-viewer-recorder.js'));
  const recorder = installSketchfabViewerRecorder(window);
  ipcRenderer.on('smoke-snapshot', async (_event, message) => {
    try {
      if (!recorder) throw new Error('Recorder was not installed');
      const snapshot = await recorder.snapshot(message.modelId, { waitMs: 800, compact: config.compact, waitForGeometryMs: 15000 });
      ipcRenderer.send('smoke-snapshot-result', { requestId: message.requestId, ok: true, snapshot });
    } catch (error) { ipcRenderer.send('smoke-snapshot-result', { requestId: message.requestId, ok: false, code: error.code || 'SMOKE_CAPTURE_FAILED', detail: error.stack }); }
  });
}

function fixturePage(png, pbrImages) {
  const fragment = pbrImages ? `precision mediump float;
uniform sampler2D Texture0;uniform sampler2D Texture1;uniform sampler2D Texture2;
uniform float uAlbedoPBRFactor;uniform float uMetalnessPBRFactor;uniform float uRoughnessPBRFactor;
uniform float uNormalMapFactor;uniform int uNormalMapFlipY;uniform float uAOPBRFactor;uniform float uEmitColorFactor;
varying vec2 vTexCoord0;varying vec3 vNormal;
vec3 sRGBToLinear(vec3 x){return pow(x,vec3(2.2));}
vec3 getMaterialAlbedo(){vec3 albedo;albedo=uAlbedoPBRFactor*sRGBToLinear(texture2D(Texture0,vTexCoord0).rgb);return albedo;}
float getMaterialMetalness(){return uMetalnessPBRFactor*(texture2D(Texture1,vTexCoord0).a);}
float getMaterialRoughness(){float fetch=(texture2D(Texture0,vTexCoord0).a);return uRoughnessPBRFactor*fetch;}
float getMaterialAO(){return mix(1.0,(texture2D(Texture2,vTexCoord0).a),uAOPBRFactor);}
vec3 getMaterialEmitColor(){return uEmitColorFactor*sRGBToLinear(texture2D(Texture2,vTexCoord0).rgb);}
vec3 getMaterialNormalMap(){vec3 nmap=(texture2D(Texture1,vTexCoord0).rgb)*2.0-1.0;nmap.y=uNormalMapFlipY==1?-nmap.y:nmap.y;return nmap;}
vec3 transformNormal(const in float factor,in vec3 normal,const in vec3 t,const in vec3 b,in vec3 n){normal.xy=factor*normal.xy;return normalize(normal.x*t+normal.y*b+normal.z*n);}
void main(){vec3 albedo=getMaterialAlbedo();vec4 tangent=vec4(1.,0.,0.,1.);vec3 binormal=vec3(0.,1.,0.);vec3 frontNormal=vNormal;vec3 materialNormal=getMaterialNormalMap();materialNormal=transformNormal(uNormalMapFactor,materialNormal,tangent.xyz,binormal,frontNormal);float light=(0.4+0.1*getMaterialMetalness()+0.1*getMaterialRoughness()+0.1*abs(materialNormal.y)+0.1*abs(vNormal.z))*getMaterialAO();gl_FragColor=vec4(albedo*light+getMaterialEmitColor(),1.0);}` :
    'precision mediump float;uniform sampler2D Texture0;varying vec2 vTexCoord0;varying vec3 vNormal;varying vec4 vColor;vec3 sRGBToLinear(vec3 x){return pow((x+0.055)/1.055,vec3(2.4));}vec3 getVertexColor(){return sRGBToLinear(vColor.rgb);}void main(){vec4 albedo=texture2D(Texture0,vTexCoord0);albedo.rgb*=getVertexColor();gl_FragColor=vec4(albedo.rgb*(0.9+0.1*abs(vNormal.z)),albedo.a);}';
  const images = pbrImages || [png];
  return `<!doctype html><meta charset="utf-8"><title>Offline textured triangle</title><canvas id="fixture" width="640" height="640"></canvas><script>
  const canvas = document.getElementById('fixture');
  const gl = canvas.getContext('webgl', {alpha:true, antialias:false});
  if (!gl) throw new Error('WebGL unavailable');
  function shader(type, source) { const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error('Shader failed');return s; }
  const program=gl.createProgram();
  gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec3 Vertex;attribute vec3 Normal;attribute vec2 TexCoord0;attribute vec4 Color;uniform float uArrayColorEnabled;uniform mat4 uModelMatrix;uniform mat4 uModelViewMatrix;uniform mat4 uProjectionMatrix;varying vec2 vTexCoord0;varying vec3 vNormal;varying vec4 vColor;void main(){vTexCoord0=TexCoord0;vNormal=Normal;vColor=uArrayColorEnabled==1.0?Color:vec4(1.0);gl_Position=uProjectionMatrix*uModelViewMatrix*uModelMatrix*vec4(Vertex,1.0);}'));
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,${JSON.stringify(fragment)}));
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Program failed');gl.useProgram(program);
  function attribute(name,size,values){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);const i=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,size,gl.FLOAT,false,0,0);}
  attribute('Vertex',3,[-0.8,-0.8,0,0.8,-0.8,0,0,0.8,0]);attribute('Normal',3,[0,0,1,0,0,1,0,0,1]);attribute('TexCoord0',2,[0,0,1,0,0.5,1]);
  if(!${Boolean(pbrImages)}){attribute('Color',4,[0.5,1,0.25,1,0.5,1,0.25,1,0.5,1,0.25,1]);gl.uniform1f(gl.getUniformLocation(program,'uArrayColorEnabled'),1);}
  const indices=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2]),gl.STATIC_DRAW);
  const identity=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);for(const name of ['uModelMatrix','uModelViewMatrix','uProjectionMatrix'])gl.uniformMatrix4fv(gl.getUniformLocation(program,name),false,identity);
  for(const [name,value]of Object.entries(${JSON.stringify(pbrImages ? { uAlbedoPBRFactor: 1, uMetalnessPBRFactor: 0.9, uRoughnessPBRFactor: 0.8, uNormalMapFactor: 0.75, uAOPBRFactor: 0.6, uEmitColorFactor: 0.5 } : {})}))gl.uniform1f(gl.getUniformLocation(program,name),value);
  if(${Boolean(pbrImages)})gl.uniform1i(gl.getUniformLocation(program,'uNormalMapFlipY'),1);
  Promise.all(${JSON.stringify(images)}.map((data,unit)=>new Promise(resolve=>{const image=new Image();image.onload=()=>{const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform1i(gl.getUniformLocation(program,'Texture'+unit),unit);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);resolve();};image.src='data:image/png;base64,'+data;}))).then(()=>{window.fixtureReady=true;function draw(){gl.viewport(0,0,640,640);gl.clearColor(0.05,0.05,0.05,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawElements(gl.TRIANGLES,3,gl.UNSIGNED_SHORT,0);requestAnimationFrame(draw);}draw();});
  </script>`;
}

function glbParts(bytes) {
  check(bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2, 'Export is not GLB 2');
  check(bytes.readUInt32LE(8) === bytes.length, 'GLB length differs');
  const length = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + length));
  return { json, binary: bytes.subarray(28 + length) };
}
function inspectionGeometry(snapshot) {
  return { ...snapshot, meshes: snapshot.meshes.map(mesh => {
    const copy = { ...mesh };
    for (const key of ['positions', 'normals', 'texcoords', 'colors', 'weights', 'joints', 'indices']) {
      const value = copy[key]; if (!value || Array.isArray(value)) continue;
      const bytes = Buffer.from(value.data, 'base64');
      copy[key] = Array.from({ length: value.count }, (_, i) => value.componentType === 'float32' ? bytes.readFloatLE(i * 4) : bytes.readUInt32LE(i * 4));
    }
    return copy;
  }) };
}
function bounds(snapshot) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of snapshot.meshes) for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]); max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  return { min, max };
}
function expectedPreviewBounds(snapshot) {
  if (snapshot.scene) return expectedSceneBounds(snapshot);
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

function expectedSceneBounds(snapshot) {
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const multiply = (a, b) => Array.from({ length: 16 }, (_, i) => {
    const row = i % 4, column = Math.floor(i / 4);
    return [0,1,2,3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
  });
  const point = (m, p) => [0,1,2].map(i => m[i] * p[0] + m[4+i] * p[1] + m[8+i] * p[2] + m[12+i]);
  function local(node) {
    if (node.matrix) return node.matrix;
    const [x,y,z,w] = node.rotation || [0,0,0,1], [a,b,c] = node.scale || [1,1,1], t = node.translation || [0,0,0];
    return [(1-2*(y*y+z*z))*a,2*(x*y+z*w)*a,2*(x*z-y*w)*a,0,
      2*(x*y-z*w)*b,(1-2*(x*x+z*z))*b,2*(y*z+x*w)*b,0,
      2*(x*z+y*w)*c,2*(y*z-x*w)*c,(1-2*(x*x+y*y))*c,0,...t,1];
  }
  function inverse(m) {
    const a=m[0],b=m[4],c=m[8],d=m[1],e=m[5],f=m[9],g=m[2],h=m[6],i=m[10];
    const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g); check(Math.abs(det)>1e-20,'Scene has a singular mesh transform');
    const out=[(e*i-f*h)/det,(f*g-d*i)/det,(d*h-e*g)/det,0,(c*h-b*i)/det,(a*i-c*g)/det,(b*g-a*h)/det,0,
      (b*f-c*e)/det,(c*d-a*f)/det,(a*e-b*d)/det,0,0,0,0,1];
    const t=point(out,[-m[12],-m[13],-m[14]]);out[12]=t[0];out[13]=t[1];out[14]=t[2];return out;
  }
  const nodes=snapshot.scene.nodes, parents=nodes.map(()=>-1), worlds=[];
  nodes.forEach((node,index)=>(node.children||[]).forEach(child=>{parents[child]=index;}));
  const world = index => worlds[index] ||= multiply(parents[index] < 0 ? identity : world(parents[index]),local(nodes[index]));
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  nodes.forEach((node,index)=>{
    if (node.mesh === undefined) return;
    const mesh=snapshot.meshes[node.mesh], transform=world(index), localMin=[Infinity,Infinity,Infinity], localMax=[-Infinity,-Infinity,-Infinity];
    let joints;
    if(node.skin !== undefined){const skin=snapshot.scene.skins[node.skin], inv=inverse(transform);joints=skin.joints.map((joint,j)=>multiply(inv,multiply(world(joint),skin.inverseBindMatrices.slice(j*16,j*16+16))));}
    for(let v=0;v<mesh.positions.length/3;v++){
      const source=mesh.positions.slice(v*3,v*3+3).map(Math.fround);let p=source;
      if(joints){p=[0,0,0];const weights=mesh.weights.slice(v*4,v*4+4),sum=weights.reduce((a,b)=>a+b,0);weights.forEach((weight,j)=>{if(!weight)return;const q=point(joints[mesh.joints[v*4+j]],source);q.forEach((value,c)=>{p[c]+=value*weight/sum;});});}
      p.forEach((value,c)=>{localMin[c]=Math.min(localMin[c],value);localMax[c]=Math.max(localMax[c],value);});
    }
    for(let corner=0;corner<8;corner++){
      const p=point(transform,[0,1,2].map(i=>(corner&(1<<i))?localMax[i]:localMin[i]));
      const converted=snapshot.coordinateSystem==='sketchfab-z-up'?[p[0],p[2],-p[1]]:p;
      converted.forEach((value,c)=>{min[c]=Math.min(min[c],value);max[c]=Math.max(max[c],value);});
    }
  });
  return max.map((value,index)=>value-min[index]);
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
    report.sourceHashes = {};
    for (const file of ['extension/sketchfab-viewer-recorder.js', 'extension/sketchfab-scene-recorder.js', 'src/sketchfab-viewer-export.cjs'])
      report.sourceHashes[file] = crypto.createHash('sha256').update(await fs.readFile(path.join(ROOT, file))).digest('hex');
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
    const pbrPngs = await Promise.all([[30,220,70,64], [128,192,240,204], [64,32,16,102]].map(async color =>
      (await sharp(Buffer.from(Array.from({ length: 4 }, () => color).flat()), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer()).toString('base64')));
    async function snapshot(window, modelId) {
      const requestId = crypto.randomBytes(16).toString('hex');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Snapshot response timed out')), 65000);
        const listener = (event, value) => {
          if (event.sender !== window.webContents || value?.requestId !== requestId) return;
          finish(value.ok ? null : Object.assign(new Error(value.code || 'Snapshot failed'), { remoteStack: value.detail }), value.snapshot);
        };
        function finish(error, value) { clearTimeout(timer); ipcMain.removeListener('smoke-snapshot-result', listener); error ? reject(error) : resolve(value); }
        ipcMain.on('smoke-snapshot-result', listener); window.webContents.send('smoke-snapshot', { requestId, modelId });
      });
    }
    async function runCase(name, modelId, live, pbr = false) {
      const pbrPreview = pbr || modelId === PBR_MODEL;
      const directory = path.join(base, name); await fs.mkdir(directory);
      const result = { name, modelId, live, ok: false, phase: 'loading',
        recorderHash: crypto.createHash('sha256').update(await fs.readFile(path.join(ROOT, 'extension/sketchfab-viewer-recorder.js'))).digest('hex') };
      result.sourceHashes = {};
      for (const file of ['extension/sketchfab-viewer-recorder.js', 'extension/sketchfab-scene-recorder.js', 'src/sketchfab-viewer-export.cjs'])
        result.sourceHashes[file] = crypto.createHash('sha256').update(await fs.readFile(path.join(ROOT, file))).digest('hex');
      report.cases.push(result); await flush();
      let captureWindow, preview;
      try {
        const url = `https://sketchfab.com/models/${modelId}/embed?autostart=1&ui_infos=0&ui_controls=0&ui_stop=0`;
        const captureSession = session.fromPartition('smoke-' + crypto.randomUUID());
        if (!live) captureSession.protocol.handle('https', request => request.url === url ? new Response(fixturePage(png.toString('base64'), pbr ? pbrPngs : null), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response(null, { status: 404 }));
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
        if (live) await wait(config.loadWaitMs || 15000);
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
        const wireValue = JSON.parse(JSON.stringify(await capture)), value = inspectionGeometry(wireValue);
        await fs.writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(wireValue));
        const animationPreview = Boolean(value.scene?.animations?.length);
        check(value.coordinateSystem === 'sketchfab-z-up', 'Recorder coordinate system is missing');
        result.coordinateSystem = value.coordinateSystem; result.expectedPreviewBounds = expectedPreviewBounds(value);
        result.bounds = bounds(value); result.snapshot = { meshes: value.meshes.length, images: value.images.length, warnings: value.warnings || [] };
        const exported = exportSketchfabViewer(wireValue); result.export = exported.stats;
        const glb = path.join(directory, 'captured.glb'); await fs.writeFile(glb, exported.glb);
        const parsed = glbParts(exported.glb);
        result.materials = parsed.json.materials.map(m => ({ factor: m.pbrMetallicRoughness.baseColorFactor, textured: !!m.pbrMetallicRoughness.baseColorTexture, alphaMode: m.alphaMode,
          metallicFactor: m.pbrMetallicRoughness.metallicFactor, roughnessFactor: m.pbrMetallicRoughness.roughnessFactor,
          metallicRoughnessTexture: m.pbrMetallicRoughness.metallicRoughnessTexture, normalTexture: m.normalTexture,
          occlusionTexture: m.occlusionTexture, emissiveTexture: m.emissiveTexture, emissiveFactor: m.emissiveFactor }));
        if (!live && !pbr) {
          check(exported.stats.vertexCount === 3 && exported.stats.triangleCount === 1 && exported.stats.imageCount === 1, 'Offline geometry or texture count differs');
          check(value.meshes[0].normals?.length === 9 && value.meshes[0].texcoords?.length === 6, 'Offline normals or UVs missing');
          check(value.meshes[0].colors?.length === 12 && parsed.json.meshes[0].primitives[0].attributes.COLOR_0 !== undefined, 'Offline vertex colors missing');
          check(Math.abs(value.meshes[0].colors[0] - Math.pow((0.5 + 0.055) / 1.055, 2.4)) < 1e-7 && value.meshes[0].colors[3] === 1, 'Vertex color transfer or alpha differs');
          check(parsed.json.materials[0].alphaMode === 'BLEND', 'PNG transparency was lost');
          const image = parsed.json.images[0], view = parsed.json.bufferViews[image.bufferView];
          const decoded = await sharp(parsed.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)).ensureAlpha().raw().toBuffer();
          const alpha = [...decoded].filter((_, index) => index % 4 === 3); result.alpha = { min: Math.min(...alpha), max: Math.max(...alpha) };
          check(result.alpha.min === 0 && result.alpha.max === 255, 'PNG alpha pixels differ');
        } else if (pbr) {
          const material = parsed.json.materials[0], pbrMaterial = material.pbrMetallicRoughness;
          const imagePixel = async info => {
            check(info && Number.isInteger(info.index), 'PBR texture reference is missing');
            const image = parsed.json.images[parsed.json.textures[info.index].source], view = parsed.json.bufferViews[image.bufferView];
            const pixels = await sharp(parsed.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)).ensureAlpha().raw().toBuffer();
            return [...pixels.subarray(0, 4)];
          };
          result.pbrPixels = {
            base: await imagePixel(pbrMaterial.baseColorTexture), mr: await imagePixel(pbrMaterial.metallicRoughnessTexture),
            normal: await imagePixel(material.normalTexture), occlusion: await imagePixel(material.occlusionTexture), emission: await imagePixel(material.emissiveTexture),
          };
          const close = (a, b) => Math.abs(a - b) <= 2 / 255;
          check(result.pbrPixels.base[3] === 255 && material.alphaMode !== 'BLEND', 'Packed roughness alpha was mistaken for transparency');
          check(close(result.pbrPixels.mr[1] / 255 * (pbrMaterial.roughnessFactor ?? 1), 64 / 255 * 0.8), 'Roughness channel/factor differs');
          check(close(result.pbrPixels.mr[2] / 255 * (pbrMaterial.metallicFactor ?? 1), 204 / 255 * 0.9), 'Metalness channel/factor differs');
          check(close(1 + (result.pbrPixels.occlusion[0] / 255 - 1) * (material.occlusionTexture.strength ?? 1), 1 + (102 / 255 - 1) * 0.6), 'AO channel/factor differs');
          check(close((result.pbrPixels.normal[1] / 255 * 2 - 1) * (material.normalTexture.scale ?? 1), -(192 / 255 * 2 - 1) * 0.75), 'Normal Y convention/scale differs');
          check(result.pbrPixels.emission.slice(0, 3).every((value, i) => value === [64,32,16][i]), 'Emission color texture differs');
          check(material.emissiveFactor?.every(value => close(value, 0.5)), 'Emission strength differs');
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
        } else {
          check(exported.stats.imageCount > 0, 'Textured public sample lost its texture');
          if (pbrPreview) check(result.materials.some(m => m.metallicRoughnessTexture && m.normalTexture && m.occlusionTexture && m.emissiveTexture), 'Public PBR sample lost one of its packed material channels');
        }
        result.phase = 'previewing'; await flush();
        const imported = await deadline(library.importPaths([glb]), 50000, 'GLB import/thumbnail timed out'); check(imported.imported === 1 && !imported.errors.length, 'GLB did not import');
        const asset = library.snapshot().assets.find(a => a.hash && a.name === 'captured' && a.id === imported.assetIds?.[0]) || library.snapshot().assets.at(-1);
        const options = await service.prepare(library, asset.id, library.root);
        preview = new BrowserWindow({ width: 640, height: 640, show: false, skipTaskbar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } }); windows.add(preview);
        preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        await preview.loadFile(path.join(ROOT, 'src/model-viewer.html'));
        if (pbrPreview || animationPreview) await preview.webContents.executeJavaScript(`(async () => {
          const { GLTFLoader } = await import('./vendor/three/addons/loaders/GLTFLoader.js');
          const THREE = await import('./vendor/three/three.module.js');
          const { clone } = await import('./vendor/three/addons/utils/SkeletonUtils.js');
          const original = GLTFLoader.prototype.parseAsync;
          GLTFLoader.prototype.parseAsync = async function (...args) {
            const value = await original.apply(this, args), materials = [];
            value.scene.traverse(node => { if (!node.isMesh) return;
              for (const m of Array.isArray(node.material) ? node.material : [node.material]) materials.push({
                type: m.type, metalness: m.metalness, roughness: m.roughness, transparent: m.transparent,
                emissive: m.emissive?.toArray(), emissiveIntensity: m.emissiveIntensity, normalScale: m.normalScale?.toArray(),
                aoMapIntensity: m.aoMapIntensity,
                maps: Object.fromEntries(['map','metalnessMap','roughnessMap','normalMap','aoMap','emissiveMap'].map(key => [key,
                  m[key] ? { texture: m[key].isTexture, colorSpace: m[key].colorSpace, width: m[key].image?.width, height: m[key].image?.height } : null]))
              });
            });
            window.__smokePbrMaterials = materials;
            if (${animationPreview}) {
              const object = clone(value.scene), mixer = new THREE.AnimationMixer(object), clip = value.animations[0];
              mixer.clipAction(clip).play();
              const frames = [], meshes = [], bones = new Set();
              object.traverse(node => { if (node.isSkinnedMesh) { meshes.push(node); node.skeleton.bones.forEach(bone => bones.add(bone)); } });
              for (const time of [0,Math.min(0.5,clip.duration*0.25),clip.duration*0.37]) {
                mixer.setTime(time); object.updateMatrixWorld(true); meshes.forEach(mesh => mesh.skeleton.update());
                const vertices = [], matrices = [...bones].flatMap(bone => bone.matrixWorld.elements);
                for (const mesh of meshes) {
                  const count = mesh.geometry.attributes.position.count, stride = Math.max(1,Math.floor(count/256));
                  for (let i=0;i<count;i+=stride) vertices.push(...mesh.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).toArray());
                }
                frames.push({ time, vertices, matrices });
              }
              const distance = (a,b) => Math.max(...a.map((value,index) => Math.abs(value-b[index])));
              window.__smokeAnimation = { clips:value.animations.length, tracks:clip.tracks.length, duration:clip.duration,
                bones:bones.size, skinnedMeshes:meshes.length, finite:frames.every(frame=>[...frame.vertices,...frame.matrices].every(Number.isFinite)),
                vertexChange:Math.max(...frames.slice(1).map(frame=>distance(frame.vertices,frames[0].vertices))),
                boneChange:Math.max(...frames.slice(1).map(frame=>distance(frame.matrices,frames[0].matrices))),
                sampledTimes:frames.map(frame=>frame.time), sampledVertices:frames[0].vertices.length/3 };
              const reference = ${JSON.stringify(config.poseReference?.modelId === modelId ? config.poseReference : null)};
              if (reference) {
                const active = reference.active[0], time = (reference.simTime-active.start)%active.duration+(active.firstKeyTime||0);
                mixer.setTime(time); object.updateMatrixWorld(true); meshes.forEach(mesh => mesh.skeleton.update());
                const comparisons = [];
                for (const sample of reference.samples) {
                  let best = null, bestDistance = Infinity;
                  for (const mesh of meshes) {
                    const position = mesh.geometry.attributes.position, joints = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
                    for (let index=0;index<position.count;index++) {
                      const p=[position.getX(index),position.getY(index),position.getZ(index)];
                      let distance=Math.max(...p.map((v,i)=>Math.abs(v-sample.gpuLocalPosition[i])));
                      if (distance>bestDistance) continue;
                      if (sample.joints && sample.weights) {
                        const ji=[joints.getX(index),joints.getY(index),joints.getZ(index),joints.getW(index)];
                        const we=[weights.getX(index),weights.getY(index),weights.getZ(index),weights.getW(index)];
                        const sum=sample.weights.reduce((a,b)=>a+b,0);
                        if (ji.some((joint,i)=>sample.weights[i]>0 && joint!==sample.joints[i])) continue;
                        distance=Math.max(distance,...we.map((v,i)=>Math.abs(v-sample.weights[i]/sum)));
                      }
                      if (distance<bestDistance) { bestDistance=distance;best={mesh,index}; }
                    }
                  }
                  if (!best) throw new Error('Reference vertex could not be matched');
                  const actual = best.mesh.getVertexPosition(best.index,new THREE.Vector3()).applyMatrix4(best.mesh.matrixWorld).toArray();
                  comparisons.push({ sourceIndex:sample.index, matchedIndex:best.index, bindError:bestDistance, actual,
                    expected:sample.expectedYUp,error:Math.max(...actual.map((v,i)=>Math.abs(v-sample.expectedYUp[i]))) });
                }
                window.__smokeAnimation.reference={time,comparisons,maxBindError:Math.max(...comparisons.map(c=>c.bindError)),maxPoseError:Math.max(...comparisons.map(c=>c.error))};
              }
              mixer.stopAllAction(); mixer.uncacheRoot(object);
            }
            return value;
          };
        })()`);
        const rendered = await preview.webContents.executeJavaScript(`window.renderModelThumbnail(${JSON.stringify(options)})`);
        result.preview = rendered.metadata;
        check(rendered.metadata.vertices > 0 && rendered.metadata.triangles > 0, 'Preview geometry missing');
        result.previewBoundsError = Math.max(...result.expectedPreviewBounds.map((value, index) => Math.abs(value - rendered.metadata.bounds[index])));
        check(result.previewBoundsError < 0.0001, 'Preview did not apply the Z-up to Y-up coordinate conversion');
        if (animationPreview) {
          result.animation = await preview.webContents.executeJavaScript('window.__smokeAnimation');
          check(result.animation?.finite && result.animation.skinnedMeshes > 0, 'Actual preview lost a valid skinned scene');
          check(result.animation.boneChange > 1e-5 && result.animation.vertexChange > 1e-5, 'Animation did not move bones and CPU skinned vertices');
          check(result.animation.vertexChange < Math.max(...result.expectedPreviewBounds) * 10, 'Animation skin vertices exploded outside the model scale');
          if (modelId === ANIMATED_MODEL) {
            check(result.animation.bones === 22 && result.animation.clips === 1 && result.animation.tracks === 69, 'Fox bones or animation tracks were lost');
          }
          if (config.poseReference?.modelId === modelId) {
            const reference = result.animation.reference;
            check(reference && reference.comparisons.length >= 5 && reference.maxBindError < 0.0001, 'Runtime palette reference did not match the captured vertices');
            reference.normalizedPoseError = reference.maxPoseError / Math.max(...result.expectedPreviewBounds);
            check(reference.normalizedPoseError < 0.000001, 'Exported animated pose differs from the actual viewer GPU palette');
          }
        }
        if (pbrPreview) {
          result.previewMaterials = await preview.webContents.executeJavaScript('window.__smokePbrMaterials');
          const material = result.previewMaterials?.find(m => Object.values(m.maps).every(value => value?.texture && value.width > 0 && value.height > 0));
          const exportedMaterial = parsed.json.materials.find(m => m.pbrMetallicRoughness.metallicRoughnessTexture && m.normalTexture && m.occlusionTexture && m.emissiveTexture);
          check(material?.type === 'MeshStandardMaterial', 'PBR material did not load into the actual preview');
          check(Object.values(material.maps).every(value => value?.texture && value.width > 0 && value.height > 0), 'Actual preview lost a PBR map');
          check(!material.transparent, 'Actual preview confused packed alpha with transparency');
          check(material.maps.map.colorSpace === 'srgb' && material.maps.emissiveMap.colorSpace === 'srgb', 'Actual preview lost color-texture color space');
          check(material.maps.normalMap.colorSpace !== 'srgb' && material.maps.roughnessMap.colorSpace !== 'srgb', 'Actual preview treated data maps as sRGB');
          check(material.metalness === exportedMaterial.pbrMetallicRoughness.metallicFactor && material.roughness === exportedMaterial.pbrMetallicRoughness.roughnessFactor, 'Actual preview lost PBR factors');
          const normalScale = exportedMaterial.normalTexture.scale ?? 1;
          check(material.normalScale?.[0] === normalScale && Math.abs(material.normalScale[1]) === normalScale, 'Actual preview lost normal strength');
          check(material.aoMapIntensity === (exportedMaterial.occlusionTexture.strength ?? 1), 'Actual preview lost AO strength');
          check(material.emissive?.every((value, index) => value === exportedMaterial.emissiveFactor[index]), 'Actual preview lost emissive color');
          check(material.emissiveIntensity === (exportedMaterial.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1), 'Actual preview lost emission strength');
        }
        const imageBytes = Buffer.from(rendered.dataUrl.split(',')[1], 'base64'); await fs.writeFile(path.join(directory, 'preview.jpg'), imageBytes);
        if (!live && !pbr) {
          const rgba = await sharp(imageBytes).ensureAlpha().raw().toBuffer(); let green = 0;
          for (let i = 0; i < rgba.length; i += 4) if (rgba[i+1] > rgba[i] + 20 && rgba[i+1] > rgba[i+2] + 20 && rgba[i+1] > 60) green++;
          result.previewGreenPixels = green; check(green > 1000, 'PNG texture was not visible in actual preview');
        }
        result.ok = true; result.phase = 'complete';
      } catch (error) { result.error = error.message; if (error.code) result.errorCode = error.code; if (error.remoteStack) result.remoteStack = error.remoteStack; }
      finally { for (const window of [captureWindow, preview]) if (window && !window.isDestroyed()) { window.destroy(); windows.delete(window); } await flush(); }
    }
    await runCase('offline', FIXTURE_ID, false);
    await runCase('offline-pbr', FIXTURE_ID, false, true);
    if (config.live) for (const [i, modelId] of (config.models || PUBLIC_MODELS).entries()) await runCase('live-' + (i + 1), modelId, true);
    report.ok = report.cases.every(c => c.ok); check(config.live || report.externalRequests === 0, 'Offline smoke attempted external access');
  } catch (error) { report.error = error.message; }
  finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await service?.shutdown(); report.finishedAt = new Date().toISOString(); await flush(); app.exit(report.ok ? 0 : 1);
  }
}

async function parentMain() {
  const modelsArg = process.argv.find(arg => arg.startsWith('--models='));
  const models = modelsArg ? modelsArg.slice('--models='.length).split(',') : undefined;
  const loadWaitArg = process.argv.find(arg => arg.startsWith('--load-wait='));
  const loadWaitMs = loadWaitArg ? Number(loadWaitArg.slice('--load-wait='.length)) : 15000;
  check(Number.isSafeInteger(loadWaitMs) && loadWaitMs >= 0 && loadWaitMs <= 90000, 'Load wait must be 0..90000 ms');
  const referenceArg = process.argv.find(arg => arg.startsWith('--pose-reference='));
  let poseReference;
  if (referenceArg) {
    const bytes = await fs.readFile(referenceArg.slice('--pose-reference='.length));
    check(bytes.length < 5 * 1024 * 1024, 'Pose reference exceeds test limit');
    poseReference = JSON.parse(bytes);
    check(/^[a-f0-9]{32}$/.test(poseReference.modelId) && Number.isFinite(poseReference.simTime) && poseReference.active?.length === 1 &&
      Array.isArray(poseReference.samples) && poseReference.samples.length >= 5 && poseReference.samples.length <= 1000 &&
      poseReference.samples.every(s=>[s.gpuLocalPosition,s.expectedYUp].every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite))), 'Invalid runtime palette reference');
  }
  check(!models || models.length > 0 && models.length <= 8 && models.every(id => /^[a-f0-9]{32}$/.test(id)), 'Expected --models=<32-hex-id>[,<32-hex-id>...] (maximum 8)');
  const live = process.argv.includes('--live') || Boolean(models), base = await fs.mkdtemp(path.join(ROOT, 'tmp', 'sketchfab-viewer-smoke-'));
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'mosaic-sketchfab-viewer-smoke', main: __filename }));
  await fs.writeFile(path.join(base, 'config.json'), JSON.stringify({ root: ROOT, base, live, models, poseReference, loadWaitMs, compact: process.argv.includes('--compact'), diagnosticRedraw: process.argv.includes('--diagnostic-redraw') }));
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
