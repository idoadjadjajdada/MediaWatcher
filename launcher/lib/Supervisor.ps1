# Restarting the server when it dies, and knowing when to stop trying.
#
# The decision is separated from the launcher's timer loop because it is the
# part with the judgement in it, and because a supervisor that gets this wrong
# is worse than none at all: a server that crashes on a bad config file will
# crash again immediately, and a naive restarter turns that into an infinite
# loop that fills the log and hides the actual error.
#
# So three things are true here:
#
#   a stop you asked for is never undone. Pressing Stop and watching it come
#   back would be the single most annoying possible bug.
#
#   restarts back off. First is quick, because the common case is a transient
#   failure; each subsequent one waits longer, because a repeat means the
#   problem is not transient.
#
#   a crash loop gives up. After enough failures inside a short window the
#   supervisor stops and says so, leaving the last error on screen where it
#   can be read.

$script:MwRestartDefaults = @{
  # How many restarts are allowed inside the window before giving up.
  MaxAttempts = 5
  # A run that lasts longer than this is treated as a success, and the failure
  # count resets - otherwise a server restarted once a day would eventually
  # exhaust its attempts and refuse to come back.
  WindowSeconds = 300
  # Backoff, in seconds, indexed by how many failures have already happened.
  # The last value repeats for anything beyond it.
  Delays = @(2, 5, 15, 30, 60)
}

function Get-MwRestartDefaults {
  return $script:MwRestartDefaults.Clone()
}

function Get-MwRestartDelay {
  param(
    [int]$Failures,
    [int[]]$Delays = $script:MwRestartDefaults.Delays
  )

  if ($Delays.Count -eq 0) { return 0 }
  if ($Failures -lt 0) { $Failures = 0 }
  $index = [Math]::Min($Failures, $Delays.Count - 1)
  return [int]$Delays[$index]
}

<#
.SYNOPSIS
  Should the server be restarted, and after how long?

.DESCRIPTION
  Pure: it reads state and returns a decision, so the rules can be tested
  without starting or killing anything.

  $State is a hashtable the caller keeps between calls:
    Enabled       whether auto-restart is on at all
    UserStopped   set when the person pressed Stop
    Failures      how many restarts have happened in the current window
    LastExitAt    when the previous unexpected exit happened (DateTime)
    StartedAt     when the run that just ended began (DateTime)
#>
function Get-MwRestartDecision {
  param(
    [hashtable]$State,
    [int]$ExitCode,
    [datetime]$Now = (Get-Date),
    [hashtable]$Settings = $script:MwRestartDefaults
  )

  if ($null -eq $State) {
    return @{ Restart = $false; Reason = 'no supervisor state'; DelaySeconds = 0; Failures = 0 }
  }

  if (-not $State.Enabled) {
    return @{ Restart = $false; Reason = 'auto-restart is off'; DelaySeconds = 0; Failures = [int]$State.Failures }
  }

  # The one case that must never be second-guessed.
  if ($State.UserStopped) {
    return @{ Restart = $false; Reason = 'stopped on request'; DelaySeconds = 0; Failures = 0 }
  }

  # A run that lasted a while was working; whatever killed it is a new problem
  # rather than a continuation of an old one, so the count starts again.
  $failures = [int]$State.Failures
  if ($null -ne $State.StartedAt) {
    $ranFor = ($Now - [datetime]$State.StartedAt).TotalSeconds
    if ($ranFor -ge [int]$Settings.WindowSeconds) { $failures = 0 }
  }

  if ($failures -ge [int]$Settings.MaxAttempts) {
    return @{
      Restart = $false
      Reason = "gave up after $failures restarts - the server is not staying up, see the log above"
      DelaySeconds = 0
      Failures = $failures
    }
  }

  $delay = Get-MwRestartDelay -Failures $failures -Delays $Settings.Delays
  $ordinal = $failures + 1
  return @{
    Restart = $true
    Reason = "server exited with code $ExitCode - restarting (attempt $ordinal of $($Settings.MaxAttempts)) in ${delay}s"
    DelaySeconds = $delay
    Failures = $ordinal
  }
}

<#
.SYNOPSIS
  A fresh supervisor state.
#>
function New-MwSupervisorState {
  param([bool]$Enabled = $true)

  return @{
    Enabled = $Enabled
    UserStopped = $false
    Failures = 0
    LastExitAt = $null
    StartedAt = $null
    # Set while waiting out a backoff, so the UI can say what is happening and
    # the timer loop knows not to start a second one.
    RestartAt = $null
  }
}

<#
.SYNOPSIS
  Is the backoff over?
#>
function Test-MwRestartDue {
  param([hashtable]$State, [datetime]$Now = (Get-Date))

  if ($null -eq $State -or $null -eq $State.RestartAt) { return $false }
  return $Now -ge [datetime]$State.RestartAt
}
