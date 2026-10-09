<!-- SPDX-License-Identifier: MIT -->
# Stage 3 acceptance — 2026-10-09

The supported release reconstructs SCL from complete supplied pre/post state,
with recorded expressions, writes, branches, Why and visible divergences.
The native producer generates its own read-only begin/end requests using the
installed V20 serializers, checks native source/scalar/root-instance metadata,
and uses the existing session and live-reader leases. CLI and VS Code reject
stale scope/epoch, late generations, changed source and dirty workspace sources.

Native live support is limited to complete persistent primitive scalar FB
state through a root instance DB called from OB1. Local constants, used TEMP,
opaque/composite state, clocks, external state and unmatched user dependencies
are refused. Offline complete captures additionally cover arrays, structures,
user multi-instances and FC in/out. Exact status, force and PLC breakpoints are
unavailable. Native coherence stays `subscription-sample`, `exact: false`:
reconstructed source paths are not verified PLC execution.

Fresh acceptance after the final review fixes:

- Vitest: 1562 passed, 28 skipped; lint, type checks and SPDX headers passed.
- Online host C# suite: 151 passed, zero failures.
- Actual VS Code Extension Host: all 73 tests passed, including native recorded
  Why surviving ordinary updates and invalidating when its sample becomes stale.
- Final reviewer found two Important issues: unmatched local constants and Why
  invalidation on every observed frame. Both have RED→GREEN regressions. Full
  editor acceptance also reproduced an offline debug shutdown EPIPE; the relay
  now handles closed pipes and the complete editor rerun passed.
- Local RungProve/PLC_1 native producer: five complete 35-member begin/end
  samples; five replays of 161 trace entries, zero output differences.
- Published host plus packaged EXE and bundle: real local read-only capture,
  161 trace entries and zero differences each. Identity checked before testing;
  post-close TIS exploration found no watch jobs. These checks made no PLC
  writes, mode changes or downloads. Robot 192.168.1.1 was not contacted.
- Offline Math capture replayed by EXE, bundle, actual extracted VSIX and npm
  bundles: 144 trace entries, zero differences, recorded COUNTED Why value 2.
- Windows ZIP, npm and VSIX rebuilt; Siemens binary audit clean, all five
  release checksums verified. Published-host capability/refusal tests and
  compatible driver-DLL replacement passed.

The seven earlier controlled PLCSIM cycles and their restoration evidence are
retained in [the capture fixtures](../tools/prove/captures/README.md).
Runnable native producer checks are in [tools/prove/native](../tools/prove/native/README.md).
Detailed local logs and scratch proofs remain in
`.superpowers/sdd/item3-codex`; no public release, push or merge was performed.

Coverage of other firmware and serializer versions remains unproven. No cycle
coherence or general support is inferred from the local fixture. Two review
findings were fixed; there are no deferred minor findings from that review.
