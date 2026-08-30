<#
  Child-process management.

  stdout and stderr arrive on threadpool threads, so nothing here touches the
  UI. Lines are pushed into a synchronized queue that the dispatcher tick
  drains. Both the server and one-click fix commands (npm, winget) use the same
  path, so all output lands in the same log pane.
#>

function New-MwQueue {
  # The leading comma is load-bearing: PowerShell unrolls enumerable return
  # values, so returning a Queue directly hands the caller its *contents* —
  # which for a new queue is nothing at all, i.e. $null. Wrapping in a
  # single-element array suppresses the unrolling.
  return ,[System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))
}

function Write-MwQueueNotice {
  param($Queue, [string]$Text)

  if ($null -eq $Queue) { return }
  $Queue.Enqueue(@{
    Kind = 'notice'; Text = $Text; Tag = 'launcher'; Timestamp = (Get-Date)
  })
}

function Get-MwLogLevel {
  param([string]$Line)

  if ([string]::IsNullOrWhiteSpace($Line)) { return 'plain' }
  if ($Line -match '\bERROR\b') { return 'error' }
  if ($Line -match '\bWARN\b')  { return 'warn' }
  if ($Line -match '\bINFO\b')  { return 'info' }
  if ($Line -match '\bDEBUG\b') { return 'debug' }
  return 'plain'
}

function Start-StreamedCommand {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string]$Arguments = '',
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)]$Queue,
    [string]$Tag = 'cmd',
    [hashtable]$Environment = $null
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  if ($Environment) {
    foreach ($key in $Environment.Keys) {
      $psi.EnvironmentVariables[$key] = [string]$Environment[$key]
    }
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $process.EnableRaisingEvents = $true

  # MessageData carries both the queue and the tag into the event runspace,
  # which cannot see this function's local scope.
  $context = @{ Queue = $Queue; Tag = $Tag }

  $subscriptions = @()
  $subscriptions += Register-ObjectEvent -InputObject $process -EventName OutputDataReceived `
    -MessageData $context -Action {
      if ($null -ne $EventArgs.Data) {
        $Event.MessageData.Queue.Enqueue(@{
          Kind = 'stdout'; Text = $EventArgs.Data
          Tag = $Event.MessageData.Tag; Timestamp = (Get-Date)
        })
      }
    }
  $subscriptions += Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived `
    -MessageData $context -Action {
      if ($null -ne $EventArgs.Data) {
        $Event.MessageData.Queue.Enqueue(@{
          Kind = 'stderr'; Text = $EventArgs.Data
          Tag = $Event.MessageData.Tag; Timestamp = (Get-Date)
        })
      }
    }

  [void]$process.Start()
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()

  return @{ Process = $process; Subscriptions = $subscriptions; Tag = $Tag; StartedAt = (Get-Date) }
}

function Start-MwServer {
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [string]$LogLevel = 'info',
    [Parameter(Mandatory)]$Queue
  )

  Write-MwQueueNotice $Queue "starting MediaWatcher (node server.js, LOG_LEVEL=$LogLevel)"
  return Start-StreamedCommand -FilePath 'node' -Arguments 'server.js' `
    -WorkingDirectory $Config.Root -Queue $Queue -Tag 'server' `
    -Environment @{ LOG_LEVEL = $LogLevel }
}

function Stop-MwHandle {
  param([hashtable]$Handle)

  if ($null -eq $Handle) { return }

  if ($null -ne $Handle.Process) {
    try {
      if (-not $Handle.Process.HasExited) {
        # Node on Windows cannot receive SIGTERM, so the tree is terminated.
        # Safe: SQLite runs in WAL mode and recovers on next open.
        & taskkill /PID $Handle.Process.Id /T /F 2>&1 | Out-Null
      }
    } catch {
      # Process already gone between the check and the kill.
    }
  }

  if ($null -ne $Handle.Subscriptions) {
    foreach ($subscription in $Handle.Subscriptions) {
      Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
    }
  }
  $Handle.Subscriptions = @()
}
