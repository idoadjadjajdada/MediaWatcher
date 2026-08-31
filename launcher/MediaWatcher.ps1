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

function Refresh-Downloads {
  param($Jobs)

  $DownloadItems.Children.Clear()
  $list = @($Jobs)

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

  # Clear the port before binding it. A server spawned by a previous launcher
  # outlives the window that started it, so the usual failure is "already in
  # use" against an orphan of our own making rather than a real conflict.
  Clear-Port | Out-Null

  Set-ServerStatus 'starting'
  $script:ServerHandle = Start-MwServer -Config $script:Config -LogLevel $level -Queue $script:OutputQueue
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

# --- tabs ------------------------------------------------------------------
function Select-Tab {
  param([string]$Name)   # log | preflight | downloads

  $script:CurrentTab = $Name

  $PaneLog.Visibility = 'Collapsed'
  $PanePreflight.Visibility = 'Collapsed'
  $PaneDownloads.Visibility = 'Collapsed'

  $dim = $script:LogBrushes['debug']
  $bright = $script:LogBrushes['plain']
  $TabLog.Foreground = $dim
  $TabPreflight.Foreground = $dim
  $TabDownloads.Foreground = $dim

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
$window.Add_Closing({
  $timer.Stop()
  foreach ($handle in $script:FixHandles) { Stop-MwHandle $handle }
  if ($null -ne $script:PollerHandle) { Stop-ApiPoller $script:PollerHandle }
  if ($null -ne $script:ServerHandle) { Stop-MwHandle $script:ServerHandle }
})

[void]$window.ShowDialog()
