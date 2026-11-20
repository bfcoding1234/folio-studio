#!/usr/bin/env node
'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { MiB, fail, readJSON, atomicWrite, safeRead } = require('./backend/common.cjs');
const { uploadImage, generateImage, MAX_IMAGE } = require('./backend/images.cjs');
const { renderExport, MAX_PAGES } = require('./backend/export.cjs');
const { createStore } = require('./backend/presets.cjs');
const TYPES = {
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8'
};
const publicDirDefault=path.join(__dirname,'public');
function sendJSON(res,status,value) {
  const bytes=Buffer.from(JSON.stringify(value));
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store'});
  res.end(bytes);
}
async function start({env=process.env, port=Number(env.PORT ?? 5267), publicDir=publicDirDefault, dataDir=path.resolve(env.FOLIO_DATA_DIR || path.join(__dirname,'.folio-data'))}={}) {
  if (!Number.isInteger(port) || port<0 || port>65535) throw new Error('PORT 必须是 0–65535 之间的整数。');
  const mediaDir=path.join(dataDir,'media'), projectFile=path.join(dataDir,'project.json');
  await fs.mkdir(mediaDir,{recursive:true,mode:0o700});
  const busy={generate:0,upload:0,export:0};
  const presets=createStore(env,{publicDir,mediaDir});
  const server=http.createServer({maxHeaderSize:16384,requestTimeout:40000,headersTimeout:15000},async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    try {
      const p=server.address().port;
      const hosts=[`127.0.0.1:${p}`,`localhost:${p}`]; if(p===80) hosts.push('127.0.0.1','localhost');
      const host=req.headers.host?.toLowerCase();
      if (!hosts.includes(host) || (req.headers.origin !== undefined && req.headers.origin !== 'http://'+host)) fail(403,'仅接受本机同源请求。');
      if (req.url[0]!=='/' || req.url.startsWith('//') || /[\\\x00-\x1f]/.test(req.url)) fail(400,'无效的请求路径。');
      let pathname; try { pathname=decodeURIComponent(req.url.split('?')[0]); } catch {fail(400,'无效的路径编码。');}
      if (pathname.startsWith('/api/')) {
        if (req.headers['sec-fetch-site']==='cross-site') fail(403,'仅接受本机同源 API 请求。');
        if (pathname==='/api/status' && req.method==='GET') return sendJSON(res,200,{aiConfigured:Boolean(env.OPENAI_API_KEY?.trim()),maxExportPages:MAX_PAGES,maxUploadMiB:MAX_IMAGE/MiB});
        if (pathname==='/api/presets' && req.method==='GET') return sendJSON(res,200,await presets.list());
        if (pathname==='/api/presets' && req.method==='POST') {
          const {name,settings}=await readJSON(req,32*1024);
          return sendJSON(res,201,{preset:await presets.save(name,settings,undefined,true)});
        }
        const presetDelete=/^\/api\/presets\/([^/]+)\/delete$/.exec(pathname);
        if (presetDelete && req.method==='POST') {
          const {revision}=await readJSON(req,32*1024);
          return sendJSON(res,200,{removed:await presets.remove(presetDelete[1],revision)});
        }
        const presetPath=/^\/api\/presets\/([^/]+)$/.exec(pathname);
        if (presetPath && req.method==='PUT') {
          const {settings,revision}=await readJSON(req,32*1024);
          return sendJSON(res,200,{preset:await presets.save(presetPath[1],settings,revision,false)});
        }
        if (pathname==='/api/project' && req.method==='GET') {
          let bytes;
          try {bytes=await fs.readFile(projectFile);} catch(e) { if(e.code==='ENOENT') return sendJSON(res,200,null);throw e; }
          // Validate persisted JSON; propagate corruption as an error, not an empty project.
          return sendJSON(res,200,JSON.parse(bytes));
        }
        if (pathname==='/api/project' && req.method==='PUT') {
          const json=await readJSON(req,2*MiB); await atomicWrite(projectFile,JSON.stringify(json)); return sendJSON(res,200,{ok:true});
        }
        const kind=pathname.slice(5);
        if (req.method==='POST' && Object.hasOwn(busy,kind)) {
          if (busy[kind] >= (kind==='upload'?2:1)) fail(429, '已有同类任务处理中，请稍后再试。');
          busy[kind]++;
          try {
            const body=await readJSON(req,(kind==='upload'?14:kind==='generate'?0.125:4)*MiB);
            if(kind==='upload') return sendJSON(res,200,await uploadImage(body,mediaDir));
            if(kind==='generate') return sendJSON(res,200,await generateImage(body,mediaDir,env));
            const {bytes,type,filename,ext}=await renderExport(body,{env,publicDir,mediaDir});
            res.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="folio.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`});
            return res.end(bytes);
          } finally {busy[kind]--;}
        }
        fail(404,'接口或方法不存在。');
      }
      if (!['GET','HEAD'].includes(req.method)) fail(405,'不支持此请求方法。');
      const media=pathname.startsWith('/media/');
      const rel=media?pathname.slice(7):pathname==='/'?'index.html':pathname.slice(1);
      const type=TYPES[path.extname(rel).toLowerCase()];
      if (!type || (media&&!/^[a-f0-9]{64}\.webp$/.test(rel))) fail(404,'资源不存在。');
      const bytes=await safeRead(media?mediaDir:publicDir,rel,24*MiB);
      const headers={'Content-Type':type,'Content-Length':bytes.length,'Cache-Control':media?'private, max-age=31536000, immutable':'no-cache'};
      if (type.startsWith('text/html')) headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
      res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:bytes);
    } catch (e) {
      if(res.destroyed||res.writableEnded) return;
      const status=Number.isInteger(e.httpStatus)?e.httpStatus:500;
      if (status===500) console.error('Folio: local request failed:',e.code || e.name || 'Error'); // no submitted text, keys or remote response bodies
      sendJSON(res,status,{error:status===500?'本地服务处理失败，请检查数据目录或浏览器环境。':e.message});
    }
  });
  try {
    await new Promise((resolve,reject)=>{const error=e=>reject(e);server.once('error',error);server.listen(port,'127.0.0.1',()=>{server.off('error',error);resolve();});});
  } catch (e) {if(e.code==='EADDRINUSE') throw new Error(`端口 ${port} 已占用。请设置 PORT 后重试。`);throw e;}
  return server;
}
if(require.main===module) start().then(server=>console.log(`Folio Studio → http://127.0.0.1:${server.address().port}`)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={start};
