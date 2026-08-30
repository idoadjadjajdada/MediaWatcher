# MediaWatcher desktop launcher
#
# A real Windows window (WinForms) for starting, stopping and watching the
# MediaWatcher server. No dependencies: Windows already ships PowerShell and
# .NET Framework, so this runs as-is on a clean machine.
#
# Launched by MediaWatcher.bat. Run directly with:
#   powershell -ExecutionPolicy Bypass -File MediaWatcher.ps1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $Root

# ---------------------------------------------------------------------------
# Palette (matches the app's dark theme)
# ---------------------------------------------------------------------------
$C = @{
  Bg      = [System.Drawing.Color]::FromArgb(10, 10, 10)
  Panel   = [System.Drawing.Color]::FromArgb(22, 22, 22)
  Hover   = [System.Drawing.Color]::FromArgb(31, 31, 31)
  Text    = [System.Drawing.Color]::FromArgb(229, 229, 229)
  Dim     = [System.Drawing.Color]::FromArgb(136, 136, 136)
  Accent  = [System.Drawing.Color]::FromArgb(168, 85, 247)
  Pink    = [System.Drawing.Color]::FromArgb(236, 72, 153)
  Border  = [System.Drawing.Color]::FromArgb(42, 42, 42)
  Danger  = [System.Drawing.Color]::FromArgb(239, 68, 68)
  Success = [System.Drawing.Color]::FromArgb(16, 185, 129)
  Warning = [System.Drawing.Color]::FromArgb(245, 158, 11)
  Info    = [System.Drawing.Color]::FromArgb(147, 197, 253)
  LogBg   = [System.Drawing.Color]::FromArgb(13, 13, 13)
}

$FontUi     = New-Object System.Drawing.Font("Segoe UI", 9)
$FontBold   = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$FontTitle  = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$FontSmall  = New-Object System.Drawing.Font("Segoe UI", 8)
$FontMono   = New-Object System.Drawing.Font("Consolas", 9)

# ---------------------------------------------------------------------------
# Config inspection
# ---------------------------------------------------------------------------

function Read-EnvFile {
  $file = Join-Path $Root ".env"
  if (-not (Test-Path $file)) { return $null }

  $values = @{}
  foreach ($line in (Get-Content $file)) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
      # Strip the inline comments that .env.example writes.
      $values[$matches[1]] = ($matches[2] -split '#')[0].Trim()
    }
  }
  return $values
}

function Test-Binary($command) {
  try {
    $found = Get-Command $command -ErrorAction Stop
    return $null -ne $found
  } catch {
    return $false
  }
}

function Get-AppPort {
  $env_ = Read-EnvFile
  if ($env_ -and $env_["PORT"]) { return $env_["PORT"] }
  return "3000"
}

function Get-LibraryPath {
  $env_ = Read-EnvFile
  $raw = "./library"
  if ($env_ -and $env_["LIBRARY_PATH"]) { $raw = $env_["LIBRARY_PATH"] }
  if ([System.IO.Path]::IsPathRooted($raw)) { return $raw }
  return (Join-Path $Root ($raw -replace '^\./', ''))
}

function Get-Preflight {
  $env_ = Read-EnvFile
  $results = @()

  $nodeOk = Test-Binary "node"
  $nodeVersion = "not found"
  if ($nodeOk) { $nodeVersion = (& node --version) }
  $results += @{ Label = "Node.js"; Ok = $nodeOk; Detail = $nodeVersion }

  $results += @{ Label = ".env file"; Ok = ($null -ne $env_);
                 Detail = $(if ($env_) { "found" } else { "missing - copy .env.example" }) }

  $hasTmdb = $env_ -and $env_["TMDB_API_KEY"]
  $hasDebrid = $env_ -and $env_["ALLDEBRID_API_KEY"]
  $keyDetail = "both set"
  if (-not $hasTmdb -and -not $hasDebrid) { $keyDetail = "TMDB and AllDebrid missing" }
  elseif (-not $hasTmdb) { $keyDetail = "TMDB_API_KEY missing" }
  elseif (-not $hasDebrid) { $keyDetail = "ALLDEBRID_API_KEY missing" }
  $results += @{ Label = "API keys"; Ok = ($hasTmdb -and $hasDebrid); Detail = $keyDetail }

  $ffmpegCmd = "ffmpeg"
  if ($env_ -and $env_["FFMPEG_PATH"]) { $ffmpegCmd = $env_["FFMPEG_PATH"] }
  $hasFfmpeg = Test-Binary $ffmpegCmd
  $results += @{ Label = "ffmpeg"; Ok = $hasFfmpeg; Warn = (-not $hasFfmpeg)
                 Detail = $(if ($hasFfmpeg) { "found" } else { "missing - most MKVs will not play" }) }

  $lib = Get-LibraryPath
  $libShown = $lib
  if ($lib.StartsWith($Root)) { $libShown = "." + $lib.Substring($Root.Length) }
  $results += @{ Label = "Library folder"; Ok = (Test-Path $lib); Detail = $libShown }

  $results += @{ Label = "Dependencies"; Ok = (Test-Path (Join-Path $Root "node_modules"))
                 Detail = $(if (Test-Path (Join-Path $Root "node_modules")) { "installed" } else { "run npm install" }) }

  return $results
}

# ---------------------------------------------------------------------------
# Window
# ---------------------------------------------------------------------------

$form = New-Object System.Windows.Forms.Form
$form.Text = "MediaWatcher"
$form.Size = New-Object System.Drawing.Size(1000, 680)
$form.MinimumSize = New-Object System.Drawing.Size(820, 560)
$form.StartPosition = "CenterScreen"
$form.BackColor = $C.Bg
$form.ForeColor = $C.Text
$form.Font = $FontUi

# --- header ---------------------------------------------------------------
$header = New-Object System.Windows.Forms.Panel
$header.Size = New-Object System.Drawing.Size(1000, 62)
$header.Location = New-Object System.Drawing.Point(0, 0)
$header.BackColor = $C.Panel
$header.Anchor = "Top,Left,Right"
$form.Controls.Add($header)

$mark = New-Object System.Windows.Forms.Label
$mark.Text = [char]0x25B6
$mark.Font = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$mark.ForeColor = [System.Drawing.Color]::White
$mark.BackColor = $C.Accent
$mark.TextAlign = "MiddleCenter"
$mark.Size = New-Object System.Drawing.Size(34, 34)
$mark.Location = New-Object System.Drawing.Point(18, 14)
$header.Controls.Add($mark)

$title = New-Object System.Windows.Forms.Label
$title.Text = "MediaWatcher"
$title.Font = $FontTitle
$title.ForeColor = $C.Text
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(62, 11)
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "self-hosted media library"
$subtitle.Font = $FontSmall
$subtitle.ForeColor = $C.Dim
$subtitle.AutoSize = $true
$subtitle.Location = New-Object System.Drawing.Point(64, 34)
$header.Controls.Add($subtitle)

$status = New-Object System.Windows.Forms.Label
$status.Text = "Stopped"
$status.Font = $FontBold
$status.ForeColor = $C.Dim
$status.TextAlign = "MiddleRight"
$status.Size = New-Object System.Drawing.Size(340, 24)
$status.Location = New-Object System.Drawing.Point(640, 19)
$status.Anchor = "Top,Right"
$header.Controls.Add($status)

# --- buttons --------------------------------------------------------------
function New-FlatButton($text, $x, $y, $w, $h, $accent) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, $y)
  $b.Size = New-Object System.Drawing.Size($w, $h)
  $b.FlatStyle = "Flat"
  $b.Font = $FontBold
  $b.Cursor = "Hand"
  $b.FlatAppearance.BorderSize = 1
  if ($accent -eq "primary") {
    $b.BackColor = $C.Accent
    $b.ForeColor = [System.Drawing.Color]::White
    $b.FlatAppearance.BorderColor = $C.Accent
    $b.FlatAppearance.MouseOverBackColor = $C.Pink
  } elseif ($accent -eq "danger") {
    $b.BackColor = $C.Panel
    $b.ForeColor = $C.Danger
    $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(90, 40, 40)
    $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(45, 22, 22)
  } else {
    $b.BackColor = $C.Hover
    $b.ForeColor = $C.Text
    $b.FlatAppearance.BorderColor = $C.Border
    $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(38, 38, 38)
  }
  return $b
}

$sidebar = New-Object System.Windows.Forms.Panel
$sidebar.Location = New-Object System.Drawing.Point(16, 76)
$sidebar.Size = New-Object System.Drawing.Size(292, 560)
$sidebar.BackColor = $C.Bg
$sidebar.Anchor = "Top,Left,Bottom"
$form.Controls.Add($sidebar)

$btnStart   = New-FlatButton "Start server" 0 0 292 40 "primary"
$btnRestart = New-FlatButton "Restart" 0 48 142 34 ""
$btnStop    = New-FlatButton "Stop" 150 48 142 34 "danger"
$btnOpen    = New-FlatButton "Open MediaWatcher" 0 90 292 34 ""
$btnRescan  = New-FlatButton "Rescan library" 0 132 142 34 ""
$btnLibrary = New-FlatButton "Library folder" 150 132 142 34 ""
foreach ($b in @($btnStart, $btnRestart, $btnStop, $btnOpen, $btnRescan, $btnLibrary)) { $sidebar.Controls.Add($b) }

$lblLevel = New-Object System.Windows.Forms.Label
$lblLevel.Text = "Log level"
$lblLevel.ForeColor = $C.Dim
$lblLevel.AutoSize = $true
$lblLevel.Location = New-Object System.Drawing.Point(0, 182)
$sidebar.Controls.Add($lblLevel)

$cmbLevel = New-Object System.Windows.Forms.ComboBox
$cmbLevel.Location = New-Object System.Drawing.Point(70, 178)
$cmbLevel.Size = New-Object System.Drawing.Size(222, 24)
$cmbLevel.DropDownStyle = "DropDownList"
$cmbLevel.FlatStyle = "Flat"
$cmbLevel.BackColor = $C.Hover
$cmbLevel.ForeColor = $C.Text
[void]$cmbLevel.Items.AddRange(@("info", "debug", "warn", "error"))
$cmbLevel.SelectedIndex = 0
$sidebar.Controls.Add($cmbLevel)

# --- pre-flight -----------------------------------------------------------
$lblChecks = New-Object System.Windows.Forms.Label
$lblChecks.Text = "PRE-FLIGHT"
$lblChecks.Font = $FontSmall
$lblChecks.ForeColor = $C.Dim
$lblChecks.AutoSize = $true
$lblChecks.Location = New-Object System.Drawing.Point(0, 222)
$sidebar.Controls.Add($lblChecks)

$checkPanel = New-Object System.Windows.Forms.Panel
$checkPanel.Location = New-Object System.Drawing.Point(0, 244)
$checkPanel.Size = New-Object System.Drawing.Size(292, 300)
$checkPanel.BackColor = $C.Panel
$checkPanel.Anchor = "Top,Left,Bottom"
$sidebar.Controls.Add($checkPanel)

function Refresh-Checks {
  $checkPanel.Controls.Clear()
  $y = 10
  foreach ($check in (Get-Preflight)) {
    $glyph = New-Object System.Windows.Forms.Label
    if ($check.Ok) {
      $glyph.Text = [char]0x2713
      $glyph.ForeColor = $C.Success
    } elseif ($check.Warn) {
      $glyph.Text = "!"
      $glyph.ForeColor = $C.Warning
    } else {
      $glyph.Text = [char]0x2717
      $glyph.ForeColor = $C.Danger
    }
    $glyph.Font = $FontBold
    $glyph.AutoSize = $true
    $glyph.Location = New-Object System.Drawing.Point(12, $y)
    $checkPanel.Controls.Add($glyph)

    $name = New-Object System.Windows.Forms.Label
    $name.Text = $check.Label
    $name.Font = $FontBold
    $name.ForeColor = $C.Text
    $name.AutoSize = $true
    $name.Location = New-Object System.Drawing.Point(34, $y)
    $checkPanel.Controls.Add($name)

    $detail = New-Object System.Windows.Forms.Label
    $detail.Text = $check.Detail
    $detail.Font = $FontSmall
    $detail.ForeColor = $C.Dim
    $detail.AutoSize = $false
    $detail.Size = New-Object System.Drawing.Size(240, 16)
    $detail.Location = New-Object System.Drawing.Point(34, ($y + 17))
    $checkPanel.Controls.Add($detail)

    $y += 42
  }
}

# --- log ------------------------------------------------------------------
$lblLog = New-Object System.Windows.Forms.Label
$lblLog.Text = "SERVER LOG"
$lblLog.Font = $FontSmall
$lblLog.ForeColor = $C.Dim
$lblLog.AutoSize = $true
$lblLog.Location = New-Object System.Drawing.Point(324, 82)
$form.Controls.Add($lblLog)

$chkFollow = New-Object System.Windows.Forms.CheckBox
$chkFollow.Text = "Follow"
$chkFollow.Checked = $true
$chkFollow.ForeColor = $C.Dim
$chkFollow.AutoSize = $true
$chkFollow.Location = New-Object System.Drawing.Point(790, 78)
$chkFollow.Anchor = "Top,Right"
$form.Controls.Add($chkFollow)

$btnClear = New-FlatButton "Clear" 872 74 100 26 ""
$btnClear.Font = $FontSmall
$btnClear.Anchor = "Top,Right"
$form.Controls.Add($btnClear)

$log = New-Object System.Windows.Forms.RichTextBox
$log.Location = New-Object System.Drawing.Point(324, 104)
$log.Size = New-Object System.Drawing.Size(648, 532)
$log.BackColor = $C.LogBg
$log.ForeColor = $C.Text
$log.Font = $FontMono
$log.ReadOnly = $true
$log.BorderStyle = "None"
$log.WordWrap = $true
$log.Anchor = "Top,Left,Bottom,Right"
$form.Controls.Add($log)

# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------

$script:proc = $null
$script:startedAt = $null
# The stdout/stderr events fire on other threads, so lines are queued here and
# drained by the UI timer instead of touching the control directly.
$script:queue = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))
$script:subscriptions = @()

function Write-Log($text, $color) {
  $log.SelectionStart = $log.TextLength
  $log.SelectionLength = 0
  $log.SelectionColor = $color
  $log.AppendText($text + [Environment]::NewLine)
  $log.SelectionColor = $log.ForeColor

  # Keep the buffer bounded or the control slows to a crawl.
  if ($log.Lines.Count -gt 600) {
    $log.Lines = $log.Lines[-400..-1]
  }
  if ($chkFollow.Checked) {
    $log.SelectionStart = $log.TextLength
    $log.ScrollToCaret()
  }
}

function Colour-For($line) {
  if ($line -match '\bERROR\b') { return $C.Danger }
  if ($line -match '\bWARN\b')  { return $C.Warning }
  if ($line -match '\bDEBUG\b') { return $C.Dim }
  if ($line -match '\bINFO\b')  { return $C.Info }
  return $C.Text
}

function Start-Server {
  if ($script:proc -and -not $script:proc.HasExited) { return }

  if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Log "Dependencies are not installed. Run: npm install" $C.Danger
    return
  }

  $stamp = (Get-Date).ToString("HH:mm:ss")
  Write-Log "$stamp  starting MediaWatcher (node server.js)" $C.Accent

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node"
  $psi.Arguments = "server.js"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables["LOG_LEVEL"] = $cmbLevel.SelectedItem

  $script:proc = New-Object System.Diagnostics.Process
  $script:proc.StartInfo = $psi
  $script:proc.EnableRaisingEvents = $true

  $queueRef = $script:queue
  $script:subscriptions += Register-ObjectEvent -InputObject $script:proc -EventName OutputDataReceived -MessageData $queueRef -Action {
    if ($EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) }
  }
  $script:subscriptions += Register-ObjectEvent -InputObject $script:proc -EventName ErrorDataReceived -MessageData $queueRef -Action {
    if ($EventArgs.Data) { $Event.MessageData.Enqueue("!" + $EventArgs.Data) }
  }

  [void]$script:proc.Start()
  $script:proc.BeginOutputReadLine()
  $script:proc.BeginErrorReadLine()
  $script:startedAt = Get-Date
}

function Stop-Server {
  if (-not $script:proc) { return }
  if ($script:proc.HasExited) { $script:proc = $null; return }

  $stamp = (Get-Date).ToString("HH:mm:ss")
  Write-Log "$stamp  stopping server" $C.Accent

  # Node on Windows cannot receive SIGTERM, so the tree is terminated. Safe:
  # SQLite runs in WAL mode and recovers on next open.
  & taskkill /PID $script:proc.Id /T /F 2>&1 | Out-Null

  foreach ($subscription in $script:subscriptions) {
    Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
  }
  $script:subscriptions = @()
  $script:proc = $null
  $script:startedAt = $null
}

function Open-Target($target) {
  Start-Process $target
}

# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

$btnStart.Add_Click({ Start-Server })
$btnStop.Add_Click({ Stop-Server })
$btnRestart.Add_Click({
  Stop-Server
  Start-Sleep -Milliseconds 900
  Start-Server
})
$btnOpen.Add_Click({ Open-Target ("http://localhost:" + (Get-AppPort)) })
$btnLibrary.Add_Click({ Open-Target (Get-LibraryPath) })
$btnClear.Add_Click({ $log.Clear() })

$btnRescan.Add_Click({
  try {
    $uri = "http://127.0.0.1:" + (Get-AppPort) + "/api/media/rescan"
    [void](Invoke-WebRequest -Uri $uri -Method POST -UseBasicParsing -TimeoutSec 10)
    Write-Log ((Get-Date).ToString("HH:mm:ss") + "  rescan requested") $C.Accent
  } catch {
    Write-Log ((Get-Date).ToString("HH:mm:ss") + "  rescan failed: " + $_.Exception.Message) $C.Danger
  }
})

# --- UI tick: drain the log queue and refresh status ----------------------
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  while ($script:queue.Count -gt 0) {
    $line = $script:queue.Dequeue()
    if ($line.StartsWith("!")) {
      Write-Log $line.Substring(1) $C.Danger
    } else {
      Write-Log $line (Colour-For $line)
    }
  }

  $running = $script:proc -and -not $script:proc.HasExited
  if (-not $running -and $script:proc) {
    Write-Log ((Get-Date).ToString("HH:mm:ss") + "  server exited") $C.Dim
    $script:proc = $null
    $script:startedAt = $null
    $running = $false
  }

  if ($running) {
    $span = (Get-Date) - $script:startedAt
    $uptime = "{0:mm}m {0:ss}s" -f $span
    if ($span.TotalHours -ge 1) { $uptime = "{0:hh}h {0:mm}m" -f $span }
    $status.Text = ([char]0x25CF) + " Running   pid " + $script:proc.Id + "   " + $uptime
    $status.ForeColor = $C.Success
  } else {
    $status.Text = ([char]0x25CF) + " Stopped"
    $status.ForeColor = $C.Dim
  }

  $btnStart.Enabled = -not $running
  $btnStop.Enabled = $running
  $btnRestart.Enabled = $running
  $btnOpen.Enabled = $running
  $btnRescan.Enabled = $running
})

$form.Add_Shown({
  Refresh-Checks
  Write-Log ((Get-Date).ToString("HH:mm:ss") + "  launcher ready - press Start server") $C.Accent
  $timer.Start()
})

# Closing the window must not orphan the server.
$form.Add_FormClosing({
  $timer.Stop()
  Stop-Server
})

[void]$form.ShowDialog()
