# Going online

TIA Portal V19, V20 or V21 with Openness must be installed on the Windows PC that runs the bridge. It can be your PC or [another PC over ssh](remote.md). rung reuses the TIA Portal that has the project open, or starts one without window.

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
Noninteractive CLI mutation is refused except the dedicated paired frontend
confirmation protocol. MCP exposes no live mutation tools. Target
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
