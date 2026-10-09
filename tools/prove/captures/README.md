<!-- SPDX-License-Identifier: MIT -->
# Captured reconstruction checks

`data.json`, `more.json` and `math.json` are actual PLCSIM Advanced 7 pre/post
snapshots captured on 2026-10-08 from the disposable RungProve/PLC_1 fixture at
192.168.250.1, in SingleStep_CT with a 10 ms cycle. They cover seven cycles and
215 observed scalar leaves, including arrays, inline structures, branches,
strings, a user FB multi-instance counter and an FC with in/out parameters.
All selected DB leaves, the previous cycle override and Run/Default mode were
restored; each file retains the expected and observed restoration values.

The exported TIA SCL sources were replayed without divergence. The portable
regression uses the equivalent existing `tools/prove/corpus` sources. An altered
COUNTED observation must produce a visible divergence and exit code 2:

```powershell
pnpm build
pnpm exec vitest run tests/prove/reconstruct.test.ts
```

For a new capture, pass `captureBefore: true` to `plcsim-run.ps1` and include
every selected DB leaf in each step's `read` and the plan's `restore` list.
Every written member must also be restored. `-ValidateOnly` checks the plan
without loading the PLCSIM SDK or connecting to the fixture. Restoration attempts
every member and runtime setting even if another restoration fails; failures
are reported instead of producing a successful capture.
Only one cycle per step is accepted; capture mode refuses any fixture other
than RungProve/PLC_1 at 192.168.250.1 in initial Run/Default. Then replay the
complete snapshot with the actual exported workspace sources:

```powershell
powershell.exe -NoProfile -File tools/prove/plcsim-run.ps1 -Plan plan.json > raw.json
node tools/prove/reconstruct.mjs workspace plc/PLC_1/blocks/FB_ProveMath.scl ProveMath_DB raw.json
```

This offline acceptance tool uses virtual time zero for these clock-independent
fixture FBs and trusts their exported declaration sizes. It refuses missing
members and opaque timer/edge state. Capture metadata is producer provenance;
agreement remains reconstruction evidence with `exact: false`.
