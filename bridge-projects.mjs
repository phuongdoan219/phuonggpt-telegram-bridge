import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const legacyProjectBase='D:\\workspace';
export const projectBase=path.resolve(process.env.CODEX_TELEGRAM_WORKSPACE ||
  (isDirectory(legacyProjectBase) ? legacyProjectBase : path.join(os.homedir(),'workspace')));
const samePath=(left,right)=>path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase();

export function newProjectPath(name,base=projectBase) {
  if (typeof name!=='string' || !name || [...name].length>80 || name!==name.trim()
      || /[\x00-\x1F<>:"/\\|?*]/.test(name) || /[. ]$/.test(name)
      || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error('Tên project không hợp lệ. Dùng tên tối đa 80 ký tự, không nhập đường dẫn hoặc ký tự cấm của Windows.');
  }
  const folder=path.resolve(base,name);
  if (!samePath(path.dirname(folder),base)) throw new Error('Tên project phải nằm trong thư mục workspace.');
  return folder;
}

export async function createLocalProject(rpc,name,base=projectBase) {
  const folder=newProjectPath(name,base);
  const projects=await listProjects(rpc);
  const existing=projects.find(project=>project.roots.some(root=>samePath(root.path,folder)));
  if (existing) {
    if (!isDirectory(folder)) throw new Error('Project đã có nhưng không truy cập được thư mục '+folder+'.');
    if (!samePath(fs.realpathSync(folder),folder)) throw new Error('Thư mục project là liên kết đến vị trí khác; hãy dùng /projects để chọn.');
    return {project:existing,folder:fs.realpathSync(folder),created:false};
  }
  if (projects.some(project=>project.name.toLowerCase()===name.toLowerCase())) throw new Error('Đã có project trùng tên ở vị trí khác. Dùng /projects để chọn hoặc đặt tên mới.');
  fs.mkdirSync(base,{recursive:true});
  if (!samePath(fs.realpathSync(base),base)) throw new Error('Thư mục workspace là liên kết đến vị trí khác. Chưa tạo project.');
  if (fs.existsSync(folder) && (!isDirectory(folder) || !samePath(fs.realpathSync(folder),folder))) throw new Error('Đường dẫn đã có file hoặc liên kết đến vị trí khác. Hãy chọn tên khác.');
  fs.mkdirSync(folder,{recursive:true});
  const idempotencyKey='telegram-project-'+createHash('sha256').update(folder.toLowerCase()).digest('hex');
  let result;
  try {result=await rpc.call('project/create',{name,roots:[{path:fs.realpathSync(folder)}],idempotencyKey});}
  catch(error) {throw new Error('Thư mục đã có tại '+folder+' nhưng đăng ký Codex chưa thành công: '+error.message+'. Bạn có thể thử lại cùng lệnh.');}
  if (!result.project?.roots?.some(root=>samePath(root.path,folder))) throw new Error('Codex chưa trả về đúng thư mục project. Hãy kiểm tra /projects.');
  return {project:result.project,folder:fs.realpathSync(folder),created:true};
}

export function isDirectory(folder) {
  try {return fs.statSync(folder).isDirectory();} catch {return false;}
}

export async function listProjects(rpc) {
  const projects=[];const cursors=new Set();let cursor;
  do {
    const page=await rpc.call('project/list',{limit:100,...(cursor?{cursor}:{})});
    projects.push(...page.data);
    cursor=page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Codex trả lại trang project bị lặp.');
    if (cursor) cursors.add(cursor);
  } while(cursor);
  return projects;
}

export function projectTarget(project,rootIndex,available=isDirectory) {
  if (!Number.isInteger(rootIndex) || rootIndex<0 || !project?.roots?.[rootIndex]?.path) throw new Error('Thư mục project không hợp lệ. Hãy gọi /projects lại.');
  const folder=project.roots[rootIndex].path;
  if (!available(folder)) throw new Error('Hiện không truy cập được thư mục '+folder+'. Kiểm tra ổ đĩa hoặc gọi /projects để chọn project khác.');
  return folder;
}

export function projectMenu(projects,page=0,available=isDirectory) {
  const entries=projects.flatMap(project=>(project.roots||[]).map((root,index)=>({project,root,index})));
  if (!entries.length) return {text:'Chưa có project local nào trong Codex. Bạn có thể dùng /cd với thư mục có sẵn.',reply_markup:{inline_keyboard:[]}};
  const pages=Math.ceil(entries.length/8);
  page=Math.max(0,Math.min(pages-1,Number.isInteger(page)?page:0));
  const rows=entries.slice(page*8,page*8+8).map(({project,root,index})=>{
    const suffix=project.roots.length>1?` · ${index+1}`:'';
    return [{text:(available(root.path)?'':'⚠ ')+[...project.name].slice(0,55).join('')+suffix,callback_data:`proj:${project.id}:${index}`}];
  });
  const navigation=[];
  if (page>0) navigation.push({text:'‹ Trang trước',callback_data:`projpage:${page-1}`});
  if (page+1<pages) navigation.push({text:'Trang sau ›',callback_data:`projpage:${page+1}`});
  if (navigation.length) rows.push(navigation);
  return {text:`Chọn project để mở ngữ cảnh Telegram mới (${page+1}/${pages}):\n⚠ = thư mục hiện không truy cập được.\nDanh sách lấy trực tiếp từ Codex.`,reply_markup:{inline_keyboard:rows}};
}
