const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { createWriteStream, createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const DEFAULT_ORIGIN = 'chrome-extension://mdleapcbplpefdgchdklofdnpjgokdhh';
function publicAddress(address) {
  if (net.isIPv4(address)) {
    const [a,b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
  }
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) return publicAddress(value.slice(7));
  return net.isIPv6(address) && /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:');
}
function webUrl(value, label = '地址') {
  if (typeof value !== 'string' || value.length > 8192) throw new Error(`${label}无效`);
  let url; try { url = new URL(value); } catch { throw new Error(`${label}无效`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label}只支持 HTTP 或 HTTPS`);
  return url;
}
function identify(buffer) {
  if (buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { ext:'png',kind:'image' };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { ext:'jpg',kind:'image' };
  if (/^GIF8[79]a/.test(buffer.subarray(0,6).toString())) return { ext:'gif',kind:'image' };
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') return { ext:'webp',kind:'image' };
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'AVI ') return { ext:'avi',kind:'video' };
  if (buffer.subarray(0,2).toString() === 'BM') return { ext:'bmp',kind:'image' };
  if (buffer.subarray(0,4).equals(Buffer.from([73,73,42,0])) || buffer.subarray(0,4).equals(Buffer.from([77,77,0,42]))) return { ext:'tiff',kind:'image' };
  if (buffer.subarray(4,8).toString() === 'ftyp') {
    const brands = buffer.subarray(8,80).toString();
    if (/avif|avis/.test(brands)) return {ext:'avif',kind:'image'};
    return {ext:brands.startsWith('qt  ') ? 'mov' : 'mp4',kind:'video'};
  }
  if (buffer.length >= 12 && ['moov', 'mdat', 'wide', 'free'].includes(buffer.subarray(4,8).toString())) return {ext:'mov',kind:'video'};
  if (buffer.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return {ext:buffer.includes(Buffer.from('matroska'))?'mkv':'webm',kind:'video'};
  if (buffer.subarray(0,4).toString() === 'OggS') return {ext:'ogv',kind:'video'};
  if (buffer.subarray(0,3).toString() === 'FLV') return {ext:'flv',kind:'video'};
  if (buffer.subarray(0,4).equals(Buffer.from([0,0,1,186])) || buffer.subarray(0,4).equals(Buffer.from([0,0,1,179]))) return {ext:'mpg',kind:'video'};
  if (buffer.length > 376 && buffer[0] === 0x47 && buffer[188] === 0x47 && buffer[376] === 0x47) return {ext:'ts',kind:'video'};
  if (buffer.subarray(0,16).equals(Buffer.from('3026b2758e66cf11a6d900aa0062ce6c','hex'))) return {ext:'asf',kind:'video'};
  if (buffer.subarray(0,4).equals(Buffer.from([6,14,43,52]))) return {ext:'mxf',kind:'video'};
  const text = buffer.toString('utf8').replace(/^\uFEFF/,'').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text)) return {ext:'svg',kind:'image'};
  return null;
}
async function readJSON(request, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('请求太大，图片数据上限为 20 MB'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('采集请求格式无效'); }
}

function createCollector({ library, configPath, onImported = () => {}, isReady=()=>true, allowedOrigin = DEFAULT_ORIGIN, port = 38475, allowPrivate = false, maxDownloadBytes = 512 * 1024 * 1024, timeout = 90000 } = {}) {
  let server, token, listeningPort, active = 0, disabledError;
  const sockets = new Set();
  async function download(url, destination, pageUrl, signal, redirects = 0) {
    if (redirects > 5) throw new Error('下载重定向次数过多');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname) ? [{address:hostname,family:net.isIP(hostname)}] : await dns.lookup(hostname, {all:true});
    if (!addresses.length || (!allowPrivate && addresses.some(a => !publicAddress(a.address)))) throw new Error('不支持从本机或内网地址采集');
    const address = addresses[0];
    const response = await new Promise((resolve,reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        signal,
        lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null,address.address,address.family),
        headers: { 'User-Agent': 'Mozilla/5.0 ShituCollector/0.4', 'Accept': 'image/*,video/*;q=0.9,*/*;q=0.5', ...(pageUrl ? {Referer:pageUrl} : {}) }
      }, resolve);
      request.on('error',reject);
    });
    if ([301,302,303,307,308].includes(response.statusCode)) {
      response.resume();
      if (!response.headers.location) throw new Error('下载重定向地址缺失');
      return download(webUrl(new URL(response.headers.location,url).href), destination, pageUrl, signal, redirects+1);
    }
    if (response.statusCode !== 200) { response.resume(); throw new Error(`网站返回 HTTP ${response.statusCode}，可能需要登录或不允许直接下载`); }
    const type = String(response.headers['content-type'] || '');
    if (/mpegurl|dash\+xml|text\/html/i.test(type)) { response.resume(); throw new Error('该地址是网页或分段视频流，无法直接保存为视频文件'); }
    if (Number(response.headers['content-length']) > maxDownloadBytes) { response.destroy(); throw new Error('素材超过 512 MB 下载上限'); }
    let bytes = 0;
    const limiter = new Transform({ transform(chunk,_encoding,callback) { bytes += chunk.length; callback(bytes > maxDownloadBytes ? new Error('素材超过 512 MB 下载上限') : null, chunk); } });
    await pipeline(response, limiter, createWriteStream(destination, {flags:'wx'}), {signal});
  }
  async function capture(body) {
    if (!body || !['image','video'].includes(body.kind)) throw new Error('只支持图片和视频素材');
    const source = body.dataBase64 ? null : webUrl(body.url, '素材地址');
    const pageUrl = body.pageUrl ? webUrl(body.pageUrl,'来源页面').href : undefined;
    if (source && /\.(m3u8|mpd)(?:$|[?#])/i.test(source.href)) throw new Error('暂不支持直播、分段流或受保护视频，请使用可直接下载的视频文件');
    if (body.dataBase64 && (typeof body.dataBase64 !== 'string' || body.dataBase64.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64))) throw new Error('临时素材数据无效或超过 20 MB');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'shitu-capture-'));
    const original = path.join(temporary,'download');
    try {
      if (body.dataBase64) {
        const data = Buffer.from(body.dataBase64,'base64');
        if (data.length > 20*1024*1024) throw new Error('临时素材超过 20 MB');
        await fs.writeFile(original,data,{flag:'wx'});
      } else await download(source,original,pageUrl,AbortSignal.timeout(timeout));
      const handle = await fs.open(original,'r');
      const head = Buffer.alloc(4096); let bytesRead;
      try { ({bytesRead} = await handle.read(head,0,4096,0)); } finally { await handle.close(); }
      const format = identify(head.subarray(0,bytesRead));
      if (!format || format.kind !== body.kind) throw new Error('下载结果不是支持的图片或视频文件；网站可能返回了登录页面或分段流');
      let name = typeof body.name === 'string' ? body.name : '';
      if (!name && source) { try { name = decodeURIComponent(path.posix.basename(source.pathname)); } catch {} }
      if (!name) name = typeof body.title === 'string' ? body.title : '网页素材';
      name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/\.[a-z0-9]{2,5}$/i,'').trim().slice(0,200) || '网页素材';
      const typed = path.join(temporary,`media.${format.ext}`);
      await fs.rename(original,typed);
      const report = await library.importPaths([typed], { metadata:{name,...(source ? {sourceUrl:source.href} : {}),...(pageUrl ? {pageUrl} : {})} });
      if (report.errors.length) throw new Error(report.errors[0].message);
      await onImported(report);
      return {ok:true,imported:report.imported,duplicates:report.duplicates,assetIds:report.assetIds};
    } finally { await fs.rm(temporary,{recursive:true,force:true}); }
  }
  async function handler(request,response) {
    const origin = request.headers.origin;
    const cors = origin === allowedOrigin ? {'Access-Control-Allow-Origin':allowedOrigin,'Vary':'Origin'} : {};
    const json = (status,body) => { response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...cors}); response.end(JSON.stringify(body)); };
    if (request.headers.host !== `127.0.0.1:${listeningPort}` || (origin && origin !== allowedOrigin)) return json(403,{ok:false,error:'不允许的请求来源'});
    if (request.method === 'OPTIONS') {
      response.writeHead(204,{...cors,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Shitu-Token, X-Shitu-Extension','Access-Control-Max-Age':'600'}); return response.end();
    }
    // The browser supplies Origin; ordinary pages cannot forge an extension
    // origin or send our custom header with no-cors. Requests with no Origin
    // are accepted only with the exact extension id (some Chrome worker builds
    // omit Origin on host-permitted requests). This is a loopback-only API.
    if(request.method==='POST' && request.url==='/v1/connect') {
      if(request.headers['x-shitu-extension']!==allowedOrigin.replace('chrome-extension://','')) return json(403,{ok:false,error:'不是受支持的拾图采集扩展'});
      if(!String(request.headers['content-type']).startsWith('application/json')) return json(415,{ok:false,error:'只支持 JSON 请求'});
      try {
        await readJSON(request,4096);
        return json(200,{ok:true,app:'拾图',version:'0.10.7',ready:Boolean(isReady()),connection:{port:listeningPort,token}});
      } catch(error) {return json(400,{ok:false,error:error.message});}
    }
    const supplied = request.headers['x-shitu-token'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) return json(401,{ok:false,error:'连接已失效，采集助手需要自动重新连接'});
    if (request.method !== 'POST' || !['/v1/ping','/v1/capture'].includes(request.url)) return json(404,{ok:false,error:'接口不存在'});
    if (!String(request.headers['content-type']).startsWith('application/json')) return json(415,{ok:false,error:'只支持 JSON 请求'});
    try {
      const body = await readJSON(request,28*1024*1024+32768);
      if (request.url === '/v1/ping') return json(200,{ok:true,app:'拾图',version:'0.10.7',ready:Boolean(isReady())});
      if(!isReady())return json(409,{ok:false,error:'请先在拾图中选择素材库位置，或等待切换完成'});
      if (active >= 3) return json(429,{ok:false,error:'当前有多个素材正在采集，请稍候再试'});
      active++;
      response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...cors}); response.write('\n');
      const heartbeat = setInterval(()=>{if (!response.destroyed) response.write(' ');},10000); heartbeat.unref();
      try { const result = await capture(body); if (!response.destroyed) response.end(JSON.stringify(result)); }
      catch(error) { if (!response.destroyed) response.end(JSON.stringify({ok:false,error:error.message})); }
      finally { clearInterval(heartbeat); active--; }
    } catch(error) { if (!response.headersSent) json(400,{ok:false,error:error.message}); }
  }
  return {
    async start() {
      await fs.mkdir(path.dirname(configPath),{recursive:true});
      try { token = JSON.parse(await fs.readFile(configPath,'utf8')).token; } catch(error) { if (error.code !== 'ENOENT') throw error; }
      if (!/^[a-f0-9]{64}$/.test(token || '')) { token = crypto.randomBytes(32).toString('hex'); await fs.writeFile(configPath,JSON.stringify({token}),{mode:0o600}); }
      for (let attempt=0;attempt<(port===0 ? 1 : 10);attempt++) {
        server=http.createServer(handler); server.requestTimeout=100000; server.headersTimeout=10000;
        server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
        try { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port ? port+attempt : 0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});}); listeningPort=server.address().port; disabledError=null; return this.info(); }
        catch(error) { if (error.code !== 'EADDRINUSE') throw error; disabledError='浏览器采集端口被占用，请关闭其他拾图实例后重试'; }
      }
      throw new Error(disabledError);
    },
    info() { return {enabled:Boolean(listeningPort),baseUrl:listeningPort?`http://127.0.0.1:${listeningPort}`:null,code:listeningPort?`SHITU1.${listeningPort}.${token}`:null,error:disabledError}; },
    activeCount: () => active,
    async close() { for(const socket of sockets)socket.destroy();if(server?.listening)await new Promise(resolve=>server.close(resolve));listeningPort=null; }
  };
}
module.exports={createCollector,identify,publicAddress,webUrl};
