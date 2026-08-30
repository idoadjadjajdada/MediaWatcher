. (Join-Path $LauncherRoot 'lib\Config.ps1')
. (Join-Path $LauncherRoot 'lib\ServerProcess.ps1')
. (Join-Path $LauncherRoot 'lib\ApiClient.ps1')

Describe-Group 'ConvertTo-MwLibrarySummary' {
  $payload = ConvertFrom-Json '{
    "movies": [{"tmdb_id":1},{"tmdb_id":2}],
    "shows": [{"tmdb_id":3,"seasons":[{"number":1,"episodes":[{"files":[{}]},{"files":[{}]}]}]}],
    "unknown": [{"file_path":"x"}],
    "last_scan_at": 1788060000000,
    "scanning": false
  }'
  $summary = ConvertTo-MwLibrarySummary $payload

  Assert-Equal 2 $summary.Movies 'counts movies'
  Assert-Equal 1 $summary.Shows 'counts shows'
  Assert-Equal 1 $summary.Unknown 'counts unknown files'
  Assert-Equal 2 $summary.Files 'counts episode and movie files'
  Assert-Equal $false $summary.Scanning 'carries the scanning flag'
  Assert-True ($summary.LastScanAt -is [datetime]) 'converts last_scan_at to a datetime'

  $empty = ConvertTo-MwLibrarySummary (ConvertFrom-Json '{"movies":[],"shows":[],"unknown":[],"last_scan_at":null,"scanning":true}')
  Assert-Equal 0 $empty.Movies 'handles an empty library'
  Assert-Equal $true $empty.Scanning 'carries scanning=true'
  Assert-Null $empty.LastScanAt 'handles a null last_scan_at'

  Assert-Null (ConvertTo-MwLibrarySummary $null) 'returns null for a null payload'
}

Describe-Group 'ConvertTo-MwJobSummary' {
  $payload = ConvertFrom-Json '[
    {"id":"a1","title":"Movie One","status":"downloading","progress":0.42,"phase":"transfer"},
    {"id":"b2","title":"Show S01E01","status":"complete","progress":1},
    {"id":"c3","title":"Broken","status":"error","progress":0,"error":"boom"}
  ]'
  $jobs = ConvertTo-MwJobSummary $payload

  Assert-Equal 3 $jobs.Count 'maps every job'
  Assert-Equal 'a1' $jobs[0].Id 'carries the id'
  Assert-Equal 42 $jobs[0].Percent 'converts progress to a whole percent'
  Assert-Equal 'transfer' $jobs[0].Phase 'carries the phase'
  Assert-Equal 100 $jobs[1].Percent 'handles progress of 1'
  Assert-Equal '' $jobs[1].Phase 'defaults a missing phase to empty string'
  Assert-Equal 'boom' $jobs[2].Error 'carries the error text'

  Assert-Equal 0 (ConvertTo-MwJobSummary (ConvertFrom-Json '[]')).Count 'handles an empty job list'
  Assert-Equal 0 (ConvertTo-MwJobSummary $null).Count 'handles a null payload'
}

Describe-Group 'Get-MwActiveJobCount' {
  $jobs = @(
    @{ Status = 'downloading' }, @{ Status = 'queued' },
    @{ Status = 'complete' }, @{ Status = 'error' }
  )
  Assert-Equal 2 (Get-MwActiveJobCount $jobs) 'counts downloading and queued only'
  Assert-Equal 0 (Get-MwActiveJobCount @()) 'handles an empty array'
  Assert-Equal 0 (Get-MwActiveJobCount $null) 'handles null'
}

Describe-Group 'Start-ApiPoller lifecycle' {
  $config = @{ Root = $env:TEMP; Port = 59998 }   # nothing listening here
  $queue = New-MwQueue
  $handle = Start-ApiPoller -Config $config -ResultQueue $queue

  Assert-True ($null -ne $handle.Runspace) 'creates a runspace'
  Assert-True ($null -ne $handle.Control) 'exposes a control table'
  Assert-Equal $false $handle.Control['Stop'] 'starts with Stop false'

  Set-ApiPollerJobsWanted $handle $true
  Assert-Equal $true $handle.Control['JobsWanted'] 'JobsWanted is settable'

  Request-LibraryRefresh $handle
  Assert-Equal $true $handle.Control['RefreshLibrary'] 'library refresh is requestable'

  Request-Rescan $handle
  Assert-Equal $true $handle.Control['Rescan'] 'rescan is requestable'

  # A refused connection on 127.0.0.1 takes ~2s to raise, so the first failing
  # poll is not observable any sooner than that.
  Start-Sleep -Milliseconds 5000

  $messages = @()
  while ($queue.Count -gt 0) { $messages += $queue.Dequeue() }
  $errorMessages = @($messages | Where-Object { $_.Kind -eq 'error' })
  Assert-True ($errorMessages.Count -ge 1) 'a dead server produces an error result, not an exception'

  # Must return promptly even though the worker may be mid-request: this runs
  # on the UI thread in the real launcher.
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  Stop-ApiPoller $handle
  $stopwatch.Stop()
  Assert-Equal $true $handle.Control['Stop'] 'Stop flag is set on shutdown'
  Assert-True ($stopwatch.ElapsedMilliseconds -lt 500) 'Stop-ApiPoller does not block the caller'

  Stop-ApiPoller $handle -Wait
  Assert-True $handle.AsyncResult.IsCompleted 'the worker loop exits once the flag is set'
}
