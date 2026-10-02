# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
  Makes a small TIA Portal V20 project to try rung on: one conveyor with a motor, a part counter and an analog speed.
.DESCRIPTION
  Creates <Dir>\RungDemo\RungDemo.ap20: an S7-1500 CPU, a PLC data type, a global DB, FC_Scale, FB_Motor,
  FB_Conveyor (in the folder Line), its instance DB, OB1 "Main", the tag table IO and the I/O modules behind it,
  compiled and saved. Then, when rung is on PATH, <Dir>\workspace: bound to the project, pulled, with the tests from
  tools\demo\tests and a first git commit. An existing project is replaced only when this script made it (.rung-demo),
  an existing workspace only when it is bound to that project.
  Must run in Windows PowerShell 5.1 (.NET Framework), as a member of "Siemens TIA Openness".
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\demo\New-DemoProject.ps1
#>
[CmdletBinding()]
param(
    [string]$Dir = (Join-Path $env:USERPROFILE 'rung-demo'),
    [string]$OpennessDir = 'C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V20',
    [string]$CpuOrderNumber = '6ES7 516-3AN02-0AB0',
    [string]$Name = 'RungDemo',
    # only the TIA Portal project, no rung workspace next to it
    [switch]$NoWorkspace
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') { throw 'Run this script with Windows PowerShell 5.1 (powershell.exe), not pwsh.' }

$src = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'src'
$target = Join-Path $Dir $Name
$marker = Join-Path $target '.rung-demo'

try { Add-Type -Path (Join-Path $OpennessDir 'Siemens.Engineering.dll') } catch [System.Reflection.ReflectionTypeLoadException] { }

function Get-Service2([object]$provider, [type]$serviceType) {
    $m = [Siemens.Engineering.IEngineeringServiceProvider].GetMethod('GetService').MakeGenericMethod($serviceType)
    return $m.Invoke($provider, $null)
}

function Find-PlcSoftware($items) {
    foreach ($item in $items) {
        $sc = Get-Service2 $item ([Siemens.Engineering.HW.Features.SoftwareContainer])
        if ($sc -and $sc.Software -is [Siemens.Engineering.SW.PlcSoftware]) { return $sc.Software }
        $nested = Find-PlcSoftware $item.DeviceItems
        if ($nested) { return $nested }
    }
    return $null
}

function Import-Source($plc, [string]$file, $group) {
    $path = Join-Path $src $file
    $tmp = Join-Path $env:TEMP ("rung-demo-" + [guid]::NewGuid().ToString('N') + [IO.Path]::GetExtension($path))
    # CRLF and a BOM, as TIA Portal wants its external sources
    $text = [IO.File]::ReadAllText($path) -replace "`r`n", "`n" -replace "`n", "`r`n"
    [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding($true)))
    $source = $plc.ExternalSourceGroup.ExternalSources.CreateFromFile('demo_' + ([IO.Path]::GetFileNameWithoutExtension($file) -replace '[^A-Za-z0-9_]', '_'), $tmp)
    try {
        if ($group) { $null = $source.GenerateBlocksFromSource($group, [Siemens.Engineering.SW.ExternalSources.GenerateBlockOption]::None) }
        else { $null = $source.GenerateBlocksFromSource([Siemens.Engineering.SW.ExternalSources.GenerateBlockOption]::None) }
    } finally { $source.Delete(); Remove-Item $tmp -Force }
}

if (Test-Path $target) {
    if (-not (Test-Path $marker)) { throw "$target exists and was not made by this script (no .rung-demo); refusing to replace it." }
    Remove-Item $target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

$sw = [Diagnostics.Stopwatch]::StartNew()
$tia = New-Object Siemens.Engineering.TiaPortal([Siemens.Engineering.TiaPortalMode]::WithoutUserInterface)
try {
    $project = $tia.Projects.Create((New-Object IO.DirectoryInfo($Dir)), $Name)
    Set-Content -Path $marker -Value 'rung-demo-v1' -Encoding ASCII -NoNewline
    # S7-PLCSIM runs only programs compiled with simulation support
    $project.IsSimulationDuringBlockCompilationEnabled = $true

    $entries = @($tia.HardwareCatalog.Find($CpuOrderNumber) | Where-Object { $_.TypeIdentifier -like "OrderNumber:$CpuOrderNumber/*" })
    if (-not $entries) { throw "CPU $CpuOrderNumber not found in the hardware catalog." }
    $typeId = ($entries | Sort-Object { [version](($_.TypeIdentifier -split '/V')[-1]) } | Select-Object -Last 1).TypeIdentifier
    $device = $project.Devices.CreateWithItem($typeId, 'PLC_1', 'PLC_1')
    $plc = Find-PlcSoftware $device.DeviceItems
    if (-not $plc) { throw 'No PLC software found on the created device.' }

    # a lab PLC's security settings (no configuration password, full access), so the hardware compiles and PLCSIM takes it
    $cpuItem = $device.DeviceItems | Where-Object { Get-Service2 $_ ([Siemens.Engineering.HW.Features.SoftwareContainer]) } | Select-Object -First 1
    try {
        $secret = Get-Service2 $cpuItem ([Siemens.Engineering.HW.Features.PlcMasterSecretConfigurator])
        if ($secret -and "$($secret.MasterSecretConfiguration)" -ne 'None') { $secret.Unprotect() }
        $access = Get-Service2 $cpuItem ([Siemens.Engineering.HW.Features.PlcAccessLevelProvider])
        if ($access) { $access.PlcProtectionAccessLevel = [Siemens.Engineering.HW.PlcProtectionAccessLevel]::FullAccess }
        $cpuItem.SetAttribute('CommunicationMode', [uint32]0)
    } catch { Write-Warning "CPU security settings: $($_.Exception.Message)" }
    # no factory address on any port (192.168.0.1 and 192.168.1.1 answer on almost every plant network): X1 on
    # 192.168.250.1, X2 on 192.168.251.1, so rung connect never finds a real PLC for this demo
    try {
        $subnet = $project.Subnets.Create('System:Subnet.Ethernet', 'PN/IE_1')
        $ethernet = @($cpuItem.DeviceItems | Where-Object { $n = Get-Service2 $_ ([Siemens.Engineering.HW.Features.NetworkInterface]); $n -and "$($n.InterfaceType)" -eq 'Ethernet' })
        for ($k = 0; $k -lt $ethernet.Count; $k++) {
            $node = (Get-Service2 $ethernet[$k] ([Siemens.Engineering.HW.Features.NetworkInterface])).Nodes[0]
            $node.SetAttribute('Address', "192.168.$(250 + $k).1")
            if ($k -eq 0) { $node.ConnectToSubnet($subnet) }
        }
    } catch { Write-Warning "network: $($_.Exception.Message)" }
    # the I/O modules behind the tags, so the program compiles without "inputs or outputs ... do not exist"
    $slots = @($device.DeviceItems) + @($device.DeviceItems | ForEach-Object { $_.DeviceItems })
    foreach ($m in @(@('6ES7 521-1BL00-0AB0', 'DI_1', 2, -1), @('6ES7 522-1BL01-0AB0', 'DQ_1', 3, -1), @('6ES7 531-7KF00-0AB0', 'AI_1', 4, 64))) {
        try {
            $found = @($tia.HardwareCatalog.Find($m[0]) | Where-Object { $_.TypeIdentifier -like "OrderNumber:$($m[0])/*" })
            if (-not $found) { throw "$($m[0]) is not in the hardware catalog" }
            $id = ($found | Sort-Object { [version](($_.TypeIdentifier -split '/V')[-1]) } | Select-Object -Last 1).TypeIdentifier
            $rack = $slots | Where-Object { $_.CanPlugNew($id, $m[1], $m[2]) } | Select-Object -First 1
            if (-not $rack) { throw "slot $($m[2]) does not take it" }
            $module = $rack.PlugNew($id, $m[1], $m[2])
            # the analog input at %IW64, where S7-1500 projects usually start their analog values
            if ($m[3] -ge 0) {
                $address = @(@($module) + @($module.DeviceItems) | ForEach-Object { $_.Addresses } | Where-Object { "$($_.IoType)" -eq 'Input' })[0]
                $address.StartAddress = $m[3]
            }
        } catch { Write-Warning "$($m[1]) ($($m[0])): $($_.Exception.Message)" }
    }

    # the I/O first: Main reads and writes them
    $io = $plc.TagTableGroup.TagTables.Create('IO')
    foreach ($t in @(
            @('Start_PB', 'Bool', '%I0.0', 'start button'), @('Stop_PB', 'Bool', '%I0.1', 'stop button, NC'),
            @('Reset_PB', 'Bool', '%I0.2', 'fault reset button'), @('EStop_OK', 'Bool', '%I0.3', 'safety relay OK'),
            @('Motor_FB', 'Bool', '%I0.4', 'contactor feedback'), @('Part_Sensor', 'Bool', '%I0.5', 'light barrier, end of the belt'),
            @('Speed_AI', 'Int', '%IW64', 'drive speed, 0..27648'),
            @('Motor_Run', 'Bool', '%Q0.0', 'conveyor contactor'), @('Fault_Lamp', 'Bool', '%Q0.1', 'fault lamp'))) {
        $tag = $io.Tags.Create($t[0], $t[1], $t[2])
        try { $tag.Comment.Items[0].Text = $t[3] } catch { }
    }

    # types and data first, then the code that uses them
    Import-Source $plc 'UDT_MotorCmd.udt' $null
    Import-Source $plc 'Line_DB.db' $null
    Import-Source $plc 'FC_Scale.scl' $null
    $line = $plc.BlockGroup.Groups.Create('Line')
    Import-Source $plc 'FB_Motor.scl' $line
    Import-Source $plc 'FB_Conveyor.scl' $line
    Import-Source $plc 'Conveyor_DB.db' $line
    Import-Source $plc 'Main.scl' $null

    $result = (Get-Service2 $plc ([Siemens.Engineering.Compiler.ICompilable])).Compile()
    # what TIA Portal would show in its compile window, leaves only
    function Show-Messages($messages, [string]$at) {
        foreach ($m in $messages) {
            if ($m.Messages.Count) { Show-Messages $m.Messages "$at/$($m.Path)" }
            elseif ("$($m.State)" -ne 'Success' -and $m.Description -notlike 'Compiling finished*') { Write-Warning "$at/$($m.Path): $($m.Description)" }
        }
    }
    Show-Messages $result.Messages ''
    $project.Save()
    $path = $project.Path.FullName
    $project.Close()
    Write-Output "DEMO OK $path compile=$($result.State) errors=$($result.ErrorCount) warnings=$($result.WarningCount) in $([math]::Round($sw.Elapsed.TotalSeconds, 1))s"
}
finally { $tia.Dispose() }

# a rung workspace next to it, pulled, with the tests and a first git commit to compare against
if ($NoWorkspace) { return }
if (-not (Get-Command rung -ErrorAction SilentlyContinue)) { Write-Warning 'rung is not on PATH: make the workspace with rung init and rung pull (docs/quickstart.md).'; return }
$ws = Join-Path $Dir 'workspace'
if (Test-Path $ws) {
    $toml = Join-Path $ws 'rung.toml'
    if (-not ((Test-Path $toml) -and (Get-Content $toml -Raw).Contains($path.Replace('\', '\\')))) { throw "$ws exists and is not this demo's workspace; refusing to replace it." }
    Remove-Item $ws -Recurse -Force
}
New-Item -ItemType Directory -Path $ws | Out-Null
Push-Location $ws
try {
    & rung init --project $path | Out-Null
    if ($LASTEXITCODE) { throw "rung init failed ($LASTEXITCODE)" }
    & rung pull | Out-Null
    if ($LASTEXITCODE) { throw "rung pull failed ($LASTEXITCODE)" }
    Copy-Item -Recurse (Join-Path $PSScriptRoot 'tests') (Join-Path $ws 'tests')
    if (Get-Command git -ErrorAction SilentlyContinue) {
        git init -q
        git add -A
        git -c user.name='rung demo' -c user.email=demo@localhost commit -q -m 'the demo project as pulled from TIA Portal'
    }
    Write-Output "WORKSPACE OK $ws"
} finally { Pop-Location }
