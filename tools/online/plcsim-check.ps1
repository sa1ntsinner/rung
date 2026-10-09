# SPDX-License-Identifier: MIT
# Read-only local identity gate. Run in Windows PowerShell 5.1 (.NET Framework).
[CmdletBinding()]
param([string]$Name = 'RungProve', [string]$Address = '192.168.250.1',
      [switch]$Samples,
      [string]$Api = 'C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API\7.0\Siemens.Simatic.Simulation.Runtime.Api.x64.dll')
$ErrorActionPreference = 'Stop'
if ($Name -cne 'RungProve' -or $Address -cne '192.168.250.1') { throw 'Only local RungProve at 192.168.250.1 is accepted.' }
Add-Type -Path $Api
$registered = @([Siemens.Simatic.Simulation.Runtime.SimulationRuntimeManager]::RegisteredInstanceInfo | Where-Object { $_.Name -ceq $Name })
if ($registered.Count -ne 1) { throw 'Expected exactly one registered local RungProve instance.' }
$instance = [Siemens.Simatic.Simulation.Runtime.SimulationRuntimeManager]::CreateInterface($Name)
try {
    $addresses = @($instance.ControllerIPSuite4 | ForEach-Object { [string]$_.IPAddress })
    if ($instance.Name -cne $Name -or $instance.ControllerName -cne 'PLC_1' -or $addresses -notcontains $Address) {
        throw 'Local fixture identity/IP mismatch; abort before any modification.'
    }
    $proof = [ordered]@{ name = $instance.Name; controller = $instance.ControllerName; addresses = $addresses;
        cpu = [string]$instance.CPUType; mode = [string]$instance.OperatingState; storage = $instance.StoragePath;
        certificateVerified = $false; mutationAuthorized = $false }
    if ($Samples) {
        $instance.UpdateTagList() # Refresh API metadata after a fixture restart/download; no PLC writes.
        $proof.values = [ordered]@{
            'Fx_Global.Station.Enabled' = $instance.ReadBool('Fx_Global.Station.Enabled')
            'Fx_Global.Station.Mode' = $instance.ReadInt16('Fx_Global.Station.Mode')
            'Fx_Global.Station.Setpoint' = $instance.ReadFloat('Fx_Global.Station.Setpoint')
            'Fx_Global.Station.Label' = $instance.ReadString('Fx_Global.Station.Label')
            'ProveData_DB.arr[0]' = $instance.ReadInt16('ProveData_DB.arr[0]')
            'ProveTypes_DB.grid[1,2]' = $instance.ReadInt16('ProveTypes_DB.grid[1,2]')
            'ProveMore_DB.pts[1].x' = $instance.ReadInt16('ProveMore_DB.pts[1].x')
            'ProveMath_DB.inner.step' = $instance.ReadInt16('ProveMath_DB.inner.step')
            'ProveMath_DB.inner.count' = $instance.ReadInt16('ProveMath_DB.inner.count')
            'IArea.Fx_Inputs_0' = $instance.ReadBool('Fx_Inputs_0')
            'QArea.Fx_Outputs_0' = $instance.ReadBool('Fx_Outputs_0')
        }
    }
    $proof | ConvertTo-Json -Depth 4
} finally { if ($instance -is [IDisposable]) { $instance.Dispose() } }
