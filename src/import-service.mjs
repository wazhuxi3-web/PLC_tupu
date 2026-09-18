import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

export function findProjects(folder, maxDepth=2) {
  if(typeof folder!=='string'||!folder.trim()||folder.includes('\0'))throw Error('请选择工程文件夹，或输入完整路径。');
  const root=path.resolve(folder.trim());
  if(!path.isAbsolute(folder.trim()))throw Error('请输入完整的绝对路径。');
  if(!fs.statSync(root).isDirectory())throw Error('所选路径不是文件夹。');
  const projects=[];let visited=0;
  const walk=(dir,depth)=>{
    if(++visited>1000)throw Error('选择范围过大，请选择更具体的 PLC 工程文件夹。');
    const entries=fs.readdirSync(dir,{withFileTypes:true});
    for(const entry of entries){
      if(entry.isFile()&&/\.s7p$/i.test(entry.name))projects.push({name:entry.name,path:path.join(dir,entry.name),folder:dir});
      if(projects.length>100)throw Error('工程过多，请选择更具体的文件夹。');
    }
    if(entries.some(e=>e.isFile()&&/\.s7p$/i.test(e.name)))return;
    if(depth<maxDepth)for(const entry of entries)if(entry.isDirectory()&&!entry.isSymbolicLink()&&!entry.name.startsWith('.'))walk(path.join(dir,entry.name),depth+1);
  };
  walk(root,0);
  return {folder:root,projects};
}

export function resolvePowerShell(root) {
  const portable=path.join(root,'.tools/runtime/pwsh/pwsh.exe');
  if(fs.existsSync(portable))return portable;
  if(process.env.PWSH_PATH&&fs.existsSync(process.env.PWSH_PATH))return process.env.PWSH_PATH;
  const bundled=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe');
  if(fs.existsSync(bundled))return bundled;
  return 'pwsh';
}

export class ImportService {
  constructor(root,onSuccess){this.root=root;this.onSuccess=onSuccess;this.job=null;this.picker=null;}
  async selectFolder(){
    if(this.picker)throw Error('文件夹选择窗口已经打开，请先选择或取消。');
    return new Promise((resolve,reject)=>{
      const child=spawn(resolvePowerShell(this.root),['-NoProfile','-STA','-File',path.join(this.root,'scripts/Select-ProjectFolder.ps1')],{windowsHide:true,cwd:this.root});
      this.picker=child;let out='',err='';
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);
      child.on('error',error=>{this.picker=null;reject(Error(`无法打开文件夹选择窗口：${error.message}。也可以直接输入文件夹路径。`));});
      child.on('close',code=>{this.picker=null;if(code!==0)return reject(Error(`文件夹选择窗口异常：${err.slice(-500)}`));try{resolve(JSON.parse(out.replace(/^\uFEFF/,'')));}catch{reject(Error('文件夹选择结果无法读取，可直接输入路径。'));}});
    });
  }
  start(projectFile,codePage=936){
    if(this.job?.status==='running')throw Error('已有工程正在导入，请等待完成。');
    if(typeof projectFile!=='string'||!path.isAbsolute(projectFile)||!/^\d+$/.test(String(codePage))||Number(codePage)>65535)throw Error('无效工程路径或编码。');
    const file=path.resolve(projectFile);
    if(!/\.s7p$/i.test(file)||!fs.statSync(file).isFile())throw Error('请选择实际存在的 .S7P 工程入口。');
    const job={id:crypto.randomUUID(),status:'running',projectFile:file,startedAt:new Date().toISOString(),message:'正在创建工程副本并检查文件…',lines:[]};this.job=job;
    const child=spawn(resolvePowerShell(this.root),['-NoProfile','-File',path.join(this.root,'scripts/Import-Step7Project.ps1'),'-ProjectFile',file,'-CodePage',String(codePage)],{cwd:this.root,windowsHide:true});
    let errorOutput='';
    const log=chunk=>{const text=chunk.replace(/\x1b\[[0-9;]*m/g,'');const lines=text.split(/\r?\n/).filter(Boolean);job.lines.push(...lines);job.lines=job.lines.slice(-8);if(lines.length)job.message=lines.at(-1);};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',log);child.stderr.on('data',chunk=>{errorOutput=(errorOutput+chunk).slice(-2500);log(chunk);});
    child.on('error',error=>{job.status='failed';job.message=`导入程序无法启动：${error.message}`;job.finishedAt=new Date().toISOString();});
    child.on('close',code=>{
      if(job.status==='failed')return;
      job.finishedAt=new Date().toISOString();
      if(code!==0){job.status='failed';job.message=errorOutput.replace(/\x1b\[[0-9;]*m/g,'').trim()||job.message;return;}
      try{this.onSuccess();job.status='complete';job.message='导入完成，已加载新的工程快照。';}catch(error){job.status='failed';job.message=`导入完成但加载失败：${error.message}`;}
    });
    return job;
  }
}
