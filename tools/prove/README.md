<!-- SPDX-License-Identifier: MIT -->
# Differential validation against an S7-1500 runtime

`prove.mjs` runs the same test cases in rung's simulator (`rung test --observe`) and on a PLCSIM Advanced instance
that runs the block as TIA Portal compiled and downloaded it, and compares every output after every step. The
instance runs in `SingleStep_CT`: one cycle per step of the API, each taking the test's cycle time in virtual time, so
timers count as in the simulator. Each case starts from a warm restart (STOP, RUN): a `NON_RETAIN` instance DB is
back at its start values.

Only on a disposable fixture: a PLCSIM Advanced instance of a generated project, never a machine's PLC.

## Setup (once)

1. A runnable fixture project and a workspace for it:
   `powershell -File tools\fixtures\New-FixtureProject.ps1 -Name RungProve -Runnable`, then `rung init <dir> --project <...>\RungProve.ap20 --tia V20 --writes` and `rung pull`.
2. The blocks to compare (`corpus/*.scl`, `examples/conveyor/blocks/FB_Conveyor.scl`, `packages/lsp/test/sd/FB_Pump.s7dcl` and `Fx_LadEdges.s7dcl`), each with a
   `NON_RETAIN` instance DB that OB1 calls without arguments (`"ProveOps_DB"();`): the steps write the instance DB's
   inputs and read its outputs. Their tests go to `tests/`. `rung sync` compiles them in TIA Portal.
3. A PLCSIM Advanced instance with the PLC's address (the film tools' `plcsim-host.ps1 -Name RungProve` registers one
   at 192.168.250.1 on the PLCSIM virtual adapter; give PLC_1 that address in `plc/PLC_1/hardware/network.yaml`),
   `[plc.PLC_1]` in `rung.toml` naming `Siemens PLCSIM Virtual Ethernet Adapter`, and `rung download --yes --hw`.

## Run

```
node tools/prove/prove.mjs --workspace <dir> --test tests/ops.test.yaml --instance RungProve --db ProveOps_DB
node tools/prove/prove.mjs --workspace <dir> --test tests/conveyor.test.yaml --instance RungProve --db Conveyor_DB
```

A block must finish its cycle with the start values (a loop that depends on an input needs a bound): the CPU runs one cycle with them after each warm restart.

Exit 0 when every compared value is the same, 2 when a case differs. Steps with `within`, `always` or `never` are not
compared (their length depends on the code). `plcsim-run.ps1` needs the PLCSIM Advanced 7.0 API at its default path.
