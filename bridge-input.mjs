const short=value=>[...String(value)].slice(0,60).join('');
function choices(schema) {
  if(schema.type==='boolean')return [{label:'Có / Cho phép',value:true},{label:'Không / Từ chối',value:false}];
  const titled=schema.oneOf||schema.anyOf;
  if(titled?.every(o=>Object.hasOwn(o,'const')))return titled.map(o=>({label:o.title||String(o.const),value:o.const}));
  return (schema.enum||[]).map((value,i)=>({label:schema.enumNames?.[i]||String(value),value}));
}

export class InputFlow {
  constructor(request) {
    this.form=request.method==='mcpServer/elicitation/request';
    this.message=request.params.message||'Codex cần bạn trả lời';
    this.fields=this.form?Object.entries(request.params.requestedSchema?.properties||{}).map(([id,schema])=>({
      id,label:schema.title||id,question:schema.description||schema.title||id,schema,
      required:request.params.requestedSchema.required?.includes(id)||false,
      multi:schema.type==='array',options:choices(schema.type==='array'?schema.items||{}:schema)
    })):(request.params.questions||[]).map(q=>({id:q.id,label:q.header,question:q.question,secret:q.isSecret,other:q.isOther,
      required:true,schema:{type:'string'},options:(q.options||[]).map(o=>({label:o.label,value:o.label,description:o.description}))}));
    this.index=0;this.values=new Map();this.selected=[];this.page=0;
  }
  current() {const f=this.fields[this.index];if(!f)throw Error('Câu hỏi này đã được trả lời.');return f;}
  validate(value,field=this.current()) {
    const s=field.schema;
    if(typeof value==='string') {
      if(s.minLength!=null&&[...value].length<s.minLength)throw Error(`Cần ít nhất ${s.minLength} ký tự.`);
      if(s.maxLength!=null&&[...value].length>s.maxLength)throw Error(`Tối đa ${s.maxLength} ký tự.`);
      if(s.pattern&&!new RegExp(s.pattern).test(value))throw Error('Nội dung chưa đúng định dạng yêu cầu.');
      if(s.format==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))throw Error('Hãy nhập địa chỉ email hợp lệ.');
      if(s.format==='uri') {try {new URL(value);}catch {throw Error('Hãy nhập đường link hợp lệ.');}}
    }
    if(typeof value==='number') {
      if(!Number.isFinite(value)||(s.type==='integer'&&!Number.isInteger(value)))throw Error('Hãy nhập số hợp lệ.');
      if(s.minimum!=null&&value<s.minimum)throw Error(`Số phải từ ${s.minimum} trở lên.`);
      if(s.maximum!=null&&value>s.maximum)throw Error(`Số phải không quá ${s.maximum}.`);
    }
    if(Array.isArray(value)) {
      if(s.minItems!=null&&value.length<s.minItems)throw Error(`Chọn ít nhất ${s.minItems} mục.`);
      if(s.maxItems!=null&&value.length>s.maxItems)throw Error(`Chọn tối đa ${s.maxItems} mục.`);
    }
  }
  commit(value) {this.validate(value);this.values.set(this.current().id,value);this.index++;this.selected=[];this.page=0;}
  choose(index) {
    const f=this.current();const option=f.options[index];if(!option)throw Error('Lựa chọn không hợp lệ.');
    if(f.multi) {this.selected=this.selected.includes(index)?this.selected.filter(i=>i!==index):[...this.selected,index];}
    else this.commit(option.value);
  }
  enter(text) {
    const f=this.current();let value=text.trim();
    if(!value||value.length>20000)throw Error('Hãy nhập nội dung từ 1 đến 20.000 ký tự.');
    if(f.options.length&&!f.other)throw Error('Hãy chọn một nút bên dưới câu hỏi.');
    if(['number','integer'].includes(f.schema.type))value=Number(value);
    else if(f.schema.type==='array') {
      value=value.split(',').map(v=>v.trim()).filter(Boolean);
    } else if(f.schema.type!=='string') {
      try {value=JSON.parse(value);}catch {throw Error('Dữ liệu cần đúng định dạng JSON được yêu cầu.');}
    }
    this.commit(value);
  }
  next() {const f=this.current();if(!f.multi)throw Error('Câu hỏi không có nhiều lựa chọn.');this.commit(this.selected.map(i=>f.options[i].value));}
  skip() {if(this.current().required)throw Error('Trường này bắt buộc.');this.index++;this.selected=[];this.page=0;}
  reset() {this.index=0;this.values.clear();this.selected=[];this.page=0;}
  result() {
    if(this.index!==this.fields.length)throw Error('Bạn chưa trả lời đủ các câu hỏi.');
    return this.form?{action:'accept',content:Object.fromEntries(this.values)}
      :{answers:Object.fromEntries([...this.values].map(([id,value])=>[id,{answers:[value]}]))};
  }
  view(key) {
    const callback=op=>`input:${key}:${this.index}:${op}`;
    const rows=[];
    if(this.index===this.fields.length) {
      const summary=this.fields.filter(f=>this.values.has(f.id)).map(f=>`${f.label}: ${f.secret?'••••••':short(JSON.stringify(this.values.get(f.id)))}`).join('\n');
      rows.push([{text:'Gửi câu trả lời',callback_data:callback('submit')}],[{text:'Điền lại',callback_data:callback('reset')}]);
      rows.push([{text:'Hủy / Từ chối',callback_data:`deny:${key}`}]);
      return {text:'Kiểm tra câu trả lời:\n'+summary,reply_markup:{inline_keyboard:rows}};
    }
    const f=this.current();const start=this.page*8;
    f.options.slice(start,start+8).forEach((o,i)=>rows.push([{text:(this.selected.includes(start+i)?'✓ ':'')+short(o.label),callback_data:callback('pick'+(start+i))}]));
    const nav=[];
    if(this.page>0)nav.push({text:'‹ Trang trước',callback_data:callback('page'+(this.page-1))});
    if(start+8<f.options.length)nav.push({text:'Trang sau ›',callback_data:callback('page'+(this.page+1))});
    if(nav.length)rows.push(nav);
    if(!f.options.length||f.other)rows.push([{text:'Nhập câu trả lời',callback_data:callback('text')}]);
    if(f.multi&&f.options.length)rows.push([{text:'Xong / Tiếp tục',callback_data:callback('next')}]);
    if(!f.required)rows.push([{text:'Bỏ qua',callback_data:callback('skip')}]);
    rows.push([{text:'Hủy / Từ chối',callback_data:`deny:${key}`}]);
    const details=f.options.slice(start,start+8).filter(o=>o.description).map(o=>short(o.label)+': '+o.description).join('\n');
    return {text:`${this.message}\n\nCâu ${this.index+1}/${this.fields.length}: ${f.question}`+(details?'\n\n'+details:''),reply_markup:{inline_keyboard:rows}};
  }
}
