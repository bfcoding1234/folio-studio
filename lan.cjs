'use strict';
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isIPv4 } = require('node:net');
const { randomBytes, timingSafeEqual, createHash } = require('node:crypto');

function privateIPv4(ip) {
  if (!isIPv4(ip || '')) return false;
  const [a,b] = ip.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
function int(ip) { return ip.split('.').reduce((n,s)=>(n<<8)|Number(s),0); }
const digest = s => createHash('sha256').update(s).digest();
const hop = new Set(['connection','keep-alive','proxy-connection','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function forwarded(headers, extra = []) {
  const drop = new Set([...hop,...extra,...String(headers.connection || '').toLowerCase().split(',').map(x=>x.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key])=>!drop.has(key)&&!key.startsWith('x-forwarded-')&&key!=='forwarded'));
}
async function loadPassword(file) {
  const password = randomBytes(15).toString('base64url');
  await fs.mkdir(path.dirname(file), {recursive:true,mode:0o700});
  try { await fs.writeFile(file,password+'\n',{flag:'wx',mode:0o600}); }
  catch(e) { if (e.code!=='EEXIST') throw e; }
  const saved=(await fs.readFile(file,'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(saved)) throw new Error('局域网口令文件无效。');
  return saved;
}

async function startLan({host, port=5268, upstreamPort=5267, password, open=false}={}) {
  if (!privateIPv4(host)) throw new Error('请通过 FOLIO_LAN_HOST 指定这台 Mac 的 Wi‑Fi 私有 IPv4 地址。');
  const nic = Object.values(os.networkInterfaces()).flat().find(x=>x?.address===host && !x.internal && isIPv4(x.netmask));
  if (!nic) throw new Error('指定地址不在这台电脑的网络接口上。请核对 Wi‑Fi 地址。');
  if (![port,upstreamPort].every(x=>Number.isInteger(x)&&x>=1&&x<=65535)) throw new Error('端口无效。');
  if (!open && (typeof password!=='string'||password.length<20)) throw new Error('局域网口令未设置。');
  // Verify the existing app before accepting traffic. The upstream is always this computer.
  await new Promise((resolve,reject)=>{
    const rq=http.get({hostname:'127.0.0.1',port:upstreamPort,path:'/api/status',timeout:3000},res=>{
      res.resume(); res.statusCode===200 ? resolve() : reject(new Error('本机排版台未就绪。'));
    });
    rq.on('timeout',()=>rq.destroy(new Error('连接本机排版台超时。')));
    rq.on('error',()=>reject(new Error('本机排版台未启动，请先运行 npm start。')));
  });
  const expected = open ? null : digest('Basic '+Buffer.from(`folio:${password}`,'utf8').toString('base64'));
  const hostHeader=`${host}:${port}`, origin=`http://${hostHeader}`, upstream=`127.0.0.1:${upstreamPort}`;
  const subnet=int(host)&int(nic.netmask), mask=int(nic.netmask);
  const server=http.createServer({maxHeaderSize:16384,requestTimeout:42000,headersTimeout:15000},(req,res)=>{
    function respond(status, text, extra) {
      res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',...extra});
      res.end(text);
    }
    const peer=req.socket.remoteAddress;
    if (!isIPv4(peer||'')||(int(peer)&mask)!==subnet||req.headers.host!==hostHeader||
      (req.headers.origin!==undefined&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site') {
      return respond(403,'此入口只接受同一 Wi‑Fi 网段的直接访问。');
    }
    if (!['GET','HEAD','POST','PUT'].includes(req.method)||!req.url.startsWith('/')||req.url.startsWith('//')||/[\\\x00-\x1f]/.test(req.url)) return respond(400,'请求格式不受支持。');
    const auth=req.headers.authorization||'';
    if (expected && !timingSafeEqual(expected,digest(auth))) {
      return respond(401,'请用用户名 folio 和局域网口令登录。',{'WWW-Authenticate':'Basic realm="Folio Studio Wi-Fi", charset="UTF-8"'});
    }
    if (['POST','PUT'].includes(req.method)&&!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) return respond(415,'仅接受 JSON 数据。');
    const headers=forwarded(req.headers,['authorization','host','origin','cookie','expect']);
    headers.host=upstream;
    if (req.headers.origin) headers.origin=`http://${upstream}`;
    const request=http.request({host:'127.0.0.1',port:upstreamPort,path:req.url,method:req.method,headers},answer=>{
      const downstream=forwarded(answer.headers,['set-cookie','location']);
      downstream['cache-control']='private, no-store';
      res.writeHead(answer.statusCode || 502,downstream);
      answer.on('error',()=>res.destroy());
      answer.pipe(res);
    });
    request.setTimeout(240000,()=>request.destroy(new Error('upstream timeout')));
    request.on('error',()=>{if(res.headersSent)res.destroy();else if(!res.destroyed)respond(502,'Mac 上的排版台未响应。')});
    res.on('close',()=>{if(!res.writableFinished)request.destroy()});
    req.on('error',()=>request.destroy());
    req.pipe(request);
  });
  server.maxConnections=30;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve()})});
  return server;
}

if(require.main===module) (async()=>{
  const host=process.env.FOLIO_LAN_HOST;
  const port=Number(process.env.FOLIO_LAN_PORT || 5268);
  const upstreamPort=Number(process.env.FOLIO_UPSTREAM_PORT || 5267);
  const file=path.join(process.env.FOLIO_DATA_DIR||path.join(__dirname,'.folio-data'),'lan-password.txt');
  const open=process.env.FOLIO_LAN_OPEN==='1';
  const password=open ? undefined : await loadPassword(file);
  await startLan({host,port,upstreamPort,password,open});
  console.log(`纸间 Wi‑Fi 入口 → http://${host}:${port}/（${open?'同网段设备免登录':'用户名 folio；口令仅保存在本机数据目录'}）`);
})().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={startLan,loadPassword};
