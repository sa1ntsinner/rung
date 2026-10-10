<!-- SPDX-License-Identifier: MIT -->
# Hardware snapshot, preview and apply

`rung hardware` shows a concise engineering summary of the returned snapshot: names, module identities, positions, firmware and addresses when available. `--json` keeps the full tree and revision for scripts and patch preparation. Summary limits and incomplete native snapshots are stated explicitly; the summary does not prove hardware compatibility.

`rung views` already exports read-only hardware YAML, including device/module
identity, positions, attributes and their access/runtime-type metadata. Existing
`plc/<PLC>/hardware/network.yaml` remains the separate editable network workflow.

The initial project hardware workflow can take a fresh snapshot and validate
a patch without changing TIA or contacting a PLC:

```powershell
rung hardware --json > hardware.snapshot.json
rung hardware --file hardware.patch.yaml --json
```

Both commands use the workspace's engineering project. The second returns the
validated changes and current revision; it does not apply them. A patch accepts
block-style YAML 1.2 or JSON. YAML duplicate keys, aliases, unknown tags and
multiple documents refuse before opening the bridge. Raw JSON reaches the host
unchanged so its duplicate-key check remains authoritative.

```yaml
version: 1
expectedRevision: "<revision from the snapshot>"
changes:
  - device: PLC_1
    positions: [1]
    typeIdentifier: "<CPU TypeIdentifier from the snapshot>"
    field: Comment
    before: "<current Comment>"
    after: "New comment"
```

```json
{
  "version": 1,
  "expectedRevision": "<revision from the snapshot>",
  "changes": [{
    "device": "PLC_1",
    "positions": [1],
    "typeIdentifier": "<exact TypeIdentifier of the selected module>",
    "field": "Comment",
    "before": "<current comment>",
    "after": "New comment"
  }]
}
```

`positions` follows `DeviceItems` by the actual `PositionNumber` at each level;
an empty path selects the station. It is not an array index or a display name.
Missing or ambiguous devices/positions are refused. The exact type identity,
original value and complete snapshot revision must match the current project.
Truncated/cyclic/oversized snapshots, duplicate changes and unknown patch fields
are refused. Raw patch text reaches the host so duplicate JSON keys are refused
there rather than silently discarded by the CLI.

A change may name any attribute the snapshot reports as `ReadWrite` with a text,
`true`/`false`, whole-number or enumeration type (`Name`, `Comment`,
`ClockMemoryByte`, `CycleMaximumCycleTime`, `TransmissionRateAndDuplex`, …); the
value must be written as the snapshot shows it (an enumeration by its member name,
`TP100MbpsFullDuplex`).
What identifies the hardware (`TypeIdentifier`, `PositionNumber`, `IsBuiltIn`,
`Container`, `OrderNumber`, `FirmwareVersion`) is not edited: modules are plugged
instead. Other types (dates, certificates, lists) are refused for now.
Snapshot access information is not an apply guarantee: the applied graph is.

A network node of an interface is named by `node` next to the interface's
`positions`: `{ device: PLC_1, positions: [1, 33024], node: X2, field: Address,
before: 192.168.253.1, after: 192.168.253.2 }` changes that IP address. A built-in
interface has no `typeIdentifier`; the change then names none.

Turning a setting on can make TIA Portal show a dependent one: enabling
`ClockMemoryByte` adds `ClockMemoryByteAddress`. An attribute whose name continues
the changed one may appear or disappear with it; the result lists it under
`related` ("added by TIA Portal"), and so does a change of which attributes of
that item may be edited (a fixed port speed). Any other side effect is rolled
back, and the error names it: TIA Portal changes some settings together (a fixed
port speed switches `PortMonitoring` on), so to accept that, name the attribute in
the patch too, with the value it gets.

`rung hardware --file hardware.patch.json --apply --json` explicitly applies
these annotations. It requires workspace writes to be on and `sync.import = auto`.
The host also requires its existing import permission, checks the current full
graph inside exclusive access, rejects reused operation IDs and uses TIA
transactions. The complete resulting graph must match the requested changes;
unexpected changes refuse the operation and verify restoration. A restoration
failure is reported as `RESTORATION FAILED`, never a successful apply.

Apply follows `sync.save`: `after-import` saves the engineering project; `never`
leaves it open with unsaved edits. The JSON result contains `saved`, and a failed
save reports `SAVE_FAILED`. No PLC connection or download is involved.

A separate version 2 patch creates or deletes one module. It cannot mix module
operations with annotations:

```yaml
version: 2
expectedRevision: "<revision from the snapshot>"
module:
  action: create # delete uses a fresh snapshot after creation
  device: PLC_1
  parentPositions: [0]
  parentTypeIdentifier: "OrderNumber:6ES7 590-1***0-0AA0"
  typeIdentifier: "OrderNumber:6ES7 521-1BH00-0AB0/V1.0"
  position: 2
  name: RungStage4_DI
```

Use the same `hardware --file ...` preview and explicit `--apply` commands. Any
catalogue identifier (`OrderNumber:`, `GSD:`, `System:`) on any parent path of up to
four positions is accepted when TIA Portal says it plugs there (`CanPlugNew`); the
committed graph must differ from the snapshot by exactly that module. Names accept
1–64 ASCII letters, digits or underscores. Preview checks the native
`CanPlugNew` result; delete checks the exact native identity, logical container
and `IsBuiltIn = false`. CPU and built-in children cannot be deleted here.

TIA stores the new module in the station's flat `DeviceItems` composition while
its logical `Container` is the rail. TIA generates its child objects and defaults.
Create verifies that removing the actual generated subtree yields the original
complete hardware graph; delete verifies exactly that subtree was removed.
Both checks run before commit and again after transaction disposal. Failed
transactions verify native rollback; they do not reconstruct configured modules
from factory defaults. A graph difference after rollback reports
`RESTORATION FAILED`. The returned revision identifies the actual native graph.

Limits: patch file 1 MiB, 256 changes, 12 positions per path, 1024 characters
per annotation; snapshot 4096 nodes, depth 12 and 128 KiB of source strings.
Large escaped requests may additionally encounter the bridge's line-size limit.

Local RungProve proof: a CPU comment preview returned one change, stale revision
and read-only identifier edits refused, then a fresh snapshot had the identical
revision and original comment. No engineering setters, saves, PLC writes or
downloads were used. Library, technology and safety acceptance are separate
stage 4 tasks.

The apply proof used a separate project extracted from a preserved native
RungProve archive. Comment and Author round-tripped through the real host;
read-only host, reused operation ID and stale revision refused. Reverse apply
restored the complete hardware graph. The actual CLI also applied, saved,
restored and saved a Comment edit. Core tests cover a failed second setter,
unexpected graph changes and failed restoration. An early real poststate refusal
verified TIA transaction rollback; its cause was dictionary ordering in the
expected copy, fixed with an ordinal-order regression.

Hardware compilation reported zero errors and two fixture protection warnings;
it renewed a communication certificate in the disposable copy. Hardware graph
equality does not establish whole-project byte equality. The tested copy was
closed and preserved, the source archive hash stayed identical, and a separate
clean copy matched all 24 archived file hashes. The original UI project remained
open with zero attached sessions.

Module proof: native create rollback, rollback after a second failed creation,
committed creation and deletion all restored the original hardware graph. The
actual YAML CLI also created/saved SM521, compiled with zero errors and the same
two fixture protection warnings, then deleted/saved it and verified full graph
equality. Only the disposable offline copy changed; the source archive remained
identical. This evidence covers the bounded module above, not arbitrary stations,
catalogue modules, slots or device settings.
