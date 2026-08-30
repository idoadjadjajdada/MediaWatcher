. (Join-Path $LauncherRoot 'lib\Config.ps1')

$fixtureDir = Join-Path $env:TEMP ("mw-config-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDir | Out-Null

Describe-Group 'Read-EnvFile' {
  $envFile = Join-Path $fixtureDir '.env'
  @(
    '# a comment line',
    'TMDB_API_KEY=abc123          # Get from themoviedb.org',
    'PORT=4200',
    'BLANK_VALUE=',
    '   SPACED_KEY   =   spaced value   ',
    'QUOTED="quoted value"',
    'HASH_IN_VALUE=abc#def'
  ) | Set-Content -LiteralPath $envFile -Encoding utf8

  $values = Read-EnvFile -Path $envFile

  Assert-Equal 'abc123' $values['TMDB_API_KEY'] 'strips an inline comment'
  Assert-Equal '4200' $values['PORT'] 'reads a plain value'
  Assert-Equal '' $values['BLANK_VALUE'] 'keeps a blank value as empty string'
  Assert-Equal 'spaced value' $values['SPACED_KEY'] 'trims key and value whitespace'
  Assert-Equal 'quoted value' $values['QUOTED'] 'strips surrounding quotes'
  Assert-Equal 'abc#def' $values['HASH_IN_VALUE'] 'keeps a hash that has no leading space'
  Assert-Equal $false $values.ContainsKey('# a comment line') 'ignores comment lines'

  $missing = Read-EnvFile -Path (Join-Path $fixtureDir 'nope.env')
  Assert-Equal 0 $missing.Count 'returns an empty hashtable when the file is absent'
}

Describe-Group 'Get-EnvValue' {
  $values = @{ SET = 'value'; EMPTY = '' }
  Assert-Equal 'value'    (Get-EnvValue $values 'SET' 'fallback')     'returns the set value'
  Assert-Equal 'fallback' (Get-EnvValue $values 'EMPTY' 'fallback')   'falls back on an empty value'
  Assert-Equal 'fallback' (Get-EnvValue $values 'ABSENT' 'fallback')  'falls back on a missing key'
}

Describe-Group 'Resolve-MwPath' {
  Assert-Equal 'C:\abs\path' (Resolve-MwPath 'C:\abs\path' 'C:\root') 'passes a rooted path through'
  Assert-Equal 'C:\root\library' (Resolve-MwPath './library' 'C:\root') 'resolves a dot-relative path'
  Assert-Equal 'C:\root\library' (Resolve-MwPath 'library' 'C:\root') 'resolves a bare relative path'
  Assert-Null (Resolve-MwPath '' 'C:\root') 'returns null for a blank path'
}

Describe-Group 'Get-MwConfig' {
  $config = Get-MwConfig -Root $fixtureDir
  Assert-Equal 4200 $config.Port 'parses PORT as an integer'
  Assert-Equal (Join-Path $fixtureDir 'library') $config.LibraryPath 'defaults LibraryPath to ./library'
  Assert-Equal (Join-Path $fixtureDir 'temp') $config.TempPath 'defaults TempPath to ./temp'
  Assert-Equal 'ffmpeg' $config.FfmpegPath 'defaults FfmpegPath to ffmpeg'
  Assert-Equal 'ffprobe' $config.FfprobePath 'defaults FfprobePath to ffprobe'
  Assert-Equal 'info' $config.LogLevel 'defaults LogLevel to info'
  Assert-Equal $fixtureDir $config.Root 'carries Root through'

  $emptyDir = Join-Path $env:TEMP ("mw-empty-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $emptyDir | Out-Null
  $bare = Get-MwConfig -Root $emptyDir
  Assert-Equal 3000 $bare.Port 'defaults Port to 3000 with no .env'
  Remove-Item -LiteralPath $emptyDir -Recurse -Force
}

Remove-Item -LiteralPath $fixtureDir -Recurse -Force
