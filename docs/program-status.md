<!-- SPDX-License-Identifier: MIT -->
# Reconstructed SCL program status

The captured reconstruction replays **one supplied pre-cycle state** offline and compares
its result with a separate observed post-cycle state:

```powershell
rung program-status plc/PLC_1/blocks/Counter.scl --capture cycle.json --instance Counter_DB --json
```

The selected instance DB must belong to the mirrored SCL FB. The CLI never opens
TIA or a live PLC connection, changes a file, writes a value or downloads code.
Exit codes are 0 for agreement, 2 for divergence and 1 for unavailable replay.
JSON results retain `exact: false` and `freshness: "capture-only"`; agreement does
not prove the PLC executed the reconstructed branches or runs the mirrored code.

A capture contains `scope` (`plc`, quoted `instance`, `epoch`), `sourceRevision`,
`time` and `clockStart` in milliseconds, `coherence`, `before.mem`,
`before.globals` and `observed`. Memory uses the simulator's complete state shape,
with uppercase member names. Arrays include their bounds and items; user FB
multi-instances include their type and memory. `observed` is the complete
post-cycle instance memory. Capture files are bounded to 1 MiB. The exported
`reconstructionRevision(index, uri)` computes the selected PLC/shared-source hash;
`reconstructCycle` provides the same engine for capture tooling.

Missing values, changed scope/source, incompatible state and opaque standard-FB
or pointer state are refused. Relevant global state must be supplied. Timer and
edge-detector internals are not guessed. Trace output is capped at 10,000 entries
and 1 MiB, and includes executed source statements and actual expression values
after type rounding. Expressions are observed once, without re-evaluation.
Integer state must fit the declared PLC type. Array bounds must be literals;
declaration shape is checked before allocating templates. A selected DB's global
reference shares the captured instance memory; conflicting duplicate memory is
refused. Ambiguous FB source names are refused.

`controlled-cycle` records the capture producer's declared provenance;
`subscription-sample` identifies approximate observations. Neither declaration
is independently verified by this offline command. Subscription values generally
represent different times and post-execution memory: do not feed them back as
pre-cycle state and call the result exact PLC program status.

In VS Code, **rung: Reconstruct SCL from Cycle Capture** opens a capture for the
selected block and DB. Inline labels say `reconstructed`, mark executed source
statements and show up to eight expression values per line. The header records
the historical provenance and divergence count; hovering shows scope and up to
20 output divergences. Other files' trace entries stay in the CLI JSON. Source
edits (including closed dependencies), source creation/deletion and workspace/
live-target changes clear the display. Dirty workspace sources are refused;
opening a capture never saves them or opens a PLC connection.

Neovim exposes the same CLI as `:Rung program-status <file> --capture <json>
--instance <DB>`. Live FB watch JSON carries an explicit unavailable
`programStatus` for subscription-only observations, preserving each measurement's
timestamp. Stale/disconnected frames explain their refusal. Live values remain
observations; the running PLC's executed branches cannot be inferred from them.

On a supported S7CommPlus target, live watch also requests native begin/end
snapshots through its existing reader lease. A validated matching SCL FB, whose
instance DB OB1 calls or which is a multi-instance below it (`--instance
Line_DB.motor`), can show `native-sample` reconstruction and recorded Why in VS
Code. Ordinary observed declaration values stay separate.
Native sample times belong to the capture, and its coherence remains
`subscription-sample`: reconstructed branches are not verified PLC execution.

This producer needs the installed V20 serializers. The sample holds the members
the code touches, by path (`count`, `s.a`, `arr[1]`); a member it does not hold is
unknown, and a cycle that reads one is refused rather than replayed with a guess.
Temporaries need no capture: a temporary read before the cycle wrote it refuses the
sample. DB members and tags the FB reads or writes are read right before and after
the sample; a value that moved in between refuses it, and what the FB writes is
compared with the PLC's value. A local constant the code uses replays with its
declared value only when the PLC shows it was compiled with that value (integer
constants; a different value asks for a download). A user FC the FB calls, directly
or through other FCs, runs inside the replay when its source is the code the PLC
holds; the DB members and tags it reads are read next to the sample like the FB's.
Standard FB instances (TON, CTU: their state is not in the sample), other constants,
CPU clocks, calls of FBs other than multi-instances, recursive FCs, instance DBs
called from inside an FB, other OBs and computed array indexes that the cycle reads
are explicitly refused. Source revision, session scope/epoch, reader lifetime
and dirty editor sources invalidate the result. Missing native support retains
the unavailable subscription-only behavior described above.

The bounded exact-status investigation is complete; exact block status remains
unavailable in this release.

Seven controlled PLCSIM cycles now cover arrays, structures, a stateful user
multi-instance and an FC with in/out parameters: all 215 observed leaves agreed.
The portable captured-value regression and restoration evidence are in
[tools/prove/captures](../tools/prove/captures/README.md). This extends the earlier
one-cycle arithmetic check; it does not establish exact live execution or support
for hidden standard-FB state.

Add `--why "Count"` (or `--why "Arr[1]"`) to show the recorded last write, its operands and enclosing controls. In VS Code, Why? uses the active capture and clears with its source/scope invalidation. It never evaluates a call or index again. Member paths require literal indices. Trees show up to 32 evaluations per statement and eight enclosing controls; CLI JSON retains the bounded trace. Write attribution scans current selected memory, including aliases and newly bound FB inputs, with a ten-million-object-visit ceiling per replay. Exceeding the ceiling refuses replay. Historical evidence remains unverified against current PLC execution.
