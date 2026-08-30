<#
  Pre-flight checks.

  Every check reports a severity and, where a machine can plausibly fix the
  problem itself, a Fix scriptblock. Fixes that run long commands delegate to
  Start-StreamedCommand so their output lands in the same log pane as the
  server's, and return immediately rather than blocking the UI.

  Write-MwQueueNotice and Start-StreamedCommand live in ServerProcess.ps1; the
  Fix scriptblocks only run at UI time, by which point both files are loaded.
#>

function Test-MwBinary {
  param([string]$Command)

  if ([string]::IsNullOrWhiteSpace($Command)) { return $false }
  try {
    $found = Get-Command $Command -ErrorAction Stop
    return ($null -ne $found)
  } catch {
    return $false
  }
}

function Get-PortOwner {
  param([int]$Port)

  try {
    $connections = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop
    foreach ($connection in $connections) { return [int]$connection.OwningProcess }
    return 0
  } catch {
    # Get-NetTCPConnection throws when nothing is listening, and does not exist
    # on very old builds. netstat is the portable fallback.
    $pattern = ':' + $Port + '\s'
    $line = (& netstat -ano -p TCP | Select-String -Pattern $pattern | Select-String -Pattern 'LISTENING' | Select-Object -First 1)
    if ($null -eq $line) { return 0 }
    $fields = ($line.ToString().Trim() -split '\s+')
    $owner = 0
    if ([int]::TryParse($fields[-1], [ref]$owner)) { return $owner }
    return 0
  }
}

function Get-PreflightChecks {
  param([Parameter(Mandatory)][hashtable]$Config)

  $checks = @()
  $values = $Config.EnvValues

  # --- node ------------------------------------------------------------------
  $nodeOk = Test-MwBinary 'node'
  $nodeDetail = 'not found - install Node 20+ from nodejs.org'
  if ($nodeOk) {
    try { $nodeDetail = (& node --version) } catch { $nodeDetail = 'found' }
  }
  $checks += @{
    Id = 'node'; Label = 'Node.js'; Ok = $nodeOk; Severity = 'fail'
    Detail = $nodeDetail; FixLabel = $null; Fix = $null
  }

  # --- .env ------------------------------------------------------------------
  $envOk = Test-Path -LiteralPath $Config.EnvPath
  $envDetail = 'found'
  if (-not $envOk) { $envDetail = 'missing - copy .env.example' }
  $checks += @{
    Id = 'env'; Label = '.env file'; Ok = $envOk; Severity = 'fail'
    Detail = $envDetail; FixLabel = 'Create'
    Fix = {
      param($Config, $Queue)
      $example = Join-Path $Config.Root '.env.example'
      if (-not (Test-Path -LiteralPath $example)) {
        Write-MwQueueNotice $Queue '.env.example is missing, cannot create .env'
        return
      }
      Copy-Item -LiteralPath $example -Destination $Config.EnvPath -Force
      Write-MwQueueNotice $Queue "created $($Config.EnvPath) - add your API keys"
    }
  }

  # --- API keys --------------------------------------------------------------
  $tmdb = Get-EnvValue $values 'TMDB_API_KEY' ''
  $debrid = Get-EnvValue $values 'ALLDEBRID_API_KEY' ''
  $hasTmdb = -not [string]::IsNullOrWhiteSpace($tmdb)
  $hasDebrid = -not [string]::IsNullOrWhiteSpace($debrid)

  $keyDetail = 'both set'
  if (-not $hasTmdb -and -not $hasDebrid) { $keyDetail = 'TMDB_API_KEY and ALLDEBRID_API_KEY missing' }
  elseif (-not $hasTmdb) { $keyDetail = 'TMDB_API_KEY missing' }
  elseif (-not $hasDebrid) { $keyDetail = 'ALLDEBRID_API_KEY missing' }

  $checks += @{
    Id = 'keys'; Label = 'API keys'; Ok = ($hasTmdb -and $hasDebrid); Severity = 'fail'
    Detail = $keyDetail; FixLabel = 'Edit .env'
    Fix = {
      param($Config, $Queue)
      if (Test-Path -LiteralPath $Config.EnvPath) {
        Start-Process -FilePath $Config.EnvPath
        Write-MwQueueNotice $Queue 'opened .env - save it, then press Recheck'
      } else {
        Write-MwQueueNotice $Queue 'no .env to edit - run the .env fix first'
      }
    }
  }

  # --- ffmpeg ----------------------------------------------------------------
  $ffmpegOk = Test-MwBinary $Config.FfmpegPath
  $ffmpegDetail = 'found'
  if (-not $ffmpegOk) { $ffmpegDetail = 'missing - most MKVs will not play' }
  $checks += @{
    Id = 'ffmpeg'; Label = 'ffmpeg'; Ok = $ffmpegOk; Severity = 'warn'
    Detail = $ffmpegDetail; FixLabel = 'Install'
    Fix = {
      param($Config, $Queue)
      if (-not (Test-MwBinary 'winget')) {
        Write-MwQueueNotice $Queue 'winget is not available - install ffmpeg manually from ffmpeg.org'
        return
      }
      Write-MwQueueNotice $Queue 'installing ffmpeg via winget, this can take a minute'
      Start-StreamedCommand -FilePath 'winget' `
        -Arguments 'install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements' `
        -WorkingDirectory $Config.Root -Queue $Queue -Tag 'winget'
    }
  }

  # --- library folder --------------------------------------------------------
  $libraryOk = Test-Path -LiteralPath $Config.LibraryPath
  $libraryDetail = $Config.LibraryPath
  if (-not $libraryOk) { $libraryDetail = "missing - $($Config.LibraryPath)" }
  $checks += @{
    Id = 'library'; Label = 'Library folder'; Ok = $libraryOk; Severity = 'warn'
    Detail = $libraryDetail; FixLabel = 'Create'
    Fix = {
      param($Config, $Queue)
      New-Item -ItemType Directory -Path $Config.LibraryPath -Force | Out-Null
      New-Item -ItemType Directory -Path (Join-Path $Config.LibraryPath 'movies') -Force | Out-Null
      New-Item -ItemType Directory -Path (Join-Path $Config.LibraryPath 'shows') -Force | Out-Null
      Write-MwQueueNotice $Queue "created $($Config.LibraryPath) with movies/ and shows/"
    }
  }

  # --- dependencies ----------------------------------------------------------
  $depsPath = Join-Path $Config.Root 'node_modules'
  $depsOk = Test-Path -LiteralPath $depsPath
  $depsDetail = 'installed'
  if (-not $depsOk) { $depsDetail = 'not installed - run npm install' }
  $checks += @{
    Id = 'deps'; Label = 'Dependencies'; Ok = $depsOk; Severity = 'fail'
    Detail = $depsDetail; FixLabel = 'npm install'
    Fix = {
      param($Config, $Queue)
      Write-MwQueueNotice $Queue 'running npm install, this can take a few minutes'
      Start-StreamedCommand -FilePath 'npm.cmd' -Arguments 'install' `
        -WorkingDirectory $Config.Root -Queue $Queue -Tag 'npm'
    }
  }

  # --- port ------------------------------------------------------------------
  $owner = Get-PortOwner $Config.Port
  $portOk = ($owner -eq 0)
  $portDetail = "$($Config.Port) is free"
  if (-not $portOk) { $portDetail = "$($Config.Port) is in use by pid $owner" }
  $checks += @{
    Id = 'port'; Label = 'Port free'; Ok = $portOk; Severity = 'warn'
    Detail = $portDetail; FixLabel = $null; Fix = $null
  }

  return $checks
}

function Invoke-PreflightFix {
  param([Parameter(Mandatory)][hashtable]$Check, $Queue, [hashtable]$Config)

  if ($null -eq $Check.Fix) { return $false }
  try {
    & $Check.Fix $Config $Queue
    return $true
  } catch {
    Write-MwQueueNotice $Queue "fix for '$($Check.Label)' failed: $($_.Exception.Message)"
    return $false
  }
}
