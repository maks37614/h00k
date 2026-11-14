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

function Get-H00kInstallerLanguage {
  # Per-user NSIS installations store their selection under a subkey of HKCU:\Software.
  $values = @(Get-ChildItem -Path 'Registry::HKEY_CURRENT_USER\Software' -ErrorAction Stop |
    ForEach-Object {
      $item = Get-ItemProperty -LiteralPath $_.PSPath -Name 'H00kInstallerLanguage' -ErrorAction SilentlyContinue
      if ($null -ne $item -and $null -ne $item.H00kInstallerLanguage) {
        [string]$item.H00kInstallerLanguage
      }
    })
  if ($values.Count -ne 1) { throw "Expected one stored h00k installer language; got $($values.Count)" }
  return $values[0]
}

# GitHub Windows runner is fresh; intentionally exercise both an opted-out and
# an opted-in install on the same Windows user. No trading terminal is launched.
if (@(DesktopLinks).Count -ne 0) { throw 'Runner already has a h00k desktop shortcut' }
Install-H00k @('/S','/NO_DESKTOP_SHORTCUT')
if ((Get-H00kInstallerLanguage) -ne '1033') {
  throw 'English must be the initial installer language, regardless of OS locale'
}
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

# Verify all four language overrides persist without changing the shortcut preference.
# Interactive Windows users choose the same locales through the first page.
foreach ($testCase in @(
  @{ Code = 'pl'; Lcid = '1045' },
  @{ Code = 'ru'; Lcid = '1049' },
  @{ Code = 'uk'; Lcid = '1058' },
  @{ Code = 'en'; Lcid = '1033' }
)) {
  Install-H00k @('/S', "/H00K_LANG=$($testCase.Code)")
  $actual = Get-H00kInstallerLanguage
  if ($actual -ne $testCase.Lcid) {
    throw "Language $($testCase.Code) did not persist: expected $($testCase.Lcid), got $actual"
  }
  if (@(DesktopLinks).Count -ne 1) {
    throw "Changing installer language affected the desktop shortcut ($($testCase.Code))"
  }
  Write-Host "PASS: installer locale $($testCase.Code) / LCID $actual persisted"
}

# Exercise both deletion choices using the actual installed NSIS uninstaller.
# This runs only on the disposable GitHub-hosted Windows CI user.
function Get-Uninstaller([string]$InstallRoot) {
  $exe = @(Get-ChildItem -LiteralPath $InstallRoot -Filter 'Uninstall*.exe' -File -ErrorAction Stop)
  if ($exe.Count -ne 1) { throw "Expected one registered NSIS uninstaller in $InstallRoot; found $($exe.Count)" }
  return $exe[0].FullName
}
function Uninstall-H00k([string]$Executable, [string[]]$Arguments) {
  $proc = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -Wait
  if ($proc.ExitCode -ne 0) { throw "NSIS uninstall failed: exit $($proc.ExitCode)" }
  Start-Sleep -Milliseconds 600 # NSIS can remove its own exe asynchronously
}
$installRoot = Split-Path -Parent $shortcut.TargetPath
$profilePaths = @(
  (Join-Path $env:APPDATA 'h00k Desktop'),
  (Join-Path $env:APPDATA 'h00k-desktop'),
  (Join-Path $env:LOCALAPPDATA 'h00k Desktop'),
  (Join-Path $env:LOCALAPPDATA 'h00k-desktop')
)
foreach ($profilePath in $profilePaths) {
  New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $profilePath 'h00k-uninstall-smoke-marker.txt') -Value 'ci-owned-marker'
}
$uninstall = Get-Uninstaller $installRoot
Uninstall-H00k $uninstall @('/S')
if (@(DesktopLinks).Count -ne 0) { throw 'Standard uninstall left desktop shortcut' }
if (@(StartMenuLinks).Count -ne 0) { throw 'Standard uninstall left Start menu shortcut' }
if (Test-Path -LiteralPath $shortcut.TargetPath) { throw 'Standard uninstall left executable' }
foreach ($profilePath in $profilePaths) {
  if (-not (Test-Path -LiteralPath (Join-Path $profilePath 'h00k-uninstall-smoke-marker.txt'))) {
    throw "Standard uninstall deleted opted-out user data: $profilePath"
  }
}
Write-Host 'PASS: normal uninstall removes app and shortcuts but preserves user data'

Install-H00k @('/S','/DESKTOP_SHORTCUT')
$installedLinks = @(DesktopLinks)
if ($installedLinks.Count -ne 1) { throw 'Reinstall did not restore desktop shortcut' }
$reinstallShortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($installedLinks[0].FullName)
$uninstall = Get-Uninstaller (Split-Path -Parent $reinstallShortcut.TargetPath)
Uninstall-H00k $uninstall @('/S','/DELETE_H00K_DATA')
if (@(DesktopLinks).Count -ne 0) { throw 'Full uninstall left desktop shortcut' }
if (@(StartMenuLinks).Count -ne 0) { throw 'Full uninstall left Start menu shortcut' }
if (Test-Path -LiteralPath $reinstallShortcut.TargetPath) { throw 'Full uninstall left executable' }
foreach ($profilePath in $profilePaths) {
  if (Test-Path -LiteralPath (Join-Path $profilePath 'h00k-uninstall-smoke-marker.txt')) {
    throw "Full uninstall left local data: $profilePath"
  }
}
Write-Host 'PASS: full uninstall removes app, shortcuts and this user local data'
