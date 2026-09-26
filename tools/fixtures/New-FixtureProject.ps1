# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
  Generates the rung test fixture project (TIA Portal V20) from the sources in this folder.
.DESCRIPTION
  Creates <FixtureDir>\RungFixture\RungFixture.ap20 with one S7-1500 CPU, folders, SCL/STL/DB/UDT
  blocks, an optional LAD FC (xml\Fx_LadInterlock.xml), tag tables and a deliberately broken block.
  Writes .rung-fixture (the marker that allows rung imports) and fixture-manifest.json.
  Idempotent: an existing target is deleted only if it carries the marker.
  Must run in Windows PowerShell 5.1 (.NET Framework), as a member of "Siemens TIA Openness".
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\fixtures\New-FixtureProject.ps1
#>
[CmdletBinding()]
param(
    [string]$FixtureDir = $(if ($env:RUNG_FIXTURE_DIR) { $env:RUNG_FIXTURE_DIR } else { Join-Path $env:USERPROFILE 'rung-fixtures' }),
    [string]$OpennessDir = 'C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V20',
    [string]$CpuOrderNumber = '6ES7 516-3AN02-0AB0',
    [switch]$WithUserInterface,
    [switch]$KeepOpen
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') { throw 'Run this script with Windows PowerShell 5.1 (powershell.exe), not pwsh.' }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $FixtureDir 'RungFixture'
$marker = Join-Path $target '.rung-fixture'

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

function Import-Source($plc, [string]$path, $group, [string]$option = 'None') {
    $name = 'fx_' + [IO.Path]::GetFileNameWithoutExtension($path) -replace '[^A-Za-z0-9_]', '_'
    # Openness requires UTF-8 with BOM for sources with non-ASCII characters.
    $tmp = Join-Path $env:TEMP ("rung-fx-" + [guid]::NewGuid().ToString('N') + [IO.Path]::GetExtension($path))
    # CRLF: with LF endings TIA adds a blank line at both ends of every SCL body (docs/facts/openness-v20.md, F20)
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
    $project = $tia.Projects.Create((New-Object IO.DirectoryInfo($FixtureDir)), 'RungFixture')
    Set-Content -Path $marker -Value 'rung-fixture-v1' -Encoding ASCII -NoNewline

    # --- CPU: pick the newest firmware of the order number in the installed catalog
    $entries = @($tia.HardwareCatalog.Find($CpuOrderNumber) | Where-Object { $_.TypeIdentifier -like "OrderNumber:$CpuOrderNumber/*" })
    if (-not $entries) { throw "CPU $CpuOrderNumber not found in the hardware catalog." }
    $typeId = ($entries | Sort-Object { [version](($_.TypeIdentifier -split '/V')[-1]) } | Select-Object -Last 1).TypeIdentifier
    $manifest.cpu = $typeId
    $device = $project.Devices.CreateWithItem($typeId, 'PLC_1', 'PLC_1')
    $plc = Find-PlcSoftware $device.DeviceItems
    if (-not $plc) { throw 'No PLC software found on the created device.' }

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
    Import-Source $plc (Join-Path $here 'scl\Fx_Broken.scl') $null 'KeepOnError'
    $manifest.addresses += 'plc:PLC_1/blocks/Fx_Broken'

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
