// Conservative, explicitly bounded static analysis. No PLC execution or write operations.
export function normalizeOperand(value = '') {
  let operand = value.trim();
  if (operand.startsWith('"') || operand.startsWith('#')) return operand;
  operand = operand.replace(/\s+/g, '').toUpperCase();
  return operand.replace(/^(PE|PA|E|A|Z)(?=[BWD]?\d)/, x => ({PE:'PI',PA:'PQ',E:'I',A:'Q',Z:'C'}[x]));
}
export const isLocal = value => /^(?:#|L(?:[BWD]?\d))/.test(normalizeOperand(value));
const supported = new Set(['NETWORK','A','AN','O','ON','X','XN','A(','AN(','O(','ON(','X(','XN(',')','=','NOT','SET','CLR','BLD','NOP','CALL','UC']);
const simpleBit = operand => /^(?:#[\w.]+|(?:I|Q|M|L)\d+\.[0-7]|DB\d+\.DBX\d+\.[0-7])$/i.test(normalizeOperand(operand));
const union = (...sets) => new Map(sets.flatMap(s => [...s.entries()]));

/** Analyze only fully supported straight-line Boolean networks. Each dependency retains read/write evidence. */
export function analyzeBooleanBlock(block) {
  const networks = new Map();
  for (const row of block.rows) { if (!networks.has(row.network)) networks.set(row.network, []); networks.get(row.network).push(row); }
  const assignments = [], calls = new Map(), diagnostics = [];
  for (const [network, rows] of networks) {
    const invalid = rows.find(r => !supported.has(r.command) || r.label ||
      ((['A','AN','O','ON','X','XN','='].includes(r.command) && r.operand) && !simpleBit(r.operand)));
    if (invalid) {
      diagnostics.push({code:'UNSUPPORTED_NETWORK',blockId:block.id,network,row:invalid.index,message:`该网络未作布尔依赖推导：${invalid.command} ${invalid.operand}`}); continue;
    }
    let rlo=new Map(), fresh=true, stack=[], locals=new Map(), valid=true;
    const staged=[], stagedCalls=[];
    for (const row of rows) {
      const cmd=row.command, operand=normalizeOperand(row.operand);
      if (['NETWORK','BLD','NOP'].includes(cmd)) continue;
      if (cmd.endsWith('(')) { stack.push(fresh ? new Map() : rlo); rlo=new Map(); fresh=true; continue; }
      if (cmd===')') { if (!stack.length) {valid=false;break;} rlo=union(stack.pop(),rlo);fresh=false;continue; }
      if (cmd==='SET'||cmd==='CLR') { rlo=new Map();fresh=false;continue; }
      if (cmd==='NOT') { if(fresh) {valid=false;break;} continue; }
      if (cmd==='CALL'||cmd==='UC') {
        if(stack.length){valid=false;break;}
        stagedCalls.push([row.index,new Map(locals)]);
        // Unknown call side effects invalidate local substitutions beyond this boundary.
        locals=new Map(); rlo=new Map();fresh=true;continue;
      }
      if (cmd==='=') {
        if(fresh===true || stack.length){valid=false;break;}
        const deps=[...rlo.values()]; staged.push({target:operand,dependencies:deps,network,row:row.index,blockId:block.id});
        if(isLocal(operand)) locals.set(operand,{dependencies:deps,writeRow:row.index});
        // An immediate next '=' retains the RLO; a subsequent Boolean operand starts a new chain.
        fresh='after-write';continue;
      }
      if (!operand) { if(cmd!=='O'){valid=false;break;} continue; }
      if (fresh) rlo=new Map();
      const local=locals.get(operand);
      const deps=local?.dependencies ?? [{operand,readRow:row.index,negated:cmd.endsWith('N')}];
      rlo=union(rlo,new Map(deps.map(d=>[`${d.operand}:${d.readRow}`,d]))); fresh=false;
    }
    if (!valid || stack.length) { diagnostics.push({code:'INVALID_BOOLEAN_STATE',blockId:block.id,network,message:'未能可靠还原该网络的逻辑状态。'});continue; }
    assignments.push(...staged); for(const [row,values] of stagedCalls)calls.set(row,values);
  }
  return {assignments,calls,diagnostics,totalNetworks:networks.size,analyzedNetworks:networks.size-new Set(diagnostics.map(d=>d.network)).size};
}

export function buildCallGraph(project, programId, focus, limit=160) {
  let calls=project.calls.filter(c=>c.programId===programId && (!focus||c.caller===focus||c.target===focus));
  const total=calls.length; calls=calls.slice(0,limit);
  const ids=new Set(calls.flatMap(c=>[c.caller,c.target]));if(focus)ids.add(focus);
  const byId=new Map(project.blocks.map(b=>[b.id,b]));
  return {nodes:[...ids].map(id=>byId.get(id)??{id,name:id.split('--').at(-1),status:'unresolved'}),edges:calls,total,truncated:total>limit};
}

export function buildParameterGraph(call, caller, callee, symbols=[]) {
  const callerAnalysis=analyzeBooleanBlock(caller), calleeAnalysis=callee?analyzeBooleanBlock(callee):null;
  const definitions=callerAnalysis.calls.get(call.row)??new Map();
  const aliases=new Map(symbols.map(s=>[normalizeOperand(s.operand),s.name]));
  const nodes=new Map(),edges=[],warnings=[];
  const addNode=(key,label,column,extra={})=>{const id=`${call.id}:${key}`;nodes.set(id,{id,label,column,...extra});return id;};
  const addEdge=(from,to,kind,evidence)=>edges.push({id:`e${edges.length}`,from,to,kind,evidence});
  const label=value=>{const op=normalizeOperand(value);return aliases.has(op)?`${aliases.get(op)} · ${op}`:op;};
  const inputs=new Map(),outputs=new Map();
  for (const p of call.parameters) {
    const value=normalizeOperand(p.value);
    if(p.direction==='IN'||p.direction==='IN_OUT') {
      const actual=addNode(`in-actual:${value}`,label(value),1,{operand:value});
      const formal=addNode(`in-param:${p.name}`,`${call.targetName}.${p.name}`,2,{parameter:p.name,direction:p.direction});inputs.set(`#${p.name}`,formal);
      addEdge(actual,formal,'parameter-in',{blockId:caller.id,row:call.row,network:call.network,parameter:p.name});
      const definition=definitions.get(value);
      if(definition) for(const dep of definition.dependencies) {
        const src=addNode(`source:${dep.operand}`,label(dep.operand),0,{operand:dep.operand});
        addEdge(src,actual,'boolean-preparation',{blockId:caller.id,row:definition.writeRow,readRow:dep.readRow,network:call.network});
      }
      else if(isLocal(value)||value.includes('[')||/^DI/.test(value))warnings.push(`实参 ${value} 的上游未解析（${p.name}）。`);
    }
    if(p.direction==='OUT'||p.direction==='IN_OUT') {
      const formal=addNode(`out-param:${p.name}`,`${call.targetName}.${p.name}`,3,{parameter:p.name,direction:p.direction});outputs.set(`#${p.name}`,formal);
      const actual=addNode(`out-actual:${value}`,label(value),4,{operand:value});
      addEdge(formal,actual,'parameter-out',{blockId:caller.id,row:call.row,network:call.network,parameter:p.name});
    }
    if(!['IN','OUT','IN_OUT'].includes(p.direction))warnings.push(`参数 ${p.name} 方向未识别：${p.direction}`);
  }
  if(calleeAnalysis) {
    // Only unambiguous, unique output definitions with supported input dependencies.
    const writes=new Map();
    for(const row of callee.rows)if(['=','S','R','T'].includes(row.command)){
      const op=normalizeOperand(row.operand);writes.set(op,(writes.get(op)||0)+1);
    }
    for(const assignment of calleeAnalysis.assignments) {
      const output=outputs.get(assignment.target);if(!output)continue;
      if(writes.get(assignment.target)!==1){warnings.push(`${assignment.target} 有多个写入点，未合并推导。`);continue;}
      for(const dep of assignment.dependencies) {
        const input=inputs.get(dep.operand);
        if(input)addEdge(input,output,'potential-boolean-dependency',{blockId:callee.id,row:assignment.row,readRow:dep.readRow,network:assignment.network});
        else warnings.push(`输出 ${assignment.target} 还依赖未映射的 ${dep.operand}。`);
      }
    }
  }else warnings.push('被调用块未解析，仅展示调用实参绑定。');
  if(!call.parameters.length)warnings.push('此调用没有已还原的参数绑定。');
  return {call,nodes:[...nodes.values()],edges,warnings:[...new Set(warnings)],
    coverage:{caller:callerAnalysis.diagnostics,callee:calleeAnalysis?.diagnostics??[],analyzedCalleeNetworks:calleeAnalysis?.analyzedNetworks??0,totalCalleeNetworks:calleeAnalysis?.totalNetworks??0},
    semantics:'单个调用点的潜在布尔依赖；未证明当前执行条件或现场因果。不同调用点不会合并。',truncated:false};
}

export function sliceGraph(graph, focus, direction='both', maxDepth=12, maxNodes=100) {
  if(!focus)return graph;
  const starts=graph.nodes.filter(n=>n.id===focus||n.parameter===focus||n.operand===normalizeOperand(focus)).map(n=>n.id);
  if(!starts.length)return {...graph,nodes:[],edges:[],matched:false,truncated:false};
  const seen=new Set(starts);let truncated=false;
  // Traverse directions separately, so a sibling input is not reached via a common output.
  for(const dir of direction==='both'?['upstream','downstream']:[direction]) {
    let queue=starts.map(id=>[id,0]),visited=new Set(starts);
    while(queue.length) {
      const [id,depth]=queue.shift();
      for(const edge of graph.edges) {
        const next=dir==='upstream'?(edge.to===id?edge.from:null):(edge.from===id?edge.to:null);
        if(!next||visited.has(next))continue;
        if(depth>=maxDepth||(!seen.has(next)&&seen.size>=maxNodes)){truncated=true;continue;}
        seen.add(next);visited.add(next);queue.push([next,depth+1]);
      }
    }
  }
  return {...graph,nodes:graph.nodes.filter(n=>seen.has(n.id)),edges:graph.edges.filter(e=>seen.has(e.from)&&seen.has(e.to)),matched:true,truncated};
}

const readCommands=new Set(['A','AN','O','ON','X','XN','L','LC']);
const writeCommands=new Set(['=','S','R','T']);
export function findReferences(block, query) {
  const operand=normalizeOperand(query),results=[];
  for(const row of block.rows) {
    if(normalizeOperand(row.operand)===operand && (readCommands.has(row.command)||writeCommands.has(row.command))) {
      results.push({blockId:block.id,network:row.network,row:row.index,kind:readCommands.has(row.command)?'read':'write',command:row.command,operand:row.operand});
    }
    for(const p of row.parameters??[])if(normalizeOperand(p.value)===operand)results.push({blockId:block.id,network:row.network,row:row.index,kind:p.direction==='IN'?'read':p.direction==='OUT'?'write':'read-write',parameter:p.name,operand:p.value});
  }
  return results;
}
