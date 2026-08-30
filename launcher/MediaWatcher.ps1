<#
  MediaWatcher launcher entry point.
  Run via MediaWatcher.bat, or directly:
    powershell -ExecutionPolicy Bypass -File launcher\MediaWatcher.ps1

  Threading rule: nothing touches the UI except the dispatcher tick and direct
  user event handlers. Server output and API polling both land in synchronized
  queues that the tick drains.
#>
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$LauncherRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $LauncherRoot

. (Join-Path $LauncherRoot 'lib\Config.ps1')
. (Join-Path $LauncherRoot 'lib\ServerProcess.ps1')
. (Join-Path $LauncherRoot 'lib\Preflight.ps1')
. (Join-Path $LauncherRoot 'lib\ApiClient.ps1')

# --- load the window -------------------------------------------------------
$xamlPath = Join-Path $LauncherRoot 'MainWindow.xaml'
try {
  [xml]$xamlDoc = Get-Content -LiteralPath $xamlPath -Raw
  $reader = New-Object System.Xml.XmlNodeReader $xamlDoc
  $window = [Windows.Markup.XamlReader]::Load($reader)
} catch {
  [System.Windows.MessageBox]::Show(
    "MediaWatcher launcher could not load its interface.`n`n$($_.Exception.Message)",
    'MediaWatcher', 'OK', 'Error') | Out-Null
  exit 1
}

# Bind every x:Name to a script variable of the same name. Names declared inside
# ControlTemplates are not reachable from the window, so FindName returns null
# for them and they are skipped rather than shadowing anything.
$XAML_NS = 'http://schemas.microsoft.com/winfx/2006/xaml'
foreach ($node in $xamlDoc.SelectNodes("//*[@*[local-name()='Name']]")) {
  $attribute = $node.Attributes.GetNamedItem('Name', $XAML_NS)
  if ($null -eq $attribute) { continue }
  $element = $window.FindName($attribute.Value)
  if ($null -ne $element) { Set-Variable -Name $attribute.Value -Value $element -Scope Script }
}

# --- shared state ----------------------------------------------------------
$script:Config = Get-MwConfig -Root $ProjectRoot
$script:OutputQueue = New-MwQueue
$script:ResultQueue = New-MwQueue
$script:ServerHandle = $null
$script:PollerHandle = $null
$script:FixHandles = @()
$script:LastStatus = ''
$script:ActiveJobCount = 0
$script:LibraryKnown = $false
$script:CurrentTab = 'log'

$converter = New-Object System.Windows.Media.BrushConverter
$script:LogBrushes = @{
  error  = $converter.ConvertFromString('#ef4444')
  warn   = $converter.ConvertFromString('#f59e0b')
  info   = $converter.ConvertFromString('#93c5fd')
  debug  = $converter.ConvertFromString('#888888')
  plain  = $converter.ConvertFromString('#e5e5e5')
  notice = $converter.ConvertFromString('#a855f7')
}

$LOG_CAP = 500

# --- animation seams (real storyboards land in Task 9) ---------------------
function Start-LineEntrance { param($Element) $Element.Opacity = 1 }
function Start-PaneEntrance { param($Element) $Element.Opacity = 1 }
function Start-StatusTransition { param([string]$Status) }

# --- log -------------------------------------------------------------------
function Add-LogLine {
  param([string]$Text, [string]$Level, [bool]$Animate)

  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.FontFamily = New-Object System.Windows.Media.FontFamily 'Consolas'
  $block.FontSize = 11.5
  $block.TextWrapping = 'Wrap'
  $block.Margin = New-Object System.Windows.Thickness 0, 0, 0, 2
  $block.Foreground = $script:LogBrushes[$Level]

  if ($Animate) {
    $block.Opacity = 0
    $transform = New-Object System.Windows.Media.TranslateTransform
    $transform.X = -10
    $block.RenderTransform = $transform
  }

  [void]$LogItems.Items.Add($block)
  if ($Animate) { Start-LineEntrance $block }

  while ($LogItems.Items.Count -gt $LOG_CAP) { $LogItems.Items.RemoveAt(0) }
  if ($ChkFollow.IsChecked) { $LogScroll.ScrollToEnd() }
}

# --- status ----------------------------------------------------------------
function Set-ServerStatus {
  param([string]$Status)   # stopped | starting | running

  if ($Status -eq $script:LastStatus) { return }
  $script:LastStatus = $Status

  switch ($Status) {
    'running'  { $StatusText.Text = 'Running' }
    'starting' { $StatusText.Text = 'Starting' }
    default    { $StatusText.Text = 'Stopped' }
  }
  Start-StatusTransition $Status
}

function Update-ButtonStates {
  $running = ($null -ne $script:ServerHandle) -and
             ($null -ne $script:ServerHandle.Process) -and
             (-not $script:ServerHandle.Process.HasExited)

  $BtnStart.IsEnabled = -not $running
  $BtnStop.IsEnabled = $running
  $BtnRestart.IsEnabled = $running
  $BtnOpenApp.IsEnabled = $running
  $BtnRescan.IsEnabled = $running
  return $running
}

function Clear-StatusTiles {
  $dash = [string][char]0x2014
  $TileFiles.Text = $dash
  $TileShows.Text = $dash
  $TileMovies.Text = $dash
  $TileDownloads.Text = $dash
  $script:LibraryKnown = $false
}

# --- API results (fully populated in Task 8) -------------------------------
function Receive-ApiResult {
  param([hashtable]$Result)
  if ($Result.Kind -eq 'error') { return }
}

# --- server control --------------------------------------------------------
function Start-Server {
  if ($null -ne $script:ServerHandle) { return }
  $level = [string]$CmbLogLevel.SelectedItem.Content
  Set-ServerStatus 'starting'
  $script:ServerHandle = Start-MwServer -Config $script:Config -LogLevel $level -Queue $script:OutputQueue
  Update-ButtonStates | Out-Null
}

function Stop-Server {
  if ($null -eq $script:ServerHandle) { return }
  Write-MwQueueNotice $script:OutputQueue 'stopping server'
  Stop-MwHandle $script:ServerHandle
  $script:ServerHandle = $null
  Set-ServerStatus 'stopped'
  Clear-StatusTiles
  Update-ButtonStates | Out-Null
}

$BtnStart.Add_Click({ Start-Server })
$BtnStop.Add_Click({ Stop-Server })
$BtnRestart.Add_Click({
  Stop-Server
  Start-Sleep -Milliseconds 900
  Start-Server
})
$BtnOpenApp.Add_Click({ Start-Process ("http://localhost:" + $script:Config.Port) })
$BtnLibrary.Add_Click({
  if (Test-Path -LiteralPath $script:Config.LibraryPath) {
    Start-Process $script:Config.LibraryPath
  } else {
    Write-MwQueueNotice $script:OutputQueue "library folder does not exist: $($script:Config.LibraryPath)"
  }
})
$BtnClearLog.Add_Click({ $LogItems.Items.Clear() })

# --- window chrome ---------------------------------------------------------
$TitleBar.Add_MouseLeftButtonDown({
  if ($_.ClickCount -eq 2) { return }
  $window.DragMove()
})
$BtnMinimize.Add_Click({ $window.WindowState = 'Minimized' })
$BtnClose.Add_Click({ $window.Close() })

# --- dispatcher tick: the only thing allowed to touch the UI ---------------
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(200)

$timer.Add_Tick({
  # Drain server + fix-command output. Count first so the animation gate can
  # tell a trickle from a burst: more than one line per 200ms tick (~5/sec)
  # appends flat instead of animating.
  $batch = @()
  while ($script:OutputQueue.Count -gt 0) { $batch += $script:OutputQueue.Dequeue() }
  $animate = ($batch.Count -le 1)

  foreach ($message in $batch) {
    if ($message.Kind -eq 'notice') { $level = 'notice' }
    elseif ($message.Kind -eq 'stderr') { $level = 'error' }
    else { $level = Get-MwLogLevel $message.Text }

    $text = $message.Text
    if ($message.Kind -eq 'notice') {
      $text = $message.Timestamp.ToString('HH:mm:ss') + '  ' + $message.Text
    }
    Add-LogLine -Text $text -Level $level -Animate $animate
  }

  while ($script:ResultQueue.Count -gt 0) {
    Receive-ApiResult $script:ResultQueue.Dequeue()
  }

  $running = Update-ButtonStates
  if (-not $running -and $null -ne $script:ServerHandle) {
    $code = $script:ServerHandle.Process.ExitCode
    Write-MwQueueNotice $script:OutputQueue "server exited (code $code)"
    Stop-MwHandle $script:ServerHandle
    $script:ServerHandle = $null
    if ($null -ne $script:PollerHandle) {
      Stop-ApiPoller $script:PollerHandle
      $script:PollerHandle = $null
    }
    Set-ServerStatus 'stopped'
    Clear-StatusTiles
  } elseif ($running) {
    $uptime = (Get-Date) - $script:ServerHandle.StartedAt
    $shown = '{0:mm}m {0:ss}s' -f $uptime
    if ($uptime.TotalHours -ge 1) { $shown = '{0:hh}h {0:mm}m' -f $uptime }
    $StatusText.Text = "Running   pid $($script:ServerHandle.Process.Id)   $shown"
  }
})

# --- boot ------------------------------------------------------------------
$window.Add_Loaded({
  Write-MwQueueNotice $script:OutputQueue 'launcher ready - press Start server'
  Set-ServerStatus 'stopped'
  Update-ButtonStates | Out-Null
  $timer.Start()
})

# Closing the window must never orphan the server.
$window.Add_Closing({
  $timer.Stop()
  foreach ($handle in $script:FixHandles) { Stop-MwHandle $handle }
  if ($null -ne $script:PollerHandle) { Stop-ApiPoller $script:PollerHandle }
  if ($null -ne $script:ServerHandle) { Stop-MwHandle $script:ServerHandle }
})

[void]$window.ShowDialog()
