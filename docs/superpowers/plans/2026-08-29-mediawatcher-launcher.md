# MediaWatcher WPF Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MediaWatcher's broken launcher entry point with a dark, animated WPF control panel that starts/stops the server, runs pre-flight checks that fix their own failures, and shows live library and download state.

**Architecture:** A single PowerShell entry script loads a XAML window and dot-sources four pure-logic modules (`Config`, `Preflight`, `ServerProcess`, `ApiClient`). Server output and API polling both run off the UI thread and deposit messages into synchronized queues; one `DispatcherTimer` at 200ms drains both and is the only thing that touches the UI. Motion is four WPF `Storyboard`s on `Opacity` and `RenderTransform` so everything stays GPU-composited.

**Tech Stack:** Windows PowerShell 5.1, .NET Framework 4.8, WPF (`PresentationFramework`), `System.Windows.Shell.WindowChrome`. No npm packages, no installed PowerShell modules.

**Spec:** `docs/superpowers/specs/2026-08-29-mediawatcher-launcher-design.md`

## Global Constraints

- **Target runtime:** Windows PowerShell **5.1** on .NET Framework **4.8**. Verified present.
- **No PowerShell 7 syntax.** No ternary `? :`, no `??`, no `-AsHashtable` on `ConvertFrom-Json`, no `&&`/`||` chaining. These are parse errors on 5.1.
- **No installed modules.** Tests use a hand-rolled assertion harness. Pester 5 is NOT available on this machine (only 3.4).
- **No new npm dependencies.** `package.json` is not modified.
- **XAML must not declare `x:Class`.** PowerShell cannot compile code-behind; `XamlReader::Load` throws if `x:Class` is present. Elements are reached with `$window.FindName('name')`.
- **`AllowsTransparency` must stay `False`.** On .NET Framework it forces software rendering and kills animation smoothness. Custom chrome comes from `WindowChrome` only.
- **Nothing touches the UI outside the dispatcher tick or a direct user event handler.** No `Invoke-WebRequest` on the UI thread, ever.
- **Palette (exact):** Background `#0a0a0a`, Panel `#161616`, Hover `#1f1f1f`, LogBg `#0d0d0d`, Border `#2a2a2a`, Text `#e5e5e5`, Dim `#888888`, Accent `#a855f7`, Accent2 `#ec4899`, Success `#10b981`, Warning `#f59e0b`, Danger `#ef4444`, Info `#93c5fd`.
- **Fonts:** Segoe UI for interface, Consolas for the log.
- **Log buffer cap:** 500 lines, trimmed from the front.
- **Dispatcher tick:** 200ms.
- **Project root** is the parent of `launcher/`, resolved from `$PSScriptRoot`.

---

## File Structure

| File | Responsibility |
|---|---|
| `MediaWatcher.bat` | Double-click entry. One line, launches the PowerShell entry hidden. |
| `MediaWatcher.winforms.ps1` | The old WinForms launcher, renamed. Untouched fallback. |
| `launcher/MediaWatcher.ps1` | Entry: dot-sources lib, loads XAML, wires events, owns the tick. |
| `launcher/MainWindow.xaml` | All markup, brushes, control styles, storyboards. |
| `launcher/lib/Config.ps1` | `.env` parsing, path and port resolution. |
| `launcher/lib/Preflight.ps1` | Check definitions, evaluation, fix actions. |
| `launcher/lib/ServerProcess.ps1` | Process lifecycle, output queue, streamed commands. |
| `launcher/lib/ApiClient.ps1` | Background runspace polling the server API. |
| `launcher/tests/run-tests.ps1` | Assertion harness + runner. No module dependency. |
| `launcher/tests/Config.Tests.ps1` | Tests for Config. |
| `launcher/tests/Preflight.Tests.ps1` | Tests for Preflight. |
| `launcher/tests/ServerProcess.Tests.ps1` | Tests for ServerProcess. |
| `launcher/tests/ApiClient.Tests.ps1` | Tests for ApiClient. |
| `start.bat` | Rewritten to hand off to `MediaWatcher.bat`. |
| `README.md` | Launcher sections rewritten. |
| `.gitignore` | Gains `.superpowers/`. |

---

## Task 0: Version control, preservation, and test harness

No git repository exists, so there is currently no undo for any of this work. This task creates one, preserves the existing launcher, and builds the assertion harness every later task depends on.

**Files:**
- Create: `.git/` (via `git init`)
- Modify: `.gitignore`
- Rename: `MediaWatcher.ps1` → `MediaWatcher.winforms.ps1`
- Create: `launcher/tests/run-tests.ps1`

**Interfaces:**
- Consumes: nothing
- Produces: `Assert-Equal`, `Assert-True`, `Assert-Null`, `Assert-Contains`, `Describe-Group` — used by every test file in Tasks 1–4. `run-tests.ps1` exits 1 when any assertion fails.

- [ ] **Step 1: Initialise the repository**

```bash
cd "C:/Users/Zion/Desktop/Claude/mediawatcher"
git init
git config user.email "steelestrongpta@gmail.com"
git config user.name "Zion"
```

- [ ] **Step 2: Add `.superpowers/` to `.gitignore`**

Append to `.gitignore` after the `# Editors` block:

```gitignore

# Brainstorming artifacts
.superpowers/
```

- [ ] **Step 3: Verify the ignore rules exclude the heavy directories**

Run: `git status --short | head -30`

Expected: no `library/`, no `node_modules/`, no `*.db`, no `.env` entries. If any appear, stop and fix `.gitignore` before committing — `library/` alone is many gigabytes of video.

- [ ] **Step 4: Commit the current state as a baseline**

```bash
git add -A
git commit -m "chore: baseline before launcher rewrite"
```

- [ ] **Step 5: Preserve the WinForms launcher**

```bash
git mv MediaWatcher.ps1 MediaWatcher.winforms.ps1
```

- [ ] **Step 6: Write the assertion harness**

Create `launcher/tests/run-tests.ps1`:

```powershell
<#
  Minimal assertion harness. Pester 5 is not installed on the target machine
  and Windows ships Pester 3.4, whose syntax differs enough to be a liability.
  This runner has no dependencies beyond Windows PowerShell itself.

  Usage:  powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1
  Exit:   0 when every assertion passed, 1 otherwise.
#>
$ErrorActionPreference = 'Stop'

$script:Total = 0
$script:Failures = 0
$script:CurrentGroup = ''

function Describe-Group {
  param([string]$Name, [scriptblock]$Body)
  $script:CurrentGroup = $Name
  Write-Host ""
  Write-Host $Name -ForegroundColor Cyan
  & $Body
}

function Assert-Equal {
  param($Expected, $Actual, [string]$Because)
  $script:Total++
  if ($Expected -eq $Actual) {
    Write-Host "  [pass] $Because" -ForegroundColor DarkGreen
  } else {
    $script:Failures++
    Write-Host "  [FAIL] $Because" -ForegroundColor Red
    Write-Host "         expected: <$Expected>" -ForegroundColor Red
    Write-Host "         actual:   <$Actual>" -ForegroundColor Red
  }
}

function Assert-True {
  param([bool]$Condition, [string]$Because)
  Assert-Equal -Expected $true -Actual $Condition -Because $Because
}

function Assert-Null {
  param($Value, [string]$Because)
  Assert-Equal -Expected $true -Actual ($null -eq $Value) -Because $Because
}

function Assert-Contains {
  param([string]$Haystack, [string]$Needle, [string]$Because)
  Assert-Equal -Expected $true -Actual ($Haystack -like "*$Needle*") -Because $Because
}

# --- discover and run every *.Tests.ps1 beside this file ---------------------
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$LauncherRoot = Split-Path -Parent $here
$ProjectRoot = Split-Path -Parent $LauncherRoot

foreach ($file in (Get-ChildItem -Path $here -Filter '*.Tests.ps1' | Sort-Object Name)) {
  Write-Host ""
  Write-Host ("=" * 60) -ForegroundColor DarkGray
  Write-Host $file.Name -ForegroundColor White
  . $file.FullName
}

Write-Host ""
Write-Host ("=" * 60) -ForegroundColor DarkGray
if ($script:Failures -eq 0) {
  Write-Host "$($script:Total) assertions, all passed" -ForegroundColor Green
  exit 0
} else {
  Write-Host "$($script:Total) assertions, $($script:Failures) FAILED" -ForegroundColor Red
  exit 1
}
```

- [ ] **Step 7: Run the harness with no test files present**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: prints `0 assertions, all passed`, exits 0. This proves discovery and exit codes work before any real test exists.

- [ ] **Step 8: Commit**

```bash
git add .gitignore launcher/tests/run-tests.ps1
git commit -m "test: add dependency-free assertion harness; preserve WinForms launcher"
```

---

## Task 1: Config module

**Files:**
- Create: `launcher/lib/Config.ps1`
- Test: `launcher/tests/Config.Tests.ps1`

**Interfaces:**
- Consumes: `Assert-*` from Task 0, `$ProjectRoot` set by the runner
- Produces:
  - `Read-EnvFile([string]$Path)` → `[hashtable]`, empty when the file is absent
  - `Get-EnvValue([hashtable]$Values, [string]$Key, [string]$Default)` → `[string]`
  - `Resolve-MwPath([string]$Raw, [string]$Root)` → absolute path `[string]`, `$null` for blank input
  - `Get-MwConfig([string]$Root)` → `[hashtable]` with keys `Root, EnvPath, EnvValues, Port, LibraryPath, TempPath, FfmpegPath, FfprobePath, LogLevel`

- [ ] **Step 1: Write the failing tests**

Create `launcher/tests/Config.Tests.ps1`:

```powershell
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: FAIL — the run aborts with `The term 'Read-EnvFile' is not recognized` (or a dot-source failure on the missing `Config.ps1`).

- [ ] **Step 3: Write the implementation**

Create `launcher/lib/Config.ps1`:

```powershell
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: PASS — `Read-EnvFile`, `Get-EnvValue`, `Resolve-MwPath` and `Get-MwConfig` groups all green, `19 assertions, all passed`.

- [ ] **Step 5: Commit**

```bash
git add launcher/lib/Config.ps1 launcher/tests/Config.Tests.ps1
git commit -m "feat(launcher): add Config module with .env parsing and path resolution"
```

---

## Task 2: Preflight module

**Files:**
- Create: `launcher/lib/Preflight.ps1`
- Test: `launcher/tests/Preflight.Tests.ps1`

**Interfaces:**
- Consumes: `Get-MwConfig` from Task 1
- Produces:
  - `Test-MwBinary([string]$Command)` → `[bool]`
  - `Get-PortOwner([int]$Port)` → owning pid as `[int]`, or `0` when free
  - `Get-PreflightChecks([hashtable]$Config)` → array of check hashtables with keys `Id, Label, Ok, Severity, Detail, FixLabel, Fix`
  - `Invoke-PreflightFix([hashtable]$Check, $Queue)` → `[bool]`

`Severity` is the string `fail` or `warn`. `Fix` is a `[scriptblock]` taking `$Config` and `$Queue`, or `$null`.

- [ ] **Step 1: Write the failing tests**

Create `launcher/tests/Preflight.Tests.ps1`:

```powershell
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
  # Port 0 is never listened on; a free high port should report no owner.
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: FAIL — `Test-MwBinary` is not recognised.

- [ ] **Step 3: Write the implementation**

Create `launcher/lib/Preflight.ps1`:

```powershell
<#
  Pre-flight checks.

  Every check reports a severity and, where a machine can plausibly fix the
  problem itself, a Fix scriptblock. Fixes that run long commands delegate to
  Start-StreamedCommand so their output lands in the same log pane as the
  server's, and return immediately rather than blocking the UI.
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
```

Note: `Write-MwQueueNotice` and `Start-StreamedCommand` come from Task 3. The Fix scriptblocks are not invoked by these tests, so Task 2's tests pass without them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: PASS — all Config and Preflight groups green.

- [ ] **Step 5: Commit**

```bash
git add launcher/lib/Preflight.ps1 launcher/tests/Preflight.Tests.ps1
git commit -m "feat(launcher): add pre-flight checks with fix actions"
```

---

## Task 3: ServerProcess module

**Files:**
- Create: `launcher/lib/ServerProcess.ps1`
- Test: `launcher/tests/ServerProcess.Tests.ps1`

**Interfaces:**
- Consumes: `Get-MwConfig` from Task 1
- Produces:
  - `New-MwQueue()` → `[System.Collections.Queue]` (synchronized)
  - `Write-MwQueueNotice($Queue, [string]$Text)` → void
  - `Get-MwLogLevel([string]$Line)` → one of `error, warn, info, debug, plain`
  - `Start-StreamedCommand([string]$FilePath, [string]$Arguments, [string]$WorkingDirectory, $Queue, [string]$Tag)` → `[hashtable]` `@{ Process; Subscriptions }`
  - `Start-MwServer([hashtable]$Config, [string]$LogLevel, $Queue)` → same handle shape
  - `Stop-MwHandle([hashtable]$Handle)` → void

Queue messages are hashtables: `@{ Kind; Text; Tag; Timestamp }` where `Kind` is `stdout`, `stderr` or `notice`.

- [ ] **Step 1: Write the failing tests**

Create `launcher/tests/ServerProcess.Tests.ps1`:

```powershell
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
  Start-Sleep -Milliseconds 400   # let the async output events drain

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: FAIL — `New-MwQueue` is not recognised.

- [ ] **Step 3: Write the implementation**

Create `launcher/lib/ServerProcess.ps1`:

```powershell
<#
  Child-process management.

  stdout and stderr arrive on threadpool threads, so nothing here touches the
  UI. Lines are pushed into a synchronized queue that the dispatcher tick
  drains. Both the server and one-click fix commands (npm, winget) use the same
  path, so all output lands in the same log pane.
#>

function New-MwQueue {
  return [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))
}

function Write-MwQueueNotice {
  param($Queue, [string]$Text)

  if ($null -eq $Queue) { return }
  $Queue.Enqueue(@{
    Kind = 'notice'; Text = $Text; Tag = 'launcher'; Timestamp = (Get-Date)
  })
}

function Get-MwLogLevel {
  param([string]$Line)

  if ([string]::IsNullOrWhiteSpace($Line)) { return 'plain' }
  if ($Line -match '\bERROR\b') { return 'error' }
  if ($Line -match '\bWARN\b')  { return 'warn' }
  if ($Line -match '\bINFO\b')  { return 'info' }
  if ($Line -match '\bDEBUG\b') { return 'debug' }
  return 'plain'
}

function Start-StreamedCommand {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string]$Arguments = '',
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)]$Queue,
    [string]$Tag = 'cmd',
    [hashtable]$Environment = $null
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  if ($Environment) {
    foreach ($key in $Environment.Keys) {
      $psi.EnvironmentVariables[$key] = [string]$Environment[$key]
    }
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $process.EnableRaisingEvents = $true

  # MessageData carries both the queue and the tag into the event runspace,
  # which cannot see this function's local scope.
  $context = @{ Queue = $Queue; Tag = $Tag }

  $subscriptions = @()
  $subscriptions += Register-ObjectEvent -InputObject $process -EventName OutputDataReceived `
    -MessageData $context -Action {
      if ($null -ne $EventArgs.Data) {
        $Event.MessageData.Queue.Enqueue(@{
          Kind = 'stdout'; Text = $EventArgs.Data
          Tag = $Event.MessageData.Tag; Timestamp = (Get-Date)
        })
      }
    }
  $subscriptions += Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived `
    -MessageData $context -Action {
      if ($null -ne $EventArgs.Data) {
        $Event.MessageData.Queue.Enqueue(@{
          Kind = 'stderr'; Text = $EventArgs.Data
          Tag = $Event.MessageData.Tag; Timestamp = (Get-Date)
        })
      }
    }

  [void]$process.Start()
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()

  return @{ Process = $process; Subscriptions = $subscriptions; Tag = $Tag; StartedAt = (Get-Date) }
}

function Start-MwServer {
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [string]$LogLevel = 'info',
    [Parameter(Mandatory)]$Queue
  )

  Write-MwQueueNotice $Queue "starting MediaWatcher (node server.js, LOG_LEVEL=$LogLevel)"
  return Start-StreamedCommand -FilePath 'node' -Arguments 'server.js' `
    -WorkingDirectory $Config.Root -Queue $Queue -Tag 'server' `
    -Environment @{ LOG_LEVEL = $LogLevel }
}

function Stop-MwHandle {
  param([hashtable]$Handle)

  if ($null -eq $Handle) { return }

  if ($null -ne $Handle.Process) {
    try {
      if (-not $Handle.Process.HasExited) {
        # Node on Windows cannot receive SIGTERM, so the tree is terminated.
        # Safe: SQLite runs in WAL mode and recovers on next open.
        & taskkill /PID $Handle.Process.Id /T /F 2>&1 | Out-Null
      }
    } catch {
      # Process already gone between the check and the kill.
    }
  }

  if ($null -ne $Handle.Subscriptions) {
    foreach ($subscription in $Handle.Subscriptions) {
      Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
    }
  }
  $Handle.Subscriptions = @()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: PASS — Config, Preflight and ServerProcess groups all green.

- [ ] **Step 5: Commit**

```bash
git add launcher/lib/ServerProcess.ps1 launcher/tests/ServerProcess.Tests.ps1
git commit -m "feat(launcher): add process management with queued output streaming"
```

---

## Task 4: ApiClient module

**Files:**
- Create: `launcher/lib/ApiClient.ps1`
- Test: `launcher/tests/ApiClient.Tests.ps1`

**Interfaces:**
- Consumes: `New-MwQueue` from Task 3
- Produces:
  - `ConvertTo-MwLibrarySummary($Payload)` → `@{ Movies; Shows; Unknown; LastScanAt; Scanning }`
  - `ConvertTo-MwJobSummary($Payload)` → array of `@{ Id; Title; Status; Progress; Phase }`
  - `Start-ApiPoller([hashtable]$Config, $ResultQueue)` → `[hashtable]` `@{ Runspace; PowerShell; AsyncResult; Control }`
  - `Stop-ApiPoller([hashtable]$Handle)` → void
  - `Request-LibraryRefresh([hashtable]$Handle)` → void
  - `Request-Rescan([hashtable]$Handle)` → void
  - `Set-ApiPollerJobsWanted([hashtable]$Handle, [bool]$Wanted)` → void

Result messages: `@{ Kind; Data; Timestamp }` where `Kind` is `health`, `library`, `jobs` or `error`.

The `Control` member is a synchronized hashtable shared with the runspace, carrying `Stop`, `RefreshLibrary`, `Rescan`, `JobsWanted`.

- [ ] **Step 1: Write the failing tests**

Create `launcher/tests/ApiClient.Tests.ps1`:

```powershell
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

  Start-Sleep -Milliseconds 900   # let it attempt at least one failing poll

  $messages = @()
  while ($queue.Count -gt 0) { $messages += $queue.Dequeue() }
  $errorMessages = @($messages | Where-Object { $_.Kind -eq 'error' })
  Assert-True ($errorMessages.Count -ge 1) 'a dead server produces an error result, not an exception'

  Stop-ApiPoller $handle
  Assert-Equal $true $handle.Control['Stop'] 'Stop flag is set on shutdown'
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: FAIL — `ConvertTo-MwLibrarySummary` is not recognised.

- [ ] **Step 3: Write the implementation**

Create `launcher/lib/ApiClient.ps1`:

```powershell
<#
  Polls the MediaWatcher server's own API from a background runspace.

  No HTTP call is ever made on the UI thread. The current WinForms launcher
  calls Invoke-WebRequest -TimeoutSec 10 inside a click handler, which freezes
  the window for ten seconds against a hung server; this module exists to make
  that impossible.

  Cadence:
    /api/health          every 2s   (cheap liveness, drives the status pill)
    /api/media/library   every 15s  (whole-library payload; a cold first call
                                     blocks on a full scan, so it is polled
                                     slowly and on demand)
    /api/torrents/jobs   every 2s   but only when JobsWanted is set
#>

function ConvertTo-MwLibrarySummary {
  param($Payload)

  if ($null -eq $Payload) { return $null }

  $movies = @($Payload.movies)
  $shows = @($Payload.shows)
  $unknown = @($Payload.unknown)

  $files = 0
  foreach ($movie in $movies) { $files += @($movie.files).Count }
  foreach ($show in $shows) {
    foreach ($season in @($show.seasons)) {
      foreach ($episode in @($season.episodes)) { $files += @($episode.files).Count }
    }
  }

  $lastScan = $null
  if ($Payload.last_scan_at) {
    $lastScan = [System.DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Payload.last_scan_at).LocalDateTime
  }

  return @{
    Movies     = $movies.Count
    Shows      = $shows.Count
    Unknown    = $unknown.Count
    Files      = $files
    LastScanAt = $lastScan
    Scanning   = [bool]$Payload.scanning
  }
}

function ConvertTo-MwJobSummary {
  param($Payload)

  if ($null -eq $Payload) { return @() }

  $jobs = @()
  foreach ($row in @($Payload)) {
    $progress = 0.0
    if ($null -ne $row.progress) { $progress = [double]$row.progress }

    $phase = ''
    if ($row.PSObject.Properties.Name -contains 'phase' -and $row.phase) { $phase = [string]$row.phase }

    $errorText = ''
    if ($row.PSObject.Properties.Name -contains 'error' -and $row.error) { $errorText = [string]$row.error }

    $jobs += @{
      Id       = [string]$row.id
      Title    = [string]$row.title
      Status   = [string]$row.status
      Progress = $progress
      Percent  = [int][math]::Round($progress * 100)
      Phase    = $phase
      Error    = $errorText
    }
  }
  return $jobs
}

function Get-MwActiveJobCount {
  param($Jobs)

  if ($null -eq $Jobs) { return 0 }
  return @($Jobs | Where-Object { $_.Status -eq 'downloading' -or $_.Status -eq 'queued' }).Count
}

function Start-ApiPoller {
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [Parameter(Mandatory)]$ResultQueue
  )

  $control = [hashtable]::Synchronized(@{
    Stop           = $false
    RefreshLibrary = $false
    Rescan         = $false
    JobsWanted     = $false
  })

  $runspace = [runspacefactory]::CreateRunspace()
  $runspace.ApartmentState = 'MTA'
  $runspace.ThreadOptions = 'ReuseThread'
  $runspace.Open()
  $runspace.SessionStateProxy.SetVariable('Control', $control)
  $runspace.SessionStateProxy.SetVariable('ResultQueue', $ResultQueue)
  $runspace.SessionStateProxy.SetVariable('BaseUrl', "http://127.0.0.1:$($Config.Port)")

  $worker = {
    $ErrorActionPreference = 'Stop'

    function Push-Result($Kind, $Data) {
      $ResultQueue.Enqueue(@{ Kind = $Kind; Data = $Data; Timestamp = (Get-Date) })
    }

    function Invoke-Api($Path, $TimeoutSec, $Method) {
      $uri = $BaseUrl + $Path
      return Invoke-RestMethod -Uri $uri -Method $Method -TimeoutSec $TimeoutSec -UseBasicParsing
    }

    $lastHealth = [datetime]::MinValue
    $lastLibrary = [datetime]::MinValue
    $lastJobs = [datetime]::MinValue
    $lastErrorAt = [datetime]::MinValue
    $awaitingScan = $false

    while (-not $Control['Stop']) {
      $now = Get-Date

      # --- rescan request (POST, then follow the scan to completion) ---------
      if ($Control['Rescan']) {
        $Control['Rescan'] = $false
        try {
          Invoke-Api '/api/media/rescan' 10 'POST' | Out-Null
          Push-Result 'notice' 'rescan requested'
          $awaitingScan = $true
          $lastLibrary = [datetime]::MinValue
        } catch {
          Push-Result 'error' "rescan failed: $($_.Exception.Message)"
        }
      }

      if ($Control['RefreshLibrary']) {
        $Control['RefreshLibrary'] = $false
        $lastLibrary = [datetime]::MinValue
      }

      # --- health (2s) -------------------------------------------------------
      if (($now - $lastHealth).TotalMilliseconds -ge 2000) {
        $lastHealth = $now
        try {
          $health = Invoke-Api '/api/health' 3 'GET'
          Push-Result 'health' $health
        } catch {
          # Rate-limit error noise to one message every 10 seconds.
          if (($now - $lastErrorAt).TotalSeconds -ge 10) {
            $lastErrorAt = $now
            Push-Result 'error' $_.Exception.Message
          }
        }
      }

      # --- library (15s, or 2s while a scan is running) ----------------------
      $libraryInterval = 15000
      if ($awaitingScan) { $libraryInterval = 2000 }
      if (($now - $lastLibrary).TotalMilliseconds -ge $libraryInterval) {
        $lastLibrary = $now
        try {
          $library = Invoke-Api '/api/media/library' 10 'GET'
          Push-Result 'library' $library
          if ($awaitingScan -and -not $library.scanning) { $awaitingScan = $false }
        } catch {
          # Library failures are silent; health already reports the server state.
        }
      }

      # --- jobs (2s, only when wanted) ---------------------------------------
      if ($Control['JobsWanted'] -and ($now - $lastJobs).TotalMilliseconds -ge 2000) {
        $lastJobs = $now
        try {
          $jobs = Invoke-Api '/api/torrents/jobs' 5 'GET'
          Push-Result 'jobs' $jobs
        } catch {
          # Silent for the same reason as library.
        }
      }

      Start-Sleep -Milliseconds 250
    }
  }

  $powershell = [powershell]::Create()
  $powershell.Runspace = $runspace
  [void]$powershell.AddScript($worker)
  $asyncResult = $powershell.BeginInvoke()

  return @{
    Runspace = $runspace; PowerShell = $powershell
    AsyncResult = $asyncResult; Control = $control
  }
}

function Stop-ApiPoller {
  param([hashtable]$Handle)

  if ($null -eq $Handle) { return }
  $Handle.Control['Stop'] = $true

  try {
    # Give the loop one cycle to notice the flag before tearing the runspace down.
    Start-Sleep -Milliseconds 350
    if ($null -ne $Handle.PowerShell) {
      [void]$Handle.PowerShell.Stop()
      $Handle.PowerShell.Dispose()
    }
    if ($null -ne $Handle.Runspace) {
      $Handle.Runspace.Close()
      $Handle.Runspace.Dispose()
    }
  } catch {
    # Shutdown races are not worth reporting.
  }
}

function Request-LibraryRefresh {
  param([hashtable]$Handle)
  if ($null -ne $Handle) { $Handle.Control['RefreshLibrary'] = $true }
}

function Request-Rescan {
  param([hashtable]$Handle)
  if ($null -ne $Handle) { $Handle.Control['Rescan'] = $true }
}

function Set-ApiPollerJobsWanted {
  param([hashtable]$Handle, [bool]$Wanted)
  if ($null -ne $Handle) { $Handle.Control['JobsWanted'] = $Wanted }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: PASS — all four module groups green.

- [ ] **Step 5: Commit**

```bash
git add launcher/lib/ApiClient.ps1 launcher/tests/ApiClient.Tests.ps1
git commit -m "feat(launcher): add background API poller with off-thread rescan"
```

---

## Task 5: XAML window shell

Static markup only — no behaviour. The deliverable is a window that opens and looks right.

**Files:**
- Create: `launcher/MainWindow.xaml`
- Create: `launcher/MediaWatcher.ps1` (minimal loader; expanded in Task 6)

**Interfaces:**
- Consumes: nothing
- Produces: named elements reached via `$window.FindName(...)` in Tasks 6–9:
  `TitleBar, BtnMinimize, BtnClose, StatusPill, StatusDot, StatusText,
   TileFiles, TileShows, TileMovies, TileDownloads,
   BtnStart, BtnRestart, BtnStop, BtnOpenApp, BtnRescan, BtnLibrary, CmbLogLevel,
   TabLog, TabPreflight, TabDownloads, DotPreflight, BadgeDownloads,
   PaneLog, PanePreflight, PaneDownloads,
   LogItems, LogScroll, ChkFollow, BtnClearLog,
   PreflightItems, BtnRecheck, DownloadItems, DownloadsEmpty`

- [ ] **Step 1: Write the XAML**

Create `launcher/MainWindow.xaml`. Note there is **no `x:Class`** — `XamlReader::Load` throws on it.

```xml
<Window
  xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  xmlns:shell="clr-namespace:System.Windows.Shell;assembly=PresentationFramework"
  Title="MediaWatcher" Width="1040" Height="700" MinWidth="880" MinHeight="580"
  WindowStartupLocation="CenterScreen" Background="#0a0a0a"
  FontFamily="Segoe UI" UseLayoutRounding="True" TextOptions.TextFormattingMode="Display">

  <shell:WindowChrome.WindowChrome>
    <!-- CaptionHeight 0: the whole titlebar is ours, dragged via a mouse handler.
         AllowsTransparency stays False so the window keeps hardware acceleration. -->
    <shell:WindowChrome CaptionHeight="0" ResizeBorderThickness="6"
                        CornerRadius="0" GlassFrameThickness="0" UseAeroCaptionButtons="False"/>
  </shell:WindowChrome.WindowChrome>

  <Window.Resources>
    <SolidColorBrush x:Key="Bg"      Color="#0a0a0a"/>
    <SolidColorBrush x:Key="Panel"   Color="#161616"/>
    <SolidColorBrush x:Key="Hover"   Color="#1f1f1f"/>
    <SolidColorBrush x:Key="LogBg"   Color="#0d0d0d"/>
    <SolidColorBrush x:Key="Border"  Color="#2a2a2a"/>
    <SolidColorBrush x:Key="Text"    Color="#e5e5e5"/>
    <SolidColorBrush x:Key="Dim"     Color="#888888"/>
    <SolidColorBrush x:Key="Accent"  Color="#a855f7"/>
    <SolidColorBrush x:Key="Accent2" Color="#ec4899"/>
    <SolidColorBrush x:Key="Success" Color="#10b981"/>
    <SolidColorBrush x:Key="Warning" Color="#f59e0b"/>
    <SolidColorBrush x:Key="Danger"  Color="#ef4444"/>
    <SolidColorBrush x:Key="Info"    Color="#93c5fd"/>

    <LinearGradientBrush x:Key="AccentGradient" StartPoint="0,0" EndPoint="1,1">
      <GradientStop Color="#a855f7" Offset="0"/>
      <GradientStop Color="#ec4899" Offset="1"/>
    </LinearGradientBrush>

    <!-- Primary button: gradient fill, hover lift, 96% press dip. -->
    <Style x:Key="PrimaryButton" TargetType="Button">
      <Setter Property="Foreground" Value="White"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="SnapsToDevicePixels" Value="True"/>
      <Setter Property="RenderTransformOrigin" Value="0.5,0.5"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="{StaticResource AccentGradient}" CornerRadius="6" Padding="10,9">
              <Border.RenderTransform><ScaleTransform x:Name="sc" ScaleX="1" ScaleY="1"/></Border.RenderTransform>
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Opacity" Value="0.88"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="sc" Property="ScaleX" Value="0.96"/>
                <Setter TargetName="sc" Property="ScaleY" Value="0.96"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="bd" Property="Opacity" Value="0.35"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="SecondaryButton" TargetType="Button" BasedOn="{StaticResource PrimaryButton}">
      <Setter Property="Foreground" Value="#d4d4d4"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="{StaticResource Hover}" BorderBrush="{StaticResource Border}"
                    BorderThickness="1" CornerRadius="6" Padding="10,8">
              <Border.RenderTransform><ScaleTransform x:Name="sc" ScaleX="1" ScaleY="1"/></Border.RenderTransform>
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#262626"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="sc" Property="ScaleX" Value="0.96"/>
                <Setter TargetName="sc" Property="ScaleY" Value="0.96"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="bd" Property="Opacity" Value="0.4"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="DangerButton" TargetType="Button" BasedOn="{StaticResource SecondaryButton}">
      <Setter Property="Foreground" Value="#ef4444"/>
    </Style>

    <Style x:Key="ChromeButton" TargetType="Button">
      <Setter Property="Foreground" Value="{StaticResource Dim}"/>
      <Setter Property="FontFamily" Value="Segoe MDL2 Assets"/>
      <Setter Property="FontSize" Value="10"/>
      <Setter Property="Width" Value="44"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="Transparent">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#262626"/>
                <Setter Property="Foreground" Value="{StaticResource Text}"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="TabButton" TargetType="Button">
      <Setter Property="Foreground" Value="{StaticResource Dim}"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border Background="Transparent" Padding="14,8">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter Property="Foreground" Value="{StaticResource Text}"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="Tile" TargetType="Border">
      <Setter Property="Background" Value="{StaticResource Panel}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Border}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="8"/>
      <Setter Property="Padding" Value="14,10"/>
    </Style>

    <Style x:Key="TileNumber" TargetType="TextBlock">
      <Setter Property="Foreground" Value="White"/>
      <Setter Property="FontSize" Value="22"/>
      <Setter Property="FontWeight" Value="Bold"/>
    </Style>

    <Style x:Key="TileCaption" TargetType="TextBlock">
      <Setter Property="Foreground" Value="{StaticResource Dim}"/>
      <Setter Property="FontSize" Value="9"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Margin" Value="0,2,0,0"/>
    </Style>

    <Style x:Key="SectionLabel" TargetType="TextBlock">
      <Setter Property="Foreground" Value="{StaticResource Dim}"/>
      <Setter Property="FontSize" Value="9"/>
      <Setter Property="FontWeight" Value="Bold"/>
    </Style>
  </Window.Resources>

  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="46"/>   <!-- titlebar -->
      <RowDefinition Height="Auto"/> <!-- status strip -->
      <RowDefinition Height="*"/>    <!-- body -->
    </Grid.RowDefinitions>

    <!-- ============ TITLEBAR ============ -->
    <Border x:Name="TitleBar" Grid.Row="0" Background="{StaticResource Panel}"
            BorderBrush="{StaticResource Border}" BorderThickness="0,0,0,1">
      <Grid>
        <StackPanel Orientation="Horizontal" VerticalAlignment="Center" Margin="14,0,0,0">
          <Border Width="24" Height="24" CornerRadius="6" Background="{StaticResource AccentGradient}">
            <TextBlock Text="&#9654;" Foreground="White" FontSize="10"
                       HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <TextBlock Text="MediaWatcher" Foreground="{StaticResource Text}" FontWeight="Bold"
                     FontSize="13" VerticalAlignment="Center" Margin="10,0,0,0"/>
        </StackPanel>

        <Border x:Name="StatusPill" HorizontalAlignment="Right" VerticalAlignment="Center"
                Margin="0,0,100,0" CornerRadius="20" Padding="12,5"
                Background="#1f1f1f" BorderBrush="{StaticResource Border}" BorderThickness="1">
          <StackPanel Orientation="Horizontal">
            <Ellipse x:Name="StatusDot" Width="8" Height="8" Fill="#666666" VerticalAlignment="Center"/>
            <TextBlock x:Name="StatusText" Text="Stopped" Foreground="{StaticResource Dim}"
                       FontWeight="SemiBold" FontSize="11" Margin="8,0,0,0" VerticalAlignment="Center"/>
          </StackPanel>
        </Border>

        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Stretch">
          <Button x:Name="BtnMinimize" Style="{StaticResource ChromeButton}" Content="&#xE921;"/>
          <Button x:Name="BtnClose" Style="{StaticResource ChromeButton}" Content="&#xE8BB;"/>
        </StackPanel>
      </Grid>
    </Border>

    <!-- ============ STATUS STRIP ============ -->
    <Grid x:Name="StatusStrip" Grid.Row="1" Margin="16,14,16,0">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/><ColumnDefinition Width="10"/>
        <ColumnDefinition Width="*"/><ColumnDefinition Width="10"/>
        <ColumnDefinition Width="*"/><ColumnDefinition Width="10"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>
      <Border Grid.Column="0" Style="{StaticResource Tile}">
        <StackPanel>
          <TextBlock x:Name="TileFiles" Text="&#8212;" Style="{StaticResource TileNumber}"/>
          <TextBlock Text="FILES" Style="{StaticResource TileCaption}"/>
        </StackPanel>
      </Border>
      <Border Grid.Column="2" Style="{StaticResource Tile}">
        <StackPanel>
          <TextBlock x:Name="TileShows" Text="&#8212;" Style="{StaticResource TileNumber}"/>
          <TextBlock Text="SHOWS" Style="{StaticResource TileCaption}"/>
        </StackPanel>
      </Border>
      <Border Grid.Column="4" Style="{StaticResource Tile}">
        <StackPanel>
          <TextBlock x:Name="TileMovies" Text="&#8212;" Style="{StaticResource TileNumber}"/>
          <TextBlock Text="MOVIES" Style="{StaticResource TileCaption}"/>
        </StackPanel>
      </Border>
      <Border Grid.Column="6" Style="{StaticResource Tile}">
        <StackPanel>
          <TextBlock x:Name="TileDownloads" Text="&#8212;" Style="{StaticResource TileNumber}"/>
          <TextBlock Text="DOWNLOADING" Style="{StaticResource TileCaption}"/>
        </StackPanel>
      </Border>
    </Grid>

    <!-- ============ BODY ============ -->
    <Grid Grid.Row="2" Margin="16,14,16,16">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="176"/>
        <ColumnDefinition Width="14"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>

      <!-- control rail -->
      <StackPanel x:Name="ControlRail" Grid.Column="0">
        <Button x:Name="BtnStart" Style="{StaticResource PrimaryButton}" Content="Start server"/>
        <Grid Margin="0,8,0,0">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/><ColumnDefinition Width="8"/><ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>
          <Button x:Name="BtnRestart" Grid.Column="0" Style="{StaticResource SecondaryButton}" Content="Restart"/>
          <Button x:Name="BtnStop" Grid.Column="2" Style="{StaticResource DangerButton}" Content="Stop"/>
        </Grid>
        <Button x:Name="BtnOpenApp" Style="{StaticResource SecondaryButton}" Content="Open MediaWatcher" Margin="0,8,0,0"/>
        <Button x:Name="BtnRescan" Style="{StaticResource SecondaryButton}" Content="Rescan library" Margin="0,8,0,0"/>
        <Button x:Name="BtnLibrary" Style="{StaticResource SecondaryButton}" Content="Library folder" Margin="0,8,0,0"/>

        <TextBlock Text="LOG LEVEL" Style="{StaticResource SectionLabel}" Margin="2,18,0,6"/>
        <ComboBox x:Name="CmbLogLevel" Background="{StaticResource Hover}" Foreground="#d4d4d4"
                  BorderBrush="{StaticResource Border}" FontSize="12" Padding="8,5">
          <ComboBoxItem Content="info" IsSelected="True"/>
          <ComboBoxItem Content="debug"/>
          <ComboBoxItem Content="warn"/>
          <ComboBoxItem Content="error"/>
        </ComboBox>
        <TextBlock Text="applies on next start" Foreground="#666666" FontSize="9" Margin="2,5,0,0"/>
      </StackPanel>

      <!-- tabbed pane -->
      <Grid Grid.Column="2">
        <Grid.RowDefinitions>
          <RowDefinition Height="Auto"/>
          <RowDefinition Height="*"/>
        </Grid.RowDefinitions>

        <Grid Grid.Row="0">
          <StackPanel Orientation="Horizontal">
            <Button x:Name="TabLog" Style="{StaticResource TabButton}" Content="Log"/>
            <Button x:Name="TabPreflight" Style="{StaticResource TabButton}">
              <StackPanel Orientation="Horizontal">
                <TextBlock Text="Pre-flight"/>
                <Ellipse x:Name="DotPreflight" Width="6" Height="6" Fill="#ef4444"
                         Margin="6,0,0,0" VerticalAlignment="Center" Visibility="Collapsed"/>
              </StackPanel>
            </Button>
            <Button x:Name="TabDownloads" Style="{StaticResource TabButton}">
              <StackPanel Orientation="Horizontal">
                <TextBlock Text="Downloads"/>
                <Border x:Name="BadgeDownloads" Background="{StaticResource Accent}" CornerRadius="8"
                        Padding="5,1" Margin="6,0,0,0" Visibility="Collapsed">
                  <TextBlock x:Name="BadgeDownloadsText" Text="0" Foreground="White" FontSize="9" FontWeight="Bold"/>
                </Border>
              </StackPanel>
            </Button>
          </StackPanel>

          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
            <CheckBox x:Name="ChkFollow" Content="Follow" IsChecked="True" Foreground="{StaticResource Dim}"
                      FontSize="11" VerticalAlignment="Center"/>
            <Button x:Name="BtnClearLog" Style="{StaticResource SecondaryButton}" Content="Clear"
                    FontSize="11" Padding="10,4" Margin="12,0,0,0"/>
          </StackPanel>

          <Border Height="1" Background="{StaticResource Border}" VerticalAlignment="Bottom"/>
          <Border x:Name="TabUnderline" Height="2" Width="52" HorizontalAlignment="Left"
                  VerticalAlignment="Bottom" Background="{StaticResource AccentGradient}" CornerRadius="2"/>
        </Grid>

        <!-- LOG -->
        <Border x:Name="PaneLog" Grid.Row="1" Margin="0,12,0,0" CornerRadius="8"
                Background="{StaticResource LogBg}" BorderBrush="#1f1f1f" BorderThickness="1">
          <ScrollViewer x:Name="LogScroll" VerticalScrollBarVisibility="Auto" Padding="12,10">
            <ItemsControl x:Name="LogItems">
              <ItemsControl.ItemsPanel>
                <ItemsPanelTemplate><VirtualizingStackPanel/></ItemsPanelTemplate>
              </ItemsControl.ItemsPanel>
            </ItemsControl>
          </ScrollViewer>
        </Border>

        <!-- PRE-FLIGHT -->
        <Border x:Name="PanePreflight" Grid.Row="1" Margin="0,12,0,0" CornerRadius="8"
                Background="{StaticResource Panel}" BorderBrush="{StaticResource Border}"
                BorderThickness="1" Visibility="Collapsed">
          <Grid>
            <Grid.RowDefinitions>
              <RowDefinition Height="*"/><RowDefinition Height="Auto"/>
            </Grid.RowDefinitions>
            <ScrollViewer Grid.Row="0" VerticalScrollBarVisibility="Auto" Padding="14,12">
              <StackPanel x:Name="PreflightItems"/>
            </ScrollViewer>
            <Border Grid.Row="1" BorderBrush="{StaticResource Border}" BorderThickness="0,1,0,0" Padding="14,10">
              <Button x:Name="BtnRecheck" Style="{StaticResource SecondaryButton}"
                      Content="Recheck" HorizontalAlignment="Left" Padding="16,6"/>
            </Border>
          </Grid>
        </Border>

        <!-- DOWNLOADS -->
        <Border x:Name="PaneDownloads" Grid.Row="1" Margin="0,12,0,0" CornerRadius="8"
                Background="{StaticResource Panel}" BorderBrush="{StaticResource Border}"
                BorderThickness="1" Visibility="Collapsed">
          <Grid>
            <TextBlock x:Name="DownloadsEmpty" Text="No active downloads"
                       Foreground="{StaticResource Dim}" FontSize="12"
                       HorizontalAlignment="Center" VerticalAlignment="Center"/>
            <ScrollViewer VerticalScrollBarVisibility="Auto" Padding="14,12">
              <StackPanel x:Name="DownloadItems"/>
            </ScrollViewer>
          </Grid>
        </Border>
      </Grid>
    </Grid>
  </Grid>
</Window>
```

- [ ] **Step 2: Write a minimal loader that just shows the window**

Create `launcher/MediaWatcher.ps1`:

```powershell
<#
  MediaWatcher launcher entry point.
  Run via MediaWatcher.bat, or directly:
    powershell -ExecutionPolicy Bypass -File launcher\MediaWatcher.ps1
#>
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$LauncherRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $LauncherRoot

. (Join-Path $LauncherRoot 'lib\Config.ps1')
. (Join-Path $LauncherRoot 'lib\ServerProcess.ps1')
. (Join-Path $LauncherRoot 'lib\Preflight.ps1')
. (Join-Path $LauncherRoot 'lib\ApiClient.ps1')

# --- load the window -------------------------------------------------------
$xamlPath = Join-Path $LauncherRoot 'MainWindow.xaml'
try {
  [xml]$xaml = Get-Content -LiteralPath $xamlPath -Raw
  $reader = New-Object System.Xml.XmlNodeReader $xaml
  $window = [Windows.Markup.XamlReader]::Load($reader)
} catch {
  [System.Windows.MessageBox]::Show(
    "MediaWatcher launcher could not load its interface.`n`n$($_.Exception.Message)",
    'MediaWatcher', 'OK', 'Error') | Out-Null
  exit 1
}

# Every x:Name in the XAML becomes a variable of the same name.
foreach ($node in $xaml.SelectNodes("//*[@*[local-name()='Name']]")) {
  $name = $node.Attributes['x:Name'].Value
  Set-Variable -Name $name -Value $window.FindName($name) -Scope Script
}

# --- window chrome behaviour ----------------------------------------------
$TitleBar.Add_MouseLeftButtonDown({
  if ($_.ClickCount -eq 2) { return }
  $window.DragMove()
})
$BtnMinimize.Add_Click({ $window.WindowState = 'Minimized' })
$BtnClose.Add_Click({ $window.Close() })

[void]$window.ShowDialog()
```

- [ ] **Step 3: Launch it and confirm the window renders**

Run: `powershell -ExecutionPolicy Bypass -File launcher\MediaWatcher.ps1`

Expected, verified by eye:
- Window opens centred, 1040×700, fully dark
- Custom titlebar with the gradient play mark, "MediaWatcher", a grey "Stopped" pill, and working minimize/close buttons
- Dragging the titlebar moves the window; edges resize; Win11 renders rounded corners
- Four status tiles showing `—`
- Control rail with six buttons and the log-level dropdown; buttons visibly dip when pressed
- Log tab selected, empty dark log panel

Close the window to continue.

- [ ] **Step 4: Confirm the test suite still passes**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: PASS, unchanged from Task 4.

- [ ] **Step 5: Commit**

```bash
git add launcher/MainWindow.xaml launcher/MediaWatcher.ps1
git commit -m "feat(launcher): add WPF window shell with custom chrome"
```

---

## Task 6: Process control, log pane, and the dispatcher tick

**Files:**
- Modify: `launcher/MediaWatcher.ps1`

**Interfaces:**
- Consumes: `Start-MwServer`, `Stop-MwHandle`, `New-MwQueue`, `Get-MwLogLevel`, `Write-MwQueueNotice` (Task 3); `Get-MwConfig` (Task 1)
- Produces: `Add-LogLine`, `Set-ServerStatus`, `Update-ButtonStates`, and the `$script:State` table used by Tasks 7–9

- [ ] **Step 1: Add state, log rendering, and the tick**

Insert into `launcher/MediaWatcher.ps1`, after the chrome handlers and before `ShowDialog`:

```powershell
# --- shared state ----------------------------------------------------------
$script:Config = Get-MwConfig -Root $ProjectRoot
$script:OutputQueue = New-MwQueue
$script:ResultQueue = New-MwQueue
$script:ServerHandle = $null
$script:PollerHandle = $null
$script:FixHandles = @()
$script:LogCount = 0
$script:LastStatus = ''

$script:LogBrushes = @{
  error  = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#ef4444')
  warn   = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#f59e0b')
  info   = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#93c5fd')
  debug  = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#888888')
  plain  = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#e5e5e5')
  notice = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#a855f7')
}

$LOG_CAP = 500

function Add-LogLine {
  param([string]$Text, [string]$Level, [bool]$Animate)

  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.FontFamily = New-Object System.Windows.Media.FontFamily 'Consolas'
  $block.FontSize = 11.5
  $block.TextWrapping = 'Wrap'
  $block.Margin = New-Object System.Windows.Thickness 0, 0, 0, 2
  $block.Foreground = $script:LogBrushes[$Level]

  if ($Animate) {
    $block.Opacity = 0
    $transform = New-Object System.Windows.Media.TranslateTransform
    $transform.X = -10
    $block.RenderTransform = $transform
  }

  [void]$LogItems.Items.Add($block)
  $script:LogCount++

  if ($Animate) { Start-LineEntrance $block }

  while ($LogItems.Items.Count -gt $LOG_CAP) { $LogItems.Items.RemoveAt(0) }

  if ($ChkFollow.IsChecked) { $LogScroll.ScrollToEnd() }
}

function Set-ServerStatus {
  param([string]$Status)   # stopped | starting | running

  if ($Status -eq $script:LastStatus) { return }
  $script:LastStatus = $Status

  switch ($Status) {
    'running'  { $StatusText.Text = 'Running' }
    'starting' { $StatusText.Text = 'Starting' }
    default    { $StatusText.Text = 'Stopped' }
  }
  Start-StatusTransition $Status
}

function Update-ButtonStates {
  $running = ($null -ne $script:ServerHandle) -and
             ($null -ne $script:ServerHandle.Process) -and
             (-not $script:ServerHandle.Process.HasExited)

  $BtnStart.IsEnabled = -not $running
  $BtnStop.IsEnabled = $running
  $BtnRestart.IsEnabled = $running
  $BtnOpenApp.IsEnabled = $running
  $BtnRescan.IsEnabled = $running
  return $running
}

# --- dispatcher tick: the only thing allowed to touch the UI ---------------
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(200)

$timer.Add_Tick({
  # Drain server + fix-command output. Count first so the animation gate can
  # tell a trickle from a burst: >1 line per 200ms tick (~5/sec) appends flat.
  $batch = @()
  while ($script:OutputQueue.Count -gt 0) { $batch += $script:OutputQueue.Dequeue() }
  $animate = ($batch.Count -le 1)

  foreach ($message in $batch) {
    $level = 'plain'
    if ($message.Kind -eq 'notice') { $level = 'notice' }
    elseif ($message.Kind -eq 'stderr') { $level = 'error' }
    else { $level = Get-MwLogLevel $message.Text }

    $text = $message.Text
    if ($message.Kind -eq 'notice') {
      $text = $message.Timestamp.ToString('HH:mm:ss') + '  ' + $message.Text
    }
    Add-LogLine -Text $text -Level $level -Animate $animate
  }

  # Drain API results.
  while ($script:ResultQueue.Count -gt 0) {
    $result = $script:ResultQueue.Dequeue()
    Receive-ApiResult $result
  }

  # Process liveness.
  $running = Update-ButtonStates
  if (-not $running -and $null -ne $script:ServerHandle) {
    $code = $script:ServerHandle.Process.ExitCode
    Write-MwQueueNotice $script:OutputQueue "server exited (code $code)"
    Stop-MwHandle $script:ServerHandle
    $script:ServerHandle = $null
    Set-ServerStatus 'stopped'
  } elseif ($running) {
    $uptime = (Get-Date) - $script:ServerHandle.StartedAt
    $shown = '{0:mm}m {0:ss}s' -f $uptime
    if ($uptime.TotalHours -ge 1) { $shown = '{0:hh}h {0:mm}m' -f $uptime }
    $StatusText.Text = "Running   pid $($script:ServerHandle.Process.Id)   $shown"
  }
})
```

- [ ] **Step 2: Add a placeholder `Receive-ApiResult` so the tick runs before Task 8**

```powershell
function Receive-ApiResult {
  param([hashtable]$Result)
  # Expanded in Task 8. Errors are surfaced now so a dead server is visible.
  if ($Result.Kind -eq 'error') { return }
}
```

- [ ] **Step 3: Wire the control-rail buttons**

```powershell
function Start-Server {
  if ($null -ne $script:ServerHandle) { return }
  $level = $CmbLogLevel.SelectedItem.Content
  Set-ServerStatus 'starting'
  $script:ServerHandle = Start-MwServer -Config $script:Config -LogLevel $level -Queue $script:OutputQueue
  Update-ButtonStates | Out-Null
}

function Stop-Server {
  if ($null -eq $script:ServerHandle) { return }
  Write-MwQueueNotice $script:OutputQueue 'stopping server'
  Stop-MwHandle $script:ServerHandle
  $script:ServerHandle = $null
  Set-ServerStatus 'stopped'
  Update-ButtonStates | Out-Null
}

$BtnStart.Add_Click({ Start-Server })
$BtnStop.Add_Click({ Stop-Server })
$BtnRestart.Add_Click({
  Stop-Server
  Start-Sleep -Milliseconds 900
  Start-Server
})
$BtnOpenApp.Add_Click({ Start-Process ("http://localhost:" + $script:Config.Port) })
$BtnLibrary.Add_Click({
  if (Test-Path -LiteralPath $script:Config.LibraryPath) { Start-Process $script:Config.LibraryPath }
  else { Write-MwQueueNotice $script:OutputQueue "library folder does not exist: $($script:Config.LibraryPath)" }
})
$BtnClearLog.Add_Click({ $LogItems.Items.Clear(); $script:LogCount = 0 })
```

- [ ] **Step 4: Start the timer and clean up on close**

Replace the final `[void]$window.ShowDialog()` with:

```powershell
$window.Add_Loaded({
  Write-MwQueueNotice $script:OutputQueue 'launcher ready - press Start server'
  Set-ServerStatus 'stopped'
  Update-ButtonStates | Out-Null
  $timer.Start()
})

# Closing the window must never orphan the server.
$window.Add_Closing({
  $timer.Stop()
  foreach ($handle in $script:FixHandles) { Stop-MwHandle $handle }
  if ($null -ne $script:PollerHandle) { Stop-ApiPoller $script:PollerHandle }
  if ($null -ne $script:ServerHandle) { Stop-MwHandle $script:ServerHandle }
})

[void]$window.ShowDialog()
```

- [ ] **Step 5: Add temporary no-op animation stubs so Task 6 runs standalone**

These are replaced with real storyboards in Task 9.

```powershell
function Start-LineEntrance { param($Element) $Element.Opacity = 1 }
function Start-StatusTransition { param([string]$Status) }
```

- [ ] **Step 6: Verify end to end**

Run: `powershell -ExecutionPolicy Bypass -File launcher\MediaWatcher.ps1`

Verify by eye:
- "launcher ready" appears in the log in purple with a timestamp
- **Start server** launches the server; real `INFO`/`WARN` lines stream in, coloured
- The pill reads `Running   pid NNNN   0m 05s` and the uptime advances
- **Stop** kills it; "server exited" appears; the pill returns to Stopped
- **Open MediaWatcher** opens `http://localhost:3000` in the browser
- **Library folder** opens Explorer
- **Clear** empties the log
- Closing the window while the server runs leaves no orphan: `netstat -ano | findstr :3000` prints nothing afterwards

- [ ] **Step 7: Commit**

```bash
git add launcher/MediaWatcher.ps1
git commit -m "feat(launcher): wire process control, log pane and dispatcher tick"
```

---

## Task 7: Tabs and the pre-flight pane

**Files:**
- Modify: `launcher/MediaWatcher.ps1`

**Interfaces:**
- Consumes: `Get-PreflightChecks`, `Invoke-PreflightFix` (Task 2); `Add-LogLine` (Task 6)
- Produces: `Select-Tab([string]$Name)`, `Refresh-Preflight()`

- [ ] **Step 1: Add tab switching**

```powershell
$script:CurrentTab = 'log'

function Select-Tab {
  param([string]$Name)   # log | preflight | downloads

  $script:CurrentTab = $Name

  $PaneLog.Visibility = 'Collapsed'
  $PanePreflight.Visibility = 'Collapsed'
  $PaneDownloads.Visibility = 'Collapsed'

  $dim = $script:LogBrushes['debug']
  $bright = $script:LogBrushes['plain']
  $TabLog.Foreground = $dim
  $TabPreflight.Foreground = $dim
  $TabDownloads.Foreground = $dim

  # The underline jumps rather than slides - the slide animation was cut by design.
  switch ($Name) {
    'preflight' {
      $PanePreflight.Visibility = 'Visible'
      $TabPreflight.Foreground = $bright
      $TabUnderline.Width = $TabPreflight.ActualWidth
      $TabUnderline.Margin = New-Object System.Windows.Thickness $TabLog.ActualWidth, 0, 0, 0
      Start-PaneEntrance $PanePreflight
    }
    'downloads' {
      $PaneDownloads.Visibility = 'Visible'
      $TabDownloads.Foreground = $bright
      $TabUnderline.Width = $TabDownloads.ActualWidth
      $TabUnderline.Margin = New-Object System.Windows.Thickness ($TabLog.ActualWidth + $TabPreflight.ActualWidth), 0, 0, 0
      Start-PaneEntrance $PaneDownloads
    }
    default {
      $PaneLog.Visibility = 'Visible'
      $TabLog.Foreground = $bright
      $TabUnderline.Width = $TabLog.ActualWidth
      $TabUnderline.Margin = New-Object System.Windows.Thickness 0, 0, 0, 0
      Start-PaneEntrance $PaneLog
    }
  }

  # Follow/Clear only make sense over the log.
  $visibility = 'Collapsed'
  if ($Name -eq 'log') { $visibility = 'Visible' }
  $ChkFollow.Visibility = $visibility
  $BtnClearLog.Visibility = $visibility

  # Jobs are only polled while their tab is open or something is active.
  if ($null -ne $script:PollerHandle) {
    $wanted = ($Name -eq 'downloads') -or ($script:ActiveJobCount -gt 0)
    Set-ApiPollerJobsWanted $script:PollerHandle $wanted
  }
}

$TabLog.Add_Click({ Select-Tab 'log' })
$TabPreflight.Add_Click({ Select-Tab 'preflight' })
$TabDownloads.Add_Click({ Select-Tab 'downloads' })
```

Add the stub that Task 9 replaces, next to the other animation stubs:

```powershell
function Start-PaneEntrance { param($Element) $Element.Opacity = 1 }
```

And initialise the counter used above, next to the other `$script:` state:

```powershell
$script:ActiveJobCount = 0
```

- [ ] **Step 2: Render the pre-flight list**

```powershell
function New-PreflightRow {
  param([hashtable]$Check)

  $row = New-Object System.Windows.Controls.Grid
  $row.Margin = New-Object System.Windows.Thickness 0, 0, 0, 14
  1..3 | ForEach-Object {
    $column = New-Object System.Windows.Controls.ColumnDefinition
    $row.ColumnDefinitions.Add($column)
  }
  $row.ColumnDefinitions[0].Width = New-Object System.Windows.GridLength 22
  $row.ColumnDefinitions[1].Width = New-Object System.Windows.GridLength 1, 'Star'
  $row.ColumnDefinitions[2].Width = 'Auto'

  $glyph = New-Object System.Windows.Controls.TextBlock
  $glyph.FontWeight = 'Bold'
  $glyph.FontSize = 13
  $glyph.VerticalAlignment = 'Top'
  if ($Check.Ok) {
    $glyph.Text = [char]0x2713
    $glyph.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#10b981')
  } elseif ($Check.Severity -eq 'warn') {
    $glyph.Text = '!'
    $glyph.Foreground = $script:LogBrushes['warn']
  } else {
    $glyph.Text = [char]0x2717
    $glyph.Foreground = $script:LogBrushes['error']
  }
  [System.Windows.Controls.Grid]::SetColumn($glyph, 0)
  [void]$row.Children.Add($glyph)

  $stack = New-Object System.Windows.Controls.StackPanel
  $label = New-Object System.Windows.Controls.TextBlock
  $label.Text = $Check.Label
  $label.FontWeight = 'SemiBold'
  $label.FontSize = 12
  $label.Foreground = $script:LogBrushes['plain']
  [void]$stack.Children.Add($label)

  $detail = New-Object System.Windows.Controls.TextBlock
  $detail.Text = $Check.Detail
  $detail.FontSize = 10.5
  $detail.TextWrapping = 'Wrap'
  $detail.Foreground = $script:LogBrushes['debug']
  [void]$stack.Children.Add($detail)

  [System.Windows.Controls.Grid]::SetColumn($stack, 1)
  [void]$row.Children.Add($stack)

  if (-not $Check.Ok -and $null -ne $Check.Fix) {
    $button = New-Object System.Windows.Controls.Button
    $button.Content = $Check.FixLabel
    $button.Style = $window.FindResource('SecondaryButton')
    $button.FontSize = 11
    $button.Padding = New-Object System.Windows.Thickness 12, 4, 12, 4
    $button.VerticalAlignment = 'Top'
    $button.Tag = $Check
    $button.Add_Click({
      $this.IsEnabled = $false
      $this.Content = 'Working...'
      Invoke-PreflightFix -Check $this.Tag -Queue $script:OutputQueue -Config $script:Config | Out-Null
      Select-Tab 'log'
    })
    [System.Windows.Controls.Grid]::SetColumn($button, 2)
    [void]$row.Children.Add($button)
  }

  return $row
}

function Refresh-Preflight {
  $PreflightItems.Children.Clear()
  $failing = 0

  foreach ($check in (Get-PreflightChecks -Config $script:Config)) {
    if (-not $check.Ok -and $check.Severity -eq 'fail') { $failing++ }
    [void]$PreflightItems.Children.Add((New-PreflightRow -Check $check))
  }

  if ($failing -gt 0) { $DotPreflight.Visibility = 'Visible' }
  else { $DotPreflight.Visibility = 'Collapsed' }
}

$BtnRecheck.Add_Click({
  # Config may have changed - a fix could have created .env.
  $script:Config = Get-MwConfig -Root $ProjectRoot
  Refresh-Preflight
})
```

- [ ] **Step 3: Run pre-flight at startup**

Inside the existing `$window.Add_Loaded` handler, before `$timer.Start()`:

```powershell
  Refresh-Preflight
  Select-Tab 'log'
```

- [ ] **Step 4: Verify**

Run: `powershell -ExecutionPolicy Bypass -File launcher\MediaWatcher.ps1`

Verify by eye:
- Three tabs switch panes; the underline jumps and resizes to the active tab
- Follow/Clear appear only on the Log tab
- The Pre-flight tab lists seven rows. On this machine expect all green except **Port free**, which should report the pid of the running server
- Temporarily rename `.env` to `.env.bak` and press **Recheck**: `.env file` and `API keys` go red, a **Create** button appears, the red dot appears on the tab. Press **Create**, confirm it switches to the Log tab and reports the copy, press **Recheck**, confirm green. Restore your real `.env` afterwards.

- [ ] **Step 5: Commit**

```bash
git add launcher/MediaWatcher.ps1
git commit -m "feat(launcher): add tabbed panes and pre-flight checks with fixes"
```

---

## Task 8: Live status strip and downloads pane

**Files:**
- Modify: `launcher/MediaWatcher.ps1`

**Interfaces:**
- Consumes: `Start-ApiPoller`, `Stop-ApiPoller`, `Request-Rescan`, `Set-ApiPollerJobsWanted`, `ConvertTo-MwLibrarySummary`, `ConvertTo-MwJobSummary`, `Get-MwActiveJobCount` (Task 4)
- Produces: a fully populated `Receive-ApiResult`, `Refresh-Downloads`

- [ ] **Step 1: Replace the placeholder `Receive-ApiResult`**

Replace the stub from Task 6 Step 2 with:

```powershell
$script:LibraryKnown = $false

function Receive-ApiResult {
  param([hashtable]$Result)

  switch ($Result.Kind) {
    'health' {
      # Health only proves reachability; process liveness drives the pill.
    }
    'library' {
      $summary = ConvertTo-MwLibrarySummary $Result.Data
      if ($null -ne $summary) {
        $script:LibraryKnown = $true
        $TileFiles.Text = [string]$summary.Files
        $TileShows.Text = [string]$summary.Shows
        $TileMovies.Text = [string]$summary.Movies
      }
    }
    'jobs' {
      $jobs = ConvertTo-MwJobSummary $Result.Data
      $script:ActiveJobCount = Get-MwActiveJobCount $jobs
      $TileDownloads.Text = [string]$script:ActiveJobCount

      if ($script:ActiveJobCount -gt 0) {
        $BadgeDownloads.Visibility = 'Visible'
        $BadgeDownloadsText.Text = [string]$script:ActiveJobCount
      } else {
        $BadgeDownloads.Visibility = 'Collapsed'
      }
      Refresh-Downloads $jobs
    }
    'notice' {
      Write-MwQueueNotice $script:OutputQueue ([string]$Result.Data)
    }
    'error' {
      # The server is unreachable: show unknown rather than stale numbers.
      if ($script:LibraryKnown) {
        $script:LibraryKnown = $false
        $TileFiles.Text = [char]0x2014
        $TileShows.Text = [char]0x2014
        $TileMovies.Text = [char]0x2014
        $TileDownloads.Text = [char]0x2014
      }
    }
  }
}
```

- [ ] **Step 2: Render the downloads list**

```powershell
function New-DownloadRow {
  param([hashtable]$Job)

  $stack = New-Object System.Windows.Controls.StackPanel
  $stack.Margin = New-Object System.Windows.Thickness 0, 0, 0, 16

  $head = New-Object System.Windows.Controls.DockPanel
  $title = New-Object System.Windows.Controls.TextBlock
  $title.Text = $Job.Title
  $title.FontSize = 12
  $title.Foreground = $script:LogBrushes['plain']
  $title.TextTrimming = 'CharacterEllipsis'
  [void]$head.Children.Add($title)

  $percent = New-Object System.Windows.Controls.TextBlock
  $percent.Text = "$($Job.Percent)%"
  $percent.FontSize = 11
  $percent.Foreground = $script:LogBrushes['debug']
  $percent.HorizontalAlignment = 'Right'
  [System.Windows.Controls.DockPanel]::SetDock($percent, 'Right')
  [void]$head.Children.Add($percent)
  [void]$stack.Children.Add($head)

  $track = New-Object System.Windows.Controls.Border
  $track.Height = 6
  $track.CornerRadius = New-Object System.Windows.CornerRadius 3
  $track.Background = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#1f1f1f')
  $track.Margin = New-Object System.Windows.Thickness 0, 6, 0, 0
  $track.HorizontalAlignment = 'Stretch'

  $fill = New-Object System.Windows.Controls.Border
  $fill.CornerRadius = New-Object System.Windows.CornerRadius 3
  $fill.Background = $window.FindResource('AccentGradient')
  $fill.HorizontalAlignment = 'Left'
  $fill.Tag = $Job.Percent
  $track.Child = $fill
  [void]$stack.Children.Add($track)

  if ($Job.Phase -or $Job.Error) {
    $note = New-Object System.Windows.Controls.TextBlock
    $note.FontSize = 10
    $note.Margin = New-Object System.Windows.Thickness 0, 5, 0, 0
    if ($Job.Error) {
      $note.Text = $Job.Error
      $note.Foreground = $script:LogBrushes['error']
    } else {
      $note.Text = $Job.Phase
      $note.Foreground = $script:LogBrushes['debug']
    }
    [void]$stack.Children.Add($note)
  }

  return @{ Element = $stack; Fill = $fill; Track = $track; Percent = $Job.Percent }
}

function Refresh-Downloads {
  param($Jobs)

  $DownloadItems.Children.Clear()
  $list = @($Jobs)

  if ($list.Count -eq 0) {
    $DownloadsEmpty.Visibility = 'Visible'
    return
  }
  $DownloadsEmpty.Visibility = 'Collapsed'

  foreach ($job in $list) {
    $row = New-DownloadRow -Job $job
    [void]$DownloadItems.Children.Add($row.Element)
    Start-ProgressFill -Fill $row.Fill -Track $row.Track -Percent $row.Percent
  }
}
```

Add the stub Task 9 replaces, with the other animation stubs:

```powershell
function Start-ProgressFill {
  param($Fill, $Track, [int]$Percent)
  $Track.Add_Loaded({ $Fill.Width = $Track.ActualWidth * ($Fill.Tag / 100) })
}
```

- [ ] **Step 3: Start and stop the poller with the server**

In `Start-Server`, after the handle is assigned:

```powershell
  if ($null -eq $script:PollerHandle) {
    $script:PollerHandle = Start-ApiPoller -Config $script:Config -ResultQueue $script:ResultQueue
  }
```

In `Stop-Server`, after `Stop-MwHandle`:

```powershell
  if ($null -ne $script:PollerHandle) {
    Stop-ApiPoller $script:PollerHandle
    $script:PollerHandle = $null
  }
  $script:LibraryKnown = $false
  $TileFiles.Text = [char]0x2014
  $TileShows.Text = [char]0x2014
  $TileMovies.Text = [char]0x2014
  $TileDownloads.Text = [char]0x2014
```

Add the same poller teardown to the process-exit branch of the tick, right after `$script:ServerHandle = $null`.

- [ ] **Step 4: Wire the rescan button**

```powershell
$BtnRescan.Add_Click({
  if ($null -eq $script:PollerHandle) {
    Write-MwQueueNotice $script:OutputQueue 'server is not running'
    return
  }
  Request-Rescan $script:PollerHandle
  Select-Tab 'log'
})
```

- [ ] **Step 5: Verify**

Run: `powershell -ExecutionPolicy Bypass -File launcher\MediaWatcher.ps1`, press **Start server**.

Verify by eye:
- Within ~15s the tiles populate. On this machine expect **91 FILES, 1 SHOWS, 0 MOVIES**
- **Rescan library** switches to the Log tab, logs "rescan requested", and the scanner's own lines appear
- Press **Stop**: tiles revert to `—` rather than holding stale numbers
- The Downloads tab reads "No active downloads" with nothing queued

- [ ] **Step 6: Confirm tests still pass**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add launcher/MediaWatcher.ps1
git commit -m "feat(launcher): add live status tiles and downloads pane"
```

---

## Task 9: Motion

Replaces the three stubs from Tasks 6–8 with real storyboards. All animate `Opacity` and `RenderTransform` only, so nothing falls off the GPU path.

**Files:**
- Modify: `launcher/MediaWatcher.ps1`

**Interfaces:**
- Consumes: `$script:LogBrushes`, the named elements from Task 5
- Produces: `Start-LineEntrance`, `Start-PaneEntrance`, `Start-StatusTransition`, `Start-ProgressFill` (real implementations)

- [ ] **Step 1: Replace the entrance stubs**

Delete `function Start-LineEntrance` and `function Start-PaneEntrance` from Task 6/7 and add:

```powershell
$script:EaseOut = New-Object System.Windows.Media.Animation.QuinticEase
$script:EaseOut.EasingMode = 'EaseOut'

function Start-LineEntrance {
  param($Element)

  $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
  $fade.From = 0; $fade.To = 1
  $fade.Duration = [TimeSpan]::FromMilliseconds(450)
  $fade.EasingFunction = $script:EaseOut

  $slide = New-Object System.Windows.Media.Animation.DoubleAnimation
  $slide.From = -10; $slide.To = 0
  $slide.Duration = [TimeSpan]::FromMilliseconds(450)
  $slide.EasingFunction = $script:EaseOut

  $Element.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
  if ($null -ne $Element.RenderTransform) {
    $Element.RenderTransform.BeginAnimation(
      [System.Windows.Media.TranslateTransform]::XProperty, $slide)
  }
}

function Start-PaneEntrance {
  param($Element)

  $transform = New-Object System.Windows.Media.TranslateTransform
  $transform.Y = 14
  $Element.RenderTransform = $transform
  $Element.Opacity = 0

  $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
  $fade.From = 0; $fade.To = 1
  $fade.Duration = [TimeSpan]::FromMilliseconds(260)
  $fade.EasingFunction = $script:EaseOut

  $rise = New-Object System.Windows.Media.Animation.DoubleAnimation
  $rise.From = 14; $rise.To = 0
  $rise.Duration = [TimeSpan]::FromMilliseconds(260)
  $rise.EasingFunction = $script:EaseOut

  $Element.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
  $transform.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $rise)
}

function Start-StaggeredEntrance {
  param($Elements)

  $delay = 0
  foreach ($element in $Elements) {
    $transform = New-Object System.Windows.Media.TranslateTransform
    $transform.Y = 14
    $element.RenderTransform = $transform
    $element.Opacity = 0

    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
    $fade.From = 0; $fade.To = 1
    $fade.Duration = [TimeSpan]::FromMilliseconds(260)
    $fade.BeginTime = [TimeSpan]::FromMilliseconds($delay)
    $fade.EasingFunction = $script:EaseOut

    $rise = New-Object System.Windows.Media.Animation.DoubleAnimation
    $rise.From = 14; $rise.To = 0
    $rise.Duration = [TimeSpan]::FromMilliseconds(260)
    $rise.BeginTime = [TimeSpan]::FromMilliseconds($delay)
    $rise.EasingFunction = $script:EaseOut

    $element.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
    $transform.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $rise)
    $delay += 130
  }
}
```

- [ ] **Step 2: Replace the status transition stub**

```powershell
$script:StatusPalette = @{
  stopped  = @{ Dot = '#666666'; Fill = '#1f1f1f'; Border = '#2a2a2a'; Text = '#888888' }
  starting = @{ Dot = '#f59e0b'; Fill = '#2b2110'; Border = '#5a4318'; Text = '#f59e0b' }
  running  = @{ Dot = '#10b981'; Fill = '#10251c'; Border = '#1a4d3a'; Text = '#10b981' }
}

function New-ColorAnimation {
  param([string]$ToHex)

  $animation = New-Object System.Windows.Media.Animation.ColorAnimation
  $animation.To = [System.Windows.Media.ColorConverter]::ConvertFromString($ToHex)
  $animation.Duration = [TimeSpan]::FromMilliseconds(400)
  return $animation
}

function Start-StatusTransition {
  param([string]$Status)

  $palette = $script:StatusPalette[$Status]
  if ($null -eq $palette) { $palette = $script:StatusPalette['stopped'] }

  # Brushes from a Style are frozen; clone before animating or WPF throws.
  foreach ($pair in @(
      @{ Target = $StatusDot;   Property = 'Fill';       Hex = $palette.Dot },
      @{ Target = $StatusPill;  Property = 'Background'; Hex = $palette.Fill },
      @{ Target = $StatusPill;  Property = 'BorderBrush';Hex = $palette.Border },
      @{ Target = $StatusText;  Property = 'Foreground'; Hex = $palette.Text })) {

    $current = $pair.Target.($pair.Property)
    if ($null -eq $current -or $current.IsFrozen) {
      $current = New-Object System.Windows.Media.SolidColorBrush $current.Color
      $pair.Target.($pair.Property) = $current
    }
    $current.BeginAnimation(
      [System.Windows.Media.SolidColorBrush]::ColorProperty,
      (New-ColorAnimation $pair.Hex))
  }

  Set-StatusPulse ($Status -eq 'running')
}

function Set-StatusPulse {
  param([bool]$On)

  if (-not $On) {
    $StatusDot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
    $StatusDot.Opacity = 1
    return
  }

  $pulse = New-Object System.Windows.Media.Animation.DoubleAnimation
  $pulse.From = 1; $pulse.To = 0.35
  $pulse.Duration = [TimeSpan]::FromMilliseconds(1600)
  $pulse.AutoReverse = $true
  $pulse.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $StatusDot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $pulse)
}
```

- [ ] **Step 3: Replace the progress stub with an animated fill**

```powershell
function Start-ProgressFill {
  param($Fill, $Track, [int]$Percent)

  $apply = {
    $target = $Track.ActualWidth * ($Percent / 100.0)
    $grow = New-Object System.Windows.Media.Animation.DoubleAnimation
    $grow.To = $target
    $grow.Duration = [TimeSpan]::FromMilliseconds(400)
    $grow.EasingFunction = $script:EaseOut
    $Fill.BeginAnimation([System.Windows.FrameworkElement]::WidthProperty, $grow)

    # Sheen: a translucent white band sweeping across the filled portion.
    if ($Percent -gt 0 -and $Percent -lt 100) {
      $sheen = New-Object System.Windows.Controls.Border
      $sheen.Width = 40
      $sheen.HorizontalAlignment = 'Left'
      $brush = New-Object System.Windows.Media.LinearGradientBrush
      $brush.StartPoint = New-Object System.Windows.Point 0, 0
      $brush.EndPoint = New-Object System.Windows.Point 1, 0
      $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Colors]::Transparent), 0))
      $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Color]::FromArgb(96,255,255,255)), 0.5))
      $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Colors]::Transparent), 1))
      $sheen.Background = $brush

      $transform = New-Object System.Windows.Media.TranslateTransform
      $sheen.RenderTransform = $transform
      $Fill.Child = $sheen

      $sweep = New-Object System.Windows.Media.Animation.DoubleAnimation
      $sweep.From = -40; $sweep.To = [math]::Max($target, 60)
      $sweep.Duration = [TimeSpan]::FromMilliseconds(1500)
      $sweep.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
      $transform.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $sweep)
    }
  }

  if ($Track.ActualWidth -gt 0) { & $apply }
  else { $Track.Add_Loaded($apply) }
}
```

- [ ] **Step 4: Play the staggered entrance on window open**

In `$window.Add_Loaded`, after `Select-Tab 'log'`:

```powershell
  Start-StaggeredEntrance @($StatusStrip, $ControlRail, $PaneLog)
```

- [ ] **Step 5: Verify every motion**

Run: `powershell -ExecutionPolicy Bypass -File launcher\MediaWatcher.ps1`

Verify by eye:
- **Entrance** — on open, the status strip, control rail and log pane fade in and rise in sequence, not together
- **Status pill** — press Start: grey eases to amber, then to green as the server boots. The dot pulses steadily once running. Press Stop: it eases back to grey and the pulse stops
- **Log lines** — with `LOG_LEVEL=info`, individual lines slide in from the left. Now set the dropdown to **debug**, restart, and confirm the burst during a scan appends flat with no stutter
- **Buttons** — hover lightens; pressing visibly dips the button
- **Tabs** — panes fade and rise on switch; the underline jumps

- [ ] **Step 6: Commit**

```bash
git add launcher/MediaWatcher.ps1
git commit -m "feat(launcher): add entrance, status, log and progress animations"
```

---

## Task 10: Entry points and documentation

**Files:**
- Create: `MediaWatcher.bat`
- Modify: `start.bat`
- Modify: `README.md:26-70`

- [ ] **Step 1: Create the double-click entry point**

Create `MediaWatcher.bat`:

```bat
@echo off
REM MediaWatcher - double-click to open the launcher.
start "" powershell -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "%~dp0launcher\MediaWatcher.ps1"
```

- [ ] **Step 2: Rewrite `start.bat`**

Replace the whole file. It keeps the Node check and first-run setup, then hands off:

```bat
@echo off
REM MediaWatcher - first-run setup, then opens the launcher.
title MediaWatcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install Node 20 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   Installing dependencies, this only happens once...
  echo.
  call npm install || (echo. & echo   npm install failed. & pause & exit /b 1)
)

if not exist ".env" (
  echo.
  echo   No .env file yet - creating one from .env.example.
  echo   Add your TMDB and AllDebrid keys in the launcher, then start the server.
  echo.
  copy /y ".env.example" ".env" >nul
)

call "%~dp0MediaWatcher.bat"
```

- [ ] **Step 3: Rewrite the README launcher sections**

In `README.md`, replace everything from `## Quick start` down to (but not including) `### Installing ffmpeg` with:

```markdown
## Quick start

**Double-click `MediaWatcher.bat`.** That opens the launcher — a desktop control
panel for starting and stopping the server, with pre-flight checks, live library
stats and a colour-coded server log.

First time out, run `start.bat` instead: it installs dependencies, creates `.env`
from `.env.example`, and then opens the same launcher.

From a terminal instead:

```bash
npm install
cp .env.example .env      # then open .env and paste your two API keys
npm start                 # server only, logs in the terminal
```

Either way the app itself is at <http://localhost:3000>.

### The launcher

`MediaWatcher.bat` opens a WPF window that:

- starts, stops and restarts the server, showing pid and uptime
- runs pre-flight checks — Node version, `.env`, both API keys, ffmpeg, library
  folder, dependencies, port availability — and offers a one-click fix for each
  failure it can repair itself (`npm install`, creating `.env`, installing ffmpeg
  via winget)
- shows live library counts and any active downloads, read from the server's own API
- streams the server log, colour-coded by level, with follow and clear
- triggers a rescan, opens the app, or opens your library folder
- lets you pick a log level for the next start

It is a single PowerShell script driving a XAML window — no installs beyond what
Windows already ships. Like the app, everything it talks to is on `127.0.0.1`.

The previous WinForms launcher is kept as `MediaWatcher.winforms.ps1` if you need
a fallback.

The first launch creates `library/movies`, `library/shows`, `temp/` and
`db/mediawatcher.db`, then scans whatever is already in the library.
```

- [ ] **Step 4: Verify both entry points**

Run: `cmd /c MediaWatcher.bat`

Expected: the launcher window opens and the console returns immediately (no lingering window).

Run: `cmd /c start.bat`

Expected: the Node check and `.env` check pass silently, then the same launcher opens.

- [ ] **Step 5: Confirm the README has no stale references**

Run: `grep -n "launcher.js\|3999\|npm run launcher" README.md`

Expected: no output. If any line matches, remove it.

- [ ] **Step 6: Run the full suite one last time**

Run: `powershell -ExecutionPolicy Bypass -File launcher\tests\run-tests.ps1`

Expected: PASS, all groups green.

- [ ] **Step 7: Commit**

```bash
git add MediaWatcher.bat start.bat README.md
git commit -m "docs: add MediaWatcher.bat entry point and correct launcher docs"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| File layout | 0, 5, 10 |
| Config module | 1 |
| Preflight module | 2 |
| ServerProcess module | 3 |
| ApiClient module (incl. `Request-Rescan`) | 4, 8 |
| Threading model | 3, 4, 6 |
| Polling cadence | 4 |
| UI structure + palette | 5 |
| Control rail behaviour | 6, 8 |
| Log pane + gating | 5, 6, 9 |
| Motion (4 storyboards) | 9 |
| Error handling | 2, 4, 6, 8 |
| Testing | 0–4 |
| Migration and cleanup | 0, 10 |

**Type consistency** — checked across tasks: the queue message shape `@{ Kind; Text; Tag; Timestamp }` is produced in Task 3 and consumed unchanged in Task 6; the result shape `@{ Kind; Data; Timestamp }` is produced in Task 4 and consumed in Task 8; check hashtable keys `Id, Label, Ok, Severity, Detail, FixLabel, Fix` are produced in Task 2 and consumed in Task 7; `Stop-MwHandle` is named consistently everywhere (not `Stop-MwServer`, which does not exist as a separate function).

**Known ordering dependency** — `Preflight.ps1` (Task 2) references `Write-MwQueueNotice` and `Start-StreamedCommand` from `ServerProcess.ps1` (Task 3) inside Fix scriptblocks. Those scriptblocks are not invoked by Task 2's tests, so Task 2 passes standalone; both files are dot-sourced together at runtime by Task 5's loader.

**Animation stubs** — Tasks 6–8 define no-op versions of `Start-LineEntrance`, `Start-PaneEntrance`, `Start-StatusTransition` and `Start-ProgressFill` so each task is independently runnable; Task 9 deletes and replaces all four. This is called out explicitly in each step that adds one.
