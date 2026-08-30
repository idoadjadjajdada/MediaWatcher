<#
  Configuration for the MediaWatcher launcher.

  Reads the same .env the server reads, but never imports it into the launcher's
  own environment — values are returned as data so nothing leaks into child
  processes by accident.
#>

function Read-EnvFile {
  param([Parameter(Mandatory)][string]$Path)

  $values = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $values }

  foreach ($line in (Get-Content -LiteralPath $Path)) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $key = $matches[1]
      $raw = $matches[2]

      # Strip inline comments, but only when the # is preceded by whitespace.
      # A bare '#' inside a value (some API keys contain one) survives.
      $raw = ($raw -split '\s+#')[0]

      $raw = $raw.Trim()
      if ($raw.Length -ge 2) {
        if (($raw.StartsWith('"') -and $raw.EndsWith('"')) -or
            ($raw.StartsWith("'") -and $raw.EndsWith("'"))) {
          $raw = $raw.Substring(1, $raw.Length - 2)
        }
      }
      $values[$key] = $raw
    }
  }
  return $values
}

function Get-EnvValue {
  param([hashtable]$Values, [string]$Key, [string]$Default)

  if ($Values -and $Values.ContainsKey($Key)) {
    $candidate = $Values[$Key]
    if (-not [string]::IsNullOrWhiteSpace($candidate)) { return $candidate }
  }
  return $Default
}

function Resolve-MwPath {
  param([string]$Raw, [string]$Root)

  if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
  if ([System.IO.Path]::IsPathRooted($Raw)) {
    return [System.IO.Path]::GetFullPath($Raw)
  }
  $trimmed = $Raw -replace '^\.[\\/]', ''
  return [System.IO.Path]::GetFullPath((Join-Path $Root $trimmed))
}

function Get-MwConfig {
  param([Parameter(Mandatory)][string]$Root)

  $envPath = Join-Path $Root '.env'
  $values = Read-EnvFile -Path $envPath

  $port = 3000
  $portRaw = Get-EnvValue $values 'PORT' '3000'
  $parsed = 0
  if ([int]::TryParse($portRaw, [ref]$parsed)) { $port = $parsed }

  return @{
    Root        = $Root
    EnvPath     = $envPath
    EnvValues   = $values
    Port        = $port
    LibraryPath = Resolve-MwPath (Get-EnvValue $values 'LIBRARY_PATH' './library') $Root
    TempPath    = Resolve-MwPath (Get-EnvValue $values 'TEMP_PATH' './temp') $Root
    FfmpegPath  = Get-EnvValue $values 'FFMPEG_PATH' 'ffmpeg'
    FfprobePath = Get-EnvValue $values 'FFPROBE_PATH' 'ffprobe'
    LogLevel    = Get-EnvValue $values 'LOG_LEVEL' 'info'
  }
}
