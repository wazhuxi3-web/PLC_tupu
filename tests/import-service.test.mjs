import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {findProjects,ImportService,resolvePowerShell} from '../src/import-service.mjs';

test('folder discovery accepts uppercase extension and stops at complete project boundaries',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'step7-discovery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['one/nested','two','deep/a/b'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  for(const name of ['one/Main.S7P','one/nested/Hidden.s7p','two/Second.s7p','deep/a/b/TooDeep.s7p'])fs.writeFileSync(path.join(root,name),'test');
  assert.deepEqual(findProjects(root).projects.map(p=>p.name).sort(),['Main.S7P','Second.s7p']);
  assert.throws(()=>findProjects('relative/path'),/绝对路径/);
  assert.throws(()=>findProjects(path.join(root,'one/Main.S7P')),/不是文件夹/);
  assert.throws(()=>findProjects(''),/请选择/);
});

test('import rejects unsupported inputs and overlapping jobs before spawning a reader',()=>{
  const service=new ImportService(process.cwd(),()=>{});
  assert.throws(()=>service.start('relative.s7p'),/无效/);
  assert.throws(()=>service.start(path.resolve('package.json')),/S7P/);
  assert.throws(()=>service.start(path.resolve('test.s7p'),'-1'),/无效/);
  service.job={status:'running'};
  assert.throws(()=>service.start(path.resolve('anything.s7p')),/正在导入/);
});

test('portable PowerShell is selected ahead of machine-specific runtimes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'step7-runtime-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const exe=path.join(root,'.tools/runtime/pwsh/pwsh.exe');
  fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'fixture');
  assert.equal(resolvePowerShell(root),exe);
});
