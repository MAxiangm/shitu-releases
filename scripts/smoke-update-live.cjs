'use strict';
// Explicit live-network diagnostic. Never run automatically in CI.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');

(async () => {
  const tests = path.join(root, '.recovery', 'tests'); fs.mkdirSync(tests, { recursive: true });
  const base = fs.mkdtempSync(path.join(tests, 'update-live-electron-'));
  const bootstrap = path.join(base, 'main.cjs');
  const installed = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Shitu', 'resources', 'app', 'src', 'app-updater.cjs');
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'shitu-update-network-check', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(bootstrap, `'use strict';
const { app, net, session } = require('electron');
const fs = require('node:fs/promises'); const path = require('node:path');
const base=${JSON.stringify(base)}, root=${JSON.stringify(root)}, installed=${JSON.stringify(installed)};
app.setName('shitu-update-network-check'); app.setPath('userData', path.join(base,'profile'));
function safeMessage(value) { return String(value||'').split('https:')[0].split('http:')[0]; }
function errorInfo(error) { return {name:error?.name,message:safeMessage(error?.message||error),code:error?.code,cause:error?.cause?{name:error.cause.name,message:safeMessage(error.cause.message),code:error.cause.code}:null}; }
function address(value) { const url=new URL(value); return url.hostname+url.pathname; }
const report={electron:process.versions.electron,node:process.versions.node,results:[],requests:[],transportDiagnostics:[],userData:app.getPath('userData'),fullInstallerDownloaded:false,installerExecuted:false,systemProxyConfigurationChanged:false};
const timeout=setTimeout(()=>{ fs.writeFile(path.join(base,'result.json'),JSON.stringify({...report,ok:false,error:'probe timeout'},null,2)).finally(()=>app.exit(2)); },180000);
app.whenReady().then(async()=>{
 try {
  const latest='https://api.github.com/repos/MAxiangm/shitu-releases/releases/latest';
  const proxy=await session.defaultSession.resolveProxy(latest); report.proxyType=proxy.split(/[ ;]/)[0];
  const {createUpdateTransport}=require(path.join(root,'src','update-transport.cjs'));
  const productionTransport=createUpdateTransport({net,onDiagnostic:detail=>{report.transportDiagnostics.push({phase:detail?.phase,event:detail?.event,host:detail?.host,status:detail?.status,code:detail?.code});}});
  for(const [name,options] of [['default',{}],['manual',{redirect:'manual'}],['production',{redirect:'manual',headers:{Accept:'application/json','User-Agent':'Shitu/0.13.0'}}],['fresh',{redirect:'manual',cache:'no-store',headers:{Accept:'application/json','User-Agent':'Shitu/0.13.1','Cache-Control':'no-cache, no-store, max-age=0',Pragma:'no-cache'}}]]) {
   try { const response=await net.fetch(latest+'?live='+Date.now(),{...options,signal:AbortSignal.timeout(15000)}); const text=await response.text(); let parsed;try{parsed=JSON.parse(text);}catch{}; const result={name,status:response.status,type:response.type,tag:parsed?.tag_name,contentType:response.headers.get('content-type')};report.results.push(result);console.log(JSON.stringify(result)); }
   catch(error) { const result={name,error:errorInfo(error)};report.results.push(result);console.log(JSON.stringify(result)); }
  }
  let detectedVersion;
  for(const [name,filename,transport] of [['installed-electron-net',installed,net.fetch],['workspace-electron-net',path.join(root,'src','app-updater.cjs'),net.fetch],['workspace-native-transport',path.join(root,'src','app-updater.cjs'),productionTransport],['workspace-node-fetch',path.join(root,'src','app-updater.cjs'),fetch]]) {
   try { const {createAppUpdater}=require(filename); const updater=createAppUpdater({currentVersion:'0.13.0',repository:'MAxiangm/shitu-releases',cacheDir:path.join(base,'updates'),fetchImpl:async(url,options)=>{const trace={client:name,address:address(url),cache:options.cache,redirect:options.redirect};report.requests.push(trace);try{const response=await transport(url,options);trace.status=response.status;trace.type=response.type;trace.location=response.headers.get('location')?address(new URL(response.headers.get('location'),url).href):undefined;return response;}catch(error){trace.error=errorInfo(error);throw error;}}});try {const state=await updater.check(); const result={name,status:state.status,latestVersion:state.latestVersion,message:state.message};report.results.push(result);if(name==='workspace-native-transport')detectedVersion=state.latestVersion;console.log(JSON.stringify(result));}finally{updater.dispose();} }
   catch(error) { const result={name,error:errorInfo(error)};report.results.push(result);console.log(JSON.stringify(result)); }
  }
  if(detectedVersion) {
   let url='https://github.com/MAxiangm/shitu-releases/releases/download/v'+detectedVersion+'/shitu-'+detectedVersion+'-setup.exe';
   const allowed=new Set(['github.com','api.github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
   for(let redirects=0;redirects<=5;redirects++) {
    const checked=new URL(url);if(checked.protocol!=='https:'||!allowed.has(checked.hostname)||checked.username||checked.password||checked.port)throw new Error('The tiny-range probe refused an untrusted redirect');
    const response=await productionTransport(url,{redirect:'manual',headers:{Range:'bytes=0-1',Accept:'application/octet-stream'},signal:AbortSignal.timeout(20000)});
    const trace={client:'installer-range',address:address(url),status:response.status};report.requests.push(trace);
    if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location||redirects===5)throw new Error('The tiny-range probe exceeded redirects');url=new URL(location,url).href;trace.location=address(url);continue;}
    if(response.status!==206){await response.body?.cancel();throw new Error('The public installer did not honor the tiny range; refusing a full download');}
    const reader=response.body.getReader();let prefix=Buffer.alloc(0);
    try {while(prefix.length<2){const next=await reader.read();if(next.done)break;prefix=Buffer.concat([prefix,Buffer.from(next.value)]);if(prefix.length>4096)throw new Error('The tiny range exceeded the read limit');}}
    finally{await reader.cancel();}
    if(prefix.subarray(0,2).toString('ascii')!=='MZ')throw new Error('The public installer is not a Windows executable');
    report.installerPrefix='MZ';report.installerBytesRead=prefix.length;report.nativeRedirectRangeVerified=true;break;
   }
  }
  const nativeRequests=report.requests.filter(item=>item.client==='workspace-native-transport');
  report.nativeManifestRedirectVerified=nativeRequests.some(item=>item.status===302&&item.location?.startsWith('release-assets.githubusercontent.com/'))&&nativeRequests.some(item=>item.address.startsWith('release-assets.githubusercontent.com/')&&item.status===200);
  report.metadataNoStoreVerified=nativeRequests.length>0&&nativeRequests.every(item=>item.cache==='no-store');
  report.ok=report.results.some(item=>item.name==='workspace-native-transport'&&item.status==='available')&&report.nativeManifestRedirectVerified&&report.nativeRedirectRangeVerified&&report.metadataNoStoreVerified;
  await fs.writeFile(path.join(base,'result.json'),JSON.stringify(report,null,2));
 } catch(error) {report.ok=false;report.error=errorInfo(error);await fs.writeFile(path.join(base,'result.json'),JSON.stringify(report,null,2));}
 clearTimeout(timeout);app.exit(report.ok?0:1);
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const syntax = spawnSync(process.execPath, ['--check', bootstrap], { windowsHide: true, stdio: 'inherit' });
  if (syntax.status !== 0) throw new Error('The isolated network probe bootstrap has invalid syntax');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [base], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => {
      // Terminate only the process tree this probe spawned, never the user's app.
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
      reject(new Error('The isolated Electron network probe timed out'));
    }, 210000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
  });
  const result = JSON.parse(fs.readFileSync(path.join(base, 'result.json'), 'utf8'));
  fs.mkdirSync(path.join(root, '.recovery', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, '.recovery', 'reports', 'update-live-electron.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, reportDirectory: base }, null, 2));
  process.exitCode = result.ok && code === 0 ? 0 : 1;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
