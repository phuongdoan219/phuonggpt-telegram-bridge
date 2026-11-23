# PhuongGPT Telegram Bridge

Cầu nối cho phép bạn giao việc cho Codex trên máy Windows qua bot Telegram riêng. Bot nhận tin nhắn, ảnh và ghi âm, cho phép chọn dự án hoặc cuộc trò chuyện, rồi gửi phản hồi của Codex về Telegram. Máy Windows cần đăng nhập, có mạng và đang chạy cầu nối.

## Cài trên máy Windows khác

1. Cài [ChatGPT desktop cho Windows](https://learn.chatgpt.com/docs/windows/windows-app), mở Codex và đăng nhập bằng tài khoản bạn muốn dùng. Cài [Node.js 24 LTS cho Windows](https://nodejs.org/en/download) và mở cửa sổ PowerShell mới. Kiểm tra bằng `node --version`.
2. Trên GitHub, chọn **Code → Download ZIP** hoặc clone repo. Giải nén vào thư mục cố định mà tài khoản Windows của bạn ghi được. Không cần chạy `npm install`.
3. Nếu chuyển cùng một bot sang máy mới, trên máy cũ hãy tắt tác vụ **PhuongGPT Telegram Bridge** trong Task Scheduler rồi chạy `STOP-TELEGRAM-BRIDGE.cmd`. Mỗi bot chỉ nên có một cầu nối đang nhận lệnh.
4. Trong Telegram, gửi một tin `/start` mới cho bot từ chat riêng. Nếu chưa có bot, tạo bằng [BotFather](https://core.telegram.org/bots/tutorial#obtain-your-bot-token). Chạy `SETUP-TELEGRAM.cmd`, dán bot token vào ô nhập ẩn, kiểm tra tên bot, nhập `YES` rồi chọn Chat ID của bạn từ danh sách.
5. Mở PowerShell trong thư mục repo và chạy `node telegram-bridge.mjs --check`. Kiểm tra `signedIn: true`, đúng tên bot và trạng thái sandbox `ready`.
6. Chạy `START-TELEGRAM-BRIDGE.cmd` và nhắn `/status` cho bot để thử. Nếu muốn tự bật sau mỗi lần đăng nhập Windows, chạy thêm `AUTOSTART-TELEGRAM.cmd`.

Token được mã hóa riêng cho tài khoản Windows hiện tại. Hãy chạy lại bước kết nối trên máy mới. Lịch sử Codex, thư mục dự án và trạng thái của cầu nối là dữ liệu nằm ngoài repo.

## Dùng hằng ngày

- `/help` liệt kê lệnh, `/status` xem trạng thái và `/stop` dừng việc đang chạy.
- `/projects` và `/chats` chọn dự án và cuộc trò chuyện Codex có sẵn.
- `/newproject TenDuAn` tạo dự án trong `%USERPROFILE%\workspace` hoặc trong `D:\workspace` nếu thư mục cũ đó đã tồn tại. Có thể chỉ định thư mục khác bằng biến môi trường người dùng `CODEX_TELEGRAM_WORKSPACE` rồi khởi động lại cầu nối.
- Dùng `STOP-TELEGRAM-BRIDGE.cmd` để dừng cầu nối trong phiên hiện tại. Tắt tác vụ **PhuongGPT Telegram Bridge** trong Task Scheduler nếu muốn bỏ tự khởi động. Nếu di chuyển thư mục repo, chạy lại `AUTOSTART-TELEGRAM.cmd` từ vị trí mới.

## Bật nhận tin nhắn thoại

Phần này tùy chọn. Cài [Python 3.12 cho Windows x64](https://www.python.org/downloads/windows/) cùng Python Launcher. Sau đó chạy các lệnh sau trong PowerShell tại thư mục repo. Lệnh tải model một lần để cầu nối có thể nhận giọng nói ngoại tuyến khi chạy.

```powershell
$voicePython = (& py -3.12 -c "import sys; print(sys.executable)").Trim()
& $voicePython -m pip install --target .voice-python -r voice-requirements.txt
$env:PYTHONPATH = (Resolve-Path -LiteralPath '.voice-python').Path
& $voicePython -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small')"
& $voicePython .\voice-transcribe.py --check
[Environment]::SetEnvironmentVariable('CODEX_VOICE_PYTHON', $voicePython, 'User')
$env:CODEX_VOICE_PYTHON = $voicePython
```

Khi phần kiểm tra trả về `"ready": true`, khởi động lại cầu nối để nhận biến môi trường mới.

## Kiểm tra và xử lý lỗi

```powershell
node --test
node telegram-bridge.mjs --check
node telegram-bridge.mjs --smoke
```

`--check` kiểm tra kết nối Telegram, đăng nhập Codex và sandbox. `--smoke` chạy một yêu cầu Codex thử và không gửi thử tin nhắn sang Telegram.

Nếu bot im lặng, kiểm tra `%LOCALAPPDATA%\CodexTelegram\bridge-error.log`. Nếu log báo xung đột `getUpdates`, kiểm tra xem máy cũ có còn chạy cùng bot không. Xem [tài liệu lệnh và hành vi chi tiết](TELEGRAM-README.md).
