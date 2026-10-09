# Controlled native begin/end capture

Run from the repository root with .NET 10. Set `RUNG_TEST_CERT_SHA256` to the
previously verified local PLC certificate, then run:

```powershell
dotnet run --project tools/prove/native -c Release -- tools/prove/captures/tis-generated-prepost.json
```

This acceptance producer permits only the validated request for the local
RungProve/PLC_1 at 192.168.250.1, its recorded serial, and FB_ProveOps. It checks
the FB and Main signatures and resolves Main's native call site before opening
the read-only watch. Each sample requires all 70 valid fields and the recorded
caller frame. It disposes the watch and checks both source signatures again.
Consume a collected run only if its final record has `signaturesValidated:true`;
earlier records are provisional. The samples retain `subscription-sample`
coherence and do not establish exact or cycle-coherent program status.

The source records contain rendered native SCL and its scalar address/type
bindings before and after collection. Rendering and metadata joins use the
checked-in host code, without installed TIA serializers. The simulator's
`verifyNativeBody` compares existing lexer tokens with the mirror, preserving
string whitespace; `verifyNativeScalars` requires complete matching scalar
declarations and disjoint addresses. Used TEMP state and composite declarations
remain refused by this initial native capture gate.

Request construction uses pure serializers from the installed V20 runtime
(MC7Codegenerator 1700.0.0.0 and TisPlusServer/TisServer 2000.0.9501.1).
Those DLLs are loaded from the installation and are never copied into rung's
distribution. The host builds the request from current guarded metadata with a
fresh UID, checks it against the validated fixture reference, and decodes each
raw sample into named before/after values. Missing installations or unvalidated
versions refuse construction. Unsafe 64-bit integer values are refused before
passing them to the JavaScript replay engine.

Accepted locally: complete samples, independent fresh connection, and rejection
of a changed expected instance before creating a watch. Read-only session
exploration confirmed no residual watch jobs. No program download, input write,
CPU mode change, force, or breakpoint is performed.

Root instance routing now joins SAC/cuId/elementId to the DB and FB symbol
references, cross-reference usage, DB/FB block numbers and matching native type
identity. Missing or conflicting identifiers are refused. The validated ten-slot
stack reader accepts one OB frame; nested and multi-instance stacks are refused.
Native scalar replay also refuses RD_SYS_T, RD_LOC_T and RUNTIME because these
samples do not include CPU clock state.

The reusable product producer still needs nested instance routing, source
export matching, unsupported-state refusal, epoch/reconnect invalidation and
integration with existing reader leases. This guarded benchmark does not expose
a product capability.
