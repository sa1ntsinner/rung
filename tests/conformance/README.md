<!-- SPDX-License-Identifier: BUSL-1.1 -->
# CODESYS conformance corpus

These twelve programs compare rung's offline simulator with CODESYS V3.5 SP22 on the fixture's Control Win V3 x64 simulation target. Each `r_` variable is a check; its declaration explains it. Programs compute their own inputs, freeze their results and cycle count when `done` is true, and never depend on writes to the running application. Supporting POUs and types have separate files under `cases/support/`, as the CODESYS bridge requires.

Record on a Windows PC with CODESYS and the standard libraries installed, from the repository root (PowerShell):

```powershell
$env:RUNG_E2E_CODESYS='1'; $env:RUNG_CONFORMANCE_RECORD='1'; npx vitest run tests/e2e/conformance.e2e.test.ts
```

Build first with `pnpm -s build`. The test generates a fresh disposable project, mirrors and syncs the corpus through rung, calls every program from the fixture's cyclic task, downloads to simulation, waits for every `done`, and reads through `plc.read` while `rung watch` holds the simulation open. It writes `cases/<area>.test.yaml` only after every result was read and validated. Review and commit those recordings with the sources. They contain values from CODESYS; no baselines are supplied before that run. The temporary project/workspace is kept in the system temporary directory for diagnosis.

With only `RUNG_E2E_CODESYS=1` (unset `RUNG_CONFORMANCE_RECORD`), the same test compares CODESYS results with the saved files and writes nothing. Missing recordings fail that comparison. Both CODESYS suites use the same fixture generator and CLI helpers; run them sequentially when using the installed runtime.

CI runs `npx vitest run packages/sim/test/conformance.test.ts` (also included in `npx vitest run packages/sim`). It loads just this corpus, uses the same runner as `rung test`, and prints program counts: match CODESYS, refused by rung, differ, not recorded. Missing baselines are listed without claiming a match. Explicit unsupported constructs are listed with their reason; malformed recordings and unexpected errors fail. Every result must be recorded, with no stubs or input writes. Integers also receive an exact comparison because the normal runner's numeric tolerance is intended for real values. Real results use the runner's usual tolerance.

Checks cover signed and unsigned widths, 64-bit wrap, conversion ties and REAL precision, shifts and rotates including counts at/beyond width, bits, selection and math, control flow, arrays/structures/enumerations, persistent FBs and cycle-driven triggers/counters/latches, STRING edge positions, and TIME literals/arithmetic. 64-bit results are read as decimal strings before conversion to an exactly representable number; recording fails rather than rounding an unrepresentable value. The ULINT underflow check records its low byte. Behavior beyond a shift's width can depend on the target; a baseline is evidence for this simulation target.

TON/TOF/TP are omitted: CODESYS uses runtime elapsed time, while rung advances virtual time by the configured cycle. Counting scans alone cannot make those timers deterministic across both runtimes.
