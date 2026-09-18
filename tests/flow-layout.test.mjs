import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {layoutFlow,visibleFlow} from '../web/flow-layout.js';
import {tracePoint} from '../src/point-report.mjs';

function verifyRoutes(graph){
  const layout=layoutFlow(graph);
  for(const edge of layout.edges){
    assert.ok(edge.points.length>=4);
    const from=layout.nodes.find(n=>n.id===edge.from),to=layout.nodes.find(n=>n.id===edge.to);
    assert.equal(edge.points[0].x,from.x+from.width);
    assert.equal(edge.points.at(-1).x,to.x);
    for(let i=1;i<edge.points.length;i++){
      const a=edge.points[i-1],b=edge.points[i];
      assert.ok(a.x===b.x||a.y===b.y,'Every route segment must be orthogonal');
      for(const n of layout.nodes){
        const crosses=a.x===b.x?
          a.x>n.x&&a.x<n.x+n.width&&Math.max(a.y,b.y)>n.y&&Math.min(a.y,b.y)<n.y+n.height:
          a.y>n.y&&a.y<n.y+n.height&&Math.max(a.x,b.x)>n.x&&Math.min(a.x,b.x)<n.x+n.width;
        assert.equal(crosses,false,edge.from+' → '+edge.to+' crosses '+n.id);
      }
    }
  }
  assert.equal(layout.edges.length,graph.edges.length);
  return layout;
}
const nodes=Array.from({length:18},(_,i)=>({id:'n'+i,label:'节点'+i,level:Math.floor(i/6)-1}));
const pairs=[[0,0],[0,1],[1,0],[0,17],[17,0],[6,11],[11,6],[7,13],[2,12],[13,7],[16,3],[3,16]];
const edges=pairs.map(([a,b],index)=>({from:'n'+a,to:'n'+b,kind:index%2?'control-dependency':'data-transfer'}));
const graph={nodes,edges,focus:'n7'};

test('routing avoids all boxes for forward, skipped-level, backward, same-column and self edges',()=>{
  const result=verifyRoutes(graph);
  assert.deepEqual(result,layoutFlow(graph),'Repeated layouts must be stable');
});
test('dense directed graphs never route through boxes after filtering or hiding',()=>{
  for(let seed=1;seed<=12;seed++){
    const dense={...graph,edges:Array.from({length:140},(_,i)=>({from:'n'+((i*7+seed)%18),to:'n'+((i*11+Math.floor(i/18)+seed)%18),kind:i%3?'control-dependency':'data-transfer'}))};
    verifyRoutes(visibleFlow(dense));
    verifyRoutes(visibleFlow(dense,{hidden:new Set(['n0','n8']),condition:false}));
  }
});
test('node hiding removes every incident edge, filtering and neighborhoods preserve evidence indices',()=>{
  const source={...graph,edges:[...edges,{...edges[0]}]};
  const filtered=visibleFlow(source,{hidden:new Set(['n0']),compact:false});
  assert.ok(filtered.nodes.every(n=>n.id!=='n0'));
  assert.ok(filtered.edges.every(e=>e.from!=='n0'&&e.to!=='n0'));
  for(const e of filtered.edges)assert.deepEqual(source.edges[e.index],{from:e.from,to:e.to,kind:e.kind});
  const one=visibleFlow(source,{anchor:'n7'});
  assert.ok(one.edges.every(e=>e.from==='n7'||e.to==='n7'));
  const none=visibleFlow(source,{solid:false,condition:false});
  assert.deepEqual(none.nodes.map(n=>n.id),['n7']);assert.equal(none.edges.length,0);
  assert.equal(visibleFlow(source,{solid:false,condition:false,hidden:new Set(['n7'])}).nodes.length,0);
  assert.deepEqual(visibleFlow(source).nodes,visibleFlow(source,{hidden:new Set()}).nodes);
});
test('empty graph and a graph with one isolated node remain renderable',()=>{
  verifyRoutes({nodes:[],edges:[]});
  verifyRoutes({nodes:[nodes[0]],edges:[]});
});
const pointer=new URL('../data/current.json',import.meta.url);
test('actual MW17 and M145.0 topologies avoid node boxes in both line modes',{skip:!fs.existsSync(pointer)},()=>{
  const c=JSON.parse(fs.readFileSync(pointer)),base=new URL('../data/imports/'+c.importId+'/',import.meta.url);
  const project=JSON.parse(fs.readFileSync(new URL('project.json',base)));
  if(project.projectId!=='l0226d02')return;
  const cache=new Map(),get=id=>{
    if(!project.blocks.some(b=>b.id===id&&b.status==='parsed'))return null;
    if(!cache.has(id))cache.set(id,JSON.parse(fs.readFileSync(new URL('blocks/'+id+'.json',base))));
    return cache.get(id);
  };
  for(const point of ['MW17','M145.0']){
    const flow=tracePoint(project,'p-ombstx-offline-0000000E',point,get).flow;
    for(const settings of [{},{condition:false},{solid:false},{anchor:flow.focus},{hidden:new Set([flow.focus])}]){
      verifyRoutes(visibleFlow(flow,settings));
    }
  }
});