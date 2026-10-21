# Going online

TIA Portal V18, V19, V20 or V21 with Openness must be installed on the Windows PC that runs the bridge. It can be your PC or [another PC over ssh](remote.md). rung reuses the TIA Portal that has the project open, or starts one without window.

## Read-only lock

Set `RUNG_READ_ONLY=1` before starting rung, or set `read_only = true` in
`[plc.PLC_1]` or `[live.plc.PLC_1]` in `rung.toml`. The environment lock wins
over workspace permissions, `allow_writes`, command flags and editor settings.
Refused changes report `PLC_READ_ONLY` and exit with code 2.

The lock blocks downloads, value modification, CPU control and TIA imports and
apply operations. Pull and export remain available; watch runs export-only and
does not start automatically in VS Code. `192.168.1.1` is admitted for locked
read paths only. Use a pinned certificate for native reads and verified HTTPS
for Web API reads; insecure TLS and the non-loopback HTTP override are refused.
FB monitors do not automatically capture native program status while locked;
`rung live watch --native-capture` requests it explicitly.

`rung init --from-plc <ip> --project <dir>/<name>/<name>.ap20` works under the
lock, into a project that does not exist yet: the bridge is started for that
new project only and may upload into it and compile it, nothing else.
`rung upload` into an existing project stays refused. Local restore, upgrade
and retrieve remain available. A locked command refuses reuse of a keeper that
was started without the lock. Archive remains available for a saved project;
the lock refuses the save if the source has unsaved changes.

A PLC with secure communication shows its certificate during the upload, and a
new project knows none yet: pass `--trust-certificate` to `rung init --from-plc`
or `rung upload` to trust it for that run (without it, nothing is uploaded and
rung says why).

`rung live trust --device PLC_1 --expect-sha256 <fingerprint>` pins the PLC
certificate without a prompt, only when its SHA-256 is exactly the one given
(compare it beforehand with TIA Portal's certificate manager); scripts and
remote sessions without a terminal use this.

When the online host or the connection is lost during `rung live watch`, the
broker starts a new host and subscribes again (after 1, 2, 5, then every 10 s);
frames say `disconnected` meanwhile, never live. A CLI watch that sees no live
values for 60 s stops with exit 1 (`--reconnect-timeout <s>`).
`rung trace record` starts its `--duration` with the first live values; how
long connecting took is saved as `connectMs`.

A PLC address on another interface of the CPU (X2 rather than X1): with
several target interfaces set `target_interface` in `[plc.PLC_1]` to the one
that carries the address; `rung interfaces` lists the CPU's interfaces and their
addresses, and a failed go-online names the interface it used.

## Back up a running PLC

```powershell
$env:RUNG_READ_ONLY = '1'
rung backup --from-plc 192.168.0.10 --out D:\backups\line1-2026-10-12 --use "<PG/PC interface>" --trust-certificate --expect-sha256 <fingerprint>
```

One new folder with everything rung can read from the CPU, the PLC only read: the station uploaded into a new TIA
Portal project (`project/`) and archived (`.zap20`), TIA Portal's online compare of that project with the PLC right
after the upload (proof the copy is complete), the program as text (`program/`, a workspace bound to the project), the
CPU's identity, state and certificate, its active alarms, and the values of every data block (`values/`, at most 16
per read with pauses, so the CPU's cycle does not notice). `manifest.json` lists each step with its result,
`SHA256SUMS` every file. Exit 0 complete, 2 partial (the steps that worked are kept), 1 when the upload failed.
`--trust-certificate` trusts the certificate TIA Portal shows for the upload; `--expect-sha256` checks the one the CPU
shows for live values (without either, the live part is skipped). `--no-values` leaves the values out.

It is not a native CPU image: Siemens' "backup from online device" stops the CPU, so rung never uses it. Watch and
force tables, web server users and device-internal parameters of drives and gateways are not in it.

`rung backup verify <folder>` checks the files against `SHA256SUMS` without connecting anything. `rung backup diff
<before> <after>` lists program files and values that differ between two backups: take one before and one after
working on a machine, and the program part says whether anything changed.

## Find the PLC

Run these commands in the folder with `rung.toml`:

```sh
rung connect                 # find the PLC and save the connection in rung.toml
rung connect --pick          # choose among the connections that answer
rung connect --json          # list choices and addresses as JSON; saves nothing
rung online                  # go online with the saved connection
rung online --state          # show the online state
rung online --off            # go offline
```

With several PLCs, add `--plc PLC_1`. `rung connect` looks through TIA Portal's PG/PC interfaces for the project's addresses and S7-PLCSIM. One matching connection is chosen automatically; otherwise it asks. A scan can take up to half a minute. The connection is saved as `[plc.<name>]` in `rung.toml`.

`--json` lists the saved connection, project addresses, candidates and other reachable devices. An `addressChange` on a choice says which project interface has a different address. `rung interfaces` lists the PG/PC interfaces TIA Portal offers if you need to choose manually.

In VS Code, **Go online** finds a connection when needed. **Connect…** lets you choose again. If nothing answers, the dialog offers **Retry**, **Choose manually** and **Show details**. With several PLCs, the PLC picker remembers the last PLC chosen in the workspace and lists it first.

## A PLC at another address

Check the device name and address before choosing it. A device at a familiar address can be another machine.

For V19/V20, TIA Portal goes online only at the address in the project:

```sh
rung connect --plc PLC_1 --address 192.168.1.1
rung writes on
rung sync
rung online --plc PLC_1
```

`connect --address` edits `plc/PLC_1/hardware/network.yaml`. Pull first if that file is not mirrored yet. Sync takes the edit into TIA Portal with writes on; it does not change the running PLC's address. In VS Code, **Use … in the Project** makes the same edit.

For V21, use an online address without changing the project:

```sh
rung connect --plc PLC_1 --pick                  # choose a PG/PC interface first
rung connect --plc PLC_1 --address 192.168.1.1   # save the online address in rung.toml
rung online --plc PLC_1
```

V21 uses that address when going online. `network.yaml` and the TIA Portal project stay unchanged. VS Code offers **Go Online at …**. To edit the project address on V21 instead, use `rung connect --address <ip> --project-address`, or **Use … in the Project**, then sync with writes on.

## Passwords

The CLI takes the PLC's password from `RUNG_PLC_PASSWORD`. For a PLC with user management, set `RUNG_PLC_USER` too. In PowerShell:

```powershell
$env:RUNG_PLC_PASSWORD = '<PLC password>'
$env:RUNG_PLC_USER = '<PLC user>' # only for user management
rung online --plc PLC_1
Remove-Item Env:RUNG_PLC_PASSWORD
Remove-Item Env:RUNG_PLC_USER -ErrorAction SilentlyContinue
```

`rung compare` uses these credentials too. rung does not write them into workspace files. `RUNG_WEBAPI_PASSWORD` is separate: it is for the web server used by `rung live`.

VS Code asks when the PLC requires a password or refuses the stored one. When user management requires a user, it asks for that too. It keeps the password and user in VS Code's secret storage, keyed by project path, bridge host and PLC name. Rebinding a folder to another project does not reuse the old project's credentials.

## TLS certificates

When TIA Portal asks about an untrusted PLC certificate, rung refuses it with `TLS_UNTRUSTED` and shows the certificate details TIA Portal supplies. Check them before retrying:

```sh
rung online --plc PLC_1 --trust-certificate
```

`rung compare --trust-certificate` also accepts it for that connection. In VS Code, the modal shows the details and asks whether to trust it for the connection. Consent applies only to that run. rung never saves the decision in `rung.toml`, workspace state or secret storage.

## S7-PLCSIM

rung uses legacy communication for the PLCSIM PG/PC interface and the Siemens PLCSIM Virtual Ethernet Adapter used by S7-PLCSIM Advanced. These simulated PLCs have no PLC certificate, so this path has no TLS certificate prompt. A successful PLCSIM connection does not check the certificate path of a real PLC.

## Read-only subscriptions without TIA Portal

`rung live` also supports a separate S7CommPlus host. This path requires secure PLC communication and a verified certificate pin; it never falls back to legacy communication. The Openness commands above use a different connection path. CLI, LSP and `rung mcp` share one workspace live broker, one read connection per selected PLC/backend, and one subscription to the union of consumers' symbols. Monitoring does not save, import, compile or download anything.

In your workspace's `rung.toml`, use the actual mirrored device name:

```toml
[live.plc.PLC_1]
transport = "s7commplus"
address = "192.168.250.1"
allow_writes = false
```

### Installed release

The release includes the online host; no source checkout, .NET SDK or build command is needed. Run in the workspace and replace the device and symbol with yours:

```powershell
rung live trust --device PLC_1
# Compare the displayed fingerprint with the PLC's certificate before accepting.
# Only if the PLC requires credentials:
$env:RUNG_PLC_USER = '<PLC user>'
$env:RUNG_PLC_PASSWORD = '<PLC password>'
rung live read '"Fx_Global".Counter' --device PLC_1 --transport s7commplus --json
rung live watch '"Fx_Global".Counter' --device PLC_1 --transport s7commplus --interval 250 --json
# After stopping watch:
Remove-Item Env:RUNG_PLC_USER, Env:RUNG_PLC_PASSWORD -ErrorAction SilentlyContinue
```

For a PLC's Web API instead, configure its web server user and HTTPS address:

```toml
[live.plc.PLC_1]
transport = "webapi"
address = "192.168.250.1"
allow_writes = false

[live.plc.PLC_1.webapi]
url = "https://192.168.250.1"
user = "<web server user>"
```

```powershell
$env:RUNG_WEBAPI_PASSWORD = '<web server password>'
rung live read '"Fx_Global".Counter' --device PLC_1 --transport webapi --json
rung live watch '"Fx_Global".Counter' --device PLC_1 --transport webapi --json
Remove-Item Env:RUNG_WEBAPI_PASSWORD -ErrorAction SilentlyContinue
```

Web API reads and watches are supported, but `rung trace record` requires S7CommPlus. The address and URL must identify the same selected PLC. Passwords belong in environment variables, never in `rung.toml`.

### Building from a source checkout

These contributor commands build the host instead of using the installed release. Edit `$workspace`, `$device` and `$symbol` to match your local test project:

```powershell
$repo = 'C:\path\to\rung'
$workspace = 'C:\path\to\RungProve-workspace'
$device = 'PLC_1'
$symbol = '"Fx_Global".Counter'
$cli = Join-Path $repo 'packages\cli\dist\index.js'
$env:RUNG_ONLINE_HOST = Join-Path $repo 'bridge\src\Rung.Online\bin\Debug\net10.0\rung-online.dll'

dotnet build (Join-Path $repo 'bridge\src\Rung.Online')
node (Join-Path $repo 'node_modules\typescript\bin\tsc') -b $repo

# Compare the displayed SHA-256 fingerprint with the fixture certificate
# before typing the device name. This saves the verified pin in rung.toml.
node $cli live trust --dir $workspace --device $device

# Only if the fixture requires legitimation; these stay out of arguments/TOML.
$env:RUNG_PLC_USER = '<fixture PLC user>'
$env:RUNG_PLC_PASSWORD = '<fixture PLC password>'

node $cli live read $symbol --dir $workspace --device $device --transport s7commplus --json
node $cli live watch $symbol --dir $workspace --device $device --transport s7commplus --interval 250 --json
```

Open a second terminal, set the same variables, and run the same watch command. Both consumers share the live broker. Each stream starts with `{plan}`, followed by complete `{at, values, errors, scope, observedAt, types, display, state}` frames. `scope` identifies the PLC, transport and session epoch; `observedAt` measures actual values rather than health checks. A REAL zero retains numeric `value: 0` and display text `"0.0"`. Ctrl+C releases that terminal's lease. The last consumer allows the broker to exit after 30 seconds idle.

For a source block, replace the last command with:

```powershell
node $cli live watch --dir $workspace --file 'plc/PLC_1/blocks/Motor.scl' --instance '"Motor_DB"' --transport s7commplus --interval 250 --json
```

Use actual block/instance names; file scope selects its PLC. LSP monitoring receives pushed updates, while polling providers remain supported. Read-only MCP calls accept `device` and `transport` and return target/observation provenance. Explicit Web API fallback uses `--transport webapi`, the selected PLC's `[live.plc.<device>.webapi]`, and `RUNG_WEBAPI_PASSWORD`; the existing `rung simulate` Web API remains supported.

### Owner-side disconnect/reconnect check

Keep the subscription terminal running. In another PowerShell terminal on the PLCSIM Advanced 7.0 owner PC, use only the local `RungProve` instance at `192.168.250.1`:

```powershell
Add-Type -Path 'C:\Program Files (x86)\Common Files\Siemens\PLCSIMADV\API\7.0\Siemens.Simatic.Simulation.Runtime.Api.x64.dll'
$fixture = [Siemens.Simatic.Simulation.Runtime.SimulationRuntimeManager]::CreateInterface('RungProve')
if ($fixture.Name -ne 'RungProve' -or $fixture.ControllerIP -notcontains '192.168.250.1') {
    throw 'Expected local RungProve at 192.168.250.1'
}
$fixture.PowerOff(30000)
# Observe state stale in the watch stream, then restore promptly.
$power = $fixture.PowerOn(30000)
if ([string]$power -ne 'OK') { throw "RungProve PowerOn failed: $power" }
$fixture.Run(30000)
```

On detected transport failure, the host marks retained values stale and reconnects while consumers remain, with 1/2/4/8/15-second capped backoff and a 15-second deadline per attempt. Consumers can close or change their symbol union during an outage. Recovery verifies CPU model, serial number and PLC name, invalidates accessors, reads a fresh snapshot and recreates subscriptions, retaining any newer startup notifications. The epoch advances; old generations are ignored. Quiet subscriptions remain valid; health checks do not refresh measurement timestamps. Program catalog checks also rebuild changed accessors. Authentication, certificate, access and identity failures stop recovery and require explicit correction.

After correcting a terminal trust/authentication/identity failure, stop **all** live consumers, wait for the idle broker to exit, and restart:

```powershell
# After Ctrl+C in both subscription terminals and stopping LSP live monitoring:
Start-Sleep -Seconds 31
node $cli live watch $symbol --dir $workspace --device $device --transport s7commplus --interval 250 --json
```

If the fixture certificate changed, verify and pin it again before restarting. Hardware subscription/reconnect results must be recorded on the owner PC; passing fake lifecycle tests does not establish PLCSIM interoperability.

### VS Code monitoring

The existing inline monitor, declarations Monitor column and Live Values view use
the configured live backend. A block selects its own `plc/<device>/` target;
pinned values ask which PLC when the workspace has several. Both views share
credentials in VS Code SecretStorage, bound to workspace, project, PLC, address,
user and transport. Native monitoring prompts only when the PLC requests
authentication; `RUNG_PLC_USER`/`RUNG_PLC_PASSWORD` remain explicit overrides.

Monitoring refuses unsaved blocks and never saves them. Editing the block or
changing the live configuration stops its monitor. Hidden or paused Live Values
releases its process/lease. Late events cannot populate the replacement view.
The target/backend and stale state are shown in tooltips; measurement age uses
`observedAt`, and the recorder retains only new successful observations.

## TIA watch tables

Run `rung live watch --table plc/PLC_1/watch/Fx_Watch.xml --device PLC_1 --json` to monitor a mirrored watch table. The local online host parses its XML without opening TIA or connecting to a PLC. The selected configured backend resolves symbolic and indexed names. XML edits rebuild the subscription; monitoring does not save or import the table.

VS Code's Live Values view has **Watch a TIA Table**. Neovim uses `:Rung live table plc/PLC_1/watch/Fx_Watch.xml`. Rows keep their order, duplicate symbols, comments, display format and draft modify value. Loading a draft never applies it. Force tables are refused.

V19/V20/V21 exports are covered by real fixtures. Scalar process-image I/Q/M BOOL and unsigned BYTE/WORD/DWORD aliases use explicit driver catalogue metadata. Peripheral addresses, signed or floating reinterpretation, aggregate rows and DB byte offsets remain visible with an unsupported-mapping error. Hardware mapping acceptance passed on the local fixture. Optimized DB offsets are never inferred.

## Confirmed modification and CPU control

Set `allow_writes = true` explicitly for the selected native PLC target. Run
`rung live modify <name> <SCL-literal> --device PLC_1`, `rung live run`, or
`rung live stop`. Each operation prepares a typed preview with the actual PLC
identity and endpoint, then asks for confirmation. A watch table's modify value
is only a draft. VS Code exposes Modify Current Value and CPU RUN/STOP actions;
Neovim opens the same CLI confirmation in its terminal.

Prepared operations expire after 30 seconds and are single-use. Commit checks
the configuration, certificate, identity, epoch, program and scalar type again.
The writer uses a separate short-lived TLS session and sends once. A timeout
after sending reports `unknown`; it never retries. `acknowledged` means the PLC
accepted the operation; subsequent logic can overwrite a modified value.

`rung live modify` also changes a value in this workspace's `rung simulate`, which is not a PLC: no `allow_writes` or
certificate, the same preview and confirmation, and the value checked like a test's `set:` (a number in a BOOL, 40000
in an INT are refused). It has no RUN/STOP.

By default a person starts downloads and live changes. A person may set an
[agent mode](agents/modes.md) that permits selected actions. Real PLCs default to
`manual`; reliably identified simulators default to `auto`. Noninteractive CLI
mutation is refused unless an agent mode or the paired frontend confirmation
protocol permits it. `RUNG_READ_ONLY` and read-only locks always win. MCP exposes no live mutation tools. Target
`192.168.1.1` is refused before connection, including read requests.

## Alarms and CPU diagnostics

`rung live state --device PLC_1 --json` reads CPU mode, cycle and memory with
target and identity provenance. `rung live alarms --device PLC_1 --lcid 1033
--stream --json` receives the active snapshot and subsequent alarm changes.
Alarm rows preserve raw IDs, state, language, CPU timestamps and host receive
timestamps. Reconnect rebuilds the alarm snapshot; connection loss marks it
disconnected. Missing optional metadata is reported as unavailable.

`rung live diag` combines native CPU diagnostics with the selected PLC's optional
Web API diagnostic buffer. A missing Web API reports an unavailable buffer,
never a fabricated empty one. The PLC view shows diagnostics and alarms;
read-only MCP tools are `rung_live_state` and `rung_live_alarms`. Alarm
acknowledgement is not exposed.

## Distribution and acceptance

The Windows release bundles the .NET runtime in `bridge/rung-online.exe` and
ships `S7CommPlusDriver.dll` separately. Corresponding modified driver source,
hash manifest, LGPL/GPL texts, dependency notices and replacement/debugging
permission accompany it. See `tools/online/REPLACEMENT.md` and
`tools/online/README.md` for runnable offline and local fixture checks.

Offline host, mutation-policy and alarm-lifecycle checks do not prove PLC
interoperability. Local-fixture reads, writes, alarm activation/clear, recovery and
performance checks passed with a user-approved fixture certificate exception.
The certificate was not independently verified against the engineering project.
See [evidence](evidence.md#online-through-s7commplus-measured) for measurements and limitations.
