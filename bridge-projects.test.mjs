import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listProjects, projectMenu, projectTarget, newProjectPath, createLocalProject} from './bridge-projects.mjs';

const projects=Array.from({length:14},(_,i)=>({id:`p${i}`,name:`Project ${i}`,roots:[{path:`D:\\Project ${i}`}]}));
function cleanupTemp(folder) {
  const target=fs.realpathSync(folder);
  assert.equal(path.dirname(target),fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(target),/^codex-project-/);
  fs.rmSync(target,{recursive:true,force:true});
}

test('loads every page from the live Codex project catalog',async()=>{
  const calls=[];
  const rpc={call:async(method,params)=>{calls.push({method,params});return params.cursor?{data:projects.slice(8),nextCursor:null}:{data:projects.slice(0,8),nextCursor:'second'};}};
  assert.equal((await listProjects(rpc)).length,14);
  assert.equal(calls[1].params.cursor,'second');
  assert.ok(calls.every(c=>c.method==='project/list'));
});
test('project buttons use IDs instead of paths and paginate',()=>{
  const menu=projectMenu(projects,1,()=>true);
  const rows=menu.reply_markup.inline_keyboard;
  assert.ok(rows.flat().some(b=>b.text==='Project 12'&&b.callback_data==='proj:p12:0'));
  assert.ok(rows.flat().some(b=>b.callback_data==='projpage:0'));
  assert.ok(rows.flat().every(b=>Buffer.byteLength(b.callback_data)<=64));
  assert.ok(rows.length<=9);
});
test('unavailable roots are marked and cannot be selected',()=>{
  assert.ok(projectMenu(projects,0,()=>false).reply_markup.inline_keyboard[0][0].text.startsWith('⚠'));
  assert.throws(()=>projectTarget(projects[0],0,()=>false),/không truy cập/);
  assert.throws(()=>projectTarget(projects[0],-1,()=>true),/không hợp lệ/);
  assert.equal(projectTarget(projects[0],0,()=>true),projects[0].roots[0].path);
});
test('projects with multiple roots show each folder separately',()=>{
  const menu=projectMenu([{id:'multi',name:'Multi',roots:[{path:'D:\\a'},{path:'D:\\b'}]}],0,()=>true);
  assert.deepEqual(menu.reply_markup.inline_keyboard.map(row=>row[0].callback_data),['proj:multi:0','proj:multi:1']);
});
test('empty catalogs and stale page numbers remain usable',()=>{
  assert.match(projectMenu([],20,()=>true).text,/Chưa có project/);
  assert.ok(projectMenu(projects,999,()=>true).text.includes('2/2'));
});
test('new project names stay inside the workspace and reject invalid Windows names',()=>{
  const base=path.resolve('test-workspace');
  assert.equal(newProjectPath('Dự án mới',base),path.join(base,'Dự án mới'));
  for(const name of ['','..','../escape','D:\\escape','a/b','a\\b','CON','nul.txt','LPT1','bad?','trailing.','trailing ','x'.repeat(81)]) {
    assert.throws(()=>newProjectPath(name,base),/Tên project/);
  }
});
test('creation registers the folder in Codex and repeated calls reuse it',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'codex-project-test-'));
  t.after(()=>cleanupTemp(base));
  const catalog=[];const calls=[];
  const rpc={call:async(method,params)=>{
    calls.push({method,params});
    if(method==='project/list')return {data:catalog,nextCursor:null};
    assert.equal(method,'project/create');
    const project={id:'new',name:params.name,roots:params.roots};catalog.push(project);return {project};
  }};
  const first=await createLocalProject(rpc,'Demo',base);
  fs.writeFileSync(path.join(first.folder,'keep.txt'),'keep');
  const second=await createLocalProject(rpc,'Demo',base);
  assert.equal(first.created,true);assert.equal(second.created,false);
  assert.equal(fs.readFileSync(path.join(first.folder,'keep.txt'),'utf8'),'keep');
  assert.equal(calls.filter(c=>c.method==='project/create').length,1);
  assert.ok(calls.find(c=>c.method==='project/create').params.idempotencyKey);
});
test('registration failure is retryable without changing existing contents',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'codex-project-retry-'));
  t.after(()=>cleanupTemp(base));
  let fail=true;const keys=[];
  const rpc={call:async(method,params)=>{
    if(method==='project/list')return {data:[]};
    keys.push(params.idempotencyKey);
    if(fail)throw Error('API unavailable');
    return {project:{id:'retry',name:params.name,roots:params.roots}};
  }};
  await assert.rejects(createLocalProject(rpc,'Demo',base),/API unavailable/);
  fs.writeFileSync(path.join(base,'Demo','keep.txt'),'keep');fail=false;
  await createLocalProject(rpc,'Demo',base);
  assert.equal(keys[0],keys[1]);
  assert.equal(fs.readFileSync(path.join(base,'Demo','keep.txt'),'utf8'),'keep');
});
test('same name in another location is rejected before folder creation',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'codex-project-collision-'));
  t.after(()=>cleanupTemp(base));
  const rpc={call:async()=>({data:[{id:'old',name:'Demo',roots:[{path:path.join(base,'elsewhere')}]}]})};
  await assert.rejects(createLocalProject(rpc,'Demo',base),/trùng tên/);
  assert.equal(fs.existsSync(path.join(base,'Demo')),false);
});
