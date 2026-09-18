import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {analyzeBooleanBlock,buildParameterGraph,sliceGraph,normalizeOperand,findReferences} from '../src/analysis.mjs';
const row=(index,command,operand='',network=1,extra={})=>({index,command,operand,network,label:'',parameters:[],...extra});
test('German/English address aliases normalize without corrupting symbolic names',()=>{
  assert.equal(normalizeOperand('A 1420.0'),'Q1420.0');assert.equal(normalizeOperand('E 920.0'),'I920.0');
  assert.equal(normalizeOperand('DB4.DBX 21.0'),'DB4.DBX21.0');assert.equal(normalizeOperand('"A motor"'),'"A motor"');
});
test('RLO reset prevents unrelated assignments from becoming dependencies',()=>{
  const a=analyzeBooleanBlock({id:'FC1',rows:[row(1,'A','I0.0'),row(2,'=','L0.0'),row(3,'A','I0.1'),row(4,'=','L0.1'),row(5,'CALL','FC2')]});
  assert.deepEqual(a.calls.get(5).get('L0.1').dependencies.map(d=>d.operand),['I0.1']);
  assert.deepEqual(a.calls.get(5).get('L0.0').dependencies.map(d=>d.operand),['I0.0']);
});
test('unsupported jump invalidates the network and cannot produce a false definite path',()=>{
  const a=analyzeBooleanBlock({id:'FC1',rows:[row(1,'A','I0.0'),row(2,'JC','end'),row(3,'=','Q0.0')]});
  assert.equal(a.assignments.length,0);assert.equal(a.diagnostics[0].code,'UNSUPPORTED_NETWORK');
});
test('consecutive writes retain the current RLO but the next Boolean chain starts fresh',()=>{
  const a=analyzeBooleanBlock({id:'FC1',rows:[row(1,'A','I0.0'),row(2,'=','Q0.0'),row(3,'=','Q0.1'),row(4,'A','I0.1'),row(5,'=','Q0.2')]});
  assert.deepEqual(a.assignments.map(a=>a.dependencies.map(d=>d.operand)),[['I0.0'],['I0.0'],['I0.1']]);
});
test('incomplete brackets do not leak staged assignments',()=>{
  const a=analyzeBooleanBlock({id:'FC1',rows:[row(1,'A','I0.0'),row(2,'=','Q0.0'),row(3,'A('),row(4,'A','I0.1')]});
  assert.equal(a.assignments.length,0);assert.equal(a.diagnostics[0].code,'INVALID_BOOLEAN_STATE');
});
test('temporaries and parameters are isolated by call site',()=>{
  const caller={id:'FC1',rows:[row(1,'A','I0.0'),row(2,'=','L0.0'),row(3,'CALL','FC2'),row(4,'A','I0.1'),row(5,'=','L0.0'),row(6,'CALL','FC2')]};
  const callee={id:'FC2',rows:[row(1,'A','#Enable'),row(2,'=','#Run')]};
  const c={id:'call1',caller:'FC1',targetName:'FC2',row:3,network:1,parameters:[{name:'Enable',value:'L0.0',direction:'IN'},{name:'Run',value:'Q0.0',direction:'OUT'}]};
  const g1=buildParameterGraph(c,caller,callee),g2=buildParameterGraph({...c,id:'call2',row:6},caller,callee);
  assert.ok(g1.nodes.some(n=>n.operand==='I0.0'));assert.ok(!g1.nodes.some(n=>n.operand==='I0.1'));
  assert.ok(g2.nodes.some(n=>n.operand==='I0.1'));assert.ok(!g2.nodes.some(n=>n.operand==='I0.0'));
  assert.ok(g1.nodes.every(n=>!g2.nodes.some(m=>m.id===n.id)));
});
test('bidirectional focus does not pull in sibling inputs through the shared output',()=>{
  const graph={nodes:['a','b','c'].map(id=>({id})),edges:[{from:'a',to:'c'},{from:'b',to:'c'}]};
  assert.deepEqual(sliceGraph(graph,'a').nodes.map(n=>n.id),['a','c']);
  assert.equal(sliceGraph(graph,'a','downstream',0).truncated,true);
});
test('address search is exact; a byte address does not masquerade as a bit alias',()=>{
  const block={id:'FC1',rows:[row(1,'A','I 920.0'),row(2,'L','IB920'),row(3,'CALL','FC2',1,{parameters:[{name:'Run',direction:'OUT',value:'A 1420.0'}]})]};
  assert.equal(findReferences(block,'I920.0').length,1);assert.equal(findReferences(block,'Q1420.0')[0].kind,'write');
});

const pointer=new URL('../data/current.json',import.meta.url);
test('L0226D02: offline FC231 → FC156 → Q1420.0 is backed by decoded instructions',{skip:!fs.existsSync(pointer)},()=>{
  const current=JSON.parse(fs.readFileSync(pointer)),base=new URL(`../data/imports/${current.importId}/`,import.meta.url);
  const p=JSON.parse(fs.readFileSync(new URL('project.json',base)));
  if(p.projectId!=='l0226d02')return;
  const load=id=>JSON.parse(fs.readFileSync(new URL(`blocks/${id}.json`,base)));
  const prog=p.programs.find(x=>x.cpu==='CPU 416-3 PN/DP');assert.equal(prog.symbols.length,6155);
  assert.equal(p.blocks.filter(x=>x.programId===prog.id).length,302);
  const c=p.calls.find(c=>c.programId===prog.id&&c.caller.endsWith('--FC231')&&c.targetName==='FC156'&&c.parameters.some(x=>x.name==='M_NO'&&x.value==='310'));
  assert.ok(c);const caller=load(c.caller),callee=load(c.target);const g=buildParameterGraph(c,caller,callee,prog.symbols),focused=sliceGraph(g,'M_QS');
  for(const value of ['I920.0','L102.5','Q1420.0','Q1420.1'])assert.ok(focused.nodes.some(n=>n.operand===value),value);
  assert.equal(focused.edges.filter(e=>e.kind==='potential-boolean-dependency').length,2);
  for(const e of focused.edges){const block=e.evidence.blockId===caller.id?caller:callee;assert.ok(block.rows.some(r=>r.index===e.evidence.row&&r.network===e.evidence.network));}
  assert.equal(load(`${prog.id}--FC400`).rows.filter(r=>r.command==='NETWORK').length,27);
  assert.deepEqual(p.savedSources.map(s=>s.networks).sort((a,b)=>a-b),[64,129]);
  assert.equal(p.diagnostics.filter(d=>d.code==='BLOCK_PARSE_FAILED').length,0);
});
