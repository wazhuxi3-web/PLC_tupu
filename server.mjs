import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildCallGraph,buildParameterGraph,sliceGraph,findReferences,normalizeOperand} from './src/analysis.mjs';
import {ImportService,findProjects} from './src/import-service.mjs';
import {tracePoint} from './src/point-report.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
let current=null,dataDir=null,project=null,blocks=new Map(),details=new Map();
function loadCurrent(){
  const pointer=path.join(root,'data/current.json');if(!fs.existsSync(pointer))return;
  const next=JSON.parse(fs.readFileSync(pointer,'utf8'));if(!/^[\w-]+$/.test(next.importId))throw Error('Invalid import pointer');
  const directory=path.join(root,'data/imports',next.importId),data=JSON.parse(fs.readFileSync(path.join(directory,'project.json'),'utf8'));
  current=next;dataDir=directory;project=data;blocks=new Map(data.blocks.map(b=>[b.id,b]));details=new Map();
}
try{loadCurrent();}catch(error){console.error('读取上次导入失败，可重新导入：',error.message);}
const importer=new ImportService(root,loadCurrent);
function getBlock(id){if(!blocks.has(id)||blocks.get(id).status!=='parsed')return null;if(!details.has(id))details.set(id,JSON.parse(fs.readFileSync(path.join(dataDir,'blocks',id+'.json'),'utf8')));return details.get(id);}
async function readBody(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw Error('请求过大。');}return JSON.parse(body||'{}');}
const staticFiles=new Map([['/','index.html'],['/app.js','app.js'],['/style.css','style.css']]);
const server=http.createServer(async(req,res)=>{
  const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"});res.end(type.startsWith('application/json')?JSON.stringify({...value,context:{apiVersion:'1.0',projectId:project?.projectId??null,snapshotId:project?.snapshotId??null,analysisMode:'offline-static'}}):value);};
  try{
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host??''))return send(403,{error:'只允许本机访问。',code:'LOCAL_ACCESS_ONLY'});
    const u=new URL(req.url,'http://127.0.0.1'),q=u.searchParams;const versioned=u.pathname.startsWith('/api/v1/');if(versioned){if(req.method!=='GET')return send(405,{error:'集成接口只允许查询。',code:'READ_ONLY_API'});u.pathname=u.pathname.replace('/api/v1/','/api/');if(!['project','block','calls','symbols','references','parameters','point'].some(name=>u.pathname==='/api/'+name))return send(404,{error:'未找到集成接口。',code:'NOT_FOUND'});}
    if(req.method==='POST'){
      if(req.headers['x-step7-local']!=='1'||(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`))return send(403,{error:'请从本地工作台操作。',code:'LOCAL_UI_REQUIRED'});
      const body=await readBody(req);
      if(u.pathname==='/api/select-folder')return send(200,await importer.selectFolder());
      if(u.pathname==='/api/inspect-folder')return send(200,findProjects(body.folder));
      if(u.pathname==='/api/import')return send(202,importer.start(body.projectFile,body.codePage??936));
      return send(404,{error:'未找到。',code:'NOT_FOUND'});
    }
    if(req.method!=='GET')return send(405,{error:'不支持此操作。',code:'METHOD_NOT_ALLOWED'});
    if(staticFiles.has(u.pathname)){const name=staticFiles.get(u.pathname);return send(200,fs.readFileSync(path.join(root,'web',name)),name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');}
    if(u.pathname==='/api/health')return send(200,{app:'step7-explorer',version:'0.2.0',loaded:!!project});
    if(u.pathname==='/api/import-status')return send(200,importer.job??{status:'idle'});
    if(u.pathname==='/api/project')return send(200,project?{...project,callCount:project.calls.length,programs:project.programs.map(({symbols,...p})=>({...p,symbolCount:symbols.length})),calls:undefined}:{empty:true});
    if(!project)return send(409,{error:'请先选择 PLC 文件夹并导入工程。',code:'NO_PROJECT'});
    if(versioned && (!q.get('projectId')||!q.get('snapshotId')))return send(400,{error:'必须提供 projectId 和 snapshotId。',code:'CONTEXT_REQUIRED'});
    if(q.has('projectId')&&q.get('projectId')!==project.projectId)return send(409,{error:'当前工程与请求不符。',code:'PROJECT_MISMATCH'});
    if(q.has('snapshotId')&&q.get('snapshotId')!==project.snapshotId)return send(409,{error:'工程快照已变化，请重新获取工程信息。',code:'SNAPSHOT_MISMATCH',snapshotId:project.snapshotId});
    if(u.pathname==='/api/point'){
      try{return send(200,tracePoint(project,q.get('program'),q.get('q')??'',getBlock));}
      catch(error){if(error.code&&error.status)return send(error.status,{error:error.message,code:error.code});throw error;}
    }
    if(u.pathname==='/api/block'){const b=getBlock(q.get('id'));return b?send(200,b):send(404,{error:'块未解析或不存在。',code:'BLOCK_UNAVAILABLE'});}
    if(u.pathname==='/api/calls'){
      if(!project.programs.some(p=>p.id===q.get('program')))return send(404,{error:'程序不存在。',code:'PROGRAM_NOT_FOUND'});
      if(q.get('focus')&&blocks.get(q.get('focus'))?.programId!==q.get('program'))return send(404,{error:'当前程序中没有该块。',code:'BLOCK_UNAVAILABLE'});
      return send(200,buildCallGraph(project,q.get('program'),q.get('focus')));
    }
    if(u.pathname==='/api/symbols'){
      const program=project.programs.find(p=>p.id===q.get('program'));if(!program)return send(404,{error:'程序不存在。',code:'PROGRAM_NOT_FOUND'});
      const query=(q.get('q')??'').trim(),norm=normalizeOperand(query),matches=program.symbols.filter(s=>!query||s.name.toLowerCase().includes(query.toLowerCase())||normalizeOperand(s.operand).includes(norm)||s.comment.includes(query));
      return send(200,{items:matches.slice(0,120),total:matches.length,truncated:matches.length>120});
    }
    if(u.pathname==='/api/references'){
      const program=project.programs.find(p=>p.id===q.get('program'));if(!program)return send(404,{error:'程序不存在。',code:'PROGRAM_NOT_FOUND'});
      const query=q.get('q')??'',symbol=program.symbols.find(s=>s.name===query),operand=symbol?.operand??query;
      const found=[];for(const b of project.blocks)if(b.programId===program.id&&b.status==='parsed')found.push(...findReferences(getBlock(b.id),operand));
      return send(200,{operand:normalizeOperand(operand),items:found.slice(0,300),total:found.length,truncated:found.length>300,scope:'已解析块中的直接地址与已还原调用实参；不包含间接寻址和地址重叠推断。'});
    }
    if(u.pathname==='/api/parameters'){
      const call=project.calls.find(c=>c.id===q.get('call'));if(!call)return send(404,{error:'调用点不存在。',code:'CALL_NOT_FOUND'});
      const graph=buildParameterGraph(call,getBlock(call.caller),getBlock(call.target),project.programs.find(p=>p.id===call.programId).symbols);
      const direction=q.get('direction')??'both';if(!['upstream','downstream','both'].includes(direction))return send(400,{error:'无效追踪方向。',code:'INVALID_DIRECTION'});
      return send(200,sliceGraph(graph,q.get('focus'),direction));
    }
    return send(404,{error:'未找到。',code:'NOT_FOUND'});
  }catch(error){console.error(error.message);return send(req.method==='POST'?400:500,{error:req.method==='POST'?error.message:'读取失败，请查看本地服务日志。',code:req.method==='POST'?'IMPORT_REQUEST_FAILED':'INTERNAL_ERROR'});}
});
const port=Number(process.env.PORT??4173),url=`http://127.0.0.1:${port}`;
function openBrowser(){if(process.argv.includes('--open'))spawn('cmd.exe',['/c','start','',url],{windowsHide:true,stdio:'ignore'});}
server.on('error',async error=>{
  if(error.code==='EADDRINUSE')try{const r=await fetch(`${url}/api/health`),data=await r.json();if(data.app==='step7-explorer'){console.log(`工作台已运行：${url}`);openBrowser();return;}}catch{}
  console.error(`无法启动工作台：${error.message}`);process.exitCode=1;
});
server.listen(port,'127.0.0.1',()=>{console.log(`STEP7 离线工作台：${url} / ${current?.importId??'请选择工程文件夹'}`);openBrowser();});
