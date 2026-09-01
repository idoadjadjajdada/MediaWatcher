. (Join-Path $LauncherRoot 'lib\Config.ps1')
. (Join-Path $LauncherRoot 'lib\ApiClient.ps1')

Describe-Group 'Get-MwAdminKey' {
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
  New-Item -ItemType Directory -Path (Join-Path $dir 'config') -Force | Out-Null
  Set-Content -Path (Join-Path $dir 'config\admin-key') -Value ('b' * 64) -Encoding utf8 -NoNewline

  Assert-Equal ('b' * 64) (Get-MwAdminKey $dir) 'reads the key file'

  $missing = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
  Assert-Equal '' (Get-MwAdminKey $missing) 'returns empty when absent rather than throwing'

  # The server writes the key with no trailing newline, but an editor might.
  $dir2 = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
  New-Item -ItemType Directory -Path (Join-Path $dir2 'config') -Force | Out-Null
  Set-Content -Path (Join-Path $dir2 'config\admin-key') -Value ("c" * 64) -Encoding utf8
  Assert-Equal ('c' * 64) (Get-MwAdminKey $dir2) 'trims a trailing newline'

  Remove-Item -Recurse -Force $dir, $dir2 -ErrorAction SilentlyContinue
}

Describe-Group 'ConvertTo-MwDeviceSummary' {
  $payload = ConvertFrom-Json '{
    "devices": [
      {"id":"abc","name":"Aaron iPad",
       "user_agent":"Mozilla/5.0 (iPad; CPU OS 17_0) AppleWebKit/605.1 Safari/605.1",
       "last_ip":"100.64.1.2","origin":"tailscale",
       "first_seen":1756000000000,"last_seen":1756600000000}
    ]
  }'
  $rows = ConvertTo-MwDeviceSummary $payload

  Assert-Equal 1 $rows.Count 'maps every device'
  Assert-Equal 'abc' $rows[0].Id 'carries the id'
  Assert-Equal 'Aaron iPad' $rows[0].Name 'carries the name'
  Assert-Equal 'tailscale' $rows[0].Origin 'carries the origin'
  Assert-Equal 'Safari' $rows[0].Browser 'identifies Safari'
  Assert-True ($rows[0].LastSeen -is [datetime]) 'converts last_seen to a datetime'
  Assert-True ($rows[0].FirstSeen -is [datetime]) 'converts first_seen to a datetime'

  Assert-Equal 0 (ConvertTo-MwDeviceSummary $null).Count 'returns empty for a null payload'
  Assert-Equal 0 (ConvertTo-MwDeviceSummary (ConvertFrom-Json '{"devices":[]}')).Count `
    'returns empty when nothing is remembered'
}

Describe-Group 'ConvertTo-MwDeviceSummary browser detection' {
  # Chrome and Edge both carry "Safari" in their user agent, and Edge carries
  # "Chrome", so the most specific match has to win or every row says Safari.
  $agents = ConvertFrom-Json '{
    "devices": [
      {"id":"1","name":"a","user_agent":"Mozilla/5.0 Chrome/120.0 Safari/537.36","last_ip":"","origin":"lan","first_seen":1,"last_seen":1},
      {"id":"2","name":"b","user_agent":"Mozilla/5.0 Chrome/120.0 Safari/537.36 Edg/120.0","last_ip":"","origin":"lan","first_seen":1,"last_seen":1},
      {"id":"3","name":"c","user_agent":"Mozilla/5.0 Gecko/20100101 Firefox/121.0","last_ip":"","origin":"lan","first_seen":1,"last_seen":1},
      {"id":"4","name":"d","user_agent":"curl/8.4.0","last_ip":"","origin":"lan","first_seen":1,"last_seen":1}
    ]
  }'
  $rows = ConvertTo-MwDeviceSummary $agents

  Assert-Equal 'Chrome' $rows[0].Browser 'identifies Chrome'
  Assert-Equal 'Edge' $rows[1].Browser 'identifies Edge ahead of Chrome'
  Assert-Equal 'Firefox' $rows[2].Browser 'identifies Firefox'
  Assert-Equal 'Unknown' $rows[3].Browser 'falls back to Unknown'
}
