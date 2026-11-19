'use strict';
// Boot the actual desktop entry point in an isolated, hidden profile. This
// checks the production collector adapter, not a separately assembled fixture.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { root, electronPath } = require('./runtime.cjs');

(async () => {
  const testsRoot = path.join(root, '.recovery', 'tests');
  await fs.mkdir(testsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testsRoot, 'sketchfab-startup-'));
  const profile = path.join(directory, 'profile'), library = path.join(directory, 'library');
  await fs.mkdir(profile); await fs.mkdir(library);
  const version = require('../package.json').version;
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'mosaic-sketchfab-startup', version, main: 'main.cjs' }));
  await fs.writeFile(path.join(directory, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const profile = ${JSON.stringify(profile)};
app.setPath('userData', profile); app.setPath('sessionData', profile);
process.env.SHITU_LIBRARY = ${JSON.stringify(library)};
require(${JSON.stringify(path.join(root, 'src', 'main.cjs'))});
(async () => {
  let result;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const { token } = JSON.parse(await fs.readFile(path.join(profile, 'collector.json'), 'utf8'));
      for (let port = 38475; port <= 38484; port++) {
        try {
          const request = (route, body) => fetch('http://127.0.0.1:' + port + route, { method:'POST',
            headers:{'Content-Type':'application/json','X-Shitu-Token':token}, body:JSON.stringify(body), signal:AbortSignal.timeout(1000) });
          const response = await request('/v1/ping', {}), status = await response.json();
          if (!response.ok || status.version !== ${JSON.stringify(version)}) continue;
          if (status.sketchfabDownload !== true || status.sketchfabBrowserDownload !== true) throw new Error('Actual desktop entry point did not wire model imports into the collector.');
          const id = '0123456789abcdef0123456789abcdef', page = 'https://sketchfab.com/3d-models/' + id;
          const capture = await (await request('/v1/capture', {kind:'model',sourceType:'sketchfab',modelId:id,url:page,pageUrl:page})).json();
          if (capture.ok || capture.code !== 'SKETCHFAB_BROWSER_DOWNLOAD_REQUIRED') throw new Error('Unconnected model capture did not reach the real Sketchfab browser-download service.');
          result = {ok:true, version:status.version, ready:status.ready, sketchfabDownload:status.sketchfabDownload, sketchfabBrowserDownload:status.sketchfabBrowserDownload, unconnectedCode:capture.code};
          break;
        } catch (error) { if (/wire model|account service|browser-download service/.test(error.message)) throw error; }
      }
      if (result) break;
    } catch (error) { if (/wire model|account service|browser-download service/.test(error.message)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!result) throw new Error('Isolated desktop collector did not become available.');
  await fs.writeFile(${JSON.stringify(path.join(directory, 'result.json'))}, JSON.stringify(result, null, 2));
  // The collector is ready before the asynchronously created main window.
  // This isolated startup test has no import or pending save to flush.
  app.exit(0);
})().catch(async error => {
  await fs.writeFile(${JSON.stringify(path.join(directory, 'result.json'))}, JSON.stringify({ok:false,error:error.message})); app.exit(1);
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let completedReport;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath(), [directory, '--background'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    // app.exit can race asynchronous window creation in this bootstrap. Once
    // the live collector has written its result, only this isolated child is
    // stopped; this test does not assert the application shutdown lifecycle.
    const reportPoll = setInterval(async () => {
      try {
        const value = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
        if (typeof value.ok !== 'boolean' || completedReport) return;
        completedReport = value; clearInterval(reportPoll); child.kill();
      } catch {}
    }, 100);
    const timeout = setTimeout(() => { clearInterval(reportPoll); child.kill(); reject(new Error('Isolated Sketchfab desktop startup timed out.')); }, 45000);
    child.once('error', error => { clearInterval(reportPoll); clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearInterval(reportPoll); clearTimeout(timeout); resolve(completedReport ? completedReport.ok ? 0 : 1 : code); });
  });
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  console.log(JSON.stringify({ ...result, reportDirectory: directory }));
  if (exitCode !== 0 || !result.ok) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
