import {layoutFlow,visibleFlow,isCondition} from './flow-layout.js';
const escape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let activeController;
export function disposeFlowExplorer(){activeController?.abort();activeController=null;}
export function flowExplorerMarkup(){
  return '<section class="flow-explorer" aria-label="点位拓扑浏览器">'+
    '<div class="flow-filter" role="group" aria-label="流程图关系显示">'+
    '<label><input id="show-solid-flow" type="checkbox" checked><span class="line-sample solid"></span>显示实线：数值 / 参数</label>'+
    '<label><input id="show-condition-flow" type="checkbox" checked><span class="line-sample dashed"></span>显示虚线：条件影响</label>'+
    '<label><input id="flow-motion" type="checkbox" checked>流向动画</label>'+
    '<label><input id="flow-compact" type="checkbox" checked>收起无连线节点</label></div>'+
    '<div class="flow-toolbar" role="group" aria-label="拓扑查看工具">'+
    '<label class="flow-locate">定位节点<select id="flow-locate"><option value="">选择节点…</option></select></label>'+
    '<button id="flow-neighborhood" aria-pressed="false">只看选中节点一跳关系</button>'+
    '<button id="flow-clear-selection">取消选中</button>'+
    '<button id="flow-hide">隐藏选中流程</button><button id="flow-undo">撤销隐藏</button><button id="flow-restore">恢复全部隐藏</button>'+
    '<span class="flow-zoom"><button id="flow-zoom-out" aria-label="缩小拓扑">−</button><output id="flow-zoom-label">100%</output><button id="flow-zoom-in" aria-label="放大拓扑">＋</button></span>'+
    '<button id="flow-fit">适应全图</button><button id="flow-center">回到查询点位</button><button id="flow-expand" aria-pressed="false">展开大图</button></div>'+
    '<p class="flow-selection" id="flow-selection" aria-live="polite">单击节点可突出相邻连线；右键节点可隐藏该流程。</p>'+
    '<div class="flow-status"><span id="point-flow-visible" role="status"></span><span id="flow-hidden-count"></span></div>'+
    '<div class="graph-scroll memory-graph" tabindex="0" aria-label="拓扑画布，可滚动查看"><svg id="point-flow" role="group" aria-label="点位来源与去向流程图"></svg><p class="flow-empty" hidden>当前没有可显示的节点，可恢复隐藏或调整筛选。</p></div>'+
    '<p class="small flow-help">光点从来源流向去向，仅表示离线程序关系，不代表实时运行。实线为数值 / 参数，虚线为条件影响。点击连线查看证据；右键节点隐藏流程（同时隐藏进出连线）；按 Esc 退出聚焦或大图。</p>'+
    '<div class="flow-context" role="menu" aria-label="节点操作" hidden><strong id="flow-context-name"></strong><button role="menuitem" data-action="hide">隐藏流程及进出连线</button><button role="menuitem" data-action="neighbors">只看此节点一跳关系</button><button role="menuitem" data-action="cancel">取消</button></div></section>';
}
function linesFor(label){
  const lines=[''];let units=0;
  for(const ch of label){const size=/[^\x00-\xff]/.test(ch)?12:7;if(units+size>208){if(lines.length===2){lines[1]=lines[1].slice(0,-1)+'…';break;}lines.push('');units=0;}lines[lines.length-1]+=ch;units+=size;}
  return lines;
}
export function mountFlowExplorer(flow,showEvidence){
  disposeFlowExplorer();
  const controller=new AbortController();activeController=controller;
  const root=document.querySelector('.flow-explorer'),svg=root.querySelector('svg'),viewport=svg.parentElement;
  const find=id=>root.querySelector('#'+id),menu=root.querySelector('.flow-context');
  const settings={hidden:new Set(),solid:true,condition:true,compact:true,anchor:null};
  const undo=[],names=new Map(flow.nodes.map(n=>[n.id,n.label]));
  let selected=flow.focus,layout,zoom=1,menuNode=null;
  const on=(element,event,fn)=>element.addEventListener(event,fn,{signal:controller.signal});
  const closeMenu=()=>{menu.hidden=true;menuNode=null;};
  function applyZoom(next,center){
    const old=zoom;zoom=Math.max(.05,Math.min(2,next));
    svg.style.width=layout.width*zoom+'px';svg.style.height=layout.height*zoom+'px';
    find('flow-zoom-label').textContent=Math.round(zoom*100)+'%';
    if(center)centerNode(center);
    else {viewport.scrollLeft=(viewport.scrollLeft+viewport.clientWidth/2)*zoom/old-viewport.clientWidth/2;viewport.scrollTop=(viewport.scrollTop+viewport.clientHeight/2)*zoom/old-viewport.clientHeight/2;}
  }
  function centerNode(id){
    const n=layout.nodes.find(n=>n.id===id);if(!n)return;
    viewport.scrollLeft=(n.x+n.width/2)*zoom-viewport.clientWidth/2;
    viewport.scrollTop=(n.y+n.height/2)*zoom-viewport.clientHeight/2;
  }
  function animate(){
    const running=find('flow-motion').checked;
    svg.classList.toggle('motion-paused',!running);
    if(running)svg.unpauseAnimations?.();else svg.pauseAnimations?.();
  }
  function highlight(){
    const touching=layout.edges.filter(e=>e.from===selected||e.to===selected);
    const connected=new Set([selected,...touching.flatMap(e=>[e.from,e.to])]);
    svg.querySelectorAll('[data-memory-node]').forEach(el=>{
      el.classList.toggle('selected',el.dataset.memoryNode===selected);
      el.classList.toggle('muted',!!selected&&!connected.has(el.dataset.memoryNode));
    });
    svg.querySelectorAll('[data-memory-edge]').forEach(el=>{
      const edge=flow.edges[Number(el.dataset.memoryEdge)],active=edge.from===selected||edge.to===selected;
      el.classList.toggle('emphasized',!!selected&&active);el.classList.toggle('muted',!!selected&&!active);
    });
    const inbound=touching.filter(e=>e.to===selected).length,outbound=touching.filter(e=>e.from===selected).length;
    find('flow-selection').textContent=selected?names.get(selected)+' · 当前显示流入 '+inbound+' 条 / 流出 '+outbound+' 条 · 相邻关系已突出':
      '单击节点可突出相邻连线；右键节点可隐藏该流程。';
    find('flow-hide').disabled=!selected;find('flow-clear-selection').disabled=!selected;
    find('flow-locate').value=selected??'';
  }
  function select(id){selected=id;highlight();}
  function render(center){
    closeMenu();
    layout=layoutFlow(visibleFlow(flow,settings));
    if(selected&&!layout.nodes.some(n=>n.id===selected))selected=null;
    svg.setAttribute('viewBox','0 0 '+layout.width+' '+layout.height);
    svg.innerHTML=layout.columns.map(c=>'<text class="memory-heading" x="'+c.x+'" y="25">'+(c.level===0?'查询点位 / 同层关系':c.level<0?'上游 '+(-c.level)+' 层':'下游 '+c.level+' 层')+'</text>').join('')+
      layout.edges.map((e,i)=>{
        const kind=isCondition(e)?'条件影响':'数值 / 参数';
        const title=names.get(e.from)+' → '+names.get(e.to)+' · '+kind+' · 点击查看指令证据';
        const length=e.points.slice(1).reduce((sum,p,j)=>sum+Math.abs(p.x-e.points[j].x)+Math.abs(p.y-e.points[j].y),0);
        const duration=Math.max(2,Math.min(12,length/100));
        return '<g class="memory-edge '+(isCondition(e)?'condition-link':'value-link')+'" data-memory-edge="'+e.index+'" role="button" tabindex="0" aria-label="'+escape(title)+'"><title>'+escape(title)+'</title>'+
          '<path class="edge-hit" d="'+e.path+'"/><path class="edge-line" d="'+e.path+'"/>'+
          '<circle class="flow-particle" r="3"><animateMotion dur="'+duration+'s" begin="-'+(i%7)/7*duration+'s" repeatCount="indefinite" path="'+e.path+'"/></circle></g>';
      }).join('')+
      layout.nodes.map(n=>{
        const status=n.boundary?'达到追踪边界':n.sourceState==='unresolved'?'来源未解析':n.kind==='constant'?'常量':n.kind==='input'?'外部输入':n.kind==='parameter'?'调用参数':'内部数据';
        return '<g class="memory-node '+(n.id===flow.focus?'focus ':'')+(n.sourceState==='unresolved'?'unresolved':'')+'" data-memory-node="'+escape(n.id)+'" transform="translate('+n.x+','+n.y+')" tabindex="0" role="button" aria-label="'+escape(n.label)+'，'+status+'，按菜单键或右键可隐藏"><title>'+escape(n.label)+' · '+status+'</title><rect width="'+n.width+'" height="'+n.height+'" rx="9"/>'+
          linesFor(n.label).map((line,i)=>'<text x="12" y="'+(23+i*17)+'">'+escape(line)+'</text>').join('')+'<text class="memory-status" x="12" y="64">'+status+'</text></g>';
      }).join('');
    find('flow-locate').innerHTML='<option value="">选择节点…</option>'+layout.nodes.map(n=>'<option value="'+escape(n.id)+'">'+escape(n.label)+'</option>').join('');
    find('point-flow-visible').textContent='当前显示 '+layout.nodes.length+' / '+flow.nodes.length+' 个节点 · '+layout.edges.length+' 条连线'+(settings.anchor?' · 一跳关系':'');
    find('flow-hidden-count').textContent=settings.hidden.size?'手动隐藏 '+settings.hidden.size+' 个节点':'';
    find('flow-undo').disabled=!undo.length;find('flow-restore').disabled=!settings.hidden.size;
    find('flow-neighborhood').setAttribute('aria-pressed',String(!!settings.anchor));
    find('flow-neighborhood').textContent=settings.anchor?'退出一跳关系':'只看选中节点一跳关系';
    root.querySelector('.flow-empty').hidden=!!layout.nodes.length;
    applyZoom(zoom,center);highlight();animate();
  }
  function hide(id){
    if(!id||settings.hidden.has(id))return;
    undo.push({id,anchor:settings.anchor,selected});
    settings.hidden.add(id);if(settings.anchor===id)settings.anchor=null;
    if(selected===id)selected=null;
    render(flow.focus);
  }
  function neighborhood(id){settings.anchor=settings.anchor===id?null:id;selected=id;render(id);}
  function openMenu(id,x,y){
    select(id);menuNode=id;menu.hidden=false;find('flow-context-name').textContent=names.get(id);
    const box=root.getBoundingClientRect();
    menu.style.left=Math.max(0,Math.min(x-box.left,box.width-menu.offsetWidth))+'px';
    menu.style.top=Math.max(0,Math.min(y-box.top,box.height-menu.offsetHeight))+'px';
    menu.querySelector('button').focus();
  }
  on(find('show-solid-flow'),'change',()=>{settings.solid=find('show-solid-flow').checked;render(selected||flow.focus);});
  on(find('show-condition-flow'),'change',()=>{settings.condition=find('show-condition-flow').checked;render(selected||flow.focus);});
  on(find('flow-compact'),'change',()=>{settings.compact=find('flow-compact').checked;render(selected||flow.focus);});
  find('flow-motion').checked=!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  on(find('flow-motion'),'change',animate);
  on(find('flow-locate'),'change',()=>{const id=find('flow-locate').value;select(id||null);if(id)centerNode(id);});
  on(find('flow-neighborhood'),'click',()=>{if(settings.anchor){settings.anchor=null;render(selected||flow.focus);}else neighborhood(selected||flow.focus);});
  on(find('flow-clear-selection'),'click',()=>{selected=null;highlight();});
  on(find('flow-hide'),'click',()=>hide(selected));
  on(find('flow-undo'),'click',()=>{const last=undo.pop();if(last){settings.hidden.delete(last.id);settings.anchor=last.anchor;selected=last.selected;render(last.id);}});
  on(find('flow-restore'),'click',()=>{settings.hidden.clear();undo.length=0;render(selected||flow.focus);});
  on(find('flow-zoom-in'),'click',()=>applyZoom(zoom*1.2));
  on(find('flow-zoom-out'),'click',()=>applyZoom(zoom/1.2));
  on(find('flow-fit'),'click',()=>{applyZoom(Math.min((viewport.clientWidth-24)/layout.width,(viewport.clientHeight-24)/layout.height,1));viewport.scrollTop=0;viewport.scrollLeft=0;});
  on(find('flow-center'),'click',()=>{settings.hidden.delete(flow.focus);settings.anchor=null;selected=flow.focus;render(flow.focus);});
  function expand(value){root.classList.toggle('expanded',value);find('flow-expand').textContent=value?'收起大图':'展开大图';find('flow-expand').setAttribute('aria-pressed',String(value));centerNode(selected||flow.focus);}
  on(find('flow-expand'),'click',()=>expand(!root.classList.contains('expanded')));
  on(svg,'click',event=>{
    const node=event.target.closest('[data-memory-node]'),edge=event.target.closest('[data-memory-edge]');
    if(node)select(node.dataset.memoryNode);
    else if(edge)showEvidence(flow.edges[Number(edge.dataset.memoryEdge)].evidence);
    else{selected=null;highlight();}
  });
  on(svg,'contextmenu',event=>{const node=event.target.closest('[data-memory-node]');if(node){event.preventDefault();openMenu(node.dataset.memoryNode,event.clientX,event.clientY);}});
  on(svg,'keydown',event=>{
    const node=event.target.closest('[data-memory-node]'),edge=event.target.closest('[data-memory-edge]');
    if(node&&(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))){event.preventDefault();const b=node.getBoundingClientRect();openMenu(node.dataset.memoryNode,b.left,b.bottom);}
    else if(event.key==='Enter'||event.key===' '){if(node||edge){event.preventDefault();if(node)select(node.dataset.memoryNode);else showEvidence(flow.edges[Number(edge.dataset.memoryEdge)].evidence);}}
    else if(node&&event.key==='Delete'){event.preventDefault();hide(node.dataset.memoryNode);}
  });
  on(menu,'click',event=>{const action=event.target.closest('[data-action]')?.dataset.action,id=menuNode;if(action==='hide')hide(id);else if(action==='neighbors')neighborhood(id);closeMenu();viewport.focus();});
  on(menu,'keydown',event=>{if(!['ArrowDown','ArrowUp'].includes(event.key))return;event.preventDefault();const buttons=[...menu.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);buttons[(i+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();});
  on(document,'pointerdown',event=>{if(!menu.hidden&&!menu.contains(event.target))closeMenu();});
  on(document,'keydown',event=>{if(event.key!=='Escape'||document.querySelector('dialog[open]'))return;if(!menu.hidden){closeMenu();viewport.focus();}else if(root.classList.contains('expanded'))expand(false);else if(settings.anchor){settings.anchor=null;render(selected||flow.focus);}else{selected=null;highlight();}});
  render(flow.focus);
}