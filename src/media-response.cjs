const fs = require('node:fs');
const { stat } = require('node:fs/promises');
const { Readable } = require('node:stream');
const path = require('node:path');
const { MIME } = require('./media-formats.cjs');
async function mediaResponse(filename,request) {
  const {size}=await stat(filename);
  const headers={'Content-Type':MIME[path.extname(filename).slice(1).toLowerCase()]||'application/octet-stream','Cache-Control':'private, max-age=3600','Content-Security-Policy':"default-src 'none'; sandbox",'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
  let start=0,end=size-1,status=200;
  const range=request.headers.get('range');
  if(range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match || (!match[1]&&!match[2]))return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${size}`}});
    if(!match[1])start=Math.max(0,size-Number(match[2]));
    else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    if(start>end||start>=size)return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${size}`}});
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length']=String(Math.max(0,end-start+1));
  return new Response(size ? Readable.toWeb(fs.createReadStream(filename,{start,end})) : null,{status,headers});
}
module.exports={mediaResponse};
