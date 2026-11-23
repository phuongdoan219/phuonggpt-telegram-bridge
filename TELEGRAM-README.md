# PhuongGPT Assistant

## Receive commands

See the [installation guide](README.md) for a fresh Windows setup. Run AUTOSTART-TELEGRAM.cmd to register the **PhuongGPT Telegram Bridge** task, which starts the listener in the background when the owner signs in to Windows. Keep the computer awake and online. Use START-TELEGRAM-BRIDGE.cmd to start it manually or STOP-TELEGRAM-BRIDGE.cmd to stop it for the current session. To turn off automatic startup, disable the task in Task Scheduler.

Send normal text requests to the bot connected during setup. Only the configured private owner can issue commands. The bridge keeps Telegram context in a dedicated Codex conversation.

- `/help`: commands and examples.
- `/newproject TenProject` creates a folder under the configured workspace, registers it as a Codex project, and selects it with fresh Telegram context. The default is `%USERPROFILE%\workspace` unless `D:\workspace` already exists. Set `CODEX_TELEGRAM_WORKSPACE` to choose a different folder. Unicode and spaces are supported. Repeating the command reuses the existing project without overwriting files. A name already used at another location is rejected. A failed Codex registration leaves the folder intact and can be retried.

Desktop display limitation: native project/create registration is verified in app-server project/list and the bot's /projects. The running desktop app's list_projects connector did not immediately show the test project. Immediate desktop-sidebar synchronization is not verified; the bridge does not modify the desktop app's private global-state file to force it.
- `/projects`: show live Codex projects as paginated buttons. Tap a project to select its existing folder and start fresh Telegram context. Unavailable folders are marked with a warning. No directory path needs to be typed. Desktop project conversations are not resumed by this action.
- `/chats`: show saved, non-archived chats in the selected project (including legacy unassigned chats in its selected folder), newest update first. Tap a title to resume that original conversation with its history. Eight chats per page; ✓ marks the current chat. Old buttons expire when the list is refreshed or the project/folder changes. Busy chats cannot be selected. Historical replies are not resent. Use `/projects` first if you have not selected the intended project; `/cd` limits the list to unassigned chats in that folder. Avoid using the same conversation simultaneously from desktop and Telegram.
- `/status`: active task and working folder.
- `/stop`: interrupt the active Codex turn.
- `/new`: clear Telegram conversation context for the next request.
- `/cd C:\Folder name` switches working folder and starts new context.

The default working folder is the directory containing the bridge. The agent can read and search as allowed by Codex's sandbox. Writes default to the selected folder. Extra permission requests appear as one-use Telegram buttons. Confirm only the displayed operation. Approvals expire after ten minutes. Text questions may require `/answer REQUEST_ID YOUR_ANSWER`. Structured forms require JSON.

The bridge accepts text, Telegram photos and JPG/PNG/WebP image documents, one active request at a time. Add the request as the image caption; a caption is optional. Images are downloaded using the existing bot connection, capped at 20 MiB, and forwarded as image data to Codex; credential-bearing URLs are never passed to the model. Images are not copied into a local inbox. Send one image message at a time; albums are not grouped and later messages may be rejected while busy. It rejects new work while busy; resend after completion or use /stop. Existing local files can be delivered without making another local copy; the bridge upload limit is 49 MiB. Telegram Desktop may separately download received documents according to its settings.

Voice requests: hold Telegram's microphone button and send a voice note (or send an audio file). The bridge transcribes locally with the cached multilingual Faster Whisper small model, shows the recognized text, and submits that text as a normal request in the selected conversation. Replies remain text. The single-task limit, permission prompts and remembered permissions apply as before. The transcript is not interpreted as a Telegram slash command. Voice is limited to 5 minutes and 20 MiB; empty/failed recognition does not start a Codex turn. Audio is piped in memory to a hidden Python worker and is not saved as an inbox file. Whisper defaults to Vietnamese; `CODEX_VOICE_LANGUAGE` can override it. Recognition may mishear names or noisy recordings.

Voice runtime: dependencies are installed under `.voice-python` (see `voice-requirements.txt`), using bundled Codex Python; `CODEX_VOICE_PYTHON` overrides its path. `voice-transcribe.py --check` checks local model readiness. The cached model must exist under the user's Hugging Face `models--Systran--faster-whisper-small/snapshots` directory. The worker disables online model downloads and uses CPU int8 with at most four threads. Startup never records from the computer microphone.

Voice preparation runs asynchronously while keeping the one-task busy guard. `/stop` aborts downloads/transcription before starting a Codex turn; cancellation while `turn/start` is already in flight interrupts the returned real turn ID. Audio decoding stops incrementally at the sample budget rather than decoding an unbounded recording first. Python decoder checks use `python -B -m unittest voice_worker_test.py` with in-memory silence, no microphone or speech synthesis.

Approval button feedback: after an authenticated Allow/Deny click is forwarded to Codex, the bot shows a Telegram toast and replaces the approval buttons with a permanent status on the original message. Expired/repeated clicks and forwarding errors show their actual status. If editing the old message fails, a separate receipt is sent instead. The receipt confirms forwarding the decision, not completion of the requested command.

Empty MCP consent forms (for example, allowing Google Chrome) show Allow/Deny buttons and send `{action: "accept", content: {}}` only after an authenticated Allow click. Forms with actual fields or additional schema constraints still require data; URL authorization remains a separate flow. For older empty-form prompts, `/answer REQUEST_ID {}` accepts the form while it is still pending.

Interactive questions now show buttons as well: answer each question using choices, or tap **Nhập câu trả lời** and type in Telegram's reply field. MCP form fields are collected one at a time; booleans and enums use choices, arrays with options support multiple selections, and optional fields can be skipped. A final **Gửi câu trả lời** button submits the collected values. Cancel/deny is always available. Replies to expired or superseded prompts do not become new Codex tasks. Normal typed replies are bound to the bot message being replied to; no `/answer` command or JSON is needed for standard fields. URL authorization shows **Mở trang xác nhận**, **Đã hoàn tất / Tiếp tục**, and **Từ chối**; pressing Continue only forwards the user's acknowledgement, not proof of authentication. Legacy `/answer` remains supported.

Remembered approvals: choose **Cho phép & ghi nhớ** to persist approval for an exact repeat in the same project and working folder. Command text, requested permissions, environment and other action fields must match; file approvals additionally require identical complete changes. Changes in request IDs, timing or explanatory reason do not invalidate a match. The bridge stores only SHA-256 fingerprints in its existing state, rechecks authenticated thread requests and replies using ordinary scoped approval responses. No sandbox mode is weakened. Questions, elicitation, stdin and incomplete requests cannot be remembered. **Cho phép lần này** remains one-use. Denied or failed responses are not remembered. Earlier one-use approvals cannot be reconstructed. `/forgetpermissions` clears all Telegram remembered approvals; it does not change rules configured outside the bridge.

Exception for application access: the exact empty-form consent **Allow Codex to use Google Chrome?** can also be remembered. The fingerprint includes the MCP server identity, full non-volatile request metadata/schema and selected project/folder; other consent text, servers or changed scopes do not match. The original tool source is shown before approval. A repeated match returns the MCP `{action: "accept", content: {}}` response, not a shell-command decision. General empty forms, data forms and URL authorization are never auto-accepted by this rule. Opening Chrome by hand does not grant this bridge permission to control it.

## Runtime files

State, encrypted credentials, health and sanitized error logs are under `%LOCALAPPDATA%\CodexTelegram`. The Telegram token is decrypted only in process memory. Do not share credential files or logs without reviewing them. First startup discards existing bot updates. Later restarts retain committed offsets and do not automatically rerun an interrupted task. A request may have partially completed before a crash: inspect before retrying.

## Checks

`node --test bridge.test.mjs bridge-projects.test.mjs bridge-chats.test.mjs bridge-approval-feedback.test.mjs bridge-images.test.mjs bridge-remember.test.mjs bridge-voice.test.mjs bridge-input.test.mjs`

`node telegram-bridge.mjs --check`

`node telegram-bridge.mjs --smoke`

The check validates login, bot and sandbox readiness. Smoke runs one harmless ephemeral Codex turn and sends nothing through Telegram. The bridge uses your current Codex configuration and account; availability and usage limits still apply.
