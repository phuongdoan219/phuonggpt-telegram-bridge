import test from 'node:test';
import assert from 'node:assert/strict';
import * as chats from './bridge-chats.mjs';
import * as bridge from './telegram-bridge.mjs';

const scope={cwd:'D:\\work',projectId:'p1'};
const thread=(id,extra={})=>({id,cwd:scope.cwd,projectId:'p1',name:'Chat '+id,updatedAt:100,status:{type:'idle'},...extra});

test('listing merges project history and legacy folder chats, filtering unrelated and child chats',async()=>{
  const calls=[];
  const rpc={call:async(method,p)=>{
    calls.push({method,p});
    if(p.cursor)return {data:[thread('child',{parentThreadId:'parent'})]};
    if(p.projectId===null)return {data:[thread('legacy',{projectId:null}),thread('foreign',{projectId:'p2'})]};
    return {data:[thread('one'),thread('other-root',{cwd:'D:\\other-root'})],nextCursor:'next'};
  }};
  assert.deepEqual((await chats.listChats(rpc,scope)).map(t=>t.id).sort(),['legacy','one','other-root']);
  assert.ok(calls.every(c=>c.method==='thread/list'&&c.p.archived===false));
  assert.ok(calls.some(c=>c.p.cwd===scope.cwd&&c.p.projectId===null));
});

test('menu paginates, labels current chat and rejects stale buttons after refresh or scope switch',()=>{
  const picker=new chats.ChatPicker();
  const data=Array.from({length:10},(_,i)=>thread(String(i),{name:'Tiếng Việt 😀'.repeat(20)}));
  const first=picker.open(data,scope,'0');
  const buttons=first.reply_markup.inline_keyboard.flat();
  assert.match(buttons[0].text,/✓/);
  assert.ok(buttons.every(b=>Buffer.byteLength(b.callback_data)<=64));
  const selected=buttons[0].callback_data;
  assert.equal(picker.resolve(selected,scope).threadId,'0');
  const next=buttons.at(-1).callback_data;
  assert.match(picker.page(next,scope).text,/2\/2/);
  assert.throws(()=>picker.resolve(selected,{...scope,projectId:'p2'}),/\/chats/);
  picker.open(data,scope);
  assert.throws(()=>picker.resolve(selected,scope),/\/chats/);
});

test('selection resumes original history and only updates state after success',async()=>{
  const state={...scope,threadId:'old'};const calls=[];
  const rpc={call:async(method,p)=>{calls.push({method,p});return {thread:thread('chosen')};}};
  await chats.resumeChat(rpc,state,'chosen',{developerInstructions:'telegram'},()=>true);
  assert.equal(state.threadId,'chosen');
  assert.equal(calls[1].method,'thread/resume');
  assert.equal(calls[1].p.threadId,'chosen');
  assert.equal(calls[1].p.excludeTurns,true);
  assert.equal(calls[1].p.sandbox,'workspace-write');
  assert.equal(calls[1].p.approvalsReviewer,'user');
});

test('busy, foreign or missing-folder threads and failed resume preserve current state',async()=>{
  for(const candidate of [thread('x',{status:{type:'active'}}),thread('x',{projectId:'p2'}),thread('x')]) {
    const state={...scope,threadId:'old'};
    const rpc={call:async method=>{if(method==='thread/resume')throw Error('resume failed');return {thread:candidate};}};
    await assert.rejects(chats.resumeChat(rpc,state,'x',{},()=>true));
    assert.equal(state.threadId,'old');
  }
  await assert.rejects(chats.resumeChat({call:async()=>({thread:thread('x')})},{...scope},'x',{},()=>false),/thư mục/i);
});

test('empty history explains next action and repeated cursors fail instead of looping',async()=>{
  assert.match(new chats.ChatPicker().open([],scope).text,/Chưa có/);
  await assert.rejects(chats.listChats({call:async()=>({data:[],nextCursor:'same'})},scope),/lặp/);
});

test('switching away and back cannot revive old menu buttons',()=>{
  const picker=new chats.ChatPicker();
  const menu=picker.open([thread('one')],scope);
  const button=menu.reply_markup.inline_keyboard[0][0].callback_data;
  picker.invalidate();
  assert.throws(()=>picker.resolve(button,scope),/\/chats/);
});

test('new Telegram chats retain the selected project assignment and resumes omit creation-only tools',async()=>{
  const calls=[];
  const state={...scope,threadId:null};
  const rpc={call:async(method,p)=>{calls.push({method,p});return {thread:thread('new')};}};
  const bot=new bridge.Bridge(state,rpc);bot.save=()=>{};
  await bot.thread();
  assert.equal(calls[0].p.projectId,scope.projectId);
  assert.equal(calls[0].method,'thread/start');
  bot.readyThread=false;
  await bot.thread();
  assert.equal(calls[1].method,'thread/resume');
  assert.equal(calls[1].p.projectId,undefined);
  assert.equal(calls[1].p.dynamicTools,undefined);
});
