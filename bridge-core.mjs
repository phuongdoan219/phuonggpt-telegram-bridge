import {randomBytes} from 'node:crypto';

export const telegramFileTool={type:'function',name:'telegram_send_file',description:'Send an existing local file to the authenticated Telegram owner, only when the user requests it. No local copy is made. Returns a successful message ID or an error.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}};

export function isConsentRequest(params) {
  if(params.mode==='url'||!params.message?.trim())return false;
  const schema=params.requestedSchema;
  const known=new Set(['type','properties','required','additionalProperties','title','description','$schema']);
  return schema?.type==='object'
    &&Object.keys(schema).every(key=>known.has(key))
    &&(!schema.properties||(typeof schema.properties==='object'&&!Array.isArray(schema.properties)&&Object.keys(schema.properties).length===0))
    &&(!schema.required||(Array.isArray(schema.required)&&schema.required.length===0));
}

export function approvalPreview(kind,params,item) {
  if (kind==='file') {
    if (!item?.changes?.length) return null;
    return JSON.stringify({reason:params.reason,grantRoot:params.grantRoot,changes:item.changes},null,2);
  }
  return JSON.stringify({command:params.command,cwd:params.cwd,reason:params.reason,additionalPermissions:params.additionalPermissions,networkApprovalContext:params.networkApprovalContext},null,2);
}

export class ReplyOutbox {
  constructor(items,persist,deliver) {this.items=items;this.persist=persist;this.deliver=deliver;this.current=null;}
  add(text) {this.items.push(...chunks(text));this.persist();}
  flush() {
    if (this.current) return this.current;
    this.current=this.run().finally(()=>{this.current=null;});
    return this.current;
  }
  async run() {
    while(this.items.length) {await this.deliver(this.items[0]);this.items.shift();this.persist();}
  }
}

export function authorized(message, owner) {
  return message?.chat?.type === 'private'
    && String(message.chat.id) === String(owner)
    && String(message.from?.id) === String(owner)
    && !message.from?.is_bot;
}

export function freshUpdate(update, offset) {
  return Number.isSafeInteger(update?.update_id) && update.update_id >= offset;
}

export function chunks(text, limit = 4000) {
  const result = [];
  let part = '';
  for (const char of String(text)) {
    if (part.length + char.length > limit) { result.push(part); part = ''; }
    part += char;
  }
  if (part) result.push(part);
  return result;
}

export class ApprovalStore {
  constructor(clock = Date.now) { this.clock = clock; this.pending = new Map(); }
  add(request) {
    const key = randomBytes(8).toString('hex');
    this.pending.set(key, {...request, expires: this.clock() + 600000});
    return key;
  }
  take(key) {
    const request = this.pending.get(key);
    this.pending.delete(key);
    return request && request.expires > this.clock() ? request : undefined;
  }
  clear() { this.pending.clear(); }
}
