// Independent regression contract, intended for an actual layout-capable browser.
// Serve public/ at /, import this module in a browser test harness, and await
// checkPages((await import('/pages.js')).buildPages). No test library required.
export async function checkPages(buildPages) {
  const passed=[];
  function check(ok, label) { if(!ok) throw new Error(label); passed.push(label); }
  const all=(result,sel)=>result.pages.flatMap(page=>[...page.querySelectorAll(sel)]);
  const paragraph='有些信息值得保留，有些则要重新核实。🧵'.repeat(350);
  const code='let answer = 42; // 保留换行\n'.repeat(80)+'// EOF';
  const rows=Array.from({length:75},(_,i)=>`| ${i} | 例子 ${i} |`).join('\r\n');
  const md=['# 标题','相同段落','相同段落','<!-- pagebreak -->','> **引文**','- 项目一\r\n- 项目二',`**${paragraph}**`,`\`\`\`js\r\n${code}\r\n\`\`\``,`| 序号 | 内容 |\r\n| --- | --- |\r\n${rows}`,'<button>不应变成按钮</button> [文字](javascript:bad)'].join('\r\n\r\n');
  const project={md,settings:{cover:false,ending:false,bodySize:36,lineHeight:1.6}};
  const result=await buildPages(project);
  check(result.pages.length>4,'内容实际跨页');
  check(result.blocks.length===9,'保留所有正文块；分页指令不成为段落');
  check(result.blocks.every(b=>md.slice(b.start,b.end).length>0),'原稿 UTF-16 来源区间');
  check(md.slice(result.blocks[1].start,result.blocks[1].end)==='相同段落','CRLF 段落区间准确');
  check(result.blocks[1].id!==result.blocks[2].id,'重复段落锚点不冲突');
  const anchored=await buildPages({md:'新增段落\n\n相同段落\n\n相同段落',settings:project.settings});
  check(anchored.blocks[1].id===result.blocks[1].id && anchored.blocks[2].id===result.blocks[2].id,'在前文插入内容不影响已有锚点');
  check(!result.pages[0].querySelector('blockquote') && !!result.pages[1].querySelector('blockquote'),'手动分页强制从新页开始');
  check(all(result,'strong').map(n=>n.textContent).join('')==='引文'+paragraph,'跨页粗体长段完整、保留 UTF-16 字符');
  check(all(result,'pre code').map(n=>n.textContent).join('')===code,'跨页代码无截断或重复');
  check(all(result,'tbody td').map(n=>n.textContent).join('')===Array.from({length:75},(_,i)=>`${i}例子 ${i}`).join(''),'表格分页无文字丢失');
  check(all(result,'li').length===2 && all(result,'blockquote strong')[0]?.textContent==='引文','保留列表与引用内粗体');
  check(!all(result,'button,script,a[href^="javascript:"]').length && result.warnings.some(w=>w.includes('不安全')),'HTML 惰性展示，危险链接过滤');
  const mount=document.createElement('div');mount.className='fp-measure';document.body.append(mount);
  try { mount.append(...result.pages);
    check(result.pages.every(p=>p.offsetWidth===1080 && p.offsetHeight===1440),'实体画布 1080×1440');
    check(result.pages.every(p=>p.querySelector('.fp-stack').getBoundingClientRect().height<=p.querySelector('.fp-flow').getBoundingClientRect().height+.1),'每页实测高度均在版心内');
  } finally {mount.remove();}
  const small={md:'编号一。配图应该留在这一段。',settings:{cover:true,ending:true,coverImage:'/assets/context.png',title:'标题',subtitle:'副标题',question:'追问？',endQuote:'情境。',issue:'特刊'}};
  const initial=await buildPages(small); const id=initial.blocks[0].id;
  for(const layout of ['spot','inline','hero']) {const r=await buildPages(small,{[id]:{src:'/assets/shoes.png',layout,caption:'测试'}});
    check(all(r,`.fp-${layout} img`).length===1 && all(r,'figcaption')[0].textContent==='测试',`${layout} 图片与说明各一次`);
    check(r.pages.filter(p=>p.dataset.kind==='hero').length===(layout==='hero'?1:0),`${layout} 页面层级正确`);
  }
  check(initial.pages[0].querySelector('img')?.getAttribute('src')==='/assets/context.png' && !initial.pages[0].textContent.includes('追问') && initial.pages[0].textContent.includes('副标题'),'封面包含可导出的本地插画，副标题独立');
  check(initial.pages.at(-1).textContent.includes('追问？') && initial.pages.at(-1).textContent.includes('特刊 · 练习页') && initial.pages.at(-1).querySelectorAll('.fp-action').length===3,'结尾含情境、追问和三个独立动作');
  return {passed:passed.length,bodyPages:result.pages.length,checks:passed};
}
