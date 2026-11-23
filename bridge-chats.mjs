import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {isDirectory} from './bridge-projects.mjs';

const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const scopeKey=s=>JSON.stringify([s.projectId||null,path.resolve(s.cwd).toLowerCase()]);
const belongs=(t,s)=>!t.parentThreadId&&(s.projectId&&t.projectId===s.projectId||!t.projectId&&samePath(t.cwd,s.cwd));
const title=t=>(t.name||t.preview||'Cuộc chat chưa có tiêu đề').replace(/\s+/g,' ').trim();

export async function listChats(rpc,scope) {
  const found=new Map();
  const filters=scope.projectId?[{projectId:scope.projectId},{projectId:null,cwd:scope.cwd}]:[{cwd:scope.cwd}];
  for(const filter of filters) {
    let cursor;const seen=new Set();
    do {
      const page=await rpc.call('thread/list',{...filter,limit:100,archived:false,sortKey:'updated_at',sortDirection:'desc',...(cursor?{cursor}:{})});
      for(const thread of page.data) if(belongs(thread,scope)) found.set(thread.id,thread);
      cursor=page.nextCursor;
      if(cursor&&seen.has(cursor))throw Error('Codex trả lại trang chat bị lặp.');
      if(cursor)seen.add(cursor);
    } while(cursor);
  }
  return [...found.values()].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
}

export class ChatPicker {
  invalidate() {this.snapshot=null;}
  open(threads,scope,currentId) {
    this.snapshot={threads,key:scopeKey(scope),nonce:randomBytes(6).toString('hex'),currentId};
    return this.render(0);
  }
  decode(data,scope,kind) {
    const match=/^(chat|chatpage):([a-f0-9]{12}):(\d+)$/.exec(data);
    const s=this.snapshot;
    if(!match||match[1]!==kind||!s||s.nonce!==match[2]||s.key!==scopeKey(scope))throw Error('Danh sách đã cũ. Gọi /chats để chọn lại.');
    return Number(match[3]);
  }
  resolve(data,scope) {
    const index=this.decode(data,scope,'chat');
    const thread=this.snapshot.threads[index];
    if(!thread)throw Error('Chat không còn trong danh sách. Gọi /chats lại.');
    return {threadId:thread.id};
  }
  page(data,scope) {return this.render(this.decode(data,scope,'chatpage'));}
  render(page) {
    const {threads,nonce,currentId}=this.snapshot;
    if(!threads.length)return {text:'Chưa có cuộc chat đã lưu trong project/thư mục này. Nhắn yêu cầu để bắt đầu chat mới hoặc dùng /projects để chọn project khác.',reply_markup:{inline_keyboard:[]}};
    const pages=Math.ceil(threads.length/8);page=Math.max(0,Math.min(pages-1,page));
    const rows=threads.slice(page*8,page*8+8).map((t,i)=>{
      const date=t.updatedAt?new Date(t.updatedAt*1000).toLocaleDateString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}):'';
      return [{text:(t.id===currentId?'✓ ':'')+[...title(t)].slice(0,48).join('')+(date?' · '+date:''),callback_data:`chat:${nonce}:${page*8+i}`}];
    });
    const nav=[];
    if(page>0)nav.push({text:'‹ Trang trước',callback_data:`chatpage:${nonce}:${page-1}`});
    if(page+1<pages)nav.push({text:'Trang sau ›',callback_data:`chatpage:${nonce}:${page+1}`});
    if(nav.length)rows.push(nav);
    return {text:`Chọn cuộc chat để tiếp tục (${page+1}/${pages}):\nMới cập nhật trước. ✓ = chat đang chọn.`,reply_markup:{inline_keyboard:rows}};
  }
}

export async function resumeChat(rpc,state,threadId,overrides={},available=isDirectory) {
  const {thread}=await rpc.call('thread/read',{threadId,includeTurns:false});
  if(thread.id!==threadId||!belongs(thread,state))throw Error('Chat không thuộc project đang chọn. Gọi /chats lại.');
  if(thread.status?.type==='active')throw Error('Chat đang chạy. Hãy chờ chat hoàn tất rồi chọn lại.');
  if(thread.canAcceptDirectInput===false)throw Error('Chat này không nhận tin nhắn trực tiếp.');
  if(!available(thread.cwd))throw Error('Không truy cập được thư mục của cuộc chat.');
  const result=await rpc.call('thread/resume',{...overrides,threadId,cwd:thread.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write',excludeTurns:true});
  if(result.thread.id!==threadId)throw Error('Codex không khôi phục đúng cuộc chat.');
  state.threadId=threadId;state.cwd=thread.cwd;
  return result.thread;
}
