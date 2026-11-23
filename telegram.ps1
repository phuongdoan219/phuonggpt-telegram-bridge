param(
    [ValidateSet('Setup','Status','SendText','SendFile')][string]$Action = 'Status',
    [string]$Text,
    [string]$Path
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$configDir = Join-Path $env:LOCALAPPDATA 'CodexTelegram'
$configPath = Join-Path $configDir 'connection.json'

function Invoke-Bot($Token, $Method, $Body) {
    try {
        $result = Invoke-RestMethod -Uri ('https://api.telegram.org/bot' + $Token + '/' + $Method) -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress)))
        if (-not $result.ok) { throw 'API error' }
        return $result.result
    } catch {
        throw "Telegram request failed ($Method). Check token, connection and bot permissions."
    }
}

function Read-Connection {
    if (-not (Test-Path -LiteralPath $configPath)) { throw 'Run SETUP-TELEGRAM.cmd first.' }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $secret = ConvertTo-SecureString $config.token
    $credential = New-Object System.Management.Automation.PSCredential('telegram', $secret)
    return @{ Token = $credential.GetNetworkCredential().Password; ChatId = [string]$config.chat_id; Name = $config.bot_name }
}

if ($Action -eq 'Setup') {
    Write-Host 'Connect PhuongGPT Assistant to Codex'
    Write-Host 'Send a new /start message to your bot from your private Telegram chat.'
    Write-Host 'If you use the same bot elsewhere, stop the other listener first.'
    $secret = Read-Host 'Paste BotFather token (hidden)' -AsSecureString
    $credential = New-Object System.Management.Automation.PSCredential('telegram', $secret)
    $token = $credential.GetNetworkCredential().Password.Trim()
    if ($token -notmatch '^\d+:[A-Za-z0-9_-]+$') { throw 'Token format is invalid.' }
    $bot = Invoke-Bot $token 'getMe' @{}
    Write-Host ('Bot: ' + $bot.first_name + ' (@' + $bot.username + ')')
    $confirm = Read-Host 'Is this the bot you want to connect? Type YES'
    if ($confirm -cne 'YES') { throw 'Setup cancelled. No connection saved.' }
    $updates = @(Invoke-Bot $token 'getUpdates' @{timeout=0; allowed_updates=@('message')})
    $chats = @($updates | ForEach-Object { $_.message.chat } | Where-Object { $_.type -eq 'private' } | Sort-Object id -Unique)
    if ($chats.Count -eq 0) { throw 'No private chat found. Send /start to your bot, then run setup again.' }
    foreach ($chat in $chats) { Write-Host ('Chat ID: ' + $chat.id + ' | ' + $chat.first_name + ' ' + $chat.last_name + ' @' + $chat.username) }
    $chatId = Read-Host 'Enter your Chat ID from the list above'
    if ($chatId -notin @($chats | ForEach-Object { [string]$_.id })) { throw 'Chat ID does not match the list. No connection saved.' }
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    $encrypted = ConvertTo-SecureString $token -AsPlainText -Force | ConvertFrom-SecureString
    @{token=$encrypted; chat_id=$chatId; bot_name=$bot.first_name; bot_username=$bot.username} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
    Write-Host 'SAVED. Token is encrypted for your Windows account. No message has been sent.'
    exit
}

$connection = Read-Connection
if ($Action -eq 'Status') {
    $bot = Invoke-Bot $connection.Token 'getMe' @{}
    Write-Output ('Connected: ' + $bot.first_name + ' (@' + $bot.username + '), chat ID: ' + $connection.ChatId)
} elseif ($Action -eq 'SendText') {
    if ($Path) { $Text = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Path).Path) }
    if ([string]::IsNullOrWhiteSpace($Text)) { throw 'Provide Text or a UTF-8 text file using Path.' }
    if ($Text.Length -gt 4096) { throw 'Text exceeds 4096 characters. Send it as a file using SendFile.' }
    $message = Invoke-Bot $connection.Token 'sendMessage' @{chat_id=$connection.ChatId; text=$Text}
    Write-Output ('Sent message ID: ' + $message.message_id)
} elseif ($Action -eq 'SendFile') {
    Add-Type -AssemblyName System.Net.Http
    $file = Get-Item -LiteralPath $Path
    if ($file.PSIsContainer) { throw 'Path must be a file.' }
    $client = New-Object System.Net.Http.HttpClient
    $form = New-Object System.Net.Http.MultipartFormDataContent
    $stream = [IO.File]::OpenRead($file.FullName)
    try {
        $form.Add((New-Object System.Net.Http.StringContent($connection.ChatId)), 'chat_id')
        $form.Add((New-Object System.Net.Http.StreamContent($stream)), 'document', $file.Name)
        $response = $client.PostAsync(('https://api.telegram.org/bot' + $connection.Token + '/sendDocument'), $form).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw 'Upload failed' }
        $result = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        if (-not $result.ok) { throw 'Upload failed' }
        Write-Output ('Sent file message ID: ' + $result.result.message_id)
    } catch { throw 'Telegram file upload failed. Check connection, permissions and file size.' }
    finally { $form.Dispose(); $stream.Dispose(); $client.Dispose() }
}
