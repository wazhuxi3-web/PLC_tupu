const valueKinds = new Set(['data-transfer','parameter-in','parameter-out','argument-preparation']);
export const isCondition = edge => !valueKinds.has(edge.kind);

export function visibleFlow(flow, {hidden = new Set(), solid = true, condition = true, anchor = null, compact = true} = {}) {
  let edges = [...new Map(flow.edges.map((e,index) => [JSON.stringify([e.from,e.to,e.kind]), {...e,index}])).values()]
    .filter(e => !hidden.has(e.from) && !hidden.has(e.to) && (isCondition(e) ? condition : solid));
  let allowed = null;
  if (anchor) {
    allowed = new Set([anchor]);
    for (const e of edges) if (e.from === anchor || e.to === anchor) { allowed.add(e.from); allowed.add(e.to); }
    edges = edges.filter(e => e.from === anchor || e.to === anchor);
  }
  const connected = new Set(edges.flatMap(e => [e.from,e.to]));
  const nodes = flow.nodes.filter(n => !hidden.has(n.id) && (!allowed || allowed.has(n.id)) &&
    (!compact || connected.has(n.id) || n.id === (anchor || flow.focus)));
  return {nodes,edges,focus:flow.focus};
}

// All boxes occupy common rows. Vertical lanes live only between columns;
// long/backward/self edges cross columns only in dedicated spaces between rows.
export function layoutFlow(graph) {
  const nodeWidth = 232, nodeHeight = 76;
  if (!graph.nodes.length) return {nodes:[],edges:[],columns:[],width:700,height:300};
  const levels = [...new Set(graph.nodes.map(n => n.level ?? 0))].sort((a,b) => a-b);
  const groups = levels.map(level => graph.nodes.filter(n => (n.level ?? 0) === level));
  const neighbors = new Map(graph.nodes.map(n => [n.id,[]]));
  for (const e of graph.edges) { neighbors.get(e.from)?.push(e.to); neighbors.get(e.to)?.push(e.from); }
  // Barycentric sweeps reduce crossings while preserving stable order for ties.
  for (let sweep=0;sweep<6;sweep++) {
    const rank = new Map(groups.flatMap(g => g.map((n,i) => [n.id,i+(Math.max(...groups.map(x=>x.length))-g.length)/2])));
    for (const g of (sweep%2 ? [...groups].reverse() : groups)) {
      const score = n => {
        const values = neighbors.get(n.id).filter(id => !g.some(other => other.id===id)).map(id => rank.get(id));
        return values.length ? values.reduce((a,b)=>a+b,0)/values.length : rank.get(n.id);
      };
      g.sort((a,b) => score(a)-score(b));
    }
  }
  const rows = Math.max(...groups.map(g=>g.length));
  const slots = new Map();
  groups.forEach((g,col)=>g.forEach((n,i)=>slots.set(n.id,{col,row:i+Math.floor((rows-g.length)/2)})));
  const lanes = Array.from({length:groups.length+1},()=>[]);
  const rowLanes = Array.from({length:rows},()=>[]);
  const routes = graph.edges.filter(e=>slots.has(e.from)&&slots.has(e.to)).map((e,i)=>{
    const a=slots.get(e.from),b=slots.get(e.to),direct=b.col===a.col+1;
    const r={...e,key:i,a,b,direct};
    lanes[a.col+1].push({route:r,side:'source'});
    if(!direct) { lanes[b.col].push({route:r,side:'target'}); rowLanes[a.row].push(r); }
    return r;
  });
  const gapWidths=lanes.map(l=>Math.max(64,32+l.length*7));
  const rowGaps=rowLanes.map(l=>Math.max(52,26+l.length*6));
  const xs=[],ys=[];
  let width=gapWidths[0]+20;
  for(let col=0;col<groups.length;col++){xs[col]=width;width+=nodeWidth+gapWidths[col+1];}
  let height=48;
  for(let row=0;row<rows;row++){ys[row]=height;height+=nodeHeight+rowGaps[row];}
  lanes.forEach((lane,gap)=>{
    lane.sort((a,b)=>(a.route.a.row+a.route.b.row)-(b.route.a.row+b.route.b.row));
    const left=gap===0?20:xs[gap-1]+nodeWidth;
    lane.forEach((item,i)=>item.route[item.side+'X']=left+16+i*7);
  });
  rowLanes.forEach((lane,row)=>lane.forEach((r,i)=>r.crossY=ys[row]+nodeHeight+14+i*6));
  const outgoing=new Map(),incoming=new Map();
  for(const r of routes) {
    if(!outgoing.has(r.from))outgoing.set(r.from,[]);
    if(!incoming.has(r.to))incoming.set(r.to,[]);
    outgoing.get(r.from).push(r);incoming.get(r.to).push(r);
  }
  for(const list of outgoing.values())list.sort((a,b)=>a.b.row-b.b.row).forEach((r,i)=>r.sourceY=ys[r.a.row]+14+(i+1)*48/(list.length+1));
  for(const list of incoming.values())list.sort((a,b)=>a.a.row-b.a.row).forEach((r,i)=>r.targetY=ys[r.b.row]+14+(i+1)*48/(list.length+1));
  const edges=routes.map(r=>{
    const start={x:xs[r.a.col]+nodeWidth,y:r.sourceY},end={x:xs[r.b.col],y:r.targetY};
    const points=r.direct?[start,{x:r.sourceX,y:start.y},{x:r.sourceX,y:end.y},end]:
      [start,{x:r.sourceX,y:start.y},{x:r.sourceX,y:r.crossY},{x:r.targetX,y:r.crossY},{x:r.targetX,y:end.y},end];
    return {...r,points,path:points.map((p,i)=>(i?'L':'M')+p.x+','+p.y).join(' ')};
  });
  return {width:width+20,height:height+20,columns:levels.map((level,col)=>({level,x:xs[col]})),
    nodes:graph.nodes.map(n=>({...n,...slots.get(n.id),x:xs[slots.get(n.id).col],y:ys[slots.get(n.id).row],width:nodeWidth,height:nodeHeight})),edges};
}