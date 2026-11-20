'use strict';
// All fixtures, image API traffic and state are local and temporary. Actual credentials are never used.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');
const {start} = require('../server.cjs');
const {sanitizePage} = require('../backend/export.cjs');

test('static export copies only the intended markup',()=>{
  const clean=sanitizePage('<article class="folio-page" style="--fp-size: 32px; --fp-leading: 1.4; color: red"><a href="https://example.invalid/">A &amp; B</a></article>',new Set());
  assert.equal(clean,'<article class="folio-page" style="--fp-size:32px;--fp-leading:1.4"><a>A &amp; B</a></article>');
  assert.throws(()=>sanitizePage('<article class="folio-page"><img src="https://example.invalid/image.png"></article>',new Set()),/本地/);
});

test('project API, upload, loopback-only mock generation and real offline Chrome exports',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'folio-backend-test-'));
  assert.equal(path.dirname(dir),os.tmpdir().replace(/\/$/,''));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const pub=path.join(dir,'public'); await fs.mkdir(pub); await fs.writeFile(path.join(pub,'pages.css'),'.folio-page{box-sizing:border-box;width:1080px;height:1440px;background:#103050;color:white;}');
  const env={}; const server=await start({env,port:0,publicDir:pub,dataDir:path.join(dir,'data')});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=(endpoint, method='GET', body)=>fetch(base+'/api/'+endpoint,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  assert.equal(await (await api('project')).json(),null);
  assert.equal((await (await api('status')).json()).aiConfigured,false);
  assert.equal((await fetch(base+'/api/status',{headers:{Origin:'https://example.invalid'}})).status,403);
  assert.equal((await api('project','PUT',{title:'排版测试',markdown:'你好'})).status,200);
  assert.equal((await (await api('project')).json()).markdown,'你好');
  assert.equal((await api('generate','POST',{prompt:'绘制封面'})).status,503);
  const png=await sharp({create:{width:40,height:30,channels:3,background:'#ff9933'}}).png().toBuffer();
  const upload=await api('upload','POST',{dataUrl:'data:image/png;base64,'+png.toString('base64')}); assert.equal(upload.status,200);
  const {src}=await upload.json(); assert.match(src,/^\/media\/[a-f0-9]{64}\.webp$/);
  assert.equal((await fetch(base+src)).headers.get('content-type'),'image/webp');
  assert.equal((await api('upload','POST',{dataUrl:'data:image/jpeg;base64,'+png.toString('base64')})).status,415);
  let called=0;
  const upstream=http.createServer(async(req,res)=>{
    const buf=[];for await (const chunk of req) buf.push(chunk);
    const payload=JSON.parse(Buffer.concat(buf));
    assert.equal(req.url,'/v1/images/generations');assert.equal(req.headers.authorization,'Bearer test-placeholder');assert.equal(payload.model,'gpt-image-1');assert.equal(payload.size,'1536x1024');assert.equal(payload.background,'transparent');assert.equal(payload.output_format,'png');assert.match(payload.prompt,/纯测试/);called++;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  env.OPENAI_BASE_URL=`http://127.0.0.1:${upstream.address().port}/v1`;env.OPENAI_API_KEY='test-placeholder';
  const generated=await api('generate','POST',{prompt:'纯测试',style:'透明背景',layout:'inline'});assert.equal(generated.status,200);assert.equal((await generated.json()).src,src);assert.equal(called,1);
  const html=[`<article class="folio-page"><h1>你好，Folio。</h1><img src="${src}"></article>`, '<article class="folio-page"><p>第二页</p></article>'];
  const file=await api('export','POST',{title:'中文测试',html,index:0}); if(!file.ok) assert.fail(await file.text());
  const shot=Buffer.from(await file.arrayBuffer()); const meta=await sharp(shot).metadata();assert.deepEqual([meta.format,meta.width,meta.height],['png',1080,1440]);
  const raw=await sharp(shot).extract({left:1000,top:1300,width:1,height:1}).removeAlpha().raw().toBuffer(); assert.deepEqual([...raw],[16,48,80]);
  const archive=await api('export','POST',{title:'中文测试',html});if(!archive.ok) assert.fail(await archive.text());
  const zip=Buffer.from(await archive.arrayBuffer());assert.equal(zip.readUInt32LE(0),0x04034b50);assert.equal(zip.readUInt16LE(zip.length-12),2);assert.ok(zip.includes(Buffer.from('page-02.png')));assert.equal(called,1);
});
