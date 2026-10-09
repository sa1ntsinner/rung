# SPDX-License-Identifier: MIT
# Explicit local-fixture power-cycle acceptance; always restore the initial CPU mode.
[CmdletBinding()]
param([switch]$Fixture)
$ErrorActionPreference = 'Stop'
if (-not $Fixture) { throw 'Pass -Fixture to power-cycle local RungProve.' }
$proof = & "$PSScriptRoot/plcsim-check.ps1" | ConvertFrom-Json
if ($proof.mode -notin @('Run', 'Stop')) { throw 'Expected a running or stopped fixture.' }
$instance = [Siemens.Simatic.Simulation.Runtime.SimulationRuntimeManager]::CreateInterface('RungProve')
try {
    $instance.PowerOff(30000)
    Start-Sleep -Seconds 3
} finally {
    try {
        $result = $instance.PowerOn(30000)
        if ([string]$result -ne 'OK') { throw "Fixture power-on failed: $result" }
        if ($proof.mode -eq 'Run') { $instance.Run(30000) } else { $instance.Stop(30000) }
        [ordered]@{ before = $proof.mode; after = [string]$instance.OperatingState } | ConvertTo-Json
    } finally { if ($instance -is [IDisposable]) { $instance.Dispose() } }
}
