import test from 'node:test';
import assert from 'node:assert/strict';
import * as voice from './bridge-voice.mjs';
import {Bridge} from './telegram-bridge.mjs';

test('voice and audio messages produce a Vietnamese transcript as ordinary Codex input',async()=>{
  const message={voice:{file_id:'v',duration:12,mime_type:'audio/ogg'}};
  assert.equal(voice.voiceAttachment(message).file_id,'v');
  const result=await voice.voiceInput(message,async attachment=>{assert.equal(attachment.file_id,'v');return Buffer.from('audio');},async bytes=>{assert.equal(bytes.toString(),'audio');return 'Tìm báo cáo mới nhất';});
  assert.deepEqual(result,{transcript:'Tìm báo cáo mới nhất',input:[{type:'text',text:'Tìm báo cáo mới nhất'}]});
  assert.equal(voice.voiceAttachment({audio:{file_id:'a',mime_type:'audio/mpeg'}}).file_id,'a');
  assert.equal(voice.voiceAttachment({text:'hello'}),null);
});
test('long recordings and empty transcripts never become Codex instructions',async()=>{
  await assert.rejects(voice.voiceInput({voice:{file_id:'v',duration:301}},()=>{throw Error('must not download');},()=>{}),/5 phút/);
  await assert.rejects(voice.voiceInput({voice:{file_id:'v',duration:3}},async()=>Buffer.from('audio'),async()=> '  '),/không nghe rõ/i);
});
test('voice downloads are bounded and validate the Telegram file path',async()=>{
  assert.equal((await voice.downloadVoice({file_id:'v'},async()=>({file_path:'voice/file.oga'}),async()=>new Response(Buffer.from('OggS')))).toString(),'OggS');
  await assert.rejects(voice.downloadVoice({file_id:'v',file_size:21*1024*1024},()=>{},()=>{}),/20 MB/);
  await assert.rejects(voice.downloadVoice({file_id:'v'},async()=>({file_path:'../file'}),()=>{}),/đường dẫn/i);
});
test('local transcription propagates worker failures instead of inventing a transcript',async()=>{
  await assert.rejects(voice.voiceInput({voice:{file_id:'v'}},async()=>Buffer.from('audio'),async()=>{throw Error('worker failed');}),/worker failed/);
});

test('stop during preparation cancels before a Codex turn can start',async()=>{
  const calls=[];const bot=new Bridge({cwd:process.cwd()},{call:async(method)=>calls.push(method)});
  bot.save=()=>{};bot.health=()=>{};bot.outbox={add:()=>{},flush:async()=>{}};
  const controller=new AbortController();bot.preparingController=controller;bot.active='starting';
  bot.thread=async()=>{await bot.interrupt();};
  await bot.runWork({text:'do work'},false,false,controller);
  assert.equal(controller.signal.aborted,true);
  assert.deepEqual(calls,[]);
});

test('already cancelled transcription never starts a Python process',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(voice.transcribeLocal(Buffer.from('audio'),{signal:controller.signal}),/hủy|dừng/i);
});
