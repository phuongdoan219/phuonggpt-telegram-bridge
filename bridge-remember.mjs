import {createHash} from 'node:crypto';
import {isConsentRequest} from './bridge-core.mjs';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])])):value;
const volatile=new Set(['threadId','turnId','itemId','approvalId','startedAtMs','reason']);

export class RememberedApprovals {
  constructor(saved) {this.saved=saved;}
  fingerprint(request,scope,item) {
    const {method,params}=request;
    if(method==='item/commandExecution/requestApproval') {
      if(typeof params.command!=='string'||!params.command.trim()||(params.kind&&params.kind!=='command'))return null;
    } else if(method==='item/fileChange/requestApproval') {
      if(!item?.changes?.length)return null;
    } else if(method==='item/permissions/requestApproval') {
      if(!params.permissions||!Object.keys(params.permissions).length)return null;
    } else if(method==='mcpServer/elicitation/request') {
      // Only this explicit application-use consent is reusable. Never infer
      // permission for arbitrary empty forms such as purchases or publishing.
      if(!params.serverName||params.message!=='Allow Codex to use Google Chrome?'||!isConsentRequest(params))return null;
    } else return null;
    const details=Object.fromEntries(Object.entries(params).filter(([key])=>!volatile.has(key)));
    // Keep every non-volatile field, including unknown future permission fields.
    const content={version:1,method,projectId:scope.projectId||null,cwd:scope.cwd,details,
      ...(method==='item/fileChange/requestApproval'?{changes:item.changes}:{})};
    return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
  }
  has(request,scope,item) {const key=this.fingerprint(request,scope,item);return !!key&&this.saved.includes(key);}
  remember(request,scope,item) {
    const key=this.fingerprint(request,scope,item);
    if(!key)return false;
    if(!this.saved.includes(key))this.saved.push(key);
    return true;
  }
  clear() {this.saved.splice(0);}
}
