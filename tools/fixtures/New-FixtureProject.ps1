# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
  Generates the rung test fixture project (TIA Portal V20) from the sources in this folder.
.DESCRIPTION
  Creates <FixtureDir>\RungFixture\RungFixture.ap20 with one S7-1500 CPU, folders, SCL/STL/DB/UDT
  blocks, an optional LAD FC (xml\Fx_LadInterlock.xml), tag tables and a deliberately broken block.
  Writes .rung-fixture (the marker that allows rung imports) and fixture-manifest.json.
  Idempotent: an existing target is deleted only if it carries the marker.
  -Runnable builds a program that compiles cleanly and runs (no broken block, an OB1 that counts cycles),
  for downloads to S7-PLCSIM; use it with another -Name, e.g. RungPlcsim.
  Must run in Windows PowerShell 5.1 (.NET Framework), as a member of "Siemens TIA Openness".
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\fixtures\New-FixtureProject.ps1
  powershell -ExecutionPolicy Bypass -File tools\fixtures\New-FixtureProject.ps1 -Name RungPlcsim -Runnable
#>
[CmdletBinding()]
param(
    [string]$FixtureDir = $(if ($env:RUNG_FIXTURE_DIR) { $env:RUNG_FIXTURE_DIR } else { Join-Path $env:USERPROFILE 'rung-fixtures' }),
    [string]$OpennessDir = 'C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V20',
    [string]$CpuOrderNumber = '6ES7 516-3AN02-0AB0',
    [string]$Name = 'RungFixture',
    [switch]$Runnable,
    [switch]$WithUserInterface,
    [switch]$KeepOpen
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') { throw 'Run this script with Windows PowerShell 5.1 (powershell.exe), not pwsh.' }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $FixtureDir $Name
$marker = Join-Path $target '.rung-fixture'

# V21 splits Openness into several assemblies (PublicAPI\V21\net48); earlier versions have one
$assemblies = if (Test-Path (Join-Path $OpennessDir 'Siemens.Engineering.dll')) { @(Join-Path $OpennessDir 'Siemens.Engineering.dll') } else { @(Get-ChildItem $OpennessDir -Filter 'Siemens.Engineering*.dll' | Sort-Object { $_.Name -ne 'Siemens.Engineering.Base.dll' } | ForEach-Object FullName) }
foreach ($a in $assemblies) { try { Add-Type -Path $a } catch [System.Reflection.ReflectionTypeLoadException] { } catch { } }

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

function Import-Source($plc, [string]$path, $group, [string]$option = 'None') {
    $name = 'fx_' + [IO.Path]::GetFileNameWithoutExtension($path) -replace '[^A-Za-z0-9_]', '_'
    # Openness requires UTF-8 with BOM for sources with non-ASCII characters.
    $tmp = Join-Path $env:TEMP ("rung-fx-" + [guid]::NewGuid().ToString('N') + [IO.Path]::GetExtension($path))
    # CRLF: with LF endings TIA adds a blank line at both ends of every SCL body
    $text = [IO.File]::ReadAllText($path) -replace "`r`n", "`n" -replace "`n", "`r`n"
    [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding($true)))
    $src = $plc.ExternalSourceGroup.ExternalSources.CreateFromFile($name, $tmp)
    try {
        $opt = [Siemens.Engineering.SW.ExternalSources.GenerateBlockOption]::$option
        if ($group) { $null = $src.GenerateBlocksFromSource($group, $opt) } else { $null = $src.GenerateBlocksFromSource($opt) }
    } finally { $src.Delete(); Remove-Item $tmp -Force }
}

# --- prepare target -------------------------------------------------------
if (Test-Path $target) {
    if (-not (Test-Path $marker)) { throw "$target exists but is not a rung fixture (no .rung-fixture); refusing to delete it." }
    Remove-Item $target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $FixtureDir | Out-Null

$mode = if ($WithUserInterface) { [Siemens.Engineering.TiaPortalMode]::WithUserInterface } else { [Siemens.Engineering.TiaPortalMode]::WithoutUserInterface }
$sw = [Diagnostics.Stopwatch]::StartNew()
$tia = New-Object Siemens.Engineering.TiaPortal($mode)
$ok = $false
$manifest = [ordered]@{ generatedAt = (Get-Date).ToString('o'); tia = 'V20'; addresses = @(); skipped = @() }
try {
    $project = $tia.Projects.Create((New-Object IO.DirectoryInfo($FixtureDir)), $Name)
    Set-Content -Path $marker -Value 'rung-fixture-v1' -Encoding ASCII -NoNewline
    # S7-PLCSIM only accepts programs compiled with simulation support
    # V21 no longer has this project attribute (PLCSIM takes the program as it is)
    if ($project.PSObject.Properties['IsSimulationDuringBlockCompilationEnabled']) { $project.IsSimulationDuringBlockCompilationEnabled = $true }
    $manifest.runnable = [bool]$Runnable

    # --- CPU: pick the newest firmware of the order number in the installed catalog
    $entries = @($tia.HardwareCatalog.Find($CpuOrderNumber) | Where-Object { $_.TypeIdentifier -like "OrderNumber:$CpuOrderNumber/*" })
    if (-not $entries) { throw "CPU $CpuOrderNumber not found in the hardware catalog." }
    $typeId = ($entries | Sort-Object { [version](($_.TypeIdentifier -split '/V')[-1]) } | Select-Object -Last 1).TypeIdentifier
    $manifest.cpu = $typeId
    $device = $project.Devices.CreateWithItem($typeId, 'PLC_1', 'PLC_1')
    $plc = Find-PlcSoftware $device.DeviceItems
    if (-not $plc) { throw 'No PLC software found on the created device.' }

    # --- security the TIA Portal wizard would set for a lab PLC: no configuration-data password, full access,
    # no secure-only PG/PC communication. Without it the hardware does not compile and nothing can be downloaded.
    $cpuItem = $device.DeviceItems | Where-Object { Get-Service2 $_ ([Siemens.Engineering.HW.Features.SoftwareContainer]) } | Select-Object -First 1
    try {
        $secret = Get-Service2 $cpuItem ([Siemens.Engineering.HW.Features.PlcMasterSecretConfigurator])
        if ($secret -and "$($secret.MasterSecretConfiguration)" -ne 'None') { $secret.Unprotect() }
        $access = Get-Service2 $cpuItem ([Siemens.Engineering.HW.Features.PlcAccessLevelProvider])
        if ($access) { $access.PlcProtectionAccessLevel = [Siemens.Engineering.HW.PlcProtectionAccessLevel]::FullAccess }
        $cpuItem.SetAttribute('CommunicationMode', [uint32]0)
    } catch { $manifest.skipped += "CPU security settings: $($_.Exception.Message)" }

    # --- PROFINET interfaces on unusual addresses: the factory ones (192.168.0.1, 192.168.1.1) are what real PLCs
    # answer at on almost every network, and rung matches a PLC by its project address. The first interface
    # goes on a subnet, as in real projects: TIA takes the target address from it.
    try {
        $subnet = $project.Subnets.Create('System:Subnet.Ethernet', 'PN/IE_1')
        $ethernet = @($cpuItem.DeviceItems | Where-Object { $n = Get-Service2 $_ ([Siemens.Engineering.HW.Features.NetworkInterface]); $n -and "$($n.InterfaceType)" -eq 'Ethernet' })
        $addresses = @('192.168.254.1', '192.168.253.1')
        for ($i = 0; $i -lt $ethernet.Count -and $i -lt $addresses.Count; $i++) {
            $node = (Get-Service2 $ethernet[$i] ([Siemens.Engineering.HW.Features.NetworkInterface])).Nodes[0]
            $node.SetAttribute('Address', $addresses[$i])
            if ($i -eq 0) { $node.ConnectToSubnet($subnet) }
        }
        $manifest.ip = $addresses[0..([Math]::Min($ethernet.Count, $addresses.Count) - 1)]
    } catch { $manifest.skipped += "network: $($_.Exception.Message)" }

    # --- folders
    $drives = $plc.BlockGroup.Groups.Create('10_Drives')
    $motors = $drives.Groups.Create('Motors')
    $valves = $plc.BlockGroup.Groups.Create('20_Valves')

    # --- types and data first (dependencies), then code
    Import-Source $plc (Join-Path $here 'scl\Fx_Types.udt') $null
    $manifest.addresses += 'plc:PLC_1/types/Fx_Types'
    Import-Source $plc (Join-Path $here 'scl\Fx_Global.db') $null
    $manifest.addresses += 'plc:PLC_1/blocks/Fx_Global'
    Import-Source $plc (Join-Path $here 'scl\Fx_Motor.scl') $motors
    $manifest.addresses += 'plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor'
    Import-Source $plc (Join-Path $here 'scl\Fx_Counter.scl') $drives
    $manifest.addresses += 'plc:PLC_1/blocks/10_Drives/Fx_Counter'
    Import-Source $plc (Join-Path $here 'scl\Fx_Valve.scl') $valves
    $manifest.addresses += 'plc:PLC_1/blocks/20_Valves/Fx_Valve'
    Import-Source $plc (Join-Path $here 'scl\Fx_Stl.awl') $null
    $manifest.addresses += 'plc:PLC_1/blocks/Fx_Stl'
    if ($Runnable) {
        Import-Source $plc (Join-Path $here 'scl\Fx_CounterDB.db') $null
        $manifest.addresses += 'plc:PLC_1/blocks/Fx_CounterDB'
        Import-Source $plc (Join-Path $here 'scl\Fx_Main.scl') $null
    } else {
        Import-Source $plc (Join-Path $here 'scl\Fx_Broken.scl') $null 'KeepOnError'
        $manifest.addresses += 'plc:PLC_1/blocks/Fx_Broken'
    }

    # --- know-how protected block (fixture-only password)
    Import-Source $plc (Join-Path $here 'scl\Fx_Secret.scl') $null
    try {
        $secret = $plc.BlockGroup.Blocks.Find('Fx_Secret')
        # no ConvertTo-SecureString: its module fails to load when PowerShell 7 started this 5.1 process (PSModulePath)
        $pw = New-Object Security.SecureString
        foreach ($c in 'Rung-Fixture-0nly!'.ToCharArray()) { $pw.AppendChar($c) }
        (Get-Service2 $secret ([Siemens.Engineering.SW.Blocks.PlcBlockProtectionProvider])).Protect($pw)
        $manifest.addresses += 'plc:PLC_1/blocks/Fx_Secret'
        $manifest.protected = 'Fx_Secret'
    } catch { $manifest.skipped += "know-how protection: $($_.Exception.Message)" }

    # --- a block whose name needs file-name escaping (first name TIA accepts wins).
    # V20 Openness cannot create SCL blocks directly (CreateFB is ProDiag-only), so go through a source.
    $escaped = $null
    $escapeErrors = @()
    foreach ($n in @('Motor/Valve 1', 'Motor:Valve 1', 'Motor.Valve 1.', 'Motor*Valve 1')) {
        $tmpSrc = Join-Path $env:TEMP 'Fx_Escaped.scl'
        [IO.File]::WriteAllText($tmpSrc, "FUNCTION `"$n`" : Void`r`nVERSION : 0.1`r`nBEGIN`r`n   ;`r`nEND_FUNCTION`r`n")
        try {
            Import-Source $plc $tmpSrc $null
            $escaped = $n; break
        } catch { $escapeErrors += "$n -> $($_.Exception.Message -replace '\s+', ' ')" }
        finally { Remove-Item $tmpSrc -ErrorAction SilentlyContinue }
    }
    if ($escapeErrors) { $manifest.escapeRejected = $escapeErrors }
    if ($escaped) { $manifest.escapedName = $escaped } else { $manifest.skipped += 'escaped-name block (no candidate accepted)' }

    # --- LAD FC from owned SimaticML
    $lad = Join-Path $here 'xml\Fx_LadInterlock.xml'
    try {
        $null = $valves.Blocks.Import((New-Object IO.FileInfo($lad)), [Siemens.Engineering.ImportOptions]::Override)
        $manifest.addresses += 'plc:PLC_1/blocks/20_Valves/Fx_LadInterlock'
    } catch { $manifest.skipped += "LAD import: $($_.Exception.Message)" }

    # --- tag tables
    foreach ($t in @(@{ n = 'Fx_Inputs'; p = 'I' }, @{ n = 'Fx_Outputs'; p = 'Q' })) {
        $table = $plc.TagTableGroup.TagTables.Create($t.n)
        for ($i = 0; $i -lt 10; $i++) { $null = $table.Tags.Create("$($t.n)_$i", 'Bool', "%$($t.p)$([math]::Floor($i / 8)).$($i % 8)") }
        $manifest.addresses += "plc:PLC_1/tags/$($t.n)"
    }

    # --- a watch table (its entries come in through rung, as XML)
    try {
        $null = $plc.WatchAndForceTableGroup.WatchTables.Create('Fx_Watch')
        $manifest.addresses += 'plc:PLC_1/watch/Fx_Watch'
    } catch { $manifest.skipped += "watch table: $($_.Exception.Message)" }

    # --- software unit with a namespaced block (V20 support varies; best effort)
    try {
        $units = Get-Service2 $plc ([Siemens.Engineering.SW.Units.PlcUnitProvider])
        if ($units) { $null = $units.UnitGroup.Units.Create('Fx_Unit'); $manifest.unit = 'Fx_Unit' } else { $manifest.skipped += 'software units not available' }
    } catch { $manifest.skipped += "software unit: $($_.Exception.Message)" }

    # --- compile (Fx_Broken is expected to fail) and save
    $compiler = Get-Service2 $plc ([Siemens.Engineering.Compiler.ICompilable])
    $result = $compiler.Compile()
    $manifest.compile = @{ state = "$($result.State)"; errors = $result.ErrorCount; warnings = $result.WarningCount }
    $project.Save()
    $manifest.projectPath = $project.Path.FullName
    $manifest.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $target 'fixture-manifest.json') -Encoding UTF8
    if (-not $KeepOpen) { $project.Close() }
    $ok = $true
    Write-Output "FIXTURE OK $($manifest.projectPath) objects=$($manifest.addresses.Count) compileErrors=$($result.ErrorCount) skipped=$($manifest.skipped.Count) in $($manifest.seconds)s"
}
finally {
    # a failed run never leaves a half-built project open in TIA Portal
    if (-not $KeepOpen -or -not $ok) { $tia.Dispose() }
}
