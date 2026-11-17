'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');
const { prepareModelTestFixtures } = require('./prepare-model-test-fixtures.cjs');
(async () => {
  // Fixture downloads are an explicit separate step; this test stays offline.
  const { samplesRoot } = await prepareModelTestFixtures({ download: false });
  await fs.mkdir(path.join(root, '.recovery', 'tests'), { recursive: true });
  const base = await fs.mkdtemp(path.join(root, '.recovery', 'tests', 'model-viewer-'));
  const texture = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: { r: 40, g: 210, b: 100 } } }).png().toBuffer();
  const vertices = new Float32Array([-1, -0.8, 0, 1, -0.8, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1]);
  const data = Buffer.concat([Buffer.from(vertices.buffer), Buffer.from(normals.buffer), Buffer.from(uvs.buffer)]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] }],
    buffers: [{ uri: 'mesh.bin', byteLength: data.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }, { buffer: 0, byteOffset: 72, byteLength: 24 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -0.8, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' }],
    images: [{ uri: 'textures/albedo.png' }], textures: [{ source: 0 }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } }]
  };
  const glbJson = structuredClone(gltf); delete glbJson.buffers[0].uri;
  glbJson.images[0].uri = 'data:image/png;base64,' + texture.toString('base64');
  const json = Buffer.from(JSON.stringify(glbJson)); const jsonChunk = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(jsonChunk);
  const glb = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + data.length);
  glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(jsonChunk.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); jsonChunk.copy(glb, 20);
  const bin = 20 + jsonChunk.length; glb.writeUInt32LE(data.length, bin); glb.writeUInt32LE(0x004e4942, bin + 4); data.copy(glb, bin + 8);
  const fixtures = {
    'mesh.gltf': Buffer.from(JSON.stringify(gltf)), 'mesh.bin': data, 'mesh.glb': glb, 'textures/albedo.png': texture,
    'mesh.obj': Buffer.from('mtllib material.mtl\nv -1 -0.8 0\nv 1 -0.8 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0.5 1\nvn 0 0 1\nusemtl green\nf 1/1/1 2/2/1 3/3/1\n'),
    'material.mtl': Buffer.from('newmtl green\nKd 1 1 1\nmap_Kd textures/albedo.png\n'),
    'mesh.stl': Buffer.from('solid triangle\nfacet normal 0 0 1\nouter loop\nvertex -1 -0.8 0\nvertex 1 -0.8 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n'),
    'mesh.ply': Buffer.from('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n-1 -0.8 0\n1 -0.8 0\n0 1 0\n3 0 1 2\n')
  };
  fixtures['embedded.fbx'] = await fs.readFile(path.join(samplesRoot, 'monkey_embedded_texture.fbx'));
  fixtures['compressed.glb'] = await fs.readFile(path.join(samplesRoot, 'littlest-tokyo.glb'));
  fixtures['textures/albedo.ktx2'] = await fs.readFile(path.join(samplesRoot, 'albedo-etc1s.ktx2'));
  fixtures['points.ply'] = Buffer.from('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nend_header\n-1 -0.8 0 0 0 1\n1 -0.8 0 0 0 1\n0 1 0 0 0 1\n');
  const ktx = structuredClone(gltf); ktx.extensionsUsed = ['KHR_texture_basisu']; ktx.extensionsRequired = ['KHR_texture_basisu'];
  ktx.images[0].uri = 'textures/albedo.ktx2'; ktx.textures[0] = { extensions: { KHR_texture_basisu: { source: 0 } } };
  fixtures['ktx.gltf'] = Buffer.from(JSON.stringify(ktx));
  const serialized = Object.fromEntries(Object.entries(fixtures).map(([name, bytes]) => [name, bytes.toString('base64')]));
  await fs.writeFile(path.join(base, 'fixture.json'), JSON.stringify(serialized));
  const bootstrap = `
const {app,BrowserWindow,protocol,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
for(const name of ['profile','sessions'])fs.mkdirSync(path.join(__dirname,name),{recursive:true});
app.setName('Shitu isolated model viewer test'); app.setPath('userData',path.join(__dirname,'profile')); app.setPath('sessionData',path.join(__dirname,'sessions'));
protocol.registerSchemesAsPrivileged([{scheme:'shitu',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixture.json'),'utf8'));
let networkAttempts=0; const failures=[];
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>{networkAttempts++;done({cancel:true})});
 protocol.handle('shitu',request=>{ const url=new URL(request.url); const name=decodeURIComponent(url.pathname.split('/').slice(2).join('/')); const bytes=fixture[name]; return bytes?new Response(Buffer.from(bytes,'base64'),{headers:{'Content-Type':name.endsWith('.png')?'image/png':'application/octet-stream','Access-Control-Allow-Origin':'*'}}):new Response(null,{status:404}); });
 const window=new BrowserWindow({width:640,height:480,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
 window.setSkipTaskbar(true); window.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)failures.push(event.message)});
 try{
 await window.loadFile(${JSON.stringify(path.join(root, 'src', 'model-viewer.html'))});
 const names=Object.keys(fixture);
 const results=[];
 for(const [format,entry] of [...['gltf','glb','obj','stl','ply'].map(format=>[format,'mesh.'+format]),['fbx','embedded.fbx'],['glb','compressed.glb'],['gltf','ktx.gltf'],['ply','points.ply']]){
 const options={format,entry,url:'shitu://model/test/'+entry,files:names.map(name=>({path:name,url:'shitu://model/test/'+name.split('/').map(encodeURIComponent).join('/')}))};
 const result=await window.webContents.executeJavaScript('window.renderModelThumbnail('+JSON.stringify(options)+')');
 if(!result.metadata.vertices || !result.dataUrl.startsWith('data:image/jpeg;base64,'))throw Error('Failed '+format);
 if(result.metadata.warnings.length)throw Error('Unexpected warning for '+entry+': '+JSON.stringify(result.metadata.warnings));
 if(entry==='points.ply'&&(result.metadata.meshes!==0||result.metadata.triangles!==0))throw Error('PLY point cloud was converted into fake triangles');
 fs.writeFileSync(path.join(__dirname,entry+'.jpg'),Buffer.from(result.dataUrl.split(',')[1],'base64'));
 results.push({entry,format,...result.metadata,jpegBytes:result.dataUrl.length});
 }
 fixture['material.mtl']=Buffer.from('newmtl green\\nKd 1 1 1\\nmap_Kd http://127.0.0.1:1/private.png\\n').toString('base64');
 const security=await window.webContents.executeJavaScript('window.renderModelThumbnail('+JSON.stringify({format:'obj',entry:'mesh.obj',url:'shitu://model/test/mesh.obj',files:names.map(name=>({path:name,url:'shitu://model/test/'+name.split('/').map(encodeURIComponent).join('/')}))})+')');
 if(networkAttempts!==0||!security.metadata.warnings.length)throw Error('Network reference not blocked');
 const raceOptions={format:'glb',entry:'compressed.glb',url:'shitu://model/test/compressed.glb',files:names.map(name=>({path:name,url:'shitu://model/test/'+name.split('/').map(encodeURIComponent).join('/')}))};
 const race=await window.webContents.executeJavaScript('(async()=>{const options='+JSON.stringify(raceOptions)+';const a=window.renderModelThumbnail(options);const b=window.renderModelThumbnail(options);const settled=await Promise.allSettled([a,b]);return settled.map(result=>({status:result.status,errorName:result.reason?.name,vertices:result.value?.metadata.vertices}));})()');
 if(race[0].status!=='rejected'||race[0].errorName!=='AbortError'||race[1].status!=='fulfilled')throw Error('Stale model load not isolated: '+JSON.stringify(race));
 if(failures.length)throw Error('Viewer console errors: '+failures.join('\\n'));
 fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:true,networkAttempts,results,resourceWarnings:security.metadata.warnings,race},null,2));
 await window.webContents.executeJavaScript('window.disposeModelThumbnail()'); window.destroy(); app.exit(0);
 }catch(error){console.error(error);fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:false,error:error.stack,failures}));app.exit(1)}
});
setTimeout(()=>app.exit(2),60000).unref();
`;
  await fs.writeFile(path.join(base, 'main.cjs'), bootstrap);
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'shitu-model-viewer-test', main: 'main.cjs' }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [base], { windowsHide: true, stdio: 'inherit', env });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Model viewer smoke timed out: ' + base)); }, 90000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  const resultFile = path.join(base, 'result.json');
  const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  await prepareModelTestFixtures({ download: false });
  result.originalSamplesUnchanged = true; result.reportDirectory = base;
  const reports = path.join(root, '.recovery', 'reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, 'model-viewer-smoke.json'), JSON.stringify(result, null, 2) + '\n');
  if (code !== 0 || !result.ok) throw new Error('Model viewer smoke failed: ' + JSON.stringify(result));
  await fs.copyFile(path.join(base, 'compressed.glb.jpg'), path.join(reports, 'model-viewer-draco.jpg'));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
