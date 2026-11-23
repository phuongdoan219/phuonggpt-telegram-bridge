import test from 'node:test';
import assert from 'node:assert/strict';
import * as memory from './bridge-remember.mjs';
import {Bridge} from './telegram-bridge.mjs';
const scope={cwd:'D:\\work',projectId:'p1',threadId:'thread'};
const command={method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'item',cwd:'D:\\work',command:'node --test',additionalPermissions:{network:{enabled:true}}}};

test('remembered approvals survive reload, ignore request IDs, and stay scoped to exact command and permissions',()=>{
  const saved=[];const rules=new memory.RememberedApprovals(saved);
  assert.equal(rules.has(command,scope),false);
  rules.remember(command,scope);
  const reloaded=new memory.RememberedApprovals(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.has({...command,params:{...command.params,itemId:'new',turnId:'new'}},scope),true);
  assert.equal(reloaded.has({...command,params:{...command.params,command:'node other.mjs'}},scope),false);
  assert.equal(reloaded.has(command,{...scope,cwd:'D:\\other'}),false);
  assert.equal(reloaded.has(command,{...scope,projectId:'p2'}),false);
  assert.equal(reloaded.has({...command,params:{...command.params,additionalPermissions:{network:{enabled:false}}}},scope),false);
  assert.ok(saved.every(value=>/^[a-f0-9]{64}$/.test(value)));
});

test('file approvals require complete identical changes; user questions and missing command details cannot be cached',()=>{
  const rules=new memory.RememberedApprovals([]);
  for(const r of [{method:'item/tool/requestUserInput',params:{}},{...command,params:{command:null}}]) {
    rules.remember(r,scope);assert.equal(rules.has(r,scope),false);
  }
  const file={method:'item/fileChange/requestApproval',params:{itemId:'x'}};
  rules.remember(file,scope);assert.equal(rules.has(file,scope),false);
  const changes={changes:[{path:'D:\\outside\\x.txt',diff:'one'}]};
  rules.remember(file,scope,changes);
  assert.equal(rules.has(file,scope,changes),true);
  assert.equal(rules.has(file,scope,{changes:[{path:'D:\\outside\\x.txt',diff:'two'}]}),false);
});

test('Bridge remembers only explicitly remembered successful approvals, and auto replies to exact repeats',async()=>{
  const responses=[];const state={...scope};
  const bot=new Bridge(state,{respond:(id,result)=>responses.push({id,result})});bot.save=()=>{};
  let key=bot.approvals.add({...command,id:1,deny:{decision:'decline'}});
  await bot.answer(key,true,undefined,true,true);
  assert.equal(state.rememberedApprovals.length,1);
  const next={...command,id:2,params:{...command.params,itemId:'next'}};
  await bot.request(next);
  assert.deepEqual(responses,[{id:1,result:{decision:'accept'}},{id:2,result:{decision:'accept'}}]);
  key=bot.approvals.add({...command,id:3,params:{...command.params,command:'other'},deny:{decision:'decline'}});
  await bot.answer(key,false,undefined,true,true);
  assert.equal(state.rememberedApprovals.length,1);
  key=bot.approvals.add({...command,id:4,params:{...command.params,command:'one time'},deny:{decision:'decline'}});
  await bot.answer(key,true,undefined,true,false);
  assert.equal(state.rememberedApprovals.length,1);
});

test('failed RPC response does not create a remembered permission',async()=>{
  const state={...scope};const bot=new Bridge(state,{respond:()=>{throw Error('disconnected');}});bot.save=()=>{};
  const key=bot.approvals.add({...command,id:1,deny:{decision:'decline'}});
  await assert.rejects(bot.answer(key,true,undefined,true,true),/disconnected/);
  assert.equal(state.rememberedApprovals.length,0);
});

test('failed persistence reports an accepted one-use decision without keeping a live unsaved rule',async()=>{
  const responses=[];const state={...scope};
  const bot=new Bridge(state,{respond:(id,result)=>responses.push(result)});bot.save=()=>{throw Error('disk full');};
  const key=bot.approvals.add({...command,id:1,deny:{decision:'decline'}});
  const result=await bot.answer(key,true,undefined,true,true);
  assert.deepEqual(responses,[{decision:'accept'}]);
  assert.equal(result.rememberFailed,true);
  assert.equal(state.rememberedApprovals.length,0);
});

const chromeConsent={method:'mcpServer/elicitation/request',params:{serverName:'computer-use',threadId:'thread',turnId:'turn',mode:'form',message:'Allow Codex to use Google Chrome?',requestedSchema:{type:'object',properties:{}}}};
test('Chrome consent can be remembered; other servers, projects and different permissions cannot reuse it',()=>{
  const rules=new memory.RememberedApprovals([]);
  assert.equal(rules.remember(chromeConsent,scope),true);
  assert.equal(rules.has({...chromeConsent,params:{...chromeConsent.params,turnId:'new'}},scope),true);
  assert.equal(rules.has({...chromeConsent,params:{...chromeConsent.params,serverName:'other-tool'}},scope),false);
  assert.equal(rules.has(chromeConsent,{...scope,projectId:'other'}),false);
  assert.equal(rules.remember({...chromeConsent,params:{...chromeConsent.params,message:'Confirm this purchase?'}},scope),false);
  assert.equal(rules.remember({...chromeConsent,params:{...chromeConsent.params,requestedSchema:{type:'object',properties:{password:{type:'string'}}}}},scope),false);
});

test('repeated Chrome consent returns an MCP accept response rather than a command approval response',async()=>{
  const responses=[];const state={...scope};
  const bot=new Bridge(state,{respond:(id,result)=>responses.push({id,result})});bot.save=()=>{};
  const token=bot.approvals.add({...chromeConsent,id:1,deny:{action:'decline',content:null}});
  assert.deepEqual(await bot.answer(token,true,undefined,true,true),{remembered:true});
  await bot.request({...chromeConsent,id:2,params:{...chromeConsent.params,turnId:'new'}});
  assert.deepEqual(responses,[{id:1,result:{action:'accept',content:{}}},{id:2,result:{action:'accept',content:{}}}]);
});
