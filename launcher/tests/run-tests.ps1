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
