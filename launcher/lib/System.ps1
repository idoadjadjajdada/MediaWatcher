# Tailscale, the caches, and running as a Windows service.
#
# Everything here shells out to something that already exists — tailscale.exe,
# sc.exe, the server's own diagnostics API — rather than reimplementing it. The
# value is in knowing which question to ask and what the answer means, so the
# parsing is what gets tested; the shelling out is not.

$script:MwServiceName = 'MediaWatcher'

<#
.SYNOPSIS
  Where is tailscale.exe, if anywhere?
.DESCRIPTION
  PATH first, then the default install location. Answers $null rather than
  throwing, because not having Tailscale is a normal state for this app.
#>
function Get-MwTailscalePath {
  $onPath = Get-Command 'tailscale.exe' -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

<#
.SYNOPSIS
  Turn `tailscale status --json` into the three facts the panel shows.
.DESCRIPTION
  Separated from the process call so it can be tested against captured output.
  A machine can be logged in but not running, and running but not serving, and
  those need different buttons — so they are three fields rather than one.
#>
function ConvertTo-MwTailscaleStatus {
  param([string]$Json)

  $result = @{
    Installed = $true
    Running = $false
    DnsName = ''
    Label = 'Not connected'
  }

  if ([string]::IsNullOrWhiteSpace($Json)) {
    $result.Label = 'No response from tailscale'
    return $result
  }

  try {
    $parsed = $Json | ConvertFrom-Json
  } catch {
    $result.Label = 'Could not read the tailscale status'
    return $result
  }

  $state = [string]$parsed.BackendState
  $result.Running = ($state -eq 'Running')

  if ($null -ne $parsed.Self -and $parsed.Self.DNSName) {
    # The API returns it fully qualified with a trailing dot.
    $result.DnsName = ([string]$parsed.Self.DNSName).TrimEnd('.')
  }

  if ($result.Running -and $result.DnsName) {
    $result.Label = "Connected as $($result.DnsName)"
  } elseif ($result.Running) {
    $result.Label = 'Connected'
  } elseif ($state) {
    $result.Label = "Tailscale is $state"
  }

  return $result
}

<#
.SYNOPSIS
  The https URL for a tailnet hostname, or '' when there is not one.
#>
function Get-MwTailnetUrl {
  param([string]$DnsName)
  if ([string]::IsNullOrWhiteSpace($DnsName)) { return '' }
  return 'https://' + $DnsName.TrimEnd('.').ToLowerInvariant()
}

<#
.SYNOPSIS
  Is `tailscale serve` already publishing our port?
.DESCRIPTION
  Reads `tailscale serve status --json`. The shape varies between versions, so
  this looks for the port anywhere in the text rather than walking a path that
  a future release might rename - a false negative here costs a redundant
  button press, while over-fitting the shape costs a wrong answer.
#>
function Test-MwServePublished {
  param([string]$Json, [int]$Port)

  if ([string]::IsNullOrWhiteSpace($Json)) { return $false }
  return $Json -match "127\.0\.0\.1:$Port" -or $Json -match "localhost:$Port"
}

<#
.SYNOPSIS
  What sc.exe says about our service.
.DESCRIPTION
  Parsed from text rather than Get-Service so that "not installed" is a plain
  answer instead of a terminating error to be caught.
#>
function ConvertTo-MwServiceStatus {
  param([string]$Output)

  $result = @{ Installed = $false; Running = $false; Label = 'Not installed' }
  if ([string]::IsNullOrWhiteSpace($Output)) { return $result }

  # 1060 is "the specified service does not exist".
  if ($Output -match '1060') { return $result }
  if ($Output -notmatch 'STATE') { return $result }

  $result.Installed = $true
  if ($Output -match 'STATE\s*:\s*\d+\s+RUNNING') {
    $result.Running = $true
    $result.Label = 'Installed and running'
  } elseif ($Output -match 'STATE\s*:\s*\d+\s+STOPPED') {
    $result.Label = 'Installed, stopped'
  } else {
    $result.Label = 'Installed'
  }
  return $result
}

<#
.SYNOPSIS
  Are we running elevated?
.DESCRIPTION
  Installing a service needs it, and finding out by trying produces an opaque
  access-denied from sc.exe rather than something worth showing a person.
#>
function Test-MwElevated {
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

<#
.SYNOPSIS
  The sc.exe command line that installs the server as a service.
.DESCRIPTION
  Built rather than run, so the quoting can be tested - which is the part that
  breaks, because sc.exe wants `binPath= "..."` with the space after the equals
  sign and the whole value quoted as one argument.
#>
function Get-MwServiceInstallArgs {
  param([string]$NodePath, [string]$Root, [int]$Port)

  $script = Join-Path $Root 'server.js'
  $binPath = '"{0}" "{1}"' -f $NodePath, $script
  return @(
    'create', $script:MwServiceName,
    'binPath=', $binPath,
    'DisplayName=', 'MediaWatcher',
    'start=', 'auto'
  )
}
