const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const sharp=require('sharp');
const exec=promisify(execFile);
const run=(args,env={},cwd)=>exec(process.execPath,[path.join(__dirname,'../cli.cjs'),...args],{env:{...process.env,...env},cwd,timeout:45000});

test('offline CLI renders relative images and saved projects without editing drafts', {timeout:60000}, async()=>{
 const fixture=await fs.mkdtemp(path.resolve(os.tmpdir(),'folio-cli-test-'));
 const markdown=path.join(fixture,'post.md'), data=path.join(fixture,'data');
 const once=path.join(fixture,'from-md'), current=path.join(fixture,'from-current');
 const source='# 新的面试题\n\n> 原稿正文：保留能改变答案的信息。\n\n![图例](./subject.png)\n\n```md\n![此处不是图片](./does-not-exist.png)\n```\n';
 try{
  await fs.mkdir(data);
  const projectFile=path.join(data,'project.json');
  const saved=JSON.stringify({md:'# 已保存\n\n网页稿件独立存在。',settings:{title:'当前稿件',theme:'blue',cover:true,coverImage:'/assets/context.png',ending:false}});
  await fs.writeFile(projectFile,saved);
  await fs.writeFile(markdown,source);
  await sharp({create:{width:120,height:80,channels:3,background:'#9a3725'}}).png().toFile(path.join(fixture,'subject.png'));
  const presetDir=path.join(fixture,'presets');await fs.mkdir(presetDir);
   await fs.writeFile(path.join(presetDir,'ai-pm.json'),'{}');
   await fs.writeFile(path.join(presetDir,'ai-pm-indigo.json'),'{"theme":"blue"}');
   const env={FOLIO_DATA_DIR:data,FOLIO_PRESETS_DIR:presetDir};
  const {stdout}=await run(['render',markdown,'--preset','ai-pm','--out',once,'--no-cover','--no-ending','--json'],env);
  const report=JSON.parse(stdout);assert.equal(report.title,'新的面试题');assert.deepEqual(report.warnings,[]);assert.equal(report.pageCount,1);
  const z=await fs.readFile(report.zip);assert.equal(z.readUInt32LE(0),0x04034b50);assert.ok(z.includes(Buffer.from('page-01.png')));
  const png=await fs.readFile(report.pages[0]);const {width,height}=await sharp(png).metadata();assert.deepEqual([width,height],[1080,1440]);
  const {data:rgb,info}=await sharp(png).resize(160).removeAlpha().raw().toBuffer({resolveWithObject:true});let redPixels=0;
  for(let i=0;i<rgb.length;i+=info.channels)if(rgb[i]>125&&rgb[i]<175&&rgb[i+1]<75&&rgb[i+2]<65)redPixels++;
  assert.ok(redPixels>200,'source picture must actually be rendered');
  await assert.rejects(run(['render',markdown,'--preset','ai-pm','--out',once,'--no-cover','--no-ending'],env),err=>err.stderr.includes('输出已存在'));
  assert.deepEqual(await fs.readFile(report.pages[0]),png);
  const base=JSON.parse((await run(['render',markdown,'--out',path.join(fixture,'quick'),'--json'],env)).stdout);
  assert.equal(base.preset,'ai-pm');assert.equal(base.title,'新的面试题');assert.deepEqual(base.pageKinds,['cover','body','ending']);
  const listed=JSON.parse((await run(['presets','--json'],env)).stdout);assert.ok(listed.includes('ai-pm-indigo'));
  const custom=JSON.parse((await run(['render',markdown,'--preset','ai-pm-indigo','--question','这一步需要什么证据？','--out',path.join(fixture,'indigo'),'--json'],env)).stdout);
  assert.equal(custom.preset,'ai-pm-indigo');assert.deepEqual(custom.pageKinds,['cover','body','ending']);
  const second=JSON.parse((await run(['export','--current','--out',current,'--json'],env)).stdout);
  assert.equal(second.title,'当前稿件');assert.equal(second.pageCount,2);
  assert.equal(await fs.readFile(projectFile,'utf8'),saved);assert.equal(await fs.readFile(markdown,'utf8'),source);
 }finally{if(path.dirname(fixture)===path.resolve(os.tmpdir())&&/^folio-cli-test-[A-Za-z0-9]+$/.test(path.basename(fixture)))await fs.rm(fixture,{recursive:true,force:true});}
});

test('render accepts an optional local cover image without changing drafts or presets', {timeout:60000}, async t=>{
 const fixture=await fs.mkdtemp(path.resolve(os.tmpdir(),'folio-cover-test-'));
 t.after(()=>fs.rm(fixture,{recursive:true,force:true}));
 const articleDir=path.join(fixture,'articles');
 const presetDir=path.join(fixture,'presets');
 const dataDir=path.join(fixture,'data');
 await Promise.all([articleDir,presetDir,dataDir].map(dir=>fs.mkdir(dir)));
 const markdown=path.join(articleDir,'post.md');
 const presetFile=path.join(presetDir,'layout.json');
 const draft=path.join(dataDir,'project.json');
 const source='# 原文标题\n\n保留正文。';
 const preset=JSON.stringify({cover:true,coverImage:'default.webp',ending:false});
 const saved=JSON.stringify({md:'不改动当前草稿'});
 const coverName='本篇 封面.png';
 await Promise.all([
  fs.writeFile(markdown,source),fs.writeFile(presetFile,preset),fs.writeFile(draft,saved),
  sharp({create:{width:300,height:200,channels:3,background:'#18d553'}}).png().toFile(path.join(fixture,coverName)),
  sharp({create:{width:300,height:200,channels:3,background:'#2355df'}}).webp().toFile(path.join(presetDir,'default.webp')),
  fs.writeFile(path.join(fixture,'broken.png'),'not a PNG')
 ]);
 const env={FOLIO_DATA_DIR:dataDir,FOLIO_PRESETS_DIR:presetDir};
 const invoke=args=>run(args,env,fixture);
 const render=async (out,args)=>JSON.parse((await invoke(['render','./articles/post.md','--out',out,'--json',...args])).stdout);
 const coverColors=async file=>{
  const {data,info}=await sharp(file).resize(100).removeAlpha().raw().toBuffer({resolveWithObject:true});
  let green=0,blue=0;
  for(let i=0;i<data.length;i+=info.channels){
   if(data[i]<70&&data[i+1]>180&&data[i+2]<120)green++;
   if(data[i]<70&&data[i+1]<120&&data[i+2]>180)blue++;
  }
  return {green,blue};
 };
 const override=await render('override',['--preset','layout','--cover-image',`./${coverName}`]);
 assert.deepEqual(override.pageKinds,['cover','body']);
 assert.equal(override.title,'原文标题');
 const explicitColors=await coverColors(override.pages[0]);
 assert.ok(explicitColors.green>1000 && explicitColors.blue===0,'explicit artwork replaced the preset cover');
 const fallback=await render('fallback',['--preset','layout']);
 assert.deepEqual(fallback.pageKinds,['cover','body']);
 const fallbackColors=await coverColors(fallback.pages[0]);
 assert.ok(fallbackColors.blue>1000 && fallbackColors.green===0,'omitting the flag keeps the preset artwork');
 const forced=await render('forced',['--preset','text','--title','指定标题','--cover-image',path.join(fixture,coverName)]);
 assert.deepEqual(forced.pageKinds,['cover','body']);
 assert.equal(forced.title,'指定标题');
 assert.ok((await coverColors(forced.pages[0])).green>1000);

 const invalid=args=>invoke(['render',markdown,'--preset','layout','--out','invalid',...args]);
 await assert.rejects(invalid(['--cover-image','missing.png']),/找不到文件/);
 await assert.rejects(invalid(['--cover-image','broken.png']),/图片内容不是声明的/);
 await assert.rejects(invalid(['--cover-image','image.svg']),/仅支持本地 PNG/);
 await assert.rejects(invalid(['--cover-image',coverName,'--no-cover']),/不能同时使用/);
 await assert.rejects(invoke(['export','--current','--cover-image',coverName]),/仅适用于 folio render/);
 await assert.rejects(fs.stat(path.join(fixture,'invalid')),{code:'ENOENT'});
 assert.equal(await fs.readFile(markdown,'utf8'),source);
 assert.equal(await fs.readFile(presetFile,'utf8'),preset);
 assert.equal(await fs.readFile(draft,'utf8'),saved);
});
