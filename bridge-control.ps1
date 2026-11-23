param([ValidateSet('Start','Stop','Status','EnableAutostart','DisableAutostart')][string]$Action='Status')
$ErrorActionPreference='Stop'
$bridgeRoot = $PSScriptRoot
$bridgeScript = Join-Path $bridgeRoot 'telegram-bridge.mjs'
$bridgeLocal = Join-Path $env:LOCALAPPDATA 'CodexTelegram'
$bridgeTaskName = 'PhuongGPT Telegram Bridge'

if ($Action -eq 'EnableAutostart') {
    $bridgeUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $bridgePowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action Start'
    $taskAction = New-ScheduledTaskAction -Execute $bridgePowerShell -Argument $taskArgs -WorkingDirectory $bridgeRoot
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $bridgeUser
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $bridgeUser -LogonType Interactive -RunLevel Limited
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $bridgeTaskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Starts the PhuongGPT Telegram-to-Codex listener when the owner signs in to Windows.' -Force | Out-Null
    Write-Output 'Telegram bridge will start when you sign in to Windows.'
    return
}
if ($Action -eq 'DisableAutostart') {
    if (Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue) {
        Disable-ScheduledTask -TaskName $bridgeTaskName | Out-Null
    }
    Write-Output 'Automatic startup is disabled.'
    return
}

$bridgeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($bridgeScript) })
if ($Action -eq 'Stop') {
    foreach ($bridgeProcess in $bridgeProcesses) { & taskkill.exe /PID $bridgeProcess.ProcessId /T /F | Out-Null }
    Write-Output 'Telegram bridge stopped.'
    exit
}
if ($bridgeProcesses.Count) {
    Write-Output ('Telegram bridge is running. PID: ' + ($bridgeProcesses.ProcessId -join ', '))
    exit
}
if ($Action -eq 'Status') { Write-Output 'Telegram bridge is not running.'; exit }
New-Item -ItemType Directory -Path $bridgeLocal -Force | Out-Null
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
Start-Process -FilePath $nodePath -ArgumentList @(('"' + $bridgeScript + '"')) -WorkingDirectory $bridgeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $bridgeLocal 'bridge.log') -RedirectStandardError (Join-Path $bridgeLocal 'bridge-error.log') | Out-Null
Write-Output 'Starting Telegram bridge. Check Telegram for the ready message.'
