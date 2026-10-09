# Online acceptance evidence — 2026-10-08

Software implementation for tasks 8–10 and the distribution part of task 11 is
verified. Native fixture reads, confirmed writes, STOP/RUN and power-loss recovery
have now passed, including program-alarm activation/clear and live array-layout
changes. Task 7's catalogue-backed address coverage is verified. End-to-end warm
editor opening and notification rendering meet their targets. Item 2 is complete
within the address-coverage ruling below; an optional Web API comparison remains
unavailable and no comparative speed claim is made.

| Check | Result |
|---|---|
| Full Vitest | 1514 passed, 28 skipped; no type errors |
| Online host Release | 134 passed, including equal-counter alarm transitions |
| Driver Release | 220 passed after concurrent receive fixes |
| Bridge core Release | 296 passed on net48 and 296 on net10 |
| VS Code real extension host | 4 fresh and 72 fake tests passed |
| Neovim headless smoke | All checks passed |
| Build, typecheck and SPDX | Passed |
| Windows ZIP, npm and VSIX packaging | Built; forbidden-binary and source/license audit passed |
| Published host offline check | Read-only capabilities and pre-connection refusals passed |
| Modified compatible driver DLL | Loaded by unchanged self-contained host; loopback-only probe |
| Installed CLI discovery | Found bundled host and refused force-table XML before connection |
| Release checksums | ZIP and npm package verified |

Run `tools/online/check.mjs` and `tools/online/plcsim-check.ps1` as described in
`tools/online/README.md`. Test logs remain in the ignored plan workspace
`.superpowers/sdd/item2-codex/`; the implementation and runnable checks are tracked.

The final fresh reviewer found one important defect: reshaping a multidimensional
array while preserving total element count did not change the program revision.
The revision now includes every dimension's lower bound and element count.
`ArrayReshapeInvalidatesCatalogueAndPreparedProgramRevision` failed before the
fix and passed afterward; the entire host suite passed. This invalidates cached
indexed accessors and prepared confirmations after that layout change.

The full driver run also exposed a socket/deadline timeout race in certificate
inspection. Its existing interrupted-inspection regression failed before the
shared timeout classification fix; all 218 driver tests passed afterward.
The broker's alarm-disconnect regression likewise failed before its fix and
passed afterward.

Read-only PLCSIM Advanced API inspection confirmed the registered local instance
`RungProve`, controller `PLC_1`, CPU1516, mode Run and interface addresses
`192.168.250.1` and `192.168.253.1`. The fixture identity guard rejects other names
and addresses before loading the API. This verifies local instance identity,
not the TLS certificate.

The inspected TLS leaf fingerprint was
`D46FF2A330C94C2555ED2B456ED72C0597932B6932B363C8FADC945E8D3C1213`,
subject `CN=PLC-1/Communication-1`. It has **not** been independently verified
against the engineering project in this continuation. Public-certificate file
and local certificate-store searches found no verification material. Prior-agent
claims and the network inspection alone were not accepted as independent proof.
The user explicitly approved this inspected fingerprint as a local-fixture trust
exception and authorized continuing the fixture acceptance operations. This is
not independent engineering-project certificate verification.

Actual fixture evidence (published host, real private broker, managed TLS):

- Identity: PLC_1, serial `10S C-7308856Zb7`, firmware `2.9.0.0`,
  order number `6ES7 516-3AN02-0AB0`; 389 catalogue symbols.
- Eleven optimized scalar/UDT/array/multi-instance/global-tag reads agreed with PLCSIM API:
  four Station fields, `arr[0]`, `grid[1,2]`, `pts[1].x`, `inner.step/count`,
  `IArea.Fx_Inputs_0` and `QArea.Fx_Outputs_0`. Watch reads of `%I0.0`, `%Q0.0`
  and a quoted symbolic name matched the same API values. Initially unmatched
  `%MW2`, `%ID0` and `%QB4` remained explicit unsupported rows. Temporary explicit
  catalogue tags subsequently verified those aliases, as recorded below.
- Confirmed BOOL/INT/REAL/STRING writes were observed by API and subscriptions;
  every original input was restored. Actual STOP and RUN were verified by API.
  The immediate post-acknowledgement RUN observation can still report Stop;
  acknowledgement is not a claim that the asynchronous transition has completed.
- Concurrent value/alarm subscriptions survived CPU mode/cycle/memory checks.
  A 20-second read-only run delivered 81 value frames at the requested 250 ms.
- Power-off/on emitted stale values and reconnecting alarms, then resumed values
  and a refreshed alarm snapshot at epoch 2. The API tag list was refreshed after
  restart; CPU mode and original inputs were restored to Run/initial values.
- Ten warm monitor openings delivered first live frames in 10.8–107.3 ms
  (sample p95 107.3 ms). This measures the broker callback, not editor rendering;
  no Web API speed comparison has been established.
- An opt-in real VS Code extension-host test displayed the changing native PLC
  cycle counter. The final renderer and warm-opening measurements are recorded
  below. The project tree uses the existing fake project fixture; live values
  come from the actual pinned local RungProve connection.
- A direct-driver resource probe opened/closed twenty value and ten alarm
  subscriptions. After every iteration the PLC reported all 500 subscription
  slots and all 1,048,576 subscription-memory bytes free, matching the baseline.
  Ten additional broker monitors also opened/closed successfully.
- CPU STOP/startup system alarms arrived with CPU timestamps and translated text.
  A disposable program alarm subsequently proved streamed Incoming and Going
  events with the same occurrence counter, as recorded below.

Hardware testing exposed two actual defects: optimized BOOL datatype 40 was
refused by the scalar parser; concurrent notification readers could consume a
pending response and starve foreground diagnostic requests. Regression checks
failed before each fix and pass afterward. The dispatcher retains one matching
response and lets the pending foreground request pump notifications.

Runnable acceptance is `tools/online/hardware.mjs`; logs are retained in the
ignored plan workspace (`hardware-priority-read.log`,
`hardware-priority-mutate.log`, `hardware-recovery-2.log`,
`hardware-addresses.log`, `hardware-resources.log`). Source downloads
remain separate explicit operations. The Windows ZIP/npm/VSIX were rebuilt after
these hardware-driven fixes; source/licence audits, installed-host discovery and
loading a modified compatible driver DLL passed again.

After the user accepted TIA's Openness prompt, the disposable Program_Alarm FB and
instance DB compiled and were downloaded by separate explicit `rung download`
commands. Incoming and Going events shared a CPU occurrence counter. A regression
failed before the fix: equal counters now use strictly newer CPU timestamps,
so an older snapshot cannot resurrect a cleared alarm. Both events and the empty
active-alarm query after clear were verified on the fixture.

A live 2×3 array was reshaped with the same element count. The old indexed accessor
became unavailable, replacement indices read successfully at epoch 2, and a pending
write was rejected with `STALE_PREPARATION` before expiry. A separate regression
fix preserves this explicit pre-send host refusal through the broker instead of
reporting an uncertain outcome. Actual timeout/transport failures remain unknown.

The V20 watch fixture was re-exported from TIA with seven rows, duplicate symbolic
names, comments, display formats and an unapplied draft ModifyValue. Explicit
catalogue tags proved `%M0.0`, `%MW2`, `%ID0` and `%QB4` against API values true,
4660, 2309737967 and 165. Originals were restored. Temporary FB, DB, Program_Alarm,
tag table and watch table were removed; the original Main was downloaded again.
The fixture was observed in RUN with its original Station values.

Fresh checks: 1514 Vitest passed (28 skipped), 134 online-host Release tests passed,
VS Code fresh/fake suites 4/72 passed, build/lint and installed-host/replacement
checks passed. Native cold connect was 183 ms; cold browse of 389 symbols was
19.44 ms. Forty 250 ms subscription intervals had median 251.16 ms and p95
251.43 ms. A real VS Code workbench renderer measured p95 23 ms across 39 rendered
updates from 40 notifications after two animation frames; physical screen pixels
were not sampled. Ten actual editor reopenings measured 427–446 ms, p95 446 ms.
Both targets (100 ms rendering and 500 ms warm opening) passed.

The initial warm test exposed Windows process-tree termination killing the shared
broker. Read-only CLI streams now release their own leases on parent stdin EOF;
VS Code and Neovim use that path, with a timeout fallback. All ten final reopenings
retained broker PID 40604. Live rows no longer receive redundant age-timer
refreshes, and the native Live Values view requests a 250 ms subscription cycle.
EOF cleanup and stale-only age refresh each have a regression that failed before
the fix and passed afterward. Raw evidence is `warm-broker-green-4.log`.

The fixture's HTTPS port timed out and no Web API credentials were configured,
so a same-workload Web API comparison is unavailable. No speed advantage is claimed.

Address coverage is deliberately limited to symbolic/indexed scalars and explicit
catalogue-derived process-image I/Q/M BOOL and unsigned BYTE/WORD/DWORD aliases.
Standard DB offsets, peripheral forms, aggregate rows and signed/floating
reinterpretation stay visibly unsupported. No optimized offset is guessed.
