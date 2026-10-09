// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it.skipIf(process.platform !== "win32")("rejects unrestored writes before loading PLCSIM and attempts every restoration", () => {
  const root = mkdtempSync(join(tmpdir(), "rung-capture-plan-"));
  try {
    const plan = join(root, "plan.json");
    writeFileSync(plan, JSON.stringify({ captureBefore: true, instance: "RungProve", db: "ProveMath_DB", cycleNs: 10_000_000,
      restore: ["COUNTED"], cases: [{ steps: [{ cycles: 1, read: ["COUNTED"], set: { K: 2 } }] }] }));
    const checked = spawnSync("powershell.exe", ["-NoProfile", "-File", resolve("tools/prove/plcsim-run.ps1"), "-Plan", plan, "-ValidateOnly"], { encoding: "utf8" });
    expect(checked.status).not.toBe(0); expect(checked.stderr).toMatch(/restore.*K|K.*restore/i);
    const script = join(root, "restore.ps1");
    writeFileSync(script, `
$ErrorActionPreference = 'Stop'
Add-Type 'namespace Siemens.Simatic.Simulation.Runtime { public enum EOperatingMode { Default, SingleStep_CT } }'
$i = [pscustomobject]@{ OperatingMode = 'Freeze'; OperatingState = 'Run'; OverwrittenMinimalCycleTime_ns = 99 }
$i | Add-Member ScriptMethod UnregisterOnSyncPointReachedEvent { }
$p = [pscustomobject]@{ restore = @('FIRST','SECOND'); captureBefore = $true }
$original = @{ FIRST = 1; SECOND = 2 }; $originalCycle = 10; $script:attempted = @()
function Put($member, $value) { $script:attempted += $member; if ($member -eq 'FIRST') { throw 'simulated failure' } }
$parseErrors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$parseErrors)
$main = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.TryStatementAst] -and $null -ne $node.Finally }, $true)
$text = $main.Finally.Extent.Text
try { & ([scriptblock]::Create($text.Substring(1, $text.Length - 2))) } catch { }
if (($script:attempted -join ',') -ne 'FIRST,SECOND' -or [string]$i.OperatingMode -ne 'Default' -or $i.OverwrittenMinimalCycleTime_ns -ne 10) { throw 'Restoration skipped members or runtime settings' }
`);
    const restored = spawnSync("powershell.exe", ["-NoProfile", "-File", script, resolve("tools/prove/plcsim-run.ps1")], { encoding: "utf8" });
    expect(restored.status, restored.stderr).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
