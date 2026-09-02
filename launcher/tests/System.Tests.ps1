. (Join-Path $LauncherRoot 'lib\System.ps1')

# The parsing is what is tested here. Shelling out to tailscale.exe and sc.exe
# is not interesting; correctly reading three different "not working" states
# out of their output is, because each one needs a different button.

Describe-Group 'ConvertTo-MwTailscaleStatus' {
  $running = @'
{"BackendState":"Running","Self":{"DNSName":"desktop-9dikq29.taila824ee.ts.net.","Online":true}}
'@
  $status = ConvertTo-MwTailscaleStatus $running
  Assert-Equal $true $status.Running 'reads the running state'
  # The API returns a fully qualified name with a trailing dot; a URL built
  # from it unstripped still resolves but looks broken to anyone reading it.
  Assert-Equal 'desktop-9dikq29.taila824ee.ts.net' $status.DnsName 'strips the trailing dot'
  Assert-Contains $status.Label 'desktop-9dikq29' 'the label names the machine'

  $stopped = '{"BackendState":"Stopped","Self":{"DNSName":"x.ts.net."}}'
  $status2 = ConvertTo-MwTailscaleStatus $stopped
  Assert-Equal $false $status2.Running 'a stopped backend is not running'
  Assert-Contains $status2.Label 'Stopped' 'and the label says which state it is in'

  # Logged out still parses; it is a different problem from being stopped.
  $out = '{"BackendState":"NeedsLogin"}'
  Assert-Contains (ConvertTo-MwTailscaleStatus $out).Label 'NeedsLogin' 'needs-login is reported as itself'

  Assert-Equal $false (ConvertTo-MwTailscaleStatus '').Running 'no output is not running'
  Assert-Contains (ConvertTo-MwTailscaleStatus '').Label 'No response' 'and says so'
  Assert-Contains (ConvertTo-MwTailscaleStatus 'not json at all').Label 'Could not read' `
    'unparseable output is reported, not thrown'
  Assert-Equal $false (ConvertTo-MwTailscaleStatus '{"BackendState":"Running"}').DnsName.Length `
    'a running node with no name yields an empty name'
}

Describe-Group 'Get-MwTailnetUrl' {
  Assert-Equal 'https://host.ts.net' (Get-MwTailnetUrl 'host.ts.net') 'builds an https URL'
  Assert-Equal 'https://host.ts.net' (Get-MwTailnetUrl 'host.ts.net.') 'tolerates the trailing dot'
  Assert-Equal 'https://host.ts.net' (Get-MwTailnetUrl 'HOST.TS.NET') 'lowercases it'
  Assert-Equal '' (Get-MwTailnetUrl '') 'no name yields no URL'
  Assert-Equal '' (Get-MwTailnetUrl $null) 'null yields no URL'
}

Describe-Group 'Test-MwServePublished' {
  $serving = '{"TCP":{"443":{"HTTPS":true}},"Web":{"host:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}'
  Assert-Equal $true (Test-MwServePublished $serving 3000) 'finds our port in the serve config'
  Assert-Equal $false (Test-MwServePublished $serving 3001) 'a different port is not ours'
  Assert-Equal $false (Test-MwServePublished '' 3000) 'no output means not serving'
  Assert-Equal $true (Test-MwServePublished '{"Proxy":"http://localhost:3000"}' 3000) `
    'localhost is recognised as well as the address'
}

Describe-Group 'ConvertTo-MwServiceStatus' {
  $running = @'
SERVICE_NAME: MediaWatcher
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
'@
  $status = ConvertTo-MwServiceStatus $running
  Assert-Equal $true $status.Installed 'a service that reports a state is installed'
  Assert-Equal $true $status.Running 'and running'
  Assert-Contains $status.Label 'running' 'the label says so'

  $stopped = "SERVICE_NAME: MediaWatcher`n        STATE              : 1  STOPPED"
  $status2 = ConvertTo-MwServiceStatus $stopped
  Assert-Equal $true $status2.Installed 'a stopped service is still installed'
  Assert-Equal $false $status2.Running 'but not running'

  # 1060 is what sc.exe returns for a service that does not exist. Reading it
  # as anything else would offer Remove for something never installed.
  $missing = '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:'
  Assert-Equal $false (ConvertTo-MwServiceStatus $missing).Installed 'error 1060 means not installed'
  Assert-Equal 'Not installed' (ConvertTo-MwServiceStatus $missing).Label 'and says exactly that'

  Assert-Equal $false (ConvertTo-MwServiceStatus '').Installed 'no output means not installed'
  Assert-Equal $false (ConvertTo-MwServiceStatus 'something unexpected').Installed `
    'output without a STATE line is not treated as installed'
}

Describe-Group 'Get-MwServiceInstallArgs' {
  $args = Get-MwServiceInstallArgs -NodePath 'C:\Program Files\nodejs\node.exe' -Root 'C:\mw' -Port 3000

  Assert-Equal 'create' $args[0] 'creates the service'
  Assert-Equal 'MediaWatcher' $args[1] 'under the expected name'
  # sc.exe wants the equals sign attached to the key and the value separate;
  # writing binPath=value as one token is the classic way to get a service
  # that installs and then cannot start.
  Assert-Equal 'binPath=' $args[2] 'binPath= is its own token, with the trailing equals'
  Assert-Contains $args[3] 'node.exe' 'the binary path names node'
  Assert-Contains $args[3] 'server.js' 'and the script'
  # A path with a space in it is the normal case on Windows.
  Assert-Contains $args[3] '"C:\Program Files\nodejs\node.exe"' 'the node path is quoted'
  Assert-Contains $args[3] '"C:\mw\server.js"' 'and so is the script path'
  Assert-Equal 'start=' $args[6] 'start= is its own token too'
  Assert-Equal 'auto' $args[7] 'and starts with Windows'
}

Describe-Group 'Test-MwElevated' {
  # Whatever the answer, it must be a boolean rather than a throw - the panel
  # disables a button on it.
  $elevated = Test-MwElevated
  Assert-Equal $true ($elevated -is [bool]) 'answers a boolean either way'
}
