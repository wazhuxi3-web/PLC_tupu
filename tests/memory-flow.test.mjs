import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {analyzeMemoryBlock,buildMemoryGraph,sliceMemoryGraph} from '../src/memory-flow.mjs';
import {tracePoint} from '../src/point-report.mjs';
const rows=spec=>spec.map(([command,operand='',label=''],i)=>({index:i+1,network:1,command,operand,label,parameters:[]}));
const block=spec=>({id:'p--FC1',rows:rows(spec)});

test('word arithmetic retains both sources and temporary assignments substitute their origins',()=>{
  const result=analyzeMemoryBlock(block([['L','MW10'],['L','2'],['+I'],['T','LW0'],['L','LW0'],['T','MW17']]));
  assert.deepEqual(result.assignments.at(-1).dependencies.map(d=>d.operand),['constant:2','MW10']);
});
test('jumps and labels do not carry stale accumulator values into a later store',()=>{
  const result=analyzeMemoryBlock(block([['L','MW10'],['JC','next'],['T','MW17','next'],['L','MW28'],['T','MW17']]));
  assert.equal(result.assignments.length,1);assert.equal(result.assignments[0].dependencies[0].operand,'MW28');
});
test('numeric comparisons feed conditional outputs but do not turn into direct numeric copies',()=>{
  const result=analyzeMemoryBlock(block([['A('],['L','MW17'],['L','900'],['>I'],[')'],['=','M0.0']]));
  const out=result.assignments.at(-1);assert.equal(out.kind,'control-dependency');assert.ok(out.dependencies.some(d=>d.operand==='MW17'));
});
test('unknown accumulator-affecting instructions terminate a segment rather than invent a source',()=>{
  const result=analyzeMemoryBlock(block([['L','MW17'],['POP'],['T','MW20']]));
  assert.equal(result.assignments.length,0);assert.equal(result.diagnostics.length,1);
});
test('internal cycles remain visible without manufacturing an external input',()=>{
  const b=block([['L','MW17'],['T','MW18'],['L','MW18'],['T','MW17']]);
  const p={programs:[{id:'p',symbols:[]}],blocks:[{id:b.id,programId:'p',status:'parsed'}],calls:[]};
  const result=sliceMemoryGraph(buildMemoryGraph(p,'p',()=>b),'MW17');
  assert.equal(result.hasCycle,true);assert.equal(result.nodes.length,2);assert.equal(result.edges.length,2);
  assert.ok(result.nodes.every(n=>n.kind==='memory'));
});
test('numeric formal parameters of two call sites stay isolated',()=>{
  const caller=block([['CALL','FC2'],['CALL','FC2']]);
  const callee={id:'p--FC2',rows:rows([['L','#In'],['T','#Out']])};
  const calls=[0,1].map(i=>({id:'call'+i,programId:'p',caller:caller.id,target:callee.id,network:1,row:i+1,parameters:[{name:'In',value:'MW'+(10+i),direction:'IN'},{name:'Out',value:'MW'+(20+i),direction:'OUT'}]}));
  const p={programs:[{id:'p',symbols:[]}],blocks:[caller,callee].map(b=>({id:b.id,programId:'p',status:'parsed'})),calls};
  const graph=sliceMemoryGraph(buildMemoryGraph(p,'p',id=>id===caller.id?caller:callee),'MW10');
  assert.ok(graph.nodes.some(n=>n.operand==='MW20'));assert.ok(!graph.nodes.some(n=>n.operand==='MW21'));
});

const pointer=new URL('../data/current.json',import.meta.url);
test('L0226D02 MW17 has two evidenced numeric origins and internal destinations',{skip:!fs.existsSync(pointer)},()=>{
  const c=JSON.parse(fs.readFileSync(pointer)),base=new URL(`../data/imports/${c.importId}/`,import.meta.url),p=JSON.parse(fs.readFileSync(new URL('project.json',base)));
  if(p.projectId!=='l0226d02')return;
  const cache=new Map(),get=id=>{if(!p.blocks.some(b=>b.id===id&&b.status==='parsed'))return null;if(!cache.has(id))cache.set(id,JSON.parse(fs.readFileSync(new URL('blocks/'+id+'.json',base))));return cache.get(id);};
  const r=tracePoint(p,'p-ombstx-offline-0000000E','MW17',get);
  assert.equal(r.referenceTotal,18);assert.equal(r.directBlocks[0].name,'FC239');
  const inbound=r.flow.edges.filter(e=>e.to===r.flow.focus);
  assert.deepEqual([...new Set(inbound.map(e=>e.from))].sort(),['memory:DB26.DBW84','memory:MW28']);
  for(const target of ['MW48','DB26.DBW14'])assert.ok(r.flow.edges.some(e=>e.from===r.flow.focus&&e.to==='memory:'+target&&e.kind==='data-transfer'));
  for(const e of r.flow.edges){const b=get(e.evidence.blockId);assert.ok(b.rows.some(row=>row.index===e.evidence.row&&row.network===e.evidence.network));}
  const qs=tracePoint(p,'p-ombstx-offline-0000000E','QS310',get);
  assert.equal(qs.operand,'I920.0');assert.ok(qs.relatedCalls.some(c=>c.call.targetName==='FC156'));
  assert.throws(()=>tracePoint(p,'p-ombstx-offline-0000000E','not-a-symbol',get),/未找到/);
});
