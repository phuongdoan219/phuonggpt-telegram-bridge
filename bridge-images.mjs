const maxBytes=20*1024*1024;
const tooLarge=()=>new Error('Ảnh vượt giới hạn 20 MB. Hãy gửi ảnh nhỏ hơn.');

export function imageAttachment(message) {
  if(message.photo?.length)return message.photo.reduce((best,item)=>(item.width||0)*(item.height||0)>=(best.width||0)*(best.height||0)?item:best);
  if(/^image\/(jpeg|png|webp)$/.test(message.document?.mime_type||''))return message.document;
  return null;
}

export async function messageInput(message,loadImage) {
  const attachment=imageAttachment(message);
  const text=(message.text||message.caption||'').trim();
  if(!attachment)return text?[{type:'text',text}]:[];
  const url=await loadImage(attachment);
  return [{type:'text',text:text||'Hãy xem ảnh tôi vừa gửi và hỗ trợ theo ngữ cảnh cuộc trò chuyện. Nếu chưa rõ yêu cầu, hãy hỏi tôi muốn làm gì với ảnh.'},{type:'image',url}];
}

export async function downloadImage(attachment,telegram,download) {
  if(attachment.file_size>maxBytes)throw tooLarge();
  const file=await telegram('getFile',{file_id:attachment.file_id});
  if(file.file_size>maxBytes)throw tooLarge();
  if(!file.file_path||! /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(file.file_path)||file.file_path.split('/').some(p=>p==='.'||p==='..'))throw Error('Telegram trả về đường dẫn ảnh không hợp lệ.');
  const response=await download(file.file_path);
  if(!response.ok||!response.body)throw Error('Không tải được ảnh từ Telegram. Hãy gửi lại ảnh.');
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body.cancel();throw tooLarge();}
  const reader=response.body.getReader();let size=0;const parts=[];
  try {
    while(true) {
      const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw tooLarge();}
      parts.push(Buffer.from(value));
    }
  } finally {reader.releaseLock();}
  const bytes=Buffer.concat(parts);
  const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png'
    :bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg'
    :bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
  if(!mime)throw Error('Định dạng ảnh chưa hỗ trợ. Hãy gửi ảnh JPG, PNG hoặc WebP.');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
