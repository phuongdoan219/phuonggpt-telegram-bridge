import {chunks} from './bridge-core.mjs';

// Called only after the bridge authenticates the callback's sender and chat.
export async function approvalFeedback(callback,allowed,respond,telegram) {
  let status;
  try {
    const received=await respond();
    status=received
      ?allowed?received.remembered?'✅ Đã cho phép và ghi nhớ. Thao tác đúng phạm vi này sẽ không hỏi lại.':received.rememberFailed?'⚠️ Đã cho phép lần này và gửi tới Codex, nhưng chưa lưu được quyền ghi nhớ.':'✅ Đã cho phép lần này. Đã gửi lựa chọn tới Codex.':'⛔ Đã từ chối. Đã gửi lựa chọn tới Codex.'
      :'⌛ Yêu cầu đã được trả lời hoặc hết hạn. Không gửi lại lựa chọn.';
  } catch {
    status='⚠️ Chưa gửi được lựa chọn tới Codex. Hãy gửi lại yêu cầu công việc.';
  }
  // A stale callback or failed toast must not suppress the persistent receipt.
  await telegram('answerCallbackQuery',{callback_query_id:callback.id,text:status}).catch(()=>{});
  try {
    await telegram('editMessageText',{
      chat_id:callback.message.chat.id,message_id:callback.message.message_id,
      text:(chunks(callback.message.text||'Codex cần xác nhận:',3700)[0]||'')+'\n\n'+status,
      reply_markup:{inline_keyboard:[]}
    });
  } catch {
    await telegram('sendMessage',{chat_id:callback.message.chat.id,text:status});
  }
}
