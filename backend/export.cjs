'use strict';
const { parseDocument } = require('htmlparser2');
const { chromium } = require('playwright');
const fs = require('node:fs');
const { fail, MiB, safeRead, isLocalImagePath } = require('./common.cjs');
const WIDTH = 1080, HEIGHT = 1440, MAX_PAGES = 60;
const tags = new Set('article div span header footer section main aside h1 h2 h3 h4 h5 h6 p blockquote pre code ol ul li table thead tbody tr th td a strong b em i del br hr img figure figcaption small mark sup sub'.split(' '));
const voidTags = new Set(['br', 'hr', 'img']);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const exportOrigin = 'https://folio-export.invalid'; // Synthetic origin; Chromium never contacts a server.
function sanitizePage(html, images) {
  if (typeof html !== 'string' || !html.length || Buffer.byteLength(html) > 256 * 1024) fail(400, '每页 HTML 须为不超过 256 KiB 的字符串。');
  const doc = parseDocument(html);
  const roots = doc.children.filter(n => n.type !== 'text' || n.data.trim());
  if (roots.length !== 1 || !['article','section','div'].includes(roots[0].name) || !String(roots[0].attribs.class || '').split(/\s+/).includes('folio-page')) fail(400, '每页须包含唯一的 .folio-page 根元素。');
  let nodes = 0;
  function walk(n, depth) {
    if (++nodes > 10000 || depth > 60) fail(413, '页面结构过于复杂。');
    if (n.type === 'text') return esc(n.data);
    if (n.type === 'comment') return '';
    if (n.type !== 'tag' || !tags.has(n.name)) fail(400, '导出仅接受受支持的静态排版元素。');
    const attrs = [];
    for (const [k,v] of Object.entries(n.attribs)) {
      if (k === 'class' && /^[a-zA-Z0-9_\-\s]{0,512}$/.test(v)) attrs.push([k,v]);
      else if (/^data-[a-z0-9-]{1,40}$/.test(k) && v.length <= 128) attrs.push([k,v]);
      else if (n.name === 'img' && k === 'src') {
        if (!isLocalImagePath(v)) fail(400, '导出只允许 /assets/ 或 /media/ 下的本地栅格图片。');
        images.add(v); attrs.push([k,v]);
      } else if (n.name === 'img' && k === 'alt') attrs.push([k,v.slice(0,1000)]);
      else if ((n.name === 'ol' && k === 'start' || n.name === 'li' && k === 'value') && /^\d{1,8}$/.test(v)) attrs.push([k,v]);
      else if (k === 'style') {
        // Copy only the two scalar settings understood by pages.css, never a CSS expression.
        const vars = [];
        for (const declaration of v.split(';')) {
          const m = /^\s*(--fp-size|--fp-leading)\s*:\s*(\d{1,3}(?:\.\d{1,12})?|\.\d{1,12})(px)?\s*$/.exec(declaration);
          if (m && ((m[1] === '--fp-size' && m[3] === 'px' && +m[2] >= 1 && +m[2] <= 160) || (m[1] === '--fp-leading' && !m[3] && +m[2] >= .5 && +m[2] <= 4))) vars.push(`${m[1]}:${Number(m[2])}${m[3] || ''}`);
        }
        if (vars.length) attrs.push(['style',vars.join(';')]);
      }
      // No href, id, events, srcset, background, form or arbitrary attribute is forwarded.
    }
    return `<${n.name}${attrs.map(([k,v]) => ` ${k}="${esc(v)}"`).join('')}>` + (voidTags.has(n.name) ? '' : n.children.map(child => walk(child,depth+1)).join('') + `</${n.name}>`);
  }
  return walk(roots[0],0);
}
const crcTable = Uint32Array.from({length:256},(_,n) => { for(let j=0;j<8;j++) n = (n>>>1)^((n&1)?0xedb88320:0); return n>>>0; });
function crc32(buf) {let c = 0xffffffff; for (const v of buf) c = (c>>>8)^crcTable[(c^v)&255]; return (~c)>>>0;}
// Store-only ZIP: screenshots are already compressed. Names are generated locally (no user paths).
function zip(entries) {
  const files = [], dir = []; let pos = 0, dirSize = 0;
  for (const [filename, data] of entries) {
    const name = Buffer.from(filename), c = crc32(data);
    const h = Buffer.alloc(30), d = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50,0); h.writeUInt16LE(20,4); h.writeUInt16LE(33,12); h.writeUInt32LE(c,14); h.writeUInt32LE(data.length,18); h.writeUInt32LE(data.length,22); h.writeUInt16LE(name.length,26);
    d.writeUInt32LE(0x02014b50,0); d.writeUInt16LE(20,4); h.copy(d,6,4,28); d.writeUInt32LE(pos,42);
    files.push(h,name,data); dir.push(d,name); pos += h.length+name.length+data.length; dirSize += d.length+name.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(dirSize,12); end.writeUInt32LE(pos,16);
  return Buffer.concat([...files,...dir,end]);
}
function browserEnvironment() {
  // Browser receives only launch essentials (not API keys or provider configuration).
  return Object.fromEntries(['PATH','HOME','USER','TMPDIR','TMP','TEMP','LANG','LC_ALL','SystemRoot','LOCALAPPDATA','DISPLAY','XDG_RUNTIME_DIR'].filter(k => process.env[k]).map(k=>[k,process.env[k]]));
}
async function launchBrowser(env) {
  const candidates = env.FOLIO_CHROME_PATH ? [env.FOLIO_CHROME_PATH] : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].filter(f=>fs.existsSync(f)).concat([undefined]);
  for (const executablePath of candidates) {
    try { return await chromium.launch({headless:true, chromiumSandbox:true, executablePath, env:browserEnvironment(), timeout:12000, args:['--disable-background-networking','--disable-component-update','--no-first-run','--disable-sync','--host-resolver-rules=MAP * ~NOTFOUND']}); } catch { /* try the bundled browser unless a path was explicitly configured */ }
  }
  fail(503, '无法启动沙箱 Chrome。请安装 Chrome 或执行 npx playwright install chromium，或设置 FOLIO_CHROME_PATH。');
}
async function renderExport(body, {publicDir, mediaDir, env, browser: sharedBrowser}) {
  const {html, index, title} = body;
  if (!Array.isArray(html) || !html.length || html.length > MAX_PAGES || typeof title !== 'string' || title.length > 500) fail(400, `需要标题和 1–${MAX_PAGES} 页 HTML。`);
  if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= html.length)) fail(400, '导出页码不在范围内（index 从 0 开始）。');
  const images = new Set(), pages = (index === undefined ? html : [html[index]]).map(h=>sanitizePage(h,images));
  if (images.size > 80) fail(413, '单次导出的图片过多。');
  const resources = new Map([['/pages.css', {contentType:'text/css',body:await safeRead(publicDir,'pages.css',MiB)}]]);
  let imageBytes = 0;
  for (const src of images) {
    const media = src.startsWith('/media/'); const buf = await safeRead(media ? mediaDir : publicDir, media ? src.slice(7) : src.slice(1), 16*MiB);
    if ((imageBytes += buf.length) > 64*MiB) fail(413, '页面图片总大小超过 64 MiB。');
    resources.set(src, {body:buf, contentType: /\.png$/i.test(src) ? 'image/png' : /\.webp$/i.test(src) ? 'image/webp' : 'image/jpeg'});
  }
  const ownsBrowser = !sharedBrowser;
  const browser = sharedBrowser || await launchBrowser(env);
  const watchdog = setTimeout(() => { if (ownsBrowser) browser.close().catch(()=>{}); }, 120000); watchdog.unref();
  let ctx;
  try {
    ctx = await browser.newContext({viewport:{width:WIDTH,height:HEIGHT},deviceScaleFactor:1,javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false,bypassCSP:false});
    let markup;
    const csp = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
    await ctx.route('**/*', async route=>{
      const req=route.request(); const u=new URL(req.url());
      if (u.origin !== exportOrigin || req.method() !== 'GET' || u.search) return route.abort();
      if (u.pathname === '/page' && req.resourceType()==='document') return route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'Content-Security-Policy':csp},body:markup});
      const resource=resources.get(u.pathname);
      if (!resource || !['image','stylesheet'].includes(req.resourceType())) return route.abort();
      return route.fulfill({status:200,...resource}); // no continue() or fallback to network
    });
    const page=await ctx.newPage(); const entries=[]; let total=0;
    for (let i=0; i<pages.length; i++) {
      markup = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/pages.css"><style>html,body{margin:0!important;padding:0!important;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}body>.folio-page{margin:0!important;transform:none!important;box-shadow:none!important}</style></head><body>${pages[i]}</body></html>`;
      await page.goto(exportOrigin+'/page',{waitUntil:'load',timeout:10000});
      const loaded=await page.evaluate(async()=>{await document.fonts.ready;return Array.from(document.images).every(x=>x.complete && x.naturalWidth>0)});
      if (!loaded) fail(422, '页面包含读取失败的图片。');
      const png=await page.screenshot({type:'png',timeout:10000,animations:'disabled'});
      if ((total+=png.length)>96*MiB) fail(413, '导出文件超过 96 MiB。请分批导出。');
      entries.push([`page-${String((index ?? i)+1).padStart(2,'0')}.png`,png]);
    }
    const ext=index===undefined?'zip':'png'; const stem=Array.from(title.normalize('NFC').replace(/[^\p{L}\p{N}\s_-]/gu,'').trim()).slice(0,60).join('')||'Folio';
    return { bytes:ext==='zip'?zip(entries):entries[0][1], entries, type:ext==='zip'?'application/zip':'image/png',filename:`${stem}${ext==='png'?'-'+String(index+1).padStart(2,'0'):''}.${ext}`, ext };
  } finally {
    clearTimeout(watchdog);
    if (ctx) await ctx.close().catch(()=>{});
    if (ownsBrowser) await browser.close().catch(()=>{});
  }
}
module.exports = { MAX_PAGES, sanitizePage, renderExport, launchBrowser, zip };
