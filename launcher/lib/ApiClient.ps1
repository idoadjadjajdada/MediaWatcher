<#
  Polls the MediaWatcher server's own API from a background runspace.

  No HTTP call is ever made on the UI thread. The previous WinForms launcher
  called Invoke-WebRequest -TimeoutSec 10 inside a click handler, which freezes
  the window for ten seconds against a hung server; this module exists to make
  that impossible.

  Cadence:
    /api/health          every 2s   (cheap liveness, drives the status pill)
    /api/media/library   every 15s  (whole-library payload; a cold first call
                                     blocks on a full scan, so it is polled
                                     slowly and on demand)
    /api/torrents/jobs   every 2s   but only when JobsWanted is set
#>

function ConvertTo-MwLibrarySummary {
  param($Payload)

  if ($null -eq $Payload) { return $null }

  $movies = @($Payload.movies)
  $shows = @($Payload.shows)
  $unknown = @($Payload.unknown)

  # @($null).Count is 1, not 0, so an item with no files array would otherwise
  # be counted as holding one file.
  $countOf = {
    param($Value)
    if ($null -eq $Value) { return 0 }
    return @($Value).Count
  }

  $files = 0
  foreach ($movie in $movies) { $files += (& $countOf $movie.files) }
  foreach ($show in $shows) {
    foreach ($season in @($show.seasons)) {
      foreach ($episode in @($season.episodes)) { $files += (& $countOf $episode.files) }
    }
  }

  $lastScan = $null
  if ($Payload.last_scan_at) {
    $lastScan = [System.DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Payload.last_scan_at).LocalDateTime
  }

  return @{
    Movies     = $movies.Count
    Shows      = $shows.Count
    Unknown    = $unknown.Count
    Files      = $files
    LastScanAt = $lastScan
    Scanning   = [bool]$Payload.scanning
  }
}

function ConvertTo-MwJobSummary {
  param($Payload)

  if ($null -eq $Payload) { return @() }

  $jobs = @()
  foreach ($row in @($Payload)) {
    $progress = 0.0
    if ($null -ne $row.progress) { $progress = [double]$row.progress }

    $phase = ''
    if ($row.PSObject.Properties.Name -contains 'phase' -and $row.phase) { $phase = [string]$row.phase }

    $errorText = ''
    if ($row.PSObject.Properties.Name -contains 'error' -and $row.error) { $errorText = [string]$row.error }

    $jobs += @{
      Id       = [string]$row.id
      Title    = [string]$row.title
      Status   = [string]$row.status
      Progress = $progress
      Percent  = [int][math]::Round($progress * 100)
      Phase    = $phase
      Error    = $errorText
    }
  }
  return ,$jobs
}

function Get-MwActiveJobCount {
  param($Jobs)

  if ($null -eq $Jobs) { return 0 }
  return @($Jobs | Where-Object { $_.Status -eq 'downloading' -or $_.Status -eq 'queued' }).Count
}

function Start-ApiPoller {
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [Parameter(Mandatory)]$ResultQueue
  )

  $control = [hashtable]::Synchronized(@{
    Stop           = $false
    RefreshLibrary = $false
    Rescan         = $false
    JobsWanted     = $false
  })

  $runspace = [runspacefactory]::CreateRunspace()
  $runspace.ApartmentState = 'MTA'
  $runspace.ThreadOptions = 'ReuseThread'
  $runspace.Open()
  $runspace.SessionStateProxy.SetVariable('Control', $control)
  $runspace.SessionStateProxy.SetVariable('ResultQueue', $ResultQueue)
  $runspace.SessionStateProxy.SetVariable('BaseUrl', "http://127.0.0.1:$($Config.Port)")

  $worker = {
    # A fresh runspace defaults to 'Continue'. Without this, a failing
    # Invoke-RestMethod writes to the error stream and returns nothing rather
    # than throwing, so every catch block below would be dead code and a
    # unreachable server would look like silence.
    $ErrorActionPreference = 'Stop'

    function Push-Result($Kind, $Data) {
      $ResultQueue.Enqueue(@{ Kind = $Kind; Data = $Data; Timestamp = (Get-Date) })
    }

    function Invoke-Api($Path, $TimeoutSec, $Method) {
      $uri = $BaseUrl + $Path
      return Invoke-RestMethod -Uri $uri -Method $Method -TimeoutSec $TimeoutSec `
        -UseBasicParsing -ErrorAction Stop
    }

    $lastHealth = [datetime]::MinValue
    $lastLibrary = [datetime]::MinValue
    $lastJobs = [datetime]::MinValue
    $lastErrorAt = [datetime]::MinValue
    $awaitingScan = $false

    while (-not $Control['Stop']) {
      $now = Get-Date

      # --- rescan request (POST, then follow the scan to completion) ---------
      if ($Control['Rescan']) {
        $Control['Rescan'] = $false
        try {
          Invoke-Api '/api/media/rescan' 10 'POST' | Out-Null
          Push-Result 'notice' 'rescan requested'
          $awaitingScan = $true
          $lastLibrary = [datetime]::MinValue
        } catch {
          Push-Result 'error' "rescan failed: $($_.Exception.Message)"
        }
      }

      if ($Control['RefreshLibrary']) {
        $Control['RefreshLibrary'] = $false
        $lastLibrary = [datetime]::MinValue
      }

      # --- health (2s) -------------------------------------------------------
      if (($now - $lastHealth).TotalMilliseconds -ge 2000) {
        $lastHealth = $now
        try {
          $health = Invoke-Api '/api/health' 3 'GET'
          Push-Result 'health' $health
        } catch {
          # Rate-limit error noise to one message every 10 seconds.
          if (($now - $lastErrorAt).TotalSeconds -ge 10) {
            $lastErrorAt = $now
            Push-Result 'error' $_.Exception.Message
          }
        }
      }

      # --- library (15s, or 2s while a scan is running) ----------------------
      $libraryInterval = 15000
      if ($awaitingScan) { $libraryInterval = 2000 }
      if (($now - $lastLibrary).TotalMilliseconds -ge $libraryInterval) {
        $lastLibrary = $now
        try {
          $library = Invoke-Api '/api/media/library' 10 'GET'
          Push-Result 'library' $library
          if ($awaitingScan -and -not $library.scanning) { $awaitingScan = $false }
        } catch {
          # Library failures are silent; health already reports the server state.
        }
      }

      # --- jobs (2s, only when wanted) ---------------------------------------
      if ($Control['JobsWanted'] -and ($now - $lastJobs).TotalMilliseconds -ge 2000) {
        $lastJobs = $now
        try {
          $jobs = Invoke-Api '/api/torrents/jobs' 5 'GET'
          Push-Result 'jobs' $jobs
        } catch {
          # Silent for the same reason as library.
        }
      }

      Start-Sleep -Milliseconds 250
    }
  }

  $powershell = [powershell]::Create()
  $powershell.Runspace = $runspace
  [void]$powershell.AddScript($worker)
  $asyncResult = $powershell.BeginInvoke()

  return @{
    Runspace = $runspace; PowerShell = $powershell
    AsyncResult = $asyncResult; Control = $control
  }
}

function Stop-ApiPoller {
  <#
    Non-blocking by default, because this is called from the UI thread.

    PowerShell.Stop() blocks until the pipeline unwinds, and the worker can be
    parked inside Invoke-RestMethod for seconds at a time — a refused
    connection on 127.0.0.1 takes roughly two seconds to raise. Calling Stop()
    there freezes the window on every server stop and on close.

    Setting the flag is enough: the loop re-checks it every 250ms, so the
    runspace terminates on its own once the in-flight request returns. We
    dispose immediately when it has already finished, and otherwise leave it to
    unwind. Pass -Wait (tests, teardown) for deterministic cleanup.
  #>
  param([hashtable]$Handle, [switch]$Wait, [int]$WaitMs = 6000)

  if ($null -eq $Handle) { return }
  $Handle.Control['Stop'] = $true

  try {
    if ($Wait -and $null -ne $Handle.AsyncResult) {
      [void]$Handle.AsyncResult.AsyncWaitHandle.WaitOne($WaitMs)
    }

    $finished = ($null -eq $Handle.AsyncResult) -or $Handle.AsyncResult.IsCompleted
    if ($finished) {
      if ($null -ne $Handle.PowerShell) { $Handle.PowerShell.Dispose() }
      if ($null -ne $Handle.Runspace) { $Handle.Runspace.Dispose() }
    }
  } catch {
    # Shutdown races are not worth reporting.
  }
}

function Request-LibraryRefresh {
  param([hashtable]$Handle)
  if ($null -ne $Handle) { $Handle.Control['RefreshLibrary'] = $true }
}

function Request-Rescan {
  param([hashtable]$Handle)
  if ($null -ne $Handle) { $Handle.Control['Rescan'] = $true }
}

function Set-ApiPollerJobsWanted {
  param([hashtable]$Handle, [bool]$Wanted)
  if ($null -ne $Handle) { $Handle.Control['JobsWanted'] = $Wanted }
}
