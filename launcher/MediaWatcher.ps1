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
. (Join-Path $LauncherRoot 'lib\Supervisor.ps1')
. (Join-Path $LauncherRoot 'lib\System.ps1')

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
# Auto-restart. Held here rather than inside the supervisor so the timer loop,
# the buttons and the checkbox all read and write one object.
$script:Supervisor = New-MwSupervisorState
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

# --- motion ----------------------------------------------------------------
# Everything animates Opacity and RenderTransform only, so it stays on the GPU
# compositor. Nothing here animates layout properties.
$script:EaseOut = New-Object System.Windows.Media.Animation.QuinticEase
$script:EaseOut.EasingMode = 'EaseOut'

function Start-LineEntrance {
  param($Element)

  $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
  $fade.From = 0; $fade.To = 1
  $fade.Duration = [TimeSpan]::FromMilliseconds(450)
  $fade.EasingFunction = $script:EaseOut

  $slide = New-Object System.Windows.Media.Animation.DoubleAnimation
  $slide.From = -10; $slide.To = 0
  $slide.Duration = [TimeSpan]::FromMilliseconds(450)
  $slide.EasingFunction = $script:EaseOut

  $Element.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
  if ($null -ne $Element.RenderTransform) {
    $Element.RenderTransform.BeginAnimation(
      [System.Windows.Media.TranslateTransform]::XProperty, $slide)
  }
}

function Start-PaneEntrance {
  param($Element)

  $transform = New-Object System.Windows.Media.TranslateTransform
  $transform.Y = 14
  $Element.RenderTransform = $transform
  $Element.Opacity = 0

  $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
  $fade.From = 0; $fade.To = 1
  $fade.Duration = [TimeSpan]::FromMilliseconds(260)
  $fade.EasingFunction = $script:EaseOut

  $rise = New-Object System.Windows.Media.Animation.DoubleAnimation
  $rise.From = 14; $rise.To = 0
  $rise.Duration = [TimeSpan]::FromMilliseconds(260)
  $rise.EasingFunction = $script:EaseOut

  $Element.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
  $transform.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $rise)
}

function Start-StaggeredEntrance {
  param($Elements)

  $delay = 0
  foreach ($element in $Elements) {
    $transform = New-Object System.Windows.Media.TranslateTransform
    $transform.Y = 14
    $element.RenderTransform = $transform
    $element.Opacity = 0

    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
    $fade.From = 0; $fade.To = 1
    $fade.Duration = [TimeSpan]::FromMilliseconds(260)
    $fade.BeginTime = [TimeSpan]::FromMilliseconds($delay)
    $fade.EasingFunction = $script:EaseOut

    $rise = New-Object System.Windows.Media.Animation.DoubleAnimation
    $rise.From = 14; $rise.To = 0
    $rise.Duration = [TimeSpan]::FromMilliseconds(260)
    $rise.BeginTime = [TimeSpan]::FromMilliseconds($delay)
    $rise.EasingFunction = $script:EaseOut

    $element.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
    $transform.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $rise)
    $delay += 130
  }
}

$script:StatusPalette = @{
  stopped  = @{ Dot = '#666666'; Fill = '#1f1f1f'; Border = '#2a2a2a'; Text = '#888888' }
  starting = @{ Dot = '#f59e0b'; Fill = '#2b2110'; Border = '#5a4318'; Text = '#f59e0b' }
  running  = @{ Dot = '#10b981'; Fill = '#10251c'; Border = '#1a4d3a'; Text = '#10b981' }
}

function New-ColorAnimation {
  param([string]$ToHex)

  $animation = New-Object System.Windows.Media.Animation.ColorAnimation
  $animation.To = [System.Windows.Media.ColorConverter]::ConvertFromString($ToHex)
  $animation.Duration = [TimeSpan]::FromMilliseconds(400)
  return $animation
}

function Set-AnimatableBrush {
  <#
    Brushes that come from a Style or a XAML literal are frozen, and a frozen
    Freezable cannot be animated. Swap in an unfrozen clone the first time.
  #>
  param($Target, [string]$Property)

  $current = $Target.$Property
  if ($null -eq $current) { return $null }
  if ($current.IsFrozen) {
    $clone = $current.Clone()
    $Target.$Property = $clone
    return $clone
  }
  return $current
}

function Start-StatusTransition {
  param([string]$Status)

  $palette = $script:StatusPalette[$Status]
  if ($null -eq $palette) { $palette = $script:StatusPalette['stopped'] }

  $targets = @(
    @{ Target = $StatusDot;  Property = 'Fill';        Hex = $palette.Dot },
    @{ Target = $StatusPill; Property = 'Background';  Hex = $palette.Fill },
    @{ Target = $StatusPill; Property = 'BorderBrush'; Hex = $palette.Border },
    @{ Target = $StatusText; Property = 'Foreground';  Hex = $palette.Text }
  )

  foreach ($entry in $targets) {
    $brush = Set-AnimatableBrush -Target $entry.Target -Property $entry.Property
    if ($null -eq $brush) { continue }
    $brush.BeginAnimation(
      [System.Windows.Media.SolidColorBrush]::ColorProperty,
      (New-ColorAnimation $entry.Hex))
  }

  Set-StatusPulse ($Status -eq 'running')
}

function Set-StatusPulse {
  param([bool]$On)

  if (-not $On) {
    $StatusDot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
    $StatusDot.Opacity = 1
    return
  }

  $pulse = New-Object System.Windows.Media.Animation.DoubleAnimation
  $pulse.From = 1; $pulse.To = 0.35
  $pulse.Duration = [TimeSpan]::FromMilliseconds(1600)
  $pulse.AutoReverse = $true
  $pulse.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $StatusDot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $pulse)
}

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

# --- downloads -------------------------------------------------------------
function Start-ProgressFill {
  param($Fill, $Track, [int]$Percent)

  $apply = {
    $target = $Track.ActualWidth * ($Percent / 100.0)

    $grow = New-Object System.Windows.Media.Animation.DoubleAnimation
    # From is not optional here. A Border with no explicit width has Width =
    # Double.NaN (Auto), and a To-only animation interpolates from the current
    # value - NaN - which throws AnimationException on the render thread's
    # animation tick. That is not catchable at the call site, so it took the
    # whole launcher down, and the Closing handler took the server with it.
    $grow.From = 0
    $grow.To = $target
    $grow.Duration = [TimeSpan]::FromMilliseconds(400)
    $grow.EasingFunction = $script:EaseOut
    $Fill.BeginAnimation([System.Windows.FrameworkElement]::WidthProperty, $grow)

    # A translucent band sweeping the filled portion, so an active transfer
    # looks alive even when the percentage is barely moving.
    if ($Percent -gt 0 -and $Percent -lt 100) {
      $sheen = New-Object System.Windows.Controls.Border
      $sheen.Width = 40
      $sheen.HorizontalAlignment = 'Left'

      $brush = New-Object System.Windows.Media.LinearGradientBrush
      $brush.StartPoint = New-Object System.Windows.Point 0, 0
      $brush.EndPoint = New-Object System.Windows.Point 1, 0
      $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Colors]::Transparent), 0))
      $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Color]::FromArgb(96, 255, 255, 255)), 0.5))
      $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Colors]::Transparent), 1))
      $sheen.Background = $brush

      $transform = New-Object System.Windows.Media.TranslateTransform
      $sheen.RenderTransform = $transform
      $Fill.Child = $sheen

      $sweep = New-Object System.Windows.Media.Animation.DoubleAnimation
      $sweep.From = -40
      $sweep.To = [math]::Max($target, 60)
      $sweep.Duration = [TimeSpan]::FromMilliseconds(1500)
      $sweep.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
      $transform.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $sweep)
    }
  }.GetNewClosure()

  if ($Track.ActualWidth -gt 0) { & $apply } else { $Track.Add_Loaded($apply) }
}

function New-DownloadRow {
  param([hashtable]$Job)

  $stack = New-Object System.Windows.Controls.StackPanel
  $stack.Margin = New-Object System.Windows.Thickness 0, 0, 0, 16

  $head = New-Object System.Windows.Controls.DockPanel
  $percent = New-Object System.Windows.Controls.TextBlock
  $percent.Text = "$($Job.Percent)%"
  $percent.FontSize = 11
  $percent.Foreground = $script:LogBrushes['debug']
  [System.Windows.Controls.DockPanel]::SetDock($percent, 'Right')
  [void]$head.Children.Add($percent)

  $title = New-Object System.Windows.Controls.TextBlock
  $title.Text = $Job.Title
  $title.FontSize = 12
  $title.Foreground = $script:LogBrushes['plain']
  $title.TextTrimming = 'CharacterEllipsis'
  [void]$head.Children.Add($title)
  [void]$stack.Children.Add($head)

  $track = New-Object System.Windows.Controls.Border
  $track.Height = 6
  $track.CornerRadius = New-Object System.Windows.CornerRadius 3
  $track.Background = $converter.ConvertFromString('#1f1f1f')
  $track.Margin = New-Object System.Windows.Thickness 0, 6, 0, 0
  $track.HorizontalAlignment = 'Stretch'

  $fill = New-Object System.Windows.Controls.Border
  $fill.CornerRadius = New-Object System.Windows.CornerRadius 3
  $fill.Background = $window.FindResource('AccentGradient')
  $fill.HorizontalAlignment = 'Left'
  $track.Child = $fill
  [void]$stack.Children.Add($track)

  if ($Job.Phase -or $Job.Error) {
    $note = New-Object System.Windows.Controls.TextBlock
    $note.FontSize = 10
    $note.Margin = New-Object System.Windows.Thickness 0, 5, 0, 0
    $note.TextWrapping = 'Wrap'
    if ($Job.Error) {
      $note.Text = $Job.Error
      $note.Foreground = $script:LogBrushes['error']
    } else {
      $note.Text = $Job.Phase
      $note.Foreground = $script:LogBrushes['debug']
    }
    [void]$stack.Children.Add($note)
  }

  return @{ Element = $stack; Fill = $fill; Track = $track; Percent = $Job.Percent }
}

<#
  Throughput, sampled from progress rather than from the socket.

  The launcher never sees the bytes - it polls the API for a percentage - so
  the rate is derived: total progress across active jobs, differenced against
  the previous sample and divided by the elapsed time. That makes it an
  estimate of aggregate completion rather than a byte counter, which is
  honest about what it can actually know and is still the number you want
  when the question is "is this moving?".
#>
$script:ThroughputSamples = New-Object System.Collections.Generic.List[double]
$script:ThroughputLast = $null
$script:ThroughputMax = 60

function Add-ThroughputSample {
  param($Jobs)

  $now = Get-Date
  $active = @($Jobs | Where-Object { $_.Status -eq 'downloading' })

  # Nothing running means a genuine zero, not a gap - a flat line while idle
  # is the correct picture and keeps the graph's scale stable.
  $completion = 0.0
  foreach ($job in $active) { $completion += ([double]$job.Percent) }

  if ($null -ne $script:ThroughputLast) {
    $elapsed = ($now - $script:ThroughputLast.At).TotalSeconds
    if ($elapsed -gt 0.25) {
      $delta = $completion - $script:ThroughputLast.Completion
      # Only forward movement. A finished job leaves the active set and drops
      # the total, which would otherwise read as a large negative rate.
      if ($delta -lt 0) { $delta = 0 }
      $rate = $delta / $elapsed
      $script:ThroughputSamples.Add($rate)
      while ($script:ThroughputSamples.Count -gt $script:ThroughputMax) {
        $script:ThroughputSamples.RemoveAt(0)
      }
      $script:ThroughputLast = @{ At = $now; Completion = $completion }
    }
  } else {
    $script:ThroughputLast = @{ At = $now; Completion = $completion }
  }

  return $active.Count
}

function Draw-Throughput {
  $canvas = $ThroughputCanvas
  $canvas.Children.Clear()

  $count = $script:ThroughputSamples.Count
  if ($count -lt 2) { return }

  $width = $canvas.ActualWidth
  if ($width -le 0) { $width = 320 }
  $height = $canvas.ActualHeight
  if ($height -le 0) { $height = 46 }

  # Scaled to the tallest sample in view, with a floor so a nearly-flat line
  # does not get amplified into noise.
  $peak = 0.0
  foreach ($sample in $script:ThroughputSamples) { if ($sample -gt $peak) { $peak = $sample } }
  if ($peak -lt 0.5) { $peak = 0.5 }

  $points = New-Object System.Windows.Media.PointCollection
  for ($i = 0; $i -lt $count; $i++) {
    $x = ($i / [double]($count - 1)) * $width
    $y = $height - (($script:ThroughputSamples[$i] / $peak) * ($height - 4)) - 2
    [void]$points.Add((New-Object System.Windows.Point $x, $y))
  }

  $line = New-Object System.Windows.Shapes.Polyline
  $line.Points = $points
  $line.Stroke = $script:LogBrushes['plain']
  $line.StrokeThickness = 1.6
  $line.StrokeLineJoin = 'Round'
  [void]$canvas.Children.Add($line)

  $latest = $script:ThroughputSamples[$count - 1]
  $TxtThroughput.Text = '{0:0.0}%/s' -f $latest
}

function Refresh-Downloads {
  param($Jobs)

  $DownloadItems.Children.Clear()
  $list = @($Jobs)

  $activeCount = Add-ThroughputSample -Jobs $list
  # The graph appears only while something is transferring; a flat line over an
  # empty queue is a chart of nothing.
  if ($activeCount -gt 0) {
    $ThroughputPanel.Visibility = 'Visible'
    Draw-Throughput
  } else {
    $ThroughputPanel.Visibility = 'Collapsed'
  }

  if ($list.Count -eq 0) {
    $DownloadsEmpty.Visibility = 'Visible'
    return
  }
  $DownloadsEmpty.Visibility = 'Collapsed'

  foreach ($job in $list) {
    $row = New-DownloadRow -Job $job
    [void]$DownloadItems.Children.Add($row.Element)
    Start-ProgressFill -Fill $row.Fill -Track $row.Track -Percent $row.Percent
  }

  Send-DownloadNotifications -Jobs $list
}

<#
  Tell you when something finishes, whichever tab you are on.

  Tracked by id against the previous poll rather than by listening for an
  event: the launcher only ever sees job snapshots, so a transition is
  something it has to notice by comparing. Only completions and failures are
  announced - a queue that merely started is not news.
#>
$script:LastJobStatus = @{}

function Send-DownloadNotifications {
  param($Jobs)

  foreach ($job in @($Jobs)) {
    $id = [string]$job.Id
    $status = [string]$job.Status
    $previous = $null
    if ($script:LastJobStatus.ContainsKey($id)) { $previous = $script:LastJobStatus[$id] }

    # A first sighting is not a transition. Without this every job in the
    # database announces itself the moment the launcher opens.
    if ($null -ne $previous -and $previous -ne $status) {
      if ($status -eq 'complete') {
        Write-MwQueueNotice $script:OutputQueue "finished: $($job.Title)"
        Show-MwToast -Title 'Download finished' -Text $job.Title
      } elseif ($status -eq 'error') {
        Write-MwQueueNotice $script:OutputQueue "failed: $($job.Title)"
        Show-MwToast -Title 'Download failed' -Text $job.Title
      }
    }
    $script:LastJobStatus[$id] = $status
  }
}

<#
  A balloon from the tray icon.

  Deliberately the old NotifyIcon rather than a modern toast: a real Windows
  toast needs a registered AppUserModelID and a Start Menu shortcut, which is
  an installer's job, and this application is a script someone runs from a
  folder. A balloon works with neither.
#>
function Show-MwToast {
  param([string]$Title, [string]$Text)

  try {
    if ($null -eq $script:TrayIcon) {
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
      $script:TrayIcon = New-Object System.Windows.Forms.NotifyIcon
      $script:TrayIcon.Icon = [System.Drawing.SystemIcons]::Information
      $script:TrayIcon.Visible = $true
    }
    $script:TrayIcon.BalloonTipTitle = $Title
    $script:TrayIcon.BalloonTipText = $Text
    $script:TrayIcon.ShowBalloonTip(4000)
  } catch {
    # No tray, no notification. The log line above already said it.
  }
}

# --- API results -----------------------------------------------------------
function Receive-ApiResult {
  param([hashtable]$Result)

  switch ($Result.Kind) {
    'health' {
      # Health only proves reachability; process liveness drives the pill.
    }
    'library' {
      $summary = ConvertTo-MwLibrarySummary $Result.Data
      if ($null -ne $summary) {
        $script:LibraryKnown = $true
        $TileFiles.Text = [string]$summary.Files
        $TileShows.Text = [string]$summary.Shows
        $TileMovies.Text = [string]$summary.Movies
      }
    }
    'jobs' {
      $jobs = ConvertTo-MwJobSummary $Result.Data
      $script:ActiveJobCount = Get-MwActiveJobCount $jobs
      $TileDownloads.Text = [string]$script:ActiveJobCount

      if ($script:ActiveJobCount -gt 0) {
        $BadgeDownloads.Visibility = 'Visible'
        $BadgeDownloadsText.Text = [string]$script:ActiveJobCount
      } else {
        $BadgeDownloads.Visibility = 'Collapsed'
      }
      Refresh-Downloads $jobs
    }
    'notice' {
      Write-MwQueueNotice $script:OutputQueue ([string]$Result.Data)
    }
    'error' {
      # The server is unreachable: show unknown rather than stale numbers.
      if ($script:LibraryKnown) { Clear-StatusTiles }
    }
  }
}

# --- server control --------------------------------------------------------
function Start-Server {
  if ($null -ne $script:ServerHandle) { return }
  $level = [string]$CmbLogLevel.SelectedItem.Content

  # Starting by hand clears both a pending restart and the "you asked for this"
  # flag, so the supervisor treats what follows as a fresh run.
  $script:Supervisor.UserStopped = $false
  $script:Supervisor.RestartAt = $null

  # Clear the port before binding it. A server spawned by a previous launcher
  # outlives the window that started it, so the usual failure is "already in
  # use" against an orphan of our own making rather than a real conflict.
  Clear-Port | Out-Null

  Set-ServerStatus 'starting'
  $script:ServerHandle = Start-MwServer -Config $script:Config -LogLevel $level -Queue $script:OutputQueue
  $script:Supervisor.StartedAt = Get-Date
  if ($null -eq $script:PollerHandle) {
    $script:PollerHandle = Start-ApiPoller -Config $script:Config -ResultQueue $script:ResultQueue
  }
  Update-ButtonStates | Out-Null
}

<#
  Terminate anything of ours squatting the configured port.

  Our own running child is excluded, so this can never shoot the server the
  launcher is currently managing.
#>
function Clear-Port {
  $ownPid = 0
  if ($null -ne $script:ServerHandle -and $null -ne $script:ServerHandle.Process) {
    try { $ownPid = $script:ServerHandle.Process.Id } catch { $ownPid = 0 }
  }

  $result = Stop-MwPortOwner -Port $script:Config.Port -ExcludePid $ownPid `
    -Queue $script:OutputQueue

  if ($result.Killed.Count -eq 0 -and $result.Foreign.Count -eq 0) {
    Write-MwQueueNotice $script:OutputQueue "port $($script:Config.Port) is free"
  }
  return $result
}

function Stop-Server {
  if ($null -eq $script:ServerHandle) { return }
  # Recorded before the process dies, because the exit is noticed on the next
  # timer tick and by then there is nothing left to say who asked for it.
  $script:Supervisor.UserStopped = $true
  $script:Supervisor.RestartAt = $null
  Write-MwQueueNotice $script:OutputQueue 'stopping server'
  Stop-MwHandle $script:ServerHandle
  $script:ServerHandle = $null
  if ($null -ne $script:PollerHandle) {
    Stop-ApiPoller $script:PollerHandle
    $script:PollerHandle = $null
  }
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
$BtnFreePort.Add_Click({
  $result = Clear-Port
  if ($result.Killed.Count -gt 0) {
    Write-MwQueueNotice $script:OutputQueue "freed port $($script:Config.Port) - stopped $($result.Killed.Count) process(es)"
  }
})

$BtnClearLog.Add_Click({ $LogItems.Items.Clear() })
$BtnRescan.Add_Click({
  if ($null -eq $script:PollerHandle) {
    Write-MwQueueNotice $script:OutputQueue 'server is not running'
    return
  }
  Request-Rescan $script:PollerHandle
  Select-Tab 'log'
})

# --- devices ---------------------------------------------------------------
#
# Every row here is a live credential, and the list is complete, so anything
# unfamiliar can be revoked on sight. That is the whole point of the tab.

function New-DeviceRow {
  param([hashtable]$Device)

  $row = New-Object System.Windows.Controls.Grid
  $row.Margin = New-Object System.Windows.Thickness 0, 0, 0, 12

  $colBody = New-Object System.Windows.Controls.ColumnDefinition
  $colBody.Width = New-Object System.Windows.GridLength 1, ([System.Windows.GridUnitType]::Star)
  $colAction = New-Object System.Windows.Controls.ColumnDefinition
  $colAction.Width = New-Object System.Windows.GridLength 84
  $row.ColumnDefinitions.Add($colBody)
  $row.ColumnDefinitions.Add($colAction)

  $stack = New-Object System.Windows.Controls.StackPanel

  $label = New-Object System.Windows.Controls.TextBlock
  $label.Text = $Device.Name
  $label.FontSize = 13
  $label.Foreground = $script:LogBrushes['plain']
  [void]$stack.Children.Add($label)

  $where = 'LAN'
  if ($Device.Origin -eq 'tailscale') { $where = 'Tailscale' }

  $detail = New-Object System.Windows.Controls.TextBlock
  $detail.Text = "$($Device.Browser) - $where - $($Device.LastIp) - last seen $($Device.LastSeen.ToString('d MMM HH:mm'))"
  $detail.FontSize = 10.5
  $detail.TextWrapping = 'Wrap'
  $detail.Margin = New-Object System.Windows.Thickness 0, 1, 8, 0
  $detail.Foreground = $script:LogBrushes['debug']
  [void]$stack.Children.Add($detail)

  [System.Windows.Controls.Grid]::SetColumn($stack, 0)
  [void]$row.Children.Add($stack)

  $button = New-Object System.Windows.Controls.Button
  $button.Content = 'Revoke'
  $button.Style = $window.FindResource('SecondaryButton')
  $button.FontSize = 11
  $button.Padding = New-Object System.Windows.Thickness 12, 4, 12, 4
  $button.VerticalAlignment = 'Top'
  # Carried on the control rather than captured, matching the pre-flight rows:
  # the list is rebuilt on every refresh, and a closure would go stale.
  $button.Tag = $Device
  $button.Add_Click({
    $device = $this.Tag
    $answer = [System.Windows.MessageBox]::Show(
      "Revoke $($device.Name)? It will have to enter the password again.",
      'Revoke device', 'YesNo', 'Warning')
    if ($answer -ne 'Yes') { return }

    try {
      Remove-MwDevice $script:Config $device.Id
      Write-MwQueueNotice $script:OutputQueue "revoked device: $($device.Name)"
      Update-DeviceList
    } catch {
      Write-MwQueueNotice $script:OutputQueue "revoke failed: $($_.Exception.Message)"
    }
  })
  [System.Windows.Controls.Grid]::SetColumn($button, 1)
  [void]$row.Children.Add($button)

  return $row
}

function Update-DeviceList {
  $DeviceItems.Children.Clear()

  $devices = @()
  try {
    # Assigned directly, NOT wrapped in @(). Get-MwDeviceList already hands
    # back an array via the ,$rows idiom, and wrapping it again produces a
    # one-element array holding the empty array - so an empty list would
    # report Count 1 and the "no devices" state would never appear.
    $devices = Get-MwDeviceList $script:Config
  } catch {
    # A stopped server is the usual cause, and the log already says so.
    Write-MwQueueNotice $script:OutputQueue "device list unavailable: $($_.Exception.Message)"
  }

  if ($null -eq $devices -or $devices.Count -eq 0) {
    $DevicesEmpty.Visibility = 'Visible'
    return
  }

  $DevicesEmpty.Visibility = 'Collapsed'
  foreach ($device in $devices) {
    [void]$DeviceItems.Children.Add((New-DeviceRow $device))
  }
}

# --- tabs ------------------------------------------------------------------
function Select-Tab {
  param([string]$Name)   # log | preflight | downloads | devices

  $script:CurrentTab = $Name

  $PaneLog.Visibility = 'Collapsed'
  $PanePreflight.Visibility = 'Collapsed'
  $PaneDownloads.Visibility = 'Collapsed'
  $PaneDevices.Visibility = 'Collapsed'
  $PaneSystem.Visibility = 'Collapsed'

  $dim = $script:LogBrushes['debug']
  $bright = $script:LogBrushes['plain']
  $TabLog.Foreground = $dim
  $TabPreflight.Foreground = $dim
  $TabDownloads.Foreground = $dim
  $TabDevices.Foreground = $dim
  $TabSystem.Foreground = $dim

  # The underline jumps rather than slides - the slide animation was cut by design.
  switch ($Name) {
    'preflight' {
      $PanePreflight.Visibility = 'Visible'
      $TabPreflight.Foreground = $bright
      $TabUnderline.Width = $TabPreflight.ActualWidth
      $TabUnderline.Margin = New-Object System.Windows.Thickness $TabLog.ActualWidth, 0, 0, 0
      Start-PaneEntrance $PanePreflight
    }
    'downloads' {
      $PaneDownloads.Visibility = 'Visible'
      $TabDownloads.Foreground = $bright
      $TabUnderline.Width = $TabDownloads.ActualWidth
      $TabUnderline.Margin = New-Object System.Windows.Thickness ($TabLog.ActualWidth + $TabPreflight.ActualWidth), 0, 0, 0
      Start-PaneEntrance $PaneDownloads
    }
    'devices' {
      $PaneDevices.Visibility = 'Visible'
      $TabDevices.Foreground = $bright
      $TabUnderline.Width = $TabDevices.ActualWidth
      $TabUnderline.Margin = New-Object System.Windows.Thickness ($TabLog.ActualWidth + $TabPreflight.ActualWidth + $TabDownloads.ActualWidth), 0, 0, 0
      Start-PaneEntrance $PaneDevices
      Update-DeviceList
    }
    'system' {
      $PaneSystem.Visibility = 'Visible'
      $TabSystem.Foreground = $bright
      $TabUnderline.Width = $TabSystem.ActualWidth
      $TabUnderline.Margin = New-Object System.Windows.Thickness ($TabLog.ActualWidth + $TabPreflight.ActualWidth + $TabDownloads.ActualWidth + $TabDevices.ActualWidth), 0, 0, 0
      Start-PaneEntrance $PaneSystem
      Update-SystemPane
    }
    default {
      $PaneLog.Visibility = 'Visible'
      $TabLog.Foreground = $bright
      $TabUnderline.Width = $TabLog.ActualWidth
      $TabUnderline.Margin = New-Object System.Windows.Thickness 0, 0, 0, 0
      Start-PaneEntrance $PaneLog
    }
  }

  # Follow/Clear only make sense over the log.
  $visibility = 'Collapsed'
  if ($Name -eq 'log') { $visibility = 'Visible' }
  $ChkFollow.Visibility = $visibility
  $BtnClearLog.Visibility = $visibility

  # Jobs are only polled while their tab is open or something is active.
  if ($null -ne $script:PollerHandle) {
    $wanted = ($Name -eq 'downloads') -or ($script:ActiveJobCount -gt 0)
    Set-ApiPollerJobsWanted $script:PollerHandle $wanted
  }
}

$TabLog.Add_Click({ Select-Tab 'log' })
$TabPreflight.Add_Click({ Select-Tab 'preflight' })
$TabDownloads.Add_Click({ Select-Tab 'downloads' })
$TabDevices.Add_Click({ Select-Tab 'devices' })
$TabSystem.Add_Click({ Select-Tab 'system' })
$BtnRefreshDevices.Add_Click({ Update-DeviceList })

$ChkAutoRestart.Add_Click({
  $script:Supervisor.Enabled = [bool]$ChkAutoRestart.IsChecked
  if (-not $script:Supervisor.Enabled) {
    # Cancel a restart already counting down, or unticking the box would be
    # ignored for as long as the backoff had left to run.
    $script:Supervisor.RestartAt = $null
  }
  Update-SupervisorLabel
})

<#
  What the supervisor is doing, under the checkbox.

  Says something only when there is something to say: a healthy server needs
  no commentary, but a pending restart or an exhausted retry budget does.
#>
function Update-SupervisorLabel {
  if (-not $script:Supervisor.Enabled) {
    $TxtSupervisor.Text = 'off - a crash will leave it stopped'
    return
  }
  if ($null -ne $script:Supervisor.RestartAt) {
    $left = [int][Math]::Max(0, ($script:Supervisor.RestartAt - (Get-Date)).TotalSeconds)
    $TxtSupervisor.Text = "restarting in ${left}s"
    return
  }
  if ($script:Supervisor.Failures -gt 0) {
    $TxtSupervisor.Text = "$($script:Supervisor.Failures) restart(s) so far"
    return
  }
  $TxtSupervisor.Text = ''
}


# --- system pane -----------------------------------------------------------
#
# Everything here shells out to a tool that already exists - tailscale.exe,
# sc.exe, the server's own diagnostics API. The parsing lives in lib\System.ps1
# where it can be tested; this file is the wiring.

$script:TailnetUrl = ''

function Invoke-MwTool {
  param([string]$FilePath, [string[]]$ToolArgs)
  try {
    return (& $FilePath @ToolArgs 2>&1 | Out-String)
  } catch {
    return ''
  }
}

function Invoke-MwApi {
  param([string]$Path, [string]$Method = 'GET')

  if ($null -eq $script:ServerHandle) { return $null }
  try {
    $key = Get-MwAdminKey $script:Config.Root
    return Invoke-RestMethod -Method $Method -TimeoutSec 20 `
      -Uri "http://localhost:$($script:Config.Port)$Path" `
      -Headers @{ 'x-mediawatcher-key' = $key }
  } catch {
    return $null
  }
}

function Format-MwBytes {
  param([double]$Bytes)
  if ($Bytes -le 0) { return '0 B' }
  $units = @('B', 'KB', 'MB', 'GB', 'TB')
  $index = 0
  while ($Bytes -ge 1024 -and $index -lt ($units.Count - 1)) { $Bytes = $Bytes / 1024; $index = $index + 1 }
  return ('{0:0.#} {1}' -f $Bytes, $units[$index])
}

# The server encodes the QR; this draws the matrix it sends back. WPF has no
# SVG renderer, and one rectangle per dark module is a handful of lines.
function Update-QrCode {
  param([string]$Text)

  $QrCanvas.Children.Clear()
  if ([string]::IsNullOrWhiteSpace($Text)) { return }

  $encoded = [uri]::EscapeDataString($Text)
  $response = Invoke-MwApi "/api/diagnostics/qr?format=json&text=$encoded"
  if ($null -eq $response) { return }

  $size = [int]$response.size
  if ($size -le 0) { return }
  $module = [Math]::Floor($QrCanvas.Width / $size)
  if ($module -lt 1) { $module = 1 }

  $black = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Colors]::Black)
  for ($r = 0; $r -lt $size; $r = $r + 1) {
    for ($c = 0; $c -lt $size; $c = $c + 1) {
      if ($response.matrix[$r][$c] -ne 1) { continue }
      $rect = New-Object System.Windows.Shapes.Rectangle
      $rect.Width = $module
      $rect.Height = $module
      $rect.Fill = $black
      [System.Windows.Controls.Canvas]::SetLeft($rect, $c * $module)
      [System.Windows.Controls.Canvas]::SetTop($rect, $r * $module)
      [void]$QrCanvas.Children.Add($rect)
    }
  }
}

function Update-TailscalePane {
  $exe = Get-MwTailscalePath
  if ($null -eq $exe) {
    $TxtTailscaleState.Text = 'Tailscale is not installed'
    $TxtTailnetUrl.Text = 'Install it from tailscale.com to reach this server from anywhere.'
    $BtnTailscaleServe.IsEnabled = $false
    $BtnCopyTailnet.IsEnabled = $false
    $QrCanvas.Children.Clear()
    return
  }

  $status = ConvertTo-MwTailscaleStatus (Invoke-MwTool $exe @('status', '--json'))
  $TxtTailscaleState.Text = $status.Label
  $script:TailnetUrl = Get-MwTailnetUrl $status.DnsName

  if ((-not $status.Running) -or (-not $script:TailnetUrl)) {
    $TxtTailnetUrl.Text = 'Connect Tailscale to get a shareable address.'
    $BtnTailscaleServe.IsEnabled = $false
    $BtnCopyTailnet.IsEnabled = $false
    $QrCanvas.Children.Clear()
    return
  }

  $BtnCopyTailnet.IsEnabled = $true
  $BtnTailscaleServe.IsEnabled = $true

  $serveJson = Invoke-MwTool $exe @('serve', 'status', '--json')
  if (Test-MwServePublished -Json $serveJson -Port $script:Config.Port) {
    $TxtTailnetUrl.Text = $script:TailnetUrl
    $BtnTailscaleServe.Content = 'Stop sharing'
    Update-QrCode $script:TailnetUrl
  } else {
    $TxtTailnetUrl.Text = "$($script:TailnetUrl)  (not shared yet)"
    $BtnTailscaleServe.Content = 'Start sharing'
    $QrCanvas.Children.Clear()
  }
}

function Update-CachePane {
  $diagnostics = Invoke-MwApi '/api/diagnostics'
  if ($null -eq $diagnostics) {
    $TxtCacheSizes.Text = 'Start the server to see cache sizes'
    $BtnSweepCache.IsEnabled = $false
    $BtnClearMp4.IsEnabled = $false
    $BtnClearThumbs.IsEnabled = $false
    return
  }

  $BtnSweepCache.IsEnabled = $true
  $BtnClearMp4.IsEnabled = $true
  $BtnClearThumbs.IsEnabled = $true
  $TxtCacheSizes.Text = ('Video {0} in {1} files     Thumbnails {2} in {3} files' -f `
    (Format-MwBytes $diagnostics.caches.mp4.bytes), $diagnostics.caches.mp4.files, `
    (Format-MwBytes $diagnostics.caches.thumbs.bytes), $diagnostics.caches.thumbs.files)
}

function Update-ServicePane {
  $status = ConvertTo-MwServiceStatus (Invoke-MwTool 'sc.exe' @('query', 'MediaWatcher'))
  $elevated = Test-MwElevated

  $TxtServiceState.Text = $status.Label
  if (-not $elevated) {
    $TxtServiceState.Text = "$($status.Label)  -  run the launcher as administrator to change this"
  }

  $BtnInstallService.IsEnabled = ((-not $status.Installed) -and $elevated)
  $BtnRemoveService.IsEnabled = ($status.Installed -and $elevated)
}

function Update-SystemPane {
  Update-TailscalePane
  Update-CachePane
  Update-ServicePane
}

$BtnCopyTailnet.Add_Click({
  if ($script:TailnetUrl) {
    Set-Clipboard -Value $script:TailnetUrl
    Write-MwQueueNotice $script:OutputQueue "copied $($script:TailnetUrl)"
  }
})

$BtnTailscaleServe.Add_Click({
  $exe = Get-MwTailscalePath
  if ($null -eq $exe) { return }

  if ($BtnTailscaleServe.Content -eq 'Stop sharing') {
    Write-MwQueueNotice $script:OutputQueue 'stopping tailscale serve'
    Invoke-MwTool $exe @('serve', '--https=443', 'off') | Out-Null
  } else {
    Write-MwQueueNotice $script:OutputQueue "publishing port $($script:Config.Port) over tailscale"
    Invoke-MwTool $exe @('serve', '--bg', [string]$script:Config.Port) | Out-Null
  }
  Update-TailscalePane
})

$BtnSweepCache.Add_Click({
  $result = Invoke-MwApi '/api/diagnostics/cache/sweep' 'POST'
  if ($null -ne $result) { Write-MwQueueNotice $script:OutputQueue 'cache swept' }
  Update-CachePane
})

$BtnClearMp4.Add_Click({
  $result = Invoke-MwApi '/api/diagnostics/cache/mp4' 'DELETE'
  if ($null -ne $result) {
    Write-MwQueueNotice $script:OutputQueue "cleared the video cache ($($result.files) files)"
  }
  Update-CachePane
})

$BtnClearThumbs.Add_Click({
  $result = Invoke-MwApi '/api/diagnostics/cache/thumbs' 'DELETE'
  if ($null -ne $result) {
    Write-MwQueueNotice $script:OutputQueue "cleared the thumbnail cache ($($result.files) files)"
  }
  Update-CachePane
})

$BtnInstallService.Add_Click({
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Write-MwQueueNotice $script:OutputQueue 'cannot install: node is not on PATH'
    return
  }
  $installArgs = Get-MwServiceInstallArgs -NodePath $node -Root $script:Config.Root -Port $script:Config.Port
  $output = Invoke-MwTool 'sc.exe' $installArgs
  Write-MwQueueNotice $script:OutputQueue ('sc create: ' + $output.Trim())
  Update-ServicePane
})

$BtnRemoveService.Add_Click({
  Invoke-MwTool 'sc.exe' @('stop', 'MediaWatcher') | Out-Null
  $output = Invoke-MwTool 'sc.exe' @('delete', 'MediaWatcher')
  Write-MwQueueNotice $script:OutputQueue ('sc delete: ' + $output.Trim())
  Update-ServicePane
})

# --- pre-flight ------------------------------------------------------------
function New-PreflightRow {
  param([hashtable]$Check)

  $row = New-Object System.Windows.Controls.Grid
  $row.Margin = New-Object System.Windows.Thickness 0, 0, 0, 14

  $colGlyph = New-Object System.Windows.Controls.ColumnDefinition
  $colGlyph.Width = New-Object System.Windows.GridLength 22
  $colBody = New-Object System.Windows.Controls.ColumnDefinition
  $colBody.Width = New-Object System.Windows.GridLength 1, ([System.Windows.GridUnitType]::Star)
  $colFix = New-Object System.Windows.Controls.ColumnDefinition
  $colFix.Width = [System.Windows.GridLength]::Auto
  $row.ColumnDefinitions.Add($colGlyph)
  $row.ColumnDefinitions.Add($colBody)
  $row.ColumnDefinitions.Add($colFix)

  $glyph = New-Object System.Windows.Controls.TextBlock
  $glyph.FontWeight = 'Bold'
  $glyph.FontSize = 13
  $glyph.VerticalAlignment = 'Top'
  if ($Check.Ok) {
    $glyph.Text = [string][char]0x2713
    $glyph.Foreground = $converter.ConvertFromString('#10b981')
  } elseif ($Check.Severity -eq 'warn') {
    $glyph.Text = '!'
    $glyph.Foreground = $script:LogBrushes['warn']
  } else {
    $glyph.Text = [string][char]0x2717
    $glyph.Foreground = $script:LogBrushes['error']
  }
  [System.Windows.Controls.Grid]::SetColumn($glyph, 0)
  [void]$row.Children.Add($glyph)

  $stack = New-Object System.Windows.Controls.StackPanel
  $label = New-Object System.Windows.Controls.TextBlock
  $label.Text = $Check.Label
  $label.FontWeight = 'SemiBold'
  $label.FontSize = 12
  $label.Foreground = $script:LogBrushes['plain']
  [void]$stack.Children.Add($label)

  $detail = New-Object System.Windows.Controls.TextBlock
  $detail.Text = $Check.Detail
  $detail.FontSize = 10.5
  $detail.TextWrapping = 'Wrap'
  $detail.Margin = New-Object System.Windows.Thickness 0, 1, 8, 0
  $detail.Foreground = $script:LogBrushes['debug']
  [void]$stack.Children.Add($detail)

  [System.Windows.Controls.Grid]::SetColumn($stack, 1)
  [void]$row.Children.Add($stack)

  if (-not $Check.Ok -and $null -ne $Check.Fix) {
    $button = New-Object System.Windows.Controls.Button
    $button.Content = $Check.FixLabel
    $button.Style = $window.FindResource('SecondaryButton')
    $button.FontSize = 11
    $button.Padding = New-Object System.Windows.Thickness 12, 4, 12, 4
    $button.VerticalAlignment = 'Top'
    $button.Tag = $Check
    $button.Add_Click({
      $this.IsEnabled = $false
      $this.Content = 'Working...'
      Invoke-PreflightFix -Check $this.Tag -Queue $script:OutputQueue -Config $script:Config | Out-Null
      Select-Tab 'log'
    })
    [System.Windows.Controls.Grid]::SetColumn($button, 2)
    [void]$row.Children.Add($button)
  }

  return $row
}

function Refresh-Preflight {
  $PreflightItems.Children.Clear()
  $failing = 0

  foreach ($check in (Get-PreflightChecks -Config $script:Config)) {
    if (-not $check.Ok -and $check.Severity -eq 'fail') { $failing++ }
    [void]$PreflightItems.Children.Add((New-PreflightRow -Check $check))
  }

  if ($failing -gt 0) { $DotPreflight.Visibility = 'Visible' }
  else { $DotPreflight.Visibility = 'Collapsed' }
}

$BtnRecheck.Add_Click({
  # Config may have changed - a fix could have created .env.
  $script:Config = Get-MwConfig -Root $ProjectRoot
  Refresh-Preflight
})

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

  # A restart whose backoff has elapsed. Checked before the exit branch so the
  # window between "it died" and "it is back" is a single tick.
  if ($null -eq $script:ServerHandle -and (Test-MwRestartDue -State $script:Supervisor)) {
    $script:Supervisor.RestartAt = $null
    Write-MwQueueNotice $script:OutputQueue 'restarting now'
    Start-Server
  }

  Update-SupervisorLabel

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

    $decision = Get-MwRestartDecision -State $script:Supervisor -ExitCode $code
    $script:Supervisor.Failures = $decision.Failures
    $script:Supervisor.LastExitAt = Get-Date

    if ($decision.Restart) {
      $script:Supervisor.RestartAt = (Get-Date).AddSeconds($decision.DelaySeconds)
      Write-MwQueueNotice $script:OutputQueue $decision.Reason
      Set-ServerStatus 'starting'
      $StatusText.Text = "Restarting in $($decision.DelaySeconds)s"
    } else {
      $script:Supervisor.RestartAt = $null
      # Only worth saying when a decision was actually made against restarting;
      # an ordinary Stop does not need explaining back to the person who pressed it.
      if (-not $script:Supervisor.UserStopped) {
        Write-MwQueueNotice $script:OutputQueue $decision.Reason
      }
      Set-ServerStatus 'stopped'
      Clear-StatusTiles
    }
  } elseif ($running) {
    # Promote starting -> running. Set-ServerStatus is guarded on $LastStatus,
    # so this is a no-op after the first tick; without it the pill stays amber
    # forever and the green pulse never starts.
    Set-ServerStatus 'running'
    $uptime = (Get-Date) - $script:ServerHandle.StartedAt
    $shown = '{0:mm}m {0:ss}s' -f $uptime
    if ($uptime.TotalHours -ge 1) { $shown = '{0:hh}h {0:mm}m' -f $uptime }
    $StatusText.Text = "Running   pid $($script:ServerHandle.Process.Id)   $shown"
  }
})

# --- boot ------------------------------------------------------------------
$window.Add_Closed({
  if ($null -ne $script:TrayIcon) {
    $script:TrayIcon.Visible = $false
    $script:TrayIcon.Dispose()
    $script:TrayIcon = $null
  }
})

$window.Add_Loaded({
  Write-MwQueueNotice $script:OutputQueue 'launcher ready - press Start server'
  Set-ServerStatus 'stopped'
  Update-ButtonStates | Out-Null
  Refresh-Preflight
  Select-Tab 'log'
  Start-StaggeredEntrance @($StatusStrip, $ControlRail, $PaneLog)
  $timer.Start()
})

# Closing the window must never orphan the server.
<#
  A rendering fault must not cost you the server.

  Animation exceptions surface on the render thread's tick, not at the call
  site, so no try/catch around the code that started them can help. Left
  unhandled they terminate the app - and the Closing handler below then stops
  the server, so a cosmetic bug in a progress bar killed playback.

  Marking them handled keeps the launcher alive and puts the fault in the log
  where it can be seen and fixed.
#>
$window.Dispatcher.add_UnhandledException({
  param($dispatcherSource, $dispatcherEvent)
  $ex = $dispatcherEvent.Exception
  Write-MwQueueNotice $script:OutputQueue ("UI error (recovered): " + $ex.GetType().Name + " - " + $ex.Message)
  $dispatcherEvent.Handled = $true
})

$window.Add_Closing({
  $timer.Stop()
  foreach ($handle in $script:FixHandles) { Stop-MwHandle $handle }
  if ($null -ne $script:PollerHandle) { Stop-ApiPoller $script:PollerHandle }
  if ($null -ne $script:ServerHandle) { Stop-MwHandle $script:ServerHandle }
})

[void]$window.ShowDialog()
