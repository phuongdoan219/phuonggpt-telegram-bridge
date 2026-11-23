import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized, freshUpdate, chunks, ApprovalStore, telegramFileTool, ReplyOutbox, approvalPreview } from './bridge-core.mjs';
import * as core from './bridge-core.mjs';
import {Bridge} from './telegram-bridge.mjs';

test('empty consent forms use buttons while real data forms and URL authorization do not',()=>{
  const params={mode:'form',message:'Allow Codex to use Google Chrome?',requestedSchema:{type:'object',properties:{}}};
  assert.equal(core.isConsentRequest(params),true);
  assert.equal(core.isConsentRequest({...params,mode:'url'}),false);
  assert.equal(core.isConsentRequest({...params,requestedSchema:{type:'object',properties:{name:{type:'string'}}}}),false);
  assert.equal(core.isConsentRequest({...params,requestedSchema:{type:'object',properties:{},minProperties:1}}),false);
});

test('approving an empty consent form sends accept with an empty object without asking for JSON',async()=>{
  const responses=[];const bot=new Bridge({cwd:process.cwd()},{respond:(id,result)=>responses.push(result)});
  const key=bot.approvals.add({id:1,method:'mcpServer/elicitation/request',params:{message:'Allow Codex to use Google Chrome?',requestedSchema:{type:'object',properties:{}}},deny:{action:'decline',content:null}});
  await bot.answer(key,true,undefined,true);
  assert.deepEqual(responses,[{action:'accept',content:{}}]);
});

const owner = '424242';
const message = {chat:{id:424242,type:'private'},from:{id:424242,is_bot:false}};
test('file delivery tool matches the installed app-server tagged schema', () => {
  assert.equal(telegramFileTool.type, 'function');
  assert.equal(telegramFileTool.inputSchema.required[0], 'path');
});
test('only the configured private owner can issue commands', () => {
  assert.equal(authorized(message, owner), true);
  assert.equal(authorized({...message, from:{id:123}}, owner), false);
  assert.equal(authorized({...message, chat:{id:424242,type:'group'}}, owner), false);
  assert.equal(authorized({...message, from:{id:424242,is_bot:true}}, owner), false);
  assert.equal(authorized({}, owner), false);
});
test('updates below committed offset are not replayed', () => {
  assert.equal(freshUpdate({update_id:9}, 10), false);
  assert.equal(freshUpdate({update_id:10}, 10), true);
});
test('long replies preserve Unicode and respect Telegram UTF-16 limit', () => {
  const original = 'Tiếng Việt 😀'.repeat(800);
  const parts = chunks(original);
  assert.equal(parts.join(''), original);
  assert.ok(parts.every(p => p.length <= 4000 && !/[\uD800-\uDBFF]$/.test(p)));
});
test('approvals are one-use and expired requests cannot grant permission', () => {
  let now = 100;
  const store = new ApprovalStore(() => now);
  const key = store.add({id:42});
  assert.equal(store.take(key).id, 42);
  assert.equal(store.take(key), undefined);
  const old = store.add({id:43});
  now += 600001;
  assert.equal(store.take(old), undefined);
});
test('a failed reply stays pending and retry never reruns the model', async () => {
  const saved=[];let fail=true;const delivered=[];
  const queue=new ReplyOutbox(saved,()=>{},async text=>{if(fail)throw Error('offline');delivered.push(text);});
  queue.add('kết quả');
  await assert.rejects(queue.flush(), /offline/);
  assert.deepEqual(saved,['kết quả']);
  fail=false;
  await Promise.all([queue.flush(),queue.flush()]);
  assert.deepEqual(delivered,['kết quả']);
  assert.deepEqual(saved,[]);
});
test('approval shows command working directory and requested extra access', () => {
  const preview=approvalPreview('command',{command:'Remove-Item temp.txt',cwd:'D:\\work',additionalPermissions:{filesystem:{write:['D:\\other']}}});
  assert.ok(preview.includes('D:\\\\work'));
  assert.ok(preview.includes('D:\\\\other'));
});
test('file approval requires actual affected files and includes the patch', () => {
  assert.equal(approvalPreview('file',{itemId:'patch1'}),null);
  const preview=approvalPreview('file',{grantRoot:'D:\\work'},{changes:[{path:'D:\\work\\a.txt',diff:'-old\n+new'}]});
  assert.ok(preview.includes('a.txt'));
  assert.ok(preview.includes('+new'));
});
