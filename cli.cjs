#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { MiB, ASSET_PATH_RE: assetPattern, MEDIA_PATH_RE: mediaPattern, safeRead } = require('./backend/common.cjs');
const { uploadImage, MAX_IMAGE } = require('./backend/images.cjs');
const { MAX_PAGES, launchBrowser, renderExport } = require('./backend/export.cjs');
const { LIMIT, checkSettings, presetDirectory, customNames, isPresetName, readCustom } = require('./backend/presets.cjs');
const publicDir = path.join(__dirname,'public');
const origin = 'https://folio-cli.invalid';
const opts={out:{type:'string'},preset:{type:'string'},settings:{type:'string'},title:{type:'string'},issue:{type:'string'},'header-right':{type:'string'},vote:{type:'boolean'},'no-vote':{type:'boolean'},question:{type:'string'},'no-ending':{type:'boolean'},'body-size':{type:'string'},'no-cover':{type:'boolean'},current:{type:'boolean'},json:{type:'boolean'},help:{type:'boolean',short:'h'}};
const help=`纸间 CLI · 共用网页排版引擎

  folio render <article.md> [--preset NAME] [--out ./cards]
  folio export --current [--out ./cards]
  folio presets

  --preset NAME      text（仅正文）/ 自定义预设名或 JSON 路径（可用 folio presets 查看）
  --settings FILE    JSON 版式设置，覆盖预设或当前稿件的版式（不保存）
  --title TEXT       指定封面与页脚标题
  --body-size N      正文字号，24–52 px
  --header-right TEXT  右上页眉，默认留空（兼容旧参数 --issue）
  --question TEXT    覆盖本期追问并启用尾页
  --no-ending        不生成尾页
  --vote / --no-vote 在已开启的互动尾页显示或隐藏投票提示
  --no-cover         不生成封面
  --json             输出机器可读结果，含警告与成品路径

输出：每页 1080×1440 PNG、整篇 ZIP，不覆盖现有文件。
两个命令均不启动网页、不修改网页稿件、不生成 AI 图片。
`;
const contentTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
const imageType = s => contentTypes[path.extname(s).toLowerCase()];

async function readFile(file,max){
  const real=await fs.realpath(file); const stat=await fs.stat(real);
  if(!stat.isFile()||stat.size>max) throw new Error(`文件非普通文件或超过大小限制：${file}`);
  const bytes=await fs.readFile(real);
  if(bytes.length>max) throw new Error(`文件超过大小限制：${file}`);
  return bytes.toString('utf8').replace(/^\uFEFF/,'');
}
async function readObject(file,max){
  const data=JSON.parse(await readFile(file,max));
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error(`需要 JSON 对象：${file}`);
  return data;
}
async function importLocalImage(raw, articleDir, mediaDir) {
  let rel;try{rel=decodeURIComponent(raw).replace(/^\.\//,'');}catch{throw new Error(`图片路径编码无效：${raw}`);}
  const mime=imageType(rel);
  if(!mime||path.isAbsolute(rel)||/[\\:?#]/.test(rel)||rel.split('/').some(p=>!p||p.startsWith('.')))throw new Error(`仅允许稿件目录内的相对 PNG、JPEG 或 WebP 路径：${raw}`);
  let bytes;try{bytes=await safeRead(articleDir,rel,MAX_IMAGE);}catch(e){throw new Error(`无法读取稿件配图 ${raw}：${e.message}`);}
  return (await uploadImage({dataUrl:`data:${mime};base64,${bytes.toString('base64')}`},mediaDir)).src;
}
async function paginate(project,{articleDir,mediaDir,coverDir,sharedMediaDir,browser:sharedBrowser}){
  const ownsBrowser=!sharedBrowser;
  const browser=sharedBrowser||await launchBrowser(process.env);
  const watchdog=setTimeout(()=>{if(ownsBrowser)browser.close().catch(()=>{});},60000);watchdog.unref();
  let ctx;
  try{
    ctx=await browser.newContext({viewport:{width:1080,height:1440},serviceWorkers:'block'});
    const contentPolicy="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; object-src 'none'";
    const staticFiles=new Map();
    for(const [name,type] of [['pages.js','text/javascript'],['pages.css','text/css']])staticFiles.set('/'+name,{body:await safeRead(publicDir,name,MiB),contentType:type});
    await ctx.route('**/*',async route=>{
      const req=route.request(),u=new URL(req.url());
      if(u.origin!==origin||u.search||req.method()!=='GET')return route.abort();
      if(u.pathname==='/preview'&&req.resourceType()==='document')return route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'Content-Security-Policy':contentPolicy},body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body></body></html>'});
      if(staticFiles.has(u.pathname))return route.fulfill({status:200,...staticFiles.get(u.pathname)});
      if(req.resourceType()==='image'&&(assetPattern.test(u.pathname)||mediaPattern.test(u.pathname))){
        const isMedia=mediaPattern.test(u.pathname);
        try{const body=await safeRead(isMedia?mediaDir:publicDir,u.pathname.slice(isMedia?7:1),16*MiB);return route.fulfill({status:200,body,contentType:imageType(u.pathname)});}catch{return route.abort();}
      }
      return route.abort();
    });
    const page=await ctx.newPage();await page.goto(origin+'/preview',{timeout:10000});
    const warnings=[];const aliases=Object.create(null);
    if(articleDir){
      const info=await page.evaluate(async md=>(await import('/pages.js')).inspectMarkdown(md),project.md);
      project.settings.title ||= [...(info.title||project.fallbackTitle||'无题')].slice(0,55).join('');
      if(info.images.length>80)throw new Error('单篇稿件最多支持 80 张不同的图片。');
      for(const raw of info.images){
        if(assetPattern.test(raw))continue;
        if(/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(raw)){aliases[raw]=null;warnings.push(`未读取非稿件目录相对路径的配图：${raw}`);continue;}
        aliases[raw]=await importLocalImage(raw,articleDir,mediaDir);
      }
      const art=project.settings.coverImage;
      if(project.settings.cover&&art&&!assetPattern.test(art)){
        if(mediaPattern.test(art)){
          const name=art.slice(7);
          let bytes;try{bytes=await safeRead(sharedMediaDir,name,16*MiB);}catch{throw new Error('找不到预设封面图片。请核对 FOLIO_DATA_DIR 与网页是否一致，或在网页重新选择封面。');}
          // Copy only the selected preset cover into the isolated rendering store.
          await fs.writeFile(path.join(mediaDir,name),bytes,{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});
        }else project.settings.coverImage=await importLocalImage(art,coverDir||articleDir,mediaDir);
      }
    }
    const result=await page.evaluate(async ({project,aliases})=>{
      const {buildPages}=await import('/pages.js');
      const r=await buildPages(project,project.placements||{},{imageAliases:aliases});
      return {html:r.pages.map(p=>p.outerHTML),pageKinds:r.pages.map(p=>p.dataset.kind),title:r.title,warnings:r.warnings};
    },{project,aliases});
    return {...result,warnings:[...new Set([...warnings,...result.warnings])]};
  }finally{clearTimeout(watchdog);if(ctx)await ctx.close().catch(()=>{});if(ownsBrowser)await browser.close().catch(()=>{});}
}
async function main(args=process.argv.slice(2)){
  if(!args.length||['-h','--help','help'].includes(args[0])){console.log(help);return;}
  const [command,...rest]=args;
  const {values,positionals}=parseArgs({args:rest,options:opts,allowPositionals:true});
  if(values.help){console.log(help);return;}
  const {aiPmDefaults,cliPresets,quickAiPm}=await import('./public/presets.mjs');
  const presetDir=presetDirectory();
  if(command==='presets'){
    if(positionals.length||Object.keys(values).some(k=>k!=='json'))throw new Error('用法：folio presets [--json]');
    const extra=(await customNames(presetDir)).filter(x=>!Object.hasOwn(cliPresets,x));
    const list=[...Object.keys(cliPresets),...extra];
    console.log(values.json?JSON.stringify(list):list.map(x=>x==='text'?'text · 仅正文（内置）':x+' · 自定义').join('\n'));return;
  }
  if(!['render','export'].includes(command))throw new Error(`未知命令 ${command}。运行 folio --help 查看用法。`);
  if(command==='render'&&(positionals.length!==1||values.current))throw new Error('用法：folio render article.md --out ./cards');
  if(command==='export'&&(!values.current||positionals.length||values.preset))throw new Error('用法：folio export --current --out ./cards');
  let presetName=command==='export'?'current':(values.preset==='Text'?'text':values.preset)||'ai-pm';
  let preset=quickAiPm,presetFile;
  if(command==='render'){
    if(Object.hasOwn(cliPresets,presetName))preset=cliPresets[presetName];
    else{
      const explicit=presetName.toLowerCase().endsWith('.json');
      if(explicit)presetFile=path.resolve(presetName);
      else if(isPresetName(presetName))presetFile=path.join(presetDir,presetName+'.json');
      else throw new Error('预设须为：text、自定义名称或 JSON 路径。');
      try{const chosen=explicit?checkSettings(await readObject(presetFile,LIMIT)):(await readCustom(presetDir,presetName)).settings;preset={...preset,...chosen};}
      catch(e){if(e.code==='ENOENT'||e.httpStatus===404){if(!values.preset&&presetName==='ai-pm'){presetFile=undefined;presetName='text';preset=cliPresets.text;}else throw new Error(`找不到预设 ${presetName}。可运行 folio presets 查看预设。`);}else throw e;}
    }
  }
  const out=path.resolve(values.out||'./cards');
  const dataDir=path.resolve(process.env.FOLIO_DATA_DIR||path.join(__dirname,'.folio-data'));
  const settings=values.settings?checkSettings(await readObject(path.resolve(values.settings),32*1024)):{};
  if(values.title!==undefined)Object.assign(settings,checkSettings({title:values.title}));
  if(values['body-size']!==undefined)Object.assign(settings,checkSettings({bodySize:Number(values['body-size'])}));
  const headerRight=values['header-right']??values.issue;
  if(headerRight!==undefined)Object.assign(settings,checkSettings({headerRight}));
  if(values.vote&&values['no-vote'])throw new Error('--vote 和 --no-vote 不能同时使用。');
  if(values.vote||values['no-vote'])settings.endingVote=!!values.vote;
  if(values.question!==undefined){
    if(!values.question.trim())throw new Error('--question 不能为空。');
    Object.assign(settings,checkSettings({question:values.question,ending:true}));
  }
  if(values['no-cover'])settings.cover=false;
  if(values['no-ending'])settings.ending=false;
  let temp,project,articleDir,coverDir,mediaDir=path.join(dataDir,'media');
  try{
    if(command==='export'){
      let stored;try{stored=await readObject(path.join(dataDir,'project.json'),2*MiB);}catch(e){if(e.code==='ENOENT')throw new Error('网页里还没有保存的稿件。请先修改并保存，或用 folio render 直接排版。');throw e;}
      if(typeof stored.md!=='string')throw new Error('当前网页稿件没有合法的 Markdown 内容。');
      project={md:stored.md,settings:{...aiPmDefaults,...stored.settings,headerRight:stored.settings?.headerRight??stored.settings?.issue??'',...settings},placements:stored.placements||{}};
    }else{
      const file=path.resolve(positionals[0]);articleDir=path.dirname(file);
      const md=await readFile(file,220000);if(!md.trim())throw new Error('Markdown 文件没有正文。');
      project={md,fallbackTitle:path.parse(file).name,settings:{...preset,...settings},placements:{}};
      if(presetFile&&!Object.hasOwn(settings,'coverImage'))coverDir=path.dirname(presetFile);
      if(project.settings.ending&&!project.settings.question?.trim())throw new Error('启用结尾页时请使用 --question 或在预设中填写 question。');
      temp=await fs.mkdtemp(path.resolve(os.tmpdir(),'folio-cli-'));mediaDir=temp;
    }
    let html,pageKinds,title,warnings,result;
    const browser=await launchBrowser(process.env);
    const watchdog=setTimeout(()=>browser.close().catch(()=>{}),150000);watchdog.unref();
    try{
      ({html,pageKinds,title,warnings}=await paginate(project,{articleDir,mediaDir,coverDir,sharedMediaDir:path.join(dataDir,'media'),browser}));
      if(html.length>MAX_PAGES)throw new Error(`本稿有 ${html.length} 页，超过单次导出上限 ${MAX_PAGES} 页，请拆稿。`);
      result=await renderExport({html,title},{publicDir,mediaDir,env:process.env,browser});
    }finally{clearTimeout(watchdog);await browser.close().catch(()=>{});}
    const outputs=[...result.entries,[result.filename,result.bytes]];
    await fs.mkdir(out,{recursive:true});
    for(const [name] of outputs){try{await fs.lstat(path.join(out,name));throw new Error(`输出已存在：${path.join(out,name)}。请使用新的 --out 目录。`);}catch(e){if(e.code!=='ENOENT')throw e;}}
    for(const [name,bytes] of outputs)await fs.writeFile(path.join(out,name),bytes,{flag:'wx',mode:0o600});
    const report={title,preset:presetName,pageCount:html.length,pageKinds,pages:result.entries.map(([name])=>path.join(out,name)),zip:path.join(out,result.filename),warnings};
    if(values.json)console.log(JSON.stringify(report));else{console.log(`已导出 ${report.pageCount} 页：${out}\nZIP：${report.zip}`);for(const w of warnings)console.warn(`提示：${w}`);}
  }finally{
    // Only remove the exact private temp directory just created for this invocation.
    if(temp&&path.dirname(temp)===path.resolve(os.tmpdir())&&/^folio-cli-[A-Za-z0-9]+$/.test(path.basename(temp)))await fs.rm(temp,{recursive:true,force:true});
  }
}
if(require.main===module)main().catch(e=>{console.error(`纸间：${e.message}`);process.exitCode=1;});
