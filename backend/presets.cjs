'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fail, safeRead, atomicWrite } = require('./common.cjs');
const LIMIT = 32 * 1024;
const STYLE_KEYS = ['column','headerRight','theme','bodyFont','titleFont','bodySize','lineHeight','imageStyle','cover','ending','endingVote'];
const DEFAULT_KEYS = ['question','coverImage','endingLabel','endingInvite','endingSign','endingActionNotes'];
const COVER_ASSET = /^\/assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:png|jpe?g|webp)$/i;
const COVER_MEDIA = /^\/media\/[a-f0-9]{64}\.webp$/;
const localCover = s=>s===''||COVER_ASSET.test(s)||COVER_MEDIA.test(s);
const EDITABLE_KEYS = new Set([...STYLE_KEYS,...DEFAULT_KEYS]);
// Accept legacy file keys so older CLI presets still load; subtitle/endQuote are no longer rendered.
const stringLimits = {column:40,headerRight:30,issue:20,title:55,subtitle:90,endQuote:100,question:100,coverImage:512,endingLabel:55,endingInvite:100,endingSign:55};
const choices = {theme:['clay','blue','sage'],bodyFont:['sans','serif'],titleFont:['sans','serif'],imageStyle:['ink','collage','photo','diagram']};
const builtinPromise = import('../public/presets.mjs');
const presetDirectory = (env=process.env) => path.resolve(env.FOLIO_PRESETS_DIR||path.join(__dirname,'../presets'));
const isPresetName = name => typeof name==='string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
function checkSettings(input,{web=false}={}) {
  if(!input || typeof input!=='object'||Array.isArray(input))fail(400,'预设设置必须是 JSON 对象。');
  const valid={};
  for(const [k,v] of Object.entries(input)){
    if(web&&!EDITABLE_KEYS.has(k))fail(400,`不能把本篇字段写进网页预设：${k}。`);
    if(web&&k==='coverImage'&&(typeof v!=='string'||!localCover(v)))fail(400,'预设封面需使用本地上传或内置图片。');
    if(Object.hasOwn(stringLimits,k)){
      const max=stringLimits[k];if(typeof v!=='string'||v.length>max)fail(400,`设置 ${k} 必须是最多 ${max} 字符的字符串。`);
    }else if(k==='endingActionNotes'){
      if(!Array.isArray(v)||v.length!==3||v.some(x=>typeof x!=='string'||x.length>40))fail(400,'endingActionNotes 需要三条不超过 40 字的提示，依次为收藏、点赞、关注。');
    }else if(k==='cover'||k==='ending'||k==='endingVote'){
      if(typeof v!=='boolean')fail(400,`设置 ${k} 必须为 true 或 false。`);
    }else if(Object.hasOwn(choices,k)){
      if(!choices[k].includes(v))fail(400,`设置 ${k} 可选：${choices[k].join('、')}。`);
    }else if(k==='bodySize'||k==='lineHeight'){
      const [min,max]=k==='bodySize'?[24,52]:[1.25,2];
      if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(400,`设置 ${k} 须在 ${min}–${max}。`);
    }else fail(400,`未知设置：${k}`);
    valid[k]=v;
  }
  if(!web&&!Object.hasOwn(valid,'headerRight')&&Object.hasOwn(valid,'issue')) valid.headerRight=valid.issue;
  return valid;
}
async function customNames(dir){
  const entries=await fs.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  return entries.filter(x=>x.isFile()&&x.name.endsWith('.json')&&isPresetName(x.name.slice(0,-5))).map(x=>x.name.slice(0,-5)).sort();
}
async function readCustom(dir,name){
  if(!isPresetName(name))fail(400,'预设名只可用小写字母、数字、连字符或下划线（最多 64 个字符）。');
  const filename=name+'.json',file=path.join(dir,filename);
  try{const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink())fail(404,'找不到可编辑的预设。');}
  catch(e){if(e.code==='ENOENT')fail(404,'找不到预设。');throw e;}
  const bytes=await safeRead(dir,filename,LIMIT);
  let data;try{data=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{fail(400,'预设文件不是有效的 JSON。');}
  return {settings:checkSettings(data), revision:createHash('sha256').update(bytes).digest('hex')};
}
function createStore(env,{publicDir,mediaDir}={}){
  const dir=presetDirectory(env);
  // Serialize all saves in this service so two open devices cannot both overwrite the same revision.
  let pending=Promise.resolve();
  function queue(fn){const job=pending.then(fn);pending=job.catch(()=>{});return job;}
  const onlyWebFields=s=>Object.fromEntries(Object.entries(s).filter(([k,v])=>EDITABLE_KEYS.has(k)&&(k!=='coverImage'||localCover(v))));
  const publicPreset=(name,s,editable,revision)=>({name,...(name==='text'?{label:'Text'}:{}),settings:onlyWebFields(s),editable,...(revision?{revision}:{})});
  async function list(){
    const {cliPresets,quickAiPm}=await builtinPromise;
    const results=Object.entries(cliPresets).map(([name,s])=>publicPreset(name,s,false));
    const warnings=[];
    for(const name of await customNames(dir)){
      if(Object.hasOwn(cliPresets,name))continue;
      try{const {settings,revision}=await readCustom(dir,name);results.push(publicPreset(name,{...quickAiPm,...settings},true,revision));}
      catch(e){if(!e.httpStatus)throw e;warnings.push(`${name} 未能加载：${e.message}`);}
    }
    return {presets:results,warnings};
  }
  async function save(name,input,revision,isNew){
    if(!isPresetName(name))fail(400,'预设名以小写字母或数字开头，只可用小写字母、数字、连字符或下划线（最多 64 个字符）。');
    const {cliPresets,quickAiPm}=await builtinPromise;
    if(Object.hasOwn(cliPresets,name))fail(409,'内置预设不可修改，请另存为新预设。');
    const patch=checkSettings(input,{web:true});
    if(!Object.keys(patch).length)fail(400,'没有要保存的预设设置。');
    if(patch.coverImage){
      const isMedia=COVER_MEDIA.test(patch.coverImage);
      try{await safeRead(isMedia?mediaDir:publicDir,patch.coverImage.slice(isMedia?7:1),16*1024*1024);}
      catch{fail(400,'预设封面图片不存在或无法读取，请重新上传。');}
    }
    return queue(async()=>{
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      const file=path.join(dir,name+'.json');
      let earlier={};
      if(!isNew){
        earlier=await readCustom(dir,name);
        if(typeof revision!=='string'||earlier.revision!==revision)fail(409,'预设已在别处修改。请重新载入预设后再更新。');
      }
      const next={...earlier.settings,...patch};
      const resolved={...quickAiPm,...next};
      if(resolved.ending&&!resolved.question.trim())fail(400,'启用尾页时，请填写预设自己的默认追问。');
      const bytes=Buffer.from(JSON.stringify(next,null,2)+'\n');
      if(isNew){
        // Linking is atomic and refuses to replace an existing file, directory or symlink.
        const tmp=path.join(dir,`.preset-${randomUUID()}.tmp`);
        try{await fs.writeFile(tmp,bytes,{flag:'wx',mode:0o600});await fs.link(tmp,file);}
        catch(e){if(e.code==='EEXIST')fail(409,'这个预设名已存在，请换一个名称或选择更新。');throw e;}
        finally{await fs.unlink(tmp).catch(()=>{});}
      }else await atomicWrite(file,bytes);
      return publicPreset(name,resolved,true,createHash('sha256').update(bytes).digest('hex'));
    });
  }
  async function remove(name,revision){
    if(!isPresetName(name))fail(400,'预设名无效。');
    const {cliPresets}=await builtinPromise;
    if(Object.hasOwn(cliPresets,name))fail(409,'内置预设不可删除。');
    return queue(async()=>{
      const current=await readCustom(dir,name);
      if(typeof revision!=='string'||current.revision!==revision)fail(409,'预设已在别处修改。请重新载入后再删除。');
      const root=await fs.realpath(dir);
      const file=path.join(root,name+'.json');
      const archive=path.join(root,'.deleted');
      await fs.mkdir(archive,{recursive:true,mode:0o700});
      if(await fs.realpath(file)!==file||await fs.realpath(archive)!==archive)fail(409,'预设路径或备份目录已改变，无法删除。');
      await fs.rename(file,path.join(archive,`${name}-${randomUUID()}.json`));
      return {name};
    });
  }
  return {list,save,remove};
}
module.exports={LIMIT,presetDirectory,isPresetName,checkSettings,customNames,readCustom,createStore};
