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
  [xml]$xamlDoc = Get-Content -LiteralPath $xamlPath -Raw
  $reader = New-Object System.Xml.XmlNodeReader $xamlDoc
  $window = [Windows.Markup.XamlReader]::Load($reader)
} catch {
  [System.Windows.MessageBox]::Show(
    "MediaWatcher launcher could not load its interface.`n`n$($_.Exception.Message)",
    'MediaWatcher', 'OK', 'Error') | Out-Null
  exit 1
}

# Bind every x:Name to a script variable of the same name. Names declared inside
# ControlTemplates are not reachable from the window, so FindName returns null
# for them and they are skipped rather than shadowing anything.
$XAML_NS = 'http://schemas.microsoft.com/winfx/2006/xaml'
foreach ($node in $xamlDoc.SelectNodes("//*[@*[local-name()='Name']]")) {
  $attribute = $node.Attributes.GetNamedItem('Name', $XAML_NS)
  if ($null -eq $attribute) { continue }
  $element = $window.FindName($attribute.Value)
  if ($null -ne $element) { Set-Variable -Name $attribute.Value -Value $element -Scope Script }
}

# --- window chrome behaviour ----------------------------------------------
$TitleBar.Add_MouseLeftButtonDown({
  if ($_.ClickCount -eq 2) { return }
  $window.DragMove()
})
$BtnMinimize.Add_Click({ $window.WindowState = 'Minimized' })
$BtnClose.Add_Click({ $window.Close() })

[void]$window.ShowDialog()
