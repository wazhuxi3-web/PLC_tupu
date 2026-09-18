import {normalizeOperand,findReferences,buildParameterGraph,sliceGraph} from './analysis.mjs';
import {buildMemoryGraph,sliceMemoryGraph} from './memory-flow.mjs';
const graphCache=new WeakMap();

/** One address, one program, one snapshot; all results remain conservative static evidence. */
export function tracePoint(project,programId,query,getBlock,{limit=40}={}){
  const program=project.programs.find(p=>p.id===programId);
  if(!program)throw Object.assign(Error('程序不存在。'),{status:404,code:'PROGRAM_NOT_FOUND'});
  query=query.trim();
  if(!query)throw Object.assign(Error('请输入完整点位地址或符号名。'),{status:400,code:'POINT_REQUIRED'});
  const symbolMatches=program.symbols.filter(s=>s.name===query);
  const operands=[...new Set(symbolMatches.map(s=>normalizeOperand(s.operand)))];
  if(operands.length>1)return {query,ambiguous:true,candidates:symbolMatches,warnings:['此符号对应多个地址，请输入具体地址后追踪。']};
  const operand=operands[0]??normalizeOperand(query);
  if(!/^(?:(?:I|Q|M|PI|PQ)(?:[BWD]?\d+)(?:\.[0-7])?|DB\d+\.(?:DBX\d+\.[0-7]|DB[BWD]\d+)|[TC]\d+)$/.test(operand))throw Object.assign(Error('未找到该符号。请输入完整地址，例如 I920.0、Q1420.0、M10.0、DB10.DBX0.0，或完整符号名。'),{status:400,code:'POINT_NOT_RESOLVED'});
  const references=[],directBlocks=[];
  for(const summary of project.blocks){
    if(summary.programId!==programId||summary.status!=='parsed')continue;
    const block=getBlock(summary.id);if(!block)continue;
    const refs=findReferences(block,operand);
    if(refs.length){references.push(...refs);directBlocks.push({...summary,reads:refs.filter(r=>r.kind!=='write').length,writes:refs.filter(r=>r.kind!=='read').length});}
  }
  const referencedBlocks=new Set(directBlocks.map(b=>b.id)),relatedCalls=[],matchedCalls=new Set();let totalCalls=0;
  for(const call of project.calls){
    if(call.programId!==programId)continue;
    if(!referencedBlocks.has(call.caller)&&!referencedBlocks.has(call.target)&&!call.parameters.some(p=>normalizeOperand(p.value)===operand))continue;
    const caller=getBlock(call.caller);if(!caller)continue;
    const graph=sliceGraph(buildParameterGraph(call,caller,getBlock(call.target),program.symbols),operand,'both');
    const globalRefs=references.filter(r=>r.blockId===call.target);
    if(!graph.nodes.length&&!globalRefs.length)continue;
    totalCalls++;matchedCalls.add(call.id);
    if(relatedCalls.length<limit)relatedCalls.push({call,relation:graph.nodes.length?'mapped-flow':'callee-direct-reference',graph,calleeReferences:globalRefs});
  }
  const scopeBlocks=project.blocks.filter(b=>b.programId===programId);
  if(!graphCache.has(project))graphCache.set(project,new Map());
  const programGraphs=graphCache.get(project);if(!programGraphs.has(programId))programGraphs.set(programId,buildMemoryGraph(project,programId,getBlock));
  const flow=sliceMemoryGraph(programGraphs.get(programId),operand);
  for(const callId of new Set(flow.edges.map(e=>e.evidence.callId).filter(Boolean))){
    if(matchedCalls.has(callId))continue;
    const call=project.calls.find(c=>c.id===callId&&c.programId===programId);if(!call)continue;
    matchedCalls.add(callId);totalCalls++;
    if(relatedCalls.length<limit)relatedCalls.push({call,relation:'mapped-memory-flow',graph:sliceGraph(buildParameterGraph(call,getBlock(call.caller),getBlock(call.target),program.symbols),operand),calleeReferences:references.filter(r=>r.blockId===call.target)});
  }
  return {query,operand,ambiguous:false,symbols:program.symbols.filter(s=>normalizeOperand(s.operand)===operand),
    flow,
    directBlocks,references:references.slice(0,300),referenceTotal:references.length,relatedCalls,totalCalls,
    truncated:references.length>300||totalCalls>limit||relatedCalls.some(c=>c.graph.truncated)||flow.truncated,
    coverage:{parsedBlocks:scopeBlocks.filter(b=>b.status==='parsed').length,protectedBlocks:scopeBlocks.filter(b=>b.status==='protected').length,unavailableBlocks:scopeBlocks.filter(b=>b.status!=='parsed').length},
    warnings:['流程图包括可识别的 L/T 数值赋值、算术操作数、比较和布尔条件、调用参数绑定。连线是潜在数据或条件影响，不代表相同数值直接复制。','控制转移处停止合并状态；间接寻址、地址重叠和完整嵌套调用实例尚未展开。来源未解析不等于没有来源。','未列出调用关系不代表没有影响；同一调用内其他逻辑条件仍需查看指令证据。',...(relatedCalls.some(c=>c.relation==='callee-direct-reference')?['部分功能块直接使用此地址，已列出调用位置，但尚未还原该块内部到输出的完整路径。']:[])],
    semantics:'点位的静态使用位置和逐调用点潜在流向，不是实时值或确定因果。'};
}
