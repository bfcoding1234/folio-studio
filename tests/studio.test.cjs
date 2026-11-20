const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright'),sharp=require('sharp'),{start}=require('../server.cjs');
test('studio: Markdown, trial/original, adoption, export, settings and reload', {timeout:65000}, async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'folio-studio-test-'));
 const server=await start({port:0,dataDir,env:{}});const origin=`http://127.0.0.1:${server.address().port}`;
 let browser;try{
 browser=await chromium.launch({executablePath:process.env.FOLIO_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const p=await browser.newPage({viewport:{width:1440,height:980},acceptDownloads:true});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(origin);await p.waitForSelector('#stage [data-block-id]');assert.equal(await p.locator('#stage .folio-page').getAttribute('data-kind'),'body');
 const get=(s)=>p.locator(s);const pages=Number((await get('#page-count').textContent()).split(' ')[0]);assert.ok(pages>=3);
 await get('#view-grid').click();await get('#stage .griditem').last().click();assert.equal(await get('#stage .folio-page').getAttribute('data-kind'),'ending');
 assert.ok((await get('#stage').textContent()).includes('查不到这条记录'));
 await get('#rail button').nth(1).click();const paragraph=get('#stage .fp-block').filter({hasText:'一位用户问'}).first();await paragraph.click();await get('#inspector').waitFor({state:'visible'});
 await get('#library-items button').first().click();await get('#trial-banner').waitFor({state:'visible'});
 await get('#placement-layout').selectOption('hero');await p.waitForSelector('#stage .folio-page[data-kind=hero]');
 assert.ok(Number((await get('#page-count').textContent()).split(' ')[0])>pages);assert.ok((await get('#trial-delta').textContent()).includes('→'));
 await get('#trial-original').click();assert.equal(Number((await get('#page-count').textContent()).split(' ')[0]),pages);
 await get('#trial-view').click();await get('#adopt').click();await get('#inspector').waitFor({state:'hidden'});assert.ok((await get('#stage .folio-page').getAttribute('data-kind'))==='hero');
 await p.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存到本机');const saved=await fetch(origin+'/api/project').then(r=>r.json());assert.equal(Object.values(saved.placements)[0].layout,'hero');
 const dl=p.waitForEvent('download');await get('#export-page').click();const download=await dl;const {width,height}=await sharp(await download.path()).metadata();assert.deepEqual([width,height],[1080,1440]);
 await get('#article-overrides summary').click();await get('#bodySize').fill('36');await get('#theme').selectOption('blue');await get('#refresh').click();await p.waitForFunction(()=>!document.querySelector('#refresh').disabled&&document.querySelector('#save-state').textContent==='已保存到本机');await p.reload();await p.waitForSelector('#stage .folio-page[data-kind=body]');assert.equal(await get('#bodySize').inputValue(),'36');assert.equal(await get('#theme').inputValue(),'blue');
 assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
