# rung-online

The standalone host accepts the bridge JSON-lines envelope on stdin/stdout with
no arguments or `--stdio`. It advertises only `online.connect`, `online.browse`,
`online.read`, `online.state`, `online.subscribe`, `online.unsubscribe`,
`online.disconnect`, and certificate inspection.
It does not start an engineering session. Unknown methods, including mutations,
are refused. `192.168.1.1` is refused before any connection is created.

Configure the live target separately from engineering/download connections:

```toml
[live.plc.PLC_1]
transport = "s7commplus"
address = "192.168.250.1"
allow_writes = false
# certificate_sha256 is set after explicit certificate verification.
```

Build with locally restored dependencies, then inspect and confirm the pin in a
terminal (set `RUNG_ONLINE_HOST` to an installed host executable or DLL if needed):

```powershell
dotnet build bridge/src/Rung.Online --no-restore
node packages/cli/dist/index.js live trust --dir <workspace> --device PLC_1
```

The trust command shows the presented leaf certificate, asks for the PLC name,
then saves its SHA-256 in that PLC's `rung.toml` table. Cancellation and unattended
invocations save nothing. Compare with the trusted certificate in TIA Portal
before confirming. Changed/missing pins block ordinary sessions. The host takes
the verified pin in `online.connect`; it does not use an environment pin for RPC.
Passwords remain transient request credentials, never TOML fields.

Reads retain input order, quoted labels, per-item errors and observation times.
Names resolve against PLC metadata, including indexed array elements and
multi-instance paths. Area symbols use their browsed names (`IArea`, `QArea`,
`MArea`); absolute offsets are not guessed. Browse responses are paged with
`offset` and `limit` (maximum 1000). Reads accept at most 1024 names.

Each successful read has a JSON-safe `value`, PLC `type`, and TIA-style `display`.
Integers beyond JavaScript's exact range use decimal strings; times/dates use
typed literals, and arrays retain elements. Bad quality and unsupported values
are item errors without a new observation timestamp. CPU state returns the
observed mode and CPU identity. Subscription recovery and consumer routing
belong to subsequent tasks; existing Web API and simulator paths still work.

Owner-side PLCSIM read check from the repository root, after adding the table above
to the indicated workspace's `rung.toml`. Set `RUNG_PLC_PASSWORD` separately if the
CPU requires legitimation. Confirm the displayed certificate against TIA Portal:

```powershell
$env:RUNG_ONLINE_WORKSPACE = 'C:\path\to\workspace'
$env:RUNG_ONLINE_DEVICE = 'PLC_1'
$env:RUNG_ONLINE_HOST = (Resolve-Path bridge/src/Rung.Online/bin/Debug/net10.0/rung-online.dll).Path
node packages/cli/dist/index.js live trust --dir $env:RUNG_ONLINE_WORKSPACE --device $env:RUNG_ONLINE_DEVICE
@'
import { loadConfig } from './packages/core/dist/index.js';
import { S7CommPlusClient, selectLiveTarget } from './packages/live/dist/index.js';
import { onlineHost } from './packages/cli/dist/liveTrust.js';
const config = await loadConfig(process.env.RUNG_ONLINE_WORKSPACE, { raw: true });
const { device, target } = selectLiveTarget(config, { device: process.env.RUNG_ONLINE_DEVICE });
const host = await onlineHost(process.env);
const client = new S7CommPlusClient(host);
try {
  console.log(JSON.stringify(await client.connect({ device, address: target.address,
    certificateSha256: target.certificateSha256, user: target.user,
    password: process.env.RUNG_PLC_PASSWORD }), null, 2));
  console.log(JSON.stringify(await client.state(), null, 2));
  console.log(JSON.stringify(await client.browse({ filter: 'Fx_Global' }), null, 2));
  const frame = await client.readFrame(['"Fx_Global".Station.Enabled']);
  console.log(JSON.stringify(frame, null, 2));
  if (frame.items.some(item => item.error)) process.exitCode = 1;
} finally {
  try { await client.close(); } finally { await host.close(); }
}
'@ | node --input-type=module
```

Compare `value`, `type` and `display` with the same PLCSIM API/TIA observations.
Add actual fixture array and multi-instance names to `readFrame` for those checks;
the browse output provides PLC spellings. These commands are read-only.

## Feasibility probe

Read-only TLS 1.3 feasibility probe, targeting .NET 10. No TIA installation is required.
The probe connects, prints the CPU order code/type, firmware and operating state,
lists up to five accessible scalar symbols, reads one, disconnects and exits.
It never writes, changes CPU mode or falls back to challenge authentication.
Every invocation containing the protected endpoint `192.168.1.1` is refused before
password input, certificate lookup or transport creation, including duplicate options.

Inspect the PLC's presented certificate without creating a PLC session, sending a
password, browsing or reading:

```powershell
dotnet run --project bridge/src/Rung.Online -- probe --address 192.168.250.1 --show-certificate
```

This performs ISO-on-TCP/InitSSL negotiation and the TLS handshake, prints the
unverified leaf's subject, issuer, UTC validity, SHA-256 and SHA-1 fingerprints,
then disconnects. It does not require a pin and ignores `--password-stdin`.
SHA-1 is displayed for comparison with TIA Portal's certificate manager only;
trust always uses SHA-256. No presented certificate produces a TLS/configuration
diagnostic, including secure PG/PC settings and older firmware, and exit code 6
when negotiation completes without a certificate. Transport failures retain
their error exit code and also explain that no certificate was received.

Obtain the PLC's leaf certificate through a trusted engineering/export workflow.
Verify its SHA-256 fingerprint independently; do not trust a fingerprint obtained
from an unauthenticated connection. Set its 64 hexadecimal characters (without
separators) in the environment:

```powershell
$env:RUNG_ONLINE_CERTIFICATE_SHA256 = '<verified 64-character SHA-256 fingerprint>'
dotnet run --project bridge/src/Rung.Online -- probe --address 192.168.250.1
```

For a protected CPU, add `--password-stdin` and supply one password line on standard
input. The password is never accepted in arguments or printed. An empty line means
an empty password; EOF is a usage error. The probe has a 60-second total deadline;
Ctrl+C cancels it. A missing/invalid pin performs certificate inspection only,
prints the diagnostics to stderr and exits with code 4 if inspection succeeds.
A mismatched pin prints the leaf presented during the rejected handshake.
Both block session creation and legitimation. Compare the displayed fingerprints
with the certificate in the TIA Portal project before setting the pin.

Exit codes: `0` success; `1` unexpected failure; `2` usage/input; `3` protected target;
`4` certificate trust; `5` legitimation; `6` TLS/firmware; `7` timeout/cancellation;
`8` communication/no readable symbol; `9` read access denied. Errors go to stderr.

Local checks (no PLC):

```powershell
dotnet build third_party/S7CommPlusDriver/src/S7CommPlusDriver
dotnet test third_party/S7CommPlusDriver/src/S7CommPlusDriver.Tests
dotnet build bridge/src/Rung.Online
dotnet build bridge/tests/Rung.Online.Tests
dotnet test bridge/tests/Rung.Online.Tests
```

Windows packaging:

```powershell
dotnet publish bridge/src/Rung.Online -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

The runtime is bundled in `rung-online.exe`; users do not install .NET. Trimming is
disabled because the driver uses reflection. `S7CommPlusDriver.dll` is deliberately
excluded from the executable bundle and must ship alongside it as a replaceable LGPL
library, together with its notices, licence texts and corresponding modified source.
The SDK bundles the native .NET runtime libraries using standard single-file extraction;
there are no native OpenSSL dependencies. Release packaging and
PLCSIM interoperability evidence is recorded separately; offline tests make no PLC test claim.

The default stdio host advertises read-only operations, including CPU diagnostics
and alarm snapshot/subscriptions. Confirmed mutation requires the private
`--writer-policy-stdin` bootstrap from the broker. Its first input frame binds
workspace, configuration hash, endpoint, certificate and write opt-in; normal RPC
callers cannot enable writes. Prepare/commit is single-use, expires after 30
seconds and rechecks the target before one short-lived writer sends once.

Run `node tools/online/check.mjs --replacement` after publishing to verify the
self-contained host and prove loading an API-compatible modified driver DLL.
The release includes corresponding source and licenses; replacement instructions
are in `tools/online/REPLACEMENT.md`.
