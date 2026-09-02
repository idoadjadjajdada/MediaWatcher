. (Join-Path $LauncherRoot 'lib\Supervisor.ps1')

# A supervisor that gets this wrong is worse than none at all. Two failures
# matter most: undoing a stop the person asked for, and restarting forever on a
# server that cannot start - which fills the log and buries the actual error.

Describe-Group 'Get-MwRestartDecision - a stop you asked for' {
  $state = New-MwSupervisorState
  $state.UserStopped = $true

  $decision = Get-MwRestartDecision -State $state -ExitCode 1
  Assert-Equal $false $decision.Restart 'never restarts a stop that was requested'
  Assert-Equal 'stopped on request' $decision.Reason 'and says so'

  # Even a crash-looking exit code must not override it.
  $state.Failures = 3
  Assert-Equal $false (Get-MwRestartDecision -State $state -ExitCode 137).Restart `
    'a requested stop wins over any exit code'
}

Describe-Group 'Get-MwRestartDecision - switched off' {
  $state = New-MwSupervisorState -Enabled $false
  $decision = Get-MwRestartDecision -State $state -ExitCode 1
  Assert-Equal $false $decision.Restart 'does nothing when disabled'
  Assert-Equal 'auto-restart is off' $decision.Reason 'and explains why'
}

Describe-Group 'Get-MwRestartDecision - an ordinary crash' {
  $state = New-MwSupervisorState
  $state.StartedAt = (Get-Date).AddSeconds(-10)

  $decision = Get-MwRestartDecision -State $state -ExitCode 1
  Assert-Equal $true $decision.Restart 'restarts an unexpected exit'
  Assert-Equal 1 $decision.Failures 'counts the attempt'
  Assert-Equal 2 $decision.DelaySeconds 'the first retry is quick'
  Assert-Contains $decision.Reason 'attempt 1 of 5' 'the reason names the attempt'
}

Describe-Group 'Get-MwRestartDecision - backing off' {
  # A repeat means the problem is not transient, so each wait is longer.
  Assert-Equal 2  (Get-MwRestartDelay -Failures 0) 'first'
  Assert-Equal 5  (Get-MwRestartDelay -Failures 1) 'second'
  Assert-Equal 15 (Get-MwRestartDelay -Failures 2) 'third'
  Assert-Equal 30 (Get-MwRestartDelay -Failures 3) 'fourth'
  Assert-Equal 60 (Get-MwRestartDelay -Failures 4) 'fifth'
  Assert-Equal 60 (Get-MwRestartDelay -Failures 99) 'the last delay repeats rather than growing forever'
  Assert-Equal 2  (Get-MwRestartDelay -Failures -1) 'a negative count is treated as the first'
}

Describe-Group 'Get-MwRestartDecision - a crash loop gives up' {
  $state = New-MwSupervisorState
  $state.Failures = 5
  $state.StartedAt = (Get-Date).AddSeconds(-3)

  $decision = Get-MwRestartDecision -State $state -ExitCode 1
  Assert-Equal $false $decision.Restart 'stops trying after the cap'
  Assert-Contains $decision.Reason 'gave up' 'and says it gave up'
  # The point of stopping is that the last error stays readable.
  Assert-Contains $decision.Reason 'see the log' 'and points at the log'

  $state.Failures = 4
  Assert-Equal $true (Get-MwRestartDecision -State $state -ExitCode 1).Restart `
    'one under the cap still restarts'
}

Describe-Group 'Get-MwRestartDecision - a long run resets the count' {
  # Otherwise a server restarted once a day would eventually exhaust its
  # attempts and refuse to come back at all.
  $state = New-MwSupervisorState
  $state.Failures = 4
  $state.StartedAt = (Get-Date).AddHours(-6)

  $decision = Get-MwRestartDecision -State $state -ExitCode 1
  Assert-Equal $true $decision.Restart 'a run that lasted restarts even at the cap'
  Assert-Equal 1 $decision.Failures 'and the count starts again'
  Assert-Equal 2 $decision.DelaySeconds 'so the backoff starts again too'

  # Just under the window is still a crash loop.
  $state.Failures = 5
  $state.StartedAt = (Get-Date).AddSeconds(-10)
  Assert-Equal $false (Get-MwRestartDecision -State $state -ExitCode 1).Restart `
    'a short run does not reset it'
}

Describe-Group 'Get-MwRestartDecision - robustness' {
  $decision = Get-MwRestartDecision -State $null -ExitCode 1
  Assert-Equal $false $decision.Restart 'no state is not a crash'

  $fresh = New-MwSupervisorState
  Assert-Equal $true (Get-MwRestartDecision -State $fresh -ExitCode 0).Restart `
    'a clean-looking exit is still unexpected if nobody asked for it'
}

Describe-Group 'New-MwSupervisorState' {
  $state = New-MwSupervisorState
  Assert-Equal $true $state.Enabled 'on by default'
  Assert-Equal $false $state.UserStopped 'nothing requested yet'
  Assert-Equal 0 $state.Failures 'no failures yet'
  Assert-Equal $null $state.RestartAt 'nothing scheduled'
  Assert-Equal $false (New-MwSupervisorState -Enabled $false).Enabled 'can start switched off'
}

Describe-Group 'Test-MwRestartDue' {
  $state = New-MwSupervisorState
  Assert-Equal $false (Test-MwRestartDue -State $state) 'nothing scheduled is never due'

  $state.RestartAt = (Get-Date).AddSeconds(-1)
  Assert-Equal $true (Test-MwRestartDue -State $state) 'a past time is due'

  $state.RestartAt = (Get-Date).AddMinutes(5)
  Assert-Equal $false (Test-MwRestartDue -State $state) 'a future time is not'

  Assert-Equal $false (Test-MwRestartDue -State $null) 'no state is never due'
}
