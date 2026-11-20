const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const sharp=require('sharp');
const exec=promisify(execFile);
const run=(args,env={})=>exec(process.execPath,[path.join(__dirname,'../cli.cjs'),...args],{env:{...process.env,...env},timeout:45000});

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
