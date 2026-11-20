/* Native, offline Markdown → physical editorial pages. Requires a layout-capable DOM.
 * Source ranges are half-open UTF-16 offsets in the ORIGINAL string (including CRLF).
 * Raw HTML never enters an HTML parser. All untrusted values become text nodes.
 */
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const group = (tag, cls, ...children) => { const n = el(tag, cls); n.append(...children); return n; };
const pad = n => String(n).padStart(2, '0');
const clamp = (n, lo, hi, fallback) => n != null && n !== '' && Number.isFinite(+n) ? Math.min(hi, Math.max(lo, +n)) : fallback;
const num = /^[ \t]*(\d+)[.)][ \t]+/;
const marker = /^( *)([-+*]|\d+[.)])[ \t]+(.*)$/;
const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*$)/;
const rule = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const pagebreak = /^\s*<!--\s*pagebreak\s*-->\s*$/i;
const quote = /^ {0,3}> ?/;
const splitCells = line => line.trim().replace(/^\||(?<!\\)\|$/g,'').split(/(?<!\\)\|/).map(c => c.trim());
const delimiter = line => line && line.includes('|') && splitCells(line).every(c => /^:?-{3,}:?$/.test(c));
const textHash = s => {
  // Two independent 32-bit lanes, no crypto/subtle or secure origin required.
  let a = 2166136261, b = 5381;
  for (let i=0; i<s.length; i++) { const c=s.charCodeAt(i); a=Math.imul(a^c,16777619); b=Math.imul(b,33)^c; }
  return `b-${(a>>>0).toString(36)}-${(b>>>0).toString(36)}`;
};
function safeURL(raw, image) {
  if (typeof raw !== 'string' || /[\x00-\x20\x7f\\]/.test(raw) || raw.startsWith('//')) return null;
  try {
    const u = new URL(raw, document.baseURI);
    if (image) {
      const localAsset=/^\/assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:png|jpe?g|webp)$/i;
      const localUpload=/^\/media\/[a-f0-9]{64}\.webp$/;
      if (u.origin!==location.origin || !(localAsset.test(u.pathname)||localUpload.test(u.pathname))) return null;
      return u.pathname;
    }
    return ['http:','https:','mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}
// A small, deliberately conservative Markdown inline grammar. Unsupported HTML and
// malformed delimiters remain visible literally instead of being silently removed.
function inline(host, source, warn, depth=0, resolveImage) {
  if (depth>16) { host.append(source); return; }
  // Handle angle-wrapped link destinations independently; the tokenizer below
  // only admits an inert URI string and never copies arbitrary attributes.
  const rx = /\\([\\`*_{}\[\]()#+.!|~>-])|(`+)([^\n]*?)\2|(!?)\[([^\]\n]*)\]\((<[^<>\s]+>|[^\s()<>]+)(?:[ \t]+["'][^\n"']*["'])?\)|(\*\*|__|~~)(?=\S)([\s\S]+?)\7|(\*|_)(?=\S)([^\n]+?)\9| {2,}\n|\\\n/g;
  let last=0;
  for (const m of source.matchAll(rx)) {
    if (m.index>last) host.append(source.slice(last,m.index));
    if (m[1]) host.append(m[1]);
    else if (m[2]) host.append(el('code','',m[3]));
    else if (m[4]!==undefined) {
      const isImage=!!m[4], dest=m[6].replace(/^<|>$/g,''), url=safeURL(isImage && resolveImage ? resolveImage(dest) : dest,isImage);
      if (!url) { host.append(m[5] || dest); warn(isImage?'图片仅支持本地 /assets/ 或 /media/ 资源。':'已移除不安全链接，保留链接文字。'); }
      else if (isImage) { const img=el('img','fp-md-img'); img.src=url; img.alt=m[5]; host.append(img); }
      else { const a=el('a'); a.href=url; inline(a,m[5],warn,depth+1,resolveImage); host.append(a); }
    } else if (m[7] || m[9]) {
      const tag=m[7] ? (m[7]==='~~'?'del':'strong') : 'em';
      const n=el(tag); inline(n,m[8]??m[10],warn,depth+1,resolveImage); host.append(n);
    } else host.append(el('br'));
    last=m.index+m[0].length;
  }
  if(last<source.length) host.append(source.slice(last));
}
function markdown(md,warn,level=0,resolveImage) {
  const lines = Array.from(md.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g), m=>({s:m[1],at:m.index}));
  const s=i=>lines[i]?.s??'';
  const blocks=[]; let i=0;
  function push(from,node,manual=false) {
    const start=lines[from].at, end=lines[i-1].at+s(i-1).length;
    blocks.push({start,end,raw:md.slice(start,end),node,manual});
  }
  function special(j) { const a=s(j); return !a.trim()||pagebreak.test(a)||fence.test(a)||heading.test(a)||rule.test(a)||marker.test(a)||quote.test(a)||(a.includes('|') && delimiter(s(j+1))); }
  while(i<lines.length) {
    const a=s(i), first=i; if(!a.trim()) { i++; continue; }
    if(pagebreak.test(a)) { i++; push(first,null,true); continue; }
    let m=fence.exec(a);
    if(m) { const end=new RegExp('^ {0,3}'+m[1][0]+'{'+m[1].length+',}\\s*$'); const content=[]; i++;
      while(i<lines.length && !end.test(s(i))) content.push(s(i++));
      if(i<lines.length) i++; else warn('有代码围栏未闭合，已将余下内容保留为代码。');
      push(first,group('pre','',el('code','',content.join('\n')))); continue;
    }
    m=heading.exec(a); if(m) { i++; const n=el('h'+m[1].length); inline(n,(m[2]||'').replace(/\s+#+\s*$/,''),warn,0,resolveImage); push(first,n); continue; }
    if(rule.test(a)) { i++; push(first,el('hr')); continue; }
    if(a.includes('|') && delimiter(s(i+1))) {
      const table=el('table'); const ths=el('thead'), body=el('tbody'); table.append(ths,body);
      const align=splitCells(s(i+1));
      const row=(v,tag,where)=>{ const tr=el('tr'); splitCells(v).forEach((cell,k)=>{const al=align[k]||''; const td=el(tag,al.startsWith(':')&&al.endsWith(':')?'fp-center':al.endsWith(':')?'fp-right':''); inline(td,cell,warn,0,resolveImage); tr.append(td);}); where.append(tr);};
      row(a,'th',ths); i+=2; while(i<lines.length && s(i).trim() && s(i).includes('|') && !pagebreak.test(s(i))) row(s(i++),'td',body);
      push(first,table); continue;
    }
    if(quote.test(a)) { const n=el('blockquote'), values=[]; while(i<lines.length && quote.test(s(i))) values.push(s(i++).replace(quote,''));
      if(level<16) markdown(values.join('\n'),warn,level+1,resolveImage).forEach(t=>{if(t.node)n.append(t.node);else n.append(el('hr'));}); else inline(n,values.join('\n'),warn,0,resolveImage); push(first,n); continue; }
    m=marker.exec(a); if(m) {
      const ordered=num.test(a), indent=m[1].length, n=el(ordered?'ol':'ul'); let number=ordered ? +m[2].slice(0,-1) : 0;
      if(ordered) n.start=number;
      while(i<lines.length) {
        const item=marker.exec(s(i)); if(!item||item[1].length!==indent||num.test(s(i))!==ordered) break;
        const li=el('li'); if(ordered) li.value=number++; let text=item[3]; i++;
        const nested=[];
        while(i<lines.length && s(i).trim() && /^ /.test(s(i)) && s(i).search(/\S/)>indent) nested.push(s(i++).slice(Math.min(indent+2,s(i-1).search(/\S/))));
        if(nested.length && level<16) { markdown([text,...nested].join('\n'),warn,level+1,resolveImage).forEach(t=>li.append(t.node||el('hr'))); }
        else inline(li,[text,...nested].join('\n'),warn,0,resolveImage);
        n.append(li);
      }
      push(first,n); continue;
    }
    if(i+1<lines.length && /^ {0,3}(=+|-+)\s*$/.test(s(i+1))) { const n=el(s(i+1).trim()[0]==='='?'h1':'h2'); inline(n,a,warn,0,resolveImage); i+=2; push(first,n); continue; }
    const values=[a]; i++; while(i<lines.length && !special(i)) values.push(s(i++));
    const n=el('p'); inline(n,values.join('\n'),warn,0,resolveImage); push(first,n);
  }
  return blocks;
}

/** Inspect the same supported Markdown grammar without loading referenced images. */
export function inspectMarkdown(md) {
  const images = new Set();
  const blocks = markdown(String(md), () => {}, 0, raw => { images.add(raw); return null; });
  return { title: blocks.find(x => x.node?.tagName === 'H1')?.node.textContent?.trim() || '', images: [...images] };
}

let cssPromise;
function ensureStyle() {
  if(cssPromise) return cssPromise;
  const href=new URL('./pages.css',import.meta.url).href;
  let link=Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).find(l=>l.href.split('?')[0]===href.split('?')[0]);
  if(link?.sheet) return Promise.resolve();
  const create=!link; if(create) { link=el('link'); link.rel='stylesheet'; link.href=href; }
  cssPromise=new Promise((ok,no)=>{ link.addEventListener('load',ok,{once:true}); link.addEventListener('error',()=>{cssPromise=null; no(new Error('无法加载分页样式 pages.css'));},{once:true}); });
  if(create) document.head.append(link); return cssPromise;
}
function imageFigure(src, layout, caption, warn) {
  const safe=safeURL(src,true); if(!safe) {warn('已忽略非本地或无效的配图地址。'); return null;}
  const fig=el('figure','fp-image fp-'+layout); const img=el('img'); img.src=safe; img.alt=caption || '文章配图'; fig.append(img);
  if(caption) fig.append(el('figcaption','',caption)); return fig;
}
function blockView(t, placement, warn) {
  const wrap=el('div','fp-block'); wrap.dataset.blockId=t.id; wrap.append(t.node);
  if(!placement?.src) return {wrap};
  const layout=['spot','inline','hero'].includes(placement.layout)?placement.layout:'inline';
  const fig=imageFigure(placement.src,layout,String(placement.caption||''),warn); if(!fig) return {wrap};
  if(layout==='hero') { const hero=group('div','fp-block',fig); hero.dataset.blockId=t.id; return {wrap,hero}; }
  if(layout==='spot') wrap.prepend(fig);
  else if(t.node.tagName==='P' && t.node.textContent.length>1) {
    // Split at a nearby sentence boundary and preserve every inline element via Range.
    const p=t.node, full=p.textContent, half=Math.floor(full.length/2); let off=half;
    const marks=Array.from(full.matchAll(/[。！？.!?；;，,]\s*|\s+/g),m=>m.index+m[0].length).filter(x=>x>full.length*.2 && x<full.length*.8);
    if(marks.length) off=marks.reduce((a,b)=>Math.abs(a-half)<Math.abs(b-half)?a:b);
    if(/[\uDC00-\uDFFF]/.test(full[off])) off++;
    const w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT); let text=w.nextNode();
    while(text && off>text.length) {off-=text.length;text=w.nextNode();}
    if(text) {const r=document.createRange();r.selectNodeContents(p);r.setStart(text,off);const after=el('p');after.append(r.extractContents());wrap.append(fig,after);} else wrap.append(fig);
  } else wrap.append(fig);
  return {wrap};
}
// A logical offset index preserves element ancestry (including styled inline text),
// atomic leaves (images, <br>, <hr>) and real grid cells across arbitrary page cuts.
function indexDOM(root) {
  let pos=0; const preferred=[];
  function index(n) {
    const a=pos; let children;
    if(n.nodeType===3) pos+=n.length;
    else if(n.childNodes.length) children=Array.from(n.childNodes,index);
    else pos++;
    if(['TR','LI','P','FIGURE'].includes(n.tagName)) preferred.push(pos);
    return {n,a,b:pos,children};
  }
  const tree=index(root);
  function cut(t,from,to) {
    if(t.b<=from||t.a>=to) return null;
    if(t.a>=from && t.b<=to) return t.n.cloneNode(true);
    if(t.n.nodeType===3) return document.createTextNode(t.n.data.slice(Math.max(0,from-t.a),Math.min(to,t.b)-t.a));
    const n=t.n.cloneNode(false);
    if(n.tagName==='LI' && from>t.a) n.classList.add('fp-li-cont');
    for(const c of t.children||[]) {const part=cut(c,from,to); if(part) n.append(part);else if(n.tagName==='TR') n.append(c.n.cloneNode(false));}
    return n;
  }
  return {size:pos,preferred:preferred.sort((a,b)=>a-b),slice:(a,b)=>cut(tree,a,b),textAt:function at(k,t=tree){if(k<t.a||k>=t.b) return ''; if(t.n.nodeType===3) return t.n.data[k-t.a];for(const c of t.children||[]) if(k>=c.a&&k<c.b)return at(k,c);return '';}};
}
function betterCut(idx,from,best) {
  let cut=best;
  const min=from+Math.floor((best-from)*.65);
  // Preserve whole table rows/list items whenever it doesn't waste most of a page.
  for(let j=idx.preferred.length-1;j>=0;j--) {const v=idx.preferred[j]; if(v<=min) break; if(v<=best) return v;}
  for(let j=best;j>Math.max(min,best-60);j--) if(/[\s。！？；，、,.!?;:]/.test(idx.textAt(j-1))) {cut=j; break;}
  if(cut>from+1 && /[\uDC00-\uDFFF]/.test(idx.textAt(cut))) cut--;
  return cut;
}

/** Build detached, export-ready pages. Concurrent calls have separate measurement roots. */
export async function buildPages(project, placements=project.placements||{}, {imageAliases={}}={}) {
  await ensureStyle(); if(document.fonts) await document.fonts.ready;
  const md=String(project.md??''), s=project.settings||{}, warnings=new Set(), warn=m=>warnings.add(m), pages=[], blocks=[], counts=new Map();
  const series=String(s.column||'思辨练习'), headerRight=String(s.headerRight??s.issue??'').trim();
  const src=markdown(md,warn,0,raw=>Object.hasOwn(imageAliases,raw)?imageAliases[raw]:raw);
  const heading=src.find(t=>t.node?.tagName==='H1')?.node.textContent?.trim();
  const title=String(s.title??'').trim() || Array.from(heading||project.fallbackTitle||'无题').slice(0,55).join('');
  const question=String(s.question??'').trim() || String(s.presetQuestion??'').trim();
  const coverImage=s.coverArtMode==='text'?'':s.coverImage||s.presetCoverImage;
  for(const t of src) if(!t.manual) {
    const key=textHash(t.raw.replace(/\r\n?/g,'\n').trim()); const occurrence=(counts.get(key)||0)+1; counts.set(key,occurrence); t.id=`${key}-${occurrence}`;
    blocks.push({id:t.id,text:t.node.textContent||t.raw,start:t.start,end:t.end});
  }
  const stage=el('div','fp-measure'); stage.setAttribute('aria-hidden','true'); document.body.append(stage);
  let current=null;
  function shell(kind) {
    const th=['clay','blue','sage'].includes(s.theme)?s.theme:'clay';
    const p=el('article',`folio-page fp-theme-${th} fp-sheet-${kind} fp-body-${s.bodyFont==='serif'?'serif':'sans'} fp-title-${s.titleFont==='sans'?'sans':'serif'}`);
    p.dataset.kind=kind; p.dataset.page=String(pages.length+1);
    p.style.setProperty('--fp-size',clamp(s.bodySize,20,72,38)+'px');p.style.setProperty('--fp-leading',clamp(s.lineHeight,1,2.6,1.65));
    pages.push(p); stage.append(p); return p;
  }
  const header=()=>{const head=group('header','fp-head',el('span','fp-series',series));if(headerRight)head.append(el('span','fp-issue',headerRight));return head;};
  const foot=(p)=>group('footer','fp-foot',el('span','',title),el('span','fp-page-no',pad(+p.dataset.page)));
  function newBody(kind='body') {
    const p=shell(kind), stack=el('div','fp-stack'), area=group('section','fp-flow',stack); p.append(header(),area,foot(p)); current={p,stack,area}; return current;
  }
  const fits=()=>current.stack.getBoundingClientRect().height <= current.area.getBoundingClientRect().height+.1;
  function trial(node,keep=false) {current.stack.append(node);const yes=fits();if(!yes||!keep) node.remove();return yes;}
  function appendBlock(node,kind='body') {
    if(!current) newBody(kind);
    if(trial(node,true)) return;
    let idx, bindHeading=false;
    // Keep a run of section headings with the following paragraph/list. Use the real
    // block first; for an oversized follower reserve room for approximately two lines.
    const old=current, tail=[];
    for(let n=old.stack.lastElementChild;n;n=n.previousElementSibling) {
      if(!Array.from(n.children).some(c=>/^H[1-6]$/.test(c.tagName))) break;
      tail.unshift(n);
    }
    if(tail.length && kind==='body') {
      let moved=tail.length<old.stack.children.length;
      if(moved) {newBody(kind);current.stack.append(...tail);}
      if(trial(node,true)) return;
      idx=indexDOM(node);
      bindHeading=idx.size>0 && trial(idx.slice(0,Math.min(64,idx.size)));
      if(!bindHeading && moved) {old.stack.append(...tail);current.p.remove();pages.pop();current=old;}
    }
    // Avoid splitting a normal-sized paragraph merely because the previous page is full.
    if(!bindHeading && current.stack.children.length) {
      const before=current; newBody(kind); if(trial(node,true)) return;
      // The block itself is taller than a page; use any meaningful remaining space.
      current.p.remove();pages.pop();current=before;
    }
    idx??=indexDOM(node); let start=0,part=0;
    while(start<idx.size) {
      let lo=start,step=64,hi=Math.min(idx.size,start+step);
      while(trial(idx.slice(start,hi))) {lo=hi; if(lo===idx.size) break; step*=2; hi=Math.min(idx.size,start+step);}
      if(lo<idx.size) while(lo+1<hi) {const m=Math.floor((lo+hi)/2); if(trial(idx.slice(start,m))) lo=m; else hi=m;}
      if(lo===start) { if(current.stack.children.length) {newBody(kind);continue;} throw new Error(`无法在空白页容纳块 ${node.dataset.blockId} 的最小片段；请检查页面样式或缩小字号。原文未变更。`); }
      let end=lo===idx.size?lo:betterCut(idx,start,lo);
      // Don't leave a meaningless single line at the bottom of a previous page.
      if(!part && current.stack.children.length && end-start<Math.min(48,idx.size*.1)) {newBody(kind);continue;}
      const frag=idx.slice(start,end); frag.dataset.part=String(++part); current.stack.append(frag);
      if(!fits()) throw new Error('分页后尺寸发生变化，请等字体加载后重试。');
      start=end; if(start<idx.size) newBody(kind);
    }
  }
  try {
    if(s.cover!==false) {
      const p=shell('cover'), text=el('section','fp-cover-copy');
      text.append(el('h1','fp-cover-title',title));
      const fig=coverImage ? imageFigure(coverImage,'cover-art','',warn):null;
      if(!fig) p.classList.add('fp-no-art'); p.append(header(),text); if(fig)p.append(fig);
      if(text.scrollHeight>text.clientHeight+1) {p.classList.add('fp-dense-cover'); if(text.scrollHeight>text.clientHeight+1) warn('封面标题超出可用空间，请缩短封面文字。');}
    }
    for(const t of src) {
      if(t.manual) {current=null;continue;}
      const {wrap,hero}=blockView(t,placements?.[t.id],warn);
      appendBlock(wrap);
      if(hero) {current=null;appendBlock(hero,'hero');current=null;}
    }
    if(s.ending!==false) {
      const p=shell('ending');p.append(header());
      const middle=el('section','fp-ending-copy');middle.append(el('div','fp-end-kicker',s.endingLabel??'欢迎来答'));
      if(question) middle.append(el('h2','fp-end-question',question));
      middle.append(el('p','fp-end-invite',s.endingInvite??'在评论区，写下你的判断。'));
      const actions=el('div','fp-end-actions');
      const actionRow=(icon,label,note)=>group('div','fp-action',el('span','fp-action-icon',icon),el('strong','',label),el('span','fp-action-note',note));
      for(const [i,[icon,label,note]] of [['☆','收藏','下次练习，再来看看'],['♡','点赞','给这道题一点反馈'],['＋','关注','一起练下一题']].entries()) actions.append(actionRow(icon,label,s.endingActionNotes?.[i]??note));
      if(s.endingVote===true) actions.append(actionRow('☑','投票','到笔记投票区，选出你的答案。'));
      middle.append(actions);p.append(middle,el('footer','fp-end-sign',s.endingSign??'本题完'));if(middle.scrollHeight>middle.clientHeight+1) {p.classList.add('fp-dense-end');if(middle.scrollHeight>middle.clientHeight+1)warn('尾页文字超长，请缩短追问或互动文案。');}
    }
    if(!pages.length) newBody();
    const imgs=Array.from(stage.querySelectorAll('img'));
    await Promise.all(imgs.map(async img=>{try{await img.decode();} catch {warn(`未能加载图片：${img.getAttribute('src')}`);}}));
    pages.forEach(n=>n.remove());return {pages,blocks,title,warnings:Array.from(warnings)};
  } finally {stage.remove();}
}
