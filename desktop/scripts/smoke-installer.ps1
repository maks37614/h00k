param(
  [Parameter(Mandatory = $true)]
  [string]$Installer
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Installer = (Resolve-Path $Installer).Path
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
  throw "Installer not found: $Installer"
}
$desktopPath = [Environment]::GetFolderPath('DesktopDirectory')
$startMenuPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

function DesktopLinks {
  @(Get-ChildItem -LiteralPath $desktopPath -Filter '*h00k*.lnk' -File -ErrorAction SilentlyContinue)
}
function StartMenuLinks {
  @(Get-ChildItem -LiteralPath $startMenuPath -Filter '*h00k*.lnk' -File -Recurse -ErrorAction SilentlyContinue)
}
function Install-H00k([string[]]$Arguments) {
  Write-Host ("Smoke install: " + ($Arguments -join ' '))
  $process = Start-Process -FilePath $Installer -ArgumentList $Arguments -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "NSIS failed with exit code $($process.ExitCode)" }
}

# GitHub Windows runner is fresh; intentionally exercise both an opted-out and
# an opted-in install on the same Windows user. No trading terminal is launched.
if (@(DesktopLinks).Count -ne 0) { throw 'Runner already has a h00k desktop shortcut' }
Install-H00k @('/S','/NO_DESKTOP_SHORTCUT')
if (@(DesktopLinks).Count -ne 0) { throw 'Opt-out installation incorrectly created a desktop shortcut' }
$startLinks = @(StartMenuLinks)
if ($startLinks.Count -lt 1) { throw 'Installer did not create a Start Menu shortcut' }
Write-Host 'Opt-out: desktop shortcut absent, Start Menu shortcut present'

# Verify that silent upgrading without explicitly opting in respects prior choice.
Install-H00k @('/S')
if (@(DesktopLinks).Count -ne 0) { throw 'Silent upgrade ignored saved opt-out preference' }
Write-Host 'Opt-out choice preserved through a silent upgrade'

# Explicitly turn the shortcut back on; ensure Windows sees the icon-bearing exe.
Install-H00k @('/S','/DESKTOP_SHORTCUT')
$links = @(DesktopLinks)
if ($links.Count -ne 1) { throw "Expected exactly one desktop shortcut, got $($links.Count)" }
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($links[0].FullName)
if (-not (Test-Path -LiteralPath $shortcut.TargetPath -PathType Leaf)) {
  throw "Desktop shortcut target not found: $($shortcut.TargetPath)"
}
Add-Type -AssemblyName System.Drawing
$ico = [System.Drawing.Icon]::ExtractAssociatedIcon($shortcut.TargetPath)
if ($null -eq $ico) { throw 'Installed executable has no Windows icon' }
try {
  if ($ico.Width -lt 16 -or $ico.Height -lt 16) { throw 'Icon too small' }
  Write-Host "PASS: $($links[0].Name) -> $($shortcut.TargetPath) with $($ico.Width)x$($ico.Height) icon"
} finally {
  $ico.Dispose()
}
