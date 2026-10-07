# SPDX-License-Identifier: MIT
# Runs test steps on a PLCSIM Advanced instance, cycle by cycle (SingleStep_CT: every cycle takes the test's cycle
# time in virtual time, so timers count as in rung's simulator), and prints what each step read as JSON.
# Called by prove.mjs with a plan file:
#   { instance, db, cycleNs, cases: [{ name, steps: [{ step, set: { member: value }, cycles, read: [member] }] }] }
# Each case starts from a warm restart (STOP, RUN): a NON_RETAIN instance DB is back at its start values.
param([Parameter(Mandatory)][string]$Plan)
$ErrorActionPreference = 'Stop'
Add-Type -Path 'C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API\7.0\Siemens.Simatic.Simulation.Runtime.Api.x64.dll'
$p = Get-Content $Plan -Raw | ConvertFrom-Json
$i = [Siemens.Simatic.Simulation.Runtime.SimulationRuntimeManager]::CreateInterface($p.instance)
$i.UpdateTagList([Siemens.Simatic.Simulation.Runtime.ETagListDetails]::IOMCTDB, $true)
$types = @{}
foreach ($t in $i.TagInfos) { $types[$t.Name.ToUpperInvariant()] = [string]$t.DataType }

function Tag([string]$member) {
  $name = "$($p.db).$member"
  $type = $types[$name.ToUpperInvariant()]
  if (-not $type) { throw "PLCSIM knows no tag $name" }
  return @{ name = $name; type = $type }
}
function Put([string]$member, $value) {
  $t = Tag $member
  switch ($t.type) {
    'Bool' { $i.WriteBool($t.name, [bool]$value) }
    'Byte' { $i.WriteUInt8($t.name, [byte]$value) }
    'SInt' { $i.WriteInt8($t.name, [sbyte]$value) }
    'USInt' { $i.WriteUInt8($t.name, [byte]$value) }
    'Int' { $i.WriteInt16($t.name, [int16]$value) }
    'UInt' { $i.WriteUInt16($t.name, [uint16]$value) }
    'Word' { $i.WriteUInt16($t.name, [uint16]$value) }
    'DInt' { $i.WriteInt32($t.name, [int32]$value) }
    'UDInt' { $i.WriteUInt32($t.name, [uint32]$value) }
    'DWord' { $i.WriteUInt32($t.name, [uint32]$value) }
    'Time' { $i.WriteInt32($t.name, [int32]$value) }
    'LTime' { $i.WriteInt64($t.name, [int64]([double]$value * 1000000)) } # rung's ms, the CPU's ns
    'Date' { $i.WriteUInt16($t.name, [uint16]$value) }
    'Time_Of_Day' { $i.WriteUInt32($t.name, [uint32]$value) }
    'TimeOfDay' { $i.WriteUInt32($t.name, [uint32]$value) }
    'Real' { $i.WriteFloat($t.name, [single]$value) }
    'LReal' { $i.WriteDouble($t.name, [double]$value) }
    'LInt' { $i.WriteInt64($t.name, [int64]$value) }
    'ULInt' { $i.WriteUInt64($t.name, [uint64]$value) }
    'LWord' { $i.WriteUInt64($t.name, [uint64]$value) }
    'Char' { $i.WriteChar($t.name, [char]$value) }
    'String' { $i.WriteString($t.name, [string]$value) }
    'WString' { $i.WriteWString($t.name, [string]$value) }
    default { throw "rung prove writes no $($t.type) yet ($($t.name))" }
  }
}
# JSON has no infinities: they travel as text
function Finite([double]$v) { if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return [string]$v } ; return $v }
function Get([string]$member) {
  $t = Tag $member
  switch ($t.type) {
    'Bool' { return $i.ReadBool($t.name) }
    'Byte' { return $i.ReadUInt8($t.name) }
    'SInt' { return $i.ReadInt8($t.name) }
    'USInt' { return $i.ReadUInt8($t.name) }
    'Int' { return $i.ReadInt16($t.name) }
    'UInt' { return $i.ReadUInt16($t.name) }
    'Word' { return $i.ReadUInt16($t.name) }
    'DInt' { return $i.ReadInt32($t.name) }
    'UDInt' { return $i.ReadUInt32($t.name) }
    'DWord' { return $i.ReadUInt32($t.name) }
    'Time' { return $i.ReadInt32($t.name) }
    'LTime' { return [double]$i.ReadInt64($t.name) / 1000000 }
    'Date' { return $i.ReadUInt16($t.name) }
    'Time_Of_Day' { return $i.ReadUInt32($t.name) }
    'TimeOfDay' { return $i.ReadUInt32($t.name) }
    'Real' { return Finite ($i.ReadFloat($t.name)) }
    'LReal' { return Finite ($i.ReadDouble($t.name)) }
    'LInt' { return $i.ReadInt64($t.name) }
    'ULInt' { return $i.ReadUInt64($t.name) }
    'LWord' { return $i.ReadUInt64($t.name) }
    'Char' { return [string][char][byte]$i.ReadChar($t.name) }
    'String' { return $i.ReadString($t.name) }
    'WString' { return $i.ReadWString($t.name) }
    default { return "($($t.type))" }
  }
}
# a cycle ends in the freeze state; events of earlier sync points (the startup) must not count as this one
function Frozen { for ($n = 0; [string]$i.OperatingState -ne 'Freeze' -and $n -lt 3000; $n++) { Start-Sleep -Milliseconds 1 } }
function Drain { for ($n = 0; $n -lt 1000; $n++) { if ([string]$i.WaitForOnSyncPointReachedEvent(1).ErrorCode -ne 'OK') { return } } }
function Cycles([int]$n) { for ($k = 0; $k -lt $n; $k++) { Frozen; Drain; $i.RunToNextSyncPoint(); [void]$i.WaitForOnSyncPointReachedEvent(10000); Frozen } }

$out = @()
try {
  $i.RegisterOnSyncPointReachedEvent()
  foreach ($c in $p.cases) {
    # a warm restart: STOP, then RUN in single steps of the test's cycle time
    $i.OperatingMode = [Siemens.Simatic.Simulation.Runtime.EOperatingMode]::Default
    [void]$i.Stop(30000)
    $i.OverwrittenMinimalCycleTime_ns = [int64]$p.cycleNs
    $i.OperatingMode = [Siemens.Simatic.Simulation.Runtime.EOperatingMode]::SingleStep_CT
    [void]$i.Run(30000)
    Frozen # after the startup and a first cycle with the start values, before the test's first step
    if ([string]$i.OperatingState -ne 'Freeze') { throw "$($p.instance) did not start (it is $($i.OperatingState)): rung download it again, or look at its diagnostics in TIA Portal" }
    $steps = @()
    foreach ($s in $c.steps) {
      if ($s.set) { foreach ($prop in $s.set.PSObject.Properties) { Put $prop.Name $prop.Value } }
      Cycles ([int]$s.cycles)
      $values = [ordered]@{}
      foreach ($m in $s.read) { $values[$m] = Get $m }
      $steps += [ordered]@{ step = $s.step; values = $values }
    }
    $out += [ordered]@{ name = $c.name; steps = $steps }
  }
} finally {
  try { $i.UnregisterOnSyncPointReachedEvent() } catch { }
  $i.OperatingMode = [Siemens.Simatic.Simulation.Runtime.EOperatingMode]::Default
}
ConvertTo-Json @{ cases = $out } -Depth 6 -Compress
