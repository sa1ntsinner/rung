<!-- SPDX-License-Identifier: MIT -->
# Online acceptance

Build the CLI (`pnpm build`) and publish the Windows host:

```powershell
dotnet publish bridge/src/Rung.Online -c Release -r win-x64 --self-contained true
node tools/online/check.mjs --replacement
```

Pass the published directory before `--replacement` when using a custom output.
The offline check starts the actual bundled runtime, verifies read-only capabilities
and refusals, then builds an API-compatible modified driver in a temporary directory
and proves that the same host loads it. The only network probe uses loopback.
The source checkout and original published DLL remain unchanged.

Before hardware acceptance, run the read-only local fixture identity gate:

```powershell
powershell.exe -NoProfile -File tools/online/plcsim-check.ps1
```

It refuses every name/address except local `RungProve` at `192.168.250.1`, and
requires controller `PLC_1`. This proves local identity, not certificate trust.
Independently compare the PLC certificate with the engineering project before
pinning it with `rung live trust --device PLC_1`. A network inspection alone is
insufficient. Hardware modifications require `allow_writes = true` plus each
operation's interactive confirmation.

The opt-in acceptance runner exercises the actual broker with an explicitly
approved fixture pin. Its `--mutate` flag authorizes only the fixed local fixture
operations shown below; it echoes each prepared preview and sends that exact
preview through the private confirmation protocol. Product CLI/editor prompts
remain interactive. `--restart` additionally power-cycles this local instance.

```powershell
$env:RUNG_TEST_CERT_SHA256 = '<approved fixture SHA256>'
node tools/online/hardware.mjs --fixture
# Only after authorizing these disposable fixture operations:
node tools/online/hardware.mjs --fixture --mutate --restart
```

The runner compares eleven scalar/UDT/array/multi-instance/global-tag values against the local
API, tests both subscriptions and CPU diagnostics together, opens/closes ten
additional monitors, and reports warm first-value times. Mutation mode writes and
restores BOOL/INT/REAL/STRING inputs and verifies STOP/RUN with the API. Restart
mode requires a stale transition and recovery at a newer epoch. It does not
download a program or create a program alarm. Catalogue-backed I/Q BOOL aliases
and a quoted symbolic watch address are checked against those same API values;
the fixture's unmatched absolute rows must report an error.

For read-only native monitoring in a real VS Code extension host, keep the same
approved pin and run from `editors/vscode`:

```powershell
$env:RUNG_E2E_SUITES = 'online'
# Optional renderer and warm-open measurement; run without other heavy tests:
$env:RUNG_E2E_RENDERER_PORT = '9333'
npm run test:e2e
```

This opt-in suite gates the local instance, uses a throwaway project-tree fixture,
and reads the actual PLC cycle counter. It reports notification-to-label readiness
latency. With the optional loopback debugging port it also observes the DOM value
after two animation frames, checks ten warm reopenings and verifies that the
broker PID is retained. Physical screen pixels are not sampled. Normal editor
suites do not contact PLCSIM.

Follow the ten hardware acceptance steps in `rung-notes/plans/item2-codex.md`.
Keep raw observations, modes, epochs, alarm timestamps and resource measurements;
record unavailable checks explicitly. Fixture downloads are separate operations.
Offline tests do not establish hardware interoperability or performance.

See [REPLACEMENT.md](REPLACEMENT.md) for distributed library replacement terms.
