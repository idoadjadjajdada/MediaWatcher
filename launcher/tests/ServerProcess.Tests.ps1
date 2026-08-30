. (Join-Path $LauncherRoot 'lib\Config.ps1')
. (Join-Path $LauncherRoot 'lib\ServerProcess.ps1')

Describe-Group 'New-MwQueue and Write-MwQueueNotice' {
  $queue = New-MwQueue
  Assert-Equal 0 $queue.Count 'starts empty'

  Write-MwQueueNotice $queue 'hello'
  Assert-Equal 1 $queue.Count 'enqueues a notice'

  $message = $queue.Dequeue()
  Assert-Equal 'notice' $message.Kind 'notice messages have Kind=notice'
  Assert-Equal 'hello'  $message.Text 'carries the text'
  Assert-True ($message.Timestamp -is [datetime]) 'carries a timestamp'
}

Describe-Group 'Get-MwLogLevel' {
  Assert-Equal 'error' (Get-MwLogLevel '19:42:01.114 ERROR [app] boom') 'detects ERROR'
  Assert-Equal 'warn'  (Get-MwLogLevel '19:42:01.114 WARN  [tmdb] retrying') 'detects WARN'
  Assert-Equal 'info'  (Get-MwLogLevel '19:42:01.114 INFO  [app] listening') 'detects INFO'
  Assert-Equal 'debug' (Get-MwLogLevel '19:42:01.114 DEBUG 91 files') 'detects DEBUG'
  Assert-Equal 'plain' (Get-MwLogLevel 'just some text') 'falls back to plain'
  Assert-Equal 'plain' (Get-MwLogLevel '') 'handles an empty line'
  Assert-Equal 'plain' (Get-MwLogLevel 'ERRORS are common') 'requires a word boundary'
}

Describe-Group 'Start-StreamedCommand' {
  $queue = New-MwQueue
  $handle = Start-StreamedCommand -FilePath 'cmd.exe' -Arguments '/c echo streamed-line-marker' `
    -WorkingDirectory $env:TEMP -Queue $queue -Tag 'test'

  Assert-True ($null -ne $handle.Process) 'returns a process handle'
  $handle.Process.WaitForExit(10000) | Out-Null
  Start-Sleep -Milliseconds 400

  $collected = @()
  while ($queue.Count -gt 0) { $collected += $queue.Dequeue() }

  $texts = ($collected | ForEach-Object { $_.Text }) -join "`n"
  Assert-Contains $texts 'streamed-line-marker' 'stdout reaches the queue'

  $stdoutMessages = @($collected | Where-Object { $_.Kind -eq 'stdout' })
  Assert-True ($stdoutMessages.Count -ge 1) 'stdout messages have Kind=stdout'
  Assert-Equal 'test' $stdoutMessages[0].Tag 'messages carry the tag'

  Stop-MwHandle $handle
}

Describe-Group 'Start-StreamedCommand captures stderr separately' {
  $queue = New-MwQueue
  $handle = Start-StreamedCommand -FilePath 'cmd.exe' `
    -Arguments '/c echo err-marker 1>&2' `
    -WorkingDirectory $env:TEMP -Queue $queue -Tag 'test'

  $handle.Process.WaitForExit(10000) | Out-Null
  Start-Sleep -Milliseconds 400

  $collected = @()
  while ($queue.Count -gt 0) { $collected += $queue.Dequeue() }

  $stderrMessages = @($collected | Where-Object { $_.Kind -eq 'stderr' })
  Assert-True ($stderrMessages.Count -ge 1) 'stderr messages have Kind=stderr'
  Assert-Contains (($stderrMessages | ForEach-Object { $_.Text }) -join "`n") 'err-marker' 'stderr text reaches the queue'

  Stop-MwHandle $handle
}

Describe-Group 'Stop-MwHandle is safe to call twice' {
  $queue = New-MwQueue
  $handle = Start-StreamedCommand -FilePath 'cmd.exe' -Arguments '/c exit 0' `
    -WorkingDirectory $env:TEMP -Queue $queue -Tag 'test'
  $handle.Process.WaitForExit(10000) | Out-Null

  Stop-MwHandle $handle
  Stop-MwHandle $handle
  Assert-True $true 'a second Stop-MwHandle does not throw'
}
