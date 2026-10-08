# On/off switch for the photo work-order bot (bot.mjs): a dot in the system tray,
# green while the bot runs and grey while it is off. Opening it turns the bot on.
# Left-click the dot to turn the bot off or on again; right-click for Open log,
# Start with Windows and Quit (Quit also stops the bot). The bot's console goes to
# bot.local.log beside this file (gitignored).
#
# Run under Windows PowerShell 5.1 (powershell.exe), like winocr.ps1:
#   powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File tools\wo-bot\tray.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\wo-bot\tray.ps1 -Install
#     (adds a "Work-order bot" Start-menu shortcut that runs the line above)
#
# Telegram lets only one copy of a bot poll (a second gets 409 Conflict), so a
# second tray just says where the first is, and turning on first stops any
# bot.mjs that was started some other way.
param([switch]$Install)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$name = 'Work-order bot'
$here = $PSScriptRoot
$bot = Join-Path $here 'bot.mjs'
$log = Join-Path $here 'bot.local.log'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) "$name.lnk"

function New-Shortcut($path) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $s.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $s.WorkingDirectory = $here
  $s.Description = 'Turn the meter-log photo work-order bot on and off from the tray'
  $s.Save()
}

if ($Install) {
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) "$name.lnk")
  "Added '$name' to the Start menu."
  exit
}

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\meter-log-wo-bot-tray', [ref]$created)
if (-not $created) {
  [System.Windows.Forms.MessageBox]::Show("$name is already running. Its dot is in the tray by the clock (under ^ if Windows hid it).", $name) | Out-Null
  exit
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  [System.Windows.Forms.MessageBox]::Show('Node.js is not installed (node is not on PATH).', $name) | Out-Null
  exit
}

function New-Dot([System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), 2, 2, 28, 28)
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$onIcon = New-Dot ([System.Drawing.Color]::FromArgb(46, 160, 67))
$offIcon = New-Dot ([System.Drawing.Color]::FromArgb(150, 150, 150))

# ── the bot process ─────────────────────────────────────────────────────────
$script:proc = $null   # the cmd.exe wrapping node; its tree is the bot

function Get-OtherBots {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*wo-bot*bot.mjs*' -and $_.CommandLine -notlike '*--dry-run*' }
}
function Test-On { [bool]($script:proc -and -not $script:proc.HasExited) }

function Start-Bot {
  Get-OtherBots | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item $log "$log.1" -Force }
  Add-Content -Path $log -Value "`r`n=== turned on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
  # cmd strips the outer quotes of /c "...", leaving each path quoted.
  $script:proc = Start-Process cmd.exe -WorkingDirectory $here -WindowStyle Hidden -PassThru `
    -ArgumentList "/d /c `"`"$node`" `"$bot`" >> `"$log`" 2>&1`""
}

function Stop-Bot {
  $p = $script:proc
  $script:proc = $null
  if ($p -and -not $p.HasExited) { & taskkill.exe /PID $p.Id /T /F | Out-Null }
  Get-OtherBots | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (Test-Path $log) { Add-Content -Path $log -Value "=== turned off $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" }
}

# ── the tray ────────────────────────────────────────────────────────────────
$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$toggleItem = $menu.Items.Add('Turn off')
$toggleItem.Font = New-Object System.Drawing.Font($toggleItem.Font, [System.Drawing.FontStyle]::Bold)
$logItem = $menu.Items.Add('Open log')
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$autoItem = $menu.Items.Add('Start with Windows')
$quitItem = $menu.Items.Add('Quit')

function Show-State {
  $on = Test-On
  $tray.Icon = if ($on) { $onIcon } else { $offIcon }
  $tray.Text = "$name - $(if ($on) { 'on' } else { 'off' })"
  $toggleItem.Text = if ($on) { 'Turn off' } else { 'Turn on' }
  $autoItem.Checked = Test-Path $startup
}

function Switch-Bot {
  try {
    if (Test-On) { Stop-Bot; $msg = 'Off.' }
    else { Start-Bot; $msg = 'On. Send photos to the bot on Telegram.' }
  } catch { $msg = "Couldn't switch: $($_.Exception.Message)" }
  Show-State
  $tray.ShowBalloonTip(2000, $name, $msg, [System.Windows.Forms.ToolTipIcon]::None)
}

$tray.add_MouseClick({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Switch-Bot }
})
$toggleItem.add_Click({ Switch-Bot })
$logItem.add_Click({ if (Test-Path $log) { Start-Process notepad.exe "`"$log`"" } })
$autoItem.add_Click({
  try { if (Test-Path $startup) { Remove-Item $startup } else { New-Shortcut $startup } } catch {}
  Show-State
})
$quitItem.add_Click({
  Stop-Bot
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

# A bot that dies on its own (bad config, crash) turns the dot grey and says so.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  if ($script:proc -and $script:proc.HasExited) {
    $script:proc = $null
    Show-State
    $tray.ShowBalloonTip(5000, $name, 'The bot stopped by itself. Right-click the dot > Open log to see why.',
      [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})

$tray.ContextMenuStrip = $menu
Start-Bot
Show-State
$tray.Visible = $true
$tray.ShowBalloonTip(2000, $name, 'On. Click the dot to turn it off.', [System.Windows.Forms.ToolTipIcon]::None)
$timer.Start()
[System.Windows.Forms.Application]::Run()
$timer.Stop()
$tray.Dispose()
$mutex.ReleaseMutex()
