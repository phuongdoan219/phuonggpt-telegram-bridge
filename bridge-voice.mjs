import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const maxBytes=20*1024*1024;
export function voiceAttachment(message) {return message.voice||message.audio||null;}

export async function voiceInput(message,download,transcribe=transcribeLocal) {
  const attachment=voiceAttachment(message);
  if(!attachment)throw Error('Không có tin nhắn thoại.');
  if(attachment.duration>300)throw Error('Tin nhắn thoại tối đa 5 phút. Hãy chia thành đoạn ngắn hơn.');
  const bytes=await download(attachment);
  const transcript=(await transcribe(bytes)).trim();
  if(!transcript)throw Error('Mình không nghe rõ lời nói. Bạn hãy thu lại hoặc nhắn bằng chữ.');
  if(transcript.length>20000)throw Error('Nội dung nhận dạng quá dài. Hãy gửi đoạn ngắn hơn.');
  return {transcript,input:[{type:'text',text:transcript}]};
}

export async function downloadVoice(attachment,telegram,download) {
  const tooLarge=()=>new Error('Tin nhắn thoại vượt giới hạn 20 MB. Hãy gửi đoạn ngắn hơn.');
  if(attachment.file_size>maxBytes)throw tooLarge();
  const file=await telegram('getFile',{file_id:attachment.file_id});
  if(file.file_size>maxBytes)throw tooLarge();
  if(!file.file_path||! /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(file.file_path)||file.file_path.split('/').some(p=>p==='.'||p==='..'))throw Error('Telegram trả về đường dẫn âm thanh không hợp lệ.');
  const response=await download(file.file_path);
  if(!response.ok||!response.body)throw Error('Không tải được tin nhắn thoại từ Telegram.');
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body.cancel();throw tooLarge();}
  const reader=response.body.getReader();const parts=[];let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw tooLarge();}
      parts.push(Buffer.from(value));
    }
  } finally {reader.releaseLock();}
  if(!size)throw Error('Tin nhắn thoại không có dữ liệu âm thanh.');
  return Buffer.concat(parts);
}

export function transcribeLocal(bytes,{signal}={}) {
  if(signal?.aborted)return Promise.reject(Error('Đã hủy nhận giọng nói.'));
  const python=process.env.CODEX_VOICE_PYTHON||path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe');
  if(!fs.existsSync(python))return Promise.reject(Error('Chưa tìm thấy Python cho nhận giọng nói trên máy.'));
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-B',path.join(root,'voice-transcribe.py')],{cwd:root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',HF_HUB_OFFLINE:'1'},stdio:['pipe','pipe','pipe']});
    let output='';let settled=false;
    const abort=()=>{child.kill();finish(Error('Đã hủy nhận giọng nói.'));};
    const finish=(error,text)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(text);};
    const timer=setTimeout(()=>{child.kill();finish(Error('Nhận giọng nói quá lâu. Hãy gửi đoạn ngắn hơn.'));},180000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',data=>{output+=data;if(output.length>100000){child.kill();finish(Error('Kết quả nhận giọng nói không hợp lệ.'));}});
    child.stderr.resume();
    child.on('error',()=>finish(Error('Không khởi động được bộ nhận giọng nói.')));
    signal?.addEventListener('abort',abort,{once:true});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      try {
        const value=JSON.parse(output);
        if(code!==0||typeof value.text!=='string')throw Error();
        finish(null,value.text);
      } catch {finish(Error('Không nhận dạng được tin nhắn thoại. Hãy thu lại đoạn ngắn, rõ tiếng.'));}
    });
    child.stdin.end(bytes);
  });
}
