. (Join-Path $LauncherRoot 'lib\Config.ps1')
. (Join-Path $LauncherRoot 'lib\Preflight.ps1')

$fixtureDir = Join-Path $env:TEMP ("mw-pf-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDir | Out-Null

Describe-Group 'Test-MwBinary' {
  Assert-True (Test-MwBinary 'powershell') 'finds powershell on PATH'
  Assert-Equal $false (Test-MwBinary 'definitely-not-a-real-binary-xyz') 'reports a missing binary'
  Assert-Equal $false (Test-MwBinary '') 'reports false for an empty command'
}

Describe-Group 'Get-PortOwner' {
  Assert-Equal 0 (Get-PortOwner 59999) 'returns 0 for a free port'
}

Describe-Group 'Get-PreflightChecks shape' {
  $config = Get-MwConfig -Root $fixtureDir
  $checks = Get-PreflightChecks -Config $config

  Assert-Equal 7 $checks.Count 'returns seven checks'

  $ids = ($checks | ForEach-Object { $_.Id }) -join ','
  Assert-Equal 'node,env,keys,ffmpeg,library,deps,port' $ids 'returns checks in display order'

  foreach ($check in $checks) {
    Assert-True ($check.ContainsKey('Label'))    "$($check.Id) has a Label"
    Assert-True ($check.ContainsKey('Ok'))       "$($check.Id) has an Ok flag"
    Assert-True ($check.ContainsKey('Detail'))   "$($check.Id) has a Detail"
    Assert-True (@('fail','warn') -contains $check.Severity) "$($check.Id) has a valid Severity"
  }
}

Describe-Group 'Get-PreflightChecks against an empty project' {
  $config = Get-MwConfig -Root $fixtureDir
  $checks = Get-PreflightChecks -Config $config
  $byId = @{}
  foreach ($check in $checks) { $byId[$check.Id] = $check }

  Assert-Equal $false $byId['env'].Ok    'env check fails with no .env'
  Assert-Equal 'fail' $byId['env'].Severity 'a missing .env is fatal'
  Assert-Equal $false $byId['keys'].Ok   'keys check fails with no .env'
  Assert-Equal $false $byId['deps'].Ok   'deps check fails with no node_modules'
  Assert-Equal 'fail' $byId['deps'].Severity 'missing dependencies are fatal'
  Assert-Equal $false $byId['library'].Ok 'library check fails with no library folder'
  Assert-Equal 'warn' $byId['library'].Severity 'a missing library folder is only a warning'
  Assert-Equal 'warn' $byId['ffmpeg'].Severity 'missing ffmpeg is only a warning'
  Assert-Equal 'warn' $byId['port'].Severity 'a busy port is only a warning'

  Assert-True ($null -ne $byId['env'].Fix)  'the env check offers a fix'
  Assert-True ($null -ne $byId['deps'].Fix) 'the deps check offers a fix'
  Assert-Null $byId['node'].Fix             'the node check offers no fix'
}

Describe-Group 'Get-PreflightChecks against a configured project' {
  $good = Join-Path $env:TEMP ("mw-pf-good-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $good | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $good 'node_modules') | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $good 'library') | Out-Null
  @('TMDB_API_KEY=abc', 'ALLDEBRID_API_KEY=def') |
    Set-Content -LiteralPath (Join-Path $good '.env') -Encoding utf8

  $config = Get-MwConfig -Root $good
  $byId = @{}
  foreach ($check in (Get-PreflightChecks -Config $config)) { $byId[$check.Id] = $check }

  Assert-True $byId['env'].Ok     'env check passes when .env exists'
  Assert-True $byId['keys'].Ok    'keys check passes when both keys are set'
  Assert-True $byId['deps'].Ok    'deps check passes when node_modules exists'
  Assert-True $byId['library'].Ok 'library check passes when the folder exists'

  Remove-Item -LiteralPath $good -Recurse -Force
}

Describe-Group 'Get-PreflightChecks with one key missing' {
  $partial = Join-Path $env:TEMP ("mw-pf-partial-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $partial | Out-Null
  @('TMDB_API_KEY=abc', 'ALLDEBRID_API_KEY=') |
    Set-Content -LiteralPath (Join-Path $partial '.env') -Encoding utf8

  $config = Get-MwConfig -Root $partial
  $byId = @{}
  foreach ($check in (Get-PreflightChecks -Config $config)) { $byId[$check.Id] = $check }

  Assert-Equal $false $byId['keys'].Ok 'keys check fails when one key is blank'
  Assert-Contains $byId['keys'].Detail 'ALLDEBRID' 'the detail names the missing key'

  Remove-Item -LiteralPath $partial -Recurse -Force
}

Remove-Item -LiteralPath $fixtureDir -Recurse -Force
