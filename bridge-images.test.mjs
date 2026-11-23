import test from 'node:test';
import assert from 'node:assert/strict';
import * as images from './bridge-images.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64');
test('photo captions reach Codex with the largest photo as image input',async()=>{
  const selected=[];
  const input=await images.messageInput({caption:'Đọc nội dung ảnh',photo:[{file_id:'small',width:90,height:90},{file_id:'big',width:800,height:600}]},async file=>{selected.push(file.file_id);return 'data:image/png;base64,example';});
  assert.deepEqual(selected,['big']);
  assert.deepEqual(input,[{type:'text',text:'Đọc nội dung ảnh'},{type:'image',url:'data:image/png;base64,example'}]);
});
test('photos without captions work and image documents are supported, other documents are not',async()=>{
  assert.equal(images.imageAttachment({document:{file_id:'doc',mime_type:'image/png'}}).file_id,'doc');
  assert.equal(images.imageAttachment({document:{mime_type:'application/pdf'}}),null);
  const input=await images.messageInput({photo:[{file_id:'x'}]},async()=> 'data:image/png;base64,x');
  assert.equal(input.length,2);assert.ok(input[0].text.length>0);
  assert.deepEqual(await images.messageInput({text:'hello'},()=>{throw Error('must not download');}),[{type:'text',text:'hello'}]);
});
test('download resolves Telegram file IDs and uses byte-verified data URLs without credentials',async()=>{
  const calls=[];
  const url=await images.downloadImage({file_id:'x'},async(method,body)=>{calls.push({method,body});return {file_path:'photos/x.jpg',file_size:png.length};},async filePath=>{assert.equal(filePath,'photos/x.jpg');return new Response(png);});
  assert.deepEqual(calls,[{method:'getFile',body:{file_id:'x'}}]);
  assert.equal(url,'data:image/png;base64,'+png.toString('base64'));
});
test('oversize, invalid paths, non-image downloads and network failures abort image input',async()=>{
  await assert.rejects(images.downloadImage({file_id:'x',file_size:21*1024*1024},()=>{throw Error('should not call');},()=>{}),/20 MB/);
  await assert.rejects(images.downloadImage({file_id:'x'},async()=>({file_path:'../escape'}),()=>{}),/đường dẫn/i);
  await assert.rejects(images.downloadImage({file_id:'x'},async()=>({file_path:'photos/x'}),async()=>new Response('not an image')),/định dạng/i);
  await assert.rejects(images.messageInput({photo:[{file_id:'x'}]},async()=>{throw Error('download failed');}),/download failed/);
});
