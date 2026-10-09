<!-- SPDX-License-Identifier: MIT -->
# Exact block-status spike: current evidence

Product decision on 2026-10-08: exact block status remains unavailable. Continue
the bounded protocol investigation. A guarded fixture producer now collects
validated begin/end samples; the product cannot yet generate a validated watch
request and instance route for an arbitrary selected SCL FB.
This is a release gate, not evidence that the PLC lacks the capability.

The read-only native probe used the approved local RungProve/PLC_1 fixture at
192.168.250.1 (S7-1500 firmware 2.9). It retrieved block content and debug XML.
FB_ProveOps yielded 80 reverse-lookup operands at 48 distinct SAC positions;
all 80 element IDs matched UIDs in the native SCL body tree. Monitoring metadata
also contains debug-value and typed indirect-address references. These joins
identify compiler nodes. A subsequent fixture-only traversal of native SCL tokens
and newline nodes matched all 49 exported body lines (ignoring whitespace), and
mapped all 80 operands to 36 current mirrored source lines. For example SAC 0,
operand 1 maps to line 51, `#sum := #a + #b;`. Unknown tokens, duplicate UIDs,
compilation-unit mismatch and source-line differences are refused by that probe.
This initial metadata check preceded the real notifications described below;
it alone does not validate execution or a general renderer for arbitrary SCL.

Relevant checked-in driver paths:

- `S7CommPlusTisWatchRequest` accepts raw `RequestBlob` and `TriggerBlob` from
  its caller; it does not build them from a block/interface/instance path.
- `S7CommPlusTisWatchSubscriptionService.Create` installs AID 2693 and 2694,
  then creates and enables a non-modifying TIS job and notification subscription.
- Client tests supply synthetic byte arrays through a fake protocol session.
  Their successful lifecycle and decoder tests do not validate those bytes on
  the fixture PLC.
- `GetOnlineCapabilitiesAsync` returned an empty raw blob. That response alone
  establishes neither support nor lack of support.

The fixture acceptance gate has passed: a real read-only TIA request/trigger,
complete begin/end values, caller attribution, controlled branches and cleanup
are recorded below. Product acceptance still requires a general bounded encoder
and instance routing, export/source matching, invalidation and firmware coverage.
Until that gate passes, raw test blobs are not installed and no exact-status,
real breakpoint or force operation is exposed by the product.

The raw probe/XML/UID-join files remain in the local plan's evidence directory
`.superpowers/sdd/item3-codex`, including `map-native-lines.py` and
`uid-source-lines.json`; they are prototype evidence, separate from the
shipped offline reconstruction protocol.

An offline inspection of the locally installed TIA V20 assemblies also located
`TisPlusServer.WatchJob.WriteRequestData`, `Trigger.WriteTriggerData` and
`CodeAddress.WriteBlock/WriteInstruction`. Their metadata and managed IL provide
a concrete route to investigate request structure and capability-dependent
signatures. No job/install/start method was invoked. An isolated attempt to load
the serializers outside TIA initially terminated with a stack overflow. Diagnostic
logging identified recursion while the PowerShell assembly resolver handled
`System.Management.Automation.resources`. A CLR resolver restricted to Siemens
dependencies removed that recursion. The isolated probe now invokes only the
code-address serializer, obtaining these checked reference bytes:

| FB number / SAC | Bytes with a big-endian buffer |
| --- | --- |
| 1 / 0 | `03 5C 01 60 00` |
| 255 / 0 | `03 5C FF 60 00` |
| 256 / 0 | `03 5D 01 00 60 00` |
| 65535 / 0 | `03 5D FF FF 60 00` |

These are partial serialization vectors, not a complete request or PLC acceptance.
They verify the length transition for the block selector. The full request still
depends on capability flags, value layout, trigger and instance routing. These
local probes and logs stay outside the distributed product, which includes no
TIA assemblies.

The additional offline capability-command inspection confirms that TIA requests AID 4196, matching the driver's capability attribute. Its returned empty blob still cannot select the required request variants. Value-list IL confirms that watch serialization delegates to each value's data address; code-address vectors alone omit the actual operand and instance route. The isolated IL reader was corrected for two-byte opcodes (`FE xx`); capability/value inspection then completed without invoking constructors or network methods.

Release decision: **no-go for shipping general exact block status in this version**. The fixture transaction below has now passed real notification, branch and cleanup checks. A validated encoder for arbitrary selected blocks, instance routes and firmware variants is still absent. This is a product acceptance decision, not a claim that the CPU lacks the capability. No force or real breakpoints are exposed.

Later on 2026-10-08, TIA V20 monitored the known FB_ProveOps [FB4] on
RungProve/PLC_1. Read-only exploration of the session container (RID 285) found
its active watch job, with `ModifyingJob=False`, a 798-byte request and a
24-byte trigger. The result attribute contained a 456-byte payload. The request
and trigger were copied from TIA, rather than inferred from metadata.

The existing driver's `OpenBlockOnlineViewAsync` accepted this transaction after
TIA monitoring stopped. Concurrent viewing was rejected at job creation. Two
independent connections each received four notifications, disposed their jobs,
and a subsequent session-container exploration found no remaining watch job.
TIA was returned offline; the PLC stayed Run/Default.

Installed TIA serializer IL confirmed token widths and the watch-point/value
offset layout. The bounded fixture decoder recovered 43 watch points and 50
values, with 46 instance values joined to native debug references and source
UIDs. Four immediate operands remain outside that instance-address join. Some
references share several source uses; this is not a universal expression map.

A controlled local test observed `(a,b)=(0,0),(5,2),(5,0)`. Sum, difference,
product and quotient agreed with the fixture; the division point was unexecuted
at `b=0`, and its validity byte was zero. Both input values were restored and
verified. Stable samples were selected by agreeing input/output values; this
does not establish a coherent pre-call capture or a stream of every PLC cycle.

The bounded recorded transaction is `tools/prove/captures/tis-proveops.json`.
Run `node tools/prove/check-tis.mjs` for an offline assertion of its actual
branch/value evidence. Prototype scripts, XML and full notification logs remain
in the plan evidence directory; none is used by a shipped exact-status path.

The subsequent full-state prototype uses TIA's MC7+ `DataAddressEncoder.AsIndirect`
offline. Five actual operand vectors matched byte-for-byte, and the same encoder
supplied the two missing instance members (`n` and `i`). TIA's own Blob and
DataAddress serializers built read-only embedded begin/end monitor lists, using
the recorded fixture header/trigger. No modifying token or force mode was added.
The PLC accepted this 801-byte request and returned all 35 instance members at
each boundary, with all 70 validity bytes equal to 15.

Three selected begin/end samples replayed with zero differences. In particular,
`b=0` preserved the captured quotient 2 from the preceding call. The packaged
CLI consumed a generated capture and displayed captured Why evidence. The
recorded raw payloads, field layout and decoded memory are in
`tools/prove/captures/tis-prepost.json`; the offline check validates raw bytes
against every decoded member, and `tests/prove/reconstruct.test.ts` replays all
three against the fixture source. Full suite: 1548 passed, 28 skipped.

These captures retain `coherence=subscription-sample` and `exact=false`.
Notification delivery is not proof of every PLC cycle, and the prototype still
uses a header/trigger obtained from this particular TIA session. It does not
solve arbitrary-block request creation, call/instance routing, clock or hidden
standard-FB state, source-change invalidation, or reconnect handling in a
general capture producer. Those remain the stage-3 product gate. The fixture
inputs and Run/Default state were restored; a read-only check again found no
remaining watch job.

The next offline IL check removed the fixture's borrowed request header/trigger.
`TestJob.CreateRequestBuffer` writes the result-size token and watch-job type;
`TestJob.HasSequenceNumber` returns false in this installed base implementation.
Its ESID contains job type, reserved byte, job number and Device UID. The Device
constructor derives that UID by XORing four words of a new GUID. The block
timestamp in the trigger matches the driver's `CodeModifiedTimestampBytes`.

A new request generated its header and trigger from those serializers, a fresh
UID and native block metadata. Before opening the job, the prototype reread the
block and checked its signature. Five notifications supplied all 70 valid fields;
five complete replays agreed. Deliberately changing the expected signature was
refused before job creation, and session exploration confirmed no residual job.
`tools/prove/captures/tis-generated-prepost.json` preserves that bounded evidence;
the offline check also validates its generated header and native signature.
The installed `StackList.ReadResultData` also decoded each recorded payload as
one caller frame, OB1/SAC118. Main's native reverse lookup maps that address to
compilation unit 1 / element 258; its body identifies the call as `ProveOps_DB`.
The artifact preserves both XML fragments and the offline check compares each
raw stack frame with that route. This proves the recorded fixture's caller;
arbitrary nested or multi-instance routing and runtime invalidation remain
unverified.

The fixture producer is reproducible with `tools/prove/native` (see its README).
It verifies both native source signatures before and after collecting samples,
checks all value validities and each caller frame, and disposes its subscription.
A repeat supplied five complete samples; a changed expected instance was refused
before opening the watch. Post-run exploration found no watch jobs. Its final
signature-validation marker is required before using any provisional samples.

The host now renders the fixture's native SCL syntax and joins its monitoring
references to all 35 named scalar addresses using checked-in code. Both native
source records matched the current exported body through the existing SCL lexer,
and native types/widths matched every persistent scalar declaration. Edited body
tokens and missing/mismatched/overlapping declarations are refused. Compiler
NativeLocal result slots are excluded from persistent state; unknown syntax and
used TEMP/composite state remain unsupported. This closes the fixture source
binding check, while general producer/session integration remains open.

The installed pure operand encoder works inside .NET 10 as well as net48; no
extra serializer process is needed. `NativeCaptureEncoder` now builds bounded
scalar layouts and read-only request/trigger blobs with those serializers,
requiring the tested V20 assembly versions. A golden check reproduced every
byte of the existing 801-byte request, 24-byte trigger and 70-field layout. The
tracked producer then constructed a fresh request from current guarded metadata
and decoded five actual samples into named states. Source/type gates passed,
all five supplied replays agreed, and post-run exploration found no watch jobs.
This proves one clock-independent fixture. The release now validates root OB1
instance routing, refuses uncaptured clocks/globals/local constants and uses
existing live leases with session scope/epoch and source-generation checks.
It exposes approximate native-sample reconstruction, while exact execution and
cycle coherence remain unverified. See [final acceptance](program-status-acceptance.md).
