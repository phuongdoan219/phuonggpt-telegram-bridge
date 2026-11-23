import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import readline from 'node:readline';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {authorized, freshUpdate, chunks, ApprovalStore, telegramFileTool, ReplyOutbox, approvalPreview,isConsentRequest} from './bridge-core.mjs';
import {listProjects,projectMenu,projectTarget,createLocalProject,projectBase} from './bridge-projects.mjs';
import {ChatPicker,listChats,resumeChat} from './bridge-chats.mjs';
import {approvalFeedback} from './bridge-approval-feedback.mjs';
import {imageAttachment,messageInput,downloadImage} from './bridge-images.mjs';
import {RememberedApprovals} from './bridge-remember.mjs';
import {voiceAttachment,voiceInput,downloadVoice,transcribeLocal} from './bridge-voice.mjs';
import {InputFlow} from './bridge-input.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const local = path.join(process.env.LOCALAPPDATA, 'CodexTelegram');
const statePath = path.join(local, 'bridge-state.json');
const healthPath = path.join(local, 'bridge-health.json');
let connection;
const windowsEnv={...process.env};
// Windows PowerShell must discover its own modules, not inherit PowerShell 7's.
for (const key of Object.keys(windowsEnv)) if (key.toLowerCase()==='psmodulepath') delete windowsEnv[key];
function loadConnection() {
  const script = `$ErrorActionPreference='Stop'; $c=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'CodexTelegram\\connection.json') -Raw|ConvertFrom-Json; $s=ConvertTo-SecureString $c.token; $p=New-Object System.Management.Automation.PSCredential('telegram',$s); @{token=$p.GetNetworkCredential().Password;chat_id=[string]$c.chat_id}|ConvertTo-Json -Compress`;
  try {
    const data = execFileSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command',script], {encoding:'utf8',windowsHide:true,env:windowsEnv,stdio:['ignore','pipe','pipe']});
    const value = JSON.parse(data.replace(/^\uFEFF/,''));
    if (!/^\d+$/.test(value.chat_id) || !value.token) throw Error();
    return value;
  } catch { throw new Error('Cannot load saved Telegram connection. Run setup again.'); }
}
function saveJson(file, value) {
  fs.mkdirSync(local, {recursive:true});
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value,null,2));
  fs.renameSync(temp,file);
}
function readState() {
  if (!fs.existsSync(statePath)) return {cwd:root,offset:null,threadId:null,inflight:false};
  return JSON.parse(fs.readFileSync(statePath,'utf8'));
}
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
function safeError(error) {
  return String(error?.message || error).replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g,'[TOKEN]').slice(0,1800);
}
async function telegram(method, body = {}) {
  try {
    const multipart = body instanceof FormData;
    const response = await fetch(`https://api.telegram.org/bot${connection.token}/${method}`, {
      method:'POST',headers:multipart?undefined:{'Content-Type':'application/json'},
      body:multipart?body:JSON.stringify(body),signal:AbortSignal.timeout(method==='getUpdates'?40000:120000)
    });
    const data = await response.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || response.status}`);
    return data.result;
  } catch (error) { throw new Error(safeError(error)); }
}
async function send(text, extra = {}) {
  let last;
  for (const part of chunks(text)) last=await telegram('sendMessage',{chat_id:connection.chat_id,text:part,...extra});
  return last;
}
async function sendFile(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error('File path must be absolute.');
  const info = fs.statSync(filePath);
  if (!info.isFile()) throw new Error('Path must identify a file.');
  if (info.size > 49 * 1024 * 1024) throw new Error('File exceeds the bridge upload limit of 49 MiB.');
  const form = new FormData();
  form.set('chat_id',connection.chat_id);
  form.set('document',new Blob([await fs.promises.readFile(filePath)]),path.basename(filePath));
  const result = await telegram('sendDocument',form);
  return result.message_id;
}

async function receiveImage(attachment,signal) {
  return downloadImage(attachment,telegram,async filePath=>{
    try {
      return await fetch(`https://api.telegram.org/file/bot${connection.token}/${filePath}`,{signal:AbortSignal.any([AbortSignal.timeout(120000),...(signal?[signal]:[])]),redirect:'error'});
    } catch {throw Error('Không tải được ảnh từ Telegram. Hãy gửi lại ảnh.');}
  });
}

async function receiveVoice(attachment,signal) {
  return downloadVoice(attachment,telegram,async filePath=>{
    try {return await fetch(`https://api.telegram.org/file/bot${connection.token}/${filePath}`,{signal:AbortSignal.any([AbortSignal.timeout(120000),...(signal?[signal]:[])]),redirect:'error'});}
    catch {throw Error('Không tải được tin nhắn thoại từ Telegram. Hãy gửi lại.');}
  });
}

export class CodexRpc {
  constructor(onEvent,onRequest,onClose) {
    this.nextId=0; this.pending=new Map();
    const findExecutable = String.raw`
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
      $command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue
      if ($command) { $command.Source; exit }
      $desktopExecutables = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\*\codex.exe'
      $executable = Get-ChildItem -Path $desktopExecutables -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
      if ($executable) { $executable.FullName }
    `;
    const executable = execFileSync('powershell.exe',['-NoProfile','-Command',findExecutable],{encoding:'utf8',windowsHide:true,env:windowsEnv}).trim();
    if (!executable) throw new Error('Cannot find codex.exe in PATH or the Codex desktop installation.');
    this.process=spawn(executable,['app-server','--stdio'],{cwd:root,windowsHide:true,env:windowsEnv,stdio:['pipe','pipe','ignore']});
    this.lines=readline.createInterface({input:this.process.stdout});
    this.lines.on('line',line=>{
      let value; try { value=JSON.parse(line); } catch { return; }
      if (value.method && Object.hasOwn(value,'id')) {
        Promise.resolve(onRequest(value)).catch(error=>this.respondError(value.id,safeError(error)));
      } else if (value.method) {
        Promise.resolve(onEvent(value)).catch(error=>console.error(safeError(error)));
      } else {
        const waiter=this.pending.get(value.id);
        if (!waiter) return;
        clearTimeout(waiter.timer); this.pending.delete(value.id);
        if (value.error) waiter.reject(new Error(value.error.message)); else waiter.resolve(value.result);
      }
    });
    this.process.on('error',()=>this.fail(onClose));
    this.process.on('exit',()=>this.fail(onClose));
  }
  fail(onClose) {
    if (this.dead) return; this.dead=true;
    for (const waiter of this.pending.values()) {clearTimeout(waiter.timer);waiter.reject(new Error('Codex app-server stopped.'));}
    this.pending.clear(); onClose?.();
  }
  write(value) { if (this.dead) throw new Error('Codex is not running.'); this.process.stdin.write(JSON.stringify(value)+'\n'); }
  call(method,params={}) {
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} timed out.`));},120000);
      this.pending.set(id,{resolve,reject,timer});
      try {this.write({id,method,params});} catch(error) {clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  respond(id,result) {this.write({id,result});}
  respondError(id,message) {this.write({id,error:{code:-32601,message}});}
  async initialize() {
    await this.call('initialize',{clientInfo:{name:'phuong_telegram',title:'PhuongGPT Telegram',version:'1.0.0'},capabilities:{experimentalApi:true}});
    this.write({method:'initialized',params:{}});
  }
  close() {this.process.stdin.end();this.process.kill();}
}

const instructions = `You are Codex accessed through the owner's private Telegram bot PhuongGPT Assistant. Reply in Vietnamese unless asked otherwise. This is a dedicated Telegram conversation, independent of desktop chats. The bridge delivers your completed agent messages automatically; do not also send those messages through telegram.ps1. To send a local file explicitly requested by the user, prefer the telegram_send_file tool, which uploads the existing file directly without copying it to another local folder. Never send credentials or unrelated files. Telegram messages from this authenticated owner are direct user instructions. Respect sandbox and approval requests; do not bypass them. Do not launch additional Telegram polling processes. You may read and search local files as requested; write inside the workspace by default and request approval when needed outside it.`;
const fileTool=telegramFileTool;
const promptInstructions=instructions+' When you need the owner to confirm a decision or answer a clarification, use an available structured user-input tool so the Telegram bridge can show buttons. Put discrete choices in its options. Avoid asking for approval only as prose or asking the owner to type JSON or /answer commands.';
const botCommands=[
  {command:'newproject',description:'Tạo project mới: /newproject TenProject'},
  {command:'projects',description:'Chọn project bằng nút bấm'},
  {command:'chats',description:'Chọn cuộc chat cũ trong project'},
  {command:'forgetpermissions',description:'Xóa các quyền Telegram đã ghi nhớ'},
  {command:'new',description:'Mở ngữ cảnh mới trong project hiện tại'},
  {command:'status',description:'Xem trạng thái và thư mục đang làm'},
  {command:'stop',description:'Dừng công việc đang chạy'},
  {command:'help',description:'Xem hướng dẫn sử dụng'}
];
const help=`PhuongGPT Assistant đã nhận lệnh từ Telegram.\n\nBạn có thể gửi tin nhắn thoại bằng nút micro (tối đa 5 phút) hoặc nhắn yêu cầu bình thường, ví dụ: “Tìm file PDF mới nhất trong Downloads rồi gửi cho tôi”.\n\n/newproject TenProject — tạo project trong ${projectBase}\n/projects — chọn project bằng nút bấm\n/chats — chọn chat cũ trong project\n/status — xem trạng thái\n/stop — dừng việc đang làm\n/new — bắt đầu ngữ cảnh mới\n/cd C:\\Ten thu muc — đổi thư mục làm việc\n/help — xem hướng dẫn\n\nChỉ tài khoản Telegram đã kết nối được ra lệnh. Máy phải bật, có mạng và cầu nối đang chạy.`;

export class Bridge {
  constructor(state,rpc) {this.state=state;this.rpc=rpc;this.approvals=new ApprovalStore();state.rememberedApprovals??=[];this.rememberedApprovals=new RememberedApprovals(state.rememberedApprovals);this.active=null;this.readyThread=false;this.outputs=[];this.fileChanges=new Map();this.events=Promise.resolve();state.outbox??=[];this.outbox=new ReplyOutbox(state.outbox,()=>this.save(),text=>send(text));}
  save() {saveJson(statePath,this.state);this.health();}
  async chats() {
    this.chatPicker??=new ChatPicker();
    const menu=this.chatPicker.open(await listChats(this.rpc,this.state),this.state,this.state.threadId);
    await send(menu.text,{reply_markup:menu.reply_markup});
  }
  async chatCallback(data) {
    if(this.active) {await send('Đang làm yêu cầu trước. Dùng /stop hoặc chờ xong rồi chọn chat.');return;}
    try {
      if(!this.chatPicker)throw Error('Danh sách đã cũ. Gọi /chats để chọn lại.');
      if(data.startsWith('chatpage:')) {
        const menu=this.chatPicker.page(data,this.state);
        await send(menu.text,{reply_markup:menu.reply_markup});return;
      }
      const {threadId}=this.chatPicker.resolve(data,this.state);
      if(threadId===this.state.threadId) {await send('Bạn đang ở cuộc chat này. Nhắn yêu cầu tiếp theo nhé.');return;}
      const thread=await resumeChat(this.rpc,this.state,threadId,{developerInstructions:promptInstructions});
      this.readyThread=true;this.outputs=[];this.save();
      await send('Đã mở lại cuộc chat: '+(thread.name||thread.preview||thread.id).replace(/\s+/g,' ').slice(0,180)+'\nThư mục: '+this.state.cwd+'\nBạn nhắn tiếp để tiếp tục với lịch sử cũ.');
    } catch(error) {await send('Không thể chọn chat: '+safeError(error));}
  }
  health() {saveJson(healthPath,{pid:process.pid,updatedAt:new Date().toISOString(),status:this.active?'busy':'listening',cwd:this.state.cwd,threadId:this.state.threadId});}
  async projects(page=0) {
    const menu=projectMenu(await listProjects(this.rpc),page);
    return send(menu.text,{reply_markup:menu.reply_markup});
  }
  async selectProject(projectId,rootIndex) {
    if (this.active) {await send('Đang làm yêu cầu trước. Dùng /stop hoặc chờ xong rồi chọn project.');return;}
    try {
      const {project}=await this.rpc.call('project/read',{projectId});
      const folder=projectTarget(project,rootIndex);
      this.state.cwd=fs.realpathSync(folder);
      this.state.projectId=project.id;
      this.chatPicker?.invalidate();
      this.state.threadId=null;this.readyThread=false;this.save();
      await send('Đã chọn project '+project.name+'.\nThư mục: '+this.state.cwd+'\nDùng /chats để tiếp tục chat cũ, hoặc nhắn yêu cầu để bắt đầu chat mới.');
    } catch(error) {await send('Không thể chuyển project: '+safeError(error));}
  }
  async createProject(name) {
    if (this.active) {await send('Đang làm yêu cầu trước. Dùng /stop hoặc chờ xong rồi tạo project.');return;}
    let result;
    try {
      result=await createLocalProject(this.rpc,name);
      this.chatPicker?.invalidate();
      this.state.cwd=result.folder;this.state.projectId=result.project.id;this.state.threadId=null;this.readyThread=false;this.save();
    } catch(error) {this.outbox.add('Không thể tạo project: '+safeError(error));this.outbox.flush().catch(error=>console.error(safeError(error)));return;}
    this.outbox.add((result.created?'Đã tạo project ':'Đã mở project có sẵn ')+result.project.name+'.\nThư mục: '+result.folder+'\nĐã chuyển sang ngữ cảnh mới. Bạn nhắn việc cần làm nhé.');
    this.outbox.flush().catch(error=>console.error(safeError(error)));
  }
  async thread() {
    if (this.readyThread) return;
    const params={cwd:this.state.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write',developerInstructions:promptInstructions,dynamicTools:[fileTool]};
    const {dynamicTools,...resumeParams}=params;
    const result=await this.rpc.call(this.state.threadId?'thread/resume':'thread/start',this.state.threadId?{...resumeParams,threadId:this.state.threadId,excludeTurns:true}:{...params,...(this.state.projectId?{projectId:this.state.projectId}:{})});
    this.state.threadId=result.thread.id;this.readyThread=true;this.save();
  }
  async event({method,params}) {
    if (params?.threadId && params.threadId!==this.state.threadId) return;
    if (method==='turn/started') {this.active=params.turn.id;this.health();}
    if (method==='item/started' && params.item.type==='fileChange') this.fileChanges.set(params.item.id,params.item);
    if (method==='item/completed' && params.item.type==='agentMessage') {
      if (params.item.text && params.item.phase!=='commentary') this.outputs.push(params.item.text);
    }
    if (method==='serverRequest/resolved') {
      for (const [key,request] of this.approvals.pending) if (String(request.id)===String(params.requestId)) {clearTimeout(request.timer);this.approvals.pending.delete(key);}
    }
    if (method==='turn/completed') {
      const result=this.outputs.join('\n\n'); this.outputs=[];
      try {
        if (result) this.outbox.add(result);
        if (params.turn.status==='failed') this.outbox.add('Codex gặp lỗi: '+safeError(params.turn.error?.message || 'Không hoàn thành yêu cầu.'));
        else if (params.turn.status==='interrupted') this.outbox.add('Đã dừng công việc.');
        else if (!result) this.outbox.add('Codex đã hoàn tất lượt xử lý.');
        await this.outbox.flush();
      } finally {
        this.active=null;this.state.inflight=false;
        for (const request of this.approvals.pending.values()) clearTimeout(request.timer);
        this.approvals.clear();this.fileChanges.clear();this.save();
      }
    }
  }
  async request(request) {
    const {method,params,id}=request;
    if (params.threadId!==this.state.threadId) {this.rpc.respondError(id,'Request is outside the Telegram conversation.');return;}
    if (method==='item/tool/call') {
      if (params.tool!=='telegram_send_file') {this.rpc.respondError(id,'Unsupported tool.');return;}
      try {
        const messageId=await sendFile(params.arguments.path);
        this.rpc.respond(id,{success:true,contentItems:[{type:'inputText',text:`Sent successfully. Telegram message ID: ${messageId}`}]});
      } catch(error) {this.rpc.respond(id,{success:false,contentItems:[{type:'inputText',text:safeError(error)}]});}
      return;
    }
    const command=method==='item/commandExecution/requestApproval';
    const file=method==='item/fileChange/requestApproval';
    const permissions=method==='item/permissions/requestApproval';
    const input=method==='item/tool/requestUserInput' || method==='tool/requestUserInput';
    const elicitation=method==='mcpServer/elicitation/request';
    const consent=elicitation&&isConsentRequest(params);
    if (!command && !file && !permissions && !input && !elicitation) {this.rpc.respondError(id,'Unsupported interactive request.');return;}
    if(this.rememberedApprovals.has(request,this.state,this.fileChanges.get(params.itemId))) {
      this.rpc.respond(id,elicitation?{action:'accept',content:{}}:permissions?{permissions:params.permissions,scope:'turn'}:{decision:'accept'});
      return;
    }
    const deny=permissions?{permissions:{},scope:'turn'}:elicitation?{action:'decline',content:null}:input?{answers:{}}:{decision:'decline'};
    const key=this.approvals.add({id,method,params,deny});
    const stored=this.approvals.pending.get(key);
    stored.timer=setTimeout(()=>{
      const expired=this.approvals.pending.get(key);
      if (!expired) return; this.approvals.pending.delete(key);
      this.rpc.respond(id,deny);
      send('Yêu cầu xác nhận đã hết hạn sau 10 phút.').catch(()=>{});
    },600000);
    try {
      if (input || (elicitation && params.mode!=='url'&&!consent)) {
        stored.flow=new InputFlow(request);
        await this.showInput(key,stored);
      } else {
        let detail=command?approvalPreview('command',{...params,cwd:params.cwd||this.state.cwd}):file?approvalPreview('file',params,this.fileChanges.get(params.itemId)):permissions?JSON.stringify(params.permissions,null,2):(params.serverName?'Nguồn công cụ: '+params.serverName+'\n':'')+params.message+(params.url?'\n'+params.url:'');
        if (!detail) {this.approvals.take(key);clearTimeout(stored.timer);this.rpc.respond(id,deny);await send('Chưa có chi tiết thay đổi file; đã từ chối để tránh xác nhận thiếu thông tin.');return;}
        const canRemember=!!this.rememberedApprovals.fingerprint(request,this.state,this.fileChanges.get(params.itemId));
        const buttons=elicitation&&params.mode==='url'?[
          ...(/^https?:\/\//i.test(params.url||'')?[[{text:'Mở trang xác nhận',url:params.url}]]:[]),
          [{text:'Đã hoàn tất / Tiếp tục',callback_data:'approve:'+key},{text:'Từ chối',callback_data:'deny:'+key}]
        ]:[
          ...(canRemember?[[{text:'Cho phép & ghi nhớ',callback_data:'remember:'+key}]]:[]),
          [{text:consent&&!canRemember?'Cho phép':'Cho phép lần này',callback_data:'approve:'+key},{text:'Từ chối',callback_data:'deny:'+key}]
        ];
        if (detail?.length>10000) {this.approvals.take(key);clearTimeout(stored.timer);this.rpc.respond(id,deny);await send('Chi tiết quyền quá dài để hiển thị; đã từ chối để tránh xác nhận thiếu thông tin.');return;}
        await send('Codex cần xác nhận:\n'+(detail||params.reason||method)+(params.reason?'\nLý do: '+params.reason:'')+(canRemember?'\n\n“Ghi nhớ” áp dụng khi đúng thao tác và phạm vi quyền này lặp lại trong project/thư mục hiện tại. Dùng /forgetpermissions để xóa quyền đã nhớ.':''),{reply_markup:{inline_keyboard:buttons}});
      }
    } catch(error) {this.approvals.take(key);clearTimeout(stored.timer);this.rpc.respond(id,deny);throw error;}
  }
  async answer(key,allowed,text,silent=false,remember=false) {
    const pending=this.approvals.pending.get(key);
    if(allowed&&pending?.flow&&pending.expires>this.approvals.clock()) {
      if(!silent)await this.showInput(key,pending);
      return false;
    }
    const request=this.approvals.take(key);
    if (!request) {if(!silent)await send('Yêu cầu này đã được trả lời hoặc hết hạn.');return false;}
    clearTimeout(request.timer);
    let result=request.deny;
    if (allowed) {
      if (request.method.includes('permissions/')) result={permissions:request.params.permissions,scope:'turn'};
      else if (request.method.includes('requestUserInput')) {
        const questions=request.params.questions;
        if (questions.length===1) result={answers:{[questions[0].id]:{answers:[text]}}};
        else {try {result=JSON.parse(text);} catch {await send('JSON không hợp lệ; yêu cầu đã được từ chối.');}}
      } else if (request.method==='mcpServer/elicitation/request') {
        try {result={action:'accept',content:request.params.mode==='url'?null:isConsentRequest(request.params)?{}:JSON.parse(text)};} catch {await send('JSON không hợp lệ; yêu cầu đã được từ chối.');}
      } else result={decision:'accept'};
    }
    this.rpc.respond(request.id,result);
    const previousLength=this.state.rememberedApprovals.length;
    if(allowed&&remember&&this.rememberedApprovals.remember(request,this.state,this.fileChanges.get(request.params.itemId))) {
      try {this.save();return {remembered:true};}
      catch {
        this.state.rememberedApprovals.splice(previousLength);
        return {rememberFailed:true};
      }
    }
    return true;
  }
  finishInput(key) {
    const request=this.approvals.pending.get(key);
    if(!request?.flow||request.expires<=this.approvals.clock()||(request.params.threadId&&request.params.threadId!==this.state.threadId))return false;
    const result=request.flow.result();
    if(!this.approvals.take(key))return false;
    clearTimeout(request.timer);this.rpc.respond(request.id,result);return true;
  }
  async showInput(key,request,message) {
    const view=request.flow.view(key);
    if(message) {
      try {await telegram('editMessageText',{chat_id:message.chat.id,message_id:message.message_id,...view});return;}
      catch {/* Send a new actionable prompt if Telegram cannot edit the old one. */}
    }
    await send(view.text,{reply_markup:view.reply_markup});
  }
  async inputCallback(callback) {
    await telegram('answerCallbackQuery',{callback_query_id:callback.id}).catch(()=>{});
    const match=/^input:([a-f0-9]{16}):(\d+):(pick\d+|page\d+|text|next|skip|submit|reset)$/.exec(callback.data||'');
    if(!match)return;
    const [,key,index,action]=match;const request=this.approvals.pending.get(key);
    if(!request?.flow||request.expires<=this.approvals.clock()||request.flow.index!==Number(index)) {
      await send('Câu hỏi này đã được trả lời hoặc hết hạn. Hãy dùng tin nhắn mới nhất.');return;
    }
    try {
      const flow=request.flow;
      if(action==='text') {
        const field=flow.current();
        const prompt=await send('✍️ Trả lời cho câu hỏi của Codex:\n'+field.question+'\n\nNhập nội dung vào ô trả lời tin nhắn này. Không cần gõ lệnh.',{reply_markup:{force_reply:true,selective:true,input_field_placeholder:'Nhập câu trả lời'}});
        this.inputReplies??=new Map();
        while(this.inputReplies.size>=300)this.inputReplies.delete(this.inputReplies.keys().next().value);
        this.inputReplies.set(prompt.message_id,{key,index:flow.index});request.replyPrompt=prompt.message_id;
        return;
      }
      if(action==='submit') {
        if(!this.finishInput(key))throw Error('Yêu cầu đã hết hạn hoặc không còn ở chat này.');
        await telegram('editMessageText',{chat_id:callback.message.chat.id,message_id:callback.message.message_id,text:'✅ Đã gửi câu trả lời tới Codex.',reply_markup:{inline_keyboard:[]}}).catch(()=>send('✅ Đã gửi câu trả lời tới Codex.'));
        return;
      }
      if(action.startsWith('pick'))flow.choose(Number(action.slice(4)));
      else if(action.startsWith('page'))flow.page=Math.max(0,Math.min(Math.ceil(flow.current().options.length/8)-1,Number(action.slice(4))));
      else if(action==='next')flow.next();
      else if(action==='skip')flow.skip();
      else if(action==='reset')flow.reset();
      await this.showInput(key,request,callback.message);
    } catch(error) {await send(safeError(error));}
  }
  async inputReply(message) {
    const promptId=message.reply_to_message?.message_id;
    const target=this.inputReplies?.get(promptId);
    if(!target) {
      if(message.reply_to_message?.from?.is_bot&&message.reply_to_message.text?.startsWith('✍️ Trả lời cho câu hỏi của Codex:')) {
        await send('Câu hỏi này đã hết hạn hoặc bot vừa khởi động lại. Hãy gọi lại yêu cầu.');return true;
      }
      return false;
    }
    const request=this.approvals.pending.get(target.key);
    if(!request?.flow||request.expires<=this.approvals.clock()||request.flow.index!==target.index||request.replyPrompt!==promptId) {
      await send('Câu hỏi này đã được trả lời hoặc hết hạn. Hãy dùng tin nhắn mới nhất.');return true;
    }
    try {
      if(!message.text?.trim())throw Error('Bạn hãy nhập câu trả lời bằng chữ vào tin nhắn này.');
      request.flow.enter(message.text);
      request.replyPrompt=null;
      await this.showInput(target.key,request);
    } catch(error) {await send(safeError(error));}
    return true;
  }
  async update(update) {
    if (!freshUpdate(update,this.state.offset)) return;
    this.state.offset=update.update_id+1;this.save();
    if (update.callback_query) {
      const callback=update.callback_query;
      if (!authorized({...callback.message,from:callback.from},connection.chat_id)) return;
      if((callback.data||'').startsWith('input:')){await this.inputCallback(callback);return;}
      const approval=/^(approve|remember|deny):([a-f0-9]{16})$/.exec(callback.data||'');
      if(approval) {
        const allowed=approval[1]!=='deny';
        await approvalFeedback(callback,allowed,()=>this.answer(approval[2],allowed,undefined,true,approval[1]==='remember'),telegram);
        return;
      }
      await telegram('answerCallbackQuery',{callback_query_id:callback.id});
      if(/^(chat|chatpage):/.test(callback.data||'')) {await this.chatCallback(callback.data);return;}
      const page=/^projpage:(\d+)$/.exec(callback.data||'');
      if (page) {await this.projects(Number(page[1]));return;}
      const project=/^proj:([a-zA-Z0-9-]+):(\d+)$/.exec(callback.data||'');
      if (project) {await this.selectProject(project[1],Number(project[2]));return;}
      return;
    }
    const message=update.message;
    if (!authorized(message,connection.chat_id)) return;
    const text=message.text?.trim()||'';
    const hasImage=!!imageAttachment(message);
    const hasVoice=!!voiceAttachment(message);
    if (!text&&!hasImage&&!hasVoice) {await send('Bạn có thể gửi văn bản, tin nhắn thoại hoặc ảnh kèm chú thích việc cần làm.');return;}
    if (/^\/(start|help)(@\w+)?$/.test(text)) {await send(help);return;}
    if(/^\/forgetpermissions(@\w+)?$/.test(text)) {
      this.rememberedApprovals.clear();this.save();await send('Đã xóa các quyền đã ghi nhớ trên Telegram. Các thao tác cần quyền sẽ hỏi lại.');return;
    }
    if (/^\/projects(@\w+)?$/.test(text)) {
      try {await this.projects();} catch(error) {await send('Không lấy được danh sách project: '+safeError(error));}
      return;
    }
    if (/^\/chats(@\w+)?$/.test(text)) {
      if(this.active) {await send('Đang làm yêu cầu trước. Dùng /stop hoặc chờ xong rồi chọn chat.');return;}
      try {await this.chats();} catch(error) {await send('Không lấy được danh sách chat: '+safeError(error));}
      return;
    }
    if (text==='/status') {await send((this.active?'Đang xử lý yêu cầu.':'Đang chờ lệnh.')+'\nThư mục: '+this.state.cwd+'\nCodex: '+(this.rpc.dead?'đã dừng':'đã kết nối'));return;}
    if (text==='/stop') {
      const stopping=await this.interrupt();
      if(stopping==='preparing')await send('Đang dừng bước chuẩn bị yêu cầu.');
      else if(!stopping)await send('Hiện không có việc đang chạy.');
      return;
    }
    if(await this.inputReply(message))return;
    const answer=/^\/answer ([a-f0-9]{16})\s+([\s\S]+)$/.exec(text);
    if (answer) {await this.answer(answer[1],true,answer[2]);return;}
    if (this.active) {await send('Đang làm yêu cầu trước. Dùng /stop để dừng hoặc chờ kết quả rồi gửi lệnh tiếp.');return;}
    const create=/^\/newproject(?:@\w+)?(?:\s+([\s\S]+))?$/.exec(text);
    if (create) {
      if (!create[1]) {await send('Nhập /newproject kèm tên, ví dụ: /newproject Demo mới\nThư mục mặc định: '+projectBase);return;}
      await this.createProject(create[1].trim().replace(/^"(.*)"$/,'$1'));return;
    }
    if (text==='/new' || text.startsWith('/cd ')) {
      if (text.startsWith('/cd ')) {
        const folder=text.slice(4).trim().replace(/^"(.*)"$/,'$1');
        if (!path.isAbsolute(folder) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {await send('Thư mục không tồn tại. Nhập /cd kèm đường dẫn đầy đủ.');return;}
        this.state.cwd=fs.realpathSync(folder);
        this.state.projectId=null;
        this.chatPicker?.invalidate();
      }
      this.state.threadId=null;this.readyThread=false;this.save();
      await send('Đã bắt đầu ngữ cảnh mới.\nThư mục: '+this.state.cwd);return;
    }
    if (text.startsWith('/')) {await send('Lệnh chưa được hỗ trợ. Dùng /help hoặc nhắn yêu cầu bình thường.');return;}
    if (this.rpc.dead) {await send('Codex đã ngừng chạy. Cần khởi động lại cầu nối trên máy.');return;}
    this.active='starting';this.outputs=[];this.state.inflight=true;this.save();
    const controller=new AbortController();this.preparingController=controller;
    this.runWork(message,hasImage,hasVoice,controller).catch(error=>console.error(safeError(error)));
  }
  async interrupt() {
    if(this.preparingController){this.preparingController.abort();return 'preparing';}
    if(this.active&&this.active!=='starting'){
      await this.rpc.call('turn/interrupt',{threadId:this.state.threadId,turnId:this.active});return 'turn';
    }
    return false;
  }
  async runWork(message,hasImage,hasVoice,controller) {
    const {signal}=controller;
    try {
      this.outbox.add(hasVoice?'Đã nhận tin nhắn thoại, mình đang chuyển giọng nói thành chữ…':hasImage?'Đã nhận ảnh, Codex đang tải và xem ảnh…':'Đã nhận, Codex đang xử lý…');
      this.outbox.flush().catch(error=>console.error(safeError(error)));
      await this.thread();
      signal.throwIfAborted();
      let input;
      if(hasVoice) {
        const voice=await voiceInput(message,attachment=>receiveVoice(attachment,signal),bytes=>transcribeLocal(bytes,{signal}));
        signal.throwIfAborted();
        this.outbox.add('🎙 Mình nghe được:\n'+voice.transcript+'\n\nCodex đang xử lý yêu cầu này.');
        this.outbox.flush().catch(error=>console.error(safeError(error)));
        input=voice.input;
      } else input=await messageInput(message,attachment=>receiveImage(attachment,signal));
      signal.throwIfAborted();
      const result=await this.rpc.call('turn/start',{threadId:this.state.threadId,input,approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite',writableRoots:[this.state.cwd],networkAccess:false}});
      this.active=result.turn.id;this.health();
      if(signal.aborted)await this.rpc.call('turn/interrupt',{threadId:this.state.threadId,turnId:result.turn.id});
    } catch(error) {this.active=null;this.state.inflight=false;this.save();this.outbox.add(signal.aborted?'Đã dừng yêu cầu trước khi xử lý.':'Không thể bắt đầu: '+safeError(error));this.outbox.flush().catch(error=>console.error(safeError(error)));}
    finally {if(this.preparingController===controller)this.preparingController=null;}
  }
}

async function main() {
  connection=loadConnection();
  if (process.argv.includes('--projects-menu')) {
    const rpc=new CodexRpc(()=>{},request=>rpc.respondError(request.id,'Project menu cannot execute actions.'));
    try {
      await rpc.initialize();
      const projects=await listProjects(rpc);
      const menu=projectMenu(projects);
      await telegram('setMyCommands',{scope:{type:'chat',chat_id:Number(connection.chat_id)},commands:botCommands});
      const result=await send(menu.text,{reply_markup:menu.reply_markup});
      console.log(JSON.stringify({projects:projects.length,messageId:result.message_id}));
    } finally {rpc.close();}
    return;
  }
  if (process.argv.includes('--smoke')) {
    let threadId;
    let finish;
    const done=new Promise(resolve=>{finish=resolve;});
    const rpc=new CodexRpc(event=>{
      if (event.method==='item/completed' && event.params.item.type==='agentMessage') console.log('Codex reply: '+event.params.item.text);
      if (event.method==='turn/completed') finish(event.params.turn);
    },request=>rpc.respondError(request.id,'Smoke check does not approve actions.'));
    try {
      await rpc.initialize();
      const started=await rpc.call('thread/start',{cwd:root,approvalPolicy:'on-request',sandbox:'workspace-write',dynamicTools:[fileTool],ephemeral:true,developerInstructions:'This is a read-only integration smoke check. Do not edit files, send messages, or run commands.'});
      threadId=started.thread.id;
      await rpc.call('turn/start',{threadId,input:[{type:'text',text:'Reply with exactly TELEGRAM_BRIDGE_OK. Do not use tools.'}]});
      const timeout=setTimeout(()=>finish({status:'timeout'}),90000);
      const result=await done;clearTimeout(timeout);
      console.log('Turn status: '+result.status);
      if (result.status!=='completed') throw new Error(result.error?.message || 'Smoke turn failed.');
    } finally {rpc.close();}
    return;
  }
  if (process.argv.includes('--check')) {
    const rpc=new CodexRpc(()=>{},request=>rpc.respondError(request.id,'Check mode does not approve actions.'));
    try {
      await rpc.initialize();
      const account=await rpc.call('account/read',{});
      const bot=await telegram('getMe');
      const readiness=await rpc.call('windowsSandbox/readiness',{});
      console.log(JSON.stringify({codex:'initialized',signedIn:!!account.account,bot:bot.username,sandbox:readiness}));
    } finally {rpc.close();}
    return;
  }
  const singleton=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{singleton.once('error',()=>reject(new Error('Bridge is already running or local port 47339 is in use.')));singleton.listen(47339,'127.0.0.1',resolve);});
  const state=readState();
  let bridge;
  const rpc=new CodexRpc(event=>{
    bridge.events=bridge.events.then(()=>bridge.event(event)).catch(error=>console.error(safeError(error)));
  },async request=>{await bridge.events;return bridge.request(request);},()=>{
    send('Kết nối Codex đã dừng. Hãy chạy START-TELEGRAM-BRIDGE.cmd trên máy để khởi động lại.').catch(()=>{}).finally(()=>process.exit(1));
  });
  bridge=new Bridge(state,rpc);
  await rpc.initialize();
  const account=await rpc.call('account/read',{});
  if (!account.account) throw new Error('Codex is not signed in. Sign in to Codex on this computer first.');
  await telegram('setMyCommands',{scope:{type:'chat',chat_id:Number(connection.chat_id)},commands:botCommands}).catch(error=>console.error(safeError(error)));
  if (state.offset===null) {
    const backlog=await telegram('getUpdates',{offset:-1,timeout:0,allowed_updates:['message','callback_query']});
    state.offset=backlog.length?backlog.at(-1).update_id+1:0;
  }
  const interrupted=state.inflight;state.inflight=false;bridge.save();
  bridge.outbox.add((interrupted?'Cầu nối vừa khởi động lại. Yêu cầu trước có thể chưa hoàn tất; tôi không tự chạy lại để tránh thao tác trùng.\n\n':'')+'PhuongGPT Assistant đã sẵn sàng nhận lệnh.\nNhắn yêu cầu tại đây; dùng /help để xem hướng dẫn.');
  await bridge.outbox.flush().catch(error=>console.error(safeError(error)));
  console.log('Bridge ready.');
  setInterval(()=>bridge.health(),15000).unref();
  const shutdown=()=>{rpc.close();singleton.close();process.exit(0);};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  while (true) {
    try {
      await bridge.outbox.flush();
      const updates=await telegram('getUpdates',{offset:state.offset,timeout:25,allowed_updates:['message','callback_query']});
      for (const update of updates) {try {await bridge.update(update);} catch(error) {console.error(safeError(error));}}
    } catch(error) {console.error(safeError(error));await delay(5000);}
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(safeError(error));process.exit(1);});
}
