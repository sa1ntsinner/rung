# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
  Keeps the rung fixture project open in a headless TIA Portal (no window) for the live test suites.
.DESCRIPTION
  Starts TIA Portal WithoutUserInterface, opens <FixtureDir>\RungFixture\RungFixture.ap20 and waits.
  Bridges, the spike and the integration tests then attach to it like to a normal TIA Portal, without
  any window on screen. Stop it with -Stop (writes a stop file; the host closes the project and exits).
  Must run in Windows PowerShell 5.1, as a member of "Siemens TIA Openness".
.EXAMPLE
  Start-Process powershell -WindowStyle Hidden -ArgumentList '-ExecutionPolicy Bypass -File tools\fixtures\Start-FixtureHost.ps1'
  powershell -ExecutionPolicy Bypass -File tools\fixtures\Start-FixtureHost.ps1 -Stop
#>
[CmdletBinding()]
param(
    [string]$FixtureDir = $(if ($env:RUNG_FIXTURE_DIR) { $env:RUNG_FIXTURE_DIR } else { Join-Path $env:USERPROFILE 'rung-fixtures' }),
    [string]$OpennessDir = 'C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V20',
    [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$target = Join-Path $FixtureDir 'RungFixture'
$stopFile = Join-Path $target '.rung-host.stop'
$readyFile = Join-Path $target '.rung-host.ready'

if ($Stop) {
    if (-not (Test-Path $readyFile)) { Write-Output 'no fixture host running'; return }
    Set-Content -Path $stopFile -Value 'stop' -Encoding ASCII
    for ($i = 0; $i -lt 120 -and (Test-Path $readyFile); $i++) { Start-Sleep -Milliseconds 500 }
    Write-Output $(if (Test-Path $readyFile) { 'fixture host did not stop within 60 s' } else { 'fixture host stopped' })
    return
}
if ($PSVersionTable.PSEdition -eq 'Core') { throw 'Run this script with Windows PowerShell 5.1 (powershell.exe), not pwsh.' }
if (-not (Test-Path (Join-Path $target '.rung-fixture'))) { throw "$target is not a generated rung fixture; run New-FixtureProject.ps1 first." }
try { Add-Type -Path (Join-Path $OpennessDir 'Siemens.Engineering.dll') } catch [System.Reflection.ReflectionTypeLoadException] { }

Remove-Item $stopFile, $readyFile -ErrorAction SilentlyContinue
$tia = New-Object Siemens.Engineering.TiaPortal([Siemens.Engineering.TiaPortalMode]::WithoutUserInterface)
try {
    $project = $tia.Projects.Open((New-Object IO.FileInfo((Join-Path $target 'RungFixture.ap20'))))
    $proc = [Siemens.Engineering.TiaPortal]::GetProcesses() | Where-Object { $_.Mode -eq 'WithoutUserInterface' -and $_.ProjectPath -and $_.ProjectPath.FullName -eq $project.Path.FullName } | Select-Object -First 1
    Set-Content -Path $readyFile -Value "$($proc.Id)" -Encoding ASCII
    Write-Output "FIXTURE HOST READY tia-pid=$($proc.Id) $($project.Path.FullName)"
    while (-not (Test-Path $stopFile)) { Start-Sleep -Seconds 1 }
    $project.Close()
}
finally {
    $tia.Dispose()
    Remove-Item $stopFile, $readyFile -ErrorAction SilentlyContinue
}
