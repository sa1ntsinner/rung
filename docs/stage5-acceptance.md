# Trace and five-stage roadmap acceptance

Stage 5 accepted on 2026-10-09 in the bounded scope documented in `trace.md`.
Implementation: 764f8fa, c678832, 1b1ceb4, ecc0f71; exact native fixture bytes
8828070; final broker cleanup fix bc743e4. The branch remains codex/m2-t1.

Engineers can record selected PLC signals through existing read-only subscriptions,
stop/save, open portable JSON offline, import the evidenced TIA long-term CSV
profile, choose signals, zoom and inspect cursor values in VS Code. Recordings
preserve individual observation times, target/epoch/errors and honest gaps.
Capacity is bounded to 32 signals, 20000 frames, 64 MiB and one hour. Existing
files are never overwritten. A stalled release times out and produces a saved
partial-error recording with its IPC socket closed.

Final verification after review fixes:

- TypeScript: 1615 passed, 28 skipped; lint, editor build and E2E types passed.
- C# Core: 344 passed on each of net48/net10; online host: 151 passed.
- Actual VS Code: four passed — local PLCSIM recording, progress cancellation,
  native-format CSV import, and real CSP webview curves/cursor/zoom.
- Actual packaged EXE with packaged online host: 18 observations, two INT signals;
  identity, scope, mode and memory unchanged; reader and private server closed.
- ZIP/npm/VSIX rebuilt; all five release checksums verified; same CLI/Core payload,
  command registrations and webview assets checked; three offline import variants
  preserved the exact native CSV hash and nanosecond timestamp. Siemens binary
  redistribution audit passed.
- One fresh whole-stage review found one Important cleanup issue; watched
  stalled-release RED→GREEN and full suite passed after its fix. No deferred minors.

Evidence is retained under `.superpowers/sdd/item5-codex/`: final suite/build/audit,
native and editor logs, exact recordings and installed-writer/reader proofs.
Original TIA windows 37516 and 9636 remained alive. The robot was not modified.

Limits: subscription observations are asynchronous/coalesced, not cycle-exact or
every-change capture. Actual native waveform values were constant in this proof;
changing curves/gaps have domain/browser coverage. CSV evidence comes from the
installed V20 writer and independent reader with synthetic scalar inputs, not a
CPU measurement or UI-export acceptance. Other profiles/types/units are not guessed.
Abrupt termination or storage failure can leave an incomplete recording.

Recorded decisions: viewer development proceeded while CSV evidence was sought
(cost: adapting imported labels); imported portable files retain raw CSV+SHA and
derive views on inspect (cost: consumers need inspect); the native writer/reader
artifact establishes the supported CSV profile (cost: UI variants may be refused).

All five implementation stages are now accepted within their recorded first-release
scopes: TIA session workflow, online access (`online-acceptance.md`), reconstructed
program status (`program-status-acceptance.md`), guarded project assets
(`stage4-acceptance.md`) and Trace. Exact program status remains unavailable by the
bounded investigation's decision; unsupported operations refuse explicitly.
This does not establish unrestricted replacement of every TIA engineering task.
The owner's separate critical engineer-workday assessment starts next, without
examining rung implementation during that assessment. Automation stays paused;
no push, publication or merge was performed.
