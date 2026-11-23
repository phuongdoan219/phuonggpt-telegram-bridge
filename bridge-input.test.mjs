import test from 'node:test';
import assert from 'node:assert/strict';
import * as ui from './bridge-input.mjs';
import {Bridge} from './telegram-bridge.mjs';
const key='0123456789abcdef';
const request={method:'item/tool/requestUserInput',params:{questions:[
  {id:'mode',header:'Chọn',question:'Chọn phương án?',options:[{label:'A',description:'Phương án A'},{label:'B',description:'Phương án B'}]},
  {id:'link',header:'Link',question:'Nhập đường link',options:null}
]}};

test('questions show option buttons, collect separate answers and submit the correct protocol object',()=>{
  const flow=new ui.InputFlow(request);
  assert.equal(flow.view(key).reply_markup.inline_keyboard[0][0].text,'A');
  flow.choose(0);flow.enter('https://example.com');
  const menu=flow.view(key);
  assert.ok(menu.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`input:${key}:2:submit`));
  assert.deepEqual(flow.result(),{answers:{mode:{answers:['A']},link:{answers:['https://example.com']}}});
  assert.ok(menu.reply_markup.inline_keyboard.flat().every(b=>Buffer.byteLength(b.callback_data)<=64));
});

test('forms use buttons for booleans and enum values, preserving numeric types and optional skips',()=>{
  const flow=new ui.InputFlow({method:'mcpServer/elicitation/request',params:{message:'Điền thông tin',requestedSchema:{type:'object',required:['ok','plan','count'],properties:{ok:{type:'boolean'},plan:{type:'string',enum:['small','large'],enumNames:['Nhỏ','Lớn']},count:{type:'integer',minimum:1},note:{type:'string'}}}}});
  flow.choose(0);flow.choose(1);
  assert.throws(()=>flow.enter('zero'),/số/i);
  flow.enter('3');flow.skip();
  assert.deepEqual(flow.result(),{action:'accept',content:{ok:true,plan:'large',count:3}});
});

test('form validation keeps the current field pending, and secrets are never echoed in summaries',()=>{
  const flow=new ui.InputFlow({method:'item/tool/requestUserInput',params:{questions:[{id:'secret',header:'Mã',question:'Nhập mã',isSecret:true}]}});
  flow.enter('private-code');
  assert.doesNotMatch(flow.view(key).text,/private-code/);
  const bounded=new ui.InputFlow({method:'mcpServer/elicitation/request',params:{requestedSchema:{type:'object',required:['name'],properties:{name:{type:'string',minLength:2}}}}});
  assert.throws(()=>bounded.enter('x'),/2/);
  assert.equal(bounded.index,0);
  assert.throws(()=>bounded.skip(),/bắt buộc/i);
});

test('multi-select form buttons toggle values and only advance on Done',()=>{
  const flow=new ui.InputFlow({method:'mcpServer/elicitation/request',params:{requestedSchema:{type:'object',properties:{tags:{type:'array',minItems:1,items:{type:'string',enum:['a','b']}}}}}});
  flow.choose(0);flow.choose(1);flow.choose(0);
  assert.equal(flow.index,0);flow.next();
  assert.deepEqual(flow.result(),{action:'accept',content:{tags:['b']}});
});

test('submitting a button form responds exactly once; an expired request cannot be submitted',()=>{
  const responses=[];const bot=new Bridge({cwd:process.cwd()},{respond:(id,result)=>responses.push({id,result})});
  const flow=new ui.InputFlow(request);flow.choose(1);flow.enter('a link');
  const token=bot.approvals.add({...request,id:7,flow});
  assert.equal(bot.finishInput(token),true);
  assert.equal(bot.finishInput(token),false);
  assert.deepEqual(responses,[{id:7,result:{answers:{mode:{answers:['B']},link:{answers:['a link']}}}}]);
  const expired=bot.approvals.add({...request,id:8,flow});
  bot.approvals.pending.get(expired).expires=0;
  assert.equal(bot.finishInput(expired),false);assert.equal(responses.length,1);
});

test('legacy answer cannot bypass a button form validation and explicit submit',async()=>{
  const responses=[];const bot=new Bridge({cwd:process.cwd()},{respond:(id,result)=>responses.push(result)});
  const token=bot.approvals.add({...request,id:7,flow:new ui.InputFlow(request),deny:{answers:{}}});
  assert.equal(await bot.answer(token,true,'{}',true),false);
  assert.equal(responses.length,0);assert.ok(bot.approvals.pending.has(token));
});

test('titled MCP multi-select uses actual values while showing human labels',()=>{
  const flow=new ui.InputFlow({method:'mcpServer/elicitation/request',params:{requestedSchema:{type:'object',properties:{tags:{type:'array',items:{anyOf:[{const:'a',title:'Phương án A'},{const:'b',title:'Phương án B'}]}}}}}});
  assert.equal(flow.view(key).reply_markup.inline_keyboard[0][0].text,'Phương án A');
  flow.choose(1);flow.next();
  assert.deepEqual(flow.result(),{action:'accept',content:{tags:['b']}});
});
