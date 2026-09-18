import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('v1 contract binds queries to a snapshot and keeps imports local',async t=>{
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'4181'},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  await Promise.race([once(child.stdout,'data'),once(child,'error').then(([err])=>{throw err;})]);
  const get=async(route)=>{const r=await fetch('http://127.0.0.1:4181'+route);return {status:r.status,body:await r.json()};};
  for(const asset of ['/app.js','/flow-explorer.js','/flow-layout.js']){
    const response=await fetch('http://127.0.0.1:4181'+asset);
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/text\/javascript/);
    assert.ok((await response.text()).length>100);
  }
  const {body:project}=await get('/api/v1/project');
  assert.equal(project.context.apiVersion,'1.0');assert.equal(project.context.analysisMode,'offline-static');
  const noWrite=await fetch('http://127.0.0.1:4181/api/v1/import',{method:'POST'});
  assert.equal(noWrite.status,405);
  assert.equal((await get('/api/v1/import-status')).status,404);
  const foreign=await fetch('http://127.0.0.1:4181/api/inspect-folder',{method:'POST',headers:{'Content-Type':'application/json','X-Step7-Local':'1',Origin:'https://example.com'},body:'{}'});
  assert.equal(foreign.status,403);
  if(project.empty){assert.equal((await get('/api/v1/calls')).body.code,'NO_PROJECT');return;}
  assert.equal((await get('/api/v1/calls')).body.code,'CONTEXT_REQUIRED');
  const args=new URLSearchParams({projectId:project.projectId,snapshotId:project.snapshotId});
  const stale=await get('/api/v1/calls?'+new URLSearchParams({projectId:project.projectId,snapshotId:'old'}));
  assert.equal(stale.status,409);assert.equal(stale.body.code,'SNAPSHOT_MISMATCH');
  const wrong=await get('/api/v1/calls?'+new URLSearchParams({projectId:'wrong',snapshotId:project.snapshotId}));
  assert.equal(wrong.body.code,'PROJECT_MISMATCH');
  assert.equal((await get('/api/v1/calls?'+args+'&program=missing')).body.code,'PROGRAM_NOT_FOUND');
  const program=[...project.programs].sort((a,b)=>b.symbolCount-a.symbolCount)[0];args.set('program',program.id);
  const calls=await get('/api/v1/calls?'+args);assert.equal(calls.status,200);assert.ok(Array.isArray(calls.body.edges));
  const contract=JSON.parse(fs.readFileSync(new URL('../docs/openapi.v1.json',import.meta.url)));
  for(const name of ['project','block','calls','symbols','references','parameters','point'])assert.ok(contract.paths['/api/v1/'+name].get.operationId);
  if(project.projectId!=='l0226d02')return;
  const caller=project.blocks.find(b=>b.programId===program.id&&b.name==='FC231');
  const focused=await get('/api/v1/calls?'+args+'&focus='+caller.id);
  const call=focused.body.edges.find(c=>c.targetName==='FC156'&&c.parameters.some(p=>p.name==='M_NO'&&p.value==='310'));
  assert.ok(call);args.set('call',call.id);args.set('focus','M_QS');
  const graph=await get('/api/v1/parameters?'+args);assert.equal(graph.body.nodes.length,7);assert.equal(graph.body.edges.length,6);
  assert.equal(graph.body.context.snapshotId,project.snapshotId);
  args.set('direction','invalid');assert.equal((await get('/api/v1/parameters?'+args)).body.code,'INVALID_DIRECTION');args.delete('direction');
  args.set('q','QS310');const refs=await get('/api/v1/references?'+args);assert.equal(refs.body.total,2);assert.equal(refs.body.operand,'I920.0');
  const evidence=graph.body.edges[0].evidence;args.set('id',evidence.blockId);
  const block=await get('/api/v1/block?'+args);assert.ok(block.body.rows.some(r=>r.index===evidence.row&&r.network===evidence.network));
  args.set('q','MW17');const point=await get('/api/v1/point?'+args);
  assert.equal(point.status,200);assert.equal(point.body.referenceTotal,18);assert.ok(point.body.flow.edges.some(e=>e.from==='memory:MW28'&&e.to==='memory:MW17'));
  args.set('q','bad-symbol');assert.equal((await get('/api/v1/point?'+args)).body.code,'POINT_NOT_RESOLVED');
});
