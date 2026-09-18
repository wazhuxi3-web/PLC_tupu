import {normalizeOperand} from './analysis.mjs';

const globalAddress=/^(?:(?:I|Q|M|PI|PQ)[BWD]?\d+(?:\.[0-7])?|DB\d+\.(?:DBX\d+\.[0-7]|DB[BWD]\d+)|[TC]\d+)$/;
const localAddress=/^(?:#[\w.\[\]]+|L[BWD]?\d+(?:\.[0-7])?)$/;
const binary=/^(?:[+*/-][IDR]|MOD|AW|OW|XOW|AD|OD|XOD)$/;
const compare=/^(?:==|<>|>=|<=|>|<)[IDR]$/;
const unary=/^(?:ITD|DTR|RND|RND\+|RND-|TRUNC|NEGI|NEGD|NEGR|INVI|INVD|ABS|SQR|SQRT)$/;
const merge=(...values)=>[...new Map(values.flat().filter(Boolean).map(v=>[`${v.operand}:${v.readRow}`,v])).values()];
const local=value=>localAddress.test(value);
const constant=value=>/^(?:[-+]?\d|[BLDW]#|S5T#|T#|C#|TRUE$|FALSE$|')/i.test(value);

/** Potential data/control dependencies inside straight-line instruction segments.
 * Control transfers and unknown operations discard state; no path feasibility is claimed.
 */
export function analyzeMemoryBlock(block){
  const assignments=[],diagnostics=[],calls=new Map();let acc=[],rlo=null,stack=[],locals=new Map(),network=-1,afterWrite=false;
  const reset=()=>{acc=[];rlo=null;stack=[];locals=new Map();afterWrite=false;};
  const read=row=>{const operand=normalizeOperand(row.operand);if(local(operand)&&locals.has(operand))return locals.get(operand);if(globalAddress.test(operand)||local(operand))return [{operand,readRow:row.index}];if(constant(operand))return [{operand:'constant:'+row.operand.trim(),readRow:row.index}];return null;};
  const write=(row,deps,kind)=>{const target=normalizeOperand(row.operand);if(!(globalAddress.test(target)||local(target))||deps===null)return;const item={target,dependencies:deps,kind,blockId:block.id,network:row.network,row:row.index};assignments.push(item);if(local(target))locals.set(target,deps);};
  for(const row of block.rows){
    if(row.network!==network){reset();network=row.network;}
    if(row.label)reset();
    const cmd=row.command;
    if(['NETWORK','NOP','BLD','SAVE',''].includes(cmd))continue;
    if(/^(?:J|LOOP|BE)/.test(cmd)){diagnostics.push({blockId:block.id,network,row:row.index,code:'CONTROL_BOUNDARY',message:'控制转移处停止合并状态；附近赋值仅表示条件性潜在传递。'});reset();continue;}
    if(cmd==='CALL'||cmd==='UC'){calls.set(row.index,new Map(locals));reset();continue;}
    if(cmd==='L'){const deps=read(row);acc=[deps,...acc].slice(0,2);continue;}
    if(cmd==='T'){write(row,acc.length?acc[0]:null,'data-transfer');continue;}
    if(binary.test(cmd)){acc=[acc.length===2&&acc.every(v=>v!==null)?merge(...acc):null];continue;}
    if(unary.test(cmd)){continue;}
    if(cmd==='TAK'){if(acc.length===2)acc.reverse();else acc=[];continue;}
    if(compare.test(cmd)){
      const deps=acc.length===2&&acc.every(v=>v!==null)?merge(...acc):null;
      if(afterWrite){rlo=null;afterWrite=false;}
      rlo=deps===null?null:merge(rlo??[],deps);continue;
    }
    if(['A(','AN(','O(','ON(','X(','XN('].includes(cmd)){stack.push(afterWrite?null:rlo);rlo=null;afterWrite=false;continue;}
    if(cmd===')'){if(!stack.length){rlo=null;continue;}const before=stack.pop();rlo=rlo===null?null:merge(before??[],rlo);afterWrite=false;continue;}
    if(['A','AN','O','ON','X','XN'].includes(cmd)){
      if(!row.operand&&cmd==='O')continue;
      const deps=read(row);if(afterWrite){rlo=null;afterWrite=false;}
      rlo=deps===null?null:merge(rlo??[],deps);continue;
    }
    if(cmd==='SET'||cmd==='CLR'){rlo=[{operand:'constant:'+(cmd==='SET'?'TRUE':'FALSE'),readRow:row.index}];afterWrite=false;continue;}
    if(cmd==='NOT')continue;
    if(['=','S','R'].includes(cmd)){write(row,rlo,'control-dependency');afterWrite=true;continue;}
    if(['SD','SE','SS','SF','SP'].includes(cmd)){
      write(row,rlo===null?null:merge(rlo,acc[0]??[]),'timer-dependency');continue;
    }
    if(cmd==='FP'||cmd==='FN'){if(rlo!==null)rlo=merge(rlo,read(row)??[]);continue;}
    diagnostics.push({blockId:block.id,network,row:row.index,code:'UNKNOWN_INSTRUCTION',message:`${cmd} ${row.operand} 的状态影响未支持，停止当前段推导。`});reset();
  }
  return {assignments,calls,diagnostics};
}

export function buildMemoryGraph(project,programId,getBlock){
  const program=project.programs.find(p=>p.id===programId),nodes=new Map(),edges=[],edgeKeys=new Set(),analyses=new Map(),diagnostics=[];
  const aliases=new Map(program.symbols.map(s=>[normalizeOperand(s.operand),s.name]));
  const scopedCalls=project.calls.filter(c=>c.programId===programId),called=new Set(scopedCalls.map(c=>c.target));
  const callById=new Map(scopedCalls.map(c=>[c.id,c]));
  const blocks=project.blocks.filter(b=>b.programId===programId&&b.status==='parsed');
  for(const summary of blocks){const block=getBlock(summary.id);if(block){const analysis=analyzeMemoryBlock(block);analyses.set(summary.id,analysis);diagnostics.push(...analysis.diagnostics);}}
  const node=(operand,scope)=>{
    const global=globalAddress.test(operand),isConstant=operand.startsWith('constant:');
    const id=global?'memory:'+operand:isConstant?operand:`${scope}:${operand}`;
    const call=callById.get(scope.split(':')[0]);
    const scopeLabel=call?(scope.includes(':actual')?call.caller.split('--').at(-1):call.targetName):scope.split('--').at(-1).split(':')[0];
    if(!nodes.has(id))nodes.set(id,{id,operand:global?operand:undefined,label:global?(aliases.has(operand)?`${aliases.get(operand)} · ${operand}`:operand):isConstant?operand.slice(9):`${scopeLabel} / ${operand}`,kind:global?(/^(?:I|PI)/.test(operand)?'input':'memory'):isConstant?'constant':operand.startsWith('#')?'parameter':'unresolved-local'});
    return id;
  };
  const edge=(from,to,kind,evidence)=>{
    const key=[from,to,kind,evidence.blockId,evidence.row,evidence.readRow].join('|');
    if(edgeKeys.has(key))return;edgeKeys.add(key);edges.push({id:'m'+edges.length,from,to,kind,evidence});
  };
  const addAssignments=(blockId,scope,callId,onlyGlobal=false)=>{
    for(const a of analyses.get(blockId)?.assignments??[]){
      if(onlyGlobal&&!globalAddress.test(a.target))continue;
      // A temporary version is distinct at each write; dependencies were substituted while decoding.
      const target=node(a.target,/^L/.test(a.target)?`${scope}:write${a.row}`:scope);
      for(const dep of a.dependencies)edge(node(dep.operand,scope),target,a.kind,{blockId,network:a.network,row:a.row,readRow:dep.readRow,...(callId?{callId}:{})});
    }
  };
  for(const b of blocks){
    // Callable blocks with formal inputs are instantiated below; global-only relationships remain useful without a caller.
    if(!called.has(b.id))addAssignments(b.id,b.id,null,true);
    else for(const a of analyses.get(b.id)?.assignments??[]){
      if(!globalAddress.test(a.target)||a.dependencies.some(d=>local(d.operand)))continue;
      for(const dep of a.dependencies)edge(node(dep.operand,b.id),node(a.target,b.id),a.kind,{blockId:b.id,network:a.network,row:a.row,readRow:dep.readRow});
    }
  }
  for(const call of scopedCalls){
    const analysis=analyses.get(call.caller),defs=analysis?.calls.get(call.row)??new Map(),scope=call.id;
    for(const p of call.parameters){
      const value=normalizeOperand(p.value),evidence={blockId:call.caller,network:call.network,row:call.row,parameter:p.name,callId:call.id};
      if(!(globalAddress.test(value)||local(value)||constant(value)))continue;
      const actual=node(constant(value)?'constant:'+p.value:value,`${call.id}:actual`),formal=node('#'+p.name,scope);
      if(p.direction==='IN'||p.direction==='IN_OUT'){
        edge(actual,formal,'parameter-in',evidence);
        if(local(value)&&defs.has(value))for(const dep of defs.get(value))edge(node(dep.operand,call.caller),actual,'argument-preparation',{...evidence,readRow:dep.readRow});
      }
      if(p.direction==='OUT'||p.direction==='IN_OUT')edge(formal,actual,'parameter-out',evidence);
    }
    addAssignments(call.target,scope,call.id);
  }
  return {nodes:[...nodes.values()],edges,diagnostics,semantics:'数据赋值与条件影响的静态潜在关系；控制跳转处分段，不证明路径可执行。调用形参按调用点隔离，未完整展开嵌套调用实例。'};
}

export function sliceMemoryGraph(graph,operand,{maxDepth=6,maxNodes=90,maxEdges=240}={}){
  const focus='memory:'+operand,byId=new Map(graph.nodes.map(n=>[n.id,n]));
  if(!byId.has(focus))byId.set(focus,{id:focus,operand,label:operand,kind:'memory'});
  const selected=new Set([focus]),levels=new Map([[focus,0]]),cuts=new Set(),incoming=new Map(),outgoing=new Map();
  for(const edge of graph.edges){if(!incoming.has(edge.to))incoming.set(edge.to,[]);incoming.get(edge.to).push(edge);if(!outgoing.has(edge.from))outgoing.set(edge.from,[]);outgoing.get(edge.from).push(edge);}
  for(const direction of [-1,1]){
    const queue=[[focus,0]],visited=new Set([focus]);
    while(queue.length){const [id,depth]=queue.shift();for(const edge of (direction===-1?incoming:outgoing).get(id)??[]){
      const next=direction===-1?edge.from:edge.to;if(visited.has(next))continue;
      if(depth>=maxDepth||(!selected.has(next)&&selected.size>=maxNodes)){cuts.add(id);continue;}
      selected.add(next);visited.add(next);if(!levels.has(next))levels.set(next,(depth+1)*direction);queue.push([next,depth+1]);
    }}
  }
  const visible=graph.edges.filter(e=>selected.has(e.from)&&selected.has(e.to));
  const sourceState=id=>byId.get(id).kind==='constant'?'constant':byId.get(id).kind==='input'?'external-input':(incoming.get(id)?.length?'internal':'unresolved');
  const nodes=[...selected].map(id=>({...byId.get(id),level:levels.get(id),boundary:cuts.has(id),sourceState:sourceState(id)}));
  const active=new Set(),finished=new Set();
  const cyclic=id=>{if(active.has(id))return true;if(finished.has(id))return false;active.add(id);for(const edge of outgoing.get(id)??[])if(selected.has(edge.to)&&cyclic(edge.to))return true;active.delete(id);finished.add(id);return false;};
  const hasCycle=[...selected].some(cyclic);
  return {focus,nodes,edges:visible.slice(0,maxEdges),truncated:cuts.size>0||visible.length>maxEdges,limits:{maxDepth,maxNodes,maxEdges},
    hasCycle,
    sourceStatus:incoming.get(focus)?.length?'potential-writers-found':'no-mapped-writer',
    sources:nodes.filter(n=>n.id!==focus&&n.level<0&&(n.sourceState==='constant'||n.sourceState==='external-input'||n.sourceState==='unresolved'||n.boundary)).map(n=>n.id),
    diagnostics:graph.diagnostics.filter(d=>visible.some(e=>e.evidence.blockId===d.blockId&&e.evidence.network===d.network)).slice(0,100),semantics:graph.semantics};
}
