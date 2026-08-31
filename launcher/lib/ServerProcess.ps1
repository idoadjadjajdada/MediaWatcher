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

<#
.SYNOPSIS
  Processes listening on a port, classified by whether they are ours to kill.

.DESCRIPTION
  A node server spawned by the launcher outlives it when the launcher window is
  closed - the parent dies, the child keeps the port, and the next launch finds
  3000 taken by an orphan nobody owns.

  Only a node process running a server.js is reported as `Ours`. Anything else
  holding the port is reported as foreign and left alone: silently killing an
  unrelated app that happens to use 3000 would be a far worse failure than
  refusing to start.

  There is deliberately no working-directory check. Windows does not expose
  another process's CWD through Win32_Process - `Path` is node.exe's own
  location - so a root comparison looks reassuring while always being false,
  which is worse than not checking at all. The port itself is the scope: the
  launcher owns it by configuration, and only a node server.js is touched.

  Emits objects to the pipeline rather than returning an array. `,$owners`
  would wrap an empty result into a one-element array, so a free port would
  report one owner; callers wrap with @() instead, which is 0 when empty.
#>
function Get-MwPortOwner {
  param(
    [Parameter(Mandatory)][int]$Port,
    [int]$ExcludePid = 0
  )

  $pids = @()
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    # Get-NetTCPConnection is missing on some builds; netstat is always there.
    $pattern = ':' + $Port + '\s'
    $pids = @(netstat -ano 2>$null |
      Where-Object { $_ -match $pattern -and $_ -match 'LISTENING' } |
      ForEach-Object { ($_ -split '\s+')[-1] } |
      Sort-Object -Unique)
  }

  foreach ($rawPid in $pids) {
    $procId = 0
    if (-not [int]::TryParse([string]$rawPid, [ref]$procId)) { continue }
    if ($procId -le 4 -or $procId -eq $ExcludePid) { continue }

    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }

    $commandLine = [string]$proc.CommandLine
    $isNode = $proc.Name -eq 'node.exe'
    $isServer = $commandLine -match 'server\.js'

    [pscustomobject]@{
      ProcessId   = $procId
      Name        = $proc.Name
      CommandLine = $commandLine
      Ours        = [bool]($isNode -and $isServer)
    }
  }
}

<#
.SYNOPSIS
  Terminate orphaned MediaWatcher servers holding a port.

.OUTPUTS
  A hashtable: Killed (pids terminated), Foreign (pids left alone).
#>
function Stop-MwPortOwner {
  param(
    [Parameter(Mandatory)][int]$Port,
    [int]$ExcludePid = 0,
    $Queue = $null
  )

  # @() is load-bearing: an empty pipeline becomes an empty array here, where a
  # bare assignment would give $null and @($null).Count is 1.
  $owners = @(Get-MwPortOwner -Port $Port -ExcludePid $ExcludePid)
  $killed = @()
  $foreign = @()

  foreach ($owner in $owners) {
    if (-not $owner.Ours) {
      $foreign += $owner.ProcessId
      if ($Queue) {
        # ASCII only inside strings here: this file is read as ANSI by Windows
        # PowerShell 5.1, so a UTF-8 dash arrives as three bytes of garbage and
        # breaks the parse. Comments survive it; quoted strings do not.
        Write-MwQueueNotice $Queue "port $Port is held by $($owner.Name) (pid $($owner.ProcessId)) - not ours, leaving it alone"
      }
      continue
    }

    try {
      & taskkill /PID $owner.ProcessId /T /F 2>&1 | Out-Null
      $killed += $owner.ProcessId
      if ($Queue) { Write-MwQueueNotice $Queue "stopped orphaned server on port $Port (pid $($owner.ProcessId))" }
    } catch {
      if ($Queue) { Write-MwQueueNotice $Queue "could not stop pid $($owner.ProcessId): $($_.Exception.Message)" }
    }
  }

  return @{ Killed = $killed; Foreign = $foreign }
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
