const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {start}=require('../server.cjs');
const {chromium}=require('playwright');
const projectRoot=path.resolve(__dirname,'..');
async function isolated(fn){
  const fixture=await fs.mkdtemp(path.resolve(os.tmpdir(),'folio-preset-test-'));
  const dir=path.join(fixture,'presets'), dataDir=path.join(fixture,'data');
  const env={FOLIO_PRESETS_DIR:dir,FOLIO_DATA_DIR:dataDir}, server=await start({port:0,dataDir,env});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=(url,method='GET',body)=>fetch(base+'/api/'+url,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try{await fn({api,base,dir,env,fixture});}
  finally{await new Promise(r=>server.close(r));if(path.dirname(fixture)===path.resolve(os.tmpdir())&&/^folio-preset-test-[A-Za-z0-9]+$/.test(path.basename(fixture)))await fs.rm(fixture,{recursive:true,force:true});}
}
const cli=(args,env)=>execFileSync(process.execPath,[path.join(projectRoot,'cli.cjs'),...args],{env:{...process.env,...env},encoding:'utf8',timeout:25000});

test('preset API writes the CLI store, validates input and rejects stale changes',async()=>isolated(async({api,dir,env})=>{
  const initial=await (await api('presets')).json();
  assert.deepEqual(initial.presets.map(p=>[p.name,p.editable]),[['text',false]]);
  let res=await api('presets','POST',{name:'review-style',settings:{theme:'blue',bodySize:36,question:'预设问题？'}});
  assert.equal(res.status,201);const original=(await res.json()).preset;assert.equal(original.settings.theme,'blue');assert.equal(original.editable,true);
  assert.ok(JSON.parse(cli(['presets','--json'],env)).includes('review-style'));
  res=await api('presets','POST',{name:'review-style',settings:{theme:'sage'}});assert.equal(res.status,409);
  res=await api('presets','POST',{name:'text',settings:{theme:'sage'}});assert.equal(res.status,409);
  res=await api('presets','POST',{name:'invalid',settings:{title:'本篇标题'}});assert.equal(res.status,400);
  res=await api('presets','POST',{name:'../outside',settings:{theme:'sage'}});assert.equal(res.status,400);
  const file=path.join(dir,'review-style.json');const manuallyEdited={theme:'sage',bodySize:36,question:'预设问题？',coverImage:'/assets/context.png'};await fs.writeFile(file,JSON.stringify(manuallyEdited));
  assert.equal((await api('presets/review-style','PUT',{settings:{bodySize:34},revision:original.revision})).status,409);
  const refreshed=(await (await api('presets')).json()).presets.find(p=>p.name==='review-style');assert.notEqual(refreshed.revision,original.revision);assert.equal(refreshed.settings.coverImage,manuallyEdited.coverImage);
  res=await api('presets/review-style','PUT',{settings:{bodySize:34},revision:refreshed.revision});assert.equal(res.status,200);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{...manuallyEdited,bodySize:34});
  const version=(await res.json()).preset.revision;
  assert.equal((await api('presets/text/delete','POST',{revision:version})).status,409);
  assert.equal((await api('presets/review-style/delete','POST',{revision:original.revision})).status,409);
  assert.equal((await api('presets/review-style/delete','POST',{revision:version})).status,200);
  assert.ok(!(JSON.parse(cli(['presets','--json'],env))).includes('review-style'));
  const [archived]=await fs.readdir(path.join(dir,'.deleted'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'.deleted',archived),'utf8')),{...manuallyEdited,bodySize:34});
}));
test('web saves and applies a named preset without overwriting article fields', {timeout:45000}, async()=>isolated(async({base,api,env,fixture})=>{
  const md='# 文章标题\n\n这段正文不会被预设替换。';
  const original={title:'当篇标题',subtitle:'当篇副标题',issue:'第 07 题',question:'当篇追问？',endQuote:'当篇的场景',coverImage:'/assets/context.png'};
  await api('project','PUT',{md,settings:original,placements:{},library:[]});
  const b=await chromium.launch({executablePath:process.env.FOLIO_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try{
    const p=await b.newPage({viewport:{width:1350,height:950}});
    const $=s=>p.locator(s);await p.goto(base);await p.waitForSelector('#stage .folio-page[data-kind=body]');
    await p.waitForFunction(()=>Array.from(document.querySelector('#preset-select').options).some(x=>x.value==='text'));
    assert.equal(await $('#settings-fields').evaluate(el=>!!el.closest('.editor')&&!el.closest('dialog')),true);
    assert.equal(await $('#article-extras').getAttribute('open'),null);
    assert.equal(await $('#article-overrides').getAttribute('open'),null);
    assert.equal(await $('#headerRight').inputValue(),original.issue);
    assert.equal(await $('#headerRight').isHidden(),true);
    await $('#open-settings').click();
    await $('#preset-new').click();await $('#preset-edit-theme').selectOption('blue');await $('#preset-edit-bodySize').fill('38');await $('#preset-edit-headerRight').fill('栏目精选');
    await $('#preset-name').fill('web-blue');await $('#preset-edit-question').fill('独立排版的默认问题？');
    await $('#preset-cover-file').setInputFiles(path.join(projectRoot,'public/assets/shoes.png'));
    await p.waitForFunction(()=>!document.querySelector('#preset-cover-clear').disabled);
    await $('#preset-create').click();await p.waitForFunction(()=>Array.from(document.querySelector('#preset-select').options).some(x=>x.value==='web-blue'));
    await $('#settings-close').click();
    assert.ok(JSON.parse(cli(['presets','--json'],env)).includes('web-blue'));
    const presets=await (await api('presets')).json();const created=presets.presets.find(x=>x.name==='web-blue');
    assert.equal(created.settings.bodySize,38);assert.equal(created.settings.headerRight,'栏目精选');assert.equal(created.settings.question,'独立排版的默认问题？');assert.equal(created.settings.title,undefined);assert.match(created.settings.coverImage,/^\/media\//);
    // Change the form and apply the saved style again. The manuscript fields must stay intact.
    await $('#article-overrides summary').click();await $('#theme').selectOption('sage');await $('#preset-select').selectOption('web-blue');
    assert.equal(await $('#theme').inputValue(),'blue');assert.equal(await $('#bodySize').inputValue(),'38');
    for(const key of ['title','question'])assert.equal(await $('#'+key).inputValue(),original[key]);
    assert.equal(await $('#headerRight').inputValue(),'栏目精选');
    assert.equal(await p.locator('#subtitle, #endQuote, #issue').count(),0);
    await $('#refresh').click();await p.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存到本机');
    const saved=await (await api('project')).json();assert.equal(saved.md,md);assert.equal(saved.settings.theme,'blue');assert.equal(saved.settings.bodySize,38);assert.equal(saved.settings.presetName,'web-blue');assert.equal(saved.settings.presetCoverImage,created.settings.coverImage);assert.equal(saved.settings.presetQuestion,'独立排版的默认问题？');
    for(const k of ['title','question','coverImage'])assert.equal(saved.settings[k],original[k]);
    assert.equal(saved.settings.headerRight,'栏目精选');
    for(const k of ['issue','subtitle','endQuote'])assert.equal(saved.settings[k],undefined);
    await $('#open-settings').click();await $('#preset-manage-select').selectOption('web-blue');
    await $('#preset-edit-question').fill('网页里更新过的追问？');await $('#preset-edit-theme').selectOption('sage');await $('#preset-edit-headerRight').fill('换一个页眉');await $('#preset-update').click();
    await p.waitForFunction(()=>document.querySelector('#preset-status').textContent.includes('已更新'));
    const updated=(await (await api('presets')).json()).presets.find(x=>x.name==='web-blue');
    assert.equal(updated.settings.question,'网页里更新过的追问？');assert.equal(updated.settings.theme,'sage');assert.equal(updated.settings.headerRight,'换一个页眉');
    assert.deepEqual(await (await api('project')).json(),saved);
    await $('#settings-close').click();await p.reload();await p.waitForSelector('#stage .fp-theme-blue');
    await $('#jump-cover').click();assert.equal(await $('#stage .fp-cover-art img').getAttribute('src'),original.coverImage);assert.equal(await $('#stage .fp-issue').textContent(),'栏目精选');
    await $('#title').fill('');await $('#article-extras summary').click();await $('#question').fill('');await $('#cover-clear').click();
    assert.equal(await $('#export-all').isDisabled(),true);
    await $('#refresh').click();
    await p.waitForSelector('#stage .fp-cover-art img[src="'+created.settings.coverImage+'"]');
    assert.equal(await $('#stage .fp-cover-title').textContent(),'文章标题');
    await $('#jump-ending').click();assert.equal(await $('#stage .fp-end-question').textContent(),'独立排版的默认问题？');
    // Verify that CLI can actually render with the preset created in the browser.
    const file=path.join(fixture,'article.md');await fs.writeFile(file,md);
    const result=JSON.parse(cli(['render',file,'--preset','web-blue','--out',path.join(fixture,'cards'),'--json'],env));
    assert.deepEqual(result.pageKinds,['cover','body','ending']);assert.equal(result.title,'文章标题');
    await $('#open-settings').click();await $('#preset-manage-select').selectOption('text');
    assert.equal(await $('#preset-delete').isVisible(),false);
    await $('#preset-manage-select').selectOption('web-blue');
    const draftBeforeDelete=await (await api('project')).json();
    p.once('dialog',d=>d.dismiss());await $('#preset-delete').click();
    assert.ok((await (await api('presets')).json()).presets.some(x=>x.name==='web-blue'));
    p.once('dialog',d=>d.accept());await $('#preset-delete').click();
    await p.waitForFunction(()=>document.querySelector('#preset-status').textContent.includes('已删除'));
    assert.ok(!(await (await api('presets')).json()).presets.some(x=>x.name==='web-blue'));
    assert.deepEqual(await (await api('project')).json(),draftBeforeDelete);
  }finally{await b.close();}
}));

test('header is optional, vote is opt-in, and preview can jump directly to cover and ending', {timeout:30000}, async()=>isolated(async({base,api})=>{
 const browser=await chromium.launch({executablePath:process.env.FOLIO_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
   const p=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
   const $=s=>p.locator(s), stage=$('#stage .folio-page');
   const kind=async expected=>{await p.waitForSelector(`#stage .folio-page[data-kind="${expected}"]`);};
   await p.goto(base);await kind('body');
   await $('#jump-cover').click();await kind('cover');
   assert.equal(await stage.locator('.fp-issue').count(),0);
   assert.equal(await stage.locator('.fp-cover-question').count(),0);
   await $('#jump-ending').click();await kind('ending');
   assert.deepEqual(await stage.locator('.fp-action strong').allTextContents(),['收藏','点赞','关注']);
   assert.equal(await stage.locator('.fp-issue').count(),0);
   assert.equal(await $('#headerRight').inputValue(),'');
   await $('#article-overrides summary').click();await $('#headerRight').fill('第 02 期');await $('#endingVote').check();await $('#refresh').click();
   await p.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存到本机'&&!document.querySelector('#refresh').disabled);
   await $('#jump-ending').click();await kind('ending');
   assert.deepEqual(await stage.locator('.fp-action strong').allTextContents(),['收藏','点赞','关注','投票']);
   assert.equal(await stage.locator('.fp-issue').textContent(),'第 02 期');
   const saved=await (await api('project')).json();assert.equal(saved.settings.endingVote,true);
   await $('#view-grid').click();await $('#jump-cover').click();
   assert.equal(await $('#view-grid').getAttribute('aria-pressed'),'true');assert.match(await $('#turn-indicator').textContent(),/^1 \/ /);
   await $('#ending').uncheck();assert.equal(await $('#endingVote').isHidden()||await $('#endingVote').isDisabled(),true);
   await $('#cover').uncheck();await $('#refresh').click();
   await p.waitForFunction(()=>document.querySelector('#jump-cover').disabled&&document.querySelector('#jump-ending').disabled);
 }finally{await browser.close();}
}));
