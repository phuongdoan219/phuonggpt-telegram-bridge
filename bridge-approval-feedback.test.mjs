import test from 'node:test';
import assert from 'node:assert/strict';
import * as feedback from './bridge-approval-feedback.mjs';
import {Bridge} from './telegram-bridge.mjs';

const callback={id:'click',message:{message_id:42,chat:{id:1},text:'Codex cần xác nhận:\nLệnh cần chạy'}};
for(const allowed of [true,false])test(`approval ${allowed} is sent once before showing persistent feedback and removing buttons`,async()=>{
  const events=[];const bot=new Bridge({cwd:process.cwd()}, {respond:(id,result)=>events.push({rpc:id,result})});
  const key=bot.approvals.add({id:7,method:'item/commandExecution/requestApproval',params:{},deny:{decision:'decline'}});
  const api=async(method,body)=>{events.push({method,body});};
  await feedback.approvalFeedback(callback,allowed,()=>bot.answer(key,allowed,undefined,true),api);
  assert.equal(events[0].rpc,7);
  assert.equal(events[0].result.decision,allowed?'accept':'decline');
  const edit=events.find(e=>e.method==='editMessageText');
  assert.deepEqual(edit.body.reply_markup.inline_keyboard,[]);
  assert.match(edit.body.text,allowed?/Đã cho phép/:/Đã từ chối/);
  assert.ok(events.find(e=>e.method==='answerCallbackQuery').body.text.length>0);
  await feedback.approvalFeedback(callback,allowed,()=>bot.answer(key,allowed,undefined,true),api);
  assert.equal(events.filter(e=>e.rpc).length,1);
  assert.match(events.at(-1).body.text,/hết hạn|đã được trả lời/);
});

test('failed Codex response never shows success',async()=>{
  const calls=[];
  await feedback.approvalFeedback(callback,true,async()=>{throw Error('disconnected');},async(method,body)=>calls.push({method,body}));
  assert.match(calls.find(c=>c.method==='editMessageText').body.text,/Chưa gửi được/);
  assert.doesNotMatch(calls.find(c=>c.method==='editMessageText').body.text,/Đã cho phép/);
});

test('failed callback toast cannot prevent persistent feedback; failed edit falls back to a message',async()=>{
  const calls=[];
  await feedback.approvalFeedback(callback,true,async()=>true,async(method,body)=>{
    calls.push({method,body});if(method!=='sendMessage')throw Error('Telegram unavailable for this method');
  });
  assert.equal(calls.at(-1).method,'sendMessage');
  assert.match(calls.at(-1).body.text,/Đã cho phép/);
  assert.equal(calls.at(-1).body.chat_id,1);
});

test('a failed permission save still acknowledges the already forwarded choice',async()=>{
  const calls=[];
  await feedback.approvalFeedback(callback,true,async()=>({rememberFailed:true}),async(method,body)=>calls.push({method,body}));
  const status=calls.find(c=>c.method==='editMessageText').body.text;
  assert.match(status,/Đã cho phép lần này/);
  assert.match(status,/chưa lưu được/);
  assert.doesNotMatch(status,/Chưa gửi được/);
});
