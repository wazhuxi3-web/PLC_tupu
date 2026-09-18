// Generates the checked-in, read-only integration contract. Does not connect to Dify.
import fs from 'node:fs';
const ref=name=>({$ref:'#/components/schemas/'+name});
const str={type:'string'},integer={type:'integer'},bool={type:'boolean'};
const array=items=>({type:'array',items});
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:true});
const schemas={
  Context:object({apiVersion:{type:'string',enum:['1.0']},projectId:{type:'string',nullable:true},snapshotId:{type:'string',nullable:true},analysisMode:{type:'string',enum:['offline-static']}},['apiVersion','projectId','snapshotId','analysisMode']),
  Error:object({error:str,code:str,context:ref('Context')},['error','code','context']),
  Evidence:object({blockId:str,network:integer,row:integer,readRow:integer,parameter:str,callId:str},['blockId','network','row']),
  Parameter:object({name:str,value:str,direction:{type:'string',description:'Normally IN, OUT, IN_OUT. Unknown values must not be guessed.'},type:str,comment:str},['name','value','direction']),
  Call:object({id:str,programId:str,caller:str,target:str,targetName:str,instance:{type:'string',nullable:true},row:integer,network:integer,targetStatus:str,parameters:array(ref('Parameter'))},['id','programId','caller','target','row','network','parameters']),
  BlockSummary:object({id:str,programId:str,name:str,symbol:str,description:str,type:str,status:{type:'string',enum:['parsed','protected','failed','metadata-only','unresolved']},networkCount:integer,rowCount:integer},['id','name','status']),
  Program:object({id:str,station:str,cpu:str,symbolCount:integer},['id','symbolCount']),
  Project:object({context:ref('Context'),empty:bool,projectId:str,snapshotId:str,projectName:str,sourcePath:str,importedAt:{type:'string',format:'date-time'},programs:array(ref('Program')),blocks:array(ref('BlockSummary')),callCount:integer,diagnostics:array({type:'object'}),limitations:array(str),savedSources:array({type:'object'})},['context']),
  Interface:object({name:str,type:str,address:str,comment:str,isArray:bool,arrayStart:array({type:'integer',nullable:true}),arrayStop:array({type:'integer',nullable:true}),byteLength:integer,children:array(ref('Interface'))}),
  Instruction:object({index:integer,network:integer,command:str,operand:str,label:str,comment:str,parameters:array(ref('Parameter'))},['index','network','command','operand','parameters']),
  Block:object({context:ref('Context'),id:str,name:str,interface:ref('Interface'),rows:array(ref('Instruction'))},['context','id','name','rows']),
  CallGraph:object({context:ref('Context'),nodes:array(ref('BlockSummary')),edges:array(ref('Call')),total:integer,truncated:bool},['context','nodes','edges','total','truncated']),
  Symbol:object({name:str,operand:str,type:str,comment:str},['name','operand']),
  Symbols:object({context:ref('Context'),items:array(ref('Symbol')),total:integer,truncated:bool},['context','items','total','truncated']),
  Reference:object({blockId:str,network:integer,row:integer,kind:{type:'string',enum:['read','write','read-write']},command:str,parameter:str,operand:str},['blockId','network','row','kind','operand']),
  References:object({context:ref('Context'),operand:str,items:array(ref('Reference')),total:integer,truncated:bool,scope:str},['context','operand','items','total','truncated','scope']),
  FlowNode:object({id:str,label:str,column:{type:'integer',minimum:0,maximum:4},operand:str,parameter:str,direction:str},['id','label','column']),
  FlowEdge:object({id:str,from:str,to:str,kind:{type:'string',enum:['parameter-in','parameter-out','boolean-preparation','potential-boolean-dependency']},evidence:ref('Evidence')},['id','from','to','kind','evidence']),
  Diagnostic:object({code:str,blockId:str,network:integer,row:integer,message:str},['code','blockId','network','message']),
  Coverage:object({caller:array(ref('Diagnostic')),callee:array(ref('Diagnostic')),analyzedCalleeNetworks:integer,totalCalleeNetworks:integer},['caller','callee','analyzedCalleeNetworks','totalCalleeNetworks']),
  ParameterGraph:object({context:ref('Context'),call:ref('Call'),nodes:array(ref('FlowNode')),edges:array(ref('FlowEdge')),coverage:ref('Coverage'),warnings:array(str),semantics:str,truncated:bool,matched:bool},['call','nodes','edges','coverage','warnings','semantics','truncated']),
  MemoryNode:object({id:str,label:str,operand:str,kind:{type:'string',enum:['memory','input','constant','parameter','unresolved-local']},level:integer,boundary:bool,sourceState:{type:'string',enum:['constant','external-input','internal','unresolved']}},['id','label','kind','level','boundary','sourceState']),
  MemoryEdge:object({id:str,from:str,to:str,kind:{type:'string',enum:['data-transfer','control-dependency','timer-dependency','parameter-in','parameter-out','argument-preparation']},evidence:ref('Evidence')},['id','from','to','kind','evidence']),
  MemoryFlow:object({focus:str,nodes:array(ref('MemoryNode')),edges:array(ref('MemoryEdge')),truncated:bool,hasCycle:bool,sourceStatus:{type:'string',enum:['potential-writers-found','no-mapped-writer']},sources:array(str),limits:object({maxDepth:integer,maxNodes:integer,maxEdges:integer}),diagnostics:array(ref('Diagnostic')),semantics:str},['focus','nodes','edges','truncated','hasCycle','sourceStatus','sources','limits','diagnostics','semantics']),
  PointReport:object({context:ref('Context'),query:str,ambiguous:bool,candidates:array(ref('Symbol')),operand:str,symbols:array(ref('Symbol')),directBlocks:array(ref('BlockSummary')),references:array(ref('Reference')),referenceTotal:integer,relatedCalls:array(object({call:ref('Call'),relation:str,graph:ref('ParameterGraph'),calleeReferences:array(ref('Reference'))},['call','relation','graph','calleeReferences'])),totalCalls:integer,flow:ref('MemoryFlow'),coverage:object({parsedBlocks:integer,protectedBlocks:integer,unavailableBlocks:integer}),truncated:bool,warnings:array(str),semantics:str},['context','query','ambiguous','warnings'])
};
const param=(name,description,required=false,schema=str)=>({name,in:'query',description,required,schema});
const context=[param('projectId','Copy verbatim from getProject.context; use together with snapshotId.',true),param('snapshotId','Copy verbatim from getProject.context. Reject stale contexts.',true)];
const response=(description,schema)=>({description,content:{'application/json':{schema:ref(schema)}}});
const route=(operationId,summary,schema,params=[],bind=true)=>({get:{operationId,summary,parameters:[...(bind?context:[]),...params],responses:{200:response('Query result. Inspect warnings, coverage and truncation.',''+schema),400:response('Missing context or invalid arguments.','Error'),404:response('Unavailable block, program or call.','Error'),409:response('No imported project or context no longer current.','Error'),500:response('Local service read error.','Error')}}});
const spec={openapi:'3.0.3',info:{title:'STEP7 Offline Explorer Read API',version:'1.0.0',description:'Prepared for future Dify integration. Local-only; no workflow/model connection. Static potential dependencies are not runtime state or established causality. All IDs are scoped by projectId + snapshotId. Instruction row numbers are decoded instruction indices, not original source lines.'},servers:[{url:'http://127.0.0.1:4173',description:'Current local-only deployment'}],paths:{
  '/api/v1/project':route('getProject','Get current project context, programs, block inventory and limitations','Project',[],false),
  '/api/v1/point':route('tracePoint','Trace a point or exact symbol: direct usages, related call sites and upstream/downstream value or condition dependencies','PointReport',[param('program','Program id.',true),param('q','Exact symbol or address, e.g. MW17. Ambiguous symbols return candidates.',true)]),
  '/api/v1/block':route('getBlock','Get decoded instructions and interface; unavailable/protected blocks return 404','Block',[param('id','Block id from inventory or evidence.',true)]),
  '/api/v1/calls':route('getCalls','Get direct call sites; capped at 160 edges, no pagination in v1','CallGraph',[param('program','Program id.',true),param('focus','Optional block id from this program. Omit to query its call inventory.')]),
  '/api/v1/symbols':route('searchSymbols','Search symbol name, normalized address or comment; capped at 120','Symbols',[param('program','Program id.',true),param('q','Search term; empty returns first 120 symbols.')]),
  '/api/v1/references':route('getReferences','Exact direct address / exact symbol references; capped at 300','References',[param('program','Program id.',true),param('q','Exact symbol name or direct address. No indirect or overlapping address inference.',true)]),
  '/api/v1/parameters':route('traceParameters','Get a single-call potential Boolean dependency graph','ParameterGraph',[param('call','Exact call-site id from getCalls.edges; do not synthesize.',true),param('focus','Parameter name, node id or normalized address. Empty returns all call bindings.'),param('direction','Traversal relative to focus; ignored when focus empty.',false,{type:'string',enum:['upstream','downstream','both'],default:'both'})])
},components:{schemas}};
fs.writeFileSync(new URL('../docs/openapi.v1.json',import.meta.url),JSON.stringify(spec,null,2)+'\n');
console.log('docs/openapi.v1.json written');
